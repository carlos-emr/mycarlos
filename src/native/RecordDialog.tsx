import {
  useTextState,
  deferredText,
  useI18n,
  t as translateNow,
} from "../i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import { useModalFocus } from "../useModalFocus";
import {
  vaultErrorMessage,
  type RecordingProgress,
  type VaultBridge,
} from "../vault";
import {
  cameraFailure,
  cameraFailureMessage,
  isPhone,
  type CameraFailure,
} from "./photo";
import {
  NO_CHOICE,
  NO_DEVICES,
  cameraConstraints,
  deviceIsGone,
  devicesInUse,
  listDevices,
  microphoneConstraints,
  openLevelReader,
  readDeviceChoice,
  rememberDeviceChoice,
  type DeviceChoice,
  type DeviceInfo,
  type DeviceLists,
} from "./mediaDevices";
import {
  MAX_UNSENT_BYTES,
  QUALITIES,
  isNoSpace,
  minutesLeft,
  RecordedClock,
  deliveredHeight,
  formatClock,
  highQualityAvailable,
  pickMp4Type,
  readVideoQuality,
  rememberVideoQuality,
  videoConstraints,
  videoName,
  type VideoQuality,
} from "./video";

/** The part of the bridge recording uses. */
export type RecordBridge = Pick<
  VaultBridge,
  | "videoStart"
  | "videoAppend"
  | "videoPause"
  | "videoResume"
  | "videoStop"
  | "videoSpace"
>;

/** How a recording ended: the patient asked, or something else did. */
export type RecordEnd =
  | "asked"
  | "stopped"
  | "slow"
  | "hidden"
  | "failed"
  | "space"
  | "unfinished";

type Stage =
  | "explain"
  | "starting"
  | "ready"
  | "recording"
  | "paused"
  | "stopping"
  | "failed";

// How often the clock on screen is redrawn. It is not a live region: it is read
// when it is focused, not every second.
const CLOCK_TICK_MS = 500;
const asked = <T,>(question: Promise<T>) => question;

// Recording a video (#359). The camera and the microphone are asked for only
// after the patient chooses Record video and then Use the camera and
// microphone, and every track is stopped when the recording ends, the dialog
// closes, the vault locks (which closes it) or the window is hidden. The
// pieces the recorder makes go to the vault one at a time as they arrive,
// encrypted there; nothing is kept here but the few not yet sent.
export function RecordDialog({
  platform,
  bridge,
  profileId,
  profileName,
  folderIds,
  whileAsking = asked,
  holdLock,
  notice,
  onSaved,
  onClose,
}: {
  /** The operating system, for where to look when the camera is refused. */
  platform: string;
  bridge: RecordBridge;
  profileId: string;
  /** Whose video this is, for the title ("Record a video for Sam"). Without it the title has no name. */
  profileName?: string;
  folderIds: string[];
  /** On a phone the system asks whether myCarlos may use the camera and the
   * microphone, and Android hides the app while it does: the caller holds the
   * lock until it is answered (as for the camera dialog). */
  whileAsking?: <T>(question: Promise<T>) => Promise<T>;
  /** Called while video is being recorded (not while paused): the automatic
   * lock waits for as long as the recording runs. Returns how to let go. */
  holdLock?: () => () => void;
  /** Result of the last vault operation. */
  notice: string;
  /** The recording ended: the new video, or null when nothing complete had been
   * recorded, and what ended it. The caller closes the dialog, refreshes the
   * library and says how it ended. */
  onSaved: (recordId: string | null, endedBy: RecordEnd) => void;
  onClose: () => void;
}) {
  useI18n();
  const phone = isPhone(platform);
  const [stage, setStage] = useState<Stage>("explain");
  const [failure, setFailure] = useState<CameraFailure | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [quality, setQuality] = useState<VideoQuality>(readVideoQuality);
  const [highOk, setHighOk] = useState(false);
  const [delivered, setDelivered] = useState<number | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  // No room to record: the dialog says so and offers Try again, the camera and
  // microphone still off.
  const [needsRoom, setNeedsRoom] = useState(false);
  // How room stands while recording: a warning from 512 MiB left, and the
  // recording ends and is saved at 256 MiB.
  const [room, setRoom] = useState<RecordingProgress | null>(null);
  // A pause or a resume is on its way: the toggle waits for it.
  const [changing, setChanging] = useState(false);
  // The cameras and microphones connected (named once they have been allowed), the ones the open
  // stream really uses, whether the remembered ones were missing, and the microphone test.
  const [devices, setDevices] = useState<DeviceLists>(NO_DEVICES);
  const [using, setUsing] = useState<DeviceChoice>(NO_CHOICE);
  const [fellBack, setFellBack] = useState(false);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  // One camera or microphone is being swapped for another on the open stream: Start and the lists
  // wait for it.
  const [switching, setSwitching] = useState(false);
  const previousStageRef = useRef<Stage | null>(null);
  const [status, setStatus] = useTextState();
  const [, setTick] = useState(0);
  const dialogRef = useRef<HTMLElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const startRef = useRef<HTMLButtonElement | null>(null);
  const stopRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const clock = useRef(new RecordedClock()).current;
  // Each start, and each stop, moves this on, so a camera that answers after
  // the dialog moved on is stopped at once instead of shown.
  const attemptRef = useRef(0);
  const openRef = useRef(true);
  const recordingIdRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  const unsentRef = useRef<Blob[]>([]);
  const unsentBytesRef = useRef(0);
  const sendingRef = useRef<Promise<void> | null>(null);
  const failedSendRef = useRef<unknown>(null);
  const finishingRef = useRef(false);
  // From Pause being pressed until the recorder says it is paused: every piece in that time is
  // kept, whichever it is (a regular piece may already be queued ahead of the one cut at the pause,
  // and a real recorder delivers both a moment later).
  const pausingRef = useRef(false);
  // The latest `finish`, for callbacks made before it exists and kept across renders.
  const finishRef = useRef<(why: RecordEnd) => Promise<void>>(async () => {});

  const stopCamera = useCallback(() => {
    attemptRef.current += 1;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // A track that ends on its own (a camera unplugged, a permission taken back) ends the recording
  // with what there is; before one, the dialog says the camera stopped. Only for the stream that is
  // open: a track stopped here when its device is swapped is not that.
  const watchTrack = useCallback(
    (stream: MediaStream, track: MediaStreamTrack) => {
      track.addEventListener("ended", () => {
        if (streamRef.current !== stream || !stream.getTracks().includes(track))
          return;
        if (recorderRef.current) void finishRef.current("stopped");
        else {
          stopCamera();
          setFailure("stopped");
          setStage("failed");
          setStatus("");
        }
      });
    },
    [setStatus, stopCamera],
  );

  const start = useCallback(
    // `choice` is what to open (the devices in use, with the one chosen from a list replaced);
    // `chosen` is which of the two the patient picked, the only one that is remembered.
    async (choice?: DeviceChoice, chosen?: keyof DeviceChoice) => {
      stopCamera();
      const attempt = attemptRef.current;
      setFailure(null);
      setProblem(null);
      setNeedsRoom(false);
      setStage("starting");
      setStatus(
        deferredText(() =>
          translateNow("interface.RecordDialog.startingTheCameraAndMicrophone"),
        ),
      );
      try {
        // Room first: with too little, neither the camera nor the microphone is
        // turned on.
        const space = await bridge.videoSpace?.();
        if (attempt !== attemptRef.current) return;
        if (space && !space.canRecord) {
          setNeedsRoom(true);
          setStage("failed");
          setStatus("");
          return;
        }
        if (!navigator.mediaDevices?.getUserMedia)
          throw new DOMException("No camera interface", "NotFoundError");
        // The devices chosen last, if any are remembered; if one of them is gone, the system's
        // defaults are used instead, and the dialog says so.
        const wanted = choice ?? readDeviceChoice();
        const open = (chosen: DeviceChoice) =>
          whileAsking(
            navigator.mediaDevices.getUserMedia({
              video: cameraConstraints(
                videoConstraints("standard", phone),
                chosen.camera,
              ),
              audio: microphoneConstraints(chosen.microphone),
            }),
          );
        let stream: MediaStream;
        let gone = false;
        try {
          stream = await open(wanted);
        } catch (error) {
          if (!(wanted.camera || wanted.microphone) || !deviceIsGone(error))
            throw error;
          // Only the device that is gone gives way: the request cannot say which one it was, so
          // each remembered device is tried alone with the system's default for the other, and
          // the defaults for both only if that fails too.
          const tries: DeviceChoice[] = [];
          if (wanted.camera && wanted.microphone)
            tries.push(
              { camera: wanted.camera, microphone: null },
              { camera: null, microphone: wanted.microphone },
            );
          tries.push(NO_CHOICE);
          let opened: MediaStream | null = null;
          for (const [index, chosen] of tries.entries()) {
            try {
              opened = await open(chosen);
              break;
            } catch (again) {
              if (index === tries.length - 1 || !deviceIsGone(again))
                throw again;
            }
          }
          if (!opened) throw error;
          stream = opened;
          gone = true;
        }
        if (attempt !== attemptRef.current) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        for (const track of stream.getTracks()) watchTrack(stream, track);
        setHighOk(highQualityAvailable(stream.getVideoTracks()[0]));
        // Names come only now that the devices have been allowed.
        const connected = await listDevices(navigator.mediaDevices);
        if (attempt !== attemptRef.current) return;
        setDevices(connected);
        const used = devicesInUse(stream, connected);
        setUsing(used);
        setFellBack(gone);
        // A choice made from the lists is remembered only now that its stream is open: a device
        // that is busy or refuses must not become the one asked for every time ("Try again"
        // would retry it for ever). Only the one the patient chose is remembered: the other keeps
        // what was stored (nothing, for the system's default), so choosing a camera does not pin
        // the microphone that happened to be in use.
        if (choice && chosen)
          rememberDeviceChoice({
            ...readDeviceChoice(),
            [chosen]: used[chosen] ?? choice[chosen],
          });
        setStage("ready");
      } catch (error) {
        if (attempt !== attemptRef.current) return;
        setFailure(cameraFailure(error));
        setStage("failed");
        setStatus("");
      }
    },
    [bridge, phone, stopCamera, watchTrack, whileAsking],
  );

  // The preview, once there is a stream and a place for it.
  useEffect(() => {
    if (
      (stage === "ready" || stage === "recording" || stage === "paused") &&
      videoRef.current &&
      streamRef.current &&
      videoRef.current.srcObject !== streamRef.current
    )
      videoRef.current.srcObject = streamRef.current;
  }, [stage]);

  // High is a request on the camera already open: if the webview refuses it,
  // Standard stays.
  const applyQuality = (
    track: MediaStreamTrack | undefined,
    next: VideoQuality,
  ) => {
    const spec = QUALITIES[next];
    void track
      ?.applyConstraints({
        width: { ideal: spec.width },
        height: { ideal: spec.height },
      })
      .catch(() => undefined);
  };
  const chooseQuality = (next: VideoQuality) => {
    setQuality(next);
    rememberVideoQuality(next);
    applyQuality(streamRef.current?.getVideoTracks()[0], next);
  };

  // ---- sending pieces ---------------------------------------------------

  const sendNext = useCallback(async (): Promise<void> => {
    if (sendingRef.current) return sendingRef.current;
    const work = (async () => {
      while (unsentRef.current.length > 0 && !failedSendRef.current) {
        const piece = unsentRef.current[0];
        const id = recordingIdRef.current;
        if (!id) return;
        const bytes = new Uint8Array(await piece.arrayBuffer());
        try {
          const progress = await bridge.videoAppend(
            id,
            sequenceRef.current,
            bytes,
          );
          sequenceRef.current = progress.nextSequence;
          unsentRef.current.shift();
          unsentBytesRef.current -= piece.size;
          setRoom(progress);
          // At the reserve the recording ends and is saved: "Saved. There was
          // no more room."
          if (progress.space === "stop") void finishRef.current("space");
        } catch (error) {
          failedSendRef.current = error;
          // The vault would not take a piece: the recorder is stopped at once,
          // not left saying Recording, and what was saved before it is kept. A
          // disk that filled anyway is told as no room.
          void finishRef.current(isNoSpace(error) ? "space" : "failed");
        } finally {
          bytes.fill(0);
        }
      }
    })();
    sendingRef.current = work;
    try {
      await work;
    } finally {
      sendingRef.current = null;
    }
  }, [bridge]);

  const onPiece = useCallback(
    (data: Blob) => {
      // Nothing is recorded while paused: a recorder is paused to stop frames and sound, and a piece
      // that comes anyway is not kept. The exceptions are the pieces of the moment of the pause (see
      // `pausingRef`) and the last one as the recording ends.
      if (
        recorderRef.current?.state === "paused" &&
        !pausingRef.current &&
        !finishingRef.current
      )
        return;
      if (data.size === 0) return;
      unsentRef.current.push(data);
      unsentBytesRef.current += data.size;
      void sendNext();
      // Past the limit the vault is not keeping up: end the recording and keep
      // what was recorded, rather than fill the webview's memory.
      if (unsentBytesRef.current > MAX_UNSENT_BYTES && !finishingRef.current)
        void finishRef.current("slow");
    },
    [sendNext],
  );

  /** Ends the recording: the recorder stops, the last pieces go to the vault,
   * the video is saved. `why` is what to tell the patient when it was not the
   * patient who ended it. */
  const finish = useCallback(
    async (why: RecordEnd) => {
      const id = recordingIdRef.current;
      const recorder = recorderRef.current;
      if (!id || finishingRef.current) return;
      finishingRef.current = true;
      setConfirmStop(false);
      setStage("stopping");
      clock.stop();
      setStatus(
        deferredText(() =>
          translateNow("interface.RecordDialog.savingTheVideo"),
        ),
      );
      // The recorder ends first: its last piece arrives as it stops.
      if (recorder && recorder.state !== "inactive") {
        await new Promise<void>((resolve) => {
          recorder.addEventListener("stop", () => resolve(), { once: true });
          try {
            recorder.stop();
          } catch {
            resolve();
          }
        });
      }
      recorderRef.current = null;
      stopCamera();
      await sendNext();
      const sendFailed = failedSendRef.current;
      try {
        const saved = await bridge.videoStop(id);
        recordingIdRef.current = null;
        if (!openRef.current) return;
        // A piece the vault would not take, and nothing complete before it:
        // nothing was kept, and the library says so.
        if (sendFailed && !saved.recordId) {
          onSaved(null, isNoSpace(sendFailed) ? "space" : "failed");
          return;
        }
        onSaved(
          saved.recordId,
          sendFailed && why === "asked"
            ? isNoSpace(sendFailed)
              ? "space"
              : "failed"
            : why,
        );
      } catch (error) {
        recordingIdRef.current = null;
        if (!openRef.current) return;
        // Only when Stop itself was refused for want of room: ending it needed
        // room to finish it (a recording cut off mid-fragment or by a write the
        // disk refused is finished by copying it), so the vault kept it, not
        // lost, to be finished when there is room.
        if (isNoSpace(error)) {
          onSaved(null, "unfinished");
          return;
        }
        setStage("failed");
        setFailure(null);
        setProblem(vaultErrorMessage(error));
        setStatus("");
      }
    },
    [bridge, clock, onSaved, sendNext, setStatus, stopCamera],
  );

  // ---- recording --------------------------------------------------------

  const record = async () => {
    const stream = streamRef.current;
    if (!stream || stage !== "ready" || switching) return;
    const mimeType = pickMp4Type();
    if (!mimeType) {
      setProblem(
        translateNow("interface.RecordDialog.thisDeviceCannotRecordMp4"),
      );
      setStage("failed");
      return;
    }
    setProblem(null);
    setRoom(null);
    setStage("starting");
    let startedId: string | null = null;
    try {
      const started = await bridge.videoStart(
        profileId,
        folderIds,
        videoName(new Date()),
      );
      if (!openRef.current || !streamRef.current) {
        // Closed while starting: nothing was recorded.
        void bridge.videoStop(started.recordingId).catch(() => undefined);
        return;
      }
      startedId = started.recordingId;
      recordingIdRef.current = started.recordingId;
      sequenceRef.current = 0;
      unsentRef.current = [];
      unsentBytesRef.current = 0;
      failedSendRef.current = null;
      finishingRef.current = false;
      const spec = QUALITIES[quality];
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: spec.videoBitsPerSecond,
        audioBitsPerSecond: spec.audioBitsPerSecond,
      });
      recorderRef.current = recorder;
      recorder.addEventListener("dataavailable", (event) =>
        onPiece((event as BlobEvent).data),
      );
      recorder.addEventListener(
        "error",
        () => void finishRef.current("stopped"),
      );
      // About a piece a second.
      recorder.start(1000);
      clock.start();
      setDelivered(deliveredHeight(stream.getVideoTracks()[0]));
      setStage("recording");
      setStatus(
        deferredText(() => translateNow("interface.RecordDialog.recording")),
      );
    } catch (error) {
      // Nothing is recording: the camera and microphone go off, and a recording
      // the vault began is ended (nothing complete, so nothing is added).
      recorderRef.current = null;
      recordingIdRef.current = null;
      stopCamera();
      if (startedId) void bridge.videoStop(startedId).catch(() => undefined);
      setStage("failed");
      setProblem(vaultErrorMessage(error));
      setStatus("");
    }
  };

  // While paused the camera keeps showing (the person can still see themselves before going
  // on), so its track stays on; only the microphone is silenced. Nothing is recorded meanwhile:
  // the recorder is paused, which is what stops frames and sound being appended.
  const setMicrophoneEnabled = (enabled: boolean) => {
    for (const track of streamRef.current?.getAudioTracks() ?? [])
      track.enabled = enabled;
  };

  const pause = async () => {
    const recorder = recorderRef.current;
    const id = recordingIdRef.current;
    if (stage !== "recording" || !recorder || !id || changing) return;
    setChanging(true);
    // What was cut so far goes to the vault before the pause, so the vault
    // can keep it safe through the pause.
    pausingRef.current = true;
    try {
      recorder.requestData();
    } catch {
      // A recorder that cannot say what it has yet: the pieces come as they do, and no piece is
      // owed for the pause.
      pausingRef.current = false;
    }
    // The pieces of the moment of the pause are all in by the time the recorder says it paused.
    recorder.addEventListener(
      "pause",
      () => {
        pausingRef.current = false;
      },
      { once: true },
    );
    recorder.pause();
    clock.stop();
    setMicrophoneEnabled(false);
    setStage("paused");
    await sendNext();
    // A piece the vault refused on the way ends the recording (see sendNext):
    // it is not announced as paused.
    if (failedSendRef.current) {
      setChanging(false);
      return;
    }
    try {
      await bridge.videoPause(id);
    } catch (error) {
      // Not paused as far as the vault is concerned: say so, not "paused".
      setProblem(vaultErrorMessage(error));
      setChanging(false);
      return;
    }
    setChanging(false);
    setStatus(
      deferredText(() =>
        translateNow("interface.RecordDialog.recordingPaused"),
      ),
    );
  };

  const resume = async () => {
    const recorder = recorderRef.current;
    const id = recordingIdRef.current;
    if (stage !== "paused" || !recorder || !id || changing) return;
    setChanging(true);
    // Room is looked at again before recording goes on: with too little, the
    // recording is saved as it is, not continued into a full disk.
    const space = await bridge.videoSpace?.().catch(() => undefined);
    if (space && !space.canRecord) {
      setChanging(false);
      void finishRef.current("space");
      return;
    }
    try {
      await bridge.videoResume(id);
    } catch (error) {
      setProblem(vaultErrorMessage(error));
      setChanging(false);
      return;
    }
    setChanging(false);
    setProblem(null);
    pausingRef.current = false;
    setMicrophoneEnabled(true);
    recorder.resume();
    clock.start();
    setStage("recording");
    setStatus(
      deferredText(() =>
        translateNow("interface.RecordDialog.recordingResumed"),
      ),
    );
  };

  // ---- the lock, the clock, the window ----------------------------------

  finishRef.current = finish;

  // The automatic lock waits while video is being recorded, and not while it is
  // paused.
  useEffect(() => {
    if (stage !== "recording") return;
    return holdLock?.();
  }, [holdLock, stage]);

  useEffect(() => {
    if (stage !== "recording") return;
    const timer = window.setInterval(
      () => setTick((n) => n + 1),
      CLOCK_TICK_MS,
    );
    return () => window.clearInterval(timer);
  }, [stage]);

  // A hidden window does not keep the camera and microphone on: the recording
  // is ended and saved. (The vault also locks then, which closes this dialog.)
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      if (recorderRef.current) void finishRef.current("hidden");
      else if (streamRef.current) {
        stopCamera();
        setFailure("stopped");
        setStage("failed");
        setStatus("");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [stopCamera, setStatus]);

  // Closing for any reason, a lock included, ends the camera and microphone. A
  // recording the vault holds is parked by the lock itself.
  useEffect(() => {
    openRef.current = true;
    return () => {
      openRef.current = false;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      try {
        if (recorder && recorder.state !== "inactive") recorder.stop();
      } catch {
        // Already ended.
      }
      stopCamera();
    };
  }, [stopCamera]);

  const close = () => {
    if (stage === "stopping") return;
    // Never discards silently: a recording in progress is ended and saved, and
    // only when the patient says so.
    if (stage === "recording" || stage === "paused") {
      setConfirmStop(true);
      return;
    }
    // Also while starting: the camera that was being asked for is turned off the
    // moment it answers, and a recording the vault had begun is ended.
    stopCamera();
    onClose();
  };
  useModalFocus(true, dialogRef, close, firstRef);

  useEffect(() => {
    const was = previousStageRef.current;
    previousStageRef.current = stage;
    // A device switched from its list no longer restarts the preview, so the focus never leaves
    // that list; Start takes it only when the preview first comes up.
    if (stage === "ready" && was !== "ready") startRef.current?.focus();
    if (stage === "failed") retryRef.current?.focus();
    if (stage === "recording" || stage === "paused") stopRef.current?.focus();
  }, [stage]);
  useEffect(() => {
    if (confirmStop) keepRef.current?.focus();
  }, [confirmStop]);

  // Plugging or unplugging a camera or microphone updates the lists at once. A device that was
  // in use and goes ends its track, which the dialog already handles; a recording keeps the
  // devices it started with whatever happens to the lists.
  useEffect(() => {
    const media = navigator.mediaDevices;
    if (
      !media?.addEventListener ||
      stage === "explain" ||
      stage === "failed" ||
      stage === "stopping"
    )
      return;
    let live = true;
    const refresh = () =>
      void listDevices(media).then((connected) => {
        if (live) setDevices(connected);
      });
    media.addEventListener("devicechange", refresh);
    return () => {
      live = false;
      media.removeEventListener("devicechange", refresh);
    };
  }, [stage]);

  // The microphone test: a level meter on the microphone already open, only while the preview
  // is up and nothing is being recorded. Nothing is recorded, kept or sent.
  useEffect(() => {
    if (!testing) return;
    const stream = streamRef.current;
    const reader = stage === "ready" && stream ? openLevelReader(stream) : null;
    if (!reader) {
      setTesting(false);
      return;
    }
    const timer = window.setInterval(() => setLevel(reader.read()), 100);
    return () => {
      window.clearInterval(timer);
      reader.close();
      setLevel(0);
    };
  }, [testing, stage, using]);

  // Switching changes only the device that was chosen: the other keeps running, so the picture does
  // not blink when the microphone is changed and the sound does not drop when the camera is. The new
  // device is opened alone, and its track takes the old one's place in the open stream (the preview
  // follows the stream). Never while recording or starting a recording: a recording keeps the camera
  // and microphone it began with. A device that will not open leaves everything as it was.
  const switchDevice = async (kind: "camera" | "microphone", id: string) => {
    const stream = streamRef.current;
    if (stage !== "ready" || switching || !stream || using[kind] === id) return;
    if (!navigator.mediaDevices?.getUserMedia) return;
    const attempt = attemptRef.current;
    setTesting(false);
    setSwitching(true);
    setProblem(null);
    try {
      const opened = await whileAsking(
        navigator.mediaDevices.getUserMedia(
          kind === "camera"
            ? {
                video: cameraConstraints(
                  videoConstraints("standard", phone),
                  id,
                ),
              }
            : { audio: microphoneConstraints(id) },
        ),
      );
      // The dialog moved on while the device was opening (closed, locked, hidden, the camera
      // stopped): what was just opened is not wanted.
      if (attempt !== attemptRef.current || streamRef.current !== stream) {
        for (const track of opened.getTracks()) track.stop();
        return;
      }
      const fresh =
        kind === "camera"
          ? opened.getVideoTracks()[0]
          : opened.getAudioTracks()[0];
      // Only the track asked for is kept: anything else the answer carries (a stub that hands back
      // both) is let go of at once, never left on.
      for (const track of opened.getTracks()) if (track !== fresh) track.stop();
      if (!fresh) throw new DOMException("No track", "NotFoundError");
      const old =
        kind === "camera" ? stream.getVideoTracks() : stream.getAudioTracks();
      for (const track of old) {
        stream.removeTrack(track);
        track.stop();
      }
      stream.addTrack(fresh);
      watchTrack(stream, fresh);
      if (kind === "camera") {
        setHighOk(highQualityAvailable(fresh));
        if (quality === "high") applyQuality(fresh, "high");
      }
      const used = devicesInUse(stream, devices);
      setUsing(used);
      setFellBack(false);
      // Only the one chosen is remembered, and only now that it is open (as for a restart).
      rememberDeviceChoice({
        ...readDeviceChoice(),
        [kind]: used[kind] ?? id,
      });
    } catch {
      if (attempt !== attemptRef.current) return;
      // The preview and the lists stay as they were (the list shows the device still in use); the
      // dialog says the other one did not open.
      setProblem(translateNow("interface.RecordDialog.deviceNotSwitched"));
    } finally {
      setSwitching(false);
    }
  };

  const pausedNow = stage === "paused";
  const recordingNow = stage === "recording" || pausedNow;
  const elapsed = formatClock(clock.elapsed());
  const standard = translateNow("interface.RecordDialog.standard");
  const high = translateNow("interface.RecordDialog.high");
  // The settings (the two lists, the microphone test, the picture quality) sit in a column beside
  // the preview on a wide window and below it on a narrow one; they are there once the devices
  // have been allowed. While recording the column stays for the lists (shown, not changeable); the
  // picture quality is there from the start, whether or not the devices could be listed.
  const hasDevices =
    devices.cameras.length > 0 || devices.microphones.length > 0;
  const hasSettings = stage === "ready" || (recordingNow && hasDevices);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={close}>
      <section
        ref={dialogRef}
        className="record-dialog camera-dialog record-video-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="record-title"
        aria-describedby={stage === "explain" ? "record-about" : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head record-head">
          <h2 id="record-title">
            {profileName
              ? translateNow("interface.RecordDialog.recordAVideoFor", {
                  name: profileName,
                })
              : translateNow("interface.RecordDialog.recordAVideo")}
          </h2>
          <button className="button record-close" type="button" onClick={close}>
            {translateNow("photo.close")}
          </button>
        </header>
        <div
          className={
            hasSettings ? "record-layout has-settings" : "record-layout"
          }
        >
          <div className="record-main camera-body">
            {stage === "explain" && (
              <div id="record-about" className="camera-about">
                <p>
                  {translateNow(
                    "interface.RecordDialog.theVideoIsRecordedWithSound",
                  )}
                </p>
                <p>
                  {phone
                    ? translateNow("interface.RecordDialog.yourPhoneAsksOnce")
                    : translateNow(
                        "interface.RecordDialog.theCameraAndMicrophoneAreOn",
                      )}
                </p>
              </div>
            )}
            {stage === "starting" && (
              <p>
                {translateNow(
                  "interface.RecordDialog.startingTheCameraAndMicrophone",
                )}
              </p>
            )}
            <div className="record-preview">
              <video
                ref={videoRef}
                className="camera-view"
                hidden={
                  stage !== "ready" &&
                  stage !== "recording" &&
                  stage !== "paused"
                }
                aria-label={translateNow("interface.CameraDialog.cameraView")}
                autoPlay
                muted
                playsInline
              />
              {recordingNow && (
                /* The elapsed time sits on the picture, top left. Not a live region: it would speak
                 every second. Read on focus. */
                <p className="record-clock" tabIndex={0}>
                  {translateNow("interface.RecordDialog.recorded", {
                    time: elapsed,
                  })}
                </p>
              )}
            </div>
            {recordingNow && (
              <div className="record-state">
                <p
                  className={
                    pausedNow
                      ? "record-badge record-badge-paused"
                      : "record-badge"
                  }
                >
                  <Icon name={pausedNow ? "pause" : "camera"} />
                  <span>
                    {pausedNow
                      ? translateNow("interface.RecordDialog.paused")
                      : translateNow("interface.RecordDialog.recording")}
                  </span>
                </p>
                {pausedNow && (
                  <p className="record-paused-note">
                    {translateNow(
                      "interface.RecordDialog.pausedCameraAndMicrophoneStillOn",
                    )}
                  </p>
                )}
                {delivered && (
                  <p className="record-delivered">
                    {translateNow("interface.RecordDialog.recordingAt", {
                      height: String(delivered),
                    })}
                  </p>
                )}
              </div>
            )}
            {/* The record controls are one row under the picture, centred in its column. */}
            {stage !== "starting" && (
              <div className="record-controls">
                {stage === "explain" && (
                  <button
                    ref={firstRef}
                    className="button primary"
                    type="button"
                    onClick={() => void start()}
                  >
                    <Icon name="camera" />
                    <span>
                      {translateNow(
                        "interface.RecordDialog.useTheCameraAndMicrophone",
                      )}
                    </span>
                  </button>
                )}
                {stage === "ready" && (
                  <button
                    ref={startRef}
                    className="button record-start"
                    type="button"
                    aria-disabled={switching}
                    onClick={() => void record()}
                  >
                    <span className="record-start-dot" aria-hidden="true" />
                    <span>
                      {translateNow("interface.RecordDialog.startRecording")}
                    </span>
                  </button>
                )}
                {recordingNow && (
                  <>
                    {typeof MediaRecorder !== "undefined" &&
                      typeof MediaRecorder.prototype.pause === "function" && (
                        <button
                          className="button"
                          type="button"
                          aria-disabled={changing}
                          onClick={() => void (pausedNow ? resume() : pause())}
                        >
                          <Icon name={pausedNow ? "camera" : "pause"} />
                          <span>
                            {pausedNow
                              ? translateNow(
                                  "interface.RecordDialog.resumeRecording",
                                )
                              : translateNow(
                                  "interface.RecordDialog.pauseRecording",
                                )}
                          </span>
                        </button>
                      )}
                    <button
                      ref={stopRef}
                      className="button primary"
                      type="button"
                      onClick={() => void finish("asked")}
                    >
                      {translateNow("interface.RecordDialog.stopAndSave")}
                    </button>
                  </>
                )}
                {stage === "stopping" && (
                  <button
                    className="button primary"
                    type="button"
                    aria-disabled="true"
                  >
                    {translateNow("rename.saving")}
                  </button>
                )}
                {stage === "failed" && (failure || needsRoom) && (
                  <button
                    ref={retryRef}
                    className="button primary"
                    type="button"
                    onClick={() => void start()}
                  >
                    {translateNow("interface.CameraDialog.tryAgain")}
                  </button>
                )}
              </div>
            )}
            {/* Always present, empty until there is something to say: a live region that is inserted
              together with its text is not announced by every screen reader. A live region and not
              role="status", which the dialog's own status line already is (one per dialog). */}
            <p aria-live="polite" className="record-device-note">
              {fellBack && (stage === "ready" || recordingNow)
                ? translateNow("interface.RecordDialog.deviceFellBack")
                : ""}
            </p>
            {recordingNow && room?.space === "low" && (
              <p className="camera-failure" role="alert">
                {(() => {
                  const minutes = minutesLeft(
                    room.freeBytes,
                    room.storedBytes,
                    clock.elapsed(),
                  );
                  return minutes === null
                    ? translateNow("interface.RecordDialog.lowOnRoom")
                    : translateNow("interface.RecordDialog.lowOnRoomMinutes", {
                        minutes,
                      });
                })()}
              </p>
            )}
            {confirmStop && (
              <div
                className="record-confirm"
                role="alertdialog"
                aria-labelledby="record-stop-title"
              >
                <p id="record-stop-title">
                  {translateNow("interface.RecordDialog.stopAndSaveTheVideo")}
                </p>
                <div className="dialog-actions">
                  <button
                    ref={keepRef}
                    className="button"
                    type="button"
                    onClick={() => setConfirmStop(false)}
                  >
                    {translateNow("interface.RecordDialog.keepRecording")}
                  </button>
                  <button
                    className="button primary"
                    type="button"
                    onClick={() => void finish("asked")}
                  >
                    {translateNow("interface.RecordDialog.stopAndSave")}
                  </button>
                </div>
              </div>
            )}
            {stage === "failed" && (
              <p className="camera-failure" role="alert">
                {needsRoom
                  ? translateNow("interface.RecordDialog.notEnoughRoom")
                  : failure
                    ? `${cameraFailureMessage(failure, platform)} ${translateNow("interface.RecordDialog.videoNeedsBoth")}`
                    : problem}
              </p>
            )}
            {stage !== "failed" && problem && (
              <p className="camera-failure" role="alert">
                {problem}
              </p>
            )}
          </div>
          {hasSettings && (
            <aside
              className="record-settings"
              aria-label={translateNow(
                "interface.RecordDialog.recordingSettings",
              )}
            >
              {hasDevices && (
                <fieldset className="record-devices">
                  <legend className="sr-only">
                    {translateNow("interface.RecordDialog.cameraAndMicrophone")}
                  </legend>
                  <DevicePick
                    kind="camera"
                    label={translateNow("interface.RecordDialog.camera")}
                    unnamed="interface.RecordDialog.unnamedCamera"
                    devices={devices.cameras}
                    current={using.camera}
                    disabled={stage !== "ready"}
                    onChange={(kind, id) => void switchDevice(kind, id)}
                  />
                  <DevicePick
                    kind="microphone"
                    label={translateNow("interface.RecordDialog.microphone")}
                    unnamed="interface.RecordDialog.unnamedMicrophone"
                    devices={devices.microphones}
                    current={using.microphone}
                    // Not disabled while a switch is under way: a disabled list loses the keyboard's
                    // place. A change made meanwhile is ignored (see `switchDevice`) and the list
                    // shows the device in use again.
                    disabled={stage !== "ready"}
                    onChange={(kind, id) => void switchDevice(kind, id)}
                  />
                  {stage === "ready" && typeof AudioContext !== "undefined" && (
                    <div className="record-mic-test">
                      <button
                        className="button"
                        type="button"
                        aria-pressed={testing}
                        onClick={() => setTesting((on) => !on)}
                      >
                        {translateNow(
                          testing
                            ? "interface.RecordDialog.stopTestingMicrophone"
                            : "interface.RecordDialog.testMicrophone",
                        )}
                      </button>
                      {testing && (
                        <>
                          <meter
                            min={0}
                            max={1}
                            value={level}
                            aria-label={translateNow(
                              "interface.RecordDialog.microphoneLevel",
                            )}
                          />
                          <p className="record-mic-hint">
                            {translateNow(
                              "interface.RecordDialog.saySomething",
                            )}
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </fieldset>
              )}
              {stage === "ready" && (
                <fieldset className="record-quality appearance-choice">
                  <legend>
                    {translateNow("interface.RecordDialog.pictureQuality")}
                  </legend>
                  <label className="appearance-option">
                    <input
                      type="radio"
                      name="video-quality"
                      checked={quality === "standard"}
                      onChange={() => chooseQuality("standard")}
                    />
                    <span>
                      {standard}
                      <span className="record-quality-size">
                        {translateNow(
                          "interface.RecordDialog.aboutStandardPerHour",
                        )}
                      </span>
                    </span>
                  </label>
                  {highOk && (
                    <label className="appearance-option">
                      <input
                        type="radio"
                        name="video-quality"
                        checked={quality === "high"}
                        onChange={() => chooseQuality("high")}
                      />
                      <span>
                        {high}
                        <span className="record-quality-size">
                          {translateNow(
                            "interface.RecordDialog.aboutHighPerHour",
                          )}
                        </span>
                      </span>
                    </label>
                  )}
                  <p>
                    {translateNow(
                      "interface.RecordDialog.theCameraAndMicrophoneAreOnNow",
                    )}
                  </p>
                </fieldset>
              )}
              <p className="record-settings-note">
                {translateNow("interface.RecordDialog.settingsNote")}
              </p>
            </aside>
          )}
        </div>
        <p className="native-dialog-status" role="status">
          {[status, notice].filter(Boolean).join(" ")}
        </p>
      </section>
    </div>
  );
}

/** One of the two device lists. With more than one device it is a list to choose from (the one in
 * use is selected); with one, the same list, disabled, so the patient still sees which one is in
 * use and where the choice is. */
function DevicePick({
  kind,
  label,
  unnamed,
  devices,
  current,
  disabled,
  onChange,
}: {
  kind: "camera" | "microphone";
  label: string;
  unnamed:
    | "interface.RecordDialog.unnamedCamera"
    | "interface.RecordDialog.unnamedMicrophone";
  devices: DeviceInfo[];
  current: string | null;
  disabled: boolean;
  onChange: (kind: "camera" | "microphone", id: string) => void;
}) {
  if (devices.length === 0) return null;
  const nameOf = (device: DeviceInfo, index: number) =>
    device.label || translateNow(unnamed, { number: index + 1 });
  // The one in use, if the browser says which it is. When it cannot be matched to a listed device
  // (the system's default, which a stream reports under an alias id), "System default" is shown:
  // never the first device of the list, which would be a guess shown as a fact.
  const selected = devices.find((device) => device.id === current) ?? null;
  // With one device there is nothing to choose, but the list is still there, disabled, so it is
  // clear where a choice would be made and which device is in use. The one device is the one in
  // use, whatever the stream reports for it.
  if (devices.length === 1)
    return (
      <label className="record-device">
        <span>{label}</span>
        <select
          id={`record-device-${kind}`}
          value={devices[0].id}
          disabled
          onChange={() => undefined}
        >
          <option value={devices[0].id}>{nameOf(devices[0], 0)}</option>
        </select>
      </label>
    );
  return (
    <label className="record-device">
      <span>{label}</span>
      <select
        id={`record-device-${kind}`}
        value={selected ? selected.id : ""}
        disabled={disabled}
        onChange={(event) => onChange(kind, event.currentTarget.value)}
      >
        {!selected && (
          <option value="" disabled>
            {translateNow("interface.RecordDialog.systemDefaultDevice")}
          </option>
        )}
        {devices.map((device, index) => (
          <option key={device.id} value={device.id}>
            {nameOf(device, index)}
          </option>
        ))}
      </select>
    </label>
  );
}

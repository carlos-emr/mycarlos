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
  // The piece cut when the pause was pressed has yet to come (a real recorder delivers it a moment
  // later, already paused): it is the one piece a paused recording takes.
  const pausePieceRef = useRef(false);
  // The latest `finish`, for callbacks made before it exists and kept across renders.
  const finishRef = useRef<(why: RecordEnd) => Promise<void>>(async () => {});

  const stopCamera = useCallback(() => {
    attemptRef.current += 1;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const start = useCallback(async () => {
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
      const stream = await whileAsking(
        navigator.mediaDevices.getUserMedia({
          video: videoConstraints("standard", phone),
          audio: true,
        }),
      );
      if (attempt !== attemptRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      for (const track of stream.getTracks())
        track.addEventListener("ended", () => {
          if (streamRef.current !== stream) return;
          // A track that ends while recording ends the recording, keeping what
          // there is; before it, the dialog says the camera stopped.
          if (recorderRef.current) void finishRef.current("stopped");
          else {
            stopCamera();
            setFailure("stopped");
            setStage("failed");
            setStatus("");
          }
        });
      setHighOk(highQualityAvailable(stream.getVideoTracks()[0]));
      setStage("ready");
    } catch (error) {
      if (attempt !== attemptRef.current) return;
      setFailure(cameraFailure(error));
      setStage("failed");
      setStatus("");
    }
  }, [bridge, phone, stopCamera, whileAsking]);

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
  const chooseQuality = (next: VideoQuality) => {
    setQuality(next);
    rememberVideoQuality(next);
    const track = streamRef.current?.getVideoTracks()[0];
    const spec = QUALITIES[next];
    void track
      ?.applyConstraints({
        width: { ideal: spec.width },
        height: { ideal: spec.height },
      })
      .catch(() => undefined);
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
      // that comes anyway is not kept. The exceptions are the piece cut at the pause and the last one
      // as the recording ends.
      if (
        recorderRef.current?.state === "paused" &&
        !pausePieceRef.current &&
        !finishingRef.current
      )
        return;
      pausePieceRef.current = false;
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
    if (!stream || stage !== "ready") return;
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
    pausePieceRef.current = true;
    try {
      recorder.requestData();
    } catch {
      // A recorder that cannot say what it has yet: the pieces come as they do.
    }
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
    pausePieceRef.current = false;
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
    if (stage === "ready") startRef.current?.focus();
    if (stage === "failed") retryRef.current?.focus();
    if (stage === "recording" || stage === "paused") stopRef.current?.focus();
  }, [stage]);
  useEffect(() => {
    if (confirmStop) keepRef.current?.focus();
  }, [confirmStop]);

  const pausedNow = stage === "paused";
  const recordingNow = stage === "recording" || pausedNow;
  const elapsed = formatClock(clock.elapsed());
  const standard = translateNow("interface.RecordDialog.standard");
  const high = translateNow("interface.RecordDialog.high");

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
        <header className="dialog-head">
          <h2 id="record-title">
            {translateNow("interface.RecordDialog.recordAVideo")}
          </h2>
        </header>
        <div className="camera-body">
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
          <video
            ref={videoRef}
            className="camera-view"
            hidden={
              stage !== "ready" && stage !== "recording" && stage !== "paused"
            }
            aria-label={translateNow("interface.CameraDialog.cameraView")}
            autoPlay
            muted
            playsInline
          />
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
                      {translateNow("interface.RecordDialog.aboutHighPerHour")}
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
              {/* Not a live region: it would speak every second. Read on focus. */}
              <p className="record-clock" tabIndex={0}>
                {translateNow("interface.RecordDialog.recorded", {
                  time: elapsed,
                })}
              </p>
              {delivered && (
                <p className="record-delivered">
                  {translateNow("interface.RecordDialog.recordingAt", {
                    height: String(delivered),
                  })}
                </p>
              )}
            </div>
          )}
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
        <p className="native-dialog-status" role="status">
          {[status, notice].filter(Boolean).join(" ")}
        </p>
        <footer className="dialog-actions camera-actions">
          {stage === "explain" && (
            <>
              <button className="button" type="button" onClick={close}>
                {translateNow("common.cancel")}
              </button>
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
            </>
          )}
          {stage === "starting" && (
            <button className="button" type="button" onClick={close}>
              {translateNow("common.cancel")}
            </button>
          )}
          {stage === "ready" && (
            <>
              <button className="button" type="button" onClick={close}>
                {translateNow("common.cancel")}
              </button>
              <button
                ref={startRef}
                className="button primary"
                type="button"
                onClick={() => void record()}
              >
                <Icon name="camera" />
                <span>
                  {translateNow("interface.RecordDialog.startRecording")}
                </span>
              </button>
            </>
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
                        ? translateNow("interface.RecordDialog.resumeRecording")
                        : translateNow("interface.RecordDialog.pauseRecording")}
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
          {stage === "failed" && (
            <>
              <button className="button" type="button" onClick={close}>
                {translateNow("photo.close")}
              </button>
              {(failure || needsRoom) && (
                <button
                  ref={retryRef}
                  className="button primary"
                  type="button"
                  onClick={() => void start()}
                >
                  {translateNow("interface.CameraDialog.tryAgain")}
                </button>
              )}
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

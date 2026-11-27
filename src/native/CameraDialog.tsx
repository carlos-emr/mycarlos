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
  encodePhoto,
  cameraExplained,
  cameraFailure,
  cameraFailureMessage,
  isPhone,
  photoSize,
  rememberCameraExplained,
  type CameraFailure,
} from "./photo";
import {
  NO_DEVICES,
  cameraConstraints,
  deviceIsGone,
  devicesInUse,
  listDevices,
  readDeviceChoice,
  rememberDeviceChoice,
  type DeviceLists,
} from "./mediaDevices";
import { DevicePick } from "./DevicePick";

type Stage = "explain" | "starting" | "live" | "preview" | "failed";

// On a computer the question needs no holding. Stable, so `start` (and the
// camera an opening starts) is not made again on every render.
const asked = <T,>(question: Promise<T>) => question;

// What the photo asks of the camera when none was chosen: on a phone the back one, a good size.
const PHOTO_VIDEO: MediaTrackConstraints = {
  facingMode: "environment",
  width: { ideal: 1920 },
  height: { ideal: 1080 },
};

// The camera is used for this dialog only. It is asked for after the patient
// chooses Use the camera (or opens the dialog once they have before), for
// video and never sound, and every track is stopped as soon as the photo is
// taken and whenever the dialog closes, the vault locks (which closes it), or
// the window is hidden. A photo is drawn to a canvas and encoded there as a
// JPEG, so it carries no camera metadata; the vault checks and cleans it again
// (photo.rs) before encrypting it.
export function CameraDialog({
  platform,
  whileAsking = asked,
  notice,
  saving,
  onUse,
  onClose,
}: {
  /** The operating system, for where to look when the camera is refused. */
  platform: string;
  /** On a phone, the system asks whether myCarlos may use the camera, and
   * Android hides the app while it does. The vault must not lock under that
   * question, as under a file picker; the caller holds the lock until it is
   * answered, then looks again (D97). */
  whileAsking?: <T>(question: Promise<T>) => Promise<T>;
  /** Result of the last vault operation: a failed save is reported here. */
  notice: string;
  /** Whether the photo is being saved. */
  saving: boolean;
  /** Saves the JPEG. Its bytes are overwritten once this settles; on success
   * the caller closes the dialog. */
  onUse: (jpeg: Uint8Array) => Promise<void>;
  onClose: () => void;
}) {
  useI18n();
  // Opened again after the camera worked once: straight to the camera.
  const [autoStart] = useState(cameraExplained);
  const [stage, setStage] = useState<Stage>(autoStart ? "starting" : "explain");
  const [failure, setFailure] = useState<CameraFailure | null>(null);
  const [ready, setReady] = useState(false);
  const [photoReady, setPhotoReady] = useState(false);
  const [status, setStatus] = useTextState();
  const [preparing, setPreparing] = useState(false);
  // The cameras now connected and the one in use (null: the system's default), as the video
  // recording dialog lists them (#359); and whether the camera remembered from last time was gone.
  const [devices, setDevices] = useState<DeviceLists>(NO_DEVICES);
  const [using, setUsing] = useState<string | null>(null);
  const [fellBack, setFellBack] = useState(false);
  // Set when the camera was just switched from its list, so the focus returns to that list.
  const switchedRef = useRef(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const shutterRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const retakeRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Each start, and each stop, moves this on, so a camera that answers after
  // the dialog moved on is stopped at once instead of shown.
  const attemptRef = useRef(0);

  const stopCamera = useCallback(() => {
    attemptRef.current += 1;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setReady(false);
  }, []);
  const clearPhoto = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 0;
    canvas.height = 0;
  }, []);

  // `chosen` is a camera picked from the list (its exact id); without one, the camera remembered
  // from last time, and without that the system's default.
  const start = useCallback(
    async (chosen?: string) => {
      stopCamera();
      clearPhoto();
      setPhotoReady(false);
      const attempt = attemptRef.current;
      setFailure(null);
      setStage("starting");
      setStatus(
        deferredText(() =>
          translateNow("interface.CameraDialog.startingTheCamera"),
        ),
      );
      try {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new DOMException("No camera interface", "NotFoundError");
        // The camera chosen from the list or remembered from last time; if it is gone (unplugged,
        // or not the same one any more), the system's default is used instead and the dialog says so.
        const wanted = chosen ?? readDeviceChoice().camera;
        const open = (camera: string | null) =>
          whileAsking(
            navigator.mediaDevices.getUserMedia({
              video: cameraConstraints(PHOTO_VIDEO, camera),
              audio: false,
            }),
          );
        let stream: MediaStream;
        let gone = false;
        try {
          stream = await open(wanted);
        } catch (error) {
          if (!wanted || !deviceIsGone(error)) throw error;
          stream = await open(null);
          gone = true;
        }
        if (attempt !== attemptRef.current) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        for (const track of stream.getTracks())
          track.addEventListener("ended", () => {
            if (streamRef.current !== stream) return;
            stopCamera();
            setFailure("stopped");
            setStage("failed");
            setStatus("");
          });
        rememberCameraExplained();
        // Names come only now that the camera has been allowed.
        const connected = await listDevices(navigator.mediaDevices);
        if (attempt !== attemptRef.current) return;
        setDevices(connected);
        const used = devicesInUse(stream, connected).camera;
        setUsing(used);
        setFellBack(gone);
        // A camera picked from the list is remembered only now that its stream is open: one that
        // is busy or refuses must not become the one asked for every time. The microphone choice
        // of the video dialog, which shares the stored choice, is kept as it was.
        if (chosen)
          rememberDeviceChoice({
            ...readDeviceChoice(),
            camera: used ?? chosen,
          });
        setStage("live");
      } catch (error) {
        if (attempt !== attemptRef.current) return;
        setFailure(cameraFailure(error));
        setStage("failed");
        setStatus("");
      }
    },
    [clearPhoto, stopCamera, whileAsking],
  );

  useEffect(() => {
    if (!autoStart) return;
    void start();
    return stopCamera;
  }, [autoStart, start, stopCamera]);

  // The video exists once the stage is live.
  useEffect(() => {
    if (stage === "live" && videoRef.current && streamRef.current)
      videoRef.current.srcObject = streamRef.current;
  }, [stage]);

  // Closing for any reason, a lock included, ends the camera and the photo.
  useEffect(
    () => () => {
      stopCamera();
      clearPhoto();
    },
    [clearPhoto, stopCamera],
  );
  // A photo still being prepared when the dialog closes (a lock included) is
  // not saved: after a quick unlock it would land in the new session.
  const openRef = useRef(true);
  useEffect(() => {
    openRef.current = true;
    return () => {
      openRef.current = false;
    };
  }, []);

  // A hidden window does not keep the camera on. (The vault also locks then,
  // which closes this dialog; this stops the camera even if that lock fails.)
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden" || !streamRef.current) return;
      stopCamera();
      setFailure("stopped");
      setStage("failed");
      setStatus("");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [stopCamera]);

  // Plugging or unplugging a camera updates the list at once. A camera in use that goes ends its
  // track, which the dialog already handles.
  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.addEventListener || stage !== "live") return;
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

  // Switching restarts the preview on the other camera (only while the preview is live).
  const switchCamera = (_kind: "camera" | "microphone", id: string) => {
    if (stage !== "live" || using === id) return;
    switchedRef.current = true;
    void start(id);
  };

  const close = () => {
    if (saving || preparing) return;
    stopCamera();
    clearPhoto();
    onClose();
  };
  useModalFocus(true, dialogRef, close, firstRef);

  // After useModalFocus, which keeps the button that opened the dialog to
  // give the focus back to: the dialog's first focus is its own.
  useEffect(() => {
    if (stage === "preview")
      (photoReady ? confirmRef : retakeRef).current?.focus();
    if (stage === "failed") retryRef.current?.focus();
  }, [stage, photoReady]);
  useEffect(() => {
    if (!ready) return;
    if (switchedRef.current) {
      // A camera was just switched from its list and the preview restarted on it: the focus
      // returns to that list, not to the shutter.
      switchedRef.current = false;
      const list = document.getElementById("record-device-camera");
      if (list) {
        list.focus();
        return;
      }
    }
    shutterRef.current?.focus();
  }, [ready]);

  const take = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) return;
    const { width, height } = photoSize(video.videoWidth, video.videoHeight);
    canvas.width = width;
    canvas.height = height;
    let captured = false;
    try {
      const context = canvas.getContext("2d");
      if (context) {
        context.drawImage(video, 0, 0, width, height);
        captured = true;
      }
    } catch {
      // A refused draw must not offer a blank or incomplete photo to save.
    }
    if (!captured) clearPhoto();
    // The still is all that is needed now.
    stopCamera();
    setPhotoReady(captured);
    setStage("preview");
    setStatus(
      deferredText(() =>
        translateNow(
          captured
            ? "interface.CameraDialog.photoTakenRetakeOrUseThePhoto"
            : "interface.CameraDialog.thePhotoCouldNotBePreparedChoose",
        ),
      ),
    );
  };

  const use = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !photoReady || saving || preparing) return;
    setPreparing(true);
    try {
      // Kept under MAX_CAMERA_JPEG_BYTES (photo.ts).
      const blob = await encodePhoto(canvas);
      if (!blob) {
        if (openRef.current)
          setStatus(
            deferredText(() =>
              translateNow(
                "interface.CameraDialog.thePhotoCouldNotBePreparedChoose",
              ),
            ),
          );
        return;
      }
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      try {
        // Checked last, after every wait: closed meanwhile, nothing is saved.
        if (openRef.current) await onUse(jpeg);
      } finally {
        jpeg.fill(0);
      }
    } finally {
      setPreparing(false);
    }
  };

  const working = saving || preparing;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={close}>
      <section
        ref={dialogRef}
        className="record-dialog camera-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="camera-title"
        aria-describedby={stage === "explain" ? "camera-about" : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <h2 id="camera-title">
            {translateNow("interface.CameraDialog.takeAPhoto")}
          </h2>
        </header>
        <div className="camera-body">
          {stage === "explain" && (
            <div id="camera-about" className="camera-about">
              <p>
                {translateNow(
                  "interface.CameraDialog.myCarlosUsesTheCameraToSavePhotos",
                )}
              </p>
              {isPhone(platform) ? (
                <p>
                  {translateNow(
                    "interface.CameraDialog.yourPhoneAsksOnceWhetherMyCarlosMay",
                  )}
                </p>
              ) : (
                <p>
                  {translateNow(
                    "interface.CameraDialog.theCameraIsOnOnlyWhileYou",
                  )}
                </p>
              )}
            </div>
          )}
          {stage === "starting" && (
            <p>{translateNow("interface.CameraDialog.startingTheCamera")}</p>
          )}
          <video
            ref={videoRef}
            className="camera-view"
            hidden={stage !== "live"}
            aria-label={translateNow("interface.CameraDialog.cameraView")}
            autoPlay
            muted
            playsInline
            onPlaying={() => {
              if (streamRef.current) {
                setReady(true);
                setStatus(
                  deferredText(() =>
                    translateNow("interface.CameraDialog.cameraReady"),
                  ),
                );
              }
            }}
          />
          {/* Always present, empty until there is something to say: a live region that is inserted
              together with its text is not announced by every screen reader. */}
          <p aria-live="polite" className="record-device-note">
            {fellBack && stage === "live"
              ? translateNow("interface.CameraDialog.cameraFellBack")
              : ""}
          </p>
          {stage === "live" && devices.cameras.length > 0 && (
            <div className="record-devices">
              <DevicePick
                kind="camera"
                label={translateNow("interface.RecordDialog.camera")}
                unnamed="interface.RecordDialog.unnamedCamera"
                devices={devices.cameras}
                current={using}
                disabled={!ready}
                onChange={switchCamera}
              />
            </div>
          )}
          <canvas
            ref={canvasRef}
            className="camera-view"
            hidden={stage !== "preview" || !photoReady}
            role="img"
            aria-label={translateNow("interface.CameraDialog.thePhotoYouTook")}
          />
          {stage === "failed" && failure && (
            <p className="camera-failure" role="alert">
              {cameraFailureMessage(failure, platform)}
            </p>
          )}
        </div>
        <p className="native-dialog-status" role="status">
          {notice || status}
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
                  {translateNow("interface.CameraDialog.useTheCamera")}
                </span>
              </button>
            </>
          )}
          {(stage === "starting" || stage === "live") && (
            <>
              <button className="button" type="button" onClick={close}>
                {translateNow("common.cancel")}
              </button>
              <button
                ref={shutterRef}
                className="button primary camera-shutter"
                type="button"
                disabled={!ready}
                onClick={take}
              >
                <Icon name="camera" />
                <span>{translateNow("interface.CameraDialog.takePhoto")}</span>
              </button>
            </>
          )}
          {stage === "preview" && (
            <>
              {/* Not disabled while saving: the focus would fall out of the
                  dialog. They do nothing until the save is over. */}
              <button
                ref={retakeRef}
                className="button"
                type="button"
                aria-disabled={working}
                onClick={() => {
                  if (!working) void start();
                }}
              >
                {translateNow("interface.CameraDialog.retake")}
              </button>
              <button
                ref={confirmRef}
                className="button primary"
                type="button"
                aria-disabled={working || !photoReady}
                onClick={() => void use()}
              >
                {working
                  ? translateNow("rename.saving")
                  : translateNow("interface.CameraDialog.usePhoto")}
              </button>
            </>
          )}
          {stage === "failed" && (
            <>
              <button className="button" type="button" onClick={close}>
                {translateNow("photo.close")}
              </button>
              <button
                ref={retryRef}
                className="button primary"
                type="button"
                onClick={() => void start()}
              >
                {translateNow("interface.CameraDialog.tryAgain")}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

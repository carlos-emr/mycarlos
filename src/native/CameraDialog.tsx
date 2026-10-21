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

type Stage = "explain" | "starting" | "live" | "preview" | "failed";

// On a computer the question needs no holding. Stable, so `start` (and the
// camera an opening starts) is not made again on every render.
const asked = <T,>(question: Promise<T>) => question;

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
  // Opened again after the camera worked once: straight to the camera.
  const [autoStart] = useState(cameraExplained);
  const [stage, setStage] = useState<Stage>(autoStart ? "starting" : "explain");
  const [failure, setFailure] = useState<CameraFailure | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("");
  const [preparing, setPreparing] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const shutterRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
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

  const start = useCallback(async () => {
    stopCamera();
    clearPhoto();
    const attempt = attemptRef.current;
    setFailure(null);
    setStage("starting");
    setStatus("Starting the camera…");
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new DOMException("No camera interface", "NotFoundError");
      const stream = await whileAsking(
        navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
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
          stopCamera();
          setFailure("stopped");
          setStage("failed");
          setStatus("");
        });
      rememberCameraExplained();
      setStage("live");
    } catch (error) {
      if (attempt !== attemptRef.current) return;
      setFailure(cameraFailure(error));
      setStage("failed");
      setStatus("");
    }
  }, [clearPhoto, stopCamera, whileAsking]);

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
    if (stage === "preview") confirmRef.current?.focus();
    if (stage === "failed") retryRef.current?.focus();
  }, [stage]);
  useEffect(() => {
    if (ready) shutterRef.current?.focus();
  }, [ready]);

  const take = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) return;
    const { width, height } = photoSize(video.videoWidth, video.videoHeight);
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(video, 0, 0, width, height);
    // The still is all that is needed now.
    stopCamera();
    setStage("preview");
    setStatus("Photo taken. Retake or use the photo.");
  };

  const use = async () => {
    const canvas = canvasRef.current;
    if (!canvas || saving || preparing) return;
    setPreparing(true);
    try {
      // Kept under MAX_CAMERA_JPEG_BYTES (photo.ts).
      const blob = await encodePhoto(canvas);
      if (!blob) {
        if (openRef.current)
          setStatus("The photo could not be prepared. Choose Retake.");
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
          <h2 id="camera-title">Take a photo</h2>
        </header>
        <div className="camera-body">
          {stage === "explain" && (
            <div id="camera-about" className="camera-about">
              <p>
                myCarlos uses the camera to save photos of your health
                documents. Photos stay locked in myCarlos.
              </p>
              {isPhone(platform) ? (
                <p>
                  Your phone asks once whether myCarlos may use the camera. The
                  camera is on only while you take the photo. It turns off when
                  you take it, cancel, or myCarlos locks.
                </p>
              ) : (
                <p>
                  The camera is on only while you take the photo. It turns off
                  when you take it, close this window, or myCarlos locks.
                </p>
              )}
            </div>
          )}
          {stage === "starting" && <p>Starting the camera…</p>}
          <video
            ref={videoRef}
            className="camera-view"
            hidden={stage !== "live"}
            aria-label="Camera view"
            autoPlay
            muted
            playsInline
            onPlaying={() => {
              if (streamRef.current) {
                setReady(true);
                setStatus("Camera ready.");
              }
            }}
          />
          <canvas
            ref={canvasRef}
            className="camera-view"
            hidden={stage !== "preview"}
            role="img"
            aria-label="The photo you took"
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
                Cancel
              </button>
              <button
                ref={firstRef}
                className="button primary"
                type="button"
                onClick={() => void start()}
              >
                <Icon name="camera" />
                <span>Use the camera</span>
              </button>
            </>
          )}
          {(stage === "starting" || stage === "live") && (
            <>
              <button className="button" type="button" onClick={close}>
                Cancel
              </button>
              <button
                ref={shutterRef}
                className="button primary camera-shutter"
                type="button"
                disabled={!ready}
                onClick={take}
              >
                <Icon name="camera" />
                <span>Take photo</span>
              </button>
            </>
          )}
          {stage === "preview" && (
            <>
              {/* Not disabled while saving: the focus would fall out of the
                  dialog. They do nothing until the save is over. */}
              <button
                className="button"
                type="button"
                aria-disabled={working}
                onClick={() => {
                  if (!working) void start();
                }}
              >
                Retake
              </button>
              <button
                ref={confirmRef}
                className="button primary"
                type="button"
                aria-disabled={working}
                onClick={() => void use()}
              >
                {working ? "Saving…" : "Use photo"}
              </button>
            </>
          )}
          {stage === "failed" && (
            <>
              <button className="button" type="button" onClick={close}>
                Close
              </button>
              <button
                ref={retryRef}
                className="button primary"
                type="button"
                onClick={() => void start()}
              >
                Try again
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

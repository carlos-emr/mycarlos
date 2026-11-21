import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useModalFocus } from "../useModalFocus";
import { useI18n } from "../i18n";

/** Seconds a left or right arrow skips, and a J or L key (the usual player
 * keys) skips. */
export const SKIP_SECONDS = 5;
export const BIG_SKIP_SECONDS = 10;
const VOLUME_STEP = 0.1;

/** A stored video, played from the vault's own address (#359). `url` is the
 * `mycarlos-video` address a token makes. It never plays by itself, never
 * repeats, and is torn down (its address dropped, so nothing more is asked of
 * the vault) when the viewer closes or the vault locks, which closes it.
 * `onPlaying` says whether it is playing now: the automatic lock waits only
 * while it is, not while it is paused or only buffering ahead. */
export function VideoViewer({
  name,
  url,
  onPlaying,
  onClose,
}: {
  name: string;
  url: string;
  onPlaying?: (playing: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playingRef = useRef(false);
  useModalFocus(true, dialogRef, onClose, closeRef);

  const say = (playing: boolean) => {
    if (playingRef.current === playing) return;
    playingRef.current = playing;
    onPlaying?.(playing);
  };
  // Closed for any reason: no longer playing, and nothing left attached.
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (playingRef.current) {
        playingRef.current = false;
        onPlaying?.(false);
      }
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    };
  }, [onPlaying]);

  const key = (event: KeyboardEvent<HTMLElement>) => {
    const video = videoRef.current;
    if (!video || event.altKey || event.ctrlKey || event.metaKey) return;
    // Buttons keep their own keys (Space and Enter press them).
    if ((event.target as HTMLElement).closest("button")) return;
    const skip = (seconds: number) => {
      const end = Number.isFinite(video.duration) ? video.duration : Infinity;
      video.currentTime = Math.min(
        Math.max(0, video.currentTime + seconds),
        end,
      );
    };
    switch (event.key) {
      case " ":
      case "k":
      case "K":
        if (video.paused) void video.play().catch(() => undefined);
        else video.pause();
        break;
      case "ArrowLeft":
        skip(-SKIP_SECONDS);
        break;
      case "ArrowRight":
        skip(SKIP_SECONDS);
        break;
      case "j":
      case "J":
        skip(-BIG_SKIP_SECONDS);
        break;
      case "l":
      case "L":
        skip(BIG_SKIP_SECONDS);
        break;
      case "ArrowUp":
        video.volume = Math.min(1, video.volume + VOLUME_STEP);
        break;
      case "ArrowDown":
        video.volume = Math.max(0, video.volume - VOLUME_STEP);
        break;
      case "m":
      case "M":
        video.muted = !video.muted;
        break;
      case "Home":
        video.currentTime = 0;
        break;
      case "End":
        if (Number.isFinite(video.duration)) video.currentTime = video.duration;
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="record-dialog photo-viewer video-viewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-viewer-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={key}
      >
        <header className="dialog-head">
          <div>
            <span className="eyebrow">{t("interface.VideoViewer.video")}</span>
            <h2 id="video-viewer-title">{name}</h2>
          </div>
        </header>
        <div className="video-frame">
          {/* No autoplay and no loop. Its own controls are shown, and the keys
              below work from the dialog as well. */}
          <video
            ref={videoRef}
            className="video-player"
            src={url}
            controls
            preload="metadata"
            playsInline
            aria-label={t("interface.VideoViewer.player", { name })}
            onPlaying={() => say(true)}
            onPause={() => say(false)}
            onEnded={() => say(false)}
            onError={() => {
              say(false);
              setFailed(true);
            }}
          />
        </div>
        {failed ? (
          <p className="camera-failure" role="alert">
            {t("interface.VideoViewer.thisVideoCouldNotBePlayed")}
          </p>
        ) : (
          <p className="native-dialog-status">
            {t("interface.VideoViewer.keys", { seconds: SKIP_SECONDS })}
          </p>
        )}
        <footer className="dialog-actions">
          <button
            ref={closeRef}
            className="button primary"
            type="button"
            onClick={onClose}
          >
            {t("photo.close")}
          </button>
        </footer>
      </section>
    </div>
  );
}

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon, type IconName } from "../Icon";
import { useModalFocus } from "../useModalFocus";
import { useI18n } from "../i18n";

/** Seconds a left or right arrow key skips (the usual player behaviour). It has no button: the
 * buttons skip BIG_SKIP_SECONDS, which the J and L keys do too. */
export const SKIP_SECONDS = 5;
export const BIG_SKIP_SECONDS = 10;
const VOLUME_STEP = 0.1;

type Action =
  | "playPause"
  | "back"
  | "forward"
  | "backBig"
  | "forwardBig"
  | "volumeUp"
  | "volumeDown"
  | "mute"
  | "start"
  | "end";

/** The keys and what they do (the buttons under the video do the same and say the key, except the
 * arrows' 5 s skip: those two have no button, and a line under the buttons says them). */
const ACTION_OF_KEY: Record<string, Action | undefined> = {
  " ": "playPause",
  k: "playPause",
  K: "playPause",
  ArrowLeft: "back",
  ArrowRight: "forward",
  j: "backBig",
  J: "backBig",
  l: "forwardBig",
  L: "forwardBig",
  ArrowUp: "volumeUp",
  ArrowDown: "volumeDown",
  m: "mute",
  M: "mute",
  Home: "start",
  End: "end",
};

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
  const [muted, setMuted] = useState(false);
  // Whether the video is playing as the play button sees it: from the element's own play and
  // pause events, so the button's icon is never from counting its own presses.
  const [playing, setPlaying] = useState(false);
  // A different video starts not playing, whatever the parent does with this component.
  useEffect(() => setPlaying(false), [url]);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playingRef = useRef(false);
  // The player takes the first focus (its Space, arrow and J/L keys work at once, and its own
  // controls are one Tab away); Escape and the Close button still close the viewer.
  useModalFocus(true, dialogRef, onClose, videoRef);

  // The latest callback and address, read through refs: the library hands in a
  // new function on every render, and a teardown that depended on it would run
  // (and strip the address) at each one.
  const onPlayingRef = useRef(onPlaying);
  onPlayingRef.current = onPlaying;
  const urlRef = useRef(url);
  urlRef.current = url;

  const say = (playing: boolean) => {
    if (playingRef.current === playing) return;
    playingRef.current = playing;
    onPlayingRef.current?.(playing);
  };
  // Closed for any reason: no longer playing, and nothing left attached. It runs
  // once, when the viewer goes away. (React's development double mount runs it
  // too; the address is put back on the next mount, so the player is not left
  // blank.)
  useEffect(() => {
    const video = videoRef.current;
    if (video && !video.getAttribute("src"))
      video.setAttribute("src", urlRef.current);
    return () => {
      if (playingRef.current) {
        playingRef.current = false;
        onPlayingRef.current?.(false);
      }
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    };
  }, []);

  /** What a key or its button does to the video: the same function for both, so that they cannot
   * drift apart. */
  const act = (action: Action) => {
    const video = videoRef.current;
    if (!video) return;
    const skip = (seconds: number) => {
      const end = Number.isFinite(video.duration) ? video.duration : Infinity;
      video.currentTime = Math.min(
        Math.max(0, video.currentTime + seconds),
        end,
      );
    };
    switch (action) {
      case "playPause":
        if (video.paused) void video.play().catch(() => undefined);
        else video.pause();
        break;
      case "back":
        skip(-SKIP_SECONDS);
        break;
      case "forward":
        skip(SKIP_SECONDS);
        break;
      case "backBig":
        skip(-BIG_SKIP_SECONDS);
        break;
      case "forwardBig":
        skip(BIG_SKIP_SECONDS);
        break;
      case "volumeUp":
        video.volume = Math.min(1, video.volume + VOLUME_STEP);
        break;
      case "volumeDown":
        video.volume = Math.max(0, video.volume - VOLUME_STEP);
        break;
      case "mute":
        video.muted = !video.muted;
        break;
      case "start":
        video.currentTime = 0;
        break;
      case "end":
        if (Number.isFinite(video.duration)) video.currentTime = video.duration;
        break;
    }
  };

  // The shortcuts work wherever the focus is inside the player (the video, the play button or any
  // control), because this runs on the dialog, not on the video; nowhere else, and never while the
  // focus is in a text field (WCAG 2.1.4: they are single keys, scoped to the focused player).
  const key = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    // A focused button keeps Space and Enter for its own action (one press, one action).
    if (
      (event.key === " " || event.key === "Enter") &&
      target.closest("button")
    )
      return;
    const action = ACTION_OF_KEY[event.key];
    if (!action) return;
    act(action);
    event.preventDefault();
    event.stopPropagation();
  };

  // Once playing, the keys must have somewhere to land: if the click on Play took the focus out of
  // the player (some web views do, for their own controls), it goes back to the video.
  const keepFocusInPlayer = () => {
    const dialog = dialogRef.current;
    const video = videoRef.current;
    if (dialog && video && !dialog.contains(document.activeElement))
      video.focus({ preventScroll: true });
  };

  type Control = {
    action: Action;
    icon: IconName;
    label: string;
    shortcut: string;
  };
  // The buttons in four groups (playback, skip, volume, jump), each a row that wraps by itself.
  // Every icon shows what pressing the button does, as its label says: Pause while playing, Play
  // while not, Unmute while muted. The icon is drawing only (aria-hidden); the label, which names
  // the key, is the button's visible text and its accessible name.
  const controls: Control[][] = [
    [
      {
        action: "playPause",
        icon: playing ? "pause" : "play",
        label: t("interface.VideoViewer.playPause"),
        shortcut: "k Space",
      },
    ],
    [
      {
        action: "backBig",
        icon: "rewind",
        label: t("interface.VideoViewer.backBig", {
          seconds: BIG_SKIP_SECONDS,
        }),
        shortcut: "j",
      },
      {
        action: "forwardBig",
        icon: "fast-forward",
        label: t("interface.VideoViewer.forwardBig", {
          seconds: BIG_SKIP_SECONDS,
        }),
        shortcut: "l",
      },
    ],
    [
      {
        action: "volumeUp",
        icon: "volume-up",
        label: t("interface.VideoViewer.volumeUp"),
        shortcut: "ArrowUp",
      },
      {
        action: "volumeDown",
        icon: "volume-down",
        label: t("interface.VideoViewer.volumeDown"),
        shortcut: "ArrowDown",
      },
      {
        action: "mute",
        icon: muted ? "volume" : "volume-off",
        label: t(
          muted ? "interface.VideoViewer.unmute" : "interface.VideoViewer.mute",
        ),
        shortcut: "m",
      },
    ],
    [
      {
        action: "start",
        icon: "skip-start",
        label: t("interface.VideoViewer.start"),
        shortcut: "Home",
      },
      {
        action: "end",
        icon: "skip-end",
        label: t("interface.VideoViewer.end"),
        shortcut: "End",
      },
    ],
  ];

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="record-dialog photo-viewer video-viewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-viewer-title"
        onMouseDown={(event) => event.stopPropagation()}
        // In the capture phase, so that the player's own controls do not also
        // act on a key this has already handled (a double skip).
        onKeyDownCapture={key}
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
            onClick={keepFocusInPlayer}
            onVolumeChange={(event) => setMuted(event.currentTarget.muted)}
            onPlay={() => {
              setPlaying(true);
              keepFocusInPlayer();
            }}
            onPlaying={() => say(true)}
            onPause={() => {
              setPlaying(false);
              say(false);
            }}
            onEnded={() => {
              setPlaying(false);
              say(false);
            }}
            // Waiting for data is not playing; `playing` says so again when it
            // goes on. (Not `stalled`: it can fire while the video still plays
            // from what it has buffered.)
            onWaiting={() => say(false)}
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
          // The keys, as buttons that say their key: each does what its key does.
          <>
            <div
              className="video-controls"
              role="group"
              aria-label={t("interface.VideoViewer.controls")}
            >
              {controls.map((group) => (
                <div key={group[0].action} className="video-control-group">
                  {group.map(({ action, icon, label, shortcut }) => (
                    <button
                      key={action}
                      className="button"
                      type="button"
                      aria-keyshortcuts={shortcut}
                      onClick={() => act(action)}
                    >
                      <Icon name={icon} />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
            {/* The arrow keys skip too, but have no button: this says so. */}
            <p className="video-key-hint">
              {t("interface.VideoViewer.arrowKeys", {
                seconds: SKIP_SECONDS,
              })}
            </p>
          </>
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

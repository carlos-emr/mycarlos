import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import { useI18n } from "../i18n";
import {
  vaultErrorMessage,
  type VaultBridge,
  type VideoImportProgress,
  type VideoRefusal,
} from "../vault";

/** The part of the bridge adding a video uses. */
export type AddVideoBridge = Pick<
  VaultBridge,
  | "pickImportVideo"
  | "importPickedVideo"
  | "videoImportProgress"
  | "videoImportCancel"
>;

/** The words for each reason a video is refused. */
const REFUSAL_TEXT = {
  notVideo: "interface.AddVideo.notVideo",
  hevc: "interface.AddVideo.hevc",
  videoCodec: "interface.AddVideo.videoCodec",
  audioCodec: "interface.AddVideo.audioCodec",
  noVideo: "interface.AddVideo.noVideo",
  tooManyTracks: "interface.AddVideo.tooManyTracks",
  external: "interface.AddVideo.external",
  fragmented: "interface.AddVideo.fragmented",
  tooBig: "interface.AddVideo.tooBig",
  tooLarge: "interface.AddVideo.tooLarge",
  damaged: "interface.AddVideo.damaged",
} as const satisfies Record<VideoRefusal, string>;

/** How often the progress is asked while a video is being added. */
const POLL_MS = 400;

type Outcome =
  | { kind: "added" | "duplicate" | "cancelled" }
  | { kind: "refused"; reason: VideoRefusal }
  | { kind: "failed"; text: string };

/** Whether this bridge can add a video (a bridge made before this existed, and a
 * fake, may not). */
export function canAddVideo(bridge: Partial<AddVideoBridge>): boolean {
  return (
    typeof bridge.pickImportVideo === "function" &&
    typeof bridge.importPickedVideo === "function"
  );
}

/**
 * "Add a video": picks one MP4 or MOV from the device and adds it to the person's records
 * (the folder that is open). The vault checks the file, removes the place and device details
 * it carries, and refuses what it cannot play, saying why. While it works there is a
 * progress bar with Cancel; a cancelled or refused video leaves nothing behind.
 *
 * Self-contained: the library gives it the person, the folder and what to do afterwards, and
 * shows nothing of its own but the button and its status line.
 */
export function AddVideo({
  bridge,
  profileId,
  folderIds,
  disabled = false,
  onAdded,
}: {
  bridge: AddVideoBridge;
  profileId: string;
  folderIds: string[];
  disabled?: boolean;
  /** A video was added (the library shows it). */
  onAdded?: (recordId: string) => void;
}) {
  const { t } = useI18n();
  const [working, setWorking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<VideoImportProgress | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const refocus = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  useEffect(() => {
    if (!working && refocus.current) {
      refocus.current = false;
      button.current?.focus();
    }
  }, [working]);

  const stopPolling = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  const add = async () => {
    if (working || !bridge.pickImportVideo || !bridge.importPickedVideo) return;
    setOutcome(null);
    setCancelling(false);
    setProgress(null);
    setWorking(true);
    try {
      const pickId = await bridge.pickImportVideo(profileId, folderIds);
      if (!pickId) return;
      if (bridge.videoImportProgress) {
        timer.current = setInterval(() => {
          void bridge
            .videoImportProgress?.()
            .then((now) => {
              if (mounted.current) setProgress(now);
            })
            .catch(() => undefined);
        }, POLL_MS);
      }
      const result = await bridge.importPickedVideo(
        pickId,
        profileId,
        folderIds,
      );
      if (!mounted.current) return;
      if (result.result === "imported") {
        setOutcome({ kind: "added" });
        onAdded?.(result.recordId);
      } else if (result.result === "refused") {
        setOutcome({ kind: "refused", reason: result.reason });
      } else {
        setOutcome({ kind: result.result });
      }
    } catch (error) {
      if (mounted.current)
        setOutcome({ kind: "failed", text: vaultErrorMessage(error) });
    } finally {
      stopPolling();
      if (mounted.current) {
        setWorking(false);
        setCancelling(false);
        setProgress(null);
        // The button was disabled while the work ran: the focus goes back to it once it is enabled.
        refocus.current = true;
      }
    }
  };

  const cancel = () => {
    setCancelling(true);
    void bridge.videoImportCancel?.().catch(() => undefined);
  };

  const storing =
    progress?.stage === "storing" && progress.totalBytes > 0 ? progress : null;
  const percent = storing
    ? Math.min(100, Math.floor((storing.doneBytes / storing.totalBytes) * 100))
    : null;

  return (
    <span className="add-video">
      <button
        ref={button}
        className="button"
        type="button"
        disabled={disabled || working}
        onClick={() => void add()}
        aria-describedby="native-add-video-hint"
      >
        <Icon name="video" />
        <span>{t("interface.AddVideo.add")}</span>
      </button>
      <span id="native-add-video-hint" hidden>
        {t("interface.AddVideo.hint")}
      </span>
      {working && (
        <div className="add-video-progress" role="group">
          <progress
            aria-label={t("interface.AddVideo.progressLabel")}
            max={percent === null ? undefined : 100}
            value={percent === null ? undefined : percent}
          />
          <span role="status">
            {cancelling
              ? t("interface.AddVideo.cancelling")
              : percent === null
                ? t("interface.AddVideo.checking")
                : t("interface.AddVideo.storing", { percent })}
          </span>
          <button
            className="button"
            type="button"
            disabled={cancelling}
            onClick={cancel}
          >
            {t("interface.AddVideo.cancel")}
          </button>
        </div>
      )}
      {!working && outcome && (
        <p
          className="add-video-result"
          role={
            outcome.kind === "refused" || outcome.kind === "failed"
              ? "alert"
              : "status"
          }
        >
          {outcome.kind === "failed"
            ? outcome.text
            : outcome.kind === "refused"
              ? t(REFUSAL_TEXT[outcome.reason])
              : t(`interface.AddVideo.${outcome.kind}` as const)}
        </p>
      )}
    </span>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
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

/** How the last import ended. */
export type AddVideoOutcome =
  | { kind: "added" | "duplicate" | "cancelled" }
  | { kind: "refused"; reason: VideoRefusal }
  | { kind: "failed"; text: string };

/** What the screens use: the state of the one import, and its two actions. */
export interface AddVideoApi {
  /** The bridge can add a video. */
  canAdd: boolean;
  /** Picks a video and adds it to the person's records, in these folders. */
  start(profileId: string, folderIds: string[]): Promise<void>;
  /** Stops the import at its next read; nothing is stored. */
  cancel(): void;
  working: boolean;
  cancelling: boolean;
  progress: VideoImportProgress | null;
  outcome: AddVideoOutcome | null;
}

/** How often the progress is asked while a video is being added. */
const POLL_MS = 400;

/** Whether this bridge can add a video (an older bridge, and a fake, may not). */
export function canAddVideo(bridge: Partial<AddVideoBridge>): boolean {
  return (
    typeof bridge.pickImportVideo === "function" &&
    typeof bridge.importPickedVideo === "function"
  );
}

/**
 * The state of adding a video, kept by whoever calls this hook: put it ABOVE the screens (VaultApp
 * does), so that leaving the library mid-import keeps the progress, the Cancel and the answer, and
 * `onAdded` still fires when the video is in. Nothing here cancels on unmount: the vault's own lock
 * stops an import.
 */
export function useAddVideo({
  bridge,
  onAdded,
}: {
  bridge: Partial<AddVideoBridge>;
  onAdded?: (recordId: string) => void;
}): AddVideoApi {
  const [working, setWorking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<VideoImportProgress | null>(null);
  const [outcome, setOutcome] = useState<AddVideoOutcome | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // The latest bridge and callback, read when they are needed (a render in between must not
  // restart the work).
  const bridgeRef = useRef(bridge);
  const addedRef = useRef(onAdded);
  bridgeRef.current = bridge;
  addedRef.current = onAdded;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const stopPolling = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  const start = useCallback(async (profileId: string, folderIds: string[]) => {
    const current = bridgeRef.current;
    if (
      running.current ||
      !current.pickImportVideo ||
      !current.importPickedVideo
    )
      return;
    running.current = true;
    setOutcome(null);
    setCancelling(false);
    setProgress(null);
    setWorking(true);
    try {
      const pickId = await current.pickImportVideo(profileId, folderIds);
      if (!pickId) return;
      if (current.videoImportProgress) {
        timer.current = setInterval(() => {
          void bridgeRef.current
            .videoImportProgress?.()
            .then((now) => {
              if (mounted.current) setProgress(now);
            })
            .catch(() => undefined);
        }, POLL_MS);
      }
      const result = await current.importPickedVideo(
        pickId,
        profileId,
        folderIds,
      );
      if (result.result === "imported") {
        // Even if the screen that started it is gone: the library shows the video.
        addedRef.current?.(result.recordId);
        if (mounted.current) setOutcome({ kind: "added" });
      } else if (mounted.current) {
        setOutcome(
          result.result === "refused"
            ? { kind: "refused", reason: result.reason }
            : { kind: result.result },
        );
      }
    } catch (error) {
      if (mounted.current)
        setOutcome({ kind: "failed", text: vaultErrorMessage(error) });
    } finally {
      stopPolling();
      running.current = false;
      if (mounted.current) {
        setWorking(false);
        setCancelling(false);
        setProgress(null);
      }
    }
  }, []);

  const cancel = useCallback(() => {
    setCancelling(true);
    void bridgeRef.current.videoImportCancel?.().catch(() => undefined);
  }, []);

  return {
    canAdd: canAddVideo(bridge),
    start,
    cancel,
    working,
    cancelling,
    progress,
    outcome,
  };
}

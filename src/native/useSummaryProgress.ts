import { useCallback, useEffect, useState } from "react";
import {
  applyProgress,
  initialProgress,
  tickProgress,
  viewOf,
  type ProgressView,
  type SummaryProgressEvent,
} from "../ai/summaryProgress";

/** How often the clock is looked at while a summary is being made: the time
 * left is said in whole minutes, so a second is fine. */
export const PROGRESS_TICK_MS = 1000;

/**
 * The progress of the summary being made (#72): the helper's events go in
 * through `onProgress`, `reset` starts a new run, and `view` says what to
 * show. While `active`, the clock is looked at each second so that a run
 * that passes its time shown says so.
 */
export function useSummaryProgress(active: boolean): {
  view: ProgressView;
  reset: () => void;
  onProgress: (event: SummaryProgressEvent) => void;
} {
  const [state, setState] = useState(initialProgress);
  const reset = useCallback(() => setState(initialProgress()), []);
  const onProgress = useCallback(
    (event: SummaryProgressEvent) =>
      setState((current) => applyProgress(current, event, Date.now())),
    [],
  );
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(
      () => setState((current) => tickProgress(current, Date.now())),
      PROGRESS_TICK_MS,
    );
    return () => window.clearInterval(timer);
  }, [active]);
  return { view: viewOf(state), reset, onProgress };
}

/**
 * What the reader shows while a summary is being made: the stage, how far it
 * is, and a rough time left (#72, Ben's request of 17 Nov). Pure: the panel
 * feeds it the helper's progress events and the clock, and draws what it says.
 *
 * Counts only ever come in (no text, no word, no page): the helper reads, then
 * writes sentences, then the app checks the answer. The numbers arrive as
 * `ai-answer-progress` events (design note `agent1-summary-progress-design`):
 * `{ answerId, stage, done, total, estimateSeconds? }`.
 */

/** The stages a run goes through, in order. "before" is the screen's own: from
 * the tap until the helper's first word. */
export type ProgressStage = "before" | "reading" | "writing" | "checking";

/** A progress event as the native side sends it (its `answerId` is matched
 * before it gets here). */
export interface SummaryProgressEvent {
  answerId: string;
  stage: Exclude<ProgressStage, "before">;
  done: number;
  total: number;
  /** The native side's own estimate of the time left, in seconds, when it
   * has one (from the end of the first reading chunk). */
  estimateSeconds?: number;
}

const RANK: Record<ProgressStage, number> = {
  before: 0,
  reading: 1,
  writing: 2,
  checking: 3,
};

export interface ProgressState {
  stage: ProgressStage;
  /** 0 to 1 within the stage; `null` while there is no real number (before). */
  fraction: number | null;
  /** The time left as shown, in whole minutes: 0 is "less than a minute".
   * Only ever goes down. `null` until there is an estimate. */
  shownMinutes: number | null;
  /** When the number now shown was first shown (ms). */
  shownAt: number;
  /** The run passed the time it showed: said once, never taken back. */
  slower: boolean;
  /** The stage the run was in when it passed the time shown. */
  slowerStage: ProgressStage | null;
}

export const initialProgress = (): ProgressState => ({
  stage: "before",
  fraction: null,
  shownMinutes: null,
  shownAt: 0,
  slower: false,
  slowerStage: null,
});

/**
 * The estimate as the patient reads it: "less than a minute" (0), whole
 * minutes up to 5, then 10, 15 or 20, always rounded UP, never above 20. A
 * run that will take longer says so in "taking longer than expected".
 */
export function estimateMinutes(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return Number.NaN;
  if (seconds <= 60) return 0;
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 5) return minutes;
  if (minutes <= 10) return 10;
  if (minutes <= 15) return 15;
  return 20;
}

const wholeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Takes one event. A stage that goes back, a count that is not a count, or
 * numbers that do not add up change nothing: what is on screen stays. */
export function applyProgress(
  state: ProgressState,
  event: Pick<SummaryProgressEvent, "stage" | "done" | "total"> &
    Partial<Pick<SummaryProgressEvent, "estimateSeconds">>,
  now: number,
): ProgressState {
  const rank = RANK[event.stage as ProgressStage];
  if (rank === undefined || rank === 0 || rank < RANK[state.stage])
    return state;
  let next: ProgressState = state;
  if (event.stage === "checking") {
    next = { ...state, stage: "checking", fraction: 1 };
  } else if (
    wholeNumber(event.done) &&
    wholeNumber(event.total) &&
    event.total > 0 &&
    event.done <= event.total
  ) {
    const fraction = event.done / event.total;
    // The bar never goes back inside a stage.
    const kept =
      event.stage === state.stage && state.fraction !== null
        ? Math.max(state.fraction, fraction)
        : fraction;
    next = { ...state, stage: event.stage, fraction: kept };
  } else {
    return state;
  }
  // No time left while the app's own checks run (milliseconds).
  if (event.estimateSeconds !== undefined && next.stage !== "checking") {
    const candidate = estimateMinutes(event.estimateSeconds);
    if (!Number.isNaN(candidate)) {
      if (next.shownMinutes === null || candidate < next.shownMinutes)
        next = { ...next, shownMinutes: candidate, shownAt: now };
    }
  }
  return next;
}

/** Passing the time shown turns it into "taking longer than expected", once. */
export function tickProgress(state: ProgressState, now: number): ProgressState {
  if (state.slower || state.shownMinutes === null) return state;
  const allowed = Math.max(state.shownMinutes, 1) * 60_000;
  return now - state.shownAt > allowed
    ? { ...state, slower: true, slowerStage: state.stage }
    : state;
}

export interface ProgressView {
  stage: ProgressStage;
  /** The bar's value, 0 to 100, or `null` for the indeterminate bar. */
  percent: number | null;
  /** The time left to say, in minutes (0: less than a minute), or `null`
   * when there is none to say (not yet, checking, or already "slower"). */
  minutesLeft: number | null;
  slower: boolean;
  /** "Taking longer than expected" goes into the status line a screen reader
   * hears once, in the stage it appeared in; the next stage's words replace
   * it. */
  statusSaysSlower: boolean;
}

export function viewOf(state: ProgressState): ProgressView {
  return {
    stage: state.stage,
    percent: state.fraction === null ? null : Math.round(state.fraction * 100),
    minutesLeft:
      state.slower || state.stage === "checking" ? null : state.shownMinutes,
    slower: state.slower,
    statusSaysSlower: state.slower && state.slowerStage === state.stage,
  };
}

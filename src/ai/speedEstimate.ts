// How long a summary may take on this computer, from the speed the patient's own check measured
// (#305). Display only: no time limit changes. The estimate is made from the tokens the model
// would read (the document's estimated tokens, never more than its room) and the most a summary
// writes, so it errs on the long side, and it is shown only when it is long enough to matter.

import { estimateTokens } from "./capacity";
import type { DocumentText, ModelCapacity } from "./types";

/** What the check measured, in thousandths of a token a second (`ai_model_speed`). */
export interface Speed {
  promptMilliTps: number;
  answerMilliTps: number;
}

/** The instructions around the pages (the helper's prompt and the answer format). */
const INSTRUCTION_TOKENS = 750;
/** The most a summary writes (the answer limit's own figure, `ANSWER_LIMIT`). */
const SUMMARY_ANSWER_TOKENS = 600;
/** The longest one answer may take (`ANSWER_LIMIT.ceiling`): above this the app stops the run, so
 * the reader says a summary this long may not finish rather than naming a time it would not get. */
export const ANSWER_CEILING_MINUTES = 20;
/** A shorter wait is not worth a line. */
export const SHOW_FROM_MINUTES = 2;
/** About how many words a token is (English; the tokens estimate is English-centred too). */
const WORDS_PER_TOKEN = 0.75;

/** A rate the native side measured, or null if it is not a usable one. */
export function usableSpeed(value: unknown): Speed | null {
  if (typeof value !== "object" || value === null) return null;
  const { promptMilliTps, answerMilliTps } = value as Record<string, unknown>;
  const ok = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 10 && n <= 5_000_000;
  return ok(promptMilliTps) && ok(answerMilliTps)
    ? { promptMilliTps, answerMilliTps }
    : null;
}

/** The tokens a summary of `document` would read: the pages' estimate, never more than the room. */
export function tokensRead(
  document: DocumentText,
  capacity: ModelCapacity,
): number {
  const all = document.pages.reduce(
    (sum, page) => sum + estimateTokens(page.text),
    0,
  );
  return Math.min(all, Math.max(0, capacity.documentTokens));
}

/** Whole minutes (rounded up) a summary reading `documentTokens` may take at `speed`. */
export function summaryMinutes(documentTokens: number, speed: Speed): number {
  const seconds =
    (INSTRUCTION_TOKENS + documentTokens) / (speed.promptMilliTps / 1000) +
    SUMMARY_ANSWER_TOKENS / (speed.answerMilliTps / 1000);
  return Math.max(1, Math.ceil(seconds / 60));
}

/** Words a second for a rate in thousandths of a token, one decimal, in the language in use. */
export function wordsPerSecond(milliTps: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format((milliTps / 1000) * WORDS_PER_TOKEN);
}

import type { ReadRate } from "./types";

/**
 * How fast this computer reads with each model (D250: the expected minutes
 * before a long read), from the last summary's own timing.
 *
 * Kept in the webview's storage, outside the vault, like the zoom level: per
 * model (by its file's SHA-256), as a speed only. That is the time a token
 * takes at the start of a prompt, and the seconds an answer took. Never a
 * document's length, words or name.
 *
 * A token takes longer the more tokens were read before it: attention looks
 * back at all of them. The 11 November 2026 runs (Qwen3.5 4B, a busy test
 * computer) fit about 37 ms a token plus 0.005 ms for each token before it.
 * The speed is kept as the first part, so the minutes for a longer document
 * grow by the same shape.
 */
const STORAGE_KEY = "mycarlos.aiReadRate.v1";
const MAX_MODELS = 8;

/** How much longer a token takes for each token read before it, as a share
 * of its own time (0.005 ms ÷ 37 ms). */
export const SLOWDOWN_PER_TOKEN = 0.005 / 37;

/** This computer's speed with one model. */
export interface DeviceRate {
  /** Milliseconds a token takes at the start of a prompt. */
  msPerToken: number;
  /** Seconds the last answer took to write. */
  answerSeconds: number;
}

/** The speed one summary's timing shows, or null when it shows none. */
export function deviceRate(rate: ReadRate): DeviceRate | null {
  const { promptTokens, promptMs, answerMs } = rate;
  if (
    !Number.isFinite(promptTokens) ||
    !Number.isFinite(promptMs) ||
    promptTokens <= 0 ||
    promptMs <= 0
  )
    return null;
  return {
    msPerToken:
      promptMs / (promptTokens * (1 + SLOWDOWN_PER_TOKEN * promptTokens)),
    answerSeconds:
      Number.isFinite(answerMs) && answerMs > 0 ? answerMs / 1000 : 0,
  };
}

function valid(rate: unknown): rate is DeviceRate {
  if (typeof rate !== "object" || rate === null) return false;
  const { msPerToken, answerSeconds } = rate as Record<string, unknown>;
  return (
    typeof msPerToken === "number" &&
    Number.isFinite(msPerToken) &&
    msPerToken > 0 &&
    typeof answerSeconds === "number" &&
    Number.isFinite(answerSeconds) &&
    answerSeconds >= 0
  );
}

/** The kept speeds, newest last; empty when none or unreadable. */
function kept(): [string, DeviceRate][] {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(stored)) return [];
    return stored.filter(
      (entry): entry is [string, DeviceRate] =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        valid(entry[1]),
    );
  } catch {
    return [];
  }
}

/** This computer's speed with the model whose file has this SHA-256, if a
 * summary has been written with it. */
export function readDeviceRate(sha256: string): DeviceRate | null {
  return kept().find(([model]) => model === sha256)?.[1] ?? null;
}

/** Keeps the speed a summary's timing shows, in place of the model's older
 * one; at most `MAX_MODELS` models, the oldest going first. */
export function rememberReadRate(sha256: string, rate: ReadRate): void {
  const speed = deviceRate(rate);
  if (!speed) return;
  const rounded: DeviceRate = {
    msPerToken: Math.round(speed.msPerToken * 100) / 100 || 0.01,
    answerSeconds: Math.round(speed.answerSeconds),
  };
  const others = kept().filter(([model]) => model !== sha256);
  const next = [...others, [sha256, rounded] as [string, DeviceRate]].slice(
    -MAX_MODELS,
  );
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Without storage the next long read says no minutes: nothing else changes.
  }
}

/** About how many whole minutes reading a prompt of `tokens` and writing the
 * answer take at `rate`: at least 1; null without a speed. */
export function expectedMinutes(
  tokens: number,
  rate: DeviceRate | null,
): number | null {
  if (!rate || !Number.isFinite(tokens) || tokens <= 0) return null;
  const ms =
    rate.msPerToken * tokens * (1 + SLOWDOWN_PER_TOKEN * tokens) +
    rate.answerSeconds * 1000;
  return Math.max(1, Math.ceil(ms / 60_000));
}

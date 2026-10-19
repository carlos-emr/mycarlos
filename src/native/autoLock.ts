export const DEFAULT_AUTO_LOCK_MINUTES = 5;
const AUTO_LOCK_STORAGE_KEY = "mycarlos.autoLockMinutes.v1";
export const AUTO_LOCK_MIN = 1;
export const AUTO_LOCK_MAX = 15;
/** Every choice, for the browser preview's list. */
export const AUTO_LOCK_OPTIONS = Array.from(
  { length: AUTO_LOCK_MAX - AUTO_LOCK_MIN + 1 },
  (_, index) => index + AUTO_LOCK_MIN,
);

export function normalizeAutoLockMinutes(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) &&
    parsed >= AUTO_LOCK_MIN &&
    parsed <= AUTO_LOCK_MAX
    ? parsed
    : DEFAULT_AUTO_LOCK_MINUTES;
}

export function readAutoLockMinutes(): number {
  try {
    return normalizeAutoLockMinutes(
      window.localStorage.getItem(AUTO_LOCK_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_AUTO_LOCK_MINUTES;
  }
}

export function persistAutoLockMinutes(value: number): void {
  try {
    window.localStorage.setItem(AUTO_LOCK_STORAGE_KEY, String(value));
  } catch {
    // The clamped in-memory setting remains active when webview storage is unavailable.
  }
}

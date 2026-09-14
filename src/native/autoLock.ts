const DEFAULT_AUTO_LOCK_MINUTES = 5;
const AUTO_LOCK_STORAGE_KEY = "mycarlos.autoLockMinutes.v1";
export const AUTO_LOCK_OPTIONS = Array.from(
  { length: 15 },
  (_, index) => index + 1,
);

export function normalizeAutoLockMinutes(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 15
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

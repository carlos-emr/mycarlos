// A vault without a recovery key is offered one when it is unlocked, at most
// once a day: more often, and "Set up later" becomes a reflex. The rest of
// the time the library's notice offers it.
//
// When it was last offered is kept on this device, like the automatic lock
// setting. It names no vault and no patient, and is kept to the hour, so
// that it says little about when the app was used.
const RECOVERY_OFFER_STORAGE_KEY = "mycarlos.recoveryOfferHour.v1";
const HOUR_MS = 60 * 60 * 1000;
export const RECOVERY_OFFER_EVERY_HOURS = 24;

// For when webview storage is unavailable: at least not again in this run.
let offeredThisRun: number | null = null;

const hourOf = (nowMs: number) => Math.floor(nowMs / HOUR_MS);

function lastOfferedHour(): number | null {
  try {
    const stored = window.localStorage.getItem(RECOVERY_OFFER_STORAGE_KEY);
    const hour = stored === null ? NaN : Number(stored);
    if (Number.isInteger(hour) && hour >= 0) return hour;
  } catch {
    // Fall through to what this run remembers.
  }
  return offeredThisRun;
}

/** Whether a day has passed since the recovery key setup was last offered.
 * A time in the future (a clock that was set back) counts as never. */
export function recoveryOfferDue(nowMs: number): boolean {
  const last = lastOfferedHour();
  const now = hourOf(nowMs);
  return (
    last === null || last > now || now - last >= RECOVERY_OFFER_EVERY_HOURS
  );
}

/** Notes that the setup is being offered now. */
export function recordRecoveryOffer(nowMs: number): void {
  offeredThisRun = hourOf(nowMs);
  try {
    window.localStorage.setItem(
      RECOVERY_OFFER_STORAGE_KEY,
      String(offeredThisRun),
    );
  } catch {
    // Remembered for this run only.
  }
}

/** For tests: forget what this run remembers. */
export function forgetRecoveryOffer(): void {
  offeredThisRun = null;
  try {
    window.localStorage.removeItem(RECOVERY_OFFER_STORAGE_KEY);
  } catch {
    // Nothing was stored.
  }
}

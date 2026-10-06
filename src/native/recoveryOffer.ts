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
  // What this run did is known for certain, whatever could be stored.
  if (offeredThisRun !== null) return offeredThisRun;
  try {
    const stored = window.localStorage.getItem(RECOVERY_OFFER_STORAGE_KEY);
    const hour = stored === null ? NaN : Number(stored);
    if (Number.isInteger(hour) && hour >= 0) return hour;
  } catch {
    // Nothing can be read: as if never offered.
  }
  return null;
}

/** Whether a day has passed since the recovery key setup was last offered.
 *
 * The hour is kept, not the minute, so more than 24 hours must separate the
 * two hours for a whole day to lie between the offers: they are then 24 to
 * 26 hours apart, never less than a day.
 *
 * A clock set back a little leaves the last offer in the future: it still
 * counts. One more than a day ahead is taken for a wrong clock at the time,
 * and the offer is due. */
export function recoveryOfferDue(nowMs: number): boolean {
  const last = lastOfferedHour();
  if (last === null) return true;
  const hours = hourOf(nowMs) - last;
  return Math.abs(hours) > RECOVERY_OFFER_EVERY_HOURS;
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

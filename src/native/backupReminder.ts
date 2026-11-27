// The backup reminder (a gentle nudge to make a myCarlos encrypted backup).
//
// Where the vault is kept out of the phone's and the computer's own backups, a lost device loses it
// unless the patient made a myCarlos backup. What the reminder remembers is kept natively, beside
// the vault, as DAYS only (the day of the last whole backup, of one that left videos out, and the
// day a "Not now" ends): never in webview storage, which iOS may carry into iCloud and device
// backups, and never a time, a name or a count. "Documents added since" is worked out here from
// the documents' own dates.

/** Remind when the last whole backup is at least this many days old. */
export const REMIND_AFTER_DAYS = 30;
/** Remind when this many documents were added after the day of the last whole backup. */
export const REMIND_AFTER_DOCUMENTS = 20;
/**
 * The "never backed up" note waits for a vault worth a backup, so the very first import is not met
 * with a warning: it shows once the vault holds this many documents, or this many days have passed
 * since the first one, whichever comes first.
 */
export const NEVER_AFTER_DOCUMENTS = 3;
export const NEVER_AFTER_DAYS = 7;
/** "Not now" puts the reminder off for this many days (the native side counts the same). */
export const SNOOZE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the native side keeps (VaultSnapshot.backupReminder). */
export interface BackupReminderState {
  savedDay?: number;
  partialDay?: number;
  snoozedUntilDay?: number;
}

export type BackupReminder =
  | { kind: "never" }
  | { kind: "partial" }
  | { kind: "old"; savedDay: number }
  | { kind: "many"; added: number };

/**
 * The day number of a time on the PATIENT'S calendar: days since 1970-01-01 of the date their wall
 * clock shows (`offsetMinutes` is `Date.getTimezoneOffset()`: minutes WEST of UTC, so 300 in
 * Toronto in winter). The native side keeps the backup and snooze days in the same form, from the
 * local date the page sends (`localDateText`), so both sides must count days this way: counting in
 * UTC would make a snooze last 13 days west of UTC and a backup made today look dated tomorrow east
 * of it.
 */
export const dayOf = (
  ms: number,
  offsetMinutes: number = new Date(ms).getTimezoneOffset(),
) => Math.floor((ms - offsetMinutes * 60_000) / DAY_MS);

/**
 * The calendar date a day number names, as the time that date starts in UTC, to be shown with
 * `timeZone: "UTC"` (the day is already the patient's own).
 */
export const dayStartMs = (day: number) => day * DAY_MS;

/**
 * Why a reminder is due now, or null when it is not: no documents, a recent whole backup, or a snooze.
 * `documentDates` are the documents' imported times, counted on the patient's calendar like
 * `nowMs` (`offsetMinutes` as for `dayOf`; the device's own by default, set only by tests). A clock
 * set back cannot hide the reminder: a backup day in the future counts as old, and a snooze longer
 * than the longest one the app sets is over.
 */
export function dueBackupReminder(
  documentDates: readonly number[],
  state: BackupReminderState,
  nowMs: number,
  after: { days: number; documents: number } = {
    days: REMIND_AFTER_DAYS,
    documents: REMIND_AFTER_DOCUMENTS,
  },
  offsetMinutes?: number,
): BackupReminder | null {
  if (documentDates.length === 0) return null;
  const dayAt = (ms: number) =>
    dayOf(ms, offsetMinutes ?? new Date(ms).getTimezoneOffset());
  const today = dayAt(nowMs);
  const snoozed =
    state.snoozedUntilDay !== undefined &&
    state.snoozedUntilDay <= today + SNOOZE_DAYS &&
    today < state.snoozedUntilDay;
  if (snoozed) return null;
  if (state.savedDay === undefined) {
    if (state.partialDay !== undefined) return { kind: "partial" };
    // Not on the very first import: once there are enough documents, or enough time since the first.
    const firstDay = dayAt(documentDates.reduce((a, b) => Math.min(a, b)));
    return documentDates.length >= NEVER_AFTER_DOCUMENTS ||
      today - firstDay >= NEVER_AFTER_DAYS
      ? { kind: "never" }
      : null;
  }
  if (state.savedDay > today || today - state.savedDay >= after.days)
    return { kind: "old", savedDay: state.savedDay };
  // Documents added after the day of the backup; not those of the same day (a day is the grain).
  const savedDay = state.savedDay;
  const added = documentDates.filter((date) => dayAt(date) > savedDay).length;
  return added >= after.documents ? { kind: "many", added } : null;
}

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

/** The day number (days since 1970-01-01, UTC) of a time. */
export const dayOf = (ms: number) => Math.floor(ms / DAY_MS);

/** The start of a day number, for showing it as a date. */
export const dayStartMs = (day: number) => day * DAY_MS;

/**
 * Why a reminder is due now, or null when it is not: no documents, a recent whole backup, or a snooze.
 * `documentDates` are the documents' imported times. A clock set back cannot hide the reminder: a
 * backup day in the future counts as old, and a snooze longer than the longest one the app sets
 * is over.
 */
export function dueBackupReminder(
  documentDates: readonly number[],
  state: BackupReminderState,
  nowMs: number,
  after: { days: number; documents: number } = {
    days: REMIND_AFTER_DAYS,
    documents: REMIND_AFTER_DOCUMENTS,
  },
): BackupReminder | null {
  if (documentDates.length === 0) return null;
  const today = dayOf(nowMs);
  const snoozed =
    state.snoozedUntilDay !== undefined &&
    state.snoozedUntilDay <= today + SNOOZE_DAYS &&
    today < state.snoozedUntilDay;
  if (snoozed) return null;
  if (state.savedDay === undefined)
    return state.partialDay === undefined
      ? { kind: "never" }
      : { kind: "partial" };
  if (state.savedDay > today || today - state.savedDay >= after.days)
    return { kind: "old", savedDay: state.savedDay };
  // Documents added after the day of the backup; not those of the same day (a day is the grain).
  const since = dayStartMs(state.savedDay + 1);
  const added = documentDates.filter((date) => date >= since).length;
  return added >= after.documents ? { kind: "many", added } : null;
}

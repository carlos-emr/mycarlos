// The backup reminder (a gentle nudge to make a myCarlos encrypted backup).
//
// Where the vault is kept out of the phone's and the computer's own backups, a lost device loses it
// unless the patient made a myCarlos backup. The reminder needs three facts: the day of the last
// backup this device saw saved, how many documents the vault held then, and when the patient last
// said "Not now". They are a device preference (webview storage, like the language and the
// automatic lock), not part of the vault: no vault format changes, and a failure to read or write
// the storage only means the reminder may show again.

/** Remind when the last backup is older than this many days. */
export const REMIND_AFTER_DAYS = 30;
/** Remind when this many documents were added since the last backup. */
export const REMIND_AFTER_DOCUMENTS = 20;
/** "Not now" puts the reminder off for this many days. */
export const SNOOZE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = "mycarlos.backupReminder.v1";

export interface BackupMemory {
  /** When a backup was last saved from this device, in this vault. */
  savedAtMs?: number;
  /** How many documents the vault held when it was saved. */
  documentsThen?: number;
  /** The reminder stays away until this time. */
  snoozedUntilMs?: number;
}

export type BackupReminder =
  | { kind: "never" }
  | { kind: "old"; savedAtMs: number }
  | { kind: "many"; added: number };

type Stored = Record<string, BackupMemory>;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function readAll(storage: Storage | null): Stored {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const all: Stored = {};
    for (const [key, value] of Object.entries(parsed as object)) {
      if (!value || typeof value !== "object") continue;
      const row = value as Record<string, unknown>;
      all[key] = {
        ...(finite(row.savedAtMs) ? { savedAtMs: row.savedAtMs } : {}),
        ...(finite(row.documentsThen)
          ? { documentsThen: row.documentsThen }
          : {}),
        ...(finite(row.snoozedUntilMs)
          ? { snoozedUntilMs: row.snoozedUntilMs }
          : {}),
      };
    }
    return all;
  } catch {
    return {};
  }
}

function defaultStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** What this device remembers about backups of this vault ("vaultKey" is any opaque id of it). */
export function readBackupMemory(
  vaultKey: string,
  storage: Storage | null = defaultStorage(),
): BackupMemory {
  return readAll(storage)[vaultKey] ?? {};
}

function write(
  vaultKey: string,
  change: (before: BackupMemory) => BackupMemory,
  storage: Storage | null,
): BackupMemory {
  const all = readAll(storage);
  const next = change(all[vaultKey] ?? {});
  all[vaultKey] = next;
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage may be unavailable: the reminder is then only as good as this session.
  }
  return next;
}

/** A backup was saved: remember when, and how many documents it held; a snooze ends. */
export function rememberBackup(
  vaultKey: string,
  documents: number,
  now: number,
  storage: Storage | null = defaultStorage(),
): BackupMemory {
  return write(
    vaultKey,
    () => ({ savedAtMs: now, documentsThen: documents }),
    storage,
  );
}

/** "Not now": the reminder stays away for the snooze period. */
export function snoozeBackupReminder(
  vaultKey: string,
  now: number,
  storage: Storage | null = defaultStorage(),
): BackupMemory {
  return write(
    vaultKey,
    (before) => ({ ...before, snoozedUntilMs: now + SNOOZE_DAYS * DAY_MS }),
    storage,
  );
}

/** Why a reminder is due now, or null when it is not (no documents, a recent backup, a snooze). */
export function dueBackupReminder(
  documents: number,
  memory: BackupMemory,
  now: number,
  after: { days: number; documents: number } = {
    days: REMIND_AFTER_DAYS,
    documents: REMIND_AFTER_DOCUMENTS,
  },
): BackupReminder | null {
  if (documents <= 0) return null;
  if (memory.snoozedUntilMs !== undefined && now < memory.snoozedUntilMs)
    return null;
  if (memory.savedAtMs === undefined) return { kind: "never" };
  // A date in the future (a clock set back) is not "old".
  if (now - memory.savedAtMs >= after.days * DAY_MS)
    return { kind: "old", savedAtMs: memory.savedAtMs };
  const added = documents - (memory.documentsThen ?? documents);
  if (added >= after.documents) return { kind: "many", added };
  return null;
}

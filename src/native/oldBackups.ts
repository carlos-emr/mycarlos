import {} from "../i18n";
// What to do about backups saved before a recovery key was replaced. They
// open with the passphrase or recovery key they were saved with, the old key
// among them. Whether to delete them depends on why the key was replaced,
// which the patient is asked: only a kit that may have been lost or seen
// makes them worth deleting, and then only once a new backup is saved, so
// that deleting never leaves none.

/** A routine replacement: the old kit is safe. */
export const OLD_BACKUPS_ROUTINE =
  "interface.oldBackups.eachBackupYouSavedBeforeNowStill";

/** A kit that may have been lost or seen: Security shows the steps. */
export const OLD_BACKUPS_EXPOSED =
  "interface.oldBackups.yourOldKitCouldStillOpenBackups";

/** The same, for a vault that cannot save a backup just now. */
export const OLD_BACKUPS_KEEP =
  "interface.oldBackups.yourOldKitCouldStillOpenBackupsAlternative";

/** Where the steps for older backups are: a new backup to save first, then
 * every other one to delete, keeping the one named here (the file written,
 * where the platform says it). Kept in webview storage, so that a lock or
 * closing myCarlos does not lose the steps; it holds only a file name the
 * patient chose or saw. */
export type OldBackupsGuide =
  | { step: "save" }
  | {
      step: "delete";
      keep: string | null;
      savedAtMs: number;
      bytes: number | null;
    };

const STORAGE_KEY = "mycarlos.oldBackupsGuide.v1";

export function readOldBackupsGuide(): OldBackupsGuide | null {
  let stored: unknown = null;
  try {
    const text = window.localStorage.getItem(STORAGE_KEY);
    stored = text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof stored !== "object" || stored === null) return null;
  const { step, keep, savedAtMs, bytes } = stored as {
    step?: unknown;
    keep?: unknown;
    savedAtMs?: unknown;
    bytes?: unknown;
  };
  if (step === "save") return { step };
  if (
    step === "delete" &&
    (typeof keep === "string" || keep === null) &&
    typeof savedAtMs === "number"
  )
    return {
      step,
      keep,
      savedAtMs,
      bytes: typeof bytes === "number" ? bytes : null,
    };
  return null;
}

export function rememberOldBackupsGuide(guide: OldBackupsGuide | null): void {
  try {
    if (guide) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(guide));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Without webview storage the steps last as long as this screen.
  }
}

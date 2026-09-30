// What to do about backups saved before a recovery key was replaced. They
// open with the passphrase or recovery key they were saved with, the old key
// among them. Whether to delete them depends on why the key was replaced,
// which the patient is asked: only a kit that may have been lost or seen
// makes them worth deleting, and then only once a new backup is saved, so
// that deleting never leaves none.

/** A routine replacement: the old kit is safe. */
export const OLD_BACKUPS_ROUTINE =
  "Backups you saved before now still open with your old key, or the passphrase they were saved with. Keep the old key's kit safe. If you destroy it, those backups open only with their passphrase. A backup you save from now on opens with your new key.";

/** A kit that may have been lost or seen: Security shows the steps. */
export const OLD_BACKUPS_EXPOSED =
  "Your old kit could still open backups saved before now. In Security, save a new backup, then delete the older ones: Security shows the steps.";

/** The same, for a vault that cannot save a backup just now. */
export const OLD_BACKUPS_KEEP =
  'Your old kit could still open backups saved before now, but keep them for now: this vault cannot save a new backup until you have done what the "Read-only recovery mode" notice in the library says. Then save a new backup in Security, and delete the older ones.';

/** Where the steps for older backups are: a new backup to save first, then
 * every other one to delete, keeping the one named here (the file written,
 * where the platform says it). Kept in webview storage, so that a lock or
 * closing myCarlos does not lose the steps; it holds only a file name the
 * patient chose or saw. */
export type OldBackupsGuide =
  | { step: "save" }
  | { step: "delete"; keep: string | null };

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
  const { step, keep } = stored as { step?: unknown; keep?: unknown };
  if (step === "save") return { step };
  if (step === "delete" && (typeof keep === "string" || keep === null))
    return { step, keep };
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

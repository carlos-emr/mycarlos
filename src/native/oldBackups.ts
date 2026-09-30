/** What to do about backups saved before a recovery key was replaced: they
 * still open with the old key, so a kit for it that is lost or seen still
 * opens them. myCarlos does not know where they are; the patient chose. */
export const OLD_BACKUPS_ADVICE =
  'Backups saved before now still open with the old key, so a lost kit could still open them. Delete them: they are the files named "myCarlos backup" (ending in .mycarlosbackup) wherever you saved them, such as a folder, a USB stick, or on a phone the Files app or a cloud drive. Then save a new backup: in Security, choose Save encrypted backup.';

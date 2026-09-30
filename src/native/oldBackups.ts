/** What to do about backups saved before a recovery key was replaced: they
 * open with the key and passphrase they were saved with, so a kit for an
 * older key that is lost or seen still opens them. A new backup comes first,
 * so that deleting the old ones never leaves none; myCarlos does not know
 * where they are, as the patient chose. */
export const OLD_BACKUPS_ADVICE =
  'Any backups you saved before now still open with the passphrase or recovery key they were saved with, so an old kit could still open them. First save a new backup: in Security, choose Save encrypted backup. Then delete the older backups, and keep the new one: they are files whose names start with "myCarlos backup" (unless you renamed them), wherever you saved them, such as a folder, a USB stick, or on a phone the Files app or a cloud drive. Check each file\'s date before you delete it.';

/** The same, for a vault that cannot save a backup just now. */
export const OLD_BACKUPS_KEEP =
  'Any backups you saved before now still open with the passphrase or recovery key they were saved with. Keep them for now: this vault cannot save a new backup until you have done what the "Read-only recovery mode" notice in your records says. Then save a new backup in Security, and delete the older ones, keeping the new one.';

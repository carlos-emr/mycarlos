import type { Message } from "../types";

/** The source catalogue. Every other language must have exactly these keys
 * (the compiler and the catalogue tests both check), and each translation
 * must use the same {placeholders} as the English text. Text goes into the page
 * as plain text, never as HTML. */
export const en = {
  // Window frame
  "frame.banner.title": "Synthetic-data development build",
  "frame.banner.body": "Do not use real patient information",
  "frame.window.label": "myCarlos private vault",
  "frame.state.locked": "Locked",
  "frame.state.locking": "Locking",
  "frame.state.notLocked": "Not locked",
  "frame.state.settingUp": "Setting up",
  "frame.state.opening": "Opening",
  "auth.kicker": "myCarlos private records",

  // Passphrase fields, shared
  "passphrase.label": "Passphrase",
  "passphrase.confirm.label": "Confirm passphrase",
  "passphrase.new.label": "New passphrase",
  "passphrase.confirmNew.label": "Confirm new passphrase",
  "passphrase.rules":
    "Use at least {min} characters. Spaces are allowed; common passwords, names, and predictable patterns are rejected locally.",
  "passphrase.mismatch": "Passphrases do not match.",
  "passphrase.tooLong": "This passphrase is too long. Shorten it.",
  "passphrase.tooShort":
    "This passphrase is too short. Use at least {min} characters.",
  "passphrase.longerThanAny":
    "This is longer than any vault passphrase. Check what you typed.",

  // Create the vault
  "create.title": "Create your encrypted vault",
  "create.intro":
    "Your files and record details are encrypted on this device. Your passphrase opens the vault. Next, you can set up a recovery key in case you forget it.",
  "create.stays":
    "Your vault stays on this device. If you created one on another device, it is still there, and will not appear here.",
  "create.profile.label": "First patient profile",
  "create.profile.tooLong": "This name is too long. Shorten it.",
  "create.submit": "Create vault",

  // Unlock
  "unlock.title": "Unlock your vault",
  "unlock.autoLock": {
    one: "The vault locks after {count} minute of inactivity and whenever myCarlos is hidden, for example minimized or sent to the background.",
    other:
      "The vault locks after {count} minutes of inactivity and whenever myCarlos is hidden, for example minimized or sent to the background.",
  },
  "unlock.submit": "Unlock",
  "unlock.forgot.summary": "Forgot your passphrase?",
  "unlock.noKey.heading": "No recovery key?",
  "unlock.noKey.body":
    "Without one, the only way back in is to erase this vault, which permanently deletes everything in it, and start again.",
  "restore.summary": "Restore from a backup",

  // Erase the vault
  "reset.type": "Type {phrase}",
  "reset.submit": "Erase vault",

  // Open with the recovery key
  "recover.intro":
    "Use your recovery key to open the vault and choose a new passphrase.",
  "recover.key.label": "Recovery key",
  "recover.key.format":
    "28 letters and digits, in 7 groups of 4, as on your kit or as you wrote it down. Dashes, spaces and other punctuation do not matter.",
  "recover.key.show": "Show recovery key",
  "recover.submit": "Open with recovery key",

  // Hidden-text count read out for a secret field (never the secret itself)
  "secret.count.password": {
    one: "{count} character password",
    other: "{count} character password",
  },
  "secret.count.recoveryKey": {
    one: "{count} character recovery key",
    other: "{count} character recovery key",
  },
  "secret.count.shown": "{description}, shown",

  // Restore a backup
  "restore.intro":
    "An encrypted backup opens with the passphrase it was made with, or with the recovery key the vault had when the backup was saved, if it had one.",
  "restore.choose": "Choose backup file…",
  "restore.chooseOther": "Choose a different backup…",
  "restore.chosen": "Backup chosen.",
  "restore.openWith": "Open it with",
  "restore.method.passphrase": "Its passphrase",
  "restore.method.recoveryKey": "Its recovery key",
  "restore.passphrase.label": "Backup passphrase",
  "restore.passphrase.show": "Show passphrase",
  "restore.tooLong": "This is too long. Check what you typed.",
  "restore.check": "Check backup",
  "restore.checking": "Checking the backup…",
  "restore.checked": {
    one: "The backup holds {count} document. {consequence}",
    other: "The backup holds {count} documents. {consequence}",
  },
  "restore.consequence.nothing": "Restoring puts this vault on this device.",
  "restore.consequence.same":
    "The vault on this device holds the same documents. Restoring replaces it with this backup.",
  "restore.consequence.differs":
    "The vault on this device may not be the same as this backup: it may have changed since, or part of it could not be read. Restoring replaces the vault with the backup: anything in the vault that is not in the backup is lost, and the passphrase and recovery key become the ones the backup was made with.",
  "restore.consequence.otherVault":
    "This device has a different vault. Restoring erases it, permanently, and puts the backup in its place.",
  "restore.consequence.unreadable":
    "The vault on this device could not be read, so myCarlos cannot tell whether it is the one this backup was made from. Restoring erases it, permanently, and puts the backup in its place.",
  "restore.agree.erase":
    "Erase the vault on this device and restore the backup",
  "restore.agree.replace":
    "Replace the vault on this device with this backup and lose what changed since",
  "restore.submit": "Restore backup",
  "restore.restoring":
    "Restoring the backup. This can take a while for a large vault…",
  "restore.cancelled": "Restore cancelled. Nothing changed.",
} as const satisfies Record<string, Message>;

export type MessageKey = keyof typeof en;

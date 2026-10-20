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

  "passphrase.show": "Show passphrase",
  "passphrase.show.inConfirm": "in Confirm passphrase",

  // The rules a new passphrase must meet, each ticked once it is met
  "checklist.heading": "Your passphrase needs to be:",
  "checklist.length": "At least {min} characters",
  "checklist.hardToGuess": "Not easy to guess",
  "checklist.notAName": "Not your name",
  "checklist.done": ", done",
  "checklist.notYet": ", not yet",
  "checklist.spaces":
    "Spaces are allowed, so a few unrelated words make a good one. myCarlos checks these rules on this computer.",
  "checklist.allMet": "Your passphrase meets all the rules.",

  // Create the vault
  "create.title": "Set up myCarlos on this computer",
  "create.intro":
    "Your files and record details are encrypted on this device. Your passphrase opens the vault. Next, you can set up a recovery key in case you forget it.",
  "create.stays":
    "Your vault stays on this device. If you created one on another device, it is still there, and will not appear here.",
  "create.profile.label": "Whose records will you keep here?",
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
    "Without one, the only way back in is to set this vault aside and start again. The vault set aside stays on this device, encrypted, but nobody can open it without its passphrase.",
  "restore.summary": "Restore from a backup",

  // Erase the vault
  "reset.plainly":
    "Setting the vault aside takes all your documents, folders and patient profiles out of myCarlos on this computer. They stay on this computer, encrypted, but nobody can open them without the passphrase. To be sure, type the words below exactly.",
  "reset.type": "Type {phrase}",
  "reset.submit": "Set vault aside",

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
    "The vault on this device holds the same documents. Restoring sets it aside and puts this backup in its place. The vault set aside stays on this device, encrypted, but myCarlos cannot open it again for you yet.",
  "restore.consequence.differs":
    "The vault on this device may not be the same as this backup: it may have changed since, or part of it could not be read. Restoring sets the vault aside and puts the backup in its place: anything that is not in the backup is no longer in the vault you use, and the passphrase and recovery key become the ones the backup was made with. The vault set aside stays on this device, encrypted, but myCarlos cannot open it again for you yet.",
  "restore.consequence.otherVault":
    "This device has a different vault. Restoring sets it aside and puts the backup in its place. The vault set aside stays on this device, encrypted, but myCarlos cannot open it again for you yet.",
  "restore.consequence.unreadable":
    "The vault on this device could not be read, so myCarlos cannot tell whether it is the one this backup was made from. Restoring sets it aside and puts the backup in its place. The vault set aside stays on this device, encrypted, but myCarlos cannot open it again for you yet.",
  "restore.agree.erase":
    "Set the vault on this device aside and restore the backup",
  "restore.agree.replace":
    "Set the vault on this device aside, with what changed since, and restore this backup",
  "restore.submit": "Restore backup",
  "restore.restoring":
    "Restoring the backup. This can take a while for a large vault…",
  "restore.cancelled": "Restore cancelled. Nothing changed.",
} as const satisfies Record<string, Message>;

export type MessageKey = keyof typeof en;

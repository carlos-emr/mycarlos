import type { Message } from "../types";

/** The source catalogue. Every other language must have exactly these keys
 * (the compiler and the catalogue tests both check), and each translation
 * must use the same {placeholders} as the English text. Text goes into the page
 * as plain text, never as HTML. */
export const en = {
  "portal.working": "Clinic operation in progress…",
  "portal.connectConsent":
    "This connects this device and sends an approval request. Your clinic must approve the device before it can receive documents.",
  "portal.connecting": "Connecting and requesting clinic approval…",
  "portal.connected":
    "Device linked. Its approval status is shown in Security, under Clinic documents.",
  "portal.linkedApprovalIssue":
    "Device linked, but the approval request could not be confirmed. Its status in Security, under Clinic documents, says what to do next.",
  "portal.retryApproval": "Retry saved approval request",
  "portal.errorBusy":
    "Another clinic operation is running. Wait for it to finish, then try again.",
  "portal.serviceDateLabel": "Service date",
  "portal.serviceDate": "Service date: {date}",
  "portal.dateNotRecorded": "Date not recorded",
  "portal.restartApproval": "Start a new approval request",
  "portal.approvalExpired":
    "This approval request expired. To ask again for this device, go to Security, under Clinic documents.",
  "portal.approvalExpiredCard":
    "This approval request expired. To ask again for this same device, choose Start a new approval request. Your documents and this device's link stay as they are.",
  "portal.approvalCancelled":
    "This approval request was cancelled. Check for updates before starting a new request.",
  "portal.approvalRefused":
    "The clinic refused this device approval request. Contact your clinic for next steps.",
  "portal.approvalContact":
    "Clinic approval needs to be checked. Contact your clinic for next steps.",
  "portal.approvalMissing":
    "Your saved approval request was not found on the portal. Send the saved request again.",
  "portal.awaitingClinic":
    "Your clinic has the approval request. Waiting for clinic staff to approve this device.",
  "portal.approvalPickedUp":
    "Your clinic's records system has picked up this request. Waiting for clinic staff to approve this device.",
  "portal.approvalTimeLeft": {
    one: "Time left for this request: about {count} minute.",
    other: "Time left for this request: about {count} minutes.",
  },
  "portal.approvalTimeUp":
    "The time for this request has run out. Checking with your clinic…",
  "portal.approvalTimeOver": "The time for this request has run out.",
  "portal.approvalTimeOverRestart":
    "The time for this request has run out. If your clinic has not approved this device, choose Start a new approval request.",
  "portal.approvalUnanswered":
    "myCarlos could not get this request's status from the clinic portal.",
  "portal.deviceRemoved":
    "This device was removed from your clinic portal account. To use it again, connect it again with a new linking code from your patient portal.",
  "portal.approvalReplyInvalid":
    "The clinic portal's answer about this request could not be verified, so it was not used. Contact your clinic.",
  "portal.approvalStillOpen":
    "This approval request is still open on the clinic portal. Wait until it ends before starting a new one.",
  "portal.approvalUnreachable":
    "myCarlos could not reach the clinic portal, so this request's status is not known yet.",
  "portal.approvalWait":
    "The clinic portal asked myCarlos to check less often.",
  "portal.autoChecking":
    "While this page is open, myCarlos checks for your clinic's answer automatically.",
  "portal.autoCheckStopped":
    "Automatic checks have stopped. To check again, choose {button}.",
  "portal.errorRateLimited":
    "The clinic portal asked myCarlos to wait before trying again.",
  "portal.confirmationsPending":
    "Saved documents awaiting pickup confirmation: {count}. Check again to finish confirmation. Your saved copies stay in the vault.",
  "portal.partialResult":
    "Some clinic checks need attention. New documents saved: {added}. Documents that could not be verified: {refused}.",
  "portal.clinicIssue": "{clinic}: {detail}",
  // Native clinic linking and explicit document pickup.
  "portal.title": "Clinic documents",
  "portal.intro":
    "Link myCarlos using the address and code shown in your patient portal.",
  "portal.address": "Portal HTTPS address",
  "portal.code": "Linking code",
  "portal.deviceName": "Name for this device",
  "portal.person": "Whose records",
  "portal.matchPerson": "Match the document details",
  "portal.routing":
    "Documents go to a person with a matching full name and birth date. Other documents go to Shared with me.",
  "portal.link": "Connect and request approval",
  "portal.check": "Check for new documents",
  "portal.result":
    "New documents saved: {added}. Documents that could not be verified: {refused}.",
  "portal.incomplete":
    "This saved attempt is incomplete. Check linked devices in the portal or contact your clinic before connecting again. This app cannot resume this attempt.",
  "portal.approved": "The clinic approved this device.",
  "portal.notRequested":
    "Request clinic approval to receive documents on this device.",
  "portal.awaiting":
    "Approval request saved. Check for updates or send it again.",
  "portal.deviceCode": "Device code",
  "portal.copy": "Copy device code",
  "portal.copied": "Device code copied.",
  "portal.copyFailed": "Select the entire device code and copy it.",
  "portal.fingerprint": "Full device fingerprint",
  "portal.compare":
    "Ask clinic staff to compare this entire fingerprint on this screen before approving this device.",
  "portal.requestApproval": "Request clinic approval",
  "portal.sourceVerified": "From {clinic} · Verified",
  "portal.errorAddress":
    "Enter the portal HTTPS address without a username, password, query, or fragment.",
  "portal.errorCode":
    "Enter the complete linking code shown in your patient portal.",
  "portal.errorDeviceName":
    "Choose a device name of 1 to 64 characters without control characters.",
  "portal.errorCodeRejected":
    "The portal did not accept that code. Make a new linking code in your patient portal.",
  "portal.errorKeys":
    "The clinic has not published a signing key yet. Linking is incomplete.",
  "portal.errorExists":
    "This device is already registered. Check Linked devices in your patient portal.",
  "portal.errorIncomplete":
    "The portal request could not be completed. Check your connection and device clock, then try again.",
  "portal.errorRefused":
    "A clinic document could not be verified. It was not added and no pickup receipt was sent.",

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
  "create.profile.sharedTaken":
    "{folder} is where shared files go. Choose another name.",
  "create.submit": "Create vault",

  // Unlock
  "unlock.title": "Unlock your vault",
  "unlock.autoLock": {
    one: "The vault locks after {count} minute of inactivity and whenever myCarlos is hidden, for example minimized or sent to the background.",
    other:
      "The vault locks after {count} minutes of inactivity and whenever myCarlos is hidden, for example minimized or sent to the background.",
  },
  "unlock.waiting.one":
    "One shared file is waiting. Unlock and it goes into {folder}. If myCarlos closes first, it is not kept: share it again.",
  "unlock.waiting": {
    one: "{count} shared file is waiting. Unlock and it goes into {folder}. If myCarlos closes first, it is not kept: share it again.",
    other:
      "{count} shared files are waiting. Unlock and they go into {folder}. If myCarlos closes first, they are not kept: share them again.",
  },
  "unlock.submit": "Unlock",
  "unlock.forgot.summary": "Forgot your passphrase?",
  "unlock.noKey.heading": "No recovery key?",
  "unlock.noKey.body":
    "Without one, the only way back in is to set this vault aside and start again. The vault set aside stays on this device, encrypted, but nobody can open it without its passphrase.",
  "restore.summary": "Restore from a backup",

  // Set the vault aside
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

  // Shared
  "common.cancel": "Cancel",

  // Library sidebar
  "sidebar.label": "Record library",
  "sidebar.myRecords": "My records",
  "sidebar.settings": "Settings",
  "sidebar.preferences": "Preferences",
  "sidebar.storage": "Encrypted local vault",
  "sidebar.documents": { one: "{count} document", other: "{count} documents" },
  "sidebar.folderCount": { one: "{count} folder", other: "{count} folders" },

  // Text size (Settings > Preferences)
  "textSize.title": "Text size",
  "textSize.announce": "Text size {percent}",
  "textSize.help":
    "Makes everything in myCarlos larger or smaller, from {min}% to {max}%. myCarlos remembers the size on this computer. You can also hold {modifier} and press plus, minus or 0.",
  "textSize.key.command": "Command",
  "textSize.smaller": "Smaller text",
  "textSize.larger": "Larger text",
  "textSize.box": "Text size in percent",
  "textSize.reset": "Back to normal size",
  "textSize.notNumber": "Type a number from {min} to {max}.",
  "textSize.smallest": "The smallest size is {min}%.",
  "textSize.largest": "The largest size is {max}%.",
  "textSize.between": "{typed}% is between sizes, so it is {size}.",

  // Rename a document or folder
  "rename.title.document": "Rename document",
  "rename.title.folder": "Rename folder",
  "rename.label.folder": "Folder name",
  "rename.label.document": "File name",
  "rename.help.folder":
    "The folder and its contents stay in the same location.",
  "rename.help.document":
    "This changes the name in myCarlos and the suggested export name.",
  "rename.help.documentExtension":
    "This changes the name in myCarlos and the suggested export name. The {extension} extension stays the same.",
  "rename.stemMissing": "Enter a name before {extension}.",
  "rename.gainsExtension":
    "This document's name has no .pdf extension, so it cannot end in .pdf.",
  "rename.tooLong": "This name is too long. Shorten it to save.",
  "rename.unsafe":
    "Document names cannot contain {characters} or invisible control characters, or end with a dot.",
  "rename.reserved":
    '"{word}" cannot be used as a document name, because Windows keeps it for its own use. Choose another name.',
  "rename.saving": "Saving…",
  "rename.save": "Save name",

  // Settings > Security
  "security.title": "Security",
  "security.subtitle": "Your encrypted vault and access settings",
  "security.devBuild.title": "Development build.",
  "security.devBuild.body": "Use synthetic files only.",
  "security.encryption.title": "Encryption",
  "security.encryption.state": "On — always",
  "security.encryption.body":
    "Files, names, folders, and record details are encrypted on this device.",
  "security.autoLock.title": "Lock automatically",
  "security.autoLock.minutes": {
    one: "{count} minute",
    other: "{count} minutes",
  },
  "security.autoLock.body":
    "The vault locks after the selected period without keyboard, pointer, or touch activity. Choose from 1 to 15 minutes.",
  "security.autoLock.label": "Automatic lock delay",
  "security.autoLock.shorter": "Shorter delay",
  "security.autoLock.longer": "Longer delay",
  "security.lockNow": "Lock now",
  "security.recoveryKey.title": "Recovery key",
  "security.recoveryKey.setUpOn": "Set up {date}",
  "security.recoveryKey.notSetUp": "Not set up",
  "security.recoveryKey.body":
    "Opens your vault if you forget your passphrase. Only you have it: nobody at your clinic or at myCarlos can open your vault for you. Replacing it stops the old one working.",
  "security.recoveryKey.current":
    "Your current key has the label {label}. A kit or note with this label is the one that works; one with another label does not open this vault. Kits and notes made before labels were shown have none: one without a label may still be this key, set up on {date}.",
  "security.recoveryKey.replace": "Replace recovery key",
  "security.recoveryKey.setUp": "Set up recovery key",
  "security.backup.title": "Encrypted backup",
  "security.backup.body":
    "One file holding your whole vault, still encrypted. Keep it somewhere other than this device, such as a USB drive. It opens with the passphrase or recovery key you have when you save it, and keeps opening with them even after you change them here. To restore one, lock the vault and choose Restore from a backup.",
  "security.oldBackups.title": "Your older backups",
  "security.oldBackups.intro":
    "The kit for an earlier recovery key may have been lost or seen, and it still opens backups saved before that key was replaced.",
  "security.oldBackups.saveWhenWritable":
    "Once the vault accepts changes again, save a new backup: choose Save encrypted backup.",
  "security.oldBackups.saveNow":
    "Save a new backup now: choose Save encrypted backup.",
  "security.oldBackups.keepCopy":
    "Keep it, or a copy of it, somewhere other than this device, such as a USB stick or a cloud drive.",
  "security.oldBackups.thenDelete":
    "Then delete the older backups. Once the new one is saved, this says how.",
  "security.oldBackups.none": "I have no older backups",
  "security.oldBackups.named": "Your new backup is “{name}”.",
  "security.oldBackups.namedWithSize": "Your new backup is “{name}” ({size}).",
  "security.oldBackups.justSaved":
    "Your new backup is the one you just saved, on {date} at about {time}: your files app shows when each file was saved, and its size.",
  "security.oldBackups.justSavedWithSize":
    "Your new backup is the one you just saved, on {date} at about {time} ({size}): your files app shows when each file was saved, and its size.",
  "security.oldBackups.deleteOlder":
    "Delete the older backups: files whose names start with “myCarlos backup”, and any you renamed, other than the new one and its copies. They are wherever you saved them: a folder, a USB stick, or on a phone the Files app or a cloud drive.",
  "security.oldBackups.inPlace":
    "If you saved it in place of an older backup, that file is now your new backup: keep it.",
  "security.oldBackups.done": "Done with older backups",
  "security.backup.save": "Save encrypted backup…",
  "security.passphrase.title": "Change passphrase",
  "security.passphrase.rules":
    "Use at least {min} characters and avoid common names or predictable phrases. Your recovery key, if you have one, keeps working; without one, forgetting the new passphrase means setting the vault aside and starting again.",
  "security.passphrase.copies":
    "Changing your passphrase keeps out someone who only knows the old one. If they may also have a copy of your vault, such as a backup of this device or a saved backup file, a new passphrase is not enough: the old one still opens that copy, and with that copy they could open a newer one they got later. Shutting them out takes a new vault, and care not to lose documents on the way. Ask for help before you set your vault aside.",
  "security.passphrase.current": "Current passphrase",
  "security.passphrase.currentTooLong":
    "The current passphrase is longer than any vault passphrase. Check what you typed.",
  "security.passphrase.mismatch": "New passphrases do not match.",
  "security.passphrase.newTooLong":
    "The new passphrase is too long. Shorten it.",
  "security.passphrase.newTooShort":
    "The new passphrase is too short. Use at least {min} characters.",
  "security.passphrase.submit": "Change passphrase",
  "security.speed.title": "Speed test, for testers",
  "security.speed.body":
    "Measures how long this device takes to check a passphrase. It uses a made-up passphrase, not yours, and changes nothing. It takes a few seconds, longer on an older phone. Close other apps first, and stay on this screen until it is done. Send the result with the device's make and model.",
  "security.speed.run": "Run speed test",
  "security.speed.measuring": "Measuring…",
  "security.copies.title": "Readable copies and screenshots",
  "security.copies.body":
    "Exports and screenshots leave vault protection. Hiding a document in myCarlos does not erase those copies or the clinic's source medical record.",
  "security.profiles.title": "Patient profiles",
  "security.profiles.body":
    "Keep each person’s filing cabinet separate inside this vault.",
  "security.profiles.label": "New profile name",
  "security.profiles.add": "Add profile",
  "security.erase.title": "Erase entire vault",
  "security.erase.body":
    "Permanently deletes every encrypted document, profile, and folder. This cannot be undone.",
  "security.erase.show": "Show reset controls",
  "security.erase.submit": "Erase entire vault",

  // Recovery key setup, and the printed kit
  "recoveryKey.printUnavailable":
    "Printing is not available here. Save the kit, or write the key down.",
  "recoveryKey.chooseReason": "Choose why you are replacing your recovery key.",
  "recoveryKey.kitSaved":
    "Recovery kit saved. The key starts working once you finish the check.",
  "recoveryKey.typedCount": {
    one: "You typed {count} letter or digit. Your recovery key has {total} letters and digits: 7 groups of 4. Check what you wrote.",
    other:
      "You typed {count} letters and digits. Your recovery key has {total} letters and digits: 7 groups of 4. Check what you wrote.",
  },
  "recoveryKey.notChanged":
    "Your recovery key was not changed. Your current key still works. To change it, press Check and save again.",
  "recoveryKey.threeMisses":
    "That did not match three times. Look at your recovery key again, then check it.",
  "recoveryKey.leave.required": "Lock vault and finish later",
  "recoveryKey.leave.offered": "Set up later",
  "recoveryKey.title.replace": "Replace your recovery key",
  "recoveryKey.title.setUp": "Set up a recovery key",
  "recoveryKey.title.key": "Your recovery key",
  "recoveryKey.title.check": "Check your recovery key",
  "recoveryKey.discard.title": "Discard this recovery key?",
  "recoveryKey.discard.body":
    "This recovery key is not set up yet, so it will never open the vault. myCarlos locks the vault now. After you unlock it, you can set up a new key.",
  "recoveryKey.discard.confirm": "Discard key and lock",
  "recoveryKey.about.offered":
    "Your vault is open. It has no recovery key yet. Without one, if you forget your passphrase, the only way back in is to set the vault aside and start again.",
  "recoveryKey.about.what":
    "A recovery key opens your vault if you forget your passphrase. Only you will have it: nobody at your clinic or at myCarlos can open your vault for you.",
  "recoveryKey.about.replacing":
    "Your current recovery key stops working once you have checked the new one.",
  "recoveryKey.about.type":
    "Type your passphrase to make your recovery key. It is shown next: choose Continue only when nobody else can see your screen.",
  "recoveryKey.about.typeAgain":
    "Type your passphrase again to make your recovery key. It is shown next: choose Continue only when nobody else can see your screen.",
  "recoveryKey.about.typeNew":
    "Type your passphrase to make your new recovery key. It is shown next: choose Continue only when nobody else can see your screen.",
  "recoveryKey.about.typeAgainNew":
    "Type your passphrase again to make your new recovery key. It is shown next: choose Continue only when nobody else can see your screen.",
  "recoveryKey.reason.legend": "Why are you replacing it?",
  "recoveryKey.reason.hint": "If you are not sure, choose the first.",
  "recoveryKey.reason.exposed":
    "Its kit or note may have been lost, or seen by someone else",
  "recoveryKey.reason.routine": "I just want a new key: its kit is safe",
  "recoveryKey.continue": "Continue",
  "recoveryKey.keyboardHint":
    "Escape leaves this setup. During first setup it asks first, because leaving locks the vault and an unfinished key will not work.",
  "recoveryKey.instructions":
    "Write it down, or save or print the kit, and keep it somewhere private, away from this device. This is the only time myCarlos shows it. Next, you type it all back to check it. Stay in myCarlos until the check is done: leaving or locking cancels this key.",
  "recoveryKey.hiddenWhileSaving": "Hidden while the kit is being saved.",
  "recoveryKey.group": "Group {number}: {characters}",
  "recoveryKey.label":
    "Key label: {label}. Write it next to the key. It is not secret: in Security, myCarlos shows the label of the key that works, so you can tell which kit is current.",
  "recoveryKey.saveKit": "Save recovery kit…",
  "recoveryKey.printKit": "Print recovery kit",
  "recoveryKey.next": "Next: check your recovery key",
  "recoveryKey.check.label": "Your recovery key",
  "recoveryKey.check.hint":
    "Type your whole recovery key, as you wrote it down or saved it: 7 groups of 4 letters and digits. Dashes, spaces and other punctuation do not matter.",
  "recoveryKey.back": "Back: read your recovery key",
  "recoveryKey.checkAndSave": "Check and save",
  "kit.title": "myCarlos recovery kit",
  "kit.printed": "Printed {date}",
  "kit.labelPrinted": "Key label: {label} · Printed {date}",
  "kit.labelNote":
    "The label is not secret. In Security, myCarlos shows the label of the recovery key that works now: a kit with a different label no longer opens the vault.",
  "kit.use":
    "If you forget your myCarlos passphrase, this key opens your vault on this device and lets you choose a new passphrase. It works once you have finished the check in myCarlos.",
  "kit.keep":
    "Keep it somewhere private and away from the device. Anyone with this key and a copy of your vault can open it. If you set up a new recovery key, this one no longer opens the vault on this device.",

  // First setup: comfort settings, before the passphrase
  "comfort.title": "Make myCarlos comfortable for you",
  "comfort.intro":
    "Choose what suits you before you set up. Each choice works at once.",
  "comfort.sample":
    "This is how text looks in myCarlos. Press − or + until it is easy to read.",
  "textSize.followsDevice":
    "Here, text size follows your device: its own text size setting, or the browser's zoom.",
  "comfort.autoLock.body":
    "myCarlos locks itself when it has not been used for this long, so that nobody else can see your records. Choose from 1 to 15 minutes.",
  "comfort.later":
    "You can change these any time in {settings}: {textSize} under {preferences}, and {autoLock} under {security}.",
  "comfort.continue": "Continue",
  "comfort.usual": "Use the usual settings",

  // Notices after vault actions (the app's status line)
  "notice.iosKeepOpen":
    "Keep myCarlos open: switching apps pauses this transfer.",
  "notice.dropRefused":
    "To import PDFs, unlock your vault and use {button}. Drag and drop moves documents already in myCarlos.",
  "notice.lockedIdle": {
    one: "Locked after {count} minute without use.",
    other: "Locked after {count} minutes without use.",
  },
  "notice.lockedHidden":
    "Locked because myCarlos was minimized or sent to the background.",
  "notice.locked": "Vault locked.",
  "notice.autoLockSet": {
    one: "Automatic locking set to {count} minute.",
    other: "Automatic locking set to {count} minutes.",
  },
  "notice.backupCutOff":
    "The backup stopped because the vault locked. No backup was saved. Keep your older backups. {note}",
  "notice.transferUnfinished": "The transfer did not finish.",
  "notice.restored":
    "Backup restored. Unlock it with the passphrase it was made with, or use its recovery key.",
  "notice.createdThenLocked":
    "Your vault was created, then locked before its recovery key could be made. Unlock it to set one up.",
  "notice.created":
    "Encrypted vault created. Set up a recovery key, so that a forgotten passphrase does not lock you out of your documents for good.",
  "notice.unlockedRecovery":
    "Vault unlocked in read-only recovery mode. See the notice in the library for what to do.",
  "notice.unlocked": "Vault unlocked.",
  "notice.recovered":
    "Vault opened with your recovery key. Use your new passphrase from now on.",
  "notice.recoveredReadOnly":
    "Vault opened read-only with your recovery key, and your passphrase is unchanged. See the notice in the library for what to do.",
  "notice.eraseCancelled": "Nothing changed: the vault was not set aside.",

  // What to check after a refusal, and other errors the app words itself
  "box.name": "the name",
  "box.passphrase": "the passphrase",
  "box.currentPassphrase": "the current passphrase",
  "box.newPassphrase": "the new passphrase",
  "box.recoveryKey": "the recovery key",
  "box.typedWords": "the words you typed",
  "box.profileName": "the profile name",
  "box.folderName": "the folder name",
  "error.checkBoxes": "Check {boxes}, then try again.",
  "error.retryIn": {
    one: "Try again in {count} second.",
    other: "Try again in {count} seconds.",
  },
  "error.fallback": "The vault operation could not be completed.",
  "error.damaged":
    'No backup was saved: the document "{name}" ({where}) is damaged and can no longer be read, and a backup that holds it would not restore. Nothing was changed. Keep your older backups. Ask for help recovering this document from a good copy or backup before trying again.',
  "error.damaged.where": "added {date}",
  "error.damaged.whereFor": "added {date}, in {person}'s records",

  // The warning before the automatic lock (#68)
  "lockWarning.title": {
    one: "myCarlos will lock in {count} second to keep your records private.",
    other:
      "myCarlos will lock in {count} seconds to keep your records private.",
  },
  "lockWarning.help": "To keep it open, press {keepOpen}, or any key.",
  "lockWarning.left": {
    one: "{count} second left.",
    other: "{count} seconds left.",
  },
  "lockWarning.keepOpen": "Keep open",

  // Settings > Preferences, and Appearance (#47)
  "preferences.subtitle": "How myCarlos looks on this computer",
  "language.title": "Language",
  "language.help":
    "Remembered on this device. Your documents stay in their original language.",
  "language.system": "System default",
  "language.error.unreadable":
    "Your saved language could not be read. Using your device's language for this session.",
  "language.error.notRemembered":
    "Language changed for this session, but could not be remembered on this device.",

  "appearance.title": "Appearance",
  "appearance.help":
    "{system} follows your device's light or dark appearance. High contrast uses a black background and bright text. Your device's contrast colors always take priority.",
  "appearance.system": "System",
  "appearance.light": "Light",
  "appearance.dark": "Dark",
  "appearance.highContrast": "High contrast",
  "appearance.error.unreadable":
    "The saved appearance could not be read. Using {system} for this session.",
  "appearance.error.notRemembered":
    "Appearance changed for this session, but could not be remembered on this device.",
  "appearance.error.window":
    "Window appearance could not follow this choice. You can keep using myCarlos.",

  // A document shown as a photo
  "photo.eyebrow": "Photo",
  "photo.alt": "Photo: {name}",
  "photo.area": "Photo. Zoom in to see details; drag or scroll to move around.",
  "photo.fitted": "Fitted to the window.",
  "photo.zoomed": "Zoomed to {percent}%.",
  "photo.zoomOut": "Zoom out",
  "photo.zoomIn": "Zoom in",
  "photo.close": "Close",

  // The library's folders and documents, as a list or a grid
  "library.items": {
    one: "{count} visible library item",
    other: "{count} visible library items",
  },
  "library.column.name": "Name",
  "library.column.source": "Source",
  "library.column.added": "Date added",
  "library.folder.label": "{name} folder",
  "library.folder.open": "Open {name}",
  "library.folder.items": {
    one: "{count} item",
    other: "{count} items",
  },
  "library.folder.rename": "Rename folder {name}",
  "library.rename": "Rename",
  "library.document.label": "{name} document",
  "library.document.details": "Details for {name}",
  "library.details": "Details",
  "library.select": "Select {name}",
  "library.empty.title": "This location is empty",
  "library.empty.help": "Add a folder or import a document here.",
  "library.search.results":
    "Search results. Folders: {folders}. Documents: {documents}.",
  "library.search.cleared":
    "Search cleared. Folders in this location: {folders}. Documents: {documents}.",
  "library.noMatch.title": "No matching records",
  "library.noMatch.help": "Try another search.",
  // Optional identity details and explicit shared-document suggestions (#97).
  "personDetails.fullName": "Full name, as on clinic documents (optional)",
  "personDetails.birthDate": "Birth date (optional)",
  "personDetails.help":
    "Kept in this encrypted vault, to suggest who a shared document is for. These details do not verify a document's source.",
  "personDetails.nameTooLong": "This full name is too long. Shorten it.",
  "personDetails.invalidDate":
    "Enter a valid birth date as year, month and day.",
  "personDetails.futureDate": "A birth date cannot be in the future.",
  "personDetails.list": "People's details",
  "personDetails.for": "Details for {name}",
  "personDetails.save": "Save details",
  "personDetails.cancel": "Cancel",
  "personDetails.noName": "No full name",
  "personDetails.noDate": "No birth date",
  "personDetails.editFor": "Edit details for {name}",
  "personDetails.edit": "Edit details",
  "personDetails.saved": "Details for {name} saved.",
  "personSuggestion.byDate": "the birth date on the document matches",
  "personSuggestion.byBoth": "the birth date and name on the document match",
  "personSuggestion.byName": "the name on the document matches",
  "personSuggestion.for": "Suggested person for {document}",
  "personSuggestion.offer":
    "Looks like this is for {name} ({why}). Move it to their records?",
  "personSuggestion.moveLabel": "Move {document} to {name}'s records",
  "personSuggestion.move": "Move",
  "personSuggestion.dismissLabel": "Not this person: {document}",
  "personSuggestion.dismiss": "Not this person",
} as const satisfies Record<string, Message>;

export type MessageKey = keyof typeof en;

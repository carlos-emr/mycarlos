# myCarlos: draft pack for a privacy impact assessment

This is a plain-language draft for the privacy officer who will carry out the privacy impact
assessment (PIA) of myCarlos. It describes what the app does today, in this repository, and
what it does not do yet. It names no people, clinics or patients. Where a point needs a decision
or a check, it is listed under "Open questions" at the end.

**Status today.** myCarlos is an evaluation build. It is for synthetic (made-up) test data only
and is not approved for real patient information or a pilot (`README.md`, `MVP_STATUS.md`,
`SECURITY.md`). Nobody has yet run this version of the app by hand on any computer or phone, so
everything this pack says about how the app behaves comes from its code and documents, not from
watching it run; the Android and iPhone versions have never even been started. The test builds are
not signed (see section 4). There has been no independent security or privacy review yet. This
pack is meant to help start one.

## 1. What myCarlos is

myCarlos is an app a patient installs on their own computer or phone to keep their own health
records: PDF documents they choose to add, sorted into folders, under one or more "profiles"
(for example, one for themselves and one for a child they care for). It is a personal health
record held by the patient, not a clinic system.

It cannot show a document yet. To read one, the patient saves a readable copy outside the app and
opens it in another app (see section 6).

Today it is **not connected to anything**: not to CARLOS (the clinic's electronic medical
record), not to a clinic portal, not to any server. It has no accounts, no sign-in and no
analytics. The planned link with CARLOS (a clinic sends an encrypted document, and the patient
adds it to myCarlos) is not built.

## 2. What information it holds

Everything the patient puts into myCarlos is kept in one encrypted "vault" on the device.

| What | Examples | Kept encrypted? |
|---|---|---|
| Documents | The PDF files the patient adds | Yes, each with its own key |
| Document details | Name (the patient can rename it), size, date added, the label "Manual import — unverified", which folder it is in | Yes |
| Profiles | A display name for each person the patient keeps records for | Yes |
| Folders | Folder names and how they nest | Yes |
| Passphrase | Never stored. The vault's key is stored locked with a key worked out from the passphrase each time it is typed | The vault's key is locked with it |
| Recovery key | Never stored in the vault. The vault's key is stored locked with the recovery key, with a random id and the date it was set up | The vault's key is locked with it |

Adding a document copies it into the vault. **The original file stays where it was** (for example
in a Downloads folder or an email app), unencrypted; the app does not remove it or remind the
patient that it is there.

A few things are **readable without the passphrase** to anyone who can get at the vault's folder
or a backup file:
- that a vault exists, and its random id;
- the settings for turning the passphrase into a key: a random value (a "salt", which stops one
  round of guessing from working on many vaults at once) and how much work each guess costs;
- the random id of the recovery key and the date it was set up;
- how many documents there are, and the exact size of each (not their names or contents), so a
  document someone else also has, for example a standard form, could be recognised by its size;
- in the vault's folder on the device, the file dates, which show when documents were added or
  changed;
- counters, in the vault and in a backup, that show roughly how many changes have been made;
- when a backup was made;
- while a readable copy is being saved, the folder it is being saved to. This note is removed when
  the save ends; if the app is stopped during a save, it stays until the app next starts and can
  clean it up.

The app also keeps a few **settings in its own browser storage** on the device, none of them
secret and none naming a person or document (unless the patient typed one into a backup's file
name):
- how many minutes before it locks itself (1 to 15);
- whether a recovery-key setup was cut short by a lock or by closing the app: when the key was set
  up and, when a key was being replaced, whether the patient said its kit may have been lost or
  seen; never the key;
- after a recovery key is replaced because its kit may have been lost or seen, the steps for
  older backups: the file name the patient saved the new backup under, when, and its size.

Beside the vault, the app also keeps a small file counting wrong passphrase or recovery-key tries
in a row, and when the last one was, to make the next try wait after several. It holds no secret.
This is being added by a change still under review; see section 9.

The app itself never writes documents, their names, or profile and folder names anywhere
unencrypted, except when the patient saves a readable copy (see section 6). The name suggested for
that copy is the document's name, so it shows in the folder chosen and may show in the system's
"recent files" lists. Whether the operating system keeps copies of its own (logs, preview images,
memory written to disk) has not been checked (see section 9).

## 3. Where it is kept

The vault lives in the app's own data folder on the device, on that device only:
- **Windows:** the user's own application data folder that stays on this computer, so on a work
  network it does not follow the user to other computers.
- **macOS and iPhone/iPad:** the app's own data folder. Normal device backups (for example to a
  computer or iCloud) carry the encrypted files; restoring them still needs the passphrase.
- **Android:** the app's private storage. Android's own cloud backup and phone-to-phone transfer
  are switched off for the app, and the app cannot be built without that setting. Whether phone
  makers' own transfer tools respect it has not been tested on a phone.
- **Linux** (not supported; built for testing only): the user's local data folder.

On macOS and Linux the folder and files can be read by that user only. That another user account
on the same computer cannot get at them has not yet been tested on any system.

The app refuses to keep a vault where the storage cannot promise that what it writes is really
saved (for example some network folders), on the systems where it can tell.

## 4. Who can see it

- **The patient**, or anyone who has the vault's passphrase or its recovery key, and access to the
  device (or to a copy of the vault or a backup).
- **No one else holds a key.** The clinic, the developers and the people who host the code hold no
  key that opens a vault, and there is no "back door". As with any app, a changed (tampered) copy
  of the app, or a tampered update, could capture the passphrase as it is typed. A way to prove a
  copy is genuine (release signing and secure updates) is not in place yet; today's test builds
  are not signed.
- **One passphrase opens every profile.** Profiles only sort documents; they are not private from
  each other. On a shared family device, anyone who knows the passphrase sees every profile,
  including a child's or another adult's. A profile also does not show, and the app does not
  check, that the patient is allowed to hold that person's records.
- **On screen** are the names of documents, folders and profiles (there is no document viewer). When
  the window is minimised, or on a phone when the app goes to the background, myCarlos hides its
  content at once, and locks as soon as any import, save or backup under way has finished.
  Switching to another window on a computer without minimising leaves the list on screen until
  the automatic lock. The app does not block screenshots (a recorded product decision,
  `PRODUCT_DECISIONS.md`: blocking works differently on each system).
- The app **cannot protect** records on a device whose operating system is already compromised
  (for example, by malware that records the screen or the keyboard).
- **No record of use.** The app keeps no record of who opened the vault or what they looked at.
  Apart from the traces listed in section 2 (and, once the change under review lands, the count of
  wrong tries), it records nothing about use.

## 5. Backups

The patient can save an **encrypted backup**: one file holding the whole vault, still encrypted,
saved wherever the patient chooses (a folder, a USB stick, or on a phone the Files app or a
cloud drive). The app never chooses a place and never uploads it anywhere. The name it suggests
is "myCarlos backup", the date, and the recovery key's short label if the vault has a recovery
key (for example `myCarlos backup 2026-09-30 7F3A.mycarlosbackup`); it names no person or
document. The patient can type any other name.

- A backup opens only with the passphrase, or the recovery key, that the vault had when the backup
  was saved. Changing the passphrase or replacing the recovery key later does **not** lock older
  backups: they keep opening with what they were saved with. When a patient replaces a recovery
  key because its kit may have been lost or seen, the app guides them to save a new backup, keep
  it (or a copy) away from the device, and then delete the older ones.
- Anyone holding a backup file can try to guess its passphrase on their own computer, as with a
  copy of the vault. Each guess is made slow on purpose, but the repository's own estimate (not
  measured) is that a passphrase that only just passes the app's check could be found within days
  by a well-equipped attacker (`THREAT_MODEL.md`, KEY-01). A longer passphrase takes far longer.
- Restoring a backup replaces the vault on the device. The app shows what would be replaced, asks
  the patient to agree, and asks again in a separate system window (see section 8) before it does
  anything.
- Deleting a document in myCarlos does not delete it from backups made before.

## 6. The recovery key, and readable copies

**Recovery key.** A long random key (28 letters and digits) that opens the vault if the patient
forgets the passphrase. It is shown once, when it is made. The patient writes it down, or saves or
prints a "kit": a plain text file or page holding the key, a short label and a date, with no
names. **Anyone who finds the kit can open the vault** with it, so it must be kept like a house
key. Printing sends the key through the computer's print system, which may keep a copy for a
while. The patient can replace the key; the old one then stops opening the vault, but still opens
backups saved before (the app tells the patient what to do about them).

**Readable copies ("Save a copy").** Because the app cannot show a document yet, saving a readable
(unencrypted) copy, to a place the patient chooses, is the only way to read one, send it to
someone or open it in another app. That copy is outside myCarlos's protection. The app warns about
this before saving. Deleting the document in myCarlos, or erasing the whole vault, does not delete
readable copies already saved. A save cut off part way (for example by the app being stopped)
leaves part of the readable copy in a hidden folder beside the chosen place until the app next
starts and removes it.

## 7. What leaves the device

**The app itself sends nothing.** It:
- has no way to reach the internet: its security settings let its screens talk only to the app's
  own parts, and it includes no code for network connections;
- has no analytics, telemetry or crash reporting;
- has no automatic updates yet (updates are planned through app stores and a signed desktop
  updater);
- sends nothing to CARLOS, a clinic or the developers.

**Outside the app's own code:**
- Apple device backups can carry the encrypted vault to iCloud (section 3).
- The Windows installer may, without asking, download WebView2 (the Microsoft component that
  draws the app's screens) if the computer lacks it (open question 9).
- Parts of the system the app does not control have not been checked: for example the operating
  system's own crash reports, WebView2's own updates, a cloud drive chosen in the system's file
  window, and print services.

What the patient saves themselves (backups, recovery kits, readable copies) leaves the vault only
where the patient puts it.

## 8. How it is protected

- A random key for the vault, and a separate key for each document.
- The passphrase is turned into a key with Argon2id (a method that makes each guess slow and use a
  lot of memory); documents are encrypted with XChaCha20-Poly1305. Both are well-regarded, widely
  used methods; how myCarlos uses them has not been independently reviewed.
- Passphrases must be at least 15 characters, and a check on the device refuses ones that are easy
  to guess (see section 5 for how strong that makes them).
- The app locks after 1 to 15 minutes without use (5 by default). When its window is minimised or,
  on a phone, when it goes to the background, it hides its content at once and locks as soon as
  any import, save or backup under way has finished.
- Erasing the vault, restoring a backup over it and replacing the recovery key each need a second
  confirmation in a window drawn by the operating system rather than by the app's own screens,
  which makes it harder for a fault in those screens to skip it. Setting up the first recovery
  key, changing the passphrase and deleting documents do not have this second confirmation.
- Only one copy of the app can have the vault open at a time.

## 9. Known limits

These are stated in the repository's own documents (`THREAT_MODEL.md`, `VAULT_FORMAT.md`,
`MVP_STATUS.md`, `SECURITY_OPERATIONS.md`):
- **An old passphrase can still work.** Changing the passphrase, or replacing the recovery key,
  does not shut out someone who knows the old one and has a copy of the vault from before the
  change (a device backup, a copied folder, a backup file). The vault's own key never changes: the
  old passphrase opens the old copy, which gives up the vault's key, and that key also opens the
  vault as it is now, if they can get at it too. The only remedy today is a new vault. Changing
  the vault's key is planned after the first release.
- **Lost or stolen device.** There is no remote lock or wipe. What protects the vault is the
  device's own lock, the app's automatic lock (up to 15 minutes after last use) and the
  passphrase.
- **Uninstalling.** On Windows, removing the app can leave the vault's encrypted files behind; the
  app's instructions say to erase the vault first. Other systems have not been checked.
- **Rolling back the vault's files from outside the app** (for example restoring older copies of
  them with a file-restore tool) is not detected.
- **Deletion** is not carried into backups, readable copies or device snapshots, and the app cannot
  promise that deleted data is gone from the storage media.
- **Originals.** The file a document was added from stays where it was (section 2).
- **PDF safety.** There is no viewer, safe or otherwise: documents are read in other apps. A
  planned viewer with no access to the vault or the network is not built.
- **Guessing on the device.** A wait after repeated wrong passphrases or recovery keys is being
  added in a change still under review (none for the first five, then a little longer each time,
  up to a minute). It slows guessing only through the app on the device, not against a copied
  vault or backup, and whoever can change the app's files can undo it.
- **Not yet checked:** system logs, crash files, the app-switcher preview images, "recent files"
  lists, memory the system writes to disk, notifications and operating system backups have not
  been checked for leaked information. Nobody has run this version by hand, and the Android and
  iPhone versions have never been started.

## 10. Open questions for the assessment

1. **Approval to hold real patient information:** what is needed before a pilot (this assessment,
   an independent security review, device testing, signed builds)?
2. **Which law, and who is responsible for what:** does a health privacy law such as Ontario's
   PHIPA apply, and is anyone (the clinic, the developers) a custodian of the information or a
   provider of a service for it, or is the patient alone responsible? What, if anything, is the
   clinic responsible for once it gives a patient the app or sends documents to it?
3. **Incidents:** nobody is named yet to handle a security or privacy incident. The repository
   says an owner, an incident lead and privacy and clinical contacts must be named, and the process
   practised, before a pilot (`SECURITY_OPERATIONS.md`).
4. **Records about other people:** is guidance needed for patients who keep a child's or another
   adult's records in a profile, given that profiles are not private from each other?
5. **Corrections:** documents in myCarlos are copies. Should patients be told that a request to
   correct a record goes to whoever holds the original?
6. **Readable copies:** since saving a readable copy is the only way to read a document today, is
   the warning before "Save a copy" enough, or should a viewer come first?
7. **Originals left behind:** should the app remind patients that the file they added a document
   from is still there, unencrypted?
8. **Backups in cloud drives:** backups are encrypted, but a patient may save them to a cloud
   service. Is advice about where to keep them needed?
9. **Windows installer:** it can download Microsoft's WebView2 component during installation,
   without asking, if the computer lacks it. Is that acceptable, or should the installer carry it?
10. **Device backups on Apple devices:** these carry the encrypted vault by design. Should that
    change?
11. **Screenshots:** the app allows them, as a recorded product decision. Is that acceptable?
12. **Retention:** how long should backups and deleted documents be kept, if any rule applies?
13. **The planned link with CARLOS:** consent, and what the clinic's systems would see (for example
    who sent what to whom, and when), will need their own assessment when it is designed.

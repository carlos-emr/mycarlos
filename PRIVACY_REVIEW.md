# myCarlos: draft pack for a privacy impact assessment

This is a plain-language draft for the privacy officer who will carry out the privacy impact
assessment (PIA) of myCarlos. It describes what the app does today, in this repository, and
what it does not do yet. It names no people, clinics or patients. Where a point needs a decision
or a check, it is listed under "Open questions" (section 10).

**Status today.** myCarlos is an evaluation build. It is for synthetic (made-up) test data only and
is not approved for real patient information or a pilot (`README.md`, `MVP_STATUS.md`,
`SECURITY.md`). Nobody has yet run this version of the app by hand on any computer or phone, so
everything this pack says about how the app behaves comes from its code and documents, not from
watching it run; the Android and iPhone versions have never even been started (the iPhone build is
made only for Apple's simulator, a stand-in for a phone that runs on a Mac). The test builds are not
signed by the publisher (see section 4). There has been no independent security or privacy review
yet. This pack is meant to help start one.

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

| What             | Examples                                                                                                                                                                                                   | Kept encrypted?                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Documents        | The PDF files the patient adds, photos taken with the camera in myCarlos (on a computer or a phone), and PDFs shared to myCarlos from another app (kept in "Shared with me" until the patient moves each to a person), including documents the patient has **hidden** | Yes, each with its own key        |
| Document details | Name (the patient can rename it), size, date added, the label "Manual import — unverified", which folder it is in                                                                                          | Yes                               |
| Profiles         | A display name for each person the patient keeps records for                                                                                                                                               | Yes                               |
| Folders          | Folder names and how they nest                                                                                                                                                                             | Yes                               |
| Passphrase       | Never stored. The vault's key is stored locked with a key worked out from the passphrase each time it is typed                                                                                             | The vault's key is locked with it |
| Recovery key     | Never stored in the vault. The vault's key is stored locked with the recovery key, with a random id and the date it was set up                                                                             | The vault's key is locked with it |

**Nothing is deleted** (#71, decided 16 October). A document the patient no longer wants to see
is hidden: it leaves every view but the **Hidden** list, and stays in the vault, encrypted, with
its name and details, until the patient restores it. This holds even for a document about someone
else sent by mistake. A document whose encrypted file went missing is hidden in the same way, as
damaged. The app tells the patient this in Security, under "What myCarlos keeps". Hidden
documents are in every backup, like the rest.

**A history is kept** (#71's second part). The vault records, encrypted with everything else,
when it was opened (and with which secret), and each document added, renamed (both names),
moved (the folders' names then), hidden, restored, or saved outside the vault as a readable copy,
with where it was saved (a file path, or a document provider's address on Android), and when
backups were saved, and where. It also records when the passphrase was changed (never the
passphrase itself), each patient profile added (its name), and each folder made, renamed or moved
(its names then). It keeps the names as they were at each moment, so a document
renamed or hidden can still be read off the history. Security now offers a verified read-only
view while the vault is unlocked. Native code sends display names, folder labels, times, methods,
session notes and saved locations over local main-window IPC only for entries it has
authenticated and linked from the start of the manifest-pinned chain, or back from its pinned end.
If a piece is damaged or the chain is cut short, Security shows the entries those ends prove with
a notice that the events between can't be checked; damaged pieces are never opened or shown
(D129, D146). Record/profile/folder
identifiers, chain hashes, wrapped keys and object paths stay native. Folder labels do not
establish complete paths or unrecorded historical person attribution; saved locations can be
shortened. Locking conceals
the view while native confirmation is pending and late results cannot restore it. The app never
changes or removes an entry. It is in every backup. The app tells the patient this in Security,
under "What myCarlos keeps". There is no separate history-file export outside the vault:
Ben chose (19 October) to keep it on the device only, tamper-evident.

**Nothing erases a vault either** (#71's third part). Starting again ("Set vault aside", under
"Forgot your passphrase?" on the unlock screen; Security no longer offers it) and restoring a backup over a vault both
set the vault aside: it moves, whole and still encrypted, into a `set-aside` folder next to it,
with its documents, names, history and keys, and its passphrase or recovery key still opens it. The
app cannot open it again yet, and never deletes it: storage grows with each one. On a computer,
freeing the space, or making sure it is gone, means deleting its folder by hand; the confirmation
dialog names the folder. On Android and iPhone the folder is private to the app: the
only way to remove a vault set aside is to clear myCarlos's data, or uninstall it, which removes
every vault on the device, the one in use too. This matters when someone else knows the old
passphrase and can reach the device: a new vault does not shut them out of the old one until it
is removed, and on a phone that means losing the new vault as well. This phone limit is accepted
(decided 19 October), and for the same reason Security no longer offers starting again as a way to
shut someone out. The unlock screen says what is kept; the native confirmation says who can still
open it and how to remove it on that platform.

Adding a document copies it into the vault. **The original file stays where it was** (for example
in a Downloads folder or an email app), unencrypted; the app does not remove it or remind the
patient that it is there.

A **file shared to myCarlos** (or opened with it) is encrypted into the vault as soon as the vault
is open, into "Shared with me", which belongs to no one until the patient moves the file to a
person. While the vault is locked, the shared file is only remembered (where it is, not what is in
it), and the lock screen shows how many are waiting, never their names; if myCarlos closes first,
it is forgotten. The app that shared it keeps its own copy.

A **PDF locked with a password** (as CARLOS sends documents) is stored as it came. When the
patient unlocks it with the document password from their patient portal, an unlocked copy is
encrypted into the vault beside it, and the locked original is kept, renamed "… (locked
original).pdf"; the patient can delete either. The password is used once, by a separate helper
process with no vault keys, and is never stored, shown again or logged.

A **photo taken in myCarlos** has no original: it goes from the camera to the app's memory and is
encrypted into the vault, and is never saved anywhere else. It carries no place, camera or other
details: the app makes the JPEG itself, and the vault removes any such details again before
encrypting it. Its name gives the date and time it was taken, and it is labelled like any added
document ("Manual import — unverified"). The camera is turned on only after the patient chooses to
use it, never records sound, and turns off as soon as the photo is taken or the camera window
closes. On a phone, the phone itself asks once whether myCarlos may use the camera; the app says
so before it asks, and never opens the phone's own camera app, so no photo reaches the phone's
Photos or Gallery app.

A few things are **readable without the passphrase** to anyone who can get at the vault's folder
or a backup file:

- that a vault exists, and its random id;
- the settings for turning the passphrase into a key: a random value (a "salt", which stops one
  round of guessing from working on many vaults at once) and how much work each guess costs;
- the random id of the recovery key and the date it was set up;
- how many documents there are, and the exact size of each (not their names or contents), so a
  document someone else also has, for example a standard form, could be recognised by its size;
- in the vault's folder on the device, the file dates, which show when documents were added and
  when the vault last changed;
- a counter in the vault's header, readable in the vault and in a backup, that shows roughly how
  often the passphrase or recovery key has changed; a backup also shows a second counter, of
  roughly how many changes of any kind have been made;
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
  older backups: the file name the patient saved the new backup under, when, and its size;
- on a computer, the text size chosen for the app (`mycarlos.zoom.v1`). A large size kept on a
  shared computer could suggest that someone who uses it has poor sight;
- the appearance choice, System, Light or Dark (`mycarlos.appearance.v1`). This preference
  names no vault, patient or document and is not copied into an encrypted backup.

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
  are not signed by the publisher (the Mac build carries only a placeholder signature, and the
  Android build a test one).
- **One passphrase opens every profile.** Profiles only sort documents; they are not private from
  each other. On a shared family device, anyone who knows the passphrase sees every profile,
  including a child's or another adult's. A profile also does not show, and the app does not
  check, that the patient is allowed to hold that person's records.
- **On screen** are the names of documents, folders and profiles (there is no document viewer). When
  the window is minimised, or on a phone when the app goes to the background, myCarlos hides its
  content at once, and locks as soon as any import, save or backup under way has finished.
  Switching to another window on a computer without minimising leaves the list on screen until
  the automatic lock. While a file window, or the system window confirming a new recovery key,
  that myCarlos opened is showing, the automatic lock waits, for up to 15 more minutes, and on a
  computer the list stays visible behind that window. Minimising the window, or on a phone going
  to the background, with such a window open hides and locks when it closes, or at the automatic
  lock if that comes first. The app does not block screenshots (a recorded product decision,
  `PRODUCT_DECISIONS.md`: blocking works differently on each system).
- The app **cannot protect** records on a device whose operating system is already compromised
  (for example, by malware that records the screen or the keyboard).
- **No record of use.** The app keeps no record of who opened the vault or what they looked at.
  Apart from the traces listed in section 2 (and, once the change under review lands, the count of
  wrong tries), it records nothing about use. The planned AI helper adds its text exports and saved
  answers to those traces (section 11).

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
readable copies already saved. What a save cut off part way (for example by the app being stopped)
leaves depends on the system:

- On a computer, part of the readable copy is left in a `.mycarlos-export-…` folder beside the
  chosen place (hidden on macOS and Linux, visible on Windows) until the app next starts and
  removes it. If that place's drive is not connected then, it is removed only once the drive is
  back. In two rare cases it is never removed: when the save could not be recorded first (for
  example because the disk is full), and for folders left by earlier test builds.
- On Android, the copy is written straight to the place chosen, so a failed save can leave part of
  a readable copy there. The app tells the patient to delete it, but if the app is stopped during
  the save, nothing removes it.
- On iPhone, and on Macs where the app runs in Apple's app sandbox (as App Store apps do), it has
  not been confirmed that the app may create that folder; if it may not, saving a readable copy
  fails there.

## 7. What leaves the device

**The app itself sends nothing.** It:

- makes no network connections: its own code makes none, and its security settings let its
  screens talk only to the app itself;
- has no analytics, telemetry or crash reporting;
- has no automatic updates yet (updates are planned through app stores and a signed desktop
  updater);
- sends nothing to CARLOS, a clinic or the developers.

The framework the app is built on includes a network library, used only to reload the screens while
a developer works on the phone versions; an installed app loads its screens from inside itself.

**Outside the app's own code:**

- **Files the patient picks.** To add a document, save a readable copy or a backup, or restore
  one, the patient picks a place in the system's own file window. If that place is a cloud drive
  (for example iCloud Drive, Google Drive or OneDrive), the system or that drive's app moves the
  file over the network, not myCarlos: a readable copy then goes to that service unencrypted, and
  a backup encrypted.
- Apple device backups can carry the encrypted vault to iCloud (section 3).
- The Windows installer may, without asking, download WebView2 (the Microsoft component that
  draws the app's screens) if the computer lacks it (open question 9).
- Parts of the system the app does not control have not been checked: for example the operating
  system's own crash reports, WebView2's own updates, crash dumps and diagnostics, and print
  services.

What the patient saves themselves (backups, recovery kits, readable copies) leaves the vault only
where the patient puts it.

**The planned AI helper (#72, section 11) does not change this.** It sends nothing. Its text export
is a file the patient saves, like a readable copy.

## 8. How it is protected

- A random key for the vault, and a separate key for each document.
- The passphrase is turned into a key with Argon2id (a method that makes each guess slow and use a
  lot of memory); documents are encrypted with XChaCha20-Poly1305. Both are well-regarded, widely
  used methods; how myCarlos uses them has not been independently reviewed.
- Passphrases must be at least 15 characters, and a check on the device refuses ones that are easy
  to guess (see section 5 for how strong that makes them).
- The app locks after 1 to 15 minutes without use (5 by default); a file window, or the system
  window confirming a new recovery key, that it opened extends that by up to 15 more minutes. When
  its window is minimised or, on a phone, when it goes to the background, it hides its content at
  once and locks as soon as any import, save or backup under way has finished (see section 4 for the
  details).
- Erasing the vault, restoring a backup over it and replacing the recovery key each need a second
  confirmation in a window drawn by the operating system rather than by the app's own screens,
  which makes it harder for a fault in those screens to skip it. Setting up the first recovery
  key, changing the passphrase and deleting documents do not have this second confirmation.
- Only one copy of the app can have the vault open at a time.

## 9. Known limits

These are stated in the repository's own documents (`THREAT_MODEL.md`, `VAULT_FORMAT.md`,
`MVP_STATUS.md`, `SECURITY_OPERATIONS.md`, `PRODUCT_DECISIONS.md`, `TESTING.md`, `WINDOWS.md`):
- **No document can be deleted** (#71). A patient who wants something gone from the device can
  only hide it; it stays in the vault and in its backups, and the vault grows with what is
  hidden. The history keeps each document's names, and where copies were saved, for good. A vault
  set aside (when starting again, or restoring over it) stays on the device until its folder is
  deleted by hand.
- **An old passphrase can still work.** Changing the passphrase, or replacing the recovery key,
  does not shut out someone who knows the old one and has a copy of the vault from before the
  change (a device backup, a copied folder, a backup file). The vault's own key never changes: the
  old passphrase opens the old copy, which gives up the vault's key, and that key also opens the
  vault as it is now, if they can get at it too. The only remedy today is a new vault. Changing
  the vault's key is not built; a change still under review records it as planned after the first
  release.
- **Lost or stolen device.** There is no remote lock or wipe. What protects the vault is the
  device's own lock, the app's automatic lock (up to 15 minutes after last use, or up to 15 more
  while a file window it opened is showing) and the passphrase.
- **Uninstalling.** On a computer, removing the app leaves the vault's encrypted files in place,
  vaults set aside included, and some app files, such as the lock-delay setting; the app's
  instructions say to delete the vault's folder by hand. On
  Android and iPhone, removing the app removes the vault too (as the platforms' guides say; not
  yet seen on a device).
- **Rolling back the vault's files from outside the app** (for example restoring older copies of
  them with a file-restore tool) is not detected.
- **Deletion** is not carried into backups, readable copies or device snapshots, and the app cannot
  promise that deleted data is gone from the storage media. The message before deleting a document
  mentions readable copies and the clinic's record, but not backups.
- **Restoring an older backup** brings back the documents deleted since, and the passphrase and
  recovery key the backup was made with. The screen and the system window say so before the
  patient agrees.
- **A kit and backups kept together.** A recovery kit is a plain-text key. A kit and backups in the
  same cloud account (or a kit in iCloud and an iCloud device backup) together open everything,
  for whoever gets into that account.
- **Originals.** The file a document was added from stays where it was (section 2).
- **PDF safety.** There is no viewer, safe or otherwise: documents are read in other apps. A
  planned viewer with no access to the vault or the network is not built.
- **Photos in memory.** While a photo is taken or shown, the app's display engine holds copies of
  it that the app cannot overwrite; it overwrites its own copy and lets go of the rest when the
  camera or photo window closes, and the engine frees them later. A photo is shown by the app's
  own display engine, not by a separate viewer.
- **Phones.** Taking photos on Android and iPhone is written but has not yet been tried on a
  phone (see MVP_STATUS); document scanning on phones and tablets comes later.
- **Guessing on the device.** A wait after repeated wrong passphrases or recovery keys is being
  added in a change still under review (none for the first five, then a little longer each time,
  up to a minute). It slows guessing only through the app on the device, not against a copied
  vault or backup, and whoever can change or delete the file where the app counts wrong tries, or
  set the device clock forward, can undo it.
- **Not yet checked:** system logs, crash files, the app-switcher preview images, "recent files"
  lists, memory the system writes to disk, notifications, the clipboard (including clipboards that
  sync between devices, such as Windows' cloud clipboard and Apple's Universal Clipboard) and
  operating system backups have not been checked for leaked information. Nobody has run this
  version by hand, and the Android and iPhone versions have never been started.

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
8. **Backups and kits in cloud drives:** backups are encrypted, but a patient may save them, and
   the recovery kit, to a cloud service, and the two together open everything (section 9). Is
   advice about where to keep them needed?
9. **Windows installer:** it can download Microsoft's WebView2 component during installation,
   without asking, if the computer lacks it. Is that acceptable, or should the installer carry it?
10. **Device backups on Apple devices:** these carry the encrypted vault by design. Should that
    change?
11. **Screenshots:** the app allows them, as a recorded product decision. Is that acceptable?
12. **Retention:** how long should backups and deleted documents be kept, if any rule applies?
13. **The planned link with CARLOS:** consent, and what the clinic's systems would see (for example
    who sent what to whom, and when), will need their own assessment when it is designed.
14. **The AI helper's text export (section 11):** the patient may give an anonymized text to any AI
    service. Is the notice enough, given that removing details is never perfect and that the
    service's own terms then apply? Should the app suggest services that keep no data, or say
    nothing about which to use?
15. **Medical-device rules:** does a tool that explains a patient's own documents, is not asked to
    diagnose or advise (though an AI can still write such text), and labels every answer "may be
    wrong", stay outside the rules for software as a medical device (#25)?
16. **Other people's documents:** the helper can be used on documents in a child's or another
    adult's profile. Is more guidance needed before their text is exported (see also question 4)?
17. **Keeping AI answers:** answers are kept with their document, encrypted, and are only hidden
    with it, never deleted (#71). Is that acceptable, or should the patient be able to remove an
    answer they do not want?
18. **Shifted dates:** all dates move back by the same random number of days, which keeps the gaps
    between them. A reader who knows one real date (a birth, or an event named in the text) can
    work out the rest. A new number is drawn for each export, so a service given several exports of
    one document could narrow down the real dates; one fixed number per document, worked out from a
    vault key and never stored, would stop that, but then one known date gives away every export of
    that document. Which is better, and is shifting acceptable at all, or should dates be removed?
19. **How the model reaches the device:** #72 has the patient download the model. To keep
    myCarlos from making any network connection, the design proposes that the patient adds the
    file instead (`THREAT_MODEL.md` D-10). Either way the download site sees the device's address
    and when; if myCarlos downloads it, myCarlos also connects to a second host, and the site learns
    that the device runs myCarlos. Which should it be?
20. **Turning the export on:** #72 asked for a Settings switch that turns the cloud way on. The
    design has none: each export is chosen for one document, after a preview and a save dialog.
    Is that enough, or should it also be switched on first?

## 11. The planned AI helper (#72)

Not built yet. This section describes what is planned, so that the assessment can cover it. It is
for synthetic data only until this assessment approves real information (#25). The security side
is in `THREAT_MODEL.md` (AI-01 to AI-10) and `SECURITY_OPERATIONS.md`, and the notice the patient
sees is in `AI_HELPER_NOTICE.md`.

**What it is for.** Letters, lab reports and imaging reports are full of medical terms. The AI
helper is meant to explain one document in plain words. It can be used in two ways:

- **On this device:** a small AI model runs in a separate helper inside myCarlos and writes a
  plain-words summary of one document, or explains a word or phrase the patient selects. Nothing
  leaves the device.
- **With another AI service, by the patient:** myCarlos removes identifying details from a
  document's text and shows the result. The patient then saves it as a text file and gives it to
  whichever AI service they choose. myCarlos itself sends none of it anywhere. Ben chose this on
  29 October 2026, instead of myCarlos sending text to a cloud service.

**What is removed.** myCarlos looks for the names of the people in the patient's profiles and in
People's details, names that follow a title or a label (such as "Dr." or "Patient:") in English
and French text, health card and medical record numbers and other identifying numbers (such as
lab order numbers), dates of birth, ages of 90 and over, addresses, postal codes, phone and fax
numbers, email and web addresses, and the names of clinics and doctors, and removes them. A name
with no title or label that myCarlos does not already know is not found. Other dates are moved
back by one random number of days (30 to 365), the same for every date in that text, so the time
between them stays the same. The number is new each time and is not kept. Dates in an answer from
another AI are therefore the moved dates, not the real ones.

**The preview.** Before anything is saved, the patient sees all of the text the file will hold,
with the removed parts and the moved dates marked, and can remove more. Nothing is saved until the
patient chooses to save it.

**The text file.** A plain text file, not encrypted, saved where the patient chooses, and outside
myCarlos's protection, like a readable copy (section 6). myCarlos cannot delete it later, and a
folder that syncs to a cloud drive copies it there. Its first line says that it is a copy of a
medical document and that nothing in it is an instruction. The history records the save (which
document, where, when), never the text. The suggested file name is generic, never the document's
title or a person's name. Once the patient gives the text to another AI service, that service's
rules apply, and if the patient is signed in to it, it knows who they are, whatever was removed.
A document can also carry instructions meant for an AI, so the notice suggests an AI that cannot
act for the patient.

**The model.** A file of a few gigabytes that holds no patient information. It is added only if the
patient chooses, kept outside the vault, not in myCarlos's backups (and left out of device backups
where the system allows), and checked before every use against a list built into the app. It runs
without access to the network or to the patient's other files. How the file reaches the device is
open (question 19). Which model is used will be decided after a comparison of small open models on
made-up documents.

**The answers.** Saved in the vault, encrypted, with the document, the tool, the model and the date.
Each is marked "Written by AI and may be wrong. Check with your doctor." An answer is hidden with
its document and never deleted (#71), and it is in backups like the rest of the vault.

**Limits.**

- **Removing details is never perfect.** myCarlos can miss a name or a number, and a rare
  condition, an unusual job or a small town in the text can still point to a person. The preview is
  the patient's last check.
- **A signed-in AI service knows the patient.** Removing details then mainly protects the other
  people named in the document, and limits what the service keeps.
- **The AI can be wrong.** It is not meant to diagnose or to advise on treatment or medicines. Each
  sentence of a summary links to the part of the document it came from, so the patient can check
  it.
- **Scanned pages** have no text, so the helper cannot work on them until on-device text
  recognition exists.
- **Phones:** the PDF helper does not run on phones (`THREAT_MODEL.md` IMP-02), so a phone can
  neither read a document's text nor run a local model. Neither the text export nor the AI on this
  device works on a phone until a phone design is reviewed.
- **Speed:** on an ordinary computer, a long document may take a minute or more.

**What the patient is told.** The notice in `AI_HELPER_NOTICE.md`, in all seven languages, before
the first use and at any time from Security.

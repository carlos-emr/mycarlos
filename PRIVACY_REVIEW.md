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

Until the patient links a clinic's portal it is **not connected to anything**: not to CARLOS (the
clinic's electronic medical record), not to a clinic portal, not to any server. Once a patient links
a clinic, it contacts that clinic's portal and only that (section 7, "The clinic portal"). It has no accounts, no sign-in and no
analytics. The planned link with CARLOS (a clinic sends an encrypted document, and the patient
adds it to myCarlos) is not built.

## 2. What information it holds

Everything the patient puts into myCarlos is kept in one encrypted "vault" on the device.

| What             | Examples                                                                                                                                                                                                   | Kept encrypted?                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Documents        | The PDF files the patient adds, photos taken with the camera in myCarlos (on a computer or a phone), and PDFs shared to myCarlos from another app (kept in "Shared with me" until the patient moves each to a person), including documents the patient has **hidden** | Yes, each with its own key        |
| Document details | Name (the patient can rename it), size, date added, the stored label "Manual import — unverified" (stored unchanged; the app shows it as the status "Unverified", then "Manual import", or, when the vault has checked a clinic's signature, as "Verified", then "From {clinic}"), which folder it is in | Yes                               |
| AI answers       | What the AI helper wrote about a document on this device (#72): a plain-words summary or a term explained, with the tool, language, model and date. Kept encrypted with the document. Asking again shows the new answer and hides the older one, which stays in the vault, never deleted (#71, D3); nothing leaves the device | Yes                               |
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
with where it was saved (a file path, or a document provider's address on Android), each AI answer
kept with a document (the document's name and the tool, never the answer's text, #72), and when
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
use it, never records sound for a photo, and turns off as soon as the photo is taken or the camera
window closes. On a phone, the phone itself asks once whether myCarlos may use the camera; the app says
so before it asks, and never opens the phone's own camera app, so no photo reaches the phone's
Photos or Gallery app.

A **video recorded in myCarlos** (#359) is recorded **with sound**. The camera and the microphone
are turned on only after the patient taps Record video and then chooses to use them, and are asked
for together. On a phone and on a Mac the system asks whether myCarlos may use them, and on Apple
phones and computers its prompt reads: "myCarlos uses the microphone to record sound with your
videos. Videos stay locked in myCarlos." On Windows the system's own microphone setting decides
(Windows raises the camera and the microphone as two requests, and shows no prompt of its own for a
desktop app), and on Linux nothing asks beyond the app's own check, which allows the camera and
microphone for myCarlos's own pages only. Before anything is turned on the dialog says that people
nearby may be heard. A video is encrypted into the vault as it is recorded, a piece at a time, and
never saved anywhere else; it is sent from myCarlos only if the patient chooses to send it. Both
are turned off at Stop, when the recording window closes, when the vault locks and when the app is
hidden, and a badge shows that recording (or a pause) is on for as long as it is. A pause keeps
the camera and microphone on, and says so. About 1 GB of free room is needed to start, the dialog
warns when room runs low, and a recording is saved, or kept to be finished when there is room, and never lost, when the room runs out. If myCarlos
closes or locks during a recording, what was saved is kept: after a lock it is saved and the
patient is told at the next unlock, and after a crash the patient is asked whether to keep it.
Playing a video shows it in the app's own player, from the vault, and nothing is left behind. The
app makes no transcript and no other copy of the sound. It cannot ask the people who are heard:
that is the patient's to do.

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
  names no vault, patient or document and is not copied into an encrypted backup;
- the camera and the microphone the patient chose for a recording (`mycarlos.videoDevices.v1`):
  the webview's opaque device identifiers only (at most a short, checked string each), never a
  device name, a person or a recording. They can tell which hardware this device's user prefers
  and, as the browser derives them, they are specific to this app on this device. Not copied into
  an encrypted backup.

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
  wrong tries), it records nothing about use. The AI helper adds its text exports to those traces (#171),
  and its answers, which are kept (#212; section 11).

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
- **What the file shows to someone without the key** (audit of 26 Nov 2026, read from the source and
  not run on macOS or Windows: `out-of-vault-files-audit-20261126.md`): the number of records and each
  document's exact size; a vault id that is the same in every backup of that vault; the time it was
  saved, to the millisecond; roughly how many changes the vault has had; which videos were left
  out; and, in the suggested file name, the recovery key's short label (which links the backup to
  the kits). No name, title or text. Rounding the time, padding the sizes and leaving the label out
  of the name are not done: today, and an open question (question 21).

## 6. The recovery key, and readable copies

**Recovery key.** A long random key (28 letters and digits) that opens the vault if the patient
forgets the passphrase. It is shown once, when it is made. The patient writes it down, or saves or
prints a "kit": a plain text file or page holding the key, a short label and a date, with no
names. **Anyone who finds the kit can open the vault** with it, so it must be kept like a house
key. Printing sends the key through the computer's print system, which may keep a copy for a
while. The patient can replace the key; the old one then stops opening the vault, but still opens
backups saved before (the app tells the patient what to do about them). The last 2 of the 28
characters are a **check** (10 bits made from the key, a hash with a label that differs for a
recovery key and a hand-over key): a typed-back key whose check does not fit is called a typo
before anything is tried. It is not secret and does not weaken the key (the protection is the
128-bit key). A mistyped key passes the check by chance 1 time in 1,024: it is then tried and
fails, and at unlock that counts as one wrong try. A longer check would be a format change; the
note recommends against it (`key-check-rates-20261126.md`): today, and an open question
(question 22).

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

**Other files the app writes outside the vault** (audit of 26 Nov 2026, from the source:
`out-of-vault-files-audit-20261126.md`). What each shows to someone who has the file but not the
key, today:

- **Recovery kit (`.txt`):** the key itself, by design. Nothing keeps it out of search indexes or
  cloud-synced folders: no code sets an operating-system "not indexed" or "do not sync" mark on
  any file the app writes (#533, in review, sets the "not indexed" mark on Windows for the kit).
- **Single-document export:** the suggested file name is the document's own name, which can be a
  person's, a clinic's or a test's name.
- **Hand-over package (`.mycarlosprofile`):** the number of objects and their exact sizes, whether a
  key or a passphrase protects it (and the passphrase's salt and cost), and the date in the
  name. No time, vault id, person or device.
- **Export stage folder (`.mycarlos-export-<id>`):** shows that myCarlos saved here, and when; it
  stays after a crash until the next start (above). The readable copy and the text export write
  their temporary file inside it. The temporary file carries neither the document's name nor the
  destination's.
- **A kit, a backup or a hand-over package is not in the stage folder.** These three saves write
  through a hidden `.atomicwrite…` folder beside the chosen place. A crash during one leaves that
  folder with a partly written file, and **nothing removes it**: for a kit that is part of the
  key's text; for a backup or a hand-over package, part of an encrypted file. #533 (in review)
  moves those temporary files into the journaled stage, so the next start removes them.
- **De-identified text export:** a fixed, localised name ("Anonymized text.txt"), so it shows the
  app's language, and the text's length.
- **`attempts.json` (the app's own folder, 0600 on Unix):** how many wrong tries of each kind, the
  time of the last one, and how often a count was cleared. No vault id.

On Unix these files are created with mode 0600; on Windows the mode is not set, so they take the
folder's permissions (not verified). Whether to add the marks, change the default names or clear
the stage folders sooner is not decided: today, and an open question (question 21).

## 7. What leaves the device

**The app itself sends nothing.** It:

- makes no network connections until the patient links a clinic or clicks the AI helper's model
  download (#219): its security settings let its screens talk only to the app itself, and its own
  code reaches only the portal the patient linked (see "The clinic portal" below) and, on the
  patient's click, the one public model file;
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

**The AI helper (#72, section 11) sends nothing about the patient.** Its one connection is the
model download (#219), only when the patient clicks it: the download site sees the
computer's IP address, the time and which public file was fetched, and nothing else is sent
(`SECURITY_OPERATIONS.md`). Its text export is a file the patient saves, like a readable copy.

**The clinic portal (after the patient links a clinic: computers, iPhone and, from the Android
connection pieces #493, #478 and #503, Android; *requires #478, merged before this piece*).** The
lines above describe an app that is not linked. When a patient links a clinic the app contacts that clinic's portal and only it (NET-01):
the address the patient typed or scanned, over HTTPS (clear text is refused on every platform), with
the device's own certificate trust. On Android that is the phone's system authorities only: an
authority a person, a piece of malware or a device manager installed is not trusted (NET-06), and a debug
build trusts one more, a FAKE test authority that exists only in debug builds, which is a property
of test builds and not of a build for patients. The portal and anyone watching the network learn
what any such request shows, the IP address the phone is reached from and the time, plus the fields
the app sends: the opaque ids and the per-link device key id listed in `SECURITY_OPERATIONS.md`
("Portal pickup", NET-03), signed by the link's device key. Documents arrive sealed to the device and
are opened only inside the vault. On Android there is no background checker yet: the app contacts
the portal when the patient asks (links a clinic, or checks for documents), and once after unlocking
when a notice is owed; a request still running when the app goes to the background or the vault locks is
dropped (NET-08). **Not yet verified on a phone:** a real connection from an Android phone has not
been run (TESTING.md, "Linking a clinic on Android").

**Tray notices (built in #230, after the tray #206; Portal contract merged in carlos-portal#88).**
With the tray, closing the window locks the vault. While unlocked and tray notices are wanted (tray mode and notices both on: at link time, at unlock, or when a switch turns on), the device
registers a separate waiting key's id, public key and algorithm with that portal, in a request
signed by the link's device key. To still tell the patient that a clinic has sent something, the
locked app may then ask each linked portal "is anything waiting?" with its waiting key. Each check's
body contains only the key's id. Its signed header also carries the audience, issuer, key id,
one-time nonce, times and request hash listed in `SECURITY_OPERATIONS.md` ("Tray notices").
The answer is yes or no. The patient sees a generic notice
("A new document is waiting. Unlock myCarlos to see it."), with no clinic, document, name or count.

To work while the vault is locked, the waiting keys and the linked portals' addresses are kept
**outside the vault**: in a sealed file beside the settings, whose key is in the OS credential
store of the patient's OS account (Ben accepted this on 5 November 2026). Anyone who can run as
that OS account can therefore learn the stored portal addresses (and so associated clinics),
count the populated waiting-key slots, and ask whether something is waiting at each. They cannot
read or pick up documents with a waiting key. The fixed-size sealed file has 16 slots; its size
does not reveal how many are populated. The keys are wiped locally on unlink,
when the notices or the tray are turned off, and on vault reset; they are not in myCarlos portable
backups. Portal revocation may wait while the device is offline, as explained in the operations
guide. Where the app has no supported OS credential-store adapter, there are no tray notices.
The Windows adapter is described in #270; Linux and macOS adapters remain future work. Details:
`VAULT_FORMAT.md` ("Settings kept outside the vault"), `SECURITY_OPERATIONS.md` ("Tray notices").

**What a clinic portal receives (audit of 26 Nov 2026, from the source; no traffic was captured:
`portal-send-audit-20261126.md`).** One HTTPS client makes every request to a portal (HTTPS only,
no redirect, retry, proxy or referrer; the only other client is the AI model download, a plain GET
to the model host). Each request carries a `Content-Type` and one signed
assertion header, and nothing else: **no User-Agent**, `Authorization`, cookie or `Accept-Encoding`
(a test pins this: #532, in review). No error report is sent back anywhere. The bodies hold keys, random ids,
hashes and times: the link request (the one-use code, split into two fields: its first 8 characters
as the link id and the rest as the code; the two public keys; the device's name),
the approval request and its 6-digit clinic code (the check digits never leave), delivery
receipts (the document's and the sealed copy's SHA-256, the pick-up time), the push destination's
random id (**no** Apple or Google token), and the waiting key. **No person's name, document title,
file name, recovery key, hand-over key or passphrase is sent.** Three things are worth knowing:

- **The device name is free text** the patient types ("Name for this device", at most 64
  characters), sent to the clinic being linked and kept by its portal. A patient could type a
  person's name. The link form's help line asks for a device name, not a person's (#532, in
  review): today, and an open question whether more is needed.
- The portal learns **when** a document was picked up, its **hashes**, when the device is online and
  its IP address, as any HTTPS server does. This is the delivery protocol's own evidence.
- `vault_head_link` is an HMAC of the vault's history head under a key from the device key: the
  portal can see **that** the vault changed between two requests, never what changed.

**What an operating-system notice says.** Every text the app can post to the operating system (the
arrival notice, the test notice, the tray's menu, tooltip and waiting notice, and the Windows toast
the tray poller makes) is **one fixed sentence from the app's own message catalogue**, never a
person's name, a document title, a clinic name or a file name; guard tests pin the catalogue, every
place that hands text to the system, and the tray's call sites (#525, in review). The Windows
toast's first line is the constant "myCarlos" (the Linux and macOS notices, #488 and #495, in
review, do the same with their title or summary line, and will need the same guard tests when they
merge). On an iPhone (the notice stack in #479 and #480, in
review) the push carries only a message key, and the phone looks the sentence up in **its own
system language**: a patient who set myCarlos to French on an English phone gets the English
sentence. That is today, and an open question (question 24).

## 8. How it is protected

- A random key for the vault, and a separate key for each document.
- The passphrase is turned into a key with Argon2id (a method that makes each guess slow and use a
  lot of memory); documents are encrypted with XChaCha20-Poly1305. Both are well-regarded, widely
  used methods; how myCarlos uses them has not been independently reviewed.
- Passphrases must be at least 15 characters, and a check on the device refuses ones that are easy
  to guess (see section 5 for how strong that makes them).
- The app locks after 1 to 15 minutes without use (5 by default); a file window, or the system
  window confirming a new recovery key, that it opened extends that by up to 15 more minutes, and
  an AI answer being written by the time it takes, up to that answer's own limit (5 to 20
  minutes; 20 at most while the AI helper starts). When
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
  while a file window it opened is showing, or, while an AI answer is written, up to its limit of
  at most 20 minutes plus the AI helper's start) and the passphrase.
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
- **A copied de-identified text stays on the clipboard after the vault locks.** The AI helper's
  "Copy text" puts the approved text on the system clipboard, with a warning that a copy can stay on
  the device (Windows clipboard history, clipboard sync) and that the app cannot take it back.
  Nothing clears it when the vault locks or after a while, unlike a copied hand-over key, which the
  app takes off the clipboard after a minute or when the dialog ends. The remover has run on that text, but removing details is never perfect
  (THREAT_MODEL.md, AI-01), and it is still health text. Whether to clear it after a while is
  today, and an open question (question 23).
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
17. **Keeping AI answers:** answers are kept with their document, encrypted (#212). A
    newer answer for the same document, tool and language (and term, for Explain) is shown in place
    of the older one, and the older one is kept hidden, never deleted, like the documents (#71;
    decided 5 November 2026). Each document keeps up to 32 shown answers and 96 hidden older ones (#250); past either, a new answer is still shown, but not kept, and the reader says so. Should the patient be able to remove an answer
    they do not want?
18. **Dates replaced by marks:** no real date is sent. Each date is a numbered mark with its gap in
    days from the earliest date, so the time between dates stays clear. A reader who knows one real
    date (a birth, or an event named in the text) can still work out all the others from the
    gaps, and the same document gives the same marks and gaps every time it is exported (there is
    no random number to differ between exports). A very old date also makes every gap large. Is
    that acceptable, or should the gaps be left out, or only some dates be given a gap? And a year
    on its own with no cue word ("Appendectomy 2019", "(2019)") is not removed, because treating
    every 19xx or 20xx as a date would also hit "2019 tablets": together with the gaps, one dated
    event a reader knows can anchor every mark. Should a bare year be treated as a date, accepting
    that cost, or left as it is and named in the notice, as now?
19. **How the model reaches the device:** both ways, in #219 (on main; `THREAT_MODEL.md` D-10,
    AI-08). **Download the default model** fetches one public file, at a fixed version, from
    huggingface.co and its CDN, only on a click; nothing about the patient is sent, and the notice
    and Preferences say so. The site sees the computer's IP address, the time and which file, which
    suggests that the computer runs myCarlos. **Add a model file…** keeps a way with no connection.
    Open for the assessment: is that disclosure to the download site acceptable, or should the
    project host the file itself?
20. **Turning the export on:** #72 asked for a Settings switch that turns the cloud way on. The
    design has none: each export is chosen for one document, after a preview and a save dialog.
    Is that enough, or should it also be switched on first?
21. **Files outside the vault (section 6) and the backup's trailer (section 5):** should the app
    round a backup's save time to the day, drop the key's label from its suggested name, mark the
    recovery kit "not indexed" (Windows) and warn against synced folders, suggest a neutral name
    for a single-document export, and clear leftover stage folders sooner? Padding object sizes is
    a format change that the audit's author would not make. Not decided.
22. **The 10-bit check on recovery and hand-over keys (section 6):** a mistyped key passes it 1 time
    in 1,024. Lengthening it would be a format change for printed kits already handed out; the
    note recommends no change and a gentler message when a hand-over box gets a recovery key. Not
    decided.
23. **The clipboard (section 9):** should "Copy text" of a de-identified text be cleared after a
    while, or when the vault locks, as a copied hand-over key is?
24. **Notice language on an iPhone (section 7):** the phone shows the notice in its own system
    language, not the one set in myCarlos. Acceptable, or should the app ask for a
    language-matched sentence?
25. **Sending to a cloud AI with the patient's own key (#72, proposed, not built; section 11.1):** may a
    patient's own API key, a de-identified text, and a native confirmation for each send be the cloud
    way for the pilot? What processing locations are acceptable for each supported provider? Who writes
    the notice in seven languages, and who checks each provider's terms? This gates real data (#25).

### Reading a stored PDF on Android (#358)

On Android the document is read in a separate native window. The letter is decrypted only into the
app's memory and an anonymous in-memory file that no other app can open; nothing is written to the
app's storage or to shared storage. Screenshots and the recent-apps picture are allowed, as everywhere
else in the app (owner decision, 20 Nov 2026: the patient's choice). Android's backup is
already off. The reader closes when the app goes to the background, when the vault locks, and when
the person closes it. Pages are shown as pictures, so a screen reader cannot read the letter's text
there; this is a stated gap, not a privacy trade.

## 11. The AI helper (#72)

The text export (part B) is built on main (#171) and works on computers only; it is hidden on
phones. The reader's Summary and Explain (#217), the model runtime (#218) and the model
download (#219) and kept answers (#212) are on main. This section describes all of it, so that the assessment
can cover them. It is for synthetic data only until this assessment approves real information (#25). The security side
is in `THREAT_MODEL.md` (AI-01 to AI-10) and `SECURITY_OPERATIONS.md`, and the notice the patient
sees is in `AI_HELPER_NOTICE.md`.

**What it is for.** Letters, lab reports and imaging reports are full of medical terms. The AI
helper is meant to explain one document in plain words. It can be used in two ways:

- **On this device:** a small AI model runs in a separate helper inside myCarlos and writes a
  plain-words summary of one document. Explaining a word or phrase the patient selects is switched
  off in the UI for now (THREAT_MODEL AI-05). Nothing about the patient leaves the device.
- **With another AI service, by the patient:** myCarlos removes identifying details from a
  document's text and shows the result. The patient then saves it as a text file and gives it to
  whichever AI service they choose. myCarlos itself sends none of it anywhere. Ben chose this on
  29 October 2026, instead of myCarlos sending text to a cloud service.

**What is removed.** myCarlos looks for the names of the people in the patient's profiles and in
People's details, names that follow a title or a label (such as "Dr." or "Patient:") in English
and French text, health card and medical record numbers (after any of 24 labels) and other identifying numbers
(such as lab order numbers), social insurance numbers (SIN, NAS) written with points, spaces or
hyphens, dates of birth, ages of 90 and over, addresses, postal codes, phone and fax
numbers, email and web addresses, and the names of clinics and doctors, and removes them. A name
with no title or label that myCarlos does not already know is not found. No date that myCarlos recognises is sent (written in English or French, in the common forms:
ISO dates and timestamps, ordinals, day-month-year with hyphens, slashes or full stops, eight
digits such as 20261008, a day and month with no year, and a range of days). Each such date is
replaced by a numbered mark in calendar order, such as "DATE 2, 14 days after DATE 1": the same
real date always has the same number, and the note says how far it falls after the earliest date,
so the time between dates stays clear without the dates. A numeric date that could be read two
ways (03/04/2025), a month and year and a year alone get a plain numbered mark with no gap. An age
of 90 or over becomes a numbered mark that says "90+". A date it does not recognise (for
example one written in Spanish, Polish, Portuguese or Chinese) stays as it was, unmarked, and so
does a year on its own, such as the 2019 in "Appendectomy 2019". The notice says both.

**Putting the details back.** The app can put the details back into an answer that came back
with the placeholders, on the device. After the text is saved, the preview has a box for the
AI's answer: each placeholder written exactly as it was sent becomes what it stood for. A
placeholder-shaped mark that is not one of this export's, or whose note was changed or left out,
is left as written and highlighted, never guessed. Names or dates that shared one placeholder
come back as the first spelling seen. The list of what was replaced is kept in memory while the
vault stays unlocked and the window stays open, and is never saved.

**Who removes them, and how well.** The app's own remover, written in Rust and TypeScript, and
nothing else. Ben decided (D9, 4 November 2026) not to ship Presidio to patients; it may later be an
optional tool on the clinic's side. On 24 synthetic documents (12 English, 12 French) with 36
identifier targets, the remover alone fully removed 28, partly removed 3 and missed 5; with a known
patient identity 20, 3 and 1 of 24; without one 8, 0 and 4 of 12; it damaged 2 of 64 clinical
targets. The documents were synthetic and not typical, so these counts show where the gaps were and
do not predict real use. The preview is the safety net for what is missed.

**The preview.** Before anything is saved, the patient sees all of the text the file will hold,
with the removed parts and the replaced dates marked, and can remove more. Nothing is saved until
the patient chooses to save it.

**The text file.** A plain text file, not encrypted, saved where the patient chooses, and outside
myCarlos's protection, like a readable copy (section 6). myCarlos cannot delete it later, and a
folder that syncs to a cloud drive copies it there. Its first line says that it is a copy of a
medical document and that nothing in it is an instruction. The history records the save (which
document, where, when), never the text. The suggested file name is generic, never the document's
title or a person's name. Once the patient gives the text to another AI service, that service's
rules apply, and if the patient is signed in to it, it knows who they are, whatever was removed.
A document can also carry instructions meant for an AI, so the notice suggests an AI that cannot
act for the patient.

**The model.** A file of a few gigabytes (3.0 GB for the default, Qwen3.5 4B) that holds no patient
information. The patient chooses how it arrives (#219): **Download the default model** fetches one
public file at a fixed version, or **Add a model file…** takes a copy the patient already has
(question 19). It is kept outside the vault, so it is not in myCarlos's backups (it is not yet left
out of system backups), and it is checked against a list built into the app when it is added and
before every use; a changed file is not used. It runs in a sandboxed helper without access to the
network or to the patient's other files (#218), on Windows and Linux computers with enough memory;
Macs come later (#211). The default model is Qwen3.5 4B (Q4_K_M), chosen on 5 November 2026 after the comparison of small
open models on made-up documents.

**The answers.** Each is marked "Written by AI and may be wrong. Check with your doctor." Answers
are saved in the vault, encrypted, with the document, the tool, the model and the date (#212). A newer
answer for the same document, tool and language (and term) is shown in place of the older one,
which is kept hidden, never deleted (#71; decided 5 November 2026); an answer is hidden with its
document, and answers are in backups like the rest of the vault (question 17). Each document keeps up to 32 shown answers and 96 hidden older ones (#250); past either, a new answer is still shown, but not kept, and the reader says so. The notice says that answers are saved (`resultsBody`).

**Limits.**

- **Removing details is never perfect.** myCarlos can miss a name or a number, and a rare
  condition, an unusual job or a small town in the text can still point to a person. The preview is
  the patient's last check.
- **A signed-in AI service knows the patient.** Removing details then mainly protects the other
  people named in the document, and limits what the service keeps.
- **The AI can be wrong.** It is not meant to diagnose or to advise on treatment or medicines. Each
  sentence of a summary links to the words of the document it quotes, when they are really there;
  one with no valid source is marked "No source found". A link shows where a sentence came from,
  not that it is right.
- **Scanned pages** have no text, so the helper cannot work on them until on-device text
  recognition exists.
- **Phones:** the PDF helper does not run on phones (`THREAT_MODEL.md` IMP-02), so a phone can
  neither read a document's text nor run a local model. Neither the text export nor the AI on this
  device works on a phone until a phone design is reviewed.
- **Macs:** the AI on this device is not offered on a Mac yet (#211); the text export works there.
- **Speed:** a summary may take a few minutes on an ordinary computer. On a 4-core test computer,
  a one- or two-page letter took 2 to 3 minutes (119 to 169 seconds, Qwen3.5 4B), and loading the
  model about 25 seconds more.

**What the patient is told.** The notice in `AI_HELPER_NOTICE.md`, in all seven languages, before
the first use and at any time from Security.

### 11.1 Proposed, not built: sending the text with the patient's own key

For #72's cloud option, the patient may add **their own API key** and send one document's text from
myCarlos to a provider from a fixed allowlist. The 27 November 2026 decision permits the off-by-default
`cloud-ai` Cargo feature in evaluation builds and requires release builds to refuse it. The text-file
option stays. This assessment describes the proposed end-to-end send.

- **What leaves the device:** the text of one document after the remover and the preview, re-checked in
  Rust, with fixed instructions, plus the key (which identifies the patient's account to the provider, so
  the provider knows whose account it is whatever was removed) and the computer's internet address. Nothing
  else: no profile, vault, device or document identifier. **Only after a native confirmation for each
  send** that names the provider, the model, the size and an estimated cost. Consent is required in each
  unlocked session and ends when the vault locks. There is no background send or automatic fallback.
- **The key:** typed once, stored encrypted in the vault, never shown again (only its last four characters),
  removed with one confirmed action, and an administration key is refused. **A backup contains it**, and
  older backups keep it after removal; the dialogs say so and advise a key made for myCarlos with a spending
  limit.
- **What the provider does with the text** (how long it is kept, whether it is used to improve models) is
  decided by the patient's account at the provider; myCarlos cannot see or change it, and the notice makes no
  claim about it. The assessment must verify processing locations and terms for each supported provider.
- **Recorded:** the history keeps the time, provider, model, document and the provider's request id, never
  the text, the answer or the key; the entry is written before the send.
- **Stated limits:** the remover is never perfect; the native side cannot prove the patient read the
  preview; a patient can lose a key to anything that reads what they type; cost is billed by the provider
  and myCarlos only estimates it.
- Synthetic data only until this assessment approves real information (#25). Details: `THREAT_MODEL.md`
  (AI-11, NET-09) and `docs/cloud-ai-send.md`.

# Durable vault format v1

- **Status:** Implemented for synthetic-data development; security review required
- **Identifier:** `ca.carlos.mycarlos`
- **Storage root:** `vault-home/` in Tauri's machine-local application-data directory. On Windows
  that is `%LOCALAPPDATA%`, which neither roams nor can be redirected to a network share. Roaming
  data (`%APPDATA%`) was rejected: a roaming profile copies the vault between machines, where each
  locks its own copy of the lock file, both may write, and the last upload wins file by file; it can
  also restore an older authentic state, undoing a passphrase change or a deletion. On every other
  platform the local and roaming directories are the same. A vault therefore stays on the device it
  was created on, and the create screen says so.
- **Earlier evaluation builds:** they used `<application data>/vault-v1/`, first as the vault itself
  (with `vault-v1.lock` and possibly `vault-v1.reset-pending/` beside it), later as a home holding
  `vault/`. On Windows that directory is under `%APPDATA%`, or `%LOCALAPPDATA%` for the last two
  builds before this layout. None of these is migrated, read, or removed; they held synthetic data
  only and may be deleted by hand. The new home has a different name so that, on macOS and Linux,
  the new layout never places an old vault's files inside it.
- **Storage requirement:** the location must confirm directory writes. On Unix-like platforms,
  creation probes a directory fsync and refuses storage that cannot perform one (some network,
  FUSE, and removable filesystems) with `unsupported_storage`. Windows has no equivalent call, so
  the probe cannot detect such storage there; the local application-data directory is what keeps
  the vault off it.
- **Implemented recovery:** the patient passphrase, and a patient-held recovery key (header
  format 2) with a saved or printed kit, set up when a vault is created. There is no vendor key.
- **Approved patient-pilot recovery:** the recovery key and kit, and a portable encrypted backup;
  all three are implemented (see [Portable encrypted backup](#portable-encrypted-backup))

This records decisions D-01, D-02, D-03, and D-05 from the [threat model's mandatory design
decisions](THREAT_MODEL.md#mandatory-design-decisions) for the current local-only vertical slice.
It is an implementation description, not approval to store PHI.

## Key hierarchy

Vault creation generates a random 256-bit master key. Argon2id derives a wrapping key from the
patient passphrase using a unique 128-bit salt, 64 MiB memory, three iterations, and four lanes.
The passphrase-derived key wraps only the master key with XChaCha20-Poly1305. HKDF-SHA-256 derives
separate manifest, object-key-wrapping, and keyed-fingerprint keys from the master key. Each record
has an independent random 256-bit content key, itself authenticated and wrapped by the object-wrap
key. Changing the passphrase therefore rewraps the master key without rewriting every object.

The parameters and algorithm identifiers are stored in the non-secret header. They need target
device benchmarking and independent cryptographic review before release. Raw keys never cross IPC;
Rust zeroizes passphrase request strings and long-lived secret-key buffers where the libraries make
that practical. The vault's own copies of a passphrase (its normalized form, and the lower-case
form the name check reads) are sized once and wiped. Copies it does not control are not, among them those the
strength estimator makes while it scores a new passphrase, the normalizer's working buffers, and
the request as the IPC layer parsed it. At first setup, the checklist asks for the same judgement (`vault_passphrase_rules`) each time typing pauses, so the estimator's copies, and the IPC layer's copy of each request, are made then too, once per pause, not only at Create.

New and replacement passphrases must contain at least 15 Unicode characters, contain no control
characters, and encode to no more than 1,024 bytes. There are no composition rules. A passphrase is
normalized to Unicode NFC before it reaches the KDF, at creation, unlock, and change alike, so the
same visible text derives the same key whichever composition form a keyboard or input method
produces. A passphrase that contains any word of four or more characters from a profile name is
refused outright, since the estimator matches a name only as a whole and a rearranged or joined
name would otherwise score as strong. Then local zxcvbn analysis rejects scores below three using
its common-password/name/pattern data plus myCarlos and the current profile names as context. No
proposed passphrase leaves the process.
Unlock accepts a passphrase shorter than the current minimum, so a vault whose passphrase was set
under an earlier rule stays openable. Input over 1,024 bytes is refused before normalization; every
other length, composition, and strength rule applies to the normalized form. A production breach corpus and independent threshold review remain patient-pilot work.

### Recovery key (header format 2)

A recovery key is 128 random bits from the OS generator, shown once as 26 Crockford base32
characters plus 2 check characters, in 7 groups of 4 (for example `K7Q2-...`). The check characters
are 10 bits of a SHA-256 hash of the key, so nearly every mistyped key is reported as a typo before
any unwrapping. Typing is forgiving: case, spaces and hyphens are ignored, and I, L and O read as 1,
1 and 0.

The header's optional `recovery` envelope holds a random, non-secret `keyId`, the time the key was
set up, and the master key wrapped with XChaCha20-Poly1305 under
`HKDF-SHA-256(ikm = recovery key, salt = vaultId ‖ keyId, info = "mycarlos/recovery-wrap/v1")`, with
`"mycarlos-recovery-v1:" ‖ vaultId ‖ keyId` as associated data. A 128-bit random key needs no
memory-hard KDF. The envelope does not depend on the header generation: every header write (a
passphrase change, redundancy repair, recovery) copies it forward unchanged, and the header's
integrity tag, which covers it in format 2, binds it to each generation.

Setting up a key is two steps. `begin` takes the current passphrase, as a passphrase change does,
since a recovery key opens the vault for good; it generates the key, keeps it and the
passphrase-derived wrapping key in native memory, and returns the key once for display. This is the
only secret the native side ever sends to the renderer. `confirm` checks the whole key as the
patient types it back, all seven groups (fewer are refused), and only then writes a new pair of
header generations carrying the envelope, replacing any earlier key; it returns the vault as it then
is, from the same session, so that a lock cannot fall between the two. When the vault already has a
key, the command asks in a trusted native dialog before it replaces it, after the typed groups were
found right and before anything is written; cancelled there, nothing changes and the pending key
stays, to be checked again or cancelled. The dialog also says that backups saved before then still
open with the passphrase or recovery key they were saved with, and that myCarlos says what to do
about them. The setup asks first why the key is being replaced: whether its kit or note may have
been lost or seen. If so, the app says to save a new backup and then delete the older ones, and
Security shows the steps, kept in webview storage (a file name, nothing secret) until the patient
closes them: first a new backup (or "I have no older backups"), with it or a copy of it kept
somewhere other than the device; once it is saved, the file written, with its size, by the name the
native side reports (an Android document provider gives none, so it is "the backup you just saved",
with the time it was saved; a later save while the steps are open takes its place), and the older
backups to delete: files whose names start with "myCarlos backup", and any renamed, other than the
new one and its copies, wherever they were saved (a folder, a USB stick, or on a phone the Files app
or a cloud drive; myCarlos does not know where). A backup saved in place of an older one is the new
one. A failed backup leaves the steps where they were. If not, it says that the older backups still
open with the old key, so its kit is to be kept safe (if it is destroyed, they open only with their
passphrase), and says nothing about deleting them. A vault that could not finish writing the key, or
that opens read-only when the next unlock or recovery reports a key stored as a lock fell, cannot
save a backup, so the app says to keep the old ones until it can. The key is then stored only if the
typed groups still match and whether it replaces a key is still what the patient was asked about (a
vault that had none may have gained one, or the reverse), checked as it is stored. A vault's first
key is not asked about, as it replaces nothing. The envelope's id is chosen when the key is made, so
that a kit saved before the check can name it. Cancelling, locking, or changing the passphrase first
writes nothing and forgets the pending key. Wherever a key is typed, case, Crockford's look-alike
letters and anything in it other than a letter or digit (dashes, spaces, other punctuation) do not
matter.

While a key is pending, `recovery_kit_save` writes the kit: a plain-text file holding the key, a
four-character label from the envelope's id (not secret), the UTC date it was saved, and what it is
for, with no patient or document names. The key step shows the label beside the key, and a printed
kit carries it with the date it was printed; the page asks for it with `recovery_key_label`, which
returns only that label. Security shows the label and set-up date of the key the vault has (the
snapshot carries the label, from the header's envelope), so that the patient can tell the kit that
works from any other. The name suggested for its file carries the date and the label, so that a kit
for a new key does not take the place of the kit for the key the vault still has, should the new one
never be set up. It is written natively, only to a file the patient picks. For a filesystem path it
is never inside the vault home, is private to the user on Unix, and replaces a link at the
destination rather than writing through it; a document provider's URI (Android) is written directly,
so a failed write can leave a partial kit there. The kit holds the key in plain text by design, and
says that the key works only once the check is finished: a kit saved for a setup that was then
cancelled, or ended by a lock before the check finished, holds a key that opens nothing. The key
step says so. If a lock, or myCarlos closing, ends a setup after the key was shown and before the
patient saw it finish, the next unlock says how it ended: from when the vault's recovery key was set
up, before and after, it tells a key never stored from one stored just as the lock came (whose reply
the setup never saw). A marker in webview storage carries this over a restart; it holds only that
time, never the key, and creating, erasing or restoring a vault forgets it. Setup is the first thing
a new vault shows: the passphrase just typed authorizes it, and Escape or "Lock vault and finish
later" first asks whether to discard the key on screen; confirming cancels the unfinished key and
locks the vault. A lock ends it all the same (on a phone, switching apps locks), and so does a
failure to make the key. If that happens before the key is stored, the vault has no recovery key and
says so in a banner until one is set up; if the key was stored just as the lock came, the next
unlock says so, as above. Unlocking a vault that has no
recovery key opens the setup as an offer, at most once a day (the hour it was last offered is kept
in the app's settings on the device, and names no vault; offers are 24 to 26 hours apart at the
least), on the step that says what a recovery key is and asks for the passphrase: it says why it is
there and can be left with "Set up later". No key is made or shown until the patient goes on, so
that none is on screen unasked, where someone else may be looking. It is not opened on a vault that
opened read-only, or over anything held for that unlock: the result of a transfer, or how a key
setup that a lock ended had ended.

**Wrong tries.** Unlocking, recovering with the recovery key and opening a backup each count wrong
tries in a row, apart; a passphrase checked while the vault is open (to change it, or to make a
recovery key) is counted with unlocking. A passphrase or recovery key that does not open it counts,
and a key whose check characters are wrong (a typo) does not. After five in a row, the next try
waits 5 seconds, and each further wrong one adds 5 seconds, to a minute at most. A try made during
the wait is refused before any work, with how long is left, and the screen says it is to slow down
anyone guessing and that what was typed was not checked; a refused try adds nothing to the count.
Each try is counted as it starts, under the same lock as the check, so that tries sent together
cannot all pass, and is taken back off, with the time of the wrong try before it unless another try
has counted since, if it turns out neither right nor wrong (a count cleared since it began is left
alone); a try the app is killed during stays counted, so that killing it is no way round the count.
The right secret clears the count (opening the vault either way clears both of its counts), even if
reading the vault's state after it fails. Creating, erasing or restoring a vault clears the vault's
two counts, as they were about the vault it replaces; the count for backups stays, as the same
backup files can still be tried. The counts, and when the last wrong try was, are kept in
`attempts.json` beside the vault, written as the vault's own files are: private to the user, staged
in an `.atomicwrite*` folder beside it and renamed over it, and on macOS, Linux, iOS and Android the
folder synced (Windows relies on its filesystem journal), so that closing and reopening myCarlos, or
a power cut, does not clear them. The file is read only as a plain file of at most 4 KiB, never
through a link, and each time the counts are needed rather than as the app starts, so that another
copy of myCarlos open at the same time shares them: each takes the higher count and the later time
of its own and the file's, unless the other has cleared them since (a clear is numbered); a try one
copy takes back off may stay counted in the other, which only lengthens the wait. Two copies trying
at the same instant can still lose one another's count, so copies run side by side can each guess at
the pace of one. Before a vault home exists, or when the file cannot be written (a full or read-only
disk), the counts last for that run only: refusing every try then would shut the patient out of a
vault that can still be read, and a disk that fails to write undoes no more than deleting the file
does. A clock set back behind the last wrong try counts the wait from then, rather than never, even
when the file cannot take the earlier time; a clock before 1970, which reads as unknown, means no
wait, rather than one that never ends; and a file that does not read is passed over for this run's
own counts, which start from nothing. This slows only guessing through the app on this device: a
copy of the vault, or a backup, can be guessed at elsewhere without it, where only the cost of the
key derivation stands in the way; and whoever can delete the file, make it unwritable, set the clock
forward or before 1970, or run several copies of myCarlos at once, undoes or weakens the wait.

`recover` opens a locked vault with the recovery key and a new passphrase. It selects the header as
unlock does, the newest one the key authenticates, and refuses an older one when a newer header for
the same master key exists that the key does not open (a replaced key). The new passphrase must meet
the usual rules; then a new header pair wraps the master key under it and carries the envelope
forward, and the vault opens as an unlock would. If that pair cannot be written at all, as on a full
disk, the vault opens read-only with its passphrase unchanged. A vault that can only open read-only (see
recovery mode below) opens read-only with its passphrase unchanged, since nothing may be rewritten,
so that its documents can still be saved.

**Header formats.** Format 1 headers (no envelope) are still read, with their original integrity
payload. Every header written now is format 2, so a vault moves to format 2 at its next header write;
until then it stays format 1. A generation 0 (legacy, untagged) header is always format 1 and never
carries an envelope. A format 1 header that carries an envelope, or any other version, is invalid.

An earlier build, which knows only format 1, does not read a format 2 header. Once both slots are
format 2 it reports the vault as damaged and changes nothing. While the slots are mixed (the format 2
write of one slot landed and the other did not, or a legacy `header.json` is still there), an earlier
build opens the format 1 header with the earlier passphrase and its repair writes format 1 over the
format 2 slot, undoing the passphrase change or recovery key that slot carried. Do not go back to an
earlier build with a vault this build has written to. From this build on, a slot in a header format
newer than the build knows counts as unreadable: the vault opens read-only and the slot is left alone.
The format number is read before anything authenticates the slot, so a damaged or altered slot can
claim a newer format and keep the vault read-only. Nothing is lost by that: documents can still be
read and exported. The ways out are the build that wrote the slot, or a restored copy of the vault.

Replacing the recovery key, like changing the passphrase, does not change the master key. The
replaced key no longer opens this vault's current headers, but it still opens any earlier copy of
them (a backup, a snapshot), and with it the master key. See "Known limits before release".

## Files and transactions

```text
vault-home/               holds only what the vault manages; back up as a whole
  vault-v1.lock           stable OS lock file; never rename or delete while the app is running
  set-aside/<UTC yyyymmddThhmmssZ>-<uuid>/  a whole vault set aside by a reset or a restore,
                          headers and all, never removed by the app (#71)
  vault-v1.reset-pending/ a vault an older build retired to erase; set aside at the next start
  .create-<uuid>/         a vault being created, renamed into place once complete
  .restore-<uuid>/        a backup being restored, not yet verified; removed at the next start
  vault-v1.restore-ready/ a verified restore about to replace the vault; finished at the next start
  pending-exports/<uuid>  one per desktop export not yet cleaned up, naming its staging folder
  attempts.json           wrong tries in a row at a secret, and when the last was (no secret)
  .atomicwrite*/          attempts.json being written, renamed over it once complete; one a
                          killed write left holds only counts, and stays
  vault-v1/
    header-0.json        non-secret KDF configuration, wrapped master key, optional recovery-key
                         envelope (format 2), and keyed integrity tag
    header-1.json        redundant generation-bound wrapped-key and integrity-tag slot
    manifest-0.bin       authenticated encrypted metadata slot
    manifest-1.bin       authenticated encrypted metadata slot
    objects/<uuid>.mcobj authenticated encrypted record stream
    quarantine/<uuid>.mcobj  an object no manifest named at a writable unlock, moved aside,
                         never removed (#71)
    staging/<job-id>/    incomplete imports, removed after failure or next unlock
```

Nothing but these entries is ever written to the home, and the home is created private. That is
what lets a readable export refuse every destination inside it without a list of protected names:
saving a copy over the lock file, or as a regular file under the pending-reset name, would
otherwise let a second instance open the vault or block every later unlock, and no copy can land
in `set-aside/`.

An exclusive OS file lock is held throughout each unlocked session and during creation, reset,
and startup recovery. Another app instance receives an `in_use` error before it can read mutable
state or perform cleanup. Locking or closing the owning session releases ownership; the next
instance must unlock and load the current manifests. The lock file lives outside the vault so
reset cannot replace the inode/handle being locked. It contains no secret material.

Nothing erases a vault (#71's third part). A whole-vault reset ("Set vault aside") sets the vault
aside: one rename, under the same OS lock, moves it whole into
`set-aside/<UTC yyyymmddThhmmssZ>-<random uuid>/`, headers and all. It stays encrypted, and the
passphrase or recovery key it had still opens it; the folder's name tells only when it was set
aside. An open, writable vault first records `setAside`, with that folder's name, in its history;
the next vault created in the same run of the app names it in its `created` entry. The app cannot
open a vault set aside yet: the way back is to copy its folder into place by hand, with myCarlos
closed. The app never removes anything from `set-aside/`, so storage grows with each vault set
aside. On a computer, freeing the space means deleting a folder by hand: the confirmation dialog
names it in full. On Android and iPhone the folder is private to the app: only clearing myCarlos's
data in the system settings, or uninstalling it, removes a vault set aside, and that removes every
vault on the device, the one in use too. The dialog says so, and says that someone who knows the
old passphrase can still open the vault set aside until it is removed. This phone limit is accepted
(decided 19 October), and Security no longer offers starting again: only the unlock screen's
"Forgot your passphrase?" does, so no screen sets an open vault aside. A `vault-v1.reset-pending/` an older
build left on its way to erasing a vault, whole or partly erased, is set aside too, at the next
status, create, unlock or reset, under the same lock; while that cannot be done, access and
creation are blocked. Symlink/reparse-point reset directories, and a `set-aside` that is not a real
folder, are rejected. Abrupt-exit tests cover the rename; physical power-cut and filesystem
durability validation remain release gates.

The encrypted manifest contains profiles, nested folders, folder assignments, sanitized document
names that the patient may rename, sizes, timestamps, unverified-source labels, per-record
fingerprints, opaque object names, and wrapped content keys.

**Shared with me (#61).** Files shared to myCarlos from another app, or opened with it, are kept in
one reserved profile until the patient moves each to a person. It is an ordinary format v1 profile
named "Shared with me", added with the first such file, whose id is not random but derived from the
vault id: the first 16 bytes of SHA-256 over `mycarlos:shared-with-me:v1:` and the vault id's 16
bytes, with the UUID version set to 8 (RFC 9562's custom version) and the RFC 4122 variant. Every
other profile has a random version 4 id, which differs from it in the version bits, so no person can
ever have it; the manifest grammar is unchanged and needs no migration. The app shows this profile
as a folder, never as a person: it holds no folders, and its name is not one of the profile names a
passphrase is checked against. A document moves from it to a person by keeping its object, object
key and record id (the encryption binds the vault and the record, not the person) and recomputing
only its fingerprint, which is keyed with the person: the object is decrypted once, through the same
authenticated read as an export, into an HMAC. A document the person already has, by that
fingerprint, stays where it is. Documents move only out of this profile, never between people. No
person may be named "Shared with me", in any case, so the folder is never mistaken for one. A build
from before this change, which knows nothing of the reserved id, would list the profile as a person
named "Shared with me"; no such build has been released, and opening a vault with an older build is
not supported in any case (MIGRATIONS, rule 2). Mutations write the same logical state
into two consecutive generations using a cross-platform atomic replacement primitive. Once the first
generation is durable, the logical mutation is committed; failure of the redundant write is
reported in the snapshot as recovery mode rather than as a failed mutation. Unlock authenticates both slots, selects
the highest valid generation whose objects exist, rejects divergent authenticated states at the same
generation, and repairs only missing or damaged redundancy. If repair cannot write because storage
is full, unlock still permits read/export access in recovery mode. Staging, and ciphertext an
import wrote but never committed (a duplicate, or a batch that failed before its commit), are
removed without relying on a later unlock. Any other object that the opened manifest does not
name, found at a writable unlock, is moved to `quarantine/` rather than removed (#71): it may be
a crash's leftover, or a document a mistake in collecting references would otherwise lose. The
app never removes anything from there. The atomic replacement primitive
stages each header or manifest in an `.atomicwrite*` directory beside it; one that a killed process
left behind may still hold a superseded wrapped key, so a writable unlock and reset remove them.

Three cases open the vault in recovery mode without writing to the vault at all: no repair, no
staging cleanup, and no orphan quarantine. (Before any header is read, an unlock takes the lock file
beside the vault and finishes a reset or restore that an earlier run left unfinished.) First, if no authentic generation has all of its objects, unlock
selects the newest authentic manifest anyway, reports each record whose object is missing or is not
a regular file as unavailable, and refuses to export those records; the remaining records stay
exportable, so one lost object no longer leaves whole-vault reset as the only action. The same
applies when an older generation is complete but the newest authentic one also references an intact
object the older one lacks: falling back would overwrite the newer manifest and treat that object
as an orphan, so the newest generation is opened read-only instead. Second, if a
manifest slot exists but cannot be read (for example a sharing violation or device error), that
slot may hold the newest committed state, so unlock does not repair over it or remove the objects
it may reference. An absent, oversized, or non-regular slot is still treated as damage that repair
replaces. Third, if a header slot exists but cannot be read, it may hold a newer passphrase
generation: the passphrase just used may be one that it has replaced (a change whose second write
did not land leaves the earlier passphrase in the other slot, and that passphrase still opens the
vault, read-only). Whether a slot could be read is taken from the same reading that chose the
header, so that a slot held for a moment by another program is not missed by one and seen by the
other. While the vault is open and writable, a change of passphrase, a new recovery key (when it
is made and when it is confirmed) and a backup are refused if a header slot cannot be read by
then; documents can still be added and changed, which does not touch the headers. A legacy
`header.json` that cannot be read does not make the vault read-only: the slots supersede it.

A vault that cannot be opened is reported as damaged only when every file that holds its state
could be read. If no header opens with what was typed, or no manifest is authentic, and a header
or manifest file is there that could not be read, the error is `unreadable` instead: the files may
be held by another program, or on a drive that is away, and the patient is told that nothing has
been changed and not to erase the vault. It cannot say whether the passphrase was right, since the
header it opens may be the one that could not be read. A slot from a newer build is not counted
here: it opens the vault read-only, but a passphrase that only it holds is reported as wrong.

The snapshot names the reason for recovery mode, because each has its own way out. `lostObjects`:
some records' ciphertext is missing; the patient can restore the vault folder from a backup, or
choose to hide the damaged documents (#71; they used to be dropped). Hiding re-checks the disk
first, marks as hidden as damaged only records that were shown as damaged and whose object is
still missing (if another has gone missing since, it hides nothing and shows that one too),
commits that manifest through the ordinary two-generation write, and leaves recovery mode: the
vault no longer requires those records' objects. A file that came back keeps its document in view;
one that comes back later lets the hidden document be restored. A format 1 vault in this mode is
upgraded first, in a commit of its own. `unreadableSlot`: a manifest or
header slot could not be read and may be newer than what was opened, or a record's object could not
be looked up and may be intact, so nothing is written, not even a removal, until a later unlock can
read it.

An object is **present** when it is a regular file; **missing** when it is not found in a folder
that could be searched (or the folder is gone), or is a directory or special file; and **unknown**
when the lookup failed for any other reason (a permission, sharing or device error), when it is not
found but the `objects` folder is a link or a file (so the folder could not be searched for
certain), or when the object is a link or a Windows reparse point such as a cloud placeholder.
Unknown objects are listed as unavailable but are never offered for removal. Removal names the
documents the patient was shown; if the vault's own list differs by then, nothing is removed.
A vault whose objects stay unknown stays read-only until they can be read: reconnect the drive, fix
the folder's permissions, or tell the sync tool to keep the files on this device. `writeFailed`: a redundant write or repair failed;
a later unlock retries the repair.

Every manifest is checked with the reader's own validation before it is written. A mutation that
would produce a manifest the reader rejects fails as an invalid change and leaves both slots
untouched.

Each header binds its generation into the master-key wrapping operation and carries a separate
master-key-authenticated tag over the KDF configuration and wrapped envelope. That tag lets unlock
reject a genuinely newer passphrase generation while recovering from a newer slot whose still-valid
JSON has been corrupted. A single `header.json`, the layout before the two slots, is still accepted
once and migrated; format v1 keeps that path, though no vault from an earlier build is read (see
the storage root above).

Before a decrypted manifest can drive a filesystem operation, the reader checks format and vault
identity, unique profile/folder/record/object IDs, folder ownership and acyclic depth, record-folder
ownership, exact v1 object-name syntax, wrapped-key/fingerprint encodings, metadata bounds, and that
every object is a regular file rather than a link. The non-secret header is limited to 16 KiB and
each encrypted manifest slot to 16 MiB before allocation, so a corrupt local file cannot request an
unbounded metadata allocation.

Imports stream arbitrary files in 1 MiB chunks. XChaCha20-Poly1305 authenticates every chunk with
the vault ID, record ID, chunk index, and final-chunk marker as associated data. Files are encrypted
and verified in a per-job staging directory; a batch becomes visible only after every non-duplicate
input succeeds and the next manifest generation is durable. Duplicate fingerprints are keyed and
scoped to a patient profile. A failure before the first manifest commit leaves the prior manifest
authoritative and immediately removes newly moved ciphertext. A failure after that commit returns a
successful import in recovery mode because the new manifest is already authoritative. The native
picker is filtered to PDFs and batches are limited to 100 files so the picker bridge does not hold
an unbounded number of open handles in one transaction. Individual file size is not capped;
constant-memory chunking keeps large medical files possible, while available storage and future
vault-quota policy remain separate concerns. The filter does not validate PDF structure or make a
future renderer safe.

Exports stream authenticated plaintext only into a destination explicitly chosen with the native
save dialog. Filesystem-path destinations are written to a temporary file in a
`.mycarlos-export-<uuid>` folder beside the destination and atomically replaced only after
authentication and syncing succeeds. That folder is recorded first in `pending-exports/` in the
vault home: one file per export, named by its UUID and holding the staging folder's path in the
platform's native encoding (raw bytes on Unix, UTF-16LE on Windows). The entry reveals the folder
the user exported to, never the document's name. When an export ends, successfully or not, it
removes the folder and then its entry, keeping the entry if the folder could not be removed. Startup
status, creation, unlock and reset remove any folder that a killed process left, then its entry,
skipping exports still under way in the same process (another instance, sweeping after this one's
session locked, can remove a copy not yet renamed, which fails that export cleanly); outside the
vault home they only remove a real directory (not a link) with that exact name. An entry is kept for
a later start when it cannot be read, when something else has taken its folder's name, or when the
folder's parent is missing, as when its drive is not connected; that last is a best guess, and a
drive remounted elsewhere loses its entry. If the entry cannot be written for any reason, as when
the vault's disk is full, the export still runs, untracked. Content-provider destinations, where
atomic rename is unavailable, receive a second streaming pass only after a complete authentication
pass. The UI warns that the exported copy is outside vault protection.

Nothing is deleted (#71, Ben's decision of 16 October). Hiding a document commits, through the
ordinary two-generation write, a manifest that marks its record hidden, with when and why
(`patient` or `damaged`); its ciphertext, wrapped key and every other detail stay. The library
leaves hidden documents out of every view but **Hidden**, which lists them with their size and
offers Restore, which clears the mark. A document hidden as damaged whose file is still missing
cannot be restored, since the vault would require that file again. Backups carry hidden documents
and their objects; a document hidden as damaged is carried with its object only if the file is
there, and a restore accepts it without one. Plaintext exported earlier, and copies in filesystem
snapshots, device backups or a future synchronization service, are outside the app's control.
No viewer, synchronization, analytics, or CARLOS provenance is implemented.

Every removal from storage goes through one helper that names what it removes: a create or
restore stage, an import's staging or uncommitted ciphertext, an export's stage or journal
entry, the superseded `header.json`, what the atomic replacement primitive left, and a history
segment the committed manifest no longer names (below). No kind covers a vault: a reset or a
restore sets it aside (above). Direct
`std::fs` removal is disallowed crate-wide by `src-tauri/clippy.toml`, which CI enforces, and a
scripted session of every document command checks that every object a record ever named is
still there, byte for byte.

### Manifest format 2

Format 2 (#71) adds each record's optional `hidden: {atMs, reason}`, and pads the manifest's JSON
plaintext with spaces, which JSON ignores, to a size class: the next power of two, at least
4 KiB, at most the 16 MiB slot limit less its 40 bytes of nonce and tag. A manifest file's size
then tells only roughly how much the vault holds. Format 1 manifests are still read, unpadded; a
format 1 manifest with a hidden record is refused.

### Manifest format 3 and the history

Format 3 (#71) adds the history: `history: {count, head, segments: [{id, objectName, wrappedKey,
firstSeq, entryCount}]}`, left out while empty. Formats 1 and 2 are still read; a format 1 or 2
manifest with a history is refused. It is a format of its own, not an addition to format 2,
because format 2 can be released before the history is: a build that knows only format 2 reads
unknown fields as absent, so it would open a format 2 vault with a history, write its manifest
back without one, and move the segments to `quarantine/` as orphans, losing the record with no
error. It refuses format 3 instead.

A writable unlock of a format 1 or 2 vault upgrades it to format 3 at once, in a commit of its own
that changes nothing but the format and the generation: both slots hold format 3 before anything
only format 3 can hold (a history; for format 1, a hidden document) is written. A crash between
the two upgrade writes leaves one format 3 slot holding the same state as the older slot, with no
history, so an older build that opens the older slot loses nothing; once both slots are format 3,
an older build refuses both (it reports the vault as damaged), and never reaches its orphan
cleanup. An upgrade that cannot write leaves the session read-only, as a failed repair does; the
next unlock tries again. A vault opened in lost-objects recovery mode is upgraded when its damaged
documents are hidden. See `MIGRATIONS.md`, "Manifest additions".

**What is recorded.** One entry per event, appended in the same commit as the change it records,
so that neither is ever committed without the other: the vault created; the history started (in a
vault an earlier build made, at its first recorded event); each unlock, with the secret that opened
it (`passphrase` or `recoveryKey`) and how the session before it ended; a document imported
(`how: "picked"`, `"camera"` for a photo taken in myCarlos, or `"shared"` for a PDF received from another app), renamed (old and new name), moved (the folders before and after, by id and by
their names then), hidden (`how: "patient"` or `"damaged"`) or shown again; a readable copy saved,
and where; a recovery key set; a backup saved, and where; a backup restored (`how: "replaced"`
when it set a vault aside); and the vault set aside, with the folder it went to, when it was open
and writable then. A vault created after this run of the app set one aside names that folder in
its first entry's `place`. An entry about a
document names it as it was called at that moment. Read-only sessions record nothing. Changing
the passphrase, profiles and folders themselves are not recorded.

**Locks are recorded at the next unlock.** Nothing is written when the vault locks, so that a lock
never waits on a write or fails over one. The app remembers, in memory only, when and how the
session ended (`lockedAt:<ms>:app`, or `:nativeDeadline` when the native idle backstop locked it),
and the next unlock in the same run of the app records it as `previousSession`. After the app
restarts it records `notRecorded`. A session that could not record its own unlock (a read-only
one, or one whose unlock entry could not be written), or that left read-only after a failed write,
leaves no note of its own: the note waiting from before it is kept and `;notRecorded` added, so
the next recorded unlock says both how the last recorded session ended and that one went
unrecorded after it. The vault can therefore show a session's start, but its end only as well as
this run of the app knew it.

**Entries and the chain.** An entry's canonical form is the UTF-8 JSON of these fields, in this
order, with no whitespace, absent fields left out, integers as integers, and strings escaped as
JSON requires and no more (non-ASCII characters are written as themselves; there is no Unicode
normalization, so the bytes are hashed as written):

`seq, atMs, app, event, recordId, profileId, folderId, name, oldName, from, fromTotal, to, toTotal,
how, place, placeSha256, previousSession, prev`

`event` is one of `created`, `historyStarted`, `unlocked`, `imported`, `renamed`, `moved`,
`hidden`, `restored`, `copySaved`, `recoveryKeySet`, `backupSaved`, `backupRestored`,
`passphraseChanged`, `profileCreated`, `profileDetailsChanged`, `folderCreated`, `folderRenamed`, `folderMoved`, `setAside`. A folder is
`{"id", "name"}`. A profile's or folder's entry gives its `profileId` (a folder's also its
`folderId`) and its `name` afterwards, except `profileDetailsChanged`, which records only
`profileId` and never the identity values. Renaming a person's top-level folder label is
`folderRenamed` with `how: "personFolder"`, the unchanged person's `profileId`, and
`oldName`/`name`. It has no `folderId` or `recordId`: no ordinary folder or document
was changed. Only the profile's displayed label changes; its identity details, IDs,
document bytes, signatures and previous history stay untouched. This uses existing
event and optional fields without changing manifest format or canonical entry order;
older readers can parse, verify and append it. A reader that does not label this
method specially can show “Folder renamed” with its old/new names and the method
marker. Shared intake also gives the reserved source
`profileId`; its move to a person records `moved` with `how: "shared"` and the destination
`profileId`, even when both locations have no folders. The move and its history entry commit
together. For folder events, `folderCreated` gives in `to` the folder it was made in,
`folderRenamed` the `oldName`, and `folderMoved` the folder it left in `from` and the one it is in
now in `to` (none for "My records"). `passphraseChanged` says in `how` what replaced it: the
passphrase in Security (`passphrase`), or the recovery key at the unlock screen (`recoveryKey`,
right after that unlock's entry, in the same commit). No passphrase or key is ever recorded. A move names at most 32 folders on each side and then gives `fromTotal` or
`toTotal`; a place longer than 256 characters is cut there and `placeSha256` holds the SHA-256 of
the whole, so that no entry can outgrow a segment.

- `hash(entry) = SHA-256("mycarlos/history/v1" ‖ 0x00 ‖ canonical JSON)`, in lower-case hex.
- `prev` is the previous entry's hash. The first entry's is the genesis value,
  `SHA-256("mycarlos/history/genesis/v1" ‖ the vault id's 16 bytes)`.
- `seq` counts from 0. The manifest's authenticated `count` and `head` (the last entry's hash) pin
  the end, so a changed, missing, reordered or cut-off entry shows, at the first `seq` that does
  not follow.

Test vectors, which a test in `src-tauri/src/vault.rs` checks against this file. For the vault id
`00112233-4455-6677-8899-aabbccddeeff`:

- genesis: `c5ecb0cf1c9d1c151c148ab3ab2f3b7deca1fc15094948bb486eced0c990fa60`
- entry 0: `{"seq":0,"atMs":1767225600000,"app":"0.1.0","event":"created","prev":"c5ecb0cf1c9d1c151c148ab3ab2f3b7deca1fc15094948bb486eced0c990fa60"}`
- its hash: `1577ce4e606eab3176352f79ffcfaf9b5597ecfdd6bc02601430fd3211573f7c`
- entry 1: `{"seq":1,"atMs":1767225660000,"app":"0.1.0","event":"renamed","recordId":"10000000-0000-4000-8000-000000000001","name":"Écho \"cardiaque\".pdf","oldName":"scan.pdf","prev":"1577ce4e606eab3176352f79ffcfaf9b5597ecfdd6bc02601430fd3211573f7c"}`
- its hash, the head: `0178d36064227e0af099fb7c2d51cf80da017fca9e41a96cd59ccb5a18348c78`

**Segments.** Entries are kept in segments of exactly 64 KiB of plaintext: entries one per line,
then spaces. A segment is closed when the next entry would not fit. Each is an object in
`objects/`, named like a document's and encrypted in the same chunked envelope under a random key
of its own, wrapped by the object-wrap key with the associated data
`"mycarlos-history-segment-v1:" ‖ segment id`; the segment id stands where a document's id does in
each chunk's associated data. Every segment's file is the same size. Filler segments, holding no
entry (`entryCount` 0, `firstSeq` 0) and listed after the others, make the number of segments a
power of two, so that the count of segment-sized files shows only about log₂ of the history's
length.

**Appending.** The last segment is rewritten copy-on-write with the new entries after its own,
with new segments when it is full and new fillers when the count passes a power of two: the new
objects are written and made durable, the manifest naming them is committed, and the superseded
segment is unlinked between the two manifest writes. A failure before the commit removes what it
wrote; a crash there leaves objects that orphan cleanup moves to `quarantine/`. A last segment that
is gone or does not authenticate is kept as it is, and the new entries start a segment of their
own: the chain goes on from the head the manifest pins, and a check shows the gap. Segments are
not required objects: a missing one never stops the vault opening.

**Backups and restore.** A backup carries every segment that authenticates; one that is gone or
damaged is left out. A restore takes segments as optional, authenticates those present, and, before
the restored vault is put in place, appends `backupRestored` to its history (a backup made by an
earlier build becomes format 3 there and starts its history). Whether the vault on this device
"differs from the backup" leaves the history and the format out of the comparison, since every
unlock, and every backup saved, adds to the history.

**Verified read-only view, kept on the device.** While the vault is unlocked, the Security
screen can request the history. Native code reads every encrypted segment in order and returns
display rows over IPC only for entries it has authenticated from one of the chain's two pinned
ends. From the start: entries before the first segment that is missing or does not authenticate,
while each follows the one before from the genesis value, and never past the manifest's count.
From the end (Ben's D146): entries after the last such segment, walking back from the manifest's
pinned head while each is the `prev` of the one after it with the number before it, so that the
last is number `count - 1` and its hash is the head; none is shown twice. With the rows it returns
`complete`, true only when the rows from the start are the whole chain the manifest pins (its
count and head). When it is false, Security shows a notice dated from the native fields: "Part of
this history is damaged. Events between <date> and <date> can't be checked and aren't shown." (or
"after <date>", "before <date>", or that none are shown), with a marker in the list where the gap
is (Ben's D129 and D146, mycarlos#120). The notice follows those fields only; the renderer never
works it out. Its dates are the entries' recorded times, so after the device clock was set back
the first can read later than the second; the order shown is always the chain's. A damaged
segment is never opened or shown.
Those rows include recorded names, folder labels, times, methods, session notes and saved
locations (including file paths or provider addresses). Native record/profile/folder identifiers,
chain hashes, wrapped keys and object paths are not returned. Some entries lack person context;
folder labels are not complete paths and saved locations can be shortened. A lock request
cancels the read; the renderer conceals content while confirming the lock and ignores late
responses from an earlier view or session.

The view never edits entries or saves a separate history file: Ben chose (#71, 19 October) a
history recorded automatically and tamper-evident on the device, with no auditor export. A backup
carries it only as part of the encrypted vault. The view does not overcome rollback of a complete
vault or an inaccurate device clock; those limits and the outside-anchor follow-up remain.

### Manifest format 4: optional profile identity details

Format 4 adds optional `fullName` and `birthDate` to each patient profile in the encrypted
manifest. `fullName` is a trimmed nonempty name, bounded by the existing 120-character name
limit. `birthDate` is an exact Gregorian `YYYY-MM-DD` date (year 0001–9999). Blank details
are omitted, not serialized as null. Shared with me is a reserved location and cannot carry
identity details. Formats 1–3 must not carry either field, including null; such manifests are
refused. No identity details are written to plaintext headers or filenames.

Creation and editing validate dates natively. A new birth date cannot be later than the
current local calendar day supplied by the renderer; that day must itself be within one day
of the native UTC date, covering time zones without trusting an arbitrary future date.
Structural validation of stored dates does not depend on the clock, so a clock correction
does not damage an existing vault. Editing details records `profileDetailsChanged` with only
`profileId`, never the old/new full name or birth date. Details and that history entry use the
existing atomic recorded mutation. Read-only recovery sessions cannot change them.

A writable unlock upgrades formats 1–3 using the existing two-slot upgrade transaction,
before new fields or events can be written. Profiles, records, folder assignments, document
objects and existing history are retained. If recovery makes the vault read-only, it stays in
its older format until a writable unlock is possible. Backups and restores preserve identity
details. A backup made by a format-4-capable app requires a format-4-capable app to restore;
an older app refuses the newer manifest. Keep a pre-upgrade backup if returning to an older
build is needed; there is no lossy downgrade or silent removal of identity details.

**What an older build shows.** A build that knows only formats 1–3 (every build before format 4)
cannot tell a newer format from damage. Once both slots are format 4 it reports the vault as
damaged or incomplete, and a backup saved from it as not a complete myCarlos backup; it changes
nothing either way. From format 4 on, a manifest that decrypts under the vault's key but declares
a format newer than the build's own is told apart from damage, and only its format number is
read: unlock and recovery refuse with `vault_newer_format` ("This vault was saved by a newer
version of myCarlos. Update myCarlos to open it. Nothing was changed."), and checking or restoring
a backup refuses with `backup_newer_format` ("This backup was saved by a newer version of
myCarlos. Update myCarlos to restore it. Nothing on this device was changed."). A newer slot
beside one the build can open is handled as before: a crash between a newer build's two upgrade
writes leaves nothing in the newer slot that the other lacks, so the vault opens from the other
slot, and redundancy repair may write over the newer one. A manifest that does not decrypt, or
declares a known format and fails its checks, is still damage.

Shared PDF hints are not saved in the manifest or history. Only explicitly labelled patient
names (Patient name / Patient full name) and optional exact ISO dates (DOB / Date of birth /
Birth date) from the existing sandbox helper's bounded first-page text are considered.
When a date is present, its label must be adjacent to the name label (ignoring blank lines);
possibly truncated text and repeated identity labels yield no hint. The existing reader may
flatten visually separate PDF text positioned with `Td` or `Tm`; visual positioning alone is
not an identity boundary. The two tiny test PDFs are handwritten FAKE fixtures: `labelled.pdf`
uses an explicit `T*` text-line break; `flat-text.pdf` uses `Td` positioning and deliberately
finds no identity. They are not representative CARLOS output or clinic captures. Bundled dev
PDFs using `Patient:` and positioned text do not demonstrate this suggestion feature.
Conflicting or malformed labels, unsupported layouts, encrypted PDFs without an unlocked
copy, missing text and unavailable helpers yield no hint. No OCR or free-text date guessing
is performed. The hint never changes source verification and never moves a record by itself.
The patient must press Move; the existing move and its history entry remain one operation.
Dismissals and extracted hints last only for the unlocked session. Clinic pickup and automatic
clinic-to-person links remain dependent on portal linking and authenticated delivery intake
(portal #41 M2/M4); this change introduces no clinic queue, network client or trust claim.

## Backup and restore behavior

On Apple platforms the vault is deliberately stored in the application data/Application Support
area so normal device backups can carry its ciphertext. A restored vault still requires the
patient passphrase. No plaintext cache is created or marked for backup. Android cloud backup is not
promised and the generated Android application manifest is configured in CI with
`android:allowBackup="false"` and `android:fullBackupContent="false"`. Android 12 and later ignore
both for device-to-device transfer, so the same step writes data extraction rules that exclude every
storage domain from `<cloud-backup>` and `<device-transfer>`. Checked-in build logic rejects an
Android build unless those generated-manifest settings and the rules file are present; Android users
move a vault with the portable encrypted backup below, and physical OEM transfer testing remains.

A forgotten passphrase is replaced with the recovery key, if the patient set one up. Without it, the
only fallback is a typed-confirmation whole-vault reset followed by a trusted native confirmation
dialog, which sets the vault aside and starts an empty one; without its passphrase, the vault set
aside cannot be opened. OS cloud backup is to be excluded
where the platform permits, now that the portable backup exists; that is separate, per-platform
work.

### Portable encrypted backup

A backup is one `.mycarlosbackup` file holding the vault's ciphertext as the patient sees it. Every
document is authenticated as it is copied, so a damaged one fails the backup, naming the problem
while the vault is still there, rather than the restore. The refusal carries that document's id
(never its name), and the screen names the document. The patient is told to keep older backups
and get help recovering the document from a good copy or backup before trying again. A corrupt
file hidden by the patient is still required in a backup.

```text
"MYCARLOS-BACKUP\n"                      16-byte magic, format 1
entry*   kind (1 header, 2 manifest, 3 object) | name length (u16) | name | length (u64) | bytes
         the newest authentic header (JSON), the current manifest slot, then every referenced object
trailer  0xff | length (u32) | JSON {format, vaultId, manifestGeneration, createdAtMs,
         entries: [{kind, name, length, sha256}]} | HMAC-SHA-256 tag (32 bytes)
```

The tag covers the magic and the trailer, under `HKDF-SHA-256(master key, salt = vaultId,
"mycarlos/backup/v1")`. The trailer lists every entry's length and SHA-256, so the tag covers the
whole file. Document content, names and details are already encrypted, so no plaintext of them is
written at any point; the header's key envelopes (passphrase and recovery key) are what open it.
Readable in the file: the vault id, the header and manifest generations, the backup's time, the
KDF salt, the recovery key's id and set-up time, and each object's opaque name, length and hash,
so the number of documents and their sizes. Whoever holds a backup can try passphrases against it
at the cost of Argon2id per try, as with a copy of the vault. A read-only vault is not
backed up, since what it shows may not be what it holds. Saving streams with constant memory, as a
transfer the automatic lock waits for, to a file the patient picks (never inside the vault home),
replaced atomically only once complete. The name suggested for it carries the date it is saved, on
the patient's own calendar (the page gives it as `YYYY-MM-DD`, checked natively, with the UTC date
if it gives none), and the label of the vault's recovery key, if it has one (`myCarlos backup
2026-09-30 7F3A.mycarlosbackup`), so that backups from different days or keys do not take each
other's place. A saved backup reports the name of the file written, where the platform says it,
and its size.
A backup that fails for want of space, a storage error, unreadable files or a lock says that none
was saved and to keep the older ones. On Android, the picker makes a new document or hands back an
older one the patient chose to save over, and opening it empties it (the provider may empty it as it
opens, even if the open then fails): a failure before myCarlos has it open says that an empty file
may be left there to delete, and to keep any backup that is not empty; a failure after says that the
file there may be empty or incomplete, and emptied if it was an older backup, and to delete that
one, not the other backups. What may be left on Android is said after any backup failure; for a
backup a lock cut off, it is told, with the rest, after the next unlock, or at once if that lock
fails while the screen is shown. When the steps for older backups name no file (Android), such a
failure takes them back to saving a new backup first.

A backup opens with the passphrase, and the recovery key if it had one, that the vault had when it
was saved, not with any set up since; a restore that is refused for either says so in those words,
not the unlock screen's.
A backup file that cannot be opened at all (for example, one a cloud folder has not brought to
the device) is refused with advice to copy it to a local folder first, and nothing changes.

Restoring happens while no vault is open. The patient picks the file and gives its passphrase or
recovery key. An inspect step reads only the header and manifest and reports what restoring would
replace: nothing, the same vault unchanged, the same vault differing from the backup (its
documents, passphrase or recovery key; or it could not be read to tell), a different vault, or a
vault whose header could not be read at all, so that which one it is cannot be told (it is not
called a different one). The screen spells this out and requires an explicit agreement before a
changed, different or unreadable vault is replaced. Replacing any vault is then confirmed in a
trusted native dialog, as a reset is; the native side works the preview out again itself and puts
it in the dialog. The restore itself:

1. opens the header with the credential, as unlock would, and checks its integrity tag. The file
   is opened again for this, so the restore works the preview out once more from what it has
   opened, and refuses if it is not the one the patient confirmed: another backup put in the
   file's place meanwhile (in a shared or synced folder), or a vault that changed or appeared;
2. streams every object into `.restore-<uuid>/` in the vault home, hashing each, accepting only the
   manifest's objects, each once, in any order;
3. checks the trailer's tag, that it lists exactly the entries read, and that nothing follows it;
4. writes the header and manifest into the stage, opens it as unlock would (it must be complete and
   writable), and decrypts every object to authenticate it;
5. renames the verified stage to `vault-v1.restore-ready/`, then sets the live vault aside, as a
   reset does, and renames the restore into place. Nothing is erased; the restored vault's
   `backupRestored` entry says `how: "replaced"` when there was a vault to set aside.

Any failure before step 5 removes the stage and changes nothing else. So does a failure in step 5:
a failure to retire the live vault, or to rename the restore into place once it is retired, in
which case the retired vault is renamed back first. The verified copy is then discarded, so that a
restore reported as failed cannot happen at a later start. It is renamed back to a stage's name
before it is removed, and a start never puts a `restore-ready` directory without a header in
place, so a removal cut short cannot either; where it cannot be renamed, its header is removed
first, for the same reason. Only if the retired vault cannot be renamed back, or the verified
copy's header cannot be removed, is the copy kept whole (as the one vault left, or as what the next
start puts in place): the patient is told to close and reopen myCarlos to finish the restore, and then to
open the vault with the backup's passphrase or recovery key. From step 5 on, each step is one rename, and every start repeats whatever is
left: status, create, unlock and reset put a waiting restore in place first when the live vault
is already set aside, then set aside a vault an older build retired, then activate a restore
still waiting. The restored
vault is left locked; it opens with the passphrase or recovery key it was backed up with. The
restore always takes the whole backup: an older backup brings documents hidden since back into view, and
the passphrase and recovery key it was made with, and the screen and the native dialog say so
before the patient agrees. On Android a backup is written straight to the document the provider
returns, so a failed or cancelled save leaves an incomplete file there (which a restore refuses)
in place of what that document held. Everything that would refuse the backup is therefore checked
first, as the backup checks it (a read-only vault, the header, the manifest slot, every document),
before that document is opened and emptied; only a failure while the backup is written, or a lock
or change that comes between the check and the writing, can leave it emptied.

## Settings kept outside the vault

The following device preferences are kept in the webview's own storage, not in the vault, so that
they apply before a vault is unlocked. These preferences name no vault, patient or document. Anyone
who can read the app's files on the device can read them. Erasing the vault does not remove them.
This table covers preferences only; recovery setup and older-backup guidance also keep local
state, described in the recovery-key sections above.

| Setting | Key | What it could tell |
| --- | --- | --- |
| Minutes until the automatic lock | `mycarlos.autoLockMinutes.v1` | Nothing about the patient |
| Size of the interface (zoom), on a computer | `mycarlos.zoom.v1` | A large size suggests that whoever uses the app sees poorly |
| Appearance (System, Light or Dark) | `mycarlos.appearance.v1` | The chosen appearance; no vault, patient or document |

## Known limits before release

- Rollback across an externally restored pair of otherwise valid manifest slots is not detected.
- Changing the passphrase or replacing the recovery key does not change the master key. Someone who
  has the earlier passphrase or key, and any earlier copy of a header (a device backup, a copied
  folder, a saved backup file), has the master key, which decrypts the vault as it is now and
  later, whenever they get a copy of it. Rotating the master key is not implemented; it is
  planned for after the first release, and until then this limit is accepted. The
  only remedy is a new vault, which the app does not guide: save a readable copy of every document
  (one at a time, in every profile; a damaged document cannot be saved), check that each copy
  opens, lock it and set it aside ("Forgot your passphrase?" on the unlock screen), create a new
  one and import the copies. The vault set aside stays
  on the device (#71), and the earlier passphrase still opens it: to keep it from someone who knows
  that passphrase and can reach the device, delete its folder in `set-aside/` by hand. Folders, profiles and the dates
  added are not kept, the saved copies are not encrypted while they wait, and the recovery key and
  earlier backups belong to the earlier vault: restoring one brings the earlier master key back.
  The earlier passphrase does not itself open a later copy of the vault; the master key taken from
  the earlier copy does.
- Restoring an older valid pair of header slots can restore an older passphrase wrapper, or an older
  recovery-key envelope, for the unchanged master key. Patient-pilot backup, recovery-key rotation, and device synchronization must define
  and enforce key-envelope rollback protection.
- There is no way to delete a document (#71): hidden documents and their names stay in the
  vault and its portable backups. Unreferenced objects in `quarantine/` stay on this device,
  but portable vault backups omit them; a separate backup of the device may retain them.
  Storage grows with retained data. Exported plaintext and copies outside the live vault are
  beyond the app's control.
- The history (#71) cannot prove the patient did not rewrite it: a copy of the whole vault put back
  (a backup, or the folder copied back) passes the chain check, since that copy's chain is whole
  in itself, and the device clock can be changed. Only an anchor outside the device (the portal,
  #55) would catch that. The number of segment-sized files shows the history's length to about a
  power of two. Locks are recorded only at the next unlock in the same run of the app.
- Nothing erases a vault (#71): every vault set aside stays on the device, encrypted, and opens
  with the passphrase or recovery key it had, until its folder is deleted by hand, or, on Android
  and iPhone, until myCarlos's data is cleared or it is uninstalled, which removes every vault.
  Storage grows with each one. The app cannot open one yet (reopening is a follow-up).
- Crash-injection, power-loss, low-disk, physical-device backup/restore, and filesystem-permission
  matrices remain release-gate tests. Abrupt subprocess termination at the application-controlled
  chunk, staging, rename, manifest, and deletion boundaries is automated, along with deterministic
  `NoSpace` failures around object and metadata commits. True power-cut and genuinely full
  filesystem behavior inside platform primitives still require target-device testing.
- Argon2id settings require performance measurements on the oldest supported device class; the
  repeatable harness and result record are in [`ARGON2_BENCHMARK.md`](ARGON2_BENCHMARK.md).
- The format has not received independent cryptographic or privacy review. [`MIGRATIONS.md`](MIGRATIONS.md)
  defines the future staged, verified, rollback-safe protocol and version/interruption matrix;
  activation code awaits an actual v2.
- The application has been extracted into this dedicated repository; protected release infrastructure
  and the remaining review gates are still required before release. See [HANDOFF.md](HANDOFF.md).


### Future manifest format 5: portal link custody (#55)

This future branch reserves format 5 above held profile format 4. It does not
authorize upgrading the current demo. A writable unlock upgrades older supported
manifests using the existing redundant/history transaction; read-only recovery
never writes a migration. Older applications refuse the new version.

`portalLinks` is absent for an empty list, at most 16 entries otherwise. Each
entry keeps its UUID, canonical HTTPS portal base (including any deployment path),
a generic patient-edited device name, optional existing-person UUID, creation
time and two independent 32-byte private seeds (`x25519`, `ed25519`). These seeds
are inside the authenticated encrypted manifest, never the public snapshot.
Every clone of the private-seed structure zeroizes on drop.

An entry with no `clinic` is an incomplete attempt. It is durably committed
before the one-use code is sent; the code is never stored in the vault. An entry
becomes linked only when a valid response binds its derived device key ID to
a recipient, clinic ID/name and 1–16 canonical P-256 SPKI keys with hash-derived
IDs and active/revoked status, including at least one active key. Duplicate
link IDs, device IDs, key IDs or response members are refused.

`portalLinkStarted` and `portalLinked` are history events. Both have a
`portalLinkId`; success also records the clinic name and complete `clinicKeyIds`
in that same encrypted commit. New optional history fields appear before `prev`
and are omitted when absent, preserving the old canonical bytes.

The public snapshot carries native availability and redacted summaries (portal
base, generic device name, clinic name, key fingerprints, person and incomplete
state). It carries no private seeds, SPKI blobs or recipient IDs. Backup already
contains this encrypted manifest and hence retains link custody. Signed-original
object metadata, durable verification results, rechecks and the restore notice
are further format-5 work; their absence must not be reported as complete #55.

#### Format-5 original-PDF custody source checkpoint

Document objects and history segments are synced before publication through
`atomicwrites::move_atomic`: `MoveFileExW(MOVEFILE_WRITE_THROUGH)` on Windows,
and atomic publication followed by source/destination directory sync on Unix.
The encrypted manifest is published afterwards through the existing atomic-write
primitive. Restart tests cover a crash after either document object, history
publication, and each manifest slot. These tests establish process-crash recovery;
Windows power-loss behavior still needs the actual supported filesystem/device
validation before delivery is enabled.

`originalPdf`, when present on a record, describes a separate MCVO1 object: its
own UUID, object name, wrapped independent random key, plaintext size and SHA-256.
The source implementation retains this for every accepted PDF, including unsigned,
unknown-signer and oversized input, so custody does not depend on a hostile PDF's
signature classification. This costs approximately two encrypted PDF objects per
record. Camera JPEGs do not normally carry a PDF header and retain one object.

The copy streams from an authenticated read of the incoming encrypted object,
before helper parsing, into the existing XChaCha20-Poly1305 framing. No readable
temporary file is made; one output chunk is held until the final-chunk bit is
known. Both references enter the same durable record/history commit, backup,
restore and orphan-reference set. New original-object UUIDs cannot alias records
or history segments. The original's plaintext hash is checked on export/backup/
restore. Saving or sharing selects the original; viewing uses the intact display
object. Conservative identity suggestions prefer raw original PDF bytes and
continue using helper raw text, never readableText.

A missing original does not remove the intact display. Its presence is exposed
separately; backup/export refuse an unavailable or unauthentic original. This is
a private source checkpoint: focused original custody and process-restart tests pass on Linux; durable
verification state/rechecks and missing/corrupt-source downgrade history still
need implementation, and no full #55 or platform claim follows from these edits.

#### Format 6: clinic delivery custody and first-device approval

Format 6 prevents older writers from discarding delivery or approval evidence.
Writable unlock upgrades formats 1–5 before adding it. Header and object formats
are unchanged. Default builds still disable all portal network commands, and
can open and back up this encrypted evidence without enabling network access.

A received record's optional `delivery` contains its saved link UUID, complete
outer identity, authenticated delivery manifest and exact compact signature,
checked PDF document ID/revision, check time, filing history head, exact signed
receipt, and optional terminal receipt outcome (`picked_up` or `gone`). The
receipt is outside the chain because it authenticates the per-link HMAC of the
head after `deliveryFiled`. Both independent PDF objects and history segments
are synced/published before the manifest that owns them and the receipt. No
receipt is exposed to the HTTP path until this custody commit succeeds.
An uncertain manifest publication preserves possibly referenced objects and
makes the session read-only until restart reconciliation.

Same-link delivery IDs are stable. Identical ciphertext retries do not add a
record or regenerate the receipt; a different ciphertext under an existing ID
is refused. Pending receipts are retried before a new mailbox listing, using
exact saved compact bytes and a fresh outer request assertion. Only strict
200 `picked_up` or 404 `delivery_not_found` responses settle retry; a generic
404, refusal, timeout or lost reply does not. Settlement appends history and
retains the original receipt. `gone` never represents a cryptographic pickup.

A link's optional `approval` keeps one first-device request UUID, exact signed
intent and expiry, and any verified challenge/acceptance. Intent and history
are committed before POST. This milestone implements `staff_first` only, with
null predecessor; it does not authorize a later-device or lost-all-devices
fallback. Exact clinic signatures bind the saved portal base, recipient, both
public keys, device ID, request, challenge and original compact hashes. Unsigned
portal status alone never establishes approval. Stored historical evidence
remains readable after revocation; current approval requires active pinned keys.
Full device code/fingerprint in the snapshot are public identifiers only.

Linux shared-vector, real-helper interoperability and subprocess-crash tests
are partial evidence. Supported Windows filesystem behavior, real portal HTTP,
actual linking/staff approval and full native UI flow remain enablement gates.

#### Format 7: recoverable approval requests and terminal status

Format 7 retains original request IDs across explicit restarts. Each link keeps
its current `approval` and bounded `approvalHistory` (at most 16 requests in all).
No request/proof is dropped to make room: a full history stops new requests and
asks the patient to contact the clinic. Each attempt can also keep its typed
advisory `status` and controlled `reason`; old format-6 attempts with neither
field remain readable. Current approval still requires a verified acceptance,
never an unsigned status. Header/object formats and M3 wire bytes are unchanged.

Request sends and restart actions first reconcile all retained unaccepted IDs.
An accepted response is verified and saved before any restart decision. Ordinary
retry keeps the original intent/request ID even after local expiry. A separate,
explicit restart may create a new intent only after reconciliation, retaining
the complete old attempt. A later valid acceptance for a retained ID still
establishes this same device's approval; current key trust remains mandatory.
A failed/unknown reconciliation never starts a replacement automatically.

Typed refused/expired/cancelled states and their controlled reasons are committed
with history before a visible error is returned. Both POST replies and GET
updates take this path. Unknown reasons, malformed replies and invalid proofs
are refused. Check for new documents cannot silently turn a terminal refusal
into a successful pending check. The UI distinguishes exact retry from explicit
restart and preserves terminal guidance after reopening the vault. Upgrade
coverage includes formats 1–6. Production-boundary tests exercise the real
vault/proof parser with scripted synthetic HTTP replies; those tests do not
claim live network or Windows end-to-end completion.

Approval reconciliation commits each independently verified response before the
next HTTP exchange. Once current acceptance is durable, unavailable archive
endpoints do not block that link. An archived network/parser failure leaves the
old request intact and is surfaced without discarding earlier committed proof
or terminal state. Explicit restarts still refuse unresolved reconciliation.

Mailbox checks retry each link's existing durable receipts before approval
refresh. Per-clinic portal/approval failures are returned as typed, content-free
issues while independent links continue. Global lock, cancellation, corruption,
recovery or storage failures still stop the operation. Saved documents with an
unconfirmed receipt remain pending and preserve the exact compact bytes for the
next check; pending count and clinic guidance are shown together with progress.

#### Format 8: clinic documents that failed their checks (#143)

Format 8 adds one manifest list, `refusedDeliveries`. When a clinic delivery
fails its checks (it does not decrypt or open, its signed PDF is not verified for
this link, what the PDF says differs from its envelope, or a delivery already
filed is listed again with another hash), the vault remembers what the portal's
listing said of it: `linkId`, `deliveryId`, `ciphertextSha256`, `refusedAtMs`
and the delivery's own `expiresAt` (seconds; however far off the portal sets it,
no later than 8 days after the refusal: a delivery's 7 days and the day's grace
after them). Nothing from inside the document is kept, and
the portal is not told: the refusal stays on this device (Ben, 29 Oct).

A check for new documents, and the check after unlocking, skip a listed delivery
whose link, id and hash match a remembered refusal that has not expired, without
downloading it. So the patient is told once, and the clinic's card says how many
of its documents could not be verified. The same id with another hash is a
different document and is checked again. Try again (`vault_forget_refused_deliveries`)
forgets a clinic's refusals, so the next check checks them again. A refusal is
dropped once its delivery has expired. A check that could not be made, such as a
missing or failed PDF helper, a cancelled check, bytes that do not match the
listing (which may be a damaged download), or a package version newer than this
build reads (which an update may open), is not remembered: that delivery is
tried again next time, as before.

The list is kept apart from `portalLinks`, so that the link a check is working
from stays as saved while refusals are added. It holds at most 100 refusals per
link. Those kept stay until they expire or Try again; a further refusal is not
remembered (dropping a kept one would only have it downloaded and refused again).
Forgetting expired refusals at the start of a check is only tidying: if it cannot
be written, the check goes on. Each remembered refusal and each Try again is recorded
in the history (`deliveryRefused`, `deliveryRefusalsCleared`) in the same commit. A
manifest below format 8 that holds refusals is corrupt, as is a refusal for no
saved link, a second refusal for one delivery, more than 100 for a link, or a
malformed id, hash or expiry.

A format 1–7 vault opens with no refusals and is upgraded to format 8 at its next
writable unlock, in a commit of its own, as for every earlier format. An older
myCarlos then refuses the vault as newer: there is no downgrade. Header/object
formats and the delivery wire format are unchanged.

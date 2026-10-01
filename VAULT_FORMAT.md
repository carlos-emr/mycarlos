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
the request as the IPC layer parsed it.

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
a new vault shows: the passphrase just typed authorizes it, and the dialog has no Cancel and ignores
Escape. It offers "Set up later" once something other than a wrong answer has failed. A lock ends it
all the same (on a phone, switching apps locks), and so does a failure to make the key; the vault
then has no recovery key and says so in a banner until one is set up. Unlocking a vault that has no
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
  vault-v1.reset-pending/ retired vault awaiting completion of an already-confirmed reset
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
    staging/<job-id>/    incomplete imports, removed after failure or next unlock
```

Nothing but these entries is ever written to the home, and the home is created private. That is
what lets a readable export refuse every destination inside it without a list of protected names:
saving a copy over the lock file, or as a regular file under the pending-reset name, would
otherwise let a second instance open the vault or block every later unlock.

An exclusive OS file lock is held throughout each unlocked session and during creation, reset,
and startup recovery. Another app instance receives an `in_use` error before it can read mutable
state or perform cleanup. Locking or closing the owning session releases ownership; the next
instance must unlock and load the current manifests. The lock file lives outside the vault so
reset cannot replace the inode/handle being locked. It contains no secret material.

Whole-vault reset renames the vault to the fixed `vault-v1.reset-pending/` sibling before removing
key envelopes and the remaining files. Startup status, creation, unlock, and reset all finish this
cleanup under the same OS lock before proceeding. A cleanup error is surfaced and blocks access
and creation until retry succeeds. Symlink/reparse-point reset directories are rejected. Abrupt-exit
tests cover the rename and key-removal boundaries; physical power-cut and filesystem durability
validation remain release gates.

The encrypted manifest contains profiles, nested folders, folder assignments, sanitized document
names that the patient may rename, sizes, timestamps, unverified-source labels, per-record
fingerprints, opaque object names, and wrapped content keys. Mutations write the same logical state
into two consecutive generations using a cross-platform atomic replacement primitive. Once the first
generation is durable, the logical mutation is committed; failure of the redundant write is
reported in the snapshot as recovery mode rather than as a failed mutation. Unlock authenticates both slots, selects
the highest valid generation whose objects exist, rejects divergent authenticated states at the same
generation, and repairs only missing or damaged redundancy. If repair cannot write because storage
is full, unlock still permits read/export access in recovery mode. Staging and definite precommit
orphan objects are removed without relying on a later unlock. The atomic replacement primitive
stages each header or manifest in an `.atomicwrite*` directory beside it; one that a killed process
left behind may still hold a superseded wrapped key, so a writable unlock and reset remove them.

Three cases open the vault in recovery mode without writing to the vault at all: no repair, no
staging cleanup, and no orphan removal. (Before any header is read, an unlock takes the lock file
beside the vault and finishes a reset or restore that an earlier run left unfinished.) First, if no authentic generation has all of its objects, unlock
selects the newest authentic manifest anyway, reports each record whose object is missing or is not
a regular file as unavailable, and refuses to export those records; the remaining records stay
exportable, so one lost object no longer leaves whole-vault reset as the only action. The same
applies when an older generation is complete but the newest authentic one also references an intact
object the older one lacks: falling back would overwrite the newer manifest and delete that object
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
choose to remove the damaged documents. Removal re-checks the disk first, drops only records that
were shown as damaged and whose object is still missing (if another has gone missing since, it
removes nothing and shows that one too), commits the now-complete manifest through the ordinary two-generation
write, and leaves recovery mode; a file that came back is kept. `unreadableSlot`: a manifest or
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

Individual deletion commits a manifest without the record into one slot, unlinks the ciphertext,
then commits the same state at a newer generation into the other slot. Both live manifests
therefore omit the wrapped per-object key after a successful operation. If unlinking fails, the
second commit still makes the object an undecryptable orphan and unlock cleanup retries its
removal. This local cryptographic-erasure
property does not remove previously exported plaintext or old copies held by filesystem snapshots,
device backups, or a future synchronization service. Those systems require explicit tombstones and
retention rules. No viewer, synchronization, analytics, or CARLOS provenance is implemented.

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
dialog, which permanently removes all local profiles and records. OS cloud backup is to be excluded
where the platform permits, now that the portable backup exists; that is separate, per-platform
work.

### Portable encrypted backup

A backup is one `.mycarlosbackup` file holding the vault's ciphertext as the patient sees it. Every
document is authenticated as it is copied, so a damaged one fails the backup, naming the problem
while the vault is still there, rather than the restore. The refusal carries that document's id
(never its name), and the screen names the document, so that the patient can delete it, or add it
again from another copy, and back up the rest.

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
5. renames the verified stage to `vault-v1.restore-ready/`, then retires the live vault to
   `vault-v1.reset-pending/` and renames the restore into place;
6. erases the retired vault as a reset does, key envelopes first.

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
is already retired, then finish erasing a retired vault, then activate a restore still waiting.
A failure to erase the retired vault after the restore is in place is not a failed restore; the
erasing is retried at every start. The restored
vault is left locked; it opens with the passphrase or recovery key it was backed up with. The
restore always takes the whole backup: an older backup brings back documents deleted since, and
the passphrase and recovery key it was made with, and the screen and the native dialog say so
before the patient agrees. On Android a backup is written straight to the document the provider
returns, so a failed or cancelled save leaves an incomplete file there (which a restore refuses)
in place of what that document held. Everything that would refuse the backup is therefore checked
first, as the backup checks it (a read-only vault, the header, the manifest slot, every document),
before that document is opened and emptied; only a failure while the backup is written, or a lock
or change that comes between the check and the writing, can leave it emptied.

## Known limits before release

- Rollback across an externally restored pair of otherwise valid manifest slots is not detected.
- Changing the passphrase or replacing the recovery key does not change the master key. Someone who
  has the earlier passphrase or key, and any earlier copy of a header (a device backup, a copied
  folder, a saved backup file), has the master key, which decrypts the vault as it is now and
  later, whenever they get a copy of it. Rotating the master key is not implemented; it is
  planned for after the first release, and until then this limit is accepted. The
  only remedy is a new vault, which the app does not guide: save a readable copy of every document
  (one at a time, in every profile; a damaged document cannot be saved), check that each copy
  opens, erase the vault, create a new one and import the copies. Folders, profiles and the dates
  added are not kept, the saved copies are not encrypted while they wait, and the recovery key and
  earlier backups belong to the earlier vault: restoring one brings the earlier master key back.
  The earlier passphrase does not itself open a later copy of the vault; the master key taken from
  the earlier copy does.
- Restoring an older valid pair of header slots can restore an older passphrase wrapper, or an older
  recovery-key envelope, for the unchanged master key. Patient-pilot backup, recovery-key rotation, and device synchronization must define
  and enforce key-envelope rollback protection.
- Individual deletion has no backup/synchronization tombstone or verified secure-erasure guarantee
  for storage media, snapshots, exported plaintext, or copies outside the live vault.
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

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
- **Implemented recovery:** the patient passphrase; there is no vendor key or recovery code
- **Approved patient-pilot recovery:** a patient-held recovery key; not implemented in format v1

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
that practical.

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
other length, composition, and strength rule applies to the normalized form. A production breach corpus, independent threshold review, and the patient-held
recovery key remain patient-pilot work.

## Files and transactions

```text
vault-home/               holds only what the vault manages; back up as a whole
  vault-v1.lock           stable OS lock file; never rename or delete while the app is running
  vault-v1.reset-pending/ retired vault awaiting completion of an already-confirmed reset
  .create-<uuid>/         a vault being created, renamed into place once complete
  pending-exports/<uuid>  one per desktop export not yet cleaned up, naming its staging folder
  vault-v1/
    header-0.json        non-secret KDF configuration, wrapped master key, and keyed integrity tag
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

Two cases open the vault in recovery mode without writing to storage at all: no repair, no staging
cleanup, and no orphan removal. First, if no authentic generation has all of its objects, unlock
selects the newest authentic manifest anyway, reports each record whose object is missing or is not
a regular file as unavailable, and refuses to export those records; the remaining records stay
exportable, so one lost object no longer leaves whole-vault reset as the only action. The same
applies when an older generation is complete but the newest authentic one also references an intact
object the older one lacks: falling back would overwrite the newer manifest and delete that object
as an orphan, so the newest generation is opened read-only instead. Second, if a
manifest slot exists but cannot be read (for example a sharing violation or device error), that
slot may hold the newest committed state, so unlock does not repair over it or remove the objects
it may reference. An absent, oversized, or non-regular slot is still treated as damage that repair
replaces. A header slot that exists but cannot be read is likewise never rewrapped over, because it
may hold a newer passphrase generation; the session opens in recovery mode instead.

The snapshot names the reason for recovery mode, because each has its own way out. `lostObjects`:
some records' ciphertext is missing; the patient can restore the vault folder from a backup, or
choose to remove the damaged documents. Removal re-checks the disk first, drops only records whose
object is still missing, commits the now-complete manifest through the ordinary two-generation
write, and leaves recovery mode; a file that came back is kept. `unreadableSlot`: a manifest or
header slot could not be read and may be newer than what was opened, so nothing is written, not
even a removal, until a later unlock can read it. `writeFailed`: a redundant write or repair failed;
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
still need a future explicit encrypted export/restore flow and physical OEM transfer testing.

Losing the passphrase means losing access. The only fallback is a typed-confirmation whole-vault
reset followed by a trusted native confirmation dialog. It permanently removes all local profiles
and records.

The patient-pilot target in [`PRODUCT_DECISIONS.md`](PRODUCT_DECISIONS.md) replaces this limitation
with a patient-held recovery kit and portable authenticated encrypted backups. That target is not
implemented by format v1. OS cloud backup is to be excluded where the platform permits once the
portable backup flow exists.

## Known limits before release

- Rollback across an externally restored pair of otherwise valid manifest slots is not detected.
- Restoring an older valid pair of header slots can restore an older passphrase wrapper for the unchanged
  master key. Patient-pilot backup, recovery-key rotation, and device synchronization must define
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

use crate::idle::IdleDeadline;
use argon2::{Algorithm, Argon2, Params, Version};
use atomicwrites::{AllowOverwrite, AtomicFile, Error as AtomicWriteError};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard, PoisonError,
    },
    time::{Duration, Instant},
};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};
use zxcvbn::{zxcvbn, Score};

const VAULT_FORMAT: u32 = 1;
/// Header format 2 adds the optional recovery-key envelope. Format 1 headers
/// are still read; every header written now is format 2, so a vault moves to
/// format 2 at its next header write. An older build refuses a format 2 header.
const HEADER_FORMAT: u32 = 2;
const HEADER_FORMAT_V1: u32 = 1;
/// A recovery key is 128 random bits. It is shown as 26 Crockford base32
/// characters plus 2 check characters, in 7 groups of 4.
const RECOVERY_KEY_BYTES: usize = 16;
const RECOVERY_KEY_GROUPS: usize = 7;
const RECOVERY_KEY_GROUP_LEN: usize = 4;
const CROCKFORD_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const OBJECT_MAGIC: &[u8; 5] = b"MCVO1";
const CHUNK_SIZE: usize = 1024 * 1024;
pub(crate) const MAX_IMPORT_FILES: usize = 100;
pub(crate) const MAX_FOLDER_ASSIGNMENTS: usize = 1_000;
const MIN_PASSPHRASE_CHARS: usize = 15;
const MAX_PASSPHRASE_BYTES: usize = 1024;
const CREATE_STAGE_PREFIX: &str = ".create-";
// The atomic-write primitive stages each file in a directory with this prefix,
// beside the file it replaces.
const ATOMIC_WRITE_PREFIX: &str = ".atomicwrite";
// A desktop export stages its readable copy in a folder with this prefix and a
// UUID, beside the destination, so the final rename is atomic.
const EXPORT_STAGE_PREFIX: &str = ".mycarlos-export-";
// In the vault home: one file per export not yet cleaned up, naming its
// staging folder, so a readable copy left by a process that died is removed at
// the next start.
const EXPORT_JOURNAL: &str = "pending-exports";
// Exports under way in this process, by id. Plaintext is only written while a
// session is open, and while it is, only this process can sweep: the sweep
// skips these rather than every export holding the session throughout, which
// would keep a lock waiting behind a slow destination's final sync.
static EXPORTS_IN_FLIGHT: Mutex<BTreeSet<Uuid>> = Mutex::new(BTreeSet::new());
// A journal entry holds one path; anything longer is not one of ours.
const MAX_EXPORT_JOURNAL_BYTES: usize = 64 * 1024;
// Names Windows reserves for devices. A file whose name before its first dot
// is one of these, with ASCII letters in any case and any ASCII spaces
// (U+0020) before the dot, cannot be created, so `sanitize_basename` prefixes it. The rename
// dialog lists the same names (src/native/reservedNames.ts) to say why such a
// name is refused.
const RESERVED_DEVICE_NAMES: [&str; 32] = [
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "CONIN$",
    "CONOUT$",
    "COM\u{b9}",
    "COM\u{b2}",
    "COM\u{b3}",
    "LPT\u{b9}",
    "LPT\u{b2}",
    "LPT\u{b3}",
    "COM0",
    "LPT0",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
];
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_MANIFEST_BYTES: usize = 16 * 1024 * 1024;
// The sanitizer caps record names at this many bytes and manifest validation
// caps them at this many characters. A name never has more characters than
// bytes, so every sanitized name passes validation when it is read back.
const MAX_RECORD_NAME_LEN: usize = 240;
const ARGON_MEMORY_KIB: u32 = 64 * 1024;
const ARGON_ITERATIONS: u32 = 3;
const ARGON_LANES: u32 = 4;
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

#[cfg(test)]
const TEST_TERMINATION_EXIT_CODE: i32 = 86;

#[cfg(test)]
fn terminate_at_test_boundary(boundary: &str) {
    if std::env::var("MYCARLOS_TEST_TERMINATE_AT").as_deref() == Ok(boundary) {
        std::process::exit(TEST_TERMINATION_EXIT_CODE);
    }
}

#[cfg(not(test))]
fn terminate_at_test_boundary(_boundary: &str) {}

/// A test's action, and the boundary to run it at.
#[cfg(test)]
type TestBoundaryAction = Option<(&'static str, Box<dyn Fn()>)>;

#[cfg(test)]
thread_local! {
    /// A test's action to run when this thread reaches the named boundary.
    static AT_TEST_BOUNDARY: std::cell::RefCell<TestBoundaryAction> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn run_at_test_boundary(boundary: &str) {
    let action = AT_TEST_BOUNDARY.with(|slot| {
        slot.borrow_mut()
            .take_if(|(name, _)| *name == boundary)
            .map(|(_, action)| action)
    });
    if let Some(action) = action {
        action();
    }
}

#[cfg(not(test))]
fn run_at_test_boundary(_boundary: &str) {}

#[cfg(test)]
thread_local! {
    /// Boundaries that fail on this thread only, so that tests running
    /// beside this one are not failed too.
    static FAIL_AT_TEST_BOUNDARY: std::cell::Cell<&'static [&'static str]> =
        const { std::cell::Cell::new(&[]) };
}

#[cfg(test)]
fn fail_at_test_boundary(boundary: &str) -> Result<(), VaultError> {
    if FAIL_AT_TEST_BOUNDARY.get().contains(&boundary)
        || std::env::var("MYCARLOS_TEST_FAIL_AT").as_deref() == Ok(boundary)
    {
        Err(VaultError::NoSpace)
    } else {
        Ok(())
    }
}

#[cfg(not(test))]
fn fail_at_test_boundary(_boundary: &str) -> Result<(), VaultError> {
    Ok(())
}

type HmacSha256 = Hmac<Sha256>;
type SecretKey = Zeroizing<[u8; 32]>;

#[derive(Debug)]
struct CancelledIo;

impl std::fmt::Display for CancelledIo {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("vault locking")
    }
}

impl std::error::Error for CancelledIo {}

fn cancelled_io_error() -> io::Error {
    io::Error::other(CancelledIo)
}

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("the vault has already been created")]
    AlreadyExists,
    #[error("the vault has not been created")]
    Missing,
    #[error("the vault is locked")]
    Locked,
    #[error("the vault is open in another app instance")]
    InUse,
    #[error("the passphrase is incorrect")]
    WrongPassphrase,
    #[error("the vault data is damaged or incomplete")]
    Corrupt,
    #[error("the requested item does not exist")]
    NotFound,
    #[error("the requested change is not valid")]
    Invalid,
    #[error("the passphrase is too easy to guess")]
    WeakPassphrase,
    #[error("too many files were selected for one import")]
    ImportBatchLimit,
    #[error("there is not enough space to complete the operation")]
    NoSpace,
    #[error("the storage operation could not be completed")]
    Storage,
    #[error("the operation was cancelled because the vault is locking")]
    Cancelled,
    #[error("the vault is in read-only recovery mode")]
    RecoveryMode,
    #[error("this storage cannot hold the vault safely")]
    UnsupportedStorage,
    #[error("the recovery key is not typed correctly")]
    RecoveryKeyTypo,
    #[error("the recovery key does not open this vault")]
    WrongRecoveryKey,
    #[error("the file is not a complete, unchanged myCarlos backup")]
    BackupUnreadable,
    #[error("the backup or the vault is not what was confirmed")]
    BackupChanged,
    #[error("the backup file could not be opened")]
    BackupNotOpened,
    #[error("a document does not authenticate, so the vault cannot be backed up")]
    DamagedDocument(Uuid),
    #[error("the restore was verified, but could not yet take the vault's place")]
    RestoreUnfinished,
}

impl From<io::Error> for VaultError {
    fn from(error: io::Error) -> Self {
        if error
            .get_ref()
            .and_then(|source| source.downcast_ref::<CancelledIo>())
            .is_some()
        {
            Self::Cancelled
        } else if matches!(
            error.kind(),
            io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded
        ) {
            // The kinds cover ENOSPC and EDQUOT on Unix and the disk-full and
            // quota codes on Windows, where raw code 28 means something else.
            Self::NoSpace
        } else {
            Self::Storage
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KdfConfig {
    algorithm: String,
    version: u32,
    memory_kib: u32,
    iterations: u32,
    lanes: u32,
    salt: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WrappedSecret {
    nonce: String,
    ciphertext: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultHeader {
    magic: String,
    format_version: u32,
    vault_id: Uuid,
    #[serde(default)]
    generation: u64,
    kdf: KdfConfig,
    wrapped_master_key: WrappedSecret,
    /// The master key wrapped under the patient's recovery key, if one is set
    /// up. Format 2 only; a format 1 header has none.
    #[serde(default)]
    recovery: Option<RecoveryEnvelope>,
    #[serde(default)]
    integrity_tag: String,
}

/// The master key wrapped under a key derived from the recovery key. It does
/// not depend on the header generation, so every header write copies it
/// forward unchanged; the header's integrity tag binds it to each generation.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryEnvelope {
    /// Which recovery key this is. Not secret.
    key_id: Uuid,
    created_at_ms: u64,
    wrapped_master_key: WrappedSecret,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatientProfile {
    pub id: Uuid,
    pub display_name: String,
    pub created_at_ms: u64,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFolder {
    pub id: Uuid,
    pub profile_id: Uuid,
    pub parent_id: Option<Uuid>,
    pub name: String,
    pub created_at_ms: u64,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRecord {
    id: Uuid,
    profile_id: Uuid,
    folder_ids: Vec<Uuid>,
    display_name: String,
    source_label: String,
    media_type: String,
    plaintext_size: u64,
    imported_at_ms: u64,
    object_name: String,
    fingerprint: String,
    wrapped_object_key: WrappedSecret,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format_version: u32,
    vault_id: Uuid,
    generation: u64,
    profiles: Vec<PatientProfile>,
    folders: Vec<VaultFolder>,
    records: Vec<StoredRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultRecord {
    pub id: Uuid,
    pub profile_id: Uuid,
    pub folder_ids: Vec<Uuid>,
    pub display_name: String,
    pub source_label: String,
    pub media_type: String,
    pub plaintext_size: u64,
    pub imported_at_ms: u64,
    /// False when the encrypted object was missing at unlock and cannot be exported.
    pub available: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSnapshot {
    pub profiles: Vec<PatientProfile>,
    pub folders: Vec<VaultFolder>,
    pub records: Vec<VaultRecord>,
    /// Why the session is read-only, if it is.
    pub recovery: Option<RecoveryReason>,
    /// When the vault's recovery key was set up, if it has one.
    pub recovery_key_set_at_ms: Option<u64>,
}

/// Why an unlocked session refuses changes. Each reason has its own way out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryReason {
    /// Some records' ciphertext is missing. Their intact neighbours can be
    /// exported, and `remove_unavailable_records` makes the vault writable
    /// again once the user gives them up (or restores them from a backup).
    LostObjects,
    /// A manifest or header slot exists but could not be read. It may hold a
    /// newer state than the one opened, so nothing on disk may be replaced.
    /// Clears itself on a later unlock once the slot can be read.
    UnreadableSlot,
    /// A redundant write or a repair failed. Storage is not reliable enough
    /// to commit; a later unlock retries the repair.
    WriteFailed,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VaultStatus {
    Absent,
    Locked,
    Unlocked,
}

pub struct ImportSource {
    pub display_name: String,
    pub reader: Box<dyn Read + Send>,
}

struct CancellableReader {
    inner: Box<dyn Read + Send>,
    cancelled: Arc<AtomicBool>,
    idle: Option<Arc<IdleDeadline>>,
}

impl CancellableReader {
    fn new(inner: Box<dyn Read + Send>, cancelled: Arc<AtomicBool>) -> Self {
        Self {
            inner,
            cancelled,
            idle: None,
        }
    }

    /// Counts each read that moves data as activity: a transfer that is making
    /// progress keeps the session unlocked, however slowly, and one blocked in
    /// a read does not.
    fn with_progress(mut self, idle: &Arc<IdleDeadline>) -> Self {
        self.idle = Some(Arc::clone(idle));
        self
    }
}

impl Read for CancellableReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(cancelled_io_error());
        }
        let count = self.inner.read(buffer)?;
        if count > 0 {
            if let Some(idle) = &self.idle {
                idle.touch(Instant::now());
            }
        }
        Ok(count)
    }
}

struct CancellableWriter<W> {
    inner: W,
    cancelled: Arc<AtomicBool>,
    idle: Option<Arc<IdleDeadline>>,
}

impl<W> CancellableWriter<W> {
    fn new(inner: W, cancelled: Arc<AtomicBool>) -> Self {
        Self {
            inner,
            cancelled,
            idle: None,
        }
    }

    /// As for `CancellableReader::with_progress`.
    fn with_progress(mut self, idle: &Arc<IdleDeadline>) -> Self {
        self.idle = Some(Arc::clone(idle));
        self
    }
}

impl<W: Write> Write for CancellableWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(cancelled_io_error());
        }
        let count = self.inner.write(buffer)?;
        if count > 0 {
            if let Some(idle) = &self.idle {
                idle.touch(Instant::now());
            }
        }
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(cancelled_io_error());
        }
        self.inner.flush()
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub imported: Vec<Uuid>,
    pub skipped_duplicates: Vec<String>,
}

/// A recovery key shown to the patient and not yet confirmed, with the key
/// derived from the passphrase that authorized it, for the header write.
struct PendingRecoveryKey {
    key: Zeroizing<[u8; RECOVERY_KEY_BYTES]>,
    kdf: KdfConfig,
    wrapping_key: SecretKey,
}

struct UnlockedVault {
    master_key: Zeroizing<[u8; 32]>,
    // When the header's recovery key was set up, if it has one.
    recovery_key_set_at_ms: Option<u64>,
    // A recovery key shown to the patient and not yet confirmed.
    pending_recovery_key: Option<PendingRecoveryKey>,
    manifest: Manifest,
    recovery: Option<RecoveryReason>,
    // Records whose object was missing at unlock. Only populated in recovery mode.
    unavailable: HashSet<Uuid>,
    // Keep the OS lock until the session (and any operation using it) ends.
    storage_lock: Arc<File>,
}

pub struct VaultStore {
    root: PathBuf,
    unlocked: Mutex<Option<UnlockedVault>>,
    cancel_io: Arc<AtomicBool>,
    idle: Arc<IdleDeadline>,
}

impl VaultStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            unlocked: Mutex::new(None),
            cancel_io: Arc::new(AtomicBool::new(false)),
            idle: Arc::new(IdleDeadline::new(Instant::now())),
        }
    }

    /// The session's idle deadline, which the app's native timer checks.
    pub fn idle(&self) -> &Arc<IdleDeadline> {
        &self.idle
    }

    /// Takes the session mutex. A panic while it was held may have left the
    /// session half-updated, so a poisoned session is dropped, which locks the
    /// vault and its keys, instead of being reused. Clearing the poison keeps
    /// every later call from panicking until the app is restarted.
    fn session(&self) -> MutexGuard<'_, Option<UnlockedVault>> {
        self.unlocked.lock().unwrap_or_else(|poisoned| {
            let mut guard = poisoned.into_inner();
            *guard = None;
            self.idle.disarm();
            self.unlocked.clear_poison();
            guard
        })
    }

    pub fn status(&self) -> Result<VaultStatus, VaultError> {
        let guard = self.session();
        if guard.is_some() {
            return Ok(VaultStatus::Unlocked);
        }
        let _storage_lock = acquire_storage_lock(&self.root)?;
        finish_pending_resets(&self.root)?;
        Ok(if self.root.exists() {
            VaultStatus::Locked
        } else {
            VaultStatus::Absent
        })
    }

    pub fn create(
        &self,
        passphrase: &str,
        initial_profile: &str,
        now_ms: u64,
    ) -> Result<(), VaultError> {
        validate_name(initial_profile)?;
        validate_new_passphrase(passphrase, &[initial_profile])?;
        let mut guard = self.session();
        if guard.is_some() {
            return Err(VaultError::AlreadyExists);
        }
        let storage_lock = acquire_storage_lock(&self.root)?;
        finish_pending_resets(&self.root)?;
        self.cancel_io.store(false, Ordering::Release);
        if self.root.exists() {
            return Err(VaultError::AlreadyExists);
        }

        let parent = self.root.parent().ok_or(VaultError::Storage)?;
        fs::create_dir_all(parent)?;
        let stage = parent.join(format!("{CREATE_STAGE_PREFIX}{}", Uuid::new_v4()));
        create_private_dir(&stage)?;

        let result = (|| {
            ensure_storage_supports_directory_sync(&stage)?;
            // Inside the closure so that a failure here also removes the stage.
            create_private_dir(&stage.join("objects"))?;
            create_private_dir(&stage.join("staging"))?;
            let vault_id = Uuid::new_v4();
            let mut master_key = Zeroizing::new([0_u8; 32]);
            OsRng.fill_bytes(master_key.as_mut());
            let (kdf, wrapping_key) = new_passphrase_key(passphrase)?;
            let (first_header, second_header) =
                build_header_pair_with_key(vault_id, 1, &kdf, &wrapping_key, &master_key, None)?;
            atomic_json(&header_path(&stage, first_header.generation), &first_header)?;
            atomic_json(
                &header_path(&stage, second_header.generation),
                &second_header,
            )?;

            let mut manifest = Manifest {
                format_version: VAULT_FORMAT,
                vault_id,
                generation: 1,
                profiles: vec![PatientProfile {
                    id: Uuid::new_v4(),
                    display_name: initial_profile.trim().to_owned(),
                    created_at_ms: now_ms,
                }],
                folders: Vec::new(),
                records: Vec::new(),
            };
            write_valid_manifest_at(&stage, &master_key, &manifest)?;
            manifest.generation = manifest
                .generation
                .checked_add(1)
                .ok_or(VaultError::Storage)?;
            write_valid_manifest_at(&stage, &master_key, &manifest)?;
            sync_parent(&stage);
            fs::rename(&stage, &self.root)?;
            sync_parent(parent);
            self.open_session(
                &mut guard,
                UnlockedVault {
                    storage_lock,
                    master_key,
                    recovery_key_set_at_ms: None,
                    pending_recovery_key: None,
                    manifest,
                    recovery: None,
                    unavailable: HashSet::new(),
                },
            );
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&stage);
        }
        result
    }

    pub fn unlock(&self, passphrase: &str) -> Result<(), VaultError> {
        if passphrase.len() > MAX_PASSPHRASE_BYTES {
            return Err(VaultError::Invalid);
        }
        let mut guard = self.session();
        let storage_lock = match guard.as_ref() {
            Some(unlocked) => Arc::clone(&unlocked.storage_lock),
            None => acquire_storage_lock(&self.root)?,
        };
        finish_pending_resets(&self.root)?;
        self.cancel_io.store(false, Ordering::Release);
        let (header, master_key, wrapping_key) =
            read_header_for_passphrase(&self.root, passphrase)?;
        self.open_with_header(&mut guard, storage_lock, header, master_key, wrapping_key)
    }

    /// The rest of an unlock, once a header and its keys are authenticated:
    /// choose the manifest, repair redundancy where that is safe, and open
    /// the session.
    fn open_with_header(
        &self,
        guard: &mut Option<UnlockedVault>,
        storage_lock: Arc<File>,
        header: VaultHeader,
        master_key: SecretKey,
        wrapping_key: SecretKey,
    ) -> Result<(), VaultError> {
        let recovery_key_set_at_ms = header
            .recovery
            .as_ref()
            .map(|envelope| envelope.created_at_ms);
        let slots = read_manifest_slots(&self.root, &master_key, header.vault_id)?;
        let SelectedManifest {
            manifest,
            unavailable,
            mut recovery,
        } = select_manifest(&slots)?;
        if recovery == Some(RecoveryReason::LostObjects) && header_slot_unreadable(&self.root) {
            // `select_manifest` only sees the manifest slots. A header slot that
            // cannot be read outranks lost objects for the same reason an
            // unreadable manifest slot does: removing the lost records would
            // make the session writable, and a passphrase change could then
            // rewrap the key over a newer generation held in that slot.
            recovery = Some(RecoveryReason::UnreadableSlot);
        }
        if recovery.is_some() {
            // Leave storage exactly as found: no redundancy repair, no staging or
            // orphan cleanup. The session can only read and export.
            self.open_session(
                guard,
                UnlockedVault {
                    storage_lock,
                    master_key,
                    recovery_key_set_at_ms,
                    pending_recovery_key: None,
                    manifest,
                    recovery,
                    unavailable,
                },
            );
            return Ok(());
        }
        let manifest_healthy = manifest_redundancy_healthy(&slots, &manifest);
        let header_healthy =
            header_redundancy_healthy(&self.root, &header, &wrapping_key, &master_key);
        let mut recovery = None;
        let manifest = if manifest_healthy {
            manifest
        } else {
            match repair_manifest_redundancy(&self.root, &master_key, manifest.clone()) {
                Ok(repaired) => repaired,
                Err(VaultError::NoSpace | VaultError::Storage) => {
                    recovery = Some(RecoveryReason::WriteFailed);
                    manifest
                }
                Err(error) => return Err(error),
            }
        };
        if !header_healthy {
            if header_slot_unreadable(&self.root) {
                // Repair rewrites both slots under the passphrase just used. A
                // slot that could not be read may be a newer passphrase
                // generation, which that would silently roll back.
                recovery = Some(RecoveryReason::UnreadableSlot);
            } else {
                match repair_header_redundancy(&self.root, &header, &wrapping_key, &master_key) {
                    Ok(()) => {}
                    Err(VaultError::NoSpace | VaultError::Storage) => {
                        recovery = Some(RecoveryReason::WriteFailed);
                    }
                    Err(error) => return Err(error),
                }
            }
        } else {
            // Both slots are authentic and current, so a legacy envelope has been
            // superseded. Its removal is best effort where the slots are written;
            // retry here so a failure then does not leave a key wrapped under an
            // earlier passphrase on disk for good.
            let _ = fs::remove_file(self.root.join(LEGACY_HEADER));
        }
        if ensure_objects_dir(&self.root).is_err() {
            recovery = Some(RecoveryReason::WriteFailed);
        }
        remove_staging(&self.root);
        remove_abandoned_atomic_writes(&self.root);
        remove_orphan_objects(&self.root, &manifest);
        self.open_session(
            guard,
            UnlockedVault {
                storage_lock,
                master_key,
                recovery_key_set_at_ms,
                pending_recovery_key: None,
                manifest,
                recovery,
                unavailable,
            },
        );
        Ok(())
    }

    /// Every unlocked session has an idle deadline, started with it under the
    /// session lock.
    fn open_session(&self, guard: &mut Option<UnlockedVault>, vault: UnlockedVault) {
        *guard = Some(vault);
        self.idle.arm(Instant::now());
    }

    pub fn lock(&self) {
        self.lock_if(|| true);
    }

    /// Locks the vault if it has been idle past its deadline at `now`. Returns
    /// whether it locked.
    pub fn lock_if_idle(&self, now: Instant) -> bool {
        self.idle.is_due(now) && self.lock_if(|| self.idle.is_due(now))
    }

    /// Cancels any transfer, then clears the session if `due` still holds once
    /// the session lock is taken: an unlock may have started a new session
    /// while this waited for the lock. The cancel must come first, since a
    /// transfer holds the session lock until it stops; in the rare race where
    /// a new session starts, or activity arrives, while it waits, it can stop
    /// a transfer without locking.
    fn lock_if(&self, due: impl Fn() -> bool) -> bool {
        self.cancel_io.store(true, Ordering::Release);
        let locked = {
            let mut guard = self.session();
            // Disarmed under the session lock, so an unlock cannot slip between
            // the two and be left unlocked with no deadline.
            let due = due();
            if due {
                *guard = None;
                self.idle.disarm();
            }
            due
        };
        self.cancel_io.store(false, Ordering::Release);
        locked
    }

    /// Fails unless the vault is unlocked, writable, and owns `profile_id`.
    ///
    /// Lets a command refuse before it opens a native picker, so nobody chooses
    /// files for an import that is already certain to be rejected.
    pub fn ensure_import_allowed(&self, profile_id: Uuid) -> Result<(), VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        require_profile(&unlocked.manifest, profile_id)
    }

    pub fn snapshot(&self) -> Result<VaultSnapshot, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        Ok(VaultSnapshot {
            profiles: unlocked.manifest.profiles.clone(),
            folders: unlocked.manifest.folders.clone(),
            records: unlocked
                .manifest
                .records
                .iter()
                .map(|record| VaultRecord {
                    id: record.id,
                    profile_id: record.profile_id,
                    folder_ids: record.folder_ids.clone(),
                    display_name: record.display_name.clone(),
                    source_label: record.source_label.clone(),
                    media_type: record.media_type.clone(),
                    plaintext_size: record.plaintext_size,
                    imported_at_ms: record.imported_at_ms,
                    available: !unlocked.unavailable.contains(&record.id),
                })
                .collect(),
            recovery: unlocked.recovery,
            recovery_key_set_at_ms: unlocked.recovery_key_set_at_ms,
        })
    }

    pub fn create_profile(&self, display_name: &str, now_ms: u64) -> Result<Uuid, VaultError> {
        validate_name(display_name)?;
        self.mutate_manifest(|manifest| {
            let id = Uuid::new_v4();
            manifest.profiles.push(PatientProfile {
                id,
                display_name: display_name.trim().to_owned(),
                created_at_ms: now_ms,
            });
            Ok(id)
        })
    }

    pub fn create_folder(
        &self,
        profile_id: Uuid,
        parent_id: Option<Uuid>,
        name: &str,
        now_ms: u64,
    ) -> Result<Uuid, VaultError> {
        validate_name(name)?;
        self.mutate_manifest(|manifest| {
            require_profile(manifest, profile_id)?;
            if let Some(parent) = parent_id {
                let folder = manifest
                    .folders
                    .iter()
                    .find(|folder| folder.id == parent)
                    .ok_or(VaultError::NotFound)?;
                if folder.profile_id != profile_id {
                    return Err(VaultError::Invalid);
                }
                ensure_depth(manifest, Some(parent), 1)?;
            }
            let id = Uuid::new_v4();
            manifest.folders.push(VaultFolder {
                id,
                profile_id,
                parent_id,
                name: name.trim().to_owned(),
                created_at_ms: now_ms,
            });
            Ok(id)
        })
    }

    pub fn update_folder(
        &self,
        folder_id: Uuid,
        parent_id: Option<Uuid>,
        name: &str,
    ) -> Result<(), VaultError> {
        validate_name(name)?;
        self.mutate_manifest(|manifest| {
            let current = manifest
                .folders
                .iter()
                .find(|folder| folder.id == folder_id)
                .cloned()
                .ok_or(VaultError::NotFound)?;
            if parent_id == Some(folder_id) {
                return Err(VaultError::Invalid);
            }
            if let Some(parent) = parent_id {
                let parent_folder = manifest
                    .folders
                    .iter()
                    .find(|folder| folder.id == parent)
                    .ok_or(VaultError::NotFound)?;
                if parent_folder.profile_id != current.profile_id
                    || is_descendant(manifest, parent, folder_id)
                {
                    return Err(VaultError::Invalid);
                }
                ensure_depth(manifest, Some(parent), subtree_depth(manifest, folder_id)?)?;
            }
            let folder = manifest
                .folders
                .iter_mut()
                .find(|folder| folder.id == folder_id)
                .ok_or(VaultError::NotFound)?;
            folder.parent_id = parent_id;
            folder.name = name.trim().to_owned();
            Ok(())
        })
    }

    pub fn rename_record(&self, record_id: Uuid, name: &str) -> Result<(), VaultError> {
        let name = name.trim();
        // Display names also become export suggestions. Reject unsafe names instead
        // of silently changing the name the patient asked to save.
        if !valid_record_name(name) || sanitize_basename(name) != name {
            return Err(VaultError::Invalid);
        }
        self.mutate_manifest(|manifest| {
            let record = manifest
                .records
                .iter_mut()
                .find(|record| record.id == record_id)
                .ok_or(VaultError::NotFound)?;
            // The extension says what kind of file an export is; a rename
            // changes only the name before it, and neither removes ".pdf",
            // changes its case, nor adds it.
            // Both sides are judged trimmed, as `name` already is: an earlier
            // build could store "X.pdf" followed by a no-break space. A name
            // without ".pdf" cannot become one ending in it, not even ".pdf".
            let kept = file_extension(record.display_name.trim());
            if file_extension(name) != kept
                || (kept.is_empty() && name.to_ascii_lowercase().ends_with(".pdf"))
            {
                return Err(VaultError::Invalid);
            }
            record.display_name = name.to_owned();
            Ok(())
        })
    }

    pub fn assign_folders(&self, record_id: Uuid, folder_ids: Vec<Uuid>) -> Result<(), VaultError> {
        self.assign_folders_batch(vec![record_id], folder_ids)
    }

    pub fn assign_folders_batch(
        &self,
        record_ids: Vec<Uuid>,
        folder_ids: Vec<Uuid>,
    ) -> Result<(), VaultError> {
        if record_ids.is_empty()
            || record_ids.len() > MAX_FOLDER_ASSIGNMENTS
            || folder_ids.len() > MAX_FOLDER_ASSIGNMENTS
        {
            return Err(VaultError::Invalid);
        }
        self.mutate_manifest(|manifest| {
            let unique_record_ids: HashSet<Uuid> = record_ids.into_iter().collect();
            // Folder validity depends only on the owning profile, so check each
            // profile once rather than once per record. Record ids are unique
            // within a manifest, so one pass both finds and counts the targets.
            let mut profile_ids = HashSet::new();
            let mut found = 0_usize;
            for record in &manifest.records {
                if unique_record_ids.contains(&record.id) {
                    found += 1;
                    profile_ids.insert(record.profile_id);
                }
            }
            if found != unique_record_ids.len() {
                return Err(VaultError::NotFound);
            }
            let assignments = unique(folder_ids);
            for profile_id in profile_ids {
                validate_folder_ids(manifest, profile_id, &assignments)?;
            }
            for record in &mut manifest.records {
                if unique_record_ids.contains(&record.id) {
                    record.folder_ids = assignments.clone();
                }
            }
            Ok(())
        })
    }

    pub fn import(
        &self,
        profile_id: Uuid,
        folder_ids: Vec<Uuid>,
        sources: Vec<ImportSource>,
        now_ms: u64,
    ) -> Result<ImportOutcome, VaultError> {
        if sources.is_empty() {
            return Ok(ImportOutcome::default());
        }
        validate_import_count(sources.len())?;
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        require_profile(&unlocked.manifest, profile_id)?;
        validate_folder_ids(&unlocked.manifest, profile_id, &folder_ids)?;
        let folder_ids = unique(folder_ids);

        let job_id = Uuid::new_v4();
        let stage = self.root.join("staging").join(job_id.to_string());
        create_private_dir_all(&stage)?;
        let keys = derive_keys(unlocked.manifest.vault_id, &unlocked.master_key)?;
        let existing: HashSet<String> = unlocked
            .manifest
            .records
            .iter()
            .filter(|record| record.profile_id == profile_id)
            .map(|record| record.fingerprint.clone())
            .collect();
        let mut batch_fingerprints = HashSet::new();
        let mut staged = Vec::new();
        let mut skipped_duplicates = Vec::new();

        let result = (|| {
            for source in sources {
                let record_id = Uuid::new_v4();
                let object_name = format!("{}.mcobj", Uuid::new_v4());
                let object_path = stage.join(&object_name);
                let mut object_key = Zeroizing::new([0_u8; 32]);
                OsRng.fill_bytes(object_key.as_mut());
                let encrypted = encrypt_object(
                    Box::new(
                        CancellableReader::new(source.reader, Arc::clone(&self.cancel_io))
                            .with_progress(&self.idle),
                    ),
                    &object_path,
                    ObjectContext {
                        vault_id: unlocked.manifest.vault_id,
                        record_id,
                        profile_id,
                    },
                    &object_key,
                    &keys.fingerprint,
                )?;
                let fingerprint = BASE64.encode(encrypted.fingerprint);
                if existing.contains(&fingerprint)
                    || !batch_fingerprints.insert(fingerprint.clone())
                {
                    fs::remove_file(&object_path)?;
                    skipped_duplicates.push(sanitize_basename(&source.display_name));
                    continue;
                }
                verify_object(
                    &object_path,
                    CancellableWriter::new(io::sink(), Arc::clone(&self.cancel_io))
                        .with_progress(&self.idle),
                    unlocked.manifest.vault_id,
                    record_id,
                    &object_key,
                    encrypted.plaintext_size,
                )?;
                let wrapped_object_key =
                    wrap_secret(&keys.object_wrap, &object_key, record_id.as_bytes())?;
                staged.push((
                    object_path,
                    StoredRecord {
                        id: record_id,
                        profile_id,
                        folder_ids: folder_ids.clone(),
                        display_name: sanitize_basename(&source.display_name),
                        source_label: "Manual import — unverified".to_owned(),
                        media_type: "application/octet-stream".to_owned(),
                        plaintext_size: encrypted.plaintext_size,
                        imported_at_ms: now_ms,
                        object_name,
                        fingerprint,
                        wrapped_object_key,
                    },
                ));
            }
            if self.cancel_io.load(Ordering::Acquire) {
                return Err(VaultError::Cancelled);
            }
            if staged.is_empty() {
                // Every source was a duplicate. Nothing changed, so there is no
                // manifest to commit: a commit here could only fail, or leave
                // the session read-only, over an import that added nothing.
                return Ok(ImportOutcome {
                    imported: Vec::new(),
                    skipped_duplicates,
                });
            }
            terminate_at_test_boundary("import.after-staging");

            let objects = self.root.join("objects");
            for (path, record) in &staged {
                let destination = objects.join(&record.object_name);
                fs::rename(path, &destination)?;
            }
            // The manifest about to be committed references these objects. If
            // their directory entries are not durable, a power loss could leave
            // the newest manifest pointing at files that no longer exist.
            fail_at_test_boundary("import.objects-sync")?;
            sync_dir(&objects)?;
            if self.cancel_io.load(Ordering::Acquire) {
                return Err(VaultError::Cancelled);
            }
            terminate_at_test_boundary("import.after-object-rename");
            let mut next = unlocked.manifest.clone();
            next.records
                .extend(staged.iter().map(|(_, record)| record.clone()));
            let redundant = commit_manifest_redundant(
                &self.root,
                &unlocked.master_key,
                &mut unlocked.manifest,
                next,
                || Ok(()),
            )?;
            unlocked.recovery = (!redundant).then_some(RecoveryReason::WriteFailed);
            Ok(ImportOutcome {
                imported: staged.iter().map(|(_, record)| record.id).collect(),
                skipped_duplicates,
            })
        })();
        if result.is_err() {
            let objects = self.root.join("objects");
            for (_, record) in &staged {
                let _ = fs::remove_file(objects.join(&record.object_name));
            }
            sync_parent(&objects);
        }
        let _ = fs::remove_dir_all(&stage);
        result
    }

    pub fn export<W: Write>(&self, record_id: Uuid, writer: W) -> Result<(), VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        let record = unlocked
            .manifest
            .records
            .iter()
            .find(|record| record.id == record_id)
            .ok_or(VaultError::NotFound)?;
        if unlocked.unavailable.contains(&record.id) {
            return Err(VaultError::Corrupt);
        }
        let keys = derive_keys(unlocked.manifest.vault_id, &unlocked.master_key)?;
        let object_key = unwrap_secret(
            &keys.object_wrap,
            &record.wrapped_object_key,
            record.id.as_bytes(),
        )?;
        verify_object(
            &self.root.join("objects").join(&record.object_name),
            CancellableWriter::new(writer, Arc::clone(&self.cancel_io)).with_progress(&self.idle),
            unlocked.manifest.vault_id,
            record.id,
            &object_key,
            record.plaintext_size,
        )
    }

    pub fn export_name(&self, record_id: Uuid) -> Result<String, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        let record = unlocked
            .manifest
            .records
            .iter()
            .find(|record| record.id == record_id)
            .ok_or(VaultError::NotFound)?;
        // The name is asked for just before a save picker opens. Refuse here, as
        // `export` will, so nobody chooses a destination for a lost object.
        if unlocked.unavailable.contains(&record.id) {
            return Err(VaultError::Corrupt);
        }
        Ok(record.display_name.clone())
    }

    pub fn export_atomic(&self, record_id: Uuid, destination: &Path) -> Result<(), VaultError> {
        // The vault home holds only entries the vault manages: the vault, its
        // lock, a pending reset, a create stage, the export journal. No export
        // may land anywhere in it, whatever it is called, so the check needs no
        // list of names.
        let home = fs::canonicalize(vault_home(&self.root)?)?;
        let destination_parent = destination.parent().ok_or(VaultError::Invalid)?;
        if fs::canonicalize(destination_parent)?.starts_with(&home) {
            return Err(VaultError::Invalid);
        }

        // Refused before anything is journaled or staged.
        if self.session().is_none() {
            return Err(VaultError::Locked);
        }

        // Record the staging folder before a readable byte is written, so that
        // if this process dies the next start can remove what it left. If the
        // vault's own disk cannot take the entry, as when it is full and the
        // vault is in recovery mode, the export still runs: it may be the only
        // way to get a document out, and only a crash during it would leave an
        // untracked copy, as every export could before.
        let id = Uuid::new_v4();
        let _in_flight = ExportInFlight::new(id);
        let stage = destination_parent.join(format!("{EXPORT_STAGE_PREFIX}{id}"));
        let entry = journal_export(&self.root, id, &stage).ok();
        if let Err(error) = create_stage_dir(&stage) {
            if let Some(entry) = &entry {
                let _ = fs::remove_file(entry);
            }
            return Err(error);
        }

        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600);
        let result = AtomicFile::new_with_tmpdir(destination, AllowOverwrite, &stage)
            .write_with_options(
                |file| {
                    let written = self.export(record_id, file);
                    terminate_at_test_boundary("export.after-write");
                    run_at_test_boundary("export.after-write");
                    written
                },
                options,
            )
            .map_err(|error| match error {
                AtomicWriteError::Internal(error) => error.into(),
                AtomicWriteError::User(error) => error,
            });
        terminate_at_test_boundary("export.after-rename");
        finish_export(&stage, entry.as_deref());
        result
    }

    pub fn delete_record(&self, record_id: Uuid) -> Result<(), VaultError> {
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        let mut next = unlocked.manifest.clone();
        let index = next
            .records
            .iter()
            .position(|record| record.id == record_id)
            .ok_or(VaultError::NotFound)?;
        let object_name = next.records.remove(index).object_name;

        // The ciphertext is unlinked between the two manifest writes. Once the
        // first is durable, the newest manifest records the deletion and the
        // older one cannot decrypt a ciphertext that was removed. Unlock repairs
        // slot redundancy before it considers orphan cleanup, so an unlink that
        // fails here is retried there.
        let objects = self.root.join("objects");
        let redundant = commit_manifest_redundant(
            &self.root,
            &unlocked.master_key,
            &mut unlocked.manifest,
            next,
            || {
                match fs::remove_file(objects.join(&object_name)) {
                    Ok(()) => sync_parent(&objects),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    // The second manifest commit still performs cryptographic erasure.
                    Err(_) => {}
                }
                terminate_at_test_boundary("delete.after-object-unlink");
                fail_at_test_boundary("delete.after-object-unlink")
            },
        )?;
        unlocked.recovery = (!redundant).then_some(RecoveryReason::WriteFailed);
        Ok(())
    }

    /// Drops every record whose ciphertext is still missing, and returns their
    /// ids. The vault is then complete again and leaves recovery mode. Files
    /// that have come back since unlock, from a backup restore, are kept.
    ///
    /// Only for the lost-objects reason: with an unreadable slot the commit
    /// could replace a newer state, and after a write failure it would fail.
    pub fn remove_unavailable_records(&self) -> Result<Vec<Uuid>, VaultError> {
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        match unlocked.recovery {
            Some(RecoveryReason::LostObjects) => {}
            Some(_) => return Err(VaultError::RecoveryMode),
            None => return Err(VaultError::Invalid),
        }
        let mut next = unlocked.manifest.clone();
        let mut removed = Vec::new();
        next.records.retain(|record| {
            if object_is_present(&self.root, record) {
                return true;
            }
            removed.push(record.id);
            false
        });
        let redundant = commit_manifest_redundant(
            &self.root,
            &unlocked.master_key,
            &mut unlocked.manifest,
            next,
            || Ok(()),
        )?;
        unlocked.unavailable.clear();
        // The session becomes writable without passing through the writable
        // unlock path, which is where a dropped `objects` directory is normally
        // restored. Every record's file was lost when the directory itself is
        // gone, so imports would fail here until the next unlock without this.
        unlocked.recovery = if redundant && ensure_objects_dir(&self.root).is_ok() {
            None
        } else {
            Some(RecoveryReason::WriteFailed)
        };
        Ok(removed)
    }

    pub fn change_passphrase(&self, current: &str, replacement: &str) -> Result<(), VaultError> {
        if current.len() > MAX_PASSPHRASE_BYTES {
            return Err(VaultError::Invalid);
        }
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        let profile_names = unlocked
            .manifest
            .profiles
            .iter()
            .map(|profile| profile.display_name.as_str())
            .collect::<Vec<_>>();
        validate_new_passphrase(replacement, &profile_names)?;
        // Select the header as unlock does: the newest one that `current`
        // authenticates. Taking the highest generation on structure alone would
        // let a damaged or planted slot turn the right passphrase into a refusal.
        let (header, verified, _) = read_header_for_passphrase(&self.root, current)?;
        if header.vault_id != unlocked.manifest.vault_id
            || verified.as_ref() != unlocked.master_key.as_ref()
        {
            return Err(VaultError::Corrupt);
        }
        let first_generation = header
            .generation
            .checked_add(1)
            .ok_or(VaultError::Storage)?;
        let (kdf, wrapping_key) = new_passphrase_key(replacement)?;
        // The recovery key, if any, still opens the vault after the change.
        let (first, second) = build_header_pair_with_key(
            header.vault_id,
            first_generation,
            &kdf,
            &wrapping_key,
            &unlocked.master_key,
            header.recovery.as_ref(),
        )?;
        let written =
            write_header_pair(&self.root, &first, &second, "passphrase.after-first-write")?;
        // A key shown for setup was authorized by the old passphrase.
        unlocked.pending_recovery_key = None;
        if written == HeaderPairWrite::FirstOnly {
            unlocked.recovery = Some(RecoveryReason::WriteFailed);
        }
        Ok(())
    }

    /// Makes a new recovery key and returns it, once, for the patient to
    /// write down. The current passphrase authorizes it, as it does a
    /// passphrase change: a recovery key opens the vault for good. Nothing is
    /// stored until `confirm_recovery_key` checks that the patient has the
    /// key; until then the vault keeps any key it already has.
    pub fn begin_recovery_key(&self, passphrase: &str) -> Result<Zeroizing<String>, VaultError> {
        if passphrase.len() > MAX_PASSPHRASE_BYTES {
            return Err(VaultError::Invalid);
        }
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        let (header, verified, wrapping_key) = read_header_for_passphrase(&self.root, passphrase)?;
        if header.vault_id != unlocked.manifest.vault_id
            || verified.as_ref() != unlocked.master_key.as_ref()
        {
            return Err(VaultError::Corrupt);
        }
        let mut key = Zeroizing::new([0_u8; RECOVERY_KEY_BYTES]);
        OsRng.fill_bytes(key.as_mut());
        let text = encode_recovery_key(&key);
        unlocked.pending_recovery_key = Some(PendingRecoveryKey {
            key,
            kdf: header.kdf,
            wrapping_key,
        });
        Ok(text)
    }

    /// The recovery kit for the key shown by `begin_recovery_key` and not yet
    /// confirmed: the key, when it was made and what it is for. It names no
    /// patient or document, so a kit someone else finds says nothing more.
    pub fn recovery_kit(&self, now_ms: u64) -> Result<Zeroizing<String>, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        let pending = unlocked
            .pending_recovery_key
            .as_ref()
            .ok_or(VaultError::Invalid)?;
        Ok(recovery_kit_text(
            &encode_recovery_key(&pending.key),
            now_ms,
        ))
    }

    /// Saves the recovery kit to a file the patient chose, as an export is
    /// saved: never inside the vault home, private to the user, and replacing
    /// a link at the destination rather than writing through it.
    pub fn save_recovery_kit(&self, destination: &Path, now_ms: u64) -> Result<(), VaultError> {
        let home = fs::canonicalize(vault_home(&self.root)?)?;
        let destination_parent = destination.parent().ok_or(VaultError::Invalid)?;
        if fs::canonicalize(destination_parent)?.starts_with(&home) {
            return Err(VaultError::Invalid);
        }
        let kit = self.recovery_kit(now_ms)?;
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600);
        AtomicFile::new(destination, AllowOverwrite)
            .write_with_options(|file| file.write_all(kit.as_bytes()), options)
            .map_err(io::Error::from)?;
        Ok(())
    }

    /// Forgets a recovery key shown by `begin_recovery_key` without storing it.
    pub fn cancel_recovery_key(&self) {
        if let Some(unlocked) = self.session().as_mut() {
            unlocked.pending_recovery_key = None;
        }
    }

    /// Checks groups of the pending recovery key as the patient typed them
    /// back (group index and text; at least two different groups), then
    /// stores the key: a new pair of header generations carries its envelope,
    /// replacing any earlier recovery key.
    pub fn confirm_recovery_key(
        &self,
        groups: &[(usize, &str)],
        now_ms: u64,
    ) -> Result<(), VaultError> {
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        let PendingRecoveryKey {
            key: pending,
            kdf,
            wrapping_key,
        } = unlocked
            .pending_recovery_key
            .as_ref()
            .ok_or(VaultError::Invalid)?;
        let distinct: HashSet<usize> = groups.iter().map(|(index, _)| *index).collect();
        if distinct.len() < 2
            || distinct.len() != groups.len()
            || groups.len() > RECOVERY_KEY_GROUPS
        {
            return Err(VaultError::Invalid);
        }
        // Every index is checked before any group is compared, so that the
        // answer never depends on how far the comparison got.
        if groups
            .iter()
            .any(|(index, typed)| *index >= RECOVERY_KEY_GROUPS || typed.len() > 64)
        {
            return Err(VaultError::Invalid);
        }
        let expected = encode_recovery_key(pending);
        let expected_groups: Vec<&str> = expected.split('-').collect();
        let matched = groups
            .iter()
            .filter(|(index, typed)| recovery_group_matches(typed, expected_groups[*index]))
            .count();
        if matched != groups.len() {
            return Err(VaultError::RecoveryKeyTypo);
        }

        let vault_id = unlocked.manifest.vault_id;
        let current = newest_authentic_header(&self.root, vault_id, &unlocked.master_key)?;
        // The passphrase that authorized the key must still open the current
        // header; otherwise the pair below would wrap the master key under a
        // passphrase that no longer applies.
        let opens = &current.kdf == kdf
            && unwrap_secret(
                wrapping_key,
                &current.wrapped_master_key,
                &header_aad(vault_id, current.generation),
            )
            .is_ok_and(|candidate| candidate.as_ref() == unlocked.master_key.as_ref());
        if !opens {
            return Err(VaultError::Corrupt);
        }
        let envelope = new_recovery_envelope(pending, vault_id, &unlocked.master_key, now_ms)?;
        let first_generation = current
            .generation
            .checked_add(1)
            .ok_or(VaultError::Storage)?;
        let (first, second) = build_header_pair_with_key(
            vault_id,
            first_generation,
            kdf,
            wrapping_key,
            &unlocked.master_key,
            Some(&envelope),
        )?;
        let written = write_header_pair(
            &self.root,
            &first,
            &second,
            "recovery-key.after-first-write",
        )?;
        unlocked.pending_recovery_key = None;
        unlocked.recovery_key_set_at_ms = Some(now_ms);
        if written == HeaderPairWrite::FirstOnly {
            unlocked.recovery = Some(RecoveryReason::WriteFailed);
        }
        Ok(())
    }

    /// Opens a locked vault with its recovery key and replaces the forgotten
    /// passphrase with `new_passphrase`. Returns whether the passphrase was
    /// replaced: a vault that can only open read-only (see `RecoveryReason`)
    /// is opened read-only with its passphrase unchanged, since nothing on
    /// disk may be rewritten, so that its documents can still be saved.
    pub fn recover(&self, recovery_key: &str, new_passphrase: &str) -> Result<bool, VaultError> {
        if new_passphrase.len() > MAX_PASSPHRASE_BYTES {
            return Err(VaultError::Invalid);
        }
        let key = decode_recovery_key(recovery_key)?;
        let mut guard = self.session();
        if guard.is_some() {
            return Err(VaultError::Invalid);
        }
        let storage_lock = acquire_storage_lock(&self.root)?;
        finish_pending_resets(&self.root)?;
        self.cancel_io.store(false, Ordering::Release);
        let (header, master_key) = read_header_for_recovery_key(&self.root, &key)?;
        let slots = read_manifest_slots(&self.root, &master_key, header.vault_id)?;
        let selected = select_manifest(&slots)?;
        let header_unreadable = header_slot_unreadable(&self.root);
        if selected.recovery.is_some() || header_unreadable {
            // As in `open_with_header`: an unreadable header slot outranks lost
            // objects, so the session cannot become writable over it.
            let recovery = if header_unreadable {
                Some(RecoveryReason::UnreadableSlot)
            } else {
                selected.recovery
            };
            self.open_session(
                &mut guard,
                UnlockedVault {
                    storage_lock,
                    master_key,
                    recovery_key_set_at_ms: header
                        .recovery
                        .as_ref()
                        .map(|envelope| envelope.created_at_ms),
                    pending_recovery_key: None,
                    manifest: selected.manifest,
                    recovery,
                    unavailable: selected.unavailable,
                },
            );
            return Ok(false);
        }
        let profile_names = selected
            .manifest
            .profiles
            .iter()
            .map(|profile| profile.display_name.as_str())
            .collect::<Vec<_>>();
        validate_new_passphrase(new_passphrase, &profile_names)?;
        let (kdf, wrapping_key) = new_passphrase_key(new_passphrase)?;
        let first_generation = header
            .generation
            .checked_add(1)
            .ok_or(VaultError::Storage)?;
        // The recovery key keeps working: the envelope is carried forward.
        let (first, second) = build_header_pair_with_key(
            header.vault_id,
            first_generation,
            &kdf,
            &wrapping_key,
            &master_key,
            header.recovery.as_ref(),
        )?;
        match write_header_pair(&self.root, &first, &second, "recover.after-first-write") {
            Ok(_) => {}
            // Nothing was written, as on a full disk. The patient still gets
            // in, read-only and with the passphrase unchanged, so that their
            // documents can be saved.
            Err(VaultError::NoSpace | VaultError::Storage) => {
                self.open_session(
                    &mut guard,
                    UnlockedVault {
                        storage_lock,
                        master_key,
                        recovery_key_set_at_ms: header
                            .recovery
                            .as_ref()
                            .map(|envelope| envelope.created_at_ms),
                        pending_recovery_key: None,
                        manifest: selected.manifest,
                        recovery: Some(RecoveryReason::WriteFailed),
                        unavailable: selected.unavailable,
                    },
                );
                return Ok(false);
            }
            Err(error) => return Err(error),
        }
        // Open as an unlock with the new passphrase would. If the second
        // header write failed, the redundancy repair there rewrites it. An
        // error from here on is reported although the passphrase is already
        // replaced; the recovery key still opens the vault.
        self.open_with_header(&mut guard, storage_lock, first, master_key, wrapping_key)?;
        Ok(true)
    }

    pub fn reset(&self) -> Result<(), VaultError> {
        self.cancel_io.store(true, Ordering::Release);
        let mut guard = self.session();
        // Holding the mutex means the cancelled operation has stopped. Clear the
        // flag on every path, as `lock` does, so that no later session inherits it.
        self.cancel_io.store(false, Ordering::Release);
        let _storage_lock = match guard.as_ref() {
            Some(unlocked) => Arc::clone(&unlocked.storage_lock),
            None => acquire_storage_lock(&self.root)?,
        };
        *guard = None;
        self.idle.disarm();
        let resumed = finish_pending_resets(&self.root)?;
        if !self.root.exists() {
            return if resumed {
                Ok(())
            } else {
                Err(VaultError::Missing)
            };
        }
        let retired = reset_path(&self.root)?;
        fs::rename(&self.root, &retired)?;
        if let Some(parent) = self.root.parent() {
            sync_parent(parent);
        }
        terminate_at_test_boundary("reset.after-rename");
        finish_pending_resets(&self.root)?;
        Ok(())
    }

    /// Checks that a backup could be made, as `backup` checks it, without
    /// writing one: for a destination that cannot be written beside and
    /// renamed over, such as a document provider's, so that an earlier backup
    /// there is not overwritten by one that is then refused.
    pub fn verify_for_backup(&self) -> Result<(), VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        let parts = self.backup_parts(unlocked)?;
        for record in &unlocked.manifest.records {
            self.verify_for_backup_object(unlocked, &parts.keys, record)?;
        }
        Ok(())
    }

    /// Writes a portable backup of the vault: its ciphertext only, as the
    /// patient sees it now. A read-only vault is not backed up, since what
    /// it shows may not be what it holds.
    pub fn backup<W: Write>(&self, writer: W, now_ms: u64) -> Result<(), VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        let parts = self.backup_parts(unlocked)?;
        let manifest = &unlocked.manifest;
        let writer =
            CancellableWriter::new(writer, Arc::clone(&self.cancel_io)).with_progress(&self.idle);
        let mut backup = BackupWriter::new(writer)?;
        backup.entry(
            BACKUP_KIND_HEADER,
            "header.json",
            parts.header_data.len() as u64,
            &mut parts.header_data.as_slice(),
        )?;
        backup.entry(
            BACKUP_KIND_MANIFEST,
            "manifest.bin",
            parts.manifest_data.len() as u64,
            &mut parts.manifest_data.as_slice(),
        )?;
        for record in &manifest.records {
            // A restore refuses the whole backup over one object that does not
            // authenticate, so a damaged one is found now, while the vault
            // and its other documents are still here, not when it is needed.
            self.verify_for_backup_object(unlocked, &parts.keys, record)?;
            let path = self.root.join("objects").join(&record.object_name);
            let mut object = open_regular_read(&path)?;
            let length = object.metadata()?.len();
            backup.entry(BACKUP_KIND_OBJECT, &record.object_name, length, &mut object)?;
        }
        backup.finish(
            &unlocked.master_key,
            manifest.vault_id,
            manifest.generation,
            now_ms,
        )
    }

    /// Every check that refuses a backup before its documents are read, and
    /// what the backup holds besides them. `verify_for_backup` makes the same
    /// checks, so that nothing it passes is refused by `backup` afterwards.
    fn backup_parts(&self, unlocked: &UnlockedVault) -> Result<BackupParts, VaultError> {
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        let manifest = &unlocked.manifest;
        let vault_id = manifest.vault_id;
        let header = newest_authentic_header(&self.root, vault_id, &unlocked.master_key)?;
        let header_data = serde_json::to_vec_pretty(&header).map_err(|_| VaultError::Storage)?;
        let keys = derive_keys(vault_id, &unlocked.master_key)?;
        let manifest_data = read_bounded_regular_file(
            &manifest_path(&self.root, manifest.generation),
            MAX_MANIFEST_BYTES,
        )?;
        // The slot must hold the session's state, or the backup would not be
        // what the patient sees.
        if decrypt_manifest(&manifest_data, &keys.manifest, vault_id).as_ref() != Some(manifest) {
            return Err(VaultError::Corrupt);
        }
        Ok(BackupParts {
            header_data,
            manifest_data,
            keys,
        })
    }

    /// Authenticates one document for a backup. One that does not is named,
    /// so that the patient can tell which, instead of every backup failing
    /// over something they cannot find.
    fn verify_for_backup_object(
        &self,
        unlocked: &UnlockedVault,
        keys: &DerivedKeys,
        record: &StoredRecord,
    ) -> Result<(), VaultError> {
        let vault_id = unlocked.manifest.vault_id;
        let object_key = unwrap_secret(
            &keys.object_wrap,
            &record.wrapped_object_key,
            record.id.as_bytes(),
        )?;
        verify_object(
            &self.root.join("objects").join(&record.object_name),
            CancellableWriter::new(io::sink(), Arc::clone(&self.cancel_io))
                .with_progress(&self.idle),
            vault_id,
            record.id,
            &object_key,
            record.plaintext_size,
        )
        .map_err(|error| match error {
            VaultError::Corrupt => VaultError::DamagedDocument(record.id),
            error => error,
        })
    }

    /// Saves a backup to a file the patient chose, as an export is saved:
    /// never inside the vault home, and replacing the destination only once
    /// the whole backup is written.
    pub fn backup_atomic(&self, destination: &Path, now_ms: u64) -> Result<(), VaultError> {
        let home = fs::canonicalize(vault_home(&self.root)?)?;
        let destination_parent = destination.parent().ok_or(VaultError::Invalid)?;
        if fs::canonicalize(destination_parent)?.starts_with(&home) {
            return Err(VaultError::Invalid);
        }
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut outcome = Ok(());
        let written = AtomicFile::new(destination, AllowOverwrite).write_with_options(
            |file| {
                outcome = self.backup(BufWriter::new(&mut *file), now_ms);
                match &outcome {
                    Ok(()) => file.sync_all(),
                    Err(_) => Err(io::Error::other("backup failed")),
                }
            },
            options,
        );
        outcome?;
        written.map_err(io::Error::from)?;
        Ok(())
    }

    /// Reads a backup's header and manifest with the credential and says what
    /// restoring it would replace. Nothing changes, except that a reset or
    /// restore left unfinished by an earlier run is finished first.
    pub fn inspect_backup<R: Read + Send + 'static>(
        &self,
        source: R,
        credential: RestoreCredential<'_>,
    ) -> Result<RestorePreview, VaultError> {
        // Held throughout, as for a restore.
        let session = self.session();
        if session.is_some() {
            return Err(VaultError::Invalid);
        }
        let _storage_lock = acquire_storage_lock(&self.root)?;
        finish_pending_resets(&self.root)?;
        self.cancel_io.store(false, Ordering::Release);
        let source = CancellableReader::new(Box::new(source), Arc::clone(&self.cancel_io));
        let opened = open_backup(source, &credential)?;
        let preview = self.preview_of(&opened);
        drop(session);
        preview
    }

    /// What restoring an opened backup would do to this device. The caller
    /// holds the session and the storage lock.
    fn preview_of<R: Read>(&self, opened: &OpenedBackup<R>) -> Result<RestorePreview, VaultError> {
        let OpenedBackup {
            header,
            master_key,
            manifest,
            manifest_data,
            ..
        } = opened;
        let candidates = read_header_candidates(&self.root);
        let (replaces, differs_from_this_device) = if !self.root.exists() {
            (RestoreReplaces::Nothing, false)
        } else if candidates.is_empty() {
            // No header could be read: the vault may be the backup's, damaged
            // or unreadable, or another one. It is not called either.
            (RestoreReplaces::Unreadable, false)
        } else if candidates
            .iter()
            .any(|candidate| candidate.vault_id == header.vault_id)
        {
            // The same vault holds the same master key, so its own header and
            // manifest can be read and compared with the backup's.
            let live_header = newest_authentic_header(&self.root, header.vault_id, master_key).ok();
            let live_manifest = read_manifest_slots(&self.root, master_key, header.vault_id)
                .ok()
                .and_then(|slots| {
                    slots
                        .iter()
                        .filter_map(SlotReading::authentic)
                        .map(|(manifest, _)| manifest)
                        .max_by_key(|manifest| manifest.generation)
                        .cloned()
                });
            // The same passphrase (its KDF salt) and the same recovery key.
            let same_keys = live_header.is_some_and(|live| {
                live.kdf == header.kdf
                    && live.recovery.as_ref().map(|envelope| envelope.key_id)
                        == header.recovery.as_ref().map(|envelope| envelope.key_id)
            });
            // Redundancy repair moves the generation on without changing
            // anything else, so the generation is left out of the comparison.
            let same_content = live_manifest.as_ref().is_some_and(|live| {
                let mut live = live.clone();
                live.generation = manifest.generation;
                live == *manifest
            });
            // Which of the two is the later one is not told: a generation
            // moves on with repairs, and a vault restored and changed
            // elsewhere has a lower one than a vault left untouched here.
            (RestoreReplaces::SameVault, !(same_keys && same_content))
        } else {
            (RestoreReplaces::OtherVault, false)
        };
        Ok(RestorePreview {
            replaces,
            differs_from_this_device,
            document_count: manifest.records.len(),
            fingerprint: {
                let mut hash = <Sha256 as sha2::Digest>::new();
                sha2::Digest::update(
                    &mut hash,
                    serde_json::to_vec(header).map_err(|_| VaultError::Storage)?,
                );
                sha2::Digest::update(&mut hash, manifest_data);
                sha2::Digest::finalize(hash).into()
            },
        })
    }

    /// Restores the backup the patient agreed to: `confirmed` is the preview
    /// they were shown. The file is opened again for the restore, and may by
    /// then be another one (an older backup put in its place, in a shared or
    /// synced folder), or the vault on this device may have changed. Either
    /// is refused before anything is staged.
    pub fn restore_confirmed<R: Read + Send + 'static>(
        &self,
        source: R,
        credential: RestoreCredential<'_>,
        confirmed: &RestorePreview,
    ) -> Result<(), VaultError> {
        self.restore_checked(
            source,
            credential,
            confirmed.replaces != RestoreReplaces::Nothing,
            Some(confirmed),
        )
    }

    /// Restores a backup: it is read, authenticated and staged in full, and
    /// every document decrypted, before anything on this device changes.
    /// Then it takes the live vault's place, which is erased as a reset
    /// erases it; `replace` must say the patient agreed to that. The vault
    /// is left locked: it opens with the passphrase or recovery key it was
    /// backed up with.
    #[cfg(test)]
    pub fn restore<R: Read + Send + 'static>(
        &self,
        source: R,
        credential: RestoreCredential<'_>,
        replace: bool,
    ) -> Result<(), VaultError> {
        self.restore_checked(source, credential, replace, None)
    }

    fn restore_checked<R: Read + Send + 'static>(
        &self,
        source: R,
        credential: RestoreCredential<'_>,
        replace: bool,
        confirmed: Option<&RestorePreview>,
    ) -> Result<(), VaultError> {
        // Held throughout, as `create` holds it: a lock or reset then waits
        // for the restore, which its cancel flag stops at the next read.
        let session = self.session();
        if session.is_some() {
            return Err(VaultError::Invalid);
        }
        let _storage_lock = acquire_storage_lock(&self.root)?;
        finish_pending_resets(&self.root)?;
        self.cancel_io.store(false, Ordering::Release);
        if self.root.exists() && !replace {
            return Err(VaultError::AlreadyExists);
        }
        let source = CancellableReader::new(Box::new(source), Arc::clone(&self.cancel_io));
        let opened = open_backup(source, &credential)?;
        if confirmed
            .is_some_and(|confirmed| self.preview_of(&opened).ok().as_ref() != Some(confirmed))
        {
            return Err(VaultError::BackupChanged);
        }
        let OpenedBackup {
            mut reader,
            header,
            master_key,
            manifest,
            manifest_data,
        } = opened;
        let home = vault_home(&self.root)?;
        let stage = home.join(format!("{RESTORE_STAGE_PREFIX}{}", Uuid::new_v4()));
        create_private_dir(&stage)?;
        let staged = (|| {
            create_private_dir(&stage.join("objects"))?;
            create_private_dir(&stage.join("staging"))?;
            let mut wanted: HashMap<&str, u64> = manifest
                .records
                .iter()
                .map(|record| (record.object_name.as_str(), record.plaintext_size))
                .collect();
            while let Some((kind, name, length)) = reader.next_entry()? {
                // Only the manifest's objects, each once, and no larger than
                // the document the authenticated manifest describes: an
                // entry's own length is not authenticated until the trailer
                // is, and must not be able to fill the disk before that.
                if kind != BACKUP_KIND_OBJECT || !valid_object_name(&name) {
                    return Err(VaultError::BackupUnreadable);
                }
                let plaintext_size = wanted
                    .remove(name.as_str())
                    .ok_or(VaultError::BackupUnreadable)?;
                if length > largest_object_len(plaintext_size) {
                    return Err(VaultError::BackupUnreadable);
                }
                let mut file = open_private_new(&stage.join("objects").join(&name))?;
                reader.copy_entry(kind, &name, length, &mut file)?;
                file.sync_all()?;
            }
            if !wanted.is_empty() {
                return Err(VaultError::BackupUnreadable);
            }
            reader.finish(&master_key, header.vault_id, manifest.generation)?;
            fail_at_test_boundary("restore.before-verify")?;

            // Authentic as a whole. Lay it out as a vault, open it as unlock
            // would, and authenticate every document.
            atomic_json(&header_path(&stage, header.generation), &header)?;
            atomic_bytes(&manifest_path(&stage, manifest.generation), &manifest_data)?;
            sync_dir(&stage.join("objects"))?;
            let slots = read_manifest_slots(&stage, &master_key, header.vault_id)?;
            let selected = select_manifest(&slots)?;
            if selected.recovery.is_some() || selected.manifest != manifest {
                return Err(VaultError::BackupUnreadable);
            }
            let keys = derive_keys(header.vault_id, &master_key)?;
            for record in &manifest.records {
                let object_key = unwrap_secret(
                    &keys.object_wrap,
                    &record.wrapped_object_key,
                    record.id.as_bytes(),
                )?;
                verify_object(
                    &stage.join("objects").join(&record.object_name),
                    CancellableWriter::new(io::sink(), Arc::clone(&self.cancel_io)),
                    header.vault_id,
                    record.id,
                    &object_key,
                    record.plaintext_size,
                )
                .map_err(|error| match error {
                    VaultError::Cancelled => error,
                    _ => VaultError::BackupUnreadable,
                })?;
            }
            sync_dir(&stage)?;
            Ok(())
        })();
        if let Err(error) = staged {
            if remove_key_envelopes(&stage).is_ok() {
                sync_parent(&stage);
            }
            let _ = fs::remove_dir_all(&stage);
            sync_parent(home);
            return Err(error);
        }
        // From here a crash finishes the restore at the next start instead of
        // discarding it: the verified copy takes a fixed name first.
        let ready = restore_ready_path(&self.root)?;
        let discard = |directory: &Path| {
            if remove_key_envelopes(directory).is_ok() {
                sync_parent(directory);
            }
            let _ = fs::remove_dir_all(directory);
            sync_parent(home);
        };
        if let Err(error) = fs::rename(&stage, &ready) {
            discard(&stage);
            return Err(error.into());
        }
        sync_parent(home);
        terminate_at_test_boundary("restore.after-ready");
        if let Err(error) = activate_restore(&self.root) {
            // The failure is reported, so the restore must not happen after
            // all at a later start: the vault is as it was, which activation
            // sees to by putting a retired vault back, and the verified copy
            // is discarded. Only when that could not be done is the copy the
            // one vault left, and the next start puts it in place.
            if !matches!(error, VaultError::RestoreUnfinished) {
                // Under a stage's name first, in one step: a removal cut
                // short must not leave half a vault under the name that the
                // next start puts in place.
                if fs::rename(&ready, &stage).is_ok() {
                    sync_parent(home);
                    discard(&stage);
                } else {
                    discard(&ready);
                    // What cannot be removed (a file held open, say) is put
                    // in place at the next start, so the failure is not the
                    // one to report.
                    if HEADER_SLOTS.iter().any(|slot| ready.join(slot).is_file()) {
                        return Err(VaultError::RestoreUnfinished);
                    }
                }
            }
            return Err(error);
        }
        // The restore is in place. Erasing the vault it retired is retried at
        // every start, so a failure here does not make the restore one.
        let _ = erase_retired_vault(&self.root);
        drop(session);
        Ok(())
    }

    #[cfg(test)]
    fn read_header(&self) -> Result<VaultHeader, VaultError> {
        read_latest_header(&self.root)
    }

    fn mutate_manifest<T>(
        &self,
        mutation: impl FnOnce(&mut Manifest) -> Result<T, VaultError>,
    ) -> Result<T, VaultError> {
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        let mut next = unlocked.manifest.clone();
        let result = mutation(&mut next)?;
        let redundant = commit_manifest_redundant(
            &self.root,
            &unlocked.master_key,
            &mut unlocked.manifest,
            next,
            || Ok(()),
        )?;
        unlocked.recovery = (!redundant).then_some(RecoveryReason::WriteFailed);
        Ok(result)
    }
}

/// What a backup holds besides its documents, and the keys to check them.
struct BackupParts {
    header_data: Vec<u8>,
    manifest_data: Vec<u8>,
    keys: DerivedKeys,
}

#[derive(Zeroize, ZeroizeOnDrop)]
struct DerivedKeys {
    manifest: [u8; 32],
    object_wrap: [u8; 32],
    fingerprint: [u8; 32],
}

struct EncryptedObject {
    plaintext_size: u64,
    fingerprint: [u8; 32],
}

#[derive(Clone, Copy)]
struct ObjectContext {
    vault_id: Uuid,
    record_id: Uuid,
    profile_id: Uuid,
}

/// A word of a profile name long enough that its presence in a passphrase is
/// not a coincidence.
const MIN_NAME_WORD_CHARS: usize = 4;

fn validate_new_passphrase(passphrase: &str, context: &[&str]) -> Result<(), VaultError> {
    // Bound the raw input before any work on it.
    if passphrase.len() > MAX_PASSPHRASE_BYTES {
        return Err(VaultError::Invalid);
    }
    // Every rule applies to the form the KDF will see. The same visible text
    // must pass or fail alike whichever composition form a keyboard produced.
    let passphrase = normalize_passphrase(passphrase);
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS
        || passphrase.len() > MAX_PASSPHRASE_BYTES
        || passphrase.chars().any(char::is_control)
    {
        return Err(VaultError::Invalid);
    }
    // Names are normalized before they are split: a combining mark is not
    // alphanumeric, so splitting first would break "Renée" apart.
    let context: Vec<Zeroizing<String>> = context
        .iter()
        .filter(|value| !value.trim().is_empty())
        .map(|value| normalize_passphrase(value))
        .collect();
    // The estimator matches a context entry only as a whole string, so a name
    // rearranged or joined with a symbol scores as strong. Any word of a
    // profile name is refused outright instead.
    let lowered = passphrase.to_lowercase();
    let contains_name_word = context
        .iter()
        .flat_map(|value| value.split(|c: char| !c.is_alphanumeric()))
        .filter(|word| word.chars().count() >= MIN_NAME_WORD_CHARS)
        .any(|word| lowered.contains(&word.to_lowercase()));
    if contains_name_word {
        return Err(VaultError::WeakPassphrase);
    }

    let mut user_inputs = vec!["mycarlos", "carlos", "myvitalhistory"];
    user_inputs.extend(context.iter().map(|value| value.as_str()));
    if zxcvbn(&passphrase, &user_inputs).score() < Score::Three {
        Err(VaultError::WeakPassphrase)
    } else {
        Ok(())
    }
}

pub(crate) fn validate_import_count(count: usize) -> Result<(), VaultError> {
    if count > MAX_IMPORT_FILES {
        Err(VaultError::ImportBatchLimit)
    } else {
        Ok(())
    }
}

pub(crate) fn validate_folder_assignment_count(count: usize) -> Result<(), VaultError> {
    if count > MAX_FOLDER_ASSIGNMENTS {
        Err(VaultError::Invalid)
    } else {
        Ok(())
    }
}

fn validate_name(name: &str) -> Result<(), VaultError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control) {
        Err(VaultError::Invalid)
    } else {
        Ok(())
    }
}

/// The ".pdf" at the end of a document name, in the case the name uses, after
/// a non-empty stem; otherwise "". Imports are offered as PDFs, so no other
/// suffix is treated as a file type: "Visit 10.30am" and "Mr.Jones" have no
/// extension. A desktop picker can still return another kind of file, which
/// is why a rename may not add ".pdf" either.
fn file_extension(name: &str) -> &str {
    let start = name.len().saturating_sub(4);
    match name.get(start..) {
        Some(tail) if start > 0 && tail.eq_ignore_ascii_case(".pdf") => tail,
        _ => "",
    }
}

fn sanitize_basename(value: &str) -> String {
    let raw = value.rsplit(['/', '\\']).next().unwrap_or("Imported file");
    let mut cleaned = String::new();
    for character in raw.chars().filter(|character| {
        !character.is_control()
            && !matches!(
                *character,
                '\u{061c}'
                    | '\u{200b}'..='\u{200f}'
                    | '\u{202a}'..='\u{202e}'
                    | '\u{2066}'..='\u{2069}'
                    | '\u{feff}'
            )
    }) {
        let character = if matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
            '_'
        } else {
            character
        };
        cleaned.push(character);
    }
    cleaned = truncate_record_name(
        cleaned
            .trim_start()
            .trim_end_matches(is_trailing_name_padding),
    );
    // Win32 ignores spaces between the stem and the extension, so "CON .txt"
    // still names the console device.
    let stem = cleaned
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ');
    let reserved = RESERVED_DEVICE_NAMES.contains(&stem.to_ascii_uppercase().as_str());
    if reserved {
        cleaned.insert(0, '_');
        // The prefix must not push a maximum-length name past the limit that
        // `valid_record_name` enforces when the manifest is read back.
        cleaned = truncate_record_name(&cleaned);
    }
    if cleaned.is_empty() {
        "Imported file".to_owned()
    } else {
        cleaned
    }
}

/// Dots and whitespace that a name must not end with. Any whitespace counts, not
/// only the ASCII space: stripping the dots after a no-break space would otherwise
/// leave a name that the next pass trims again, and `rename_record` relies on a
/// sanitized name being a fixed point.
fn is_trailing_name_padding(character: char) -> bool {
    character == '.' || character.is_whitespace()
}

/// Shortens `name` to `MAX_RECORD_NAME_LEN` bytes on a character boundary and
/// drops any trailing dots or spaces the cut exposes. A short final extension
/// is kept, so the export of a long name still suggests a file the platform
/// can open.
fn truncate_record_name(name: &str) -> String {
    const MAX_KEPT_EXTENSION_LEN: usize = 16;
    fn cut(value: &str, limit: usize) -> &str {
        let mut end = limit.min(value.len());
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        value[..end].trim_end_matches(is_trailing_name_padding)
    }
    if name.len() <= MAX_RECORD_NAME_LEN {
        return name.to_owned();
    }
    match name.rsplit_once('.') {
        Some((stem, extension))
            if !extension.is_empty() && extension.len() <= MAX_KEPT_EXTENSION_LEN =>
        {
            let stem = cut(stem, MAX_RECORD_NAME_LEN - extension.len() - 1);
            if stem.is_empty() {
                cut(name, MAX_RECORD_NAME_LEN).to_owned()
            } else {
                format!("{stem}.{extension}")
            }
        }
        _ => cut(name, MAX_RECORD_NAME_LEN).to_owned(),
    }
}

fn valid_kdf_config(config: &KdfConfig) -> bool {
    config.algorithm == "argon2id"
        && config.version == 19
        && config.memory_kib == ARGON_MEMORY_KIB
        && config.iterations == ARGON_ITERATIONS
        && config.lanes == ARGON_LANES
        && BASE64
            .decode(&config.salt)
            .is_ok_and(|salt| salt.len() == 16)
}

fn valid_wrapped_secret(secret: &WrappedSecret) -> bool {
    BASE64
        .decode(&secret.nonce)
        .is_ok_and(|nonce| nonce.len() == 24)
        && BASE64
            .decode(&secret.ciphertext)
            .is_ok_and(|ciphertext| ciphertext.len() == 48)
}

fn valid_fingerprint(fingerprint: &str) -> bool {
    BASE64
        .decode(fingerprint)
        .is_ok_and(|value| value.len() == 32)
}

fn valid_object_name(object_name: &str) -> bool {
    object_name
        .strip_suffix(".mcobj")
        .and_then(|value| Uuid::parse_str(value).ok())
        .is_some_and(|id| format!("{id}.mcobj") == object_name)
}

fn valid_record_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.chars().count() <= MAX_RECORD_NAME_LEN
        && !name.chars().any(char::is_control)
        && !name.contains('/')
        && !name.contains('\\')
}

/// Structure plus object presence: what a slot must satisfy to be complete.
#[cfg(test)]
fn validate_manifest(root: &Path, manifest: &Manifest, vault_id: Uuid) -> Result<(), VaultError> {
    validate_manifest_structure(manifest, vault_id)?;
    if manifest
        .records
        .iter()
        .all(|record| object_is_present(root, record))
    {
        Ok(())
    } else {
        Err(VaultError::Corrupt)
    }
}

fn object_is_present(root: &Path, record: &StoredRecord) -> bool {
    fs::symlink_metadata(root.join("objects").join(&record.object_name))
        .is_ok_and(|metadata| metadata.file_type().is_file())
}

/// Checks everything about a decrypted manifest except whether its objects
/// are on disk, so a vault with a lost object can still be opened read-only.
fn validate_manifest_structure(manifest: &Manifest, vault_id: Uuid) -> Result<(), VaultError> {
    if manifest.format_version != VAULT_FORMAT
        || manifest.vault_id != vault_id
        || manifest.generation == 0
        || manifest.profiles.is_empty()
    {
        return Err(VaultError::Corrupt);
    }

    let mut profile_ids = HashSet::new();
    for profile in &manifest.profiles {
        if profile.id.is_nil()
            || !profile_ids.insert(profile.id)
            || validate_name(&profile.display_name).is_err()
        {
            return Err(VaultError::Corrupt);
        }
    }

    let mut folders_by_id = HashMap::new();
    for folder in &manifest.folders {
        if folder.id.is_nil()
            || folders_by_id
                .insert(folder.id, (folder.profile_id, folder.parent_id))
                .is_some()
            || !profile_ids.contains(&folder.profile_id)
            || folder.parent_id == Some(folder.id)
            || validate_name(&folder.name).is_err()
        {
            return Err(VaultError::Corrupt);
        }
    }
    for folder in &manifest.folders {
        let mut parent_id = folder.parent_id;
        let mut seen = HashSet::new();
        let mut depth = 1;
        while let Some(id) = parent_id {
            if !seen.insert(id) || depth >= 32 {
                return Err(VaultError::Corrupt);
            }
            let (parent_profile_id, next_parent_id) =
                folders_by_id.get(&id).copied().ok_or(VaultError::Corrupt)?;
            if parent_profile_id != folder.profile_id {
                return Err(VaultError::Corrupt);
            }
            parent_id = next_parent_id;
            depth += 1;
        }
    }

    let mut record_ids = HashSet::new();
    let mut object_names = HashSet::new();
    for record in &manifest.records {
        if record.id.is_nil()
            || !record_ids.insert(record.id)
            || !profile_ids.contains(&record.profile_id)
            || !valid_record_name(&record.display_name)
            || record.source_label != "Manual import — unverified"
            || record.media_type != "application/octet-stream"
            || !valid_object_name(&record.object_name)
            || !object_names.insert(record.object_name.as_str())
            || !valid_fingerprint(&record.fingerprint)
            || !valid_wrapped_secret(&record.wrapped_object_key)
        {
            return Err(VaultError::Corrupt);
        }
        let unique_folders: HashSet<_> = record.folder_ids.iter().collect();
        if unique_folders.len() != record.folder_ids.len()
            || record.folder_ids.iter().any(|folder_id| {
                folders_by_id
                    .get(folder_id)
                    .is_none_or(|(profile_id, _)| *profile_id != record.profile_id)
            })
        {
            return Err(VaultError::Corrupt);
        }
    }
    Ok(())
}

/// The current KDF parameters with a fresh random salt.
fn new_kdf_config() -> KdfConfig {
    let mut salt = [0_u8; 16];
    OsRng.fill_bytes(&mut salt);
    KdfConfig {
        algorithm: "argon2id".to_owned(),
        version: 19,
        memory_kib: ARGON_MEMORY_KIB,
        iterations: ARGON_ITERATIONS,
        lanes: ARGON_LANES,
        salt: BASE64.encode(salt),
    }
}

#[cfg(test)]
fn build_header(
    vault_id: Uuid,
    generation: u64,
    passphrase: &str,
    master_key: &[u8; 32],
) -> Result<VaultHeader, VaultError> {
    let kdf = new_kdf_config();
    let wrapping_key = derive_passphrase_key(passphrase, &kdf)?;
    build_header_with_key(vault_id, generation, kdf, &wrapping_key, master_key, None)
}

#[cfg(test)]
fn build_header_pair(
    vault_id: Uuid,
    first_generation: u64,
    passphrase: &str,
    master_key: &[u8; 32],
) -> Result<(VaultHeader, VaultHeader), VaultError> {
    let (kdf, wrapping_key) = new_passphrase_key(passphrase)?;
    build_header_pair_with_key(
        vault_id,
        first_generation,
        &kdf,
        &wrapping_key,
        master_key,
        None,
    )
}

/// A new passphrase's KDF settings, with a fresh salt, and the key they derive.
fn new_passphrase_key(passphrase: &str) -> Result<(KdfConfig, SecretKey), VaultError> {
    let kdf = new_kdf_config();
    let wrapping_key = derive_passphrase_key(passphrase, &kdf)?;
    Ok((kdf, wrapping_key))
}

/// Two consecutive header generations, for the two slots.
fn build_header_pair_with_key(
    vault_id: Uuid,
    first_generation: u64,
    kdf: &KdfConfig,
    wrapping_key: &[u8; 32],
    master_key: &[u8; 32],
    recovery: Option<&RecoveryEnvelope>,
) -> Result<(VaultHeader, VaultHeader), VaultError> {
    let second_generation = first_generation.checked_add(1).ok_or(VaultError::Storage)?;
    Ok((
        build_header_with_key(
            vault_id,
            first_generation,
            kdf.clone(),
            wrapping_key,
            master_key,
            recovery.cloned(),
        )?,
        build_header_with_key(
            vault_id,
            second_generation,
            kdf.clone(),
            wrapping_key,
            master_key,
            recovery.cloned(),
        )?,
    ))
}

fn build_header_with_key(
    vault_id: Uuid,
    generation: u64,
    kdf: KdfConfig,
    wrapping_key: &[u8; 32],
    master_key: &[u8; 32],
    recovery: Option<RecoveryEnvelope>,
) -> Result<VaultHeader, VaultError> {
    let wrapped_master_key =
        wrap_secret(wrapping_key, master_key, &header_aad(vault_id, generation))?;
    let mut header = VaultHeader {
        magic: "MYCARLOS-VAULT".to_owned(),
        format_version: HEADER_FORMAT,
        vault_id,
        generation,
        kdf,
        wrapped_master_key,
        recovery,
        integrity_tag: String::new(),
    };
    header.integrity_tag = compute_header_integrity_tag(&header, master_key)?;
    Ok(header)
}

#[cfg(test)]
fn unwrap_master_key(header: &VaultHeader, passphrase: &str) -> Result<SecretKey, VaultError> {
    unwrap_master_key_and_wrapping_key(header, passphrase).map(|(master_key, _)| master_key)
}

#[cfg(test)]
fn unwrap_master_key_and_wrapping_key(
    header: &VaultHeader,
    passphrase: &str,
) -> Result<(SecretKey, SecretKey), VaultError> {
    let wrapping_key = derive_passphrase_key(passphrase, &header.kdf)?;
    let master_key = unwrap_master_key_with_wrapping_key(header, &wrapping_key)?;
    Ok((master_key, wrapping_key))
}

fn unwrap_master_key_with_wrapping_key(
    header: &VaultHeader,
    wrapping_key: &[u8; 32],
) -> Result<SecretKey, VaultError> {
    let aad = if header.generation == 0 {
        header.vault_id.as_bytes().to_vec()
    } else {
        header_aad(header.vault_id, header.generation)
    };
    let master_key = unwrap_secret(wrapping_key, &header.wrapped_master_key, &aad)
        .map_err(|_| VaultError::WrongPassphrase)?;
    Ok(master_key)
}

/// The passphrase as key material. The same visible text can arrive in
/// different Unicode forms from different keyboards and input methods, and the
/// passphrase is the only way into the vault, so it is normalized (NFC) first.
fn normalize_passphrase(passphrase: &str) -> Zeroizing<String> {
    Zeroizing::new(passphrase.nfc().collect())
}

fn derive_passphrase_key(passphrase: &str, config: &KdfConfig) -> Result<SecretKey, VaultError> {
    if !valid_kdf_config(config) {
        return Err(VaultError::Corrupt);
    }
    let passphrase = normalize_passphrase(passphrase);
    let salt = BASE64
        .decode(&config.salt)
        .map_err(|_| VaultError::Corrupt)?;
    if salt.len() != 16 {
        return Err(VaultError::Corrupt);
    }
    let params = Params::new(config.memory_kib, config.iterations, config.lanes, Some(32))
        .map_err(|_| VaultError::Corrupt)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut output = Zeroizing::new([0_u8; 32]);
    argon
        .hash_password_into(passphrase.as_bytes(), &salt, output.as_mut())
        .map_err(|_| VaultError::Storage)?;
    Ok(output)
}

fn derive_keys(vault_id: Uuid, master_key: &[u8; 32]) -> Result<DerivedKeys, VaultError> {
    let hkdf = Hkdf::<Sha256>::new(Some(vault_id.as_bytes()), master_key);
    let mut keys = DerivedKeys {
        manifest: [0; 32],
        object_wrap: [0; 32],
        fingerprint: [0; 32],
    };
    hkdf.expand(b"mycarlos/manifest/v1", &mut keys.manifest)
        .map_err(|_| VaultError::Corrupt)?;
    hkdf.expand(b"mycarlos/object-wrap/v1", &mut keys.object_wrap)
        .map_err(|_| VaultError::Corrupt)?;
    hkdf.expand(b"mycarlos/fingerprint/v1", &mut keys.fingerprint)
        .map_err(|_| VaultError::Corrupt)?;
    Ok(keys)
}

fn wrap_secret(key: &[u8; 32], secret: &[u8; 32], aad: &[u8]) -> Result<WrappedSecret, VaultError> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let mut nonce = [0_u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: secret, aad })
        .map_err(|_| VaultError::Storage)?;
    Ok(WrappedSecret {
        nonce: BASE64.encode(nonce),
        ciphertext: BASE64.encode(ciphertext),
    })
}

fn unwrap_secret(
    key: &[u8; 32],
    wrapped: &WrappedSecret,
    aad: &[u8],
) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let nonce = BASE64
        .decode(&wrapped.nonce)
        .map_err(|_| VaultError::Corrupt)?;
    let ciphertext = BASE64
        .decode(&wrapped.ciphertext)
        .map_err(|_| VaultError::Corrupt)?;
    if nonce.len() != 24 {
        return Err(VaultError::Corrupt);
    }
    let plaintext = Zeroizing::new(
        XChaCha20Poly1305::new(key.into())
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad,
                },
            )
            .map_err(|_| VaultError::Corrupt)?,
    );
    if plaintext.len() != 32 {
        return Err(VaultError::Corrupt);
    }
    let mut value = Zeroizing::new([0_u8; 32]);
    value.copy_from_slice(&plaintext);
    Ok(value)
}

/// The recovery key as the patient sees it: 7 groups of 4 characters.
fn encode_recovery_key(key: &[u8; RECOVERY_KEY_BYTES]) -> Zeroizing<String> {
    let mut symbols = Zeroizing::new(Vec::with_capacity(RECOVERY_KEY_GROUPS * 4));
    // 128 bits, then 2 zero bits, make 26 five-bit symbols.
    let mut bits: u32 = 0;
    let mut count = 0;
    for byte in key {
        bits = (bits << 8) | u32::from(*byte);
        count += 8;
        while count >= 5 {
            count -= 5;
            symbols.push(CROCKFORD_ALPHABET[((bits >> count) & 31) as usize]);
        }
        bits &= (1 << count) - 1;
    }
    symbols.push(CROCKFORD_ALPHABET[((bits << (5 - count)) & 31) as usize]);
    let check = recovery_key_check(key);
    symbols.push(CROCKFORD_ALPHABET[usize::from(check >> 5)]);
    symbols.push(CROCKFORD_ALPHABET[usize::from(check & 31)]);
    let mut text = Zeroizing::new(String::with_capacity(RECOVERY_KEY_GROUPS * 5));
    for (index, group) in symbols.chunks(RECOVERY_KEY_GROUP_LEN).enumerate() {
        if index > 0 {
            text.push('-');
        }
        text.extend(group.iter().map(|symbol| char::from(*symbol)));
    }
    text
}

/// Ten check bits from a hash of the key, so a mistyped key is caught as a
/// typo before any unwrapping is tried.
fn recovery_key_check(key: &[u8; RECOVERY_KEY_BYTES]) -> u16 {
    use sha2::Digest;
    let digest = Sha256::new_with_prefix(b"mycarlos-recovery-key-check-v1:")
        .chain_update(key)
        .finalize();
    (u16::from(digest[0]) << 2) | u16::from(digest[1] >> 6)
}

/// Reads a recovery key as typed: case, spaces and hyphens do not matter, and
/// I, L and O are read as 1, 1 and 0, as Crockford base32 allows.
fn decode_recovery_key(text: &str) -> Result<Zeroizing<[u8; RECOVERY_KEY_BYTES]>, VaultError> {
    if text.len() > 256 {
        return Err(VaultError::RecoveryKeyTypo);
    }
    let mut values = Zeroizing::new(Vec::with_capacity(RECOVERY_KEY_GROUPS * 4));
    for character in text.chars() {
        if character == '-' || character.is_whitespace() {
            continue;
        }
        let symbol = match character.to_ascii_uppercase() {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        };
        let value = CROCKFORD_ALPHABET
            .iter()
            .position(|candidate| char::from(*candidate) == symbol)
            .ok_or(VaultError::RecoveryKeyTypo)?;
        // Never past its capacity: growing would leave a copy behind.
        if values.len() == RECOVERY_KEY_GROUPS * RECOVERY_KEY_GROUP_LEN {
            return Err(VaultError::RecoveryKeyTypo);
        }
        values.push(value as u32);
    }
    if values.len() != RECOVERY_KEY_GROUPS * RECOVERY_KEY_GROUP_LEN {
        return Err(VaultError::RecoveryKeyTypo);
    }
    let mut key = Zeroizing::new([0_u8; RECOVERY_KEY_BYTES]);
    let mut bits: u32 = 0;
    let mut count = 0;
    let mut index = 0;
    for value in &values[..26] {
        bits = (bits << 5) | value;
        count += 5;
        if count >= 8 {
            count -= 8;
            if index < RECOVERY_KEY_BYTES {
                key[index] = ((bits >> count) & 0xff) as u8;
            }
            index += 1;
        }
        bits &= (1 << count) - 1;
    }
    // The 2 bits left over are padding and must be zero.
    if bits != 0 || index != RECOVERY_KEY_BYTES {
        return Err(VaultError::RecoveryKeyTypo);
    }
    let check = ((values[26] << 5) | values[27]) as u16;
    if check != recovery_key_check(&key) {
        return Err(VaultError::RecoveryKeyTypo);
    }
    Ok(key)
}

/// The text of a recovery kit. Plain text, so that it prints and opens
/// anywhere; the date is UTC.
fn recovery_kit_text(key: &str, now_ms: u64) -> Zeroizing<String> {
    let (year, month, day) = utc_date(now_ms);
    Zeroizing::new(format!(
        "myCarlos recovery kit\n\
         =====================\n\
         \n\
         Recovery key:  {key}\n\
         Saved on:      {year:04}-{month:02}-{day:02} (UTC)\n\
         \n\
         What it is for\n\
         If you forget your myCarlos passphrase, this key opens your vault on\n\
         this device and lets you choose a new passphrase. It works once you\n\
         have finished the check in myCarlos that follows saving this kit.\n\
         \n\
         Keep it safe\n\
         - Keep this kit somewhere private and away from the device, for\n  \
         example printed and stored with your important papers. Anyone with\n  \
         this key and a copy of your vault can open it.\n\
         - If you set up a new recovery key, this one no longer opens the\n  \
         vault on this device.\n\
         - Neither your clinic nor the makers of myCarlos can open your vault\n  \
         for you.\n"
    ))
}

/// Year, month and day (UTC) of a time in milliseconds since 1970, by
/// Howard Hinnant's days-to-civil algorithm.
fn utc_date(ms: u64) -> (i64, u32, u32) {
    let days = i64::try_from(ms / 86_400_000).unwrap_or(i64::MAX / 2);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month as u32, day as u32)
}

fn recovery_wrap_key(
    recovery_key: &[u8; RECOVERY_KEY_BYTES],
    vault_id: Uuid,
    key_id: Uuid,
) -> Result<SecretKey, VaultError> {
    let mut salt = [0_u8; 32];
    salt[..16].copy_from_slice(vault_id.as_bytes());
    salt[16..].copy_from_slice(key_id.as_bytes());
    let hkdf = Hkdf::<Sha256>::new(Some(&salt), recovery_key);
    let mut key = Zeroizing::new([0_u8; 32]);
    hkdf.expand(b"mycarlos/recovery-wrap/v1", key.as_mut())
        .map_err(|_| VaultError::Storage)?;
    Ok(key)
}

fn recovery_aad(vault_id: Uuid, key_id: Uuid) -> Vec<u8> {
    let mut aad = Vec::with_capacity(53);
    aad.extend_from_slice(b"mycarlos-recovery-v1:");
    aad.extend_from_slice(vault_id.as_bytes());
    aad.extend_from_slice(key_id.as_bytes());
    aad
}

fn new_recovery_envelope(
    recovery_key: &[u8; RECOVERY_KEY_BYTES],
    vault_id: Uuid,
    master_key: &[u8; 32],
    now_ms: u64,
) -> Result<RecoveryEnvelope, VaultError> {
    let key_id = Uuid::new_v4();
    let wrap_key = recovery_wrap_key(recovery_key, vault_id, key_id)?;
    Ok(RecoveryEnvelope {
        key_id,
        created_at_ms: now_ms,
        wrapped_master_key: wrap_secret(&wrap_key, master_key, &recovery_aad(vault_id, key_id))?,
    })
}

fn header_aad(vault_id: Uuid, generation: u64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(48);
    aad.extend_from_slice(b"mycarlos-header-v1:");
    aad.extend_from_slice(vault_id.as_bytes());
    aad.extend_from_slice(&generation.to_be_bytes());
    aad
}

fn header_integrity_payload(header: &VaultHeader) -> Result<Vec<u8>, VaultError> {
    let common = (
        header.magic.as_str(),
        header.format_version,
        header.vault_id,
        header.generation,
        &header.kdf,
        &header.wrapped_master_key,
    );
    // Format 1's payload is unchanged, so its existing tags still verify.
    if header.format_version == HEADER_FORMAT_V1 {
        serde_json::to_vec(&common)
    } else {
        serde_json::to_vec(&(common, &header.recovery))
    }
    .map_err(|_| VaultError::Storage)
}

fn header_integrity_key(vault_id: Uuid, master_key: &[u8; 32]) -> Result<SecretKey, VaultError> {
    let hkdf = Hkdf::<Sha256>::new(Some(vault_id.as_bytes()), master_key);
    let mut key = Zeroizing::new([0_u8; 32]);
    hkdf.expand(b"mycarlos/header-integrity/v1", key.as_mut())
        .map_err(|_| VaultError::Corrupt)?;
    Ok(key)
}

fn compute_header_integrity_tag(
    header: &VaultHeader,
    master_key: &[u8; 32],
) -> Result<String, VaultError> {
    let key = header_integrity_key(header.vault_id, master_key)?;
    let mut mac =
        <HmacSha256 as Mac>::new_from_slice(key.as_ref()).map_err(|_| VaultError::Storage)?;
    mac.update(&header_integrity_payload(header)?);
    Ok(BASE64.encode(mac.finalize().into_bytes()))
}

fn valid_header_integrity(header: &VaultHeader, master_key: &[u8; 32]) -> bool {
    if header.generation == 0 {
        return header.integrity_tag.is_empty();
    }
    let Ok(tag) = BASE64.decode(&header.integrity_tag) else {
        return false;
    };
    let Ok(key) = header_integrity_key(header.vault_id, master_key) else {
        return false;
    };
    let Ok(payload) = header_integrity_payload(header) else {
        return false;
    };
    let Ok(mut mac) = <HmacSha256 as Mac>::new_from_slice(key.as_ref()) else {
        return false;
    };
    mac.update(&payload);
    mac.verify_slice(&tag).is_ok()
}

fn header_path(root: &Path, generation: u64) -> PathBuf {
    root.join(format!("header-{}.json", generation % 2))
}

fn valid_header(header: &VaultHeader) -> bool {
    // A generation 0 header is the legacy one, written before integrity tags
    // existed: it is format 1 and has no envelope. Accepting format 2 there
    // would let an envelope in that no tag covers.
    let valid_recovery = match (header.format_version, &header.recovery) {
        (HEADER_FORMAT_V1, None) => true,
        (HEADER_FORMAT, None) => header.generation >= 1,
        (HEADER_FORMAT, Some(envelope)) => {
            header.generation >= 1
                && !envelope.key_id.is_nil()
                && valid_wrapped_secret(&envelope.wrapped_master_key)
        }
        _ => false,
    };
    header.magic == "MYCARLOS-VAULT"
        && valid_recovery
        && !header.vault_id.is_nil()
        && valid_kdf_config(&header.kdf)
        && valid_wrapped_secret(&header.wrapped_master_key)
        && (header.generation == 0
            || BASE64
                .decode(&header.integrity_tag)
                .is_ok_and(|tag| tag.len() == 32))
}

const HEADER_SLOTS: [&str; 2] = ["header-0.json", "header-1.json"];
const LEGACY_HEADER: &str = "header.json";

/// The structurally valid headers among `names`, in the order given.
fn read_headers(root: &Path, names: &[&str]) -> Vec<VaultHeader> {
    names
        .iter()
        .filter_map(|name| read_bounded_regular_file(&root.join(name), MAX_HEADER_BYTES).ok())
        .filter_map(|data| serde_json::from_slice::<VaultHeader>(&data).ok())
        .filter(valid_header)
        .collect()
}

fn read_header_candidates(root: &Path) -> Vec<VaultHeader> {
    read_headers(root, &[HEADER_SLOTS[0], HEADER_SLOTS[1], LEGACY_HEADER])
}

#[cfg(test)]
fn read_latest_header(root: &Path) -> Result<VaultHeader, VaultError> {
    let candidates = read_header_candidates(root);
    let generation = candidates
        .iter()
        .map(|header| header.generation)
        .max()
        .ok_or_else(|| {
            if root.exists() {
                VaultError::Corrupt
            } else {
                VaultError::Missing
            }
        })?;
    let mut newest = candidates
        .into_iter()
        .filter(|header| header.generation == generation);
    let selected = newest.next().ok_or(VaultError::Corrupt)?;
    if newest.any(|candidate| candidate != selected) {
        return Err(VaultError::Corrupt);
    }
    Ok(selected)
}

/// Compares a typed group of the recovery key with the expected one, reading
/// it as `decode_recovery_key` does.
fn recovery_group_matches(typed: &str, expected: &str) -> bool {
    // Sized once, so that no copy is left behind by growing.
    let mut normalized = Zeroizing::new(String::with_capacity(typed.len()));
    for character in typed
        .chars()
        .filter(|character| *character != '-' && !character.is_whitespace())
    {
        normalized.push(match character.to_ascii_uppercase() {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        });
    }
    normalized.as_str() == expected
}

/// The newest header slot authenticated by the session's master key.
fn newest_authentic_header(
    root: &Path,
    vault_id: Uuid,
    master_key: &[u8; 32],
) -> Result<VaultHeader, VaultError> {
    read_header_candidates(root)
        .into_iter()
        .filter(|header| header.vault_id == vault_id && valid_header_integrity(header, master_key))
        .max_by_key(|header| header.generation)
        .ok_or(VaultError::Corrupt)
}

/// Selects the header a recovery key opens, as `read_header_for_passphrase`
/// does for a passphrase: the newest one it authenticates, and never an older
/// one when a newer header for the same master key exists that it does not
/// open (a replaced recovery key).
fn read_header_for_recovery_key(
    root: &Path,
    recovery_key: &[u8; RECOVERY_KEY_BYTES],
) -> Result<(VaultHeader, SecretKey), VaultError> {
    let mut candidates = read_header_candidates(root);
    if candidates.is_empty() {
        return Err(if root.exists() {
            VaultError::Corrupt
        } else {
            VaultError::Missing
        });
    }
    candidates.sort_by_key(|header| std::cmp::Reverse(header.generation));
    let mut selected = None;
    for header in &candidates {
        let Some(envelope) = &header.recovery else {
            continue;
        };
        let wrap_key = recovery_wrap_key(recovery_key, header.vault_id, envelope.key_id)?;
        let Ok(master_key) = unwrap_secret(
            &wrap_key,
            &envelope.wrapped_master_key,
            &recovery_aad(header.vault_id, envelope.key_id),
        ) else {
            continue;
        };
        if valid_header_integrity(header, &master_key) {
            selected = Some((header.clone(), master_key));
            break;
        }
    }
    let (header, master_key) = selected.ok_or(VaultError::WrongRecoveryKey)?;
    if candidates.iter().any(|candidate| {
        candidate.generation > header.generation && valid_header_integrity(candidate, &master_key)
    }) {
        return Err(VaultError::WrongRecoveryKey);
    }
    if candidates.iter().any(|candidate| {
        candidate.generation == header.generation
            && candidate != &header
            && valid_header_integrity(candidate, &master_key)
    }) {
        return Err(VaultError::Corrupt);
    }
    Ok((header, master_key))
}

fn read_header_for_passphrase(
    root: &Path,
    passphrase: &str,
) -> Result<(VaultHeader, SecretKey, SecretKey), VaultError> {
    let mut candidates = read_header_candidates(root);
    if candidates.is_empty() {
        return Err(if root.exists() {
            VaultError::Corrupt
        } else {
            VaultError::Missing
        });
    }
    candidates.sort_by_key(|header| std::cmp::Reverse(header.generation));

    let mut wrapping_keys: Vec<(KdfConfig, SecretKey)> = Vec::new();
    let mut selected = None;
    for header in &candidates {
        let key_index = match wrapping_keys
            .iter()
            .position(|(config, _)| config == &header.kdf)
        {
            Some(index) => index,
            None => {
                let key = derive_passphrase_key(passphrase, &header.kdf)?;
                wrapping_keys.push((header.kdf.clone(), key));
                wrapping_keys.len() - 1
            }
        };
        let Ok(master_key) =
            unwrap_master_key_with_wrapping_key(header, &wrapping_keys[key_index].1)
        else {
            continue;
        };
        if valid_header_integrity(header, &master_key) {
            selected = Some((header.clone(), master_key, key_index));
            break;
        }
    }
    let (header, master_key, key_index) = selected.ok_or(VaultError::WrongPassphrase)?;

    // A valid newer header for this same master key represents a committed passphrase rotation.
    // Do not silently fall back to an older passphrase. Invalid newer tags are damaged copies and
    // may safely be repaired from the authenticated candidate selected above.
    if candidates.iter().any(|candidate| {
        candidate.generation > header.generation && valid_header_integrity(candidate, &master_key)
    }) {
        return Err(VaultError::WrongPassphrase);
    }
    if candidates.iter().any(|candidate| {
        candidate.generation == header.generation
            && candidate != &header
            && valid_header_integrity(candidate, &master_key)
    }) {
        return Err(VaultError::Corrupt);
    }
    let (_, wrapping_key) = wrapping_keys.swap_remove(key_index);
    Ok((header, master_key, wrapping_key))
}

fn header_redundancy_healthy(
    root: &Path,
    selected: &VaultHeader,
    wrapping_key: &[u8; 32],
    master_key: &[u8; 32],
) -> bool {
    let headers = read_headers(root, &HEADER_SLOTS);
    headers.len() == 2
        && headers[0].generation.abs_diff(headers[1].generation) == 1
        && headers
            .iter()
            .any(|header| header.generation == selected.generation)
        && headers.iter().all(|header| {
            header.vault_id == selected.vault_id
                && header.kdf == selected.kdf
                && header.recovery == selected.recovery
                && valid_header_integrity(header, master_key)
                && unwrap_secret(
                    wrapping_key,
                    &header.wrapped_master_key,
                    &header_aad(header.vault_id, header.generation),
                )
                .is_ok_and(|candidate| candidate.as_ref() == master_key)
        })
}

#[derive(Debug, PartialEq, Eq)]
enum HeaderPairWrite {
    Both,
    /// The first generation is durable, so the change is made, but the
    /// redundant second write failed.
    FirstOnly,
}

/// Writes a new pair of header generations, as a passphrase change does. Once
/// the first is in place the change is made, even if its write reported an
/// error after the rename landed; only a first write that did not land is a
/// refusal. `boundary` names the test boundary after the first write.
fn write_header_pair(
    root: &Path,
    first: &VaultHeader,
    second: &VaultHeader,
    boundary: &str,
) -> Result<HeaderPairWrite, VaultError> {
    let first_path = header_path(root, first.generation);
    if let Err(error) =
        atomic_json(&first_path, first).and_then(|()| fail_at_test_boundary(boundary))
    {
        // The rename can land before a directory sync fails. The new header
        // is then the newest one, and the previous key no longer opens the
        // vault, so report the change as made rather than refused.
        let landed = serde_json::to_vec_pretty(first)
            .is_ok_and(|expected| fs::read(&first_path).is_ok_and(|found| found == expected));
        if !landed {
            return Err(error);
        }
        return Ok(HeaderPairWrite::FirstOnly);
    }
    if atomic_json(&header_path(root, second.generation), second).is_err() {
        return Ok(HeaderPairWrite::FirstOnly);
    }
    let _ = fs::remove_file(root.join(LEGACY_HEADER));
    Ok(HeaderPairWrite::Both)
}

/// Rewrites both slots under the wrapping key that unlock already derived for
/// `current`. Deriving it again from the passphrase would run the memory-hard
/// KDF a second time inside the same unlock.
fn repair_header_redundancy(
    root: &Path,
    current: &VaultHeader,
    wrapping_key: &[u8; 32],
    master_key: &[u8; 32],
) -> Result<(), VaultError> {
    fail_at_test_boundary("header.repair")?;
    let first_generation = current
        .generation
        .checked_add(1)
        .ok_or(VaultError::Storage)?;
    let second_generation = first_generation.checked_add(1).ok_or(VaultError::Storage)?;
    let first = build_header_with_key(
        current.vault_id,
        first_generation,
        current.kdf.clone(),
        wrapping_key,
        master_key,
        current.recovery.clone(),
    )?;
    let second = build_header_with_key(
        current.vault_id,
        second_generation,
        current.kdf.clone(),
        wrapping_key,
        master_key,
        current.recovery.clone(),
    )?;
    atomic_json(&header_path(root, first_generation), &first)?;
    atomic_json(&header_path(root, second.generation), &second)?;
    let _ = fs::remove_file(root.join(LEGACY_HEADER));
    Ok(())
}

fn manifest_path(root: &Path, generation: u64) -> PathBuf {
    root.join(format!("manifest-{}.bin", generation % 2))
}

/// Writes a manifest only if the reader would accept it.
///
/// Unlock rejects any manifest that fails `validate_manifest`, and a rejected
/// manifest leaves whole-vault reset as the only action. Every production write
/// goes through this check so a defect in one mutation surfaces as a failed
/// operation instead of a vault that can no longer be opened.
fn write_valid_manifest_at(
    root: &Path,
    master_key: &[u8; 32],
    manifest: &Manifest,
) -> Result<(), VaultError> {
    validate_manifest_structure(manifest, manifest.vault_id).map_err(|_| VaultError::Invalid)?;
    // An object that went missing during the session is damage to the vault,
    // not a mistake in the request being committed.
    if !manifest
        .records
        .iter()
        .all(|record| object_is_present(root, record))
    {
        return Err(VaultError::Corrupt);
    }
    write_manifest_at(root, master_key, manifest)
}

fn write_manifest_at(
    root: &Path,
    master_key: &[u8; 32],
    manifest: &Manifest,
) -> Result<(), VaultError> {
    let keys = derive_keys(manifest.vault_id, master_key)?;
    let plaintext = Zeroizing::new(serde_json::to_vec(manifest).map_err(|_| VaultError::Storage)?);
    if plaintext.len() > MAX_MANIFEST_BYTES.saturating_sub(40) {
        return Err(VaultError::Storage);
    }
    let mut nonce = [0_u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let aad = manifest_aad(manifest.vault_id);
    let ciphertext = XChaCha20Poly1305::new((&keys.manifest).into())
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| VaultError::Storage)?;
    let mut output = Vec::with_capacity(24 + ciphertext.len());
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&ciphertext);
    atomic_bytes(&manifest_path(root, manifest.generation), &output)
}

/// Commits `next` as two consecutive generations, one per slot.
///
/// Once the first write is durable the mutation is committed and `current`
/// reflects it. `between` runs at that point, before the redundant write: a
/// deletion unlinks its ciphertext there. Returns whether the redundant write
/// also succeeded; when it did not, or when `between` failed, the caller's
/// session must enter write-failed recovery, since unlock repairs the slot redundancy.
fn commit_manifest_redundant(
    root: &Path,
    master_key: &[u8; 32],
    current: &mut Manifest,
    mut next: Manifest,
    between: impl FnOnce() -> Result<(), VaultError>,
) -> Result<bool, VaultError> {
    next.generation = current
        .generation
        .checked_add(1)
        .ok_or(VaultError::Storage)?;
    let second_generation = next.generation.checked_add(1).ok_or(VaultError::Storage)?;
    fail_at_test_boundary("manifest.before-first-write")?;
    write_valid_manifest_at(root, master_key, &next)?;
    *current = next.clone();
    terminate_at_test_boundary("manifest.after-first-write");
    if fail_at_test_boundary("manifest.after-first-write").is_err() || between().is_err() {
        return Ok(false);
    }

    next.generation = second_generation;
    if write_valid_manifest_at(root, master_key, &next).is_err() {
        return Ok(false);
    }
    *current = next;
    terminate_at_test_boundary("manifest.after-second-write");
    Ok(true)
}

fn repair_manifest_redundancy(
    root: &Path,
    master_key: &[u8; 32],
    mut manifest: Manifest,
) -> Result<Manifest, VaultError> {
    manifest.generation = manifest
        .generation
        .checked_add(1)
        .ok_or(VaultError::Storage)?;
    fail_at_test_boundary("manifest.repair")?;
    write_valid_manifest_at(root, master_key, &manifest)?;
    Ok(manifest)
}

/// The manifest chosen at unlock and what the session may safely do with it.
struct SelectedManifest {
    manifest: Manifest,
    /// Records whose ciphertext object is missing or is not a regular file.
    unavailable: HashSet<Uuid>,
    /// Set when storage must not be written: repair or orphan cleanup could
    /// destroy a newer manifest or ciphertext that is only temporarily out of reach.
    recovery: Option<RecoveryReason>,
}

/// One manifest slot as found on disk. Read once at unlock; every decision
/// about which generation to open, and whether the slots agree, is made from
/// the two readings without touching the files again.
enum SlotReading {
    Absent,
    /// Present but not an authentic manifest: damage that a repair may replace.
    Damaged,
    /// Exists but could not be read (sharing violation, permission or device
    /// error). It may hold the newest committed state, so nothing may replace
    /// it and no orphan cleanup may run.
    Unreadable,
    Authentic {
        manifest: Manifest,
        /// Records whose object is missing or is not a regular file.
        missing: HashSet<Uuid>,
    },
}

impl SlotReading {
    fn authentic(&self) -> Option<(&Manifest, &HashSet<Uuid>)> {
        match self {
            Self::Authentic { manifest, missing } => Some((manifest, missing)),
            _ => None,
        }
    }

    fn complete(&self) -> Option<&Manifest> {
        self.authentic()
            .filter(|(_, missing)| missing.is_empty())
            .map(|(manifest, _)| manifest)
    }
}

fn read_manifest_slots(
    root: &Path,
    master_key: &[u8; 32],
    vault_id: Uuid,
) -> Result<[SlotReading; 2], VaultError> {
    let keys = derive_keys(vault_id, master_key)?;
    Ok([
        read_manifest_slot_reading(root, &keys.manifest, vault_id, 0),
        read_manifest_slot_reading(root, &keys.manifest, vault_id, 1),
    ])
}

fn read_manifest_slot_reading(
    root: &Path,
    manifest_key: &[u8; 32],
    vault_id: Uuid,
    slot: u64,
) -> SlotReading {
    let data = match read_bounded_regular_file(&manifest_path(root, slot), MAX_MANIFEST_BYTES) {
        Ok(data) => data,
        Err(error) => {
            return match error.kind() {
                io::ErrorKind::NotFound => SlotReading::Absent,
                // Oversized and non-regular slots are damage that repair may replace.
                io::ErrorKind::InvalidData => SlotReading::Damaged,
                _ => SlotReading::Unreadable,
            };
        }
    };
    let Some(manifest) = decrypt_manifest(&data, manifest_key, vault_id) else {
        return SlotReading::Damaged;
    };
    let missing = manifest
        .records
        .iter()
        .filter(|record| !object_is_present(root, record))
        .map(|record| record.id)
        .collect();
    SlotReading::Authentic { manifest, missing }
}

fn decrypt_manifest(data: &[u8], manifest_key: &[u8; 32], vault_id: Uuid) -> Option<Manifest> {
    if data.len() < 40 {
        return None;
    }
    let aad = manifest_aad(vault_id);
    let plaintext = XChaCha20Poly1305::new(manifest_key.into())
        .decrypt(
            XNonce::from_slice(&data[..24]),
            Payload {
                msg: &data[24..],
                aad: &aad,
            },
        )
        .ok()?;
    let plaintext = Zeroizing::new(plaintext);
    let manifest = serde_json::from_slice::<Manifest>(&plaintext).ok()?;
    validate_manifest_structure(&manifest, vault_id).ok()?;
    Some(manifest)
}

/// Which generation an unlock opens, and what the session may do with it.
///
/// - The newest complete generation (authentic, every object present) is
///   opened writable, unless a slot could not be read: it may hold a newer
///   state, so nothing on disk may be replaced or cleaned up.
/// - If the other slot holds a newer authentic generation that was passed over
///   for a lost object, falling back is only safe when that loses nothing.
///   Repair would overwrite the newer manifest and orphan cleanup would delete
///   every intact object only it references. If such an object exists, the
///   newer generation is opened read-only with its lost records unavailable.
/// - If no generation is complete, the newest authentic one is opened
///   read-only so its intact records can still be exported.
fn select_manifest(slots: &[SlotReading; 2]) -> Result<SelectedManifest, VaultError> {
    let slot_unreadable = slots
        .iter()
        .any(|slot| matches!(slot, SlotReading::Unreadable));
    // An unreadable slot outranks lost objects: removing the lost records would
    // commit over a state that may be newer than the one opened.
    let read_only_selection = |manifest: &Manifest, missing: &HashSet<Uuid>| SelectedManifest {
        manifest: manifest.clone(),
        unavailable: missing.clone(),
        recovery: Some(if slot_unreadable {
            RecoveryReason::UnreadableSlot
        } else {
            RecoveryReason::LostObjects
        }),
    };
    let Some(selected) = newest(slots.iter().filter_map(SlotReading::complete))? else {
        // No generation has all of its objects.
        let (manifest, missing) =
            newest(slots.iter().filter_map(SlotReading::authentic))?.ok_or(VaultError::Corrupt)?;
        return Ok(read_only_selection(manifest, missing));
    };
    let kept: HashSet<&str> = selected
        .records
        .iter()
        .map(|record| record.object_name.as_str())
        .collect();
    let newer_with_intact_object = slots
        .iter()
        .filter_map(SlotReading::authentic)
        .filter(|(manifest, _)| manifest.generation > selected.generation)
        .find(|(manifest, missing)| {
            manifest.records.iter().any(|record| {
                !kept.contains(record.object_name.as_str()) && !missing.contains(&record.id)
            })
        });
    if let Some((manifest, missing)) = newer_with_intact_object {
        return Ok(read_only_selection(manifest, missing));
    }
    Ok(SelectedManifest {
        manifest: selected.clone(),
        unavailable: HashSet::new(),
        recovery: slot_unreadable.then_some(RecoveryReason::UnreadableSlot),
    })
}

/// The candidate with the highest generation. Two candidates with the same
/// generation but different content are damage, not a choice.
fn newest<T: Copy + ManifestLike>(
    candidates: impl Iterator<Item = T>,
) -> Result<Option<T>, VaultError> {
    let mut best: Option<T> = None;
    for candidate in candidates {
        match best {
            Some(current) if current.manifest().generation == candidate.manifest().generation => {
                if current.manifest() != candidate.manifest() {
                    return Err(VaultError::Corrupt);
                }
            }
            Some(current) if current.manifest().generation > candidate.manifest().generation => {}
            _ => best = Some(candidate),
        }
    }
    Ok(best)
}

trait ManifestLike {
    fn manifest(&self) -> &Manifest;
}

impl ManifestLike for &Manifest {
    fn manifest(&self) -> &Manifest {
        self
    }
}

impl ManifestLike for (&Manifest, &HashSet<Uuid>) {
    fn manifest(&self) -> &Manifest {
        self.0
    }
}

/// Whether both slots hold the selected state, in adjacent generations, with
/// every object present: the condition after a completed redundant commit.
fn manifest_redundancy_healthy(slots: &[SlotReading; 2], selected: &Manifest) -> bool {
    let (Some(first), Some(second)) = (slots[0].complete(), slots[1].complete()) else {
        return false;
    };
    let adjacent = first.generation.abs_diff(second.generation) == 1;
    let includes_selected =
        first.generation == selected.generation || second.generation == selected.generation;
    let mut first = first.clone();
    let mut second = second.clone();
    first.generation = 0;
    second.generation = 0;
    adjacent && includes_selected && first == second
}

/// A header slot that exists but cannot be read may hold a newer passphrase
/// generation, so repair must not rewrap the key over it.
///
/// The same goes for a slot written in a header format newer than this build
/// knows: a newer build put it there, so it is not damage to repair over.
fn header_slot_unreadable(root: &Path) -> bool {
    HEADER_SLOTS.iter().any(|name| {
        let path = root.join(name);
        file_unreadable(&path, MAX_HEADER_BYTES) || header_from_newer_build(&path)
    })
}

fn header_from_newer_build(path: &Path) -> bool {
    let Ok(data) = read_bounded_regular_file(path, MAX_HEADER_BYTES) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&data).is_ok_and(|header| {
        header["magic"] == "MYCARLOS-VAULT"
            && header["formatVersion"]
                .as_u64()
                .is_some_and(|version| version > u64::from(HEADER_FORMAT))
    })
}

fn file_unreadable(path: &Path, maximum: usize) -> bool {
    match read_bounded_regular_file(path, maximum) {
        Ok(_) => false,
        // Absent, oversized and non-regular slots are damage that repair may replace.
        Err(error) => !matches!(
            error.kind(),
            io::ErrorKind::NotFound | io::ErrorKind::InvalidData
        ),
    }
}

/// The newest complete generation, as an unlock would select before any
/// read-only rule applies.
#[cfg(test)]
fn read_latest_manifest(
    root: &Path,
    master_key: &[u8; 32],
    vault_id: Uuid,
) -> Result<Manifest, VaultError> {
    let slots = read_manifest_slots(root, master_key, vault_id)?;
    newest(slots.iter().filter_map(SlotReading::complete))?
        .cloned()
        .ok_or(VaultError::Corrupt)
}

fn manifest_aad(vault_id: Uuid) -> Vec<u8> {
    [b"mycarlos-manifest-v1:".as_slice(), vault_id.as_bytes()].concat()
}

fn object_aad(vault_id: Uuid, record_id: Uuid, index: u64, final_chunk: bool) -> Vec<u8> {
    let mut aad = Vec::with_capacity(64);
    aad.extend_from_slice(b"mycarlos-object-v1:");
    aad.extend_from_slice(vault_id.as_bytes());
    aad.extend_from_slice(record_id.as_bytes());
    aad.extend_from_slice(&index.to_be_bytes());
    aad.push(u8::from(final_chunk));
    aad
}

fn encrypt_object(
    mut reader: Box<dyn Read + Send>,
    path: &Path,
    context: ObjectContext,
    object_key: &[u8; 32],
    fingerprint_key: &[u8; 32],
) -> Result<EncryptedObject, VaultError> {
    let file = open_private_new(path)?;
    let mut writer = BufWriter::new(file);
    let mut nonce_prefix = [0_u8; 16];
    OsRng.fill_bytes(&mut nonce_prefix);
    writer.write_all(OBJECT_MAGIC)?;
    writer.write_all(&(CHUNK_SIZE as u32).to_be_bytes())?;
    writer.write_all(&nonce_prefix)?;

    let cipher = XChaCha20Poly1305::new(object_key.into());
    let mut mac =
        <HmacSha256 as Mac>::new_from_slice(fingerprint_key).map_err(|_| VaultError::Storage)?;
    mac.update(context.profile_id.as_bytes());
    let mut current = Zeroizing::new(vec![0_u8; CHUNK_SIZE]);
    let mut next = Zeroizing::new(vec![0_u8; CHUNK_SIZE]);
    let mut current_len = read_chunk(&mut reader, &mut current)?;
    let mut total = 0_u64;
    let mut index = 0_u64;
    loop {
        let next_len = if current_len == 0 && index == 0 {
            0
        } else {
            read_chunk(&mut reader, &mut next)?
        };
        let final_chunk = next_len == 0;
        mac.update(&current[..current_len]);
        total = total
            .checked_add(current_len as u64)
            .ok_or(VaultError::Invalid)?;
        let mut nonce = [0_u8; 24];
        nonce[..16].copy_from_slice(&nonce_prefix);
        nonce[16..].copy_from_slice(&index.to_be_bytes());
        let aad = object_aad(context.vault_id, context.record_id, index, final_chunk);
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &current[..current_len],
                    aad: &aad,
                },
            )
            .map_err(|_| VaultError::Storage)?;
        writer.write_all(&(ciphertext.len() as u32).to_be_bytes())?;
        writer.write_all(&[u8::from(final_chunk)])?;
        writer.write_all(&ciphertext)?;
        terminate_at_test_boundary("object.after-chunk-write");
        fail_at_test_boundary("object.after-chunk-write")?;
        if final_chunk {
            break;
        }
        std::mem::swap(&mut current, &mut next);
        current_len = next_len;
        index = index.checked_add(1).ok_or(VaultError::Invalid)?;
    }
    writer.flush()?;
    writer.get_ref().sync_all()?;
    let fingerprint: [u8; 32] = mac.finalize().into_bytes().into();
    Ok(EncryptedObject {
        plaintext_size: total,
        fingerprint,
    })
}

fn verify_object<W: Write>(
    path: &Path,
    mut writer: W,
    vault_id: Uuid,
    record_id: Uuid,
    object_key: &[u8; 32],
    expected_size: u64,
) -> Result<(), VaultError> {
    // An object that is gone, like one that is no longer a regular file, is
    // damage to the vault and not a storage operation that could be retried.
    let file = open_regular_read(path).map_err(|error| {
        if matches!(
            error.kind(),
            io::ErrorKind::InvalidData | io::ErrorKind::NotFound
        ) {
            VaultError::Corrupt
        } else {
            error.into()
        }
    })?;
    let mut reader = BufReader::new(file);
    // An object cut short, such as the empty file a power loss can leave, is
    // damaged ciphertext. Any other read error is a failed storage operation
    // that a retry can get past, not damage to the vault.
    let read_object = |reader: &mut BufReader<File>, buffer: &mut [u8]| {
        reader.read_exact(buffer).map_err(|error| {
            if error.kind() == io::ErrorKind::UnexpectedEof {
                VaultError::Corrupt
            } else {
                error.into()
            }
        })
    };
    let mut read_header = |buffer: &mut [u8]| read_object(&mut reader, buffer);
    let mut magic = [0_u8; 5];
    read_header(&mut magic)?;
    if &magic != OBJECT_MAGIC {
        return Err(VaultError::Corrupt);
    }
    let mut size_bytes = [0_u8; 4];
    read_header(&mut size_bytes)?;
    if u32::from_be_bytes(size_bytes) as usize != CHUNK_SIZE {
        return Err(VaultError::Corrupt);
    }
    let mut nonce_prefix = [0_u8; 16];
    read_header(&mut nonce_prefix)?;
    let cipher = XChaCha20Poly1305::new(object_key.into());
    let mut total = 0_u64;
    let mut index = 0_u64;
    loop {
        let mut length_bytes = [0_u8; 4];
        read_object(&mut reader, &mut length_bytes)?;
        let length = u32::from_be_bytes(length_bytes) as usize;
        if !(16..=CHUNK_SIZE + 16).contains(&length) {
            return Err(VaultError::Corrupt);
        }
        let mut final_byte = [0_u8; 1];
        read_object(&mut reader, &mut final_byte)?;
        if final_byte[0] > 1 {
            return Err(VaultError::Corrupt);
        }
        let final_chunk = final_byte[0] == 1;
        let mut ciphertext = vec![0_u8; length];
        read_object(&mut reader, &mut ciphertext)?;
        let mut nonce = [0_u8; 24];
        nonce[..16].copy_from_slice(&nonce_prefix);
        nonce[16..].copy_from_slice(&index.to_be_bytes());
        let aad = object_aad(vault_id, record_id, index, final_chunk);
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: &ciphertext,
                        aad: &aad,
                    },
                )
                .map_err(|_| VaultError::Corrupt)?,
        );
        total = total
            .checked_add(plaintext.len() as u64)
            .ok_or(VaultError::Corrupt)?;
        writer.write_all(&plaintext)?;
        if final_chunk {
            let mut trailing = [0_u8; 1];
            if reader.read(&mut trailing)? != 0 || total != expected_size {
                return Err(VaultError::Corrupt);
            }
            writer.flush()?;
            return Ok(());
        }
        index = index.checked_add(1).ok_or(VaultError::Corrupt)?;
    }
}

fn read_chunk(reader: &mut dyn Read, buffer: &mut [u8]) -> Result<usize, VaultError> {
    let mut used = 0;
    while used < buffer.len() {
        match reader.read(&mut buffer[used..]) {
            Ok(0) => break,
            Ok(read) => used += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(used)
}

/// The directory that holds the vault and everything the vault manages beside
/// it: its lock file, a pending reset, a create stage, the export journal.
/// Nothing else is ever written there, which is what lets an export refuse the
/// whole directory.
fn vault_home(root: &Path) -> Result<&Path, VaultError> {
    root.parent().ok_or(VaultError::Storage)
}

fn sibling_path(root: &Path, suffix: &str) -> Result<PathBuf, VaultError> {
    let mut name = root.file_name().ok_or(VaultError::Storage)?.to_os_string();
    name.push(suffix);
    Ok(root.with_file_name(name))
}

fn acquire_storage_lock(root: &Path) -> Result<Arc<File>, VaultError> {
    create_private_dir_all(vault_home(root)?)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    #[cfg(windows)]
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    // This file must never be unlinked or renamed, including during vault reset. Otherwise
    // another process could lock a new inode while the old inode is still held.
    let file = options.open(sibling_path(root, ".lock")?)?;
    if !is_regular_non_reparse(&file.metadata()?) {
        return Err(VaultError::Storage);
    }
    // A lock can outlive its owner's close by a moment: on Unix a subprocess
    // forked meanwhile holds a copy of the descriptor until it execs, and
    // Windows releases a closed handle's lock asynchronously. Another instance
    // holds the lock for as long as it runs, so a short wait tells them apart.
    let deadline = Instant::now() + STORAGE_LOCK_GRACE;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(Arc::new(file)),
            Err(fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(STORAGE_LOCK_RETRY);
            }
            Err(fs::TryLockError::WouldBlock) => return Err(VaultError::InUse),
            Err(fs::TryLockError::Error(error)) => return Err(error.into()),
        }
    }
}

const STORAGE_LOCK_GRACE: Duration = Duration::from_millis(250);
const STORAGE_LOCK_RETRY: Duration = Duration::from_millis(10);

fn reset_path(root: &Path) -> Result<PathBuf, VaultError> {
    sibling_path(root, ".reset-pending")
}

fn remove_key_envelopes(directory: &Path) -> Result<(), VaultError> {
    // An interrupted header write leaves a wrapped key in its temporary directory.
    remove_abandoned_atomic_writes(directory);
    // Every envelope wraps the same key, so one that cannot be removed must not
    // keep the others on disk. Try them all and report the first failure.
    let mut failure = None;
    for header in [HEADER_SLOTS[0], HEADER_SLOTS[1], LEGACY_HEADER] {
        match fs::remove_file(directory.join(header)) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                failure.get_or_insert(error);
            }
        }
    }
    failure.map_or(Ok(()), |error| Err(error.into()))
}

/// Marks an export as under way in this process until it is dropped.
struct ExportInFlight(Uuid);

impl ExportInFlight {
    fn new(id: Uuid) -> Self {
        EXPORTS_IN_FLIGHT
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id);
        Self(id)
    }
}

impl Drop for ExportInFlight {
    fn drop(&mut self) {
        EXPORTS_IN_FLIGHT
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.0);
    }
}

fn export_in_flight(entry: &Path) -> bool {
    entry
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| Uuid::parse_str(name).ok())
        .is_some_and(|id| {
            EXPORTS_IN_FLIGHT
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .contains(&id)
        })
}

/// Writes a durable journal entry naming an export's staging folder, in the
/// vault home, and returns the entry's path.
fn journal_export(root: &Path, id: Uuid, stage: &Path) -> Result<PathBuf, VaultError> {
    let home = vault_home(root)?;
    let journal = home.join(EXPORT_JOURNAL);
    if !journal.exists() {
        create_private_dir_all(&journal)?;
        // The first entry is only durable once the journal itself is.
        sync_parent(home);
    }
    let entry = journal.join(id.to_string());
    let mut file = open_private_new(&entry)?;
    let written = file
        .write_all(&encode_path(stage))
        .and_then(|()| file.sync_all());
    if let Err(error) = written {
        let _ = fs::remove_file(&entry);
        return Err(error.into());
    }
    sync_parent(&journal);
    Ok(entry)
}

fn create_stage_dir(stage: &Path) -> Result<(), VaultError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(stage)?;
    }
    #[cfg(not(unix))]
    fs::create_dir(stage)?;
    Ok(())
}

/// Removes an export's staging folder and then its journal entry, whether the
/// export succeeded or not. The entry is kept if the folder could not be
/// removed, so the next start tries again.
fn finish_export(stage: &Path, entry: Option<&Path>) {
    match fs::remove_dir_all(stage) {
        Ok(()) => {
            if let Some(parent) = stage.parent() {
                sync_parent(parent);
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return,
    }
    if let Some(entry) = entry {
        if fs::remove_file(entry).is_ok() {
            if let Some(journal) = entry.parent() {
                sync_parent(journal);
            }
        }
    }
}

/// Removes the staging folders of exports that a process which died left
/// behind, each holding a readable copy of a document, and their journal
/// entries. Best effort. The caller holds the storage lock, which keeps out
/// other processes while a session is open, and exports under way in this
/// process are skipped; another process can only sweep once this session has
/// locked, after which an export writes nothing readable (a copy it already
/// wrote but has not yet renamed is removed, and that export fails). Outside
/// the vault home it only removes a real directory (not a link) named like our
/// staging folders. An entry is kept for a later start when it cannot be read, when
/// something else has taken the folder's name, or when the folder's parent is
/// missing, as when its drive is not connected (a best guess: a drive
/// remounted elsewhere, or a mount point that stays when the drive is out,
/// loses the entry). Checking a folder on an unreachable network drive can
/// block until the drive answers.
fn remove_abandoned_exports(home: &Path) {
    let journal = home.join(EXPORT_JOURNAL);
    if !is_real_dir(&journal) {
        return;
    }
    let Ok(entries) = fs::read_dir(&journal) else {
        return;
    };
    for entry in entries.flatten() {
        let entry_path = entry.path();
        // Still being written by this process: not abandoned.
        if export_in_flight(&entry_path) {
            continue;
        }
        let bytes = match read_bounded_regular_file(&entry_path, MAX_EXPORT_JOURNAL_BYTES) {
            Ok(bytes) => bytes,
            // Not a regular file, or too long to be one of ours.
            Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                let _ = fs::remove_file(&entry_path);
                continue;
            }
            // Perhaps held open for a moment by a scanner; try at a later start.
            Err(_) => continue,
        };
        let stage =
            decode_path(&bytes).filter(|stage| stage.is_absolute() && is_export_stage_name(stage));
        let Some(stage) = stage else {
            // Not an entry this app wrote: drop it, and touch nothing it names.
            let _ = fs::remove_file(&entry_path);
            continue;
        };
        let done = match fs::symlink_metadata(&stage) {
            // A link or junction is never followed. Other reparse points, such
            // as OneDrive's on a synced folder, are still real folders.
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                fs::remove_dir_all(&stage).is_ok()
            }
            // Something else has that name; it is not ours to remove.
            Ok(_) => false,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                stage.parent().is_some_and(|parent| parent.exists())
            }
            Err(_) => false,
        };
        if done {
            let _ = fs::remove_file(&entry_path);
        }
    }
    sync_parent(&journal);
}

fn is_export_stage_name(stage: &Path) -> bool {
    stage
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix(EXPORT_STAGE_PREFIX))
        .is_some_and(|id| Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id))
}

/// A path as bytes that `decode_path` reads back exactly on the same platform.
#[cfg(unix)]
fn encode_path(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(unix)]
fn decode_path(bytes: &[u8]) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(bytes)))
}

#[cfg(windows)]
fn encode_path(path: &Path) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}

#[cfg(windows)]
fn decode_path(bytes: &[u8]) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    if bytes.len() % 2 != 0 {
        return None;
    }
    let wide: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    Some(PathBuf::from(std::ffi::OsString::from_wide(&wide)))
}

/// Removes staging directories that a `create` left behind when the process
/// died before the rename. Each holds headers that wrap a key under the chosen
/// passphrase, so it must not outlive the attempt or a later reset. Best effort:
/// an abandoned stage never blocks access to the vault. The caller holds the
/// storage lock, so no other `create` can own a stage.
fn remove_abandoned_create_stages(parent: &Path) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let is_stage = entry.file_name().to_str().is_some_and(|name| {
            name.strip_prefix(CREATE_STAGE_PREFIX)
                .is_some_and(|id| Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id))
        });
        let path = entry.path();
        // `DirEntry::file_type` does not follow links, so a link is never entered.
        if !is_stage || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        if remove_key_envelopes(&path).is_ok() {
            sync_parent(&path);
        }
        if fs::remove_dir_all(&path).is_ok() {
            sync_parent(parent);
        }
    }
}

// The caller holds the stable sibling lock. A retired directory is itself the durable reset
// intent, so partial deletion and process death can be retried without the passphrase.
fn finish_pending_resets(root: &Path) -> Result<bool, VaultError> {
    let parent = root.parent().ok_or(VaultError::Storage)?;
    remove_abandoned_create_stages(parent);
    remove_abandoned_restore_stages(parent);
    remove_abandoned_exports(parent);
    let mut resumed = false;
    // A verified restore whose vault was already retired goes in place before
    // anything is erased: if the erasing then fails, the patient still has a
    // vault.
    if !root.exists() && activate_restore(root)? {
        resumed = true;
    }
    resumed |= erase_retired_vault(root)?;
    // A restore that was verified but not yet in place takes the live vault's
    // place now; the vault it retires is erased as a reset's is.
    if activate_restore(root)? {
        erase_retired_vault(root)?;
        resumed = true;
    }
    Ok(resumed)
}

fn erase_retired_vault(root: &Path) -> Result<bool, VaultError> {
    let parent = root.parent().ok_or(VaultError::Storage)?;
    let pending = reset_path(root)?;
    let mut resumed = false;
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let path = entry.path();
        if path != pending {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(VaultError::Storage);
        }
        #[cfg(windows)]
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(VaultError::Storage);
        }
        fail_at_test_boundary("reset.before-cleanup")?;
        // Erase key envelopes first. Keep the retired directory until all deletion succeeds.
        remove_key_envelopes(&path)?;
        sync_parent(&path);
        terminate_at_test_boundary("reset.after-key-removal");
        fs::remove_dir_all(&path)?;
        sync_parent(parent);
        resumed = true;
    }
    Ok(resumed)
}

fn read_bounded_regular_file(path: &Path, maximum: usize) -> io::Result<Vec<u8>> {
    let file = open_regular_read(path)?;
    let metadata = file.metadata()?;
    if metadata.len() > maximum as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file is not a bounded regular file",
        ));
    }
    let mut data = Vec::with_capacity(metadata.len() as usize);
    file.take((maximum as u64).saturating_add(1))
        .read_to_end(&mut data)?;
    if data.len() > maximum {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file exceeds its format limit",
        ));
    }
    Ok(data)
}

pub(crate) fn open_regular_read(path: &Path) -> io::Result<File> {
    let metadata = fs::symlink_metadata(path)?;
    if !is_regular_non_reparse(&metadata) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "path is not a regular file",
        ));
    }
    open_without_following(path)
}

/// Opens `path` without following a link, then checks the handle itself. The
/// handle check is authoritative: the path can be replaced after any earlier
/// inspection of it.
pub(crate) fn open_without_following(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    // Without O_NONBLOCK, a FIFO swapped in after the caller's check would block
    // this open forever, leaving an import unresolved or the session mutex held.
    // The flag has no effect on reads from a regular file.
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    #[cfg(windows)]
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let file = options.open(path)?;
    if !is_regular_non_reparse(&file.metadata()?) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "handle is not a regular file",
        ));
    }
    Ok(file)
}

fn is_regular_non_reparse(metadata: &fs::Metadata) -> bool {
    if !metadata.file_type().is_file() {
        return false;
    }
    #[cfg(windows)]
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return false;
    }
    true
}

fn atomic_json(path: &Path, value: &impl Serialize) -> Result<(), VaultError> {
    let data = serde_json::to_vec_pretty(value).map_err(|_| VaultError::Storage)?;
    atomic_bytes(path, &data)
}

fn atomic_bytes(path: &Path, data: &[u8]) -> Result<(), VaultError> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    AtomicFile::new(path, AllowOverwrite)
        .write_with_options(|file| file.write_all(data), options)
        .map_err(io::Error::from)?;
    Ok(())
}

fn create_private_dir(path: &Path) -> Result<(), VaultError> {
    fs::create_dir(path)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn create_private_dir_all(path: &Path) -> Result<(), VaultError> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    // The mode covers every directory created on the way, such as a `staging`
    // directory that a backup tool dropped, and not only the final one.
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn open_private_new(path: &Path) -> Result<File, VaultError> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path).map_err(Into::into)
}

/// Makes renames into `directory` durable, reporting failure. Windows cannot
/// open a directory this way; there the renames rely on the filesystem journal.
///
/// Storage that cannot sync a directory at all is refused when the vault is
/// created, so here that answer means the vault was moved somewhere it cannot
/// be kept safely; it is reported, not tolerated.
fn sync_dir(directory: &Path) -> Result<(), VaultError> {
    #[cfg(unix)]
    File::open(directory)?
        .sync_all()
        .map_err(classify_directory_sync_error)?;
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

/// EINVAL, ENOTSUP and EOPNOTSUPP from a directory fsync mean the filesystem
/// cannot confirm durability, which some network, FUSE and removable-storage
/// filesystems cannot. Compared as raw codes: how the standard library
/// classifies them differs by platform, and macOS does not report ENOTSUP as
/// `Unsupported`.
#[cfg(unix)]
fn classify_directory_sync_error(error: io::Error) -> VaultError {
    let unsupported = error
        .raw_os_error()
        .is_some_and(|code| [libc::EINVAL, libc::ENOTSUP, libc::EOPNOTSUPP].contains(&code));
    if unsupported {
        VaultError::UnsupportedStorage
    } else {
        error.into()
    }
}

/// Refuses to create a vault where a commit could be reported as failed after
/// it landed: the atomic-write primitive syncs the parent directory after each
/// rename and fails when that is unsupported.
fn ensure_storage_supports_directory_sync(directory: &Path) -> Result<(), VaultError> {
    sync_dir(directory)
}

/// Best-effort variant for cleanup paths, where a failure changes nothing the
/// caller could do.
fn sync_parent(parent: &Path) {
    let _ = sync_dir(parent);
}

/// Whether `path` is a directory itself and not a link or reparse point to one.
/// `read_dir` follows a link, so cleanup that entered a linked `staging` or
/// `objects` would delete the contents of whatever directory it points at.
fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        #[cfg(windows)]
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return false;
        }
        metadata.is_dir()
    })
}

fn remove_staging(root: &Path) {
    let staging = root.join("staging");
    if !is_real_dir(&staging) {
        return;
    }
    if let Ok(entries) = fs::read_dir(&staging) {
        for entry in entries.flatten() {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Removes the temporary directories of atomic writes that the process did not
/// survive. One may hold a header that wraps the master key under a passphrase
/// since replaced, or a manifest that still carries the wrapped key of a record
/// since deleted, so it must not outlive the next writable unlock or a reset.
/// Best effort, and only while the caller holds the storage lock.
fn remove_abandoned_atomic_writes(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let is_temporary = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(ATOMIC_WRITE_PREFIX));
        // `DirEntry::file_type` does not follow links, so a link is never entered.
        if is_temporary
            && entry.file_type().is_ok_and(|kind| kind.is_dir())
            && fs::remove_dir_all(entry.path()).is_ok()
        {
            sync_parent(directory);
        }
    }
}

/// Backup and sync tools drop empty directories. A vault restored without
/// `objects` would otherwise fail every import until it is reset. Only a
/// missing directory is created: an existing entry is never followed or
/// re-permissioned here.
fn ensure_objects_dir(root: &Path) -> Result<(), VaultError> {
    let objects = root.join("objects");
    match fs::symlink_metadata(&objects) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => create_private_dir(&objects),
        _ => Ok(()),
    }
}

fn remove_orphan_objects(root: &Path, manifest: &Manifest) {
    let referenced: HashSet<&str> = manifest
        .records
        .iter()
        .map(|record| record.object_name.as_str())
        .collect();
    let objects = root.join("objects");
    if !is_real_dir(&objects) {
        return;
    }
    if let Ok(entries) = fs::read_dir(objects) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_referenced = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| referenced.contains(name));
            if path.is_file() && !is_referenced {
                let _ = fs::remove_file(path);
            }
        }
    }
}

fn require_profile(manifest: &Manifest, profile_id: Uuid) -> Result<(), VaultError> {
    if manifest
        .profiles
        .iter()
        .any(|profile| profile.id == profile_id)
    {
        Ok(())
    } else {
        Err(VaultError::NotFound)
    }
}

fn validate_folder_ids(
    manifest: &Manifest,
    profile_id: Uuid,
    folder_ids: &[Uuid],
) -> Result<(), VaultError> {
    if folder_ids.len() <= MAX_FOLDER_ASSIGNMENTS
        && folder_ids.iter().all(|id| {
            manifest
                .folders
                .iter()
                .any(|folder| folder.id == *id && folder.profile_id == profile_id)
        })
    {
        Ok(())
    } else {
        Err(VaultError::Invalid)
    }
}

fn unique(values: Vec<Uuid>) -> Vec<Uuid> {
    let mut seen = HashSet::new();
    values.into_iter().filter(|id| seen.insert(*id)).collect()
}

fn folder_map(manifest: &Manifest) -> HashMap<Uuid, Option<Uuid>> {
    manifest
        .folders
        .iter()
        .map(|folder| (folder.id, folder.parent_id))
        .collect()
}

fn ensure_depth(
    manifest: &Manifest,
    mut parent: Option<Uuid>,
    child_depth: usize,
) -> Result<(), VaultError> {
    let parents = folder_map(manifest);
    let mut depth = child_depth;
    let mut seen = HashSet::new();
    while let Some(id) = parent {
        if !seen.insert(id) {
            return Err(VaultError::Corrupt);
        }
        depth += 1;
        if depth > 32 {
            return Err(VaultError::Invalid);
        }
        parent = *parents.get(&id).ok_or(VaultError::NotFound)?;
    }
    Ok(())
}

fn is_descendant(manifest: &Manifest, mut candidate: Uuid, ancestor: Uuid) -> bool {
    let parents = folder_map(manifest);
    let mut seen = HashSet::new();
    loop {
        if candidate == ancestor {
            return true;
        }
        if !seen.insert(candidate) {
            return true;
        }
        match parents.get(&candidate).copied().flatten() {
            Some(parent) => candidate = parent,
            None => return false,
        }
    }
}

fn subtree_depth(manifest: &Manifest, root: Uuid) -> Result<usize, VaultError> {
    fn visit(
        manifest: &Manifest,
        current: Uuid,
        seen: &mut HashSet<Uuid>,
    ) -> Result<usize, VaultError> {
        if !seen.insert(current) {
            return Err(VaultError::Corrupt);
        }
        let child_depth = manifest
            .folders
            .iter()
            .filter(|folder| folder.parent_id == Some(current))
            .map(|folder| visit(manifest, folder.id, seen))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .max()
            .unwrap_or(0);
        seen.remove(&current);
        Ok(child_depth + 1)
    }
    visit(manifest, root, &mut HashSet::new())
}

/// A portable backup is the vault's ciphertext in one file: a magic line, then
/// length-prefixed entries (the header, the manifest, then every document's
/// encrypted object), then a trailer listing each entry's length and SHA-256,
/// authenticated with HMAC-SHA-256 under a key derived from the master key.
/// No document, name or detail in it is readable without the passphrase or
/// the recovery key. What is in clear is listed in VAULT_FORMAT.md.
const BACKUP_MAGIC: &[u8; 16] = b"MYCARLOS-BACKUP\n";
const BACKUP_FORMAT: u32 = 1;
const BACKUP_KIND_HEADER: u8 = 1;
const BACKUP_KIND_MANIFEST: u8 = 2;
const BACKUP_KIND_OBJECT: u8 = 3;
const BACKUP_KIND_TRAILER: u8 = 0xff;
const MAX_BACKUP_NAME_BYTES: usize = 64;
const MAX_BACKUP_TRAILER_BYTES: usize = 64 * 1024 * 1024;
/// A restore being staged in the vault home, removed if a start finds it.
const RESTORE_STAGE_PREFIX: &str = ".restore-";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupEntry {
    kind: u8,
    name: String,
    length: u64,
    sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupTrailer {
    format: u32,
    vault_id: Uuid,
    manifest_generation: u64,
    created_at_ms: u64,
    entries: Vec<BackupEntry>,
}

/// What opens a backup: the passphrase it was made with, or the recovery key.
pub enum RestoreCredential<'a> {
    Passphrase(&'a str),
    RecoveryKey(&'a str),
}

/// What restoring a backup would replace, so that the patient can decide
/// before anything changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RestoreReplaces {
    /// There is no vault on this device.
    Nothing,
    /// The vault on this device is the one the backup was made from.
    SameVault,
    /// The vault on this device is a different one, which would be erased.
    OtherVault,
    /// The vault on this device could not be read, so whether it is the
    /// backup's cannot be told. It would be erased.
    Unreadable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub replaces: RestoreReplaces,
    /// The vault on this device is the backup's, and is not what the backup
    /// holds: its documents, passphrase or recovery key have changed since,
    /// or it could not be read to tell. Restoring loses those changes.
    pub differs_from_this_device: bool,
    pub document_count: usize,
    /// Which backup this describes: a hash of its header and manifest.
    #[serde(skip)]
    pub(crate) fingerprint: [u8; 32],
}

fn backup_key(vault_id: Uuid, master_key: &[u8; 32]) -> Result<SecretKey, VaultError> {
    let hkdf = Hkdf::<Sha256>::new(Some(vault_id.as_bytes()), master_key);
    let mut key = Zeroizing::new([0_u8; 32]);
    hkdf.expand(b"mycarlos/backup/v1", key.as_mut())
        .map_err(|_| VaultError::Storage)?;
    Ok(key)
}

fn backup_tag(key: &[u8; 32], trailer: &[u8]) -> Result<HmacSha256, VaultError> {
    let mut mac =
        <HmacSha256 as Mac>::new_from_slice(key.as_ref()).map_err(|_| VaultError::Storage)?;
    mac.update(BACKUP_MAGIC);
    mac.update(trailer);
    Ok(mac)
}

/// Copies exactly `length` bytes, hashing them. A source that ends early or
/// has more to give is refused: a backup entry is exactly what was recorded.
fn copy_hashed(
    source: &mut impl Read,
    destination: &mut impl Write,
    length: u64,
    short: VaultError,
) -> Result<String, VaultError> {
    use sha2::Digest;
    let mut hasher = Sha256::new();
    let mut remaining = length;
    let mut buffer = vec![0_u8; CHUNK_SIZE.min(64 * 1024)];
    while remaining > 0 {
        let wanted = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        let read = source.read(&mut buffer[..wanted])?;
        if read == 0 {
            return Err(short);
        }
        hasher.update(&buffer[..read]);
        destination.write_all(&buffer[..read])?;
        remaining -= read as u64;
    }
    Ok(BASE64.encode(hasher.finalize()))
}

struct BackupWriter<W: Write> {
    inner: W,
    entries: Vec<BackupEntry>,
}

impl<W: Write> BackupWriter<W> {
    fn new(mut inner: W) -> Result<Self, VaultError> {
        inner.write_all(BACKUP_MAGIC)?;
        Ok(Self {
            inner,
            entries: Vec::new(),
        })
    }

    fn entry(
        &mut self,
        kind: u8,
        name: &str,
        length: u64,
        source: &mut impl Read,
    ) -> Result<(), VaultError> {
        let name_length = u16::try_from(name.len()).map_err(|_| VaultError::Storage)?;
        self.inner.write_all(&[kind])?;
        self.inner.write_all(&name_length.to_be_bytes())?;
        self.inner.write_all(name.as_bytes())?;
        self.inner.write_all(&length.to_be_bytes())?;
        // A file that changed length while it was copied is not what the
        // manifest describes.
        let sha256 = copy_hashed(source, &mut self.inner, length, VaultError::Storage)?;
        self.entries.push(BackupEntry {
            kind,
            name: name.to_owned(),
            length,
            sha256,
        });
        Ok(())
    }

    fn finish(
        mut self,
        master_key: &[u8; 32],
        vault_id: Uuid,
        manifest_generation: u64,
        now_ms: u64,
    ) -> Result<(), VaultError> {
        let trailer = serde_json::to_vec(&BackupTrailer {
            format: BACKUP_FORMAT,
            vault_id,
            manifest_generation,
            created_at_ms: now_ms,
            entries: self.entries,
        })
        .map_err(|_| VaultError::Storage)?;
        let tag = backup_tag(&*backup_key(vault_id, master_key)?, &trailer)?
            .finalize()
            .into_bytes();
        let length = u32::try_from(trailer.len()).map_err(|_| VaultError::Storage)?;
        self.inner.write_all(&[BACKUP_KIND_TRAILER])?;
        self.inner.write_all(&length.to_be_bytes())?;
        self.inner.write_all(&trailer)?;
        self.inner.write_all(&tag)?;
        self.inner.flush()?;
        Ok(())
    }
}

/// Reads a backup in order, recording what it read so that the trailer can
/// be checked against it. Every format problem is `BackupUnreadable`.
struct BackupReader<R: Read> {
    inner: R,
    entries: Vec<BackupEntry>,
}

impl<R: Read> BackupReader<R> {
    fn new(mut inner: R) -> Result<Self, VaultError> {
        let mut magic = [0_u8; 16];
        inner
            .read_exact(&mut magic)
            .map_err(|_| VaultError::BackupUnreadable)?;
        if &magic != BACKUP_MAGIC {
            return Err(VaultError::BackupUnreadable);
        }
        Ok(Self {
            inner,
            entries: Vec::new(),
        })
    }

    fn read_exact_or_unreadable(&mut self, buffer: &mut [u8]) -> Result<(), VaultError> {
        self.inner.read_exact(buffer).map_err(|error| {
            if error.kind() == io::ErrorKind::UnexpectedEof {
                VaultError::BackupUnreadable
            } else {
                error.into()
            }
        })
    }

    /// The next entry's kind, name and length, or None at the trailer.
    fn next_entry(&mut self) -> Result<Option<(u8, String, u64)>, VaultError> {
        let mut kind = [0_u8; 1];
        self.read_exact_or_unreadable(&mut kind)?;
        if kind[0] == BACKUP_KIND_TRAILER {
            return Ok(None);
        }
        let mut name_length = [0_u8; 2];
        self.read_exact_or_unreadable(&mut name_length)?;
        let name_length = usize::from(u16::from_be_bytes(name_length));
        if name_length > MAX_BACKUP_NAME_BYTES {
            return Err(VaultError::BackupUnreadable);
        }
        let mut name = vec![0_u8; name_length];
        self.read_exact_or_unreadable(&mut name)?;
        let name = String::from_utf8(name).map_err(|_| VaultError::BackupUnreadable)?;
        let mut length = [0_u8; 8];
        self.read_exact_or_unreadable(&mut length)?;
        Ok(Some((kind[0], name, u64::from_be_bytes(length))))
    }

    fn copy_entry(
        &mut self,
        kind: u8,
        name: &str,
        length: u64,
        destination: &mut impl Write,
    ) -> Result<(), VaultError> {
        let sha256 = copy_hashed(
            &mut self.inner,
            destination,
            length,
            VaultError::BackupUnreadable,
        )?;
        self.entries.push(BackupEntry {
            kind,
            name: name.to_owned(),
            length,
            sha256,
        });
        Ok(())
    }

    /// Reads an entry that must be `kind` and at most `maximum` bytes.
    fn small_entry(&mut self, kind: u8, maximum: usize) -> Result<Vec<u8>, VaultError> {
        let (found, name, length) = self.next_entry()?.ok_or(VaultError::BackupUnreadable)?;
        if found != kind || length > maximum as u64 {
            return Err(VaultError::BackupUnreadable);
        }
        let mut data = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
        self.copy_entry(kind, &name, length, &mut data)?;
        Ok(data)
    }

    /// Checks the trailer, once every entry before it has been read: it must
    /// be authentic under this vault's backup key, list exactly the entries
    /// read, and describe this manifest. Nothing may follow it.
    fn finish(
        mut self,
        master_key: &[u8; 32],
        vault_id: Uuid,
        manifest_generation: u64,
    ) -> Result<(), VaultError> {
        let mut length = [0_u8; 4];
        self.read_exact_or_unreadable(&mut length)?;
        let length = u32::from_be_bytes(length) as usize;
        if length > MAX_BACKUP_TRAILER_BYTES {
            return Err(VaultError::BackupUnreadable);
        }
        let mut trailer = vec![0_u8; length];
        self.read_exact_or_unreadable(&mut trailer)?;
        let mut tag = [0_u8; 32];
        self.read_exact_or_unreadable(&mut tag)?;
        backup_tag(&*backup_key(vault_id, master_key)?, &trailer)?
            .verify_slice(&tag)
            .map_err(|_| VaultError::BackupUnreadable)?;
        let trailer: BackupTrailer =
            serde_json::from_slice(&trailer).map_err(|_| VaultError::BackupUnreadable)?;
        if trailer.format != BACKUP_FORMAT
            || trailer.vault_id != vault_id
            || trailer.manifest_generation != manifest_generation
            || trailer.entries != self.entries
        {
            return Err(VaultError::BackupUnreadable);
        }
        let mut extra = [0_u8; 1];
        if self.inner.read(&mut extra)? != 0 {
            return Err(VaultError::BackupUnreadable);
        }
        Ok(())
    }
}

/// Opens a backup's header with the credential, as unlock would: the master
/// key, which the header's integrity tag must also accept.
fn open_backup_header(
    data: &[u8],
    credential: &RestoreCredential<'_>,
) -> Result<(VaultHeader, SecretKey), VaultError> {
    let header: VaultHeader =
        serde_json::from_slice(data).map_err(|_| VaultError::BackupUnreadable)?;
    if !valid_header(&header) || header.generation == 0 {
        return Err(VaultError::BackupUnreadable);
    }
    let master_key = match credential {
        RestoreCredential::Passphrase(passphrase) => {
            if passphrase.len() > MAX_PASSPHRASE_BYTES {
                return Err(VaultError::Invalid);
            }
            let wrapping_key = derive_passphrase_key(passphrase, &header.kdf)?;
            unwrap_master_key_with_wrapping_key(&header, &wrapping_key)?
        }
        RestoreCredential::RecoveryKey(text) => {
            let key = decode_recovery_key(text)?;
            let envelope = header
                .recovery
                .as_ref()
                .ok_or(VaultError::WrongRecoveryKey)?;
            let wrap_key = recovery_wrap_key(&key, header.vault_id, envelope.key_id)?;
            unwrap_secret(
                &wrap_key,
                &envelope.wrapped_master_key,
                &recovery_aad(header.vault_id, envelope.key_id),
            )
            .map_err(|_| VaultError::WrongRecoveryKey)?
        }
    };
    if !valid_header_integrity(&header, &master_key) {
        return Err(VaultError::BackupUnreadable);
    }
    Ok((header, master_key))
}

/// A backup opened as far as its manifest, with the reader positioned at the
/// first object.
struct OpenedBackup<R: Read> {
    reader: BackupReader<R>,
    header: VaultHeader,
    master_key: SecretKey,
    manifest: Manifest,
    manifest_data: Vec<u8>,
}

/// Reads a backup's header and manifest: what inspecting it needs, and the
/// first part of a restore.
fn open_backup<R: Read>(
    source: R,
    credential: &RestoreCredential<'_>,
) -> Result<OpenedBackup<R>, VaultError> {
    let mut reader = BackupReader::new(source)?;
    let header_data = reader.small_entry(BACKUP_KIND_HEADER, MAX_HEADER_BYTES)?;
    let (header, master_key) = open_backup_header(&header_data, credential)?;
    let manifest_data = reader.small_entry(BACKUP_KIND_MANIFEST, MAX_MANIFEST_BYTES)?;
    let keys = derive_keys(header.vault_id, &master_key)?;
    let manifest = decrypt_manifest(&manifest_data, &keys.manifest, header.vault_id)
        .ok_or(VaultError::BackupUnreadable)?;
    Ok(OpenedBackup {
        reader,
        header,
        master_key,
        manifest,
        manifest_data,
    })
}

/// A generous upper limit on an encrypted object's size, from its document's
/// size: the object's own header, and room for every chunk's nonce, tag and
/// length several times over.
fn largest_object_len(plaintext_size: u64) -> u64 {
    let chunks = plaintext_size / CHUNK_SIZE as u64 + 2;
    plaintext_size
        .saturating_add(4096)
        .saturating_add(chunks.saturating_mul(256))
}

fn restore_ready_path(root: &Path) -> Result<PathBuf, VaultError> {
    sibling_path(root, ".restore-ready")
}

/// Puts a verified restore in place of the live vault. Each step is one
/// rename, and every start repeats whatever is left: the live vault is
/// retired as a reset retires it (its key envelopes are erased next), then
/// the verified copy takes its place.
fn activate_restore(root: &Path) -> Result<bool, VaultError> {
    let ready = restore_ready_path(root)?;
    if !is_real_dir(&ready) {
        return Ok(false);
    }
    let parent = root.parent().ok_or(VaultError::Storage)?;
    // A verified copy has a header. Without one this is what is left of a
    // copy that was being discarded, and no vault is given up for it.
    if !HEADER_SLOTS.iter().any(|slot| ready.join(slot).is_file()) {
        let _ = fs::remove_dir_all(&ready);
        sync_parent(parent);
        return Ok(false);
    }
    let mut retired_here = None;
    if root.exists() {
        let retired = reset_path(root)?;
        // Pending resets finish before this runs, so a retired vault still
        // here means that could not be done; keep both and report it.
        if retired.exists() {
            return Err(VaultError::Storage);
        }
        fail_at_test_boundary("restore.before-retire")?;
        fs::rename(root, &retired)?;
        sync_parent(parent);
        terminate_at_test_boundary("restore.after-retire");
        retired_here = Some(retired);
    }
    if let Err(error) = fail_at_test_boundary("restore.before-activate")
        .and_then(|()| fs::rename(&ready, root).map_err(VaultError::from))
    {
        // Put back the vault this retired, so that the failure leaves the
        // vault as it was. Only if that fails too is the verified copy the
        // one vault left, which the next start puts in place.
        if let Some(retired) = retired_here {
            let restored = fail_at_test_boundary("restore.before-rollback")
                .and_then(|()| fs::rename(&retired, root).map_err(VaultError::from));
            sync_parent(parent);
            if restored.is_err() {
                return Err(VaultError::RestoreUnfinished);
            }
        }
        return Err(error);
    }
    sync_parent(parent);
    terminate_at_test_boundary("restore.after-activate");
    Ok(true)
}

/// Removes restores that were being staged and never verified.
fn remove_abandoned_restore_stages(parent: &Path) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let is_stage = entry.file_name().to_str().is_some_and(|name| {
            name.strip_prefix(RESTORE_STAGE_PREFIX)
                .is_some_and(|id| Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id))
        });
        if !is_stage || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let path = entry.path();
        if remove_key_envelopes(&path).is_ok() {
            sync_parent(&path);
        }
        if fs::remove_dir_all(&path).is_ok() {
            sync_parent(parent);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::{
        io::Cursor,
        process::{Command, Stdio},
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc,
        },
        time::{Duration, Instant},
    };

    /// Whether two metadata describe the same inode (or, on Windows, the same
    /// file index), so a file was kept rather than replaced under its name.
    fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            a.ino() == b.ino() && a.dev() == b.dev()
        }
        #[cfg(not(unix))]
        {
            a.created().ok() == b.created().ok() && a.len() == b.len()
        }
    }

    const PASSWORD: &str = "river-azimuth-cobalt-sparrow-934";
    const PASSPHRASE_REPLACEMENT: &str = "lantern-orbit-willow-cascade-572";

    #[derive(Deserialize)]
    struct CorruptObjectRegression {
        name: String,
        bytes: Vec<u8>,
    }

    fn source(name: &str, data: &[u8]) -> ImportSource {
        ImportSource {
            display_name: name.to_owned(),
            reader: Box::new(Cursor::new(data.to_vec())),
        }
    }

    fn valid_manifest_fixture(root: &Path) -> (Uuid, Manifest) {
        fs::create_dir_all(root.join("objects")).unwrap();
        let vault_id = Uuid::new_v4();
        let first_profile = Uuid::new_v4();
        let second_profile = Uuid::new_v4();
        let first_folder = Uuid::new_v4();
        let second_folder = Uuid::new_v4();
        let first_record = Uuid::new_v4();
        let second_record = Uuid::new_v4();
        let first_object = format!("{}.mcobj", Uuid::new_v4());
        let second_object = format!("{}.mcobj", Uuid::new_v4());
        fs::write(root.join("objects").join(&first_object), b"object").unwrap();
        fs::write(root.join("objects").join(&second_object), b"object").unwrap();
        let wrapped = WrappedSecret {
            nonce: BASE64.encode([0x11_u8; 24]),
            ciphertext: BASE64.encode([0x22_u8; 48]),
        };
        let manifest = Manifest {
            format_version: VAULT_FORMAT,
            vault_id,
            generation: 7,
            profiles: vec![
                PatientProfile {
                    id: first_profile,
                    display_name: "Jamie".to_owned(),
                    created_at_ms: 1,
                },
                PatientProfile {
                    id: second_profile,
                    display_name: "Morgan".to_owned(),
                    created_at_ms: 2,
                },
            ],
            folders: vec![
                VaultFolder {
                    id: first_folder,
                    profile_id: first_profile,
                    parent_id: None,
                    name: "Labs".to_owned(),
                    created_at_ms: 3,
                },
                VaultFolder {
                    id: second_folder,
                    profile_id: second_profile,
                    parent_id: None,
                    name: "Imaging".to_owned(),
                    created_at_ms: 4,
                },
            ],
            records: vec![
                StoredRecord {
                    id: first_record,
                    profile_id: first_profile,
                    folder_ids: vec![first_folder],
                    display_name: "first.pdf".to_owned(),
                    source_label: "Manual import — unverified".to_owned(),
                    media_type: "application/octet-stream".to_owned(),
                    plaintext_size: 6,
                    imported_at_ms: 5,
                    object_name: first_object,
                    fingerprint: BASE64.encode([0x33_u8; 32]),
                    wrapped_object_key: wrapped.clone(),
                },
                StoredRecord {
                    id: second_record,
                    profile_id: second_profile,
                    folder_ids: vec![second_folder],
                    display_name: "second.pdf".to_owned(),
                    source_label: "Manual import — unverified".to_owned(),
                    media_type: "application/octet-stream".to_owned(),
                    plaintext_size: 6,
                    imported_at_ms: 6,
                    object_name: second_object,
                    fingerprint: BASE64.encode([0x44_u8; 32]),
                    wrapped_object_key: wrapped,
                },
            ],
        };
        (vault_id, manifest)
    }

    struct FailingReader;

    impl Read for FailingReader {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("synthetic interrupted read"))
        }
    }

    struct GeneratedReader {
        remaining: u64,
        largest_request: Arc<AtomicUsize>,
    }

    impl Read for GeneratedReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.largest_request
                .fetch_max(buffer.len(), Ordering::Relaxed);
            let length = usize::try_from(self.remaining.min(buffer.len() as u64)).unwrap();
            buffer[..length].fill(0x5a);
            self.remaining -= length as u64;
            Ok(length)
        }
    }

    fn copy_directory(source: &Path, destination: &Path) {
        fs::create_dir(destination).unwrap();
        for entry in fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            let target = destination.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_directory(&entry.path(), &target);
            } else {
                fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    fn files_below(root: &Path) -> Vec<PathBuf> {
        let mut files = Vec::new();
        for entry in fs::read_dir(root).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                files.extend(files_below(&entry.path()));
            } else {
                files.push(entry.path());
            }
        }
        files
    }

    fn run_termination_child(root: &Path, operation: &str, boundary: &str) {
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "vault::tests::termination_child"])
            .env("MYCARLOS_TEST_ROOT", root)
            .env("MYCARLOS_TEST_OPERATION", operation)
            .env("MYCARLOS_TEST_TERMINATE_AT", boundary)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert_eq!(
            status.code(),
            Some(TEST_TERMINATION_EXIT_CODE),
            "{boundary}"
        );
    }

    fn run_failure_child(root: &Path, operation: &str, boundary: &str) {
        run_failure_child_with(root, operation, boundary, &[]);
    }

    fn run_failure_child_with(
        root: &Path,
        operation: &str,
        boundary: &str,
        environment: &[(&str, &str)],
    ) {
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "vault::tests::failure_child"])
            .envs(environment.iter().copied())
            .env("MYCARLOS_TEST_ROOT", root)
            .env("MYCARLOS_TEST_OPERATION", operation)
            .env("MYCARLOS_TEST_FAIL_AT", boundary)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "{boundary}");
    }

    #[test]
    #[ignore = "invoked as an abrupt-termination subprocess by the recovery matrix"]
    fn termination_child() {
        let Ok(root) = std::env::var("MYCARLOS_TEST_ROOT") else {
            return;
        };
        let operation = std::env::var("MYCARLOS_TEST_OPERATION").unwrap();
        let store = VaultStore::new(PathBuf::from(root));
        store.unlock(PASSWORD).unwrap();
        let snapshot = store.snapshot().unwrap();
        match operation.as_str() {
            "import" => {
                store
                    .import(
                        snapshot.profiles[0].id,
                        vec![],
                        vec![source("crash-test.pdf", b"synthetic crash boundary record")],
                        2,
                    )
                    .unwrap();
            }
            "delete" => store.delete_record(snapshot.records[0].id).unwrap(),
            "reset" => store.reset().unwrap(),
            "export" => {
                let destination = std::env::var("MYCARLOS_TEST_EXPORT_TO").unwrap();
                store
                    .export_atomic(snapshot.records[0].id, Path::new(&destination))
                    .unwrap();
            }
            _ => panic!("unknown termination-child operation"),
        }
        panic!("configured termination boundary was not reached");
    }

    #[test]
    #[ignore = "invoked as an injected-write-failure subprocess by the recovery matrix"]
    fn failure_child() {
        let Ok(root) = std::env::var("MYCARLOS_TEST_ROOT") else {
            return;
        };
        let operation = std::env::var("MYCARLOS_TEST_OPERATION").unwrap();
        let store = VaultStore::new(PathBuf::from(root));
        if operation == "reset-recovery" {
            assert!(matches!(store.status(), Err(VaultError::NoSpace)));
            assert!(matches!(
                store.create(PASSWORD, "Jamie", 3),
                Err(VaultError::NoSpace)
            ));
            assert!(matches!(store.unlock(PASSWORD), Err(VaultError::NoSpace)));
            assert!(matches!(store.reset(), Err(VaultError::NoSpace)));
            assert!(!store.root.exists());
            assert!(reset_path(&store.root).unwrap().exists());
            return;
        }
        if operation == "recover" {
            // The first header landed, so the passphrase is replaced, and
            // opening the vault repairs the second slot.
            let key = std::env::var("MYCARLOS_TEST_RECOVERY_KEY").unwrap();
            assert!(store.recover(&key, PASSPHRASE_REPLACEMENT).unwrap());
            assert_eq!(store.snapshot().unwrap().recovery, None);
            return;
        }
        store.unlock(PASSWORD).unwrap();
        let snapshot = store.snapshot().unwrap();
        if operation == "unlock-degraded" {
            assert!(snapshot.recovery.is_some());
            assert!(matches!(
                store.create_profile("Blocked in recovery", 2),
                Err(VaultError::RecoveryMode)
            ));
            return;
        }
        let outcome = match operation.as_str() {
            "import" => store
                .import(
                    snapshot.profiles[0].id,
                    vec![],
                    vec![source(
                        "failure-test.pdf",
                        b"synthetic write failure record",
                    )],
                    2,
                )
                .map(|_| ()),
            "delete" => store.delete_record(snapshot.records[0].id),
            "passphrase" => store.change_passphrase(PASSWORD, PASSPHRASE_REPLACEMENT),
            "recovery-key" => {
                let key = store.begin_recovery_key(PASSWORD).unwrap();
                let groups = recovery_key_groups(&key);
                store.confirm_recovery_key(&[(0, &groups[0]), (6, &groups[6])], 7)
            }
            _ => panic!("unknown failure-child operation"),
        };
        let committed = matches!(
            std::env::var("MYCARLOS_TEST_FAIL_AT").as_deref(),
            Ok("manifest.after-first-write"
                | "delete.after-object-unlink"
                | "passphrase.after-first-write"
                | "recovery-key.after-first-write")
        );
        if committed {
            assert!(outcome.is_ok());
            assert!(store.snapshot().unwrap().recovery.is_some());
        } else {
            assert!(matches!(outcome, Err(VaultError::NoSpace)));
            if operation == "import" {
                let root = PathBuf::from(std::env::var("MYCARLOS_TEST_ROOT").unwrap());
                assert_eq!(fs::read_dir(root.join("objects")).unwrap().count(), 0);
            }
        }
    }

    #[test]
    #[ignore = "invoked by the cross-process vault ownership regression"]
    fn storage_lock_child() {
        let Ok(root) = std::env::var("MYCARLOS_TEST_ROOT") else {
            return;
        };
        let store = VaultStore::new(PathBuf::from(root));
        if std::env::var("MYCARLOS_TEST_OPERATION").as_deref() == Ok("denied") {
            assert!(matches!(store.status(), Err(VaultError::InUse)));
            assert!(matches!(
                store.create(PASSWORD, "Jamie", 2),
                Err(VaultError::InUse)
            ));
            assert!(matches!(store.unlock(PASSWORD), Err(VaultError::InUse)));
            assert!(matches!(store.reset(), Err(VaultError::InUse)));
        } else {
            store.unlock(PASSWORD).unwrap();
            let snapshot = store.snapshot().unwrap();
            assert_eq!(snapshot.records.len(), 1);
            store
                .create_folder(snapshot.profiles[0].id, None, "Second process", 3)
                .unwrap();
        }
    }

    #[test]
    fn concurrent_processes_cannot_overwrite_or_reset_an_open_vault() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let run_child = |operation: &str| {
            let status = Command::new(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", "vault::tests::storage_lock_child"])
                .env("MYCARLOS_TEST_ROOT", &root)
                .env("MYCARLOS_TEST_OPERATION", operation)
                .status()
                .unwrap();
            assert!(status.success(), "{operation}");
        };
        run_child("denied");
        let profile = store.snapshot().unwrap().profiles[0].id;
        let record = store
            .import(
                profile,
                vec![],
                vec![source("report.pdf", b"keep this record")],
                2,
            )
            .unwrap()
            .imported[0];
        assert!(matches!(
            store.export_atomic(record, &sibling_path(&root, ".lock").unwrap()),
            Err(VaultError::Invalid)
        ));
        // Windows and macOS resolve a differently cased name to the same file.
        assert!(matches!(
            store.export_atomic(record, &root.with_file_name("VAULT.LOCK")),
            Err(VaultError::Invalid)
        ));
        // A regular file under a pending-reset name would make every later
        // status, unlock, create and reset fail closed.
        for name in ["vault.reset-pending", "Vault.Reset-Pending"] {
            assert!(matches!(
                store.export_atomic(record, &root.with_file_name(name)),
                Err(VaultError::Invalid)
            ));
            assert!(!root.with_file_name(name).exists());
        }
        assert!(matches!(
            VaultStore::new(root.clone()).unlock(PASSWORD),
            Err(VaultError::InUse)
        ));
        store.lock();
        run_child("write");
        store.unlock(PASSWORD).unwrap();
        let mut output = Vec::new();
        store.export(record, &mut output).unwrap();
        assert_eq!(output, b"keep this record");
        assert_eq!(store.snapshot().unwrap().folders[0].name, "Second process");
    }

    #[test]
    fn session_ownership_survives_reunlock_and_releases_on_drop() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let first = VaultStore::new(root.clone());
        let second = VaultStore::new(root);
        first.create(PASSWORD, "Jamie", 1).unwrap();
        first.unlock(PASSWORD).unwrap();
        assert!(matches!(second.unlock(PASSWORD), Err(VaultError::InUse)));
        assert!(matches!(
            first.unlock("wrong"),
            Err(VaultError::WrongPassphrase)
        ));
        assert!(matches!(second.reset(), Err(VaultError::InUse)));
        drop(first);
        second.unlock(PASSWORD).unwrap();
        second.reset().unwrap();
        assert_eq!(second.status().unwrap(), VaultStatus::Absent);
    }

    #[test]
    fn interrupted_reset_is_finished_before_startup_or_creation() {
        for boundary in ["reset.after-rename", "reset.after-key-removal"] {
            for create_directly in [false, true] {
                let temp = tempfile::tempdir().unwrap();
                let root = temp.path().join("vault");
                let store = VaultStore::new(root.clone());
                store.create(PASSWORD, "Jamie", 1).unwrap();
                let profile = store.snapshot().unwrap().profiles[0].id;
                store
                    .import(profile, vec![], vec![source("old.pdf", b"old record")], 2)
                    .unwrap();
                store.lock();
                run_termination_child(&root, "reset", boundary);
                let retired = reset_path(&root).unwrap();
                assert!(!root.exists());
                assert!(retired.exists());
                let restarted = VaultStore::new(root);
                if create_directly {
                    restarted.create(PASSWORD, "New profile", 3).unwrap();
                    assert!(restarted.snapshot().unwrap().records.is_empty());
                } else {
                    assert_eq!(restarted.status().unwrap(), VaultStatus::Absent);
                }
                assert!(!retired.exists());
            }
        }
    }

    #[test]
    fn failed_reset_cleanup_blocks_access_and_can_be_retried() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        store.lock();
        let retired = reset_path(&root).unwrap();
        fs::rename(&root, &retired).unwrap();
        run_failure_child(&root, "reset-recovery", "reset.before-cleanup");
        assert!(retired.join("header-0.json").exists());
        store.reset().unwrap();
        assert!(!retired.exists());
        assert_eq!(store.status().unwrap(), VaultStatus::Absent);
    }

    #[test]
    fn export_refuses_every_destination_inside_the_vault_home() {
        // The vault's parent directory holds only entries the vault manages: the
        // vault, its lock, a pending reset, a create stage. Nothing may be
        // written there by name, so no list of names has to stay complete.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let record = store
            .import(profile, vec![], vec![source("report.pdf", b"record")], 2)
            .unwrap()
            .imported[0];
        let home = root.parent().unwrap();

        for name in ["copy.pdf", "vault.lock", ".create-notes", "anything"] {
            assert!(
                matches!(
                    store.export_atomic(record, &home.join(name)),
                    Err(VaultError::Invalid)
                ),
                "{name}"
            );
            assert!(!home.join(name).exists() || name == "vault.lock", "{name}");
        }
        // Beside the home is fine: that is the user's space.
        store
            .export_atomic(record, &temp.path().join("copy.pdf"))
            .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_vault_home_is_created_private() {
        use std::os::unix::fs::PermissionsExt as _;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        VaultStore::new(root.clone())
            .create(PASSWORD, "Jamie", 1)
            .unwrap();
        let mode = fs::metadata(root.parent().unwrap())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn a_name_word_is_refused_whichever_unicode_form_the_name_was_stored_in() {
        // "Renée" stored with e + combining acute. A combining mark is not
        // alphanumeric, so splitting before normalizing would break the name
        // into "Rene" and "e" and miss "renée" in the passphrase.
        let names = ["Rene\u{301}e Qvarnstrom"];
        assert!(matches!(
            validate_new_passphrase("lantern ren\u{e9}e orbit willow cascade", &names),
            Err(VaultError::WeakPassphrase)
        ));
    }

    #[test]
    fn passphrase_length_is_counted_in_the_normalized_form() {
        // 14 visible characters. Typed with a decomposed accent they are 15 code
        // points, which must not pass a rule the composed form fails.
        let composed = "caf\u{e9}-orbit-572";
        let decomposed = "cafe\u{301}-orbit-572";
        assert_eq!(composed.chars().count(), MIN_PASSPHRASE_CHARS - 1);
        assert_eq!(decomposed.chars().count(), MIN_PASSPHRASE_CHARS);
        for passphrase in [composed, decomposed] {
            assert!(
                matches!(
                    validate_new_passphrase(passphrase, &[]),
                    Err(VaultError::Invalid)
                ),
                "{passphrase:?}"
            );
        }
    }

    #[test]
    fn a_passphrase_unlocks_whichever_unicode_form_it_is_typed_in() {
        // "café" with a precomposed é, then with e + combining acute. The same
        // visible passphrase must derive the same key on every keyboard.
        const COMPOSED: &str = "caf\u{e9} lantern orbit willow cascade 572";
        const DECOMPOSED: &str = "cafe\u{301} lantern orbit willow cascade 572";
        assert_ne!(COMPOSED.as_bytes(), DECOMPOSED.as_bytes());

        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(COMPOSED, "Jamie", 1).unwrap();
        store.lock();
        store.unlock(DECOMPOSED).unwrap();
        store
            .change_passphrase(COMPOSED, "river azimuth cobalt sparrow 934")
            .unwrap();
    }

    #[test]
    fn a_passphrase_containing_a_profile_name_word_is_refused() {
        let names = ["Brzezykowa Qvarnstrom"];
        for passphrase in [
            "QvarnstromBrzezykowa1",
            "Brzezykowa+Qvarnstrom",
            "lantern qvarnstrom orbit willow cascade",
            "Lantern-BRZEZYKOWA-orbit-572",
        ] {
            assert!(
                matches!(
                    validate_new_passphrase(passphrase, &names),
                    Err(VaultError::WeakPassphrase)
                ),
                "{passphrase}"
            );
        }
        // Short words such as "Al" or "Lee" would forbid too much.
        validate_new_passphrase("lantern orbit willow cascade 572", &["Al Lee"]).unwrap();
        // A word that merely shares letters is not the name.
        validate_new_passphrase("lantern orbit willow cascade 572", &["Cascadia Orbital"]).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn storage_that_cannot_sync_a_directory_is_refused_not_tolerated() {
        for code in [libc::EINVAL, libc::ENOTSUP, libc::EOPNOTSUPP] {
            assert!(matches!(
                classify_directory_sync_error(io::Error::from_raw_os_error(code)),
                VaultError::UnsupportedStorage
            ));
        }
        for code in [libc::EIO, libc::ENOSPC] {
            assert!(!matches!(
                classify_directory_sync_error(io::Error::from_raw_os_error(code)),
                VaultError::UnsupportedStorage
            ));
        }
    }

    #[test]
    fn a_lock_released_moments_later_is_not_reported_as_in_use() {
        // A lock can be held for a moment after its owner closed it: on Unix a
        // subprocess forked meanwhile holds a copy of the descriptor until it
        // execs, and on Windows a closed handle's lock is released shortly after.
        // Another instance holds the lock for as long as it is open, so a short
        // wait tells the two apart.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let lock_path = sibling_path(&root, ".lock").unwrap();
        fs::write(&lock_path, b"").unwrap();
        let held = File::open(&lock_path).unwrap();
        held.try_lock().unwrap();
        let holder = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            drop(held);
        });

        acquire_storage_lock(&root).unwrap();
        holder.join().unwrap();
    }

    #[test]
    fn a_lock_held_by_another_instance_is_reported_as_in_use_promptly() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let lock_path = sibling_path(&root, ".lock").unwrap();
        fs::write(&lock_path, b"").unwrap();
        let held = File::open(&lock_path).unwrap();
        held.try_lock().unwrap();

        let started = Instant::now();
        assert!(matches!(
            acquire_storage_lock(&root),
            Err(VaultError::InUse)
        ));
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(held);
    }

    #[test]
    fn reset_keeps_the_lock_file() {
        // Another process may hold the lock's inode; a new inode under the same
        // name would let both open the vault.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let lock = sibling_path(&root, ".lock").unwrap();
        let inode_before = fs::metadata(&lock).unwrap();
        store.reset().unwrap();
        assert_eq!(store.status().unwrap(), VaultStatus::Absent);
        assert!(same_file(&inode_before, &fs::metadata(&lock).unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn pending_reset_symlinks_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let target = temp.path().join("unrelated");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep"), b"unrelated data").unwrap();
        std::os::unix::fs::symlink(&target, reset_path(&root).unwrap()).unwrap();
        let store = VaultStore::new(root);
        assert!(matches!(store.status(), Err(VaultError::Storage)));
        assert!(matches!(
            store.create(PASSWORD, "Jamie", 1),
            Err(VaultError::Storage)
        ));
        assert!(target.join("keep").exists());
    }

    #[test]
    fn vault_round_trip_survives_lock_and_restart() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let folder = store.create_folder(profile, None, "Hospital", 2).unwrap();
        let imported = store
            .import(
                profile,
                vec![folder],
                vec![source("report.bin", b"private clinical bytes")],
                3,
            )
            .unwrap();
        let record = imported.imported[0];
        store.lock();
        assert_eq!(store.status().unwrap(), VaultStatus::Locked);

        let restarted = VaultStore::new(root);
        restarted.unlock(PASSWORD).unwrap();
        let mut output = Vec::new();
        restarted.export(record, &mut output).unwrap();
        assert_eq!(output, b"private clinical bytes");
        assert_eq!(restarted.snapshot().unwrap().folders[0].name, "Hospital");
    }

    #[test]
    fn renamed_records_and_nested_folders_persist_without_changing_documents() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let parent = store.create_folder(profile, None, "Hospital", 2).unwrap();
        let folder = store
            .create_folder(profile, Some(parent), "Old folder", 3)
            .unwrap();
        let record = store
            .import(
                profile,
                vec![folder],
                vec![source("old.pdf", b"synthetic PDF content")],
                4,
            )
            .unwrap()
            .imported[0];
        let mut expected = store
            .unlocked
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .manifest
            .records[0]
            .clone();
        let object_path = root.join("objects").join(&expected.object_name);
        let ciphertext = fs::read(&object_path).unwrap();

        store
            .update_folder(folder, Some(parent), "  FAKE renamed folder  ")
            .unwrap();
        store
            .rename_record(record, "  FAKE renamed document.pdf  ")
            .unwrap();
        expected.display_name = "FAKE renamed document.pdf".to_owned();
        assert!(
            store
                .unlocked
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .manifest
                .records[0]
                == expected
        );
        assert_eq!(fs::read(&object_path).unwrap(), ciphertext);
        store.lock();

        let restarted = VaultStore::new(root.clone());
        restarted.unlock(PASSWORD).unwrap();
        let snapshot = restarted.snapshot().unwrap();
        let renamed_folder = snapshot
            .folders
            .iter()
            .find(|item| item.id == folder)
            .unwrap();
        assert_eq!(renamed_folder.name, "FAKE renamed folder");
        assert_eq!(renamed_folder.parent_id, Some(parent));
        assert_eq!(snapshot.records[0].folder_ids, vec![folder]);
        assert_eq!(
            restarted.export_name(record).unwrap(),
            "FAKE renamed document.pdf"
        );
        let mut exported = Vec::new();
        restarted.export(record, &mut exported).unwrap();
        assert_eq!(exported, b"synthetic PDF content");
        assert!(restarted
            .import(
                profile,
                vec![],
                vec![source("copy.pdf", b"synthetic PDF content")],
                5
            )
            .unwrap()
            .imported
            .is_empty());
        for entry in fs::read_dir(&root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_file() {
                let bytes = fs::read(path).unwrap();
                assert!(!bytes
                    .windows(b"FAKE renamed".len())
                    .any(|part| part == b"FAKE renamed"));
            }
        }
    }

    #[test]
    fn invalid_and_read_only_renames_leave_metadata_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let record = store
            .import(profile, vec![], vec![source("old.pdf", b"synthetic")], 2)
            .unwrap()
            .imported[0];
        let before = store.snapshot().unwrap().records;
        for name in [
            "",
            "   ",
            "../escape.pdf",
            "a/b.pdf",
            "a\\b.pdf",
            "CON.pdf",
            "bad:name.pdf",
            "bad\nname.pdf",
            "trailing.",
            "hidden\u{202e}.pdf",
            &"x".repeat(241),
            &"é".repeat(121),
        ] {
            assert!(
                matches!(store.rename_record(record, name), Err(VaultError::Invalid)),
                "{name:?}"
            );
            assert_eq!(store.snapshot().unwrap().records, before);
        }
        store.unlocked.lock().unwrap().as_mut().unwrap().recovery =
            Some(RecoveryReason::WriteFailed);
        assert!(matches!(
            store.rename_record(record, "new.pdf"),
            Err(VaultError::RecoveryMode)
        ));
        assert_eq!(store.snapshot().unwrap().records, before);
    }

    #[test]
    fn file_extension_matches_the_rename_dialog() {
        // The same cases as `fileExtension` in src/native/recordPresentation.test.ts.
        for (name, extension) in [
            ("Results.pdf", ".pdf"),
            ("Results.PDF", ".PDF"),
            ("Results.Pdf", ".Pdf"),
            ("a.pdf", ".pdf"),
            ("Report.pdf.pdf", ".pdf"),
            ("Report\u{2028}A.pdf", ".pdf"),
            ("字.pdf", ".pdf"),
            (".pdf", ""),
            ("pdf", ""),
            ("Resultspdf", ""),
            ("Results.pdf~", ""),
            ("Results.pdf\nA", ""),
            ("archive.tar.gz", ""),
            ("notes.c", ""),
            ("Scan 3.5 notes", ""),
            ("Visit 10.30am", ""),
            ("Mr.Jones", ""),
            ("字字", ""),
            ("photo.jpg", ""),
            ("Results.txt", ""),
            (".notes.pdf", ".pdf"),
            ("..pdf", ".pdf"),
            ("Results.pdf ", ""),
            ("Results.pdx", ""),
            ("Results.pd", ""),
            ("Results.pxf", ""),
            ("Results.xdf", ""),
            ("Results.df", ""),
            ("Results.pf", ""),
            ("Results.pdff", ""),
        ] {
            assert_eq!(file_extension(name), extension, "{name:?}");
        }
    }

    #[test]
    fn a_legacy_name_with_trailing_unicode_space_renames_as_the_pdf_it_is() {
        // Builds before the current sanitizer could store "X.pdf" followed by a
        // no-break space. Judged after trimming, as renames are, it is a PDF name.
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let record = store
            .import(profile, vec![], vec![source("X.pdf", b"synthetic pdf")], 2)
            .unwrap()
            .imported[0];
        store
            .mutate_manifest(|manifest| {
                manifest.records[0].display_name = "X.pdf\u{a0}".to_owned();
                Ok(())
            })
            .unwrap();
        let name_of = || store.snapshot().unwrap().records[0].display_name.clone();

        // Saved unedited, it is tidied, as it was before extensions were kept.
        store.rename_record(record, "X.pdf\u{a0}").unwrap();
        assert_eq!(name_of(), "X.pdf");
        store
            .mutate_manifest(|manifest| {
                manifest.records[0].display_name = "X.pdf\u{3000}".to_owned();
                Ok(())
            })
            .unwrap();
        assert!(matches!(
            store.rename_record(record, "Y"),
            Err(VaultError::Invalid)
        ));
        store.rename_record(record, "Y.pdf").unwrap();
        assert_eq!(name_of(), "Y.pdf");
    }

    #[test]
    fn a_rename_keeps_an_uppercase_extension_as_it_is() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let record = store
            .import(
                profile,
                vec![],
                vec![source("Results.PDF", b"synthetic pdf")],
                2,
            )
            .unwrap()
            .imported[0];
        for name in ["Lab.pdf", "Lab.Pdf", "Lab"] {
            assert!(
                matches!(store.rename_record(record, name), Err(VaultError::Invalid)),
                "{name:?}"
            );
        }
        store.rename_record(record, "Lab.PDF").unwrap();
        assert_eq!(store.snapshot().unwrap().records[0].display_name, "Lab.PDF");
    }

    #[test]
    fn a_rename_keeps_the_file_extension() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let imported = store
            .import(
                profile,
                vec![],
                vec![
                    source("Results.pdf", b"synthetic pdf"),
                    source("Scan 3.5 notes", b"synthetic without extension"),
                    source("photo.jpg", b"synthetic image"),
                ],
                2,
            )
            .unwrap()
            .imported;
        let (pdf, plain, photo) = (imported[0], imported[1], imported[2]);
        let name_of = |id| {
            store
                .snapshot()
                .unwrap()
                .records
                .into_iter()
                .find(|r| r.id == id)
                .unwrap()
                .display_name
        };

        for name in [
            "Results",
            "Results.txt",
            "Results.PDF",
            "Results.pdf.txt",
            ".pdf",
        ] {
            assert!(
                matches!(store.rename_record(pdf, name), Err(VaultError::Invalid)),
                "{name:?}"
            );
            assert_eq!(name_of(pdf), "Results.pdf");
        }
        store.rename_record(pdf, "a.pdf").unwrap();
        assert_eq!(name_of(pdf), "a.pdf");
        store.rename_record(pdf, "Lab results.pdf").unwrap();
        assert_eq!(name_of(pdf), "Lab results.pdf");

        // Only ".pdf" is locked: the vault holds only PDFs, and a name such as
        // "Visit 10.30am" or "Mr.Jones" has no file type, so it stays renameable.
        store.rename_record(plain, "Visit 10.30am").unwrap();
        // "pdf" without the dot is part of a name, not an extension, and so is
        // ".pdf" anywhere but the end.
        store.rename_record(plain, "Visit 11ampdf").unwrap();
        store.rename_record(plain, "Scan.pdf.txt").unwrap();
        store.rename_record(plain, ".pdf notes").unwrap();
        store.rename_record(plain, ".PDFx").unwrap();
        store.rename_record(plain, "Visit 11am").unwrap();
        assert_eq!(name_of(plain), "Visit 11am");
        // A desktop picker can still return another kind of file, and a
        // ".pdf" lock added by mistake could never be removed.
        // Only ".pdf" is locked: another extension can change or go.
        store.rename_record(photo, "photo").unwrap();
        store.rename_record(photo, "photo.png").unwrap();
        // A name without ".pdf" cannot gain it, even as the whole name.
        for name in ["Scan notes.pdf", "Scan notes.PDF", ".pdf", ".PDF"] {
            assert!(
                matches!(store.rename_record(plain, name), Err(VaultError::Invalid)),
                "{name:?}"
            );
            assert_eq!(name_of(plain), "Visit 11am");
        }
    }

    #[test]
    fn privileged_operations_reject_locked_state_and_unknown_ids() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root);
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let unknown = Uuid::new_v4();

        assert!(matches!(
            store.rename_record(unknown, "new.pdf"),
            Err(VaultError::NotFound)
        ));

        assert!(matches!(
            store.create_folder(unknown, None, "Unknown", 2),
            Err(VaultError::NotFound)
        ));
        assert!(matches!(
            store.update_folder(unknown, None, "Unknown"),
            Err(VaultError::NotFound)
        ));
        assert!(matches!(
            store.assign_folders(unknown, vec![]),
            Err(VaultError::NotFound)
        ));
        assert!(matches!(
            store.import(
                unknown,
                vec![],
                vec![source("unknown.pdf", b"never read")],
                2
            ),
            Err(VaultError::NotFound)
        ));
        assert!(matches!(
            store.export(unknown, io::sink()),
            Err(VaultError::NotFound)
        ));
        assert!(matches!(
            store.export_name(unknown),
            Err(VaultError::NotFound)
        ));

        store.lock();
        assert!(matches!(
            store.rename_record(unknown, "new.pdf"),
            Err(VaultError::Locked)
        ));
        assert!(matches!(store.snapshot(), Err(VaultError::Locked)));
        assert!(matches!(
            store.create_profile("Morgan", 3),
            Err(VaultError::Locked)
        ));
        assert!(matches!(
            store.create_folder(unknown, None, "Unknown", 3),
            Err(VaultError::Locked)
        ));
        assert!(matches!(
            store.update_folder(unknown, None, "Unknown"),
            Err(VaultError::Locked)
        ));
        assert!(matches!(
            store.assign_folders(unknown, vec![]),
            Err(VaultError::Locked)
        ));
        assert!(matches!(
            store.import(
                unknown,
                vec![],
                vec![source("locked.pdf", b"never read")],
                3
            ),
            Err(VaultError::Locked)
        ));
        assert!(matches!(
            store.export(unknown, io::sink()),
            Err(VaultError::Locked)
        ));
        assert!(matches!(
            store.export_name(unknown),
            Err(VaultError::Locked)
        ));
        assert!(matches!(
            store.delete_record(unknown),
            Err(VaultError::Locked)
        ));
        assert!(matches!(
            store.change_passphrase(PASSWORD, "lantern-orbit-willow-cascade-572"),
            Err(VaultError::Locked)
        ));
    }

    #[test]
    fn wrong_password_and_tampering_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let record = store
            .import(profile, vec![], vec![source("record", b"secret")], 2)
            .unwrap()
            .imported[0];
        store.lock();
        assert!(matches!(
            store.unlock("Wrong#8Pass"),
            Err(VaultError::WrongPassphrase)
        ));
        store.unlock(PASSWORD).unwrap();
        let object_name = {
            let guard = store.unlocked.lock().unwrap();
            guard.as_ref().unwrap().manifest.records[0]
                .object_name
                .clone()
        };
        let path = root.join("objects").join(object_name);
        let original = fs::read(&path).unwrap();
        let mut bytes = original.clone();
        *bytes.last_mut().unwrap() ^= 1;
        fs::write(&path, bytes).unwrap();
        assert!(matches!(
            store.export(record, io::sink()),
            Err(VaultError::Corrupt)
        ));

        fs::write(&path, &original[..original.len() - 1]).unwrap();
        assert!(matches!(
            store.export(record, io::sink()),
            Err(VaultError::Corrupt)
        ));
    }

    #[test]
    fn duplicate_detection_is_profile_scoped() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let first_profile = store.snapshot().unwrap().profiles[0].id;
        let second_profile = store.create_profile("Morgan", 2).unwrap();
        assert_eq!(
            store
                .import(first_profile, vec![], vec![source("a", b"same")], 3)
                .unwrap()
                .imported
                .len(),
            1
        );
        assert_eq!(
            store
                .import(first_profile, vec![], vec![source("b", b"same")], 4)
                .unwrap()
                .skipped_duplicates,
            vec!["b"]
        );
        assert_eq!(
            store
                .import(second_profile, vec![], vec![source("c", b"same")], 5)
                .unwrap()
                .imported
                .len(),
            1
        );
    }

    #[test]
    fn an_import_of_only_duplicates_commits_no_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(profile, vec![], vec![source("a", b"same")], 2)
            .unwrap();
        let generation = store.session().as_ref().unwrap().manifest.generation;

        let outcome = store
            .import(profile, vec![], vec![source("b", b"same")], 3)
            .unwrap();

        assert!(outcome.imported.is_empty());
        assert_eq!(outcome.skipped_duplicates, vec!["b"]);
        assert_eq!(
            store.session().as_ref().unwrap().manifest.generation,
            generation
        );
        assert_eq!(fs::read_dir(root.join("staging")).unwrap().count(), 0);
        assert_eq!(fs::read_dir(root.join("objects")).unwrap().count(), 1);
    }

    #[test]
    fn failed_batch_import_commits_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let result = store.import(
            profile,
            vec![],
            vec![
                source("first.txt", b"must not commit"),
                ImportSource {
                    display_name: "broken.txt".to_owned(),
                    reader: Box::new(FailingReader),
                },
            ],
            2,
        );

        assert!(matches!(result, Err(VaultError::Storage)));
        assert!(store.snapshot().unwrap().records.is_empty());
        assert_eq!(fs::read_dir(root.join("objects")).unwrap().count(), 0);
        assert_eq!(fs::read_dir(root.join("staging")).unwrap().count(), 0);
    }

    #[test]
    fn bulk_folder_assignment_is_one_manifest_transaction() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let folder = store.create_folder(profile, None, "Results", 2).unwrap();
        let records = store
            .import(
                profile,
                vec![],
                vec![
                    source("first.pdf", b"first"),
                    source("second.pdf", b"second"),
                ],
                3,
            )
            .unwrap()
            .imported;
        let before = store.snapshot().unwrap();
        assert!(matches!(
            store.assign_folders_batch(vec![records[0], Uuid::new_v4()], vec![folder]),
            Err(VaultError::NotFound)
        ));
        assert_eq!(store.snapshot().unwrap().records, before.records);

        store
            .assign_folders_batch(records.clone(), vec![folder])
            .unwrap();
        assert!(store
            .snapshot()
            .unwrap()
            .records
            .iter()
            .all(|record| record.folder_ids == vec![folder]));
    }

    /// Just past the default delay and the margin after `from`.
    fn idle_past(from: Instant) -> Instant {
        from + Duration::from_secs(15 * 60) + crate::idle::MARGIN + Duration::from_secs(1)
    }

    #[test]
    fn an_unlocked_session_has_an_idle_deadline_and_a_locked_one_does_not() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        assert!(!store.idle().is_due(idle_past(Instant::now())));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        assert!(store.idle().is_due(idle_past(Instant::now())));
        store.lock();
        assert!(!store.idle().is_due(idle_past(Instant::now())));
        store.unlock(PASSWORD).unwrap();
        assert!(store.idle().is_due(idle_past(Instant::now())));
        store.reset().unwrap();
        assert!(!store.idle().is_due(idle_past(Instant::now())));
    }

    /// Hands out `left` bytes, at most 256 KiB per read, pausing before each.
    struct SlowReader {
        left: usize,
    }

    impl Read for SlowReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            std::thread::sleep(Duration::from_millis(2));
            let count = buffer.len().min(self.left).min(256 * 1024);
            buffer[..count].fill(b'x');
            self.left -= count;
            Ok(count)
        }
    }

    #[test]
    fn the_idle_lock_checks_again_once_it_holds_the_session() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(VaultStore::new(temp.path().join("vault")));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let due = idle_past(Instant::now());
        let guard = store.session();
        let timer = {
            let store = Arc::clone(&store);
            std::thread::spawn(move || store.lock_if_idle(due))
        };
        // The timer found the session due (it requests cancellation only
        // then) and waits for the session lock, while a new session starts, as
        // an unlock would.
        let deadline = Instant::now() + Duration::from_secs(2);
        while !store.cancel_io.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "the timer did not find it due");
            std::thread::yield_now();
        }
        store.idle().arm(due);
        drop(guard);
        assert!(!timer.join().unwrap());
        assert!(matches!(store.status(), Ok(VaultStatus::Unlocked)));
        // The new session's transfers are not left cancelled.
        assert!(!store.cancel_io.load(Ordering::Acquire));
        assert!(store.lock_if_idle(idle_past(due)));
        assert!(matches!(store.status(), Ok(VaultStatus::Locked)));
    }

    #[test]
    fn an_idle_check_that_is_not_due_leaves_a_transfer_running() {
        // Runs the native timer's check while the import holds the session,
        // and waits (briefly) for it to finish before reading on.
        struct CheckingReader {
            data: Cursor<Vec<u8>>,
            store: Option<Arc<VaultStore>>,
        }

        impl Read for CheckingReader {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                if let Some(store) = self.store.take() {
                    let timer = std::thread::spawn(move || store.lock_if_idle(Instant::now()));
                    let wait_until = Instant::now() + Duration::from_millis(500);
                    while !timer.is_finished() && Instant::now() < wait_until {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                }
                self.data.read(buffer)
            }
        }

        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(VaultStore::new(temp.path().join("vault")));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let outcome = store
            .import(
                profile,
                vec![],
                vec![ImportSource {
                    display_name: "kept.pdf".to_owned(),
                    reader: Box::new(CheckingReader {
                        data: Cursor::new(b"synthetic kept import".to_vec()),
                        store: Some(Arc::clone(&store)),
                    }),
                }],
                2,
            )
            .unwrap();
        assert_eq!(outcome.imported.len(), 1);
    }

    #[test]
    fn an_import_reports_progress_while_reading_and_while_verifying() {
        let due_at = |from: Instant| from + Duration::from_secs(15 * 60) + crate::idle::MARGIN;
        // At the end of its data, notes whether the reads moved the deadline
        // on, then when reading ended.
        struct WatchingReader {
            data: Cursor<Vec<u8>>,
            idle: Arc<IdleDeadline>,
            due: Instant,
            moved_while_reading: Arc<AtomicBool>,
            reads_ended: Arc<Mutex<Option<Instant>>>,
        }

        impl Read for WatchingReader {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                let count = self.data.read(buffer)?;
                let mut reads_ended = self.reads_ended.lock().unwrap();
                if count == 0 && reads_ended.is_none() {
                    self.moved_while_reading
                        .store(!self.idle.is_due(self.due), Ordering::Release);
                    std::thread::sleep(Duration::from_millis(2));
                    *reads_ended = Some(Instant::now());
                }
                Ok(count)
            }
        }

        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let before = Instant::now();
        store.idle().arm(before);
        std::thread::sleep(Duration::from_millis(2));
        let moved_while_reading = Arc::new(AtomicBool::new(false));
        let reads_ended = Arc::new(Mutex::new(None));
        store
            .import(
                profile,
                vec![],
                vec![ImportSource {
                    display_name: "Watched.pdf".to_owned(),
                    reader: Box::new(WatchingReader {
                        data: Cursor::new(b"synthetic watched import".to_vec()),
                        idle: Arc::clone(store.idle()),
                        due: due_at(before),
                        moved_while_reading: Arc::clone(&moved_while_reading),
                        reads_ended: Arc::clone(&reads_ended),
                    }),
                }],
                2,
            )
            .unwrap();
        assert!(moved_while_reading.load(Ordering::Acquire));
        // Only the verification's writes come after the reads.
        let reads_ended = reads_ended.lock().unwrap().unwrap();
        assert!(!store.idle().is_due(due_at(reads_ended)));
    }

    #[test]
    fn a_transfer_making_progress_counts_as_activity() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;

        // Activity before the import is only the unlock; the import's reads,
        // after `before`, must move the deadline.
        std::thread::sleep(Duration::from_millis(5));
        let before = Instant::now();
        let record = store
            .import(
                profile,
                vec![],
                vec![ImportSource {
                    display_name: "Large.pdf".to_owned(),
                    reader: Box::new(SlowReader {
                        left: 3 * CHUNK_SIZE,
                    }),
                }],
                2,
            )
            .unwrap()
            .imported[0];
        // Due exactly the delay and margin after `before` unless there was
        // activity after it.
        let due_at = |from: Instant| from + Duration::from_secs(15 * 60) + crate::idle::MARGIN;
        assert!(!store.idle().is_due(due_at(before)));

        // An export's writes count too.
        let before = Instant::now();
        store.idle().arm(before);
        assert!(store.idle().is_due(due_at(before)));
        std::thread::sleep(Duration::from_millis(2));
        store.export(record, io::sink()).unwrap();
        assert!(!store.idle().is_due(due_at(before)));
    }

    #[test]
    fn each_read_and_write_that_moves_data_reports_progress() {
        let due_at = |from: Instant| from + Duration::from_secs(15 * 60) + crate::idle::MARGIN;
        let idle = Arc::new(IdleDeadline::new(Instant::now()));
        let cancelled = Arc::new(AtomicBool::new(false));
        // Arms the deadline, runs one transfer step, and says whether the step
        // moved the deadline on.
        let moved = |step: &dyn Fn(&Arc<IdleDeadline>)| {
            let before = Instant::now();
            idle.arm(before);
            std::thread::sleep(Duration::from_millis(2));
            step(&idle);
            !idle.is_due(due_at(before))
        };
        let read = |data: &'static [u8]| {
            let cancelled = Arc::clone(&cancelled);
            move |idle: &Arc<IdleDeadline>| {
                let read =
                    CancellableReader::new(Box::new(Cursor::new(data)), Arc::clone(&cancelled))
                        .with_progress(idle)
                        .read(&mut [0_u8; 4])
                        .unwrap();
                assert_eq!(read, data.len().min(4));
            }
        };
        let write = |data: &'static [u8]| {
            let cancelled = Arc::clone(&cancelled);
            move |idle: &Arc<IdleDeadline>| {
                let written = CancellableWriter::new(io::sink(), Arc::clone(&cancelled))
                    .with_progress(idle)
                    .write(data)
                    .unwrap();
                assert_eq!(written, data.len());
            }
        };
        assert!(moved(&read(b"synthetic")));
        assert!(moved(&write(b"synthetic")));
        // Nothing moved, so nothing is reported.
        assert!(!moved(&read(b"")));
        assert!(!moved(&write(b"")));
    }

    #[test]
    fn cancellation_wrappers_stop_at_the_next_io_boundary() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut reader = CancellableReader::new(
            Box::new(Cursor::new(b"synthetic".to_vec())),
            Arc::clone(&cancelled),
        );
        let mut output = [0_u8; 4];
        assert_eq!(reader.read(&mut output).unwrap(), 4);
        cancelled.store(true, Ordering::Release);
        assert!(matches!(
            VaultError::from(reader.read(&mut output).unwrap_err()),
            VaultError::Cancelled
        ));
        let mut writer = CancellableWriter::new(Vec::new(), cancelled);
        assert!(matches!(
            VaultError::from(writer.write(b"blocked").unwrap_err()),
            VaultError::Cancelled
        ));
    }

    #[test]
    fn locking_cancels_an_import_before_it_can_commit() {
        struct GatedReader {
            data: Cursor<Vec<u8>>,
            started: Option<mpsc::Sender<()>>,
            release: mpsc::Receiver<()>,
        }

        impl Read for GatedReader {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                if let Some(started) = self.started.take() {
                    started.send(()).unwrap();
                    self.release.recv().unwrap();
                }
                self.data.read(buffer)
            }
        }

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = Arc::new(VaultStore::new(root.clone()));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let import_store = Arc::clone(&store);
        let import = std::thread::spawn(move || {
            import_store.import(
                profile,
                vec![],
                vec![ImportSource {
                    display_name: "cancelled.pdf".to_owned(),
                    reader: Box::new(GatedReader {
                        data: Cursor::new(b"synthetic cancelled import".to_vec()),
                        started: Some(started_tx),
                        release: release_rx,
                    }),
                }],
                2,
            )
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let lock_store = Arc::clone(&store);
        let lock = std::thread::spawn(move || lock_store.lock());
        let deadline = Instant::now() + Duration::from_secs(2);
        while !store.cancel_io.load(Ordering::Acquire) {
            assert!(
                Instant::now() < deadline,
                "lock did not request cancellation"
            );
            std::thread::yield_now();
        }
        release_tx.send(()).unwrap();

        assert!(matches!(import.join().unwrap(), Err(VaultError::Cancelled)));
        lock.join().unwrap();
        assert_eq!(store.status().unwrap(), VaultStatus::Locked);
        assert_eq!(fs::read_dir(root.join("objects")).unwrap().count(), 0);
        assert_eq!(fs::read_dir(root.join("staging")).unwrap().count(), 0);
    }

    /// Everything left in `folder` besides the files named in `expected`.
    fn leftovers(folder: &Path, expected: &[&str]) -> Vec<String> {
        fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| !expected.contains(&name.as_str()))
            .collect()
    }

    #[test]
    fn an_interrupted_export_leaves_no_readable_copy_after_the_next_start() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault-v1");
        let out = temp.path().join("out");
        fs::create_dir_all(&out).unwrap();
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(
                profile,
                vec![],
                vec![source("scan.pdf", b"synthetic export record")],
                2,
            )
            .unwrap();
        store.lock();

        for (boundary, written) in [("export.after-write", false), ("export.after-rename", true)] {
            let destination = out.join(format!("{boundary}.pdf"));
            let status = Command::new(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", "vault::tests::termination_child"])
                .env("MYCARLOS_TEST_ROOT", &root)
                .env("MYCARLOS_TEST_OPERATION", "export")
                .env("MYCARLOS_TEST_EXPORT_TO", &destination)
                .env("MYCARLOS_TEST_TERMINATE_AT", boundary)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert_eq!(
                status.code(),
                Some(TEST_TERMINATION_EXIT_CODE),
                "{boundary}"
            );
            // The process died leaving its staging folder beside the destination
            // (holding the readable copy if it died before the rename).
            assert!(!leftovers(&out, &[&format!("{boundary}.pdf")]).is_empty());

            // The next start removes it, without the passphrase.
            let restarted = VaultStore::new(root.clone());
            assert_eq!(restarted.status().unwrap(), VaultStatus::Locked);
            assert!(
                leftovers(&out, &[&format!("{boundary}.pdf")]).is_empty(),
                "{boundary}"
            );
            assert_eq!(destination.exists(), written, "{boundary}");
            if written {
                assert_eq!(fs::read(&destination).unwrap(), b"synthetic export record");
            }
        }
    }

    #[test]
    fn a_completed_export_leaves_nothing_beside_it_or_to_sweep() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let store = VaultStore::new(home.join("vault-v1"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let record = store
            .import(
                profile,
                vec![],
                vec![source("scan.pdf", b"synthetic export record")],
                2,
            )
            .unwrap()
            .imported[0];
        let out = temp.path().join("out");
        fs::create_dir_all(&out).unwrap();
        store.export_atomic(record, &out.join("copy.pdf")).unwrap();
        assert!(leftovers(&out, &["copy.pdf"]).is_empty());
        let journal = home.join(EXPORT_JOURNAL);
        assert!(!journal.exists() || fs::read_dir(&journal).unwrap().count() == 0);
    }

    /// A vault with one record, unlocked, and an empty folder outside it.
    fn vault_with_one_export(temp: &Path) -> (VaultStore, Uuid, PathBuf, PathBuf) {
        let home = temp.join("home");
        let store = VaultStore::new(home.join("vault-v1"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let record = store
            .import(
                profile,
                vec![],
                vec![source("scan.pdf", b"synthetic export record")],
                2,
            )
            .unwrap()
            .imported[0];
        let out = temp.join("out");
        fs::create_dir_all(&out).unwrap();
        (store, record, home, out)
    }

    fn journal_is_empty(home: &Path) -> bool {
        let journal = home.join(EXPORT_JOURNAL);
        !journal.exists() || fs::read_dir(&journal).unwrap().count() == 0
    }

    #[test]
    fn an_export_that_fails_midway_leaves_nothing_beside_it_or_to_sweep() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record, home, out) = vault_with_one_export(temp.path());
        let object_name = {
            let guard = store.unlocked.lock().unwrap();
            guard.as_ref().unwrap().manifest.records[0]
                .object_name
                .clone()
        };
        let object = home.join("vault-v1").join("objects").join(object_name);
        let mut bytes = fs::read(&object).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        fs::write(object, bytes).unwrap();

        assert!(matches!(
            store.export_atomic(record, &out.join("copy.pdf")),
            Err(VaultError::Corrupt)
        ));
        assert!(leftovers(&out, &[]).is_empty());
        assert!(journal_is_empty(&home));
    }

    #[cfg(unix)]
    #[test]
    fn an_export_to_a_read_only_folder_fails_and_leaves_no_journal_entry() {
        use std::os::unix::fs::PermissionsExt as _;

        let temp = tempfile::tempdir().unwrap();
        let (store, record, home, out) = vault_with_one_export(temp.path());
        fs::set_permissions(&out, fs::Permissions::from_mode(0o500)).unwrap();
        if fs::write(out.join("probe"), b"").is_ok() {
            // A privileged process ignores folder modes, so the staging folder
            // could be created; the refusal cannot be exercised here.
            return;
        }

        let result = store.export_atomic(record, &out.join("copy.pdf"));
        fs::set_permissions(&out, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
        assert!(leftovers(&out, &[]).is_empty());
        assert!(journal_is_empty(&home));
    }

    #[cfg(unix)]
    #[test]
    fn export_journal_entries_and_staging_folders_are_private() {
        use std::os::unix::fs::PermissionsExt as _;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let id = Uuid::new_v4();
        let stage = temp.path().join(format!("{EXPORT_STAGE_PREFIX}{id}"));
        let entry = journal_export(&home.join("vault-v1"), id, &stage).unwrap();
        create_stage_dir(&stage).unwrap();

        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(entry, home.join(EXPORT_JOURNAL).join(id.to_string()));
        assert_eq!(decode_path(&fs::read(&entry).unwrap()).unwrap(), stage);
        assert_eq!(mode(&home.join(EXPORT_JOURNAL)), 0o700);
        assert_eq!(mode(&entry), 0o600);
        assert_eq!(mode(&stage), 0o700);
    }

    #[test]
    fn finishing_an_export_whose_staging_folder_is_gone_drops_its_entry() {
        let temp = tempfile::tempdir().unwrap();
        let entry = temp.path().join("entry");
        fs::write(&entry, b"").unwrap();
        let stage = temp
            .path()
            .join(format!("{EXPORT_STAGE_PREFIX}{}", Uuid::new_v4()));
        finish_export(&stage, Some(&entry));
        assert!(!entry.exists());
    }

    #[cfg(unix)]
    #[test]
    fn finishing_an_export_keeps_its_entry_while_the_staging_folder_remains() {
        use std::os::unix::fs::PermissionsExt as _;

        let temp = tempfile::tempdir().unwrap();
        let entry = temp.path().join("entry");
        fs::write(&entry, b"").unwrap();
        let out = temp.path().join("out");
        let stage = out.join(format!("{EXPORT_STAGE_PREFIX}{}", Uuid::new_v4()));
        fs::create_dir_all(&stage).unwrap();
        fs::set_permissions(&out, fs::Permissions::from_mode(0o500)).unwrap();
        if fs::write(out.join("probe"), b"").is_ok() {
            // A privileged process ignores folder modes; nothing to exercise.
            return;
        }

        finish_export(&stage, Some(&entry));
        fs::set_permissions(&out, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(stage.exists());
        assert!(entry.exists());
    }

    #[test]
    fn the_export_sweep_drops_an_entry_whose_staging_folder_is_already_gone() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let journal = home.join(EXPORT_JOURNAL);
        fs::create_dir_all(&journal).unwrap();
        let gone = temp
            .path()
            .join(format!("{EXPORT_STAGE_PREFIX}{}", Uuid::new_v4()));
        fs::write(journal.join(Uuid::new_v4().to_string()), encode_path(&gone)).unwrap();

        remove_abandoned_exports(&home);
        assert_eq!(fs::read_dir(&journal).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn the_export_sweep_keeps_an_entry_it_cannot_check() {
        use std::os::unix::fs::PermissionsExt as _;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let journal = home.join(EXPORT_JOURNAL);
        fs::create_dir_all(&journal).unwrap();
        let out = temp.path().join("out");
        let stage = out.join(format!("{EXPORT_STAGE_PREFIX}{}", Uuid::new_v4()));
        fs::create_dir_all(&stage).unwrap();
        fs::write(
            journal.join(Uuid::new_v4().to_string()),
            encode_path(&stage),
        )
        .unwrap();
        fs::set_permissions(&out, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::symlink_metadata(&stage).is_ok() {
            // A privileged process ignores folder modes; nothing to exercise.
            fs::set_permissions(&out, fs::Permissions::from_mode(0o700)).unwrap();
            return;
        }

        remove_abandoned_exports(&home);
        fs::set_permissions(&out, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(stage.exists());
        assert_eq!(fs::read_dir(&journal).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn the_export_sweep_does_not_enter_a_linked_journal_folder() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let elsewhere = temp.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("notes.txt"), b"keep").unwrap();
        std::os::unix::fs::symlink(&elsewhere, home.join(EXPORT_JOURNAL)).unwrap();

        remove_abandoned_exports(&home);
        assert_eq!(fs::read(elsewhere.join("notes.txt")).unwrap(), b"keep");
    }

    #[cfg(unix)]
    #[test]
    fn the_export_sweep_reads_only_bounded_regular_entries() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let journal = home.join(EXPORT_JOURNAL);
        fs::create_dir_all(&journal).unwrap();
        let linked = temp
            .path()
            .join(format!("{EXPORT_STAGE_PREFIX}{}", Uuid::new_v4()));
        let oversized = temp
            .path()
            .join(format!("{EXPORT_STAGE_PREFIX}{}", Uuid::new_v4()));
        fs::create_dir_all(&linked).unwrap();
        fs::create_dir_all(&oversized).unwrap();
        // An entry that is a link to a file naming a staging folder.
        let target = temp.path().join("target");
        fs::write(&target, encode_path(&linked)).unwrap();
        std::os::unix::fs::symlink(&target, journal.join(Uuid::new_v4().to_string())).unwrap();
        // An entry past the size limit that still names a staging folder.
        let mut long = vec![b'/'; MAX_EXPORT_JOURNAL_BYTES];
        long.extend_from_slice(&encode_path(&oversized));
        fs::write(journal.join(Uuid::new_v4().to_string()), long).unwrap();

        remove_abandoned_exports(&home);
        assert!(linked.exists());
        assert!(oversized.exists());
        assert_eq!(fs::read_dir(&journal).unwrap().count(), 0);
    }

    #[test]
    fn export_stage_names_are_the_prefix_and_a_canonical_uuid() {
        let id = Uuid::new_v4();
        let folder = Path::new("out");
        assert!(is_export_stage_name(
            &folder.join(format!("{EXPORT_STAGE_PREFIX}{id}"))
        ));
        for name in [
            format!("{id}"),
            format!("x{EXPORT_STAGE_PREFIX}{id}"),
            format!("{EXPORT_STAGE_PREFIX}{id}x"),
            EXPORT_STAGE_PREFIX.to_string(),
            format!("{EXPORT_STAGE_PREFIX}{}", id.simple()),
            format!("{EXPORT_STAGE_PREFIX}{}", id.braced()),
            format!("{EXPORT_STAGE_PREFIX}{}", id.to_string().to_uppercase()),
        ] {
            assert!(!is_export_stage_name(&folder.join(&name)), "{name}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_journal_entry_of_odd_length_decodes_to_nothing() {
        let stage = Path::new(r"C:\out").join(format!("{EXPORT_STAGE_PREFIX}{}", Uuid::new_v4()));
        let mut bytes = encode_path(&stage);
        assert_eq!(decode_path(&bytes).as_deref(), Some(stage.as_path()));
        bytes.push(0);
        assert_eq!(decode_path(&bytes), None);
    }

    #[cfg(unix)]
    #[test]
    fn the_export_sweep_keeps_an_entry_it_cannot_read() {
        use std::os::unix::fs::PermissionsExt as _;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let journal = home.join(EXPORT_JOURNAL);
        fs::create_dir_all(&journal).unwrap();
        let stage = temp
            .path()
            .join(format!("{EXPORT_STAGE_PREFIX}{}", Uuid::new_v4()));
        fs::create_dir_all(&stage).unwrap();
        let entry = journal.join(Uuid::new_v4().to_string());
        fs::write(&entry, encode_path(&stage)).unwrap();
        fs::set_permissions(&entry, fs::Permissions::from_mode(0o000)).unwrap();
        if File::open(&entry).is_ok() {
            // A privileged process ignores file modes; nothing to exercise.
            return;
        }

        remove_abandoned_exports(&home);
        fs::set_permissions(&entry, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(entry.exists());
        assert!(stage.exists());
    }

    #[test]
    fn unlock_and_reset_also_remove_an_abandoned_export() {
        for operation in ["unlock", "reset"] {
            let temp = tempfile::tempdir().unwrap();
            let home = temp.path().join("home");
            let store = VaultStore::new(home.join("vault-v1"));
            store.create(PASSWORD, "Jamie", 1).unwrap();
            let stage = temp
                .path()
                .join(format!("{EXPORT_STAGE_PREFIX}{}", Uuid::new_v4()));
            fs::create_dir_all(&stage).unwrap();
            fs::write(stage.join("copy.pdf"), b"readable").unwrap();
            let journal = home.join(EXPORT_JOURNAL);
            fs::create_dir_all(&journal).unwrap();
            fs::write(
                journal.join(Uuid::new_v4().to_string()),
                encode_path(&stage),
            )
            .unwrap();

            // Both run with the session still open, as a re-unlock or a reset does.
            match operation {
                "unlock" => store.unlock(PASSWORD).unwrap(),
                _ => store.reset().unwrap(),
            }
            assert!(!stage.exists(), "{operation}");
            assert!(journal_is_empty(&home), "{operation}");
        }
    }

    #[test]
    fn a_sweep_in_the_middle_of_an_export_leaves_it_to_finish() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record, home, out) = vault_with_one_export(temp.path());
        let store = Arc::new(store);
        // Unlocking the open session sweeps, between the write and the rename.
        let sweeper = Arc::clone(&store);
        AT_TEST_BOUNDARY.with(|slot| {
            *slot.borrow_mut() = Some((
                "export.after-write",
                Box::new(move || sweeper.unlock(PASSWORD).unwrap()),
            ))
        });
        store.export_atomic(record, &out.join("copy.pdf")).unwrap();
        assert_eq!(
            fs::read(out.join("copy.pdf")).unwrap(),
            b"synthetic export record"
        );
        assert!(leftovers(&out, &["copy.pdf"]).is_empty());
        assert!(journal_is_empty(&home));
    }

    #[test]
    fn the_export_sweep_skips_an_export_still_under_way_here() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _, home, out) = vault_with_one_export(temp.path());
        let id = Uuid::new_v4();
        let stage = out.join(format!("{EXPORT_STAGE_PREFIX}{id}"));
        let _in_flight = ExportInFlight::new(id);
        journal_export(&home.join("vault-v1"), id, &stage).unwrap();
        create_stage_dir(&stage).unwrap();
        // Unlocking the open session sweeps, but this export is still running.
        store.unlock(PASSWORD).unwrap();
        assert!(stage.exists());
        assert!(!journal_is_empty(&home));
    }

    #[test]
    fn an_export_stops_being_under_way_when_its_marker_is_dropped() {
        let id = Uuid::new_v4();
        let entry = Path::new("journal").join(id.to_string());
        let marker = ExportInFlight::new(id);
        assert!(export_in_flight(&entry));
        drop(marker);
        assert!(!export_in_flight(&entry));
    }

    #[test]
    fn a_locked_vault_journals_and_stages_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let store = VaultStore::new(home.join("vault-v1"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        store.lock();
        let out = temp.path().join("out");
        fs::create_dir_all(&out).unwrap();
        assert!(matches!(
            store.export_atomic(Uuid::new_v4(), &out.join("copy.pdf")),
            Err(VaultError::Locked)
        ));
        assert!(leftovers(&out, &[]).is_empty());
        assert!(!home.join(EXPORT_JOURNAL).exists());
    }

    #[test]
    fn an_export_still_runs_when_its_journal_entry_cannot_be_written() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let store = VaultStore::new(home.join("vault-v1"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let record = store
            .import(
                profile,
                vec![],
                vec![source("scan.pdf", b"synthetic export record")],
                2,
            )
            .unwrap()
            .imported[0];
        // Nothing can be written inside a file where the journal should be.
        fs::write(home.join(EXPORT_JOURNAL), b"").unwrap();
        let out = temp.path().join("out");
        fs::create_dir_all(&out).unwrap();
        store.export_atomic(record, &out.join("copy.pdf")).unwrap();
        assert_eq!(
            fs::read(out.join("copy.pdf")).unwrap(),
            b"synthetic export record"
        );
        assert!(leftovers(&out, &["copy.pdf"]).is_empty());
    }

    #[test]
    fn the_export_sweep_only_removes_its_own_staging_folders() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let root = home.join("vault-v1");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        store.lock();
        let journal = home.join(EXPORT_JOURNAL);
        fs::create_dir_all(&journal).unwrap();
        // A journal entry naming something that is not a staging folder is
        // dropped, and what it names is left alone.
        let important = temp.path().join("important");
        fs::create_dir_all(&important).unwrap();
        fs::write(
            journal.join(Uuid::new_v4().to_string()),
            encode_path(&important),
        )
        .unwrap();
        // An entry whose folder's parent (an unplugged drive) is missing is kept.
        let unplugged = temp
            .path()
            .join("unplugged")
            .join(format!("{EXPORT_STAGE_PREFIX}{}", Uuid::new_v4()));
        let later = Uuid::new_v4().to_string();
        fs::write(journal.join(&later), encode_path(&unplugged)).unwrap();

        // A link that has taken a staging folder's name is not followed or
        // removed, and its entry is kept.
        #[cfg(unix)]
        let (link, link_entry) = {
            let link = temp
                .path()
                .join(format!("{EXPORT_STAGE_PREFIX}{}", Uuid::new_v4()));
            std::os::unix::fs::symlink(&important, &link).unwrap();
            fs::write(important.join("keep.txt"), b"keep").unwrap();
            let link_entry = Uuid::new_v4().to_string();
            fs::write(journal.join(&link_entry), encode_path(&link)).unwrap();
            (link, link_entry)
        };
        // A relative path is never one of ours.
        fs::write(
            journal.join(Uuid::new_v4().to_string()),
            encode_path(Path::new(&format!(
                "{EXPORT_STAGE_PREFIX}{}",
                Uuid::new_v4()
            ))),
        )
        .unwrap();

        assert_eq!(store.status().unwrap(), VaultStatus::Locked);
        assert!(important.exists());
        #[cfg(unix)]
        {
            assert!(fs::symlink_metadata(&link).is_ok());
            assert!(important.join("keep.txt").exists());
        }
        let mut remaining: Vec<_> = fs::read_dir(&journal)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        remaining.sort();
        #[allow(unused_mut)]
        let mut expected = vec![later];
        #[cfg(unix)]
        expected.push(link_entry);
        expected.sort();
        assert_eq!(remaining, expected);
    }

    #[test]
    fn import_abrupt_termination_matrix_recovers_to_a_complete_state() {
        let temp = tempfile::tempdir().unwrap();
        let template = temp.path().join("template-vault");
        let template_store = VaultStore::new(template.clone());
        template_store.create(PASSWORD, "Jamie", 1).unwrap();
        template_store.lock();

        for (boundary, committed) in [
            ("object.after-chunk-write", false),
            ("import.after-staging", false),
            ("import.after-object-rename", false),
            ("manifest.after-first-write", true),
            ("manifest.after-second-write", true),
        ] {
            let root = temp.path().join(boundary);
            copy_directory(&template, &root);
            run_termination_child(&root, "import", boundary);

            let restarted = VaultStore::new(root.clone());
            restarted.unlock(PASSWORD).unwrap();
            assert_eq!(
                restarted.snapshot().unwrap().records.len(),
                usize::from(committed)
            );
            assert_eq!(fs::read_dir(root.join("staging")).unwrap().count(), 0);
            assert_eq!(
                fs::read_dir(root.join("objects")).unwrap().count(),
                usize::from(committed)
            );
        }
    }

    #[test]
    fn injected_no_space_import_failures_recover_to_a_complete_state() {
        let temp = tempfile::tempdir().unwrap();
        let template = temp.path().join("template-vault");
        let template_store = VaultStore::new(template.clone());
        template_store.create(PASSWORD, "Jamie", 1).unwrap();
        template_store.lock();

        for (boundary, committed) in [
            ("object.after-chunk-write", false),
            ("import.objects-sync", false),
            ("manifest.before-first-write", false),
            ("manifest.after-first-write", true),
        ] {
            let root = temp.path().join(boundary);
            copy_directory(&template, &root);
            run_failure_child(&root, "import", boundary);

            let restarted = VaultStore::new(root.clone());
            restarted.unlock(PASSWORD).unwrap();
            assert_eq!(
                restarted.snapshot().unwrap().records.len(),
                usize::from(committed)
            );
            assert_eq!(fs::read_dir(root.join("staging")).unwrap().count(), 0);
            assert_eq!(
                fs::read_dir(root.join("objects")).unwrap().count(),
                usize::from(committed)
            );
        }
    }

    fn recovery_key_groups(key: &str) -> Vec<String> {
        key.split('-').map(str::to_owned).collect()
    }

    /// Sets up a recovery key in an unlocked store and returns it.
    fn set_up_recovery_key(store: &VaultStore, now_ms: u64) -> String {
        let key = store.begin_recovery_key(PASSWORD).unwrap().to_string();
        let groups = recovery_key_groups(&key);
        store
            .confirm_recovery_key(&[(1, &groups[1]), (5, &groups[5])], now_ms)
            .unwrap();
        key
    }

    #[test]
    fn a_recovery_key_reads_back_as_typed_and_a_typo_is_caught() {
        for _ in 0..64 {
            let mut key = [0_u8; RECOVERY_KEY_BYTES];
            rand::RngCore::fill_bytes(&mut OsRng, &mut key);
            let text = encode_recovery_key(&key);
            let groups = recovery_key_groups(&text);
            assert_eq!(groups.len(), RECOVERY_KEY_GROUPS);
            assert!(groups
                .iter()
                .all(|group| group.len() == RECOVERY_KEY_GROUP_LEN));
            assert_eq!(*decode_recovery_key(&text).unwrap(), key);
            // Case, spaces and Crockford's look-alike letters don't matter.
            let relaxed = text
                .to_lowercase()
                .replace('-', " ")
                .replace('0', "o")
                .replace('1', "l");
            assert_eq!(*decode_recovery_key(&relaxed).unwrap(), key);
        }
        for text in ["", "ABCD", "UUUU-UUUU-UUUU-UUUU-UUUU-UUUU-UUUU"] {
            assert!(matches!(
                decode_recovery_key(text),
                Err(VaultError::RecoveryKeyTypo)
            ));
        }
        // Nearly every single-character slip is caught by the check characters
        // (a 10-bit check lets about 1 in 1,024 through).
        let text = encode_recovery_key(&[7_u8; RECOVERY_KEY_BYTES]).replace('-', "");
        let mut accepted = 0;
        for position in 0..text.len() {
            for symbol in CROCKFORD_ALPHABET.iter().map(|symbol| char::from(*symbol)) {
                if text.chars().nth(position) == Some(symbol) {
                    continue;
                }
                let mut slipped: Vec<char> = text.chars().collect();
                slipped[position] = symbol;
                let slipped: String = slipped.into_iter().collect();
                if decode_recovery_key(&slipped).is_ok() {
                    accepted += 1;
                }
            }
        }
        assert!(accepted <= 5, "{accepted} slips accepted");
    }

    #[test]
    fn a_recovery_key_replaces_a_forgotten_passphrase_and_keeps_working() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();

        // Nothing is stored until the patient types groups of the key back.
        let key = store.begin_recovery_key(PASSWORD).unwrap().to_string();
        let groups = recovery_key_groups(&key);
        assert!(read_latest_header(&root).unwrap().recovery.is_none());
        assert!(matches!(
            store.confirm_recovery_key(&[(1, &groups[1])], 5),
            Err(VaultError::Invalid)
        ));
        assert!(matches!(
            store.confirm_recovery_key(&[(1, "ZZZZ"), (4, &groups[4])], 5),
            Err(VaultError::RecoveryKeyTypo)
        ));
        assert!(read_latest_header(&root).unwrap().recovery.is_none());
        let lower = groups[1].to_lowercase();
        store
            .confirm_recovery_key(&[(1, &lower), (4, &groups[4])], 5)
            .unwrap();
        assert_eq!(store.snapshot().unwrap().recovery_key_set_at_ms, Some(5));
        let header = read_latest_header(&root).unwrap();
        assert_eq!(header.format_version, HEADER_FORMAT);
        assert!(header.recovery.is_some());
        store.lock();

        assert!(matches!(
            store.recover("ABCD", PASSPHRASE_REPLACEMENT),
            Err(VaultError::RecoveryKeyTypo)
        ));
        let other = encode_recovery_key(&[9_u8; RECOVERY_KEY_BYTES]);
        assert!(matches!(
            store.recover(&other, PASSPHRASE_REPLACEMENT),
            Err(VaultError::WrongRecoveryKey)
        ));
        // The new passphrase meets the usual rules, and a refusal writes nothing.
        let before = read_latest_header(&root).unwrap();
        assert!(matches!(
            store.recover(&key, "too short"),
            Err(VaultError::Invalid)
        ));
        assert!(read_latest_header(&root).unwrap() == before);

        assert!(store.recover(&key, PASSPHRASE_REPLACEMENT).unwrap());
        assert_eq!(store.snapshot().unwrap().recovery_key_set_at_ms, Some(5));
        store.lock();
        assert!(matches!(
            store.unlock(PASSWORD),
            Err(VaultError::WrongPassphrase)
        ));
        store.unlock(PASSPHRASE_REPLACEMENT).unwrap();

        // The key survives a passphrase change and a header repair.
        store
            .change_passphrase(PASSPHRASE_REPLACEMENT, PASSWORD)
            .unwrap();
        store.lock();
        fs::remove_file(root.join("header-0.json")).unwrap();
        store.unlock(PASSWORD).unwrap();
        store.lock();
        assert!(store.recover(&key, PASSPHRASE_REPLACEMENT).unwrap());
    }

    #[test]
    fn setting_up_a_recovery_key_needs_the_passphrase_and_can_be_cancelled() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        assert!(matches!(
            store.begin_recovery_key(PASSWORD),
            Err(VaultError::Locked)
        ));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        // A recovery key opens the vault for good, so the passphrase is asked
        // for again, as for a passphrase change.
        assert!(matches!(
            store.begin_recovery_key(PASSPHRASE_REPLACEMENT),
            Err(VaultError::WrongPassphrase)
        ));
        let key = store.begin_recovery_key(PASSWORD).unwrap().to_string();
        let groups = recovery_key_groups(&key);
        store.cancel_recovery_key();
        assert!(matches!(
            store.confirm_recovery_key(&[(0, &groups[0]), (1, &groups[1])], 5),
            Err(VaultError::Invalid)
        ));
        // A key shown before a passphrase change was authorized by the old
        // passphrase, so the change forgets it.
        let key = store.begin_recovery_key(PASSWORD).unwrap().to_string();
        let groups = recovery_key_groups(&key);
        store
            .change_passphrase(PASSWORD, PASSPHRASE_REPLACEMENT)
            .unwrap();
        assert!(matches!(
            store.confirm_recovery_key(&[(0, &groups[0]), (1, &groups[1])], 5),
            Err(VaultError::Invalid)
        ));
        assert!(read_latest_header(&root).unwrap().recovery.is_none());
        // Recovering is for a locked vault.
        assert!(matches!(
            store.recover(&key, PASSPHRASE_REPLACEMENT),
            Err(VaultError::Invalid)
        ));
    }

    #[test]
    fn a_recovery_kit_holds_the_pending_key_and_no_names() {
        let temp = tempfile::tempdir().unwrap();
        // Its own home, so that the temporary folder itself is outside it.
        let root = temp.path().join("home").join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        assert!(matches!(store.recovery_kit(1), Err(VaultError::Invalid)));

        let key = store.begin_recovery_key(PASSWORD).unwrap().to_string();
        let kit = store.recovery_kit(1_790_553_600_000).unwrap();
        assert!(kit.contains(&key));
        assert!(kit.contains("2026-09-28"));
        assert!(!kit.contains("Jamie"));

        // Saved as an export is: outside the vault home, and private.
        let outside = temp.path().join("kit.txt");
        store.save_recovery_kit(&outside, 1).unwrap();
        let saved = fs::read_to_string(&outside).unwrap();
        assert!(saved.contains(&key) && saved.contains("1970-01-01"));
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&outside).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let inside = vault_home(&root).unwrap().join("kit.txt");
        assert!(matches!(
            store.save_recovery_kit(&inside, 1),
            Err(VaultError::Invalid)
        ));
        assert!(!inside.exists());

        // Once the key is stored, there is no kit left to save.
        let groups = recovery_key_groups(&key);
        store
            .confirm_recovery_key(&[(0, &groups[0]), (3, &groups[3])], 5)
            .unwrap();
        assert!(matches!(store.recovery_kit(1), Err(VaultError::Invalid)));
    }

    #[test]
    fn utc_dates_follow_the_calendar() {
        assert_eq!(utc_date(0), (1970, 1, 1));
        assert_eq!(utc_date(1_790_553_600_000), (2026, 9, 28));
        assert_eq!(utc_date(951_868_740_000), (2000, 2, 29));
    }

    #[test]
    fn a_legacy_header_cannot_carry_an_envelope_or_claim_format_2() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        set_up_recovery_key(&store, 5);
        let header = read_latest_header(&root).unwrap();
        assert!(valid_header(&header));

        // Generation 0 has no integrity tag, so nothing would cover these.
        let mut legacy = header.clone();
        legacy.generation = 0;
        legacy.integrity_tag = String::new();
        assert!(!valid_header(&legacy));
        legacy.recovery = None;
        assert!(!valid_header(&legacy));
        legacy.format_version = HEADER_FORMAT_V1;
        assert!(valid_header(&legacy));
    }

    #[test]
    fn a_header_slot_from_a_newer_build_is_not_repaired_over() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        store.lock();
        let slot = root.join(HEADER_SLOTS[0]);
        let mut newer: serde_json::Value =
            serde_json::from_slice(&fs::read(&slot).unwrap()).unwrap();
        newer["formatVersion"] = serde_json::json!(HEADER_FORMAT + 1);
        let written = serde_json::to_vec_pretty(&newer).unwrap();
        fs::write(&slot, &written).unwrap();

        store.unlock(PASSWORD).unwrap();
        assert_eq!(
            store.snapshot().unwrap().recovery,
            Some(RecoveryReason::UnreadableSlot)
        );
        store.lock();
        assert_eq!(fs::read(&slot).unwrap(), written);
    }

    #[test]
    fn the_format_1_integrity_payload_is_the_one_earlier_builds_wrote() {
        // Built here field by field, not through `header_integrity_payload`,
        // so that a change to the format 1 payload fails this test.
        let master_key = [7_u8; 32];
        let (kdf, wrapping_key) = new_passphrase_key(PASSWORD).unwrap();
        let mut header =
            build_header_with_key(Uuid::new_v4(), 3, kdf, &wrapping_key, &master_key, None)
                .unwrap();
        header.format_version = HEADER_FORMAT_V1;
        let payload = serde_json::to_vec(&(
            "MYCARLOS-VAULT",
            1_u32,
            header.vault_id,
            header.generation,
            &header.kdf,
            &header.wrapped_master_key,
        ))
        .unwrap();
        let key = header_integrity_key(header.vault_id, &master_key).unwrap();
        let mut mac = <HmacSha256 as Mac>::new_from_slice(key.as_ref()).unwrap();
        mac.update(&payload);
        assert_eq!(
            compute_header_integrity_tag(&header, &master_key).unwrap(),
            BASE64.encode(mac.finalize().into_bytes())
        );
    }

    #[test]
    fn typed_back_groups_are_checked_by_position_and_a_lock_forgets_the_key() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let key = store.begin_recovery_key(PASSWORD).unwrap().to_string();
        let groups = recovery_key_groups(&key);
        // An index out of range, a repeated index and too many groups are
        // refused as invalid whether or not the other groups match.
        for request in [
            vec![(0, groups[0].as_str()), (7, "ZZZZ")],
            vec![(0, "ZZZZ"), (7, "ZZZZ")],
            vec![(2, groups[2].as_str()), (2, groups[2].as_str())],
            (0..8).map(|index| (index % 7, "ZZZZ")).collect(),
        ] {
            assert!(
                matches!(
                    store.confirm_recovery_key(&request, 5),
                    Err(VaultError::Invalid)
                ),
                "{request:?}"
            );
        }
        // I is read as 1, as L is.
        assert!(recovery_group_matches("i0l-", "101"));

        store.lock();
        store.unlock(PASSWORD).unwrap();
        assert!(matches!(
            store.confirm_recovery_key(&[(0, &groups[0]), (1, &groups[1])], 5),
            Err(VaultError::Invalid)
        ));
        assert!(read_latest_header(&root).unwrap().recovery.is_none());
    }

    #[test]
    fn a_recovery_whose_first_header_landed_has_replaced_the_passphrase() {
        for left_behind in HEADER_SLOTS {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("vault");
            let store = VaultStore::new(root.clone());
            store.create(PASSWORD, "Jamie", 1).unwrap();
            let key = set_up_recovery_key(&store, 5);
            store.lock();
            let before = fs::read(root.join(left_behind)).unwrap();
            run_failure_child_with(
                &root,
                "recover",
                "recover.after-first-write",
                &[("MYCARLOS_TEST_RECOVERY_KEY", key.as_str())],
            );
            // The child repaired the second slot when it opened the vault.
            // Put back what a power loss would have left there: one slot
            // with the new passphrase, one still with the old.
            assert_ne!(fs::read(root.join(left_behind)).unwrap(), before);
            fs::write(root.join(left_behind), &before).unwrap();

            let restarted = VaultStore::new(root.clone());
            assert!(matches!(
                restarted.unlock(PASSWORD),
                Err(VaultError::WrongPassphrase)
            ));
            restarted.unlock(PASSPHRASE_REPLACEMENT).unwrap();
            assert_eq!(restarted.snapshot().unwrap().recovery, None);
            restarted.lock();
            // The unlock repaired the slot left behind.
            assert_ne!(fs::read(root.join(left_behind)).unwrap(), before);
            // The key still works, and the repair kept its envelope.
            assert!(restarted.recover(&key, PASSWORD).unwrap());
        }
    }

    #[test]
    fn replacing_the_recovery_key_stops_the_old_one() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let first = set_up_recovery_key(&store, 5);
        let second = set_up_recovery_key(&store, 6);
        store.lock();
        assert!(matches!(
            store.recover(&first, PASSPHRASE_REPLACEMENT),
            Err(VaultError::WrongRecoveryKey)
        ));
        assert!(store.recover(&second, PASSPHRASE_REPLACEMENT).unwrap());
    }

    #[test]
    fn a_replacement_key_whose_first_write_landed_stops_the_old_one() {
        // Only the first header of the replacement is written. The old key
        // still opens the slot left over, but the newer header outranks it.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let old = set_up_recovery_key(&store, 5);
        store.lock();
        run_failure_child(&root, "recovery-key", "recovery-key.after-first-write");

        let restarted = VaultStore::new(root);
        assert!(matches!(
            restarted.recover(&old, PASSPHRASE_REPLACEMENT),
            Err(VaultError::WrongRecoveryKey)
        ));
        restarted.unlock(PASSWORD).unwrap();
    }

    #[test]
    fn the_header_tag_covers_the_recovery_envelope() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        set_up_recovery_key(&store, 5);
        let header = read_latest_header(&root).unwrap();
        let master_key = unwrap_master_key(&header, PASSWORD).unwrap();
        assert!(valid_header_integrity(&header, &master_key));

        let mut changed = header.clone();
        changed.recovery.as_mut().unwrap().created_at_ms += 1;
        assert!(!valid_header_integrity(&changed, &master_key));
        let mut removed = header.clone();
        removed.recovery = None;
        assert!(!valid_header_integrity(&removed, &master_key));
        // A format 1 header cannot carry an envelope.
        let mut downgraded = header;
        downgraded.format_version = HEADER_FORMAT_V1;
        assert!(!valid_header(&downgraded));
    }

    #[test]
    fn a_format_1_header_still_opens_and_moves_to_format_2_at_its_next_write() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let current = read_latest_header(&root).unwrap();
        let master_key = unwrap_master_key(&current, PASSWORD).unwrap();
        store.lock();

        // Both slots as an earlier build wrote them: format 1, one KDF salt.
        let (kdf, wrapping_key) = new_passphrase_key(PASSWORD).unwrap();
        for generation in [current.generation + 1, current.generation + 2] {
            let mut header = build_header_with_key(
                current.vault_id,
                generation,
                kdf.clone(),
                &wrapping_key,
                &master_key,
                None,
            )
            .unwrap();
            header.format_version = HEADER_FORMAT_V1;
            header.integrity_tag = compute_header_integrity_tag(&header, &master_key).unwrap();
            atomic_json(&header_path(&root, generation), &header).unwrap();
        }
        store.unlock(PASSWORD).unwrap();
        assert_eq!(
            read_latest_header(&root).unwrap().format_version,
            HEADER_FORMAT_V1
        );

        set_up_recovery_key(&store, 5);
        let upgraded = read_latest_header(&root).unwrap();
        assert_eq!(upgraded.format_version, HEADER_FORMAT);
        assert!(upgraded.recovery.is_some());
    }

    #[test]
    fn a_vault_that_opens_read_only_keeps_its_passphrase_when_recovered() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile_id = store.snapshot().unwrap().profiles[0].id;
        store
            .import(
                profile_id,
                vec![],
                vec![source("lost.pdf", b"synthetic record that goes missing")],
                2,
            )
            .unwrap();
        let key = set_up_recovery_key(&store, 5);
        store.lock();
        for entry in fs::read_dir(root.join("objects")).unwrap() {
            fs::remove_file(entry.unwrap().path()).unwrap();
        }

        assert!(!store.recover(&key, PASSPHRASE_REPLACEMENT).unwrap());
        assert_eq!(
            store.snapshot().unwrap().recovery,
            Some(RecoveryReason::LostObjects)
        );
        store.lock();
        store.unlock(PASSWORD).unwrap();
    }

    const CANARY: &[u8] = b"FAKE-CANARY-plaintext-that-must-never-appear";

    /// A vault with two documents and a recovery key, its backup, and the key.
    fn backed_up_vault(root: &Path) -> (VaultStore, Vec<u8>, String) {
        let store = VaultStore::new(root.to_path_buf());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(
                profile,
                vec![],
                vec![
                    source("first.pdf", CANARY),
                    source("second.pdf", b"second synthetic record"),
                ],
                2,
            )
            .unwrap();
        let key = set_up_recovery_key(&store, 3);
        let mut backup = Vec::new();
        store.backup(&mut backup, 4).unwrap();
        store.lock();
        (store, backup, key)
    }

    fn exported(store: &VaultStore, name: &str) -> Vec<u8> {
        let snapshot = store.snapshot().unwrap();
        let record = snapshot
            .records
            .iter()
            .find(|record| record.display_name == name)
            .unwrap();
        let mut out = Vec::new();
        store.export(record.id, &mut out).unwrap();
        out
    }

    fn restore_leftovers(root: &Path) -> Vec<String> {
        fs::read_dir(root.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| {
                name.starts_with(RESTORE_STAGE_PREFIX) || name.ends_with(".restore-ready")
            })
            .collect()
    }

    #[test]
    fn a_backup_holds_no_plaintext_and_restores_on_another_device() {
        let temp = tempfile::tempdir().unwrap();
        let (_, backup, key) = backed_up_vault(&temp.path().join("home-a").join("vault"));
        assert!(backup.starts_with(BACKUP_MAGIC));
        assert!(!backup.windows(CANARY.len()).any(|window| window == CANARY));
        assert!(!backup.windows(5).any(|window| window == b"Jamie"));

        // Restored with the passphrase on a device that has no vault.
        let root = temp.path().join("home-b").join("vault");
        let fresh = VaultStore::new(root.clone());
        let preview = fresh
            .inspect_backup(
                Cursor::new(backup.clone()),
                RestoreCredential::Passphrase(PASSWORD),
            )
            .unwrap();
        assert_eq!(preview.replaces, RestoreReplaces::Nothing);
        assert_eq!(preview.document_count, 2);
        fresh
            .restore(
                Cursor::new(backup.clone()),
                RestoreCredential::Passphrase(PASSWORD),
                false,
            )
            .unwrap();
        assert_eq!(fresh.status().unwrap(), VaultStatus::Locked);
        fresh.unlock(PASSWORD).unwrap();
        assert_eq!(exported(&fresh, "first.pdf"), CANARY);
        assert_eq!(fresh.snapshot().unwrap().recovery, None);
        fresh.lock();
        // The recovery key opens the restored vault too.
        assert!(fresh.recover(&key, PASSPHRASE_REPLACEMENT).unwrap());
        assert!(restore_leftovers(&root).is_empty());

        // And the recovery key alone restores a backup.
        let other = temp.path().join("home-c").join("vault");
        let restored = VaultStore::new(other.clone());
        restored
            .restore(
                Cursor::new(backup),
                RestoreCredential::RecoveryKey(&key),
                false,
            )
            .unwrap();
        restored.unlock(PASSWORD).unwrap();
        assert_eq!(restored.snapshot().unwrap().records.len(), 2);
    }

    #[test]
    fn a_wrong_credential_changes_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let (_, backup, _) = backed_up_vault(&temp.path().join("home-a").join("vault"));
        let root = temp.path().join("home-b").join("vault");
        let store = VaultStore::new(root.clone());
        assert!(matches!(
            store.restore(
                Cursor::new(backup.clone()),
                RestoreCredential::Passphrase(PASSPHRASE_REPLACEMENT),
                false
            ),
            Err(VaultError::WrongPassphrase)
        ));
        let other_key = encode_recovery_key(&[9_u8; RECOVERY_KEY_BYTES]);
        assert!(matches!(
            store.restore(
                Cursor::new(backup),
                RestoreCredential::RecoveryKey(&other_key),
                false
            ),
            Err(VaultError::WrongRecoveryKey)
        ));
        assert!(!root.exists());
        assert!(restore_leftovers(&root).is_empty());
    }

    #[test]
    fn a_changed_or_truncated_backup_is_refused_before_anything_changes() {
        let temp = tempfile::tempdir().unwrap();
        let (_, backup, _) = backed_up_vault(&temp.path().join("home-a").join("vault"));
        let root = temp.path().join("home-b").join("vault");
        let store = VaultStore::new(root.clone());
        // One changed byte anywhere after the header's key envelope, and every
        // truncation, is refused. (A changed byte in the header is refused
        // too, as a wrong passphrase or an unreadable backup.)
        let header_end = 16 + 1 + 2 + "header.json".len() + 8 + 64;
        let step = (backup.len() / 41).max(1);
        for position in (header_end..backup.len()).step_by(step) {
            let mut changed = backup.clone();
            changed[position] ^= 0x01;
            let outcome = store.restore(
                Cursor::new(changed),
                RestoreCredential::Passphrase(PASSWORD),
                false,
            );
            assert!(
                matches!(
                    outcome,
                    Err(VaultError::BackupUnreadable | VaultError::WrongPassphrase)
                ),
                "byte {position}"
            );
        }
        // The places only the trailer's tag protects, each by name: the last
        // object's bytes are also covered by its own encryption, but the
        // trailer's fields and the tag itself are not.
        let tag_start = backup.len() - 32;
        let created = backup
            .windows(11)
            .rposition(|window| window == b"createdAtMs")
            .unwrap();
        for position in [tag_start - 200, created + 14, tag_start, backup.len() - 1] {
            let mut changed = backup.clone();
            changed[position] ^= 0x01;
            assert!(
                matches!(
                    store.restore(
                        Cursor::new(changed),
                        RestoreCredential::Passphrase(PASSWORD),
                        false
                    ),
                    Err(VaultError::BackupUnreadable)
                ),
                "byte {position}"
            );
        }
        for length in (0..backup.len()).step_by(step) {
            let outcome = store.restore(
                Cursor::new(backup[..length].to_vec()),
                RestoreCredential::Passphrase(PASSWORD),
                false,
            );
            assert!(outcome.is_err(), "length {length}");
        }
        let mut longer = backup.clone();
        longer.push(0);
        assert!(matches!(
            store.restore(
                Cursor::new(longer),
                RestoreCredential::Passphrase(PASSWORD),
                false
            ),
            Err(VaultError::BackupUnreadable)
        ));
        assert!(!root.exists());
        assert!(restore_leftovers(&root).is_empty());
    }

    #[test]
    fn restoring_replaces_a_vault_only_when_the_patient_agrees() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home-a").join("vault");
        let (store, backup, _) = backed_up_vault(&root);

        // The same vault, moved on since the backup.
        store.unlock(PASSWORD).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(
                profile,
                vec![],
                vec![source("later.pdf", b"later record")],
                5,
            )
            .unwrap();
        store.lock();
        let preview = store
            .inspect_backup(
                Cursor::new(backup.clone()),
                RestoreCredential::Passphrase(PASSWORD),
            )
            .unwrap();
        assert_eq!(preview.replaces, RestoreReplaces::SameVault);
        assert!(preview.differs_from_this_device);
        assert!(matches!(
            store.restore(
                Cursor::new(backup.clone()),
                RestoreCredential::Passphrase(PASSWORD),
                false
            ),
            Err(VaultError::AlreadyExists)
        ));
        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.snapshot().unwrap().records.len(), 3);
        store.lock();

        store
            .restore(
                Cursor::new(backup.clone()),
                RestoreCredential::Passphrase(PASSWORD),
                true,
            )
            .unwrap();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.snapshot().unwrap().records.len(), 2);
        store.lock();
        assert!(!reset_path(&root).unwrap().exists());
        assert!(restore_leftovers(&root).is_empty());

        // A different vault on this device is reported as such.
        let (other, _, _) = backed_up_vault(&temp.path().join("home-b").join("vault"));
        drop(other);
        let other = VaultStore::new(temp.path().join("home-b").join("vault"));
        assert_eq!(
            other
                .inspect_backup(
                    Cursor::new(backup.clone()),
                    RestoreCredential::Passphrase(PASSWORD),
                )
                .unwrap()
                .replaces,
            RestoreReplaces::OtherVault
        );
    }

    #[test]
    fn a_vault_whose_header_cannot_be_read_is_not_called_another_one() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (store, backup, _) = backed_up_vault(&root);
        for slot in [HEADER_SLOTS[0], HEADER_SLOTS[1], LEGACY_HEADER] {
            if root.join(slot).exists() {
                fs::write(root.join(slot), b"not a header").unwrap();
            }
        }
        assert_eq!(
            store
                .inspect_backup(Cursor::new(backup), RestoreCredential::Passphrase(PASSWORD))
                .unwrap()
                .replaces,
            RestoreReplaces::Unreadable
        );
    }

    /// Makes `boundary`, or each of `boundaries`, fail on this thread until
    /// the guard is dropped.
    struct FailAt;
    impl FailAt {
        fn new(boundary: &'static str) -> Self {
            Self::all(Box::leak(Box::new([boundary])))
        }
        fn all(boundaries: &'static [&'static str]) -> Self {
            FAIL_AT_TEST_BOUNDARY.set(boundaries);
            Self
        }
    }
    impl Drop for FailAt {
        fn drop(&mut self) {
            FAIL_AT_TEST_BOUNDARY.set(&[]);
        }
    }

    #[test]
    fn a_backup_is_refused_when_a_document_does_not_authenticate() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (store, _, objects) = vault_with_records(&root, &["kept.pdf", "rotted.pdf"]);
        let mut bytes = fs::read(&objects[1]).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        fs::write(&objects[1], bytes).unwrap();

        // The object is there, so the vault opens as usual. Without the check
        // the backup would save, and no restore would ever accept it.
        store.unlock(PASSWORD).unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.recovery, None);
        // The refusal names the document, so the patient can tell which.
        let rotted = snapshot
            .records
            .iter()
            .find(|record| record.display_name == "rotted.pdf")
            .unwrap()
            .id;
        let mut backup = Vec::new();
        assert!(matches!(
            store.verify_for_backup(),
            Err(VaultError::DamagedDocument(id)) if id == rotted
        ));
        assert!(matches!(
            store.backup(&mut backup, 4),
            Err(VaultError::DamagedDocument(id)) if id == rotted
        ));
    }

    #[test]
    fn the_preview_says_when_this_device_differs_from_the_backup() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (store, backup, _) = backed_up_vault(&root);
        let preview = |store: &VaultStore| {
            store
                .inspect_backup(
                    Cursor::new(backup.clone()),
                    RestoreCredential::Passphrase(PASSWORD),
                )
                .unwrap()
        };
        let same = preview(&store);
        assert_eq!(same.replaces, RestoreReplaces::SameVault);
        assert!(!same.differs_from_this_device);

        // A passphrase change leaves the documents as they were, but the
        // backup would bring the old passphrase back.
        store.unlock(PASSWORD).unwrap();
        store
            .change_passphrase(PASSWORD, PASSPHRASE_REPLACEMENT)
            .unwrap();
        store.lock();
        let changed = preview(&store);
        assert!(changed.differs_from_this_device);

        // Restored and opened: redundancy repair moves the generations on,
        // and the vault is still what the backup holds.
        store
            .restore(
                Cursor::new(backup.clone()),
                RestoreCredential::Passphrase(PASSWORD),
                true,
            )
            .unwrap();
        store.unlock(PASSWORD).unwrap();
        store.lock();
        let restored = preview(&store);
        assert!(!restored.differs_from_this_device);

        // A replaced recovery key differs too.
        store.unlock(PASSWORD).unwrap();
        set_up_recovery_key(&store, 9);
        store.lock();
        assert!(preview(&store).differs_from_this_device);
    }

    #[test]
    fn a_restore_that_could_not_retire_the_vault_changes_nothing_later() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (store, backup, _) = backed_up_vault(&root);
        store.unlock(PASSWORD).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(
                profile,
                vec![],
                vec![source("later.pdf", b"later record")],
                5,
            )
            .unwrap();
        store.lock();
        {
            let _failing = FailAt::new("restore.before-retire");
            assert!(store
                .restore(
                    Cursor::new(backup),
                    RestoreCredential::Passphrase(PASSWORD),
                    true
                )
                .is_err());
        }
        // The failure was reported, so no later start may finish the restore.
        assert!(restore_leftovers(&root).is_empty());
        let restarted = VaultStore::new(root);
        restarted.unlock(PASSWORD).unwrap();
        assert_eq!(restarted.snapshot().unwrap().records.len(), 3);
    }

    /// A vault changed after its backup was made: it holds a third
    /// document, which the backup does not.
    fn changed_since_its_backup(root: &Path) -> (VaultStore, Vec<u8>) {
        let (store, backup, _) = backed_up_vault(root);
        store.unlock(PASSWORD).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(
                profile,
                vec![],
                vec![source("later.pdf", b"later record")],
                5,
            )
            .unwrap();
        store.lock();
        (store, backup)
    }

    #[test]
    fn a_restore_that_could_not_take_the_vaults_place_puts_it_back() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (store, backup) = changed_since_its_backup(&root);
        {
            let _failing = FailAt::new("restore.before-activate");
            assert!(matches!(
                store.restore(
                    Cursor::new(backup),
                    RestoreCredential::Passphrase(PASSWORD),
                    true
                ),
                Err(VaultError::NoSpace)
            ));
        }
        // The vault was retired, and is back: the failure changed nothing,
        // and no later start finishes the restore.
        assert!(restore_leftovers(&root).is_empty());
        assert!(!reset_path(&root).unwrap().exists());
        let restarted = VaultStore::new(root);
        restarted.unlock(PASSWORD).unwrap();
        assert_eq!(restarted.snapshot().unwrap().records.len(), 3);
    }

    #[test]
    fn a_restore_that_could_not_put_the_vault_back_finishes_at_the_next_start() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (store, backup) = changed_since_its_backup(&root);
        {
            let _failing = FailAt::all(&["restore.before-activate", "restore.before-rollback"]);
            assert!(matches!(
                store.restore(
                    Cursor::new(backup),
                    RestoreCredential::Passphrase(PASSWORD),
                    true
                ),
                Err(VaultError::RestoreUnfinished)
            ));
        }
        // The verified copy is the one vault left, so it is kept, and the
        // next start puts it in place, as the failure said.
        assert!(!root.exists());
        assert_eq!(restore_leftovers(&root).len(), 1);
        let restarted = VaultStore::new(root.clone());
        assert_eq!(restarted.status().unwrap(), VaultStatus::Locked);
        assert!(restore_leftovers(&root).is_empty());
        assert!(!reset_path(&root).unwrap().exists());
        restarted.unlock(PASSWORD).unwrap();
        assert_eq!(restarted.snapshot().unwrap().records.len(), 2);
    }

    #[test]
    fn a_restore_that_could_not_take_the_vaults_place_at_a_start_puts_it_back() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (_store, backup) = changed_since_its_backup(&root);
        let file = temp.path().join("backup.mycarlosbackup");
        fs::write(&file, &backup).unwrap();
        // A verified restore waits for the next start, which fails to put it
        // in place after retiring the vault.
        run_restore_termination_child(&root, &file, "restore.after-ready");
        let restarted = VaultStore::new(root.clone());
        {
            let _failing = FailAt::new("restore.before-activate");
            assert!(restarted.status().is_err());
        }
        // The vault is back, and the restore still waits for a start.
        assert!(root.exists());
        assert!(!reset_path(&root).unwrap().exists());
        assert_eq!(restore_leftovers(&root).len(), 1);
        assert_eq!(restarted.status().unwrap(), VaultStatus::Locked);
        restarted.unlock(PASSWORD).unwrap();
        assert_eq!(restarted.snapshot().unwrap().records.len(), 2);
        assert!(restore_leftovers(&root).is_empty());
    }

    #[test]
    fn a_failed_restore_onto_a_device_with_no_vault_leaves_it_without_one() {
        let temp = tempfile::tempdir().unwrap();
        let (_, backup, _) = backed_up_vault(&temp.path().join("home-a").join("vault"));
        let root = temp.path().join("home-b").join("vault");
        let store = VaultStore::new(root.clone());
        {
            let _failing = FailAt::new("restore.before-activate");
            assert!(matches!(
                store.restore(
                    Cursor::new(backup),
                    RestoreCredential::Passphrase(PASSWORD),
                    false
                ),
                Err(VaultError::NoSpace)
            ));
        }
        // Reported as failed, so nothing is put in place later either.
        assert!(restore_leftovers(&root).is_empty());
        assert_eq!(store.status().unwrap(), VaultStatus::Absent);
    }

    #[test]
    fn what_is_left_of_a_discarded_restore_is_never_put_in_place() {
        // A verified copy whose removal was cut short: no header, some
        // objects, under the name the next start looks for.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (store, _, _) = backed_up_vault(&root);
        store.lock();
        let ready = restore_ready_path(&root).unwrap();
        fs::create_dir_all(ready.join("objects")).unwrap();
        fs::write(ready.join("objects").join("left-over"), b"x").unwrap();

        let restarted = VaultStore::new(root.clone());
        assert_eq!(restarted.status().unwrap(), VaultStatus::Locked);
        assert!(!ready.exists());
        assert!(!reset_path(&root).unwrap().exists());
        restarted.unlock(PASSWORD).unwrap();
        assert_eq!(restarted.snapshot().unwrap().records.len(), 2);
    }

    #[test]
    fn a_restore_refuses_another_backup_than_the_one_confirmed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (store, older, _) = backed_up_vault(&root);
        store.unlock(PASSWORD).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(
                profile,
                vec![],
                vec![source("later.pdf", b"later record")],
                5,
            )
            .unwrap();
        let mut newer = Vec::new();
        store.backup(&mut newer, 6).unwrap();
        store.lock();

        // The patient agreed to the newer backup, which holds what the vault
        // does. The older one is in its place when the restore opens the file.
        let confirmed = store
            .inspect_backup(
                Cursor::new(newer.clone()),
                RestoreCredential::Passphrase(PASSWORD),
            )
            .unwrap();
        assert!(!confirmed.differs_from_this_device);
        assert!(matches!(
            store.restore_confirmed(
                Cursor::new(older),
                RestoreCredential::Passphrase(PASSWORD),
                &confirmed
            ),
            Err(VaultError::BackupChanged)
        ));
        assert!(restore_leftovers(&root).is_empty());
        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.snapshot().unwrap().records.len(), 3);
        store.lock();

        store
            .restore_confirmed(
                Cursor::new(newer),
                RestoreCredential::Passphrase(PASSWORD),
                &confirmed,
            )
            .unwrap();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.snapshot().unwrap().records.len(), 3);
    }

    #[test]
    fn a_restore_that_fails_before_it_is_verified_leaves_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (store, backup, _) = backed_up_vault(&root);
        store.lock();
        {
            let _failing = FailAt::new("restore.before-verify");
            assert!(store
                .restore(
                    Cursor::new(backup),
                    RestoreCredential::Passphrase(PASSWORD),
                    true
                )
                .is_err());
        }
        assert!(restore_leftovers(&root).is_empty());
        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.snapshot().unwrap().records.len(), 2);
    }

    #[test]
    fn a_restore_goes_in_place_before_the_vault_it_retired_is_erased() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (_, backup, _) = backed_up_vault(&root);
        let file = temp.path().join("backup.mycarlosbackup");
        fs::write(&file, &backup).unwrap();
        run_restore_termination_child(&root, &file, "restore.after-retire");
        assert!(!root.exists());

        // The erasing fails at the next start. The restored vault must be in
        // place all the same, or the patient would have none.
        let restarted = VaultStore::new(root.clone());
        {
            let _failing = FailAt::new("reset.before-cleanup");
            assert!(restarted.status().is_err());
        }
        assert!(root.exists());
        assert_eq!(restarted.status().unwrap(), VaultStatus::Locked);
        restarted.unlock(PASSWORD).unwrap();
        assert!(!reset_path(&root).unwrap().exists());
    }

    /// A backup of `root`'s vault with `entries` as its objects, in that
    /// order, correctly tagged: what only someone holding the key could make.
    fn crafted_backup(root: &Path, entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let header = read_latest_header(root).unwrap();
        let master_key = unwrap_master_key(&header, PASSWORD).unwrap();
        let manifest = read_latest_manifest(root, &master_key, header.vault_id).unwrap();
        let header_data = serde_json::to_vec_pretty(&header).unwrap();
        let manifest_data = fs::read(manifest_path(root, manifest.generation)).unwrap();
        let mut out = Vec::new();
        let mut backup = BackupWriter::new(&mut out).unwrap();
        backup
            .entry(
                BACKUP_KIND_HEADER,
                "header.json",
                header_data.len() as u64,
                &mut header_data.as_slice(),
            )
            .unwrap();
        backup
            .entry(
                BACKUP_KIND_MANIFEST,
                "manifest.bin",
                manifest_data.len() as u64,
                &mut manifest_data.as_slice(),
            )
            .unwrap();
        for (name, data) in entries {
            backup
                .entry(
                    BACKUP_KIND_OBJECT,
                    name,
                    data.len() as u64,
                    &mut data.as_slice(),
                )
                .unwrap();
        }
        backup
            .finish(&master_key, header.vault_id, manifest.generation, 4)
            .unwrap();
        out
    }

    #[test]
    fn a_backup_with_the_wrong_objects_is_refused_even_when_correctly_tagged() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("home-a").join("vault");
        let (_, _, objects) = vault_with_records(&source, &["a.pdf", "b.pdf"]);
        let named = |path: &PathBuf| {
            (
                path.file_name().unwrap().to_str().unwrap().to_owned(),
                fs::read(path).unwrap(),
            )
        };
        let (a, b) = (named(&objects[0]), named(&objects[1]));
        let stray = format!("{}.mcobj", Uuid::new_v4());
        let oversized = vec![0_u8; usize::try_from(largest_object_len(5)).unwrap() + 1];
        type Entries<'a> = Vec<(&'a str, Vec<u8>)>;
        let cases: Vec<(&str, Entries)> = vec![
            (
                "an object twice",
                vec![(&a.0, a.1.clone()), (&a.0, a.1.clone())],
            ),
            ("an object missing", vec![(&a.0, a.1.clone())]),
            (
                "an object the manifest does not name",
                vec![
                    (&a.0, a.1.clone()),
                    (&b.0, b.1.clone()),
                    (&stray, b.1.clone()),
                ],
            ),
            (
                "a name that leaves the folder",
                vec![(&a.0, a.1.clone()), ("../escaped.mcobj", b.1.clone())],
            ),
            (
                "an object larger than its document allows",
                vec![(&a.0, oversized), (&b.0, b.1.clone())],
            ),
        ];
        let root = temp.path().join("home-b").join("vault");
        let store = VaultStore::new(root.clone());
        for (case, entries) in cases {
            let backup = crafted_backup(&source, &entries);
            assert!(
                matches!(
                    store.restore(
                        Cursor::new(backup),
                        RestoreCredential::Passphrase(PASSWORD),
                        false
                    ),
                    Err(VaultError::BackupUnreadable)
                ),
                "{case}"
            );
            assert!(!root.exists(), "{case}");
            assert!(restore_leftovers(&root).is_empty(), "{case}");
            assert!(!temp.path().join("home-b").join("escaped.mcobj").exists());
        }
        // The same helper makes a backup that does restore.
        let good = crafted_backup(&source, &[(&a.0, a.1.clone()), (&b.0, b.1.clone())]);
        store
            .restore(
                Cursor::new(good),
                RestoreCredential::Passphrase(PASSWORD),
                false,
            )
            .unwrap();
    }

    #[test]
    fn a_refused_backup_leaves_the_vault_it_would_have_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (store, backup, _) = backed_up_vault(&root);
        store.unlock(PASSWORD).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(
                profile,
                vec![],
                vec![source("later.pdf", b"later record")],
                5,
            )
            .unwrap();
        store.lock();

        let step = (backup.len() / 23).max(1);
        let mut refused = Vec::new();
        for position in (100..backup.len()).step_by(step) {
            let mut changed = backup.clone();
            changed[position] ^= 0x01;
            refused.push(changed);
        }
        for length in (0..backup.len()).step_by(step) {
            refused.push(backup[..length].to_vec());
        }
        for (index, bad) in refused.into_iter().enumerate() {
            assert!(
                store
                    .restore(
                        Cursor::new(bad),
                        RestoreCredential::Passphrase(PASSWORD),
                        true
                    )
                    .is_err(),
                "case {index}"
            );
        }
        assert!(restore_leftovers(&root).is_empty());
        assert!(!reset_path(&root).unwrap().exists());
        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.snapshot().unwrap().records.len(), 3);
        assert_eq!(exported(&store, "later.pdf"), b"later record");
    }

    #[test]
    fn a_read_only_vault_is_not_backed_up() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        store.unlocked.lock().unwrap().as_mut().unwrap().recovery =
            Some(RecoveryReason::WriteFailed);
        assert!(matches!(
            store.backup(Vec::new(), 1),
            Err(VaultError::RecoveryMode)
        ));
        assert!(matches!(
            store.verify_for_backup(),
            Err(VaultError::RecoveryMode)
        ));
    }

    #[test]
    fn the_check_before_a_provider_backup_refuses_what_the_backup_refuses() {
        // A provider's destination is emptied before the backup is written,
        // so the check must refuse whatever the backup would.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let generation = store
            .unlocked
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .manifest
            .generation;
        // The manifest slot no longer holds what the session shows.
        fs::write(manifest_path(&root, generation), b"not the manifest").unwrap();
        assert!(matches!(
            store.verify_for_backup(),
            Err(VaultError::Corrupt)
        ));
        assert!(matches!(
            store.backup(Vec::new(), 1),
            Err(VaultError::Corrupt)
        ));
    }

    fn run_restore_termination_child(root: &Path, backup: &Path, boundary: &str) {
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "vault::tests::restore_termination_child",
            ])
            .env("MYCARLOS_TEST_ROOT", root)
            .env("MYCARLOS_TEST_BACKUP", backup)
            .env("MYCARLOS_TEST_TERMINATE_AT", boundary)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert_eq!(
            status.code(),
            Some(TEST_TERMINATION_EXIT_CODE),
            "{boundary}"
        );
    }

    #[test]
    #[ignore = "invoked as an abrupt-termination subprocess by the restore matrix"]
    fn restore_termination_child() {
        let (Ok(root), Ok(backup)) = (
            std::env::var("MYCARLOS_TEST_ROOT"),
            std::env::var("MYCARLOS_TEST_BACKUP"),
        ) else {
            return;
        };
        let store = VaultStore::new(PathBuf::from(root));
        let backup = fs::read(backup).unwrap();
        let _ = store.restore(
            Cursor::new(backup),
            RestoreCredential::Passphrase(PASSWORD),
            true,
        );
    }

    #[test]
    fn an_interrupted_restore_finishes_at_the_next_start() {
        for boundary in [
            "restore.after-ready",
            "restore.after-retire",
            "restore.after-activate",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("home").join("vault");
            let (store, backup, _) = backed_up_vault(&root);
            // The vault moves on, so that the restored state is told apart.
            store.unlock(PASSWORD).unwrap();
            let profile = store.snapshot().unwrap().profiles[0].id;
            store
                .import(
                    profile,
                    vec![],
                    vec![source("later.pdf", b"later record")],
                    5,
                )
                .unwrap();
            store.lock();
            let file = temp.path().join("backup.mycarlosbackup");
            fs::write(&file, &backup).unwrap();

            run_restore_termination_child(&root, &file, boundary);
            let restarted = VaultStore::new(root.clone());
            assert_eq!(
                restarted.status().unwrap(),
                VaultStatus::Locked,
                "{boundary}"
            );
            restarted.unlock(PASSWORD).unwrap();
            assert_eq!(restarted.snapshot().unwrap().records.len(), 2, "{boundary}");
            assert!(!reset_path(&root).unwrap().exists(), "{boundary}");
            assert!(restore_leftovers(&root).is_empty(), "{boundary}");
        }
    }

    #[test]
    fn a_stage_left_by_a_restore_that_died_is_removed_at_the_next_start() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (_, backup, _) = backed_up_vault(&root);
        // A stage left by a process that died before verifying is removed at
        // the next start, and the live vault is untouched.
        let stage = root
            .parent()
            .unwrap()
            .join(format!("{RESTORE_STAGE_PREFIX}{}", Uuid::new_v4()));
        fs::create_dir(&stage).unwrap();
        fs::write(stage.join("header-0.json"), b"{}").unwrap();
        let store = VaultStore::new(root.clone());
        assert_eq!(store.status().unwrap(), VaultStatus::Locked);
        assert!(!stage.exists());
        drop(backup);
    }

    #[test]
    fn a_passphrase_change_that_landed_is_reported_as_made() {
        // The first header write can fail after its rename lands, for example
        // when the directory sync fails. The replacement then opens the vault,
        // so the change must not be reported as refused.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        store.lock();
        run_failure_child(&root, "passphrase", "passphrase.after-first-write");

        let restarted = VaultStore::new(root);
        assert!(matches!(
            restarted.unlock(PASSWORD),
            Err(VaultError::WrongPassphrase)
        ));
        restarted.unlock(PASSPHRASE_REPLACEMENT).unwrap();
    }

    #[test]
    fn large_imports_keep_reader_requests_bounded_to_one_chunk() {
        const LARGE_FILE_SIZE: u64 = 101 * 1024 * 1024 + 17;

        let temp = tempfile::tempdir().unwrap();
        let object = temp.path().join("large.mcobj");
        let largest_request = Arc::new(AtomicUsize::new(0));
        let encrypted = encrypt_object(
            Box::new(GeneratedReader {
                remaining: LARGE_FILE_SIZE,
                largest_request: largest_request.clone(),
            }),
            &object,
            ObjectContext {
                vault_id: Uuid::new_v4(),
                record_id: Uuid::new_v4(),
                profile_id: Uuid::new_v4(),
            },
            &[1_u8; 32],
            &[2_u8; 32],
        )
        .unwrap();

        assert_eq!(encrypted.plaintext_size, LARGE_FILE_SIZE);
        assert_eq!(largest_request.load(Ordering::Relaxed), CHUNK_SIZE);
        let stored = fs::metadata(object).unwrap().len();
        assert!(stored > LARGE_FILE_SIZE);
        // The limit a restore applies has room for a real object of any size.
        assert!(stored <= largest_object_len(LARGE_FILE_SIZE));
        assert!(largest_object_len(0) >= 4096);
    }

    #[test]
    fn locked_storage_contains_no_plaintext_canaries() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Canary Patient Name", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(
                profile,
                vec![],
                vec![source(
                    "canary-diagnosis.txt",
                    b"recognizable medical canary",
                )],
                2,
            )
            .unwrap();
        store.lock();

        for path in files_below(&root) {
            let contents = fs::read(path).unwrap();
            assert!(!contents
                .windows(b"Canary Patient Name".len())
                .any(|value| value == b"Canary Patient Name"));
            assert!(!contents
                .windows(b"canary-diagnosis".len())
                .any(|value| value == b"canary-diagnosis"));
            assert!(!contents
                .windows(b"recognizable medical canary".len())
                .any(|value| value == b"recognizable medical canary"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn vault_directories_and_files_are_private_on_unix() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(
                profile,
                vec![],
                vec![source("permissions.pdf", b"synthetic permissions record")],
                2,
            )
            .unwrap();
        store.lock();

        for directory in [&root, &root.join("objects"), &root.join("staging")] {
            assert_eq!(
                fs::metadata(directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        for path in files_below(&root) {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn unlock_removes_uncommitted_ciphertext_objects() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let orphan = root.join("objects").join("interrupted-import.mcobj");
        fs::write(&orphan, b"synthetic orphan ciphertext").unwrap();
        store.lock();

        store.unlock(PASSWORD).unwrap();

        assert!(!orphan.exists());
    }

    #[test]
    fn unlock_and_reset_remove_abandoned_atomic_write_directories() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        store.lock();
        // What a process killed inside an atomic header write leaves behind.
        let abandoned = root.join(format!("{ATOMIC_WRITE_PREFIX}AbC123"));
        fs::create_dir(&abandoned).unwrap();
        fs::copy(root.join(HEADER_SLOTS[0]), abandoned.join("tmpfile.tmp")).unwrap();
        // Only a directory with the prefix is a temporary write.
        let unrelated = root.join(format!("{ATOMIC_WRITE_PREFIX}-note"));
        fs::write(&unrelated, b"not a directory").unwrap();

        store.unlock(PASSWORD).unwrap();

        assert!(!abandoned.exists());
        assert!(unrelated.exists());
        assert_eq!(store.snapshot().unwrap().recovery, None);

        store.lock();
        fs::create_dir(&abandoned).unwrap();
        fs::copy(root.join(HEADER_SLOTS[0]), abandoned.join("tmpfile.tmp")).unwrap();
        remove_key_envelopes(&root).unwrap();
        assert!(!abandoned.exists());
    }

    #[test]
    fn an_envelope_that_cannot_be_removed_does_not_keep_the_others() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        store.lock();
        // A directory in a slot's place cannot be removed as a file.
        fs::remove_file(root.join(HEADER_SLOTS[0])).unwrap();
        fs::create_dir(root.join(HEADER_SLOTS[0])).unwrap();

        assert!(remove_key_envelopes(&root).is_err());
        assert!(!root.join(HEADER_SLOTS[1]).exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_recreated_staging_directory_is_private() {
        use std::os::unix::fs::PermissionsExt as _;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        // Backup and sync tools drop empty directories.
        fs::remove_dir_all(root.join("staging")).unwrap();

        store
            .import(profile, vec![], vec![source("FAKE.pdf", b"fake")], 2)
            .unwrap();
        let mode = fs::metadata(root.join("staging"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn a_planted_newer_header_does_not_refuse_the_right_passphrase_on_change() {
        const REPLACEMENT: &str = "lantern-orbit-willow-cascade-572";

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        // Structurally valid, newest by generation, and authentic under no key.
        let mut planted: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(HEADER_SLOTS[0])).unwrap()).unwrap();
        planted["generation"] = serde_json::json!(4_000);
        fs::write(
            root.join(LEGACY_HEADER),
            serde_json::to_vec(&planted).unwrap(),
        )
        .unwrap();

        store.change_passphrase(PASSWORD, REPLACEMENT).unwrap();
        store.lock();
        store.unlock(REPLACEMENT).unwrap();
    }

    #[test]
    fn reset_never_leaves_io_cancelled_for_a_later_session() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        assert!(matches!(store.reset(), Err(VaultError::Missing)));
        assert!(!store.cancel_io.load(Ordering::Acquire));

        store.create(PASSWORD, "Jamie", 1).unwrap();
        store.reset().unwrap();
        assert!(!store.cancel_io.load(Ordering::Acquire));
    }

    #[cfg(unix)]
    #[test]
    fn export_through_a_link_to_the_lock_file_replaces_the_link_not_the_lock() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let record = store
            .import(profile, vec![], vec![source("report.pdf", b"record")], 2)
            .unwrap()
            .imported[0];
        // A link outside the home that points at the lock file. The export is
        // allowed there, but it must replace the link, not write through it.
        let lock = sibling_path(&root, ".lock").unwrap();
        let lock_before = fs::metadata(&lock).unwrap();
        let alias = temp.path().join("alias.pdf");
        symlink(&lock, &alias).unwrap();

        store.export_atomic(record, &alias).unwrap();
        assert!(!fs::symlink_metadata(&alias)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&alias).unwrap(), b"record");
        assert!(same_file(&lock_before, &fs::metadata(&lock).unwrap()));
        assert_eq!(fs::metadata(&lock).unwrap().len(), 0);
    }

    /// A locked vault with `names` imported: the record ids and object paths.
    fn vault_with_records(root: &Path, names: &[&str]) -> (VaultStore, Vec<Uuid>, Vec<PathBuf>) {
        let store = VaultStore::new(root.to_path_buf());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let sources = names
            .iter()
            .map(|name| source(name, name.as_bytes()))
            .collect();
        let imported = store.import(profile, vec![], sources, 2).unwrap().imported;
        let objects = {
            let guard = store.unlocked.lock().unwrap();
            let manifest = &guard.as_ref().unwrap().manifest;
            imported
                .iter()
                .map(|id| {
                    let record = manifest.records.iter().find(|r| r.id == *id).unwrap();
                    root.join("objects").join(&record.object_name)
                })
                .collect()
        };
        store.lock();
        (store, imported, objects)
    }

    #[test]
    fn removing_damaged_records_returns_the_vault_to_a_writable_state() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let (store, imported, objects) = vault_with_records(&root, &["kept", "lost"]);
        fs::remove_file(&objects[1]).unwrap();

        store.unlock(PASSWORD).unwrap();
        assert_eq!(
            store.snapshot().unwrap().recovery,
            Some(RecoveryReason::LostObjects)
        );
        assert!(matches!(
            store.create_profile("Morgan", 3),
            Err(VaultError::RecoveryMode)
        ));

        let removed = store.remove_unavailable_records().unwrap();

        assert_eq!(removed, vec![imported[1]]);
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.recovery, None);
        assert_eq!(snapshot.records.len(), 1);
        assert!(snapshot.records[0].available);
        store.create_profile("Morgan", 3).unwrap();
        store.lock();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.snapshot().unwrap().recovery, None);
        assert_eq!(store.snapshot().unwrap().profiles.len(), 2);
    }

    #[test]
    fn removing_damaged_records_keeps_one_whose_file_has_come_back() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let (store, imported, objects) = vault_with_records(&root, &["a", "b"]);
        let backup = temp.path().join("b.mcobj");
        fs::copy(&objects[1], &backup).unwrap();
        fs::remove_file(&objects[0]).unwrap();
        fs::remove_file(&objects[1]).unwrap();
        store.unlock(PASSWORD).unwrap();
        let damaged =
            |snapshot: &VaultSnapshot| snapshot.records.iter().filter(|r| !r.available).count();
        assert_eq!(damaged(&store.snapshot().unwrap()), 2);
        // The user restored one file from a backup before choosing to remove.
        fs::copy(&backup, &objects[1]).unwrap();

        let removed = store.remove_unavailable_records().unwrap();

        assert_eq!(removed, vec![imported[0]]);
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.recovery, None);
        assert_eq!(snapshot.records.len(), 1);
        assert_eq!(snapshot.records[0].id, imported[1]);
        assert_eq!(damaged(&snapshot), 0);
        let mut exported = Vec::new();
        store.export(imported[1], &mut exported).unwrap();
        assert_eq!(exported, b"b");
    }

    #[test]
    fn removing_damaged_records_restores_a_dropped_objects_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let (store, imported, _) = vault_with_records(&root, &["a", "b"]);
        // A restore that lost the whole directory loses every record with it.
        fs::remove_dir_all(root.join("objects")).unwrap();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(
            store.snapshot().unwrap().recovery,
            Some(RecoveryReason::LostObjects)
        );

        let mut removed = store.remove_unavailable_records().unwrap();
        removed.sort();
        let mut expected = imported.clone();
        expected.sort();
        assert_eq!(removed, expected);
        assert_eq!(store.snapshot().unwrap().recovery, None);

        // The session is writable again, so an import must work without a
        // lock and unlock in between.
        let profile = store.snapshot().unwrap().profiles[0].id;
        let outcome = store
            .import(profile, vec![], vec![source("c", b"c")], 3)
            .unwrap();
        assert_eq!(outcome.imported.len(), 1);
        let mut exported = Vec::new();
        store.export(outcome.imported[0], &mut exported).unwrap();
        assert_eq!(exported, b"c");
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_header_slot_outranks_lost_objects() {
        use std::os::unix::fs::PermissionsExt as _;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let (store, _, objects) = vault_with_records(&root, &["lost"]);
        fs::remove_file(&objects[0]).unwrap();
        let slot = root.join(HEADER_SLOTS[0]);
        fs::set_permissions(&slot, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(&slot).is_ok() {
            // A privileged process ignores file modes, so the unreadable slot
            // cannot be simulated here.
            return;
        }

        // The other header still opens the vault, but the slot that could not
        // be read may hold a newer passphrase generation. Removing the lost
        // record would make the session writable and let a passphrase change
        // rewrap the key over it.
        store.unlock(PASSWORD).unwrap();
        assert_eq!(
            store.snapshot().unwrap().recovery,
            Some(RecoveryReason::UnreadableSlot)
        );
        assert!(matches!(
            store.remove_unavailable_records(),
            Err(VaultError::RecoveryMode)
        ));
        store.lock();
        fs::set_permissions(&slot, fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn recovery_ranks_an_unreadable_header_slot_above_lost_objects() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let (store, _, objects) = vault_with_records(&root, &["lost"]);
        store.unlock(PASSWORD).unwrap();
        let key = set_up_recovery_key(&store, 5);
        store.lock();
        fs::remove_file(&objects[0]).unwrap();
        let slot = root.join(HEADER_SLOTS[0]);
        fs::set_permissions(&slot, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(&slot).is_ok() {
            // A privileged process ignores file modes, so the unreadable slot
            // cannot be simulated here.
            return;
        }

        // As for an unlock: removing the lost record would make the session
        // writable over a slot that may hold a newer header.
        assert!(!store.recover(&key, PASSPHRASE_REPLACEMENT).unwrap());
        // In that state a removal is refused, which
        // `damaged_records_are_not_removed_in_other_recovery_states` covers.
        assert_eq!(
            store.snapshot().unwrap().recovery,
            Some(RecoveryReason::UnreadableSlot)
        );
        store.lock();
        fs::set_permissions(&slot, fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[test]
    fn damaged_records_are_not_removed_in_other_recovery_states() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let (store, _, _) = vault_with_records(&root, &["a"]);
        store.unlock(PASSWORD).unwrap();
        assert!(matches!(
            store.remove_unavailable_records(),
            Err(VaultError::Invalid)
        ));
        for reason in [RecoveryReason::UnreadableSlot, RecoveryReason::WriteFailed] {
            store.unlocked.lock().unwrap().as_mut().unwrap().recovery = Some(reason);
            assert!(matches!(
                store.remove_unavailable_records(),
                Err(VaultError::RecoveryMode)
            ));
        }
    }

    #[test]
    fn a_missing_object_opens_the_vault_read_only_instead_of_failing_unlock() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let imported = store
            .import(
                profile,
                vec![],
                vec![
                    source("lost.pdf", b"synthetic lost record"),
                    source("kept.pdf", b"synthetic kept record"),
                ],
                2,
            )
            .unwrap()
            .imported;
        let (lost, kept) = (imported[0], imported[1]);
        let lost_object = {
            let guard = store.unlocked.lock().unwrap();
            let manifest = &guard.as_ref().unwrap().manifest;
            let record = manifest.records.iter().find(|r| r.id == lost).unwrap();
            root.join("objects").join(&record.object_name)
        };
        store.lock();
        fs::remove_file(&lost_object).unwrap();
        let orphan = root.join("objects").join("unreferenced.mcobj");
        fs::write(&orphan, b"synthetic orphan ciphertext").unwrap();
        let manifests_before = [
            fs::read(root.join("manifest-0.bin")).unwrap(),
            fs::read(root.join("manifest-1.bin")).unwrap(),
        ];

        store.unlock(PASSWORD).unwrap();

        let snapshot = store.snapshot().unwrap();
        assert!(snapshot.recovery.is_some());
        let availability = |id| {
            snapshot
                .records
                .iter()
                .find(|r| r.id == id)
                .unwrap()
                .available
        };
        assert!(!availability(lost));
        assert!(availability(kept));
        assert!(matches!(
            store.export(lost, io::sink()),
            Err(VaultError::Corrupt)
        ));
        let mut exported = Vec::new();
        store.export(kept, &mut exported).unwrap();
        assert_eq!(exported, b"synthetic kept record");
        assert!(matches!(
            store.delete_record(lost),
            Err(VaultError::RecoveryMode)
        ));
        // Recovery mode must leave storage exactly as it was found.
        assert!(orphan.exists());
        assert_eq!(
            fs::read(root.join("manifest-0.bin")).unwrap(),
            manifests_before[0]
        );
        assert_eq!(
            fs::read(root.join("manifest-1.bin")).unwrap(),
            manifests_before[1]
        );
    }

    #[test]
    fn import_is_refused_before_a_picker_when_it_cannot_succeed() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;

        assert!(store.ensure_import_allowed(profile).is_ok());
        assert!(matches!(
            store.ensure_import_allowed(Uuid::new_v4()),
            Err(VaultError::NotFound)
        ));
        store.unlocked.lock().unwrap().as_mut().unwrap().recovery =
            Some(RecoveryReason::WriteFailed);
        assert!(matches!(
            store.ensure_import_allowed(profile),
            Err(VaultError::RecoveryMode)
        ));
        store.lock();
        assert!(matches!(
            store.ensure_import_allowed(profile),
            Err(VaultError::Locked)
        ));
    }

    #[test]
    fn lock_drops_the_keys_even_after_a_panic_poisoned_the_vault_mutex() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(VaultStore::new(temp.path().join("vault")));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let poisoner = Arc::clone(&store);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.unlocked.lock().unwrap();
            panic!("synthetic panic while holding the vault mutex");
        })
        .join();
        assert!(store.unlocked.is_poisoned());

        store.lock();

        let guard = store
            .unlocked
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(guard.is_none());
        drop(guard);

        // The session is gone, so nothing the panic interrupted is still in use.
        // Every other method must work again instead of panicking until restart.
        assert!(matches!(store.status().unwrap(), VaultStatus::Locked));
        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.snapshot().unwrap().profiles.len(), 1);
    }

    #[test]
    fn a_poisoned_session_is_dropped_by_whichever_method_runs_next() {
        // The unlock screen never calls `lock`, so recovery cannot depend on it.
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(VaultStore::new(temp.path().join("vault")));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let poisoner = Arc::clone(&store);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.unlocked.lock().unwrap();
            panic!("synthetic panic while holding the vault mutex");
        })
        .join();
        assert!(store.unlocked.is_poisoned());

        // The interrupted session is not trusted: the vault reports locked.
        assert!(matches!(store.snapshot(), Err(VaultError::Locked)));
        assert!(!store.unlocked.is_poisoned());
        // And, as after any lock, it has no idle deadline.
        assert!(!store.idle().is_due(idle_past(Instant::now())));
        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.snapshot().unwrap().profiles.len(), 1);
    }

    #[test]
    fn a_lost_object_does_not_roll_back_over_intact_newer_records() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(profile, vec![], vec![source("first.pdf", b"first")], 2)
            .unwrap();
        let older_slots = [
            fs::read(root.join("manifest-0.bin")).unwrap(),
            fs::read(root.join("manifest-1.bin")).unwrap(),
        ];
        let imported = store
            .import(
                profile,
                vec![],
                vec![source("lost.pdf", b"lost"), source("kept.pdf", b"kept")],
                3,
            )
            .unwrap()
            .imported;
        let (newest_slot, lost_object, kept_object) = {
            let guard = store.unlocked.lock().unwrap();
            let manifest = &guard.as_ref().unwrap().manifest;
            let object = |id: Uuid| {
                let record = manifest.records.iter().find(|r| r.id == id).unwrap();
                root.join("objects").join(&record.object_name)
            };
            (
                manifest_path(&root, manifest.generation),
                object(imported[0]),
                object(imported[1]),
            )
        };
        store.lock();
        // Leave the newest state in one slot only, as a failed redundant write
        // would, then lose one of the objects only that state references.
        let stale_slot = usize::from(newest_slot.ends_with("manifest-0.bin"));
        fs::write(
            root.join(format!("manifest-{stale_slot}.bin")),
            &older_slots[stale_slot],
        )
        .unwrap();
        let newest_before = fs::read(&newest_slot).unwrap();
        fs::remove_file(&lost_object).unwrap();

        store.unlock(PASSWORD).unwrap();
        let snapshot = store.snapshot().unwrap();
        assert!(snapshot.recovery.is_some());
        assert_eq!(snapshot.records.len(), 3);
        let available = |id: Uuid| {
            snapshot
                .records
                .iter()
                .find(|r| r.id == id)
                .unwrap()
                .available
        };
        assert!(!available(imported[0]));
        assert!(available(imported[1]));
        assert!(kept_object.exists());
        assert_eq!(fs::read(&newest_slot).unwrap(), newest_before);
        let mut exported = Vec::new();
        store.export(imported[1], &mut exported).unwrap();
        assert_eq!(exported, b"kept");
    }

    #[test]
    fn a_newer_manifest_whose_new_objects_are_all_lost_still_falls_back() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(profile, vec![], vec![source("first.pdf", b"first")], 2)
            .unwrap();
        let older_slots = [
            fs::read(root.join("manifest-0.bin")).unwrap(),
            fs::read(root.join("manifest-1.bin")).unwrap(),
        ];
        let second = store
            .import(profile, vec![], vec![source("second.pdf", b"second")], 3)
            .unwrap()
            .imported[0];
        let (newest_slot, second_object) = {
            let guard = store.unlocked.lock().unwrap();
            let manifest = &guard.as_ref().unwrap().manifest;
            let record = manifest.records.iter().find(|r| r.id == second).unwrap();
            (
                manifest_path(&root, manifest.generation),
                root.join("objects").join(&record.object_name),
            )
        };
        store.lock();
        let stale_slot = usize::from(newest_slot.ends_with("manifest-0.bin"));
        fs::write(
            root.join(format!("manifest-{stale_slot}.bin")),
            &older_slots[stale_slot],
        )
        .unwrap();
        fs::remove_file(&second_object).unwrap();

        store.unlock(PASSWORD).unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.recovery, None);
        assert_eq!(snapshot.records.len(), 1);
    }

    /// A manifest with `records` named after their objects, all in one profile.
    fn manifest_with(vault_id: Uuid, generation: u64, records: &[&str]) -> Manifest {
        let profile = Uuid::from_u128(1);
        Manifest {
            format_version: VAULT_FORMAT,
            vault_id,
            generation,
            profiles: vec![PatientProfile {
                id: profile,
                display_name: "Jamie".to_owned(),
                created_at_ms: 1,
            }],
            folders: vec![],
            records: records
                .iter()
                .map(|name| StoredRecord {
                    id: Uuid::from_u128(u128::from(
                        name.bytes()
                            .fold(7_u64, |h, b| h.wrapping_mul(31).wrapping_add(u64::from(b))),
                    )),
                    profile_id: profile,
                    folder_ids: vec![],
                    display_name: format!("{name}.pdf"),
                    source_label: "test".to_owned(),
                    media_type: "application/pdf".to_owned(),
                    plaintext_size: 1,
                    imported_at_ms: 1,
                    object_name: format!("{name}.mcobj"),
                    fingerprint: String::new(),
                    wrapped_object_key: WrappedSecret {
                        nonce: String::new(),
                        ciphertext: String::new(),
                    },
                })
                .collect(),
        }
    }

    fn authentic(manifest: Manifest, missing: &[&str]) -> SlotReading {
        let missing = manifest
            .records
            .iter()
            .filter(|record| missing.contains(&record.object_name.trim_end_matches(".mcobj")))
            .map(|record| record.id)
            .collect();
        SlotReading::Authentic { manifest, missing }
    }

    #[test]
    fn unlock_selects_the_newest_complete_generation_and_reports_health() {
        let id = Uuid::new_v4();
        let older = manifest_with(id, 4, &["a"]);
        let newer = manifest_with(id, 5, &["a", "b"]);
        let slots = [authentic(older.clone(), &[]), authentic(newer.clone(), &[])];

        let selected = select_manifest(&slots).unwrap();
        assert!(selected.manifest == newer);
        assert_eq!(selected.recovery, None);
        assert!(selected.unavailable.is_empty());
        // Adjacent generations with different content: the redundant write of
        // generation 5 has not happened, so the slots are not yet healthy.
        assert!(!manifest_redundancy_healthy(&slots, &selected.manifest));

        let mut redundant = newer.clone();
        redundant.generation = 6;
        let slots = [authentic(redundant, &[]), authentic(newer.clone(), &[])];
        assert!(manifest_redundancy_healthy(&slots, &newer));
    }

    #[test]
    fn unlock_is_read_only_while_a_slot_cannot_be_read() {
        let id = Uuid::new_v4();
        let slots = [
            SlotReading::Unreadable,
            authentic(manifest_with(id, 5, &["a"]), &[]),
        ];
        let selected = select_manifest(&slots).unwrap();
        assert_eq!(selected.manifest.generation, 5);
        assert_eq!(selected.recovery, Some(RecoveryReason::UnreadableSlot));
        assert!(!manifest_redundancy_healthy(&slots, &selected.manifest));
        // Lost objects do not lower the reason: the unreadable slot still forbids writes.
        let slots = [
            SlotReading::Unreadable,
            authentic(manifest_with(id, 5, &["a", "b"]), &["b"]),
        ];
        assert_eq!(
            select_manifest(&slots).unwrap().recovery,
            Some(RecoveryReason::UnreadableSlot)
        );
    }

    #[test]
    fn unlock_keeps_a_newer_generation_whose_intact_objects_an_older_one_lacks() {
        let id = Uuid::new_v4();
        let older = manifest_with(id, 4, &["a"]);
        let newer = manifest_with(id, 5, &["a", "lost", "kept"]);
        let slots = [authentic(older, &[]), authentic(newer.clone(), &["lost"])];

        let selected = select_manifest(&slots).unwrap();
        assert!(selected.manifest == newer);
        assert_eq!(selected.recovery, Some(RecoveryReason::LostObjects));
        assert_eq!(selected.unavailable.len(), 1);
        assert!(selected.unavailable.contains(&newer.records[1].id));
    }

    #[test]
    fn unlock_falls_back_when_every_new_object_of_the_newer_generation_is_lost() {
        let id = Uuid::new_v4();
        let older = manifest_with(id, 4, &["a"]);
        let newer = manifest_with(id, 5, &["a", "lost"]);
        let slots = [authentic(older.clone(), &[]), authentic(newer, &["lost"])];

        let selected = select_manifest(&slots).unwrap();
        assert!(selected.manifest == older);
        assert_eq!(selected.recovery, None);
        assert!(selected.unavailable.is_empty());
    }

    #[test]
    fn unlock_opens_the_newest_authentic_generation_read_only_when_none_is_complete() {
        let id = Uuid::new_v4();
        let older = manifest_with(id, 4, &["a"]);
        let newer = manifest_with(id, 5, &["a", "b"]);
        let slots = [authentic(older, &["a"]), authentic(newer.clone(), &["b"])];

        let selected = select_manifest(&slots).unwrap();
        assert!(selected.manifest == newer);
        assert!(selected.recovery.is_some());
        assert_eq!(selected.unavailable.len(), 1);

        for slots in [
            [SlotReading::Absent, SlotReading::Damaged],
            [SlotReading::Damaged, SlotReading::Unreadable],
        ] {
            assert!(matches!(select_manifest(&slots), Err(VaultError::Corrupt)));
        }
    }

    #[test]
    fn damaged_or_absent_manifest_slots_are_not_treated_as_unreadable() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let reading = |slot| read_manifest_slot_reading(root, &[0_u8; 32], Uuid::nil(), slot);
        assert!(matches!(reading(0), SlotReading::Absent));
        fs::write(root.join("manifest-0.bin"), b"damaged").unwrap();
        assert!(matches!(reading(0), SlotReading::Damaged));
        fs::create_dir(root.join("manifest-1.bin")).unwrap();
        assert!(matches!(reading(1), SlotReading::Damaged));
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_newest_manifest_slot_is_not_overwritten_or_cleaned_up_after() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(profile, vec![], vec![source("first.pdf", b"first")], 2)
            .unwrap();
        let older_slots = [
            fs::read(root.join("manifest-0.bin")).unwrap(),
            fs::read(root.join("manifest-1.bin")).unwrap(),
        ];
        let second = store
            .import(profile, vec![], vec![source("second.pdf", b"second")], 3)
            .unwrap()
            .imported[0];
        let (newest_slot, second_object) = {
            let guard = store.unlocked.lock().unwrap();
            let manifest = &guard.as_ref().unwrap().manifest;
            let record = manifest.records.iter().find(|r| r.id == second).unwrap();
            (
                manifest_path(&root, manifest.generation),
                root.join("objects").join(&record.object_name),
            )
        };
        store.lock();
        // Leave the newest state in one slot only, as a failed redundant write
        // would, by restoring the other slot to the state before the import.
        let stale_slot = if newest_slot.ends_with("manifest-0.bin") {
            1
        } else {
            0
        };
        fs::write(
            root.join(format!("manifest-{stale_slot}.bin")),
            &older_slots[stale_slot],
        )
        .unwrap();
        let newest_before = fs::read(&newest_slot).unwrap();
        fs::set_permissions(&newest_slot, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(&newest_slot).is_ok() {
            // A privileged process ignores file modes, so the unreadable slot
            // cannot be simulated here.
            return;
        }

        store.unlock(PASSWORD).unwrap();
        assert!(store.snapshot().unwrap().recovery.is_some());
        store.lock();

        fs::set_permissions(&newest_slot, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(fs::read(&newest_slot).unwrap(), newest_before);
        assert!(second_object.exists());
        store.unlock(PASSWORD).unwrap();
        assert!(store
            .snapshot()
            .unwrap()
            .records
            .iter()
            .any(|record| record.id == second));
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_header_slot_is_not_rewrapped_under_the_old_passphrase() {
        use std::os::unix::fs::PermissionsExt as _;
        const REPLACEMENT: &str = "lantern-orbit-willow-cascade-572";

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let older_slots = HEADER_SLOTS.map(|name| fs::read(root.join(name)).unwrap());
        store.change_passphrase(PASSWORD, REPLACEMENT).unwrap();
        store.lock();
        // Leave the change in its first header write only, as a failed second
        // write would, by restoring the slot that received the later generation.
        let generation = |slot: usize| {
            let header: VaultHeader =
                serde_json::from_slice(&fs::read(root.join(HEADER_SLOTS[slot])).unwrap()).unwrap();
            header.generation
        };
        let first_write = usize::from(generation(1) < generation(0));
        fs::write(
            root.join(HEADER_SLOTS[1 - first_write]),
            &older_slots[1 - first_write],
        )
        .unwrap();
        let newest_slot = root.join(HEADER_SLOTS[first_write]);
        let newest_before = fs::read(&newest_slot).unwrap();
        fs::set_permissions(&newest_slot, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(&newest_slot).is_ok() {
            // A privileged process ignores file modes, so the unreadable slot
            // cannot be simulated here.
            return;
        }

        // The old passphrase still opens the one readable header, but repair must
        // not reinstate it over the slot that could not be read.
        store.unlock(PASSWORD).unwrap();
        assert!(store.snapshot().unwrap().recovery.is_some());
        store.lock();

        fs::set_permissions(&newest_slot, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(fs::read(&newest_slot).unwrap(), newest_before);
        store.unlock(REPLACEMENT).unwrap();
    }

    #[test]
    fn incomplete_vault_can_be_reset_and_recreated() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        fs::create_dir(&root).unwrap();
        let store = VaultStore::new(root.clone());

        assert_eq!(store.status().unwrap(), VaultStatus::Locked);
        assert!(matches!(store.unlock(PASSWORD), Err(VaultError::Corrupt)));
        store.reset().unwrap();
        assert_eq!(store.status().unwrap(), VaultStatus::Absent);
        store.create(PASSWORD, "Jamie", 1).unwrap();
        assert_eq!(store.status().unwrap(), VaultStatus::Unlocked);
    }

    #[test]
    fn nested_folder_cycles_and_excessive_depth_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let root = store.create_folder(profile, None, "Root", 2).unwrap();
        let child = store
            .create_folder(profile, Some(root), "Child", 3)
            .unwrap();
        assert!(matches!(
            store.update_folder(root, Some(child), "Root"),
            Err(VaultError::Invalid)
        ));

        // Folders nest at most 32 deep, on create and on move, and a vault
        // at that depth still opens.
        let mut chain = vec![store.create_folder(profile, None, "Level 1", 4).unwrap()];
        for level in 2..=32 {
            let parent = *chain.last().unwrap();
            chain.push(
                store
                    .create_folder(profile, Some(parent), &format!("Level {level}"), 4)
                    .unwrap(),
            );
        }
        assert!(matches!(
            store.create_folder(profile, Some(chain[31]), "Level 33", 5),
            Err(VaultError::Invalid)
        ));
        // `root` and `child` are two levels, so they fit under level 30, not 31.
        assert!(matches!(
            store.update_folder(root, Some(chain[30]), "Root"),
            Err(VaultError::Invalid)
        ));
        store.update_folder(root, Some(chain[29]), "Root").unwrap();
        store.lock();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.snapshot().unwrap().folders.len(), 34);
    }

    #[test]
    fn change_passphrase_only_rewraps_the_vault_key() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        assert!(matches!(
            store.change_passphrase(PASSWORD, "Jamie-Jamie-Jamie"),
            Err(VaultError::WeakPassphrase)
        ));
        store
            .change_passphrase(PASSWORD, "lantern-orbit-willow-cascade-572")
            .unwrap();
        store.lock();
        assert!(matches!(
            store.unlock(PASSWORD),
            Err(VaultError::WrongPassphrase)
        ));
        store.unlock("lantern-orbit-willow-cascade-572").unwrap();
    }

    #[test]
    fn corrupt_latest_manifest_falls_back_without_losing_imported_records() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let record = store
            .import(
                profile,
                vec![],
                vec![source("report.pdf", b"durable synthetic record")],
                2,
            )
            .unwrap()
            .imported[0];
        let latest_generation = {
            let guard = store.unlocked.lock().unwrap();
            guard.as_ref().unwrap().manifest.generation
        };
        store.lock();
        fs::write(
            manifest_path(&root, latest_generation),
            b"synthetic corruption",
        )
        .unwrap();

        let restarted = VaultStore::new(root);
        restarted.unlock(PASSWORD).unwrap();
        assert_eq!(restarted.snapshot().unwrap().records[0].id, record);
        let mut output = Vec::new();
        restarted.export(record, &mut output).unwrap();
        assert_eq!(output, b"durable synthetic record");
    }

    #[test]
    fn two_corrupt_manifest_slots_fail_closed_without_removing_ciphertext() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(
                profile,
                vec![],
                vec![source("report.pdf", b"preserve encrypted object")],
                2,
            )
            .unwrap();
        let object_path = {
            let guard = store.unlocked.lock().unwrap();
            root.join("objects")
                .join(&guard.as_ref().unwrap().manifest.records[0].object_name)
        };
        store.lock();
        fs::write(root.join("manifest-0.bin"), b"corrupt slot zero").unwrap();
        fs::write(root.join("manifest-1.bin"), b"corrupt slot one").unwrap();

        let restarted = VaultStore::new(root);
        assert!(matches!(
            restarted.unlock(PASSWORD),
            Err(VaultError::Corrupt)
        ));
        assert!(object_path.exists());
    }

    #[test]
    fn swapping_ciphertext_between_records_fails_authentication() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let records = store
            .import(
                profile,
                vec![],
                vec![
                    source("first.pdf", b"first synthetic record"),
                    source("second.pdf", b"second synthetic record"),
                ],
                2,
            )
            .unwrap()
            .imported;
        let paths = {
            let guard = store.unlocked.lock().unwrap();
            guard
                .as_ref()
                .unwrap()
                .manifest
                .records
                .iter()
                .map(|record| root.join("objects").join(&record.object_name))
                .collect::<Vec<_>>()
        };
        let first = fs::read(&paths[0]).unwrap();
        let second = fs::read(&paths[1]).unwrap();
        fs::write(&paths[0], second).unwrap();
        fs::write(&paths[1], first).unwrap();

        for record in records {
            assert!(matches!(
                store.export(record, io::sink()),
                Err(VaultError::Corrupt)
            ));
        }
    }

    #[test]
    fn copying_ciphertext_between_vaults_fails_authentication() {
        let temp = tempfile::tempdir().unwrap();
        let first_root = temp.path().join("first-vault");
        let second_root = temp.path().join("second-vault");
        let first_store = VaultStore::new(first_root.clone());
        let second_store = VaultStore::new(second_root.clone());
        first_store.create(PASSWORD, "Jamie", 1).unwrap();
        second_store
            .create("lantern-orbit-willow-cascade-572", "Morgan", 1)
            .unwrap();
        let first_profile = first_store.snapshot().unwrap().profiles[0].id;
        let second_profile = second_store.snapshot().unwrap().profiles[0].id;
        first_store
            .import(
                first_profile,
                vec![],
                vec![source("first.pdf", b"first vault record")],
                2,
            )
            .unwrap();
        let second_record = second_store
            .import(
                second_profile,
                vec![],
                vec![source("second.pdf", b"second vault record")],
                2,
            )
            .unwrap()
            .imported[0];
        let first_object = {
            let guard = first_store.unlocked.lock().unwrap();
            first_root
                .join("objects")
                .join(&guard.as_ref().unwrap().manifest.records[0].object_name)
        };
        let second_object = {
            let guard = second_store.unlocked.lock().unwrap();
            second_root
                .join("objects")
                .join(&guard.as_ref().unwrap().manifest.records[0].object_name)
        };
        fs::copy(first_object, second_object).unwrap();

        assert!(matches!(
            second_store.export(second_record, io::sink()),
            Err(VaultError::Corrupt)
        ));
    }

    #[test]
    fn atomic_export_preserves_an_existing_destination_on_corruption() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let destination = temp.path().join("export.pdf");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let record = store
            .import(
                profile,
                vec![],
                vec![source("report.pdf", b"authenticated synthetic record")],
                2,
            )
            .unwrap()
            .imported[0];

        let header_path = root.join("header-0.json");
        let header_before = fs::read(&header_path).unwrap();
        assert!(matches!(
            store.export_atomic(record, &header_path),
            Err(VaultError::Invalid)
        ));
        assert_eq!(fs::read(header_path).unwrap(), header_before);

        fs::write(&destination, b"existing destination").unwrap();
        store.export_atomic(record, &destination).unwrap();
        assert_eq!(
            fs::read(&destination).unwrap(),
            b"authenticated synthetic record"
        );

        let object_name = {
            let guard = store.unlocked.lock().unwrap();
            guard.as_ref().unwrap().manifest.records[0]
                .object_name
                .clone()
        };
        let object = root.join("objects").join(object_name);
        let mut bytes = fs::read(&object).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        fs::write(object, bytes).unwrap();
        fs::write(&destination, b"do not overwrite").unwrap();

        assert!(matches!(
            store.export_atomic(record, &destination),
            Err(VaultError::Corrupt)
        ));
        assert_eq!(fs::read(destination).unwrap(), b"do not overwrite");
    }

    #[test]
    fn unlock_finishes_deletion_interrupted_after_its_first_manifest_commit() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(
                profile,
                vec![],
                vec![source("delete-me.pdf", b"synthetic document bytes")],
                2,
            )
            .unwrap();

        let (master_key, mut interrupted, object_path) = {
            let guard = store.unlocked.lock().unwrap();
            let unlocked = guard.as_ref().unwrap();
            let mut interrupted = unlocked.manifest.clone();
            let object_path = root
                .join("objects")
                .join(&interrupted.records[0].object_name);
            interrupted.records.clear();
            (*unlocked.master_key, interrupted, object_path)
        };
        interrupted.generation += 1;
        write_manifest_at(&root, &master_key, &interrupted).unwrap();
        assert!(object_path.exists());
        store.lock();

        let restarted = VaultStore::new(root);
        restarted.unlock(PASSWORD).unwrap();
        assert!(restarted.snapshot().unwrap().records.is_empty());
        assert!(!object_path.exists());
    }

    #[test]
    fn deletion_abrupt_termination_matrix_finishes_cryptographic_erasure() {
        let temp = tempfile::tempdir().unwrap();
        let template = temp.path().join("template-vault");
        let template_store = VaultStore::new(template.clone());
        template_store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = template_store.snapshot().unwrap().profiles[0].id;
        template_store
            .import(
                profile,
                vec![],
                vec![source("delete-me.pdf", b"synthetic deletion record")],
                2,
            )
            .unwrap();
        template_store.lock();

        for boundary in [
            "manifest.after-first-write",
            "delete.after-object-unlink",
            "manifest.after-second-write",
        ] {
            let root = temp.path().join(boundary);
            copy_directory(&template, &root);
            run_termination_child(&root, "delete", boundary);

            let restarted = VaultStore::new(root.clone());
            restarted.unlock(PASSWORD).unwrap();
            assert!(restarted.snapshot().unwrap().records.is_empty());
            assert_eq!(fs::read_dir(root.join("objects")).unwrap().count(), 0);
        }
    }

    #[test]
    fn injected_no_space_deletion_failures_recover_without_half_visible_records() {
        let temp = tempfile::tempdir().unwrap();
        let template = temp.path().join("template-vault");
        let template_store = VaultStore::new(template.clone());
        template_store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = template_store.snapshot().unwrap().profiles[0].id;
        template_store
            .import(
                profile,
                vec![],
                vec![source("delete-me.pdf", b"synthetic deletion record")],
                2,
            )
            .unwrap();
        template_store.lock();

        for (boundary, deleted) in [
            ("manifest.before-first-write", false),
            ("manifest.after-first-write", true),
            ("delete.after-object-unlink", true),
        ] {
            let root = temp.path().join(boundary);
            copy_directory(&template, &root);
            run_failure_child(&root, "delete", boundary);

            let restarted = VaultStore::new(root.clone());
            restarted.unlock(PASSWORD).unwrap();
            assert_eq!(restarted.snapshot().unwrap().records.is_empty(), deleted);
            assert_eq!(
                fs::read_dir(root.join("objects")).unwrap().count(),
                usize::from(!deleted)
            );
        }
    }

    #[test]
    fn deleting_a_record_removes_its_key_from_both_manifest_slots() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let record = store
            .import(
                profile,
                vec![],
                vec![source("delete-me.pdf", b"synthetic document bytes")],
                2,
            )
            .unwrap()
            .imported[0];
        let object_name = {
            let guard = store.unlocked.lock().unwrap();
            guard.as_ref().unwrap().manifest.records[0]
                .object_name
                .clone()
        };

        store.delete_record(record).unwrap();
        assert!(store.snapshot().unwrap().records.is_empty());
        assert!(!root.join("objects").join(object_name).exists());

        let (master_key, vault_id, latest_generation) = {
            let guard = store.unlocked.lock().unwrap();
            let unlocked = guard.as_ref().unwrap();
            (
                *unlocked.master_key,
                unlocked.manifest.vault_id,
                unlocked.manifest.generation,
            )
        };
        fs::write(
            manifest_path(&root, latest_generation),
            b"synthetic corruption",
        )
        .unwrap();
        let fallback = read_latest_manifest(&root, &master_key, vault_id).unwrap();
        assert!(fallback.records.is_empty());
    }

    #[test]
    fn deleting_a_missing_record_does_not_change_the_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let before = {
            let guard = store.unlocked.lock().unwrap();
            guard.as_ref().unwrap().manifest.generation
        };

        assert!(matches!(
            store.delete_record(Uuid::new_v4()),
            Err(VaultError::NotFound)
        ));
        let after = {
            let guard = store.unlocked.lock().unwrap();
            guard.as_ref().unwrap().manifest.generation
        };
        assert_eq!(after, before);
    }

    #[test]
    fn excessive_import_batches_are_rejected_before_files_are_read() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let sources = (0..=MAX_IMPORT_FILES)
            .map(|index| source(&format!("record-{index}.pdf"), b"%PDF-synthetic"))
            .collect();
        assert!(matches!(
            store.import(profile, vec![], sources, 2),
            Err(VaultError::ImportBatchLimit)
        ));
        assert!(store.snapshot().unwrap().records.is_empty());
    }

    #[test]
    fn passphrase_policy_rejects_short_or_guessable_choices_without_composition_rules() {
        assert!(validate_new_passphrase("river azimuth cobalt sparrow 934", &[]).is_ok());
        assert!(matches!(
            validate_new_passphrase("short phrase!!", &[]),
            Err(VaultError::Invalid)
        ));
        assert!(matches!(
            validate_new_passphrase("fifteen chars\nmore", &[]),
            Err(VaultError::Invalid)
        ));
        assert!(matches!(
            validate_new_passphrase(&"a".repeat(MAX_PASSPHRASE_BYTES + 1), &[]),
            Err(VaultError::Invalid)
        ));
        assert!(matches!(
            validate_new_passphrase("passwordpassword", &[]),
            Err(VaultError::WeakPassphrase)
        ));
        assert!(matches!(
            validate_new_passphrase("Jamie-Jamie-Jamie", &["Jamie"]),
            Err(VaultError::WeakPassphrase)
        ));
    }

    #[test]
    fn a_sanitized_name_is_a_fixed_point_around_unicode_whitespace() {
        for raw in [
            "name\u{a0}.",
            "a\u{3000}. ",
            "\u{a0}scan.pdf\u{2003}..",
            "x\u{a0}. .\u{a0}",
        ] {
            let sanitized = sanitize_basename(raw);
            assert_eq!(sanitize_basename(&sanitized), sanitized, "{raw:?}");
            assert_eq!(sanitized.trim(), sanitized, "{raw:?}");
            assert!(valid_record_name(&sanitized), "{raw:?}");
        }
        assert_eq!(sanitize_basename("name\u{a0}."), "name");
    }

    #[cfg(unix)]
    #[test]
    fn unlock_cleanup_never_enters_a_linked_staging_or_objects_directory() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("data").join("vault-v1");
        let store = VaultStore::new(root.clone());
        store
            .create("plum orbit lantern meadow quartz", "Avery", 1)
            .unwrap();
        store.lock();

        let outside_staging = temp.path().join("outside-staging");
        fs::create_dir_all(outside_staging.join("folder")).unwrap();
        fs::write(outside_staging.join("folder/keep.txt"), b"keep").unwrap();
        let outside_objects = temp.path().join("outside-objects");
        fs::create_dir_all(&outside_objects).unwrap();
        fs::write(outside_objects.join("keep.txt"), b"keep").unwrap();
        fs::remove_dir_all(root.join("staging")).unwrap();
        symlink(&outside_staging, root.join("staging")).unwrap();
        fs::remove_dir_all(root.join("objects")).unwrap();
        symlink(&outside_objects, root.join("objects")).unwrap();

        store.unlock("plum orbit lantern meadow quartz").unwrap();
        assert!(outside_staging.join("folder/keep.txt").exists());
        assert!(outside_objects.join("keep.txt").exists());
    }

    #[test]
    fn the_rename_dialog_lists_exactly_the_reserved_device_names() {
        // The dialog's module lists each name as a quoted literal in one
        // frozen array, and its own tests check that each one is refused. This
        // reads the repository's frontend, so it runs only in a full checkout.
        const DECLARATION: &str =
            "export const RESERVED_DEVICE_NAMES: readonly string[] = Object.freeze([";
        let dialog = include_str!("../../src/native/reservedNames.ts");
        let list = dialog
            .split_once(DECLARATION)
            .and_then(|(_, rest)| rest.split_once("])"))
            .map(|(list, _)| list)
            .unwrap_or_else(|| panic!("reservedNames.ts must declare `{DECLARATION}` ... `]);`"));
        let parts: Vec<&str> = list.split('"').collect();
        // Between the quoted names there is only punctuation and space, so no
        // name is written some other way the check below would miss.
        for between in parts.iter().step_by(2) {
            assert!(
                between.chars().all(|c| c == ',' || c.is_whitespace()),
                "write each reserved name as a double-quoted literal, not {between:?}"
            );
        }
        let mut listed: Vec<&str> = parts.iter().copied().skip(1).step_by(2).collect();
        let mut expected = RESERVED_DEVICE_NAMES.to_vec();
        listed.sort_unstable();
        expected.sort_unstable();
        assert_eq!(listed, expected);
    }

    #[test]
    fn reserved_device_names_are_prefixed_even_with_a_padded_stem() {
        // Win32 ignores spaces after the stem, so "CON .txt" still opens the console.
        for name in [
            "CON .txt",
            "nul  .pdf",
            "CONIN$",
            "conout$.log",
            "COM\u{b9}.txt",
            "LPT\u{b3}",
            "COM0",
            "lpt0.pdf",
        ] {
            let sanitized = sanitize_basename(name);
            assert!(sanitized.starts_with('_'), "{name:?} became {sanitized:?}");
            assert!(valid_record_name(&sanitized));
        }
        assert_eq!(sanitize_basename("CONTRACT .pdf"), "CONTRACT .pdf");
        // Only U+0020 spaces before the dot are ignored.
        assert_eq!(sanitize_basename("CON\u{a0}.txt"), "CON\u{a0}.txt");
        assert_eq!(sanitize_basename("NUL\u{3000}.log"), "NUL\u{3000}.log");
        // Case is compared for ASCII letters only: a dotless \u{131} is not an I.
        assert_eq!(sanitize_basename("con\u{131}n$.pdf"), "con\u{131}n$.pdf");
    }

    #[test]
    fn unlock_restores_a_missing_objects_directory() {
        // Backup and sync tools commonly drop empty directories.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store.lock();
        fs::remove_dir(root.join("objects")).unwrap();

        store.unlock(PASSWORD).unwrap();
        let outcome = store
            .import(profile, Vec::new(), vec![source("FAKE.pdf", b"fake")], 2)
            .unwrap();
        assert_eq!(outcome.imported.len(), 1);
    }

    #[test]
    fn oversized_or_non_regular_metadata_files_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        store.lock();
        for slot in 0..=1 {
            fs::write(
                root.join(format!("header-{slot}.json")),
                vec![0_u8; MAX_HEADER_BYTES + 1],
            )
            .unwrap();
        }

        assert!(matches!(store.unlock(PASSWORD), Err(VaultError::Corrupt)));

        for slot in 0..=1 {
            let path = root.join(format!("header-{slot}.json"));
            fs::remove_file(&path).unwrap();
            fs::create_dir(path).unwrap();
        }
        assert!(matches!(store.unlock(PASSWORD), Err(VaultError::Corrupt)));
    }

    #[test]
    fn one_structurally_valid_but_damaged_header_slot_is_repaired_after_unlock() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        store.lock();
        let mut damaged: VaultHeader =
            serde_json::from_slice(&fs::read(root.join("header-0.json")).unwrap()).unwrap();
        let mut ciphertext = BASE64
            .decode(&damaged.wrapped_master_key.ciphertext)
            .unwrap();
        ciphertext[0] ^= 1;
        damaged.wrapped_master_key.ciphertext = BASE64.encode(ciphertext);
        atomic_json(&root.join("header-0.json"), &damaged).unwrap();

        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.snapshot().unwrap().recovery, None);
        for slot in 0..=1 {
            let header: VaultHeader = serde_json::from_slice(
                &fs::read(root.join(format!("header-{slot}.json"))).unwrap(),
            )
            .unwrap();
            assert!(valid_header(&header));
            assert_eq!(unwrap_master_key(&header, PASSWORD).unwrap().len(), 32);
        }
    }

    #[test]
    fn a_valid_newer_header_prevents_fallback_to_an_old_passphrase() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let current = read_latest_header(&root).unwrap();
        let master_key = unwrap_master_key(&current, PASSWORD).unwrap();
        let replacement = "lantern-orbit-willow-cascade-572";
        let (newer, _) = build_header_pair(
            current.vault_id,
            current.generation + 1,
            replacement,
            &master_key,
        )
        .unwrap();
        atomic_json(&header_path(&root, newer.generation), &newer).unwrap();
        store.lock();

        assert!(matches!(
            store.unlock(PASSWORD),
            Err(VaultError::WrongPassphrase)
        ));
        store.unlock(replacement).unwrap();
        assert_eq!(store.snapshot().unwrap().recovery, None);
    }

    #[test]
    fn repair_write_failures_still_unlock_in_recovery_mode() {
        let temp = tempfile::tempdir().unwrap();
        let template = temp.path().join("template-vault");
        let store = VaultStore::new(template.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        store.lock();

        let manifest_root = temp.path().join("manifest-repair");
        copy_directory(&template, &manifest_root);
        fs::write(manifest_root.join("manifest-0.bin"), b"damaged manifest").unwrap();
        run_failure_child(&manifest_root, "unlock-degraded", "manifest.repair");

        let header_root = temp.path().join("header-repair");
        copy_directory(&template, &header_root);
        fs::write(header_root.join("header-0.json"), b"damaged header").unwrap();
        run_failure_child(&header_root, "unlock-degraded", "header.repair");
    }

    #[test]
    fn imported_names_remove_spoofing_and_invalid_export_characters() {
        assert_eq!(sanitize_basename("/tmp/CON.pdf"), "_CON.pdf");
        assert_eq!(sanitize_basename("report\u{202e}fdp.exe"), "reportfdp.exe");
        assert_eq!(sanitize_basename("bad:name?.pdf. "), "bad_name_.pdf");
        assert_eq!(sanitize_basename("\u{200b}\u{feff}"), "Imported file");
        assert!(sanitize_basename(&"🩺".repeat(100)).len() <= 240);
    }

    #[test]
    fn a_name_cut_to_the_limit_keeps_its_extension() {
        for long in [
            format!("{}.pdf", "a".repeat(300)),
            format!("{}.pdf", "🩺".repeat(100)),
            format!("{} . .pdf", "a".repeat(236)),
            format!("con{}.pdf", " ".repeat(300)),
        ] {
            let sanitized = sanitize_basename(&long);
            assert!(sanitized.ends_with(".pdf"), "{sanitized:?}");
            assert!(sanitized.len() <= MAX_RECORD_NAME_LEN);
            assert!(valid_record_name(&sanitized));
            // `rename_record` relies on a sanitized name being a fixed point.
            assert_eq!(sanitize_basename(&sanitized), sanitized);
        }
        // An implausibly long "extension" is part of the name, not a type.
        let sanitized = sanitize_basename(&format!("report.{}", "b".repeat(300)));
        assert_eq!(sanitized.len(), MAX_RECORD_NAME_LEN);
        assert_eq!(sanitize_basename(&sanitized), sanitized);
    }

    #[test]
    fn reserved_name_prefix_keeps_a_maximum_length_name_within_the_limit() {
        let longest = format!("con.{}.pdf", "a".repeat(232));
        assert_eq!(longest.len(), MAX_RECORD_NAME_LEN);
        let sanitized = sanitize_basename(&longest);
        assert!(sanitized.starts_with("_con."));
        assert!(sanitized.len() <= MAX_RECORD_NAME_LEN);
        assert!(valid_record_name(&sanitized));

        let trailing_dot = sanitize_basename(&format!("nul.{}.x", "b".repeat(234)));
        assert!(!trailing_dot.ends_with('.'));
        assert!(valid_record_name(&trailing_dot));
    }

    #[test]
    fn vault_unlocks_after_importing_a_maximum_length_reserved_name() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root);
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let name = format!("con.{}.pdf", "a".repeat(232));
        store
            .import(profile, vec![], vec![source(&name, b"synthetic record")], 2)
            .unwrap();
        store.lock();

        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.snapshot().unwrap().records.len(), 1);
    }

    #[test]
    fn an_object_lost_during_the_session_is_reported_as_damage_not_bad_input() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile_id = store.snapshot().unwrap().profiles[0].id;
        let outcome = store
            .import(
                profile_id,
                Vec::new(),
                vec![source("kept.pdf", b"kept"), source("lost.pdf", b"lost")],
                2,
            )
            .unwrap();
        let lost = store.session().as_ref().unwrap().manifest.records[1]
            .object_name
            .clone();
        fs::remove_file(root.join("objects").join(lost)).unwrap();

        assert!(matches!(
            store.rename_record(outcome.imported[0], "renamed.pdf"),
            Err(VaultError::Corrupt)
        ));
        assert!(matches!(
            store.create_profile("Alex", 3),
            Err(VaultError::Corrupt)
        ));
        // Saving a copy of the lost record reports the same damage, while the
        // intact record can still be exported.
        assert!(matches!(
            store.export(outcome.imported[1], io::sink()),
            Err(VaultError::Corrupt)
        ));
        let mut kept = Vec::new();
        store.export(outcome.imported[0], &mut kept).unwrap();
        assert_eq!(kept, b"kept");
        assert_eq!(
            store.snapshot().unwrap().records[0].display_name,
            "kept.pdf"
        );
    }

    #[test]
    fn startup_removes_a_create_stage_abandoned_with_its_key_envelopes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let abandoned = temp
            .path()
            .join(format!("{CREATE_STAGE_PREFIX}{}", Uuid::new_v4()));
        fs::create_dir_all(abandoned.join("objects")).unwrap();
        fs::write(abandoned.join("header-0.json"), b"wrapped key").unwrap();
        let unrelated = temp.path().join(format!("{CREATE_STAGE_PREFIX}notes"));
        fs::create_dir(&unrelated).unwrap();
        let file = temp
            .path()
            .join(format!("{CREATE_STAGE_PREFIX}{}.txt", Uuid::new_v4()));
        fs::write(&file, b"not a stage").unwrap();

        let store = VaultStore::new(root);
        assert_eq!(store.status().unwrap(), VaultStatus::Absent);
        assert!(!abandoned.exists());
        assert!(unrelated.exists());
        assert!(file.exists());

        store.create(PASSWORD, "Jamie", 1).unwrap();
        assert_eq!(store.status().unwrap(), VaultStatus::Unlocked);
    }

    #[test]
    fn a_manifest_the_reader_would_reject_is_never_written() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let before = [
            fs::read(root.join("manifest-0.bin")).unwrap(),
            fs::read(root.join("manifest-1.bin")).unwrap(),
        ];

        let result = store.mutate_manifest(|manifest| {
            manifest.profiles[0].display_name = String::new();
            Ok(())
        });

        assert!(matches!(result, Err(VaultError::Invalid)));
        assert_eq!(fs::read(root.join("manifest-0.bin")).unwrap(), before[0]);
        assert_eq!(fs::read(root.join("manifest-1.bin")).unwrap(), before[1]);
        store.lock();
        store.unlock(PASSWORD).unwrap();
    }

    #[test]
    fn authenticated_manifest_cannot_escape_the_object_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(
                profile,
                vec![],
                vec![source("report.pdf", b"synthetic record")],
                2,
            )
            .unwrap();
        let (master_key, mut manifest) = {
            let guard = store.unlocked.lock().unwrap();
            let unlocked = guard.as_ref().unwrap();
            (*unlocked.master_key, unlocked.manifest.clone())
        };
        manifest.records[0].object_name = "../../outside.mcobj".to_owned();
        manifest.generation += 1;
        write_manifest_at(&root, &master_key, &manifest).unwrap();
        manifest.generation += 1;
        write_manifest_at(&root, &master_key, &manifest).unwrap();
        store.lock();

        assert!(matches!(store.unlock(PASSWORD), Err(VaultError::Corrupt)));
    }

    #[test]
    fn passphrase_change_requires_the_unlocked_master_key_to_match() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let vault_id = store
            .unlocked
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .manifest
            .vault_id;
        let forged_master = [0x5a_u8; 32];
        let forged_header = build_header(vault_id, 3, PASSWORD, &forged_master).unwrap();
        atomic_json(&root.join("header.json"), &forged_header).unwrap();

        assert!(matches!(
            store.change_passphrase(PASSWORD, "lantern-orbit-willow-cascade-572"),
            Err(VaultError::Corrupt)
        ));
    }

    #[test]
    fn random_wrapping_nonces_do_not_repeat_in_a_regression_sample() {
        let key = [0x11_u8; 32];
        let secret = [0x22_u8; 32];
        let mut nonces = HashSet::new();
        for index in 0_u64..512 {
            let wrapped = wrap_secret(&key, &secret, &index.to_be_bytes()).unwrap();
            assert!(nonces.insert(wrapped.nonce));
        }
    }

    #[test]
    #[ignore = "manual release-mode benchmark for each supported device class"]
    fn benchmark_argon2id_unlock_work_factor() {
        let config = KdfConfig {
            algorithm: "argon2id".to_owned(),
            version: 19,
            memory_kib: ARGON_MEMORY_KIB,
            iterations: ARGON_ITERATIONS,
            lanes: ARGON_LANES,
            salt: BASE64.encode([0x5a_u8; 16]),
        };
        let mut samples = Vec::with_capacity(5);
        for _ in 0..5 {
            let started = Instant::now();
            let output = Zeroizing::new(derive_passphrase_key(PASSWORD, &config).unwrap());
            samples.push(started.elapsed().as_millis());
            assert_ne!(output.as_ref(), &[0_u8; 32]);
        }
        samples.sort_unstable();
        println!(
            "mycarlos_argon2id memory_kib={} iterations={} lanes={} samples_ms={samples:?} median_ms={} max_ms={}",
            ARGON_MEMORY_KIB,
            ARGON_ITERATIONS,
            ARGON_LANES,
            samples[samples.len() / 2],
            samples.last().unwrap(),
        );
    }

    #[test]
    fn unsupported_header_and_manifest_versions_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let (master_key, mut manifest) = {
            let guard = store.unlocked.lock().unwrap();
            let unlocked = guard.as_ref().unwrap();
            (*unlocked.master_key, unlocked.manifest.clone())
        };

        let header: VaultHeader =
            serde_json::from_slice(&fs::read(root.join("header-0.json")).unwrap()).unwrap();
        for version in [0, HEADER_FORMAT + 1] {
            let mut unsupported = header.clone();
            unsupported.format_version = version;
            atomic_json(&root.join("header-0.json"), &unsupported).unwrap();
            atomic_json(&root.join("header-1.json"), &unsupported).unwrap();
            assert!(matches!(store.read_header(), Err(VaultError::Corrupt)));
        }

        for version in [0, VAULT_FORMAT + 1] {
            manifest.format_version = version;
            manifest.generation += 1;
            write_manifest_at(&root, &master_key, &manifest).unwrap();
            manifest.generation += 1;
            write_manifest_at(&root, &master_key, &manifest).unwrap();
            assert!(matches!(
                read_latest_manifest(&root, &master_key, manifest.vault_id),
                Err(VaultError::Corrupt)
            ));
        }
    }

    #[test]
    fn divergent_authenticated_manifests_at_the_same_generation_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let (master_key, mut manifest) = {
            let guard = store.unlocked.lock().unwrap();
            let unlocked = guard.as_ref().unwrap();
            (*unlocked.master_key, unlocked.manifest.clone())
        };

        manifest.generation = 100;
        manifest.profiles[0].display_name = "Jamie Alpha".to_owned();
        write_manifest_at(&root, &master_key, &manifest).unwrap();
        let alpha = fs::read(root.join("manifest-0.bin")).unwrap();

        manifest.profiles[0].display_name = "Jamie Beta".to_owned();
        write_manifest_at(&root, &master_key, &manifest).unwrap();
        let beta = fs::read(root.join("manifest-0.bin")).unwrap();
        atomic_bytes(&root.join("manifest-0.bin"), &alpha).unwrap();
        atomic_bytes(&root.join("manifest-1.bin"), &beta).unwrap();

        assert!(matches!(
            read_latest_manifest(&root, &master_key, manifest.vault_id),
            Err(VaultError::Corrupt)
        ));
    }

    #[test]
    fn generation_overflow_fails_without_mutating_manifest_slots() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let (master_key, mut current) = {
            let guard = store.unlocked.lock().unwrap();
            let unlocked = guard.as_ref().unwrap();
            (*unlocked.master_key, unlocked.manifest.clone())
        };
        let before = [
            fs::read(root.join("manifest-0.bin")).unwrap(),
            fs::read(root.join("manifest-1.bin")).unwrap(),
        ];

        current.generation = u64::MAX;
        let mut live = current.clone();
        let next = current.clone();
        assert!(matches!(
            commit_manifest_redundant(&root, &master_key, &mut live, next, || Ok(())),
            Err(VaultError::Storage)
        ));
        assert!(matches!(
            repair_manifest_redundancy(&root, &master_key, current),
            Err(VaultError::Storage)
        ));
        assert_eq!(fs::read(root.join("manifest-0.bin")).unwrap(), before[0]);
        assert_eq!(fs::read(root.join("manifest-1.bin")).unwrap(), before[1]);

        live.generation = u64::MAX - 1;
        let next = live.clone();
        assert!(matches!(
            commit_manifest_redundant(&root, &master_key, &mut live, next, || Ok(())),
            Err(VaultError::Storage)
        ));
        assert!(matches!(
            build_header_pair(Uuid::new_v4(), u64::MAX, PASSWORD, &master_key),
            Err(VaultError::Storage)
        ));
        assert_eq!(fs::read(root.join("manifest-0.bin")).unwrap(), before[0]);
        assert_eq!(fs::read(root.join("manifest-1.bin")).unwrap(), before[1]);
    }

    #[test]
    fn object_chunk_boundaries_round_trip_exactly() {
        let lengths = [
            0,
            1,
            CHUNK_SIZE - 1,
            CHUNK_SIZE,
            CHUNK_SIZE + 1,
            (2 * CHUNK_SIZE) - 1,
            2 * CHUNK_SIZE,
            (2 * CHUNK_SIZE) + 1,
        ];
        for length in lengths {
            let temp = tempfile::tempdir().unwrap();
            let object = temp.path().join("boundary.mcobj");
            let vault_id = Uuid::new_v4();
            let record_id = Uuid::new_v4();
            let plaintext = (0..length)
                .map(|index| (index % 251) as u8)
                .collect::<Vec<_>>();
            let encrypted = encrypt_object(
                Box::new(Cursor::new(plaintext.clone())),
                &object,
                ObjectContext {
                    vault_id,
                    record_id,
                    profile_id: Uuid::new_v4(),
                },
                &[0x51_u8; 32],
                &[0x52_u8; 32],
            )
            .unwrap();
            assert_eq!(encrypted.plaintext_size, length as u64);
            let mut recovered = Vec::new();
            verify_object(
                &object,
                &mut recovered,
                vault_id,
                record_id,
                &[0x51_u8; 32],
                length as u64,
            )
            .unwrap();
            assert_eq!(recovered, plaintext, "length={length}");
        }
    }

    #[test]
    fn object_aad_binds_counter_boundaries_and_object_identity() {
        let vault_id = Uuid::new_v4();
        let record_id = Uuid::new_v4();
        let counters = [0, 1, u64::MAX - 1, u64::MAX];
        let aad_values = counters
            .into_iter()
            .flat_map(|counter| {
                [
                    object_aad(vault_id, record_id, counter, false),
                    object_aad(vault_id, record_id, counter, true),
                ]
            })
            .collect::<HashSet<_>>();
        assert_eq!(aad_values.len(), counters.len() * 2);
        assert_ne!(
            object_aad(vault_id, record_id, 0, false),
            object_aad(Uuid::new_v4(), record_id, 0, false)
        );
        assert_ne!(
            object_aad(vault_id, record_id, 0, false),
            object_aad(vault_id, Uuid::new_v4(), 0, false)
        );
    }

    #[test]
    fn an_object_cut_short_inside_its_header_is_reported_as_damaged() {
        let temp = tempfile::tempdir().unwrap();
        let object = temp.path().join("truncated.mcobj");
        let mut header = OBJECT_MAGIC.to_vec();
        header.extend_from_slice(&(CHUNK_SIZE as u32).to_be_bytes());
        header.extend_from_slice(&[0_u8; 16]);
        for length in [0, 3, 7, 20] {
            fs::write(&object, &header[..length]).unwrap();
            assert!(
                matches!(
                    verify_object(
                        &object,
                        io::sink(),
                        Uuid::new_v4(),
                        Uuid::new_v4(),
                        &[0x61_u8; 32],
                        0,
                    ),
                    Err(VaultError::Corrupt)
                ),
                "header cut to {length} bytes"
            );
        }
    }

    #[test]
    fn preserved_corrupt_object_regressions_fail_closed() {
        let cases: Vec<CorruptObjectRegression> =
            serde_json::from_str(include_str!("../testdata/corrupt-object-regressions.json"))
                .unwrap();
        for case in cases {
            let temp = tempfile::tempdir().unwrap();
            let object = temp.path().join("regression.mcobj");
            fs::write(&object, case.bytes).unwrap();
            assert!(
                verify_object(
                    &object,
                    io::sink(),
                    Uuid::new_v4(),
                    Uuid::new_v4(),
                    &[0x61_u8; 32],
                    0,
                )
                .is_err(),
                "corrupt regression unexpectedly decoded: {}",
                case.name
            );
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn authenticated_semantic_manifest_mutations_fail_closed(mutation in 0_usize..23) {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path();
            let (vault_id, mut manifest) = valid_manifest_fixture(root);
            prop_assert!(validate_manifest(root, &manifest, vault_id).is_ok());

            match mutation {
                0 => manifest.format_version = VAULT_FORMAT + 1,
                1 => manifest.vault_id = Uuid::new_v4(),
                2 => manifest.generation = 0,
                3 => manifest.profiles.clear(),
                4 => manifest.profiles[0].id = Uuid::nil(),
                5 => manifest.profiles.push(manifest.profiles[0].clone()),
                6 => manifest.folders[0].profile_id = Uuid::new_v4(),
                7 => manifest.folders[0].parent_id = Some(manifest.folders[0].id),
                8 => manifest.folders[0].parent_id = Some(manifest.folders[1].id),
                9 => {
                    manifest.folders[1].profile_id = manifest.folders[0].profile_id;
                    manifest.folders[0].parent_id = Some(manifest.folders[1].id);
                    manifest.folders[1].parent_id = Some(manifest.folders[0].id);
                }
                10 => manifest.records[0].id = Uuid::nil(),
                11 => manifest.records[1].id = manifest.records[0].id,
                12 => manifest.records[0].profile_id = Uuid::new_v4(),
                13 => manifest.records[0].folder_ids = vec![Uuid::new_v4()],
                14 => {
                    let folder_id = manifest.records[0].folder_ids[0];
                    manifest.records[0].folder_ids.push(folder_id);
                }
                15 => manifest.records[0].object_name = "../../outside.mcobj".to_owned(),
                16 => manifest.records[1].object_name = manifest.records[0].object_name.clone(),
                17 => manifest.records[0].fingerprint = BASE64.encode([0_u8; 31]),
                18 => manifest.records[0].wrapped_object_key.nonce = BASE64.encode([0_u8; 23]),
                19 => {
                    manifest.records[0].wrapped_object_key.ciphertext = BASE64.encode([0_u8; 47]);
                }
                20 => manifest.records[0].source_label = "Verified".to_owned(),
                21 => manifest.records[0].media_type = "application/pdf".to_owned(),
                22 => manifest.records[0].display_name = "../record.pdf".to_owned(),
                _ => unreachable!(),
            }

            prop_assert!(matches!(
                validate_manifest(root, &manifest, vault_id),
                Err(VaultError::Corrupt)
            ));
        }

        #[test]
        fn recovery_selects_only_the_highest_valid_authenticated_generation(
            first_generation in 1_u64..10_000,
            second_generation in 1_u64..10_000,
            first_valid in any::<bool>(),
            second_valid in any::<bool>(),
        ) {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path();
            let (vault_id, base) = valid_manifest_fixture(root);
            let key = [0x71_u8; 32];

            let mut first = base.clone();
            first.generation = first_generation;
            write_manifest_at(root, &key, &first).unwrap();
            let mut first_bytes = fs::read(manifest_path(root, first_generation)).unwrap();
            if !first_valid {
                first_bytes[24] ^= 0x80;
            }

            let mut second = base;
            second.generation = second_generation;
            write_manifest_at(root, &key, &second).unwrap();
            let mut second_bytes = fs::read(manifest_path(root, second_generation)).unwrap();
            if !second_valid {
                second_bytes[24] ^= 0x80;
            }
            fs::write(root.join("manifest-0.bin"), first_bytes).unwrap();
            fs::write(root.join("manifest-1.bin"), second_bytes).unwrap();

            let selected = read_latest_manifest(root, &key, vault_id);
            if first_valid || second_valid {
                let expected = match (first_valid, second_valid) {
                    (true, true) => first_generation.max(second_generation),
                    (true, false) => first_generation,
                    (false, true) => second_generation,
                    (false, false) => unreachable!(),
                };
                prop_assert_eq!(selected.unwrap().generation, expected);
            } else {
                prop_assert!(matches!(selected, Err(VaultError::Corrupt)));
            }
        }

        #[test]
        fn arbitrary_header_bytes_fail_closed_without_panicking(
            data in prop::collection::vec(any::<u8>(), 0..(MAX_HEADER_BYTES + 1024)),
        ) {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("vault");
            fs::create_dir(&root).unwrap();
            fs::write(root.join("header.json"), data).unwrap();
            let store = VaultStore::new(root);

            prop_assert!(matches!(store.read_header(), Err(VaultError::Corrupt)));
        }

        #[test]
        fn arbitrary_manifest_envelopes_fail_closed_without_panicking(
            data in prop::collection::vec(any::<u8>(), 0..8192),
        ) {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("vault");
            fs::create_dir_all(root.join("objects")).unwrap();
            fs::write(root.join("manifest-0.bin"), &data).unwrap();
            fs::write(root.join("manifest-1.bin"), data).unwrap();

            prop_assert!(matches!(
                read_latest_manifest(&root, &[0x33_u8; 32], Uuid::new_v4()),
                Err(VaultError::Corrupt)
            ));
        }

        #[test]
        fn arbitrary_object_envelopes_fail_closed_without_panicking(
            data in prop::collection::vec(any::<u8>(), 0..8192),
            expected_size in any::<u32>(),
        ) {
            let temp = tempfile::tempdir().unwrap();
            let object = temp.path().join("object.mcobj");
            fs::write(&object, data).unwrap();

            prop_assert!(verify_object(
                &object,
                io::sink(),
                Uuid::new_v4(),
                Uuid::new_v4(),
                &[0x44_u8; 32],
                u64::from(expected_size),
            ).is_err());
        }
    }
}

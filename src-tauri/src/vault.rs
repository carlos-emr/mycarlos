use crate::history::{self, HistoryEntry, HistoryEvent};
use crate::idle::IdleDeadline;
use crate::portal_link::{self, LinkSummary, StoredLink};
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
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, PoisonError,
    },
    time::{Duration, Instant},
};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};
use zxcvbn::{zxcvbn, Score};

mod delivery;
#[cfg(all(test, feature = "portal-linking"))]
mod native_portal_flow;
mod original_pdf;

/// Manifest format 2 (#71) adds hidden documents and pads the manifest to a
/// size class; format 3 adds the history; format 4 adds profile identity details.
/// Formats 1–3 are still read; an
/// unlock that can write upgrades one at once, in a commit of its own, before
/// anything only the newer format can hold is written. An older build refuses
/// a newer manifest.
const VAULT_FORMAT: u32 = 7;
const MANIFEST_FORMAT_V1: u32 = 1;
/// The first format that can hold hidden documents.
const MANIFEST_FORMAT_HIDDEN: u32 = 2;
/// The first format that can hold a history.
const MANIFEST_FORMAT_HISTORY: u32 = 3;
/// The smallest size class a format 2 manifest's plaintext is padded to.
const MANIFEST_SIZE_CLASS_MIN: usize = 4 * 1024;
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
/// Where every document so far comes from: the patient added it, and nothing has checked it.
pub(crate) const MANUAL_IMPORT_LABEL: &str = "Manual import — unverified";
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
pub(crate) const MAX_RECORD_NAME_LEN: usize = 240;
const ARGON_MEMORY_KIB: u32 = 64 * 1024;
const ARGON_ITERATIONS: u32 = 3;
const ARGON_LANES: u32 = 4;
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

#[cfg(test)]
const TEST_TERMINATION_EXIT_CODE: i32 = 86;

/// Set while a test child unlocks, so that the boundary its environment
/// names is reached in the operation under test, not in the unlock's own
/// history commit (#71), which has its own matrix.
#[cfg(test)]
static ENV_BOUNDARIES_HELD: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
fn terminate_at_test_boundary(boundary: &str) {
    if !ENV_BOUNDARIES_HELD.load(Ordering::Acquire)
        && std::env::var("MYCARLOS_TEST_TERMINATE_AT").as_deref() == Ok(boundary)
    {
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
        || (!ENV_BOUNDARIES_HELD.load(Ordering::Acquire)
            && std::env::var("MYCARLOS_TEST_FAIL_AT").as_deref() == Ok(boundary))
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
    #[error("the portal link could not be completed")]
    Portal(portal_link::LinkError),
    #[cfg(feature = "portal-linking")]
    #[error("a document from the clinic could not be verified; no receipt was sent")]
    PickupRefused,
    #[cfg(feature = "portal-linking")]
    #[error("the clinic approval request is no longer pending")]
    ApprovalTerminal(
        crate::portal_approval::ApprovalState,
        Option<crate::portal_approval::ApprovalReason>,
    ),
    #[cfg(feature = "portal-linking")]
    #[error("the saved approval request was not found on the portal")]
    ApprovalRequestMissing,
    #[cfg(feature = "portal-linking")]
    #[error("clinic approval needs review before another request")]
    ApprovalNeedsClinic,
    #[error("another passphrase operation or speed test is running")]
    Busy,
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
    #[error("a file to import is not a PDF")]
    NotPdf,
    #[error("the document is locked with a password")]
    PdfLocked,
    #[error("the document is not locked with a password")]
    PdfNotLocked,
    #[error("an unlocked copy of the document is already stored")]
    PdfAlreadyUnlocked,
    #[error("the password did not open the locked document")]
    PdfWrongPassword,
    #[error("the locked document could not be opened")]
    PdfUnlockFailed,
    #[error("locked documents cannot be opened on this device")]
    PdfUnlockUnavailable,
    #[error("locked documents cannot be opened safely on this system")]
    PdfUnlockNoSandbox,
    #[error("the locked document is too large to open")]
    PdfTooLarge,
    #[error("the document could not be shown")]
    PdfViewFailed,
    #[error("documents cannot be shown on this device yet")]
    PdfViewUnavailable,
    #[error("documents cannot be shown safely on this system")]
    PdfViewNoSandbox,
    #[error("there is not enough space to complete the operation")]
    NoSpace,
    #[error("the storage operation could not be completed")]
    Storage,
    #[error("the operation was cancelled because the vault is locking")]
    Cancelled,
    #[error("the vault is in read-only recovery mode")]
    RecoveryMode,
    #[error("part of the vault could not be read")]
    Unreadable,
    #[error("the documents to remove are not the ones that were confirmed")]
    RemovalChanged,
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
    #[error("the file is not a JPEG photo within the size limits")]
    NotPhoto,
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
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_identity"
    )]
    pub full_name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_identity"
    )]
    pub birth_date: Option<String>,
}

// A present identity field must be a string, never null. Together with the
// format gate below this also rejects null identity fields declared as format 1–3.
fn present_identity<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileDetails {
    pub full_name: Option<String>,
    pub birth_date: Option<String>,
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
    /// Set while the document is hidden (#71). Format 2 only. A hidden
    /// document keeps its encrypted file; nothing is ever deleted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hidden: Option<Hidden>,
    /// A second independently encrypted copy of the incoming PDF bytes. Keep
    /// it even when no linked signer can authenticate the document yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    original_pdf: Option<StoredOriginalPdf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    delivery: Option<crate::portal_delivery::Custody>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredOriginalPdf {
    id: Uuid,
    object_name: String,
    plaintext_size: u64,
    sha256: String,
    wrapped_object_key: WrappedSecret,
}

#[derive(Clone, Copy)]
struct RecordObject<'a> {
    id: Uuid,
    object_name: &'a str,
    plaintext_size: u64,
    wrapped_key: &'a WrappedSecret,
    sha256: Option<&'a str>,
}

impl StoredRecord {
    fn objects(&self) -> impl Iterator<Item = RecordObject<'_>> {
        std::iter::once(RecordObject {
            id: self.id,
            object_name: &self.object_name,
            plaintext_size: self.plaintext_size,
            wrapped_key: &self.wrapped_object_key,
            sha256: None,
        })
        .chain(self.original_pdf.as_ref().map(|original| RecordObject {
            id: original.id,
            object_name: &original.object_name,
            plaintext_size: original.plaintext_size,
            wrapped_key: &original.wrapped_object_key,
            sha256: Some(&original.sha256),
        }))
    }
}

/// When, and why, a document was hidden.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hidden {
    pub at_ms: u64,
    pub reason: HiddenReason,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HiddenReason {
    /// The patient hid it.
    Patient,
    /// Its encrypted file was missing, and the patient hid it so that the
    /// vault could take changes again. The file is not required to exist;
    /// if it comes back, the document can be restored.
    Damaged,
}

/// Whether the vault needs a record's encrypted file to be there. Only a
/// document hidden as damaged does not.
fn object_required(record: &StoredRecord) -> bool {
    !matches!(
        record.hidden,
        Some(Hidden {
            reason: HiddenReason::Damaged,
            ..
        })
    )
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
    /// Format 5. Includes incomplete attempts, whose clinic is absent.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    portal_links: Vec<StoredLink>,
    /// The history (#71): where its segments are, and the end of its chain.
    /// Format 3 only.
    #[serde(default, skip_serializing_if = "HistoryState::is_empty")]
    history: HistoryState,
}

/// Where the history's entries are, and what pins its chain: how many there
/// are and the hash of the last. Its segments are objects beside the
/// documents', encrypted the same way under keys of their own.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryState {
    count: u64,
    head: String,
    segments: Vec<HistorySegment>,
}

impl HistoryState {
    fn is_empty(&self) -> bool {
        self.count == 0 && self.head.is_empty() && self.segments.is_empty()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistorySegment {
    id: Uuid,
    object_name: String,
    wrapped_key: WrappedSecret,
    /// The sequence number of its first entry.
    first_seq: u64,
    /// Its entries; none for a filler segment, which only pads the number of
    /// segments to a power of two.
    entry_count: u64,
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
    /// Set while the document is hidden (#71).
    pub hidden: Option<Hidden>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_pdf_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified_clinic_name: Option<String>,
    /// Exact service date from a clinic delivery; an empty string means the
    /// clinic did not record one. This is independent of the date added here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clinic_service_date: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSnapshot {
    pub profiles: Vec<PatientProfile>,
    pub folders: Vec<VaultFolder>,
    pub records: Vec<VaultRecord>,
    pub portal_linking_enabled: bool,
    pub portal_links: Vec<LinkSummary>,
    /// Why the session is read-only, if it is.
    pub recovery: Option<RecoveryReason>,
    /// When the vault's recovery key was set up, if it has one.
    pub recovery_key_set_at_ms: Option<u64>,
    /// Its short label, which its kit shows (not secret), if it has one.
    pub recovery_key_label: Option<String>,
    /// The reserved profile that files shared to myCarlos wait in (#61), shown
    /// as the "Shared with me" folder, never as a person. Listed in `profiles`
    /// once the first file has arrived.
    pub shared_profile_id: Uuid,
}

/// Why an unlocked session refuses changes. Each reason has its own way out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryReason {
    /// Some records' ciphertext is missing. Their intact neighbours can be
    /// exported, and `hide_unavailable_records` (#71: hiding them as damaged) makes the vault writable
    /// again once the user gives them up (or restores them from a backup).
    LostObjects,
    /// A manifest or header slot exists but could not be read, or a document's
    /// encrypted file could not be looked up. Either may hold a newer or
    /// intact state, so nothing on disk may be replaced or removed. Clears
    /// itself on a later unlock once everything can be read.
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
    /// Ephemeral diagnostics only: never a durable trust decision or a claim
    /// of verification without an authenticated clinic link.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unverified_signatures: Vec<ImportVerification>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportVerification {
    pub record_id: Uuid,
    pub reason: crate::signed_pdf_helper::Failure,
}

/// What a move out of "Shared with me" did (#61).
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOutcome {
    pub moved: Vec<Uuid>,
    /// Files the person already had, which stay in Shared with me.
    pub already_there: Vec<String>,
}

/// A recovery key shown to the patient and not yet confirmed, with the key
/// derived from the passphrase that authorized it, for the header write.
struct PendingRecoveryKey {
    key: Zeroizing<[u8; RECOVERY_KEY_BYTES]>,
    /// The id its envelope will have: chosen now, so that a kit saved before
    /// the check can name the key it holds.
    key_id: Uuid,
    kdf: KdfConfig,
    wrapping_key: SecretKey,
}

struct UnlockedVault {
    master_key: Zeroizing<[u8; 32]>,
    // When the header's recovery key was set up, if it has one.
    recovery_key_set_at_ms: Option<u64>,
    // Its envelope's id, from which its label comes.
    recovery_key_id: Option<Uuid>,
    // A recovery key shown to the patient and not yet confirmed.
    pending_recovery_key: Option<PendingRecoveryKey>,
    manifest: Manifest,
    recovery: Option<RecoveryReason>,
    // Records whose object was missing at unlock. Only populated in recovery mode.
    unavailable: HashSet<Uuid>,
    // Whether the history holds this session's start (#71): its unlock, or
    // the vault's creation.
    start_recorded: bool,
    // Keep the OS lock until the session (and any operation using it) ends.
    storage_lock: Arc<File>,
}

/// Releases admission even if the work returns an error or panics. No secrets
/// are protected by this flag; the session mutex remains responsible for them.
struct KdfWork<'a>(&'a AtomicBool);

impl Drop for KdfWork<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub struct VaultStore {
    root: PathBuf,
    unlocked: Mutex<Option<UnlockedVault>>,
    kdf_running: AtomicBool,
    /// Changes when a session opens or begins locking. Network work never
    /// holds the vault mutex and may not apply across this boundary.
    portal_session: AtomicU64,
    /// Shared admission for linking, approval requests and document checks.
    #[cfg(feature = "portal-linking")]
    portal_check_running: AtomicBool,
    cancel_io: Arc<AtomicBool>,
    idle: Arc<IdleDeadline>,
    /// How the last session of this run of the app ended, for the next
    /// unlock's history entry (#71). Kept in memory only: nothing is written
    /// when the vault locks, so a lock never waits on, or fails over, a write.
    /// Taken under the session lock, after it.
    last_session: Mutex<Option<String>>,
    /// The folder this run of the app last set a vault aside in, for the
    /// next vault created (#71's third part). In memory only.
    last_set_aside: Mutex<Option<String>>,
}

impl VaultStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            unlocked: Mutex::new(None),
            kdf_running: AtomicBool::new(false),
            portal_session: AtomicU64::new(0),
            #[cfg(feature = "portal-linking")]
            portal_check_running: AtomicBool::new(false),
            cancel_io: Arc::new(AtomicBool::new(false)),
            idle: Arc::new(IdleDeadline::new(Instant::now())),
            last_session: Mutex::new(None),
            last_set_aside: Mutex::new(None),
        }
    }

    fn forget_last_session(&self) {
        *self
            .last_session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    /// Notes how the session in `guard`, ending now, ended.
    fn note_session_end(&self, guard: &Option<UnlockedVault>, by: &str) {
        if let Some(unlocked) = guard {
            let mut last = self
                .last_session
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // A session whose start the history holds, and that wrote all it
            // did, ends with a note of its own. One that could not keeps the
            // note waiting from before it, so that the next recorded unlock
            // still says how that earlier session ended, and adds that a
            // session went unrecorded after it.
            let note = if unlocked.start_recorded && unlocked.recovery.is_none() {
                format!("lockedAt:{}:{by}", crate::now_ms())
            } else {
                match last.take() {
                    Some(kept) if kept.ends_with("notRecorded") => kept,
                    Some(kept) => format!("{kept};notRecorded"),
                    None => "notRecorded".to_owned(),
                }
            };
            *last = Some(note);
        }
    }

    /// The folder vaults are set aside in (#71), for the native dialog that
    /// confirms a reset to name. Never sent to the screen.
    pub fn set_aside_folder(&self) -> Option<PathBuf> {
        vault_home(&self.root)
            .ok()
            .map(|home| home.join(SET_ASIDE_DIR))
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
            self.portal_session.fetch_add(1, Ordering::AcqRel);
            *guard = None;
            self.idle.disarm();
            self.unlocked.clear_poison();
            guard
        })
    }

    // Reserve before taking the session lock. Never queue an unlock behind a
    // benchmark: it could otherwise reopen the vault after an explicit lock.
    fn start_kdf_work(&self) -> Result<KdfWork<'_>, VaultError> {
        self.kdf_running
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map(|_| KdfWork(&self.kdf_running))
            .map_err(|_| VaultError::Busy)
    }

    pub fn benchmark_kdf(&self) -> Result<KdfBenchmark, VaultError> {
        self.benchmark_kdf_with(benchmark_kdf)
    }

    /// `measure` is given a check that says whether the vault is still open.
    /// It asks before each derivation, so a lock during the test ends it there
    /// instead of holding off the next unlock (busy) for the derivations left.
    fn benchmark_kdf_with<T>(
        &self,
        measure: impl FnOnce(&dyn Fn() -> bool) -> Result<T, VaultError>,
    ) -> Result<T, VaultError> {
        let _work = self.start_kdf_work()?;
        if self.session().is_none() {
            return Err(VaultError::Locked);
        }
        // The session guard is gone: manual and idle locking can clear keys
        // immediately while the benchmark holds only synthetic data.
        measure(&|| self.session().is_some())
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

    /// First setup's checklist (#69): which rules a passphrase being typed
    /// for a new vault meets, judged as `create` will judge it. Only while
    /// there is no vault, open or not: it judges a typed passphrase against
    /// nothing stored, and refuses once there is something.
    pub fn new_passphrase_rules(
        &self,
        passphrase: &str,
        initial_profile: &str,
    ) -> Result<PassphraseRules, VaultError> {
        if self.session().is_some() || self.root.exists() {
            return Err(VaultError::AlreadyExists);
        }
        // A name is at most 120 characters (`validate_name`): bound the raw
        // input before any work on it.
        if initial_profile.len() > 120 * 4 {
            return Err(VaultError::Invalid);
        }
        judge_new_passphrase(passphrase, &[initial_profile], false)
    }

    pub fn create(
        &self,
        passphrase: &str,
        initial_profile: &str,
        now_ms: u64,
    ) -> Result<(), VaultError> {
        let _work = self.start_kdf_work()?;
        validate_person_name(initial_profile)?;
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
                    full_name: None,
                    birth_date: None,
                }],
                folders: Vec::new(),
                records: Vec::new(),
                history: HistoryState::default(),
                portal_links: Vec::new(),
            };
            // The history's first entry (#71), in the stage like the rest. A
            // vault made after this run set one aside names where it went.
            let mut created = HistoryEntry::new(HistoryEvent::Created, now_ms);
            if let Some(folder) = self
                .last_set_aside
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
            {
                created = created.with_place(&folder);
            }
            manifest.history =
                prepare_history(&stage, &master_key, &manifest, vec![created])?.state;
            write_valid_manifest_at(&stage, &master_key, &manifest)?;
            manifest.generation = manifest
                .generation
                .checked_add(1)
                .ok_or(VaultError::Storage)?;
            write_valid_manifest_at(&stage, &master_key, &manifest)?;
            sync_parent(&stage);
            fs::rename(&stage, &self.root)?;
            sync_parent(parent);
            *self
                .last_set_aside
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
            self.open_session(
                &mut guard,
                UnlockedVault {
                    storage_lock,
                    master_key,
                    recovery_key_set_at_ms: None,
                    recovery_key_id: None,
                    pending_recovery_key: None,
                    manifest,
                    recovery: None,
                    unavailable: HashSet::new(),
                    start_recorded: true,
                },
            );
            Ok(())
        })();
        if result.is_err() {
            let _ = remove_owned_dir_all(&stage, Removable::CreateStage);
        }
        result
    }

    pub fn unlock(&self, passphrase: &str) -> Result<(), VaultError> {
        let _work = self.start_kdf_work()?;
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
        let (header, master_key, wrapping_key, header_unreadable) =
            read_header_for_passphrase(&self.root, passphrase)?;
        self.open_with_header(
            &mut guard,
            storage_lock,
            header,
            master_key,
            wrapping_key,
            header_unreadable,
        )?;
        self.record_unlock(&mut guard, "passphrase");
        Ok(())
    }

    /// Records the unlock that just opened the session in `guard` (#71),
    /// with how the session before it ended, as far as this run of the app
    /// knows. It can never keep the vault shut: if it cannot be written, the
    /// session is read-only, and a read-only session records nothing.
    ///
    /// The note of how the session before ended is used up only once it is
    /// in the history; otherwise it waits for the next unlock that is.
    fn record_unlock(&self, guard: &mut Option<UnlockedVault>, how: &str) {
        self.record_unlock_with(guard, how, Vec::new());
    }

    /// As `record_unlock`, with entries for what the unlock itself changed.
    fn record_unlock_with(
        &self,
        guard: &mut Option<UnlockedVault>,
        how: &str,
        changed: Vec<HistoryEntry>,
    ) {
        let mut last = self
            .last_session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(unlocked) = guard.as_mut() else {
            return;
        };
        let mut entry = HistoryEntry::new(HistoryEvent::Unlocked, crate::now_ms());
        entry.how = Some(how.to_owned());
        entry.previous_session = Some(last.clone().unwrap_or_else(|| "notRecorded".to_owned()));
        let mut entries = vec![entry];
        entries.extend(changed);
        if record_in_session(&self.root, unlocked, entries) {
            unlocked.start_recorded = true;
            *last = None;
        }
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
        // From the reading that chose the header, not a later one.
        header_unreadable: bool,
    ) -> Result<(), VaultError> {
        let recovery_key_set_at_ms = header
            .recovery
            .as_ref()
            .map(|envelope| envelope.created_at_ms);
        let recovery_key_id = header.recovery.as_ref().map(|envelope| envelope.key_id);
        let slots = read_manifest_slots(&self.root, &master_key, header.vault_id)?;
        let SelectedManifest {
            manifest,
            unavailable,
            mut recovery,
        } = select_manifest(&slots).map_err(|error| not_damage_if(header_unreadable, error))?;
        if header_unreadable {
            // `select_manifest` only sees the manifest slots. A header slot that
            // cannot be read outranks lost objects for the same reason an
            // unreadable manifest slot does: removing the lost records would
            // make the session writable, and a passphrase change could then
            // rewrap the key over a newer generation held in that slot.
            //
            // It also stops an unlock that found nothing else wrong, before
            // anything is repaired or cleaned up: the passphrase used may be
            // one that the slot's header has replaced.
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
                    recovery_key_id,
                    pending_recovery_key: None,
                    manifest,
                    recovery,
                    unavailable,
                    start_recorded: false,
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
            // Both slots were read when the header was chosen, or the unlock
            // would have stopped above: the repair does not write over a
            // header that was not seen.
            match repair_header_redundancy(&self.root, &header, &wrapping_key, &master_key) {
                Ok(()) => {}
                Err(VaultError::NoSpace | VaultError::Storage) => {
                    recovery = Some(RecoveryReason::WriteFailed);
                }
                Err(error) => return Err(error),
            }
        } else {
            // Both slots are authentic and current, so a legacy envelope has been
            // superseded. Its removal is best effort where the slots are written;
            // retry here so a failure then does not leave a key wrapped under an
            // earlier passphrase on disk for good.
            let _ = remove_owned_file(self.root.join(LEGACY_HEADER), Removable::LegacyHeader);
        }
        if ensure_objects_dir(&self.root).is_err() {
            recovery = Some(RecoveryReason::WriteFailed);
        }
        remove_staging(&self.root);
        remove_abandoned_atomic_writes(&self.root);
        quarantine_orphan_objects(&self.root, &manifest);
        // An older manifest becomes the current format in a commit of its own.
        let mut manifest = manifest;
        if recovery.is_none() {
            match upgrade_manifest(&self.root, &master_key, &mut manifest) {
                Ok(true) => {}
                Ok(false) | Err(VaultError::NoSpace | VaultError::Storage) => {
                    recovery = Some(RecoveryReason::WriteFailed);
                }
                Err(error) => return Err(error),
            }
        }
        self.open_session(
            guard,
            UnlockedVault {
                storage_lock,
                master_key,
                recovery_key_set_at_ms,
                recovery_key_id,
                pending_recovery_key: None,
                manifest,
                recovery,
                unavailable,
                start_recorded: false,
            },
        );
        Ok(())
    }

    /// Every unlocked session has an idle deadline, started with it under the
    /// session lock.
    fn open_session(&self, guard: &mut Option<UnlockedVault>, vault: UnlockedVault) {
        self.portal_session.fetch_add(1, Ordering::AcqRel);
        *guard = Some(vault);
        self.idle.arm(Instant::now());
    }

    pub fn lock(&self) {
        self.lock_if(|| true, "app");
    }

    /// Locks the vault if it has been idle past its deadline at `now`. Returns
    /// whether it locked.
    pub fn lock_if_idle(&self, now: Instant) -> bool {
        self.idle.is_due(now) && self.lock_if(|| self.idle.is_due(now), "nativeDeadline")
    }

    /// Cancels any transfer, then clears the session if `due` still holds once
    /// the session lock is taken: an unlock may have started a new session
    /// while this waited for the lock. The cancel must come first, since a
    /// transfer holds the session lock until it stops; in the rare race where
    /// a new session starts, or activity arrives, while it waits, it can stop
    /// a transfer without locking.
    fn lock_if(&self, due: impl Fn() -> bool, by: &str) -> bool {
        self.portal_session.fetch_add(1, Ordering::AcqRel);
        run_at_test_boundary("portal.lock-after-ticket");
        self.cancel_io.store(true, Ordering::Release);
        let locked = {
            let mut guard = self.session();
            // Disarmed under the session lock, so an unlock cannot slip between
            // the two and be left unlocked with no deadline.
            let due = due();
            if due {
                self.note_session_end(&guard, by);
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
        Ok(Self::snapshot_of(
            &self.root,
            guard.as_ref().ok_or(VaultError::Locked)?,
        ))
    }

    fn snapshot_of(root: &Path, unlocked: &UnlockedVault) -> VaultSnapshot {
        VaultSnapshot {
            portal_linking_enabled: crate::portal_client::available(),
            portal_links: unlocked
                .manifest
                .portal_links
                .iter()
                .map(StoredLink::summary)
                .collect(),
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
                    // A document hidden as damaged is not looked for at unlock:
                    // its file may have come back since.
                    available: if object_required(record) {
                        !unlocked.unavailable.contains(&record.id)
                    } else {
                        object_is_present(root, record)
                    },
                    hidden: record.hidden,
                    verified_clinic_name: delivery::verified_clinic(
                        record,
                        &unlocked.manifest.portal_links,
                    ),
                    clinic_service_date: record
                        .delivery
                        .as_ref()
                        .map(|delivery| delivery.manifest.document.service_date.clone()),
                    original_pdf_available: record.original_pdf.as_ref().map(|original| {
                        object_presence_name(root, &original.object_name) == ObjectPresence::Present
                    }),
                })
                .collect(),
            recovery: unlocked.recovery,
            recovery_key_set_at_ms: unlocked.recovery_key_set_at_ms,
            recovery_key_label: unlocked.recovery_key_id.map(recovery_key_label),
            shared_profile_id: shared_profile_id(unlocked.manifest.vault_id),
        }
    }

    #[cfg(test)]
    pub fn create_profile(&self, display_name: &str, now_ms: u64) -> Result<Uuid, VaultError> {
        self.create_profile_with_details(
            display_name,
            ProfileDetails::default(),
            &utc_date_text(now_ms),
            now_ms,
        )
    }

    /// The feature check precedes key generation, vault writes and HTTP. The
    /// one-use code is transient: only the pending private seeds are persisted.
    pub fn portal_link_ticket(&self) -> u64 {
        self.portal_session.load(Ordering::Acquire)
    }

    pub fn link_portal(
        &self,
        portal: &str,
        code: &str,
        device_name: &str,
        profile_id: Option<Uuid>,
        now_ms: u64,
        session: u64,
    ) -> Result<LinkSummary, VaultError> {
        #[cfg(feature = "portal-linking")]
        let _running = self.start_portal_work()?;
        self.link_portal_using(
            portal,
            code,
            device_name,
            profile_id,
            (now_ms, session),
            |request, device, cancelled| crate::portal_client::link(request, device, cancelled),
        )
    }

    pub fn connect_portal(
        &self,
        portal: &str,
        code: &str,
        device_name: &str,
        profile_id: Option<Uuid>,
        now_ms: u64,
        session: u64,
    ) -> Result<(LinkSummary, Option<VaultError>), VaultError> {
        #[cfg(not(feature = "portal-linking"))]
        {
            let _ = (portal, code, device_name, profile_id, now_ms, session);
            Err(VaultError::Portal(portal_link::LinkError::Disabled))
        }
        #[cfg(feature = "portal-linking")]
        {
            self.connect_portal_using(
                session,
                || {
                    self.link_portal_using(
                        portal,
                        code,
                        device_name,
                        profile_id,
                        (now_ms, session),
                        |request, device, cancelled| {
                            crate::portal_client::link(request, device, cancelled)
                        },
                    )
                },
                &crate::portal_approval::ApprovalHttp::default(),
            )
        }
    }

    /// A read-only check of one linked device's approval status, for the
    /// clinic view's automatic refresh (#131): it reads the portal and saves
    /// the clinic's answer, and never sends or starts a request.
    pub(crate) fn refresh_device_approval(
        &self,
        link_id: Uuid,
        session: u64,
    ) -> Result<delivery::ApprovalCheck, VaultError> {
        #[cfg(not(feature = "portal-linking"))]
        {
            let _ = (link_id, session);
            Err(VaultError::Portal(portal_link::LinkError::Disabled))
        }
        #[cfg(feature = "portal-linking")]
        {
            self.poll_staff_approval(link_id, session)
        }
    }

    fn link_portal_using(
        &self,
        portal: &str,
        code: &str,
        device_name: &str,
        profile_id: Option<Uuid>,
        context: (u64, u64),
        post: impl FnOnce(
            portal_link::LinkRequest,
            &str,
            &dyn Fn() -> bool,
        ) -> Result<portal_link::LinkedClinic, portal_link::LinkError>,
    ) -> Result<LinkSummary, VaultError> {
        use portal_link::LinkError;
        let (now_ms, session) = context;
        if !portal_link::enabled() {
            return Err(VaultError::Portal(LinkError::Disabled));
        }
        if !crate::portal_client::available() {
            return Err(VaultError::Portal(LinkError::Unavailable));
        }
        let cancelled = || self.portal_session.load(Ordering::Acquire) != session;
        if cancelled() {
            return Err(VaultError::Portal(LinkError::Cancelled));
        }
        let normalized = portal_link::normalize_code(code).map_err(VaultError::Portal)?;
        let pending = StoredLink::pending(portal, device_name, profile_id, now_ms)
            .map_err(VaultError::Portal)?;
        let pending = self.mutate_recorded(|manifest, entries| {
            if cancelled() {
                return Err(VaultError::Portal(LinkError::Cancelled));
            }
            if manifest.portal_links.len() >= portal_link::MAX_LINKS {
                return Err(VaultError::Invalid);
            }
            if let Some(profile) = profile_id {
                require_profile(manifest, profile)?;
                if profile == shared_profile_id(manifest.vault_id) {
                    return Err(VaultError::Invalid);
                }
            }
            let mut entry = HistoryEntry::new(HistoryEvent::PortalLinkStarted, now_ms);
            entry.portal_link_id = Some(pending.id);
            entry.profile_id = profile_id;
            entries.push(entry);
            manifest.portal_links.push(pending.clone());
            run_at_test_boundary("portal.pending-before-commit");
            Ok(pending)
        })?;
        // A degraded redundant write may have committed pending state but made
        // the vault read-only. Do not consume a code unless success can be saved.
        {
            let guard = self.session();
            let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
            if unlocked.recovery.is_some() {
                return Err(VaultError::RecoveryMode);
            }
        }
        if cancelled() {
            return Err(VaultError::Portal(LinkError::Cancelled));
        }
        let request = pending
            .request(&normalized, now_ms / 1000)
            .map_err(VaultError::Portal)?;
        let pending_id = pending.id;
        let device_key_id = pending.keys.device_key_id();
        drop(pending);
        drop(normalized);
        let clinic = post(request, &device_key_id, &cancelled).map_err(VaultError::Portal)?;
        clinic
            .validate_initial(&device_key_id)
            .map_err(VaultError::Portal)?;
        // The HTTP exchange held no vault lock. Check the session again under
        // that lock before committing pins, with the same history transaction.
        self.mutate_recorded(|manifest, entries| {
            if cancelled() {
                return Err(VaultError::Portal(LinkError::Cancelled));
            }
            let link = manifest
                .portal_links
                .iter_mut()
                .find(|link| link.id == pending_id)
                .ok_or(VaultError::NotFound)?;
            if link.clinic.is_some() || link.keys.device_key_id() != device_key_id {
                return Err(VaultError::Invalid);
            }
            let mut entry = HistoryEntry::new(HistoryEvent::PortalLinked, crate::now_ms());
            entry.portal_link_id = Some(link.id);
            entry.profile_id = link.profile_id;
            entry.name = Some(clinic.clinic_name.clone());
            entry.clinic_key_ids = Some(
                clinic
                    .clinic_keys
                    .iter()
                    .map(|key| key.kid.clone())
                    .collect(),
            );
            entries.push(entry);
            link.clinic = Some(clinic);
            Ok(link.summary())
        })
    }

    pub fn create_profile_with_details(
        &self,
        display_name: &str,
        details: ProfileDetails,
        today: &str,
        now_ms: u64,
    ) -> Result<Uuid, VaultError> {
        validate_person_name(display_name)?;
        let (full_name, birth_date) = checked_profile_details(details, today, now_ms)?;
        self.mutate_recorded(|manifest, entries| {
            let id = Uuid::new_v4();
            let display_name = display_name.trim().to_owned();
            let mut entry = HistoryEntry::new(HistoryEvent::ProfileCreated, now_ms);
            entry.profile_id = Some(id);
            entry.name = Some(display_name.clone());
            entries.push(entry);
            manifest.profiles.push(PatientProfile {
                id,
                display_name,
                created_at_ms: now_ms,
                full_name,
                birth_date,
            });
            Ok(id)
        })
    }

    pub fn update_profile_details(
        &self,
        id: Uuid,
        details: ProfileDetails,
        today: &str,
        now_ms: u64,
    ) -> Result<(), VaultError> {
        let (full_name, birth_date) = checked_profile_details(details, today, now_ms)?;
        self.mutate_recorded(|manifest, entries| {
            if id == shared_profile_id(manifest.vault_id) {
                return Err(VaultError::Invalid);
            }
            let profile = manifest
                .profiles
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or(VaultError::NotFound)?;
            if profile.full_name != full_name || profile.birth_date != birth_date {
                profile.full_name = full_name;
                profile.birth_date = birth_date;
                let mut entry = HistoryEntry::new(HistoryEvent::ProfileDetailsChanged, now_ms);
                entry.profile_id = Some(id);
                entries.push(entry);
            }
            Ok(())
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
        self.mutate_recorded(|manifest, entries| {
            require_profile(manifest, profile_id)?;
            // Shared with me is one fixed folder: it holds no folders.
            if profile_id == shared_profile_id(manifest.vault_id) {
                return Err(VaultError::Invalid);
            }
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
            let mut entry = HistoryEntry::new(HistoryEvent::FolderCreated, now_ms);
            entry.profile_id = Some(profile_id);
            entry.folder_id = Some(id);
            entry.name = Some(name.trim().to_owned());
            entry.to = Some(folders_at_the_time(manifest, parent_id.as_slice()));
            entries.push(entry);
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
        self.mutate_recorded(|manifest, entries| {
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
            // One entry for a new name and one for a new place, each only when
            // it changed; both name the folder as it is afterwards.
            let name = name.trim();
            let at_ms = crate::now_ms();
            let folder_entry = |event| {
                let mut entry = HistoryEntry::new(event, at_ms);
                entry.profile_id = Some(current.profile_id);
                entry.folder_id = Some(folder_id);
                entry.name = Some(name.to_owned());
                entry
            };
            if current.name != name {
                let mut entry = folder_entry(HistoryEvent::FolderRenamed);
                entry.old_name = Some(current.name.clone());
                entries.push(entry);
            }
            if current.parent_id != parent_id {
                entries.push(folder_entry(HistoryEvent::FolderMoved).with_move(
                    folders_at_the_time(manifest, current.parent_id.as_slice()),
                    folders_at_the_time(manifest, parent_id.as_slice()),
                ));
            }
            let folder = manifest
                .folders
                .iter_mut()
                .find(|folder| folder.id == folder_id)
                .ok_or(VaultError::NotFound)?;
            folder.parent_id = parent_id;
            folder.name = name.to_owned();
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
        self.mutate_recorded(|manifest, entries| {
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
            if record.display_name != name {
                let mut entry = HistoryEntry::new(HistoryEvent::Renamed, crate::now_ms());
                entry.record_id = Some(record_id);
                entry.old_name = Some(std::mem::replace(&mut record.display_name, name.to_owned()));
                entry.name = Some(name.to_owned());
                entries.push(entry);
            }
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
        self.mutate_recorded(|manifest, entries| {
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
            // One entry for each document whose folders change.
            let at_ms = crate::now_ms();
            let to = folders_at_the_time(manifest, &assignments);
            for record in &manifest.records {
                if unique_record_ids.contains(&record.id) && record.folder_ids != assignments {
                    entries.push(record_entry(HistoryEvent::Moved, at_ms, record).with_move(
                        folders_at_the_time(manifest, &record.folder_ids),
                        to.clone(),
                    ));
                }
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
        self.import_from(profile_id, folder_ids, sources, now_ms, "picked")
    }

    /// `import`, saying in the history where the documents came from (#71):
    /// "picked" from the device's files, "camera" for a photo taken in
    /// myCarlos, or "shared" from another app.
    pub fn import_from(
        &self,
        profile_id: Uuid,
        folder_ids: Vec<Uuid>,
        sources: Vec<ImportSource>,
        now_ms: u64,
        how: &str,
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
        // The shared profile is made with the first file shared to myCarlos,
        // and holds no folders (#61).
        let shared = shared_profile_id(unlocked.manifest.vault_id);
        let adds_shared = profile_id == shared
            && !unlocked
                .manifest
                .profiles
                .iter()
                .any(|profile| profile.id == shared);
        if profile_id == shared && !folder_ids.is_empty() {
            return Err(VaultError::Invalid);
        }
        if !adds_shared {
            require_profile(&unlocked.manifest, profile_id)?;
            validate_folder_ids(&unlocked.manifest, profile_id, &folder_ids)?;
        }
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
        let mut unverified_signatures = Vec::new();

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
                    remove_owned_file(&object_path, Removable::UncommittedObject)?;
                    skipped_duplicates.push(sanitize_basename(&source.display_name));
                    continue;
                }
                let mut signature_probe = crate::signed_pdf_helper::ImportProbe::new();
                verify_object(
                    &object_path,
                    CancellableWriter::new(&mut signature_probe, Arc::clone(&self.cancel_io))
                        .with_progress(&self.idle),
                    unlocked.manifest.vault_id,
                    record_id,
                    &object_key,
                    encrypted.plaintext_size,
                )?;
                let wrapped_object_key =
                    wrap_secret(&keys.object_wrap, &object_key, record_id.as_bytes())?;
                let mut record = StoredRecord {
                    id: record_id,
                    profile_id,
                    folder_ids: folder_ids.clone(),
                    display_name: sanitize_basename(&source.display_name),
                    source_label: MANUAL_IMPORT_LABEL.to_owned(),
                    media_type: "application/octet-stream".to_owned(),
                    plaintext_size: encrypted.plaintext_size,
                    imported_at_ms: now_ms,
                    object_name,
                    fingerprint,
                    wrapped_object_key,
                    hidden: None,
                    original_pdf: None,
                    delivery: None,
                };
                // Preserve raw bytes before helper parsing/rendering, including
                // unsigned or too-large PDFs whose signatures cannot be ruled
                // out here. This costs a second PDF object, never a plaintext file.
                if signature_probe.is_pdf() {
                    record.original_pdf = Some(self.stage_original_pdf(
                        unlocked.manifest.vault_id,
                        &keys,
                        &record,
                        &object_path,
                        &stage,
                    )?);
                }
                if let Some(reason) =
                    signature_probe.finish(&|| self.cancel_io.load(Ordering::Acquire))
                {
                    unverified_signatures.push(ImportVerification { record_id, reason });
                }
                staged.push((object_path, record));
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
                    unverified_signatures: Vec::new(),
                });
            }
            terminate_at_test_boundary("import.after-staging");

            let objects = self.root.join("objects");
            for (_, record) in &staged {
                for object in record.objects() {
                    // atomicwrites uses MoveFileExW(MOVEFILE_WRITE_THROUGH)
                    // on Windows and syncs both directories on Unix. The
                    // receipt path must never outrun publication of an object.
                    publish_object(
                        &stage.join(object.object_name),
                        &objects.join(object.object_name),
                    )?;
                    let boundary = if object.id == record.id {
                        "import.after-display-publication"
                    } else {
                        "import.after-original-publication"
                    };
                    terminate_at_test_boundary(boundary);
                    fail_at_test_boundary(boundary)?;
                }
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
            if adds_shared {
                next.profiles.push(PatientProfile {
                    id: shared,
                    display_name: SHARED_PROFILE_NAME.to_owned(),
                    created_at_ms: now_ms,
                    full_name: None,
                    birth_date: None,
                });
            }
            next.records
                .extend(staged.iter().map(|(_, record)| record.clone()));
            let entries = staged
                .iter()
                .map(|(_, record)| {
                    let mut entry = record_entry(HistoryEvent::Imported, now_ms, record);
                    entry.how = Some(how.to_owned());
                    if record.profile_id == shared {
                        entry.profile_id = Some(shared);
                    }
                    entry
                })
                .collect();
            let redundant = commit_with_history(
                &self.root,
                &unlocked.master_key,
                &mut unlocked.manifest,
                next,
                entries,
            )?;
            unlocked.recovery = (!redundant).then_some(RecoveryReason::WriteFailed);
            Ok(ImportOutcome {
                imported: staged.iter().map(|(_, record)| record.id).collect(),
                skipped_duplicates,
                unverified_signatures,
            })
        })();
        if result.is_err() {
            let objects = self.root.join("objects");
            for (_, record) in &staged {
                for object in record.objects() {
                    let _ = remove_owned_file(
                        objects.join(object.object_name),
                        Removable::UncommittedObject,
                    );
                }
            }
            sync_parent(&objects);
        }
        let _ = remove_owned_dir_all(&stage, Removable::ImportStaging);
        result
    }

    /// The "Shared with me" profile's id for the open vault (#61).
    pub fn shared_profile(&self) -> Result<Uuid, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        Ok(shared_profile_id(unlocked.manifest.vault_id))
    }

    fn stage_original_pdf(
        &self,
        vault_id: Uuid,
        keys: &DerivedKeys,
        record: &StoredRecord,
        source: &Path,
        stage: &Path,
    ) -> Result<StoredOriginalPdf, VaultError> {
        let source_key = unwrap_secret(
            &keys.object_wrap,
            &record.wrapped_object_key,
            record.id.as_bytes(),
        )?;
        let id = Uuid::new_v4();
        let object_name = format!("{}.mcobj", Uuid::new_v4());
        let mut original_key = Zeroizing::new([0; 32]);
        OsRng.fill_bytes(original_key.as_mut());
        let mut writer = original_pdf::OriginalWriter::new(
            &stage.join(&object_name),
            ObjectContext {
                vault_id,
                record_id: id,
                profile_id: record.profile_id,
            },
            &original_key,
        )?;
        verify_object(
            source,
            CancellableWriter::new(&mut writer, Arc::clone(&self.cancel_io)),
            vault_id,
            record.id,
            &source_key,
            record.plaintext_size,
        )?;
        let (plaintext_size, sha256) = writer.finish()?;
        if plaintext_size != record.plaintext_size {
            return Err(VaultError::Corrupt);
        }
        Ok(StoredOriginalPdf {
            id,
            object_name,
            plaintext_size,
            sha256,
            wrapped_object_key: wrap_secret(&keys.object_wrap, &original_key, id.as_bytes())?,
        })
    }

    /// Moves files to another person, into the folders chosen. A file's
    /// duplicate fingerprint is keyed with its person, so each
    /// is read once to key it again; nothing is encrypted again, since a
    /// file's encryption is bound to the vault and the file, not the person.
    /// A file the person already has stays with its source and is named in
    /// the outcome.
    pub fn move_to_profile(
        &self,
        record_ids: Vec<Uuid>,
        profile_id: Uuid,
        folder_ids: Vec<Uuid>,
    ) -> Result<MoveOutcome, VaultError> {
        validate_import_count(record_ids.len())?;
        let record_ids = unique(record_ids);
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        let vault_id = unlocked.manifest.vault_id;
        let shared = shared_profile_id(vault_id);
        if profile_id == shared {
            return Err(VaultError::Invalid);
        }
        require_profile(&unlocked.manifest, profile_id)?;
        validate_folder_ids(&unlocked.manifest, profile_id, &folder_ids)?;
        let folder_ids = unique(folder_ids);
        let keys = derive_keys(vault_id, &unlocked.master_key)?;
        let existing: HashSet<&str> = unlocked
            .manifest
            .records
            .iter()
            .filter(|record| record.profile_id == profile_id)
            .map(|record| record.fingerprint.as_str())
            .collect();
        let mut batch = HashSet::new();
        let mut moved = HashMap::new();
        let mut already_there = Vec::new();
        for record_id in &record_ids {
            let record = unlocked
                .manifest
                .records
                .iter()
                .find(|record| record.id == *record_id)
                .ok_or(VaultError::NotFound)?;
            // Folder changes within the same person use assign_folders;
            // this operation changes the person and their keyed fingerprint.
            if record.profile_id == profile_id {
                return Err(VaultError::Invalid);
            }
            if unlocked.unavailable.contains(&record.id) {
                return Err(VaultError::Corrupt);
            }
            let object_key = unwrap_secret(
                &keys.object_wrap,
                &record.wrapped_object_key,
                record.id.as_bytes(),
            )?;
            let mut mac = <HmacSha256 as Mac>::new_from_slice(&keys.fingerprint)
                .map_err(|_| VaultError::Storage)?;
            mac.update(profile_id.as_bytes());
            verify_object(
                &self.root.join("objects").join(&record.object_name),
                CancellableWriter::new(MacWriter(&mut mac), Arc::clone(&self.cancel_io))
                    .with_progress(&self.idle),
                vault_id,
                record.id,
                &object_key,
                record.plaintext_size,
            )?;
            let fingerprint: [u8; 32] = mac.finalize().into_bytes().into();
            let fingerprint = BASE64.encode(fingerprint);
            if existing.contains(fingerprint.as_str()) || !batch.insert(fingerprint.clone()) {
                already_there.push(record.display_name.clone());
            } else {
                moved.insert(record.id, fingerprint);
            }
        }
        if self.cancel_io.load(Ordering::Acquire) {
            return Err(VaultError::Cancelled);
        }
        if moved.is_empty() {
            return Ok(MoveOutcome {
                moved: Vec::new(),
                already_there,
            });
        }
        let at_ms = crate::now_ms();
        let to = folders_at_the_time(&unlocked.manifest, &folder_ids);
        let entries = unlocked
            .manifest
            .records
            .iter()
            .filter(|record| moved.contains_key(&record.id))
            .map(|record| {
                let mut entry = record_entry(HistoryEvent::Moved, at_ms, record).with_move(
                    folders_at_the_time(&unlocked.manifest, &record.folder_ids),
                    to.clone(),
                );
                entry.profile_id = Some(profile_id);
                if record.profile_id == shared {
                    entry.how = Some("shared".to_owned());
                }
                entry
            })
            .collect();
        let mut next = unlocked.manifest.clone();
        for record in &mut next.records {
            if let Some(fingerprint) = moved.get(&record.id) {
                record.profile_id = profile_id;
                record.folder_ids = folder_ids.clone();
                record.fingerprint = fingerprint.clone();
            }
        }
        let redundant = commit_with_history(
            &self.root,
            &unlocked.master_key,
            &mut unlocked.manifest,
            next,
            entries,
        )?;
        unlocked.recovery = (!redundant).then_some(RecoveryReason::WriteFailed);
        Ok(MoveOutcome {
            moved: record_ids
                .into_iter()
                .filter(|id| moved.contains_key(id))
                .collect(),
            already_there,
        })
    }

    pub fn export<W: Write>(&self, record_id: Uuid, writer: W) -> Result<(), VaultError> {
        self.read_record(record_id, writer, true, true)
    }

    /// A rendered page is never a replacement for a signed original on save.
    /// Views may still use intact display bytes when an original is unavailable.
    pub(crate) fn read_for_view<W: Write>(
        &self,
        record_id: Uuid,
        writer: W,
    ) -> Result<(), VaultError> {
        self.read_record(record_id, writer, true, false)
    }

    /// Identity comes from the original raw PDF, never a rendered copy or
    /// readableText. Background suggestions do not postpone the idle deadline.
    pub(crate) fn read_for_suggestion<W: Write>(
        &self,
        record_id: Uuid,
        writer: W,
    ) -> Result<(), VaultError> {
        self.read_record(record_id, writer, false, true)
    }

    fn read_record<W: Write>(
        &self,
        record_id: Uuid,
        writer: W,
        report_progress: bool,
        prefer_original: bool,
    ) -> Result<(), VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        let record = unlocked
            .manifest
            .records
            .iter()
            .find(|record| record.id == record_id)
            .ok_or(VaultError::NotFound)?;
        let original = prefer_original
            .then_some(record.original_pdf.as_ref())
            .flatten();
        if original.is_none() && unlocked.unavailable.contains(&record.id) {
            return Err(VaultError::Corrupt);
        }
        let keys = derive_keys(unlocked.manifest.vault_id, &unlocked.master_key)?;
        let object = original
            .map(|original| RecordObject {
                id: original.id,
                object_name: &original.object_name,
                plaintext_size: original.plaintext_size,
                wrapped_key: &original.wrapped_object_key,
                sha256: Some(&original.sha256),
            })
            .unwrap_or(RecordObject {
                id: record.id,
                object_name: &record.object_name,
                plaintext_size: record.plaintext_size,
                wrapped_key: &record.wrapped_object_key,
                sha256: None,
            });
        let writer = CancellableWriter::new(writer, Arc::clone(&self.cancel_io));
        let writer = if report_progress {
            writer.with_progress(&self.idle)
        } else {
            writer
        };
        read_object_ref(
            &self.root.join("objects").join(object.object_name),
            unlocked.manifest.vault_id,
            &keys,
            object,
            writer,
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
                let _ = remove_owned_file(entry, Removable::ExportStage);
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
        if result.is_ok() {
            self.record_copy_saved(record_id, &destination.to_string_lossy());
        }
        result
    }

    /// Records a readable copy saved outside the vault, and where (#71). For
    /// a copy saved through a document provider, which `export_atomic` does
    /// not see.
    pub fn record_copy_saved(&self, record_id: Uuid, place: &str) {
        let mut guard = self.session();
        let Some(unlocked) = guard.as_mut() else {
            return;
        };
        let Some(record) = unlocked
            .manifest
            .records
            .iter()
            .find(|record| record.id == record_id)
        else {
            return;
        };
        let entry =
            record_entry(HistoryEvent::CopySaved, crate::now_ms(), record).with_place(place);
        record_in_session(&self.root, unlocked, vec![entry]);
    }

    /// Records a backup saved, and where (#71). For a backup saved through a
    /// document provider, which `backup_atomic` does not see.
    pub fn record_backup_saved(&self, place: &str) {
        let mut guard = self.session();
        if let Some(unlocked) = guard.as_mut() {
            let entry =
                HistoryEntry::new(HistoryEvent::BackupSaved, crate::now_ms()).with_place(place);
            record_in_session(&self.root, unlocked, vec![entry]);
        }
    }

    /// Hides a document (#71). It leaves every view but the Hidden list, and
    /// keeps its encrypted file: nothing is ever deleted. Hiding a hidden
    /// document changes nothing.
    pub fn hide_record(&self, record_id: Uuid, now_ms: u64) -> Result<(), VaultError> {
        self.set_hidden(
            record_id,
            Some(Hidden {
                at_ms: now_ms,
                reason: HiddenReason::Patient,
            }),
        )
    }

    /// Puts a hidden document back where it was. One hidden as damaged comes
    /// back only once its file is there again, or the vault would lose the
    /// changes it took since.
    pub fn unhide_record(&self, record_id: Uuid) -> Result<(), VaultError> {
        self.set_hidden(record_id, None)
    }

    fn set_hidden(&self, record_id: Uuid, hidden: Option<Hidden>) -> Result<(), VaultError> {
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        let record = unlocked
            .manifest
            .records
            .iter()
            .find(|record| record.id == record_id)
            .ok_or(VaultError::NotFound)?;
        if record.hidden.is_some() == hidden.is_some() {
            return Ok(());
        }
        if hidden.is_none() && !object_required(record) && !object_is_present(&self.root, record) {
            return Err(VaultError::Invalid);
        }
        let entry = match hidden.as_ref() {
            Some(hidden) => {
                let mut entry = record_entry(HistoryEvent::Hidden, hidden.at_ms, record);
                entry.how = Some("patient".to_owned());
                entry
            }
            None => record_entry(HistoryEvent::Restored, crate::now_ms(), record),
        };
        let mut next = unlocked.manifest.clone();
        for record in &mut next.records {
            if record.id == record_id {
                record.hidden = hidden;
            }
        }
        let redundant = commit_with_history(
            &self.root,
            &unlocked.master_key,
            &mut unlocked.manifest,
            next,
            vec![entry],
        )?;
        unlocked.recovery = (!redundant).then_some(RecoveryReason::WriteFailed);
        Ok(())
    }

    /// Hides, as damaged, the records shown as damaged whose ciphertext is
    /// still missing, and returns their ids (#71: before, they were dropped).
    /// The vault no longer needs their files, so it is complete again and
    /// leaves recovery mode. Files that have come back since unlock, from a
    /// backup restore, keep their documents in view.
    ///
    /// Only for the lost-objects reason: with an unreadable slot the commit
    /// could replace a newer state, and after a write failure it would fail.
    ///
    /// `confirmed` is the set of documents the patient was shown as damaged
    /// when they agreed. If the session's set differs, nothing is removed.
    pub fn hide_unavailable_records(
        &self,
        confirmed: &[Uuid],
        now_ms: u64,
    ) -> Result<Vec<Uuid>, VaultError> {
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        match unlocked.recovery {
            Some(RecoveryReason::LostObjects) => {}
            Some(_) => return Err(VaultError::RecoveryMode),
            None => return Err(VaultError::Invalid),
        }
        // A file that cannot be looked up by now may be intact. Nothing is
        // removed, and the session says why instead of offering removal again.
        let unknown: Vec<Uuid> = unlocked
            .manifest
            .records
            .iter()
            .filter(|record| {
                object_required(record)
                    && object_presence(&self.root, record) == ObjectPresence::Unknown
            })
            .map(|record| record.id)
            .collect();
        if !unknown.is_empty() {
            unlocked.unavailable.extend(unknown);
            unlocked.recovery = Some(RecoveryReason::UnreadableSlot);
            return Err(VaultError::RecoveryMode);
        }
        // Only documents the patient was shown as damaged may go. One that has
        // gone missing since is added to what the session shows, and nothing
        // is removed: the count the patient agreed to did not include it.
        let newly_missing: Vec<Uuid> = unlocked
            .manifest
            .records
            .iter()
            .filter(|record| {
                object_required(record)
                    && !unlocked.unavailable.contains(&record.id)
                    && object_presence(&self.root, record) == ObjectPresence::Missing
            })
            .map(|record| record.id)
            .collect();
        if !newly_missing.is_empty() {
            unlocked.unavailable.extend(newly_missing);
            return Err(VaultError::RemovalChanged);
        }
        // The screen may not have caught up with an earlier refusal.
        let confirmed: HashSet<Uuid> = confirmed.iter().copied().collect();
        if confirmed != unlocked.unavailable {
            return Err(VaultError::RemovalChanged);
        }
        // Hidden documents are format 2 only, and their entries format 3: a
        // vault opened in this recovery mode is upgraded first, in a commit
        // of its own (#71). The history's segments need `objects/`, which a
        // vault that lost every document may have lost too.
        if ensure_objects_dir(&self.root).is_err()
            || !upgrade_manifest(&self.root, &unlocked.master_key, &mut unlocked.manifest)?
        {
            unlocked.recovery = Some(RecoveryReason::WriteFailed);
            return Err(VaultError::RecoveryMode);
        }
        let mut next = unlocked.manifest.clone();
        let mut removed = Vec::new();
        let mut entries = Vec::new();
        // Of those, only a document whose object is really gone is hidden.
        // One whose file came back stays in view.
        let shown = &unlocked.unavailable;
        for record in &mut next.records {
            if shown.contains(&record.id)
                && object_presence(&self.root, record) == ObjectPresence::Missing
            {
                record.hidden = Some(Hidden {
                    at_ms: now_ms,
                    reason: HiddenReason::Damaged,
                });
                removed.push(record.id);
                let mut entry = record_entry(HistoryEvent::Hidden, now_ms, record);
                entry.how = Some("damaged".to_owned());
                entries.push(entry);
            }
        }
        let redundant = commit_with_history(
            &self.root,
            &unlocked.master_key,
            &mut unlocked.manifest,
            next,
            entries,
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
        let _work = self.start_kdf_work()?;
        if current.len() > MAX_PASSPHRASE_BYTES {
            return Err(VaultError::Invalid);
        }
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        let profile_names = people(&unlocked.manifest)
            .map(|profile| profile.display_name.as_str())
            .collect::<Vec<_>>();
        validate_new_passphrase(replacement, &profile_names)?;
        // Select the header as unlock does: the newest one that `current`
        // authenticates. Taking the highest generation on structure alone would
        // let a damaged or planted slot turn the right passphrase into a refusal.
        let (header, verified, _, header_unreadable) =
            read_header_for_passphrase(&self.root, current)?;
        // The session is writable, so every slot could be read when it was
        // opened. One that cannot be read now is not written over.
        if header_unreadable {
            return Err(VaultError::Unreadable);
        }
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
        let mut entry = HistoryEntry::new(HistoryEvent::PassphraseChanged, crate::now_ms());
        entry.how = Some("passphrase".to_owned());
        record_in_session(&self.root, unlocked, vec![entry]);
        Ok(())
    }

    /// Makes a new recovery key and returns it, once, for the patient to
    /// write down. The current passphrase authorizes it, as it does a
    /// passphrase change: a recovery key opens the vault for good. Nothing is
    /// stored until `confirm_recovery_key` checks that the patient has the
    /// key; until then the vault keeps any key it already has.
    pub fn begin_recovery_key(&self, passphrase: &str) -> Result<Zeroizing<String>, VaultError> {
        let _work = self.start_kdf_work()?;
        if passphrase.len() > MAX_PASSPHRASE_BYTES {
            return Err(VaultError::Invalid);
        }
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        let (header, verified, wrapping_key, header_unreadable) =
            read_header_for_passphrase(&self.root, passphrase)?;
        if header_unreadable {
            return Err(VaultError::Unreadable);
        }
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
            key_id: Uuid::new_v4(),
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
            &recovery_key_label(pending.key_id),
            now_ms,
        ))
    }

    /// The short label of the key being set up, which its kits show. Not
    /// secret: it tells kits apart, and says nothing about the key.
    pub fn pending_recovery_key_label(&self) -> Result<String, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        let pending = unlocked
            .pending_recovery_key
            .as_ref()
            .ok_or(VaultError::Invalid)?;
        Ok(recovery_key_label(pending.key_id))
    }

    /// The name suggested for the kit's file: the date, and the short label
    /// of the key it holds. A kit for a new key then does not take the place
    /// of the kit for the key the vault still has, should the new one never
    /// be set up.
    pub fn recovery_kit_name(&self, now_ms: u64) -> Result<String, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        let pending = unlocked
            .pending_recovery_key
            .as_ref()
            .ok_or(VaultError::Invalid)?;
        let (year, month, day) = utc_date(now_ms);
        Ok(format!(
            "myCarlos recovery kit {year:04}-{month:02}-{day:02} {}.txt",
            recovery_key_label(pending.key_id)
        ))
    }

    /// The name suggested for a backup's file: the date it is saved, as the
    /// patient's own calendar gives it (`YYYY-MM-DD`, already checked; the
    /// caller falls back to the UTC date), and the label of the vault's
    /// recovery key, if it has one. Backups saved on different days, or
    /// under different keys, then do not take each other's place.
    pub fn backup_file_name(&self, date: &str) -> Result<String, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        Ok(match unlocked.recovery_key_id {
            Some(key_id) => format!(
                "myCarlos backup {date} {}.mycarlosbackup",
                recovery_key_label(key_id)
            ),
            None => format!("myCarlos backup {date}.mycarlosbackup"),
        })
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

    /// Checks the typed groups against the key being set up, as
    /// `confirm_recovery_key_replacing` will, and says whether confirming would replace
    /// a recovery key the vault already has. Nothing changes. For the
    /// confirmation asked of the patient before a key is replaced, which
    /// should not be asked over a mistyped answer.
    pub fn check_recovery_key(&self, groups: &[(usize, &str)]) -> Result<bool, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        matching_pending_key(unlocked, groups)?;
        Ok(unlocked.recovery_key_set_at_ms.is_some())
    }

    /// Checks groups of the pending recovery key as the patient typed them
    /// back (group index and text; all seven, each once), then stores the
    /// key: a new pair of header generations carries its envelope, replacing
    /// any earlier recovery key. Returns the vault as it then is. The app
    /// confirms through `confirm_recovery_key_replacing`.
    #[cfg(test)]
    pub fn confirm_recovery_key(
        &self,
        groups: &[(usize, &str)],
        now_ms: u64,
    ) -> Result<VaultSnapshot, VaultError> {
        self.store_pending_key(groups, now_ms, None)
    }

    /// As `confirm_recovery_key`, once the patient was asked whether the key
    /// replaces the vault's own (or not asked, as it did not): refused as
    /// `Invalid`, with nothing written, if that has changed since. Checked
    /// under the same session guard as the key is stored.
    pub fn confirm_recovery_key_replacing(
        &self,
        groups: &[(usize, &str)],
        now_ms: u64,
        replaces: bool,
    ) -> Result<VaultSnapshot, VaultError> {
        self.store_pending_key(groups, now_ms, Some(replaces))
    }

    fn store_pending_key(
        &self,
        groups: &[(usize, &str)],
        now_ms: u64,
        replaces: Option<bool>,
    ) -> Result<VaultSnapshot, VaultError> {
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        let PendingRecoveryKey {
            key: pending,
            key_id,
            kdf,
            wrapping_key,
        } = matching_pending_key(unlocked, groups)?;
        if replaces.is_some_and(|replaces| replaces != unlocked.recovery_key_set_at_ms.is_some()) {
            return Err(VaultError::Invalid);
        }

        let vault_id = unlocked.manifest.vault_id;
        let current = current_header(&self.root, vault_id, &unlocked.master_key)?;
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
        let stored_key_id = *key_id;
        let envelope = new_recovery_envelope(
            pending,
            stored_key_id,
            vault_id,
            &unlocked.master_key,
            now_ms,
        )?;
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
        unlocked.recovery_key_id = Some(stored_key_id);
        if written == HeaderPairWrite::FirstOnly {
            unlocked.recovery = Some(RecoveryReason::WriteFailed);
        }
        record_in_session(
            &self.root,
            unlocked,
            vec![HistoryEntry::new(HistoryEvent::RecoveryKeySet, now_ms)],
        );
        // Taken under the same session guard: a lock that came between the
        // key being stored and a snapshot taken apart would report a key
        // that was stored as a failure.
        Ok(Self::snapshot_of(&self.root, unlocked))
    }

    /// Opens a locked vault with its recovery key and replaces the forgotten
    /// passphrase with `new_passphrase`. Returns whether the passphrase was
    /// replaced: a vault that can only open read-only (see `RecoveryReason`)
    /// is opened read-only with its passphrase unchanged, since nothing on
    /// disk may be rewritten, so that its documents can still be saved.
    pub fn recover(&self, recovery_key: &str, new_passphrase: &str) -> Result<bool, VaultError> {
        let _work = self.start_kdf_work()?;
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
        let (header, master_key, header_unreadable) =
            read_header_for_recovery_key(&self.root, &key)?;
        let slots = read_manifest_slots(&self.root, &master_key, header.vault_id)?;
        let selected =
            select_manifest(&slots).map_err(|error| not_damage_if(header_unreadable, error))?;
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
                    recovery_key_id: header.recovery.as_ref().map(|envelope| envelope.key_id),
                    pending_recovery_key: None,
                    manifest: selected.manifest,
                    recovery,
                    unavailable: selected.unavailable,
                    start_recorded: false,
                },
            );
            return Ok(false);
        }
        let profile_names = people(&selected.manifest)
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
                        recovery_key_id: header.recovery.as_ref().map(|envelope| envelope.key_id),
                        pending_recovery_key: None,
                        manifest: selected.manifest,
                        recovery: Some(RecoveryReason::WriteFailed),
                        unavailable: selected.unavailable,
                        start_recorded: false,
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
        // Both header slots were read before they were written.
        self.open_with_header(
            &mut guard,
            storage_lock,
            first,
            master_key,
            wrapping_key,
            false,
        )?;
        // Opened with the recovery key, which replaced the passphrase: both
        // in one commit, the unlock first, as it begins the session.
        let mut changed = HistoryEntry::new(HistoryEvent::PassphraseChanged, crate::now_ms());
        changed.how = Some("recoveryKey".to_owned());
        self.record_unlock_with(&mut guard, "recoveryKey", vec![changed]);
        Ok(true)
    }

    /// Sets the vault aside (#71's third part): moves it, whole and still
    /// encrypted, into `set-aside/` in one rename, so that the passphrase or
    /// recovery key it had still opens it. Nothing is erased. An open,
    /// writable vault records it in its history first.
    pub fn reset(&self) -> Result<(), VaultError> {
        self.portal_session.fetch_add(1, Ordering::AcqRel);
        self.cancel_io.store(true, Ordering::Release);
        let mut guard = self.session();
        // Holding the mutex means the cancelled operation has stopped. Clear the
        // flag on every path, as `lock` does, so that no later session inherits it.
        self.cancel_io.store(false, Ordering::Release);
        let _storage_lock = match guard.as_ref() {
            Some(unlocked) => Arc::clone(&unlocked.storage_lock),
            None => acquire_storage_lock(&self.root)?,
        };
        let target = set_aside_path(&self.root)?;
        if let Some(unlocked) = guard.as_mut() {
            // Best effort: the patient asked for this, and it goes ahead
            // whether or not it can be recorded.
            let entry = HistoryEntry::new(HistoryEvent::SetAside, crate::now_ms())
                .with_place(&set_aside_name(&target));
            record_in_session(&self.root, unlocked, vec![entry]);
        }
        *guard = None;
        self.idle.disarm();
        // How that vault's last session ended is nothing to the next one's.
        self.forget_last_session();
        let resumed = finish_pending_resets(&self.root)?;
        if !self.root.exists() {
            return if resumed {
                Ok(())
            } else {
                Err(VaultError::Missing)
            };
        }
        fail_at_test_boundary("reset.before-set-aside")?;
        set_aside_to(&self.root, &target)?;
        terminate_at_test_boundary("reset.after-set-aside");
        *self
            .last_set_aside
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(set_aside_name(&target));
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
            for reference in record
                .objects()
                .filter(|object| self.backs_up_record_object(record, *object))
            {
                let path = self.root.join("objects").join(reference.object_name);
                let mut object = open_regular_read(&path)?;
                let length = object.metadata()?.len();
                backup.entry(
                    BACKUP_KIND_OBJECT,
                    reference.object_name,
                    length,
                    &mut object,
                )?;
            }
        }
        // The history's segments (#71). One that is gone or damaged is left
        // out rather than failing the backup: a restore takes segments as
        // optional, and a check of the history shows the gap.
        for segment in &manifest.history.segments {
            match read_history_segment(&self.root, &parts.keys, manifest.vault_id, segment) {
                Ok(_) => {}
                Err(VaultError::Corrupt) => continue,
                Err(error) => return Err(error),
            }
            let path = self.root.join("objects").join(&segment.object_name);
            let mut object = open_regular_read(&path)?;
            let length = object.metadata()?.len();
            backup.entry(
                BACKUP_KIND_OBJECT,
                &segment.object_name,
                length,
                &mut object,
            )?;
        }
        backup.finish(
            &unlocked.master_key,
            manifest.vault_id,
            manifest.generation,
            now_ms,
        )
    }

    /// Whether a backup carries a record's object: every one the vault needs,
    /// and a document hidden as damaged only if its file came back (#71).
    fn backs_up_record_object(&self, record: &StoredRecord, object: RecordObject<'_>) -> bool {
        object_required(record)
            || object_presence_name(&self.root, object.object_name) == ObjectPresence::Present
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
        let header = current_header(&self.root, vault_id, &unlocked.master_key)?;
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
        for object in record
            .objects()
            .filter(|object| self.backs_up_record_object(record, *object))
        {
            read_object_ref(
                &self.root.join("objects").join(object.object_name),
                vault_id,
                keys,
                object,
                CancellableWriter::new(io::sink(), Arc::clone(&self.cancel_io))
                    .with_progress(&self.idle),
            )
            .map_err(|error| match error {
                VaultError::Corrupt => VaultError::DamagedDocument(record.id),
                error => error,
            })?;
        }
        Ok(())
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
        self.record_backup_saved(&destination.to_string_lossy());
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
        let _work = self.start_kdf_work()?;
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
        let files = read_header_files(&self.root);
        let candidates = &files.candidates;
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
            // From the same reading as whether a slot could not be read.
            let live_header = candidates
                .iter()
                .filter(|live| {
                    live.vault_id == header.vault_id && valid_header_integrity(live, master_key)
                })
                .max_by_key(|live| live.generation);
            let slots = read_manifest_slots(&self.root, master_key, header.vault_id).ok();
            let live_manifest = slots.as_ref().and_then(|slots| {
                slots
                    .iter()
                    .filter_map(SlotReading::authentic)
                    .map(|(manifest, _)| manifest)
                    .max_by_key(|manifest| manifest.generation)
                    .cloned()
            });
            // A header or manifest slot that could not be read may hold
            // something newer than what was compared.
            let partly_unreadable = files.slot_unreadable
                || slots.as_ref().is_some_and(|slots| {
                    slots
                        .iter()
                        .any(|slot| matches!(slot, SlotReading::Unreadable))
                });
            // The same passphrase (its KDF salt) and the same recovery key.
            let same_keys = live_header.is_some_and(|live| {
                live.kdf == header.kdf
                    && live.recovery.as_ref().map(|envelope| envelope.key_id)
                        == header.recovery.as_ref().map(|envelope| envelope.key_id)
            });
            // Redundancy repair moves the generation on without changing
            // anything else, so the generation is left out of the comparison.
            // So are the history and the format (#71): every unlock adds to
            // the history, a backup saved too, and an unlock can upgrade the
            // format. None of that is a change restoring would lose.
            let same_content = live_manifest.as_ref().is_some_and(|live| {
                let mut live = live.clone();
                live.generation = manifest.generation;
                live.format_version = manifest.format_version;
                live.history = manifest.history.clone();
                live == *manifest
            });
            // Which of the two is the later one is not told: a generation
            // moves on with repairs, and a vault restored and changed
            // elsewhere has a lower one than a vault left untouched here.
            (
                RestoreReplaces::SameVault,
                partly_unreadable || !(same_keys && same_content),
            )
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
        let _work = self.start_kdf_work()?;
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
            let segments = &manifest.history.segments;
            let mut wanted: HashMap<&str, u64> = manifest
                .records
                .iter()
                .flat_map(|record| {
                    record
                        .objects()
                        .map(|object| (object.object_name, object.plaintext_size))
                })
                .chain(segments.iter().map(|segment| {
                    (
                        segment.object_name.as_str(),
                        history::SEGMENT_PLAINTEXT_BYTES as u64,
                    )
                }))
                .collect();
            // A document hidden as damaged may come without its file, and a
            // history segment that was gone or damaged is left out (#71).
            let optional: HashSet<&str> = manifest
                .records
                .iter()
                .filter(|record| !object_required(record))
                .flat_map(|record| record.objects().map(|object| object.object_name))
                .chain(segments.iter().map(|segment| segment.object_name.as_str()))
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
            if wanted.keys().any(|name| !optional.contains(name)) {
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
            // A copy just written that cannot be read back is a failure of
            // the storage, not something about the vault on this device.
            let selected = select_manifest(&slots).map_err(|error| match error {
                VaultError::Unreadable => VaultError::Storage,
                other => other,
            })?;
            if selected.recovery.is_some() || selected.manifest != manifest {
                return Err(VaultError::BackupUnreadable);
            }
            let keys = derive_keys(header.vault_id, &master_key)?;
            for record in &manifest.records {
                for object in record.objects() {
                    if !object_required(record)
                        && object_presence_name(&stage, object.object_name)
                            != ObjectPresence::Present
                    {
                        continue;
                    }
                    read_object_ref(
                        &stage.join("objects").join(object.object_name),
                        header.vault_id,
                        &keys,
                        object,
                        CancellableWriter::new(io::sink(), Arc::clone(&self.cancel_io)),
                    )
                    .map_err(|error| match error {
                        VaultError::Cancelled => error,
                        _ => VaultError::BackupUnreadable,
                    })?;
                }
            }
            for segment in segments {
                if fs::symlink_metadata(stage.join("objects").join(&segment.object_name)).is_err() {
                    continue;
                }
                read_history_segment(&stage, &keys, header.vault_id, segment)
                    .map_err(|_| VaultError::BackupUnreadable)?;
            }
            // The restore goes in the restored vault's history (#71), written
            // here, where the keys are, before the vault is put in place. A
            // backup an earlier build made becomes format 3 and starts its
            // history here; nothing else reads the stage meanwhile.
            let mut restored = manifest.clone();
            restored.format_version = VAULT_FORMAT;
            let mut entry = HistoryEntry::new(HistoryEvent::BackupRestored, crate::now_ms());
            // The vault it replaces is set aside when it goes in place.
            if self.root.exists() {
                entry.how = Some("replaced".to_owned());
            }
            let prepared = prepare_history(&stage, &master_key, &restored, vec![entry])?;
            restored.history = prepared.state;
            for _ in 0..2 {
                restored.generation = restored
                    .generation
                    .checked_add(1)
                    .ok_or(VaultError::Storage)?;
                write_valid_manifest_at(&stage, &master_key, &restored)?;
            }
            remove_objects(&stage, &prepared.superseded, Removable::SupersededSegment);
            sync_dir(&stage)?;
            Ok(())
        })();
        if let Err(error) = staged {
            if remove_key_envelopes(&stage, Removable::RestoreStage).is_ok() {
                sync_parent(&stage);
            }
            let _ = remove_owned_dir_all(&stage, Removable::RestoreStage);
            sync_parent(home);
            return Err(error);
        }
        // From here a crash finishes the restore at the next start instead of
        // discarding it: the verified copy takes a fixed name first.
        let ready = restore_ready_path(&self.root)?;
        let discard = |directory: &Path| {
            if remove_key_envelopes(directory, Removable::RestoreStage).is_ok() {
                sync_parent(directory);
            }
            let _ = remove_owned_dir_all(directory, Removable::RestoreStage);
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
                let unstaged = fail_at_test_boundary("restore.before-unstage")
                    .and_then(|()| fs::rename(&ready, &stage).map_err(VaultError::from));
                if unstaged.is_ok() {
                    sync_parent(home);
                    discard(&stage);
                } else {
                    // Its header goes first: without one, nothing puts it in
                    // place, however much of the rest a removal leaves.
                    let removed = fail_at_test_boundary("restore.before-envelope-removal")
                        .and_then(|()| remove_key_envelopes(&ready, Removable::RestoreStage));
                    sync_parent(&ready);
                    let header_gone = HEADER_SLOTS.iter().all(|slot| {
                        fs::symlink_metadata(ready.join(slot))
                            .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
                    });
                    if removed.is_err() && !header_gone {
                        // A header that cannot be removed (a file held open,
                        // say) leaves the verified copy whole, and the next
                        // start puts it in place: that is what to report.
                        return Err(VaultError::RestoreUnfinished);
                    }
                    let _ = remove_owned_dir_all(&ready, Removable::RestoreStage);
                    sync_parent(home);
                }
            }
            return Err(error);
        }
        // The restore is in place, and the vault it replaced set aside. How
        // that vault's last session ended is nothing to the restored one.
        self.forget_last_session();
        drop(session);
        Ok(())
    }

    #[cfg(test)]
    fn read_header(&self) -> Result<VaultHeader, VaultError> {
        read_latest_header(&self.root)
    }

    /// A change to the manifest that records nothing: tests only, to set up
    /// a state. Every change the app makes is recorded (`mutate_recorded`).
    #[cfg(test)]
    fn mutate_manifest<T>(
        &self,
        mutation: impl FnOnce(&mut Manifest) -> Result<T, VaultError>,
    ) -> Result<T, VaultError> {
        self.mutate_recorded(|manifest, _| mutation(manifest))
    }

    /// As `mutate_manifest`, with the history entries the mutation adds for
    /// what it changed, in the same commit (#71).
    fn mutate_recorded<T>(
        &self,
        mutation: impl FnOnce(&mut Manifest, &mut Vec<HistoryEntry>) -> Result<T, VaultError>,
    ) -> Result<T, VaultError> {
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        let mut next = unlocked.manifest.clone();
        let mut entries = Vec::new();
        let result = mutation(&mut next, &mut entries)?;
        let redundant = commit_with_history(
            &self.root,
            &unlocked.master_key,
            &mut unlocked.manifest,
            next,
            entries,
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

impl ObjectContext {
    /// A history segment belongs to no profile (#71); a document always does.
    fn is_history_segment(&self) -> bool {
        self.profile_id.is_nil()
    }
}

/// A word of a profile name long enough that its presence in a passphrase is
/// not a coincidence.
const MIN_NAME_WORD_CHARS: usize = 4;

/// Which of the rules for a new passphrase it meets, as first setup's
/// checklist shows them (#69). Three answers only: never a score, a hint, or
/// anything of the passphrase itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PassphraseRules {
    pub long_enough: bool,
    pub not_a_name: bool,
    pub hard_to_guess: bool,
}

fn validate_new_passphrase(passphrase: &str, context: &[&str]) -> Result<(), VaultError> {
    let rules = judge_new_passphrase(passphrase, context, true)?;
    if !rules.long_enough {
        Err(VaultError::Invalid)
    } else if rules.not_a_name && rules.hard_to_guess {
        Ok(())
    } else {
        Err(VaultError::WeakPassphrase)
    }
}

/// The one judgement of a new passphrase, for both the vault and first
/// setup's checklist. Refused outright: one over the byte limit or with
/// control characters. Otherwise, which rules it meets; with `stop_early`, the
/// slow estimate is skipped once a rule has failed, and counts as failed.
fn judge_new_passphrase(
    passphrase: &str,
    context: &[&str],
    stop_early: bool,
) -> Result<PassphraseRules, VaultError> {
    // Bound the raw input before any work on it.
    if passphrase.len() > MAX_PASSPHRASE_BYTES {
        return Err(VaultError::Invalid);
    }
    // Every rule applies to the form the KDF will see. The same visible text
    // must pass or fail alike whichever composition form a keyboard produced.
    let passphrase = normalize_passphrase(passphrase);
    if passphrase.len() > MAX_PASSPHRASE_BYTES || passphrase.chars().any(char::is_control) {
        return Err(VaultError::Invalid);
    }
    let long_enough = passphrase.chars().count() >= MIN_PASSPHRASE_CHARS;
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
    let lowered = lowercase(passphrase.as_str());
    let not_a_name = !context
        .iter()
        .flat_map(|value| value.split(|c: char| !c.is_alphanumeric()))
        .filter(|word| word.chars().count() >= MIN_NAME_WORD_CHARS)
        .any(|word| lowered.contains(lowercase(word).as_str()));
    let hard_to_guess = if stop_early && !(long_enough && not_a_name) {
        false
    } else {
        let mut user_inputs = vec!["mycarlos", "carlos", "myvitalhistory"];
        user_inputs.extend(context.iter().map(|value| value.as_str()));
        zxcvbn(&passphrase, &user_inputs).score() >= Score::Three
    };
    Ok(PassphraseRules {
        long_enough,
        not_a_name,
        hard_to_guess,
    })
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

pub(crate) fn sanitize_basename(value: &str) -> String {
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
        .filter(|record| object_required(record))
        .all(|record| object_is_present(root, record))
    {
        Ok(())
    } else {
        Err(VaultError::Corrupt)
    }
}

fn object_is_present(root: &Path, record: &StoredRecord) -> bool {
    object_presence(root, record) == ObjectPresence::Present
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ObjectPresence {
    Present,
    /// Not found, or not a regular file: the object is gone.
    Missing,
    /// It could not be looked up (a permission, sharing or device error). It
    /// may be intact, so it must never be treated as gone.
    Unknown,
}

fn object_presence(root: &Path, record: &StoredRecord) -> ObjectPresence {
    object_presence_name(root, &record.object_name)
}

fn object_presence_name(root: &Path, object_name: &str) -> ObjectPresence {
    let objects = root.join("objects");
    match fs::symlink_metadata(objects.join(object_name)) {
        Ok(metadata) if is_regular_non_reparse(&metadata) => ObjectPresence::Present,
        // A link, or a Windows reparse point such as a cloud placeholder, is
        // refused when opened, but the content may be intact behind it.
        Ok(metadata) if metadata.file_type().is_file() || metadata.file_type().is_symlink() => {
            ObjectPresence::Unknown
        }
        Ok(_) => ObjectPresence::Missing,
        // "Not found" is only an answer when the folder itself could be
        // searched: it is a real folder, or it is gone altogether. Behind a
        // link whose target is away (an unmounted drive), or a file standing
        // in the folder's place, every object reads as not found.
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // A folder that is gone says so only while the vault around it
            // is there: with its drive removed, nothing is found at all.
            let folder_gone = is_real_dir(root)
                && fs::symlink_metadata(&objects)
                    .is_err_and(|error| error.kind() == io::ErrorKind::NotFound);
            if folder_gone || is_real_dir(&objects) {
                ObjectPresence::Missing
            } else {
                ObjectPresence::Unknown
            }
        }
        Err(_) => ObjectPresence::Unknown,
    }
}

/// Checks everything about a decrypted manifest except whether its objects
/// are on disk, so a vault with a lost object can still be opened read-only.
fn validate_manifest_structure(manifest: &Manifest, vault_id: Uuid) -> Result<(), VaultError> {
    if !(MANIFEST_FORMAT_V1..=VAULT_FORMAT).contains(&manifest.format_version)
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
            || profile
                .full_name
                .as_ref()
                .is_some_and(|name| name != name.trim() || validate_name(name).is_err())
            || profile
                .birth_date
                .as_ref()
                .is_some_and(|date| !valid_birth_date(date))
            || (manifest.format_version < 4
                && (profile.full_name.is_some() || profile.birth_date.is_some()))
            || (profile.id == shared_profile_id(vault_id)
                && (profile.full_name.is_some() || profile.birth_date.is_some()))
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
    let mut object_ids = HashSet::new();
    if manifest.portal_links.len() > portal_link::MAX_LINKS
        || (manifest.format_version < 5 && !manifest.portal_links.is_empty())
    {
        return Err(VaultError::Corrupt);
    }
    let mut link_ids = HashSet::new();
    let mut device_ids = HashSet::new();
    for link in &manifest.portal_links {
        if (manifest.format_version < 6 && link.approval.is_some())
            || (manifest.format_version < 7
                && (!link.approval_history.is_empty()
                    || link
                        .approval
                        .as_ref()
                        .is_some_and(|a| a.status.is_some() || a.reason.is_some())))
            || !link_ids.insert(link.id)
            || !device_ids.insert(link.keys.device_key_id())
            || link.validate().is_err()
            || link
                .profile_id
                .is_some_and(|id| !profile_ids.contains(&id) || id == shared_profile_id(vault_id))
        {
            return Err(VaultError::Corrupt);
        }
    }
    let mut object_names = HashSet::new();
    let mut delivery_ids = HashSet::new();
    for record in &manifest.records {
        if record.id.is_nil()
            || !record_ids.insert(record.id)
            || !object_ids.insert(record.id)
            || !profile_ids.contains(&record.profile_id)
            || !valid_record_name(&record.display_name)
            || record.source_label != MANUAL_IMPORT_LABEL
            || record.media_type != "application/octet-stream"
            || !valid_object_name(&record.object_name)
            || !object_names.insert(record.object_name.as_str())
            || !valid_fingerprint(&record.fingerprint)
            || !valid_wrapped_secret(&record.wrapped_object_key)
            // Format 1 has no hidden documents.
            || (record.hidden.is_some() && manifest.format_version < MANIFEST_FORMAT_HIDDEN)
        {
            return Err(VaultError::Corrupt);
        }
        if let Some(original) = &record.original_pdf {
            if manifest.format_version < 5
                || original.id.is_nil()
                || !object_ids.insert(original.id)
                || !valid_object_name(&original.object_name)
                || !object_names.insert(original.object_name.as_str())
                || !valid_wrapped_secret(&original.wrapped_object_key)
                || original.sha256.len() != 64
                || !original
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(VaultError::Corrupt);
            }
        }
        if (manifest.format_version < 6 && record.delivery.is_some())
            || record
                .delivery
                .as_ref()
                .is_some_and(|c| !delivery_ids.insert((c.link_id, c.outer.delivery_id.as_str())))
            || !delivery::valid_custody(record, &manifest.portal_links)
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
    validate_history(manifest, &mut object_names, &mut object_ids)
}

/// The history's place in the manifest (#71): format 3 only; its data
/// segments in order, each starting where the one before ended, with their
/// entries adding up to `count`; then the filler segments that make the
/// number of segments a power of two; and every segment's object its own.
fn validate_history<'a>(
    manifest: &'a Manifest,
    object_names: &mut HashSet<&'a str>,
    object_ids: &mut HashSet<Uuid>,
) -> Result<(), VaultError> {
    let state = &manifest.history;
    if state.is_empty() {
        return Ok(());
    }
    let data = state
        .segments
        .iter()
        .take_while(|segment| segment.entry_count > 0)
        .count();
    let mut next_seq = 0_u64;
    let mut ids = HashSet::new();
    for (index, segment) in state.segments.iter().enumerate() {
        let filler = index >= data;
        if segment.id.is_nil()
            || !ids.insert(segment.id)
            || !object_ids.insert(segment.id)
            || !valid_object_name(&segment.object_name)
            || !object_names.insert(segment.object_name.as_str())
            || !valid_wrapped_secret(&segment.wrapped_key)
            || (filler && (segment.entry_count != 0 || segment.first_seq != 0))
            || (!filler && segment.first_seq != next_seq)
        {
            return Err(VaultError::Corrupt);
        }
        next_seq = next_seq
            .checked_add(segment.entry_count)
            .ok_or(VaultError::Corrupt)?;
    }
    if manifest.format_version < MANIFEST_FORMAT_HISTORY
        || state.count == 0
        || next_seq != state.count
        || state.segments.len() != history::padded_segment_count(data)
        || state.head.len() != 64
        || !state
            .head
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(VaultError::Corrupt);
    }
    Ok(())
}

/// The current KDF parameters with a fresh random salt.
fn new_kdf_config() -> KdfConfig {
    let mut salt = [0_u8; 16];
    OsRng.fill_bytes(&mut salt);
    kdf_config_with_salt(salt)
}

fn kdf_config_with_salt(salt: [u8; 16]) -> KdfConfig {
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
///
/// The copy is sized once for the longest form NFC can give. Collecting into
/// a string that grows would free each shorter buffer, with the start of the
/// passphrase in it, without wiping it.
fn normalize_passphrase(passphrase: &str) -> Zeroizing<String> {
    let mut normalized = wiped_with_room(passphrase.len() * MAX_NFC_EXPANSION);
    for character in passphrase.nfc() {
        push_wiped(&mut normalized, character);
    }
    normalized
}

/// NFC makes UTF-8 text at most three times as long.
const MAX_NFC_EXPANSION: usize = 3;
/// Lower case makes UTF-8 text at most one and a half times as long; room
/// for twice is kept.
const MAX_LOWERCASE_EXPANSION: usize = 2;

fn wiped_with_room(bytes: usize) -> Zeroizing<String> {
    Zeroizing::new(String::with_capacity(bytes))
}

/// Adds a character without ever leaving an unwiped buffer behind. The room
/// kept is enough for today's Unicode tables; should later ones need more,
/// the text moves to a larger buffer and the smaller one is wiped.
fn push_wiped(text: &mut Zeroizing<String>, character: char) {
    if text.len() + character.len_utf8() > text.capacity() {
        let mut larger = wiped_with_room((text.capacity() * 2).max(8));
        larger.push_str(text);
        *text = larger;
    }
    text.push(character);
}

/// Lower case, one character at a time, into a copy that is wiped and never
/// grows. Both sides of a comparison go through it, and a final sigma, which
/// whole-text lowercasing writes by its position, is written as any other
/// sigma, so that a name is found wherever it stands.
fn lowercase(text: &str) -> Zeroizing<String> {
    let mut lowered = wiped_with_room(text.len() * MAX_LOWERCASE_EXPANSION);
    for character in text.chars().flat_map(char::to_lowercase) {
        push_wiped(&mut lowered, if character == 'ς' { 'σ' } else { character });
    }
    lowered
}

/// How many times the speed test derives a key.
pub const KDF_BENCHMARK_SAMPLES: usize = 5;

/// How long this device takes to derive a key from a passphrase, with the
/// settings every vault uses. See ARGON2_BENCHMARK.md.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfBenchmark {
    pub memory_kib: u32,
    pub iterations: u32,
    pub lanes: u32,
    /// Each derivation, in the order it was run.
    pub samples_ms: Vec<u64>,
    pub median_ms: u64,
    pub max_ms: u64,
    /// Whether this is a release build. The evaluation builds are not,
    /// though the key derivation in them is optimized (see the dev profile
    /// in Cargo.toml).
    pub release: bool,
    /// Whether this is an iOS Simulator build, whose timings are not a
    /// device's.
    pub simulator: bool,
}

/// Derives a key `KDF_BENCHMARK_SAMPLES` times and times each. It uses a
/// made-up passphrase and salt, reads no vault and keeps nothing. Before each
/// derivation it asks `still_open`, and stops with `Locked` once the vault has
/// been locked.
fn benchmark_kdf(still_open: &dyn Fn() -> bool) -> Result<KdfBenchmark, VaultError> {
    let config = kdf_config_with_salt([0x5a_u8; 16]);
    let mut samples_ms = Vec::with_capacity(KDF_BENCHMARK_SAMPLES);
    for _ in 0..KDF_BENCHMARK_SAMPLES {
        if !still_open() {
            return Err(VaultError::Locked);
        }
        let started = Instant::now();
        // Kept from the optimizer, which could otherwise drop work whose
        // result is not used.
        std::hint::black_box(derive_passphrase_key(
            std::hint::black_box("not a passphrase: the myCarlos speed test"),
            &config,
        )?);
        samples_ms.push(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX));
    }
    let mut sorted = samples_ms.clone();
    sorted.sort_unstable();
    Ok(KdfBenchmark {
        memory_kib: config.memory_kib,
        iterations: config.iterations,
        lanes: config.lanes,
        median_ms: sorted[sorted.len() / 2],
        max_ms: sorted[sorted.len() - 1],
        samples_ms,
        release: !cfg!(debug_assertions),
        simulator: cfg!(all(target_os = "ios", target_abi = "sim")),
    })
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

/// Reads a recovery key as typed: case, and anything but a letter or digit
/// (spaces, dashes, other punctuation), do not matter, and I, L and O are
/// read as 1, 1 and 0, as Crockford base32 allows.
fn decode_recovery_key(text: &str) -> Result<Zeroizing<[u8; RECOVERY_KEY_BYTES]>, VaultError> {
    if text.len() > 256 {
        return Err(VaultError::RecoveryKeyTypo);
    }
    let mut values = Zeroizing::new(Vec::with_capacity(RECOVERY_KEY_GROUPS * 4));
    for character in text.chars() {
        // Dashes, spaces and any other punctuation only separate groups.
        if !character.is_alphanumeric() {
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

/// A short name for a recovery key, from its envelope's id, which is not
/// secret: it tells kits apart, and says nothing about the key.
fn recovery_key_label(key_id: Uuid) -> String {
    key_id.simple().to_string()[..4].to_uppercase()
}

/// The text of a recovery kit. Plain text, so that it prints and opens
/// anywhere; the date is UTC.
fn recovery_kit_text(key: &str, label: &str, now_ms: u64) -> Zeroizing<String> {
    let (year, month, day) = utc_date(now_ms);
    Zeroizing::new(format!(
        "myCarlos recovery kit\n\
         =====================\n\
         \n\
         Recovery key:  {key}\n\
         Key label:     {label} (not secret: it tells kits apart)\n\
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

/// The UTC date of `ms`, as `YYYY-MM-DD`.
pub(crate) fn utc_date_text(ms: u64) -> String {
    let (year, month, day) = utc_date(ms);
    format!("{year:04}-{month:02}-{day:02}")
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
    key_id: Uuid,
    vault_id: Uuid,
    master_key: &[u8; 32],
    now_ms: u64,
) -> Result<RecoveryEnvelope, VaultError> {
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

#[cfg(test)]
fn read_header_candidates(root: &Path) -> Vec<VaultHeader> {
    read_headers(root, &[HEADER_SLOTS[0], HEADER_SLOTS[1], LEGACY_HEADER])
}

/// The header files as one reading found them. Choosing a header and
/// deciding whether a slot was unreadable must come from the same reading:
/// a slot held by another program for a moment could otherwise be missed
/// when the header is chosen and found readable when it is asked about,
/// and a repair would then write over a header that was never seen.
struct HeaderFiles {
    /// The structurally valid headers, slots first.
    candidates: Vec<VaultHeader>,
    /// A slot is there and could not be used: its file could not be read, or
    /// a newer build wrote it. Nothing may be written over it.
    slot_unreadable: bool,
    /// A header file is there and could not be read, which may pass.
    file_unreadable: bool,
}

fn read_header_files(root: &Path) -> HeaderFiles {
    let mut files = HeaderFiles {
        candidates: Vec::new(),
        slot_unreadable: false,
        file_unreadable: false,
    };
    for name in [HEADER_SLOTS[0], HEADER_SLOTS[1], LEGACY_HEADER] {
        let is_slot = name != LEGACY_HEADER;
        match read_bounded_regular_file(&root.join(name), MAX_HEADER_BYTES) {
            Ok(data) => match serde_json::from_slice::<VaultHeader>(&data) {
                Ok(header) if valid_header(&header) => files.candidates.push(header),
                _ if is_slot && newer_build_header(&data) => files.slot_unreadable = true,
                _ => {}
            },
            Err(error) if unreadable_error(&error) => {
                files.file_unreadable = true;
                files.slot_unreadable |= is_slot;
            }
            // Absent, oversized and non-regular files are damage that repair
            // may replace.
            Err(_) => {}
        }
    }
    files
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
        .filter(|character| character.is_alphanumeric())
    {
        normalized.push(match character.to_ascii_uppercase() {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        });
    }
    normalized.as_str() == expected
}

/// The key being set up, once the typed groups match it.
fn matching_pending_key<'a>(
    unlocked: &'a UnlockedVault,
    groups: &[(usize, &str)],
) -> Result<&'a PendingRecoveryKey, VaultError> {
    if unlocked.recovery.is_some() {
        return Err(VaultError::RecoveryMode);
    }
    let pending = unlocked
        .pending_recovery_key
        .as_ref()
        .ok_or(VaultError::Invalid)?;
    // The whole key, every group once: typing it all back is what shows it
    // was written down whole.
    if groups.len() != RECOVERY_KEY_GROUPS {
        return Err(VaultError::Invalid);
    }
    let distinct: HashSet<usize> = groups.iter().map(|(index, _)| *index).collect();
    if distinct.len() != RECOVERY_KEY_GROUPS {
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
    let expected = encode_recovery_key(&pending.key);
    let expected_groups: Vec<&str> = expected.split('-').collect();
    let matched = groups
        .iter()
        .filter(|(index, typed)| recovery_group_matches(typed, expected_groups[*index]))
        .count();
    if matched != groups.len() {
        return Err(VaultError::RecoveryKeyTypo);
    }
    Ok(pending)
}

/// A vault is called damaged only when every file that holds its state
/// could be read.
fn not_damage_if(unreadable: bool, error: VaultError) -> VaultError {
    match error {
        VaultError::Corrupt if unreadable => VaultError::Unreadable,
        other => other,
    }
}

/// The header an open vault writes after, or backs up: the newest one its
/// master key authenticates, once every slot could be read. A slot that
/// could not may hold a newer one.
fn current_header(
    root: &Path,
    vault_id: Uuid,
    master_key: &[u8; 32],
) -> Result<VaultHeader, VaultError> {
    let files = read_header_files(root);
    if files.slot_unreadable {
        return Err(VaultError::Unreadable);
    }
    files
        .candidates
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
) -> Result<(VaultHeader, SecretKey, bool), VaultError> {
    let HeaderFiles {
        mut candidates,
        slot_unreadable,
        file_unreadable,
    } = read_header_files(root);
    if candidates.is_empty() {
        return Err(if !root.exists() {
            VaultError::Missing
        } else if file_unreadable {
            VaultError::Unreadable
        } else {
            VaultError::Corrupt
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
    // A header that could not be read may be the one this key opens.
    let (header, master_key) = selected.ok_or(if file_unreadable {
        VaultError::Unreadable
    } else {
        VaultError::WrongRecoveryKey
    })?;
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
    Ok((header, master_key, slot_unreadable))
}

fn read_header_for_passphrase(
    root: &Path,
    passphrase: &str,
) -> Result<(VaultHeader, SecretKey, SecretKey, bool), VaultError> {
    let HeaderFiles {
        mut candidates,
        slot_unreadable,
        file_unreadable,
    } = read_header_files(root);
    if candidates.is_empty() {
        return Err(if !root.exists() {
            VaultError::Missing
        } else if file_unreadable {
            VaultError::Unreadable
        } else {
            VaultError::Corrupt
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
    // A header that could not be read may be the one this passphrase opens:
    // after a change of passphrase, the other slot may still hold the old one.
    let (header, master_key, key_index) = selected.ok_or(if file_unreadable {
        VaultError::Unreadable
    } else {
        VaultError::WrongPassphrase
    })?;

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
    Ok((header, master_key, wrapping_key, slot_unreadable))
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
    let _ = remove_owned_file(root.join(LEGACY_HEADER), Removable::LegacyHeader);
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
    let _ = remove_owned_file(root.join(LEGACY_HEADER), Removable::LegacyHeader);
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
        .filter(|record| object_required(record))
        .all(|record| object_is_present(root, record))
    {
        return Err(VaultError::Corrupt);
    }
    write_manifest_at(root, master_key, manifest)
}

/// The padded size of a manifest's plaintext: the next power of two, at least
/// `MANIFEST_SIZE_CLASS_MIN`.
fn manifest_size_class(length: usize) -> usize {
    length
        .max(MANIFEST_SIZE_CLASS_MIN)
        .checked_next_power_of_two()
        .unwrap_or(usize::MAX)
}

fn write_manifest_at(
    root: &Path,
    master_key: &[u8; 32],
    manifest: &Manifest,
) -> Result<(), VaultError> {
    let keys = derive_keys(manifest.vault_id, master_key)?;
    let mut plaintext =
        Zeroizing::new(serde_json::to_vec(manifest).map_err(|_| VaultError::Storage)?);
    let limit = MAX_MANIFEST_BYTES.saturating_sub(40);
    if plaintext.len() > limit {
        return Err(VaultError::Storage);
    }
    if manifest.format_version >= MANIFEST_FORMAT_HIDDEN {
        // Padded with spaces, which JSON ignores, to a size class (#71): the
        // file's size then tells only roughly how much the vault holds. Copied
        // into a buffer of that size, so that growing it leaves no unwiped
        // copy behind.
        let class = manifest_size_class(plaintext.len()).min(limit);
        let mut padded = Zeroizing::new(Vec::with_capacity(class));
        padded.extend_from_slice(&plaintext);
        padded.resize(class, b' ');
        plaintext = padded;
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
/// reflects it. `between` runs at that point, before the redundant write.
/// Documents are never deleted (#71); only the history unlinks there, and
/// only a superseded segment of its own (`commit_with_history`).
/// Returns whether the redundant write also succeeded; when it did not, or
/// when `between` failed, the caller's session must enter write-failed
/// recovery, since unlock repairs the slot redundancy.
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

/// Moves an older manifest to the current format in a commit of its own,
/// so that both slots hold the current format before anything only it can hold
/// (a history; for format 1, a hidden document) is written: a crash between
/// the two writes leaves a new-format slot that holds nothing an older build,
/// opening the other slot, could lose. The state is the one already
/// authenticated and is not changed, so whether its files are all there is
/// not checked again (a vault with lost documents is upgraded before they
/// are hidden). Returns whether both slots were written; nothing is written
/// for an already current manifest.
fn upgrade_manifest(
    root: &Path,
    master_key: &[u8; 32],
    current: &mut Manifest,
) -> Result<bool, VaultError> {
    if current.format_version >= VAULT_FORMAT {
        return Ok(true);
    }
    let mut next = current.clone();
    next.format_version = VAULT_FORMAT;
    validate_manifest_structure(&next, next.vault_id).map_err(|_| VaultError::Invalid)?;
    next.generation = current
        .generation
        .checked_add(1)
        .ok_or(VaultError::Storage)?;
    let second_generation = next.generation.checked_add(1).ok_or(VaultError::Storage)?;
    fail_at_test_boundary("upgrade.before-first-write")?;
    write_manifest_at(root, master_key, &next)?;
    *current = next.clone();
    terminate_at_test_boundary("upgrade.after-first-write");
    if fail_at_test_boundary("upgrade.after-first-write").is_err() {
        return Ok(false);
    }
    next.generation = second_generation;
    if write_manifest_at(root, master_key, &next).is_err() {
        return Ok(false);
    }
    *current = next;
    terminate_at_test_boundary("upgrade.after-second-write");
    Ok(true)
}

/// A history segment's key is wrapped with this before its id: it can then
/// be unwrapped only for the segment it was made for, never for a document.
const SEGMENT_KEY_DOMAIN: &[u8] = b"mycarlos-history-segment-v1:";

fn segment_key_aad(segment_id: Uuid) -> Vec<u8> {
    [SEGMENT_KEY_DOMAIN, segment_id.as_bytes()].concat()
}

/// Encrypts one history segment into a new object, in the envelope a
/// document has, under a random key of its own (#71). Its id stands where a
/// document's would in each chunk's associated data. On disk it looks like a
/// document of 64 KiB.
fn write_history_segment(
    root: &Path,
    keys: &DerivedKeys,
    vault_id: Uuid,
    entries: &[HistoryEntry],
) -> Result<HistorySegment, VaultError> {
    let plaintext = history::pack(entries).ok_or(VaultError::Invalid)?;
    let id = Uuid::new_v4();
    let object_name = format!("{}.mcobj", Uuid::new_v4());
    let mut segment_key = Zeroizing::new([0_u8; 32]);
    OsRng.fill_bytes(segment_key.as_mut());
    let wrapped_key = wrap_secret(&keys.object_wrap, &segment_key, &segment_key_aad(id))?;
    // Publish only after sync_all in encrypt_object. Windows cannot fsync a
    // directory through std, so use the same write-through move as documents.
    let path = root
        .join("objects")
        .join(format!("{}.mcobj", Uuid::new_v4()));
    let written = encrypt_object(
        Box::new(io::Cursor::new(plaintext)),
        &path,
        ObjectContext {
            vault_id,
            record_id: id,
            profile_id: Uuid::nil(),
        },
        &segment_key,
        &keys.fingerprint,
    );
    if let Err(error) = written {
        let _ = remove_owned_file(&path, Removable::UncommittedObject);
        return Err(error);
    }
    if let Err(error) = publish_object(&path, &root.join("objects").join(&object_name)) {
        let _ = remove_owned_file(&path, Removable::UncommittedObject);
        return Err(error.into());
    }
    Ok(HistorySegment {
        id,
        object_name,
        wrapped_key,
        first_seq: entries.first().map_or(0, |entry| entry.seq),
        entry_count: entries.len() as u64,
    })
}

/// The entries in one segment. `Corrupt` when its object is gone or does not
/// authenticate, or holds other entries than the manifest says.
fn read_history_segment(
    root: &Path,
    keys: &DerivedKeys,
    vault_id: Uuid,
    segment: &HistorySegment,
) -> Result<Vec<HistoryEntry>, VaultError> {
    let segment_key = unwrap_secret(
        &keys.object_wrap,
        &segment.wrapped_key,
        &segment_key_aad(segment.id),
    )?;
    let mut plaintext = Zeroizing::new(Vec::with_capacity(history::SEGMENT_PLAINTEXT_BYTES));
    verify_object(
        &root.join("objects").join(&segment.object_name),
        &mut *plaintext,
        vault_id,
        segment.id,
        &segment_key,
        history::SEGMENT_PLAINTEXT_BYTES as u64,
    )?;
    let entries = history::unpack(&plaintext).ok_or(VaultError::Corrupt)?;
    if entries.len() as u64 != segment.entry_count
        || entries
            .first()
            .is_some_and(|entry| entry.seq != segment.first_seq)
    {
        return Err(VaultError::Corrupt);
    }
    Ok(entries)
}

/// What appending to the history writes besides the manifest.
struct PreparedHistory {
    /// The next manifest's history.
    state: HistoryState,
    /// Objects written for it: removed again if the commit fails before its
    /// first write.
    written: Vec<String>,
    /// Segments the new state no longer names: removed between the two
    /// manifest writes.
    superseded: Vec<String>,
}

/// Chains `entries` onto the manifest's history and writes the segments that
/// hold them (#71): the last segment rewritten with the new entries after
/// its own, new segments when it is full, and filler segments up to the next
/// power of two. A last segment that is gone or damaged is kept as it is,
/// and the new entries start a segment of their own: the chain still goes on
/// from the head the manifest pins, and a check shows the gap. A history not
/// started yet, in a vault an earlier build made, starts with an entry
/// saying so.
fn prepare_history(
    root: &Path,
    master_key: &[u8; 32],
    current: &Manifest,
    mut entries: Vec<HistoryEntry>,
) -> Result<PreparedHistory, VaultError> {
    let vault_id = current.vault_id;
    let keys = derive_keys(vault_id, master_key)?;
    let state = &current.history;
    if state.count == 0
        && entries
            .first()
            .is_some_and(|entry| entry.event != HistoryEvent::Created)
    {
        let at_ms = entries[0].at_ms;
        entries.insert(0, HistoryEntry::new(HistoryEvent::HistoryStarted, at_ms));
    }
    let added = entries.len() as u64;
    let head = if state.count == 0 {
        history::genesis(vault_id)
    } else {
        state.head.clone()
    };
    let head = history::chain(&mut entries, state.count, head);
    let (mut data, mut fillers): (Vec<HistorySegment>, Vec<HistorySegment>) = state
        .segments
        .iter()
        .cloned()
        .partition(|segment| segment.entry_count > 0);
    let mut superseded = Vec::new();
    if let Some(last) = data.last() {
        match read_history_segment(root, &keys, vault_id, last) {
            Ok(mut kept) => {
                kept.append(&mut entries);
                entries = kept;
                superseded.push(last.object_name.clone());
                data.pop();
            }
            Err(VaultError::Corrupt) => {}
            Err(error) => return Err(error),
        }
    }
    let mut written = Vec::new();
    let write = || -> Result<(), VaultError> {
        for segment in history::into_segments(entries) {
            let segment = write_history_segment(root, &keys, vault_id, &segment)?;
            written.push(segment.object_name.clone());
            data.push(segment);
        }
        let wanted = history::padded_segment_count(data.len()) - data.len();
        while fillers.len() > wanted {
            if let Some(filler) = fillers.pop() {
                superseded.push(filler.object_name);
            }
        }
        while fillers.len() < wanted {
            let filler = write_history_segment(root, &keys, vault_id, &[])?;
            written.push(filler.object_name.clone());
            fillers.push(filler);
        }
        // The manifest about to be committed names them: their directory
        // entries must be durable first, as an import's are.
        fail_at_test_boundary("history.objects-sync")?;
        sync_dir(&root.join("objects"))
    };
    if let Err(error) = write() {
        remove_objects(root, &written, Removable::UncommittedObject);
        return Err(error);
    }
    terminate_at_test_boundary("history.after-segment-write");
    data.extend(fillers);
    Ok(PreparedHistory {
        state: HistoryState {
            count: state.count + added,
            head,
            segments: data,
        },
        written,
        superseded,
    })
}

fn remove_objects(root: &Path, names: &[String], kind: Removable) {
    if names.is_empty() {
        return;
    }
    let objects = root.join("objects");
    for name in names {
        let _ = remove_owned_file(objects.join(name), kind);
    }
    let _ = sync_dir(&objects);
}

/// Commits `next` with `entries` appended to the history, in the same commit
/// (#71): a change is never committed without its entries, nor entries
/// without their change. Superseded segments are unlinked between the two
/// manifest writes; one a failure leaves is quarantined at the next unlock.
/// Returns as `commit_manifest_redundant` does.
fn commit_with_history(
    root: &Path,
    master_key: &[u8; 32],
    current: &mut Manifest,
    mut next: Manifest,
    entries: Vec<HistoryEntry>,
) -> Result<bool, VaultError> {
    if entries.is_empty() {
        return commit_manifest_redundant(root, master_key, current, next, || Ok(()));
    }
    // A writable session's manifest is upgraded at unlock.
    if next.format_version < MANIFEST_FORMAT_HISTORY {
        return Err(VaultError::Invalid);
    }
    let prepared = prepare_history(root, master_key, current, entries)?;
    next.history = prepared.state;
    let superseded = prepared.superseded;
    let committed = commit_manifest_redundant(root, master_key, current, next, || {
        remove_objects(root, &superseded, Removable::SupersededSegment);
        Ok(())
    });
    if committed.is_err() {
        remove_objects(root, &prepared.written, Removable::UncommittedObject);
    }
    committed
}

/// Appends events that already happened, such as a readable copy saved, in
/// a commit of their own (#71), and says whether they are in the history. A
/// read-only session records nothing. A write that fails leaves the session
/// read-only, so that nothing more happens unrecorded; what was done stays
/// done.
fn record_in_session(
    root: &Path,
    unlocked: &mut UnlockedVault,
    entries: Vec<HistoryEntry>,
) -> bool {
    if unlocked.recovery.is_some() {
        return false;
    }
    let next = unlocked.manifest.clone();
    match commit_with_history(
        root,
        &unlocked.master_key,
        &mut unlocked.manifest,
        next,
        entries,
    ) {
        // Committed once the first write is durable, even if the second
        // was not.
        Ok(redundant) => {
            if !redundant {
                unlocked.recovery = Some(RecoveryReason::WriteFailed);
            }
            true
        }
        Err(_) => {
            unlocked.recovery = Some(RecoveryReason::WriteFailed);
            false
        }
    }
}

/// The folders `ids` name, as they are named now, for a move's entry.
fn folders_at_the_time(manifest: &Manifest, ids: &[Uuid]) -> Vec<history::FolderAtTheTime> {
    ids.iter()
        .filter_map(|id| manifest.folders.iter().find(|folder| folder.id == *id))
        .map(|folder| history::FolderAtTheTime {
            id: folder.id,
            name: folder.name.clone(),
        })
        .collect()
}

/// An entry about one document, with its name now.
fn record_entry(event: HistoryEvent, at_ms: u64, record: &StoredRecord) -> HistoryEntry {
    let mut entry = HistoryEntry::new(event, at_ms);
    entry.record_id = Some(record.id);
    entry.name = Some(record.display_name.clone());
    entry
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
    /// Records whose ciphertext object is missing, is not a regular file, or
    /// could not be looked up. The last may be intact, so they are only ever
    /// removable when the slot is not unreadable (see `SlotReading`).
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
        manifest: Box<Manifest>,
        /// Records whose object is missing, is not a regular file, or could
        /// not be looked up.
        missing: HashSet<Uuid>,
        /// Those of them that could not be looked up. Such an object may be
        /// intact, so the slot counts as unreadable: nothing may be removed.
        unknown: HashSet<Uuid>,
    },
}

impl SlotReading {
    fn authentic(&self) -> Option<(&Manifest, &HashSet<Uuid>)> {
        match self {
            Self::Authentic {
                manifest, missing, ..
            } => Some((manifest.as_ref(), missing)),
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
    let mut missing = HashSet::new();
    let mut unknown = HashSet::new();
    for record in manifest
        .records
        .iter()
        .filter(|record| object_required(record))
    {
        match object_presence(root, record) {
            ObjectPresence::Present => {}
            ObjectPresence::Missing => {
                missing.insert(record.id);
            }
            ObjectPresence::Unknown => {
                missing.insert(record.id);
                unknown.insert(record.id);
            }
        }
    }
    SlotReading::Authentic {
        manifest: Box::new(manifest),
        missing,
        unknown,
    }
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
    // An object that could not be looked up counts as an unreadable slot: it
    // may be intact, so its record must not be offered for removal.
    let slot_unreadable = slots.iter().any(|slot| match slot {
        SlotReading::Unreadable => true,
        SlotReading::Authentic { unknown, .. } => !unknown.is_empty(),
        _ => false,
    });
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
        let (manifest, missing) = newest(slots.iter().filter_map(SlotReading::authentic))?
            .ok_or_else(|| {
                // Nothing to open, but not for certain nothing there: a slot
                // that could not be read may hold the vault's state.
                if slots
                    .iter()
                    .any(|slot| matches!(slot, SlotReading::Unreadable))
                {
                    VaultError::Unreadable
                } else {
                    VaultError::Corrupt
                }
            })?;
        return Ok(read_only_selection(manifest, missing));
    };
    let kept: HashSet<&str> = selected
        .records
        .iter()
        .map(|record| record.object_name.as_str())
        .collect();
    // An object that could not be looked up counts as intact here: passing
    // its generation over would drop its document from the list.
    let newer_with_intact_object = slots
        .iter()
        .filter_map(|slot| match slot {
            SlotReading::Authentic {
                manifest,
                missing,
                unknown,
            } => Some((manifest, missing, unknown)),
            _ => None,
        })
        .filter(|(manifest, _, _)| manifest.generation > selected.generation)
        .find(|(manifest, missing, unknown)| {
            manifest.records.iter().any(|record| {
                object_required(record)
                    && !kept.contains(record.object_name.as_str())
                    && (!missing.contains(&record.id) || unknown.contains(&record.id))
            })
        });
    if let Some((manifest, missing, _)) = newer_with_intact_object {
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

/// A slot written in a header format newer than this build knows: a newer
/// build put it there, so it is not damage to repair over.
fn newer_build_header(data: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(data).is_ok_and(|header| {
        header["magic"] == "MYCARLOS-VAULT"
            && header["formatVersion"]
                .as_u64()
                .is_some_and(|version| version > u64::from(HEADER_FORMAT))
    })
}

/// Absent, oversized and non-regular slots are damage that repair may
/// replace. Any other failure to read leaves what the file holds unknown.
fn unreadable_error(error: &io::Error) -> bool {
    !matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::InvalidData
    )
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
        let boundary = if context.is_history_segment() {
            "history.after-chunk-write"
        } else {
            "object.after-chunk-write"
        };
        terminate_at_test_boundary(boundary);
        fail_at_test_boundary(boundary)?;
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

fn read_object_ref<W: Write>(
    path: &Path,
    vault_id: Uuid,
    keys: &DerivedKeys,
    object: RecordObject<'_>,
    writer: W,
) -> Result<(), VaultError> {
    let key = unwrap_secret(&keys.object_wrap, object.wrapped_key, object.id.as_bytes())?;
    if let Some(expected) = object.sha256 {
        let mut hashed = original_pdf::HashWriter::new(writer);
        verify_object(
            path,
            &mut hashed,
            vault_id,
            object.id,
            &key,
            object.plaintext_size,
        )?;
        if hashed.digest() != expected {
            return Err(VaultError::Corrupt);
        }
        Ok(())
    } else {
        verify_object(
            path,
            writer,
            vault_id,
            object.id,
            &key,
            object.plaintext_size,
        )
    }
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

fn remove_key_envelopes(directory: &Path, kind: Removable) -> Result<(), VaultError> {
    // An interrupted header write leaves a wrapped key in its temporary directory.
    remove_abandoned_atomic_writes(directory);
    // Every envelope wraps the same key, so one that cannot be removed must not
    // keep the others on disk. Try them all and report the first failure.
    let mut failure = None;
    for header in [HEADER_SLOTS[0], HEADER_SLOTS[1], LEGACY_HEADER] {
        match remove_owned_file(directory.join(header), kind) {
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
        let _ = remove_owned_file(&entry, Removable::ExportStage);
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
    match remove_owned_dir_all(stage, Removable::ExportStage) {
        Ok(()) => {
            if let Some(parent) = stage.parent() {
                sync_parent(parent);
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return,
    }
    if let Some(entry) = entry {
        if remove_owned_file(entry, Removable::ExportStage).is_ok() {
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
                let _ = remove_owned_file(&entry_path, Removable::ExportStage);
                continue;
            }
            // Perhaps held open for a moment by a scanner; try at a later start.
            Err(_) => continue,
        };
        let stage =
            decode_path(&bytes).filter(|stage| stage.is_absolute() && is_export_stage_name(stage));
        let Some(stage) = stage else {
            // Not an entry this app wrote: drop it, and touch nothing it names.
            let _ = remove_owned_file(&entry_path, Removable::ExportStage);
            continue;
        };
        let done = match fs::symlink_metadata(&stage) {
            // A link or junction is never followed. Other reparse points, such
            // as OneDrive's on a synced folder, are still real folders.
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                remove_owned_dir_all(&stage, Removable::ExportStage).is_ok()
            }
            // Something else has that name; it is not ours to remove.
            Ok(_) => false,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                stage.parent().is_some_and(|parent| parent.exists())
            }
            Err(_) => false,
        };
        if done {
            let _ = remove_owned_file(&entry_path, Removable::ExportStage);
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
        if remove_key_envelopes(&path, Removable::CreateStage).is_ok() {
            sync_parent(&path);
        }
        if remove_owned_dir_all(&path, Removable::CreateStage).is_ok() {
            sync_parent(parent);
        }
    }
}

// The caller holds the stable sibling lock.
fn finish_pending_resets(root: &Path) -> Result<bool, VaultError> {
    let parent = root.parent().ok_or(VaultError::Storage)?;
    remove_abandoned_create_stages(parent);
    remove_abandoned_restore_stages(parent);
    remove_abandoned_exports(parent);
    let mut resumed = false;
    // A verified restore whose vault was already set aside goes in place.
    if !root.exists() && activate_restore(root)? {
        resumed = true;
    }
    resumed |= set_aside_retired_vault(root)?;
    // A restore that was verified but not yet in place takes the live vault's
    // place now, and sets it aside.
    if activate_restore(root)? {
        resumed = true;
    }
    Ok(resumed)
}

/// Where vaults are set aside (#71's third part), beside the live vault in
/// its home. The app never removes anything from it.
const SET_ASIDE_DIR: &str = "set-aside";

/// A new folder to set a vault aside in:
/// `set-aside/<UTC yyyymmddThhmmssZ>-<random id>`, which tells only when.
fn set_aside_path(root: &Path) -> Result<PathBuf, VaultError> {
    let folder = vault_home(root)?.join(SET_ASIDE_DIR);
    match fs::symlink_metadata(&folder) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => create_private_dir(&folder)?,
        Ok(_) if is_real_dir(&folder) => {}
        // A file, a link or a reparse point where the folder should be.
        _ => return Err(VaultError::Storage),
    }
    let ms = crate::now_ms();
    let (year, month, day) = utc_date(ms);
    let seconds = (ms / 1000) % 86_400;
    Ok(folder.join(format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z-{}",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60,
        Uuid::new_v4()
    )))
}

/// The name a set-aside vault has under the vault home: `set-aside/<name>`.
fn set_aside_name(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default();
    format!("{SET_ASIDE_DIR}/{name}")
}

/// Moves a whole vault folder to `target` in `set-aside/`, in one rename on
/// the same disk. Its headers go with it: nothing is erased.
fn set_aside_to(from: &Path, target: &Path) -> Result<(), VaultError> {
    fs::rename(from, target)?;
    if let Some(folder) = target.parent() {
        sync_parent(folder);
    }
    if let Some(parent) = from.parent() {
        sync_parent(parent);
    }
    Ok(())
}

/// A vault an older build retired for erasing (`vault-v1.reset-pending`),
/// perhaps partly erased already, is set aside as it is, not erased.
fn set_aside_retired_vault(root: &Path) -> Result<bool, VaultError> {
    let pending = reset_path(root)?;
    let metadata = match fs::symlink_metadata(&pending) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        result => result?,
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(VaultError::Storage);
    }
    #[cfg(windows)]
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(VaultError::Storage);
    }
    fail_at_test_boundary("reset.before-set-aside")?;
    set_aside_to(&pending, &set_aside_path(root)?)?;
    Ok(true)
}

pub(crate) fn read_bounded_regular_file(path: &Path, maximum: usize) -> io::Result<Vec<u8>> {
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

pub(crate) fn atomic_bytes(path: &Path, data: &[u8]) -> Result<(), VaultError> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    AtomicFile::new(path, AllowOverwrite)
        .write_with_options(|file| file.write_all(data), options)
        .map_err(io::Error::from)?;
    Ok(())
}

/// What may ever be removed from storage (#71). Nothing that a committed
/// manifest references, no hidden document and no quarantined object is
/// among them. `std::fs` removal is disallowed crate-wide (clippy.toml), so
/// every removal goes through `remove_owned_file` or `remove_owned_dir_all`
/// and names one of these.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Removable {
    /// A vault being created, which failed or which a killed process left.
    CreateStage,
    /// Ciphertext an import or a history append wrote that no manifest has
    /// committed: a duplicate, or a batch or append that failed before its
    /// commit.
    UncommittedObject,
    /// A history segment the committed manifest no longer names: the last
    /// segment, rewritten with new entries after its own, or a filler no
    /// longer needed (#71). Never a document's object.
    SupersededSegment,
    /// An import's staging folder.
    ImportStaging,
    /// A readable copy's staging folder, or its journal entry.
    ExportStage,
    /// `header.json`, superseded by the two header slots.
    LegacyHeader,
    /// A restore's stage, or a verified copy being discarded.
    RestoreStage,
    /// What the atomic replacement primitive left behind.
    AtomicWriteLeftover,
}

/// The one place a file is removed (#71); `kind` says what it is.
#[allow(clippy::disallowed_methods)]
fn remove_owned_file(path: impl AsRef<Path>, kind: Removable) -> io::Result<()> {
    let _ = kind;
    fs::remove_file(path)
}

/// The one place a folder is removed (#71); `kind` says what it is.
#[allow(clippy::disallowed_methods)]
fn remove_owned_dir_all(path: impl AsRef<Path>, kind: Removable) -> io::Result<()> {
    let _ = kind;
    fs::remove_dir_all(path)
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

/// Keep std's extended Windows path handling when calling atomicwrites' raw
/// MoveFileExW. Both parents already exist; canonicalizing each supplies the
/// verbatim absolute prefix without requiring the destination file to exist.
fn publish_object(source: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        let absolute = |path: &Path| -> io::Result<PathBuf> {
            let parent = path
                .parent()
                .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
            let name = path
                .file_name()
                .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
            Ok(fs::canonicalize(parent)?.join(name))
        };
        atomicwrites::move_atomic(&absolute(source)?, &absolute(destination)?)
    }
    #[cfg(not(windows))]
    atomicwrites::move_atomic(source, destination)
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
            let _ = remove_owned_dir_all(entry.path(), Removable::ImportStaging);
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
            && remove_owned_dir_all(entry.path(), Removable::AtomicWriteLeftover).is_ok()
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

/// Moves aside, never deletes, each object that the opened manifest does not
/// reference (#71): ciphertext a crash left between writing it and its
/// commit, or one that a mistake in collecting references would otherwise
/// lose. It goes to `quarantine/` beside `objects/`, still encrypted, where
/// the app leaves it. A name already there is left where it is.
fn quarantine_orphan_objects(root: &Path, manifest: &Manifest) {
    let referenced: HashSet<&str> = manifest
        .records
        .iter()
        .flat_map(|record| record.objects().map(|object| object.object_name))
        .chain(
            manifest
                .history
                .segments
                .iter()
                .map(|segment| segment.object_name.as_str()),
        )
        .collect();
    let objects = root.join("objects");
    if !is_real_dir(&objects) {
        return;
    }
    let quarantine = root.join("quarantine");
    let mut moved = false;
    if let Ok(entries) = fs::read_dir(&objects) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let is_referenced = name.to_str().is_some_and(|name| referenced.contains(name));
            if !path.is_file() || is_referenced {
                continue;
            }
            if !is_real_dir(&quarantine) && create_private_dir(&quarantine).is_err() {
                return;
            }
            let target = quarantine.join(&name);
            if fs::symlink_metadata(&target).is_err() && fs::rename(&path, &target).is_ok() {
                moved = true;
            }
        }
    }
    if moved {
        sync_parent(&objects);
        let _ = sync_dir(&quarantine);
    }
}

/// Hashed with the vault id into the "Shared with me" profile's id.
const SHARED_PROFILE_LABEL: &[u8] = b"mycarlos:shared-with-me:v1:";
/// The name the "Shared with me" profile is stored with. The app shows it as
/// a folder, never as a person.
pub const SHARED_PROFILE_NAME: &str = "Shared with me";

/// Files shared to myCarlos from another app wait in one reserved profile
/// until the patient moves each to a person (#61). Its id is derived from the
/// vault id, so the manifest needs no field of its own for it (VAULT_FORMAT):
/// a UUID of version 8, RFC 9562's custom version, with the RFC 4122 variant.
/// Every other profile has a random version 4 id, which can never equal it.
pub fn shared_profile_id(vault_id: Uuid) -> Uuid {
    use sha2::Digest as _;
    let digest = Sha256::new()
        .chain_update(SHARED_PROFILE_LABEL)
        .chain_update(vault_id.as_bytes())
        .finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

/// A person's name: a valid name, and not the shared folder's, which would read
/// as the folder (#61).
fn validate_person_name(name: &str) -> Result<(), VaultError> {
    validate_name(name)?;
    if name.trim().to_lowercase() == SHARED_PROFILE_NAME.to_lowercase() {
        return Err(VaultError::Invalid);
    }
    Ok(())
}

/// Exact Gregorian date only; no locale-dependent date interpretation.
pub(crate) fn valid_birth_date(date: &str) -> bool {
    let b = date.as_bytes();
    if b.len() != 10
        || b[4] != b'-'
        || b[7] != b'-'
        || !b
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return false;
    }
    let year: u32 = date[..4].parse().unwrap_or(0);
    let month: u32 = date[5..7].parse().unwrap_or(0);
    let day: u32 = date[8..].parse().unwrap_or(0);
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let max = match month {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    year > 0 && day > 0 && day <= max
}

fn checked_profile_details(
    details: ProfileDetails,
    today: &str,
    now_ms: u64,
) -> Result<(Option<String>, Option<String>), VaultError> {
    // Calendar dates come from this device's renderer, as for backup names. Bound its
    // local day to the native clock's adjacent UTC dates, covering all time zones.
    if !valid_birth_date(today)
        || today < utc_date_text(now_ms.saturating_sub(86_400_000)).as_str()
        || today > utc_date_text(now_ms.saturating_add(86_400_000)).as_str()
    {
        return Err(VaultError::Invalid);
    }
    let full_name = details
        .full_name
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    let birth_date = details.birth_date.filter(|s| !s.is_empty());
    if full_name
        .as_ref()
        .is_some_and(|name| validate_name(name).is_err())
        || birth_date
            .as_ref()
            .is_some_and(|date| !valid_birth_date(date) || date.as_str() > today)
    {
        return Err(VaultError::Invalid);
    }
    Ok((full_name, birth_date))
}

/// The people a vault keeps records for: every profile but the shared one.
fn people(manifest: &Manifest) -> impl Iterator<Item = &PatientProfile> {
    let shared = shared_profile_id(manifest.vault_id);
    manifest
        .profiles
        .iter()
        .filter(move |profile| profile.id != shared)
}

/// Feeds what is written to it into a fingerprint MAC.
struct MacWriter<'a>(&'a mut HmacSha256);

impl Write for MacWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.update(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
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
/// rename, and every start repeats whatever is left: the live vault is set
/// aside, as a reset sets it aside, then the verified copy takes its place.
fn activate_restore(root: &Path) -> Result<bool, VaultError> {
    let ready = restore_ready_path(root)?;
    if !is_real_dir(&ready) {
        return Ok(false);
    }
    let parent = root.parent().ok_or(VaultError::Storage)?;
    // A verified copy has a header. Without one this is what is left of a
    // copy that was being discarded, and no vault is given up for it.
    if !HEADER_SLOTS.iter().any(|slot| ready.join(slot).is_file()) {
        let _ = remove_owned_dir_all(&ready, Removable::RestoreStage);
        sync_parent(parent);
        return Ok(false);
    }
    let mut retired_here = None;
    if root.exists() {
        let retired = set_aside_path(root)?;
        fail_at_test_boundary("restore.before-retire")?;
        set_aside_to(root, &retired)?;
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
        if remove_key_envelopes(&path, Removable::RestoreStage).is_ok() {
            sync_parent(&path);
        }
        if remove_owned_dir_all(&path, Removable::RestoreStage).is_ok() {
            sync_parent(parent);
        }
    }
}

// A native command test can damage its document without damaging history segments.
#[cfg(test)]
pub(crate) fn record_object_path_for_test(store: &VaultStore, record_id: Uuid) -> PathBuf {
    let guard = store.session();
    let record = guard
        .as_ref()
        .unwrap()
        .manifest
        .records
        .iter()
        .find(|record| record.id == record_id)
        .unwrap();
    store.root.join("objects").join(&record.object_name)
}

// Shared by native command and vault tests; no production history-read command.
#[cfg(test)]
pub(crate) fn history_events_for_test(store: &VaultStore) -> Vec<HistoryEntry> {
    let guard = store.session();
    let unlocked = guard.as_ref().unwrap();
    let manifest = &unlocked.manifest;
    let keys = derive_keys(manifest.vault_id, &unlocked.master_key).unwrap();
    let entries: Vec<HistoryEntry> = manifest
        .history
        .segments
        .iter()
        .flat_map(|segment| {
            read_history_segment(&store.root, &keys, manifest.vault_id, segment).unwrap()
        })
        .collect();
    assert_eq!(
        history::verify(
            manifest.vault_id,
            &entries,
            manifest.history.count,
            &manifest.history.head
        ),
        Ok(())
    );
    entries
}

#[cfg(test)]
// Tests remove files on purpose, to simulate damage and loss (#71).
#[allow(clippy::disallowed_methods)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[cfg(not(feature = "portal-linking"))]
    #[test]
    fn portal_link_default_off_refuses_before_creating_files_or_keys() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("not-created");
        let store = VaultStore::new(root.clone());
        assert!(matches!(
            store.link_portal(
                "https://fake.example",
                "FAKE0001-FAKE7-Q2M4K",
                "myCarlos",
                None,
                1,
                store.portal_link_ticket()
            ),
            Err(VaultError::Portal(portal_link::LinkError::Disabled))
        ));
        assert!(matches!(
            store.connect_portal(
                "https://fake.example",
                "FAKE0001-FAKE7-Q2M4K",
                "myCarlos",
                None,
                1,
                store.portal_link_ticket()
            ),
            Err(VaultError::Portal(portal_link::LinkError::Disabled))
        ));
        assert!(matches!(
            store.refresh_device_approval(Uuid::nil(), store.portal_link_ticket()),
            Err(VaultError::Portal(portal_link::LinkError::Disabled))
        ));
        assert!(!root.exists());
    }

    #[cfg(all(feature = "portal-linking", not(target_os = "android")))]
    #[test]
    fn portal_link_lock_started_during_pending_commit_never_sends_http() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(VaultStore::new(temp.path().join("vault")));
        store.create(PASSWORD, "FAKE Person", 1).unwrap();
        let ticket = store.portal_link_ticket();
        let (started_tx, started_rx) = mpsc::channel();
        let (handle_tx, handle_rx) = mpsc::channel();
        let locker = Arc::clone(&store);
        AT_TEST_BOUNDARY.with(|slot| {
            *slot.borrow_mut() = Some((
                "portal.pending-before-commit",
                Box::new(move || {
                    let locker = Arc::clone(&locker);
                    let started_tx = started_tx.clone();
                    let (gate_tx, gate_rx) = mpsc::channel();
                    let handle = std::thread::spawn(move || {
                        AT_TEST_BOUNDARY.with(|slot| {
                            *slot.borrow_mut() = Some((
                                "portal.lock-after-ticket",
                                Box::new(move || {
                                    started_tx.send(()).unwrap();
                                    gate_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                                }),
                            ));
                        });
                        locker.lock();
                    });
                    started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                    handle_tx.send((handle, gate_tx)).unwrap();
                }),
            ));
        });
        let sent = AtomicUsize::new(0);
        let result = store.link_portal_using(
            "https://fake.example",
            "FAKE0001-FAKE7-Q2M4K",
            "myCarlos",
            None,
            (2, ticket),
            |_, _, _| {
                sent.fetch_add(1, Ordering::SeqCst);
                Err(portal_link::LinkError::Network)
            },
        );
        let (handle, gate) = handle_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        gate.send(()).unwrap();
        handle.join().unwrap();
        assert!(matches!(
            result,
            Err(VaultError::Portal(portal_link::LinkError::Cancelled))
        ));
        assert_eq!(sent.load(Ordering::SeqCst), 0);
        store.unlock(PASSWORD).unwrap();
        let summary = store.snapshot().unwrap().portal_links;
        assert_eq!(summary.len(), 1);
        assert!(summary[0].incomplete);
    }

    #[cfg(all(feature = "portal-linking", not(target_os = "android")))]
    #[test]
    fn portal_link_queued_old_session_ticket_does_not_mutate_new_session() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "FAKE Person", 1).unwrap();
        let old = store.portal_link_ticket();
        store.lock();
        store.unlock(PASSWORD).unwrap();
        let before = store.session().as_ref().unwrap().manifest.clone();
        let result = store.link_portal_using(
            "https://fake.example",
            "FAKE0001-FAKE7-Q2M4K",
            "myCarlos",
            None,
            (2, old),
            |_, _, _| panic!("an old IPC ticket cannot send HTTP"),
        );
        assert!(matches!(
            result,
            Err(VaultError::Portal(portal_link::LinkError::Cancelled))
        ));
        assert!(before == store.session().as_ref().unwrap().manifest);
    }
    use std::{
        io::Cursor,
        process::{Command, Stdio},
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc,
        },
        time::{Duration, Instant},
    };

    /// Removal as the screen asks for it: confirming the documents the
    /// session shows as unavailable.
    fn remove_shown(store: &VaultStore) -> Result<Vec<Uuid>, VaultError> {
        let shown: Vec<Uuid> = store
            .session()
            .as_ref()
            .map(|unlocked| unlocked.unavailable.iter().copied().collect())
            .unwrap_or_default();
        store.hide_unavailable_records(&shown, 3)
    }

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

    fn original_pdf_fixture() -> (tempfile::TempDir, VaultStore, Uuid, Vec<u8>) {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "FAKE Person", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let bytes = b"%PDF-1.7\r\nFAKE verbatim source\n\x00\xff\r\n%%EOF".to_vec();
        let id = store
            .import(profile, vec![], vec![source("FAKE source.pdf", &bytes)], 2)
            .unwrap()
            .imported[0];
        (temp, store, id, bytes)
    }

    #[test]
    #[cfg(windows)]
    fn should_import_original_and_history_when_windows_staging_exceeds_max_path() {
        use std::os::windows::ffi::OsStrExt;
        let temp = tempfile::tempdir().unwrap();
        // The destination manifest fits MAX_PATH; the staging UUID + two
        // object UUIDs takes object publication past it. No verbatim prefix
        // is supplied by the caller, as with an ordinary selected vault.
        let root = temp.path().join("long-root-".repeat(16)).join("vault");
        fs::create_dir_all(root.parent().unwrap()).unwrap();
        let extended = fs::canonicalize(root.parent().unwrap())
            .unwrap()
            .join("vault");
        let setup = VaultStore::new(extended);
        setup.create(PASSWORD, "FAKE Person", 1).unwrap();
        setup.lock();
        drop(setup);
        assert!(root.as_os_str().encode_wide().count() < 260);
        assert!(
            root.join("manifest-0.bin")
                .as_os_str()
                .encode_wide()
                .count()
                < 260
        );
        assert!(
            root.join("staging")
                .join(Uuid::new_v4().to_string())
                .join(format!("{}.mcobj", Uuid::new_v4()))
                .as_os_str()
                .encode_wide()
                .count()
                >= 260
        );
        let store = VaultStore::new(root.clone());
        store.unlock(PASSWORD).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let bytes = b"%PDF-1.7\nFAKE Windows long path\n%%EOF";
        let id = store
            .import(profile, vec![], vec![source("FAKE.pdf", bytes)], 2)
            .unwrap()
            .imported[0];
        store.lock();
        store.unlock(PASSWORD).unwrap();
        let mut original = Vec::new();
        store.export(id, &mut original).unwrap();
        assert_eq!(original, bytes);
        assert_eq!(
            history_events(&store)
                .iter()
                .filter(|e| e.event == HistoryEvent::Imported)
                .count(),
            1
        );
        store.verify_for_backup().unwrap();
    }

    #[test]
    fn should_retain_both_pdf_objects_and_history_when_restarted_after_publication() {
        let temp = tempfile::tempdir().unwrap();
        let template = temp.path().join("template");
        let store = VaultStore::new(template.clone());
        store.create(PASSWORD, "FAKE Person", 1).unwrap();
        store.lock();
        for (boundary, committed) in [
            ("original.after-chunk-write", false),
            ("import.after-display-publication", false),
            ("import.after-original-publication", false),
            ("history.after-segment-write", false),
            ("manifest.after-first-write", true),
            ("manifest.after-second-write", true),
        ] {
            let root = temp.path().join(boundary);
            copy_directory(&template, &root);
            run_termination_child(&root, "original-import", boundary);
            let restarted = VaultStore::new(root.clone());
            restarted.unlock(PASSWORD).unwrap();
            let snapshot = restarted.snapshot().unwrap();
            assert_eq!(snapshot.records.len(), usize::from(committed), "{boundary}");
            assert_eq!(
                document_files(&root),
                2 * usize::from(committed),
                "{boundary}"
            );
            assert_eq!(fs::read_dir(root.join("staging")).unwrap().count(), 0);
            let imports: Vec<_> = history_events(&restarted)
                .into_iter()
                .filter(|entry| entry.event == HistoryEvent::Imported)
                .collect();
            assert_eq!(imports.len(), usize::from(committed), "{boundary}");
            if committed {
                assert_eq!(imports[0].record_id, Some(snapshot.records[0].id));
                let mut original = Vec::new();
                restarted
                    .export(snapshot.records[0].id, &mut original)
                    .unwrap();
                assert_eq!(
                    original,
                    b"%PDF-1.7\nFAKE original crash boundary record\n%%EOF"
                );
                restarted.verify_for_backup().unwrap();
            }
        }
    }

    #[test]
    fn should_refuse_object_id_collision_between_original_and_history() {
        let (_temp, store, _id, _bytes) = original_pdf_fixture();
        let guard = store.session();
        let unlocked = guard.as_ref().unwrap();
        let mut manifest = unlocked.manifest.clone();
        manifest.records[0].original_pdf.as_mut().unwrap().id = manifest.history.segments[0].id;
        assert!(matches!(
            validate_manifest_structure(&manifest, manifest.vault_id),
            Err(VaultError::Corrupt)
        ));
    }

    #[test]
    fn original_pdf_raw_bytes_have_an_independent_encrypted_object_and_key() {
        use sha2::Digest;
        let (_temp, store, id, bytes) = original_pdf_fixture();
        {
            let guard = store.session();
            let open = guard.as_ref().unwrap();
            let record = &open.manifest.records[0];
            let original = record.original_pdf.as_ref().unwrap();
            assert_ne!(record.id, original.id);
            assert_ne!(record.object_name, original.object_name);
            assert_eq!(original.plaintext_size, bytes.len() as u64);
            assert_eq!(
                original.sha256,
                Sha256::digest(&bytes)
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            );
            let keys = derive_keys(open.manifest.vault_id, &open.master_key).unwrap();
            let display_key = unwrap_secret(
                &keys.object_wrap,
                &record.wrapped_object_key,
                record.id.as_bytes(),
            )
            .unwrap();
            let original_key = unwrap_secret(
                &keys.object_wrap,
                &original.wrapped_object_key,
                original.id.as_bytes(),
            )
            .unwrap();
            assert!(display_key.as_slice() != original_key.as_slice());
            assert_ne!(
                fs::read(store.root.join("objects").join(&record.object_name)).unwrap(),
                fs::read(store.root.join("objects").join(&original.object_name)).unwrap()
            );
        }
        assert_eq!(store.snapshot().unwrap().records.len(), 1);
        assert_eq!(
            store.snapshot().unwrap().records[0].original_pdf_available,
            Some(true)
        );
        let mut saved = Vec::new();
        store.export(id, &mut saved).unwrap();
        assert_eq!(saved, bytes);
    }

    #[test]
    fn original_pdf_references_survive_move_hide_unlock_backup_and_restore() {
        let (temp, store, id, bytes) = original_pdf_fixture();
        let original_name = store.session().as_ref().unwrap().manifest.records[0]
            .original_pdf
            .as_ref()
            .unwrap()
            .object_name
            .clone();
        let other = store.create_profile("FAKE Other", 3).unwrap();
        store.move_to_profile(vec![id], other, vec![]).unwrap();
        store.hide_record(id, 4).unwrap();
        store.lock();
        store.unlock(PASSWORD).unwrap();
        assert!(
            store.root.join("objects").join(&original_name).is_file(),
            "unlock must not quarantine a referenced original"
        );
        assert!(store.snapshot().unwrap().records[0].hidden.is_some());
        let mut backup = Vec::new();
        store.backup(&mut backup, 5).unwrap();
        let restored = VaultStore::new(temp.path().join("restored"));
        restored
            .restore(
                Cursor::new(backup),
                RestoreCredential::Passphrase(PASSWORD),
                false,
            )
            .unwrap();
        restored.unlock(PASSWORD).unwrap();
        assert!(restored.root.join("objects").join(&original_name).is_file());
        assert_eq!(restored.snapshot().unwrap().records[0].profile_id, other);
        restored.unhide_record(id).unwrap();
        let mut saved = Vec::new();
        restored.export(id, &mut saved).unwrap();
        assert_eq!(saved, bytes);
    }

    #[test]
    fn original_pdf_missing_or_corrupt_does_not_remove_the_intact_view() {
        for corrupt in [false, true] {
            let (_temp, store, id, bytes) = original_pdf_fixture();
            let original_name = store.session().as_ref().unwrap().manifest.records[0]
                .original_pdf
                .as_ref()
                .unwrap()
                .object_name
                .clone();
            let path = store.root.join("objects").join(original_name);
            if corrupt {
                let mut data = fs::read(&path).unwrap();
                let last = data.len() - 1;
                data[last] ^= 1;
                fs::write(&path, data).unwrap();
            } else {
                fs::remove_file(&path).unwrap();
            }
            store.lock();
            store.unlock(PASSWORD).unwrap();
            assert!(store.snapshot().unwrap().records[0].available);
            assert_eq!(
                store.snapshot().unwrap().records[0].original_pdf_available,
                Some(corrupt)
            );
            let mut view = Vec::new();
            store.read_for_view(id, &mut view).unwrap();
            assert_eq!(view, bytes);
            assert!(matches!(
                store.export(id, io::sink()),
                Err(VaultError::Corrupt)
            ));
            assert!(
                matches!(store.verify_for_backup(), Err(VaultError::DamagedDocument(owner)) if owner == id)
            );
        }
    }

    #[test]
    fn original_pdf_write_failure_does_not_commit_half_an_import() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "FAKE Person", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let before = store.session().as_ref().unwrap().manifest.clone();
        {
            let _fail = FailAt::new("original.after-chunk-write");
            assert!(store
                .import(
                    profile,
                    vec![],
                    vec![source("FAKE.pdf", b"%PDF-1.7\nFAKE bytes")],
                    2
                )
                .is_err());
        }
        assert!(store.session().as_ref().unwrap().manifest == before);
        assert_eq!(fs::read_dir(store.root.join("staging")).unwrap().count(), 0);
    }

    #[test]
    #[ignore = "requires the real built helper; set MYCARLOS_TEST_SIGNED_HELPER_EXE and run explicitly"]
    fn signed_import_analysis_preserves_original_bytes_and_never_invents_a_clinic_link() {
        assert!(
            std::env::var_os("MYCARLOS_TEST_SIGNED_HELPER_EXE").is_some(),
            "run the documented real-helper import check, not the unit-test executable"
        );
        let fixture: serde_json::Value = serde_json::from_slice(include_bytes!(
            "../tests/fixtures/mycarlos-signed-pdf-fixtures.json"
        ))
        .unwrap();
        let document = &fixture["documents"][0];
        let original = BASE64
            .decode(document["pdf_b64"].as_str().unwrap())
            .unwrap();
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "FAKE Patient", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let imported = store
            .import(
                profile,
                vec![],
                vec![source("FAKE Signed.pdf", &original)],
                2,
            )
            .unwrap();
        assert_eq!(imported.imported.len(), 1);
        assert_eq!(imported.unverified_signatures.len(), 1);
        assert!(matches!(
            imported.unverified_signatures[0].reason,
            crate::signed_pdf_helper::Failure::Refused(crate::signed_pdf::Refusal::UnknownSigner)
        ));
        assert_eq!(
            imported.unverified_signatures[0].record_id,
            imported.imported[0]
        );
        let mut exported = Vec::new();
        store.export(imported.imported[0], &mut exported).unwrap();
        assert_eq!(exported, original);
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.records[0].source_label, MANUAL_IMPORT_LABEL);
        assert_eq!(snapshot.records[0].original_pdf_available, Some(true));
        {
            let guard = store.session();
            let record = &guard.as_ref().unwrap().manifest.records[0];
            assert!(record
                .original_pdf
                .as_ref()
                .is_some_and(|original| original.id != record.id
                    && original.object_name != record.object_name));
        }
        let report = serde_json::to_string(&imported).unwrap();
        assert!(!report.contains("recipient_id"));
        assert!(!report.contains("birth_date"));
        assert!(!report.contains("signer_kid"));
        let unsigned = store
            .import(
                profile,
                vec![],
                vec![source("FAKE Unsigned.pdf", b"%PDF-1.7\nFAKE unsigned")],
                3,
            )
            .unwrap();
        assert!(unsigned.unverified_signatures.is_empty());
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
                    full_name: None,
                    birth_date: None,
                },
                PatientProfile {
                    id: second_profile,
                    display_name: "Morgan".to_owned(),
                    created_at_ms: 2,
                    full_name: None,
                    birth_date: None,
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
                    hidden: None,
                    original_pdf: None,
                    delivery: None,
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
                    hidden: None,
                    original_pdf: None,
                    delivery: None,
                },
            ],
            history: HistoryState::default(),
            portal_links: Vec::new(),
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

    /// Unlocks with the environment's boundary held, so that it is reached
    /// in the operation that follows, not in the unlock's history commit.
    fn unlock_with_boundaries_held(store: &VaultStore) {
        ENV_BOUNDARIES_HELD.store(true, Ordering::Release);
        let unlocked = store.unlock(PASSWORD);
        ENV_BOUNDARIES_HELD.store(false, Ordering::Release);
        unlocked.unwrap();
    }

    /// The size every history segment's object has (#71): a 64 KiB plaintext
    /// in one chunk.
    const SEGMENT_OBJECT_LEN: u64 =
        (OBJECT_MAGIC.len() + 4 + 16 + 4 + 1 + history::SEGMENT_PLAINTEXT_BYTES + 16) as u64;

    /// The files in `objects/` that are documents' ciphertext, not history
    /// segments, told apart by size: every segment's object is the same
    /// size, and no test document is that large.
    fn document_files(root: &Path) -> usize {
        fs::read_dir(root.join("objects"))
            .unwrap()
            .filter(|entry| entry.as_ref().unwrap().metadata().unwrap().len() != SEGMENT_OBJECT_LEN)
            .count()
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
        if operation == "unlock" {
            let _ = store.unlock(PASSWORD);
            panic!("configured termination boundary was not reached");
        }
        unlock_with_boundaries_held(&store);
        let snapshot = store.snapshot().unwrap();
        match operation.as_str() {
            "import" | "original-import" => {
                let bytes: &[u8] = if operation == "original-import" {
                    b"%PDF-1.7\nFAKE original crash boundary record\n%%EOF"
                } else {
                    b"synthetic crash boundary record"
                };
                store
                    .import(
                        snapshot.profiles[0].id,
                        vec![],
                        vec![source("crash-test.pdf", bytes)],
                        2,
                    )
                    .unwrap();
            }
            "hide" => store.hide_record(snapshot.records[0].id, 3).unwrap(),
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
        if operation == "unlock-degraded" {
            store.unlock(PASSWORD).unwrap();
        } else {
            unlock_with_boundaries_held(&store);
        }
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
            "hide" => store.hide_record(snapshot.records[0].id, 3),
            "passphrase" => store.change_passphrase(PASSWORD, PASSPHRASE_REPLACEMENT),
            "recovery-key" => {
                let key = store.begin_recovery_key(PASSWORD).unwrap();
                let groups = recovery_key_groups(&key);
                store
                    .confirm_recovery_key(&typed_back(&groups), 7)
                    .map(|_| ())
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
                assert_eq!(document_files(&root), 0);
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

    /// The folders in `set-aside/` beside `root`.
    fn set_aside_folders(root: &Path) -> Vec<PathBuf> {
        let folder = root.parent().unwrap().join(SET_ASIDE_DIR);
        if !folder.exists() {
            return Vec::new();
        }
        // Folders only: a test that opens one in place leaves its lock file.
        let mut folders: Vec<PathBuf> = fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.is_dir())
            .collect();
        folders.sort();
        folders
    }

    #[test]
    fn a_reset_sets_the_vault_aside_whole_and_its_keys_still_open_it() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(profile, vec![], vec![source("old.pdf", b"old record")], 2)
            .unwrap();
        let key = set_up_recovery_key(&store, 3);
        // Every document's ciphertext and both headers, which must all go
        // with it, byte for byte.
        let mut kept: Vec<PathBuf> = store
            .session()
            .as_ref()
            .unwrap()
            .manifest
            .records
            .iter()
            .map(|record| Path::new("objects").join(&record.object_name))
            .collect();
        kept.extend(HEADER_SLOTS.iter().map(PathBuf::from));
        let before: Vec<Vec<u8>> = kept
            .iter()
            .map(|path| fs::read(root.join(path)).unwrap())
            .collect();
        store.reset().unwrap();
        assert_eq!(store.status().unwrap(), VaultStatus::Absent);

        // One folder, named for when, holding the vault.
        let folders = set_aside_folders(&root);
        assert_eq!(folders.len(), 1);
        let name = folders[0].file_name().unwrap().to_str().unwrap().to_owned();
        let (stamp, id) = name.split_once("Z-").unwrap();
        assert!(stamp.len() == 15 && stamp.as_bytes()[8] == b'T', "{name}");
        assert!(Uuid::parse_str(id).is_ok(), "{name}");
        for (path, bytes) in kept.iter().zip(&before) {
            assert_eq!(
                &fs::read(folders[0].join(path)).unwrap(),
                bytes,
                "{}",
                path.display()
            );
        }

        // Its passphrase and its recovery key still open it, with every
        // document and the history saying where it went.
        let aside = VaultStore::new(folders[0].clone());
        aside.unlock(PASSWORD).unwrap();
        assert_eq!(exported(&aside, "old.pdf"), b"old record");
        let entries = history_events(&aside);
        let set_aside = &entries[entries.len() - 2];
        assert_eq!(set_aside.event, HistoryEvent::SetAside);
        assert_eq!(
            set_aside.place.as_deref(),
            Some(format!("set-aside/{name}").as_str())
        );
        aside.lock();
        assert!(aside.recover(&key, PASSPHRASE_REPLACEMENT).unwrap());
        aside.lock();

        // The next vault made in this run names where the last one went.
        store.create(PASSWORD, "New profile", 4).unwrap();
        let created = history_events(&store).remove(0);
        assert_eq!(created.event, HistoryEvent::Created);
        assert_eq!(
            created.place.as_deref(),
            Some(format!("set-aside/{name}").as_str())
        );
        // A second reset sets the second vault aside beside the first.
        store.reset().unwrap();
        assert_eq!(set_aside_folders(&root).len(), 2);
    }

    #[test]
    fn a_reset_from_the_unlock_screen_sets_the_vault_aside_too() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        store.lock();
        // Locked, it cannot be written to: nothing is recorded in it.
        store.reset().unwrap();
        let folders = set_aside_folders(&root);
        assert_eq!(folders.len(), 1);
        let aside = VaultStore::new(folders[0].clone());
        aside.unlock(PASSWORD).unwrap();
        assert_eq!(
            events_of(&history_events(&aside)),
            [HistoryEvent::Created, HistoryEvent::Unlocked]
        );
    }

    #[test]
    fn an_interrupted_reset_leaves_the_vault_whole_in_place_or_set_aside() {
        for create_directly in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("vault");
            let store = VaultStore::new(root.clone());
            store.create(PASSWORD, "Jamie", 1).unwrap();
            store.lock();
            run_termination_child(&root, "reset", "reset.after-set-aside");
            assert!(!root.exists());
            assert_eq!(set_aside_folders(&root).len(), 1);
            let restarted = VaultStore::new(root.clone());
            if create_directly {
                restarted.create(PASSWORD, "New profile", 3).unwrap();
                assert!(restarted.snapshot().unwrap().records.is_empty());
            } else {
                assert_eq!(restarted.status().unwrap(), VaultStatus::Absent);
            }
            assert_eq!(set_aside_folders(&root).len(), 1);
        }
        // A reset that cannot move the vault leaves it where it was.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        {
            let _fail = FailAt::new("reset.before-set-aside");
            assert!(matches!(store.reset(), Err(VaultError::NoSpace)));
        }
        assert!(set_aside_folders(&root).is_empty());
        store.unlock(PASSWORD).unwrap();
    }

    #[test]
    fn a_vault_an_older_build_retired_is_set_aside_not_erased() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        store.lock();
        // What an older build left on its way to erasing a vault.
        let retired = reset_path(&root).unwrap();
        fs::rename(&root, &retired).unwrap();
        // While it cannot be moved, nothing goes ahead.
        run_failure_child(&root, "reset-recovery", "reset.before-set-aside");
        assert!(retired.join("header-0.json").exists());
        assert_eq!(store.status().unwrap(), VaultStatus::Absent);
        assert!(!retired.exists());
        let folders = set_aside_folders(&root);
        assert_eq!(folders.len(), 1);
        VaultStore::new(folders[0].clone())
            .unlock(PASSWORD)
            .unwrap();
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
        // A name ending in sigma is found wherever it stands, however the
        // sigma was written.
        for (passphrase, name) in [
            ("lanternΝΙΚΟΣorbit-willow-572", "ΝΙΚΟΣ"),
            ("lantern νικος orbit-willow-572", "ΝΙΚΟΣ"),
            ("lantern-orbit-willow-572 ΝΙΚΟΣ", "νικος"),
            ("lanternνικοσorbit-willow-572", "νικος"),
        ] {
            assert!(
                matches!(
                    validate_new_passphrase(passphrase, &[name]),
                    Err(VaultError::WeakPassphrase)
                ),
                "{passphrase} / {name}"
            );
        }
    }

    #[test]
    fn passphrase_copies_never_outgrow_their_first_buffer() {
        // A buffer that grows leaves its shorter self behind, unwiped. These
        // are the longest forms: characters that NFC takes apart, and ones
        // whose lower case is longer than they are.
        for text in [
            "lantern orbit willow cascade 572".to_owned(),
            "\u{1D15E}\u{1D15F}\u{1D160}".repeat(40),
            "\u{FB2C}\u{FB2D}\u{0958}\u{2ADC}".repeat(40),
            "\u{0130}\u{023A}\u{023E}\u{1E9E}".repeat(40),
            "e\u{0301}\u{0327}".repeat(40),
        ] {
            let normalized = normalize_passphrase(&text);
            assert_eq!(normalized.capacity(), text.len() * MAX_NFC_EXPANSION);
            // What the KDF is given must never change, or vaults stop opening.
            assert_eq!(normalized.as_str(), text.nfc().collect::<String>());
            let lowered = lowercase(&text);
            assert_eq!(lowered.capacity(), text.len() * MAX_LOWERCASE_EXPANSION);
        }
    }

    #[test]
    fn no_character_needs_more_room_than_is_kept() {
        // Every character there is, so that new Unicode tables that break
        // either bound are noticed here.
        for character in (0..=char::MAX as u32).filter_map(char::from_u32) {
            let mut buffer = [0_u8; 4];
            let text: &str = character.encode_utf8(&mut buffer);
            let normalized: usize = text.nfc().map(char::len_utf8).sum();
            assert!(
                normalized <= text.len() * MAX_NFC_EXPANSION,
                "NFC of U+{:04X}",
                character as u32
            );
            let lowered: usize = character.to_lowercase().map(char::len_utf8).sum();
            assert!(
                lowered <= text.len() * MAX_LOWERCASE_EXPANSION,
                "lower case of U+{:04X}",
                character as u32
            );
        }
    }

    #[test]
    fn a_copy_that_needs_more_room_moves_without_losing_anything() {
        let mut text = wiped_with_room(2);
        for character in "lantern \u{1D160}".chars() {
            push_wiped(&mut text, character);
        }
        assert_eq!(text.as_str(), "lantern \u{1D160}");
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
        let portal_ticket = store.portal_link_ticket();
        store.reset().unwrap();
        assert_ne!(store.portal_link_ticket(), portal_ticket);
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
    fn benchmark_excludes_all_kdf_operations_without_delaying_locks() {
        use std::sync::mpsc;
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(VaultStore::new(temp.path().join("vault")));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        for idle in [false, true] {
            let (entered_tx, entered_rx) = mpsc::channel();
            let (finish_tx, finish_rx) = mpsc::channel();
            let worker = {
                let store = Arc::clone(&store);
                std::thread::spawn(move || {
                    store.benchmark_kdf_with(|_| {
                        entered_tx.send(()).unwrap();
                        finish_rx.recv().unwrap();
                        Ok(())
                    })
                })
            };
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(matches!(
                store.create(PASSWORD, "Jamie", 1),
                Err(VaultError::Busy)
            ));
            assert!(matches!(store.unlock(PASSWORD), Err(VaultError::Busy)));
            assert!(matches!(
                store.change_passphrase(PASSWORD, PASSWORD),
                Err(VaultError::Busy)
            ));
            assert!(matches!(
                store.begin_recovery_key(PASSWORD),
                Err(VaultError::Busy)
            ));
            assert!(matches!(store.recover("", PASSWORD), Err(VaultError::Busy)));
            assert!(matches!(
                store.inspect_backup(io::empty(), RestoreCredential::Passphrase(PASSWORD)),
                Err(VaultError::Busy)
            ));
            assert!(matches!(
                store.restore_checked(
                    io::empty(),
                    RestoreCredential::Passphrase(PASSWORD),
                    false,
                    None
                ),
                Err(VaultError::Busy)
            ));
            assert!(matches!(
                store.benchmark_kdf_with::<()>(|_| panic!("busy benchmark ran")),
                Err(VaultError::Busy)
            ));
            let (locked_tx, locked_rx) = mpsc::channel();
            let locking = {
                let store = Arc::clone(&store);
                std::thread::spawn(move || {
                    if idle {
                        assert!(store.lock_if_idle(idle_past(Instant::now())));
                    } else {
                        store.lock();
                    }
                    locked_tx.send(()).unwrap();
                })
            };
            let locked = locked_rx.recv_timeout(Duration::from_secs(5));
            // The original race was lock then unlock during a speed test.
            // Capture the result before releasing admission: nothing queues
            // an unlock that could reopen the vault later.
            let (unlock_tx, unlock_rx) = mpsc::channel();
            let unlocking = {
                let store = Arc::clone(&store);
                std::thread::spawn(move || {
                    unlock_tx.send(store.unlock(PASSWORD)).unwrap();
                })
            };
            let unlock_while_running = unlock_rx.recv_timeout(Duration::from_secs(5));
            // Release the worker even on a failed assertion, avoiding hung tests.
            finish_tx.send(()).unwrap();
            worker.join().unwrap().unwrap();
            locking.join().unwrap();
            unlocking.join().unwrap();
            locked.unwrap();
            assert!(matches!(unlock_while_running, Ok(Err(VaultError::Busy))));
            assert_eq!(store.status().unwrap(), VaultStatus::Locked);
            assert!(matches!(
                store.benchmark_kdf_with::<()>(|_| panic!("locked benchmark ran")),
                Err(VaultError::Locked)
            ));
            store.unlock(PASSWORD).unwrap();
        }
    }

    #[test]
    fn benchmark_admission_releases_after_errors_and_panics() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        assert!(matches!(
            store.benchmark_kdf_with(|_| Err::<(), _>(VaultError::Storage)),
            Err(VaultError::Storage)
        ));
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = store.benchmark_kdf_with(|_| -> Result<(), VaultError> {
                panic!("FAKE benchmark panic")
            });
        }))
        .is_err());
        store.benchmark_kdf_with(|_| Ok(())).unwrap();
        store.lock();
        store.unlock(PASSWORD).unwrap();
    }

    #[test]
    fn benchmark_stops_at_the_next_sample_once_the_vault_is_locked() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        // The check handed to the measurement follows the session.
        let open = store
            .benchmark_kdf_with(|still_open| {
                let before = still_open();
                store.lock();
                Ok((before, still_open()))
            })
            .unwrap();
        assert_eq!(open, (true, false));
        // Admission is free again at once: an unlock is not answered busy.
        store.unlock(PASSWORD).unwrap();

        // The measurement asks before each derivation and runs no more after
        // a lock: here, one derivation, then Locked.
        let asked = std::cell::Cell::new(0);
        let result = benchmark_kdf(&|| {
            asked.set(asked.get() + 1);
            asked.get() == 1
        });
        assert!(matches!(result, Err(VaultError::Locked)));
        assert_eq!(asked.get(), 2);
        assert!(matches!(benchmark_kdf(&|| false), Err(VaultError::Locked)));
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
            store.hide_record(unknown, 3),
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
    fn the_shared_profile_id_is_fixed_per_vault_and_never_a_random_one() {
        let vault = Uuid::new_v4();
        let shared = shared_profile_id(vault);
        assert_eq!(shared, shared_profile_id(vault));
        assert_ne!(shared, shared_profile_id(Uuid::new_v4()));
        assert_eq!(shared.get_version_num(), 8);
        assert_eq!(shared.get_variant(), uuid::Variant::RFC4122);
        // Every other profile has a random version 4 id, which differs from
        // it in the version bits alone.
        for _ in 0..10_000 {
            let id = Uuid::new_v4();
            assert_eq!(id.get_version_num(), 4);
            assert_ne!(id, shared);
        }
    }

    #[test]
    fn shared_files_go_to_one_shared_profile_made_with_the_first() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let shared = store.shared_profile().unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.shared_profile_id, shared);
        assert!(!snapshot.profiles.iter().any(|profile| profile.id == shared));

        let first = store
            .import(shared, vec![], vec![source("a.pdf", b"one")], 2)
            .unwrap();
        assert_eq!(first.imported.len(), 1);
        store
            .import(shared, vec![], vec![source("b.pdf", b"two")], 3)
            .unwrap();
        let profiles = store.snapshot().unwrap().profiles;
        assert_eq!(profiles.len(), 2);
        let made = profiles
            .iter()
            .find(|profile| profile.id == shared)
            .unwrap();
        assert_eq!(made.display_name, SHARED_PROFILE_NAME);
        assert_eq!(made.created_at_ms, 2);

        // One fixed folder: nothing nests in it.
        assert!(matches!(
            store.create_folder(shared, None, "Labs", 4),
            Err(VaultError::Invalid)
        ));
        let jamie = profiles
            .iter()
            .find(|profile| profile.id != shared)
            .unwrap()
            .id;
        let folder = store.create_folder(jamie, None, "Labs", 5).unwrap();
        assert!(matches!(
            store.import(shared, vec![folder], vec![source("c.pdf", b"three")], 6),
            Err(VaultError::Invalid)
        ));

        // No person may be called it.
        assert!(matches!(
            store.create_profile(" shared WITH me ", 6),
            Err(VaultError::Invalid)
        ));
        // Its name is not a word a passphrase may not hold.
        store
            .change_passphrase(PASSWORD, "Shared-lantern-orbit-cascade-572")
            .unwrap();
        // A vault with it still opens.
        store.lock();
        store.unlock("Shared-lantern-orbit-cascade-572").unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.profiles.len(), 2);
        assert_eq!(
            snapshot
                .records
                .iter()
                .filter(|record| record.profile_id == shared)
                .count(),
            2
        );
    }

    #[test]
    fn a_shared_file_moves_to_a_person_keyed_as_if_imported_there() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let jamie = store.snapshot().unwrap().profiles[0].id;
        let morgan = store.create_profile("Morgan", 2).unwrap();
        let labs = store.create_folder(jamie, None, "Labs", 3).unwrap();
        let shared = store.shared_profile().unwrap();
        let added = store
            .import(
                shared,
                vec![],
                vec![source("a.pdf", b"one"), source("b.pdf", b"two")],
                4,
            )
            .unwrap()
            .imported;

        // Shared intake retains the same hide/restore guarantees as a person's files.
        let object = {
            let guard = store.session();
            let record = guard
                .as_ref()
                .unwrap()
                .manifest
                .records
                .iter()
                .find(|record| record.id == added[0])
                .unwrap();
            temp.path().join("vault/objects").join(&record.object_name)
        };
        let ciphertext = fs::read(&object).unwrap();
        store.hide_record(added[0], 5).unwrap();
        let hidden = store
            .snapshot()
            .unwrap()
            .records
            .into_iter()
            .find(|record| record.id == added[0])
            .unwrap();
        assert_eq!(hidden.profile_id, shared);
        assert!(hidden.hidden.is_some());
        assert_eq!(fs::read(&object).unwrap(), ciphertext);
        store.unhide_record(added[0]).unwrap();

        let outcome = store
            .move_to_profile(added.clone(), jamie, vec![labs])
            .unwrap();
        assert_eq!(outcome.moved, added);
        assert!(outcome.already_there.is_empty());
        assert_eq!(fs::read(&object).unwrap(), ciphertext);
        let snapshot = store.snapshot().unwrap();
        for id in &added {
            let record = snapshot.records.iter().find(|r| r.id == *id).unwrap();
            assert_eq!(record.profile_id, jamie);
            assert_eq!(record.folder_ids, vec![labs]);
        }
        // Keyed as if imported to Jamie: the same file again is a duplicate.
        assert_eq!(
            store
                .import(jamie, vec![], vec![source("again.pdf", b"one")], 5)
                .unwrap()
                .skipped_duplicates,
            vec!["again.pdf"]
        );
        // Its content is unchanged.
        let mut exported = Vec::new();
        store.export(added[0], &mut exported).unwrap();
        assert_eq!(exported, b"one");

        // A file Jamie already has stays in Shared with me; Morgan can have it.
        let again = store
            .import(shared, vec![], vec![source("c.pdf", b"one")], 6)
            .unwrap()
            .imported;
        let outcome = store.move_to_profile(again.clone(), jamie, vec![]).unwrap();
        assert!(outcome.moved.is_empty());
        assert_eq!(outcome.already_there, vec!["c.pdf"]);
        let record = |id: Uuid| {
            store
                .snapshot()
                .unwrap()
                .records
                .into_iter()
                .find(|r| r.id == id)
                .unwrap()
        };
        assert_eq!(record(again[0]).profile_id, shared);
        assert_eq!(
            store
                .move_to_profile(again.clone(), morgan, vec![])
                .unwrap()
                .moved,
            again
        );

        // Never into Shared with me or the same person, and into the target
        // person's own folders only.
        assert!(matches!(
            store.move_to_profile(vec![added[0]], jamie, vec![]),
            Err(VaultError::Invalid)
        ));
        let last = store
            .import(shared, vec![], vec![source("d.pdf", b"four")], 7)
            .unwrap()
            .imported;
        assert!(matches!(
            store.move_to_profile(last.clone(), shared, vec![]),
            Err(VaultError::Invalid)
        ));
        assert!(store
            .move_to_profile(last.clone(), morgan, vec![labs])
            .is_err());
        assert_eq!(record(last[0]).profile_id, shared);

        // What was moved is still valid when the vault opens again.
        store.lock();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(record(added[1]).profile_id, jamie);
        assert_eq!(record(again[0]).profile_id, morgan);
    }

    #[test]
    fn a_filed_document_moves_between_people_without_changing_its_object() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let jamie = store.snapshot().unwrap().profiles[0].id;
        let morgan = store.create_profile("Morgan", 2).unwrap();
        let old_folder = store.create_folder(jamie, None, "Old folder", 3).unwrap();
        let labs = store.create_folder(morgan, None, "Labs", 4).unwrap();
        // Treat document content as opaque, including any embedded signatures.
        let original = b"%PDF-1.7\nFAKE original document\n\x00\xff\r\n%%EOF";
        let id = store
            .import(
                jamie,
                vec![old_folder],
                vec![source("original.pdf", original)],
                5,
            )
            .unwrap()
            .imported[0];
        let before = store.session().as_ref().unwrap().manifest.records[0].clone();
        let history_before = history_events_for_test(&store).len();
        let object = root.join("objects").join(&before.object_name);
        let ciphertext = fs::read(&object).unwrap();

        let outcome = store.move_to_profile(vec![id], morgan, vec![labs]).unwrap();
        assert_eq!(outcome.moved, vec![id]);
        assert!(outcome.already_there.is_empty());
        let after = store.session().as_ref().unwrap().manifest.records[0].clone();
        assert_ne!(after.fingerprint, before.fingerprint);
        let mut expected = before.clone();
        expected.profile_id = morgan;
        expected.folder_ids = vec![labs];
        expected.fingerprint = after.fingerprint.clone();
        assert!(after == expected); // Includes identity, object name/key and all source metadata.
        assert_eq!(fs::read(&object).unwrap(), ciphertext);
        let history_objects = store
            .session()
            .as_ref()
            .unwrap()
            .manifest
            .history
            .segments
            .len();
        assert_eq!(
            fs::read_dir(root.join("objects")).unwrap().count(),
            2 + history_objects // Working PDF and independently encrypted original.
        );
        let history = history_events_for_test(&store);
        assert_eq!(history.len(), history_before + 1);
        let moved = history.last().unwrap();
        assert_eq!(moved.event, HistoryEvent::Moved);
        assert_eq!(moved.record_id, Some(id));
        assert_eq!(moved.profile_id, Some(morgan));
        assert_eq!(moved.how, None);
        let from = moved.from.as_ref().unwrap();
        let to = moved.to.as_ref().unwrap();
        assert_eq!(from.len(), 1);
        assert_eq!(to.len(), 1);
        assert_eq!(
            (from[0].id, from[0].name.as_str()),
            (old_folder, "Old folder")
        );
        assert_eq!((to[0].id, to[0].name.as_str()), (labs, "Labs"));
        assert_eq!(
            store
                .import(morgan, vec![], vec![source("again.pdf", original)], 6)
                .unwrap()
                .skipped_duplicates,
            vec!["again.pdf"]
        );

        store.lock();
        store.unlock(PASSWORD).unwrap();
        let reopened = store.snapshot().unwrap().records.remove(0);
        assert_eq!(reopened.id, id);
        assert_eq!(reopened.profile_id, morgan);
        assert_eq!(reopened.folder_ids, vec![labs]);
        let mut exported = Vec::new();
        store.export(id, &mut exported).unwrap();
        assert_eq!(exported, original);
        assert_eq!(fs::read(&object).unwrap(), ciphertext);
        // Moving back is valid and recomputes the original per-person fingerprint.
        store
            .move_to_profile(vec![id], jamie, vec![old_folder])
            .unwrap();
        assert!(store.session().as_ref().unwrap().manifest.records[0] == before);
    }

    #[test]
    fn a_filed_document_stays_at_source_on_duplicate_invalid_target_or_unreadable_batch() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let jamie = store.snapshot().unwrap().profiles[0].id;
        let morgan = store.create_profile("Morgan", 2).unwrap();
        let labs = store.create_folder(jamie, None, "Labs", 3).unwrap();
        let ids = store
            .import(
                jamie,
                vec![labs],
                vec![source("same.pdf", b"same"), source("other.pdf", b"other")],
                4,
            )
            .unwrap()
            .imported;
        store
            .import(morgan, vec![], vec![source("existing.pdf", b"same")], 5)
            .unwrap();
        let before = store.session().as_ref().unwrap().manifest.clone();
        let outcome = store.move_to_profile(vec![ids[0]], morgan, vec![]).unwrap();
        assert!(outcome.moved.is_empty());
        assert_eq!(outcome.already_there, vec!["same.pdf"]);
        assert!(store.session().as_ref().unwrap().manifest == before);
        for (target, folders) in [
            (morgan, vec![labs]), // Folder belongs to source, not destination.
            (store.shared_profile().unwrap(), vec![]),
            (Uuid::new_v4(), vec![]),
            (jamie, vec![]), // Same-person folder changes use assign_folders.
        ] {
            assert!(store.move_to_profile(ids.clone(), target, folders).is_err());
            assert!(store.session().as_ref().unwrap().manifest == before);
        }
        assert!(store
            .move_to_profile(vec![ids[1], Uuid::new_v4()], morgan, vec![])
            .is_err());
        assert!(store.session().as_ref().unwrap().manifest == before);
        // A later unreadable object cannot leave earlier batch items moved.
        let missing = before.records.iter().find(|r| r.id == ids[0]).unwrap();
        fs::remove_file(root.join("objects").join(&missing.object_name)).unwrap();
        assert!(store
            .move_to_profile(vec![ids[1], ids[0]], morgan, vec![])
            .is_err());
        assert!(store.session().as_ref().unwrap().manifest == before);
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
        assert_eq!(document_files(&root), 1);
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
        assert_eq!(document_files(&root), 0);
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
        assert_eq!(document_files(&root), 0);
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
            assert_eq!(document_files(&root), usize::from(committed));
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
            assert_eq!(document_files(&root), usize::from(committed));
        }
    }

    fn recovery_key_groups(key: &str) -> Vec<String> {
        key.split('-').map(str::to_owned).collect()
    }

    /// Every group of a key, by position, as the app sends them back.
    fn typed_back(groups: &[String]) -> Vec<(usize, &str)> {
        groups.iter().map(String::as_str).enumerate().collect()
    }

    /// Sets up a recovery key in an unlocked store and returns it.
    fn set_up_recovery_key(store: &VaultStore, now_ms: u64) -> String {
        let key = store.begin_recovery_key(PASSWORD).unwrap().to_string();
        let groups = recovery_key_groups(&key);
        store
            .confirm_recovery_key(&typed_back(&groups), now_ms)
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
            // Nor does other punctuation, which some keyboards put in.
            for separator in [". ", "_", "\u{2013}"] {
                let punctuated = text.replace('-', separator);
                assert_eq!(*decode_recovery_key(&punctuated).unwrap(), key);
            }
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
    fn the_whole_key_typed_back_is_stored_and_opens_the_vault() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let key = store.begin_recovery_key(PASSWORD).unwrap().to_string();
        let groups = recovery_key_groups(&key);
        let typed: Vec<(usize, &str)> = groups
            .iter()
            .enumerate()
            .map(|(index, group)| (index, group.as_str()))
            .collect();
        // The vault it leaves is returned with it, from the same session.
        let snapshot = store.confirm_recovery_key(&typed, 5).unwrap();
        assert_eq!(snapshot.recovery_key_set_at_ms, Some(5));
        store.lock();
        assert!(store
            .recover(&key.replace('-', ". "), PASSPHRASE_REPLACEMENT)
            .unwrap());
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
        // Only the whole key: one group, or all but one, is refused.
        assert!(matches!(
            store.confirm_recovery_key(&[(1, &groups[1])], 5),
            Err(VaultError::Invalid)
        ));
        assert!(matches!(
            store.confirm_recovery_key(&typed_back(&groups)[..6], 5),
            Err(VaultError::Invalid)
        ));
        let mut typo = typed_back(&groups);
        typo[1].1 = "ZZZZ";
        assert!(matches!(
            store.confirm_recovery_key(&typo, 5),
            Err(VaultError::RecoveryKeyTypo)
        ));
        assert!(read_latest_header(&root).unwrap().recovery.is_none());
        let lower = groups[1].to_lowercase();
        let mut typed = typed_back(&groups);
        typed[1].1 = &lower;
        store.confirm_recovery_key(&typed, 5).unwrap();
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
            store.confirm_recovery_key(&typed_back(&groups), 5),
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
            store.confirm_recovery_key(&typed_back(&groups), 5),
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
    fn a_backup_is_named_by_its_date_and_the_key_it_opens_with() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        assert!(matches!(
            store.backup_file_name("2026-09-28"),
            Err(VaultError::Locked)
        ));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        assert_eq!(
            store.backup_file_name("2026-09-28").unwrap(),
            "myCarlos backup 2026-09-28.mycarlosbackup"
        );
        set_up_recovery_key(&store, 2);
        let label = store.snapshot().unwrap().recovery_key_label.unwrap();
        assert_eq!(
            store.backup_file_name("2026-09-28").unwrap(),
            format!("myCarlos backup 2026-09-28 {label}.mycarlosbackup")
        );
        assert_eq!(utc_date_text(1_790_553_600_000), "2026-09-28");
    }

    #[test]
    fn a_keys_label_stays_through_a_passphrase_change_and_a_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let key = set_up_recovery_key(&store, 2);
        let label = store.snapshot().unwrap().recovery_key_label;
        assert!(label.is_some());
        store
            .change_passphrase(PASSWORD, PASSPHRASE_REPLACEMENT)
            .unwrap();
        assert_eq!(store.snapshot().unwrap().recovery_key_label, label);
        store.lock();
        assert!(store.recover(&key, PASSWORD).unwrap());
        assert_eq!(store.snapshot().unwrap().recovery_key_label, label);
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
        // Its file is named by the date and the key's label, which the kit
        // gives too: a kit for a new key does not take the place of another.
        let name = store.recovery_kit_name(1_790_553_600_000).unwrap();
        let label = name
            .strip_prefix("myCarlos recovery kit 2026-09-28 ")
            .and_then(|rest| rest.strip_suffix(".txt"))
            .unwrap()
            .to_owned();
        assert_eq!(label.len(), 4);
        assert!(label
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase()));
        assert!(kit.contains(&format!("Key label:     {label}")));
        assert!(!name.contains("Jamie"));
        // The page asks for it to print it on the kit.
        assert_eq!(store.pending_recovery_key_label().unwrap(), label);

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

        // Once the key is stored, there is no kit left to save, and the
        // stored key has the id whose label the kit gave.
        let groups = recovery_key_groups(&key);
        store.confirm_recovery_key(&typed_back(&groups), 5).unwrap();
        assert!(matches!(store.recovery_kit(1), Err(VaultError::Invalid)));
        assert!(matches!(
            store.recovery_kit_name(1),
            Err(VaultError::Invalid)
        ));
        let stored = read_latest_header(&root).unwrap().recovery.unwrap();
        assert_eq!(recovery_key_label(stored.key_id), label);
        // The vault's key has that label too, as Security shows it, after
        // the next unlock as well.
        assert_eq!(
            store.snapshot().unwrap().recovery_key_label.as_deref(),
            Some(label.as_str())
        );
        assert!(matches!(
            store.pending_recovery_key_label(),
            Err(VaultError::Invalid)
        ));
        store.lock();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(
            store.snapshot().unwrap().recovery_key_label.as_deref(),
            Some(label.as_str())
        );
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
        let mut out_of_range = typed_back(&groups);
        out_of_range[6].0 = 7;
        let mut repeated = typed_back(&groups);
        repeated[2].0 = 1;
        let mut too_many = typed_back(&groups);
        too_many.push((0, groups[0].as_str()));
        for request in [
            out_of_range,
            repeated,
            too_many,
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
            store.confirm_recovery_key(&typed_back(&groups), 5),
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
    fn checking_a_recovery_key_changes_nothing_and_says_if_one_would_be_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let headers = || HEADER_SLOTS.map(|name| fs::read(root.join(name)).unwrap());

        // Nothing is being set up.
        assert!(matches!(
            store.check_recovery_key(&[(0, "AAAA"); RECOVERY_KEY_GROUPS]),
            Err(VaultError::Invalid)
        ));
        let first = store.begin_recovery_key(PASSWORD).unwrap().to_string();
        let groups = recovery_key_groups(&first);
        let before = headers();
        let mut typo = typed_back(&groups);
        typo[1].1 = "ZZZZ";
        assert!(matches!(
            store.check_recovery_key(&typo),
            Err(VaultError::RecoveryKeyTypo)
        ));
        // The vault has no key yet, so none would be replaced.
        assert!(!store.check_recovery_key(&typed_back(&groups)).unwrap());
        assert_eq!(headers(), before);
        assert_eq!(store.snapshot().unwrap().recovery_key_set_at_ms, None);
        store.confirm_recovery_key(&typed_back(&groups), 5).unwrap();

        let second = store.begin_recovery_key(PASSWORD).unwrap().to_string();
        let groups = recovery_key_groups(&second);
        let before = headers();
        assert!(store.check_recovery_key(&typed_back(&groups)).unwrap());
        assert_eq!(headers(), before);
        // Until it is confirmed, the first key is the vault's.
        store.lock();
        assert!(matches!(
            store.recover(&second, PASSPHRASE_REPLACEMENT),
            Err(VaultError::WrongRecoveryKey)
        ));
        assert!(matches!(
            store.check_recovery_key(&typed_back(&groups)),
            Err(VaultError::Locked)
        ));
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
    fn a_key_is_stored_only_if_it_replaces_what_the_patient_was_asked_about() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let key = store.begin_recovery_key(PASSWORD).unwrap().to_string();
        let groups = recovery_key_groups(&key);
        let typed: Vec<(usize, &str)> = groups
            .iter()
            .enumerate()
            .map(|(index, group)| (index, group.as_str()))
            .collect();
        // Agreed to as a replacement, but the vault has no key to replace.
        assert!(matches!(
            store.confirm_recovery_key_replacing(&typed, 5, true),
            Err(VaultError::Invalid)
        ));
        assert_eq!(store.snapshot().unwrap().recovery_key_set_at_ms, None);
        store
            .confirm_recovery_key_replacing(&typed, 5, false)
            .unwrap();
        // Now it has one: a key not asked about as a replacement is refused.
        let key = store.begin_recovery_key(PASSWORD).unwrap().to_string();
        let groups = recovery_key_groups(&key);
        let typed: Vec<(usize, &str)> = groups
            .iter()
            .enumerate()
            .map(|(index, group)| (index, group.as_str()))
            .collect();
        assert!(matches!(
            store.confirm_recovery_key_replacing(&typed, 6, false),
            Err(VaultError::Invalid)
        ));
        assert_eq!(store.snapshot().unwrap().recovery_key_set_at_ms, Some(5));
        store
            .confirm_recovery_key_replacing(&typed, 6, true)
            .unwrap();
        assert_eq!(store.snapshot().unwrap().recovery_key_set_at_ms, Some(6));
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

    #[cfg(unix)]
    #[test]
    fn a_vault_partly_unreadable_is_not_said_to_hold_what_the_backup_holds() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (store, backup, _) = backed_up_vault(&root);
        let preview = || {
            store
                .inspect_backup(
                    Cursor::new(backup.clone()),
                    RestoreCredential::Passphrase(PASSWORD),
                )
                .unwrap()
        };
        assert!(!preview().differs_from_this_device);
        // One header slot cannot be read: it may hold a newer passphrase or
        // recovery key, so the vault is not said to be the backup's as it is.
        let slot = root.join(HEADER_SLOTS[1]);
        if !made_unreadable(&slot) {
            eprintln!("skipped: file modes do not bind this user");
            return;
        }
        let seen = preview();
        made_readable(&slot);
        assert_eq!(seen.replaces, RestoreReplaces::SameVault);
        assert!(seen.differs_from_this_device);
        // Nor when a manifest slot cannot be read: the older one here, so
        // that the newest still reads as the backup's.
        store.unlock(PASSWORD).unwrap();
        let generation = store
            .unlocked
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .manifest
            .generation;
        store.lock();
        let older = manifest_path(&root, generation + 1);
        assert!(older.exists());
        assert!(made_unreadable(&older));
        let seen = preview();
        made_readable(&older);
        assert!(seen.differs_from_this_device);
        assert!(!preview().differs_from_this_device);
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
    fn a_restore_whose_copy_could_not_be_moved_aside_is_still_discarded() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (store, backup) = changed_since_its_backup(&root);
        {
            let _failing = FailAt::all(&["restore.before-activate", "restore.before-unstage"]);
            assert!(matches!(
                store.restore(
                    Cursor::new(backup),
                    RestoreCredential::Passphrase(PASSWORD),
                    true
                ),
                Err(VaultError::NoSpace)
            ));
        }
        // Removed where it was, header first: reported as failed, and
        // nothing waits for a start.
        assert!(restore_leftovers(&root).is_empty());
        let restarted = VaultStore::new(root);
        restarted.unlock(PASSWORD).unwrap();
        assert_eq!(restarted.snapshot().unwrap().records.len(), 3);
    }

    #[test]
    fn a_restore_whose_copy_could_not_be_removed_finishes_at_the_next_start() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (store, backup) = changed_since_its_backup(&root);
        {
            let _failing = FailAt::all(&[
                "restore.before-activate",
                "restore.before-unstage",
                "restore.before-envelope-removal",
            ]);
            assert!(matches!(
                store.restore(
                    Cursor::new(backup),
                    RestoreCredential::Passphrase(PASSWORD),
                    true
                ),
                Err(VaultError::RestoreUnfinished)
            ));
        }
        // The copy is left whole, not half removed, and the next start puts
        // it in place, as the patient was told.
        assert_eq!(restore_leftovers(&root).len(), 1);
        let restarted = VaultStore::new(root.clone());
        restarted.unlock(PASSWORD).unwrap();
        assert_eq!(restarted.snapshot().unwrap().records.len(), 2);
        assert!(restore_leftovers(&root).is_empty());
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
    fn a_restore_cut_short_finishes_and_the_vault_it_replaced_stays_set_aside() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (_, backup, _) = backed_up_vault(&root);
        let file = temp.path().join("backup.mycarlosbackup");
        fs::write(&file, &backup).unwrap();
        run_restore_termination_child(&root, &file, "restore.after-retire");
        assert!(!root.exists());
        assert_eq!(set_aside_folders(&root).len(), 1);

        // The next start puts the restored vault in place; the one it
        // replaced stays set aside, and still opens.
        let restarted = VaultStore::new(root.clone());
        assert_eq!(restarted.status().unwrap(), VaultStatus::Locked);
        restarted.unlock(PASSWORD).unwrap();
        let entries = history_events(&restarted);
        let restore = &entries[entries.len() - 2];
        assert_eq!(
            (restore.event, restore.how.as_deref()),
            (HistoryEvent::BackupRestored, Some("replaced"))
        );
        let folders = set_aside_folders(&root);
        assert_eq!(folders.len(), 1);
        VaultStore::new(folders[0].clone())
            .unlock(PASSWORD)
            .unwrap();
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
        remove_key_envelopes(&root, Removable::RestoreStage).unwrap();
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

        assert!(remove_key_envelopes(&root, Removable::RestoreStage).is_err());
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

        let removed = remove_shown(&store).unwrap();

        assert_eq!(removed, vec![imported[1]]);
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.recovery, None);
        // The lost one is hidden as damaged, not dropped (#71).
        let visible: Vec<_> = snapshot
            .records
            .iter()
            .filter(|record| record.hidden.is_none())
            .collect();
        assert_eq!(visible.len(), 1);
        assert!(visible[0].available);
        let lost = snapshot
            .records
            .iter()
            .find(|record| record.id == imported[1])
            .unwrap();
        assert_eq!(
            lost.hidden.map(|hidden| hidden.reason),
            Some(HiddenReason::Damaged)
        );
        assert!(!lost.available);
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

        let removed = remove_shown(&store).unwrap();

        assert_eq!(removed, vec![imported[0]]);
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.recovery, None);
        // The one still lost is hidden, as damaged; the one that came back
        // stays in view (#71).
        let visible: Vec<_> = snapshot
            .records
            .iter()
            .filter(|record| record.hidden.is_none())
            .collect();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, imported[1]);
        assert!(visible[0].available);
        assert_eq!(damaged(&snapshot), 1);
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

        let mut removed = remove_shown(&store).unwrap();
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
            remove_shown(&store),
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
        assert!(matches!(remove_shown(&store), Err(VaultError::Invalid)));
        for reason in [RecoveryReason::UnreadableSlot, RecoveryReason::WriteFailed] {
            store.unlocked.lock().unwrap().as_mut().unwrap().recovery = Some(reason);
            assert!(matches!(
                remove_shown(&store),
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
            store.hide_record(lost, 3),
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
        let portal_ticket = store.portal_link_ticket();
        assert!(matches!(store.snapshot(), Err(VaultError::Locked)));
        assert_ne!(store.portal_link_ticket(), portal_ticket);
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

    /// Stands in for an objects folder that cannot be searched (a permission
    /// or device error): with a file in its place, looking up any object fails
    /// with an error other than "not found", even for root.
    #[cfg(unix)]
    fn make_objects_unsearchable(root: &Path, aside: &Path) {
        fs::rename(root.join("objects"), aside).unwrap();
        fs::write(root.join("objects"), b"not a folder").unwrap();
    }

    #[cfg(unix)]
    fn restore_objects(root: &Path, aside: &Path) {
        fs::remove_file(root.join("objects")).unwrap();
        fs::rename(aside, root.join("objects")).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn documents_whose_files_cannot_be_looked_up_are_never_offered_for_removal() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let aside = temp.path().join("objects-aside");
        let (store, ids, objects) = vault_with_records(&root, &["a.pdf", "b.pdf"]);
        make_objects_unsearchable(&root, &aside);

        store.unlock(PASSWORD).unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.recovery, Some(RecoveryReason::UnreadableSlot));
        assert!(matches!(
            remove_shown(&store),
            Err(VaultError::RecoveryMode)
        ));
        store.lock();

        // Once the folder can be read again, nothing was removed or deleted.
        restore_objects(&root, &aside);
        store.unlock(PASSWORD).unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.recovery, None);
        let mut found: Vec<Uuid> = snapshot.records.iter().map(|record| record.id).collect();
        found.sort();
        let mut expected = ids.clone();
        expected.sort();
        assert_eq!(found, expected);
        assert!(objects.iter().all(|object| object.is_file()));
    }

    #[cfg(unix)]
    #[test]
    fn removal_keeps_a_document_whose_file_cannot_be_looked_up_by_then() {
        // One file is really gone, so "Remove damaged documents" is offered.
        // Before it runs, the folder becomes unsearchable: the removal must not
        // take that for the other file being gone too.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let aside = temp.path().join("objects-aside");
        let (store, ids, objects) = vault_with_records(&root, &["a.pdf", "b.pdf"]);
        fs::remove_file(&objects[0]).unwrap();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(
            store.snapshot().unwrap().recovery,
            Some(RecoveryReason::LostObjects)
        );

        make_objects_unsearchable(&root, &aside);
        assert!(matches!(
            remove_shown(&store),
            Err(VaultError::RecoveryMode)
        ));
        // The session no longer offers a removal it would refuse.
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.recovery, Some(RecoveryReason::UnreadableSlot));
        // And it shows the file it could not look up as out of reach.
        assert!(snapshot.records.iter().all(|record| !record.available));
        store.lock();
        restore_objects(&root, &aside);

        store.unlock(PASSWORD).unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.recovery, Some(RecoveryReason::LostObjects));
        let kept = snapshot
            .records
            .iter()
            .find(|record| record.id == ids[1])
            .unwrap();
        assert!(kept.available);
        assert!(objects[1].is_file());
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
                full_name: None,
                birth_date: None,
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
                    hidden: None,
                    original_pdf: None,
                    delivery: None,
                })
                .collect(),
            history: HistoryState::default(),
            portal_links: Vec::new(),
        }
    }

    fn authentic(manifest: Manifest, missing: &[&str]) -> SlotReading {
        let missing = manifest
            .records
            .iter()
            .filter(|record| missing.contains(&record.object_name.trim_end_matches(".mcobj")))
            .map(|record| record.id)
            .collect();
        SlotReading::Authentic {
            manifest: Box::new(manifest),
            missing,
            unknown: HashSet::new(),
        }
    }

    #[test]
    fn an_object_that_cannot_be_looked_up_makes_the_slot_unreadable_not_lost() {
        let manifest = manifest_with(Uuid::new_v4(), 2, &["a"]);
        let SlotReading::Authentic { missing, .. } = authentic(manifest.clone(), &["a"]) else {
            unreachable!();
        };
        let slots = [
            SlotReading::Authentic {
                manifest: Box::new(manifest),
                unknown: missing.clone(),
                missing,
            },
            SlotReading::Absent,
        ];
        let selected = select_manifest(&slots).unwrap();
        assert_eq!(selected.recovery, Some(RecoveryReason::UnreadableSlot));
    }

    #[test]
    fn a_newer_generation_is_not_passed_over_for_objects_that_cannot_be_looked_up() {
        // Generation 6 adds "b", which cannot be looked up; generation 5 is
        // complete. Opening 5 would drop "b" from the list though it may be
        // intact, so 6 is opened, read-only.
        let vault_id = Uuid::new_v4();
        let newer = manifest_with(vault_id, 6, &["a", "b"]);
        let unknown: HashSet<Uuid> = newer
            .records
            .iter()
            .filter(|record| record.object_name == "b.mcobj")
            .map(|record| record.id)
            .collect();
        let slots = [
            SlotReading::Authentic {
                manifest: Box::new(newer),
                missing: unknown.clone(),
                unknown: unknown.clone(),
            },
            authentic(manifest_with(vault_id, 5, &["a"]), &[]),
        ];
        let selected = select_manifest(&slots).unwrap();
        assert_eq!(selected.manifest.generation, 6);
        assert_eq!(selected.recovery, Some(RecoveryReason::UnreadableSlot));
        assert_eq!(selected.unavailable, unknown);
    }

    #[test]
    fn removal_takes_only_the_documents_that_were_shown_as_damaged() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let (store, ids, objects) = vault_with_records(&root, &["a.pdf", "b.pdf", "c.pdf"]);
        fs::remove_file(&objects[0]).unwrap();
        store.unlock(PASSWORD).unwrap();
        let shown_damaged = |store: &VaultStore| -> Vec<Uuid> {
            store
                .snapshot()
                .unwrap()
                .records
                .iter()
                .filter(|record| !record.available)
                .map(|record| record.id)
                .collect()
        };
        assert_eq!(shown_damaged(&store), vec![ids[0]]);

        // Another file goes missing after the patient saw "1 damaged".
        fs::remove_file(&objects[1]).unwrap();
        assert!(matches!(
            remove_shown(&store),
            Err(VaultError::RemovalChanged)
        ));
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.records.len(), 3);
        assert_eq!(snapshot.recovery, Some(RecoveryReason::LostObjects));
        // The session now shows both, and a removal agreed to after that
        // takes both and nothing else.
        assert_eq!(shown_damaged(&store).len(), 2);
        let mut removed = remove_shown(&store).unwrap();
        removed.sort();
        let mut expected = vec![ids[0], ids[1]];
        expected.sort();
        assert_eq!(removed, expected);
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.records.len(), 3);
        assert_eq!(
            snapshot
                .records
                .iter()
                .filter(|record| record.hidden.is_none())
                .count(),
            1
        );
        assert!(objects[2].is_file());
    }

    #[cfg(unix)]
    #[test]
    fn a_vault_whose_drive_went_away_is_unreadable_not_empty() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let away = temp.path().join("vault-away");
        let (store, _, objects) = vault_with_records(&root, &["a.pdf", "b.pdf"]);
        fs::remove_file(&objects[0]).unwrap();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(
            store.snapshot().unwrap().recovery,
            Some(RecoveryReason::LostObjects)
        );

        // As when the drive is removed while the vault is open.
        fs::rename(&root, &away).unwrap();
        assert!(matches!(
            remove_shown(&store),
            Err(VaultError::RecoveryMode)
        ));
        assert_eq!(
            store.snapshot().unwrap().recovery,
            Some(RecoveryReason::UnreadableSlot)
        );
        store.lock();
        fs::rename(&away, &root).unwrap();

        store.unlock(PASSWORD).unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.recovery, Some(RecoveryReason::LostObjects));
        assert_eq!(snapshot.records.len(), 2);
        assert!(objects[1].is_file());
    }

    #[test]
    fn removal_refuses_a_confirmation_for_other_documents_than_those_shown() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let (store, ids, objects) = vault_with_records(&root, &["a.pdf", "b.pdf"]);
        fs::remove_file(&objects[0]).unwrap();
        store.unlock(PASSWORD).unwrap();

        // A screen that showed nothing, or more than the vault does.
        for stale in [vec![], vec![ids[0], ids[1]], vec![ids[1]]] {
            assert!(matches!(
                store.hide_unavailable_records(&stale, 3),
                Err(VaultError::RemovalChanged)
            ));
        }
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.records.len(), 2);
        assert_eq!(snapshot.recovery, Some(RecoveryReason::LostObjects));

        assert_eq!(
            store.hide_unavailable_records(&[ids[0]], 3).unwrap(),
            vec![ids[0]]
        );
        assert_eq!(store.snapshot().unwrap().recovery, None);
        assert!(objects[1].is_file());
    }

    #[cfg(unix)]
    #[test]
    fn a_documents_folder_that_may_not_be_searched_is_unreadable() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let (store, ids, _) = vault_with_records(&root, &["a.pdf"]);
        let folder = root.join("objects");
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read_dir(&folder).is_ok() {
            // A privileged process ignores folder modes.
            fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)).unwrap();
            return;
        }
        store.unlock(PASSWORD).unwrap();
        let snapshot = store.snapshot().unwrap();
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(snapshot.recovery, Some(RecoveryReason::UnreadableSlot));
        assert_eq!(snapshot.records.len(), ids.len());
    }

    #[cfg(unix)]
    #[test]
    fn a_documents_folder_behind_a_broken_link_is_unreadable_not_empty() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let aside = temp.path().join("objects-aside");
        let (store, ids, objects) = vault_with_records(&root, &["a.pdf", "b.pdf"]);
        // As when the drive the folder links to is not connected.
        fs::rename(root.join("objects"), &aside).unwrap();
        std::os::unix::fs::symlink(temp.path().join("not-connected"), root.join("objects"))
            .unwrap();

        store.unlock(PASSWORD).unwrap();
        assert_eq!(
            store.snapshot().unwrap().recovery,
            Some(RecoveryReason::UnreadableSlot)
        );
        assert!(matches!(
            remove_shown(&store),
            Err(VaultError::RecoveryMode)
        ));
        store.lock();

        fs::remove_file(root.join("objects")).unwrap();
        fs::rename(&aside, root.join("objects")).unwrap();
        store.unlock(PASSWORD).unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.recovery, None);
        assert_eq!(snapshot.records.len(), ids.len());
        assert!(objects.iter().all(|object| object.is_file()));
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

        assert!(matches!(
            select_manifest(&[SlotReading::Absent, SlotReading::Damaged]),
            Err(VaultError::Corrupt)
        ));
        // A slot that could not be read may hold the vault's state: that is
        // not damage, and may pass.
        for slots in [
            [SlotReading::Damaged, SlotReading::Unreadable],
            [SlotReading::Unreadable, SlotReading::Absent],
            [SlotReading::Unreadable, SlotReading::Unreadable],
        ] {
            assert!(matches!(
                select_manifest(&slots),
                Err(VaultError::Unreadable)
            ));
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

    /// Makes `path` unreadable, or says that it cannot be done here: a
    /// privileged process ignores file modes.
    #[cfg(unix)]
    fn made_unreadable(path: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = fs::read(path).is_err();
        if !unreadable {
            made_readable(path);
        }
        unreadable
    }

    #[cfg(unix)]
    fn made_readable(path: &Path) {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_header_slot_stops_an_unlock_before_it_writes_anything() {
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
        store
            .import(profile, vec![], vec![source("second.pdf", b"second")], 3)
            .unwrap();
        let newest_generation = store
            .unlocked
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .manifest
            .generation;
        store.lock();

        // Everything an unlock would otherwise put right: a manifest slot
        // left behind, a file no document owns, and what interrupted writes
        // leave.
        let stale = usize::try_from((newest_generation + 1) % 2).unwrap();
        let stale_slot = root.join(format!("manifest-{stale}.bin"));
        fs::write(&stale_slot, &older_slots[stale]).unwrap();
        let orphan = root
            .join("objects")
            .join(format!("{}.mcobj", Uuid::new_v4()));
        fs::write(&orphan, b"no document owns this").unwrap();
        fs::create_dir_all(root.join("staging").join("left-over")).unwrap();
        let abandoned = root.join(format!("{ATOMIC_WRITE_PREFIX}left-over"));
        fs::create_dir(&abandoned).unwrap();

        let header_slot = root.join(HEADER_SLOTS[0]);
        let header_before = fs::read(&header_slot).unwrap();
        let other_header_before = fs::read(root.join(HEADER_SLOTS[1])).unwrap();
        if !made_unreadable(&header_slot) {
            eprintln!("skipped: file modes do not bind this user");
            return;
        }

        store.unlock(PASSWORD).unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.recovery, Some(RecoveryReason::UnreadableSlot));
        assert_eq!(snapshot.records.len(), 2);
        store.lock();
        made_readable(&header_slot);

        assert_eq!(fs::read(&stale_slot).unwrap(), older_slots[stale]);
        assert_eq!(fs::read(&header_slot).unwrap(), header_before);
        assert_eq!(
            fs::read(root.join(HEADER_SLOTS[1])).unwrap(),
            other_header_before
        );
        assert!(orphan.exists());
        assert!(root.join("staging").join("left-over").exists());
        assert!(abandoned.exists());

        // Once it can be read, the unlock puts all of it right.
        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.snapshot().unwrap().recovery, None);
        assert_ne!(fs::read(&stale_slot).unwrap(), older_slots[stale]);
        assert!(!orphan.exists());
        assert!(!root.join("staging").join("left-over").exists());
        assert!(!abandoned.exists());
    }

    #[cfg(unix)]
    #[test]
    fn header_slots_that_cannot_be_read_are_not_called_damage_or_a_wrong_passphrase() {
        const REPLACEMENT: &str = "lantern-orbit-willow-cascade-572";
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let key = set_up_recovery_key(&store, 2);
        let older_slots = HEADER_SLOTS.map(|name| fs::read(root.join(name)).unwrap());
        store.change_passphrase(PASSWORD, REPLACEMENT).unwrap();
        store.lock();
        let generation = |slot: usize| {
            let header: VaultHeader =
                serde_json::from_slice(&fs::read(root.join(HEADER_SLOTS[slot])).unwrap()).unwrap();
            header.generation
        };
        // The change landed in one slot only, and that slot cannot be read:
        // the header that can be read still holds the old passphrase.
        let first_write = usize::from(generation(1) < generation(0));
        fs::write(
            root.join(HEADER_SLOTS[1 - first_write]),
            &older_slots[1 - first_write],
        )
        .unwrap();
        let newest_slot = root.join(HEADER_SLOTS[first_write]);
        if !made_unreadable(&newest_slot) {
            eprintln!("skipped: file modes do not bind this user");
            return;
        }
        // The new passphrase is right, and must not be called wrong. Nor
        // can a wrong one be told from it.
        for passphrase in [REPLACEMENT, "violet-harbor-mosaic-tundra-381"] {
            assert!(matches!(
                store.unlock(passphrase),
                Err(VaultError::Unreadable)
            ));
        }
        // The old one opens the header that could be read, and changes
        // nothing: not the passphrase, not a recovery key.
        store.unlock(PASSWORD).unwrap();
        assert_eq!(
            store.snapshot().unwrap().recovery,
            Some(RecoveryReason::UnreadableSlot)
        );
        assert!(matches!(
            store.change_passphrase(PASSWORD, "violet-harbor-mosaic-tundra-381"),
            Err(VaultError::RecoveryMode)
        ));
        assert!(matches!(
            store.begin_recovery_key(PASSWORD),
            Err(VaultError::RecoveryMode)
        ));
        store.lock();

        // Neither slot can be read: nothing says the vault is damaged.
        let other_slot = root.join(HEADER_SLOTS[1 - first_write]);
        assert!(made_unreadable(&other_slot));
        assert!(matches!(
            store.unlock(REPLACEMENT),
            Err(VaultError::Unreadable)
        ));
        assert!(matches!(
            store.recover(&key, PASSWORD),
            Err(VaultError::Unreadable)
        ));

        made_readable(&newest_slot);
        made_readable(&other_slot);
        store.unlock(REPLACEMENT).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn an_open_vault_does_not_write_a_header_over_a_slot_it_cannot_read() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let slot = root.join(HEADER_SLOTS[1]);
        let before = fs::read(&slot).unwrap();
        // The slot stops being readable while the vault is open.
        if !made_unreadable(&slot) {
            eprintln!("skipped: file modes do not bind this user");
            return;
        }
        assert!(matches!(
            store.change_passphrase(PASSWORD, "lantern-orbit-willow-cascade-572"),
            Err(VaultError::Unreadable)
        ));
        assert!(matches!(
            store.begin_recovery_key(PASSWORD),
            Err(VaultError::Unreadable)
        ));
        // Nor is a backup made, and the check made before a provider's
        // destination is emptied refuses it too.
        assert!(matches!(
            store.verify_for_backup(),
            Err(VaultError::Unreadable)
        ));
        assert!(matches!(
            store.backup(Vec::new(), 3),
            Err(VaultError::Unreadable)
        ));
        made_readable(&slot);
        assert_eq!(fs::read(&slot).unwrap(), before);
        store.lock();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.snapshot().unwrap().recovery, None);
    }

    #[cfg(unix)]
    #[test]
    fn a_recovery_key_is_not_confirmed_over_a_slot_that_cannot_be_read() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let key = store.begin_recovery_key(PASSWORD).unwrap().to_string();
        let groups = recovery_key_groups(&key);
        let answers = typed_back(&groups);
        let slot = root.join(HEADER_SLOTS[1]);
        let before = fs::read(&slot).unwrap();
        // While the patient writes the key down.
        if !made_unreadable(&slot) {
            eprintln!("skipped: file modes do not bind this user");
            return;
        }
        assert!(matches!(
            store.confirm_recovery_key(&answers, 2),
            Err(VaultError::Unreadable)
        ));
        let mut backup = Vec::new();
        assert!(matches!(
            store.backup(&mut backup, 3),
            Err(VaultError::Unreadable)
        ));
        made_readable(&slot);
        assert_eq!(fs::read(&slot).unwrap(), before);
        // The key is still waiting, and is confirmed once the slot is back.
        store.confirm_recovery_key(&answers, 4).unwrap();
        assert!(store.snapshot().unwrap().recovery_key_set_at_ms.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn damaged_manifests_beside_an_unreadable_header_are_not_called_damage() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let key = set_up_recovery_key(&store, 2);
        store.lock();
        for slot in ["manifest-0.bin", "manifest-1.bin"] {
            fs::write(root.join(slot), b"damaged").unwrap();
        }
        assert!(matches!(store.unlock(PASSWORD), Err(VaultError::Corrupt)));
        let slot = root.join(HEADER_SLOTS[0]);
        if !made_unreadable(&slot) {
            eprintln!("skipped: file modes do not bind this user");
            return;
        }
        assert!(matches!(
            store.unlock(PASSWORD),
            Err(VaultError::Unreadable)
        ));
        assert!(matches!(
            store.recover(&key, "lantern-orbit-willow-cascade-572"),
            Err(VaultError::Unreadable)
        ));
        made_readable(&slot);
    }

    #[cfg(unix)]
    #[test]
    fn a_recovery_with_a_header_slot_unreadable_opens_read_only() {
        const REPLACEMENT: &str = "lantern-orbit-willow-cascade-572";
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let key = set_up_recovery_key(&store, 2);
        store.lock();
        let slot = root.join(HEADER_SLOTS[0]);
        let other = fs::read(root.join(HEADER_SLOTS[1])).unwrap();
        if !made_unreadable(&slot) {
            eprintln!("skipped: file modes do not bind this user");
            return;
        }
        // A key that is not the vault's cannot be told from one that is for
        // the header that could not be read.
        assert!(matches!(
            store.recover("0000-0000-0000-0000-0000-0000-0000", REPLACEMENT),
            Err(VaultError::Unreadable | VaultError::RecoveryKeyTypo)
        ));
        // The vault's key opens it, and the passphrase is not replaced.
        assert!(!store.recover(&key, REPLACEMENT).unwrap());
        assert_eq!(
            store.snapshot().unwrap().recovery,
            Some(RecoveryReason::UnreadableSlot)
        );
        store.lock();
        made_readable(&slot);
        assert_eq!(fs::read(root.join(HEADER_SLOTS[1])).unwrap(), other);
        store.unlock(PASSWORD).unwrap();
    }

    #[test]
    fn a_wrong_passphrase_is_still_called_wrong_when_every_header_was_read() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        store.lock();
        assert!(matches!(
            store.unlock("lantern-orbit-willow-cascade-572"),
            Err(VaultError::WrongPassphrase)
        ));
        // A slot that is gone, or damaged, is not one that could not be read.
        fs::remove_file(root.join(HEADER_SLOTS[0])).unwrap();
        fs::write(root.join(HEADER_SLOTS[1]), b"damaged").unwrap();
        fs::remove_file(root.join(LEGACY_HEADER)).ok();
        assert!(matches!(store.unlock(PASSWORD), Err(VaultError::Corrupt)));
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
    fn hiding_abrupt_termination_matrix_keeps_the_document_and_its_file() {
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

        // Hiding writes no file but the manifest, and removes none (#71).
        for boundary in ["manifest.after-first-write", "manifest.after-second-write"] {
            let root = temp.path().join(boundary);
            copy_directory(&template, &root);
            run_termination_child(&root, "hide", boundary);

            let restarted = VaultStore::new(root.clone());
            restarted.unlock(PASSWORD).unwrap();
            let records = restarted.snapshot().unwrap().records;
            assert_eq!(records.len(), 1);
            assert!(records[0].hidden.is_some());
            assert_eq!(document_files(&root), 1);
        }
    }

    #[test]
    fn injected_no_space_hiding_failures_recover_without_half_hidden_records() {
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

        for (boundary, hidden) in [
            ("manifest.before-first-write", false),
            ("manifest.after-first-write", true),
        ] {
            let root = temp.path().join(boundary);
            copy_directory(&template, &root);
            run_failure_child(&root, "hide", boundary);

            let restarted = VaultStore::new(root.clone());
            restarted.unlock(PASSWORD).unwrap();
            let records = restarted.snapshot().unwrap().records;
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].hidden.is_some(), hidden);
            // The file stays either way (#71).
            assert_eq!(document_files(&root), 1);
        }
    }

    #[test]
    fn hiding_a_record_keeps_it_its_key_and_its_file_in_both_slots() {
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

        let bytes = fs::read(root.join("objects").join(&object_name)).unwrap();
        store.hide_record(record, 7).unwrap();
        let hidden = store.snapshot().unwrap().records;
        assert_eq!(hidden.len(), 1);
        assert_eq!(
            hidden[0].hidden,
            Some(Hidden {
                at_ms: 7,
                reason: HiddenReason::Patient
            })
        );
        // Nothing is ever deleted (#71): the file is there, byte for byte.
        assert_eq!(
            fs::read(root.join("objects").join(&object_name)).unwrap(),
            bytes
        );

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
        // Both slots hold the document, its key and its hidden mark.
        let fallback = read_latest_manifest(&root, &master_key, vault_id).unwrap();
        assert_eq!(fallback.records.len(), 1);
        assert!(fallback.records[0].hidden.is_some());

        // Restored, it is in view again, with the same file.
        store.unhide_record(record).unwrap();
        assert!(store.snapshot().unwrap().records[0].hidden.is_none());
    }

    /// A vault as an earlier build left it: both manifest slots `format`,
    /// with no history; a format 1 one unpadded, a format 2 one with its
    /// first document hidden. Returns its master key and id, for reading the
    /// slots back without an unlock, which would upgrade it.
    fn old_format_vault(
        root: &Path,
        names: &[&str],
        format: u32,
    ) -> (VaultStore, Vec<Uuid>, [u8; 32], Uuid) {
        let (store, imported, _) = vault_with_records(root, names);
        store.unlock(PASSWORD).unwrap();
        let (master_key, mut manifest) = {
            let guard = store.unlocked.lock().unwrap();
            let unlocked = guard.as_ref().unwrap();
            (*unlocked.master_key, unlocked.manifest.clone())
        };
        store.lock();
        manifest.format_version = format;
        if format == MANIFEST_FORMAT_HIDDEN {
            manifest.records[0].hidden = Some(Hidden {
                at_ms: 5,
                reason: HiddenReason::Patient,
            });
        }
        // An earlier build kept no history: its segments go, as if never
        // written.
        for segment in std::mem::take(&mut manifest.history).segments {
            fs::remove_file(root.join("objects").join(segment.object_name)).unwrap();
        }
        for _ in 0..2 {
            manifest.generation += 1;
            write_manifest_at(root, &master_key, &manifest).unwrap();
        }
        let vault_id = manifest.vault_id;
        (store, imported, master_key, vault_id)
    }

    /// Both slots, decrypted: (format, generation, the state without them or
    /// the history, which every writable unlock adds to).
    fn slots(root: &Path, master_key: &[u8; 32], vault_id: Uuid) -> Vec<(u32, u64, Manifest)> {
        let keys = derive_keys(vault_id, master_key).unwrap();
        (0..2)
            .map(|slot| {
                let data = fs::read(manifest_path(root, slot)).unwrap();
                let mut manifest = decrypt_manifest(&data, &keys.manifest, vault_id).unwrap();
                let (format, generation) = (manifest.format_version, manifest.generation);
                manifest.format_version = 0;
                manifest.generation = 0;
                manifest.history = HistoryState::default();
                (format, generation, manifest)
            })
            .collect()
    }

    /// The events in the session's history, from its segments.
    #[test]
    fn a_photo_from_the_camera_is_recorded_as_one() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store
            .create("river-azimuth-cobalt-sparrow-934", "FAKE Patient", 1)
            .unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let source = |name: &str| ImportSource {
            display_name: name.to_owned(),
            reader: Box::new(std::io::Cursor::new(
                format!("%PDF-1.7 {name}").into_bytes(),
            )),
        };
        store
            .import_from(profile, vec![], vec![source("FAKE photo.jpg")], 2, "camera")
            .unwrap();
        store
            .import(profile, vec![], vec![source("FAKE scan.pdf")], 3)
            .unwrap();
        let hows: Vec<_> = history_events(&store)
            .into_iter()
            .filter(|entry| entry.event == HistoryEvent::Imported)
            .map(|entry| (entry.name, entry.how))
            .collect();
        assert_eq!(
            hows,
            vec![
                (Some("FAKE photo.jpg".to_owned()), Some("camera".to_owned())),
                (Some("FAKE scan.pdf".to_owned()), Some("picked".to_owned())),
            ]
        );
    }

    fn history_events(store: &VaultStore) -> Vec<HistoryEntry> {
        super::history_events_for_test(store)
    }

    fn events_of(entries: &[HistoryEntry]) -> Vec<HistoryEvent> {
        entries.iter().map(|entry| entry.event).collect()
    }

    #[test]
    fn an_older_vault_opens_and_is_upgraded_in_a_commit_of_its_own() {
        let temp = tempfile::tempdir().unwrap();
        for from in [MANIFEST_FORMAT_V1, MANIFEST_FORMAT_HIDDEN] {
            let root = temp.path().join(format!("format-{from}"));
            let (store, imported, master_key, vault_id) =
                old_format_vault(&root, &["a.pdf", "b.pdf"], from);
            let before = slots(&root, &master_key, vault_id);
            assert!(before.iter().all(|(format, _, _)| *format == from));
            store.unlock(PASSWORD).unwrap();
            let snapshot = store.snapshot().unwrap();
            assert_eq!(snapshot.recovery, None);
            assert_eq!(snapshot.records.len(), imported.len());
            // Both slots are format 3 and hold the same state: nothing but
            // the format, the generation and the history changed.
            let both = slots(&root, &master_key, vault_id);
            assert!(both.iter().all(|(format, _, _)| *format == VAULT_FORMAT));
            assert!(both[0].2 == before[0].2 && both[1].2 == before[0].2);
            // Padded to a size class (#71).
            for slot in 0..2 {
                let length = fs::metadata(manifest_path(&root, slot)).unwrap().len() as usize;
                let plaintext = length - 40;
                assert!(plaintext.is_power_of_two() && plaintext >= MANIFEST_SIZE_CLASS_MIN);
            }
            // Its history starts at this unlock, and says so.
            let entries = history_events(&store);
            assert_eq!(
                events_of(&entries),
                [HistoryEvent::HistoryStarted, HistoryEvent::Unlocked]
            );
            // Hiding now writes format 3 data on top.
            store.hide_record(imported[1], 9).unwrap();
            store.lock();
            store.unlock(PASSWORD).unwrap();
            let records = store.snapshot().unwrap().records;
            assert!(records
                .iter()
                .find(|record| record.id == imported[1])
                .unwrap()
                .hidden
                .is_some());
        }
    }

    #[test]
    fn a_crash_between_the_upgrade_writes_leaves_nothing_an_older_build_could_lose() {
        let temp = tempfile::tempdir().unwrap();
        for from in [MANIFEST_FORMAT_V1, MANIFEST_FORMAT_HIDDEN] {
            let template = temp.path().join(format!("template-{from}"));
            let (_store, imported, master_key, vault_id) =
                old_format_vault(&template, &["a.pdf", "b.pdf"], from);
            let before = slots(&template, &master_key, vault_id);
            assert!(before.iter().all(|(format, _, _)| *format == from));

            for boundary in ["upgrade.after-first-write", "upgrade.after-second-write"] {
                let root = temp.path().join(format!("{from}-{boundary}"));
                copy_directory(&template, &root);
                run_termination_child(&root, "unlock", boundary);
                let after = slots(&root, &master_key, vault_id);
                // Whatever the slots hold now, it is the state from before the
                // upgrade, with no history: an older build that opens the
                // older slot, and drops as orphans the objects only the other
                // slot names, loses nothing.
                assert!(after.iter().all(|(_, _, state)| *state == before[0].2));
                let keys = derive_keys(vault_id, &master_key).unwrap();
                for slot in 0..2 {
                    let data = fs::read(manifest_path(&root, slot)).unwrap();
                    let manifest = decrypt_manifest(&data, &keys.manifest, vault_id).unwrap();
                    assert!(manifest.history.is_empty(), "{from} {boundary}");
                }
                let formats: Vec<u32> = after.iter().map(|(format, _, _)| *format).collect();
                if boundary == "upgrade.after-first-write" {
                    assert!(formats.contains(&from) && formats.contains(&VAULT_FORMAT));
                } else {
                    assert_eq!(formats, [VAULT_FORMAT, VAULT_FORMAT]);
                }
                // This build opens it, finishes the upgrade, and has
                // everything, with a history from here on.
                let restarted = VaultStore::new(root.clone());
                restarted.unlock(PASSWORD).unwrap();
                let snapshot = restarted.snapshot().unwrap();
                assert_eq!(snapshot.recovery, None);
                assert_eq!(snapshot.records.len(), imported.len());
                assert_eq!(
                    events_of(&history_events(&restarted)),
                    [HistoryEvent::HistoryStarted, HistoryEvent::Unlocked]
                );
                restarted.lock();
                assert!(slots(&root, &master_key, vault_id)
                    .iter()
                    .all(|(format, _, state)| *format == VAULT_FORMAT && *state == before[0].2));
            }
        }
    }

    #[test]
    fn an_upgrade_that_cannot_write_leaves_the_vault_read_only_and_whole() {
        let temp = tempfile::tempdir().unwrap();
        for (from, boundary) in [
            (MANIFEST_FORMAT_V1, "upgrade.before-first-write"),
            (MANIFEST_FORMAT_V1, "upgrade.after-first-write"),
            (MANIFEST_FORMAT_HIDDEN, "upgrade.before-first-write"),
            (MANIFEST_FORMAT_HIDDEN, "upgrade.after-first-write"),
        ] {
            let root = temp.path().join(format!("{from}-{boundary}"));
            let (store, imported, _, _) = old_format_vault(&root, &["a.pdf", "b.pdf"], from);
            {
                let _fail = FailAt::new(boundary);
                store.unlock(PASSWORD).unwrap();
            }
            let snapshot = store.snapshot().unwrap();
            assert_eq!(
                snapshot.recovery,
                Some(RecoveryReason::WriteFailed),
                "{boundary}"
            );
            assert!(matches!(
                store.hide_record(imported[1], 3),
                Err(VaultError::RecoveryMode)
            ));
            store.lock();
            // The next unlock upgrades it.
            store.unlock(PASSWORD).unwrap();
            assert_eq!(store.snapshot().unwrap().recovery, None, "{boundary}");
            store.hide_record(imported[1], 3).unwrap();
        }
    }

    #[test]
    fn format_1_cannot_carry_a_hidden_document_and_a_newer_format_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let (vault_id, mut manifest) = valid_manifest_fixture(temp.path());
        manifest.format_version = MANIFEST_FORMAT_V1;
        assert!(validate_manifest_structure(&manifest, vault_id).is_ok());
        manifest.records[0].hidden = Some(Hidden {
            at_ms: 1,
            reason: HiddenReason::Patient,
        });
        assert!(matches!(
            validate_manifest_structure(&manifest, vault_id),
            Err(VaultError::Corrupt)
        ));
        manifest.format_version = VAULT_FORMAT;
        assert!(validate_manifest_structure(&manifest, vault_id).is_ok());
        manifest.format_version = VAULT_FORMAT + 1;
        assert!(matches!(
            validate_manifest_structure(&manifest, vault_id),
            Err(VaultError::Corrupt)
        ));
    }

    #[test]
    fn a_patient_hidden_missing_file_remains_confirmable_without_other_damaged_hidden_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let ids = store
            .import(
                profile,
                vec![],
                vec![
                    source("later-missing.pdf", b"original bytes"),
                    source("already-damaged.pdf", b"other bytes"),
                ],
                2,
            )
            .unwrap()
            .imported;
        let originals = store.session().as_ref().unwrap().manifest.records.clone();
        let objects: Vec<_> = originals
            .iter()
            .map(|r| root.join("objects").join(&r.object_name))
            .collect();
        let ciphertext = fs::read(&objects[0]).unwrap();
        // A previous recovery already stopped requiring the second file.
        fs::remove_file(&objects[1]).unwrap();
        store.lock();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(
            store.hide_unavailable_records(&[ids[1]], 3).unwrap(),
            vec![ids[1]]
        );
        store.hide_record(ids[0], 4).unwrap();
        fs::remove_file(&objects[0]).unwrap();
        store.lock();
        store.unlock(PASSWORD).unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.recovery, Some(RecoveryReason::LostObjects));
        let first = snapshot.records.iter().find(|r| r.id == ids[0]).unwrap();
        assert!(!first.available);
        assert_eq!(first.hidden.unwrap().reason, HiddenReason::Patient);
        assert_eq!(
            store.session().as_ref().unwrap().unavailable,
            HashSet::from([ids[0]])
        );
        // Exactly the patient-hidden blocker is confirmed; the already damaged
        // hidden file must not be rediscovered as a new required blocker.
        assert_eq!(
            store.hide_unavailable_records(&[ids[0]], 5).unwrap(),
            vec![ids[0]]
        );
        assert_eq!(store.snapshot().unwrap().recovery, None);
        let after = store.session().as_ref().unwrap().manifest.records.clone();
        assert_eq!(after.len(), originals.len());
        for (record, original) in after.iter().zip(&originals) {
            let mut expected = original.clone();
            expected.hidden = record.hidden;
            assert!(*record == expected); // Identity, owner, metadata, object and key retained.
            assert_eq!(record.hidden.unwrap().reason, HiddenReason::Damaged);
        }
        // Restoring the original ciphertext recovers the original document.
        fs::write(&objects[0], &ciphertext).unwrap();
        store.lock();
        store.unlock(PASSWORD).unwrap();
        store.unhide_record(ids[0]).unwrap();
        let mut plaintext = Vec::new();
        store.export(ids[0], &mut plaintext).unwrap();
        assert_eq!(plaintext, b"original bytes");
        assert_eq!(fs::read(&objects[0]).unwrap(), ciphertext);
        assert_eq!(store.snapshot().unwrap().records.len(), 2);
    }

    #[test]
    fn a_document_hidden_as_damaged_comes_back_only_with_its_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let (store, imported, objects) = vault_with_records(&root, &["a.pdf", "b.pdf"]);
        let kept = temp.path().join("a.mcobj");
        fs::copy(&objects[0], &kept).unwrap();
        fs::remove_file(&objects[0]).unwrap();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(remove_shown(&store).unwrap(), vec![imported[0]]);
        assert!(matches!(
            store.unhide_record(imported[0]),
            Err(VaultError::Invalid)
        ));
        // A vault that no longer needs the file opens writable without it.
        store.lock();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.snapshot().unwrap().recovery, None);
        // The file came back: the document can be restored, and read.
        fs::copy(&kept, &objects[0]).unwrap();
        let snapshot = store.snapshot().unwrap();
        assert!(
            snapshot
                .records
                .iter()
                .find(|r| r.id == imported[0])
                .unwrap()
                .available
        );
        store.unhide_record(imported[0]).unwrap();
        let mut exported = Vec::new();
        store.export(imported[0], &mut exported).unwrap();
        assert_eq!(exported, b"a.pdf");
    }

    #[test]
    fn a_backup_carries_a_document_hidden_as_damaged_without_its_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let (store, imported, objects) = vault_with_records(&root, &["a.pdf", "b.pdf"]);
        fs::remove_file(&objects[0]).unwrap();
        store.unlock(PASSWORD).unwrap();
        remove_shown(&store).unwrap();
        let mut backup = Vec::new();
        store.backup(&mut backup, 5).unwrap();
        store.lock();

        let other = temp.path().join("other-home").join("vault");
        let restored = VaultStore::new(other.clone());
        restored
            .restore(
                Cursor::new(backup),
                RestoreCredential::Passphrase(PASSWORD),
                false,
            )
            .unwrap();
        restored.unlock(PASSWORD).unwrap();
        let snapshot = restored.snapshot().unwrap();
        assert_eq!(snapshot.recovery, None);
        let lost = snapshot
            .records
            .iter()
            .find(|r| r.id == imported[0])
            .unwrap();
        assert_eq!(lost.hidden.map(|h| h.reason), Some(HiddenReason::Damaged));
        assert!(!lost.available);
        let mut exported = Vec::new();
        restored.export(imported[1], &mut exported).unwrap();
        assert_eq!(exported, b"b.pdf");
    }

    #[test]
    fn an_object_no_manifest_names_is_quarantined_not_deleted() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let (store, _, objects) = vault_with_records(&root, &["a.pdf"]);
        let orphan = root
            .join("objects")
            .join(format!("{}.mcobj", Uuid::new_v4()));
        fs::write(&orphan, b"synthetic orphan ciphertext").unwrap();
        store.unlock(PASSWORD).unwrap();
        assert!(!orphan.exists());
        let quarantined = root.join("quarantine").join(orphan.file_name().unwrap());
        assert_eq!(
            fs::read(&quarantined).unwrap(),
            b"synthetic orphan ciphertext"
        );
        assert!(objects[0].is_file());
        // A backup does not carry it; a later unlock leaves it be.
        store.lock();
        store.unlock(PASSWORD).unwrap();
        assert!(quarantined.is_file());
    }

    /// #71: whatever a session does, no document's encrypted file is ever
    /// removed or changed. A scripted session runs every command that touches
    /// documents, and every object a record ever named is checked byte for
    /// byte at the end.
    #[test]
    fn no_command_removes_or_changes_a_documents_encrypted_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let folder = store
            .create_folder(profile, None, "FAKE Letters", 2)
            .unwrap();
        let imported = store
            .import(
                profile,
                vec![],
                vec![
                    source("one.pdf", b"synthetic one"),
                    source("two.pdf", b"synthetic two"),
                    source("three.pdf", b"synthetic three"),
                ],
                3,
            )
            .unwrap()
            .imported;
        // A duplicate is not added, and nothing it names is touched.
        store
            .import(
                profile,
                vec![],
                vec![source("again.pdf", b"synthetic one")],
                4,
            )
            .unwrap();
        let ever_named = |store: &VaultStore| -> HashMap<String, Vec<u8>> {
            let guard = store.unlocked.lock().unwrap();
            guard
                .as_ref()
                .unwrap()
                .manifest
                .records
                .iter()
                .map(|record| {
                    let path = root.join("objects").join(&record.object_name);
                    (
                        record.object_name.clone(),
                        fs::read(path).unwrap_or_default(),
                    )
                })
                .collect()
        };
        let before = ever_named(&store);
        assert_eq!(before.len(), 3);

        store.rename_record(imported[0], "renamed.pdf").unwrap();
        store.assign_folders(imported[1], vec![folder]).unwrap();
        store
            .assign_folders_batch(imported.clone(), vec![])
            .unwrap();
        store.hide_record(imported[2], 5).unwrap();
        store.unhide_record(imported[2]).unwrap();
        store.hide_record(imported[1], 6).unwrap();
        store
            .export_atomic(imported[0], &temp.path().join("copy.pdf"))
            .unwrap();
        let mut backup = Vec::new();
        store.backup(&mut backup, 7).unwrap();
        store
            .change_passphrase(PASSWORD, PASSPHRASE_REPLACEMENT)
            .unwrap();
        store.lock();
        store.unlock(PASSPHRASE_REPLACEMENT).unwrap();

        let after = ever_named(&store);
        assert_eq!(after, before);
        assert!(after.values().all(|bytes| !bytes.is_empty()));
        // And nothing else was quarantined along the way.
        assert!(!root.join("quarantine").exists());
    }

    #[test]
    fn hiding_a_missing_record_does_not_change_the_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let before = {
            let guard = store.unlocked.lock().unwrap();
            guard.as_ref().unwrap().manifest.generation
        };

        assert!(matches!(
            store.hide_record(Uuid::new_v4(), 3),
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
    fn the_setup_checklist_answers_each_rule_as_the_vault_judges_it() {
        // (#69) The checklist and the vault are one judgement: a passphrase
        // meets all three rules exactly when the vault accepts it.
        let name = ["Jamie Rivers"];
        for (passphrase, long_enough, not_a_name, hard_to_guess) in [
            ("river azimuth cobalt sparrow 934", true, true, true),
            // Each rule is answered on its own: short, yet hard to guess.
            ("short phrase!!", false, true, true),
            ("passwordpassword", true, true, false),
            ("lantern jamie orbit willow 572", true, false, true),
            ("RIVERS of azimuth cobalt 934", true, false, true),
            ("jamie", false, false, false),
        ] {
            let rules = judge_new_passphrase(passphrase, &name, false).unwrap();
            assert_eq!(
                rules,
                PassphraseRules {
                    long_enough,
                    not_a_name,
                    hard_to_guess,
                },
                "{passphrase}"
            );
            assert_eq!(
                validate_new_passphrase(passphrase, &name).is_ok(),
                long_enough && not_a_name && hard_to_guess,
                "{passphrase}"
            );
        }
        // Refused outright, as the vault refuses them: no answers at all.
        let too_long = "a".repeat(MAX_PASSPHRASE_BYTES + 1);
        for passphrase in ["fifteen chars\nmore", too_long.as_str()] {
            assert!(matches!(
                judge_new_passphrase(passphrase, &name, false),
                Err(VaultError::Invalid)
            ));
        }
        // Three answers, named, and nothing else crosses to the renderer.
        let answers = serde_json::to_value(
            judge_new_passphrase("river azimuth cobalt sparrow 934", &name, false).unwrap(),
        )
        .unwrap();
        assert_eq!(
            answers,
            serde_json::json!({ "longEnough": true, "notAName": true, "hardToGuess": true })
        );
    }

    #[test]
    fn the_setup_checklist_answers_only_while_there_is_no_vault() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home").join("vault");
        let store = VaultStore::new(root.clone());
        let rules = store
            .new_passphrase_rules("river azimuth cobalt sparrow 934", "Jamie")
            .unwrap();
        assert!(rules.long_enough && rules.not_a_name && rules.hard_to_guess);
        // Nothing was written by asking.
        assert!(!root.exists());
        assert!(matches!(
            store.new_passphrase_rules("x", &"n".repeat(121 * 4)),
            Err(VaultError::Invalid)
        ));

        // Open, and then locked: it refuses either way.
        store.create(PASSWORD, "Jamie", 1).unwrap();
        assert!(matches!(
            store.new_passphrase_rules("river azimuth cobalt sparrow 934", "Jamie"),
            Err(VaultError::AlreadyExists)
        ));
        store.lock();
        assert!(matches!(
            store.new_passphrase_rules("river azimuth cobalt sparrow 934", "Jamie"),
            Err(VaultError::AlreadyExists)
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
        // Backup and sync tools commonly drop empty directories. With a
        // history (#71) it is never empty, but it can still be lost whole.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store.lock();
        fs::remove_dir_all(root.join("objects")).unwrap();

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
        let measured = benchmark_kdf(&|| true).unwrap();
        println!(
            "mycarlos_argon2id memory_kib={} iterations={} lanes={} samples_ms={:?} median_ms={} max_ms={} release={}",
            measured.memory_kib,
            measured.iterations,
            measured.lanes,
            measured.samples_ms,
            measured.median_ms,
            measured.max_ms,
            measured.release,
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

    // ------------------------------------------------------------ history (#71)

    /// Every file under `root`, read whole.
    fn every_file(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut files = Vec::new();
        let mut folders = vec![root.to_path_buf()];
        while let Some(folder) = folders.pop() {
            for entry in fs::read_dir(&folder).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    folders.push(path);
                } else {
                    files.push((path.clone(), fs::read(&path).unwrap()));
                }
            }
        }
        files
    }

    #[test]
    fn profile_folder_and_passphrase_changes_go_in_the_history() {
        use HistoryEvent::*;
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let key = set_up_recovery_key(&store, 2);
        let sam = store.create_profile("  Sam ", 3).unwrap();
        let heart = store.create_folder(sam, None, "Heart", 4).unwrap();
        let echo = store.create_folder(sam, Some(heart), "Echo", 5).unwrap();
        // A new name and a new place: one entry each.
        store.update_folder(echo, None, " Echoes ").unwrap();
        // Changing nothing records nothing.
        store.update_folder(echo, None, "Echoes").unwrap();
        store
            .change_passphrase(PASSWORD, PASSPHRASE_REPLACEMENT)
            .unwrap();
        let all = history_events(&store);
        let entries = &all[all.len() - 6..];
        assert_eq!(
            events_of(entries),
            [
                ProfileCreated,
                FolderCreated,
                FolderCreated,
                FolderRenamed,
                FolderMoved,
                PassphraseChanged
            ]
        );
        let folder_at = |id, name: &str| history::FolderAtTheTime {
            id,
            name: name.to_owned(),
        };
        let profile = &entries[0];
        assert_eq!(
            (profile.profile_id, profile.name.as_deref(), profile.at_ms),
            (Some(sam), Some("Sam"), 3)
        );
        assert_eq!((profile.folder_id, profile.record_id), (None, None));
        let made = |entry: &HistoryEntry| {
            (
                entry.profile_id,
                entry.folder_id,
                entry.name.clone(),
                entry.to.clone(),
            )
        };
        assert_eq!(
            made(&entries[1]),
            (
                Some(sam),
                Some(heart),
                Some("Heart".to_owned()),
                Some(vec![])
            )
        );
        assert_eq!(
            made(&entries[2]),
            (
                Some(sam),
                Some(echo),
                Some("Echo".to_owned()),
                Some(vec![folder_at(heart, "Heart")])
            )
        );
        assert_eq!(entries[1].from, None);
        let renamed = &entries[3];
        assert_eq!(
            (
                renamed.folder_id,
                renamed.old_name.as_deref(),
                renamed.name.as_deref()
            ),
            (Some(echo), Some("Echo"), Some("Echoes"))
        );
        let moved = &entries[4];
        assert_eq!(
            (moved.folder_id, moved.name.as_deref()),
            (Some(echo), Some("Echoes"))
        );
        assert_eq!(moved.from, Some(vec![folder_at(heart, "Heart")]));
        assert_eq!(moved.to, Some(vec![]));
        assert_eq!(entries[5].how.as_deref(), Some("passphrase"));
        // Nothing about either passphrase goes in.
        for entry in entries {
            let text = String::from_utf8(entry.canonical()).unwrap();
            assert!(!text.contains(PASSWORD) && !text.contains(PASSPHRASE_REPLACEMENT));
        }

        // A forgotten passphrase replaced with the recovery key: the unlock
        // and the change, in one commit, the unlock first.
        store.lock();
        assert!(store
            .recover(&key, "lantern-orbit-willow-cascade-572")
            .unwrap());
        let entries = history_events(&store);
        let last = &entries[entries.len() - 2..];
        assert_eq!(events_of(last), [Unlocked, PassphraseChanged]);
        assert_eq!(last[0].how.as_deref(), Some("recoveryKey"));
        assert_eq!(last[1].how.as_deref(), Some("recoveryKey"));
        let text = String::from_utf8(last[1].canonical()).unwrap();
        assert!(!text.contains("lantern-orbit-willow-cascade-572") && !text.contains(&key));
    }

    #[test]
    fn shared_intake_and_person_move_commit_their_history_without_rewriting_the_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let jamie = store.snapshot().unwrap().profiles[0].id;
        let shared = store.shared_profile().unwrap();
        let id = store
            .import_from(
                shared,
                vec![],
                vec![source("shared.pdf", b"unchanged")],
                2,
                "shared",
            )
            .unwrap()
            .imported[0];
        let imported = history_events(&store).pop().unwrap();
        assert_eq!(imported.event, HistoryEvent::Imported);
        assert_eq!(imported.how.as_deref(), Some("shared"));
        assert_eq!(imported.profile_id, Some(shared));
        let before = store.session().as_ref().unwrap().manifest.clone();
        let record = before.records.iter().find(|r| r.id == id).unwrap();
        let object = root.join("objects").join(&record.object_name);
        let ciphertext = fs::read(&object).unwrap();
        for boundary in [
            "history.after-chunk-write",
            "history.objects-sync",
            "manifest.before-first-write",
        ] {
            {
                let _fail = FailAt::new(boundary);
                assert!(matches!(
                    store.move_to_profile(vec![id], jamie, vec![]),
                    Err(VaultError::NoSpace)
                ));
            }
            assert!(
                store.session().as_ref().unwrap().manifest == before,
                "{boundary}"
            );
            assert_eq!(fs::read(&object).unwrap(), ciphertext);
        }
        store.move_to_profile(vec![id], jamie, vec![]).unwrap();
        let entries = history_events(&store); // Verifies the pinned chain as well.
        let moved = entries.last().unwrap();
        assert_eq!(moved.event, HistoryEvent::Moved);
        assert_eq!(moved.record_id, Some(id));
        assert_eq!(moved.profile_id, Some(jamie));
        assert_eq!(moved.how.as_deref(), Some("shared"));
        // A person changed even when neither location has a folder.
        assert_eq!(moved.from, Some(vec![]));
        assert_eq!(moved.to, Some(vec![]));
        assert_eq!(fs::read(&object).unwrap(), ciphertext);
        let duplicate = store
            .import_from(
                shared,
                vec![],
                vec![source("duplicate.pdf", b"unchanged")],
                3,
                "shared",
            )
            .unwrap()
            .imported[0];
        let before_duplicate = store.session().as_ref().unwrap().manifest.clone();
        assert!(store
            .move_to_profile(vec![duplicate], jamie, vec![])
            .unwrap()
            .moved
            .is_empty());
        assert!(store.session().as_ref().unwrap().manifest == before_duplicate);
        store.lock();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(
            store
                .snapshot()
                .unwrap()
                .records
                .iter()
                .find(|r| r.id == id)
                .unwrap()
                .profile_id,
            jamie
        );
        assert_eq!(fs::read(&object).unwrap(), ciphertext);
        history_events(&store);
    }

    #[test]
    fn every_event_goes_in_the_history_with_what_it_was_about() {
        use HistoryEvent::*;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let folder = store.create_folder(profile, None, "Heart", 2).unwrap();
        let record = store
            .import(profile, vec![], vec![source("scan.pdf", b"fake")], 3)
            .unwrap()
            .imported[0];
        store.rename_record(record, "Echo report.pdf").unwrap();
        store.assign_folders(record, vec![folder]).unwrap();
        // Changing nothing records nothing.
        store.rename_record(record, "Echo report.pdf").unwrap();
        store.assign_folders(record, vec![folder]).unwrap();
        store.hide_record(record, 4).unwrap();
        store.unhide_record(record).unwrap();
        // Copies go outside the vault's home.
        let elsewhere = tempfile::tempdir().unwrap();
        let out = elsewhere.path();
        store.export_atomic(record, &out.join("copy.pdf")).unwrap();
        store.backup_atomic(&out.join("backup.mcbak"), 5).unwrap();
        set_up_recovery_key(&store, 6);

        let entries = history_events(&store);
        assert_eq!(
            events_of(&entries),
            [
                Created,
                FolderCreated,
                Imported,
                Renamed,
                Moved,
                Hidden,
                Restored,
                CopySaved,
                BackupSaved,
                RecoveryKeySet
            ]
        );
        assert!(entries
            .iter()
            .all(|entry| entry.app == env!("CARGO_PKG_VERSION")));
        // The folder's own entry is checked in the next test; the rest are
        // about the document.
        let entries = &entries[1..];
        let about = |index: usize| (entries[index].record_id, entries[index].name.as_deref());
        assert_eq!(about(1), (Some(record), Some("scan.pdf")));
        assert_eq!(entries[1].how.as_deref(), Some("picked"));
        assert_eq!(entries[2].old_name.as_deref(), Some("scan.pdf"));
        assert_eq!(about(2), (Some(record), Some("Echo report.pdf")));
        assert_eq!(entries[3].from, Some(vec![]));
        assert_eq!(
            entries[3].to,
            Some(vec![history::FolderAtTheTime {
                id: folder,
                name: "Heart".to_owned()
            }])
        );
        assert_eq!(
            (entries[4].at_ms, entries[4].how.as_deref()),
            (4, Some("patient"))
        );
        assert_eq!(about(5), (Some(record), Some("Echo report.pdf")));
        assert!(entries[6].place.as_deref().unwrap().ends_with("copy.pdf"));
        assert!(entries[7]
            .place
            .as_deref()
            .unwrap()
            .ends_with("backup.mcbak"));
        assert_eq!(entries[8].at_ms, 6);

        // The next unlock says how the session before it ended: asked for,
        // at the native deadline, or not known to this run of the app.
        store.lock();
        store.unlock(PASSWORD).unwrap();
        let unlocked = history_events(&store).pop().unwrap();
        assert_eq!(
            (unlocked.event, unlocked.how.as_deref()),
            (Unlocked, Some("passphrase"))
        );
        let previous = unlocked.previous_session.unwrap();
        assert!(
            previous.starts_with("lockedAt:") && previous.ends_with(":app"),
            "{previous}"
        );
        assert!(store.lock_if_idle(idle_past(Instant::now())));
        store.unlock(PASSWORD).unwrap();
        let previous = history_events(&store)
            .pop()
            .unwrap()
            .previous_session
            .unwrap();
        assert!(previous.ends_with(":nativeDeadline"), "{previous}");
        drop(store);
        let restarted = VaultStore::new(root.clone());
        restarted.unlock(PASSWORD).unwrap();
        assert_eq!(
            history_events(&restarted)
                .pop()
                .unwrap()
                .previous_session
                .as_deref(),
            Some("notRecorded")
        );
        // Its segments are its own objects, never taken for orphans.
        assert!(!root.join("quarantine").exists());
    }

    #[test]
    fn a_read_only_session_records_nothing_and_the_next_unlock_says_so() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let (store, _, objects) = vault_with_records(&root, &["a.pdf"]);
        store.unlock(PASSWORD).unwrap();
        let before = history_events(&store).len();
        store.lock();
        let aside = temp.path().join("aside");
        fs::rename(&objects[0], &aside).unwrap();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(
            store.snapshot().unwrap().recovery,
            Some(RecoveryReason::LostObjects)
        );
        assert_eq!(history_events(&store).len(), before);
        store.lock();
        fs::rename(&aside, &objects[0]).unwrap();
        store.unlock(PASSWORD).unwrap();
        let entries = history_events(&store);
        assert_eq!(entries.len(), before + 1);
        // How the last recorded session ended, then that one was not.
        let previous = entries.last().unwrap().previous_session.clone().unwrap();
        assert!(
            previous.starts_with("lockedAt:") && previous.ends_with(":app;notRecorded"),
            "{previous}"
        );
    }

    #[test]
    fn a_lock_note_waits_for_an_unlock_that_is_recorded() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        store.lock();
        // The unlock's entry cannot be written: the session opens read-only,
        // and the note of how the session before ended is kept.
        {
            let _fail = FailAt::new("history.objects-sync");
            store.unlock(PASSWORD).unwrap();
        }
        assert_eq!(
            store.snapshot().unwrap().recovery,
            Some(RecoveryReason::WriteFailed)
        );
        assert_eq!(events_of(&history_events(&store)), [HistoryEvent::Created]);
        store.lock();
        store.unlock(PASSWORD).unwrap();
        let previous = history_events(&store)
            .pop()
            .unwrap()
            .previous_session
            .unwrap();
        assert!(
            previous.starts_with("lockedAt:") && previous.ends_with(":app;notRecorded"),
            "{previous}"
        );
        // Used up once recorded: the next lock starts a note of its own.
        store.lock();
        store.unlock(PASSWORD).unwrap();
        let previous = history_events(&store)
            .pop()
            .unwrap()
            .previous_session
            .unwrap();
        assert!(
            previous.starts_with("lockedAt:") && previous.ends_with(":app"),
            "{previous}"
        );
    }

    #[test]
    fn segments_close_by_size_all_look_alike_and_come_in_powers_of_two() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let long = "n".repeat(MAX_RECORD_NAME_LEN);
        let mut shapes = Vec::new();
        for round in 0..3_u64 {
            // A batch of long entries in one commit, as a large import makes.
            {
                let mut guard = store.session();
                let unlocked = guard.as_mut().unwrap();
                let entries = (0..150)
                    .map(|at| {
                        let mut entry = HistoryEntry::new(HistoryEvent::Renamed, round * 1000 + at);
                        entry.name = Some(long.clone());
                        entry.old_name = Some(long.clone());
                        entry
                    })
                    .collect();
                let next = unlocked.manifest.clone();
                assert!(commit_with_history(
                    &root,
                    &unlocked.master_key,
                    &mut unlocked.manifest,
                    next,
                    entries
                )
                .unwrap());
            }
            let state = store.session().as_ref().unwrap().manifest.history.clone();
            let data = state.segments.iter().filter(|s| s.entry_count > 0).count();
            assert_eq!(state.segments.len(), data.next_power_of_two());
            assert!(state.segments[data..]
                .iter()
                .all(|filler| filler.entry_count == 0));
            shapes.push((data, state.segments.len()));
            // Every object on disk is a segment the manifest names, all the
            // same size: a superseded one is gone, a filler looks like data.
            let on_disk: HashSet<String> = fs::read_dir(root.join("objects"))
                .unwrap()
                .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                .collect();
            let named: HashSet<String> = state
                .segments
                .iter()
                .map(|segment| segment.object_name.clone())
                .collect();
            assert_eq!(on_disk, named);
            for name in on_disk {
                assert_eq!(
                    fs::metadata(root.join("objects").join(name)).unwrap().len(),
                    SEGMENT_OBJECT_LEN
                );
            }
        }
        assert_eq!(shapes, [(2, 2), (3, 4), (5, 8)]);
        assert_eq!(history_events(&store).len(), 1 + 450);
    }

    #[test]
    fn a_locked_vault_holds_no_name_from_its_history_in_the_clear() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let folder = store
            .create_folder(profile, None, "FAKE-Echidna-Folder", 2)
            .unwrap();
        let record = store
            .import(
                profile,
                vec![],
                vec![source("FAKE-Quokka-Report.pdf", b"x")],
                3,
            )
            .unwrap()
            .imported[0];
        store
            .rename_record(record, "FAKE-Wombat-Letter.pdf")
            .unwrap();
        store.assign_folders(record, vec![folder]).unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let out = elsewhere.path().join("FAKE-Platypus-Place");
        fs::create_dir(&out).unwrap();
        store.export_atomic(record, &out.join("copy.pdf")).unwrap();
        store.lock();
        for (path, bytes) in every_file(&root) {
            for needle in ["Quokka", "Wombat", "Echidna", "Platypus", "Jamie"] {
                assert!(
                    !bytes
                        .windows(needle.len())
                        .any(|window| window == needle.as_bytes()),
                    "{needle} in {}",
                    path.display()
                );
            }
        }
    }

    #[test]
    fn a_crash_in_an_unlocks_history_commit_leaves_a_whole_vault_and_chain() {
        let temp = tempfile::tempdir().unwrap();
        let template = temp.path().join("template");
        let (store, _, _) = vault_with_records(&template, &["a.pdf"]);
        store.unlock(PASSWORD).unwrap();
        let before = history_events(&store).len();
        store.lock();
        for (boundary, committed) in [
            ("history.after-chunk-write", false),
            ("history.after-segment-write", false),
            ("manifest.after-first-write", true),
            ("manifest.after-second-write", true),
        ] {
            let root = temp.path().join(boundary);
            copy_directory(&template, &root);
            run_termination_child(&root, "unlock", boundary);
            let restarted = VaultStore::new(root.clone());
            restarted.unlock(PASSWORD).unwrap();
            assert_eq!(restarted.snapshot().unwrap().recovery, None, "{boundary}");
            assert_eq!(restarted.snapshot().unwrap().records.len(), 1);
            // The chain checks; the interrupted unlock is in it only once
            // its commit was durable.
            let entries = history_events(&restarted);
            assert_eq!(
                entries.len(),
                before + usize::from(committed) + 1,
                "{boundary}"
            );
            assert_eq!(document_files(&root), 1);
        }
    }

    #[test]
    fn a_failed_history_write_commits_neither_the_change_nor_its_entry() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let segments =
            |store: &VaultStore| store.session().as_ref().unwrap().manifest.history.clone();
        let before = segments(&store);
        for boundary in [
            "history.after-chunk-write",
            "history.objects-sync",
            "manifest.before-first-write",
        ] {
            {
                let _fail = FailAt::new(boundary);
                assert!(matches!(
                    store.import(profile, vec![], vec![source("a.pdf", b"a")], 2),
                    Err(VaultError::NoSpace)
                ));
            }
            assert!(store.snapshot().unwrap().records.is_empty(), "{boundary}");
            assert!(segments(&store) == before, "{boundary}");
            // Nothing it wrote is left: neither the document nor a segment.
            let on_disk = fs::read_dir(root.join("objects")).unwrap().count();
            assert_eq!(on_disk, before.segments.len(), "{boundary}");
        }
        store
            .import(profile, vec![], vec![source("a.pdf", b"a")], 2)
            .unwrap();
        assert_eq!(
            events_of(&history_events(&store)),
            [HistoryEvent::Created, HistoryEvent::Imported]
        );
    }

    #[test]
    fn a_restore_goes_in_the_restored_vaults_history_and_an_unlock_is_no_change() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("home-a").join("vault");
        let (store, backup, _) = backed_up_vault(&root);
        // Opened since the backup: only the history moved on, which is not
        // a change restoring would lose.
        store.unlock(PASSWORD).unwrap();
        store.lock();
        let preview = store
            .inspect_backup(
                Cursor::new(backup.clone()),
                RestoreCredential::Passphrase(PASSWORD),
            )
            .unwrap();
        assert_eq!(preview.replaces, RestoreReplaces::SameVault);
        assert!(!preview.differs_from_this_device);
        // A real change still counts.
        store.unlock(PASSWORD).unwrap();
        let record = store.snapshot().unwrap().records[0].id;
        store.rename_record(record, "renamed.pdf").unwrap();
        store.lock();
        let preview = store
            .inspect_backup(
                Cursor::new(backup.clone()),
                RestoreCredential::Passphrase(PASSWORD),
            )
            .unwrap();
        assert!(preview.differs_from_this_device);

        // Restored elsewhere: the backup's history, then the restore.
        let fresh = VaultStore::new(temp.path().join("home-b").join("vault"));
        fresh
            .restore(
                Cursor::new(backup),
                RestoreCredential::Passphrase(PASSWORD),
                false,
            )
            .unwrap();
        fresh.unlock(PASSWORD).unwrap();
        let entries = history_events(&fresh);
        assert_eq!(entries[0].event, HistoryEvent::Created);
        assert_eq!(
            events_of(&entries[entries.len() - 2..]),
            [HistoryEvent::BackupRestored, HistoryEvent::Unlocked]
        );
        // A device with no vault: none was replaced.
        assert_eq!(entries[entries.len() - 2].how, None);
    }

    #[test]
    fn a_damaged_last_segment_is_kept_and_the_history_goes_on_in_a_new_one() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = VaultStore::new(root.clone());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let first = store.session().as_ref().unwrap().manifest.history.segments[0].clone();
        store.lock();
        let path = root.join("objects").join(&first.object_name);
        let mut bytes = fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        fs::write(&path, bytes).unwrap();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.snapshot().unwrap().recovery, None);
        let state = store.session().as_ref().unwrap().manifest.history.clone();
        // The damaged one is still named, and kept; the unlock is in a new one.
        assert!(state.segments[0] == first);
        assert!(path.exists());
        assert_eq!(state.count, 2);
        assert_eq!(state.segments[1].first_seq, 1);
        assert_eq!(state.segments[1].entry_count, 1);
    }

    #[test]
    fn the_history_test_vectors_match_vault_format_md() {
        let vault_id = Uuid::parse_str("00112233-4455-6677-8899-aabbccddeeff").unwrap();
        let genesis = history::genesis(vault_id);
        let mut entries = vec![HistoryEntry::new(HistoryEvent::Created, 1_767_225_600_000)];
        entries[0].app = "0.1.0".to_owned();
        let mut renamed = HistoryEntry::new(HistoryEvent::Renamed, 1_767_225_660_000);
        renamed.app = "0.1.0".to_owned();
        renamed.record_id = Some(Uuid::parse_str("10000000-0000-4000-8000-000000000001").unwrap());
        renamed.name = Some("Écho \"cardiaque\".pdf".to_owned());
        renamed.old_name = Some("scan.pdf".to_owned());
        entries.push(renamed);
        let head = history::chain(&mut entries, 0, genesis.clone());
        let canonical: Vec<String> = entries
            .iter()
            .map(|entry| String::from_utf8(entry.canonical()).unwrap())
            .collect();
        let documented = include_str!("../../VAULT_FORMAT.md");
        for value in [
            &genesis,
            &canonical[0],
            &entries[0].hash(),
            &canonical[1],
            &head,
        ] {
            assert!(documented.contains(value.as_str()), "{value}");
        }
    }
    fn identity_details() -> ProfileDetails {
        ProfileDetails {
            full_name: Some("  FAKE Mary Smith  ".into()),
            birth_date: Some("1958-03-12".into()),
        }
    }

    #[test]
    fn identity_details_persist_encrypt_restore_and_keep_history_private() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        let now = 1_792_713_600_000;
        let today = utc_date_text(now);
        store.create(PASSWORD, "FAKE Mary", now).unwrap();
        let id = store.snapshot().unwrap().profiles[0].id;
        store
            .update_profile_details(id, identity_details(), &today, now)
            .unwrap();
        let entry = history_events(&store).pop().unwrap();
        assert_eq!(entry.event, HistoryEvent::ProfileDetailsChanged);
        assert_eq!(entry.profile_id, Some(id));
        assert_eq!(entry.name, None);
        assert_eq!(entry.old_name, None);
        let json = serde_json::to_string(&entry).unwrap();
        assert!(!json.contains("Mary") && !json.contains("1958"));
        let count = history_events(&store).len();
        store
            .update_profile_details(id, identity_details(), &today, now)
            .unwrap();
        assert_eq!(history_events(&store).len(), count);
        let mut backup = Vec::new();
        store.backup(&mut backup, now).unwrap();
        store.lock();
        store.unlock(PASSWORD).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].clone();
        assert_eq!(profile.full_name.as_deref(), Some("FAKE Mary Smith"));
        assert_eq!(profile.birth_date.as_deref(), Some("1958-03-12"));
        for slot in 0..2 {
            let bytes = fs::read(manifest_path(&store.root, slot)).unwrap();
            assert!(!bytes.windows(15).any(|w| w == b"FAKE Mary Smith"));
        }
        let restored = VaultStore::new(temp.path().join("restored").join("vault"));
        restored
            .restore(
                Cursor::new(backup),
                RestoreCredential::Passphrase(PASSWORD),
                false,
            )
            .unwrap();
        restored.unlock(PASSWORD).unwrap();
        assert!(restored.snapshot().unwrap().profiles[0] == profile);
        restored
            .update_profile_details(id, ProfileDetails::default(), &today, now)
            .unwrap();
        let cleared = &restored.snapshot().unwrap().profiles[0];
        assert!(cleared.full_name.is_none() && cleared.birth_date.is_none());
    }

    #[test]
    fn identity_details_validate_and_refuse_read_only_or_shared_changes() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        let now = 1_792_713_600_000;
        let today = utc_date_text(now);
        store.create(PASSWORD, "FAKE Mary", now).unwrap();
        let id = store.snapshot().unwrap().profiles[0].id;
        for date in [
            "1900-02-29",
            "2000-02-30",
            "2026-13-01",
            "0000-01-01",
            "03/12/1958",
            "2999-01-01",
        ] {
            assert!(matches!(
                store.update_profile_details(
                    id,
                    ProfileDetails {
                        full_name: None,
                        birth_date: Some(date.into())
                    },
                    &today,
                    now
                ),
                Err(VaultError::Invalid)
            ));
        }
        assert!(valid_birth_date("2000-02-29"));
        assert!(valid_birth_date("0001-01-01"));
        assert!(store
            .update_profile_details(id, identity_details(), "2999-01-01", now)
            .is_err());
        assert!(store
            .update_profile_details(
                store.snapshot().unwrap().shared_profile_id,
                identity_details(),
                &today,
                now
            )
            .is_err());
        store.session().as_mut().unwrap().recovery = Some(RecoveryReason::LostObjects);
        let before = history_events(&store).len();
        assert!(matches!(
            store.update_profile_details(id, identity_details(), &today, now),
            Err(VaultError::RecoveryMode)
        ));
        assert!(matches!(
            store.create_profile_with_details("FAKE New", identity_details(), &today, now),
            Err(VaultError::RecoveryMode)
        ));
        assert_eq!(history_events(&store).len(), before);
        assert!(store.snapshot().unwrap().profiles[0].full_name.is_none());
    }

    #[test]
    fn identity_details_and_history_commit_together_or_neither() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        let now = 1_792_713_600_000;
        let today = utc_date_text(now);
        store.create(PASSWORD, "FAKE Mary", now).unwrap();
        let id = store.snapshot().unwrap().profiles[0].id;
        let count = history_events(&store).len();
        for boundary in [
            "history.after-chunk-write",
            "history.objects-sync",
            "manifest.before-first-write",
        ] {
            let _fail = FailAt::new(boundary);
            assert!(store
                .update_profile_details(id, identity_details(), &today, now)
                .is_err());
            assert!(store.snapshot().unwrap().profiles[0].full_name.is_none());
            assert_eq!(history_events(&store).len(), count);
        }
    }

    #[test]
    fn identity_details_create_atomically_and_old_formats_reject_fields() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        let now = 1_792_713_600_000;
        store.create(PASSWORD, "FAKE First", now).unwrap();
        let id = store
            .create_profile_with_details("FAKE Mary", identity_details(), &utc_date_text(now), now)
            .unwrap();
        let profile = store
            .snapshot()
            .unwrap()
            .profiles
            .into_iter()
            .find(|p| p.id == id)
            .unwrap();
        assert_eq!(profile.full_name.as_deref(), Some("FAKE Mary Smith"));
        let manifest = store.session().as_ref().unwrap().manifest.clone();
        for version in [1, 2, 3] {
            let mut old = manifest.clone();
            old.format_version = version;
            old.history = HistoryState::default();
            assert!(validate_manifest_structure(&old, old.vault_id).is_err());
        }
        for field in ["fullName", "birthDate"] {
            let mut value = serde_json::to_value(&profile).unwrap();
            value[field] = serde_json::Value::Null;
            assert!(serde_json::from_value::<PatientProfile>(value).is_err());
        }
    }

    #[test]
    fn identity_survives_migration_of_all_older_formats_without_record_loss() {
        let temp = tempfile::tempdir().unwrap();
        for version in [1, 2, 3, 4, 5, 6] {
            let root = temp.path().join(format!("v{version}"));
            let (store, ids, key, vault_id) =
                old_format_vault(&root, &["FAKE a.pdf", "FAKE b.pdf"], version);
            let before = slots(&root, &key, vault_id);
            store.unlock(PASSWORD).unwrap();
            let after = slots(&root, &key, vault_id);
            assert!(after.iter().all(|(format, _, _)| *format == VAULT_FORMAT));
            assert!(after.iter().all(|(_, _, state)| *state == before[0].2));
            assert_eq!(store.snapshot().unwrap().records.len(), ids.len());
            assert!(store
                .snapshot()
                .unwrap()
                .profiles
                .iter()
                .all(|p| p.full_name.is_none() && p.birth_date.is_none()));
        }
    }
    #[test]
    fn suggestion_reads_keep_the_idle_deadline_and_normal_exports_report_progress() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "FAKE Mary", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let payload = b"FAKE authenticated document contents";
        let record = store
            .import(profile, vec![], vec![source("FAKE.pdf", payload)], 2)
            .unwrap()
            .imported[0];
        let before = Instant::now() - Duration::from_secs(1);
        store.idle().arm(before);
        let due = before + Duration::from_secs(15 * 60) + crate::idle::MARGIN;
        assert!(store.idle().is_due(due));
        let mut read = Vec::new();
        store.read_for_suggestion(record, &mut read).unwrap();
        assert_eq!(read, payload);
        assert!(
            store.idle().is_due(due),
            "background reading must not postpone auto-lock"
        );
        store.export(record, io::sink()).unwrap();
        assert!(
            !store.idle().is_due(due),
            "patient exports still count as progress"
        );
        store.cancel_io.store(true, Ordering::Release);
        assert!(store.read_for_suggestion(record, io::sink()).is_err());
        store.cancel_io.store(false, Ordering::Release);
        store.lock();
        assert!(matches!(
            store.read_for_suggestion(record, io::sink()),
            Err(VaultError::Locked)
        ));
    }
}

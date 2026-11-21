//! The profile handover package (#360): one person's records in a file of its
//! own, with a key of its own, that another myCarlos can read.
//!
//! This is **not** the vault backup. A backup carries the vault's header, so
//! whoever opens it holds the vault's master key and everything under it. A
//! package is built so that none of the source vault's keys, ids or names are
//! in it: every key here is new, made for this one export, and two exports of
//! the same person differ everywhere.
//!
//! What is reused from the vault, not copied: the chunk format of an object
//! (`MCVO1`, 1 MiB frames, the same associated data, with the **package id in
//! the place of the vault id**), the passphrase rules and key derivation, the
//! recovery-key text for a generated key, and the backup's container shape
//! (framed entries, a trailer that lists them with a SHA-256 each, an HMAC tag).
//!
//! ```text
//! "MYCARLOS-PROFILE"                      16-byte magic, format 1
//! header length (u32) | header JSON       package id, how the key is made, the
//!                                         package key wrapped under it
//! entry*  kind (u8) | name length (u16) | name | length (u64) | bytes
//!         manifest (kind 1, once, first)  encrypted JSON, padded to a size class
//!         object   (kind 2, many)         one MCVO1 object each, in manifest order
//!         digests  (kind 3, once, last)   encrypted: each object's plaintext SHA-256
//! trailer 0xff | length (u32) | JSON {format, packageId, entries[]} | HMAC-SHA-256 tag
//! ```
//!
//! The plaintext hashes are in an entry of their own, **after** the objects,
//! so that a package is written in one pass with no readable copy anywhere:
//! the manifest has to come first (so that it can be inspected without
//! reading the rest) but the hashes are only known once an object has been
//! streamed. They are encrypted so that the file does not let anyone test
//! whether a known document is inside.
//!
//! What stays in the clear, as with a backup: the magic, the package id, the
//! KDF salt, the entry names (a random id each), their lengths and the hashes
//! of their ciphertext. That shows how many documents there are and how large
//! they are. It shows no name, no vault id, no device, no link, no clinic and
//! not even the time of the export.
//!
//! **Nothing read from a package may be trusted before [`PackageReader::finish`]
//! has returned `Ok`**: the trailer's tag, which covers the header and every
//! entry's hash, is the last thing in the file. Each chunk is authenticated as
//! it is read, but the file as a whole is not known to be complete and
//! unaltered until then. A caller stages what it reads and commits after.

use std::{
    collections::{HashMap, HashSet},
    io::{self, Read, Write},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use hmac::Mac;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::{
    decode_recovery_key, derive_passphrase_key, encode_recovery_key, kdf_config_with_salt,
    object_aad, unwrap_secret, valid_birth_date, valid_kdf_config, valid_record_name,
    validate_new_passphrase, wrap_secret, HmacSha256, KdfConfig, SecretKey, VaultError,
    WrappedSecret, CHUNK_SIZE, MAX_PASSPHRASE_BYTES, OBJECT_MAGIC, RECOVERY_KEY_BYTES,
};

/// 16 bytes, like the backup's.
const PACKAGE_MAGIC: &[u8; 16] = b"MYCARLOS-PROFILE";
/// The package format this build writes and reads. A newer number is refused
/// with [`PackageError::NewerFormat`], never read as if it were this one.
pub(crate) const PACKAGE_FORMAT: u32 = 1;

const KIND_MANIFEST: u8 = 1;
const KIND_OBJECT: u8 = 2;
const KIND_DIGESTS: u8 = 3;
const KIND_TRAILER: u8 = 0xff;
const NAME_MANIFEST: &str = "manifest";
const NAME_DIGESTS: &str = "digests";

const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_ENTRY_NAME_BYTES: usize = 64;
/// The padded manifest's largest size class.
const MAX_MANIFEST_CLASS: usize = 64 * 1024 * 1024;
const MIN_MANIFEST_CLASS: usize = 16 * 1024;
/// Documents, original PDFs and AI answers together.
pub(crate) const MAX_PACKAGE_OBJECTS: usize = 200_000;
pub(crate) const MAX_PACKAGE_RECORDS: usize = 100_000;
pub(crate) const MAX_PACKAGE_FOLDERS: usize = 10_000;
pub(crate) const MAX_FOLDER_DEPTH: usize = 64;
pub(crate) const MAX_AI_ANSWERS_PER_RECORD: usize = 256;
pub(crate) const MAX_FOLDERS_PER_RECORD: usize = 1_000;
pub(crate) const MAX_PREVIOUS_NAMES: usize = 64;
pub(crate) const MAX_HISTORY_ENTRIES: usize = 200_000;
/// One document. A terabyte is far beyond what a patient has; the limit keeps
/// a forged size from overflowing arithmetic.
pub(crate) const MAX_OBJECT_BYTES: u64 = 1 << 40;
/// What a record may carry as opaque evidence (the data model's PR types it).
const MAX_CARRIED_BYTES: usize = 256 * 1024;
const MAX_TRAILER_BYTES: usize = 64 * 1024 * 1024;
const MAX_FIELD_CHARS: usize = 240;

const WRAP_AAD: &[u8] = b"mycarlos-profile-package-key-v1:";
const MANIFEST_AAD: &[u8] = b"mycarlos-profile-manifest-v1:";
const DIGESTS_AAD: &[u8] = b"mycarlos-profile-digests-v1:";

/// Every way reading or writing a package can fail. Nothing in one carries a
/// name, a path or a document title.
#[derive(Debug, PartialEq, Eq, Error)]
pub(crate) enum PackageError {
    /// Not a package, cut short, altered, or with something in it that this
    /// format does not allow.
    #[error("the package is unreadable")]
    Unreadable,
    /// The key does not open it. (A damaged header looks the same.)
    #[error("the key is wrong, or the package is damaged")]
    WrongKey,
    /// A typed key that is not a well-formed key, caught before any unwrapping.
    #[error("the key was mistyped")]
    KeyTypo,
    /// Made by a newer myCarlos than this one.
    #[error("the package is from a newer myCarlos")]
    NewerFormat,
    /// What was asked to be written is not valid: a manifest that breaks a
    /// rule, a source that was not the size it was declared to be, an object
    /// out of order, or a passphrase that is not allowed.
    #[error("the package content is not valid")]
    Invalid,
    /// A typed passphrase that breaks the vault's rules for a new one.
    #[error("the passphrase is too weak")]
    WeakPassphrase,
    /// A size, count or length past what a package may hold.
    #[error("the package is too large")]
    TooLarge,
    /// The lock, or a cancel, came before the work was done.
    #[error("cancelled")]
    Cancelled,
    /// Reading or writing failed.
    #[error("storage failed")]
    Storage,
}

impl From<io::Error> for PackageError {
    fn from(error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            Self::Unreadable
        } else {
            Self::Storage
        }
    }
}

impl From<VaultError> for PackageError {
    fn from(error: VaultError) -> Self {
        match error {
            VaultError::WeakPassphrase => Self::WeakPassphrase,
            VaultError::Invalid => Self::Invalid,
            VaultError::Cancelled | VaultError::Locked => Self::Cancelled,
            _ => Self::Storage,
        }
    }
}

// ---------------------------------------------------------------------------
// The manifest: what the package says it holds
// ---------------------------------------------------------------------------

/// The encrypted description of what is in a package. It names no object by
/// file name, key or vault: only by an id made for this package.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PackageManifest {
    pub format: u32,
    pub exported_at_ms: u64,
    pub profile: PackageProfile,
    pub folders: Vec<PackageFolder>,
    pub records: Vec<PackageRecord>,
    /// The history excerpt (#360 Q5), or none when it was switched off.
    /// Entries are carried as JSON, typed by the data model's PR; only their
    /// number is limited here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<Vec<serde_json::Value>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PackageProfile {
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub birth_date: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub previous_full_names: Vec<String>,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PackageFolder {
    pub id: Uuid,
    pub parent_id: Option<Uuid>,
    pub name: String,
    pub created_at_ms: u64,
}

/// One encrypted object in the package: its id (also its entry name) and its
/// size in plaintext bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PackageObject {
    pub id: Uuid,
    pub size: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PackageRecord {
    pub id: Uuid,
    pub name: String,
    pub source_label: String,
    pub media_type: String,
    pub imported_at_ms: u64,
    pub folder_ids: Vec<Uuid>,
    /// Set when the document was hidden by the patient: it arrives hidden.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden_at_ms: Option<u64>,
    /// The file the patient sees.
    pub display: PackageObject,
    /// A PDF's second copy, with its own signature.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_pdf: Option<PackageObject>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ai_answers: Vec<PackageAiAnswer>,
    /// Clinic evidence, public and signed material only. Carried as JSON and
    /// typed by the data-model PR; here only its size is limited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub carried: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PackageAiAnswer {
    pub object: PackageObject,
    pub tool: String,
    pub lang: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub term: Option<String>,
    pub model_name: String,
    pub model_sha256: String,
    pub created_at_ms: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub superseded: bool,
}

impl PackageManifest {
    /// Every object, in the order the package stores them: for each record its
    /// file, its original, then its AI answers.
    pub(crate) fn objects(&self) -> Vec<PackageObject> {
        let mut objects = Vec::new();
        for record in &self.records {
            objects.push(record.display);
            objects.extend(record.original_pdf);
            objects.extend(record.ai_answers.iter().map(|answer| answer.object));
        }
        objects
    }

    /// The rules every package manifest must meet, on writing and on reading:
    /// the counts and sizes are bounded, the names are names, ids are unique,
    /// every folder has a parent that exists and the tree has no cycle and is
    /// not deeper than [`MAX_FOLDER_DEPTH`], and every record is in folders
    /// that exist.
    pub(crate) fn validate(&self) -> Result<(), PackageError> {
        if self.format != PACKAGE_FORMAT {
            return Err(if self.format > PACKAGE_FORMAT {
                PackageError::NewerFormat
            } else {
                PackageError::Unreadable
            });
        }
        if self.folders.len() > MAX_PACKAGE_FOLDERS
            || self.records.len() > MAX_PACKAGE_RECORDS
            || self
                .history
                .as_ref()
                .is_some_and(|history| history.len() > MAX_HISTORY_ENTRIES)
        {
            return Err(PackageError::TooLarge);
        }
        let profile = &self.profile;
        if !valid_name(&profile.display_name)
            || profile.full_name.as_deref().is_some_and(|n| !valid_name(n))
            || profile
                .birth_date
                .as_deref()
                .is_some_and(|d| !valid_birth_date(d))
            || profile.previous_full_names.len() > MAX_PREVIOUS_NAMES
            || profile.previous_full_names.iter().any(|n| !valid_name(n))
        {
            return Err(PackageError::Invalid);
        }
        let mut folder_ids = HashSet::new();
        for folder in &self.folders {
            if !valid_name(&folder.name) || !folder_ids.insert(folder.id) {
                return Err(PackageError::Invalid);
            }
        }
        let parents: HashMap<Uuid, Option<Uuid>> = self
            .folders
            .iter()
            .map(|folder| (folder.id, folder.parent_id))
            .collect();
        for folder in &self.folders {
            // Walk to the top: a missing parent, a cycle (more steps than
            // folders) or too much depth is refused.
            let mut depth = 1;
            let mut at = folder.parent_id;
            while let Some(parent) = at {
                depth += 1;
                if depth > MAX_FOLDER_DEPTH || depth > parents.len() + 1 {
                    return Err(PackageError::Invalid);
                }
                at = *parents.get(&parent).ok_or(PackageError::Invalid)?;
            }
        }
        let mut record_ids = HashSet::new();
        let mut object_ids = HashSet::new();
        let mut objects = 0_usize;
        for record in &self.records {
            if !record_ids.insert(record.id)
                || !valid_name(&record.name)
                || !valid_field(&record.source_label)
                || !valid_field(&record.media_type)
                || record.folder_ids.len() > MAX_FOLDERS_PER_RECORD
                || record.folder_ids.iter().any(|id| !folder_ids.contains(id))
                || has_duplicates(&record.folder_ids)
                || record.ai_answers.len() > MAX_AI_ANSWERS_PER_RECORD
            {
                return Err(PackageError::Invalid);
            }
            if let Some(carried) = &record.carried {
                let size = serde_json::to_vec(carried).map_err(|_| PackageError::Invalid)?;
                if size.len() > MAX_CARRIED_BYTES {
                    return Err(PackageError::TooLarge);
                }
            }
            for answer in &record.ai_answers {
                if !valid_field(&answer.tool)
                    || !valid_field(&answer.lang)
                    || !valid_field(&answer.model_name)
                    || !valid_field(&answer.model_sha256)
                    || answer.term.as_deref().is_some_and(|t| !valid_field(t))
                {
                    return Err(PackageError::Invalid);
                }
            }
        }
        for object in self.objects() {
            objects += 1;
            if objects > MAX_PACKAGE_OBJECTS {
                return Err(PackageError::TooLarge);
            }
            if object.size > MAX_OBJECT_BYTES {
                return Err(PackageError::TooLarge);
            }
            if !object_ids.insert(object.id) {
                return Err(PackageError::Invalid);
            }
        }
        Ok(())
    }
}

/// A name a person sees: the vault's own rule for a name.
fn valid_name(name: &str) -> bool {
    valid_record_name(name)
}

/// A short label or code that is not a name: bounded, no control characters.
fn valid_field(text: &str) -> bool {
    text.chars().count() <= MAX_FIELD_CHARS && !text.chars().any(char::is_control)
}

fn has_duplicates(ids: &[Uuid]) -> bool {
    let mut seen = HashSet::new();
    ids.iter().any(|id| !seen.insert(*id))
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/// What opens a package.
#[derive(Clone, Copy)]
pub(crate) enum PackageSecret<'a> {
    /// A generated 128-bit key, shown to the person as 7 groups of 4.
    Key(&'a [u8; RECOVERY_KEY_BYTES]),
    /// A passphrase the person typed.
    Passphrase(&'a str),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum KeyKind {
    Key,
    Passphrase,
}

/// A new random key for a package, and the text to show for it. The text is
/// the recovery key's: 26 characters and 2 check characters in 7 groups of 4.
/// Never stored in the vault: if it is lost, the person exports again.
pub(crate) fn generate_package_key() -> (Zeroizing<[u8; RECOVERY_KEY_BYTES]>, Zeroizing<String>) {
    let mut key = Zeroizing::new([0_u8; RECOVERY_KEY_BYTES]);
    OsRng.fill_bytes(key.as_mut());
    let text = encode_recovery_key(&key);
    (key, text)
}

/// Reads a key as typed: case, spaces and dashes do not matter, and the check
/// characters catch a typo before anything is tried.
pub(crate) fn parse_package_key(
    text: &str,
) -> Result<Zeroizing<[u8; RECOVERY_KEY_BYTES]>, PackageError> {
    decode_recovery_key(text).map_err(|_| PackageError::KeyTypo)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageHeader {
    format: u32,
    package_id: Uuid,
    key_kind: KeyKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kdf: Option<KdfConfig>,
    wrapped_package_key: WrappedSecret,
}

struct PackageKeys {
    manifest: SecretKey,
    object: SecretKey,
    tag: SecretKey,
}

fn expand(hkdf: &Hkdf<Sha256>, label: &[u8]) -> Result<SecretKey, PackageError> {
    let mut key = Zeroizing::new([0_u8; 32]);
    hkdf.expand(label, key.as_mut())
        .map_err(|_| PackageError::Storage)?;
    Ok(key)
}

/// Everything below is derived from the one random package key and the package
/// id, with labels of its own. None of it is related to a vault's keys.
fn derive_package_keys(
    package_key: &[u8; 32],
    package_id: Uuid,
) -> Result<PackageKeys, PackageError> {
    let hkdf = Hkdf::<Sha256>::new(Some(package_id.as_bytes()), package_key);
    Ok(PackageKeys {
        manifest: expand(&hkdf, b"mycarlos/profile-package/v1/manifest")?,
        object: expand(&hkdf, b"mycarlos/profile-package/v1/object")?,
        tag: expand(&hkdf, b"mycarlos/profile-package/v1/tag")?,
    })
}

/// The key that wraps the package key: HKDF of a generated key, or Argon2id of
/// a passphrase (the vault's own parameters).
fn wrapping_key(
    secret: PackageSecret<'_>,
    package_id: Uuid,
    kdf: Option<&KdfConfig>,
) -> Result<SecretKey, PackageError> {
    match (secret, kdf) {
        (PackageSecret::Key(key), None) => {
            let hkdf = Hkdf::<Sha256>::new(Some(package_id.as_bytes()), key);
            expand(&hkdf, b"mycarlos/profile-package/v1/key-wrap")
        }
        (PackageSecret::Passphrase(passphrase), Some(config)) => {
            if passphrase.len() > MAX_PASSPHRASE_BYTES {
                return Err(PackageError::WrongKey);
            }
            Ok(derive_passphrase_key(passphrase, config)?)
        }
        _ => Err(PackageError::WrongKey),
    }
}

fn wrap_aad(package_id: Uuid) -> Vec<u8> {
    [WRAP_AAD, package_id.as_bytes()].concat()
}

fn entry_aad(label: &[u8], package_id: Uuid) -> Vec<u8> {
    [label, package_id.as_bytes()].concat()
}

/// A fresh object's key: derived from the package's object key and the object's
/// own id, so the manifest, which comes before the objects, needs to carry no
/// per-object key. Ids are random and a package key is never used twice.
fn object_key(keys: &PackageKeys, object_id: Uuid) -> Result<SecretKey, PackageError> {
    let hkdf = Hkdf::<Sha256>::new(Some(object_id.as_bytes()), &*keys.object);
    expand(&hkdf, b"mycarlos/profile-package/v1/object-key")
}

fn tag_mac(tag_key: &[u8; 32], header: &[u8], trailer: &[u8]) -> Result<HmacSha256, PackageError> {
    let mut mac =
        <HmacSha256 as Mac>::new_from_slice(tag_key).map_err(|_| PackageError::Storage)?;
    mac.update(PACKAGE_MAGIC);
    mac.update(&(header.len() as u32).to_be_bytes());
    mac.update(header);
    mac.update(trailer);
    Ok(mac)
}

// ---------------------------------------------------------------------------
// The trailer
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrailerEntry {
    kind: u8,
    name: String,
    length: u64,
    sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Trailer {
    format: u32,
    package_id: Uuid,
    entries: Vec<TrailerEntry>,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DigestEntry {
    id: Uuid,
    size: u64,
    sha256: String,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Digests {
    objects: Vec<DigestEntry>,
}

fn object_name(id: Uuid) -> String {
    id.simple().to_string()
}

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

/// The bytes an object of `plaintext` bytes takes as an `MCVO1` object: the
/// 25-byte header, then per chunk 4 (length) + 1 (final) + data + 16 (tag). An
/// empty object is one empty final chunk.
pub(crate) fn encrypted_object_len(plaintext: u64) -> Option<u64> {
    let chunk = CHUNK_SIZE as u64;
    let chunks = plaintext.div_ceil(chunk).max(1);
    chunks
        .checked_mul(21)?
        .checked_add(25)?
        .checked_add(plaintext)
}

/// The size class a manifest of `json_len` bytes is padded to: its length
/// prefix included, a power of two, at least 16 KiB.
fn manifest_class(json_len: usize) -> Option<usize> {
    let wanted = json_len.checked_add(4)?.max(MIN_MANIFEST_CLASS);
    let class = wanted.checked_next_power_of_two()?;
    (class <= MAX_MANIFEST_CLASS).then_some(class)
}

fn sealed_len(class: usize) -> u64 {
    // nonce (24) + ciphertext (class) + tag (16)
    (class + 24 + 16) as u64
}

// ---------------------------------------------------------------------------
// Sealing and opening the small entries (manifest, digests)
// ---------------------------------------------------------------------------

fn seal_padded(
    key: &[u8; 32],
    aad: &[u8],
    data: &[u8],
    class: usize,
) -> Result<Vec<u8>, PackageError> {
    let mut plain = Zeroizing::new(vec![0_u8; class]);
    plain[..4].copy_from_slice(
        &u32::try_from(data.len())
            .map_err(|_| PackageError::TooLarge)?
            .to_be_bytes(),
    );
    plain[4..4 + data.len()].copy_from_slice(data);
    let mut nonce = [0_u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let sealed = XChaCha20Poly1305::new(key.into())
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: &plain, aad })
        .map_err(|_| PackageError::Storage)?;
    Ok([nonce.as_slice(), &sealed].concat())
}

fn open_padded(
    key: &[u8; 32],
    aad: &[u8],
    sealed: &[u8],
) -> Result<Zeroizing<Vec<u8>>, PackageError> {
    if sealed.len() < 24 + 16 {
        return Err(PackageError::Unreadable);
    }
    let (nonce, ciphertext) = sealed.split_at(24);
    let plain = Zeroizing::new(
        XChaCha20Poly1305::new(key.into())
            .decrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad,
                },
            )
            .map_err(|_| PackageError::Unreadable)?,
    );
    if plain.len() < 4 {
        return Err(PackageError::Unreadable);
    }
    let length = u32::from_be_bytes([plain[0], plain[1], plain[2], plain[3]]) as usize;
    // The padding is exactly what a writer makes: the class for this length,
    // all zero. Nothing hides in it.
    if manifest_class(length) != Some(plain.len())
        || plain[4 + length..].iter().any(|byte| *byte != 0)
    {
        return Err(PackageError::Unreadable);
    }
    Ok(Zeroizing::new(plain[4..4 + length].to_vec()))
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Counts and hashes what passes through it.
struct Tally<'a, W: Write> {
    inner: &'a mut W,
    hasher: Sha256,
    written: u64,
}

impl<W: Write> Write for Tally<'_, W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(data)?;
        self.hasher.update(&data[..written]);
        self.written += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Encrypts a stream into `MCVO1` frames as it is written to, holding one
/// chunk. The last chunk carries the final flag, so the chunk in hand is only
/// written once there is more data after it, or the stream is finished.
struct ObjectEncryptor<'a, W: Write> {
    out: &'a mut W,
    cipher: XChaCha20Poly1305,
    nonce_prefix: [u8; 16],
    package_id: Uuid,
    object_id: Uuid,
    buffer: Zeroizing<Vec<u8>>,
    index: u64,
}

impl<'a, W: Write> ObjectEncryptor<'a, W> {
    fn start(
        out: &'a mut W,
        key: &[u8; 32],
        package_id: Uuid,
        object_id: Uuid,
    ) -> Result<Self, PackageError> {
        let mut nonce_prefix = [0_u8; 16];
        OsRng.fill_bytes(&mut nonce_prefix);
        out.write_all(OBJECT_MAGIC)?;
        out.write_all(&(CHUNK_SIZE as u32).to_be_bytes())?;
        out.write_all(&nonce_prefix)?;
        Ok(Self {
            out,
            cipher: XChaCha20Poly1305::new(key.into()),
            nonce_prefix,
            package_id,
            object_id,
            buffer: Zeroizing::new(Vec::with_capacity(CHUNK_SIZE)),
            index: 0,
        })
    }

    fn emit(&mut self, final_chunk: bool) -> Result<(), PackageError> {
        let mut nonce = [0_u8; 24];
        nonce[..16].copy_from_slice(&self.nonce_prefix);
        nonce[16..].copy_from_slice(&self.index.to_be_bytes());
        let aad = object_aad(self.package_id, self.object_id, self.index, final_chunk);
        let sealed = self
            .cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &self.buffer,
                    aad: &aad,
                },
            )
            .map_err(|_| PackageError::Storage)?;
        self.out.write_all(&(sealed.len() as u32).to_be_bytes())?;
        self.out.write_all(&[u8::from(final_chunk)])?;
        self.out.write_all(&sealed)?;
        self.buffer.clear();
        self.index = self.index.checked_add(1).ok_or(PackageError::TooLarge)?;
        Ok(())
    }

    fn push(&mut self, mut data: &[u8]) -> Result<(), PackageError> {
        while !data.is_empty() {
            if self.buffer.len() == CHUNK_SIZE {
                self.emit(false)?;
            }
            let room = CHUNK_SIZE - self.buffer.len();
            let take = room.min(data.len());
            self.buffer.extend_from_slice(&data[..take]);
            data = &data[take..];
        }
        Ok(())
    }

    fn finish(mut self) -> Result<(), PackageError> {
        self.emit(true)
    }
}

/// Writes a package, in order, in one pass: header, manifest, every object the
/// manifest lists, then the digests and the trailer. Nothing readable is kept
/// anywhere: each chunk is encrypted as it is read from the source.
pub(crate) struct PackageWriter<W: Write> {
    inner: W,
    package_id: Uuid,
    header: Vec<u8>,
    keys: PackageKeys,
    entries: Vec<TrailerEntry>,
    pending: Vec<PackageObject>,
    next: usize,
    digests: Vec<DigestEntry>,
    manifest_written: bool,
}

impl<W: Write> PackageWriter<W> {
    /// Starts a package: makes a new package id and package key, wraps the key
    /// under `secret`, and writes the magic and the header. A typed passphrase
    /// must meet the vault's rules for a new one (`context` are words, such as
    /// the profile's names, it must not contain); the caller is the one that
    /// refuses the vault's own passphrase, which only it can test.
    pub(crate) fn create(
        mut inner: W,
        secret: PackageSecret<'_>,
        context: &[&str],
    ) -> Result<Self, PackageError> {
        if let PackageSecret::Passphrase(passphrase) = secret {
            validate_new_passphrase(passphrase, context)?;
        }
        let package_id = Uuid::new_v4();
        let mut package_key = Zeroizing::new([0_u8; 32]);
        OsRng.fill_bytes(package_key.as_mut());
        let (key_kind, kdf) = match secret {
            PackageSecret::Key(_) => (KeyKind::Key, None),
            PackageSecret::Passphrase(_) => {
                let mut salt = [0_u8; 16];
                OsRng.fill_bytes(&mut salt);
                (KeyKind::Passphrase, Some(kdf_config_with_salt(salt)))
            }
        };
        let wrap = wrapping_key(secret, package_id, kdf.as_ref())?;
        let header = serde_json::to_vec(&PackageHeader {
            format: PACKAGE_FORMAT,
            package_id,
            key_kind,
            wrapped_package_key: wrap_secret(&wrap, &package_key, &wrap_aad(package_id))?,
            kdf,
        })
        .map_err(|_| PackageError::Storage)?;
        if header.len() > MAX_HEADER_BYTES {
            return Err(PackageError::TooLarge);
        }
        let keys = derive_package_keys(&package_key, package_id)?;
        inner.write_all(PACKAGE_MAGIC)?;
        inner.write_all(&(header.len() as u32).to_be_bytes())?;
        inner.write_all(&header)?;
        Ok(Self {
            inner,
            package_id,
            header,
            keys,
            entries: Vec::new(),
            pending: Vec::new(),
            next: 0,
            digests: Vec::new(),
            manifest_written: false,
        })
    }

    pub(crate) fn package_id(&self) -> Uuid {
        self.package_id
    }

    fn frame(&mut self, kind: u8, name: &str, length: u64) -> Result<(), PackageError> {
        let name_length = u16::try_from(name.len()).map_err(|_| PackageError::Invalid)?;
        self.inner.write_all(&[kind])?;
        self.inner.write_all(&name_length.to_be_bytes())?;
        self.inner.write_all(name.as_bytes())?;
        self.inner.write_all(&length.to_be_bytes())?;
        Ok(())
    }

    fn small_entry(&mut self, kind: u8, name: &str, sealed: &[u8]) -> Result<(), PackageError> {
        self.frame(kind, name, sealed.len() as u64)?;
        self.inner.write_all(sealed)?;
        self.entries.push(TrailerEntry {
            kind,
            name: name.to_owned(),
            length: sealed.len() as u64,
            sha256: BASE64.encode(Sha256::digest(sealed)),
        });
        Ok(())
    }

    /// Writes the manifest, after checking it. It must come first and once;
    /// the objects it lists are then written, in its order, with
    /// [`Self::write_object`].
    pub(crate) fn write_manifest(
        &mut self,
        manifest: &PackageManifest,
    ) -> Result<(), PackageError> {
        if self.manifest_written || manifest.format != PACKAGE_FORMAT {
            return Err(PackageError::Invalid);
        }
        manifest.validate()?;
        let json = Zeroizing::new(serde_json::to_vec(manifest).map_err(|_| PackageError::Invalid)?);
        let class = manifest_class(json.len()).ok_or(PackageError::TooLarge)?;
        let sealed = seal_padded(
            &self.keys.manifest,
            &entry_aad(MANIFEST_AAD, self.package_id),
            &json,
            class,
        )?;
        self.small_entry(KIND_MANIFEST, NAME_MANIFEST, &sealed)?;
        self.pending = manifest.objects();
        self.manifest_written = true;
        Ok(())
    }

    /// The id of the object that must be written next, or none when every
    /// object the manifest lists has been.
    pub(crate) fn next_object(&self) -> Option<PackageObject> {
        self.pending.get(self.next).copied()
    }

    /// Streams the next object from `source`: exactly the size the manifest
    /// gave, no more and no less (a source that changed length is refused,
    /// never written short). `still_open` is asked between chunks; once it is
    /// false the write stops with [`PackageError::Cancelled`].
    pub(crate) fn write_object(
        &mut self,
        id: Uuid,
        source: &mut dyn Read,
        still_open: &dyn Fn() -> bool,
    ) -> Result<(), PackageError> {
        let object = self.next_object().ok_or(PackageError::Invalid)?;
        if object.id != id {
            return Err(PackageError::Invalid);
        }
        let length = encrypted_object_len(object.size).ok_or(PackageError::TooLarge)?;
        let name = object_name(id);
        self.frame(KIND_OBJECT, &name, length)?;
        let key = object_key(&self.keys, id)?;
        let mut plain_hash = Sha256::new();
        let mut tally = Tally {
            inner: &mut self.inner,
            hasher: Sha256::new(),
            written: 0,
        };
        let mut encryptor = ObjectEncryptor::start(&mut tally, &key, self.package_id, id)?;
        let mut buffer = Zeroizing::new(vec![0_u8; 64 * 1024]);
        let mut remaining = object.size;
        while remaining > 0 {
            if !still_open() {
                return Err(PackageError::Cancelled);
            }
            let wanted =
                usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
            let read = match source.read(&mut buffer[..wanted]) {
                Ok(0) => return Err(PackageError::Invalid),
                Ok(read) => read,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            };
            plain_hash.update(&buffer[..read]);
            encryptor.push(&buffer[..read])?;
            remaining -= read as u64;
        }
        // A source with more to give than it said is not what the manifest
        // describes either.
        let mut probe = [0_u8; 1];
        loop {
            match source.read(&mut probe) {
                Ok(0) => break,
                Ok(_) => return Err(PackageError::Invalid),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            }
        }
        encryptor.finish()?;
        if tally.written != length {
            return Err(PackageError::Storage);
        }
        let sha256 = BASE64.encode(tally.hasher.finalize());
        self.entries.push(TrailerEntry {
            kind: KIND_OBJECT,
            name,
            length,
            sha256,
        });
        self.digests.push(DigestEntry {
            id,
            size: object.size,
            sha256: BASE64.encode(plain_hash.finalize()),
        });
        self.next += 1;
        Ok(())
    }

    /// Writes the digests and the trailer with its tag, and returns the sink.
    /// Refused unless every object the manifest lists was written.
    pub(crate) fn finish(mut self) -> Result<W, PackageError> {
        if !self.manifest_written || self.next != self.pending.len() {
            return Err(PackageError::Invalid);
        }
        let digests = serde_json::to_vec(&Digests {
            objects: std::mem::take(&mut self.digests),
        })
        .map_err(|_| PackageError::Storage)?;
        let class = manifest_class(digests.len()).ok_or(PackageError::TooLarge)?;
        let sealed = seal_padded(
            &self.keys.manifest,
            &entry_aad(DIGESTS_AAD, self.package_id),
            &digests,
            class,
        )?;
        self.small_entry(KIND_DIGESTS, NAME_DIGESTS, &sealed)?;
        let trailer = serde_json::to_vec(&Trailer {
            format: PACKAGE_FORMAT,
            package_id: self.package_id,
            entries: std::mem::take(&mut self.entries),
        })
        .map_err(|_| PackageError::Storage)?;
        if trailer.len() > MAX_TRAILER_BYTES {
            return Err(PackageError::TooLarge);
        }
        let tag = tag_mac(&self.keys.tag, &self.header, &trailer)?
            .finalize()
            .into_bytes();
        self.inner.write_all(&[KIND_TRAILER])?;
        self.inner
            .write_all(&(trailer.len() as u32).to_be_bytes())?;
        self.inner.write_all(&trailer)?;
        self.inner.write_all(&tag)?;
        self.inner.flush()?;
        Ok(self.inner)
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Hashes what is read through it.
struct HashingRead<'a, R: Read> {
    inner: &'a mut R,
    hasher: &'a mut Sha256,
}

impl<R: Read> Read for HashingRead<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.hasher.update(&buffer[..read]);
        Ok(read)
    }
}

/// What reading one object found: its plaintext size and SHA-256, which the
/// package's digests must agree with before the package is trusted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ObjectRead {
    pub id: Uuid,
    pub size: u64,
    pub sha256: [u8; 32],
}

/// Reads a package in order. `open` reads the header and the manifest only, as
/// an inspect needs; the objects follow with [`Self::read_object`] and
/// [`Self::finish`] checks the whole.
pub(crate) struct PackageReader<R: Read> {
    inner: R,
    package_id: Uuid,
    header: Vec<u8>,
    keys: PackageKeys,
    manifest: PackageManifest,
    pending: Vec<PackageObject>,
    next: usize,
    entries: Vec<TrailerEntry>,
    read: Vec<ObjectRead>,
}

fn read_exact_or_unreadable(inner: &mut impl Read, buffer: &mut [u8]) -> Result<(), PackageError> {
    inner.read_exact(buffer).map_err(PackageError::from)
}

/// An entry header: its kind, name and length, or None at the trailer marker.
fn read_entry_header(inner: &mut impl Read) -> Result<Option<(u8, String, u64)>, PackageError> {
    let mut kind = [0_u8; 1];
    read_exact_or_unreadable(inner, &mut kind)?;
    if kind[0] == KIND_TRAILER {
        return Ok(None);
    }
    let mut name_length = [0_u8; 2];
    read_exact_or_unreadable(inner, &mut name_length)?;
    let name_length = usize::from(u16::from_be_bytes(name_length));
    if name_length > MAX_ENTRY_NAME_BYTES {
        return Err(PackageError::Unreadable);
    }
    let mut name = vec![0_u8; name_length];
    read_exact_or_unreadable(inner, &mut name)?;
    let name = String::from_utf8(name).map_err(|_| PackageError::Unreadable)?;
    let mut length = [0_u8; 8];
    read_exact_or_unreadable(inner, &mut length)?;
    Ok(Some((kind[0], name, u64::from_be_bytes(length))))
}

/// A small entry (manifest or digests): must be `kind` and `name`, and no
/// larger than the largest legal size class. Recorded for the trailer check.
fn read_small_entry(
    inner: &mut impl Read,
    entries: &mut Vec<TrailerEntry>,
    kind: u8,
    name: &str,
) -> Result<Vec<u8>, PackageError> {
    let (found, found_name, length) = read_entry_header(inner)?.ok_or(PackageError::Unreadable)?;
    if found != kind || found_name != name || length > sealed_len(MAX_MANIFEST_CLASS) {
        return Err(PackageError::Unreadable);
    }
    let mut data = vec![0_u8; usize::try_from(length).map_err(|_| PackageError::Unreadable)?];
    read_exact_or_unreadable(inner, &mut data)?;
    entries.push(TrailerEntry {
        kind,
        name: name.to_owned(),
        length,
        sha256: BASE64.encode(Sha256::digest(&data)),
    });
    Ok(data)
}

impl<R: Read> PackageReader<R> {
    /// Opens the package with its key: checks the magic and the format,
    /// unwraps the package key (a wrong key is [`PackageError::WrongKey`]) and
    /// reads and validates the manifest. Nothing else is read.
    pub(crate) fn open(mut inner: R, secret: PackageSecret<'_>) -> Result<Self, PackageError> {
        let mut magic = [0_u8; 16];
        read_exact_or_unreadable(&mut inner, &mut magic)?;
        if &magic != PACKAGE_MAGIC {
            return Err(PackageError::Unreadable);
        }
        let mut length = [0_u8; 4];
        read_exact_or_unreadable(&mut inner, &mut length)?;
        let length = u32::from_be_bytes(length) as usize;
        if length == 0 || length > MAX_HEADER_BYTES {
            return Err(PackageError::Unreadable);
        }
        let mut header_bytes = vec![0_u8; length];
        read_exact_or_unreadable(&mut inner, &mut header_bytes)?;
        let header: PackageHeader =
            serde_json::from_slice(&header_bytes).map_err(|_| PackageError::Unreadable)?;
        if header.format > PACKAGE_FORMAT {
            return Err(PackageError::NewerFormat);
        }
        if header.format != PACKAGE_FORMAT {
            return Err(PackageError::Unreadable);
        }
        match (&header.key_kind, &header.kdf) {
            (KeyKind::Key, None) => {}
            (KeyKind::Passphrase, Some(config)) if valid_kdf_config(config) => {}
            _ => return Err(PackageError::Unreadable),
        }
        // A key of the wrong kind is simply a key that does not open it.
        let matches_kind = matches!(
            (&header.key_kind, secret),
            (KeyKind::Key, PackageSecret::Key(_))
                | (KeyKind::Passphrase, PackageSecret::Passphrase(_))
        );
        if !matches_kind {
            return Err(PackageError::WrongKey);
        }
        let wrap = wrapping_key(secret, header.package_id, header.kdf.as_ref())?;
        let package_key = unwrap_secret(
            &wrap,
            &header.wrapped_package_key,
            &wrap_aad(header.package_id),
        )
        .map_err(|_| PackageError::WrongKey)?;
        let keys = derive_package_keys(&package_key, header.package_id)?;
        let mut entries = Vec::new();
        let sealed = read_small_entry(&mut inner, &mut entries, KIND_MANIFEST, NAME_MANIFEST)?;
        let json = open_padded(
            &keys.manifest,
            &entry_aad(MANIFEST_AAD, header.package_id),
            &sealed,
        )?;
        let manifest: PackageManifest =
            serde_json::from_slice(&json).map_err(|_| PackageError::Unreadable)?;
        manifest.validate()?;
        Ok(Self {
            inner,
            package_id: header.package_id,
            header: header_bytes,
            keys,
            pending: manifest.objects(),
            manifest,
            next: 0,
            entries,
            read: Vec::new(),
        })
    }

    pub(crate) fn manifest(&self) -> &PackageManifest {
        &self.manifest
    }

    pub(crate) fn package_id(&self) -> Uuid {
        self.package_id
    }

    /// The object [`Self::read_object`] will read next.
    pub(crate) fn next_object(&self) -> Option<PackageObject> {
        self.pending.get(self.next).copied()
    }

    /// Decrypts the next object into `sink`, a chunk at a time, each chunk
    /// authenticated before any of it reaches the sink. The entry must be the
    /// one the manifest lists next, of exactly its size. `still_open` is asked
    /// between chunks.
    ///
    /// What reaches `sink` is **not yet trusted as part of this package**; see
    /// the module note on [`Self::finish`].
    pub(crate) fn read_object(
        &mut self,
        sink: &mut dyn Write,
        still_open: &dyn Fn() -> bool,
    ) -> Result<ObjectRead, PackageError> {
        let object = self.next_object().ok_or(PackageError::Invalid)?;
        let expected_length = encrypted_object_len(object.size).ok_or(PackageError::TooLarge)?;
        let (kind, name, length) =
            read_entry_header(&mut self.inner)?.ok_or(PackageError::Unreadable)?;
        if kind != KIND_OBJECT || name != object_name(object.id) || length != expected_length {
            return Err(PackageError::Unreadable);
        }
        let key = object_key(&self.keys, object.id)?;
        let mut entry_hash = Sha256::new();
        let mut plain_hash = Sha256::new();
        let mut limited = (&mut self.inner).take(length);
        let mut hashed = HashingRead {
            inner: &mut limited,
            hasher: &mut entry_hash,
        };
        let mut header = [0_u8; 25];
        read_exact_or_unreadable(&mut hashed, &mut header)?;
        if &header[..5] != OBJECT_MAGIC
            || u32::from_be_bytes([header[5], header[6], header[7], header[8]]) as usize
                != CHUNK_SIZE
        {
            return Err(PackageError::Unreadable);
        }
        let nonce_prefix = &header[9..25];
        let cipher = XChaCha20Poly1305::new((&*key).into());
        let mut total = 0_u64;
        let mut index = 0_u64;
        loop {
            if !still_open() {
                return Err(PackageError::Cancelled);
            }
            let mut frame = [0_u8; 5];
            read_exact_or_unreadable(&mut hashed, &mut frame)?;
            let frame_length =
                u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
            if !(16..=CHUNK_SIZE + 16).contains(&frame_length) || frame[4] > 1 {
                return Err(PackageError::Unreadable);
            }
            let final_chunk = frame[4] == 1;
            let mut ciphertext = vec![0_u8; frame_length];
            read_exact_or_unreadable(&mut hashed, &mut ciphertext)?;
            let mut nonce = [0_u8; 24];
            nonce[..16].copy_from_slice(nonce_prefix);
            nonce[16..].copy_from_slice(&index.to_be_bytes());
            let aad = object_aad(self.package_id, object.id, index, final_chunk);
            let plaintext = Zeroizing::new(
                cipher
                    .decrypt(
                        XNonce::from_slice(&nonce),
                        Payload {
                            msg: &ciphertext,
                            aad: &aad,
                        },
                    )
                    .map_err(|_| PackageError::Unreadable)?,
            );
            total = total
                .checked_add(plaintext.len() as u64)
                .ok_or(PackageError::Unreadable)?;
            if total > object.size {
                return Err(PackageError::Unreadable);
            }
            plain_hash.update(&plaintext);
            for part in plaintext.chunks(64 * 1024) {
                sink.write_all(part)?;
            }
            if final_chunk {
                break;
            }
            index = index.checked_add(1).ok_or(PackageError::Unreadable)?;
        }
        // The entry holds exactly its object: nothing left over, and the size
        // the manifest gave.
        let mut leftover = [0_u8; 1];
        let leftover_read = hashed.read(&mut leftover)?;
        if leftover_read != 0 || total != object.size {
            return Err(PackageError::Unreadable);
        }
        let read = ObjectRead {
            id: object.id,
            size: object.size,
            sha256: plain_hash.finalize().into(),
        };
        self.entries.push(TrailerEntry {
            kind: KIND_OBJECT,
            name,
            length,
            sha256: BASE64.encode(entry_hash.finalize()),
        });
        self.read.push(read.clone());
        self.next += 1;
        Ok(read)
    }

    /// Checks the whole package, once every object has been read: the digests
    /// agree with what was read, the trailer lists exactly the entries read
    /// and is authentic under this package's key (which covers the header),
    /// and nothing follows it. Only after this returns `Ok` is anything read
    /// from the package to be kept.
    ///
    /// Returns each object's plaintext SHA-256, so that the caller can compare
    /// what it stored.
    pub(crate) fn finish(mut self) -> Result<Vec<ObjectRead>, PackageError> {
        if self.next != self.pending.len() {
            return Err(PackageError::Invalid);
        }
        let sealed = read_small_entry(
            &mut self.inner,
            &mut self.entries,
            KIND_DIGESTS,
            NAME_DIGESTS,
        )?;
        let digests = open_padded(
            &self.keys.manifest,
            &entry_aad(DIGESTS_AAD, self.package_id),
            &sealed,
        )?;
        let digests: Digests =
            serde_json::from_slice(&digests).map_err(|_| PackageError::Unreadable)?;
        let expected: Vec<DigestEntry> = self
            .read
            .iter()
            .map(|read| DigestEntry {
                id: read.id,
                size: read.size,
                sha256: BASE64.encode(read.sha256),
            })
            .collect();
        if digests.objects != expected {
            return Err(PackageError::Unreadable);
        }
        let mut marker = [0_u8; 1];
        // The trailer marker was not consumed by the digests entry.
        read_exact_or_unreadable(&mut self.inner, &mut marker)?;
        if marker[0] != KIND_TRAILER {
            return Err(PackageError::Unreadable);
        }
        let mut length = [0_u8; 4];
        read_exact_or_unreadable(&mut self.inner, &mut length)?;
        let length = u32::from_be_bytes(length) as usize;
        if length > MAX_TRAILER_BYTES {
            return Err(PackageError::Unreadable);
        }
        let mut trailer_bytes = vec![0_u8; length];
        read_exact_or_unreadable(&mut self.inner, &mut trailer_bytes)?;
        let mut tag = [0_u8; 32];
        read_exact_or_unreadable(&mut self.inner, &mut tag)?;
        tag_mac(&self.keys.tag, &self.header, &trailer_bytes)?
            .verify_slice(&tag)
            .map_err(|_| PackageError::Unreadable)?;
        let trailer: Trailer =
            serde_json::from_slice(&trailer_bytes).map_err(|_| PackageError::Unreadable)?;
        if trailer.format != PACKAGE_FORMAT
            || trailer.package_id != self.package_id
            || trailer.entries != self.entries
        {
            return Err(PackageError::Unreadable);
        }
        let mut extra = [0_u8; 1];
        if self.inner.read(&mut extra)? != 0 {
            return Err(PackageError::Unreadable);
        }
        Ok(self.read)
    }
}

#[cfg(test)]
mod tests;

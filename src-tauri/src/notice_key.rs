//! Notice keys (#230, design note "Tray mode, choice B"; the Portal calls
//! them "waiting keys", #87): one Ed25519 key per
//! linked Portal that lets a locked myCarlos ask "is anything waiting?", and
//! nothing else. They are kept outside the vault, so a lock does not take
//! them, and outside `vault-home`, so no vault backup holds them:
//!
//! - a random 32-byte wrap key in the OS credential store (`WrapKeyStore`);
//! - `notice-keys.v1` beside `vault-home`, sealed with it (XChaCha20-Poly1305)
//!   and padded to `SLOTS` entries, so its size tells neither which clinics
//!   nor how many.
//!
//! No keyring (some Linux desktops) fails closed: nothing is made or polled,
//! and there is no plain-file fallback. Nothing here is deleted from disk
//! (#71's rule for removals): a wiped entry is an empty slot in a file that
//! keeps its size; the OS item goes with the last entry.
//!
//! Step 1 of #230: the store, its file and its wipes. The poller and the
//! Portal's enrollment field use it once the Portal's route (#87) is there.
//!
//! New v1 files have 1,280 bytes of padded room per slot (20,532 bytes in
//! all). The reader also accepts the earlier experimental 512-byte padding
//! (8,244 bytes). Reading preserves that file; its next successful write
//! uses the new fixed size. The v1 JSON, magic and authenticated label stay
//! the same. Earlier readers refuse the larger envelope; this is not a
//! vault-format change or a downgrade path.
#![cfg_attr(not(test), allow(dead_code))]

use atomicwrites::{AllowOverwrite, AtomicFile};
use base64::{
    engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL},
    Engine as _,
};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use ed25519_dalek::SigningKey;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::portal_link::MAX_PORTAL_UTF8_BYTES;

/// One entry per linked Portal, at most: the cap on remote-notice
/// destinations (format 9, `remote_notices`).
pub(crate) const SLOTS: usize = 16;
/// Each slot's plaintext, padded: a normalized Portal base of up to
/// `MAX_PORTAL_UTF8_BYTES`, two ids, a key id and a seed fit with room to spare.
const SLOT_BYTES: usize = 1280;
/// The earlier experimental v1 padding remains readable. Every new write uses
/// SLOT_BYTES; reading alone does not rewrite an existing file.
const LEGACY_SLOT_BYTES: usize = 512;
const MAX_KEY_ID_BYTES: usize = 64;
const MAGIC: &[u8; 8] = b"MCNKEYS1";
const AAD: &[u8] = b"mycarlos-notice-keys-v1";
/// The file's name, beside `vault-home`.
pub(crate) const FILE_NAME: &str = "notice-keys.v1";

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum NoticeKeyError {
    /// No OS credential store here: tray notices need an unlock instead.
    NoKeyring,
    /// Every slot is taken.
    Full,
    /// The file or its wrap key does not open: treated as no keys.
    Damaged,
    Io,
}

impl From<io::Error> for NoticeKeyError {
    fn from(_: io::Error) -> Self {
        NoticeKeyError::Io
    }
}

/// The OS credential store that holds the wrap key, one per OS user. A fake
/// in tests; Windows Credential Manager on Windows (`notice_store_windows`).
pub(crate) trait WrapKeyStore: Send + Sync {
    /// `Err(NoKeyring)` where this computer has none.
    fn get(&self) -> Result<Option<Zeroizing<[u8; 32]>>, NoticeKeyError>;
    fn put(&self, key: &[u8; 32]) -> Result<(), NoticeKeyError>;
    /// Removes the item; nothing there is fine.
    fn delete(&self) -> Result<(), NoticeKeyError>;
}

/// One linked Portal's notice key. Never logged, never in IPC output.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NoticeKeyEntry {
    /// The link's normalized Portal base, including any path. The historical
    /// field name is retained in the v1 schema; this is not just a URL origin.
    pub(crate) portal_origin: String,
    pub(crate) link_id: Uuid,
    /// The vault the link belongs to: an unlock of another vault wipes it.
    pub(crate) vault_id: Uuid,
    /// The key's id, from its public key (`waiting_key_id`): the device
    /// names it when it registers the key with the Portal (`waiting-keys`).
    pub(crate) key_id: String,
    /// The Ed25519 seed, base64.
    seed: Seed,
}

/// A seed in base64, wiped from memory when it is dropped (each clone too).
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
struct Seed(String);

impl Drop for Seed {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl NoticeKeyEntry {
    pub(crate) fn signing_key(&self) -> Option<SigningKey> {
        let bytes = Zeroizing::new(B64.decode(&self.seed.0).ok()?);
        let seed = Zeroizing::new(<[u8; 32]>::try_from(bytes.as_slice()).ok()?);
        Some(SigningKey::from_bytes(&seed))
    }
}

impl std::fmt::Debug for NoticeKeyEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The seed is never printed.
        f.debug_struct("NoticeKeyEntry")
            .field("link_id", &self.link_id)
            .field("vault_id", &self.vault_id)
            .field("key_id", &self.key_id)
            .finish_non_exhaustive()
    }
}

/// The key's id as the Portal knows it (#87): unpadded base64url of
/// SHA-256("mycarlos-waiting-key-v1" || u64be(32) || public key), framed as
/// the device key's id is, with its own label. 43 characters.
pub(crate) fn waiting_key_id(public_key: &[u8; 32]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"mycarlos-waiting-key-v1");
    digest.update(crate::portal_link::frame(&[public_key]));
    B64URL.encode(digest.finalize())
}

/// A key just made, for the Portal to register.
#[derive(Debug)]
pub(crate) struct NewNoticeKey {
    pub(crate) key_id: String,
    pub(crate) public_key: [u8; 32],
    /// The link's earlier key, if it had one.
    pub(crate) replaced: Wiped,
}

impl NewNoticeKey {
    /// The public key as the Portal takes it: unpadded base64url.
    pub(crate) fn public_key_b64url(&self) -> String {
        B64URL.encode(self.public_key)
    }
}

/// What a wipe took away: the key ids the Portal still holds, for their
/// revocation (queued with the vault's other revocations, or sent with the
/// notice key itself).
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Wiped {
    pub(crate) key_ids: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Plain {
    version: u8,
    slots: Vec<Option<NoticeKeyEntry>>,
}

/// The notice keys of this OS user, beside `vault-home`.
pub(crate) struct NoticeKeys<S: WrapKeyStore> {
    path: PathBuf,
    store: S,
    /// One change at a time: each reads, changes and seals the whole file.
    lock: Mutex<()>,
}

impl<S: WrapKeyStore> NoticeKeys<S> {
    pub(crate) fn new(dir: &Path, store: S) -> Self {
        Self {
            path: dir.join(FILE_NAME),
            store,
            lock: Mutex::new(()),
        }
    }

    /// The keys kept, in slot order. No file, or no wrap key: none.
    pub(crate) fn entries(&self) -> Result<Vec<NoticeKeyEntry>, NoticeKeyError> {
        let _guard = self.lock.lock().map_err(|_| NoticeKeyError::Io)?;
        Ok(self.read()?.into_iter().flatten().collect())
    }

    /// Makes the notice key for a link, while unlocked, and returns what the
    /// Portal registers (`waiting-keys`: the key id and the public key). A
    /// link that has one gets a new one, as the Portal replaces it too: the
    /// earlier key is wiped, and its id is in `replaced`.
    pub(crate) fn make_for(
        &self,
        vault_id: Uuid,
        link_id: Uuid,
        portal_origin: &str,
    ) -> Result<NewNoticeKey, NoticeKeyError> {
        if portal_origin.is_empty() || portal_origin.len() > MAX_PORTAL_UTF8_BYTES {
            return Err(NoticeKeyError::Damaged);
        }
        let _guard = self.lock.lock().map_err(|_| NoticeKeyError::Io)?;
        // A keyring must be there before anything is made.
        self.store.get()?;
        let mut slots = self.read()?;
        let mut wiped = Wiped::default();
        for slot in slots.iter_mut() {
            if slot.as_ref().is_some_and(|entry| entry.link_id == link_id) {
                if let Some(entry) = slot.take() {
                    wiped.key_ids.push(entry.key_id);
                }
            }
        }
        let free = slots
            .iter()
            .position(Option::is_none)
            .ok_or(NoticeKeyError::Full)?;
        let mut seed = Zeroizing::new([0_u8; 32]);
        OsRng.fill_bytes(seed.as_mut());
        let public_key = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        let key_id = waiting_key_id(&public_key);
        slots[free] = Some(NoticeKeyEntry {
            portal_origin: portal_origin.to_owned(),
            link_id,
            vault_id,
            key_id: key_id.clone(),
            seed: Seed(B64.encode(seed.as_slice())),
        });
        self.seal(&slots)?;
        Ok(NewNoticeKey {
            key_id,
            public_key,
            replaced: wiped,
        })
    }

    /// Wipes the keys `which` picks (a link unlinked, a device removed,
    /// notices turned off): an empty slot each.
    pub(crate) fn wipe(
        &self,
        which: impl Fn(&NoticeKeyEntry) -> bool,
    ) -> Result<Wiped, NoticeKeyError> {
        self.wipe_where(which, false)
    }

    fn wipe_where(
        &self,
        which: impl Fn(&NoticeKeyEntry) -> bool,
        all: bool,
    ) -> Result<Wiped, NoticeKeyError> {
        let _guard = self.lock.lock().map_err(|_| NoticeKeyError::Io)?;
        if !self.path.exists() {
            // No file: no key to wipe. Wiping them all still removes a wrap
            // key left without its file (the file removed by hand); any other
            // wipe does not even ask the keyring.
            if all {
                match self.store.delete() {
                    Ok(()) | Err(NoticeKeyError::NoKeyring) => {}
                    Err(error) => return Err(error),
                }
            }
            return Ok(Wiped::default());
        }
        let mut slots = match self.read() {
            Ok(slots) => slots,
            // A file that does not open holds no usable key: start it empty.
            Err(NoticeKeyError::Damaged) => vec![None; SLOTS],
            Err(error) => return Err(error),
        };
        let mut wiped = Wiped::default();
        for slot in slots.iter_mut() {
            if slot.as_ref().is_some_and(&which) {
                if let Some(entry) = slot.take() {
                    wiped.key_ids.push(entry.key_id);
                }
            }
        }
        if slots.iter().all(Option::is_none) {
            // The last key gone: the OS item goes, then the file stays, empty.
            // In this order a failed delete changes nothing, so the wipe can
            // be tried again; once the item is gone, any file reads as no
            // keys, so a failed write after it leaves none either.
            self.store.delete()?;
            self.seal_empty()?;
        } else {
            self.seal(&slots)?;
        }
        Ok(wiped)
    }

    /// A link's key.
    pub(crate) fn wipe_link(&self, link_id: Uuid) -> Result<Wiped, NoticeKeyError> {
        self.wipe(|entry| entry.link_id == link_id)
    }

    /// Every key, when the vault is reset, erased or set aside.
    pub(crate) fn wipe_all(&self) -> Result<Wiped, NoticeKeyError> {
        self.wipe_where(|_| true, true)
    }

    /// The keys of any other vault, when `vault_id` is unlocked.
    pub(crate) fn keep_only_vault(&self, vault_id: Uuid) -> Result<Wiped, NoticeKeyError> {
        self.wipe(|entry| entry.vault_id != vault_id)
    }

    fn read(&self) -> Result<Vec<Option<NoticeKeyEntry>>, NoticeKeyError> {
        let data = match fs::read(&self.path) {
            Ok(data) => data,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(vec![None; SLOTS]);
            }
            Err(error) => return Err(error.into()),
        };
        let Some(key) = self.store.get()? else {
            // No wrap key (the last key was wiped, or the OS item was removed
            // by hand): the file holds nothing usable, so no keys.
            return Ok(vec![None; SLOTS]);
        };
        open(&key, &data)
    }

    fn seal(&self, slots: &[Option<NoticeKeyEntry>]) -> Result<(), NoticeKeyError> {
        let key = match self.store.get()? {
            Some(key) => key,
            None => {
                let mut fresh = Zeroizing::new([0_u8; 32]);
                OsRng.fill_bytes(fresh.as_mut());
                self.store.put(&fresh)?;
                fresh
            }
        };
        self.write(&seal(&key, slots)?)
    }

    /// An empty file sealed with a throwaway key: the same size, no entries,
    /// and no wrap key left to keep.
    fn seal_empty(&self) -> Result<(), NoticeKeyError> {
        let mut throwaway = Zeroizing::new([0_u8; 32]);
        OsRng.fill_bytes(throwaway.as_mut());
        self.write(&seal(&throwaway, &vec![None; SLOTS])?)
    }

    fn write(&self, data: &[u8]) -> Result<(), NoticeKeyError> {
        let parent = self.path.parent().ok_or(NoticeKeyError::Io)?;
        fs::create_dir_all(parent)?;
        let metadata = fs::symlink_metadata(parent)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(NoticeKeyError::Io);
        }
        if let Ok(metadata) = fs::symlink_metadata(&self.path) {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(NoticeKeyError::Io);
            }
        }
        AtomicFile::new(&self.path, AllowOverwrite)
            .write(|f| f.write_all(data))
            .map_err(|_| NoticeKeyError::Io)
    }
}

/// The file's whole size: magic, nonce, then the padded plaintext and its tag.
pub(crate) const FILE_BYTES: usize = MAGIC.len() + 24 + 4 + SLOTS * SLOT_BYTES + 16;
const LEGACY_FILE_BYTES: usize = MAGIC.len() + 24 + 4 + SLOTS * LEGACY_SLOT_BYTES + 16;

fn seal(key: &[u8; 32], slots: &[Option<NoticeKeyEntry>]) -> Result<Vec<u8>, NoticeKeyError> {
    let json = Zeroizing::new(
        serde_json::to_vec(&Plain {
            version: 1,
            slots: slots.to_vec(),
        })
        .map_err(|_| NoticeKeyError::Damaged)?,
    );
    let room = SLOTS * SLOT_BYTES;
    if json.len() > room {
        return Err(NoticeKeyError::Full);
    }
    // A length, then the JSON, then zeros to the fixed size.
    let mut padded = Zeroizing::new(Vec::with_capacity(4 + room));
    padded.extend_from_slice(&(json.len() as u32).to_be_bytes());
    padded.extend_from_slice(&json);
    padded.resize(4 + room, 0);
    let mut nonce = [0_u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let sealed = XChaCha20Poly1305::new(key.into())
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &padded,
                aad: AAD,
            },
        )
        .map_err(|_| NoticeKeyError::Damaged)?;
    let mut out = Vec::with_capacity(FILE_BYTES);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    debug_assert_eq!(out.len(), FILE_BYTES);
    Ok(out)
}

fn open(key: &[u8; 32], data: &[u8]) -> Result<Vec<Option<NoticeKeyEntry>>, NoticeKeyError> {
    if !matches!(data.len(), FILE_BYTES | LEGACY_FILE_BYTES) || &data[..MAGIC.len()] != MAGIC {
        return Err(NoticeKeyError::Damaged);
    }
    let nonce = XNonce::from_slice(&data[MAGIC.len()..MAGIC.len() + 24]);
    let padded = Zeroizing::new(
        XChaCha20Poly1305::new(key.into())
            .decrypt(
                nonce,
                Payload {
                    msg: &data[MAGIC.len() + 24..],
                    aad: AAD,
                },
            )
            .map_err(|_| NoticeKeyError::Damaged)?,
    );
    let length = u32::from_be_bytes(
        padded[..4]
            .try_into()
            .map_err(|_| NoticeKeyError::Damaged)?,
    ) as usize;
    let json = padded.get(4..4 + length).ok_or(NoticeKeyError::Damaged)?;
    let plain: Plain = serde_json::from_slice(json).map_err(|_| NoticeKeyError::Damaged)?;
    if plain.version != 1
        || plain.slots.len() != SLOTS
        || plain.slots.iter().flatten().any(|entry| {
            entry.portal_origin.is_empty()
                || entry.portal_origin.len() > MAX_PORTAL_UTF8_BYTES
                || entry.key_id.is_empty()
                || entry.key_id.len() > MAX_KEY_ID_BYTES
                || entry.signing_key().is_none()
        })
    {
        return Err(NoticeKeyError::Damaged);
    }
    Ok(plain.slots)
}

/// Where this build has no OS store yet (Linux until its Secret Service
/// store, macOS, phones): no keyring, so nothing is made, and a wipe with no
/// file changes nothing.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) struct NoKeyringStore;

impl WrapKeyStore for NoKeyringStore {
    fn get(&self) -> Result<Option<Zeroizing<[u8; 32]>>, NoticeKeyError> {
        Err(NoticeKeyError::NoKeyring)
    }
    fn put(&self, _: &[u8; 32]) -> Result<(), NoticeKeyError> {
        Err(NoticeKeyError::NoKeyring)
    }
    fn delete(&self) -> Result<(), NoticeKeyError> {
        Ok(())
    }
}

impl WrapKeyStore for Box<dyn WrapKeyStore> {
    fn get(&self) -> Result<Option<Zeroizing<[u8; 32]>>, NoticeKeyError> {
        (**self).get()
    }
    fn put(&self, key: &[u8; 32]) -> Result<(), NoticeKeyError> {
        (**self).put(key)
    }
    fn delete(&self) -> Result<(), NoticeKeyError> {
        (**self).delete()
    }
}

/// This OS user's store, for this build.
fn os_store() -> Box<dyn WrapKeyStore> {
    #[cfg(windows)]
    return Box::new(crate::notice_store_windows::CredentialManagerStore);
    #[cfg(not(windows))]
    Box::new(NoKeyringStore)
}

static KEPT: std::sync::OnceLock<NoticeKeys<Box<dyn WrapKeyStore>>> = std::sync::OnceLock::new();

/// At startup: the notice keys beside `vault-home` (in `dir`, the app's
/// machine-local data folder, never inside the vault's own folder).
pub(crate) fn install(dir: &Path) {
    let _ = KEPT.set(NoticeKeys::new(dir, os_store()));
}

pub(crate) fn kept() -> Option<&'static NoticeKeys<Box<dyn WrapKeyStore>>> {
    KEPT.get()
}

/// After a vault opens: any other vault's keys go. Nothing makes keys yet,
/// so nothing is owed to the Portal; their revocation comes with its route
/// (#87, step 3 of #230).
pub(crate) fn after_open(vault_id: Uuid) {
    if let Some(keys) = kept() {
        let _ = keys.keep_only_vault(vault_id);
    }
}

/// After the vault is reset (set aside for a new one): every key goes.
pub(crate) fn after_reset() {
    if let Some(keys) = kept() {
        let _ = keys.wipe_all();
    }
}

/// A keyring in memory, for tests.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct FakeWrapKeyStore {
    key: Mutex<Option<[u8; 32]>>,
    /// As a Linux desktop without Secret Service.
    pub(crate) absent: bool,
    /// How many of the next deletes fail, as a locked OS store might.
    failing_deletes: Mutex<u32>,
}

#[cfg(test)]
impl WrapKeyStore for FakeWrapKeyStore {
    fn get(&self) -> Result<Option<Zeroizing<[u8; 32]>>, NoticeKeyError> {
        if self.absent {
            return Err(NoticeKeyError::NoKeyring);
        }
        Ok(self.key.lock().unwrap().map(Zeroizing::new))
    }
    fn put(&self, key: &[u8; 32]) -> Result<(), NoticeKeyError> {
        if self.absent {
            return Err(NoticeKeyError::NoKeyring);
        }
        *self.key.lock().unwrap() = Some(*key);
        Ok(())
    }
    fn delete(&self) -> Result<(), NoticeKeyError> {
        if self.absent {
            return Err(NoticeKeyError::NoKeyring);
        }
        let mut failing = self.failing_deletes.lock().unwrap();
        if *failing > 0 {
            *failing -= 1;
            return Err(NoticeKeyError::Io);
        }
        *self.key.lock().unwrap() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, Verifier, VerifyingKey};

    const ORIGIN: &str = "https://portal.example.invalid";

    fn keys() -> (tempfile::TempDir, NoticeKeys<FakeWrapKeyStore>) {
        let temp = tempfile::tempdir().unwrap();
        let keys = NoticeKeys::new(temp.path(), FakeWrapKeyStore::default());
        (temp, keys)
    }

    fn uuid(n: u128) -> Uuid {
        Uuid::from_u128(0xFAC0_0000_0000_4000_8000_0000_0000_0000 + n)
    }

    #[test]
    fn a_key_made_for_a_link_signs_as_its_public_key_says_and_reads_back() {
        let (_temp, keys) = keys();
        let made = keys.make_for(uuid(1), uuid(10), ORIGIN).unwrap();
        assert_eq!(made.replaced, Wiped::default());
        let entries = keys.entries().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].portal_origin, ORIGIN);
        // The id comes from the public key, as the Portal checks it.
        assert_eq!(entries[0].key_id, made.key_id);
        assert_eq!(made.key_id.len(), 43);
        let mut framed = b"mycarlos-waiting-key-v1".to_vec();
        framed.extend_from_slice(&32_u64.to_be_bytes());
        framed.extend_from_slice(&made.public_key);
        assert_eq!(made.key_id, B64URL.encode(Sha256::digest(&framed)));
        // The public key as registered: 43 unpadded base64url characters.
        let registered = made.public_key_b64url();
        assert_eq!(registered.len(), 43);
        assert_eq!(B64URL.decode(&registered).unwrap(), made.public_key);
        let signature = entries[0].signing_key().unwrap().sign(b"FAKE request");
        VerifyingKey::from_bytes(&made.public_key)
            .unwrap()
            .verify(b"FAKE request", &signature)
            .unwrap();
    }

    #[test]
    fn the_file_has_one_size_whatever_it_holds_and_names_no_clinic() {
        let (temp, keys) = keys();
        keys.make_for(uuid(1), uuid(10), ORIGIN).unwrap();
        let one = fs::read(temp.path().join(FILE_NAME)).unwrap();
        assert_eq!(one.len(), FILE_BYTES);
        assert!(!one.windows(ORIGIN.len()).any(|w| w == ORIGIN.as_bytes()));
        for n in 11..(10 + SLOTS as u128) {
            keys.make_for(uuid(1), uuid(n), ORIGIN).unwrap();
        }
        let full = fs::read(temp.path().join(FILE_NAME)).unwrap();
        assert_eq!(full.len(), FILE_BYTES);
        assert_eq!(keys.entries().unwrap().len(), SLOTS);
        assert!(matches!(
            keys.make_for(uuid(1), uuid(99), ORIGIN),
            Err(NoticeKeyError::Full)
        ));
    }

    #[test]
    fn a_new_key_for_a_link_replaces_its_old_one_and_names_it_for_revocation() {
        let (_temp, keys) = keys();
        let old = keys.make_for(uuid(1), uuid(10), ORIGIN).unwrap();
        let new = keys.make_for(uuid(1), uuid(10), ORIGIN).unwrap();
        assert_eq!(new.replaced.key_ids, vec![old.key_id]);
        assert_ne!(new.key_id, new.replaced.key_ids[0]);
        assert_eq!(keys.entries().unwrap().len(), 1);
    }

    #[test]
    fn wipes_take_a_link_another_vault_or_all_and_the_last_takes_the_os_item() {
        let (temp, keys) = keys();
        let k10 = keys.make_for(uuid(1), uuid(10), ORIGIN).unwrap().key_id;
        let k11 = keys.make_for(uuid(1), uuid(11), ORIGIN).unwrap().key_id;
        let k20 = keys.make_for(uuid(2), uuid(20), ORIGIN).unwrap().key_id;
        assert_eq!(keys.wipe_link(uuid(10)).unwrap().key_ids, vec![k10]);
        // An unlock of vault 1: vault 2's key goes.
        assert_eq!(keys.keep_only_vault(uuid(1)).unwrap().key_ids, vec![k20]);
        assert_eq!(keys.entries().unwrap().len(), 1);
        assert!(keys.store.get().unwrap().is_some());
        // Reset: the rest, and the wrap key with it; the file stays, its size.
        assert_eq!(keys.wipe_all().unwrap().key_ids, vec![k11]);
        assert!(keys.store.get().unwrap().is_none());
        assert_eq!(
            fs::read(temp.path().join(FILE_NAME)).unwrap().len(),
            FILE_BYTES
        );
        assert_eq!(keys.entries(), Ok(vec![]));
        // And it can start again.
        keys.make_for(uuid(1), uuid(30), ORIGIN).unwrap();
        assert_eq!(keys.entries().unwrap().len(), 1);
    }

    #[test]
    fn with_no_keyring_nothing_is_made_and_a_wipe_with_no_file_still_succeeds() {
        let temp = tempfile::tempdir().unwrap();
        let keys = NoticeKeys::new(
            temp.path(),
            FakeWrapKeyStore {
                absent: true,
                ..Default::default()
            },
        );
        assert_eq!(
            keys.make_for(uuid(1), uuid(10), ORIGIN).map(|_| ()),
            Err(NoticeKeyError::NoKeyring)
        );
        assert!(
            !temp.path().join(FILE_NAME).exists(),
            "no plain-file fallback"
        );
        // Wiping all asks the keyring to remove its item, and none is fine.
        assert_eq!(keys.wipe_link(uuid(10)), Ok(Wiped::default()));
        assert_eq!(keys.wipe_all(), Ok(Wiped::default()));
    }

    #[test]
    fn a_damaged_or_foreign_file_opens_as_damaged_and_a_wipe_starts_it_empty() {
        let (temp, keys) = keys();
        keys.make_for(uuid(1), uuid(10), ORIGIN).unwrap();
        let path = temp.path().join(FILE_NAME);
        let mut data = fs::read(&path).unwrap();
        let last = data.len() - 1;
        data[last] ^= 1;
        fs::write(&path, &data).unwrap();
        assert_eq!(keys.entries(), Err(NoticeKeyError::Damaged));
        assert_eq!(keys.wipe_all(), Ok(Wiped::default()));
        assert_eq!(fs::read(&path).unwrap().len(), FILE_BYTES);
        // Too short, or not ours, while a wrap key is kept. (With none, as
        // after the wipe above, any file reads as no keys.)
        keys.make_for(uuid(1), uuid(10), ORIGIN).unwrap();
        fs::write(&path, b"MCNKEYS1 FAKE").unwrap();
        assert_eq!(keys.entries(), Err(NoticeKeyError::Damaged));
    }

    #[test]
    fn debug_prints_only_the_three_public_identifiers() {
        let mut entry = NoticeKeyEntry {
            portal_origin: ORIGIN.to_owned(),
            link_id: uuid(10),
            vault_id: uuid(1),
            key_id: "FAKE-public-id".to_owned(),
            seed: Seed(B64.encode([17_u8; 32])),
        };
        let expected = concat!(
            "NoticeKeyEntry { link_id: fac00000-0000-4000-8000-00000000000a, ",
            "vault_id: fac00000-0000-4000-8000-000000000001, ",
            "key_id: \"FAKE-public-id\", .. }"
        );
        let pretty = concat!(
            "NoticeKeyEntry {\n",
            "    link_id: fac00000-0000-4000-8000-00000000000a,\n",
            "    vault_id: fac00000-0000-4000-8000-000000000001,\n",
            "    key_id: \"FAKE-public-id\",\n",
            "    ..\n}"
        );
        for _ in 0..2 {
            // Failure diagnostics never print the actual representation.
            assert!(format!("{entry:?}") == expected, "Debug whitelist changed");
            assert!(
                format!("{entry:#?}") == pretty,
                "pretty Debug whitelist changed"
            );
            entry.portal_origin = "https://other.example.invalid/patient".to_owned();
            entry.seed = Seed(B64.encode([29_u8; 32]));
        }
    }

    #[test]
    fn a_last_wipe_whose_os_delete_fails_changes_nothing_and_can_be_tried_again() {
        let (_temp, keys) = keys();
        let first = keys.make_for(uuid(1), uuid(10), ORIGIN).unwrap().key_id;
        *keys.store.failing_deletes.lock().unwrap() = 1;
        assert_eq!(keys.wipe_link(uuid(10)), Err(NoticeKeyError::Io));
        // The key is still there, and new keys can still be made.
        assert_eq!(keys.entries().unwrap().len(), 1);
        let second = keys.make_for(uuid(1), uuid(11), ORIGIN).unwrap().key_id;
        assert_eq!(keys.wipe_all().unwrap().key_ids, vec![first, second]);
        assert_eq!(keys.entries(), Ok(vec![]));
        assert_eq!(keys.store.get().map(|key| key.is_some()), Ok(false));
    }

    #[test]
    fn wiping_all_with_no_file_still_removes_a_wrap_key_left_behind() {
        let (temp, keys) = keys();
        keys.store.put(&[7_u8; 32]).unwrap();
        assert!(!temp.path().join(FILE_NAME).exists());
        // Another wipe leaves the keyring alone; wiping all removes it.
        assert_eq!(keys.wipe_link(uuid(10)), Ok(Wiped::default()));
        assert_eq!(keys.store.get().map(|key| key.is_some()), Ok(true));
        assert_eq!(keys.wipe_all(), Ok(Wiped::default()));
        assert_eq!(keys.store.get().map(|key| key.is_some()), Ok(false));
    }

    #[test]
    fn a_portal_base_out_of_bounds_is_refused_without_changing_existing_keys() {
        let (_temp, keys) = keys();
        keys.make_for(uuid(1), uuid(10), ORIGIN).unwrap();
        let before = keys.entries().unwrap();
        let file_before = fs::read(&keys.path).unwrap();
        for origin in ["".to_owned(), "x".repeat(MAX_PORTAL_UTF8_BYTES + 1)] {
            assert_eq!(
                keys.make_for(uuid(1), uuid(10), &origin).map(|_| ()),
                Err(NoticeKeyError::Damaged)
            );
        }
        assert!(keys.entries().unwrap() == before);
        assert_eq!(fs::read(&keys.path).unwrap(), file_before);
    }

    fn maximum_portal_base() -> String {
        let base = "https://fake.example/";
        let count = (MAX_PORTAL_UTF8_BYTES - base.len()) / 6;
        let padding = "x".repeat(MAX_PORTAL_UTF8_BYTES - base.len() - count * 6);
        let input = format!("{base}{}{padding}", "é".repeat(count));
        let canonical = crate::portal_link::normalize_portal(&input).unwrap();
        assert_eq!(canonical.len(), MAX_PORTAL_UTF8_BYTES);
        assert_eq!(
            canonical,
            format!("{base}{}{padding}", "%C3%A9".repeat(count))
        );
        assert_eq!(
            crate::portal_link::normalize_portal(&canonical).unwrap(),
            canonical
        );
        assert!(crate::portal_link::normalize_portal(&format!("{input}x")).is_err());
        canonical
    }

    #[test]
    fn sixteen_maximum_normalized_portal_bases_fit_without_truncation() {
        let (_temp, keys) = keys();
        let portal = maximum_portal_base();
        for n in 0..SLOTS {
            keys.make_for(uuid(1), uuid(10 + n as u128), &portal)
                .unwrap();
            assert_eq!(fs::metadata(&keys.path).unwrap().len(), FILE_BYTES as u64);
        }
        let before = keys.entries().unwrap();
        assert_eq!(before.len(), SLOTS);
        assert!(before.iter().all(|entry| entry.portal_origin == portal));
        assert!(matches!(
            keys.make_for(uuid(1), uuid(99), &portal),
            Err(NoticeKeyError::Full)
        ));
        assert!(keys.entries().unwrap() == before);
        keys.wipe_all().unwrap();
        assert_eq!(keys.entries(), Ok(vec![]));
        assert_eq!(fs::metadata(&keys.path).unwrap().len(), FILE_BYTES as u64);
        keys.make_for(uuid(1), uuid(30), &portal).unwrap();
        assert_eq!(keys.entries().unwrap()[0].portal_origin, portal);
        assert_eq!(fs::metadata(&keys.path).unwrap().len(), FILE_BYTES as u64);
    }

    #[test]
    fn fixed_padding_also_fits_the_maximum_readable_key_id_in_every_slot() {
        let portal = maximum_portal_base();
        let slots: Vec<_> = (0..SLOTS)
            .map(|n| {
                Some(NoticeKeyEntry {
                    portal_origin: portal.clone(),
                    link_id: uuid(10 + n as u128),
                    vault_id: uuid(1),
                    key_id: format!("{n:064}"),
                    seed: Seed(B64.encode([17_u8; 32])),
                })
            })
            .collect();
        let data = seal(&[7_u8; 32], &slots).unwrap();
        assert_eq!(data.len(), FILE_BYTES);
        assert!(open(&[7_u8; 32], &data).unwrap() == slots);
    }

    // Independent fixture writer for the documented v1 envelope, including
    // the older padding; it never calls the production writer.
    fn v1_fixture(
        key: &[u8; 32],
        slots: &[Option<NoticeKeyEntry>],
        room: usize,
        version: u8,
    ) -> Vec<u8> {
        let json = Zeroizing::new(
            serde_json::to_vec(&Plain {
                version,
                slots: slots.to_vec(),
            })
            .unwrap(),
        );
        assert!(json.len() <= room);
        let mut plain = Zeroizing::new(Vec::new());
        plain.extend_from_slice(&(json.len() as u32).to_be_bytes());
        plain.extend_from_slice(&json);
        plain.resize(4 + room, 0);
        let nonce = [19_u8; 24];
        let sealed = XChaCha20Poly1305::new(key.into())
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &plain,
                    aad: b"mycarlos-notice-keys-v1",
                },
            )
            .unwrap();
        let mut data = b"MCNKEYS1".to_vec();
        data.extend_from_slice(&nonce);
        data.extend_from_slice(&sealed);
        data
    }

    #[test]
    fn legacy_v1_reads_unchanged_and_its_next_write_uses_the_new_fixed_padding() {
        let (_temp, keys) = keys();
        let entry = NoticeKeyEntry {
            portal_origin: ORIGIN.to_owned(),
            link_id: uuid(10),
            vault_id: uuid(1),
            key_id: "FAKE-public-id".to_owned(),
            seed: Seed(B64.encode([17_u8; 32])),
        };
        let mut slots = vec![None; SLOTS];
        slots[0] = Some(entry.clone());
        let wrap = [7_u8; 32];
        let legacy = v1_fixture(&wrap, &slots, SLOTS * LEGACY_SLOT_BYTES, 1);
        assert_eq!(legacy.len(), 8244);
        keys.store.put(&wrap).unwrap();
        fs::write(&keys.path, &legacy).unwrap();
        assert!(keys.entries().unwrap() == vec![entry.clone()]);
        assert_eq!(
            fs::read(&keys.path).unwrap(),
            legacy,
            "read must not rewrite"
        );
        keys.make_for(uuid(1), uuid(11), &maximum_portal_base())
            .unwrap();
        assert_eq!(fs::metadata(&keys.path).unwrap().len(), 20532);
        assert!(keys.entries().unwrap()[0] == entry);
        assert_eq!(keys.entries().unwrap().len(), 2);
    }

    #[test]
    fn only_the_two_v1_sizes_and_current_payload_version_are_accepted() {
        let wrap = [7_u8; 32];
        let slots = vec![None; SLOTS];
        for room in [SLOTS * LEGACY_SLOT_BYTES, SLOTS * SLOT_BYTES] {
            let data = v1_fixture(&wrap, &slots, room, 1);
            assert!(open(&wrap, &data).unwrap() == slots);
            assert_eq!(open(&[8_u8; 32], &data), Err(NoticeKeyError::Damaged));
            assert_eq!(
                open(&wrap, &v1_fixture(&wrap, &slots, room, 2)),
                Err(NoticeKeyError::Damaged)
            );
            let mut altered = data;
            altered[0] ^= 1;
            assert_eq!(open(&wrap, &altered), Err(NoticeKeyError::Damaged));
        }
        let unsupported = v1_fixture(&wrap, &slots, SLOTS * LEGACY_SLOT_BYTES + 1, 1);
        assert_eq!(open(&wrap, &unsupported), Err(NoticeKeyError::Damaged));
    }
}

//! Notice keys (#230, design note "Tray mode, choice B"): one Ed25519 key per
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
#![cfg_attr(not(test), allow(dead_code))]

use atomicwrites::{AllowOverwrite, AtomicFile};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use ed25519_dalek::SigningKey;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;
use zeroize::Zeroizing;

/// One entry per linked Portal, at most: the cap on remote-notice
/// destinations (format 9, `remote_notices`).
pub(crate) const SLOTS: usize = 16;
/// Each slot's plaintext, padded: an origin of up to `MAX_ORIGIN_BYTES`, two
/// ids, a key id and a seed fit with room to spare.
const SLOT_BYTES: usize = 512;
const MAX_ORIGIN_BYTES: usize = 255;
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
    /// The Portal, as the link knows it (scheme, host and port).
    pub(crate) portal_origin: String,
    pub(crate) link_id: Uuid,
    /// The vault the link belongs to: an unlock of another vault wipes it.
    pub(crate) vault_id: Uuid,
    /// The Portal's id for the public key, once enrollment has given it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) key_id: Option<String>,
    /// The Ed25519 seed, base64.
    seed: String,
}

impl NoticeKeyEntry {
    pub(crate) fn signing_key(&self) -> Option<SigningKey> {
        let bytes = Zeroizing::new(B64.decode(&self.seed).ok()?);
        let seed: [u8; 32] = bytes.as_slice().try_into().ok()?;
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

    /// Makes the notice key for a link, at opt-in while unlocked, and returns
    /// its public key for the Portal's enrollment. A link that has one gets a
    /// new one: the earlier key is replaced, and its id is in `Wiped`.
    pub(crate) fn make_for(
        &self,
        vault_id: Uuid,
        link_id: Uuid,
        portal_origin: &str,
    ) -> Result<([u8; 32], Wiped), NoticeKeyError> {
        if portal_origin.is_empty() || portal_origin.len() > MAX_ORIGIN_BYTES {
            return Err(NoticeKeyError::Damaged);
        }
        let _guard = self.lock.lock().map_err(|_| NoticeKeyError::Io)?;
        // A keyring must be there before anything is made.
        self.store.get()?;
        let mut slots = self.read()?;
        let mut wiped = Wiped::default();
        for slot in slots.iter_mut() {
            if slot.as_ref().is_some_and(|entry| entry.link_id == link_id) {
                if let Some(key_id) = slot.take().and_then(|entry| entry.key_id) {
                    wiped.key_ids.push(key_id);
                }
            }
        }
        let free = slots
            .iter()
            .position(Option::is_none)
            .ok_or(NoticeKeyError::Full)?;
        let mut seed = Zeroizing::new([0_u8; 32]);
        OsRng.fill_bytes(seed.as_mut());
        let public = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        slots[free] = Some(NoticeKeyEntry {
            portal_origin: portal_origin.to_owned(),
            link_id,
            vault_id,
            key_id: None,
            seed: B64.encode(seed.as_slice()),
        });
        self.seal(&slots)?;
        Ok((public, wiped))
    }

    /// Records the Portal's id for a link's key, once enrollment answered.
    pub(crate) fn set_key_id(&self, link_id: Uuid, key_id: &str) -> Result<(), NoticeKeyError> {
        if key_id.is_empty() || key_id.len() > MAX_KEY_ID_BYTES {
            return Err(NoticeKeyError::Damaged);
        }
        let _guard = self.lock.lock().map_err(|_| NoticeKeyError::Io)?;
        let mut slots = self.read()?;
        let entry = slots
            .iter_mut()
            .flatten()
            .find(|entry| entry.link_id == link_id)
            .ok_or(NoticeKeyError::Damaged)?;
        entry.key_id = Some(key_id.to_owned());
        self.seal(&slots)
    }

    /// Wipes the keys `which` picks (a link unlinked, a device removed,
    /// notices turned off): an empty slot each.
    pub(crate) fn wipe(
        &self,
        which: impl Fn(&NoticeKeyEntry) -> bool,
    ) -> Result<Wiped, NoticeKeyError> {
        let _guard = self.lock.lock().map_err(|_| NoticeKeyError::Io)?;
        // No file: nothing to wipe, and the keyring is not even asked.
        if !self.path.exists() {
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
                if let Some(key_id) = slot.take().and_then(|entry| entry.key_id) {
                    wiped.key_ids.push(key_id);
                }
            }
        }
        if slots.iter().all(Option::is_none) {
            // The last key gone: the file stays, empty, and the OS item goes.
            self.seal_empty()?;
            self.store.delete()?;
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
        self.wipe(|_| true)
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
    if data.len() != FILE_BYTES || &data[..MAGIC.len()] != MAGIC {
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
                || entry.portal_origin.len() > MAX_ORIGIN_BYTES
                || entry
                    .key_id
                    .as_ref()
                    .is_some_and(|id| id.is_empty() || id.len() > MAX_KEY_ID_BYTES)
                || entry.signing_key().is_none()
        })
    {
        return Err(NoticeKeyError::Damaged);
    }
    Ok(plain.slots)
}

/// Where this build has no OS store yet (Linux until its Secret Service
/// store, macOS, phones): no keyring, so nothing is made, and wipes of a file
/// that is not there ask nothing.
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
        let (public, wiped) = keys.make_for(uuid(1), uuid(10), ORIGIN).unwrap();
        assert_eq!(wiped, Wiped::default());
        let entries = keys.entries().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].portal_origin, ORIGIN);
        assert_eq!(entries[0].key_id, None);
        let signature = entries[0].signing_key().unwrap().sign(b"FAKE request");
        VerifyingKey::from_bytes(&public)
            .unwrap()
            .verify(b"FAKE request", &signature)
            .unwrap();
        keys.set_key_id(uuid(10), "FAKE-key-1").unwrap();
        assert_eq!(
            keys.entries().unwrap()[0].key_id.as_deref(),
            Some("FAKE-key-1")
        );
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
        keys.make_for(uuid(1), uuid(10), ORIGIN).unwrap();
        keys.set_key_id(uuid(10), "FAKE-old").unwrap();
        let (_, wiped) = keys.make_for(uuid(1), uuid(10), ORIGIN).unwrap();
        assert_eq!(wiped.key_ids, vec!["FAKE-old".to_owned()]);
        assert_eq!(keys.entries().unwrap().len(), 1);
    }

    #[test]
    fn wipes_take_a_link_another_vault_or_all_and_the_last_takes_the_os_item() {
        let (temp, keys) = keys();
        keys.make_for(uuid(1), uuid(10), ORIGIN).unwrap();
        keys.make_for(uuid(1), uuid(11), ORIGIN).unwrap();
        keys.make_for(uuid(2), uuid(20), ORIGIN).unwrap();
        for (link, id) in [(10, "FAKE-10"), (11, "FAKE-11"), (20, "FAKE-20")] {
            keys.set_key_id(uuid(link), id).unwrap();
        }
        assert_eq!(keys.wipe_link(uuid(10)).unwrap().key_ids, vec!["FAKE-10"]);
        // An unlock of vault 1: vault 2's key goes.
        assert_eq!(
            keys.keep_only_vault(uuid(1)).unwrap().key_ids,
            vec!["FAKE-20"]
        );
        assert_eq!(keys.entries().unwrap().len(), 1);
        assert!(keys.store.get().unwrap().is_some());
        // Reset: the rest, and the wrap key with it; the file stays, its size.
        assert_eq!(keys.wipe_all().unwrap().key_ids, vec!["FAKE-11"]);
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
    fn with_no_keyring_nothing_is_made_and_a_wipe_with_no_file_asks_nothing() {
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
    fn the_seed_is_never_in_a_debug_print() {
        let (_temp, keys) = keys();
        keys.make_for(uuid(1), uuid(10), ORIGIN).unwrap();
        let entry = keys.entries().unwrap().remove(0);
        let printed = format!("{entry:?}");
        assert!(!printed.contains(&entry.seed), "{printed}");
        assert!(!printed.contains("seed"), "{printed}");
    }

    #[test]
    fn an_origin_or_key_id_out_of_bounds_is_refused() {
        let (_temp, keys) = keys();
        assert_eq!(
            keys.make_for(uuid(1), uuid(10), &"x".repeat(MAX_ORIGIN_BYTES + 1))
                .map(|_| ()),
            Err(NoticeKeyError::Damaged)
        );
        keys.make_for(uuid(1), uuid(10), ORIGIN).unwrap();
        assert_eq!(
            keys.set_key_id(uuid(10), &"k".repeat(MAX_KEY_ID_BYTES + 1)),
            Err(NoticeKeyError::Damaged)
        );
    }
}

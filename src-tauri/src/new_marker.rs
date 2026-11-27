//! What the patient has seen of the documents their clinics deliver, for the "New" marker (the
//! "{N} new from your clinic" strip and a New tag on a row). Nothing about it is in the vault: a
//! vault's format has no field for it and an older build would refuse one. It is a small local
//! file, one for each vault, **beside `vault-home`** like the notice keys, so a backup of the vault
//! does not hold it and a vault moved or restored from a backup starts with nothing new:
//!
//! - **What it holds.** A "seen up to" time and a short list of the ids of documents the patient
//!   opened since (at most [`MAX_OPENED`]). No name, no clinic, no content.
//! - **What it is not.** It is sealed with a key derived from the vault's master key (XChaCha20-
//!   Poly1305, a label of its own) and padded to one fixed size, so a copy of the file says
//!   neither which documents were opened nor how many, and it can only be read while the vault is
//!   unlocked, which is the only time it is used.
//! - **A missing file means nothing is new.** The first time a vault is opened with no file the
//!   state starts at "seen up to now" and is written at once, so a document that arrives later is
//!   new and one that was already there is not. A file that cannot be read or does not
//!   authenticate is treated the same way (it is never read as "everything is new").
//! - **The rule** ([`SeenState::is_new`]): a document is new when it was filed after "seen up to"
//!   and its id is not in the opened list. Whether it is a clinic document, not carried, not
//!   hidden and not in Shared with me is the caller's part (`vault.rs`).
//! - **Clearing.** Opening a document puts its id in the list; "Mark all as seen" moves "seen up
//!   to" past everything and empties the list. Nothing else clears it: not time, not scrolling,
//!   not unlocking. When the list is full, the state does what "Mark all as seen" does rather than
//!   forget which documents were opened (a document must not come back as new).
//!
//! The state is per device: each device has its own vault copy and its own deliveries, so a
//! document is new on a phone until it has been seen on the phone.

use atomicwrites::{AllowOverwrite, AtomicFile};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use sha2::Sha256;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;
use zeroize::Zeroizing;

/// The most opened documents the file remembers.
pub(crate) const MAX_OPENED: usize = 1000;

const MAGIC: &[u8; 8] = b"MCSEENS1";
const AAD: &[u8] = b"mycarlos-new-seen-v1";
const NONCE: usize = 24;
const TAG: usize = 16;
/// The plaintext's fixed size: the time (8), the count (2), the ids (16 each).
const PLAIN: usize = 8 + 2 + 16 * MAX_OPENED;
/// The file's fixed size, whatever it holds.
pub(crate) const FILE_BYTES: usize = MAGIC.len() + NONCE + PLAIN + TAG;

/// The time now, in milliseconds since the epoch.
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

/// The file's name for one vault, beside `vault-home`.
pub(crate) fn file_name(vault_id: Uuid) -> String {
    format!("new-seen-{}.v1", vault_id.simple())
}

/// The key the file is sealed with: one per vault and per master key, never the master key
/// itself, and no other part of the vault uses it.
pub(crate) fn derive_key(vault_id: Uuid, master_key: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    let hkdf = Hkdf::<Sha256>::new(Some(vault_id.as_bytes()), master_key);
    let mut key = Zeroizing::new([0_u8; 32]);
    // 32 bytes is far below the most HKDF-SHA256 can give.
    let _ = hkdf.expand(b"mycarlos/new-seen/v1", key.as_mut());
    key
}

/// What the patient has seen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SeenState {
    /// Documents filed at or before this time (milliseconds) are not new.
    seen_up_to_ms: u64,
    /// Documents filed after it that the patient opened, oldest first.
    opened: Vec<Uuid>,
}

impl SeenState {
    /// The state of a vault that has none yet: nothing that is there now is new.
    pub(crate) fn starting_at(now_ms: u64) -> Self {
        Self {
            seen_up_to_ms: now_ms,
            opened: Vec::new(),
        }
    }

    /// Whether a document filed at `imported_at_ms` is new to the patient (the part of the rule
    /// that the state knows).
    pub(crate) fn is_new(&self, id: Uuid, imported_at_ms: u64) -> bool {
        imported_at_ms > self.seen_up_to_ms && !self.opened.contains(&id)
    }

    /// Records that the patient opened these documents. `filed` is every document that can be
    /// new (an id and the time it was filed), for the one case in which the list is full: then it
    /// does what "Mark all as seen" does (`mark_all`, with the same limit on the clock) rather
    /// than forget which documents were opened. Returns whether anything changed.
    pub(crate) fn mark_opened(&mut self, ids: &[Uuid], filed: &[(Uuid, u64)], now_ms: u64) -> bool {
        let before = self.clone();
        for id in ids {
            if !self.opened.contains(id) {
                self.opened.push(*id);
            }
        }
        if self.opened.len() > MAX_OPENED {
            self.mark_all(filed, now_ms);
        }
        *self != before
    }

    /// "Mark all as seen": every document in `filed` (an id and the time it was filed) stops being
    /// new. "Seen up to" moves to the newest of them but never past `now_ms`, so that a clock that
    /// ran ahead cannot hide documents that arrive later; a document stamped after that (filed
    /// while the clock was ahead) is put in the opened list instead, so the one the patient just
    /// marked does not come back. When that list would be full, everything up to the newest is
    /// taken as seen.
    pub(crate) fn mark_all(&mut self, filed: &[(Uuid, u64)], now_ms: u64) -> bool {
        let before = self.clone();
        let newest = filed.iter().map(|(_, at)| *at).max().unwrap_or(0);
        self.seen_up_to_ms = self.seen_up_to_ms.max(newest.min(now_ms));
        let later: Vec<Uuid> = filed
            .iter()
            .filter(|(_, at)| *at > self.seen_up_to_ms)
            .map(|(id, _)| *id)
            .collect();
        if later.len() > MAX_OPENED {
            self.seen_up_to_ms = self.seen_up_to_ms.max(newest);
            self.opened.clear();
        } else {
            self.opened = later;
        }
        *self != before
    }

    /// Forgets opened ids that no longer matter: documents filed at or before "seen up to" are
    /// not new whatever the list says, and a document that is gone needs no entry.
    /// `imported_at_ms` gives the time a document was filed, or None when there is no such
    /// document.
    pub(crate) fn prune(&mut self, imported_at_ms: impl Fn(Uuid) -> Option<u64>) -> bool {
        let before = self.opened.len();
        let seen = self.seen_up_to_ms;
        self.opened
            .retain(|id| imported_at_ms(*id).is_some_and(|at| at > seen));
        self.opened.len() != before
    }

    /// The "seen up to" time.
    #[cfg(test)]
    pub(crate) fn seen_up_to_ms(&self) -> u64 {
        self.seen_up_to_ms
    }

    #[cfg(test)]
    pub(crate) fn opened(&self) -> &[Uuid] {
        &self.opened
    }

    fn to_plain(&self) -> Zeroizing<Vec<u8>> {
        let mut plain = Zeroizing::new(vec![0_u8; PLAIN]);
        plain[..8].copy_from_slice(&self.seen_up_to_ms.to_be_bytes());
        let count = self.opened.len().min(MAX_OPENED);
        plain[8..10].copy_from_slice(&(count as u16).to_be_bytes());
        for (index, id) in self.opened.iter().take(count).enumerate() {
            let at = 10 + 16 * index;
            plain[at..at + 16].copy_from_slice(id.as_bytes());
        }
        plain
    }

    fn from_plain(plain: &[u8]) -> Option<Self> {
        if plain.len() != PLAIN {
            return None;
        }
        let seen_up_to_ms = u64::from_be_bytes(plain[..8].try_into().ok()?);
        let count = usize::from(u16::from_be_bytes(plain[8..10].try_into().ok()?));
        if count > MAX_OPENED {
            return None;
        }
        // The unused room is zeros, as it was written.
        if plain[10 + 16 * count..].iter().any(|byte| *byte != 0) {
            return None;
        }
        let mut opened = Vec::with_capacity(count);
        for index in 0..count {
            let at = 10 + 16 * index;
            let id = Uuid::from_slice(&plain[at..at + 16]).ok()?;
            if opened.contains(&id) {
                return None;
            }
            opened.push(id);
        }
        Some(Self {
            seen_up_to_ms,
            opened,
        })
    }
}

/// Why a state could not be read.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LoadError {
    /// There is no file.
    Missing,
    /// There is a file that is not exactly what this version writes, or that does not
    /// authenticate under this vault's key (damaged, from another vault, or changed).
    Damaged,
    /// The file could not be read at all.
    Unreadable,
}

/// Reads the state sealed in `path` (the session reads it through `Slot::read`, which a test can
/// make fail; this is the plain read, for the tests of the file itself).
#[cfg(test)]
pub(crate) fn load(path: &Path, key: &[u8; 32]) -> Result<SeenState, LoadError> {
    load_with(path, key, &|path| fs::read(path))
}

/// `load`, reading the file's bytes through `read`, so that a test can make the read fail the way a
/// passing input or output error does (running as the owner or as root, a permission cannot).
pub(crate) fn load_with(
    path: &Path,
    key: &[u8; 32],
    read: &dyn Fn(&Path) -> io::Result<Vec<u8>>,
) -> Result<SeenState, LoadError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(LoadError::Missing),
        Err(_) => return Err(LoadError::Unreadable),
    };
    // A link or anything but a plain file of exactly the size this version writes is not ours.
    if !metadata.is_file() || metadata.len() != FILE_BYTES as u64 {
        return Err(LoadError::Damaged);
    }
    let bytes = read(path).map_err(|_| LoadError::Unreadable)?;
    if bytes.len() != FILE_BYTES || &bytes[..MAGIC.len()] != MAGIC {
        return Err(LoadError::Damaged);
    }
    let nonce = &bytes[MAGIC.len()..MAGIC.len() + NONCE];
    let sealed = &bytes[MAGIC.len() + NONCE..];
    let plain = Zeroizing::new(
        XChaCha20Poly1305::new(key.into())
            .decrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: sealed,
                    aad: AAD,
                },
            )
            .map_err(|_| LoadError::Damaged)?,
    );
    SeenState::from_plain(&plain).ok_or(LoadError::Damaged)
}

/// Writes the state to `path`: a new nonce each time, an atomic replace, readable by this user
/// only.
pub(crate) fn save(path: &Path, key: &[u8; 32], state: &SeenState) -> io::Result<()> {
    let plain = state.to_plain();
    let mut nonce = [0_u8; NONCE];
    OsRng.fill_bytes(&mut nonce);
    let sealed = XChaCha20Poly1305::new(key.into())
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plain,
                aad: AAD,
            },
        )
        .map_err(|_| io::Error::other("the seen file could not be sealed"))?;
    let mut bytes = Vec::with_capacity(FILE_BYTES);
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&nonce);
    bytes.extend_from_slice(&sealed);
    debug_assert_eq!(bytes.len(), FILE_BYTES);
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder)?;
    }
    // A link in the file's place is not followed or replaced into.
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_file() {
            return Err(io::Error::other("the seen file's place is not a file"));
        }
    }
    AtomicFile::new(path, AllowOverwrite)
        .write(|file| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(fs::Permissions::from_mode(0o600))?;
            }
            file.write_all(&bytes)
        })
        .map_err(|error| match error {
            atomicwrites::Error::Internal(error) | atomicwrites::Error::User(error) => error,
        })
}

/// Where a vault's file is: beside its `vault-home`.
pub(crate) fn path_beside(vault_home: &Path, vault_id: Uuid) -> Option<PathBuf> {
    Some(vault_home.parent()?.join(file_name(vault_id)))
}

/// What a session needs to find and open its file.
pub(crate) struct Context<'a> {
    pub vault_id: Uuid,
    pub master_key: &'a [u8; 32],
    /// The vault's `vault-home`, beside which the file is; None when it has no folder to be
    /// beside (the state then lives in memory for the session).
    pub vault_home: Option<&'a Path>,
}

struct Loaded {
    /// None when the vault's place has no folder beside it (then the state lives in memory only).
    path: Option<PathBuf>,
    key: Zeroizing<[u8; 32]>,
    state: SeenState,
}

/// The session's copy of the state: read once, when it is first asked for, and gone with the
/// session. Held inside the unlocked vault.
#[derive(Default)]
pub(crate) struct Slot {
    loaded: Mutex<Option<Loaded>>,
    /// Tests: the read of the file answers as an input or output error would.
    #[cfg(test)]
    unreadable: std::sync::atomic::AtomicBool,
}

impl Slot {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Loaded>> {
        self.loaded
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Tests: from now on the file cannot be read (until `true` is given again as `false`).
    #[cfg(test)]
    pub(crate) fn make_unreadable_for_test(&self, unreadable: bool) {
        self.unreadable
            .store(unreadable, std::sync::atomic::Ordering::SeqCst);
    }

    /// Tests: forgets the state, as a lock does, so that the next use reads the file again.
    #[cfg(test)]
    pub(crate) fn forget_for_test(&self) {
        *self.lock() = None;
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        #[cfg(test)]
        if self.unreadable.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(io::Error::other("FAKE: the file cannot be read for now"));
        }
        fs::read(path)
    }

    /// Reads the file (or starts the state at `now_ms` when there is none, or it is not ours, and
    /// writes that at once so that "now" stays where it was put). A file that cannot be read at
    /// all is another matter: this session works in memory only (no path is kept), so nothing
    /// is ever written over it, now or at a later mark, and the next unlock can read it again.
    fn ensure<'a>(
        &self,
        guard: &'a mut Option<Loaded>,
        context: &Context<'_>,
        now_ms: u64,
    ) -> &'a mut Loaded {
        guard.get_or_insert_with(|| {
            let key = derive_key(context.vault_id, context.master_key);
            let path = context
                .vault_home
                .and_then(|home| path_beside(home, context.vault_id));
            let read = |path: &Path| self.read(path);
            let (state, path) = match path.as_deref().map(|path| load_with(path, &key, &read)) {
                Some(Ok(state)) => (state, path),
                Some(Err(LoadError::Unreadable)) => (SeenState::starting_at(now_ms), None),
                _ => {
                    let fresh = SeenState::starting_at(now_ms);
                    if let Some(path) = &path {
                        // A failed write leaves the state in memory for this session.
                        let _ = save(path, &key, &fresh);
                    }
                    (fresh, path)
                }
            };
            Loaded { path, key, state }
        })
    }

    /// A copy of the state, for working out which documents are new.
    pub(crate) fn state(&self, context: &Context<'_>, now_ms: u64) -> SeenState {
        let mut guard = self.lock();
        self.ensure(&mut guard, context, now_ms).state.clone()
    }

    /// Changes the state and writes it when `change` says it changed. On a failed write the
    /// state in memory is left as it was: what the patient was told is still true.
    pub(crate) fn update(
        &self,
        context: &Context<'_>,
        now_ms: u64,
        change: impl FnOnce(&mut SeenState) -> bool,
    ) -> io::Result<()> {
        let mut guard = self.lock();
        let loaded = self.ensure(&mut guard, context, now_ms);
        let mut next = loaded.state.clone();
        if !change(&mut next) {
            return Ok(());
        }
        if let Some(path) = &loaded.path {
            save(path, &loaded.key, &next)?;
        }
        loaded.state = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7; 32];

    fn id(n: u128) -> Uuid {
        Uuid::from_u128(n + 1)
    }

    #[test]
    fn a_document_is_new_only_after_seen_up_to_and_until_it_is_opened() {
        let mut state = SeenState::starting_at(1_000);
        assert!(!state.is_new(id(1), 999));
        // The moment of "seen up to" itself is seen: only later ones are new.
        assert!(!state.is_new(id(1), 1_000));
        assert!(state.is_new(id(1), 1_001));
        assert!(state.is_new(id(2), 5_000));
        let filed = [(id(1), 1_001), (id(2), 5_000)];
        assert!(state.mark_opened(&[id(1)], &filed, 9_000));
        assert!(!state.is_new(id(1), 1_001));
        assert!(state.is_new(id(2), 5_000));
        // Opening the same document again changes nothing.
        assert!(!state.mark_opened(&[id(1)], &filed, 9_000));
        assert_eq!(state.opened(), [id(1)]);
    }

    #[test]
    fn mark_all_moves_seen_up_to_past_everything_and_empties_the_list() {
        let mut state = SeenState::starting_at(1_000);
        state.mark_opened(&[id(1), id(2)], &[], 9_000);
        assert!(state.mark_all(&[(id(1), 5_000), (id(2), 7_000)], 8_000));
        assert_eq!(state.seen_up_to_ms(), 7_000);
        assert!(state.opened().is_empty());
        assert!(!state.is_new(id(3), 7_000));
        assert!(state.is_new(id(3), 7_001));
        // It never goes back, whatever it is given.
        assert!(!state.mark_all(&[(id(1), 3_000)], 8_000));
        assert_eq!(state.seen_up_to_ms(), 7_000);
    }

    #[test]
    fn a_clock_that_ran_ahead_cannot_hide_a_document_that_arrives_later() {
        let mut state = SeenState::starting_at(1_000);
        // Two documents were filed while the clock was a day ahead; it is 5,000 now.
        let ahead = 5_000 + 86_400_000;
        assert!(state.mark_all(&[(id(1), 4_000), (id(2), ahead)], 5_000));
        // "Seen up to" is not past now, so a document filed at 6,000 is new...
        assert_eq!(state.seen_up_to_ms(), 5_000);
        assert!(state.is_new(id(3), 6_000));
        // ...and the one the patient marked, stamped in the future, does not come back.
        assert!(!state.is_new(id(2), ahead));
        assert!(!state.is_new(id(1), 4_000));
        assert_eq!(state.opened(), [id(2)]);
        // Marking again with nothing newer changes nothing.
        assert!(!state.mark_all(&[(id(1), 4_000), (id(2), ahead)], 5_000));
    }

    #[test]
    fn marking_all_with_more_future_documents_than_the_list_holds_takes_everything_as_seen() {
        let mut state = SeenState::starting_at(0);
        let filed: Vec<(Uuid, u64)> = (0..(MAX_OPENED as u128 + 1))
            .map(|n| (id(n), 90_000))
            .collect();
        assert!(state.mark_all(&filed, 5_000));
        assert!(state.opened().is_empty());
        assert_eq!(state.seen_up_to_ms(), 90_000);
        assert!(!state.is_new(id(1), 90_000));
    }

    #[test]
    fn a_full_list_turns_into_mark_all_and_never_makes_an_opened_document_new_again() {
        let mut state = SeenState::starting_at(0);
        let ids: Vec<Uuid> = (0..MAX_OPENED as u128).map(id).collect();
        let mut filed: Vec<(Uuid, u64)> = ids.iter().map(|id| (*id, 40_000)).collect();
        filed.push((id(5_000), 40_000));
        state.mark_opened(&ids, &filed, 60_000);
        assert_eq!(state.opened().len(), MAX_OPENED);
        // One more is one too many: it does what "Mark all as seen" does.
        state.mark_opened(&[id(5_000)], &filed, 60_000);
        assert!(state.opened().is_empty());
        assert_eq!(state.seen_up_to_ms(), 40_000);
        for n in [0, 17, 999, 5_000] {
            assert!(!state.is_new(id(n), 40_000));
        }
    }

    #[test]
    fn a_full_list_does_not_let_a_clock_that_ran_ahead_hide_later_documents() {
        let mut state = SeenState::starting_at(0);
        let ids: Vec<Uuid> = (0..MAX_OPENED as u128).map(id).collect();
        // All filed while the clock was ahead of what it says now (5,000): one more document
        // opened fills the list. "Seen up to" must not pass now, so a document at 6,000 is new;
        // the documents the patient opened stay seen (the list holds them).
        let ahead = 90_000;
        let mut filed: Vec<(Uuid, u64)> = ids.iter().map(|id| (*id, ahead)).collect();
        filed.push((id(5_000), ahead));
        state.mark_opened(&ids, &filed, 5_000);
        state.mark_opened(&[id(5_000)], &filed, 5_000);
        // So many future-stamped documents cannot all be listed: everything up to the newest is
        // seen, which is the one case where the clock's lead is taken as it is.
        assert_eq!(state.seen_up_to_ms(), ahead);
        assert!(!state.is_new(id(3), ahead));
        // With only a few of them, the cap holds.
        let mut few = SeenState::starting_at(0);
        let some = [(id(1), ahead), (id(2), 4_000)];
        few.mark_opened(&[id(1)], &some, 5_000);
        assert_eq!(few.seen_up_to_ms(), 0);
        few.mark_all(&some, 5_000);
        assert_eq!(few.seen_up_to_ms(), 5_000);
        assert!(few.is_new(id(9), 6_000));
        assert!(!few.is_new(id(1), ahead));
    }

    #[test]
    fn prune_forgets_only_what_the_caller_says_no_longer_matters() {
        // id(1) is filed after "seen up to" (10), id(2) is gone, id(3) is not newer than it.
        let mut state = SeenState::starting_at(10);
        state.mark_opened(&[id(1), id(2), id(3)], &[], 100);
        let filed = |candidate: Uuid| {
            if candidate == id(1) {
                Some(50)
            } else if candidate == id(3) {
                Some(10)
            } else {
                None
            }
        };
        assert!(state.prune(filed));
        assert_eq!(state.opened(), [id(1)]);
        assert!(!state.prune(filed));
    }

    #[test]
    fn the_file_is_one_fixed_size_sealed_and_reads_back_exactly() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(file_name(Uuid::from_u128(9)));
        assert_eq!(load(&path, &KEY), Err(LoadError::Missing));
        let empty = SeenState::starting_at(123);
        save(&path, &KEY, &empty).unwrap();
        let first = fs::read(&path).unwrap();
        assert_eq!(first.len(), FILE_BYTES);
        assert_eq!(load(&path, &KEY).unwrap(), empty);
        let mut full = SeenState::starting_at(u64::MAX - 1);
        full.mark_opened(&(0..400).map(id).collect::<Vec<_>>(), &[], 0);
        save(&path, &KEY, &full).unwrap();
        let second = fs::read(&path).unwrap();
        // The size says nothing about how many were opened, and nothing is readable in it.
        assert_eq!(second.len(), FILE_BYTES);
        assert_eq!(load(&path, &KEY).unwrap(), full);
        let marker = id(7).as_bytes().to_vec();
        assert!(!second.windows(16).any(|window| window == marker));
        // A new nonce each time: the same state is not the same bytes.
        save(&path, &KEY, &full).unwrap();
        assert_ne!(fs::read(&path).unwrap(), second);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn a_wrong_key_a_change_or_a_file_of_another_size_is_damaged_and_never_everything_new() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("seen");
        save(&path, &KEY, &SeenState::starting_at(5)).unwrap();
        assert_eq!(load(&path, &[8; 32]), Err(LoadError::Damaged));
        let good = fs::read(&path).unwrap();
        for index in [0, 8, 20, 40, FILE_BYTES - 1] {
            let mut bad = good.clone();
            bad[index] ^= 1;
            fs::write(&path, &bad).unwrap();
            assert_eq!(load(&path, &KEY), Err(LoadError::Damaged), "{index}");
        }
        for length in [0, 1, FILE_BYTES - 1] {
            fs::write(&path, &good[..length]).unwrap();
            assert_eq!(load(&path, &KEY), Err(LoadError::Damaged), "{length}");
        }
        let mut longer = good.clone();
        longer.push(0);
        fs::write(&path, &longer).unwrap();
        assert_eq!(load(&path, &KEY), Err(LoadError::Damaged));
        // A folder where the file belongs is not read, and not written into.
        let folder = temp.path().join("folder");
        fs::create_dir(&folder).unwrap();
        assert_eq!(load(&folder, &KEY), Err(LoadError::Damaged));
        assert!(save(&folder, &KEY, &SeenState::starting_at(1)).is_err());
    }

    #[test]
    fn a_file_with_a_repeated_id_or_stray_bytes_in_its_free_room_is_refused() {
        let mut state = SeenState::starting_at(1);
        state.opened = vec![id(1), id(1)];
        assert_eq!(SeenState::from_plain(&state.to_plain()), None);
        let mut room = SeenState::starting_at(1);
        room.opened = vec![id(1)];
        let mut plain = room.to_plain().to_vec();
        plain[PLAIN - 1] = 1;
        assert_eq!(SeenState::from_plain(&plain), None);
        let mut count = SeenState::starting_at(1).to_plain().to_vec();
        count[8..10].copy_from_slice(&((MAX_OPENED + 1) as u16).to_be_bytes());
        assert_eq!(SeenState::from_plain(&count), None);
        assert_eq!(SeenState::from_plain(&[0; 3]), None);
    }

    #[test]
    fn the_key_and_the_file_name_are_per_vault_and_say_nothing_else() {
        let (a, b) = (Uuid::from_u128(1), Uuid::from_u128(2));
        assert_ne!(derive_key(a, &[1; 32]), derive_key(b, &[1; 32]));
        assert_ne!(derive_key(a, &[1; 32]), derive_key(a, &[2; 32]));
        assert_eq!(derive_key(a, &[1; 32]), derive_key(a, &[1; 32]));
        assert_ne!(*derive_key(a, &[1; 32]), [1; 32]);
        assert_ne!(file_name(a), file_name(b));
        assert_eq!(
            path_beside(Path::new("/data/vault-home"), a).unwrap(),
            Path::new("/data").join(file_name(a))
        );
        assert_eq!(path_beside(Path::new("/"), a), None);
    }
}

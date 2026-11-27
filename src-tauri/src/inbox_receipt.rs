//! The sealed inbox (#49), stage 2: sealing what is shared to a locked app.
//!
//! `received::ReceivedFiles` holds a share in memory when the vault is open, as it always has. When
//! the vault is locked and an inbox has a key, it hands the share here instead: each file is read,
//! checked for the PDF header, and sealed to the inbox's public key (`inbox_folder`), so that
//! nothing is lost if the app is closed, or a system grant ends, before the next unlock. Nothing in
//! the vault is read or written, and nothing readable is left on disk.
//!
//! Until an unlock has written the inbox's public key (stage 3), there is no inbox to seal to and
//! every receipt is held in memory exactly as before: this stage changes nothing by itself.
//!
//! **Only a device that holds exactly ONE vault seals to disk.** With several vaults a locked app
//! cannot tell whose phone it is: the lock screen is always the default vault (it returns there
//! after every lock, and the unlock form names the vault by what is typed), so "the vault whose lock
//! screen is up" is the default vault whoever picked the phone up, and a share made by another
//! vault's owner would be sealed into the default vault's inbox. So with several vaults nothing is
//! sealed to any vault's folder: the share is held in memory (a locked page is told a count and no
//! name) and offered to whoever unlocks next, as before the sealed inbox existed.

use crate::inbox_folder::{InboxFolder, SealFailure};
use crate::received::{received_name, ReceivedSource, SealTally, Sealer};
use crate::sealed_inbox::Source;
use crate::vault_source::StoreHandle;
use std::{io::Read, path::PathBuf};
use uuid::Uuid;

/// What a locked app may know about the device's vaults at one instant, read together from one
/// pinned handle so that the lock state and the vault come from the same store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LockScreen {
    /// The vault is known to be locked and it is the ONLY vault the device holds: its id, read from
    /// its header's clear text (no key). The only state that may seal to disk.
    OnlyVault(Uuid),
    /// Anything else: unlocked, or busy being unlocked or moved; several vaults (no way to say
    /// whose share it is); or no readable header. Nothing is sealed: the share is held in memory.
    NotSingle,
}

/// The device's lock screen as the sealer may use it (see [`LockScreen`]). A vault the registry
/// does not list (one found later, #357) is not counted: it has no slot to seal for.
pub(crate) fn lock_screen_of(handle: &StoreHandle) -> LockScreen {
    let handle = handle.pin();
    // One pinned handle (the pin scan wants this line first): the lock state, the vault count and
    // the id are of the same store.
    let store = handle.arc();
    if store.is_unlocked_now() != Some(false) {
        return LockScreen::NotSingle;
    }
    let all = handle.all();
    if all.len() != 1 || !std::sync::Arc::ptr_eq(&all[0], store) {
        return LockScreen::NotSingle;
    }
    store
        .header_vault_id()
        .map_or(LockScreen::NotSingle, LockScreen::OnlyVault)
}

/// Opens a received source for reading, with its length when the system gave one (only a hint:
/// the size limit is enforced on what is read). `None` when it cannot be opened.
pub(crate) type OpenSource =
    Box<dyn Fn(&ReceivedSource) -> Option<(Box<dyn Read + Send>, Option<u64>)> + Send + Sync>;

/// Seals shares while the vault is locked.
pub(crate) struct LockedSealer {
    /// The app's data folder, beside `vault-home`: the inbox folders are under it.
    base: PathBuf,
    /// The device's lock screen now ([`lock_screen_of`]): sealing happens only for
    /// [`LockScreen::OnlyVault`].
    screen: Box<dyn Fn() -> LockScreen + Send + Sync>,
    open: OpenSource,
    now: fn() -> u64,
}

impl LockedSealer {
    pub(crate) fn new(
        base: PathBuf,
        screen: Box<dyn Fn() -> LockScreen + Send + Sync>,
        open: OpenSource,
    ) -> Self {
        Self {
            base,
            screen,
            open,
            now: || {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |since| since.as_secs())
            },
        }
    }
}

impl Sealer for LockedSealer {
    fn seal(&self, sources: &[ReceivedSource]) -> Option<SealTally> {
        // Only a vault known to be locked AND the only one the device holds: an open vault takes the
        // file straight from where it is, a vault busy being unlocked or moved is not guessed
        // about, and with several vaults there is no way to say whose share this is, so none is
        // sealed to any vault's folder (the module documentation says why).
        let LockScreen::OnlyVault(vault_id) = (self.screen)() else {
            return None;
        };
        // That vault's own inbox, found by its id and never by search. A vault with no inbox yet
        // (not unlocked since the sealed inbox arrived) holds the share in memory, as before.
        let folder = InboxFolder::for_locked_vault(&self.base, vault_id)?;
        let public = folder.public_key()?;
        let now = (self.now)();
        // What no key is needed to remove: part-sealed leftovers and items far past their age.
        let _ = folder.sweep_locked(now);
        let mut tally = SealTally::default();
        for source in sources {
            let Some((reader, declared)) = (self.open)(source) else {
                tally.not_kept += 1;
                continue;
            };
            let kind = match source {
                ReceivedSource::ContentUri(_) => Source::Shared,
                ReceivedSource::Path(_) | ReceivedSource::Inbox(_) => Source::Opened,
            };
            match folder.seal(
                &public,
                reader,
                &received_name(source),
                kind,
                declared,
                now,
                &|| false,
            ) {
                Ok(_) => tally.kept += 1,
                Err(SealFailure::NotPdf) => tally.not_pdf += 1,
                Err(_) => tally.not_kept += 1,
            }
        }
        Some(tally)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inbox_folder::PUBLIC_FILE;
    use crate::sealed_inbox::InboxKeys;
    use std::{
        io::Cursor,
        sync::{Arc, Mutex},
    };
    use uuid::Uuid;

    fn vault(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    /// A device whose vault `n` has an inbox with its key; the folder's own keys are returned.
    fn device_with_inbox(base: &std::path::Path, n: u128) -> InboxKeys {
        let keys = InboxKeys::derive(&[n as u8; 32], vault(n)).unwrap();
        let folder = InboxFolder::new(base, vault(n));
        std::fs::create_dir_all(folder.dir()).unwrap();
        std::fs::write(folder.dir().join(PUBLIC_FILE), keys.public().to_bytes()).unwrap();
        keys
    }

    fn path(name: &str) -> ReceivedSource {
        ReceivedSource::Path(PathBuf::from(format!("/shared/{name}")))
    }

    /// A sealer over `files` (by the source's file name) for a device whose vault is `unlocked`
    /// (`Some(false)` = locked) and that holds ONLY the vault numbered `screen` (`None`: its header
    /// cannot be read). Anything but "known locked, the only vault, id readable" is
    /// [`LockScreen::NotSingle`], as `lock_screen_of` reads it.
    fn sealer(
        base: &std::path::Path,
        unlocked: Option<bool>,
        screen: Option<u128>,
        files: Vec<(&'static str, Vec<u8>)>,
    ) -> (LockedSealer, Arc<Mutex<Vec<String>>>) {
        let lock_screen = match (unlocked, screen) {
            (Some(false), Some(n)) => LockScreen::OnlyVault(vault(n)),
            _ => LockScreen::NotSingle,
        };
        sealer_on(base, lock_screen, files)
    }

    /// A sealer over `files` whose device reads as `lock_screen`.
    fn sealer_on(
        base: &std::path::Path,
        lock_screen: LockScreen,
        files: Vec<(&'static str, Vec<u8>)>,
    ) -> (LockedSealer, Arc<Mutex<Vec<String>>>) {
        let opened = Arc::new(Mutex::new(Vec::new()));
        let seen = opened.clone();
        let files: Vec<(String, Vec<u8>)> =
            files.into_iter().map(|(n, b)| (n.to_owned(), b)).collect();
        let open: OpenSource = Box::new(move |source| {
            let ReceivedSource::Path(path) = source else {
                return None;
            };
            let name = path.file_name()?.to_str()?.to_owned();
            seen.lock().unwrap().push(name.clone());
            let bytes = files.iter().find(|(n, _)| *n == name)?.1.clone();
            let length = bytes.len() as u64;
            Some((
                Box::new(Cursor::new(bytes)) as Box<dyn Read + Send>,
                Some(length),
            ))
        });
        (
            LockedSealer::new(base.to_path_buf(), Box::new(move || lock_screen), open),
            opened,
        )
    }

    fn pdf() -> Vec<u8> {
        b"%PDF-1.4 FAKE body".to_vec()
    }

    #[test]
    fn a_locked_app_with_an_inbox_seals_every_pdf_and_counts_the_rest() {
        let temp = tempfile::tempdir().unwrap();
        let keys = device_with_inbox(temp.path(), 1);
        let (sealer, _) = sealer(
            temp.path(),
            Some(false),
            Some(1),
            vec![
                ("a.pdf", pdf()),
                ("b.pdf", pdf()),
                ("notes.pdf", b"not a pdf at all".to_vec()),
            ],
        );
        let tally = sealer
            .seal(&[
                path("a.pdf"),
                path("b.pdf"),
                path("notes.pdf"),
                path("gone.pdf"),
            ])
            .unwrap();
        assert_eq!(
            tally,
            SealTally {
                kept: 2,
                not_pdf: 1,
                // gone.pdf could not be opened.
                not_kept: 1,
            }
        );
        let folder = InboxFolder::new(temp.path(), vault(1));
        assert_eq!(folder.count_waiting(&keys.public().key_id()), 2);
    }

    #[test]
    fn nothing_is_read_or_sealed_unless_the_vault_is_known_to_be_locked_and_its_own_inbox_has_a_key(
    ) {
        let temp = tempfile::tempdir().unwrap();
        // No inbox at all: held in memory.
        let (none, opened) = sealer(temp.path(), Some(false), Some(1), vec![("a.pdf", pdf())]);
        assert_eq!(none.seal(&[path("a.pdf")]), None);
        device_with_inbox(temp.path(), 1);
        for unlocked in [Some(true), None] {
            let (open_or_busy, opened_then) =
                sealer(temp.path(), unlocked, Some(1), vec![("a.pdf", pdf())]);
            assert_eq!(open_or_busy.seal(&[path("a.pdf")]), None, "{unlocked:?}");
            assert!(
                opened_then.lock().unwrap().is_empty(),
                "the file was not touched"
            );
        }
        // A lock screen whose vault cannot be named (an unreadable or mixed header) is not guessed
        // about, though a folder with a key exists.
        let (unnamed, opened_unnamed) =
            sealer(temp.path(), Some(false), None, vec![("a.pdf", pdf())]);
        assert_eq!(unnamed.seal(&[path("a.pdf")]), None);
        assert!(opened_unnamed.lock().unwrap().is_empty());
        assert!(opened.lock().unwrap().is_empty());
    }

    #[test]
    fn with_several_vaults_a_share_made_while_locked_is_sealed_to_none_and_offered_after_the_next_unlock(
    ) {
        // Two vaults that were each unlocked once, so each has an inbox with a key. The lock screen
        // is the default vault whoever picks the phone up, so a share cannot be told to be
        // anyone's: nothing may be sealed to either folder.
        let temp = tempfile::tempdir().unwrap();
        let keys_one = device_with_inbox(temp.path(), 1);
        let keys_two = device_with_inbox(temp.path(), 2);
        let (several, opened) =
            sealer_on(temp.path(), LockScreen::NotSingle, vec![("a.pdf", pdf())]);
        let received = crate::received::ReceivedFiles::default();
        received.set_sealer(Arc::new(several));
        received.receive(1, vec![path("a.pdf")]);
        // The file was not even read, and neither inbox holds an item or any other file but its key.
        assert!(opened.lock().unwrap().is_empty());
        for (n, keys) in [(1, &keys_one), (2, &keys_two)] {
            let folder = InboxFolder::new(temp.path(), vault(n));
            assert_eq!(
                folder.count_waiting(&keys.public().key_id()),
                0,
                "vault {n}"
            );
            let entries: Vec<_> = std::fs::read_dir(folder.dir())
                .unwrap()
                .map(|e| e.unwrap().file_name().into_string().unwrap())
                .collect();
            assert_eq!(entries, vec![PUBLIC_FILE.to_owned()], "vault {n}");
        }
        // It is held in memory, as before the sealed inbox: a locked page is told a count and no
        // name ...
        assert_eq!(received.len(), 1);
        let locked = crate::received::without_names_unless_unlocked(received.list(), Some(false));
        assert_eq!(locked.len(), 1);
        assert!(locked[0].name.is_empty());
        // ... and after the next unlock, whichever vault's owner unlocks, it is offered by name for
        // that person to confirm (it is never imported by itself).
        let unlocked = crate::received::without_names_unless_unlocked(received.list(), Some(true));
        assert_eq!(unlocked[0].name, "a.pdf");
        assert!(unlocked[0].needs_confirm);
    }

    #[test]
    fn the_lock_screen_is_a_vault_only_when_it_is_locked_and_the_only_one_the_device_holds() {
        use crate::vault::VaultStore;
        use crate::vault_source::{StoreHandle, VaultSource};
        use std::sync::Arc;
        const PASSWORD: &str = "river-azimuth-cobalt-sparrow-934";
        let temp = tempfile::tempdir().unwrap();
        let made = |name: &str| {
            let store = Arc::new(VaultStore::new(temp.path().join(name)));
            store.create(PASSWORD, "Jamie", 1).unwrap();
            let id = store.open_vault_id().unwrap();
            (store, id)
        };
        let (one, one_id) = made("one");
        let (two, _) = made("two");
        // One vault, unlocked: not a lock screen.
        let single = StoreHandle::single(Arc::clone(&one));
        assert_eq!(lock_screen_of(&single), LockScreen::NotSingle);
        // Locked, and the only vault: it is named by its header.
        one.lock();
        assert_eq!(lock_screen_of(&single), LockScreen::OnlyVault(one_id));
        // A device with a second vault: not the only one, whatever is locked.
        struct Both(Vec<Arc<VaultStore>>);
        impl VaultSource for Both {
            fn current(&self) -> &Arc<VaultStore> {
                &self.0[0]
            }
            fn all(&self) -> Vec<Arc<VaultStore>> {
                self.0.clone()
            }
        }
        two.lock();
        let several = StoreHandle::new(Both(vec![Arc::clone(&one), Arc::clone(&two)]));
        assert_eq!(lock_screen_of(&several), LockScreen::NotSingle);
        // A single store with no readable vault: nothing to name.
        let empty = StoreHandle::single(Arc::new(VaultStore::new(temp.path().join("empty"))));
        assert_eq!(lock_screen_of(&empty), LockScreen::NotSingle);
    }

    #[test]
    fn a_locked_receipt_sweeps_what_needs_no_key_to_remove() {
        let temp = tempfile::tempdir().unwrap();
        device_with_inbox(temp.path(), 1);
        let folder = InboxFolder::new(temp.path(), vault(1));
        let part = folder.dir().join(crate::sealed_inbox::part_file_name(
            &crate::sealed_inbox::ItemId([4; 16]),
        ));
        std::fs::write(&part, b"half an item").unwrap();
        let (sealer, _) = sealer(temp.path(), Some(false), Some(1), vec![("a.pdf", pdf())]);
        assert!(sealer.seal(&[path("a.pdf")]).is_some());
        assert!(!part.exists());
    }

    #[test]
    fn a_shared_content_uri_is_sealed_as_shared_and_a_path_as_opened() {
        // The kinds are in the sealed trailer; here only that both kinds are accepted.
        let temp = tempfile::tempdir().unwrap();
        let keys = device_with_inbox(temp.path(), 1);
        let (sealer, _) = sealer(temp.path(), Some(false), Some(1), vec![("a.pdf", pdf())]);
        assert_eq!(sealer.seal(&[path("a.pdf")]).unwrap().kept, 1);
        let folder = InboxFolder::new(temp.path(), vault(1));
        let item = std::fs::read_dir(folder.dir())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .find_map(|name| crate::sealed_inbox::parse_item_name(&name))
            .unwrap();
        let file = std::fs::File::open(
            folder
                .dir()
                .join(crate::sealed_inbox::item_file_name(&item)),
        )
        .unwrap();
        let opened = crate::sealed_inbox::open_item(&keys, &item, file).unwrap();
        assert_eq!(opened.meta.source, Source::Opened);
        assert_eq!(opened.meta.name, "a.pdf");
    }
}

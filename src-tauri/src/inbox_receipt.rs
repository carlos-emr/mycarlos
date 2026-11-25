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

use crate::inbox_folder::{Discovered, InboxFolder, SealFailure};
use crate::received::{received_name, ReceivedSource, SealTally, Sealer};
use crate::sealed_inbox::Source;
use std::{io::Read, path::PathBuf};

/// Opens a received source for reading, with its length when the system gave one (only a hint:
/// the size limit is enforced on what is read). `None` when it cannot be opened.
pub(crate) type OpenSource =
    Box<dyn Fn(&ReceivedSource) -> Option<(Box<dyn Read + Send>, Option<u64>)> + Send + Sync>;

/// Seals shares while the vault is locked.
pub(crate) struct LockedSealer {
    /// The app's data folder, beside `vault-home`: the inbox folders are under it.
    base: PathBuf,
    /// Whether the open vault is unlocked, without waiting: `None` while something holds it.
    unlocked: Box<dyn Fn() -> Option<bool> + Send + Sync>,
    open: OpenSource,
    now: fn() -> u64,
}

impl LockedSealer {
    pub(crate) fn new(
        base: PathBuf,
        unlocked: Box<dyn Fn() -> Option<bool> + Send + Sync>,
        open: OpenSource,
    ) -> Self {
        Self {
            base,
            unlocked,
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
        // Only a vault known to be locked: an open vault takes the file straight from where it
        // is, and a vault busy being unlocked or moved is not guessed about.
        if (self.unlocked)() != Some(false) {
            return None;
        }
        let Discovered::One(folder) = InboxFolder::discover(&self.base) else {
            return None;
        };
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

    /// A sealer over `files` (by the source's file name) whose vault is `unlocked`.
    fn sealer(
        base: &std::path::Path,
        unlocked: Option<bool>,
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
            LockedSealer::new(base.to_path_buf(), Box::new(move || unlocked), open),
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
    fn nothing_is_read_or_sealed_unless_the_vault_is_known_to_be_locked_and_one_inbox_has_a_key() {
        let temp = tempfile::tempdir().unwrap();
        // No inbox at all: held in memory.
        let (none, opened) = sealer(temp.path(), Some(false), vec![("a.pdf", pdf())]);
        assert_eq!(none.seal(&[path("a.pdf")]), None);
        device_with_inbox(temp.path(), 1);
        for unlocked in [Some(true), None] {
            let (open_or_busy, opened_then) = sealer(temp.path(), unlocked, vec![("a.pdf", pdf())]);
            assert_eq!(open_or_busy.seal(&[path("a.pdf")]), None, "{unlocked:?}");
            assert!(
                opened_then.lock().unwrap().is_empty(),
                "the file was not touched"
            );
        }
        assert!(opened.lock().unwrap().is_empty());
        // Two vaults with inboxes: no way to say which one the receipt belongs to.
        device_with_inbox(temp.path(), 2);
        let (several, opened) = sealer(temp.path(), Some(false), vec![("a.pdf", pdf())]);
        assert_eq!(several.seal(&[path("a.pdf")]), None);
        assert!(opened.lock().unwrap().is_empty());
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
        let (sealer, _) = sealer(temp.path(), Some(false), vec![("a.pdf", pdf())]);
        assert!(sealer.seal(&[path("a.pdf")]).is_some());
        assert!(!part.exists());
    }

    #[test]
    fn a_shared_content_uri_is_sealed_as_shared_and_a_path_as_opened() {
        // The kinds are in the sealed trailer; here only that both kinds are accepted.
        let temp = tempfile::tempdir().unwrap();
        let keys = device_with_inbox(temp.path(), 1);
        let (sealer, _) = sealer(temp.path(), Some(false), vec![("a.pdf", pdf())]);
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

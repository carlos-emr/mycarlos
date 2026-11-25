//! The sealed inbox (#49), stage 2: the folder on disk and the receipt that seals into it.
//!
//! Stage 1 (`sealed_inbox`) is the format: a key, an item, a sealer and an opener, and the caps
//! as pure functions. This is what runs them on a real folder, for the part that needs no
//! passphrase: a file shared while the vault is locked is checked, counted against the caps and
//! sealed to the vault's **public** inbox key, and a locked app can count what waits and sweep
//! what has been there far too long. Unlocking and importing is stage 3.
//!
//! One folder per vault, `<base>/inbox/<vault id>/`, outside `vault-home`. The folder is private
//! (0700 on Unix), nothing in it is ever followed through a link or reparse point, and only names
//! that match the item pattern exactly (`<32 hex>.mcin`, or `.part` while one is being sealed) are
//! ever opened, counted or deleted. An exclusive lock file is held while sealing and sweeping, so
//! two receipts cannot both pass the caps and a sweep never takes a part-sealed item from under a
//! sealer.

// The lock-screen count and the unlock import (stage 3) are the callers of what is not used yet.
#![cfg_attr(not(test), allow(dead_code))]

use crate::sealed_inbox::{
    admit, file_limit, item_file_name, long_expired, parse_item_name, parse_part_name,
    part_file_name, peek_header, usage_of, Caps, InboxError, InboxPublic, ItemId, KeyId, Refusal,
    Source, CAPS, HEADER_LEN,
};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use uuid::Uuid;

/// The one way this module removes a file (#71): always an inbox item or its part.
fn remove_item(path: impl AsRef<Path>) -> io::Result<()> {
    crate::vault::remove_owned_file(path, crate::vault::Removable::InboxItem)
}

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

/// The public half of the inbox key, as bytes: the file `inbox.pub` is exactly these 32.
pub(crate) const PUBLIC_FILE: &str = "inbox.pub";
const LOCK_FILE: &str = ".lock";
/// The lock-screen count stops here: the item cap, so it never needs to read more than this many.
const COUNT_CAP: usize = 100;

/// Why a received file was not sealed. Each is a reason to tell the patient (or, for `NotPdf`,
/// the same message as a refused file today); none leaves anything behind in the folder.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SealFailure {
    /// The file does not start the way a PDF does. Checked before anything is written.
    NotPdf,
    /// The folder is at one of its caps, or the disk is too full to seal into it.
    Refused(Refusal),
    /// The file could not be read (a grant that ended, a file that was moved).
    Unreadable,
    /// The file is empty, or longer than a file may be.
    Size(InboxError),
    /// The folder could not be made, locked or written.
    Storage,
    Cancelled,
}

/// An item that was sealed.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Sealed {
    pub(crate) item_id: ItemId,
    /// The size of the file as it lies in the folder.
    pub(crate) bytes: u64,
}

/// What a sweep removed.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Swept {
    pub(crate) parts: usize,
    pub(crate) items: usize,
}

/// What `InboxFolder::discover` found.
pub(crate) enum Discovered {
    None,
    One(InboxFolder),
    Several,
}

/// The most directory entries one unlock's listing looks at: far above the item cap (so a real
/// folder is always listed whole), and a bound on the walk of a flooded one.
// Used by the importing stage (stage 3); until then only its tests call it.
#[allow(dead_code)]
pub(crate) const MAX_LISTED_ENTRIES: usize = 10_000;

/// What an unlock may import from a folder (see `InboxFolder::import_plan`).
// Used by the importing stage (stage 3); until then only its tests call it.
#[allow(dead_code)]
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ImportPlan {
    /// Item file names to open, oldest first.
    pub(crate) take: Vec<String>,
    /// Items refused for the caps, never opened.
    pub(crate) refused: usize,
    /// The listing stopped at its bound: there were more entries than were looked at.
    pub(crate) listing_truncated: bool,
}

/// Picks, from `(name, bytes, file time)` of items, the oldest first (an unknown time counts as
/// the newest, then the name), while both the item count and the running total of bytes stay
/// within the caps; every other item is refused. Pure: it reads nothing.
// Used by the importing stage (stage 3); until then only its tests call it.
#[allow(dead_code)]
fn plan_import(
    mut items: Vec<(String, u64, Option<u64>)>,
    caps: &Caps,
    listing_truncated: bool,
) -> ImportPlan {
    items.sort_by(|a, b| (a.2.unwrap_or(u64::MAX), &a.0).cmp(&(b.2.unwrap_or(u64::MAX), &b.0)));
    let mut plan = ImportPlan {
        listing_truncated,
        ..ImportPlan::default()
    };
    let mut total = 0u64;
    for (name, bytes, _) in items {
        let fits = plan.take.len() < caps.items
            && bytes <= caps.file_bytes
            && total
                .checked_add(bytes)
                .is_some_and(|sum| sum <= caps.total_bytes);
        if fits {
            total += bytes;
            plan.take.push(name);
        } else {
            plan.refused += 1;
        }
    }
    plan
}

/// One inbox folder, of one vault.
pub(crate) struct InboxFolder {
    dir: PathBuf,
    caps: Caps,
    free_space: fn(&Path) -> Option<u64>,
}

struct Entry {
    name: String,
    bytes: u64,
    /// The file's own time, in Unix seconds: the only clock a locked app can read. `None` where
    /// the system gave none or one before 1970: an unknown age is never an old one (#49), so the
    /// locked sweep keeps such an item.
    modified: Option<u64>,
}

impl InboxFolder {
    /// The folder of `vault_id`, under `base` (the app's data folder, beside `vault-home`).
    /// Nothing is created until something is sealed.
    pub(crate) fn new(base: &Path, vault_id: Uuid) -> Self {
        Self {
            dir: base.join("inbox").join(vault_id.hyphenated().to_string()),
            caps: CAPS,
            free_space: crate::disk_space::free_bytes,
        }
    }

    #[cfg(test)]
    fn with(mut self, caps: Caps, free_space: fn(&Path) -> Option<u64>) -> Self {
        self.caps = caps;
        self.free_space = free_space;
        self
    }

    pub(crate) fn dir(&self) -> &Path {
        &self.dir
    }

    /// The inbox a locked app seals to. The app cannot read which vault it holds without the
    /// passphrase, so it looks at what the unlock left: the one folder under `<base>/inbox` that
    /// has a usable public key. None, or more than one (a device with several vaults, #357, or a
    /// vault that was reset and whose old folder is still there), means there is no inbox to seal
    /// to, and a received file is held in memory as before.
    pub(crate) fn discover(base: &Path) -> Discovered {
        let Ok(listing) = fs::read_dir(base.join("inbox")) else {
            return Discovered::None;
        };
        let mut found = None;
        for entry in listing.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            // Exactly the spelling a folder of ours has, and a real folder (not a link to one).
            let Some(vault_id) = Uuid::parse_str(&name)
                .ok()
                .filter(|id| id.hyphenated().to_string() == name)
            else {
                continue;
            };
            if !entry.metadata().is_ok_and(|meta| meta.file_type().is_dir()) {
                continue;
            }
            let folder = Self::new(base, vault_id);
            if folder.public_key().is_none() {
                continue;
            }
            if found.is_some() {
                return Discovered::Several;
            }
            found = Some(folder);
        }
        found.map_or(Discovered::None, Discovered::One)
    }

    /// The public key a locked app seals to, or `None` where there is no usable one: no file, a
    /// file of another size, or a key an item may not be sealed to. Nothing else is ever read
    /// from this file, and nothing sealed is read by a locked app.
    pub(crate) fn public_key(&self) -> Option<InboxPublic> {
        let file = crate::vault::open_regular_read(&self.dir.join(PUBLIC_FILE)).ok()?;
        let mut bytes = Vec::with_capacity(33);
        // One byte more than a key: a longer file is not one.
        file.take(33).read_to_end(&mut bytes).ok()?;
        InboxPublic::from_bytes(&bytes).ok()
    }

    /// The folder's private directory, made if it is not there yet.
    fn ensure_dir(&self) -> io::Result<()> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        // The mode covers every folder made on the way (`inbox`, then the vault's).
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(&self.dir)?;
        // Look before changing anything: `set_permissions` follows a link, so a link planted
        // here must be refused before its target is touched.
        if !fs::symlink_metadata(&self.dir)?.file_type().is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the inbox folder is not a folder",
            ));
        }
        #[cfg(unix)]
        fs::set_permissions(
            &self.dir,
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )?;
        Ok(())
    }

    /// Holds the folder's exclusive lock until the returned file is dropped.
    fn lock(&self) -> io::Result<File> {
        self.ensure_dir()?;
        let path = self.dir.join(LOCK_FILE);
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        match options.open(&path) {
            Ok(_) => {}
            // Already there: it is opened below, without following a link.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        let file = crate::vault::open_without_following(&path)?;
        file.lock()?;
        Ok(file)
    }

    /// The entries that are plain files with a strict item or part name; anything else in the
    /// folder (a link, a directory, an odd name, the lock and key files) is not an entry.
    fn entries(&self) -> io::Result<Vec<Entry>> {
        self.listed_entries(usize::MAX).map(|(entries, _)| entries)
    }

    /// `entries`, but stops after `limit` of them; the flag says more were there.
    fn listed_entries(&self, limit: usize) -> io::Result<(Vec<Entry>, bool)> {
        let mut entries = Vec::new();
        let listing = match fs::read_dir(&self.dir) {
            Ok(listing) => listing,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok((entries, false)),
            Err(error) => return Err(error),
        };
        for entry in listing {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if parse_item_name(&name).is_none() && parse_part_name(&name).is_none() {
                continue;
            }
            if entries.len() >= limit {
                return Ok((entries, true));
            }
            // `DirEntry::metadata` does not follow a link.
            let metadata = entry.metadata()?;
            if !is_plain_file(&metadata) {
                continue;
            }
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|since| since.as_secs())
                // A zero is what a restore or copy tool writes when it has no time to give.
                .filter(|secs| *secs > 0);
            entries.push(Entry {
                name,
                bytes: metadata.len(),
                modified,
            });
        }
        Ok((entries, false))
    }

    /// Seals `input` into the folder for `public`: the PDF check first (nothing is written for
    /// another kind of file), then, under the lock, the part-sealed leftovers of a crash are
    /// removed and the caps are checked, then the file is streamed into `<id>.part`, synced, and
    /// renamed to `<id>.mcin`. Any failure removes the part. `declared` is the file's length
    /// where the system gave one; it only refuses early, and the limit is enforced on what is
    /// read.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn seal(
        &self,
        public: &InboxPublic,
        input: Box<dyn Read + Send>,
        name: &str,
        source: Source,
        declared: Option<u64>,
        now: u64,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Sealed, SealFailure> {
        let limit = file_limit(&self.caps);
        if declared.is_some_and(|length| length > limit) {
            return Err(SealFailure::Size(InboxError::TooLarge));
        }
        let input = crate::received::require_pdf_header(input).map_err(|error| {
            if crate::received::is_not_pdf(&error) {
                SealFailure::NotPdf
            } else {
                SealFailure::Unreadable
            }
        })?;
        let _lock = self.lock().map_err(|_| SealFailure::Storage)?;
        // Under the lock no sealer is mid-way, so every part here is a crash's leftover.
        self.remove_parts().map_err(|_| SealFailure::Storage)?;
        let usage = usage_of(
            self.entries()
                .map_err(|_| SealFailure::Storage)?
                .iter()
                .map(|entry| (entry.name.as_str(), entry.bytes)),
        );
        // Room that cannot be measured is room that is not there.
        let free = (self.free_space)(&self.dir).unwrap_or(0);
        admit(&usage, declared.unwrap_or(limit), free, &self.caps).map_err(SealFailure::Refused)?;

        let item_id = ItemId::random();
        let part = self.dir.join(part_file_name(&item_id));
        let item = self.dir.join(item_file_name(&item_id));
        let result = self.write_item(public, &item_id, name, source, input, &part, now, cancelled);
        let bytes = match result {
            Ok(bytes) => bytes,
            Err(failure) => {
                let _ = remove_item(&part);
                return Err(failure);
            }
        };
        if let Err(error) = fs::rename(&part, &item).and_then(|()| sync_dir(&self.dir)) {
            let _ = remove_item(&part);
            let _ = remove_item(&item);
            let _ = error;
            return Err(SealFailure::Storage);
        }
        // The size of what was read may be more than was declared: count it now, and give the
        // room back if the folder went over.
        // The item is sealed and safe by now: a folder that cannot be listed again is not a
        // failure to report, or the patient shares the file a second time.
        let after = self.entries().map(|entries| {
            usage_of(
                entries
                    .iter()
                    .map(|entry| (entry.name.as_str(), entry.bytes)),
            )
        });
        if after.is_ok_and(|after| after.bytes > self.caps.total_bytes) {
            let _ = remove_item(&item);
            return Err(SealFailure::Refused(Refusal::InboxFull));
        }
        Ok(Sealed { item_id, bytes })
    }

    #[allow(clippy::too_many_arguments)]
    fn write_item(
        &self,
        public: &InboxPublic,
        item_id: &ItemId,
        name: &str,
        source: Source,
        input: Box<dyn Read + Send>,
        part: &Path,
        now: u64,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<u64, SealFailure> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(part).map_err(|_| SealFailure::Storage)?;
        // A failure of the source, as the sealer sees it, is a failed read of the output or of
        // the input; the input's is the one the patient can act on.
        let mut failed_read = false;
        let reader = ReadWatch {
            inner: input,
            failed: &mut failed_read,
        };
        let sealed = crate::sealed_inbox::seal(
            public,
            item_id,
            name,
            now,
            source,
            reader,
            &mut file,
            file_limit(&self.caps),
            cancelled,
        );
        if let Err(error) = sealed {
            return Err(match error {
                InboxError::Cancelled => SealFailure::Cancelled,
                InboxError::TooLarge | InboxError::Empty => SealFailure::Size(error),
                InboxError::Io(_) if failed_read => SealFailure::Unreadable,
                _ => SealFailure::Storage,
            });
        }
        file.flush().map_err(|_| SealFailure::Storage)?;
        file.sync_all().map_err(|_| SealFailure::Storage)?;
        let bytes = file.metadata().map_err(|_| SealFailure::Storage)?.len();
        Ok(bytes)
    }

    /// Removes every part-sealed file. Only ever called under the lock.
    fn remove_parts(&self) -> io::Result<usize> {
        let mut removed = 0;
        for entry in self.entries()? {
            if parse_part_name(&entry.name).is_some()
                && remove_item(self.dir.join(&entry.name)).is_ok()
            {
                removed += 1;
            }
        }
        Ok(removed)
    }

    /// What an unlock may read from this folder, decided from the listing alone (nothing is
    /// opened): anyone who can write the folder can also fill it, so the importing stage takes at
    /// most the item count and the total bytes the caps allow, oldest first, and counts the rest
    /// as refused without reading a byte of them. The listing is itself bounded
    /// (`MAX_LISTED_ENTRIES`), so a flooded folder costs a bounded walk.
    // Used by the importing stage (stage 3); until then only its tests call it.
    #[allow(dead_code)]
    pub(crate) fn import_plan(&self) -> io::Result<ImportPlan> {
        let (entries, truncated) = self.listed_entries(MAX_LISTED_ENTRIES)?;
        let items: Vec<(String, u64, Option<u64>)> = entries
            .into_iter()
            .filter(|entry| parse_item_name(&entry.name).is_some())
            .map(|entry| (entry.name, entry.bytes, entry.modified))
            .collect();
        Ok(plan_import(items, &self.caps, truncated))
    }

    /// What a locked app may remove with no key: part-sealed leftovers, and items far past their
    /// age by file time (twice the age, so it never takes what an unlock would call fresh).
    /// Normal expiry, by the time sealed into an item, is the unlock's. A folder that is not
    /// there has nothing to sweep.
    pub(crate) fn sweep_locked(&self, now: u64) -> Result<Swept, SealFailure> {
        if !self.dir.exists() {
            return Ok(Swept::default());
        }
        let _lock = self.lock().map_err(|_| SealFailure::Storage)?;
        let mut swept = Swept::default();
        for entry in self.entries().map_err(|_| SealFailure::Storage)? {
            let remove = if parse_part_name(&entry.name).is_some() {
                swept.parts += 1;
                true
            } else {
                let old = entry
                    .modified
                    .is_some_and(|modified| long_expired(modified, now, &self.caps));
                swept.items += usize::from(old);
                old
            };
            if remove && remove_item(self.dir.join(&entry.name)).is_err() {
                // Counted above, but still there: do not say it was removed.
                if parse_part_name(&entry.name).is_some() {
                    swept.parts -= 1;
                } else {
                    swept.items -= 1;
                }
            }
        }
        Ok(swept)
    }

    /// How many well-formed items wait for `key_id`, for the lock screen: an item name that
    /// matches exactly, a header with the inbox magic and format, the same item id as the name,
    /// and this key. Junk is not counted, and nothing is read past the 80-byte header.
    pub(crate) fn count_waiting(&self, key_id: &KeyId) -> usize {
        let Ok(entries) = self.entries() else {
            return 0;
        };
        let mut count = 0;
        for entry in entries {
            let Some(named) = parse_item_name(&entry.name) else {
                continue;
            };
            let Ok(mut file) = crate::vault::open_regular_read(&self.dir.join(&entry.name)) else {
                continue;
            };
            let mut header = [0_u8; HEADER_LEN];
            if file.read_exact(&mut header).is_err() {
                continue;
            }
            if peek_header(&header).is_some_and(|(id, key)| id == named && key == *key_id) {
                count += 1;
                if count >= COUNT_CAP {
                    break;
                }
            }
        }
        count
    }
}

/// Notes that a read of the input failed, so a failed read of the source is told apart from a
/// failed write of the folder.
struct ReadWatch<'a> {
    inner: Box<dyn Read + Send>,
    failed: &'a mut bool,
}

impl Read for ReadWatch<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buf);
        if read
            .as_ref()
            .is_err_and(|e| e.kind() != io::ErrorKind::Interrupted)
        {
            *self.failed = true;
        }
        read
    }
}

fn is_plain_file(metadata: &fs::Metadata) -> bool {
    if !metadata.file_type().is_file() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_REPARSE_POINT
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    true
}

/// Makes the rename into `dir` durable. Windows cannot open a folder this way; there the rename
/// rests on the file system's journal.
fn sync_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(dir)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sealed_inbox::{open_item, InboxKeys};
    use std::io::Cursor;

    const NOW: u64 = 1_800_000_000;

    fn vault() -> Uuid {
        Uuid::from_u128(0x11)
    }

    fn keys() -> InboxKeys {
        InboxKeys::derive(&[7_u8; 32], vault()).unwrap()
    }

    fn roomy(_: &Path) -> Option<u64> {
        Some(u64::MAX / 2)
    }

    fn folder(base: &Path) -> InboxFolder {
        InboxFolder::new(base, vault()).with(CAPS, roomy)
    }

    fn pdf(len: usize) -> Vec<u8> {
        let mut bytes = b"%PDF-1.4 FAKE ".to_vec();
        bytes.resize(len.max(bytes.len()), b'x');
        bytes
    }

    fn seal(folder: &InboxFolder, keys: &InboxKeys, data: Vec<u8>) -> Result<Sealed, SealFailure> {
        let declared = Some(data.len() as u64);
        folder.seal(
            keys.public(),
            Box::new(Cursor::new(data)),
            "report.pdf",
            Source::Shared,
            declared,
            NOW,
            &|| false,
        )
    }

    fn names(folder: &InboxFolder) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(folder.dir())
            .map(|listing| {
                listing
                    .map(|e| e.unwrap().file_name().into_string().unwrap())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn a_pdf_is_sealed_into_a_private_folder_and_opens_only_with_the_key() {
        let temp = tempfile::tempdir().unwrap();
        let (folder, keys) = (folder(temp.path()), keys());
        let data = pdf(5000);
        let sealed = seal(&folder, &keys, data.clone()).unwrap();
        let item = folder.dir().join(item_file_name(&sealed.item_id));
        assert_eq!(fs::metadata(&item).unwrap().len(), sealed.bytes);
        // Only the item and the lock: the part is gone.
        let mut expected = vec![item_file_name(&sealed.item_id), LOCK_FILE.to_owned()];
        expected.sort();
        assert_eq!(names(&folder), expected);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(folder.dir()), 0o700);
            assert_eq!(mode(&item), 0o600);
        }
        // Nothing readable in the file: not the name, not the text.
        let raw = fs::read(&item).unwrap();
        assert!(!raw.windows(10).any(|w| w == b"report.pdf"));
        assert!(!raw.windows(5).any(|w| w == b"%PDF-"));
        let opened = open_item(&keys, &sealed.item_id, File::open(&item).unwrap()).unwrap();
        assert_eq!(opened.meta.name, "report.pdf");
        assert_eq!(opened.meta.received_at, NOW);
        assert_eq!(opened.meta.plaintext_size, data.len() as u64);
    }

    #[test]
    fn a_file_that_is_not_a_pdf_writes_nothing_at_all() {
        let temp = tempfile::tempdir().unwrap();
        let (folder, keys) = (folder(temp.path()), keys());
        let result = seal(&folder, &keys, b"hello, not a pdf".to_vec());
        assert_eq!(result, Err(SealFailure::NotPdf));
        assert!(!folder.dir().exists(), "not even the folder was made");
    }

    #[test]
    fn the_caps_refuse_and_a_refusal_leaves_the_folder_as_it_was() {
        let temp = tempfile::tempdir().unwrap();
        let keys = keys();
        let small = Caps {
            items: 2,
            total_bytes: 20_000,
            ..CAPS
        };
        let folder = InboxFolder::new(temp.path(), vault()).with(small, roomy);
        seal(&folder, &keys, pdf(4000)).unwrap();
        seal(&folder, &keys, pdf(4000)).unwrap();
        let before = names(&folder);
        assert_eq!(
            seal(&folder, &keys, pdf(100)),
            Err(SealFailure::Refused(Refusal::TooManyItems))
        );
        assert_eq!(names(&folder), before);
        // The byte cap: two items of 4000 bytes fit under 20 000, a third of 20 000 does not.
        let temp = tempfile::tempdir().unwrap();
        let folder =
            InboxFolder::new(temp.path(), vault()).with(Caps { items: 10, ..small }, roomy);
        seal(&folder, &keys, pdf(4000)).unwrap();
        assert_eq!(
            seal(&folder, &keys, pdf(20_000)),
            Err(SealFailure::Refused(Refusal::InboxFull))
        );
        assert_eq!(names(&folder).len(), 2, "the first item and the lock");
    }

    #[test]
    fn a_file_over_the_file_limit_is_refused_by_its_declared_length_and_by_what_is_read() {
        let temp = tempfile::tempdir().unwrap();
        let keys = keys();
        let caps = Caps {
            file_bytes: 10_000,
            ..CAPS
        };
        let folder = InboxFolder::new(temp.path(), vault()).with(caps, roomy);
        // Declared too long: refused before the file is read.
        let result = folder.seal(
            keys.public(),
            Box::new(Cursor::new(pdf(10))),
            "a.pdf",
            Source::Shared,
            Some(10_001),
            NOW,
            &|| false,
        );
        assert_eq!(result, Err(SealFailure::Size(InboxError::TooLarge)));
        // Declared short (or not at all) but longer when read: stopped while streaming, nothing kept.
        for declared in [Some(100), None] {
            let result = folder.seal(
                keys.public(),
                Box::new(Cursor::new(pdf(10_500))),
                "a.pdf",
                Source::Shared,
                declared,
                NOW,
                &|| false,
            );
            assert_eq!(
                result,
                Err(SealFailure::Size(InboxError::TooLarge)),
                "{declared:?}"
            );
            assert!(
                !names(&folder)
                    .iter()
                    .any(|n| n.ends_with(".part") || n.ends_with(".mcin")),
                "nothing left behind"
            );
        }
    }

    #[test]
    fn too_little_free_space_or_none_known_refuses_before_anything_is_written() {
        fn tight(_: &Path) -> Option<u64> {
            Some(CAPS.free_reserve)
        }
        fn unknown(_: &Path) -> Option<u64> {
            None
        }
        let keys = keys();
        for probe in [tight as fn(&Path) -> Option<u64>, unknown] {
            let temp = tempfile::tempdir().unwrap();
            let folder = InboxFolder::new(temp.path(), vault()).with(CAPS, probe);
            assert_eq!(
                seal(&folder, &keys, pdf(1000)),
                Err(SealFailure::Refused(Refusal::NoRoom))
            );
            assert!(!names(&folder).iter().any(|n| n.ends_with(".mcin")));
        }
    }

    #[test]
    fn a_source_that_fails_mid_stream_leaves_no_part_and_is_told_apart_from_a_full_disk() {
        struct Breaks(usize);
        impl Read for Breaks {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                if self.0 == 0 {
                    return Err(io::Error::other("the grant ended"));
                }
                let n = buf.len().min(self.0).min(512);
                buf[..n].fill(b'%');
                buf[..5.min(n)].copy_from_slice(&b"%PDF-"[..5.min(n)]);
                self.0 -= n;
                Ok(n)
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let (folder, keys) = (folder(temp.path()), keys());
        let result = folder.seal(
            keys.public(),
            Box::new(Breaks(3000)),
            "a.pdf",
            Source::Shared,
            None,
            NOW,
            &|| false,
        );
        assert_eq!(result, Err(SealFailure::Unreadable));
        assert!(!names(&folder)
            .iter()
            .any(|n| n.ends_with(".part") || n.ends_with(".mcin")));
    }

    #[test]
    fn an_empty_file_or_one_that_ends_inside_the_header_is_refused_and_leaves_no_part() {
        let temp = tempfile::tempdir().unwrap();
        let (folder, keys) = (folder(temp.path()), keys());
        // No bytes at all, a declared length of nothing, and a file that is only the start of the
        // PDF header ("%PD"): each is refused, and none leaves a part or an item behind.
        for (input, declared) in [
            (Vec::new(), None),
            (Vec::new(), Some(0)),
            (b"%PD".to_vec(), None),
        ] {
            let result = folder.seal(
                keys.public(),
                Box::new(Cursor::new(input.clone())),
                "a.pdf",
                Source::Shared,
                declared,
                NOW,
                &|| false,
            );
            assert!(
                matches!(
                    result,
                    Err(SealFailure::NotPdf | SealFailure::Size(InboxError::Empty))
                ),
                "{input:?} {declared:?}: {result:?}"
            );
            assert!(
                !names(&folder)
                    .iter()
                    .any(|n| n.ends_with(".part") || n.ends_with(".mcin")),
                "nothing left behind for {input:?} {declared:?}"
            );
        }
    }

    /// An item-named file of `bytes` zero-filled bytes, with a file time: it is not a sealed
    /// item at all, which is the point: a plan never opens what it lists.
    fn plant(folder: &InboxFolder, bytes: usize, modified: u64) -> String {
        fs::create_dir_all(folder.dir()).unwrap();
        let name = item_file_name(&ItemId::random());
        let path = folder.dir().join(&name);
        fs::write(&path, vec![0u8; bytes]).unwrap();
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(UNIX_EPOCH + std::time::Duration::from_secs(modified))
            .unwrap();
        name
    }

    #[test]
    fn an_unlock_takes_the_oldest_items_up_to_the_count_cap_and_refuses_the_rest_unread() {
        let temp = tempfile::tempdir().unwrap();
        let caps = Caps { items: 3, ..CAPS };
        let folder = InboxFolder::new(temp.path(), vault()).with(caps, roomy);
        // Six items that no key could open: a plan that tried to read one would fail.
        let mut planted: Vec<(String, u64)> = (1..=6u64)
            .map(|age| (plant(&folder, 100, 1_000 + age), 1_000 + age))
            .collect();
        planted.sort_by_key(|(_, modified)| *modified);
        let plan = folder.import_plan().unwrap();
        assert_eq!(
            plan.take,
            planted[..3]
                .iter()
                .map(|(name, _)| name.clone())
                .collect::<Vec<_>>(),
            "the three oldest"
        );
        assert_eq!(plan.refused, 3);
        assert!(!plan.listing_truncated);
    }

    #[test]
    fn an_unlock_stops_at_the_total_byte_cap_and_at_the_file_cap() {
        let temp = tempfile::tempdir().unwrap();
        let caps = Caps {
            items: 10,
            total_bytes: 1_000,
            file_bytes: 600,
            ..CAPS
        };
        let folder = InboxFolder::new(temp.path(), vault()).with(caps, roomy);
        let first = plant(&folder, 500, 10);
        let second = plant(&folder, 400, 20);
        let over_total = plant(&folder, 300, 30);
        let over_file = plant(&folder, 700, 5);
        let plan = folder.import_plan().unwrap();
        // The 700-byte file is over the file cap whatever its age; then 500 + 400 fit under 1 000
        // and the 300 does not.
        assert_eq!(plan.take, vec![first, second]);
        assert_eq!(plan.refused, 2);
        let _ = (over_total, over_file);
    }

    #[test]
    fn a_flooded_folder_is_listed_to_a_bound_and_only_what_is_asked_of_it_is_taken() {
        let temp = tempfile::tempdir().unwrap();
        let folder = InboxFolder::new(temp.path(), vault()).with(CAPS, roomy);
        for _ in 0..(CAPS.items + 20) {
            plant(&folder, 1, 100);
        }
        let plan = folder.import_plan().unwrap();
        assert_eq!(plan.take.len(), CAPS.items);
        assert_eq!(plan.refused, 20);
        // The walk itself is bounded: a pure check of the bound's meaning.
        let (entries, truncated) = folder.listed_entries(10).unwrap();
        assert_eq!((entries.len(), truncated), (10, true));
        let (entries, truncated) = folder.listed_entries(usize::MAX).unwrap();
        assert_eq!((entries.len(), truncated), (CAPS.items + 20, false));
    }

    #[test]
    fn a_cancel_stops_the_seal_and_leaves_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let (folder, keys) = (folder(temp.path()), keys());
        let result = folder.seal(
            keys.public(),
            Box::new(Cursor::new(pdf(3 * 1024 * 1024))),
            "a.pdf",
            Source::Shared,
            None,
            NOW,
            &|| true,
        );
        assert_eq!(result, Err(SealFailure::Cancelled));
        assert!(!names(&folder)
            .iter()
            .any(|n| n.ends_with(".part") || n.ends_with(".mcin")));
    }

    #[test]
    fn a_crash_leaves_a_part_that_the_next_seal_removes_and_that_counts_until_then() {
        let temp = tempfile::tempdir().unwrap();
        let keys = keys();
        let caps = Caps {
            total_bytes: 3000,
            ..CAPS
        };
        let folder = InboxFolder::new(temp.path(), vault()).with(caps, roomy);
        seal(&folder, &keys, pdf(100)).unwrap();
        let stale = folder.dir().join(part_file_name(&ItemId([9; 16])));
        fs::write(&stale, vec![0_u8; 2900]).unwrap();
        // The sealer takes the lock, which is when a leftover is known to be one: it is
        // removed before the caps are counted, so the leftover never takes a patient's room.
        seal(&folder, &keys, pdf(100)).unwrap();
        assert!(!stale.exists());
    }

    #[test]
    fn only_strict_names_that_are_plain_files_are_counted_swept_or_touched() {
        let temp = tempfile::tempdir().unwrap();
        let (folder, keys) = (folder(temp.path()), keys());
        let sealed = seal(&folder, &keys, pdf(200)).unwrap();
        let odd = [
            "notes.txt",
            "ABCDEF0123456789ABCDEF0123456789.mcin",
            "0123456789abcdef0123456789abcdef.mcin.bak",
            "0123456789abcdef0123456789abcde.mcin",
        ];
        for name in odd {
            fs::write(folder.dir().join(name), b"keep me").unwrap();
        }
        // A folder named like an item, and (Unix) a link named like one.
        let dir_named = folder.dir().join(item_file_name(&ItemId([5; 16])));
        fs::create_dir(&dir_named).unwrap();
        #[cfg(unix)]
        {
            let outside = temp.path().join("outside.txt");
            fs::write(&outside, b"outside").unwrap();
            std::os::unix::fs::symlink(
                &outside,
                folder.dir().join(item_file_name(&ItemId([6; 16]))),
            )
            .unwrap();
        }
        let far_future = NOW + 365 * 24 * 60 * 60;
        let swept = folder.sweep_locked(far_future).unwrap();
        assert_eq!(
            swept,
            Swept { parts: 0, items: 1 },
            "only the real, old item"
        );
        assert!(!folder.dir().join(item_file_name(&sealed.item_id)).exists());
        for name in odd {
            assert_eq!(fs::read(folder.dir().join(name)).unwrap(), b"keep me");
        }
        assert!(dir_named.is_dir());
        #[cfg(unix)]
        assert_eq!(
            fs::read(temp.path().join("outside.txt")).unwrap(),
            b"outside"
        );
        assert_eq!(folder.count_waiting(&keys.public().key_id()), 0);
    }

    #[test]
    fn a_locked_sweep_takes_parts_and_far_old_items_and_keeps_what_an_unlock_would_still_keep() {
        let temp = tempfile::tempdir().unwrap();
        let (folder, keys) = (folder(temp.path()), keys());
        let fresh = seal(&folder, &keys, pdf(200)).unwrap();
        let part = folder.dir().join(part_file_name(&ItemId([3; 16])));
        fs::write(&part, b"half").unwrap();
        // Just past the age, not twice it: kept (an unlock has the sealed time and says).
        let after_a_week = NOW + CAPS.age_secs + 60;
        // The file time is "now" in this test, so use the real clock for the file and a later `now`.
        let real_now = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let swept = folder.sweep_locked(real_now + CAPS.age_secs + 60).unwrap();
        assert_eq!(swept, Swept { parts: 1, items: 0 });
        assert!(!part.exists());
        assert!(folder.dir().join(item_file_name(&fresh.item_id)).exists());
        let _ = after_a_week;
        // Twice the age: gone.
        let swept = folder
            .sweep_locked(real_now + 2 * CAPS.age_secs + 60)
            .unwrap();
        assert_eq!(swept, Swept { parts: 0, items: 1 });
    }

    #[test]
    fn a_file_time_that_is_unknown_keeps_the_item_through_a_locked_sweep() {
        let temp = tempfile::tempdir().unwrap();
        let (folder, keys) = (folder(temp.path()), keys());
        let zeroed = seal(&folder, &keys, pdf(200)).unwrap();
        let before_1970 = seal(&folder, &keys, pdf(200)).unwrap();
        let set = |id: &ItemId, time: std::time::SystemTime| {
            let file = OpenOptions::new()
                .write(true)
                .open(folder.dir().join(item_file_name(id)))
                .unwrap();
            file.set_modified(time)
        };
        set(&zeroed.item_id, UNIX_EPOCH).unwrap();
        // Some systems cannot hold a time before 1970: there that item just keeps a normal time,
        // which the sweep below is far past too, so only the zeroed one is checked then.
        let pre_epoch = set(
            &before_1970.item_id,
            UNIX_EPOCH - std::time::Duration::from_secs(86_400),
        )
        .is_ok();
        // Far past twice the age by any clock: a time of 0 would make both look ancient.
        let swept = folder.sweep_locked(NOW + 10 * CAPS.age_secs).unwrap();
        assert_eq!(swept.parts, 0);
        assert!(pre_epoch && swept.items == 0 || !pre_epoch && swept.items <= 1);
        assert!(folder.dir().join(item_file_name(&zeroed.item_id)).exists());
        if pre_epoch {
            assert!(folder
                .dir()
                .join(item_file_name(&before_1970.item_id))
                .exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_where_the_folder_should_be_is_refused_before_its_target_is_touched() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let (folder, keys) = (folder(temp.path()), keys());
        let target = temp.path().join("elsewhere");
        fs::create_dir_all(&target).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
        fs::create_dir_all(folder.dir().parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, folder.dir()).unwrap();
        assert_eq!(seal(&folder, &keys, pdf(200)), Err(SealFailure::Storage));
        let mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755, "the link's target keeps its own mode");
        assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
    }

    #[test]
    fn sweeping_a_folder_that_is_not_there_makes_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let folder = folder(temp.path());
        assert_eq!(folder.sweep_locked(NOW), Ok(Swept::default()));
        assert!(!folder.dir().exists());
    }

    #[test]
    fn the_lock_screen_counts_well_formed_items_for_this_key_only_and_stops_at_the_cap() {
        let temp = tempfile::tempdir().unwrap();
        let (folder, keys) = (folder(temp.path()), keys());
        let mine = seal(&folder, &keys, pdf(200)).unwrap();
        seal(&folder, &keys, pdf(200)).unwrap();
        assert_eq!(folder.count_waiting(&keys.public().key_id()), 2);
        // An item sealed to another key, the right name but a header of nothing, and a short file.
        let other = InboxKeys::derive(&[8_u8; 32], vault()).unwrap();
        let theirs = seal(&folder, &other, pdf(200)).unwrap();
        fs::write(
            folder.dir().join(item_file_name(&ItemId([1; 16]))),
            vec![0_u8; 400],
        )
        .unwrap();
        fs::write(
            folder.dir().join(item_file_name(&ItemId([2; 16]))),
            b"short",
        )
        .unwrap();
        // A real item renamed to another item's name: its header names another id.
        let moved = folder.dir().join(item_file_name(&ItemId([4; 16])));
        fs::copy(folder.dir().join(item_file_name(&mine.item_id)), &moved).unwrap();
        assert_eq!(folder.count_waiting(&keys.public().key_id()), 2);
        assert_eq!(folder.count_waiting(&other.public().key_id()), 1);
        let _ = theirs;
    }

    #[test]
    fn the_public_key_file_is_read_only_when_it_is_exactly_a_usable_key() {
        let temp = tempfile::tempdir().unwrap();
        let (folder, keys) = (folder(temp.path()), keys());
        assert_eq!(folder.public_key(), None, "no file");
        fs::create_dir_all(folder.dir()).unwrap();
        let path = folder.dir().join(PUBLIC_FILE);
        let good = keys.public().to_bytes();
        fs::write(&path, good).unwrap();
        assert_eq!(folder.public_key().unwrap().to_bytes(), good);
        for bad in [
            vec![],
            good[..31].to_vec(),
            [good.to_vec(), vec![0]].concat(),
            vec![0_u8; 32],
        ] {
            fs::write(&path, &bad).unwrap();
            assert_eq!(folder.public_key(), None, "{} bytes", bad.len());
        }
    }

    #[test]
    fn a_locked_app_finds_the_one_inbox_that_has_a_key_and_none_when_there_are_none_or_several() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        assert!(
            matches!(InboxFolder::discover(base), Discovered::None),
            "no inbox folder"
        );
        let make = |id: u128, key: bool| {
            let folder = InboxFolder::new(base, Uuid::from_u128(id));
            fs::create_dir_all(folder.dir()).unwrap();
            if key {
                let public = InboxKeys::derive(&[id as u8; 32], Uuid::from_u128(id)).unwrap();
                fs::write(folder.dir().join(PUBLIC_FILE), public.public().to_bytes()).unwrap();
            }
            folder
        };
        // A folder with no key, a file and a folder with a name that is not a vault id.
        make(1, false);
        fs::write(base.join("inbox").join("README"), b"x").unwrap();
        fs::create_dir_all(base.join("inbox").join("not-a-vault")).unwrap();
        fs::create_dir_all(
            base.join("inbox")
                .join(Uuid::from_u128(9).simple().to_string()),
        )
        .unwrap();
        assert!(matches!(InboxFolder::discover(base), Discovered::None));
        let one = make(2, true);
        match InboxFolder::discover(base) {
            Discovered::One(found) => assert_eq!(found.dir(), one.dir()),
            _ => panic!("the one folder with a key"),
        }
        make(3, true);
        assert!(matches!(InboxFolder::discover(base), Discovered::Several));
    }

    #[test]
    fn two_receipts_at_once_cannot_both_pass_the_item_cap() {
        let temp = tempfile::tempdir().unwrap();
        let keys = std::sync::Arc::new(keys());
        let caps = Caps { items: 3, ..CAPS };
        let base = temp.path().to_path_buf();
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (keys, base) = (keys.clone(), base.clone());
                std::thread::spawn(move || {
                    let folder = InboxFolder::new(&base, vault()).with(caps, roomy);
                    seal(&folder, &keys, pdf(500)).is_ok()
                })
            })
            .collect();
        let accepted = threads
            .into_iter()
            .map(|t| t.join().unwrap())
            .filter(|ok| *ok)
            .count();
        assert_eq!(accepted, 3);
        let folder = InboxFolder::new(&base, vault()).with(caps, roomy);
        assert_eq!(folder.count_waiting(&keys.public().key_id()), 3);
    }
}

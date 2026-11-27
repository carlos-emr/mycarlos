//! Adding a video the patient picks from their own files.
//!
//! The file is read twice and never kept anywhere in plain form:
//!
//! 1. **Check.** [`video_import::analyse`] walks the file and decides (an allowed brand, one H.264
//!    picture and at most one AAC sound, everything inside this very file, no larger than the cap).
//!    A file that does not pass is refused with a reason, and nothing is stored. While it reads, the
//!    check also takes a SHA-256 of the bytes.
//! 2. **Store.** The file is opened again, passed through [`video_import::Cleaner`] (which removes the
//!    places and devices it names without moving a byte) and sealed by the ordinary import. The
//!    second pass hashes the bytes it reads and, at the end, compares them with the first pass's: a
//!    file that changed between the two (a swapped file, a download that was still arriving) is
//!    refused as damaged, so what is stored is only ever what was checked.
//!
//! The history entry says `pickedVideo` (a new word in an existing text field, so no format change).
//! A backup's "Leave videos out" and the size screen treat that word as they treat `camera`.
//!
//! A user Cancel, like a lock, stops the read; the import removes its staged files and writes no
//! record, so a cancelled import leaves nothing behind. Room is checked after the first pass (when
//! the file's size is known) and before any byte is stored.

use super::recording::STOP_FREE;
use super::*;
use crate::video_import::{self, Cleaner, Refusal};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, AtomicU8};

/// The way the history says a video was picked from the patient's files.
pub(crate) const PICKED_VIDEO_HOW: &str = "pickedVideo";

const STAGE_IDLE: u8 = 0;
const STAGE_CHECKING: u8 = 1;
const STAGE_STORING: u8 = 2;

/// Where a picked video's import is, as the page shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoImportStage {
    /// Nothing is being imported.
    Idle,
    /// The file is being checked: its size is not yet known.
    Checking,
    /// The file is being sealed into the vault.
    Storing,
}

/// What the page asks while a video is imported.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoImportProgress {
    pub stage: VideoImportStage,
    /// Bytes read in this stage.
    pub done_bytes: u64,
    /// The file's size, known from the Storing stage on (0 before).
    pub total_bytes: u64,
}

/// One import of a picked video: its progress, and the patient's Cancel.
#[derive(Debug, Default)]
pub struct VideoImportJob {
    cancelled: AtomicBool,
    changed: AtomicBool,
    stage: AtomicU8,
    done: AtomicU64,
    total: AtomicU64,
}

impl VideoImportJob {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Stops the import at its next read. Nothing is stored by an import that was cancelled.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub fn progress(&self) -> VideoImportProgress {
        VideoImportProgress {
            stage: match self.stage.load(Ordering::Acquire) {
                STAGE_CHECKING => VideoImportStage::Checking,
                STAGE_STORING => VideoImportStage::Storing,
                _ => VideoImportStage::Idle,
            },
            done_bytes: self.done.load(Ordering::Acquire),
            total_bytes: self.total.load(Ordering::Acquire),
        }
    }

    fn begin(&self, stage: u8, total: u64) {
        self.done.store(0, Ordering::Release);
        self.total.store(total, Ordering::Release);
        self.stage.store(stage, Ordering::Release);
    }
}

/// How a picked video's import ended. A refusal is an answer, not an error: the file is not
/// stored, and the page says why in the patient's words.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum PickedVideoOutcome {
    #[serde(rename_all = "camelCase")]
    Imported {
        record_id: Uuid,
    },
    /// The same video (the same bytes once cleaned) is already in this person's records.
    Duplicate,
    Refused {
        reason: Refusal,
    },
    /// The patient chose Cancel. Nothing was stored.
    Cancelled,
}

/// What is asked of the import of one picked video.
pub struct PickedVideoRequest {
    pub profile_id: Uuid,
    pub folder_ids: Vec<Uuid>,
    pub display_name: String,
    /// The largest file taken on this device.
    pub max_bytes: u64,
    pub now_ms: u64,
}

/// Reads the source for one pass: counts what moves (the progress), keeps the idle timer awake,
/// stops at Cancel, and hashes what it reads. In the second pass it is held to what the first pass
/// saw: it takes no byte past the checked length (so a file that is still growing is stopped at
/// once, not copied in full), and ends with an error unless it ends at that length with the same
/// bytes.
struct JobReader {
    inner: Box<dyn Read + Send>,
    job: Arc<VideoImportJob>,
    idle: Arc<IdleDeadline>,
    hash: Sha256,
    /// The first pass's digest and length; set for the second pass only.
    expect: Option<([u8; 32], u64)>,
    seen: u64,
    ended: bool,
}

impl JobReader {
    fn new(
        inner: Box<dyn Read + Send>,
        job: &Arc<VideoImportJob>,
        idle: &Arc<IdleDeadline>,
        expect: Option<([u8; 32], u64)>,
    ) -> Self {
        Self {
            inner,
            job: Arc::clone(job),
            idle: Arc::clone(idle),
            hash: Sha256::new(),
            expect,
            seen: 0,
            ended: false,
        }
    }

    fn digest(&self) -> [u8; 32] {
        self.hash.clone().finalize().into()
    }

    /// The file is not the one that was checked.
    fn changed(&self) -> io::Error {
        self.job.changed.store(true, Ordering::Release);
        io::Error::new(
            io::ErrorKind::InvalidData,
            "the file changed while it was added",
        )
    }
}

impl Read for JobReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.job.is_cancelled() {
            return Err(cancelled_io_error());
        }
        // At most one byte past the checked length: enough to tell that the file grew.
        let room = match self.expect {
            Some((_, length)) => {
                let left = usize::try_from(length - self.seen.min(length)).unwrap_or(usize::MAX);
                buffer.len().min(left.saturating_add(1))
            }
            None => buffer.len(),
        };
        let count = self.inner.read(&mut buffer[..room])?;
        if count > 0 {
            self.seen += count as u64;
            if self.expect.is_some_and(|(_, length)| self.seen > length) {
                return Err(self.changed());
            }
            self.hash.update(&buffer[..count]);
            self.job.done.fetch_add(count as u64, Ordering::AcqRel);
            // A copy that is moving keeps the vault unlocked, however slowly.
            self.idle.touch(Instant::now());
        } else if !self.ended && !buffer.is_empty() {
            self.ended = true;
            if self
                .expect
                .is_some_and(|(digest, length)| self.seen != length || digest != self.digest())
            {
                return Err(self.changed());
            }
        }
        Ok(count)
    }
}

impl VaultStore {
    /// Adds the video the patient picked: checked, cleaned and sealed, or refused with a reason.
    ///
    /// `open` opens the source; it is called twice (the check, then the copy). A cancel (the job's,
    /// or the vault locking) stores nothing.
    pub fn import_picked_video(
        &self,
        request: PickedVideoRequest,
        open: &dyn Fn() -> Result<Box<dyn Read + Send>, VaultError>,
        job: &Arc<VideoImportJob>,
    ) -> Result<PickedVideoOutcome, VaultError> {
        let result = self.import_picked_video_inner(request, open, job);
        job.begin(STAGE_IDLE, 0);
        result
    }

    fn import_picked_video_inner(
        &self,
        request: PickedVideoRequest,
        open: &dyn Fn() -> Result<Box<dyn Read + Send>, VaultError>,
        job: &Arc<VideoImportJob>,
    ) -> Result<PickedVideoOutcome, VaultError> {
        let PickedVideoRequest {
            profile_id,
            folder_ids,
            display_name,
            max_bytes,
            now_ms,
        } = request;
        // The same refusals an import makes, before any byte is read.
        self.ensure_import_allowed(profile_id)?;
        job.begin(STAGE_CHECKING, 0);
        let mut checked = JobReader::new(open()?, job, &self.idle, None);
        let analysed = video_import::analyse(&mut checked, max_bytes);
        if job.is_cancelled() {
            return Ok(PickedVideoOutcome::Cancelled);
        }
        let plan = match analysed {
            Ok(plan) => plan,
            Err(reason) => return Ok(PickedVideoOutcome::Refused { reason }),
        };
        // The size is known now: room for the copy, and the reserve a commit needs.
        let needed = plan.length.saturating_add(STOP_FREE);
        if self.free_space_now().is_some_and(|free| free < needed) {
            return Err(VaultError::NoSpace);
        }
        job.begin(STAGE_STORING, plan.length);
        let copy = JobReader::new(
            open()?,
            job,
            &self.idle,
            Some((checked.digest(), plan.length)),
        );
        let source = ImportSource {
            display_name,
            reader: Box::new(Cleaner::new(copy, plan)),
        };
        let stored = self.import_from(
            profile_id,
            folder_ids,
            vec![source],
            now_ms,
            PICKED_VIDEO_HOW,
        );
        match stored {
            Ok(outcome) => Ok(match outcome.imported.first() {
                Some(&record_id) => PickedVideoOutcome::Imported { record_id },
                None => PickedVideoOutcome::Duplicate,
            }),
            Err(_) if job.is_cancelled() => Ok(PickedVideoOutcome::Cancelled),
            Err(_) if job.changed.load(Ordering::Acquire) => Ok(PickedVideoOutcome::Refused {
                reason: Refusal::Damaged,
            }),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video_import::tests::{bx, ftyp, full, video};
    use std::io::Cursor;
    use std::time::Duration;

    const PASSWORD: &str = "river-azimuth-cobalt-sparrow-934";
    const CAP: u64 = 2 * 1024 * 1024 * 1024;

    fn new_store(root: &Path) -> (VaultStore, Uuid) {
        let store = VaultStore::new(root.join("vault"));
        store.create(PASSWORD, "FAKE Person", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        (store, profile)
    }

    /// A video with a place and a device name in it, FAKE.
    fn tagged() -> Vec<u8> {
        let udta = bx(b"udta", &bx(b"\xa9xyz", b"+43.6532-079.3832/"));
        let meta = full(b"meta", 0, b"com.apple.quicktime.model iPhone");
        let mut extra = udta;
        extra.extend_from_slice(&meta);
        video(false, &extra, &[])
    }

    fn request(profile: Uuid, name: &str, max_bytes: u64) -> PickedVideoRequest {
        PickedVideoRequest {
            profile_id: profile,
            folder_ids: vec![],
            display_name: name.to_owned(),
            max_bytes,
            now_ms: 5,
        }
    }

    #[test]
    fn the_outcome_and_the_progress_are_said_to_the_page_in_camel_case() {
        let id = Uuid::nil();
        let said = |value: &PickedVideoOutcome| serde_json::to_value(value).unwrap();
        assert_eq!(
            said(&PickedVideoOutcome::Imported { record_id: id }),
            serde_json::json!({"result": "imported", "recordId": id.to_string()})
        );
        assert_eq!(
            said(&PickedVideoOutcome::Refused {
                reason: Refusal::Hevc
            }),
            serde_json::json!({"result": "refused", "reason": "hevc"})
        );
        assert_eq!(
            said(&PickedVideoOutcome::Duplicate),
            serde_json::json!({"result": "duplicate"})
        );
        assert_eq!(
            said(&PickedVideoOutcome::Cancelled),
            serde_json::json!({"result": "cancelled"})
        );
        let job = VideoImportJob::new();
        job.begin(STAGE_STORING, 10);
        assert_eq!(
            serde_json::to_value(job.progress()).unwrap(),
            serde_json::json!({"stage": "storing", "doneBytes": 0, "totalBytes": 10})
        );
        // Every refusal has a name of its own for the page to put words to.
        for (reason, name) in [
            (Refusal::NotVideo, "notVideo"),
            (Refusal::Hevc, "hevc"),
            (Refusal::VideoCodec, "videoCodec"),
            (Refusal::AudioCodec, "audioCodec"),
            (Refusal::NoVideo, "noVideo"),
            (Refusal::TooManyTracks, "tooManyTracks"),
            (Refusal::External, "external"),
            (Refusal::Fragmented, "fragmented"),
            (Refusal::TooBig, "tooBig"),
            (Refusal::TooLarge, "tooLarge"),
            (Refusal::Damaged, "damaged"),
        ] {
            assert_eq!(serde_json::to_value(reason).unwrap(), name);
        }
    }

    fn opener(bytes: Vec<u8>) -> impl Fn() -> Result<Box<dyn Read + Send>, VaultError> {
        move || Ok(Box::new(Cursor::new(bytes.clone())) as Box<dyn Read + Send>)
    }

    fn add(
        store: &VaultStore,
        profile: Uuid,
        bytes: Vec<u8>,
        job: &Arc<VideoImportJob>,
    ) -> Result<PickedVideoOutcome, VaultError> {
        store.import_picked_video(request(profile, "FAKE clip.mp4", CAP), &opener(bytes), job)
    }

    fn read_back(store: &VaultStore, record: Uuid) -> Vec<u8> {
        let mut bytes = Vec::new();
        store.read_for_view(record, &mut bytes).unwrap();
        bytes
    }

    fn mentions(bytes: &[u8], needle: &[u8]) -> bool {
        bytes.windows(needle.len()).any(|window| window == needle)
    }

    /// How many files the vault's objects folder holds (the history's pieces too).
    fn objects_in(root: &Path) -> usize {
        fs::read_dir(root.join("vault").join("objects"))
            .map(|entries| entries.count())
            .unwrap_or(0)
    }

    /// Nothing of an import is left: no new record, no staged file, no stray object.
    fn leaves_nothing(root: &Path, store: &VaultStore, records: usize, objects: usize) {
        assert_eq!(store.snapshot().unwrap().records.len(), records);
        assert_eq!(objects_in(root), objects, "objects");
        let staged = fs::read_dir(root.join("vault").join("staging"))
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert_eq!(staged, 0, "staging");
    }

    #[test]
    fn a_picked_video_is_stored_clean_marked_and_counted_as_a_video() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let file = tagged();
        assert!(mentions(&file, b"+43.6532") && mentions(&file, b"iPhone"));
        let job = VideoImportJob::new();
        let PickedVideoOutcome::Imported { record_id } =
            add(&store, profile, file.clone(), &job).unwrap()
        else {
            panic!("not imported");
        };
        // The place and the device are gone, and every other byte is where it was.
        let stored = read_back(&store, record_id);
        assert_eq!(stored.len(), file.len());
        assert!(!mentions(&stored, b"+43.6532") && !mentions(&stored, b"iPhone"));
        // The history says how it came in, and that is what makes it a video.
        let history = store.history_view().unwrap();
        let entry = history
            .entries
            .iter()
            .find(|entry| entry.record_id == Some(record_id))
            .unwrap();
        assert_eq!(entry.how.as_deref(), Some("pickedVideo"));
        assert!(store.added_with_camera(record_id).unwrap());
        // A backup treats it as it treats a recording: counted, and left out on request.
        let plan = store.plan_backup(true).unwrap();
        assert_eq!(plan.videos(), &[record_id]);
        let size = store.backup_size().unwrap();
        assert_eq!(size.video_count, 1);
        assert!(size.video_bytes > 0);
        let mut with = Vec::new();
        store.backup_with(&mut with, 9, false).unwrap();
        let mut without = Vec::new();
        store.backup_with(&mut without, 9, true).unwrap();
        assert!(without.len() < with.len());
        // Nothing is left running: the progress is back to idle.
        assert_eq!(job.progress().stage, VideoImportStage::Idle);
    }

    #[test]
    fn a_file_that_is_not_a_playable_video_is_refused_and_nothing_is_stored() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let before = objects_in(temp.path());
        let job = VideoImportJob::new();
        // A HEIC photo carries `ftyp` where an MP4 does; a PDF does not.
        let mut heic = ftyp(b"heic");
        heic.extend(bx(b"mdat", &[0; 32]));
        for (bytes, reason) in [
            (heic, Refusal::NotVideo),
            (b"%PDF-1.7 FAKE".to_vec(), Refusal::NotVideo),
            (Vec::new(), Refusal::NotVideo),
        ] {
            assert_eq!(
                add(&store, profile, bytes, &job).unwrap(),
                PickedVideoOutcome::Refused { reason }
            );
        }
        // Over the cap: the limit is checked as the file is read.
        let file = tagged();
        assert_eq!(
            store
                .import_picked_video(
                    request(profile, "FAKE big.mp4", file.len() as u64 - 1),
                    &opener(file.clone()),
                    &job
                )
                .unwrap(),
            PickedVideoOutcome::Refused {
                reason: Refusal::TooLarge
            }
        );
        leaves_nothing(temp.path(), &store, 0, before);
        assert!(store.plan_backup(true).unwrap().videos().is_empty());
    }

    #[test]
    fn the_same_video_twice_is_added_once() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let job = VideoImportJob::new();
        assert!(matches!(
            add(&store, profile, tagged(), &job).unwrap(),
            PickedVideoOutcome::Imported { .. }
        ));
        assert_eq!(
            add(&store, profile, tagged(), &job).unwrap(),
            PickedVideoOutcome::Duplicate
        );
        assert_eq!(store.snapshot().unwrap().records.len(), 1);
    }

    #[test]
    fn a_file_that_changes_between_the_check_and_the_copy_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let before = objects_in(temp.path());
        let checked = tagged();
        // The second time it is opened it is another file (here, with a different byte in the
        // media data): what is stored must be what was checked.
        let mut swapped = checked.clone();
        let last = swapped.len() - 1;
        let at = swapped.len() / 2;
        swapped[at] ^= 0xFF;
        assert_ne!(swapped[last], 0xAB);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let open = move || -> Result<Box<dyn Read + Send>, VaultError> {
            let bytes = if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                checked.clone()
            } else {
                swapped.clone()
            };
            Ok(Box::new(Cursor::new(bytes)))
        };
        let job = VideoImportJob::new();
        let outcome = store
            .import_picked_video(request(profile, "FAKE clip.mp4", CAP), &open, &job)
            .unwrap();
        assert_eq!(
            outcome,
            PickedVideoOutcome::Refused {
                reason: Refusal::Damaged
            }
        );
        leaves_nothing(temp.path(), &store, 0, before);
    }

    /// A source that gives a few bytes a read, and stops the import after `after` reads.
    struct Trickle {
        inner: Cursor<Vec<u8>>,
        reads: usize,
        after: usize,
        job: Arc<VideoImportJob>,
    }

    impl Read for Trickle {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.reads += 1;
            if self.reads == self.after {
                self.job.cancel();
            }
            let take = buffer.len().min(24);
            self.inner.read(&mut buffer[..take])
        }
    }

    #[test]
    fn cancel_midway_leaves_no_record_no_object_and_no_staged_file() {
        for (cancel_in_pass, after) in [(1, 3), (2, 3), (2, 20)] {
            let temp = tempfile::tempdir().unwrap();
            let (store, profile) = new_store(temp.path());
            // One record already there: it must stay, and only it.
            let job = VideoImportJob::new();
            assert!(matches!(
                add(&store, profile, video(true, &[], &[]), &job).unwrap(),
                PickedVideoOutcome::Imported { .. }
            ));
            let objects = objects_in(temp.path());
            let job = VideoImportJob::new();
            let file = tagged();
            let calls = std::sync::atomic::AtomicUsize::new(0);
            let running = Arc::clone(&job);
            let open = move || -> Result<Box<dyn Read + Send>, VaultError> {
                let pass = calls.fetch_add(1, Ordering::SeqCst) + 1;
                Ok(Box::new(Trickle {
                    inner: Cursor::new(file.clone()),
                    reads: 0,
                    // Only the pass the test cancels in stops it.
                    after: if pass == cancel_in_pass {
                        after
                    } else {
                        usize::MAX
                    },
                    job: Arc::clone(&running),
                }))
            };
            let outcome = store
                .import_picked_video(request(profile, "FAKE clip.mp4", CAP), &open, &job)
                .unwrap();
            assert_eq!(
                outcome,
                PickedVideoOutcome::Cancelled,
                "{cancel_in_pass} {after}"
            );
            leaves_nothing(temp.path(), &store, 1, objects);
        }
    }

    #[test]
    fn the_progress_counts_the_bytes_and_a_cancel_before_the_start_stores_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let before = objects_in(temp.path());
        let job = VideoImportJob::new();
        assert_eq!(job.progress().stage, VideoImportStage::Idle);
        job.cancel();
        assert_eq!(
            add(&store, profile, tagged(), &job).unwrap(),
            PickedVideoOutcome::Cancelled
        );
        leaves_nothing(temp.path(), &store, 0, before);
        // During the copy the stage is Storing and the total is the file's length.
        let job = VideoImportJob::new();
        let watching = Arc::clone(&job);
        let file = tagged();
        let length = file.len() as u64;
        let seen = Arc::new(Mutex::new(Vec::new()));
        let noted = Arc::clone(&seen);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let open = move || -> Result<Box<dyn Read + Send>, VaultError> {
            if calls.fetch_add(1, Ordering::SeqCst) == 1 {
                noted.lock().unwrap().push(watching.progress());
            }
            Ok(Box::new(Cursor::new(file.clone())))
        };
        store
            .import_picked_video(request(profile, "FAKE clip.mp4", CAP), &open, &job)
            .unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].stage, VideoImportStage::Storing);
        assert_eq!(seen[0].total_bytes, length);
    }

    #[test]
    fn without_room_for_the_copy_nothing_is_read_into_the_vault() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let before = objects_in(temp.path());
        let file = tagged();
        // Room for the file but not for the reserve a commit needs.
        let free = file.len() as u64;
        *store.free_space.lock().unwrap() = Box::new(move |_| Some(free));
        let job = VideoImportJob::new();
        assert!(matches!(
            add(&store, profile, file.clone(), &job),
            Err(VaultError::NoSpace)
        ));
        leaves_nothing(temp.path(), &store, 0, before);
        // With the room, it goes in; and a volume that cannot be asked is not a refusal.
        let enough = file.len() as u64 + STOP_FREE;
        *store.free_space.lock().unwrap() = Box::new(move |_| Some(enough));
        assert!(matches!(
            add(&store, profile, file.clone(), &job).unwrap(),
            PickedVideoOutcome::Imported { .. }
        ));
    }

    #[test]
    fn a_copy_that_is_moving_keeps_the_vault_unlocked() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        // The deadline was due five minutes ago, as if nothing had happened since.
        let long_ago = Instant::now()
            .checked_sub(Duration::from_secs(300))
            .unwrap();
        store.idle.set_delay_minutes(1, long_ago);
        store.idle.arm(long_ago);
        assert!(store.idle.is_due(Instant::now()));
        let job = VideoImportJob::new();
        assert!(matches!(
            add(&store, profile, tagged(), &job).unwrap(),
            PickedVideoOutcome::Imported { .. }
        ));
        assert!(!store.idle.is_due(Instant::now()));
    }

    #[test]
    fn only_a_writable_open_vault_takes_a_video_and_a_lock_stops_it() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let job = VideoImportJob::new();
        assert!(matches!(
            add(&store, Uuid::new_v4(), tagged(), &job),
            Err(VaultError::NotFound)
        ));
        store.lock();
        assert!(matches!(
            add(&store, profile, tagged(), &job),
            Err(VaultError::Locked)
        ));
    }

    /// Counts the bytes taken from it.
    struct Counted {
        inner: Cursor<Vec<u8>>,
        taken: Arc<AtomicU64>,
    }

    impl Read for Counted {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let count = self.inner.read(buffer)?;
            self.taken.fetch_add(count as u64, Ordering::SeqCst);
            Ok(count)
        }
    }

    /// A source that is `checked` the first time it is opened and `second` after that.
    fn changing(
        checked: Vec<u8>,
        second: Vec<u8>,
        taken: Arc<AtomicU64>,
    ) -> impl Fn() -> Result<Box<dyn Read + Send>, VaultError> {
        let calls = std::sync::atomic::AtomicUsize::new(0);
        move || {
            let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
            let bytes = if first { &checked } else { &second };
            Ok(Box::new(Counted {
                inner: Cursor::new(bytes.clone()),
                taken: if first {
                    Arc::new(AtomicU64::new(0))
                } else {
                    Arc::clone(&taken)
                },
            }))
        }
    }

    #[test]
    fn a_file_that_grows_between_the_passes_is_stopped_at_once_not_copied_in_full() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let before = objects_in(temp.path());
        let checked = tagged();
        // A download that is still arriving: the second time it is opened it has a big tail.
        let mut grown = checked.clone();
        grown.extend(std::iter::repeat_n(7_u8, 8 * 1024 * 1024));
        let taken = Arc::new(AtomicU64::new(0));
        let open = changing(checked.clone(), grown, Arc::clone(&taken));
        let job = VideoImportJob::new();
        let outcome = store
            .import_picked_video(request(profile, "FAKE clip.mp4", CAP), &open, &job)
            .unwrap();
        assert_eq!(
            outcome,
            PickedVideoOutcome::Refused {
                reason: Refusal::Damaged
            }
        );
        // It took the checked length and one byte more, not the tail.
        assert!(
            taken.load(Ordering::SeqCst) <= checked.len() as u64 + 1,
            "{} of {}",
            taken.load(Ordering::SeqCst),
            checked.len()
        );
        leaves_nothing(temp.path(), &store, 0, before);
    }

    #[test]
    fn a_file_cut_short_between_the_passes_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let before = objects_in(temp.path());
        let checked = tagged();
        let short = checked[..checked.len() - 5].to_vec();
        let open = changing(checked, short, Arc::new(AtomicU64::new(0)));
        let job = VideoImportJob::new();
        assert_eq!(
            store
                .import_picked_video(request(profile, "FAKE clip.mp4", CAP), &open, &job)
                .unwrap(),
            PickedVideoOutcome::Refused {
                reason: Refusal::Damaged
            }
        );
        leaves_nothing(temp.path(), &store, 0, before);
    }

    #[test]
    fn a_failure_while_storing_leaves_nothing_and_is_an_error_not_a_refusal() {
        for boundary in [
            &["object.after-chunk-write"][..],
            &["import.objects-sync"][..],
            &["manifest.before-first-write"][..],
        ] {
            let temp = tempfile::tempdir().unwrap();
            let (store, profile) = new_store(temp.path());
            let before = objects_in(temp.path());
            let job = VideoImportJob::new();
            let failing = FailAtForTest::boundary(boundary);
            assert!(
                matches!(
                    add(&store, profile, tagged(), &job),
                    Err(VaultError::NoSpace)
                ),
                "{boundary:?}"
            );
            drop(failing);
            leaves_nothing(temp.path(), &store, 0, before);
            // And the next try, with room again, goes in.
            assert!(matches!(
                add(&store, profile, tagged(), &job).unwrap(),
                PickedVideoOutcome::Imported { .. }
            ));
        }
    }
}

//! Backups and videos (#359): the size first, and "leave videos out".
//!
//! A video can be hours long, so a backup of a vault that holds some is very
//! large. Before anything is saved the patient is told how large (the files'
//! real sizes, and how much of it is video), and may leave the videos out. A
//! backup made that way is **backup format 2**: it starts with a different
//! magic, holds a note after its manifest that lists the records whose files it
//! leaves out (ids, never names), and says the same in its trailer, so a damaged
//! one is still found. Its manifest marks those records as lacking their file,
//! as a document whose file went missing is marked (hidden as damaged), which is
//! what lets a restore bring the vault back without them and keeps each one
//! restorable if its file ever comes back. An older build refuses a format-2
//! backup as not a backup, which is the safe outcome.
//!
//! This is not a vault format: the manifest, the objects and the header are
//! unchanged. The live vault is never touched by making a backup.

use super::*;

/// The way a restore's "hidden" event says the file was left out of the backup.
const LEFT_OUT_HOW: &str = "leftOutOfBackup";

/// What a backup would be, before it is saved.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSize {
    /// The whole file with its videos, about: its entries, their headers and
    /// the trailer.
    pub total_bytes: u64,
    /// The whole file with its videos left out, about. Both are given at once so
    /// that the screen can show either as the patient ticks the box, without
    /// asking again.
    pub without_videos_bytes: u64,
    /// Of what the vault holds, how much is video that can be left out.
    pub video_bytes: u64,
    pub video_count: usize,
}

/// The videos a backup is made around, found once for the whole save: the size
/// shown, the check of what will be written, and the write itself all use this
/// one list, so that they agree.
#[derive(Clone, Debug)]
pub struct BackupPlan {
    videos: Vec<Uuid>,
    leave_out: bool,
}

impl BackupPlan {
    /// The records whose files this backup leaves out: the videos found, that
    /// this vault still has and has not had hidden since (a patient's hide,
    /// of the document or of its whole person, must keep a record's file in the
    /// backup). Size, check and write all ask
    /// this, so they agree even if a record is hidden between them.
    pub(super) fn omitted_in(&self, manifest: &Manifest) -> Vec<Uuid> {
        if !self.leave_out {
            return Vec::new();
        }
        self.videos
            .iter()
            .copied()
            .filter(|id| {
                manifest.records.iter().any(|record| {
                    record.id == *id && record.hidden.is_none() && manifest.record_in_reach(record)
                })
            })
            .collect()
    }

    /// The videos found, whether or not they are left out.
    #[cfg(test)]
    pub(super) fn videos(&self) -> &[Uuid] {
        &self.videos
    }
}

/// The first bytes of an object's plaintext, and no more: it stops the read.
struct FirstBytes {
    bytes: [u8; 8],
    seen: usize,
}

impl Write for FirstBytes {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let take = data.len().min(self.bytes.len() - self.seen);
        self.bytes[self.seen..self.seen + take].copy_from_slice(&data[..take]);
        self.seen += take;
        if self.seen == self.bytes.len() {
            Err(io::Error::other("the first bytes are read"))
        } else {
            Ok(data.len())
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl VaultStore {
    /// The videos myCarlos recorded that a backup can leave out: records the
    /// history says were added with the camera whose file starts as an MP4 does
    /// (`ftyp` at byte 4). Never the bytes alone: an iPhone's HEIC photo, an M4A
    /// voice memo, a camera raw file and even a PDF can carry `ftyp`, and
    /// leaving one of those out would silently drop a patient's record.
    ///
    /// A record the patient hid, or whose person they hid (#360), is not listed:
    /// its file is required to restore it, and marking it as lacking its file
    /// would erase the patient's own choice, so it stays in the backup. A record whose file cannot be read here
    /// is not called a video either, and a backup keeps it.
    fn video_record_ids(
        &self,
        unlocked: &UnlockedVault,
        keys: &DerivedKeys,
    ) -> Result<Vec<Uuid>, VaultError> {
        let camera_made = self.camera_made_records(unlocked)?;
        let mut videos = Vec::new();
        for record in &unlocked.manifest.records {
            if !camera_made.contains(&record.id)
                || record.hidden.is_some()
                || !unlocked.manifest.record_in_reach(record)
                || record.plaintext_size < 12
            {
                continue;
            }
            let mut start = FirstBytes {
                bytes: [0; 8],
                seen: 0,
            };
            let object = RecordObject {
                id: record.id,
                object_name: &record.object_name,
                plaintext_size: record.plaintext_size,
                wrapped_key: &record.wrapped_object_key,
                sha256: None,
            };
            let read = read_object_ref(
                &self.root.join("objects").join(&record.object_name),
                unlocked.manifest.vault_id,
                keys,
                object,
                CancellableWriter::new(&mut start, Arc::clone(&self.cancel_io)),
            );
            if start.seen == start.bytes.len() {
                if &start.bytes[4..8] == b"ftyp" {
                    videos.push(record.id);
                }
            } else if let Err(VaultError::Cancelled) = read {
                return Err(VaultError::Cancelled);
            }
        }
        Ok(videos)
    }

    /// The records whose file a backup left out, as this vault's history says
    /// them: those whose **latest** event is "hidden" with the way
    /// `leftOutOfBackup`, which a restore adds. A record the patient has since
    /// done anything else with (restored it, renamed it, moved it) is no longer
    /// listed. Read from the history, so nothing is stored for it; a damaged
    /// history piece only means a record is not listed.
    pub fn left_out_records(&self) -> Result<Vec<Uuid>, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        let view = self.history_view_in_session(unlocked)?;
        let mut latest: HashMap<Uuid, bool> = HashMap::new();
        // The shown entries then the later ones: in order, each record's last wins.
        for entry in view.entries.iter().chain(view.later.iter()) {
            if let Some(id) = entry.record_id {
                latest.insert(
                    id,
                    entry.event == HistoryEvent::Hidden
                        && entry.how.as_deref() == Some(LEFT_OUT_HOW),
                );
            }
        }
        Ok(unlocked
            .manifest
            .records
            .iter()
            .filter(|record| latest.get(&record.id) == Some(&true))
            .map(|record| record.id)
            .collect())
    }

    /// The videos of this save, found once (see `BackupPlan`).
    pub fn plan_backup(&self, leave_videos_out: bool) -> Result<BackupPlan, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        let keys = derive_keys(unlocked.manifest.vault_id, &unlocked.master_key)?;
        Ok(BackupPlan {
            videos: self.video_record_ids(unlocked, &keys)?,
            leave_out: leave_videos_out,
        })
    }

    /// How big a backup would be, with and without the videos, from the files'
    /// real sizes: asked before the patient chooses where to save it.
    pub fn backup_size(&self) -> Result<BackupSize, VaultError> {
        self.backup_size_planned(&self.plan_backup(false)?)
    }

    /// `backup_size` for the videos already found.
    pub(super) fn backup_size_planned(&self, plan: &BackupPlan) -> Result<BackupSize, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        let parts = self.backup_parts(unlocked)?;
        let manifest = &unlocked.manifest;
        let videos = &plan.videos;
        let size_of = |name: &str| -> u64 {
            fs::metadata(self.root.join("objects").join(name)).map_or(0, |m| m.len())
        };
        // Each entry: its kind, name length, name and length (11 bytes and the
        // name), and in the trailer about 150 bytes of JSON.
        let entry = |name: &str| 11 + name.len() as u64 + 150;
        // The manifest as the backup will hold it with the videos left out: the
        // one with those records marked, which may fall in a larger size class.
        // Sized with the largest time, so that the size is never undercounted.
        let manifest_len_without = if videos.is_empty() {
            parts.manifest_data.len()
        } else {
            manifest_without_videos(&unlocked.master_key, manifest, videos, u64::MAX)?.len()
        };
        let fixed = BACKUP_MAGIC.len() as u64
            + 1
            + parts.header_data.len() as u64
            + entry("header.json")
            + entry("manifest.bin")
            + 32
            + 16;
        let mut with = fixed + parts.manifest_data.len() as u64;
        let mut without = fixed + manifest_len_without as u64;
        let mut video_bytes = 0_u64;
        for record in &manifest.records {
            let is_video = videos.contains(&record.id);
            for object in record
                .objects()
                .filter(|object| self.backs_up_record_object(record, *object))
            {
                let size = size_of(object.object_name);
                with += size + entry(object.object_name);
                if is_video {
                    video_bytes += size;
                } else {
                    without += size + entry(object.object_name);
                }
            }
        }
        for segment in &manifest.history.segments {
            let size = size_of(&segment.object_name) + entry(&segment.object_name);
            with += size;
            without += size;
        }
        if !videos.is_empty() {
            // The note, and the list in the trailer.
            without += entry("left-out.json") + 64 + videos.len() as u64 * 80;
        }
        Ok(BackupSize {
            total_bytes: with,
            without_videos_bytes: without,
            video_bytes,
            video_count: videos.len(),
        })
    }
}

/// The manifest as a backup that leaves `omitted` out holds it: each of those
/// records marked as lacking its file (hidden as damaged), so that a restore
/// does not need it, and encrypted as any manifest is. The vault's own manifest
/// is not changed.
pub(super) fn manifest_without_videos(
    master_key: &[u8; 32],
    manifest: &Manifest,
    omitted: &[Uuid],
    now_ms: u64,
) -> Result<Vec<u8>, VaultError> {
    let mut left_out = manifest.clone();
    for record in &mut left_out.records {
        if omitted.contains(&record.id) {
            record.hidden = Some(Hidden {
                at_ms: now_ms,
                reason: HiddenReason::Damaged,
            });
        }
    }
    manifest_file_bytes(master_key, &left_out)
}

/// What the history of a restored vault says about each record a backup left
/// out: hidden, because its file was not in the backup.
pub(super) fn left_out_entries(
    manifest: &Manifest,
    omitted: &[Uuid],
    now_ms: u64,
) -> Vec<HistoryEntry> {
    manifest
        .records
        .iter()
        .filter(|record| omitted.contains(&record.id))
        .map(|record| {
            let mut entry = record_entry(HistoryEvent::Hidden, now_ms, record);
            entry.how = Some(LEFT_OUT_HOW.to_owned());
            entry
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mp4_stream::fake::{fragment, ftyp, moov};
    use std::io::Cursor;

    const PASSWORD: &str = "river-azimuth-cobalt-sparrow-934";
    const NOTE: &[u8] = b"FAKE note: nothing here is a patient's";

    /// A vault with a person, one document and one video (about 2.6 MiB), all FAKE.
    fn vault_with_a_video(root: &Path) -> (VaultStore, Uuid, Uuid) {
        let store = VaultStore::new(root.join("vault"));
        store.create(PASSWORD, "FAKE Person", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(
                profile,
                vec![],
                vec![ImportSource {
                    display_name: "FAKE note.pdf".to_owned(),
                    reader: Box::new(Cursor::new(NOTE.to_vec())),
                }],
                2,
            )
            .unwrap();
        let id = store
            .recording_start(profile, vec![], "FAKE clip.mp4", 3)
            .unwrap();
        let mut movie = [ftyp(), moov()].concat();
        for n in 0..3_u64 {
            movie.extend(fragment(n as u32 + 1, n * 30000, n * 48128, 900_000));
        }
        for part in movie.chunks(300_000) {
            store.recording_append(id, part).unwrap();
        }
        let video = store.recording_stop(id, 4).unwrap().unwrap();
        let note = store
            .snapshot()
            .unwrap()
            .records
            .iter()
            .find(|r| r.display_name == "FAKE note.pdf")
            .unwrap()
            .id;
        (store, note, video)
    }

    fn read_all(store: &VaultStore, record: Uuid) -> Vec<u8> {
        let mut bytes = Vec::new();
        store.read_for_view(record, &mut bytes).unwrap();
        bytes
    }

    fn backup_bytes(store: &VaultStore, leave_out: bool) -> Vec<u8> {
        let mut bytes = Vec::new();
        store.backup_with(&mut bytes, 9, leave_out).unwrap();
        bytes
    }

    fn restored(backup: Vec<u8>, root: &Path) -> Result<VaultStore, VaultError> {
        let store = VaultStore::new(root.join("restored"));
        store.restore(
            Cursor::new(backup),
            RestoreCredential::Passphrase(PASSWORD),
            false,
        )?;
        store.unlock(PASSWORD).unwrap();
        Ok(store)
    }

    #[test]
    fn the_size_shown_is_the_size_written_and_says_how_much_is_video() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _, _) = vault_with_a_video(temp.path());
        let size = store.backup_size().unwrap();
        let (with, without) = (size, size);
        let written = backup_bytes(&store, false).len() as u64;
        let written_without = backup_bytes(&store, true).len() as u64;
        // Within the overhead of the headers and the trailer.
        assert!(with.total_bytes >= written, "{with:?} {written}");
        assert!(with.total_bytes - written < 4096, "{with:?} {written}");
        assert!(
            without.without_videos_bytes >= written_without,
            "{without:?}"
        );
        assert!(
            without.without_videos_bytes - written_without < 4096,
            "{without:?}"
        );
        assert_eq!(with.video_count, 1);
        assert!(with.video_bytes > 2_500_000);
        // Without the videos the backup is smaller by about what they take.
        assert!(without.without_videos_bytes < with.total_bytes - with.video_bytes + 1024);
        assert!(without.without_videos_bytes < 100_000);
    }

    /// An imported file that has `ftyp` where an MP4 does, with `brand` after it.
    fn imported_with_ftyp(store: &VaultStore, name: &str, brand: &[u8; 4], how: &str) -> Uuid {
        let profile = store.snapshot().unwrap().profiles[0].id;
        let mut bytes = vec![0, 0, 0, 0x18];
        bytes.extend_from_slice(b"ftyp");
        bytes.extend_from_slice(brand);
        bytes.extend_from_slice(&[0; 12]);
        bytes.extend_from_slice(name.as_bytes());
        let outcome = store
            .import_from(
                profile,
                vec![],
                vec![ImportSource {
                    display_name: name.to_owned(),
                    reader: Box::new(Cursor::new(bytes)),
                }],
                5,
                how,
            )
            .unwrap();
        outcome.imported[0]
    }

    #[test]
    fn only_a_video_recorded_in_the_app_is_left_out_never_a_photo_a_memo_or_a_pdf_with_ftyp() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _, video) = vault_with_a_video(temp.path());
        // What an iPhone, a recorder and a camera make, and a PDF that carries
        // `ftyp` in the same place, all imported from the device's files.
        let kept: Vec<(Uuid, Vec<u8>)> = [
            ("FAKE rash.heic", b"heic", "picked"),
            ("FAKE rash.avif", b"avif", "picked"),
            ("FAKE memo.m4a", b"M4A ", "picked"),
            ("FAKE raw.cr3", b"crx ", "picked"),
            ("FAKE clip.mov", b"qt  ", "picked"),
            ("FAKE clip.mp4 picked", b"isom", "picked"),
            ("FAKE scan.pdf", b"mp42", "picked"),
        ]
        .iter()
        .map(|(name, brand, how)| {
            let id = imported_with_ftyp(&store, name, brand, how);
            (id, read_all(&store, id))
        })
        .collect();
        let plan = store.plan_backup(true).unwrap();
        assert_eq!(plan.videos(), [video]);
        let size = store.backup_size().unwrap();
        assert_eq!(size.video_count, 1);
        let backup = backup_bytes(&store, true);
        let other = restored(backup, temp.path()).unwrap();
        for (id, bytes) in kept {
            assert_eq!(read_all(&other, id), bytes);
        }
        assert!(
            !other
                .snapshot()
                .unwrap()
                .records
                .iter()
                .find(|r| r.id == video)
                .unwrap()
                .available
        );
    }

    #[test]
    fn a_video_hidden_after_the_videos_were_found_is_still_kept_by_the_check_and_the_write() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _, video) = vault_with_a_video(temp.path());
        let plan = store.plan_backup(true).unwrap();
        assert_eq!(plan.videos(), [video]);
        // The patient hides it between the plan and the save (a provider's slow open).
        store.hide_record(video, 7).unwrap();
        {
            let guard = store.session();
            assert!(plan
                .omitted_in(&guard.as_ref().unwrap().manifest)
                .is_empty());
        }
        // The check reads it (it would be written), and the write holds it.
        store.verify_for_backup_planned(&plan).unwrap();
        let mut bytes = Vec::new();
        store.backup_planned(&mut bytes, 9, &plan).unwrap();
        assert_eq!(&bytes[..16], &BACKUP_MAGIC[..16]);
        let other = restored(bytes, temp.path()).unwrap();
        assert_eq!(read_all(&other, video), read_all(&store, video));
    }

    /// A hidden person's videos are never left out of a smaller backup, whether the person was
    /// hidden before the videos were found or between the plan and the save: hiding is tidiness,
    /// and a restore of the person needs their files (#360).
    #[test]
    fn a_hidden_persons_video_stays_in_the_backup_even_when_videos_are_left_out() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _, video) = vault_with_a_video(temp.path());
        let person = store
            .snapshot()
            .unwrap()
            .records
            .iter()
            .find(|r| r.id == video)
            .unwrap()
            .profile_id;
        store.create_profile("FAKE Other Person", 5).unwrap();
        // Hidden between the plan and the save.
        let plan = store.plan_backup(true).unwrap();
        assert_eq!(plan.videos(), [video]);
        store.hide_profile(person, 7).unwrap();
        {
            let guard = store.session();
            assert!(plan
                .omitted_in(&guard.as_ref().unwrap().manifest)
                .is_empty());
        }
        // Hidden before the plan: the video is not even listed.
        let plan = store.plan_backup(true).unwrap();
        assert!(plan.videos().is_empty());
        let mut bytes = Vec::new();
        store.backup_planned(&mut bytes, 9, &plan).unwrap();
        let other = restored(bytes, temp.path()).unwrap();
        // The person comes back with their video, in the vault and in the restored copy.
        store.restore_profile(person).unwrap();
        other.restore_profile(person).unwrap();
        assert_eq!(read_all(&other, video), read_all(&store, video));
        assert!(
            other
                .snapshot()
                .unwrap()
                .records
                .iter()
                .find(|r| r.id == video)
                .unwrap()
                .available
        );
    }

    #[test]
    fn a_video_the_patient_hid_stays_in_the_backup_with_its_reason() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _, video) = vault_with_a_video(temp.path());
        store.hide_record(video, 7).unwrap();
        let plan = store.plan_backup(true).unwrap();
        assert!(plan.videos().is_empty());
        let backup = backup_bytes(&store, true);
        // Not format 2: nothing was left out, and the video is there to restore.
        assert_eq!(&backup[..16], &BACKUP_MAGIC[..16]);
        let other = restored(backup, temp.path()).unwrap();
        let record = other
            .snapshot()
            .unwrap()
            .records
            .into_iter()
            .find(|r| r.id == video)
            .unwrap();
        assert!(record.available);
        assert_eq!(read_all(&other, video), read_all(&store, video));
    }

    #[test]
    fn an_ordinary_backup_is_format_1_and_one_with_videos_left_out_is_format_2() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _, _) = vault_with_a_video(temp.path());
        let ordinary = backup_bytes(&store, false);
        assert!(ordinary.starts_with(BACKUP_MAGIC));
        let left_out = backup_bytes(&store, true);
        assert!(left_out.starts_with(b"MYCARLOS-BACKUP2\n"));
        // A reader that knows only format 1 sees something else where the magic is.
        assert_ne!(&left_out[..16], BACKUP_MAGIC);
        // With no video to leave out, the backup stays format 1 though asked.
        let plain = tempfile::tempdir().unwrap();
        let other = VaultStore::new(plain.path().join("vault"));
        other.create(PASSWORD, "FAKE Person", 1).unwrap();
        assert!(backup_bytes(&other, true).starts_with(BACKUP_MAGIC));
    }

    #[test]
    fn a_backup_without_videos_restores_everything_else_byte_for_byte() {
        let temp = tempfile::tempdir().unwrap();
        let (store, note, video) = vault_with_a_video(temp.path());
        let ordinary = backup_bytes(&store, false);
        let left_out = backup_bytes(&store, true);
        assert!(left_out.len() * 10 < ordinary.len());
        // Said before anything is restored.
        let inspect = VaultStore::new(temp.path().join("inspect"));
        let preview = inspect
            .inspect_backup(
                Cursor::new(left_out.clone()),
                RestoreCredential::Passphrase(PASSWORD),
            )
            .unwrap();
        assert_eq!(preview.left_out, 1);
        let whole = inspect
            .inspect_backup(
                Cursor::new(ordinary.clone()),
                RestoreCredential::Passphrase(PASSWORD),
            )
            .unwrap();
        assert_eq!(whole.left_out, 0);
        // Restored.
        let restored = restored(left_out, temp.path()).unwrap();
        let snapshot = restored.snapshot().unwrap();
        assert_eq!(snapshot.records.len(), 2);
        assert_eq!(read_all(&restored, note), NOTE);
        let left = snapshot.records.iter().find(|r| r.id == video).unwrap();
        // The record is there, with its name and date, and no file: marked as a
        // document whose file went missing.
        assert_eq!(left.display_name, "FAKE clip.mp4");
        assert!(!left.available);
        assert!(restored.read_for_view(video, &mut Vec::new()).is_err());
        // The restore says so in the history, once for each.
        let history = history_events_for_test(&restored);
        let said: Vec<_> = history
            .iter()
            .filter(|e| e.how.as_deref() == Some("leftOutOfBackup"))
            .collect();
        assert_eq!(said.len(), 1);
        assert_eq!(said[0].record_id, Some(video));
        // The Hidden list can say why the file is missing: the latest event is it.
        assert_eq!(restored.left_out_records().unwrap(), [video]);
        // Its details ask whether it is a video to play: no, and no error, though
        // its camera event is still in the history and its file is not here.
        assert!(!crate::is_video(&restored, video).unwrap());
        // The vault the backup was made from left nothing out, and the whole
        // backup's restore did not either.
        assert!(store.left_out_records().unwrap().is_empty());
        // Anything the patient does with the record after that is the latest
        // event, and it is not told as left out any more.
        restored.rename_record(video, "FAKE renamed.mp4").unwrap();
        assert!(restored.left_out_records().unwrap().is_empty());
        // And the whole one restores the video too.
        let temp_whole = tempfile::tempdir().unwrap();
        let whole = restored_from(ordinary, temp_whole.path());
        assert_eq!(read_all(&whole, video).len(), read_all(&store, video).len());
        assert_eq!(read_all(&whole, video), read_all(&store, video));
    }

    fn restored_from(backup: Vec<u8>, root: &Path) -> VaultStore {
        restored(backup, root).unwrap()
    }

    #[test]
    fn a_vault_restored_without_its_videos_can_be_backed_up_again_and_they_stay_marked() {
        let temp = tempfile::tempdir().unwrap();
        let (store, note, video) = vault_with_a_video(temp.path());
        let restored = restored(backup_bytes(&store, true), temp.path()).unwrap();
        let again = backup_bytes(&restored, false);
        let second = tempfile::tempdir().unwrap();
        let twice = self::restored(again, second.path()).unwrap();
        assert_eq!(read_all(&twice, note), NOTE);
        let left = twice
            .snapshot()
            .unwrap()
            .records
            .into_iter()
            .find(|r| r.id == video)
            .unwrap();
        assert!(!left.available);
    }

    #[test]
    fn a_damaged_or_altered_backup_without_videos_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _, _) = vault_with_a_video(temp.path());
        let good = backup_bytes(&store, true);
        // Every part of it is covered: one flipped bit anywhere is found.
        let mut tried = 0;
        for at in (17..good.len()).step_by((good.len() / 40).max(1)) {
            let mut bad = good.clone();
            bad[at] ^= 1;
            let dir = tempfile::tempdir().unwrap();
            assert!(
                restored(bad, dir.path()).is_err(),
                "a flipped bit at {at} of {}",
                good.len()
            );
            tried += 1;
        }
        assert!(tried >= 30);
        // Cut short, or with something added.
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            restored(good[..good.len() - 5].to_vec(), dir.path()),
            Err(VaultError::BackupUnreadable)
        ));
        let mut longer = good.clone();
        longer.push(0);
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            restored(longer, dir.path()),
            Err(VaultError::BackupUnreadable)
        ));
        // Format 2's magic with a format 1 body is not a backup either.
        let mut mixed = good.clone();
        mixed[..17].copy_from_slice(b"MYCARLOS-BACKUP\n\0");
        let dir = tempfile::tempdir().unwrap();
        assert!(restored(mixed, dir.path()).is_err());
    }

    #[test]
    fn leaving_videos_out_does_not_read_them_and_does_not_change_the_vault() {
        let temp = tempfile::tempdir().unwrap();
        let (store, note, video) = vault_with_a_video(temp.path());
        let before = store.snapshot().unwrap();
        // A video that no longer reads fails an ordinary backup, naming it; one
        // left out is not read, so a backup without it still works.
        let path = record_object_path_for_test(&store, video);
        let mut bytes = fs::read(&path).unwrap();
        // In the second frame: the first still reads, so it is known to be a
        // video (one whose first frame is damaged cannot be told from any other
        // damaged document, and is kept in the backup, which then refuses it).
        bytes[25 + 5 + CHUNK_SIZE + 16 + 100] ^= 1;
        fs::write(&path, bytes).unwrap();
        assert!(matches!(
            store.verify_for_backup(),
            Err(VaultError::DamagedDocument(id)) if id == video
        ));
        assert!(store.verify_for_backup_with(true).is_ok());
        let left_out = backup_bytes(&store, true);
        let restored = restored(left_out, temp.path()).unwrap();
        assert_eq!(read_all(&restored, note), NOTE);
        // The live vault still has the video, not marked.
        let after = store.snapshot().unwrap();
        assert_eq!(before.records.len(), after.records.len());
        assert!(after.records.iter().all(|r| r.available));
        assert!(store.backup(Vec::new(), 9).is_err());
    }

    #[test]
    fn what_a_backup_leaves_out_is_ids_never_names() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _, video) = vault_with_a_video(temp.path());
        let left_out = backup_bytes(&store, true);
        // The note and the trailer are in the clear; nothing in them names a
        // document, and the file name of a video is nowhere in the backup.
        let text = String::from_utf8_lossy(&left_out);
        assert!(text.contains(&video.to_string()));
        assert!(!text.contains("FAKE clip"));
        assert!(!text.contains("FAKE note"));
    }
}

//! Recording a video into the vault (#359): the core, with no screen.
//!
//! A recording arrives as pieces of fragmented MP4 from the webview, about one
//! a second. Each is normalised (`mp4_stream`) and appended to an encrypted
//! object in the vault's own format (`MCVO1`, 1 MiB frames), so no readable
//! byte is written and at most one frame's worth is in memory. Every frame but
//! the last is exactly 1 MiB, which is what lets playback find frame *n* by
//! arithmetic; the last is sealed when the recording ends.
//!
//! **A playable video or nothing.** The object grows in `recordings/`, beside a
//! small encrypted *journal* written before the first byte. Whatever ends a
//! recording early (a crash, Lock now, the idle lock, the app hidden) leaves the
//! journal and the object behind, and the **one recovery path** at the next
//! unlock makes them a video or deletes them:
//!
//! - a **lock** *parks* a recording: its last partial frame is sealed and the
//!   journal says `parked`. The lock never waits on more than that;
//! - a **crash** leaves the object ending in a torn frame, and up to 1 MiB that
//!   was only in memory is gone;
//! - a **pause** writes the partial frame to a small encrypted *tail* file first
//!   (a pause is a long quiet time), so a crash while paused loses nothing.
//!
//! Recovery never rewrites a frame (that would reuse a nonce under the same
//! key). It reads the old object (authenticating every frame), cuts at the end
//! of the last whole fragment, and **copies** into a new object under a new key,
//! adds the index, verifies, and commits like an import. If no fragment is
//! complete it deletes everything and adds nothing.
//!
//! The commit is the import's: staged ciphertext published into `objects/`, then
//! one manifest commit with the history entry. The journal says `committing`
//! first, so that a crash between the two is still recovered (the orphan sweep
//! at unlock moves an unreferenced object to `quarantine/`, and recovery looks
//! there too).
//!
//! No screen, no IPC command and no free-space check are part of this step; it
//! is the layer they will call.

use super::*;
use crate::mp4_stream::{self, InitInfo, Mp4Normaliser};

/// Where growing recordings and their journals live: beside `staging/`, not in
/// it, because every unlock removes `staging/`.
const RECORDINGS_DIR: &str = "recordings";
const JOURNAL_MAGIC: &[u8; 5] = b"MCRJ1";
const JOURNAL_LABEL: &[u8] = b"mycarlos/recording-journal/v1";
const JOURNAL_AAD: &[u8] = b"mycarlos-recording-journal-v1:";
const TAIL_AAD: &[u8] = b"mycarlos-recording-tail-v1:";
const MAX_JOURNAL_BYTES: usize = 64 * 1024;
/// The most one piece from the webview may be. Pieces are about a second of
/// video; a larger one is refused, not buffered.
pub(crate) const MAX_RECORDING_PIECE: usize = 8 * 1024 * 1024;
/// The records the history says were added as a video, and which of them were picked from the
/// patient's files (an ordinary MP4) rather than recorded (a fragmented one with an index).
#[derive(Debug, Default)]
pub(super) struct VideoOrigins {
    any: HashSet<Uuid>,
    picked: HashSet<Uuid>,
    /// The whole history was read. When it was not, a record missing here may only be one whose
    /// piece could not be read.
    pub(super) complete: bool,
}

impl VideoOrigins {
    /// Recorded or picked.
    pub(super) fn contains(&self, id: &Uuid) -> bool {
        self.any.contains(id)
    }

    /// Picked from the patient's files: stored as the ordinary MP4 it came in as.
    pub(super) fn is_picked(&self, id: &Uuid) -> bool {
        self.picked.contains(id)
    }
}

/// Which history the video records were read from, and them.
pub(super) type CameraMade = ((Uuid, u64, String), Arc<VideoOrigins>);

/// The label the history gives a recording: the same as a photo taken in the app.
const RECORDING_HOW: &str = "camera";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum JournalState {
    Recording,
    Paused,
    Parked,
    /// The finished object is being published and committed: if the process
    /// ends here, recovery finds the object in `objects/` or `quarantine/`.
    Committing,
}

/// What the journal says. Encrypted under a key of the vault's, never read
/// without the master key.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    record_id: Uuid,
    profile_id: Uuid,
    folder_ids: Vec<Uuid>,
    display_name: String,
    started_at_ms: u64,
    object_name: String,
    wrapped_object_key: WrappedSecret,
    state: JournalState,
    /// The partial frame sealed at a pause, if there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tail_name: Option<String>,
    /// Objects recovery copied from: removed once the copy is committed, and
    /// still known if the process ends in between.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    superseded: Vec<String>,
    /// The object a recovery is copying into, named before it is created, so a
    /// copy a crash interrupts is found and removed rather than left behind.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    copying: Vec<String>,
    /// The patient ended it (Stop) and it could not be finished then (a lock did
    /// not park it): so that the next unlock can say why it is being finished.
    #[serde(default, skip_serializing_if = "is_false")]
    stopped: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn recordings_dir(root: &Path) -> PathBuf {
    root.join(RECORDINGS_DIR)
}

fn journal_path(root: &Path, record_id: Uuid) -> PathBuf {
    recordings_dir(root).join(format!("{record_id}.journal"))
}

fn journal_key(vault_id: Uuid, master_key: &[u8; 32]) -> Result<SecretKey, VaultError> {
    let hkdf = Hkdf::<Sha256>::new(Some(vault_id.as_bytes()), master_key);
    let mut key = Zeroizing::new([0_u8; 32]);
    hkdf.expand(JOURNAL_LABEL, key.as_mut())
        .map_err(|_| VaultError::Corrupt)?;
    Ok(key)
}

fn seal_with(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, VaultError> {
    let mut nonce = [0_u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = XChaCha20Poly1305::new(key.into())
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| VaultError::Storage)?;
    let mut out = Vec::with_capacity(JOURNAL_MAGIC.len() + 24 + ciphertext.len());
    out.extend_from_slice(JOURNAL_MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn open_with(key: &[u8; 32], aad: &[u8], sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    if sealed.len() < JOURNAL_MAGIC.len() + 24 + 16
        || &sealed[..JOURNAL_MAGIC.len()] != JOURNAL_MAGIC
    {
        return Err(VaultError::Corrupt);
    }
    let nonce = &sealed[JOURNAL_MAGIC.len()..JOURNAL_MAGIC.len() + 24];
    XChaCha20Poly1305::new(key.into())
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: &sealed[JOURNAL_MAGIC.len() + 24..],
                aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| VaultError::Corrupt)
}

fn journal_aad(vault_id: Uuid, record_id: Uuid) -> Vec<u8> {
    let mut aad = JOURNAL_AAD.to_vec();
    aad.extend_from_slice(vault_id.as_bytes());
    aad.extend_from_slice(record_id.as_bytes());
    aad
}

fn tail_aad(vault_id: Uuid, record_id: Uuid) -> Vec<u8> {
    let mut aad = TAIL_AAD.to_vec();
    aad.extend_from_slice(vault_id.as_bytes());
    aad.extend_from_slice(record_id.as_bytes());
    aad
}

fn write_journal(
    root: &Path,
    key: &[u8; 32],
    vault_id: Uuid,
    journal: &Journal,
) -> Result<(), VaultError> {
    let json = Zeroizing::new(serde_json::to_vec(journal).map_err(|_| VaultError::Storage)?);
    let sealed = seal_with(key, &journal_aad(vault_id, journal.record_id), &json)?;
    atomic_bytes(&journal_path(root, journal.record_id), &sealed)
}

fn read_journal(
    root: &Path,
    key: &[u8; 32],
    vault_id: Uuid,
    record_id: Uuid,
) -> Result<Journal, VaultError> {
    let bytes = read_bounded_regular_file(&journal_path(root, record_id), MAX_JOURNAL_BYTES)
        .map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => VaultError::NotFound,
            _ => VaultError::Corrupt,
        })?;
    let json = open_with(key, &journal_aad(vault_id, record_id), &bytes)?;
    let journal: Journal = serde_json::from_slice(&json).map_err(|_| VaultError::Corrupt)?;
    // The file's name and its content must agree.
    if journal.record_id != record_id {
        return Err(VaultError::Corrupt);
    }
    Ok(journal)
}

// ---- the growing object ------------------------------------------------------

/// Appends to an `MCVO1` object a piece at a time. Every frame but the last is
/// exactly `CHUNK_SIZE`; a full frame is sealed (not final), written and synced
/// at once, and the last is sealed (final) by [`finish`](Self::finish). Nothing
/// readable is written, and no more than one frame is held.
struct ObjectAppender {
    file: File,
    cipher: XChaCha20Poly1305,
    vault_id: Uuid,
    record_id: Uuid,
    nonce_prefix: [u8; 16],
    buffer: Zeroizing<Vec<u8>>,
    index: u64,
    total: u64,
    mac: HmacSha256,
    /// Where the next frame starts in the file: what a failed write is cut back to.
    file_len: u64,
    /// A write, a sync or a frame failed. The appender takes nothing more: a
    /// frame is never sealed twice under the same nonce (that would leak the
    /// XOR of two plaintexts and, with different associated data, the Poly1305
    /// key), and a torn frame is cut off rather than left in the middle.
    failed: bool,
}

impl ObjectAppender {
    fn create(
        path: &Path,
        context: ObjectContext,
        object_key: &[u8; 32],
        fingerprint_key: &[u8; 32],
    ) -> Result<Self, VaultError> {
        let mut file = open_private_new(path)?;
        let mut nonce_prefix = [0_u8; 16];
        OsRng.fill_bytes(&mut nonce_prefix);
        let mut header = Vec::with_capacity(OBJECT_MAGIC.len() + 4 + 16);
        header.extend_from_slice(OBJECT_MAGIC);
        header.extend_from_slice(&(CHUNK_SIZE as u32).to_be_bytes());
        header.extend_from_slice(&nonce_prefix);
        file.write_all(&header)?;
        let mut mac = <HmacSha256 as Mac>::new_from_slice(fingerprint_key)
            .map_err(|_| VaultError::Storage)?;
        mac.update(context.profile_id.as_bytes());
        Ok(Self {
            file,
            cipher: XChaCha20Poly1305::new(object_key.into()),
            vault_id: context.vault_id,
            record_id: context.record_id,
            nonce_prefix,
            buffer: Zeroizing::new(Vec::with_capacity(CHUNK_SIZE)),
            index: 0,
            total: 0,
            mac,
            file_len: header.len() as u64,
            failed: false,
        })
    }

    /// Whether the appender has failed and takes no more.
    fn has_failed(&self) -> bool {
        self.failed
    }

    /// What a pause seals to the tail file: the number of whole frames already in
    /// the object, then the bytes not yet in a frame. Recovery uses the tail only
    /// when the object still has exactly that many frames, so a tail that is out
    /// of date (a resume's removal failed, or the object moved on) is never added
    /// to the wrong place. A tail is always a prefix of what the buffer later
    /// holds, so one that is merely older but at the same frame is still right.
    fn tail_plain(&self) -> Zeroizing<Vec<u8>> {
        let mut plain = Zeroizing::new(Vec::with_capacity(8 + self.buffer.len()));
        plain.extend_from_slice(&self.index.to_be_bytes());
        plain.extend_from_slice(&self.buffer);
        plain
    }

    fn write(&mut self, mut data: &[u8]) -> Result<(), VaultError> {
        if self.failed {
            return Err(VaultError::Storage);
        }
        while !data.is_empty() {
            let take = (CHUNK_SIZE - self.buffer.len()).min(data.len());
            self.buffer.extend_from_slice(&data[..take]);
            self.mac.update(&data[..take]);
            self.total += take as u64;
            data = &data[take..];
            if self.buffer.len() == CHUNK_SIZE {
                self.seal(false)?;
            }
        }
        Ok(())
    }

    fn seal(&mut self, final_chunk: bool) -> Result<(), VaultError> {
        if self.failed {
            return Err(VaultError::Storage);
        }
        // Any failure below ends this appender for good: the frame's index is
        // not advanced, so sealing again would reuse its nonce.
        let result = self.seal_frame(final_chunk);
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    fn seal_frame(&mut self, final_chunk: bool) -> Result<(), VaultError> {
        let mut nonce = [0_u8; 24];
        nonce[..16].copy_from_slice(&self.nonce_prefix);
        nonce[16..].copy_from_slice(&self.index.to_be_bytes());
        let aad = object_aad(self.vault_id, self.record_id, self.index, final_chunk);
        let ciphertext = self
            .cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &self.buffer[..],
                    aad: &aad,
                },
            )
            .map_err(|_| VaultError::Storage)?;
        let mut frame = Vec::with_capacity(5 + ciphertext.len());
        frame.extend_from_slice(&(ciphertext.len() as u32).to_be_bytes());
        frame.push(u8::from(final_chunk));
        frame.extend_from_slice(&ciphertext);
        let written = fail_at_test_boundary("recording.chunk-write")
            .and_then(|()| self.file.write_all(&frame).map_err(VaultError::from))
            .and_then(|()| self.file.sync_data().map_err(VaultError::from));
        if let Err(error) = written {
            // Cut the half-written frame off, so the object ends at the last
            // whole one. If that fails too, recovery treats it as a torn tail.
            let _ = self.file.set_len(self.file_len);
            return Err(error);
        }
        self.file_len += frame.len() as u64;
        self.buffer.clear();
        self.index = self.index.checked_add(1).ok_or(VaultError::Invalid)?;
        if !final_chunk {
            terminate_at_test_boundary("recording.after-chunk-write");
            fail_at_test_boundary("recording.after-chunk-write")?;
        }
        Ok(())
    }

    /// Seals what is left as the final frame (which may be empty) and syncs.
    fn finish(mut self) -> Result<EncryptedObject, VaultError> {
        if self.failed {
            return Err(VaultError::Storage);
        }
        self.seal(true)?;
        self.file.sync_all()?;
        Ok(EncryptedObject {
            plaintext_size: self.total,
            fingerprint: self.mac.finalize().into_bytes().into(),
        })
    }
}

/// How reading an old object ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ObjectEnd {
    /// The final frame was read.
    Final,
    /// The file ended after a whole frame, with no final frame (a crash).
    Open,
    /// The file ended inside a frame, or before the header was whole.
    Torn,
}

/// Reads the whole frames of an object that may not have been finished,
/// authenticating each one, and hands their plaintext to `sink`. A frame that is
/// whole but does not authenticate is damage, not a crash.
fn read_unfinished_object(
    path: &Path,
    vault_id: Uuid,
    record_id: Uuid,
    object_key: &[u8; 32],
    mut sink: impl FnMut(&[u8]) -> Result<(), VaultError>,
) -> Result<(ObjectEnd, u64), VaultError> {
    let mut reader = BufReader::new(open_regular_read(path)?);
    let mut header = [0_u8; 25];
    if !read_full(&mut reader, &mut header)? {
        return Ok((ObjectEnd::Torn, 0));
    }
    if &header[..5] != OBJECT_MAGIC
        || u32::from_be_bytes([header[5], header[6], header[7], header[8]]) as usize != CHUNK_SIZE
    {
        return Err(VaultError::Corrupt);
    }
    let mut nonce_prefix = [0_u8; 16];
    nonce_prefix.copy_from_slice(&header[9..25]);
    let cipher = XChaCha20Poly1305::new(object_key.into());
    let mut index = 0_u64;
    loop {
        let mut length = [0_u8; 4];
        match read_some(&mut reader, &mut length)? {
            0 => return Ok((ObjectEnd::Open, index)),
            4 => {}
            _ => return Ok((ObjectEnd::Torn, index)),
        }
        let length = u32::from_be_bytes(length) as usize;
        if !(16..=CHUNK_SIZE + 16).contains(&length) {
            // After a power loss a file can end in blocks of zeros the file
            // system had extended it by but never filled: nothing but zeros to
            // the end is a torn tail. Anything else is damage.
            return if length == 0 && rest_is_zero(&mut reader)? {
                Ok((ObjectEnd::Torn, index))
            } else {
                Err(VaultError::Corrupt)
            };
        }
        let mut final_byte = [0_u8; 1];
        if !read_full(&mut reader, &mut final_byte)? {
            return Ok((ObjectEnd::Torn, index));
        }
        if final_byte[0] > 1 {
            return Err(VaultError::Corrupt);
        }
        let final_chunk = final_byte[0] == 1;
        let mut ciphertext = vec![0_u8; length];
        if !read_full(&mut reader, &mut ciphertext)? {
            return Ok((ObjectEnd::Torn, index));
        }
        let mut nonce = [0_u8; 24];
        nonce[..16].copy_from_slice(&nonce_prefix);
        nonce[16..].copy_from_slice(&index.to_be_bytes());
        let plaintext = match cipher.decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &object_aad(vault_id, record_id, index, final_chunk),
            },
        ) {
            Ok(plaintext) => Zeroizing::new(plaintext),
            // The last frame in the file, of the right length but not
            // authentic: after a power loss its blocks may never have reached
            // the disk (zeros, or the old contents). It is a torn tail, and the
            // object ends at the frame before it. The same failure in a frame
            // that something follows is damage.
            Err(_) if read_some(&mut reader, &mut [0_u8; 1])? == 0 => {
                return Ok((ObjectEnd::Torn, index));
            }
            Err(_) => return Err(VaultError::Corrupt),
        };
        sink(&plaintext)?;
        index += 1;
        if final_chunk {
            return Ok((ObjectEnd::Final, index));
        }
    }
}

/// Whether everything left in the reader is zero.
fn rest_is_zero(reader: &mut impl Read) -> Result<bool, VaultError> {
    let mut chunk = [0_u8; 4096];
    loop {
        let got = read_some(reader, &mut chunk)?;
        if chunk[..got].iter().any(|b| *b != 0) {
            return Ok(false);
        }
        if got < chunk.len() {
            return Ok(true);
        }
    }
}

/// Reads exactly `buffer.len()` bytes; false if the file ends first.
fn read_full(reader: &mut impl Read, buffer: &mut [u8]) -> Result<bool, VaultError> {
    Ok(read_some(reader, buffer)? == buffer.len())
}

/// Reads up to `buffer.len()` bytes and says how many there were.
fn read_some(reader: &mut impl Read, buffer: &mut [u8]) -> Result<usize, VaultError> {
    let mut got = 0;
    while got < buffer.len() {
        match reader.read(&mut buffer[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(got)
}

/// Counts the plaintext a verification pass reads, and keeps none of it.
struct CountingSink(u64);

impl Write for CountingSink {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.0 += data.len() as u64;
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// ---- a recording in progress -------------------------------------------------

/// A recording in progress. Held in memory by the store; its key is a copy that
/// is wiped when it ends.
pub(super) struct ActiveRecording {
    vault_id: Uuid,
    journal: Journal,
    object_key: SecretKey,
    journal_key: SecretKey,
    object_path: PathBuf,
    appender: Option<ObjectAppender>,
    normaliser: Mp4Normaliser,
    scratch: Vec<u8>,
    paused: bool,
    /// A piece the normaliser refused: the recording takes no more, and ends
    /// through recovery, which keeps what was complete.
    poisoned: bool,
    /// The sequence number the next piece must carry (pieces sent with one).
    next_sequence: u64,
    /// Where room was last found, and when it is next looked at (in sealed frames).
    space: SpaceLevel,
    free_bytes: Option<u64>,
    next_space_check: u64,
}

/// A finished object, ready to be verified, published and committed.
struct FinishedRecording<'a> {
    journal: &'a Journal,
    journal_key: &'a SecretKey,
    object_path: &'a Path,
    object_key: &'a SecretKey,
    encrypted: EncryptedObject,
}

/// At least this much room is needed to start recording, and again on every
/// resume: about 15 minutes at High, and the reserve below besides.
pub(crate) const MIN_FREE_TO_RECORD: u64 = 1 << 30;
/// From here the page warns that room is running low.
pub(crate) const LOW_FREE_WARNING: u64 = 512 << 20;
/// At this much the recording is ended and saved: what is left is the reserve for
/// the last frame, the verification pass, the manifest commit and the history.
pub(crate) const STOP_FREE: u64 = 256 << 20;
/// Room is looked at again after this many sealed frames (about 8 MiB).
const SPACE_CHECK_EVERY_FRAMES: u64 = 8;

/// How much room there is, as the page needs to say it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SpaceLevel {
    /// Plenty.
    Ok,
    /// Under 512 MiB: warn.
    Low,
    /// Under 256 MiB: end the recording and save it.
    Stop,
    /// The volume could not be asked: nothing is refused on a guess.
    Unknown,
}

/// What `recording_space` reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSpace {
    pub free_bytes: Option<u64>,
    pub level: SpaceLevel,
    /// Enough to start (or resume) recording: at least 1 GiB, or not known.
    pub can_record: bool,
}

fn space_level(free: Option<u64>) -> SpaceLevel {
    match free {
        None => SpaceLevel::Unknown,
        Some(free) if free < STOP_FREE => SpaceLevel::Stop,
        Some(free) if free < LOW_FREE_WARNING => SpaceLevel::Low,
        Some(_) => SpaceLevel::Ok,
    }
}

/// What a caller learns after a piece.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingProgress {
    /// Bytes of the video stored so far (the normalised stream).
    pub stored_bytes: u64,
    /// Complete fragments so far.
    pub fragments: usize,
    /// Both tracks the patient asked for are in the movie header: `None` until it
    /// has been read.
    pub has_video: Option<bool>,
    pub has_audio: Option<bool>,
    /// The sequence number the next piece must carry, so that a lost or repeated
    /// piece is noticed.
    pub next_sequence: u64,
    /// How much room there was when it was last looked at (every 8 MiB or so).
    pub space: SpaceLevel,
    pub free_bytes: Option<u64>,
}

/// One unfinished recording found in `recordings/`, for the question at unlock.
#[cfg_attr(test, derive(Debug))]
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRecording {
    pub id: Uuid,
    pub display_name: String,
    pub started_at_ms: u64,
    /// It was paused when it ended.
    pub paused: bool,
    /// It was parked by a lock (not a crash).
    pub parked: bool,
    /// The patient ended it and it could not be finished for want of room: it is
    /// finished when there is room again, and the notice says so.
    pub stopped: bool,
}
redact_debug!(PendingRecording);

/// All the journals found, and how many could not be read.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRecordings {
    pub recordings: Vec<PendingRecording>,
    pub unreadable: usize,
}

impl VaultStore {
    /// Starts a recording for `profile_id` (and `folder_ids`): writes its journal,
    /// then its object's header. Nothing is added to the library until it ends.
    pub fn recording_start(
        &self,
        profile_id: Uuid,
        folder_ids: Vec<Uuid>,
        display_name: &str,
        now_ms: u64,
    ) -> Result<Uuid, VaultError> {
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        // Too little room is refused before anything is written (and, in the
        // page, before the camera or microphone is turned on).
        let start_space = self.space_now();
        if !start_space.can_record {
            return Err(VaultError::NoSpace);
        }
        require_profile(&unlocked.manifest, profile_id)?;
        validate_folder_ids(&unlocked.manifest, profile_id, &folder_ids)?;
        let vault_id = unlocked.manifest.vault_id;
        let keys = derive_keys(vault_id, &unlocked.master_key)?;
        let journal_key = journal_key(vault_id, &unlocked.master_key)?;
        let record_id = Uuid::new_v4();
        let mut object_key = Zeroizing::new([0_u8; 32]);
        OsRng.fill_bytes(object_key.as_mut());
        let object_name = format!("{}.mcobj", Uuid::new_v4());
        let journal = Journal {
            record_id,
            profile_id,
            folder_ids: unique(folder_ids),
            display_name: sanitize_basename(display_name),
            started_at_ms: now_ms,
            wrapped_object_key: wrap_secret(&keys.object_wrap, &object_key, record_id.as_bytes())?,
            object_name: object_name.clone(),
            state: JournalState::Recording,
            tail_name: None,
            superseded: Vec::new(),
            copying: Vec::new(),
            stopped: false,
        };
        let dir = recordings_dir(&self.root);
        create_private_dir_all(&dir)?;
        // The journal first: an object with no journal could never be opened again.
        write_journal(&self.root, &journal_key, vault_id, &journal)?;
        terminate_at_test_boundary("recording.after-journal");
        fail_at_test_boundary("recording.after-journal")?;
        let object_path = dir.join(&object_name);
        let appender = ObjectAppender::create(
            &object_path,
            ObjectContext {
                vault_id,
                record_id,
                profile_id,
            },
            &object_key,
            &keys.fingerprint,
        );
        let appender = match appender {
            Ok(appender) => appender,
            Err(error) => {
                let _ =
                    remove_owned_file(journal_path(&self.root, record_id), Removable::Recording);
                return Err(error);
            }
        };
        sync_dir(&dir)?;
        sync_parent(&self.root);
        self.recordings
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                record_id,
                ActiveRecording {
                    vault_id,
                    journal,
                    object_key,
                    journal_key,
                    object_path,
                    appender: Some(appender),
                    normaliser: Mp4Normaliser::new(),
                    scratch: Vec::new(),
                    paused: false,
                    poisoned: false,
                    next_sequence: 0,
                    // Where the start found room: until the first look at 8 MiB.
                    space: start_space.level,
                    free_bytes: start_space.free_bytes,
                    next_space_check: 0,
                },
            );
        Ok(record_id)
    }

    /// Adds a piece. The caller sends them in order and one at a time. The
    /// commands number their pieces (`recording_append_numbered`); this is for
    /// the tests.
    #[cfg(test)]
    pub fn recording_append(
        &self,
        id: Uuid,
        piece: &[u8],
    ) -> Result<RecordingProgress, VaultError> {
        self.recording_append_numbered(id, None, piece)
    }

    /// Adds a piece that may carry a sequence number. A piece with the number
    /// expected is added; a repeat of the one just added (a reply that was lost)
    /// is answered with the progress it made and not added again; any other
    /// number is refused and nothing is changed. Every piece added counts as
    /// activity, so the vault does not lock under a recording that is running;
    /// a paused recording sends none, and so does not hold it.
    pub fn recording_append_numbered(
        &self,
        id: Uuid,
        sequence: Option<u64>,
        piece: &[u8],
    ) -> Result<RecordingProgress, VaultError> {
        if piece.len() > MAX_RECORDING_PIECE {
            return Err(VaultError::Invalid);
        }
        self.require_writable_session()?;
        let mut map = self
            .recordings
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let recording = map.get_mut(&id).ok_or(VaultError::NotFound)?;
        if recording.poisoned {
            return Err(VaultError::Invalid);
        }
        if let Some(sequence) = sequence {
            if sequence != recording.next_sequence {
                // The piece just added, sent again: it is already in.
                if sequence.checked_add(1) == Some(recording.next_sequence) {
                    return Ok(progress_of(recording));
                }
                return Err(VaultError::Invalid);
            }
        }
        // The room that was left for the last frame, the check and the commit is
        // not spent: once it is reached the page ends the recording, and a piece
        // sent after that is refused.
        if recording.space == SpaceLevel::Stop {
            return Err(VaultError::NoSpace);
        }
        recording.scratch.clear();
        if recording
            .normaliser
            .push(piece, &mut recording.scratch)
            .is_err()
        {
            recording.poisoned = true;
            return Err(VaultError::Invalid);
        }
        let appender = recording.appender.as_mut().ok_or(VaultError::Invalid)?;
        if let Err(error) = appender.write(&recording.scratch) {
            // The disk refused (full, or gone): the recording takes no more and
            // ends through recovery, which keeps the frames that were written.
            recording.poisoned = true;
            return Err(error);
        }
        // A piece the webview cut before the pause can arrive after it: the
        // tail follows what is in memory.
        if recording.paused {
            let sealed = seal_with(
                &recording.journal_key,
                &tail_aad(recording.vault_id, id),
                &appender.tail_plain(),
            )?;
            let name = format!("{id}.tail");
            atomic_bytes(&recordings_dir(&self.root).join(name), &sealed)?;
        }
        recording.next_sequence += 1;
        // Room is looked at again every 8 sealed frames (about 8 MiB).
        if let Some(appender) = recording.appender.as_ref() {
            if appender.index >= recording.next_space_check {
                recording.next_space_check = appender.index + SPACE_CHECK_EVERY_FRAMES;
                let free = self.free_space_now();
                recording.free_bytes = free;
                recording.space = space_level(free);
            }
        }
        // Video that keeps arriving keeps the vault from locking on idle.
        self.idle.touch(Instant::now());
        Ok(progress_of(recording))
    }

    /// Pauses: the partial frame is sealed to a tail file first, so that a crash
    /// while paused loses nothing, then the journal says `paused`. Pieces the
    /// webview cut before the pause may still arrive. On resume, the next
    /// fragment has its time gap closed.
    pub fn recording_pause(&self, id: Uuid) -> Result<(), VaultError> {
        self.require_writable_session()?;
        let mut map = self
            .recordings
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let recording = map.get_mut(&id).ok_or(VaultError::NotFound)?;
        let vault_id = recording.vault_id;
        if recording.paused {
            return Ok(());
        }
        let appender = recording.appender.as_ref().ok_or(VaultError::Invalid)?;
        let tail_name = format!("{id}.tail");
        let sealed = seal_with(
            &recording.journal_key,
            &tail_aad(vault_id, id),
            &appender.tail_plain(),
        )?;
        atomic_bytes(&recordings_dir(&self.root).join(&tail_name), &sealed)?;
        terminate_at_test_boundary("recording.after-pause-tail");
        fail_at_test_boundary("recording.after-pause-tail")?;
        recording.journal.state = JournalState::Paused;
        recording.journal.tail_name = Some(tail_name);
        write_journal(
            &self.root,
            &recording.journal_key,
            vault_id,
            &recording.journal,
        )?;
        recording.paused = true;
        Ok(())
    }

    /// Resumes: the tail file is no longer needed (the partial frame is still in
    /// memory and goes on filling).
    pub fn recording_resume(&self, id: Uuid) -> Result<(), VaultError> {
        self.require_writable_session()?;
        let mut map = self
            .recordings
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let recording = map.get_mut(&id).ok_or(VaultError::NotFound)?;
        let vault_id = recording.vault_id;
        if !recording.paused {
            return Ok(());
        }
        recording.journal.state = JournalState::Recording;
        let tail = recording.journal.tail_name.take();
        write_journal(
            &self.root,
            &recording.journal_key,
            vault_id,
            &recording.journal,
        )?;
        if let Some(tail) = tail {
            let _ = remove_owned_file(recordings_dir(&self.root).join(tail), Removable::Recording);
        }
        // The next fragment starts after the pause: close the gap it left.
        recording.normaliser.mark_pause();
        recording.paused = false;
        Ok(())
    }

    /// Ends a recording: the index is added, the object finished and verified,
    /// and the video committed to the library like an import. Returns the new
    /// record, or `None` when nothing complete had been recorded (nothing is
    /// added and everything is deleted).
    pub fn recording_stop(&self, id: Uuid, now_ms: u64) -> Result<Option<Uuid>, VaultError> {
        let mut recording = self
            .recordings
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id)
            .ok_or(VaultError::NotFound)?;
        let entries = recording.normaliser.index();
        // Clean: the stream ends where its last complete fragment does, so the
        // index can follow it and the object be finished in place. Anything else
        // (a refused piece, a partial fragment at the end) goes through recovery,
        // which cuts at the last complete fragment.
        let clean = !recording.poisoned
            && !entries.is_empty()
            && recording.normaliser.written() == recording.normaliser.complete_end();
        if !clean {
            recording.journal.stopped = true;
            self.park_one(&mut recording)?;
            return self.recording_recover(id, true, now_ms);
        }
        let init = recording
            .normaliser
            .init()
            .cloned()
            .ok_or(VaultError::Invalid)?;
        let mut appender = recording.appender.take().ok_or(VaultError::Invalid)?;
        let trailer =
            mp4_stream::index_trailer(&init, &entries).map_err(|_| VaultError::Invalid)?;
        appender.write(&trailer)?;
        let encrypted = appender.finish()?;
        terminate_at_test_boundary("recording.after-finish");
        fail_at_test_boundary("recording.after-finish")?;
        self.commit_recording(
            recording.vault_id,
            FinishedRecording {
                journal: &recording.journal,
                journal_key: &recording.journal_key,
                object_path: &recording.object_path,
                object_key: &recording.object_key,
                encrypted,
            },
            now_ms,
        )
        .map(Some)
    }

    /// Parks every recording in progress: the partial frame is sealed as the
    /// final one and the journal says `parked`. Called by the lock, which has
    /// the session's keys no longer a moment later; the commit waits for the
    /// next unlock. Best effort: a recording that cannot be parked is left as a
    /// crash would leave it.
    pub(super) fn park_recordings(&self) {
        let all: Vec<ActiveRecording> = self
            .recordings
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .drain()
            .map(|(_, recording)| recording)
            .collect();
        for mut recording in all {
            let _ = self.park_one(&mut recording);
        }
    }

    fn park_one(&self, recording: &mut ActiveRecording) -> Result<(), VaultError> {
        let appender = recording.appender.take().ok_or(VaultError::Invalid)?;
        // A failed appender is left as it is: the object ends at its last whole
        // frame and recovery keeps what was complete.
        if !appender.has_failed() {
            appender.finish()?;
        }
        recording.journal.state = JournalState::Parked;
        write_journal(
            &self.root,
            &recording.journal_key,
            recording.vault_id,
            &recording.journal,
        )?;
        terminate_at_test_boundary("recording.after-park");
        Ok(())
    }

    /// Lists the unfinished recordings in `recordings/` (the ones a crash or a
    /// lock left), for the question at unlock.
    pub fn recordings_pending(&self) -> Result<PendingRecordings, VaultError> {
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        let vault_id = unlocked.manifest.vault_id;
        let key = journal_key(vault_id, &unlocked.master_key)?;
        let active: HashSet<Uuid> = self
            .recordings
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .keys()
            .copied()
            .collect();
        let mut found = PendingRecordings::default();
        let Ok(entries) = fs::read_dir(recordings_dir(&self.root)) else {
            return Ok(found);
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(stem) = name.to_str().and_then(|n| n.strip_suffix(".journal")) else {
                continue;
            };
            let Ok(id) = Uuid::parse_str(stem) else {
                found.unreadable += 1;
                continue;
            };
            if active.contains(&id) {
                continue;
            }
            match read_journal(&self.root, &key, vault_id, id) {
                Ok(journal) => found.recordings.push(PendingRecording {
                    id,
                    display_name: journal.display_name,
                    started_at_ms: journal.started_at_ms,
                    paused: journal.state == JournalState::Paused,
                    parked: journal.state == JournalState::Parked,
                    stopped: journal.stopped,
                }),
                Err(_) => found.unreadable += 1,
            }
        }
        found.recordings.sort_by_key(|r| (r.started_at_ms, r.id));
        Ok(found)
    }

    /// Answers the question at unlock. `keep == false` deletes the recording.
    /// `keep == true` turns it into a video (see the module notes) or, when no
    /// fragment is complete, deletes it; either way the library gets a video or
    /// nothing. Returns the new record.
    pub fn recording_recover(
        &self,
        id: Uuid,
        keep: bool,
        now_ms: u64,
    ) -> Result<Option<Uuid>, VaultError> {
        // What the session knows, taken once so the long passes run without it.
        let (vault_id, object_wrap, journal_key_value, fingerprint, committed) = {
            let guard = self.session();
            let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
            if unlocked.recovery.is_some() {
                return Err(VaultError::RecoveryMode);
            }
            let vault_id = unlocked.manifest.vault_id;
            let keys = derive_keys(vault_id, &unlocked.master_key)?;
            (
                vault_id,
                Zeroizing::new(keys.object_wrap),
                journal_key(vault_id, &unlocked.master_key)?,
                Zeroizing::new(keys.fingerprint),
                unlocked
                    .manifest
                    .records
                    .iter()
                    .any(|record| record.id == id),
            )
        };
        if self
            .recordings
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(&id)
        {
            return Err(VaultError::Invalid);
        }
        let mut journal = read_journal(&self.root, &journal_key_value, vault_id, id)?;
        let dir = recordings_dir(&self.root);
        // A copy an earlier recovery was making when it was interrupted: never
        // committed, never named by the manifest, safe to remove.
        // (A `committing` journal never lists one: the commit's journal empties
        // the list, so this is safe for every state.)
        if !journal.copying.is_empty() {
            for name in journal.copying.drain(..) {
                let _ = remove_owned_file(dir.join(name), Removable::Recording);
            }
            write_journal(&self.root, &journal_key_value, vault_id, &journal)?;
        }
        // Already committed (a crash after the manifest commit, before the
        // journal was removed): the live object stays; the leftovers go.
        if committed {
            remove_recording_files(&self.root, &journal, false);
            return Ok(Some(id));
        }
        if !keep {
            remove_recording_files(&self.root, &journal, true);
            return Ok(None);
        }
        let old_key = unwrap_secret(&object_wrap, &journal.wrapped_object_key, id.as_bytes())?;
        let Some(old_path) = find_object(&self.root, &journal.object_name) else {
            // The journal is written before the object exists: an end between the
            // two leaves a journal that never had anything to keep. Any later
            // state names an object that must be there.
            if journal.state == JournalState::Recording {
                remove_recording_files(&self.root, &journal, true);
                return Ok(None);
            }
            return Err(VaultError::Corrupt);
        };
        // A pause's tail, found by its fixed name (a crash between the tail and
        // the journal's update must not lose it). It is used only if the object
        // has exactly the frames it was cut after and no final frame.
        let tail_plain =
            match read_bounded_regular_file(&dir.join(format!("{id}.tail")), CHUNK_SIZE + 1024) {
                Ok(sealed) => Some(open_with(
                    &journal_key_value,
                    &tail_aad(vault_id, id),
                    &sealed,
                )?),
                Err(_) => None,
            };
        let tail: Option<(u64, &[u8])> = match &tail_plain {
            Some(plain) if plain.len() >= 8 => Some((
                u64::from_be_bytes(plain[..8].try_into().map_err(|_| VaultError::Corrupt)?),
                &plain[8..],
            )),
            Some(_) => return Err(VaultError::Corrupt),
            None => None,
        };
        // The old stream: its whole frames, then the tail a pause sealed.
        let feed = |sink: &mut dyn FnMut(&[u8]) -> Result<(), VaultError>| -> Result<ObjectEnd, VaultError> {
            let (end, frames) =
                read_unfinished_object(&old_path, vault_id, id, &old_key, |chunk| sink(chunk))?;
            // If the object ended with its final frame, the parked partial frame is
            // already in it and an older tail must not be added again.
            if end != ObjectEnd::Final {
                if let Some((after, bytes)) = tail {
                    if after == frames {
                        sink(bytes)?;
                        return Ok(ObjectEnd::Open);
                    }
                }
            }
            Ok(end)
        };
        // Pass 1: where does the last whole fragment end?
        let mut scan = Mp4Normaliser::new();
        let mut scratch = Vec::new();
        let mut scan_failed = false;
        feed(&mut |chunk| {
            if scan_failed {
                return Ok(());
            }
            scratch.clear();
            // A stream that stops making sense ends the scan where it stood.
            if scan.push(chunk, &mut scratch).is_err() {
                scan_failed = true;
            }
            Ok(())
        })?;
        let complete_end = scan.complete_end();
        if scan.index().is_empty() || complete_end == 0 {
            remove_recording_files(&self.root, &journal, true);
            return Ok(None);
        }
        // Recovery writes the recording again, so it needs about its size in room
        // besides the reserve: without it the journal stays, nothing is lost, and
        // the patient is told to make room.
        if let Some(free) = self.free_space_now() {
            let size = fs::metadata(&old_path).map_or(0, |m| m.len());
            if free < size.saturating_add(STOP_FREE) {
                return Err(VaultError::NoSpace);
            }
        }
        // Pass 2: copy up to that point into a new object under a new key.
        let mut new_key = Zeroizing::new([0_u8; 32]);
        OsRng.fill_bytes(new_key.as_mut());
        let new_name = format!("{}.mcobj", Uuid::new_v4());
        let new_path = dir.join(&new_name);
        // The journal names the copy before it exists.
        let mut copying = journal.clone();
        copying.copying = vec![new_name.clone()];
        write_journal(&self.root, &journal_key_value, vault_id, &copying)?;
        let mut appender = ObjectAppender::create(
            &new_path,
            ObjectContext {
                vault_id,
                record_id: id,
                profile_id: journal.profile_id,
            },
            &new_key,
            &fingerprint,
        )?;
        let mut copy = Mp4Normaliser::new();
        let mut remaining = complete_end;
        let mut out = Vec::new();
        let outcome = feed(&mut |chunk| {
            if remaining == 0 {
                return Ok(());
            }
            out.clear();
            copy.push(chunk, &mut out)
                .map_err(|_| VaultError::Corrupt)?;
            let take = (out.len() as u64).min(remaining) as usize;
            appender.write(&out[..take])?;
            remaining -= take as u64;
            Ok(())
        });
        // Any failure from here to the commit takes the copy away and puts the
        // journal back as it was, so the old object is still what it names and
        // the next attempt starts clean.
        let copy_name = new_name.clone();
        let abandon = |error: VaultError| {
            let _ = remove_owned_file(&new_path, Removable::Recording);
            // The copy may have been published (or swept aside) before the commit
            // failed: remove it there too, unless the manifest names it.
            if !self.manifest_names_object(&copy_name) {
                for place in ["objects", "quarantine"] {
                    let _ = remove_owned_file(
                        self.root.join(place).join(&copy_name),
                        Removable::Recording,
                    );
                }
            }
            let _ = write_journal(&self.root, &journal_key_value, vault_id, &journal);
            error
        };
        if let Err(error) = outcome {
            drop(appender);
            return Err(abandon(error));
        }
        let finished = (|| {
            let init = copy.init().cloned().ok_or(VaultError::Corrupt)?;
            let entries = copy.index();
            let trailer =
                mp4_stream::index_trailer(&init, &entries).map_err(|_| VaultError::Corrupt)?;
            appender.write(&trailer)?;
            appender.finish()
        })();
        let encrypted = match finished {
            Ok(encrypted) => encrypted,
            Err(error) => return Err(abandon(error)),
        };
        terminate_at_test_boundary("recording.recovery-after-copy");
        let mut renewed = journal.clone();
        renewed.superseded.push(journal.object_name.clone());
        renewed.object_name = new_name;
        renewed.copying = Vec::new();
        renewed.wrapped_object_key = match wrap_secret(&object_wrap, &new_key, id.as_bytes()) {
            Ok(wrapped) => wrapped,
            Err(error) => return Err(abandon(error)),
        };
        let record = self.commit_recording(
            vault_id,
            FinishedRecording {
                journal: &renewed,
                journal_key: &journal_key_value,
                object_path: &new_path,
                object_key: &new_key,
                encrypted,
            },
            now_ms,
        );
        match record {
            Ok(record_id) => {
                // The old object, its tail and the journal are no longer needed.
                let mut spent = journal.clone();
                spent.superseded.push(journal.object_name.clone());
                spent.object_name = renewed.object_name.clone();
                remove_recording_files(&self.root, &spent, false);
                Ok(Some(record_id))
            }
            // Not committed: the copy goes, and the journal names the old object again
            // (it may have been rewritten as `committing` for the copy).
            Err(error) => Err(abandon(error)),
        }
    }

    /// Verifies a finished object, publishes it into `objects/` and commits the
    /// record, as an import does. The long verification runs without the session
    /// lock; if the vault locked meanwhile, nothing is committed and the journal
    /// stays for the next unlock.
    fn commit_recording(
        &self,
        vault_id: Uuid,
        finished: FinishedRecording<'_>,
        now_ms: u64,
    ) -> Result<Uuid, VaultError> {
        let FinishedRecording {
            journal,
            journal_key,
            object_path,
            object_key,
            encrypted,
        } = finished;
        let record_id = journal.record_id;
        // `vault_id` is the one the recording was made under, not whatever vault
        // is open now: the check below refuses to commit into another.
        // Verified: every frame authenticates and the size is the one written.
        let mut counted = CountingSink(0);
        verify_object(
            object_path,
            &mut counted,
            vault_id,
            record_id,
            object_key,
            encrypted.plaintext_size,
        )?;
        if counted.0 != encrypted.plaintext_size {
            return Err(VaultError::Corrupt);
        }
        // Say what is about to happen, so that a crash from here is recovered.
        let mut committing = journal.clone();
        committing.state = JournalState::Committing;
        write_journal(&self.root, journal_key, vault_id, &committing)?;
        let objects = self.root.join("objects");
        publish_object(object_path, &objects.join(&journal.object_name))?;
        terminate_at_test_boundary("recording.after-publish");
        let result = (|| {
            // A failure here is a failed commit like any other: the copy is taken
            // back out of `objects/` below.
            fail_at_test_boundary("recording.sync-after-publish")?;
            sync_dir(&objects)?;
            let mut guard = self.session();
            let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
            if unlocked.manifest.vault_id != vault_id {
                return Err(VaultError::Locked);
            }
            if unlocked.recovery.is_some() {
                return Err(VaultError::RecoveryMode);
            }
            require_profile(&unlocked.manifest, journal.profile_id)?;
            fail_at_test_boundary("recording.before-commit")?;
            let folders: Vec<Uuid> = journal
                .folder_ids
                .iter()
                .copied()
                // A folder that is gone, or is out of reach by now (hidden after the recording
                // began, #574), is dropped: the recording is filed with the rest, never silently
                // into a place the patient who just made it cannot see.
                .filter(|id| unlocked.manifest.folder_in_reach(*id))
                .collect();
            let record = StoredRecord {
                id: record_id,
                profile_id: journal.profile_id,
                folder_ids: folders,
                display_name: journal.display_name.clone(),
                source_label: MANUAL_IMPORT_LABEL.to_owned(),
                media_type: "application/octet-stream".to_owned(),
                plaintext_size: encrypted.plaintext_size,
                imported_at_ms: now_ms,
                object_name: journal.object_name.clone(),
                fingerprint: BASE64.encode(encrypted.fingerprint),
                wrapped_object_key: journal.wrapped_object_key.clone(),
                hidden: None,
                original_pdf: None,
                delivery: None,
                reading_aid: None,
                ai_results: Vec::new(),
                carried: None,
            };
            let mut next = unlocked.manifest.clone();
            next.records.push(record.clone());
            let mut entry = record_entry(HistoryEvent::Imported, now_ms, &record);
            entry.how = Some(RECORDING_HOW.to_owned());
            let redundant = commit_with_history(
                &self.root,
                &unlocked.master_key,
                &mut unlocked.manifest,
                next,
                vec![entry],
            )?;
            unlocked.recovery = (!redundant).then_some(RecoveryReason::WriteFailed);
            Ok(record_id)
        })();
        match result {
            Ok(record_id) => {
                terminate_at_test_boundary("recording.after-commit");
                let dir = recordings_dir(&self.root);
                let _ =
                    remove_owned_file(dir.join(format!("{record_id}.tail")), Removable::Recording);
                let _ =
                    remove_owned_file(journal_path(&self.root, record_id), Removable::Recording);
                sync_parent(&dir);
                Ok(record_id)
            }
            Err(error) => {
                // Not committed: take the object back out of `objects/`, so that no
                // sweep has anything to move, and keep the journal. The object is
                // published by rename, so the finished file is put back; if that
                // fails the copy is removed (it is ciphertext, and the recording's
                // own object is still there to recover from). Never touched if the
                // manifest names it, or if that cannot be told.
                if !self.manifest_names_object(&journal.object_name) {
                    let published = objects.join(&journal.object_name);
                    if publish_object(&published, object_path).is_err() {
                        let _ = remove_owned_file(published, Removable::Recording);
                    }
                    sync_parent(&objects);
                }
                Err(error)
            }
        }
    }

    /// Whether the open manifest names `object_name`. True when there is no open
    /// session, so that nothing is removed on a guess.
    fn manifest_names_object(&self, object_name: &str) -> bool {
        let guard = self.session();
        guard.as_ref().is_none_or(|unlocked| {
            unlocked
                .manifest
                .records
                .iter()
                .any(|record| record.object_name == object_name)
        })
    }

    /// The records that were added as a video, from the history: the Imported
    /// events whose way is `camera` (myCarlos's own recording, and its photos,
    /// which are JPEGs) or `pickedVideo` (a video the patient picked, which
    /// passed the structure check when it was added). This is the origin of a
    /// video, and nothing is called a video because of what its bytes look like (an iPhone's HEIC photo, an M4A voice memo, a camera raw file and
    /// even a PDF can carry `ftyp` where an MP4 does). A record whose history
    /// piece is damaged is not named here: it is then not offered as a video
    /// and not left out of a backup, which keeps it.
    ///
    /// The answer is kept for as long as the history is the same one (its
    /// length and its head, which change with every event), so that opening a
    /// document's details does not read the whole history each time. It is not
    /// kept when part of the history could not be read, so that a piece that
    /// comes back is read.
    pub(super) fn camera_made_records(
        &self,
        unlocked: &UnlockedVault,
    ) -> Result<Arc<VideoOrigins>, VaultError> {
        let history = &unlocked.manifest.history;
        let key = (
            unlocked.manifest.vault_id,
            history.count,
            history.head.clone(),
        );
        if let Some((kept, found)) = self
            .camera_made
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            if *kept == key {
                return Ok(Arc::clone(found));
            }
        }
        let view = self.history_view_in_session(unlocked)?;
        let mut origins = VideoOrigins::default();
        for entry in view.entries.iter().chain(view.later.iter()) {
            if entry.event != HistoryEvent::Imported {
                continue;
            }
            let Some(id) = entry.record_id else { continue };
            match entry.how.as_deref() {
                Some(RECORDING_HOW) => {
                    origins.any.insert(id);
                }
                Some(super::picked_video::PICKED_VIDEO_HOW) => {
                    origins.any.insert(id);
                    origins.picked.insert(id);
                }
                _ => {}
            }
        }
        origins.complete = view.complete;
        let found = Arc::new(origins);
        *self
            .camera_made
            .lock()
            .unwrap_or_else(PoisonError::into_inner) =
            view.complete.then(|| (key, Arc::clone(&found)));
        Ok(found)
    }

    /// Whether the history says the record was added with the camera, and its
    /// file is there to be read (`NotFound` for a record the vault does not
    /// have). A video restored from a backup that left its file out is still
    /// marked as lacking it and is not a video to play: that is `false`, not an
    /// error, so its details show nothing wrong.
    pub fn added_with_camera(&self, record_id: Uuid) -> Result<bool, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        // A hidden person's record is not there to ask about (#360).
        let record = unlocked
            .manifest
            .records
            .iter()
            .find(|record| record.id == record_id && unlocked.manifest.record_in_reach(record))
            .ok_or(VaultError::NotFound)?;
        if !object_required(record)
            && object_presence_name(&self.root, &record.object_name) != ObjectPresence::Present
        {
            return Ok(false);
        }
        Ok(self.camera_made_records(unlocked)?.contains(&record_id))
    }

    /// How much room the vault's volume has, and whether that is enough to
    /// record: asked before the camera and microphone are turned on, and again
    /// on every resume. Only of a vault that is open and writable, as recording
    /// is.
    pub fn recording_space(&self) -> Result<RecordingSpace, VaultError> {
        self.require_writable_session()?;
        Ok(self.space_now())
    }

    /// As `recording_space`, for a caller that already holds the session.
    fn space_now(&self) -> RecordingSpace {
        let free = self.free_space_now();
        RecordingSpace {
            free_bytes: free,
            level: space_level(free),
            can_record: free.is_none_or(|free| free >= MIN_FREE_TO_RECORD),
        }
    }

    pub(super) fn free_space_now(&self) -> Option<u64> {
        let probe = self
            .free_space
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        probe(&self.root)
    }

    fn require_writable_session(&self) -> Result<(), VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        Ok(())
    }
}

fn progress_of(recording: &ActiveRecording) -> RecordingProgress {
    let normaliser = &recording.normaliser;
    RecordingProgress {
        stored_bytes: normaliser.written(),
        fragments: normaliser.index().len(),
        has_video: normaliser.init().map(InitInfo::has_video),
        has_audio: normaliser.init().map(InitInfo::has_audio),
        next_sequence: recording.next_sequence,
        space: recording.space,
        free_bytes: recording.free_bytes,
    }
}

/// Removes what an unfinished recording left: its tail, the objects it replaced
/// (in `recordings/`, `objects/` and `quarantine/`, wherever an interrupted
/// commit or a sweep put them), the journal, and, when `own_object` is set, the
/// recording's own object too (never when it has been committed: it is then the
/// video).
fn remove_recording_files(root: &Path, journal: &Journal, own_object: bool) {
    let dir = recordings_dir(root);
    let mut names: Vec<&String> = journal.superseded.iter().collect();
    if own_object {
        names.push(&journal.object_name);
    }
    for name in names {
        for place in [dir.clone(), root.join("objects"), root.join("quarantine")] {
            let _ = remove_owned_file(place.join(name), Removable::Recording);
        }
    }
    for name in &journal.copying {
        let _ = remove_owned_file(dir.join(name), Removable::Recording);
    }
    let _ = remove_owned_file(
        dir.join(format!("{}.tail", journal.record_id)),
        Removable::Recording,
    );
    let _ = remove_owned_file(journal_path(root, journal.record_id), Removable::Recording);
    sync_parent(&dir);
}

/// Where an unfinished recording's object is: in `recordings/`, or, after a
/// crash between publishing and committing, in `objects/` or (once an unlock's
/// sweep has moved it aside) `quarantine/`.
fn find_object(root: &Path, name: &str) -> Option<PathBuf> {
    [
        recordings_dir(root).join(name),
        root.join("objects").join(name),
        root.join("quarantine").join(name),
    ]
    .into_iter()
    .find(|path| fs::symlink_metadata(path).is_ok_and(|m| m.is_file()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mp4_stream::fake::{fragment, ftyp, moov};
    use crate::mp4_stream::{
        build_virtual_head, parse_index_trailer, trailer_length, Mp4Normaliser, ParsedIndex,
        INDEX_FOOTER_LEN,
    };
    use std::process::{Command, Stdio};

    const PASSWORD: &str = "river-azimuth-cobalt-sparrow-934";

    fn new_store(root: &Path) -> (VaultStore, Uuid) {
        let store = VaultStore::new(root.join("vault"));
        store.create(PASSWORD, "FAKE Person", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        (store, profile)
    }

    /// A FAKE movie: the init, then `count` one-second fragments of `payload`
    /// bytes each, starting after `skip` seconds of the clock.
    fn movie_from(skip: u64, count: u64, payload: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        for n in skip..skip + count {
            bytes.extend(fragment(n as u32 + 1, n * 30000, n * 48128, payload));
        }
        bytes
    }

    fn movie(count: u64, payload: usize) -> Vec<u8> {
        [ftyp(), moov(), movie_from(0, count, payload)].concat()
    }

    fn feed(store: &VaultStore, id: Uuid, bytes: &[u8], piece: usize) {
        for part in bytes.chunks(piece) {
            store.recording_append(id, part).unwrap();
        }
    }

    fn stored(store: &VaultStore, record: Uuid) -> Vec<u8> {
        let mut bytes = Vec::new();
        store.read_for_view(record, &mut bytes).unwrap();
        bytes
    }

    /// The trailing index of a stored video.
    fn index_of(stored: &[u8]) -> ParsedIndex {
        let length = trailer_length(&stored[stored.len() - INDEX_FOOTER_LEN..]).unwrap();
        parse_index_trailer(&stored[stored.len() - length..]).unwrap()
    }

    fn recordings_files(root: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(recordings_dir(&root.join("vault")))
            .map(|entries| {
                entries
                    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn reopen(root: &Path) -> VaultStore {
        let store = VaultStore::new(root.join("vault"));
        store.unlock(PASSWORD).unwrap();
        store
    }

    #[test]
    fn a_recording_is_stored_in_chunks_with_its_index_and_nothing_is_left_behind() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let clip = movie(4, 700_000); // about 2.8 MiB: three frames
        let id = store
            .recording_start(profile, vec![], "FAKE clip.mp4", 5)
            .unwrap();
        // The journal and the growing object are there, encrypted, before the end.
        let files = recordings_files(temp.path());
        assert_eq!(files.len(), 2, "{files:?}");
        let progress = {
            feed(&store, id, &clip, 300_000);
            store.recording_append(id, &[]).unwrap()
        };
        assert_eq!(progress.fragments, 4);
        assert_eq!(progress.has_video, Some(true));
        assert_eq!(progress.has_audio, Some(true));
        let record = store.recording_stop(id, 6).unwrap().unwrap();
        assert_eq!(record, id);
        let plain = stored(&store, record);
        assert_eq!(&plain[..clip.len()], &clip[..]);
        let index = index_of(&plain);
        assert_eq!(index.entries.len(), 4);
        assert_eq!(index.entries[0].start, 0);
        assert_eq!(index.entries[3].start, 90000);
        // The library has it, with the name and size it should have.
        let snapshot = store.snapshot().unwrap();
        let entry = snapshot.records.iter().find(|r| r.id == record).unwrap();
        assert_eq!(entry.display_name, "FAKE clip.mp4");
        assert_eq!(entry.plaintext_size, plain.len() as u64);
        // And the synthetic head the playback address serves builds from it.
        let head = build_virtual_head(&plain, &index).unwrap();
        assert_eq!(head.media_end, clip.len() as u64);
        // Nothing readable on disk, and no recording files left.
        assert!(recordings_files(temp.path()).is_empty());
        let object = fs::read_dir(temp.path().join("vault").join("objects"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| fs::metadata(p).unwrap().len() > 2_000_000)
            .unwrap();
        let raw = fs::read(object).unwrap();
        assert!(!raw.windows(8).any(|w| w == b"ftypisom"));
        // Every frame but the last is exactly one chunk.
        let mut at = 25;
        let mut frames = Vec::new();
        while at < raw.len() {
            let length = u32::from_be_bytes(raw[at..at + 4].try_into().unwrap()) as usize;
            frames.push((raw[at + 4], length));
            at += 5 + length;
        }
        assert_eq!(at, raw.len());
        let (last, others) = frames.split_last().unwrap();
        assert!(
            others.iter().all(|f| *f == (0, CHUNK_SIZE + 16)),
            "{frames:?}"
        );
        assert_eq!(last.0, 1);
    }

    #[test]
    fn a_recording_with_nothing_complete_adds_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE empty.mp4", 5)
            .unwrap();
        store
            .recording_append(id, &[ftyp(), moov()].concat())
            .unwrap();
        assert_eq!(store.recording_stop(id, 6).unwrap(), None);
        assert!(store.snapshot().unwrap().records.is_empty());
        assert!(recordings_files(temp.path()).is_empty());
    }

    #[test]
    fn a_pause_seals_a_tail_and_a_resume_closes_the_gap() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE paused.mp4", 5)
            .unwrap();
        feed(
            &store,
            id,
            &[ftyp(), moov(), movie_from(0, 2, 4000)].concat(),
            1000,
        );
        store.recording_pause(id).unwrap();
        let files = recordings_files(temp.path());
        assert!(files.iter().any(|f| f.ends_with(".tail")), "{files:?}");
        store.recording_resume(id).unwrap();
        assert!(!recordings_files(temp.path())
            .iter()
            .any(|f| f.ends_with(".tail")));
        // The webview wrote the next fragments 1.5 s late.
        let late: Vec<u8> = (2..4)
            .flat_map(|n: u64| fragment(n as u32 + 1, n * 30000 + 45000, n * 48128 + 72000, 4000))
            .collect();
        feed(&store, id, &late, 700);
        let record = store.recording_stop(id, 6).unwrap().unwrap();
        let plain = stored(&store, record);
        let expected = [ftyp(), moov(), movie_from(0, 4, 4000)].concat();
        assert_eq!(&plain[..expected.len()], &expected[..]);
        let index = index_of(&plain);
        assert_eq!(
            index.entries.iter().map(|e| e.start).collect::<Vec<_>>(),
            vec![0, 30000, 60000, 90000]
        );
    }

    #[test]
    fn a_lock_parks_a_recording_and_the_next_unlock_recovers_what_was_complete() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE parked.mp4", 5)
            .unwrap();
        let whole = movie(3, 6000);
        let cut = whole.len() - 3000; // the third fragment is not whole
        feed(&store, id, &whole[..cut], 2500);
        store.lock();
        // Locked: nothing more goes in, and nothing was added to the library.
        assert!(matches!(
            store.recording_append(id, &[1]),
            Err(VaultError::Locked)
        ));
        let files = recordings_files(temp.path());
        assert_eq!(files.len(), 2, "{files:?}");
        let store = reopen(temp.path());
        // Unlock's cleanup leaves the recording alone.
        assert_eq!(recordings_files(temp.path()), files);
        assert!(store.snapshot().unwrap().records.is_empty());
        let pending = store.recordings_pending().unwrap();
        assert_eq!(pending.unreadable, 0);
        assert_eq!(pending.recordings.len(), 1);
        assert!(pending.recordings[0].parked);
        // Parked by a lock, not ended by the patient.
        assert!(!pending.recordings[0].stopped);
        assert_eq!(pending.recordings[0].display_name, "FAKE parked.mp4");
        let record = store.recording_recover(id, true, 9).unwrap().unwrap();
        // A recording finished by recovery has the origin of one finished at once.
        assert!(store.added_with_camera(record).unwrap());
        assert!(matches!(
            store.added_with_camera(Uuid::new_v4()),
            Err(VaultError::NotFound)
        ));
        let plain = stored(&store, record);
        let index = index_of(&plain);
        assert_eq!(index.entries.len(), 2);
        let complete = [ftyp(), moov(), movie_from(0, 2, 6000)].concat();
        assert_eq!(&plain[..complete.len()], &complete[..]);
        assert!(recordings_files(temp.path()).is_empty());
        assert!(store.recordings_pending().unwrap().recordings.is_empty());
        // The old object is gone, so the video is the only one.
        assert!(!fs::read_dir(temp.path().join("vault").join("quarantine"))
            .map(|mut e| e.next().is_some())
            .unwrap_or(false));
    }

    #[test]
    fn a_crash_loses_only_the_frame_in_memory_and_recovery_keeps_the_rest() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE crash.mp4", 5)
            .unwrap();
        feed(&store, id, &movie(4, 700_000), 250_000);
        // A crash: the store goes away without parking anything.
        drop(store);
        let store = reopen(temp.path());
        let pending = store.recordings_pending().unwrap();
        assert_eq!(pending.recordings.len(), 1);
        assert!(!pending.recordings[0].parked);
        let record = store.recording_recover(id, true, 9).unwrap().unwrap();
        let plain = stored(&store, record);
        let index = index_of(&plain);
        // Two 1 MiB frames were sealed: the init and two whole fragments fit in
        // them (the third ends after 2 MiB and was in memory).
        assert_eq!(index.entries.len(), 2);
        let complete = [ftyp(), moov(), movie_from(0, 2, 700_000)].concat();
        assert_eq!(&plain[..complete.len()], &complete[..]);
    }

    #[test]
    fn a_torn_last_frame_is_dropped_not_trusted() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE torn.mp4", 5)
            .unwrap();
        feed(&store, id, &movie(4, 700_000), 250_000);
        let object = {
            let map = store.recordings.lock().unwrap();
            map[&id].object_path.clone()
        };
        drop(store);
        // Cut the file in the middle of its second frame.
        let length = fs::metadata(&object).unwrap().len();
        let file = OpenOptions::new().write(true).open(&object).unwrap();
        file.set_len(length - 500_000).unwrap();
        drop(file);
        let store = reopen(temp.path());
        let record = store.recording_recover(id, true, 9).unwrap().unwrap();
        let plain = stored(&store, record);
        // One whole frame (1 MiB) survived: the init and the first fragment.
        assert_eq!(index_of(&plain).entries.len(), 1);
    }

    #[test]
    fn a_crash_while_paused_loses_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE paused-crash.mp4", 5)
            .unwrap();
        let clip = movie(3, 5000); // far under one frame: only memory holds it
        feed(&store, id, &clip, 1500);
        store.recording_pause(id).unwrap();
        drop(store);
        let store = reopen(temp.path());
        let pending = store.recordings_pending().unwrap();
        assert!(pending.recordings[0].paused);
        let record = store.recording_recover(id, true, 9).unwrap().unwrap();
        let plain = stored(&store, record);
        assert_eq!(&plain[..clip.len()], &clip[..]);
        assert_eq!(index_of(&plain).entries.len(), 3);
    }

    #[test]
    fn a_crash_before_anything_was_sealed_leaves_nothing_to_keep() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE lost.mp4", 5)
            .unwrap();
        feed(&store, id, &movie(3, 5000), 1500);
        drop(store);
        let store = reopen(temp.path());
        assert_eq!(store.recording_recover(id, true, 9).unwrap(), None);
        assert!(store.snapshot().unwrap().records.is_empty());
        assert!(recordings_files(temp.path()).is_empty());
    }

    #[test]
    fn declining_deletes_the_recording() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE declined.mp4", 5)
            .unwrap();
        feed(&store, id, &movie(4, 700_000), 250_000);
        store.lock();
        let store = reopen(temp.path());
        assert_eq!(store.recording_recover(id, false, 9).unwrap(), None);
        assert!(recordings_files(temp.path()).is_empty());
        assert!(store.snapshot().unwrap().records.is_empty());
        assert!(store.recordings_pending().unwrap().recordings.is_empty());
    }

    #[test]
    fn a_damaged_journal_is_counted_and_refused_not_guessed() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE damaged.mp4", 5)
            .unwrap();
        feed(&store, id, &movie(2, 5000), 4000);
        store.lock();
        let path = journal_path(&temp.path().join("vault"), id);
        let mut bytes = fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        fs::write(&path, bytes).unwrap();
        let store = reopen(temp.path());
        let pending = store.recordings_pending().unwrap();
        assert!(pending.recordings.is_empty());
        assert_eq!(pending.unreadable, 1);
        assert!(matches!(
            store.recording_recover(id, true, 9),
            Err(VaultError::Corrupt)
        ));
        // Nothing was deleted by the refusal.
        assert!(path.exists());
    }

    #[test]
    fn a_damaged_frame_in_a_whole_object_is_damage_not_a_crash() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE bitflip.mp4", 5)
            .unwrap();
        feed(&store, id, &movie(4, 700_000), 250_000);
        store.lock();
        let object = fs::read_dir(recordings_dir(&temp.path().join("vault")))
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.extension().is_some_and(|e| e == "mcobj"))
            .unwrap();
        let mut bytes = fs::read(&object).unwrap();
        bytes[1000] ^= 1;
        fs::write(&object, bytes).unwrap();
        let store = reopen(temp.path());
        assert!(matches!(
            store.recording_recover(id, true, 9),
            Err(VaultError::Corrupt)
        ));
        assert!(store.snapshot().unwrap().records.is_empty());
    }

    #[test]
    fn a_refused_piece_ends_the_recording_with_what_was_complete() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE poisoned.mp4", 5)
            .unwrap();
        feed(&store, id, &movie(3, 9000), 5000);
        assert!(matches!(
            store.recording_append(id, &[0, 0, 0, 2, b'x', b'x', b'x', b'x']),
            Err(VaultError::Invalid)
        ));
        assert!(matches!(
            store.recording_append(id, &[1, 2, 3]),
            Err(VaultError::Invalid)
        ));
        // Too large a piece is refused before it is looked at.
        assert!(matches!(
            store.recording_append(id, &vec![0; MAX_RECORDING_PIECE + 1]),
            Err(VaultError::Invalid)
        ));
        let record = store.recording_stop(id, 6).unwrap().unwrap();
        assert_eq!(index_of(&stored(&store, record)).entries.len(), 3);
    }

    #[test]
    fn a_recording_needs_an_open_writable_vault_and_a_real_person_and_folder() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        assert!(matches!(
            store.recording_start(Uuid::new_v4(), vec![], "FAKE x.mp4", 5),
            Err(VaultError::NotFound)
        ));
        assert!(store
            .recording_start(profile, vec![Uuid::new_v4()], "FAKE x.mp4", 5)
            .is_err());
        assert!(matches!(
            store.recording_append(Uuid::new_v4(), &[1]),
            Err(VaultError::NotFound)
        ));
        assert!(matches!(
            store.recording_stop(Uuid::new_v4(), 6),
            Err(VaultError::NotFound)
        ));
        store.lock();
        assert!(matches!(
            store.recording_start(profile, vec![], "FAKE x.mp4", 5),
            Err(VaultError::Locked)
        ));
    }

    #[test]
    fn the_names_are_cleaned_like_any_import() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "../FAKE/../clip.mp4", 5)
            .unwrap();
        feed(&store, id, &movie(1, 100), 100);
        let record = store.recording_stop(id, 6).unwrap().unwrap();
        let snapshot = store.snapshot().unwrap();
        let name = &snapshot
            .records
            .iter()
            .find(|r| r.id == record)
            .unwrap()
            .display_name;
        assert!(!name.contains('/') && !name.contains(".."), "{name}");
    }

    #[test]
    fn what_recovery_finds_is_a_video_the_same_scan_sees_whole() {
        // The scan recovery runs and a fresh normaliser agree on what a stored
        // video holds, so that opening it later finds the same index.
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE scan.mp4", 5)
            .unwrap();
        feed(&store, id, &movie(3, 8000), 3000);
        let record = store.recording_stop(id, 6).unwrap().unwrap();
        let plain = stored(&store, record);
        let mut again = Mp4Normaliser::new();
        let mut out = Vec::new();
        again.push(&plain, &mut out).unwrap();
        // The index box and its footer are skipped as unknown boxes.
        assert_eq!(again.index(), index_of(&plain).entries);
        assert_eq!(
            again.complete_end(),
            (plain.len() - trailer_length(&plain[plain.len() - 12..]).unwrap()) as u64
        );
    }

    // ---- a failing disk, a failed commit, and keys that must not outlive the vault

    fn frame_len() -> u64 {
        5 + CHUNK_SIZE as u64 + 16
    }

    fn the_object_of(store: &VaultStore, id: Uuid) -> PathBuf {
        store.recordings.lock().unwrap()[&id].object_path.clone()
    }

    #[test]
    fn a_write_that_fails_ends_the_recording_without_sealing_a_frame_twice() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE full.mp4", 5)
            .unwrap();
        let clip = movie(6, 700_000);
        // About 1.3 MiB gets in: one whole frame is sealed.
        feed(&store, id, &clip[..1_400_000], 250_000);
        let object = the_object_of(&store, id);
        assert_eq!(fs::metadata(&object).unwrap().len(), 25 + frame_len());
        // The disk is full for the next frame.
        FAIL_AT_TEST_BOUNDARY.set(&["recording.chunk-write"]);
        let mut failed = None;
        for part in clip[1_400_000..].chunks(250_000) {
            if let Err(error) = store.recording_append(id, part) {
                failed = Some(error);
                break;
            }
        }
        FAIL_AT_TEST_BOUNDARY.set(&[]);
        assert!(matches!(failed, Some(VaultError::NoSpace)), "{failed:?}");
        // The object ends at the last whole frame, not in the middle of one.
        assert_eq!(fs::metadata(&object).unwrap().len(), 25 + frame_len());
        // The appender is dead and the recording takes nothing more, even once
        // the disk has room again: the same frame is never sealed a second time.
        assert!(matches!(
            store.recording_append(id, &clip[..1000]),
            Err(VaultError::Invalid)
        ));
        assert_eq!(fs::metadata(&object).unwrap().len(), 25 + frame_len());
        // Stopping keeps what was written: the first frame holds the init and one
        // whole fragment.
        let record = store.recording_stop(id, 6).unwrap().unwrap();
        assert_eq!(index_of(&stored(&store, record)).entries.len(), 1);
        assert!(recordings_files(temp.path()).is_empty());
    }

    #[test]
    fn a_frame_that_failed_after_it_was_written_is_not_sealed_again_either() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE sync.mp4", 5)
            .unwrap();
        let clip = movie(6, 700_000);
        FAIL_AT_TEST_BOUNDARY.set(&["recording.after-chunk-write"]);
        let mut failed = false;
        for part in clip.chunks(250_000) {
            if store.recording_append(id, part).is_err() {
                failed = true;
                break;
            }
        }
        FAIL_AT_TEST_BOUNDARY.set(&[]);
        assert!(failed);
        let object = the_object_of(&store, id);
        assert_eq!(fs::metadata(&object).unwrap().len(), 25 + frame_len());
        assert!(store.recording_append(id, &clip[..10]).is_err());
        assert_eq!(fs::metadata(&object).unwrap().len(), 25 + frame_len());
        // Parking and stopping do not seal a final frame over the failed one.
        let record = store.recording_stop(id, 6).unwrap().unwrap();
        assert_eq!(index_of(&stored(&store, record)).entries.len(), 1);
    }

    #[test]
    fn a_recovery_whose_commit_fails_can_be_tried_again() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE retry.mp4", 5)
            .unwrap();
        feed(&store, id, &movie(4, 700_000), 250_000);
        drop(store); // a crash
        let store = reopen(temp.path());
        FAIL_AT_TEST_BOUNDARY.set(&["recording.before-commit"]);
        let failed = store.recording_recover(id, true, 9);
        FAIL_AT_TEST_BOUNDARY.set(&[]);
        assert!(matches!(failed, Err(VaultError::NoSpace)), "{failed:?}");
        assert!(store.snapshot().unwrap().records.is_empty());
        // Still there, still readable, and no copy of it left lying about.
        let pending = store.recordings_pending().unwrap();
        assert_eq!((pending.recordings.len(), pending.unreadable), (1, 0));
        let objects: Vec<_> = fs::read_dir(recordings_dir(&temp.path().join("vault")))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".mcobj"))
            .collect();
        assert_eq!(objects.len(), 1, "{objects:?}");
        let record = store.recording_recover(id, true, 10).unwrap().unwrap();
        assert_eq!(index_of(&stored(&store, record)).entries.len(), 2);
        assert!(recordings_files(temp.path()).is_empty());
        assert_eq!(store.snapshot().unwrap().records.len(), 1);
    }

    #[test]
    fn a_failed_commit_when_stopping_leaves_the_recording_to_be_recovered() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE stopfail.mp4", 5)
            .unwrap();
        feed(&store, id, &movie(3, 9000), 4000);
        FAIL_AT_TEST_BOUNDARY.set(&["recording.before-commit"]);
        let failed = store.recording_stop(id, 6);
        FAIL_AT_TEST_BOUNDARY.set(&[]);
        assert!(matches!(failed, Err(VaultError::NoSpace)));
        let record = store.recording_recover(id, true, 7).unwrap().unwrap();
        assert_eq!(index_of(&stored(&store, record)).entries.len(), 3);
        assert!(recordings_files(temp.path()).is_empty());
    }

    fn object_files(root: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(root.join("vault").join("objects"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_failure_after_publishing_takes_the_copy_back_out_of_objects() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let before = object_files(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE publish.mp4", 5)
            .unwrap();
        feed(&store, id, &movie(3, 9000), 4000);
        FAIL_AT_TEST_BOUNDARY.set(&["recording.sync-after-publish"]);
        let failed = store.recording_stop(id, 6);
        FAIL_AT_TEST_BOUNDARY.set(&[]);
        assert!(matches!(failed, Err(VaultError::NoSpace)), "{failed:?}");
        // Nothing of the recording is left in objects/, and it can still be recovered.
        assert_eq!(object_files(temp.path()), before);
        let record = store.recording_recover(id, true, 7).unwrap().unwrap();
        assert_eq!(index_of(&stored(&store, record)).entries.len(), 3);
        assert!(recordings_files(temp.path()).is_empty());
    }

    #[test]
    fn setting_the_vault_aside_parks_a_recording_and_drops_its_keys() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE reset.mp4", 5)
            .unwrap();
        feed(&store, id, &movie(2, 5000), 3000);
        store.reset().unwrap();
        // Nothing of it is held: no keys, and nothing can be written into the
        // vault that was set aside.
        assert!(store.recordings.lock().unwrap().is_empty());
        assert!(matches!(
            store.recording_append(id, &[1]),
            Err(VaultError::Locked | VaultError::NotFound)
        ));
        let aside = store.set_aside_folder().expect("a set-aside folder");
        let parked: Vec<_> = fs::read_dir(aside)
            .unwrap()
            .flat_map(|d| fs::read_dir(d.unwrap().path().join("recordings")))
            .flatten()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(parked.iter().any(|n| n.ends_with(".journal")), "{parked:?}");
    }

    #[test]
    fn a_poisoned_session_parks_the_recordings_with_it() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let store = Arc::new(store);
        let id = store
            .recording_start(profile, vec![], "FAKE poison.mp4", 5)
            .unwrap();
        feed(&store, id, &movie(2, 5000), 3000);
        let poisoner = Arc::clone(&store);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.unlocked.lock().unwrap();
            panic!("synthetic panic while holding the vault mutex");
        })
        .join();
        assert!(store.unlocked.is_poisoned());
        // Whichever method runs next drops the session, and the recording's keys
        // go with it.
        assert!(matches!(store.snapshot(), Err(VaultError::Locked)));
        assert!(store.recordings.lock().unwrap().is_empty());
        assert!(matches!(
            store.recording_append(id, &[1]),
            Err(VaultError::Locked | VaultError::NotFound)
        ));
        // And it was parked, so the next unlock finds it.
        let store = reopen(temp.path());
        let pending = store.recordings_pending().unwrap();
        assert_eq!(pending.recordings.len(), 1);
        assert!(pending.recordings[0].parked);
    }

    #[test]
    fn a_file_that_ends_in_zeros_or_a_zeroed_last_frame_is_a_torn_tail_not_damage() {
        for how in ["extended", "zeroed"] {
            let temp = tempfile::tempdir().unwrap();
            let (store, profile) = new_store(temp.path());
            let id = store
                .recording_start(profile, vec![], "FAKE zeros.mp4", 5)
                .unwrap();
            feed(&store, id, &movie(4, 700_000), 250_000);
            let object = the_object_of(&store, id);
            drop(store);
            let length = fs::metadata(&object).unwrap().len();
            let frames = (length - 25) / frame_len();
            assert_eq!(frames, 2, "{how}");
            let file = OpenOptions::new().write(true).open(&object).unwrap();
            if how == "extended" {
                // Blocks the file system extended the file by and never filled.
                file.set_len(length + 5000).unwrap();
            } else {
                // The last frame's blocks never reached the disk: right length,
                // all zeros after its header.
                use std::io::{Seek, SeekFrom};
                let mut file = file;
                file.seek(SeekFrom::Start(25 + frame_len() + 5)).unwrap();
                file.write_all(&vec![0; CHUNK_SIZE + 16]).unwrap();
            }
            let store = reopen(temp.path());
            let record = store.recording_recover(id, true, 9).unwrap().expect(how);
            let kept = if how == "extended" { 2 } else { 1 };
            assert_eq!(
                index_of(&stored(&store, record)).entries.len(),
                kept,
                "{how}"
            );
        }
    }

    #[test]
    fn a_damaged_frame_with_more_after_it_is_still_damage() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE middle.mp4", 5)
            .unwrap();
        feed(&store, id, &movie(4, 700_000), 250_000);
        let object = the_object_of(&store, id);
        drop(store);
        let mut bytes = fs::read(&object).unwrap();
        for byte in &mut bytes[30..40] {
            *byte ^= 0xFF;
        }
        fs::write(&object, bytes).unwrap();
        let store = reopen(temp.path());
        assert!(matches!(
            store.recording_recover(id, true, 9),
            Err(VaultError::Corrupt)
        ));
        assert!(store.snapshot().unwrap().records.is_empty());
    }

    // ---- an abrupt end at each step, in a child process ----------------------

    fn unlock_with_boundaries_held(store: &VaultStore) {
        ENV_BOUNDARIES_HELD.store(true, Ordering::Release);
        let unlocked = store.unlock(PASSWORD);
        ENV_BOUNDARIES_HELD.store(false, Ordering::Release);
        unlocked.unwrap();
    }

    #[test]
    #[ignore = "invoked as an abrupt-termination subprocess by the recording matrix"]
    fn recording_child() {
        let Ok(root) = std::env::var("MYCARLOS_TEST_ROOT") else {
            return;
        };
        let operation = std::env::var("MYCARLOS_TEST_OPERATION").unwrap();
        let store = VaultStore::new(PathBuf::from(root));
        unlock_with_boundaries_held(&store);
        if operation == "recover" {
            // An earlier child left a recording; this one recovers it and is
            // ended at the configured boundary inside the recovery.
            let pending = store.recordings_pending().unwrap();
            store
                .recording_recover(pending.recordings[0].id, true, 9)
                .unwrap();
            panic!("configured termination boundary was not reached");
        }
        let profile = store.snapshot().unwrap().profiles[0].id;
        let id = store
            .recording_start(profile, vec![], "FAKE child.mp4", 5)
            .unwrap();
        let clip = movie(4, 700_000);
        match operation.as_str() {
            "append" => feed(&store, id, &clip, 250_000),
            "pause" => {
                feed(&store, id, &clip[..400_000], 100_000);
                store.recording_pause(id).unwrap();
            }
            // Three whole small fragments, all still in memory.
            "pause-small" => {
                feed(&store, id, &movie(3, 5000), 1500);
                store.recording_pause(id).unwrap();
            }
            "lock" => {
                feed(&store, id, &movie(3, 5000), 1500);
                store.lock();
            }
            "stop" => {
                feed(&store, id, &clip, 250_000);
                store.recording_stop(id, 6).unwrap();
            }
            other => panic!("unknown operation {other}"),
        }
        panic!("configured termination boundary was not reached");
    }

    fn run_child(root: &Path, operation: &str, boundary: &str) {
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "vault::recording::tests::recording_child",
            ])
            .env("MYCARLOS_TEST_ROOT", root.join("vault"))
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

    /// After the abrupt end: unlock, find the recording, recover it, and check the
    /// result is a whole video (`Some(n)` fragments) or nothing (`None`), with no
    /// recording files left over.
    fn recovered_after(boundary: &str, operation: &str, expect: Option<usize>) {
        let temp = tempfile::tempdir().unwrap();
        let (store, _) = new_store(temp.path());
        drop(store);
        run_child(temp.path(), operation, boundary);
        let store = reopen(temp.path());
        let pending = store.recordings_pending().unwrap();
        assert_eq!(pending.unreadable, 0, "{boundary}");
        assert_eq!(pending.recordings.len(), 1, "{boundary}");
        let id = pending.recordings[0].id;
        let recovered = store.recording_recover(id, true, 9).unwrap();
        match expect {
            Some(fragments) => {
                let record = recovered.expect(boundary);
                let plain = stored(&store, record);
                assert_eq!(index_of(&plain).entries.len(), fragments, "{boundary}");
                assert_eq!(store.snapshot().unwrap().records.len(), 1, "{boundary}");
            }
            None => {
                assert_eq!(recovered, None, "{boundary}");
                assert!(store.snapshot().unwrap().records.is_empty(), "{boundary}");
            }
        }
        assert!(recordings_files(temp.path()).is_empty(), "{boundary}");
        assert!(store.recordings_pending().unwrap().recordings.is_empty());
        // Whatever was published and left unreferenced was moved aside, not kept
        // as a second video: only the recovered one is in the library.
        let snapshot = store.snapshot().unwrap();
        assert_eq!(
            snapshot.records.len(),
            usize::from(expect.is_some()),
            "{boundary}"
        );
    }

    #[test]
    fn an_abrupt_end_after_the_first_sealed_frame_keeps_the_first_fragment() {
        recovered_after("recording.after-chunk-write", "append", Some(1));
    }

    #[test]
    fn an_abrupt_end_right_after_the_journal_leaves_nothing_to_keep() {
        recovered_after("recording.after-journal", "append", None);
    }

    #[test]
    fn an_abrupt_end_after_a_pause_sealed_its_tail_keeps_everything_before_it() {
        // 400 KB: the init and the first fragment's start, far under one frame;
        // the pause's tail holds them, but no fragment is complete.
        recovered_after("recording.after-pause-tail", "pause", None);
    }

    #[test]
    fn the_tail_is_what_keeps_a_recording_that_never_filled_a_frame() {
        // Three whole fragments in memory only. The end comes after the tail is
        // written and before the journal says paused, so the journal still says
        // recording: only the tail (found by its name) holds them.
        recovered_after("recording.after-pause-tail", "pause-small", Some(3));
    }

    #[test]
    fn an_abrupt_end_after_a_lock_parked_the_recording_keeps_it() {
        recovered_after("recording.after-park", "lock", Some(3));
    }

    /// A crashed recording, then a recovery that is itself ended at `boundary`,
    /// then a recovery that must still make the video, leaving nothing behind.
    fn recovered_after_a_recovery_ended_at(boundary: &str, expect: usize) {
        let temp = tempfile::tempdir().unwrap();
        let (store, _) = new_store(temp.path());
        drop(store);
        run_child(temp.path(), "append", "recording.after-chunk-write");
        run_child(temp.path(), "recover", boundary);
        let store = reopen(temp.path());
        let pending = store.recordings_pending().unwrap();
        assert_eq!(pending.unreadable, 0, "{boundary}");
        assert_eq!(pending.recordings.len(), 1, "{boundary}");
        let id = pending.recordings[0].id;
        let record = store
            .recording_recover(id, true, 10)
            .unwrap()
            .expect(boundary);
        assert_eq!(index_of(&stored(&store, record)).entries.len(), expect);
        assert_eq!(store.snapshot().unwrap().records.len(), 1, "{boundary}");
        assert!(recordings_files(temp.path()).is_empty(), "{boundary}");
        // The superseded copy and any quarantined one are gone with it.
        let quarantine = temp.path().join("vault").join("quarantine");
        assert!(
            fs::read_dir(quarantine).map_or(true, |mut e| e.next().is_none()),
            "{boundary}"
        );
    }

    #[test]
    fn two_crashes_in_a_row_leave_no_copy_behind() {
        // The first ends a stop after publishing (a `committing` journal); the
        // second ends the recovery of it after it began a copy; the third finishes.
        let temp = tempfile::tempdir().unwrap();
        let (store, _) = new_store(temp.path());
        drop(store);
        run_child(temp.path(), "stop", "recording.after-publish");
        run_child(temp.path(), "recover", "recording.recovery-after-copy");
        let store = reopen(temp.path());
        let pending = store.recordings_pending().unwrap();
        assert_eq!((pending.recordings.len(), pending.unreadable), (1, 0));
        let id = pending.recordings[0].id;
        let record = store.recording_recover(id, true, 10).unwrap().unwrap();
        assert_eq!(index_of(&stored(&store, record)).entries.len(), 4);
        assert!(recordings_files(temp.path()).is_empty());
        assert_eq!(store.snapshot().unwrap().records.len(), 1);
    }

    #[test]
    fn a_recovery_ended_before_its_commit_leaves_no_copy_behind() {
        recovered_after_a_recovery_ended_at("recording.recovery-after-copy", 1);
    }

    #[test]
    fn a_recovery_ended_after_publishing_its_copy_is_recovered_again() {
        recovered_after_a_recovery_ended_at("recording.after-publish", 1);
    }

    #[test]
    fn an_abrupt_end_after_the_object_was_finished_keeps_the_whole_video() {
        recovered_after("recording.after-finish", "stop", Some(4));
    }

    #[test]
    fn an_abrupt_end_after_publishing_is_recovered_from_where_the_sweep_put_it() {
        recovered_after("recording.after-publish", "stop", Some(4));
    }

    #[test]
    fn an_abrupt_end_after_the_commit_leaves_only_leftovers_to_clear() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _) = new_store(temp.path());
        drop(store);
        run_child(temp.path(), "stop", "recording.after-commit");
        let store = reopen(temp.path());
        assert_eq!(store.snapshot().unwrap().records.len(), 1);
        let pending = store.recordings_pending().unwrap();
        assert_eq!(pending.recordings.len(), 1);
        let id = pending.recordings[0].id;
        // Already in the library: recovering clears the journal and keeps the video.
        assert_eq!(store.recording_recover(id, true, 9).unwrap(), Some(id));
        assert_eq!(store.snapshot().unwrap().records.len(), 1);
        assert!(recordings_files(temp.path()).is_empty());
        assert_eq!(index_of(&stored(&store, id)).entries.len(), 4);
    }

    // ---- sequence numbers and the idle lock ---------------------------------

    #[test]
    fn a_numbered_piece_is_added_once_and_a_wrong_number_changes_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE numbered.mp4", 5)
            .unwrap();
        let clip = movie(3, 5000);
        let (first, rest) = clip.split_at(1000);
        let progress = store.recording_append_numbered(id, Some(0), first).unwrap();
        assert_eq!(progress.next_sequence, 1);
        // The reply was lost and the page sends the same piece again: answered,
        // not added twice.
        let again = store.recording_append_numbered(id, Some(0), first).unwrap();
        assert_eq!(
            (again.next_sequence, again.stored_bytes),
            (1, progress.stored_bytes)
        );
        // A number from the future, or from long ago, is refused and changes nothing.
        for wrong in [2_u64, 5, u64::MAX] {
            assert!(matches!(
                store.recording_append_numbered(id, Some(wrong), rest),
                Err(VaultError::Invalid)
            ));
        }
        let mut next = 1;
        for part in rest.chunks(1500) {
            let progress = store
                .recording_append_numbered(id, Some(next), part)
                .unwrap();
            next += 1;
            assert_eq!(progress.next_sequence, next);
        }
        // Stopped, the video is exactly what was sent once.
        let record = store.recording_stop(id, 6).unwrap().unwrap();
        let plain = stored(&store, record);
        assert_eq!(&plain[..clip.len()], &clip[..]);
        assert_eq!(index_of(&plain).entries.len(), 3);
    }

    #[test]
    fn a_recording_that_is_running_holds_the_idle_lock_and_a_paused_one_does_not() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE idle.mp4", 5)
            .unwrap();
        // Where the deadline would fall had nothing been added since the unlock.
        let unlocked = Instant::now();
        let due_unless_touched = unlocked
            + Duration::from_secs(15 * 60)
            + crate::idle::MARGIN
            + Duration::from_millis(40);
        assert!(store.idle().is_due(due_unless_touched));
        std::thread::sleep(Duration::from_millis(120));
        let clip = movie(2, 5000);
        store.recording_append(id, &clip[..500]).unwrap();
        // A piece arrived after the unlock: the deadline moved on with it.
        assert!(!store.idle().is_due(due_unless_touched));
        // Paused, no piece arrives and nothing touches the deadline: it stays
        // where the last piece put it, so it runs out from the pause.
        store.recording_pause(id).unwrap();
        let held_until = Instant::now()
            + Duration::from_secs(15 * 60)
            + crate::idle::MARGIN
            + Duration::from_secs(1);
        assert!(store.idle().is_due(held_until));
    }

    // ---- room on the disk ---------------------------------------------------

    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    /// The disk has `free` bytes, as far as the vault can tell, until the test
    /// changes it. Returns how many times it was asked.
    fn pretend_room(store: &VaultStore, free: &Arc<AtomicU64>) -> Arc<AtomicU64> {
        let asked = Arc::new(AtomicU64::new(0));
        let (free, counted) = (Arc::clone(free), Arc::clone(&asked));
        *store.free_space.lock().unwrap() = Box::new(move |_| {
            counted.fetch_add(1, AtomicOrdering::SeqCst);
            Some(free.load(AtomicOrdering::SeqCst))
        });
        asked
    }

    const MIB: u64 = 1 << 20;
    const GIB: u64 = 1 << 30;

    #[test]
    fn the_levels_are_where_the_design_puts_them() {
        assert_eq!(space_level(None), SpaceLevel::Unknown);
        assert_eq!(space_level(Some(0)), SpaceLevel::Stop);
        assert_eq!(space_level(Some(256 * MIB - 1)), SpaceLevel::Stop);
        assert_eq!(space_level(Some(256 * MIB)), SpaceLevel::Low);
        assert_eq!(space_level(Some(512 * MIB - 1)), SpaceLevel::Low);
        assert_eq!(space_level(Some(512 * MIB)), SpaceLevel::Ok);
        assert_eq!(space_level(Some(u64::MAX)), SpaceLevel::Ok);
        assert_eq!((MIN_FREE_TO_RECORD, STOP_FREE), (GIB, 256 * MIB));
    }

    #[test]
    fn a_recording_is_refused_below_one_gib_and_nothing_is_written() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let free = Arc::new(AtomicU64::new(GIB - 1));
        pretend_room(&store, &free);
        let space = store.recording_space().unwrap();
        assert!(!space.can_record);
        assert_eq!(space.free_bytes, Some(GIB - 1));
        assert!(matches!(
            store.recording_start(profile, vec![], "FAKE full.mp4", 5),
            Err(VaultError::NoSpace)
        ));
        assert!(recordings_files(temp.path()).is_empty());
        assert!(store.recordings.lock().unwrap().is_empty());
        // Exactly one GiB is enough.
        free.store(GIB, AtomicOrdering::SeqCst);
        assert!(store.recording_space().unwrap().can_record);
        assert!(store
            .recording_start(profile, vec![], "FAKE ok.mp4", 5)
            .is_ok());
    }

    #[test]
    fn a_volume_that_cannot_be_asked_refuses_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        *store.free_space.lock().unwrap() = Box::new(|_| None);
        let space = store.recording_space().unwrap();
        assert!(space.can_record);
        assert_eq!(space.level, SpaceLevel::Unknown);
        assert!(store
            .recording_start(profile, vec![], "FAKE unknown.mp4", 5)
            .is_ok());
    }

    #[test]
    fn room_is_looked_at_every_eight_frames_and_the_level_follows_it() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let free = Arc::new(AtomicU64::new(10 * GIB));
        let asked = pretend_room(&store, &free);
        let id = store
            .recording_start(profile, vec![], "FAKE watched.mp4", 5)
            .unwrap();
        let after_start = asked.load(AtomicOrdering::SeqCst);
        // 20 frames of video (a fragment of 1 MiB is one frame): many pieces,
        // few looks at the disk.
        let clip = movie(21, 1_048_000);
        let mut progress = None;
        for part in clip.chunks(1_000_000) {
            progress = Some(store.recording_append(id, part).unwrap());
        }
        let looks = asked.load(AtomicOrdering::SeqCst) - after_start;
        // At frame 0, 8 and 16 of about 21.
        assert_eq!(looks, 3, "looked {looks} times for about 21 frames");
        assert_eq!(progress.unwrap().space, SpaceLevel::Ok);
        // Room falls to the warning, and the next look says so.
        free.store(400 * MIB, AtomicOrdering::SeqCst);
        let mut level = SpaceLevel::Ok;
        for n in 0..9_u64 {
            let part = fragment(100 + n as u32, 0, 0, 1_040_000);
            level = store
                .recording_append(id, &part)
                .map(|p| p.space)
                .unwrap_or(level);
            if level != SpaceLevel::Ok {
                break;
            }
        }
        assert_eq!(level, SpaceLevel::Low);
    }

    #[test]
    fn at_the_reserve_the_recording_is_told_to_stop_takes_no_more_and_is_saved_normally() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let free = Arc::new(AtomicU64::new(10 * GIB));
        pretend_room(&store, &free);
        let id = store
            .recording_start(profile, vec![], "FAKE reserve.mp4", 5)
            .unwrap();
        // The recorder's pieces are whole fragments of about one frame each.
        let piece = |n: u64| fragment(n as u32 + 1, n * 30000, n * 48128, 1_048_000);
        store
            .recording_append(id, &[ftyp(), moov(), piece(0)].concat())
            .unwrap();
        store.recording_append(id, &piece(1)).unwrap();
        // The disk fills to the reserve; a look at the disk finds it.
        free.store(STOP_FREE - 1, AtomicOrdering::SeqCst);
        let mut told = None;
        let mut next = 2;
        while told.is_none() && next < 40 {
            let progress = store.recording_append(id, &piece(next)).unwrap();
            next += 1;
            if progress.space == SpaceLevel::Stop {
                told = Some(progress);
            }
        }
        let told = told.expect("told to stop");
        assert_eq!(told.space, SpaceLevel::Stop);
        assert_eq!(told.free_bytes, Some(STOP_FREE - 1));
        // Nothing more is taken: the room left is the reserve for finishing.
        assert!(matches!(
            store.recording_append(id, &piece(next)),
            Err(VaultError::NoSpace)
        ));
        // It is saved as any recording is, with what there was: every fragment
        // that was taken, and no copy of it made (a copy needs room).
        let before = object_files(temp.path());
        let record = store.recording_stop(id, 6).unwrap().unwrap();
        assert_eq!(index_of(&stored(&store, record)).entries.len() as u64, next);
        assert_eq!(object_files(temp.path()).len(), before.len() + 1);
        assert!(recordings_files(temp.path()).is_empty());
    }

    #[test]
    fn recovery_needs_about_the_recordings_size_again_and_waits_if_there_is_not_room() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE recover.mp4", 5)
            .unwrap();
        feed(&store, id, &movie(4, 700_000), 250_000);
        drop(store); // a crash
        let store = reopen(temp.path());
        let free = Arc::new(AtomicU64::new(100 * MIB));
        pretend_room(&store, &free);
        assert!(matches!(
            store.recording_recover(id, true, 9),
            Err(VaultError::NoSpace)
        ));
        // Nothing was lost: the question is still there, and nothing was added.
        let pending = store.recordings_pending().unwrap();
        assert_eq!((pending.recordings.len(), pending.unreadable), (1, 0));
        assert!(store.snapshot().unwrap().records.is_empty());
        free.store(10 * GIB, AtomicOrdering::SeqCst);
        let record = store.recording_recover(id, true, 10).unwrap().unwrap();
        assert_eq!(index_of(&stored(&store, record)).entries.len(), 2);
        assert!(recordings_files(temp.path()).is_empty());
    }

    #[test]
    fn declining_a_recording_needs_no_room() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let id = store
            .recording_start(profile, vec![], "FAKE decline.mp4", 5)
            .unwrap();
        feed(&store, id, &movie(4, 700_000), 250_000);
        drop(store);
        let store = reopen(temp.path());
        pretend_room(&store, &Arc::new(AtomicU64::new(0)));
        assert_eq!(store.recording_recover(id, false, 9).unwrap(), None);
        assert!(recordings_files(temp.path()).is_empty());
    }

    #[test]
    fn room_is_only_asked_of_a_vault_that_is_open_and_writable() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _) = new_store(temp.path());
        assert!(store.recording_space().is_ok());
        store.lock();
        assert!(matches!(store.recording_space(), Err(VaultError::Locked)));
    }

    #[test]
    fn a_recording_that_ends_mid_fragment_on_a_full_disk_is_kept_unfinished_not_lost() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let free = Arc::new(AtomicU64::new(10 * GIB));
        pretend_room(&store, &free);
        let id = store
            .recording_start(profile, vec![], "FAKE midway.mp4", 5)
            .unwrap();
        // Two whole fragments, then half of a third: the recorder ended where the
        // disk filled.
        let whole = movie(2, 400_000);
        let third = fragment(3, 60000, 96256, 400_000);
        store.recording_append(id, &whole).unwrap();
        store.recording_append(id, &third[..200_000]).unwrap();
        // Finishing it means copying it, which needs room that is not there.
        free.store(100 * MIB, AtomicOrdering::SeqCst);
        assert!(matches!(
            store.recording_stop(id, 6),
            Err(VaultError::NoSpace)
        ));
        // Not lost: it is parked, nothing was added, and it is asked about when
        // the vault is next opened (or recovered now, with room).
        assert!(store.snapshot().unwrap().records.is_empty());
        let pending = store.recordings_pending().unwrap();
        assert_eq!((pending.recordings.len(), pending.unreadable), (1, 0));
        assert!(pending.recordings[0].parked);
        // The patient ended it: the next unlock says why it is being finished.
        assert!(pending.recordings[0].stopped);
        free.store(10 * GIB, AtomicOrdering::SeqCst);
        let record = store.recording_recover(id, true, 9).unwrap().unwrap();
        assert_eq!(index_of(&stored(&store, record)).entries.len(), 2);
        assert!(recordings_files(temp.path()).is_empty());
    }

    #[test]
    fn a_write_that_fails_for_want_of_room_keeps_what_was_written_for_later() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = new_store(temp.path());
        let free = Arc::new(AtomicU64::new(10 * GIB));
        pretend_room(&store, &free);
        let id = store
            .recording_start(profile, vec![], "FAKE filled.mp4", 5)
            .unwrap();
        let piece = |n: u64| fragment(n as u32 + 1, n * 30000, n * 48128, 1_048_000);
        store
            .recording_append(id, &[ftyp(), moov(), piece(0)].concat())
            .unwrap();
        store.recording_append(id, &piece(1)).unwrap();
        // The disk fills under the next frame: the write is refused.
        FAIL_AT_TEST_BOUNDARY.set(&["recording.chunk-write"]);
        let refused = store.recording_append(id, &piece(2));
        FAIL_AT_TEST_BOUNDARY.set(&[]);
        assert!(matches!(refused, Err(VaultError::NoSpace)), "{refused:?}");
        free.store(50 * MIB, AtomicOrdering::SeqCst);
        // Ending it needs room to finish it by copy: not there, so it is kept.
        assert!(matches!(
            store.recording_stop(id, 6),
            Err(VaultError::NoSpace)
        ));
        assert_eq!(store.recordings_pending().unwrap().recordings.len(), 1);
        free.store(10 * GIB, AtomicOrdering::SeqCst);
        let record = store.recording_recover(id, true, 9).unwrap().unwrap();
        assert!(!index_of(&stored(&store, record)).entries.is_empty());
    }

    #[test]
    fn the_camera_origin_is_kept_per_history_and_follows_new_recordings() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "FAKE Person", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let record = |name: &str, at: u64| {
            let id = store.recording_start(profile, vec![], name, at).unwrap();
            let movie = [mp4_stream::fake::ftyp(), mp4_stream::fake::moov()].concat();
            store.recording_append(id, &movie).unwrap();
            store
                .recording_append(id, &mp4_stream::fake::fragment(1, 0, 0, 3000))
                .unwrap();
            store.recording_stop(id, at + 1).unwrap().unwrap()
        };
        let first = record("FAKE one.mp4", 5);
        // Asked twice (the second is the kept answer), and the same.
        assert!(store.added_with_camera(first).unwrap());
        assert!(store.added_with_camera(first).unwrap());
        // A later recording changes the history, so the kept answer is replaced.
        let second = record("FAKE two.mp4", 9);
        assert!(store.added_with_camera(second).unwrap());
        assert!(store.added_with_camera(first).unwrap());
    }
}

//! Playing a stored video (#359): the random-access reader and the tokens.
//!
//! A video is an `MCVO1` object like any other: 1 MiB frames, every one
//! authenticated by its index and by whether it is the last. That is what lets
//! playback open at any byte without decrypting what comes before it: frame *n*
//! starts at `25 + n * (5 + 1 MiB + 16)`, so only the frames a range touches are
//! read and decrypted, and a small cache (four frames) keeps the one a player
//! is reading from being decrypted again for the next range. Nothing is written
//! anywhere: the bytes go from the object to the response.
//!
//! The file a player sees is not the stored one. The stored stream ends in a
//! small index; the head a player needs (`ftyp`, `moov`, then a `sidx` made
//! from the index) is built in memory and placed in front of the stored
//! fragments, so the player can seek without reading the whole file (the PR 0
//! spike showed Chromium does not seek without a `sidx`). The served length and
//! every offset are the head's plus the fragments', never the stored file's.
//!
//! A **token** is what lets the page ask for a video: 32 random bytes, made for
//! one record at one unlock, held only in memory, and gone when the vault locks,
//! is reset, or the session is dropped. A token cannot be used after a lock
//! even if the same vault is opened again. The vault's lock ends playback.
//!
//! Serving a range is not activity: a player buffers ahead while it is paused,
//! and that must not keep an unattended device unlocked. The viewer tells the
//! automatic lock when the video is actually playing (VaultApp's media hold),
//! and the lock waits only for as long as it is.

use super::*;
use crate::mp4_stream::{self, Source, VirtualHead};
use std::collections::VecDeque;
use std::io::{Seek, SeekFrom};

/// The most bytes one response carries. A player asks for `bytes=N-` and takes
/// what comes, asking again for the rest: 2 MiB keeps memory small and a seek
/// quick. The `Content-Range` always says what was sent.
pub(crate) const MAX_RANGE_RESPONSE: u64 = 2 * 1024 * 1024;
/// Decrypted frames kept for the next range.
const CHUNK_CACHE: usize = 4;
/// Videos open at once. Opening another ends the oldest.
const MAX_OPEN_PLAYBACKS: usize = 8;
/// The most a trailing index may be (about 700,000 fragments).
const MAX_INDEX_TRAILER: u64 = 16 * 1024 * 1024;
/// The most a stored head (`ftyp` and `moov`) may be, as the normaliser allows.
const MAX_STORED_HEAD: u64 = 4 * 1024 + 1024 * 1024;
const FRAME_LEN: u64 = 5 + CHUNK_SIZE as u64 + 16;
const OBJECT_HEADER_LEN: u64 = 25;
/// Token length: 32 bytes as lowercase hex.
pub(crate) const TOKEN_HEX_LEN: usize = 64;
const RANGE_HEADER_MAX: usize = 128;

/// An object read at random: the frames a range touches, and no others.
struct ChunkReader {
    file: File,
    cipher: XChaCha20Poly1305,
    vault_id: Uuid,
    record_id: Uuid,
    nonce_prefix: [u8; 16],
    frames: u64,
    /// Plaintext bytes in the last frame.
    last_plain: u64,
    plaintext_size: u64,
    /// Most recently used last. Zeroed when dropped.
    cache: VecDeque<(u64, Zeroizing<Vec<u8>>)>,
    /// How many frames were decrypted (for tests: only what is needed is read).
    decrypted: u64,
}

fn corrupt_or_io(error: io::Error) -> VaultError {
    if matches!(
        error.kind(),
        io::ErrorKind::InvalidData | io::ErrorKind::NotFound | io::ErrorKind::UnexpectedEof
    ) {
        VaultError::Corrupt
    } else {
        error.into()
    }
}

impl ChunkReader {
    /// Opens `path` and checks its shape against the size the manifest says: a
    /// file cut at a frame boundary, extended, or of another length is refused
    /// here, and a frame of the wrong kind is refused when it is read.
    fn open(
        path: &Path,
        vault_id: Uuid,
        record_id: Uuid,
        object_key: &[u8; 32],
        plaintext_size: u64,
    ) -> Result<Self, VaultError> {
        let mut file = open_regular_read(path).map_err(corrupt_or_io)?;
        let length = file.metadata().map_err(corrupt_or_io)?.len();
        let mut header = [0_u8; OBJECT_HEADER_LEN as usize];
        file.read_exact(&mut header).map_err(corrupt_or_io)?;
        if &header[..5] != OBJECT_MAGIC
            || u32::from_be_bytes([header[5], header[6], header[7], header[8]]) as usize
                != CHUNK_SIZE
        {
            return Err(VaultError::Corrupt);
        }
        let mut nonce_prefix = [0_u8; 16];
        nonce_prefix.copy_from_slice(&header[9..25]);
        let body = length
            .checked_sub(OBJECT_HEADER_LEN)
            .filter(|body| *body > 0)
            .ok_or(VaultError::Corrupt)?;
        let frames = body.div_ceil(FRAME_LEN);
        let last_frame = body - (frames - 1) * FRAME_LEN;
        let last_plain = last_frame.checked_sub(5 + 16).ok_or(VaultError::Corrupt)?;
        if (frames - 1) * CHUNK_SIZE as u64 + last_plain != plaintext_size {
            return Err(VaultError::Corrupt);
        }
        Ok(Self {
            file,
            cipher: XChaCha20Poly1305::new(object_key.into()),
            vault_id,
            record_id,
            nonce_prefix,
            frames,
            last_plain,
            plaintext_size,
            cache: VecDeque::new(),
            decrypted: 0,
        })
    }

    fn plaintext_len(&self, index: u64) -> usize {
        if index + 1 == self.frames {
            self.last_plain as usize
        } else {
            CHUNK_SIZE
        }
    }

    /// Reads, authenticates and decrypts frame `index`, or takes it from the cache.
    fn chunk(&mut self, index: u64) -> Result<&[u8], VaultError> {
        if let Some(at) = self.cache.iter().position(|(n, _)| *n == index) {
            let hit = self.cache.remove(at).ok_or(VaultError::Corrupt)?;
            self.cache.push_back(hit);
        } else {
            let plain = self.decrypt(index)?;
            while self.cache.len() >= CHUNK_CACHE {
                self.cache.pop_front();
            }
            self.cache.push_back((index, plain));
        }
        self.cache
            .back()
            .map(|(_, plain)| plain.as_slice())
            .ok_or(VaultError::Corrupt)
    }

    fn decrypt(&mut self, index: u64) -> Result<Zeroizing<Vec<u8>>, VaultError> {
        let last = index + 1 == self.frames;
        let expected = self.plaintext_len(index) + 16;
        self.file
            .seek(SeekFrom::Start(OBJECT_HEADER_LEN + index * FRAME_LEN))
            .map_err(corrupt_or_io)?;
        let mut head = [0_u8; 5];
        self.file.read_exact(&mut head).map_err(corrupt_or_io)?;
        // The frame must be exactly the length and kind this position has.
        if u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize != expected
            || head[4] != u8::from(last)
        {
            return Err(VaultError::Corrupt);
        }
        let mut ciphertext = vec![0_u8; expected];
        self.file
            .read_exact(&mut ciphertext)
            .map_err(corrupt_or_io)?;
        let mut nonce = [0_u8; 24];
        nonce[..16].copy_from_slice(&self.nonce_prefix);
        nonce[16..].copy_from_slice(&index.to_be_bytes());
        let plain = self
            .cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &object_aad(self.vault_id, self.record_id, index, last),
                },
            )
            .map_err(|_| VaultError::Corrupt)?;
        self.decrypted += 1;
        Ok(Zeroizing::new(plain))
    }

    /// `length` plaintext bytes from `offset`, decrypting only the frames they
    /// lie in.
    fn read_at(&mut self, offset: u64, length: usize) -> Result<Vec<u8>, VaultError> {
        let end = offset
            .checked_add(length as u64)
            .filter(|end| *end <= self.plaintext_size)
            .ok_or(VaultError::Invalid)?;
        let mut out = Vec::with_capacity(length);
        let mut at = offset;
        while at < end {
            let index = at / CHUNK_SIZE as u64;
            let within = (at % CHUNK_SIZE as u64) as usize;
            let take = ((CHUNK_SIZE - within) as u64).min(end - at) as usize;
            let chunk = self.chunk(index)?;
            out.extend_from_slice(
                chunk
                    .get(within..within + take)
                    .ok_or(VaultError::Corrupt)?,
            );
            at += take as u64;
        }
        Ok(out)
    }
}

/// A video opened for playback.
pub(super) struct PlaybackSession {
    record_id: Uuid,
    reader: ChunkReader,
    head: VirtualHead,
    opened: Instant,
}

impl PlaybackSession {
    /// The length of the file a player sees.
    fn total_len(&self) -> u64 {
        self.head.total_len()
    }

    /// Bytes `start..=end` of the served file: the head, then the fragments.
    fn read_served(&mut self, start: u64, end: u64) -> Result<Vec<u8>, VaultError> {
        let mut out = Vec::with_capacity((end - start + 1) as usize);
        let mut at = start;
        while at <= end {
            let left = end - at + 1;
            match self.head.locate(at).ok_or(VaultError::Invalid)? {
                Source::Head(n) => {
                    let take = ((self.head.bytes.len() - n) as u64).min(left) as usize;
                    out.extend_from_slice(&self.head.bytes[n..n + take]);
                    at += take as u64;
                }
                Source::Stored(n) => {
                    let take = (self.head.media_end - n).min(left) as usize;
                    out.extend(self.reader.read_at(n, take)?);
                    at += take as u64;
                }
            }
        }
        Ok(out)
    }
}

/// What a `Range` header asks for, against a file of `total` bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RangeOutcome {
    /// Bytes `start..=end`, already limited to the file and to one response.
    Satisfiable { start: u64, end: u64 },
    /// Nothing in the file is asked for, or the header cannot be trusted.
    Unsatisfiable,
}

/// Reads a `Range` header for a file of `total` bytes (`total > 0`).
///
/// Only one `bytes` range is understood: `a-b`, `a-` and `-n`, digits only. A
/// header that is anything else (another unit, several ranges, signs, spaces,
/// hex, a number too large for 64 bits, a range that ends before it starts, or
/// one longer than 128 bytes) is unsatisfiable: the answer is 416 with the size,
/// and nothing is read. No header at all is read as `bytes=0-`: players always
/// send one, and a response is never the whole file.
pub(crate) fn parse_range(header: Option<&str>, total: u64) -> RangeOutcome {
    let Some(header) = header else {
        return clamp(0, u64::MAX, total);
    };
    if header.len() > RANGE_HEADER_MAX || total == 0 {
        return RangeOutcome::Unsatisfiable;
    }
    let Some((unit, spec)) = header.split_once('=') else {
        return RangeOutcome::Unsatisfiable;
    };
    if !unit.eq_ignore_ascii_case("bytes") || spec.contains(',') {
        return RangeOutcome::Unsatisfiable;
    }
    let digits = |text: &str| -> Option<u64> {
        if text.is_empty() || text.len() > 20 || !text.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        text.parse().ok()
    };
    let Some((from, to)) = spec.split_once('-') else {
        return RangeOutcome::Unsatisfiable;
    };
    match (from.is_empty(), to.is_empty()) {
        // `-n`: the last n bytes.
        (true, false) => match digits(to) {
            Some(0) | None => RangeOutcome::Unsatisfiable,
            Some(n) => clamp(total.saturating_sub(n), u64::MAX, total),
        },
        // `a-`: from a to the end.
        (false, true) => match digits(from) {
            Some(start) => clamp(start, u64::MAX, total),
            None => RangeOutcome::Unsatisfiable,
        },
        // `a-b`.
        (false, false) => match (digits(from), digits(to)) {
            (Some(start), Some(end)) if start <= end => clamp(start, end, total),
            _ => RangeOutcome::Unsatisfiable,
        },
        (true, true) => RangeOutcome::Unsatisfiable,
    }
}

/// `start..=end` limited to a file of `total` bytes and to one response.
fn clamp(start: u64, end: u64, total: u64) -> RangeOutcome {
    if start >= total {
        return RangeOutcome::Unsatisfiable;
    }
    let end = end
        .min(total - 1)
        .min(start.saturating_add(MAX_RANGE_RESPONSE - 1));
    RangeOutcome::Satisfiable { start, end }
}

/// What the scheme handler sends back.
#[cfg_attr(test, derive(Debug))]
#[derive(PartialEq, Eq)]
pub(crate) struct PlaybackReply {
    /// 206, or 416 when the range could not be satisfied.
    pub(crate) status: u16,
    /// The size of the file a player sees.
    pub(crate) total: u64,
    /// The bytes sent, as `start..=end`. `None` for a 416.
    pub(crate) range: Option<(u64, u64)>,
    /// Empty for a HEAD request or a 416.
    pub(crate) body: Vec<u8>,
}
redact_debug!(PlaybackReply);

/// Why a request got no reply.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PlaybackRefusal {
    /// No such token: never made, ended, or from before the last lock. The same
    /// answer for all of them.
    UnknownToken,
    /// The video could not be read (damaged or gone).
    Unreadable,
}

/// What a caller learns when a video is opened.
#[cfg_attr(test, derive(Debug))]
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackOpened {
    /// Where to ask: the token, which is also the path of the scheme's address.
    pub token: String,
    /// The length of the file a player sees.
    pub total_bytes: u64,
}
redact_debug!(PlaybackOpened);

impl Drop for PlaybackOpened {
    /// The token is a bearer secret for one video: this copy of it is wiped (the one in the table
    /// of open playbacks goes with the playback).
    fn drop(&mut self) {
        use zeroize::Zeroize as _;
        self.token.zeroize();
    }
}

fn new_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let mut token = String::with_capacity(TOKEN_HEX_LEN);
    for byte in bytes {
        token.push(char::from_digit(u32::from(byte >> 4), 16).unwrap_or('0'));
        token.push(char::from_digit(u32::from(byte & 15), 16).unwrap_or('0'));
    }
    token
}

/// Whether `text` could be a token (the right length, lowercase hex).
pub(crate) fn looks_like_token(text: &str) -> bool {
    text.len() == TOKEN_HEX_LEN
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl VaultStore {
    /// Opens a stored video for playback and returns the token that asks for it.
    /// Refused for a record that is not a video (no index at its end), one that
    /// is unavailable, or a locked vault.
    pub fn playback_open(&self, record_id: Uuid) -> Result<PlaybackOpened, VaultError> {
        // The session is held to the end, so that the token cannot be added
        // after a lock that came in between (the lock takes the same order:
        // session first, then the tokens).
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        // A hidden person's video is not played by its id any more than it is listed (#360): the
        // answer is the one a record the vault does not have gets.
        let record = unlocked
            .manifest
            .records
            .iter()
            .find(|record| {
                record.id == record_id && !unlocked.manifest.person_is_hidden(record.profile_id)
            })
            .ok_or(VaultError::NotFound)?;
        if unlocked.unavailable.contains(&record.id) {
            return Err(VaultError::Corrupt);
        }
        let vault_id = unlocked.manifest.vault_id;
        let keys = derive_keys(vault_id, &unlocked.master_key)?;
        let object_key = unwrap_secret(
            &keys.object_wrap,
            &record.wrapped_object_key,
            record.id.as_bytes(),
        )?;
        let reader = ChunkReader::open(
            &self.root.join("objects").join(&record.object_name),
            vault_id,
            record.id,
            &object_key,
            record.plaintext_size,
        )?;
        let session = open_session(reader)?;
        let total_bytes = session.total_len();
        let token = new_token();
        let mut tokens = self.playback.lock().unwrap_or_else(PoisonError::into_inner);
        while tokens.len() >= MAX_OPEN_PLAYBACKS {
            let oldest = tokens
                .iter()
                .min_by_key(|(_, session)| session.opened)
                .map(|(token, _)| token.clone());
            match oldest {
                Some(oldest) => tokens.remove(&oldest),
                None => break,
            };
        }
        tokens.insert(token.clone(), session);
        Ok(PlaybackOpened { token, total_bytes })
    }

    /// Ends one video's playback.
    pub fn playback_close(&self, token: &str) {
        self.playback
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(token);
    }

    /// Ends every playback of one record: hiding a document ends the video that
    /// is playing from it.
    pub(super) fn end_playback_for(&self, record_id: Uuid) {
        self.playback
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|_, session| session.record_id != record_id);
    }

    /// Ends every playback of any of these records: hiding a person ends the videos that are
    /// playing from their documents (#360).
    pub(super) fn end_playback_for_records(&self, record_ids: &[Uuid]) {
        self.playback
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|_, session| !record_ids.contains(&session.record_id));
    }

    /// Ends every playback and drops their keys: the lock, a reset and a dropped
    /// session all do this, so no token outlives the unlock it was made in.
    pub(super) fn end_playback(&self) {
        self.playback
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }

    /// Answers a request for a range of an open video. `want_body` is false for
    /// HEAD.
    pub(crate) fn playback_serve(
        &self,
        token: &str,
        range: Option<&str>,
        want_body: bool,
    ) -> Result<PlaybackReply, PlaybackRefusal> {
        if !looks_like_token(token) {
            return Err(PlaybackRefusal::UnknownToken);
        }
        // A session a panic left half-updated is dropped now, which ends every
        // playback with it, not whenever something else next takes the session.
        // (Only then: the session is held for a whole transfer, and a read must
        // not wait behind one.)
        if self.unlocked.is_poisoned() {
            drop(self.session());
        }
        let mut tokens = self.playback.lock().unwrap_or_else(PoisonError::into_inner);
        let session = tokens.get_mut(token).ok_or(PlaybackRefusal::UnknownToken)?;
        let total = session.total_len();
        let RangeOutcome::Satisfiable { start, end } = parse_range(range, total) else {
            return Ok(PlaybackReply {
                status: 416,
                total,
                range: None,
                body: Vec::new(),
            });
        };
        let body = if want_body {
            session
                .read_served(start, end)
                .map_err(|_| PlaybackRefusal::Unreadable)?
        } else {
            Vec::new()
        };
        Ok(PlaybackReply {
            status: 206,
            total,
            range: Some((start, end)),
            body,
        })
    }
}

/// Reads the index and the stored head and builds what is served.
fn open_session(mut reader: ChunkReader) -> Result<PlaybackSession, VaultError> {
    let size = reader.plaintext_size;
    let footer_at = size
        .checked_sub(mp4_stream::INDEX_FOOTER_LEN as u64)
        .ok_or(VaultError::Invalid)?;
    let footer = reader.read_at(footer_at, mp4_stream::INDEX_FOOTER_LEN)?;
    // Not a video: no index footer where one would be.
    let trailer_len = mp4_stream::trailer_length(&footer).map_err(|_| VaultError::Invalid)? as u64;
    if trailer_len > size || trailer_len > MAX_INDEX_TRAILER {
        return Err(VaultError::Invalid);
    }
    let trailer = reader.read_at(size - trailer_len, trailer_len as usize)?;
    let index = mp4_stream::parse_index_trailer(&trailer).map_err(|_| VaultError::Invalid)?;
    let first = index.entries.first().ok_or(VaultError::Invalid)?;
    if first.offset > MAX_STORED_HEAD {
        return Err(VaultError::Invalid);
    }
    let stored_start = reader.read_at(0, first.offset as usize)?;
    let head =
        mp4_stream::build_virtual_head(&stored_start, &index).map_err(|_| VaultError::Invalid)?;
    // The fragments end exactly where the index begins.
    if head.media_end + trailer_len != size {
        return Err(VaultError::Corrupt);
    }
    Ok(PlaybackSession {
        record_id: reader.record_id,
        reader,
        head,
        opened: Instant::now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mp4_stream::fake::{fragment, ftyp, moov};
    use crate::mp4_stream::{build_virtual_head, parse_index_trailer, trailer_length};

    const PASSWORD: &str = "river-azimuth-cobalt-sparrow-934";

    /// A stored video of `count` fragments of `payload` bytes each, recorded
    /// through the real recording core. Returns the store, the record and the
    /// plaintext the vault holds.
    fn stored_video(root: &Path, count: u64, payload: usize) -> (VaultStore, Uuid, Vec<u8>) {
        let store = VaultStore::new(root.join("vault"));
        store.create(PASSWORD, "FAKE Person", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let id = store
            .recording_start(profile, vec![], "FAKE clip.mp4", 5)
            .unwrap();
        let mut movie = [ftyp(), moov()].concat();
        for n in 0..count {
            movie.extend(fragment(n as u32 + 1, n * 30000, n * 48128, payload));
        }
        for part in movie.chunks(300_000) {
            store.recording_append(id, part).unwrap();
        }
        let record = store.recording_stop(id, 6).unwrap().unwrap();
        let mut plain = Vec::new();
        store.read_for_view(record, &mut plain).unwrap();
        (store, record, plain)
    }

    /// The file a player should see, built independently from the plaintext.
    fn expected_served(plain: &[u8]) -> Vec<u8> {
        let length = trailer_length(&plain[plain.len() - mp4_stream::INDEX_FOOTER_LEN..]).unwrap();
        let index = parse_index_trailer(&plain[plain.len() - length..]).unwrap();
        let head = build_virtual_head(plain, &index).unwrap();
        let mut served = head.bytes.clone();
        served.extend_from_slice(&plain[head.first_fragment as usize..head.media_end as usize]);
        served
    }

    fn serve(
        store: &VaultStore,
        token: &str,
        range: Option<&str>,
    ) -> Result<PlaybackReply, PlaybackRefusal> {
        store.playback_serve(token, range, true)
    }

    // ---- the Range header, by itself -------------------------------------

    #[test]
    fn a_range_header_means_what_it_says_or_nothing() {
        let total = 1_000_u64;
        let ok = |start, end| RangeOutcome::Satisfiable { start, end };
        let no = RangeOutcome::Unsatisfiable;
        for (header, want) in [
            (Some("bytes=0-0"), ok(0, 0)),
            (Some("bytes=0-499"), ok(0, 499)),
            (Some("bytes=500-"), ok(500, 999)),
            (Some("bytes=999-"), ok(999, 999)),
            (Some("bytes=990-5000"), ok(990, 999)),
            (Some("bytes=-1"), ok(999, 999)),
            (Some("bytes=-100"), ok(900, 999)),
            (Some("bytes=-5000"), ok(0, 999)),
            (Some("BYTES=3-4"), ok(3, 4)),
            (Some("Bytes=3-4"), ok(3, 4)),
            (None, ok(0, 999)),
            (Some("bytes=1000-"), no),
            (Some("bytes=1000-2000"), no),
            (Some("bytes=-0"), no),
            (Some("bytes=5-4"), no),
            (Some("bytes=0-1,5-9"), no),
            (Some("bytes=0-1, 5-9"), no),
            (Some("items=0-9"), no),
            (Some("0-9"), no),
            (Some("bytes"), no),
            (Some("bytes="), no),
            (Some("bytes=-"), no),
            (Some("bytes=--1"), no),
            (Some("bytes=1--2"), no),
            (Some("bytes=1-2-3"), no),
            (Some("bytes= 1-2"), no),
            (Some("bytes=1-2 "), no),
            (Some("bytes=1 -2"), no),
            (Some("bytes=+1-2"), no),
            (Some("bytes=0x1-2"), no),
            (Some("bytes=١-٢"), no),
            (Some("bytes=\u{0}-5"), no),
            (Some("bytes=18446744073709551616-"), no),
            (Some("bytes=99999999999999999999-"), no),
            (Some("bytes=0-99999999999999999999"), no),
            (Some(""), no),
        ] {
            assert_eq!(parse_range(header, total), want, "{header:?}");
        }
        // A header that is too long is not parsed at all.
        let long = format!("bytes=0-{}", "9".repeat(RANGE_HEADER_MAX));
        assert_eq!(parse_range(Some(&long), total), no);
        // The largest numbers a u64 holds do not overflow anything.
        assert_eq!(parse_range(Some("bytes=18446744073709551615-"), total), no);
        assert_eq!(
            parse_range(Some("bytes=0-18446744073709551615"), total),
            ok(0, 999)
        );
        // An empty file has nothing to ask for.
        assert_eq!(parse_range(Some("bytes=0-0"), 0), no);
    }

    #[test]
    fn one_response_never_carries_more_than_the_cap() {
        let total = 10 * MAX_RANGE_RESPONSE;
        assert_eq!(
            parse_range(Some("bytes=0-"), total),
            RangeOutcome::Satisfiable {
                start: 0,
                end: MAX_RANGE_RESPONSE - 1
            }
        );
        assert_eq!(
            parse_range(Some(&format!("bytes=5-{}", total - 1)), total),
            RangeOutcome::Satisfiable {
                start: 5,
                end: 5 + MAX_RANGE_RESPONSE - 1
            }
        );
        // A tail of a few bytes is still just those bytes.
        assert_eq!(
            parse_range(Some("bytes=-10"), total),
            RangeOutcome::Satisfiable {
                start: total - 10,
                end: total - 1
            }
        );
        // The last response of a file ends at the file.
        assert_eq!(
            parse_range(Some(&format!("bytes={}-", total - 3)), total),
            RangeOutcome::Satisfiable {
                start: total - 3,
                end: total - 1
            }
        );
    }

    #[test]
    fn a_token_is_32_bytes_of_lowercase_hex_and_nothing_else_looks_like_one() {
        let token = new_token();
        assert!(looks_like_token(&token));
        assert_ne!(new_token(), token);
        for bad in [
            "",
            "0",
            &token[..63],
            &format!("{token}0"),
            &token.to_uppercase(),
            &format!("g{}", &token[1..]),
            &format!("/{}", &token[1..]),
            &format!(" {}", &token[1..]),
        ] {
            assert!(!looks_like_token(bad), "{bad:?}");
        }
    }

    // ---- the random-access reader -----------------------------------------

    #[test]
    fn only_the_frames_a_range_touches_are_decrypted_and_the_cache_is_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record, plain) = stored_video(temp.path(), 5, 900_000);
        assert!(plain.len() > 4 * CHUNK_SIZE);
        let (vault_id, object_name, key) = {
            let guard = store.session();
            let unlocked = guard.as_ref().unwrap();
            let entry = unlocked
                .manifest
                .records
                .iter()
                .find(|r| r.id == record)
                .unwrap();
            let keys = derive_keys(unlocked.manifest.vault_id, &unlocked.master_key).unwrap();
            let key = unwrap_secret(
                &keys.object_wrap,
                &entry.wrapped_object_key,
                record.as_bytes(),
            )
            .unwrap();
            (unlocked.manifest.vault_id, entry.object_name.clone(), key)
        };
        let mut reader = ChunkReader::open(
            &temp.path().join("vault").join("objects").join(object_name),
            vault_id,
            record,
            &key,
            plain.len() as u64,
        )
        .unwrap();
        assert!(reader.frames >= 4);
        // Ten bytes in the middle of the third frame: that frame and no other.
        let at = 2 * CHUNK_SIZE as u64 + 4000;
        assert_eq!(
            reader.read_at(at, 10).unwrap(),
            plain[at as usize..at as usize + 10]
        );
        assert_eq!(reader.decrypted, 1);
        // The same frame again is not decrypted again.
        reader.read_at(at + 100, 10).unwrap();
        assert_eq!(reader.decrypted, 1);
        // A read across a frame boundary takes both.
        let seam = CHUNK_SIZE as u64 - 5;
        assert_eq!(
            reader.read_at(seam, 10).unwrap(),
            plain[seam as usize..seam as usize + 10]
        );
        assert_eq!(reader.decrypted, 3);
        // However much is read, no more than the cache holds is kept.
        for frame in 0..reader.frames {
            reader.read_at(frame * CHUNK_SIZE as u64, 1).unwrap();
            assert!(reader.cache.len() <= CHUNK_CACHE);
        }
        // The whole object reads back exactly, across every seam, in odd pieces.
        let mut all = Vec::new();
        let mut at = 0_u64;
        while at < plain.len() as u64 {
            let take = (777_777_u64).min(plain.len() as u64 - at) as usize;
            all.extend(reader.read_at(at, take).unwrap());
            at += take as u64;
        }
        assert_eq!(all, plain);
        // Past the end is refused, not clamped.
        assert!(matches!(
            reader.read_at(plain.len() as u64 - 1, 2),
            Err(VaultError::Invalid)
        ));
        assert!(matches!(
            reader.read_at(u64::MAX, 2),
            Err(VaultError::Invalid)
        ));
    }

    fn object_path(root: &Path, store: &VaultStore, record: Uuid) -> PathBuf {
        let guard = store.session();
        let name = guard
            .as_ref()
            .unwrap()
            .manifest
            .records
            .iter()
            .find(|r| r.id == record)
            .unwrap()
            .object_name
            .clone();
        root.join("vault").join("objects").join(name)
    }

    #[test]
    fn a_damaged_frame_is_refused_when_it_is_read_and_the_others_still_play() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record, plain) = stored_video(temp.path(), 4, 900_000);
        let path = object_path(temp.path(), &store, record);
        let mut bytes = fs::read(&path).unwrap();
        // One bit in the second frame's ciphertext.
        bytes[(OBJECT_HEADER_LEN + FRAME_LEN + 100) as usize] ^= 1;
        fs::write(&path, bytes).unwrap();
        let opened = store.playback_open(record).unwrap();
        // The first frame still serves.
        assert_eq!(
            serve(&store, &opened.token, Some("bytes=0-99"))
                .unwrap()
                .status,
            206
        );
        // A range inside the second frame does not, and says nothing about why.
        let (head_len, first_fragment) = {
            let tokens = store.playback.lock().unwrap();
            let head = &tokens[&opened.token].head;
            (head.bytes.len() as u64, head.first_fragment)
        };
        assert!(plain.len() > CHUNK_SIZE + 600);
        let start = head_len + (CHUNK_SIZE as u64 + 500 - first_fragment);
        assert_eq!(
            serve(
                &store,
                &opened.token,
                Some(&format!("bytes={start}-{}", start + 10))
            ),
            Err(PlaybackRefusal::Unreadable)
        );
    }

    /// Hiding a person (#360) takes their videos out of reach by id as well as out of the lists:
    /// playing one, or asking how it was added, answers as for a record the vault does not have,
    /// until the person is restored.
    #[test]
    fn a_hidden_persons_video_is_not_played_or_asked_about_by_its_id() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record, _) = stored_video(temp.path(), 2, 100_000);
        let person = store
            .snapshot()
            .unwrap()
            .records
            .iter()
            .find(|r| r.id == record)
            .unwrap()
            .profile_id;
        // A person must stay visible.
        store.create_profile("FAKE Other Person", 7).unwrap();
        assert!(store.playback_open(record).is_ok());
        assert!(store.added_with_camera(record).unwrap());
        store.hide_profile(person, 8).unwrap();
        assert!(matches!(
            store.playback_open(record),
            Err(VaultError::NotFound)
        ));
        assert!(matches!(
            store.added_with_camera(record),
            Err(VaultError::NotFound)
        ));
        store.restore_profile(person).unwrap();
        assert!(store.playback_open(record).is_ok());
        assert!(store.added_with_camera(record).unwrap());
    }

    /// Hiding a person ends the videos already playing from their documents, as hiding a single
    /// document does: a token opened before the hide serves nothing after it, and restoring the person
    /// does not bring the old token back (#360).
    #[test]
    fn hiding_a_person_ends_the_playback_already_open_from_their_video() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record, _) = stored_video(temp.path(), 2, 100_000);
        let person = store
            .snapshot()
            .unwrap()
            .records
            .iter()
            .find(|r| r.id == record)
            .unwrap()
            .profile_id;
        store.create_profile("FAKE Other Person", 7).unwrap();
        let opened = store.playback_open(record).unwrap();
        assert_eq!(
            serve(&store, &opened.token, Some("bytes=0-99"))
                .unwrap()
                .status,
            206
        );
        store.hide_profile(person, 8).unwrap();
        assert!(matches!(
            serve(&store, &opened.token, Some("bytes=0-99")),
            Err(PlaybackRefusal::UnknownToken)
        ));
        store.restore_profile(person).unwrap();
        assert!(matches!(
            serve(&store, &opened.token, Some("bytes=0-99")),
            Err(PlaybackRefusal::UnknownToken)
        ));
        // A new open works again.
        assert!(store.playback_open(record).is_ok());
    }

    #[test]
    fn an_object_cut_at_a_frame_boundary_or_extended_is_not_opened() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record, _) = stored_video(temp.path(), 4, 900_000);
        let path = object_path(temp.path(), &store, record);
        let original = fs::read(&path).unwrap();
        // Truncated exactly after the first frame: the manifest's size disagrees.
        fs::write(&path, &original[..(OBJECT_HEADER_LEN + FRAME_LEN) as usize]).unwrap();
        assert!(matches!(
            store.playback_open(record),
            Err(VaultError::Corrupt)
        ));
        // Cut in the middle of a frame.
        fs::write(&path, &original[..original.len() - 7]).unwrap();
        assert!(matches!(
            store.playback_open(record),
            Err(VaultError::Corrupt)
        ));
        // Extended.
        let mut longer = original.clone();
        longer.extend_from_slice(&[0; 64]);
        fs::write(&path, longer).unwrap();
        assert!(store.playback_open(record).is_err());
        // Whole again.
        fs::write(&path, original).unwrap();
        assert!(store.playback_open(record).is_ok());
    }

    #[test]
    fn a_record_that_is_not_a_video_is_not_opened() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _, _) = stored_video(temp.path(), 1, 1000);
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(
                profile,
                vec![],
                vec![ImportSource {
                    display_name: "FAKE note.pdf".to_owned(),
                    reader: Box::new(io::Cursor::new(vec![7_u8; 5000])),
                }],
                9,
            )
            .unwrap();
        let other = store
            .snapshot()
            .unwrap()
            .records
            .iter()
            .find(|r| r.display_name == "FAKE note.pdf")
            .unwrap()
            .id;
        assert!(matches!(
            store.playback_open(other),
            Err(VaultError::Invalid)
        ));
        assert!(matches!(
            store.playback_open(Uuid::new_v4()),
            Err(VaultError::NotFound)
        ));
        assert!(store.playback.lock().unwrap().is_empty());
    }

    // ---- serving ----------------------------------------------------------

    #[test]
    fn every_byte_of_the_served_file_comes_back_through_ranges() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record, plain) = stored_video(temp.path(), 4, 900_000);
        let expected = expected_served(&plain);
        let opened = store.playback_open(record).unwrap();
        assert_eq!(opened.total_bytes, expected.len() as u64);
        // From the start, as a player asks: `bytes=N-` and take what comes.
        let mut got = Vec::new();
        while (got.len() as u64) < opened.total_bytes {
            let reply = serve(
                &store,
                &opened.token,
                Some(&format!("bytes={}-", got.len())),
            )
            .unwrap();
            assert_eq!(reply.status, 206);
            let (start, end) = reply.range.unwrap();
            assert_eq!(start, got.len() as u64);
            assert_eq!(reply.body.len() as u64, end - start + 1);
            assert!(reply.body.len() as u64 <= MAX_RANGE_RESPONSE);
            assert_eq!(reply.total, opened.total_bytes);
            got.extend(reply.body);
        }
        assert_eq!(got, expected);
    }

    #[test]
    fn a_seek_into_the_middle_decrypts_the_frame_it_lands_in_and_not_the_ones_before() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record, plain) = stored_video(temp.path(), 4, 900_000);
        let expected = expected_served(&plain);
        let opened = store.playback_open(record).unwrap();
        // The head (ftyp, moov, sidx) then the fragments: a seek lands deep in one.
        let at = expected.len() as u64 - 1_200_000;
        let reply = serve(
            &store,
            &opened.token,
            Some(&format!("bytes={at}-{}", at + 99)),
        )
        .unwrap();
        assert_eq!(reply.status, 206);
        assert_eq!(reply.body, expected[at as usize..at as usize + 100]);
        assert_eq!(reply.range, Some((at, at + 99)));
        let decrypted = store
            .playback
            .lock()
            .unwrap()
            .get(&opened.token)
            .unwrap()
            .reader
            .decrypted;
        // The two frames that hold the open (the footer and head reads) and the
        // one frame the seek landed in: well under the whole object.
        assert!(decrypted <= 4, "{decrypted}");
        // The tail of the file, and a range that ends exactly at it.
        let last = serve(&store, &opened.token, Some("bytes=-10")).unwrap();
        assert_eq!(last.body, expected[expected.len() - 10..]);
        let edge = serve(
            &store,
            &opened.token,
            Some(&format!(
                "bytes={}-{}",
                expected.len() - 1,
                expected.len() + 500
            )),
        )
        .unwrap();
        assert_eq!(edge.body, expected[expected.len() - 1..]);
        // One past the end is unsatisfiable, with the size.
        let past = serve(
            &store,
            &opened.token,
            Some(&format!("bytes={}-", expected.len())),
        )
        .unwrap();
        assert_eq!(
            (past.status, past.total, past.body.len()),
            (416, expected.len() as u64, 0)
        );
    }

    #[test]
    fn a_range_that_crosses_from_the_head_into_the_fragments_is_seamless() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record, plain) = stored_video(temp.path(), 3, 5000);
        let expected = expected_served(&plain);
        let opened = store.playback_open(record).unwrap();
        let head_len = {
            let tokens = store.playback.lock().unwrap();
            tokens[&opened.token].head.bytes.len() as u64
        };
        let start = head_len - 20;
        let reply = serve(
            &store,
            &opened.token,
            Some(&format!("bytes={start}-{}", start + 39)),
        )
        .unwrap();
        assert_eq!(reply.body, expected[start as usize..start as usize + 40]);
        // And a HEAD says the same without a body.
        let head = store
            .playback_serve(
                &opened.token,
                Some(&format!("bytes={start}-{}", start + 39)),
                false,
            )
            .unwrap();
        assert_eq!(
            (head.status, head.range, head.body.len()),
            (206, reply.range, 0)
        );
    }

    #[test]
    fn a_hostile_range_reads_nothing_and_changes_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record, _) = stored_video(temp.path(), 3, 5000);
        let opened = store.playback_open(record).unwrap();
        let before = store
            .playback
            .lock()
            .unwrap()
            .get(&opened.token)
            .unwrap()
            .reader
            .decrypted;
        for range in [
            "bytes=0-1,2-3",
            "bytes=18446744073709551615-18446744073709551615",
            "bytes=-18446744073709551615",
            "bytes=9223372036854775808-",
            "bytes=5-1",
            "bytes=0-0,0-0,0-0,0-0,0-0,0-0,0-0,0-0,0-0,0-0",
            "bytes=-",
            "bytes=\u{1F4A5}",
        ] {
            let reply = serve(&store, &opened.token, Some(range));
            match reply {
                Ok(reply) if reply.status == 416 => assert!(reply.body.is_empty(), "{range:?}"),
                // `bytes=-N` of a huge N is the whole file, capped to one response.
                Ok(reply) => assert!(reply.body.len() as u64 <= MAX_RANGE_RESPONSE, "{range:?}"),
                Err(error) => panic!("{range:?}: {error:?}"),
            }
        }
        let after = store
            .playback
            .lock()
            .unwrap()
            .get(&opened.token)
            .unwrap()
            .reader
            .decrypted;
        // The unsatisfiable ones read nothing; the one that was satisfiable read
        // a bounded amount.
        assert!(after - before <= 2, "{before} {after}");
        // The token still works.
        assert_eq!(
            serve(&store, &opened.token, Some("bytes=0-3"))
                .unwrap()
                .status,
            206
        );
    }

    // ---- tokens -----------------------------------------------------------

    #[test]
    fn a_token_is_refused_after_a_lock_and_after_the_vault_is_opened_again() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record, _) = stored_video(temp.path(), 2, 5000);
        let opened = store.playback_open(record).unwrap();
        assert!(serve(&store, &opened.token, Some("bytes=0-9")).is_ok());
        store.lock();
        assert_eq!(
            serve(&store, &opened.token, Some("bytes=0-9")),
            Err(PlaybackRefusal::UnknownToken)
        );
        assert!(store.playback.lock().unwrap().is_empty());
        store.unlock(PASSWORD).unwrap();
        assert_eq!(
            serve(&store, &opened.token, Some("bytes=0-9")),
            Err(PlaybackRefusal::UnknownToken)
        );
    }

    #[test]
    fn a_token_is_refused_after_a_reset_and_after_a_poisoned_session() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record, _) = stored_video(temp.path(), 2, 5000);
        let opened = store.playback_open(record).unwrap();
        store.reset().unwrap();
        assert_eq!(
            serve(&store, &opened.token, Some("bytes=0-9")),
            Err(PlaybackRefusal::UnknownToken)
        );

        let temp = tempfile::tempdir().unwrap();
        let (store, record, _) = stored_video(temp.path(), 2, 5000);
        let store = Arc::new(store);
        let opened = store.playback_open(record).unwrap();
        let poisoner = Arc::clone(&store);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.unlocked.lock().unwrap();
            panic!("synthetic panic while holding the vault mutex");
        })
        .join();
        assert!(store.unlocked.is_poisoned());
        // Nothing else has touched the session: serving itself ends the playback.
        assert_eq!(
            serve(&store, &opened.token, Some("bytes=0-9")),
            Err(PlaybackRefusal::UnknownToken)
        );
        assert!(!store.unlocked.is_poisoned());
        assert!(store.playback.lock().unwrap().is_empty());
    }

    #[test]
    fn a_closed_token_and_an_invented_one_get_the_same_answer() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record, _) = stored_video(temp.path(), 2, 5000);
        let opened = store.playback_open(record).unwrap();
        store.playback_close(&opened.token);
        assert_eq!(
            serve(&store, &opened.token, None),
            Err(PlaybackRefusal::UnknownToken)
        );
        assert_eq!(
            serve(&store, &new_token(), None),
            Err(PlaybackRefusal::UnknownToken)
        );
        assert_eq!(
            serve(&store, "not a token", None),
            Err(PlaybackRefusal::UnknownToken)
        );
    }

    #[test]
    fn opening_more_videos_than_the_limit_ends_the_oldest() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record, _) = stored_video(temp.path(), 2, 5000);
        let tokens: Vec<_> = (0..MAX_OPEN_PLAYBACKS + 2)
            .map(|_| store.playback_open(record).unwrap().token.clone())
            .collect();
        assert_eq!(store.playback.lock().unwrap().len(), MAX_OPEN_PLAYBACKS);
        assert!(serve(&store, &tokens[0], None).is_err());
        assert!(serve(&store, &tokens[1], None).is_err());
        assert!(serve(&store, tokens.last().unwrap(), None).is_ok());
    }

    #[test]
    fn serving_bytes_is_not_activity_so_a_paused_player_buffering_ahead_holds_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record, _) = stored_video(temp.path(), 2, 5000);
        let opened = store.playback_open(record).unwrap();
        let unlocked = Instant::now();
        let due_unless_touched = unlocked
            + Duration::from_secs(15 * 60)
            + crate::idle::MARGIN
            + Duration::from_millis(40);
        std::thread::sleep(Duration::from_millis(120));
        assert!(serve(&store, &opened.token, Some("bytes=0-9")).is_ok());
        assert!(serve(&store, &opened.token, Some("bytes=100-199")).is_ok());
        // Nothing moved the deadline: it is where the unlock left it.
        assert!(store.idle().is_due(due_unless_touched));
    }

    #[test]
    fn hiding_a_document_ends_the_video_playing_from_it() {
        let temp = tempfile::tempdir().unwrap();
        let (store, record, _) = stored_video(temp.path(), 2, 5000);
        let kept = store.playback_open(record).unwrap();
        let other = {
            let profile = store.snapshot().unwrap().profiles[0].id;
            let id = store
                .recording_start(profile, vec![], "FAKE other.mp4", 7)
                .unwrap();
            let movie = [ftyp(), moov(), fragment(1, 0, 0, 3000)].concat();
            store.recording_append(id, &movie).unwrap();
            store.recording_stop(id, 8).unwrap().unwrap()
        };
        let elsewhere = store.playback_open(other).unwrap();
        store.hide_record(record, 9).unwrap();
        assert_eq!(
            serve(&store, &kept.token, None),
            Err(PlaybackRefusal::UnknownToken)
        );
        // Another document's video plays on.
        assert!(serve(&store, &elsewhere.token, None).is_ok());
    }
}

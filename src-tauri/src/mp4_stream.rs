//! A streaming reader and normaliser for the fragmented MP4 that a webview's
//! `MediaRecorder` writes (#359, the recording core).
//!
//! Pieces arrive about once a second, cut anywhere. This walks only the
//! top-level box headers and the small `moov` and `moof` boxes (buffered whole,
//! within fixed limits), never the samples, and it never decodes anything. What
//! it does on the way through:
//!
//! - keeps the first `ftyp` and the first `moov` and drops a repeated `ftyp`
//!   (WebKitGTK writes two);
//! - drops a `moof` that is not followed by its `mdat` (WebKitGTK writes one
//!   even without a pause), and every top-level box it does not know (`styp`,
//!   `sidx`, `mfra`, `free`, ...: the stored file gets its own index);
//! - renumbers the `mfhd` sequence numbers so that they only increase;
//! - closes the time gap a pause left: after [`Mp4Normaliser::mark_pause`] the
//!   next fragment's `tfdt` is moved back, in every track by the same number of
//!   seconds, so that a paused recording is one continuous video;
//! - notes where each complete fragment starts, how long it is and how many
//!   bytes it takes, for the index.
//!
//! It also writes the stored file's trailing index (`mcvx`, an ordinary
//! top-level box that players ignore) and builds the *synthetic head* the
//! playback address serves: the stored `ftyp` and `moov`, then a `sidx` made
//! from that index, so that an engine learns the length and the seek points
//! without reading the whole file (the PR 0 spike measured 80 to 88 percent of
//! a 60 s clip read before it could show a length, and 3 percent with a `sidx`).
//!
//! The stored bytes are never changed to make the head: the head is built when
//! a video is opened and stands in front of the stored fragments.

use std::fmt;

/// The most a `ftyp` may take. Real ones take 32 to 36 bytes.
const MAX_FTYP: usize = 4 * 1024;
/// The most a `moov` may take. Real ones take 0.7 to 1.2 KiB.
const MAX_MOOV: usize = 1024 * 1024;
/// The most a `moof` may take. Real ones take 0.2 to 0.7 KiB.
const MAX_MOOF: usize = 64 * 1024;
/// A pause that left a gap shorter than this (a tenth of a second) is jitter,
/// not a pause, and is left as the webview wrote it.
const GAP_TOLERANCE_DIVISOR: u64 = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mp4Error {
    /// Not a box sequence this reader accepts.
    Malformed,
    /// A box over its limit.
    TooLarge,
    /// A fragment before the `moov` that describes it.
    NoInit,
    /// A time that would go below zero or past 64 bits.
    Timeline,
}

impl fmt::Display for Mp4Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Malformed => "malformed MP4",
            Self::TooLarge => "an MP4 box is too large",
            Self::NoInit => "a fragment came before the movie header",
            Self::Timeline => "an MP4 time is out of range",
        })
    }
}

impl std::error::Error for Mp4Error {}

/// One track of the movie.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackInfo {
    pub id: u32,
    /// The handler type: `vide` or `soun`.
    pub handler: [u8; 4],
    pub timescale: u32,
    /// From the movie's `trex`, for fragments that give no sample durations.
    pub default_duration: u32,
}

impl TrackInfo {
    pub fn is_video(&self) -> bool {
        &self.handler == b"vide"
    }
    pub fn is_audio(&self) -> bool {
        &self.handler == b"soun"
    }
}

/// What the `moov` says.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct InitInfo {
    pub tracks: Vec<TrackInfo>,
}

impl InitInfo {
    pub fn has_video(&self) -> bool {
        self.tracks.iter().any(TrackInfo::is_video)
    }
    pub fn has_audio(&self) -> bool {
        self.tracks.iter().any(TrackInfo::is_audio)
    }
    /// The track the index follows: the video track, else the first.
    pub fn primary(&self) -> Option<&TrackInfo> {
        self.tracks
            .iter()
            .find(|track| track.is_video())
            .or_else(|| self.tracks.first())
    }
}

/// One complete fragment, in the stored stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FragmentEntry {
    /// Where its `moof` starts, in the stored bytes.
    pub offset: u64,
    /// The `moof` and the `mdat` together.
    pub size: u64,
    /// Its start, in the primary track's timescale.
    pub start: u64,
    /// Its length, in the same timescale.
    pub duration: u64,
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    bytes
        .get(at..at + 4)
        .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

fn be64(bytes: &[u8], at: usize) -> Option<u64> {
    bytes
        .get(at..at + 8)
        .map(|b| u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
}

/// The children of a box whose payload starts at `from` and ends at `to`.
fn children(
    bytes: &[u8],
    from: usize,
    to: usize,
) -> Result<Vec<(usize, usize, [u8; 4])>, Mp4Error> {
    let mut out = Vec::new();
    let mut at = from;
    while at + 8 <= to {
        let size = be32(bytes, at).ok_or(Mp4Error::Malformed)? as usize;
        if size < 8 || at + size > to {
            return Err(Mp4Error::Malformed);
        }
        let kind = [bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]];
        out.push((at, size, kind));
        at += size;
    }
    Ok(out)
}

fn find<'a>(
    list: &'a [(usize, usize, [u8; 4])],
    kind: &[u8; 4],
) -> Option<&'a (usize, usize, [u8; 4])> {
    list.iter().find(|(_, _, k)| k == kind)
}

/// Reads the tracks out of a whole `moov` box.
fn parse_moov(moov: &[u8]) -> Result<InitInfo, Mp4Error> {
    let top = children(moov, 8, moov.len())?;
    let mut tracks = Vec::new();
    for &(at, size, kind) in &top {
        if &kind != b"trak" {
            continue;
        }
        let parts = children(moov, at + 8, at + size)?;
        let tkhd = find(&parts, b"tkhd").ok_or(Mp4Error::Malformed)?;
        let version = *moov.get(tkhd.0 + 8).ok_or(Mp4Error::Malformed)?;
        let id =
            be32(moov, tkhd.0 + if version == 1 { 28 } else { 20 }).ok_or(Mp4Error::Malformed)?;
        let mdia = find(&parts, b"mdia").ok_or(Mp4Error::Malformed)?;
        let media = children(moov, mdia.0 + 8, mdia.0 + mdia.1)?;
        let mdhd = find(&media, b"mdhd").ok_or(Mp4Error::Malformed)?;
        let version = *moov.get(mdhd.0 + 8).ok_or(Mp4Error::Malformed)?;
        let timescale =
            be32(moov, mdhd.0 + if version == 1 { 28 } else { 20 }).ok_or(Mp4Error::Malformed)?;
        let hdlr = find(&media, b"hdlr").ok_or(Mp4Error::Malformed)?;
        let handler = moov
            .get(hdlr.0 + 16..hdlr.0 + 20)
            .ok_or(Mp4Error::Malformed)?;
        if timescale == 0 {
            return Err(Mp4Error::Malformed);
        }
        tracks.push(TrackInfo {
            id,
            handler: [handler[0], handler[1], handler[2], handler[3]],
            timescale,
            default_duration: 0,
        });
    }
    // The movie's defaults for fragments that give no sample durations.
    if let Some(mvex) = find(&top, b"mvex") {
        for (at, size, kind) in children(moov, mvex.0 + 8, mvex.0 + mvex.1)? {
            if &kind != b"trex" || size < 24 {
                continue;
            }
            let id = be32(moov, at + 12).ok_or(Mp4Error::Malformed)?;
            let duration = be32(moov, at + 20).ok_or(Mp4Error::Malformed)?;
            if let Some(track) = tracks.iter_mut().find(|t| t.id == id) {
                track.default_duration = duration;
            }
        }
    }
    if tracks.is_empty() {
        return Err(Mp4Error::Malformed);
    }
    Ok(InitInfo { tracks })
}

/// One track's part of a `moof`.
#[derive(Clone, Copy, Debug)]
struct TrafInfo {
    track_id: u32,
    /// Where the `tfdt` value sits in the `moof`, and its width.
    tfdt_at: usize,
    tfdt_wide: bool,
    tfdt: u64,
    duration: u64,
}

/// What the normaliser needs of a buffered `moof`.
#[derive(Debug)]
struct MoofInfo {
    /// Where the `mfhd` sequence number sits.
    sequence_at: usize,
    trafs: Vec<TrafInfo>,
}

fn parse_moof(moof: &[u8], init: &InitInfo) -> Result<MoofInfo, Mp4Error> {
    let top = children(moof, 8, moof.len())?;
    let mfhd = find(&top, b"mfhd").ok_or(Mp4Error::Malformed)?;
    if mfhd.1 < 16 {
        return Err(Mp4Error::Malformed);
    }
    let sequence_at = mfhd.0 + 12;
    let mut trafs = Vec::new();
    for &(at, size, kind) in &top {
        if &kind != b"traf" {
            continue;
        }
        let parts = children(moof, at + 8, at + size)?;
        let tfhd = find(&parts, b"tfhd").ok_or(Mp4Error::Malformed)?;
        let flags = be32(moof, tfhd.0 + 8).ok_or(Mp4Error::Malformed)? & 0x00ff_ffff;
        let track_id = be32(moof, tfhd.0 + 12).ok_or(Mp4Error::Malformed)?;
        // An explicit base data offset is an absolute position in the file the
        // pieces came from; the normaliser moves every fragment, so it would
        // point at the wrong bytes afterwards. MediaRecorder does not write one
        // (it uses default-base-is-moof), so one is refused, not rewritten.
        if flags & 0x01 != 0 {
            return Err(Mp4Error::Malformed);
        }
        // Optional fields, in order: sample description index (4), default
        // sample duration (4), default size (4), flags (4).
        let mut cursor = tfhd.0 + 16;
        if flags & 0x02 != 0 {
            cursor += 4;
        }
        let mut default_duration = init
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .map_or(0, |t| u64::from(t.default_duration));
        if flags & 0x08 != 0 {
            default_duration = u64::from(be32(moof, cursor).ok_or(Mp4Error::Malformed)?);
        }
        let tfdt = find(&parts, b"tfdt").ok_or(Mp4Error::Malformed)?;
        let wide = *moof.get(tfdt.0 + 8).ok_or(Mp4Error::Malformed)? == 1;
        let value = if wide {
            be64(moof, tfdt.0 + 12).ok_or(Mp4Error::Malformed)?
        } else {
            u64::from(be32(moof, tfdt.0 + 12).ok_or(Mp4Error::Malformed)?)
        };
        // The fragment's length: the sum of its runs' sample durations.
        let mut duration = 0_u64;
        for &(rat, rsize, rkind) in &parts {
            if &rkind != b"trun" {
                continue;
            }
            let flags = be32(moof, rat + 8).ok_or(Mp4Error::Malformed)? & 0x00ff_ffff;
            let count = be32(moof, rat + 12).ok_or(Mp4Error::Malformed)? as usize;
            let mut at = rat + 16;
            if flags & 0x01 != 0 {
                at += 4;
            }
            if flags & 0x04 != 0 {
                at += 4;
            }
            if flags & 0x100 != 0 {
                let each = 4
                    + if flags & 0x200 != 0 { 4 } else { 0 }
                    + if flags & 0x400 != 0 { 4 } else { 0 }
                    + if flags & 0x800 != 0 { 4 } else { 0 };
                if at + count.checked_mul(each).ok_or(Mp4Error::Malformed)? > rat + rsize {
                    return Err(Mp4Error::Malformed);
                }
                for sample in 0..count {
                    duration = duration
                        .checked_add(u64::from(
                            be32(moof, at + sample * each).ok_or(Mp4Error::Malformed)?,
                        ))
                        .ok_or(Mp4Error::Malformed)?;
                }
            } else {
                duration = (count as u64)
                    .checked_mul(default_duration)
                    .and_then(|more| duration.checked_add(more))
                    .ok_or(Mp4Error::Malformed)?;
            }
        }
        trafs.push(TrafInfo {
            track_id,
            tfdt_at: tfdt.0 + 12,
            tfdt_wide: wide,
            tfdt: value,
            duration,
        });
    }
    if trafs.is_empty() {
        return Err(Mp4Error::Malformed);
    }
    Ok(MoofInfo { sequence_at, trafs })
}

enum State {
    /// Collecting the 8 (or 16) bytes of a box header.
    Header,
    /// Collecting a whole box that is read (ftyp, moov, moof).
    Buffering { kind: [u8; 4], total: usize },
    /// Passing an `mdat`'s payload through.
    Streaming { remaining: u64 },
    /// Dropping a box.
    Skipping { remaining: u64 },
}

struct Pending {
    bytes: Vec<u8>,
    info: MoofInfo,
}

/// The normaliser. Feed it the webview's pieces with [`push`](Self::push); it
/// writes the normalised stream to the buffer it is given.
pub struct Mp4Normaliser {
    state: State,
    buffer: Vec<u8>,
    init: Option<InitInfo>,
    seen_ftyp: bool,
    pending: Option<Pending>,
    /// Bytes written so far: the stored stream's length.
    written: u64,
    /// Where the last complete fragment ended.
    complete_end: u64,
    /// Where the `moof` of the fragment being passed through starts, and how
    /// the entry for it will read.
    open_fragment: Option<FragmentEntry>,
    /// Whether the fragment being passed through carries the primary track (and
    /// so gets an index entry of its own): one without it is folded into the
    /// entry before it, or the one after, so the entries stay contiguous.
    open_counted: bool,
    /// Where uncounted fragments that came before any entry began.
    carry_offset: Option<u64>,
    entries: Vec<FragmentEntry>,
    next_sequence: u32,
    /// Per track, how much time has been taken out (by pauses), in its own
    /// timescale.
    shifts: Vec<(u32, u64)>,
    resume_pending: bool,
    /// Where the primary track's last fragment ended, after any shift.
    last_end: Option<u64>,
}

impl Default for Mp4Normaliser {
    fn default() -> Self {
        Self::new()
    }
}

impl Mp4Normaliser {
    pub fn new() -> Self {
        Self {
            state: State::Header,
            buffer: Vec::new(),
            init: None,
            seen_ftyp: false,
            pending: None,
            written: 0,
            complete_end: 0,
            open_fragment: None,
            open_counted: true,
            carry_offset: None,
            entries: Vec::new(),
            next_sequence: 1,
            shifts: Vec::new(),
            resume_pending: false,
            last_end: None,
        }
    }

    /// What the `moov` said, once it has been read.
    pub fn init(&self) -> Option<&InitInfo> {
        self.init.as_ref()
    }

    /// The stored stream's length so far.
    pub fn written(&self) -> u64 {
        self.written
    }

    /// Where the last complete fragment ended: the stream may be cut here.
    /// Zero until the `moov` and a first fragment are complete.
    pub fn complete_end(&self) -> u64 {
        self.complete_end
    }

    /// Where the first fragment starts (the end of `ftyp` and `moov`), once the
    /// first fragment is complete.
    pub fn head_end(&self) -> Option<u64> {
        self.entries.first().map(|entry| entry.offset)
    }

    /// The complete fragments, with their lengths made exact (a fragment whose
    /// runs gave no durations takes the gap to the next one's start).
    pub fn index(&self) -> Vec<FragmentEntry> {
        let mut entries = self.entries.clone();
        for at in 0..entries.len() {
            if entries[at].duration == 0 {
                entries[at].duration = match entries.get(at + 1) {
                    Some(next) => next.start.saturating_sub(entries[at].start),
                    None => at.checked_sub(1).map_or(0, |p| entries[p].duration),
                };
            }
        }
        entries
    }

    /// The next fragment starts after a pause: close the gap it left.
    pub fn mark_pause(&mut self) {
        self.resume_pending = true;
    }

    fn shift_of(&self, track: u32) -> u64 {
        self.shifts
            .iter()
            .find(|(id, _)| *id == track)
            .map_or(0, |(_, shift)| *shift)
    }

    fn add_shift(&mut self, track: u32, by: u64) {
        match self.shifts.iter_mut().find(|(id, _)| *id == track) {
            Some((_, shift)) => *shift = shift.saturating_add(by),
            None => self.shifts.push((track, by)),
        }
    }

    /// Feeds a piece. The normalised bytes are appended to `out`.
    pub fn push(&mut self, mut data: &[u8], out: &mut Vec<u8>) -> Result<(), Mp4Error> {
        while !data.is_empty() {
            match &mut self.state {
                State::Header => {
                    // A header is 8 bytes, or 16 when its size is 1.
                    let wanted: usize =
                        if self.buffer.len() >= 8 && be32(&self.buffer, 0) == Some(1) {
                            16
                        } else {
                            8
                        };
                    let take = wanted.saturating_sub(self.buffer.len()).min(data.len());
                    self.buffer.extend_from_slice(&data[..take]);
                    data = &data[take..];
                    let wanted = if self.buffer.len() >= 8 && be32(&self.buffer, 0) == Some(1) {
                        16
                    } else {
                        8
                    };
                    if self.buffer.len() < wanted {
                        continue;
                    }
                    self.start_box(out)?;
                }
                State::Buffering { total, .. } => {
                    let total = *total;
                    let take = (total - self.buffer.len()).min(data.len());
                    self.buffer.extend_from_slice(&data[..take]);
                    data = &data[take..];
                    if self.buffer.len() == total {
                        self.finish_buffered(out)?;
                    }
                }
                State::Streaming { remaining } => {
                    let take = (*remaining).min(data.len() as u64) as usize;
                    out.extend_from_slice(&data[..take]);
                    self.written += take as u64;
                    *remaining -= take as u64;
                    data = &data[take..];
                    if *remaining == 0 {
                        self.state = State::Header;
                        self.close_fragment();
                    }
                }
                State::Skipping { remaining } => {
                    let take = (*remaining).min(data.len() as u64) as usize;
                    *remaining -= take as u64;
                    data = &data[take..];
                    if *remaining == 0 {
                        self.state = State::Header;
                    }
                }
            }
        }
        Ok(())
    }

    /// The header is in `self.buffer`: decide what the box is.
    fn start_box(&mut self, out: &mut Vec<u8>) -> Result<(), Mp4Error> {
        let small = be32(&self.buffer, 0).ok_or(Mp4Error::Malformed)?;
        let kind = [
            self.buffer[4],
            self.buffer[5],
            self.buffer[6],
            self.buffer[7],
        ];
        let header = if small == 1 { 16 } else { 8 };
        let total = match small {
            0 => return Err(Mp4Error::Malformed),
            1 => be64(&self.buffer, 8).ok_or(Mp4Error::Malformed)?,
            n => u64::from(n),
        };
        if total < header as u64 {
            return Err(Mp4Error::Malformed);
        }
        let payload = total - header as u64;
        match &kind {
            b"ftyp" => {
                if total as usize > MAX_FTYP {
                    return Err(Mp4Error::TooLarge);
                }
                if self.seen_ftyp {
                    self.buffer.clear();
                    self.state = State::Skipping { remaining: payload };
                    return self.close_if_empty();
                }
                self.state = State::Buffering {
                    kind,
                    total: total as usize,
                };
            }
            b"moov" => {
                if total as usize > MAX_MOOV {
                    return Err(Mp4Error::TooLarge);
                }
                if self.init.is_some() {
                    self.buffer.clear();
                    self.state = State::Skipping { remaining: payload };
                    return self.close_if_empty();
                }
                self.state = State::Buffering {
                    kind,
                    total: total as usize,
                };
            }
            b"moof" => {
                if total as usize > MAX_MOOF {
                    return Err(Mp4Error::TooLarge);
                }
                if self.init.is_none() {
                    return Err(Mp4Error::NoInit);
                }
                // A moof still waiting for its mdat was an orphan.
                self.pending = None;
                self.state = State::Buffering {
                    kind,
                    total: total as usize,
                };
            }
            b"mdat" => {
                let Some(pending) = self.pending.take() else {
                    // An mdat with no moof: nothing describes it.
                    self.buffer.clear();
                    self.state = State::Skipping { remaining: payload };
                    return self.close_if_empty();
                };
                let offset = self.written;
                let (entry, counted) = self.emit_moof(pending, out)?;
                out.extend_from_slice(&self.buffer);
                self.written += self.buffer.len() as u64;
                self.buffer.clear();
                self.open_counted = counted;
                self.open_fragment = Some(FragmentEntry { offset, ..entry });
                self.state = State::Streaming { remaining: payload };
                if payload == 0 {
                    return self.close_if_empty();
                }
                return Ok(());
            }
            _ => {
                // Unknown, or one the stored file replaces (styp, sidx, mfra,
                // free, skip, udta, our own index).
                self.buffer.clear();
                self.state = State::Skipping { remaining: payload };
                return self.close_if_empty();
            }
        }
        Ok(())
    }

    /// A box with nothing after its header ends at once.
    fn close_if_empty(&mut self) -> Result<(), Mp4Error> {
        match self.state {
            State::Skipping { remaining: 0 } => self.state = State::Header,
            State::Streaming { remaining: 0 } => {
                self.state = State::Header;
                self.close_fragment();
            }
            _ => {}
        }
        Ok(())
    }

    /// The fragment being passed through is whole: index it. A fragment without
    /// the primary track has no entry of its own; its bytes are added to the
    /// entry before it (or, if none came yet, to the first one) so the entries
    /// still follow one another and the sidx built from them has no gap.
    fn close_fragment(&mut self) {
        let Some(entry) = self.open_fragment.take() else {
            return;
        };
        if self.open_counted {
            let offset = self.carry_offset.take().unwrap_or(entry.offset);
            self.entries.push(FragmentEntry {
                offset,
                size: self.written - offset,
                ..entry
            });
        } else if let Some(last) = self.entries.last_mut() {
            last.size = self.written - last.offset;
        } else if self.carry_offset.is_none() {
            self.carry_offset = Some(entry.offset);
        }
        self.complete_end = self.written;
    }

    /// A buffered box is whole.
    fn finish_buffered(&mut self, out: &mut Vec<u8>) -> Result<(), Mp4Error> {
        let State::Buffering { kind, .. } = self.state else {
            return Ok(());
        };
        self.state = State::Header;
        let bytes = std::mem::take(&mut self.buffer);
        match &kind {
            b"ftyp" => {
                self.seen_ftyp = true;
                self.written += bytes.len() as u64;
                out.extend_from_slice(&bytes);
            }
            b"moov" => {
                self.init = Some(parse_moov(&bytes)?);
                self.written += bytes.len() as u64;
                out.extend_from_slice(&bytes);
            }
            b"moof" => {
                let init = self.init.as_ref().ok_or(Mp4Error::NoInit)?;
                let info = parse_moof(&bytes, init)?;
                self.pending = Some(Pending { bytes, info });
            }
            _ => {}
        }
        Ok(())
    }

    /// Writes a pending `moof`, renumbered and with its times moved, into
    /// `out`, and says where its fragment starts in time. The caller fills in
    /// the offset and, at the end of the `mdat`, the size.
    fn emit_moof(
        &mut self,
        pending: Pending,
        out: &mut Vec<u8>,
    ) -> Result<(FragmentEntry, bool), Mp4Error> {
        let Pending { mut bytes, info } = pending;
        let init = self.init.clone().ok_or(Mp4Error::NoInit)?;
        let primary = init.primary().ok_or(Mp4Error::NoInit)?.clone();
        // Only a fragment with the primary track is timed and indexed in the
        // primary's timescale. One without it (rare) is passed through with its
        // tracks' shifts applied, but never timed from another track's clock.
        let lead = info
            .trafs
            .iter()
            .find(|t| t.track_id == primary.id)
            .copied();
        let counted = lead.is_some();
        let lead = lead.unwrap_or(TrafInfo {
            track_id: primary.id,
            tfdt_at: 0,
            tfdt_wide: false,
            tfdt: 0,
            duration: 0,
        });
        let lead_track = primary.clone();
        if counted && self.resume_pending {
            self.resume_pending = false;
            if let Some(last_end) = self.last_end {
                let candidate = lead
                    .tfdt
                    .checked_sub(self.shift_of(lead.track_id))
                    .ok_or(Mp4Error::Timeline)?;
                let tolerance = u64::from(lead_track.timescale) / GAP_TOLERANCE_DIVISOR;
                if candidate > last_end.saturating_add(tolerance) {
                    let gap = candidate - last_end;
                    // The same real time out of every track, in its own scale.
                    for track in &init.tracks {
                        let ticks = (u128::from(gap) * u128::from(track.timescale)
                            + u128::from(lead_track.timescale) / 2)
                            / u128::from(lead_track.timescale);
                        let ticks = u64::try_from(ticks).map_err(|_| Mp4Error::Timeline)?;
                        self.add_shift(track.id, ticks);
                    }
                }
            }
        }
        // The sequence number only goes up.
        bytes[info.sequence_at..info.sequence_at + 4]
            .copy_from_slice(&self.next_sequence.to_be_bytes());
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(Mp4Error::Timeline)?;
        let mut start = 0;
        let mut duration = 0;
        for traf in &info.trafs {
            let moved = traf
                .tfdt
                .checked_sub(self.shift_of(traf.track_id))
                .ok_or(Mp4Error::Timeline)?;
            if traf.tfdt_wide {
                bytes[traf.tfdt_at..traf.tfdt_at + 8].copy_from_slice(&moved.to_be_bytes());
            } else {
                let narrow = u32::try_from(moved).map_err(|_| Mp4Error::Timeline)?;
                bytes[traf.tfdt_at..traf.tfdt_at + 4].copy_from_slice(&narrow.to_be_bytes());
            }
            if counted && traf.track_id == lead.track_id {
                start = moved;
                duration = traf.duration;
            }
        }
        if counted {
            self.last_end = Some(start.checked_add(duration).ok_or(Mp4Error::Timeline)?);
        }
        self.written += bytes.len() as u64;
        out.extend_from_slice(&bytes);
        Ok((
            FragmentEntry {
                offset: 0,
                size: 0,
                start,
                duration,
            },
            counted,
        ))
    }
}

// ---- the stored file's trailing index -------------------------------------

/// What the trailing index holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedIndex {
    pub track_id: u32,
    pub timescale: u32,
    pub entries: Vec<FragmentEntry>,
}

const INDEX_BOX: &[u8; 4] = b"mcvx";
const INDEX_FOOTER: &[u8; 4] = b"mcve";
/// The footer: size 12, `mcve`, then the length of the index box before it.
pub const INDEX_FOOTER_LEN: usize = 12;
const ENTRY_LEN: usize = 8 + 4 + 8 + 4;

/// The bytes appended to the stored stream when a recording ends: an `mcvx` box
/// (version, the primary track's id and timescale, the entries) and the
/// 12-byte footer that says how long it is, so that it is found from the end.
/// Both are well-formed top-level boxes, which a player skips.
pub fn index_trailer(init: &InitInfo, entries: &[FragmentEntry]) -> Result<Vec<u8>, Mp4Error> {
    let primary = init.primary().ok_or(Mp4Error::NoInit)?;
    let size = 8 + 4 + 4 + 4 + 4 + entries.len() * ENTRY_LEN;
    let mut bytes = Vec::with_capacity(size + INDEX_FOOTER_LEN);
    bytes.extend_from_slice(
        &u32::try_from(size)
            .map_err(|_| Mp4Error::TooLarge)?
            .to_be_bytes(),
    );
    bytes.extend_from_slice(INDEX_BOX);
    bytes.extend_from_slice(&1_u32.to_be_bytes()); // version 1, no flags
    bytes.extend_from_slice(&primary.id.to_be_bytes());
    bytes.extend_from_slice(&primary.timescale.to_be_bytes());
    bytes.extend_from_slice(
        &u32::try_from(entries.len())
            .map_err(|_| Mp4Error::TooLarge)?
            .to_be_bytes(),
    );
    for entry in entries {
        bytes.extend_from_slice(&entry.offset.to_be_bytes());
        bytes.extend_from_slice(
            &u32::try_from(entry.size)
                .map_err(|_| Mp4Error::TooLarge)?
                .to_be_bytes(),
        );
        bytes.extend_from_slice(&entry.start.to_be_bytes());
        bytes.extend_from_slice(
            &u32::try_from(entry.duration)
                .map_err(|_| Mp4Error::TooLarge)?
                .to_be_bytes(),
        );
    }
    bytes.extend_from_slice(&12_u32.to_be_bytes());
    bytes.extend_from_slice(INDEX_FOOTER);
    bytes.extend_from_slice(
        &u32::try_from(size)
            .map_err(|_| Mp4Error::TooLarge)?
            .to_be_bytes(),
    );
    Ok(bytes)
}

/// How long the whole trailing index is, from the stored file's last
/// [`INDEX_FOOTER_LEN`] bytes: the caller then reads that many bytes from the
/// end.
pub fn trailer_length(footer: &[u8]) -> Result<usize, Mp4Error> {
    if footer.len() != INDEX_FOOTER_LEN
        || be32(footer, 0) != Some(12)
        || &footer[4..8] != INDEX_FOOTER
    {
        return Err(Mp4Error::Malformed);
    }
    let size = be32(footer, 8).ok_or(Mp4Error::Malformed)? as usize;
    Ok(size + INDEX_FOOTER_LEN)
}

/// Reads the trailing index from the last `trailer_length` bytes.
pub fn parse_index_trailer(trailer: &[u8]) -> Result<ParsedIndex, Mp4Error> {
    let footer_at = trailer
        .len()
        .checked_sub(INDEX_FOOTER_LEN)
        .ok_or(Mp4Error::Malformed)?;
    let size = trailer_length(&trailer[footer_at..])? - INDEX_FOOTER_LEN;
    if size != footer_at
        || be32(trailer, 0) != Some(size as u32)
        || &trailer[4..8] != INDEX_BOX
        || be32(trailer, 8) != Some(1)
    {
        return Err(Mp4Error::Malformed);
    }
    let track_id = be32(trailer, 12).ok_or(Mp4Error::Malformed)?;
    let timescale = be32(trailer, 16).ok_or(Mp4Error::Malformed)?;
    let count = be32(trailer, 20).ok_or(Mp4Error::Malformed)? as usize;
    if 24 + count.checked_mul(ENTRY_LEN).ok_or(Mp4Error::Malformed)? != size || timescale == 0 {
        return Err(Mp4Error::Malformed);
    }
    let mut entries = Vec::with_capacity(count);
    for n in 0..count {
        let at = 24 + n * ENTRY_LEN;
        entries.push(FragmentEntry {
            offset: be64(trailer, at).ok_or(Mp4Error::Malformed)?,
            size: u64::from(be32(trailer, at + 8).ok_or(Mp4Error::Malformed)?),
            start: be64(trailer, at + 12).ok_or(Mp4Error::Malformed)?,
            duration: u64::from(be32(trailer, at + 20).ok_or(Mp4Error::Malformed)?),
        });
    }
    // The fragments follow one another from the first, and end where the
    // index begins.
    for pair in entries.windows(2) {
        if pair[0].offset.checked_add(pair[0].size) != Some(pair[1].offset) {
            return Err(Mp4Error::Malformed);
        }
    }
    Ok(ParsedIndex {
        track_id,
        timescale,
        entries,
    })
}

// ---- the synthetic head -----------------------------------------------------

/// The stored file's `ftyp` and `moov`, then a `sidx` made from the index.
/// Playback serves this in front of the stored fragments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VirtualHead {
    /// `ftyp`, `moov`, `sidx`.
    pub bytes: Vec<u8>,
    /// How many of those bytes are the stored file's own head.
    pub stored_head_len: u64,
    /// Where the first fragment starts in the stored file (equal to
    /// `stored_head_len`).
    pub first_fragment: u64,
    /// Where the last fragment ends in the stored file.
    pub media_end: u64,
}

/// Where a byte of the served file comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// A byte of the head.
    Head(usize),
    /// A byte of the stored file.
    Stored(u64),
}

impl VirtualHead {
    /// The served file's length: the head, then the fragments.
    pub fn total_len(&self) -> u64 {
        self.bytes.len() as u64 + (self.media_end - self.first_fragment)
    }

    /// Where byte `at` of the served file comes from. The head is
    /// `sidx_len` bytes longer than the stored head; the fragments sit after
    /// it, so the stored offset is the served one less that difference.
    pub fn locate(&self, at: u64) -> Option<Source> {
        if at >= self.total_len() {
            return None;
        }
        let head = self.bytes.len() as u64;
        if at < head {
            Some(Source::Head(at as usize))
        } else {
            Some(Source::Stored(at - head + self.first_fragment))
        }
    }
}

/// Builds the head from the stored file's first bytes (at least up to the first
/// fragment) and its index.
pub fn build_virtual_head(
    stored_start: &[u8],
    index: &ParsedIndex,
) -> Result<VirtualHead, Mp4Error> {
    let first = index.entries.first().ok_or(Mp4Error::Malformed)?;
    let last = index.entries.last().ok_or(Mp4Error::Malformed)?;
    let head_len = usize::try_from(first.offset).map_err(|_| Mp4Error::TooLarge)?;
    if head_len > stored_start.len() || head_len > MAX_FTYP + MAX_MOOV {
        return Err(Mp4Error::Malformed);
    }
    let mut bytes = stored_start[..head_len].to_vec();
    // sidx, version 0: the first fragment follows it at once. A sidx holds at
    // most 65,535 references; a longer recording (about 18 hours at one
    // fragment a second) groups consecutive fragments under one reference, so
    // seeking there lands on a group's start, a few seconds from the target,
    // instead of the recording being refused.
    let group = index.entries.len().div_ceil(usize::from(u16::MAX));
    let references: Vec<(u64, u64)> = index
        .entries
        .chunks(group.max(1))
        .map(|run| {
            let size = run.iter().try_fold(0_u64, |sum, e| sum.checked_add(e.size));
            let duration = run
                .iter()
                .try_fold(0_u64, |sum, e| sum.checked_add(e.duration));
            size.zip(duration).ok_or(Mp4Error::TooLarge)
        })
        .collect::<Result<_, _>>()?;
    let count = u16::try_from(references.len()).map_err(|_| Mp4Error::TooLarge)?;
    let size = 32 + usize::from(count) * 12;
    bytes.extend_from_slice(&(size as u32).to_be_bytes());
    bytes.extend_from_slice(b"sidx");
    bytes.extend_from_slice(&0_u32.to_be_bytes());
    bytes.extend_from_slice(&index.track_id.to_be_bytes());
    bytes.extend_from_slice(&index.timescale.to_be_bytes());
    bytes.extend_from_slice(
        &u32::try_from(first.start)
            .map_err(|_| Mp4Error::Timeline)?
            .to_be_bytes(),
    );
    bytes.extend_from_slice(&0_u32.to_be_bytes()); // first offset
    bytes.extend_from_slice(&0_u16.to_be_bytes());
    bytes.extend_from_slice(&count.to_be_bytes());
    for (size, duration) in references {
        let referenced = u32::try_from(size).map_err(|_| Mp4Error::TooLarge)?;
        if referenced >= 0x8000_0000 {
            return Err(Mp4Error::TooLarge);
        }
        bytes.extend_from_slice(&referenced.to_be_bytes()); // reference type 0: media
        bytes.extend_from_slice(
            &u32::try_from(duration)
                .map_err(|_| Mp4Error::Timeline)?
                .to_be_bytes(),
        );
        bytes.extend_from_slice(&0x9000_0000_u32.to_be_bytes()); // starts with SAP, type 1
    }
    Ok(VirtualHead {
        bytes,
        stored_head_len: head_len as u64,
        first_fragment: first.offset,
        media_end: last
            .offset
            .checked_add(last.size)
            .ok_or(Mp4Error::Malformed)?,
    })
}

#[cfg(test)]
pub(crate) mod fake {
    //! FAKE movies built from boxes, for tests here and in the recording core.
    #[allow(unused_imports)]
    use super::*;

    // ---- a FAKE movie built from boxes --------------------------------------

    pub(crate) fn boxed(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(payload);
        out
    }

    pub(crate) fn full(kind: &[u8; 4], version: u8, flags: u32, payload: &[u8]) -> Vec<u8> {
        let mut body = vec![version];
        body.extend_from_slice(&flags.to_be_bytes()[1..]);
        body.extend_from_slice(payload);
        boxed(kind, &body)
    }

    pub(crate) fn ftyp() -> Vec<u8> {
        boxed(b"ftyp", b"isom\0\0\0\0isomiso6")
    }

    pub(crate) fn trak(id: u32, handler: &[u8; 4], timescale: u32) -> Vec<u8> {
        let mut tkhd = vec![0; 8];
        tkhd.extend_from_slice(&id.to_be_bytes());
        tkhd.extend_from_slice(&[0; 68]);
        let mut mdhd = vec![0; 8];
        mdhd.extend_from_slice(&timescale.to_be_bytes());
        mdhd.extend_from_slice(&[0; 8]);
        let mut hdlr = vec![0; 4];
        hdlr.extend_from_slice(handler);
        hdlr.extend_from_slice(&[0; 12]);
        let media = [full(b"mdhd", 0, 0, &mdhd), full(b"hdlr", 0, 0, &hdlr)].concat();
        boxed(
            b"trak",
            &[full(b"tkhd", 0, 0, &tkhd), boxed(b"mdia", &media)].concat(),
        )
    }

    pub(crate) fn trex(id: u32, duration: u32) -> Vec<u8> {
        let mut payload = id.to_be_bytes().to_vec();
        payload.extend_from_slice(&1_u32.to_be_bytes()); // sample description
        payload.extend_from_slice(&duration.to_be_bytes());
        payload.extend_from_slice(&[0; 8]);
        full(b"trex", 0, 0, &payload)
    }

    /// Video (id 1, 30000/s, 1000 a frame) and sound (id 2, 48000/s, 1024 a sample).
    pub(crate) fn moov() -> Vec<u8> {
        boxed(
            b"moov",
            &[
                trak(1, b"vide", 30000),
                trak(2, b"soun", 48000),
                boxed(b"mvex", &[trex(1, 1000), trex(2, 1024)].concat()),
            ]
            .concat(),
        )
    }

    pub(crate) fn traf(
        id: u32,
        tfdt: u64,
        wide: bool,
        samples: &[u32],
        with_durations: bool,
    ) -> Vec<u8> {
        let tfhd = full(b"tfhd", 0, 0x0002_0000, &id.to_be_bytes());
        let tfdt = if wide {
            full(b"tfdt", 1, 0, &tfdt.to_be_bytes())
        } else {
            full(b"tfdt", 0, 0, &(tfdt as u32).to_be_bytes())
        };
        let mut run = (samples.len() as u32).to_be_bytes().to_vec();
        run.extend_from_slice(&0_u32.to_be_bytes()); // data offset
        let flags = if with_durations { 0x201 } else { 0x200 };
        for duration in samples {
            if with_durations {
                run.extend_from_slice(&duration.to_be_bytes());
            }
            run.extend_from_slice(&100_u32.to_be_bytes()); // size
        }
        boxed(
            b"traf",
            &[tfhd, tfdt, full(b"trun", 0, flags, &run)].concat(),
        )
    }

    /// A fragment: a `moof` with the sequence number and the tracks' starts, and
    /// an `mdat` of `payload` bytes.
    pub(crate) fn fragment(
        sequence: u32,
        video_start: u64,
        audio_start: u64,
        payload: usize,
    ) -> Vec<u8> {
        let mfhd = full(b"mfhd", 0, 0, &sequence.to_be_bytes());
        let moof = boxed(
            b"moof",
            &[
                mfhd,
                traf(1, video_start, false, &[1000; 30], true),
                traf(2, audio_start, true, &[1024; 47], false),
            ]
            .concat(),
        );
        [moof, boxed(b"mdat", &vec![0xAB; payload])].concat()
    }
}

#[cfg(test)]
mod tests {
    use super::fake::*;
    use super::*;

    fn run(stream: &[u8], piece: usize) -> (Mp4Normaliser, Vec<u8>) {
        let mut normaliser = Mp4Normaliser::new();
        let mut out = Vec::new();
        for part in stream.chunks(piece) {
            normaliser.push(part, &mut out).unwrap();
        }
        (normaliser, out)
    }

    fn clean() -> Vec<u8> {
        [
            ftyp(),
            moov(),
            fragment(1, 0, 0, 5000),
            fragment(2, 30000, 48128, 5000),
            fragment(3, 60000, 96256, 5000),
        ]
        .concat()
    }

    #[test]
    fn a_clean_stream_passes_through_byte_for_byte() {
        let stream = clean();
        let (normaliser, out) = run(&stream, stream.len());
        assert_eq!(out, stream);
        assert_eq!(normaliser.complete_end(), stream.len() as u64);
        let init = normaliser.init().unwrap();
        assert!(init.has_video() && init.has_audio());
        assert_eq!(init.primary().unwrap().id, 1);
    }

    #[test]
    fn the_output_does_not_depend_on_where_the_pieces_are_cut() {
        let stream = clean();
        let (_, whole) = run(&stream, stream.len());
        for piece in [1, 3, 7, 13, 64, 1000] {
            let (_, cut) = run(&stream, piece);
            assert_eq!(cut, whole, "pieces of {piece}");
        }
    }

    #[test]
    fn a_repeated_ftyp_and_an_orphan_moof_are_dropped_and_sequences_renumbered() {
        let orphan = {
            let mfhd = full(b"mfhd", 0, 0, &2_u32.to_be_bytes());
            boxed(
                b"moof",
                &[
                    mfhd,
                    traf(1, 30000, false, &[1000; 30], true),
                    traf(2, 48128, true, &[1024; 47], false),
                ]
                .concat(),
            )
        };
        let messy = [
            ftyp(),
            ftyp(),
            moov(),
            fragment(1, 0, 0, 800),
            orphan,
            fragment(2, 30000, 48128, 800),
        ]
        .concat();
        let (normaliser, out) = run(&messy, 17);
        let expected = [
            ftyp(),
            moov(),
            fragment(1, 0, 0, 800),
            fragment(2, 30000, 48128, 800),
        ]
        .concat();
        assert_eq!(out, expected);
        assert_eq!(normaliser.index().len(), 2);
    }

    #[test]
    fn unknown_boxes_and_a_second_moov_are_dropped() {
        let stream = [
            boxed(b"styp", b"msdh"),
            ftyp(),
            moov(),
            boxed(b"free", &[0; 20]),
            moov(),
            fragment(1, 0, 0, 100),
            boxed(b"sidx", &[0; 40]),
            boxed(b"mfra", &[0; 16]),
        ]
        .concat();
        let (_, out) = run(&stream, 9);
        assert_eq!(out, [ftyp(), moov(), fragment(1, 0, 0, 100)].concat());
    }

    #[test]
    fn a_torn_tail_ends_at_the_last_complete_fragment() {
        let whole = clean();
        let cut = whole.len() - 2000; // inside the last mdat
        let (normaliser, out) = run(&whole[..cut], 4096);
        let complete = [
            ftyp(),
            moov(),
            fragment(1, 0, 0, 5000),
            fragment(2, 30000, 48128, 5000),
        ]
        .concat();
        assert_eq!(normaliser.complete_end(), complete.len() as u64);
        assert!(out.len() as u64 > normaliser.complete_end());
        assert_eq!(&out[..complete.len()], &complete[..]);
        assert_eq!(normaliser.index().len(), 2);
        // A moof that never got its mdat is not complete either.
        let moof_only = [ftyp(), moov(), fragment(1, 0, 0, 10)].concat();
        let extra = &fragment(2, 30000, 48128, 10)[..60];
        let (normaliser, _) = run(&[moof_only.clone(), extra.to_vec()].concat(), 7);
        assert_eq!(normaliser.complete_end(), moof_only.len() as u64);
    }

    #[test]
    fn no_fragment_complete_means_no_cut_point() {
        let (normaliser, _) = run(&[ftyp(), moov()].concat(), 5);
        assert_eq!(normaliser.complete_end(), 0);
        assert!(normaliser.index().is_empty());
    }

    #[test]
    fn a_pause_that_left_a_gap_is_closed_in_every_track() {
        // One second recorded, a 1.5 s pause, then the next fragment: the
        // webview wrote its times 1.5 s late (45000 ticks of 30000, 72000 of 48000).
        let gap_video = 45000;
        let gap_audio = 72000;
        let stream = [
            ftyp(),
            moov(),
            fragment(1, 0, 0, 100),
            fragment(2, 30000 + gap_video, 48128 + gap_audio, 100),
            fragment(3, 60000 + gap_video, 96256 + gap_audio, 100),
        ]
        .concat();
        let mut normaliser = Mp4Normaliser::new();
        let mut out = Vec::new();
        let first = ftyp().len() + moov().len() + fragment(1, 0, 0, 100).len();
        normaliser.push(&stream[..first], &mut out).unwrap();
        normaliser.mark_pause();
        normaliser.push(&stream[first..], &mut out).unwrap();
        let expected = [
            ftyp(),
            moov(),
            fragment(1, 0, 0, 100),
            fragment(2, 30000, 48128, 100),
            fragment(3, 60000, 96256, 100),
        ]
        .concat();
        assert_eq!(out, expected);
        let index = normaliser.index();
        assert_eq!(index[1].start, 30000);
        assert_eq!(index[2].start, 60000);
    }

    #[test]
    fn a_pause_that_left_no_gap_changes_nothing() {
        let stream = clean();
        let mut normaliser = Mp4Normaliser::new();
        let mut out = Vec::new();
        let first = ftyp().len() + moov().len() + fragment(1, 0, 0, 5000).len();
        normaliser.push(&stream[..first], &mut out).unwrap();
        normaliser.mark_pause();
        normaliser.push(&stream[first..], &mut out).unwrap();
        assert_eq!(out, stream);
    }

    #[test]
    fn without_a_pause_a_gap_is_left_alone() {
        let stream = [
            ftyp(),
            moov(),
            fragment(1, 0, 0, 10),
            fragment(2, 30000 + 45000, 48128 + 72000, 10),
        ]
        .concat();
        let (_, out) = run(&stream, 11);
        assert_eq!(out, stream);
    }

    #[test]
    fn a_fragment_before_the_movie_header_is_refused() {
        let mut normaliser = Mp4Normaliser::new();
        let mut out = Vec::new();
        assert_eq!(
            normaliser.push(&[ftyp(), fragment(1, 0, 0, 10)].concat(), &mut out),
            Err(Mp4Error::NoInit)
        );
    }

    #[test]
    fn boxes_that_are_too_small_or_too_big_are_refused() {
        let mut out = Vec::new();
        assert_eq!(
            Mp4Normaliser::new().push(&[0, 0, 0, 4, b'f', b't', b'y', b'p'], &mut out),
            Err(Mp4Error::Malformed)
        );
        let mut huge = Vec::new();
        huge.extend_from_slice(&(MAX_MOOF as u32 + 100).to_be_bytes());
        huge.extend_from_slice(b"moof");
        let mut normaliser = Mp4Normaliser::new();
        normaliser
            .push(&[ftyp(), moov()].concat(), &mut out)
            .unwrap();
        assert_eq!(normaliser.push(&huge, &mut out), Err(Mp4Error::TooLarge));
        // A size of zero ("to the end") is not accepted for a recording.
        assert_eq!(
            Mp4Normaliser::new().push(&[0, 0, 0, 0, b'm', b'd', b'a', b't'], &mut out),
            Err(Mp4Error::Malformed)
        );
    }

    #[test]
    fn a_wide_mdat_header_is_read() {
        let payload = vec![7_u8; 50];
        let mut mdat = 1_u32.to_be_bytes().to_vec();
        mdat.extend_from_slice(b"mdat");
        mdat.extend_from_slice(&((16 + payload.len()) as u64).to_be_bytes());
        mdat.extend_from_slice(&payload);
        let moof = fragment(1, 0, 0, 0);
        let moof = &moof[..moof.len() - 8]; // without its empty mdat
        let stream = [ftyp(), moov(), moof.to_vec(), mdat.clone()].concat();
        let (normaliser, out) = run(&stream, 5);
        assert_eq!(out, stream);
        assert_eq!(normaliser.index().len(), 1);
        assert_eq!(normaliser.index()[0].size, (moof.len() + mdat.len()) as u64);
    }

    #[test]
    fn durations_come_from_the_runs_or_the_movie_defaults() {
        let (normaliser, _) = run(&clean(), 100);
        let index = normaliser.index();
        // 30 frames of 1000 at 30000/s: one second a fragment.
        assert!(index.iter().all(|entry| entry.duration == 30000));
        assert_eq!(index[0].start, 0);
        assert_eq!(index[2].start, 60000);
        // The sound track gives no per-sample durations and falls back to trex:
        // 47 samples of 1024 = 48128 ticks of 48000/s.
        let mut audio_led = Mp4Normaliser::new();
        let mut out = Vec::new();
        audio_led.push(&clean(), &mut out).unwrap();
        assert!(audio_led.init().unwrap().tracks[1].default_duration == 1024);
    }

    // ---- the trailing index and the synthetic head ---------------------------

    fn parsed(stream: &[u8]) -> (Mp4Normaliser, Vec<u8>, ParsedIndex) {
        let (normaliser, out) = run(stream, 100);
        let trailer = index_trailer(normaliser.init().unwrap(), &normaliser.index()).unwrap();
        let length = trailer_length(&trailer[trailer.len() - INDEX_FOOTER_LEN..]).unwrap();
        assert_eq!(length, trailer.len());
        let index = parse_index_trailer(&trailer).unwrap();
        (normaliser, out, index)
    }

    #[test]
    fn the_trailing_index_round_trips_and_is_found_from_the_end() {
        let (normaliser, _, index) = parsed(&clean());
        assert_eq!(index.track_id, 1);
        assert_eq!(index.timescale, 30000);
        assert_eq!(index.entries, normaliser.index());
        // Another reader of the stored file sees well-formed boxes at the end.
        let trailer = index_trailer(normaliser.init().unwrap(), &normaliser.index()).unwrap();
        let top = children(&trailer, 0, trailer.len()).unwrap();
        assert_eq!(top.len(), 2);
        assert_eq!(&top[0].2, INDEX_BOX);
        assert_eq!(&top[1].2, INDEX_FOOTER);
    }

    #[test]
    fn a_damaged_trailer_is_refused() {
        let (normaliser, _, _) = parsed(&clean());
        let trailer = index_trailer(normaliser.init().unwrap(), &normaliser.index()).unwrap();
        assert!(trailer_length(&trailer[trailer.len() - 11..]).is_err());
        let mut bad = trailer.clone();
        bad[9] = 9; // the version
        assert!(parse_index_trailer(&bad).is_err());
        let mut bad = trailer.clone();
        let footer = bad.len() - 4;
        bad[footer] ^= 1; // the length it claims
        assert!(parse_index_trailer(&bad).is_err());
        // Fragments that do not follow one another are not an index.
        let mut gapped = normaliser.index();
        gapped[1].offset += 1;
        let broken = index_trailer(normaliser.init().unwrap(), &gapped).unwrap();
        assert!(parse_index_trailer(&broken).is_err());
    }

    #[test]
    fn the_synthetic_head_adds_a_sidx_and_maps_every_byte() {
        let stream = clean();
        let (_, out, index) = parsed(&stream);
        let head = build_virtual_head(&out, &index).unwrap();
        let stored_head = ftyp().len() + moov().len();
        assert_eq!(head.stored_head_len, stored_head as u64);
        assert_eq!(&head.bytes[..stored_head], &out[..stored_head]);
        let sidx = &head.bytes[stored_head..];
        assert_eq!(&sidx[4..8], b"sidx");
        assert_eq!(be32(sidx, 0), Some(sidx.len() as u32));
        assert_eq!(be32(sidx, 12), Some(1)); // reference id: the video track
        assert_eq!(be32(sidx, 16), Some(30000)); // timescale
        assert_eq!(sidx.len(), 32 + 3 * 12);
        // Its references cover the fragments exactly.
        let referenced: u64 = (0..3)
            .map(|n| u64::from(be32(sidx, 32 + n * 12).unwrap()))
            .sum();
        assert_eq!(referenced, head.media_end - head.first_fragment);
        let durations: u64 = (0..3)
            .map(|n| u64::from(be32(sidx, 36 + n * 12).unwrap()))
            .sum();
        assert_eq!(durations, 90000);
        // The served file: the head, then the stored fragments.
        assert_eq!(head.total_len(), head.bytes.len() as u64 + referenced);
        let mut served = head.bytes.clone();
        served.extend_from_slice(&out[head.first_fragment as usize..head.media_end as usize]);
        assert_eq!(served.len() as u64, head.total_len());
        for at in [
            0,
            5,
            head.bytes.len() as u64 - 1,
            head.bytes.len() as u64,
            head.total_len() - 1,
        ] {
            let byte = match head.locate(at).unwrap() {
                Source::Head(n) => head.bytes[n],
                Source::Stored(n) => out[n as usize],
            };
            assert_eq!(byte, served[at as usize], "byte {at}");
        }
        assert_eq!(head.locate(head.total_len()), None);
        // The served file reads as boxes all the way: ftyp, moov, sidx, then fragments.
        let top = children(&served, 0, served.len()).unwrap();
        let kinds: Vec<_> = top.iter().map(|(_, _, k)| *k).collect();
        assert_eq!(&kinds[..4], &[*b"ftyp", *b"moov", *b"sidx", *b"moof"]);
    }

    #[test]
    fn a_fragment_without_the_primary_track_is_folded_into_the_entry_before_it() {
        // Sound only: it is not timed from the sound clock, gets no entry, and
        // the entries still follow one another with no gap.
        let sound_only = {
            let mfhd = full(b"mfhd", 0, 0, &2_u32.to_be_bytes());
            let moof = boxed(
                b"moof",
                &[mfhd, traf(2, 48128, true, &[1024; 47], false)].concat(),
            );
            [moof, boxed(b"mdat", &[0xCD; 2000])].concat()
        };
        let stream = [
            ftyp(),
            moov(),
            fragment(1, 0, 0, 5000),
            sound_only,
            fragment(3, 30000, 96256, 5000),
        ]
        .concat();
        for piece in [1, 7, 1000, stream.len()] {
            let (normaliser, out) = run(&stream, piece);
            let entries = normaliser.index();
            assert_eq!(entries.len(), 2, "piece {piece}");
            assert_eq!(
                entries.iter().map(|e| e.start).collect::<Vec<_>>(),
                vec![0, 30000]
            );
            assert_eq!(entries[0].offset + entries[0].size, entries[1].offset);
            assert_eq!(entries[1].offset + entries[1].size, out.len() as u64);
            assert_eq!(normaliser.complete_end(), out.len() as u64);
        }
        // Before any counted fragment: its bytes join the first entry.
        let lead_in = [
            ftyp(),
            moov(),
            {
                let mfhd = full(b"mfhd", 0, 0, &1_u32.to_be_bytes());
                let moof = boxed(
                    b"moof",
                    &[mfhd, traf(2, 0, true, &[1024; 47], false)].concat(),
                );
                [moof, boxed(b"mdat", &[0xEF; 300])].concat()
            },
            fragment(2, 0, 48128, 5000),
        ]
        .concat();
        let (normaliser, _) = run(&lead_in, 100);
        let entries = normaliser.index();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].offset, (ftyp().len() + moov().len()) as u64);
    }

    #[test]
    fn an_explicit_base_data_offset_is_refused_not_left_pointing_at_the_old_file() {
        let mut fragment = fragment(1, 0, 0, 100);
        let at = fragment
            .windows(4)
            .position(|w| w == b"tfhd")
            .expect("a tfhd");
        // Flags 0x000001 (base data offset present) in the full-box header.
        fragment[at + 5..at + 8].copy_from_slice(&[0x02, 0x00, 0x01]);
        let stream = [ftyp(), moov(), fragment].concat();
        let mut normaliser = Mp4Normaliser::new();
        let mut out = Vec::new();
        assert_eq!(normaliser.push(&stream, &mut out), Err(Mp4Error::Malformed));
    }

    #[test]
    fn a_very_long_recording_groups_fragments_under_one_sidx_reference() {
        // 70,000 one-second fragments exceed a sidx's 65,535 references.
        let head = [ftyp(), moov()].concat();
        let mut entries = Vec::new();
        let mut offset = head.len() as u64;
        for n in 0..70_000_u64 {
            entries.push(FragmentEntry {
                offset,
                size: 100,
                start: n * 30000,
                duration: 30000,
            });
            offset += 100;
        }
        let index = ParsedIndex {
            track_id: 1,
            timescale: 30000,
            entries,
        };
        // Starts in a 32-bit field up to 2^32 ticks: 70,000 s is too long at this
        // scale, so the sidx's first start (0) is what is checked, not the last.
        let built = build_virtual_head(&head, &index).unwrap();
        let sidx = &built.bytes[head.len()..];
        let count = usize::from(u16::from_be_bytes([sidx[30], sidx[31]]));
        assert_eq!(count, 35_000);
        assert_eq!(sidx.len(), 32 + count * 12);
        let referenced: u64 = (0..count)
            .map(|n| u64::from(be32(sidx, 32 + n * 12).unwrap()))
            .sum();
        assert_eq!(referenced, 70_000 * 100);
        let time: u64 = (0..count)
            .map(|n| u64::from(be32(sidx, 36 + n * 12).unwrap()))
            .sum();
        assert_eq!(time, 70_000 * 30000);
        assert_eq!(built.media_end - built.first_fragment, referenced);
    }
}

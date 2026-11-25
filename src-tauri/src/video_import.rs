//! A video the patient picks: is it one this app can play, and what must go before it is stored.
//!
//! Two steps, neither of which decodes a frame:
//!
//! 1. [`analyse`] walks the file once, in order, and decides. It reads the top-level boxes, buffers
//!    the one `moov` (at most [`MAX_MOOV`]) and checks it: an allowed `ftyp` brand, exactly one H.264
//!    video track and at most one AAC audio track, every track's data inside this very file (no
//!    reference to an outside one), the picture no larger than [`MAX_SIDE`], and a file that is not
//!    fragmented. It also makes a [`Plan`]: the edits that remove the places and devices the file
//!    names (the `udta` and `meta` boxes, `uuid` and unknown boxes, and every track that is not the
//!    picture or the sound, such as a phone's location track) and zero the bytes those tracks keep in
//!    `mdat`.
//! 2. [`Cleaner`] reads the file again and applies the plan as it goes. Every edit keeps the length
//!    and the position of every byte (a box is renamed `free` and its content zeroed; nothing moves),
//!    so the offsets inside `moov` stay right and nothing is buffered beyond one read.
//!
//! The brand allowlist, the track checks and the clean-up are why this does not need the rule that
//! only a camera video is a video: HEIC (brand `heic`) and M4A (no picture) fail the checks.
//!
//! Version 1 plays H.264 with AAC in an MP4 or QuickTime file. HEVC and the rest are refused with a
//! reason of their own.
// Nothing calls this yet: the import command that uses it comes in a later piece.
#![allow(dead_code)]

use std::io::{self, Read};

/// The most a video may take on a computer.
pub const MAX_VIDEO_BYTES_DESKTOP: u64 = 2 * 1024 * 1024 * 1024;
/// The most a video may take on a phone.
pub const MAX_VIDEO_BYTES_MOBILE: u64 = 1024 * 1024 * 1024;
/// The most a `ftyp` may take. Real ones take 20 to 40 bytes.
const MAX_FTYP: usize = 4 * 1024;
/// The most a `moov` may take. Its sample tables grow with the length of the video: an hour of phone
/// video takes about 10 MiB.
const MAX_MOOV: usize = 32 * 1024 * 1024;
/// How many boxes are looked at inside `moov`.
const MAX_BOXES: usize = 200_000;
/// The most tracks a file may have.
const MAX_TRACKS: usize = 16;
/// The most a file's removed boxes and removed tracks' samples may add up to.
const MAX_ZEROED: u64 = 16 * 1024 * 1024;
/// The most chunks and samples of one removed track that are followed.
const MAX_CHUNKS: usize = 200_000;
const MAX_SAMPLES: u64 = 2_000_000;
/// The largest picture, on either side.
pub const MAX_SIDE: u32 = 7680;

/// Why a video is refused. Each has its own plain words for the patient.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Refusal {
    /// Not an MP4 or QuickTime video at all (including HEIC photos and voice memos).
    NotVideo,
    /// The video uses H.265 (HEVC), which many computers cannot play.
    Hevc,
    /// The video uses another picture format.
    VideoCodec,
    /// The sound uses another format.
    AudioCodec,
    /// No picture: a voice memo or an audio file.
    NoVideo,
    /// More than one picture or sound, or too many tracks.
    TooManyTracks,
    /// Part of the video lives outside the file.
    External,
    /// A fragmented file (a recording that was never finished into one file).
    Fragmented,
    /// The picture is larger than `MAX_SIDE`.
    TooBig,
    /// Over the size limit.
    TooLarge,
    /// Cut short, or its boxes do not add up.
    Damaged,
}

/// `ftyp` brands of videos we take, as MP4 or QuickTime.
const BRANDS: &[&[u8; 4]] = &[
    b"isom", b"iso2", b"iso4", b"iso5", b"iso6", b"mp41", b"mp42", b"avc1", b"M4V ", b"qt  ",
];
/// Brands of other things that share the container: still pictures and audio.
const NOT_VIDEO_BRANDS: &[&[u8; 4]] = &[
    b"heic", b"heix", b"hevc", b"mif1", b"msf1", b"avif", b"avis", b"M4A ", b"M4B ", b"M4P ",
];

/// What the cleaning must do, as edits that keep every byte where it is.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    /// Ranges (start, length) to set to zero, sorted and merged.
    zero: Vec<(u64, u64)>,
    /// Four-byte box types to write (position, type), sorted.
    types: Vec<(u64, [u8; 4])>,
    /// The file has a sound track.
    pub has_audio: bool,
    /// The picture's size.
    pub width: u32,
    pub height: u32,
    /// How many bytes the file has.
    pub length: u64,
}

impl Plan {
    /// Whether anything has to change: a clean file passes through untouched.
    pub fn is_clean(&self) -> bool {
        self.zero.is_empty() && self.types.is_empty()
    }

    /// Rename a box `free` and zero what is inside it: `start` is where the box begins, `size` its
    /// whole length and `header` the length of its header (8 or 16).
    fn free_box(&mut self, start: u64, size: u64, header: u64) {
        self.types.push((start + 4, *b"free"));
        if size > header {
            self.zero.push((start + header, size - header));
        }
    }

    /// Sorts, merges and bounds the edits.
    fn finish(&mut self) -> Result<(), Refusal> {
        self.types.sort_unstable();
        self.types.dedup();
        self.zero.sort_unstable();
        let mut merged: Vec<(u64, u64)> = Vec::with_capacity(self.zero.len());
        for &(start, length) in &self.zero {
            if let Some(last) = merged.last_mut() {
                let end = last.0 + last.1;
                if start <= end {
                    last.1 = last.1.max(start + length - last.0);
                    continue;
                }
            }
            merged.push((start, length));
        }
        let total: u64 = merged.iter().map(|range| range.1).sum();
        if total > MAX_ZEROED {
            return Err(Refusal::Damaged);
        }
        self.zero = merged;
        Ok(())
    }
}

/// One box header read from a slice: the size (the whole box), the type and the header's length.
struct Header {
    size: u64,
    kind: [u8; 4],
    header: u64,
}

/// The header at `at` in `buf`, or `None` when it does not fit or says something impossible. A size
/// of 0 means "to the end of `buf`".
fn header_in(buf: &[u8], at: usize) -> Option<Header> {
    let rest = buf.get(at..)?;
    if rest.len() < 8 {
        return None;
    }
    let size32 = u32::from_be_bytes(rest[..4].try_into().ok()?);
    let kind: [u8; 4] = rest[4..8].try_into().ok()?;
    let (size, header) = match size32 {
        0 => (rest.len() as u64, 8),
        1 => {
            let long = u64::from_be_bytes(rest.get(8..16)?.try_into().ok()?);
            (long, 16)
        }
        n => (u64::from(n), 8),
    };
    if size < header || size > rest.len() as u64 {
        return None;
    }
    Some(Header { size, kind, header })
}

/// The children of the box at `parent` (its payload is `buf[start..end]`): (offset, header).
fn children(buf: &[u8], start: usize, end: usize) -> Result<Vec<(usize, Header)>, Refusal> {
    let mut found = Vec::new();
    let mut at = start;
    while at < end {
        let header = header_in(&buf[..end], at).ok_or(Refusal::Damaged)?;
        let next = at + header.size as usize;
        found.push((at, header));
        at = next;
    }
    Ok(found)
}

/// A budget of boxes looked at, so a hostile `moov` cannot take unbounded time.
struct Budget(usize);
impl Budget {
    fn spend(&mut self) -> Result<(), Refusal> {
        self.0 = self.0.checked_sub(1).ok_or(Refusal::Damaged)?;
        Ok(())
    }
}

#[derive(Default)]
struct Found {
    video: usize,
    audio: usize,
    tracks: usize,
}

/// Reads exactly `buf.len()` bytes; `Ok(false)` if the reader was already at its end, an error if it
/// ended part of the way.
fn read_all_or_end(reader: &mut impl Read, buf: &mut [u8]) -> Result<bool, Refusal> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => {
                return if filled == 0 {
                    Ok(false)
                } else {
                    Err(Refusal::Damaged)
                }
            }
            Ok(n) => filled += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(Refusal::Damaged),
        }
    }
    Ok(true)
}

/// Reads and discards `count` bytes; the reader must have them.
fn skip(reader: &mut impl Read, mut count: u64) -> Result<(), Refusal> {
    let mut scratch = [0_u8; 64 * 1024];
    while count > 0 {
        let take = count.min(scratch.len() as u64) as usize;
        match reader.read(&mut scratch[..take]) {
            Ok(0) => return Err(Refusal::Damaged),
            Ok(n) => count -= n as u64,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(Refusal::Damaged),
        }
    }
    Ok(())
}

/// Reads to the end, counting; used for a last box that says it runs to the end of the file.
fn skip_to_end(reader: &mut impl Read) -> Result<u64, Refusal> {
    let mut scratch = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        match reader.read(&mut scratch) {
            Ok(0) => return Ok(total),
            Ok(n) => total += n as u64,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(Refusal::Damaged),
        }
    }
}

/// Walks the whole file once and decides. `max_bytes` is the size limit. Nothing is decoded, and
/// nothing is kept but the one `moov`.
pub fn analyse(mut reader: impl Read, max_bytes: u64) -> Result<Plan, Refusal> {
    let mut plan = Plan::default();
    let mut pos = 0_u64;
    let (mut seen_ftyp, mut seen_moov, mut seen_mdat) = (false, false, false);
    loop {
        let mut head = [0_u8; 8];
        if !read_all_or_end(&mut reader, &mut head)? {
            break;
        }
        let size32 = u32::from_be_bytes([head[0], head[1], head[2], head[3]]);
        let kind = [head[4], head[5], head[6], head[7]];
        let (mut size, header) = match size32 {
            0 => (0, 8_u64),
            1 => {
                let mut long = [0_u8; 8];
                if !read_all_or_end(&mut reader, &mut long)? {
                    return Err(Refusal::Damaged);
                }
                (u64::from_be_bytes(long), 16)
            }
            n => (u64::from(n), 8),
        };
        if pos == 0 && &kind != b"ftyp" {
            return Err(Refusal::NotVideo);
        }
        if size == 0 {
            // To the end of the file: only the media data may do that.
            if &kind != b"mdat" {
                return Err(Refusal::Damaged);
            }
            size = header + skip_to_end(&mut reader)?;
            seen_mdat = true;
            pos = pos.checked_add(size).ok_or(Refusal::TooLarge)?;
            if pos > max_bytes {
                return Err(Refusal::TooLarge);
            }
            break;
        }
        if size < header {
            return Err(Refusal::Damaged);
        }
        let payload = size - header;
        match &kind {
            b"ftyp" => {
                if pos != 0 || seen_ftyp || payload < 8 || payload > MAX_FTYP as u64 {
                    return Err(Refusal::NotVideo);
                }
                let mut body = vec![0_u8; payload as usize];
                if !read_all_or_end(&mut reader, &mut body)? {
                    return Err(Refusal::Damaged);
                }
                check_brand(&body)?;
                seen_ftyp = true;
            }
            b"moov" => {
                if seen_moov {
                    return Err(Refusal::Damaged);
                }
                if payload > MAX_MOOV as u64 {
                    return Err(Refusal::TooLarge);
                }
                let mut body = vec![0_u8; payload as usize];
                if payload > 0 && !read_all_or_end(&mut reader, &mut body)? {
                    return Err(Refusal::Damaged);
                }
                inspect_moov(&body, pos + header, &mut plan)?;
                seen_moov = true;
            }
            b"mdat" => {
                skip(&mut reader, payload)?;
                seen_mdat = true;
            }
            b"free" | b"skip" | b"wide" => skip(&mut reader, payload)?,
            // A fragmented file's boxes: not an ordinary video.
            b"moof" | b"mfra" | b"sidx" | b"styp" => return Err(Refusal::Fragmented),
            // Anything else at the top (a `meta`, a `uuid` with a place or an XMP packet, a `PICT`):
            // renamed `free` and zeroed.
            _ => {
                if payload > MAX_ZEROED {
                    return Err(Refusal::Damaged);
                }
                skip(&mut reader, payload)?;
                plan.free_box(pos, size, header);
            }
        }
        pos = pos.checked_add(size).ok_or(Refusal::TooLarge)?;
        if pos > max_bytes {
            return Err(Refusal::TooLarge);
        }
    }
    if !seen_ftyp || !seen_moov || !seen_mdat {
        return Err(if seen_ftyp {
            Refusal::Damaged
        } else {
            Refusal::NotVideo
        });
    }
    plan.length = pos;
    // A removed track's samples must not be where the file's own structure is.
    plan.finish()?;
    Ok(plan)
}

fn check_brand(body: &[u8]) -> Result<(), Refusal> {
    let major: [u8; 4] = body[..4].try_into().map_err(|_| Refusal::NotVideo)?;
    // Compatible brands follow the major brand and the minor version, four bytes each.
    let (compatible, _) = body[8..].as_chunks::<4>();
    if NOT_VIDEO_BRANDS.iter().any(|brand| **brand == major) {
        return Err(Refusal::NotVideo);
    }
    let mut brands = std::iter::once(major).chain(compatible.iter().copied());
    // Every brand the file names for itself must be one that is not a still picture or audio-only,
    // and the major one must be a video brand.
    if brands.any(|brand| NOT_VIDEO_BRANDS.iter().any(|not| **not == brand)) {
        return Err(Refusal::NotVideo);
    }
    if !BRANDS.iter().any(|brand| **brand == major) {
        return Err(Refusal::NotVideo);
    }
    Ok(())
}

/// Checks the `moov` and adds what must go. `base` is where its payload starts in the file.
fn inspect_moov(moov: &[u8], base: u64, plan: &mut Plan) -> Result<(), Refusal> {
    let mut budget = Budget(MAX_BOXES);
    let mut found = Found::default();
    for (at, child) in children(moov, 0, moov.len())? {
        budget.spend()?;
        let start = base + at as u64;
        match &child.kind {
            b"trak" => {
                found.tracks += 1;
                if found.tracks > MAX_TRACKS {
                    return Err(Refusal::TooManyTracks);
                }
                inspect_trak(moov, at, &child, base, plan, &mut found, &mut budget)?;
            }
            // Where, with what and when: the places and devices the file names.
            b"udta" | b"meta" | b"uuid" => plan.free_box(start, child.size, child.header),
            // A fragmented movie, or one we cannot read without unpacking it.
            b"mvex" => return Err(Refusal::Fragmented),
            b"cmov" | b"rmra" => return Err(Refusal::External),
            _ => {}
        }
    }
    if found.video == 0 {
        return Err(Refusal::NoVideo);
    }
    if found.video > 1 || found.audio > 1 {
        return Err(Refusal::TooManyTracks);
    }
    plan.has_audio = found.audio == 1;
    Ok(())
}

fn payload_of(buf: &[u8], at: usize, header: &Header) -> Option<(usize, usize)> {
    let start = at + header.header as usize;
    let end = at + header.size as usize;
    (start <= end && end <= buf.len()).then_some((start, end))
}

fn first<'a>(found: &'a [(usize, Header)], kind: &[u8; 4]) -> Option<&'a (usize, Header)> {
    found.iter().find(|(_, header)| &header.kind == kind)
}

#[allow(clippy::too_many_arguments)]
fn inspect_trak(
    moov: &[u8],
    at: usize,
    trak: &Header,
    base: u64,
    plan: &mut Plan,
    found: &mut Found,
    budget: &mut Budget,
) -> Result<(), Refusal> {
    let (start, end) = payload_of(moov, at, trak).ok_or(Refusal::Damaged)?;
    let parts = children(moov, start, end)?;
    budget.spend()?;
    // What the track is, from its handler.
    let mdia = first(&parts, b"mdia").ok_or(Refusal::Damaged)?;
    let (mdia_start, mdia_end) = payload_of(moov, mdia.0, &mdia.1).ok_or(Refusal::Damaged)?;
    let media = children(moov, mdia_start, mdia_end)?;
    let hdlr = first(&media, b"hdlr").ok_or(Refusal::Damaged)?;
    let (h_start, h_end) = payload_of(moov, hdlr.0, &hdlr.1).ok_or(Refusal::Damaged)?;
    // version and flags, the old component type, then the handler type.
    let handler: [u8; 4] = moov
        .get(h_start + 8..h_start + 12)
        .filter(|_| h_start + 12 <= h_end)
        .and_then(|slice| slice.try_into().ok())
        .ok_or(Refusal::Damaged)?;
    let checked = match &handler {
        b"vide" => {
            found.video += 1;
            check_picture_track(moov, &parts, &media, plan, budget)
        }
        b"soun" => {
            found.audio += 1;
            check_sound_track(moov, &media, budget)
        }
        // Anything else (a phone's location or motion track, a timecode, subtitles): removed, with the
        // bytes it keeps in `mdat`.
        _ => {
            plan.free_box(base + at as u64, trak.size, trak.header);
            zero_samples(moov, &media, plan, budget)
        }
    };
    checked?;
    // A kept track's own `udta`, `meta` and `uuid` go too, as the movie's do (a removed track is
    // gone whole).
    if matches!(&handler, b"vide" | b"soun") {
        for (child_at, child) in &parts {
            if matches!(&child.kind, b"udta" | b"meta" | b"uuid") {
                plan.free_box(base + *child_at as u64, child.size, child.header);
            }
        }
    }
    Ok(())
}

/// The boxes found inside one parent: where each starts, and its header.
type Boxes = Vec<(usize, Header)>;

fn minf_children(moov: &[u8], media: &[(usize, Header)]) -> Result<(Boxes, Boxes), Refusal> {
    let minf = first(media, b"minf").ok_or(Refusal::Damaged)?;
    let (m_start, m_end) = payload_of(moov, minf.0, &minf.1).ok_or(Refusal::Damaged)?;
    let parts = children(moov, m_start, m_end)?;
    let stbl = first(&parts, b"stbl").ok_or(Refusal::Damaged)?;
    let (s_start, s_end) = payload_of(moov, stbl.0, &stbl.1).ok_or(Refusal::Damaged)?;
    let table = children(moov, s_start, s_end)?;
    Ok((parts, table))
}

/// The first sample description's type, and that it is the only one.
fn sample_entry(moov: &[u8], table: &[(usize, Header)]) -> Result<[u8; 4], Refusal> {
    let stsd = first(table, b"stsd").ok_or(Refusal::Damaged)?;
    let (start, end) = payload_of(moov, stsd.0, &stsd.1).ok_or(Refusal::Damaged)?;
    // version and flags, the entry count, then the first entry: its size and its type.
    let body = moov.get(start..end).ok_or(Refusal::Damaged)?;
    if body.len() < 16 {
        return Err(Refusal::Damaged);
    }
    let count = u32::from_be_bytes(body[4..8].try_into().map_err(|_| Refusal::Damaged)?);
    if count != 1 {
        return Err(Refusal::TooManyTracks);
    }
    body[12..16].try_into().map_err(|_| Refusal::Damaged)
}

/// Every data reference of the track is "in this file": the flag bit of each `url ` or `urn `.
fn check_self_contained(moov: &[u8], parts: &[(usize, Header)]) -> Result<(), Refusal> {
    let Some(dinf) = first(parts, b"dinf") else {
        return Ok(());
    };
    let (d_start, d_end) = payload_of(moov, dinf.0, &dinf.1).ok_or(Refusal::Damaged)?;
    let inside = children(moov, d_start, d_end)?;
    let Some(dref) = first(&inside, b"dref") else {
        return Ok(());
    };
    let (r_start, r_end) = payload_of(moov, dref.0, &dref.1).ok_or(Refusal::Damaged)?;
    // version and flags, the entry count, then the entries.
    let entries = children(moov, r_start + 8, r_end)?;
    for (entry_at, entry) in entries {
        let flags = moov
            .get(entry_at + entry.header as usize..entry_at + entry.header as usize + 4)
            .ok_or(Refusal::Damaged)?;
        if flags[3] & 1 == 0 {
            return Err(Refusal::External);
        }
    }
    Ok(())
}

fn check_picture_track(
    moov: &[u8],
    parts: &[(usize, Header)],
    media: &[(usize, Header)],
    plan: &mut Plan,
    budget: &mut Budget,
) -> Result<(), Refusal> {
    budget.spend()?;
    let (minf, table) = minf_children(moov, media)?;
    check_self_contained(moov, &minf)?;
    match &sample_entry(moov, &table)? {
        b"avc1" | b"avc3" => {}
        b"hvc1" | b"hev1" | b"dvh1" | b"dvhe" => return Err(Refusal::Hevc),
        _ => return Err(Refusal::VideoCodec),
    }
    // The picture's size, from the track header: 16.16 fixed point.
    let tkhd = first(parts, b"tkhd").ok_or(Refusal::Damaged)?;
    let (t_start, t_end) = payload_of(moov, tkhd.0, &tkhd.1).ok_or(Refusal::Damaged)?;
    let version = *moov.get(t_start).ok_or(Refusal::Damaged)?;
    let size_at = t_start + if version == 1 { 36 } else { 24 } + 52;
    let bytes = moov.get(size_at..size_at + 8).ok_or(Refusal::Damaged)?;
    if size_at + 8 > t_end {
        return Err(Refusal::Damaged);
    }
    let width = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) >> 16;
    let height = u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) >> 16;
    if width == 0 || height == 0 {
        return Err(Refusal::Damaged);
    }
    if width > MAX_SIDE || height > MAX_SIDE {
        return Err(Refusal::TooBig);
    }
    plan.width = width;
    plan.height = height;
    Ok(())
}

fn check_sound_track(
    moov: &[u8],
    media: &[(usize, Header)],
    budget: &mut Budget,
) -> Result<(), Refusal> {
    budget.spend()?;
    let (minf, table) = minf_children(moov, media)?;
    check_self_contained(moov, &minf)?;
    match &sample_entry(moov, &table)? {
        b"mp4a" => Ok(()),
        _ => Err(Refusal::AudioCodec),
    }
}

/// The bytes a removed track keeps in `mdat`, found from its sample tables, are zeroed too.
fn zero_samples(
    moov: &[u8],
    media: &[(usize, Header)],
    plan: &mut Plan,
    budget: &mut Budget,
) -> Result<(), Refusal> {
    budget.spend()?;
    // A track with no sample table keeps nothing.
    let Ok((_, table)) = minf_children(moov, media) else {
        return Ok(());
    };
    let body_of = |kind: &[u8; 4]| -> Result<Option<&[u8]>, Refusal> {
        match first(&table, kind) {
            Some((at, header)) => {
                let (s, e) = payload_of(moov, *at, header).ok_or(Refusal::Damaged)?;
                Ok(moov.get(s..e))
            }
            None => Ok(None),
        }
    };
    let (Some(stsz), Some(stsc)) = (body_of(b"stsz")?, body_of(b"stsc")?) else {
        return Ok(());
    };
    let offsets: Vec<u64> = if let Some(stco) = body_of(b"stco")? {
        read_offsets(stco, 4)?
    } else if let Some(co64) = body_of(b"co64")? {
        read_offsets(co64, 8)?
    } else {
        return Ok(());
    };
    // Sample sizes: a fixed size, or a table.
    if stsz.len() < 12 {
        return Err(Refusal::Damaged);
    }
    let fixed = u32::from_be_bytes([stsz[4], stsz[5], stsz[6], stsz[7]]);
    let samples = u64::from(u32::from_be_bytes([stsz[8], stsz[9], stsz[10], stsz[11]]));
    if samples > MAX_SAMPLES {
        return Err(Refusal::Damaged);
    }
    let size_of = |index: u64| -> Result<u64, Refusal> {
        if fixed != 0 {
            return Ok(u64::from(fixed));
        }
        let at = 12 + index as usize * 4;
        let entry = stsz.get(at..at + 4).ok_or(Refusal::Damaged)?;
        Ok(u64::from(u32::from_be_bytes([
            entry[0], entry[1], entry[2], entry[3],
        ])))
    };
    // Samples per chunk: runs of (first chunk, samples per chunk).
    if stsc.len() < 8 {
        return Err(Refusal::Damaged);
    }
    let runs = u32::from_be_bytes([stsc[4], stsc[5], stsc[6], stsc[7]]) as usize;
    if runs > MAX_CHUNKS || stsc.len() < 8 + runs * 12 {
        return Err(Refusal::Damaged);
    }
    let run = |index: usize| -> (u64, u64) {
        let at = 8 + index * 12;
        (
            u64::from(u32::from_be_bytes([
                stsc[at],
                stsc[at + 1],
                stsc[at + 2],
                stsc[at + 3],
            ])),
            u64::from(u32::from_be_bytes([
                stsc[at + 4],
                stsc[at + 5],
                stsc[at + 6],
                stsc[at + 7],
            ])),
        )
    };
    let mut next_sample = 0_u64;
    for (chunk_index, &offset) in offsets.iter().enumerate() {
        let chunk_number = chunk_index as u64 + 1;
        // The run that holds this chunk is the last one starting at or before it.
        let mut per_chunk = 0_u64;
        for index in 0..runs {
            let (first_chunk, count) = run(index);
            if first_chunk <= chunk_number {
                per_chunk = count;
            } else {
                break;
            }
        }
        let mut length = 0_u64;
        for _ in 0..per_chunk {
            if next_sample >= samples {
                break;
            }
            length += size_of(next_sample)?;
            next_sample += 1;
        }
        if length > 0 {
            plan.zero.push((offset, length));
        }
        budget.spend()?;
    }
    Ok(())
}

fn read_offsets(body: &[u8], width: usize) -> Result<Vec<u64>, Refusal> {
    if body.len() < 8 {
        return Err(Refusal::Damaged);
    }
    let count = u32::from_be_bytes([body[4], body[5], body[6], body[7]]) as usize;
    if count > MAX_CHUNKS || body.len() < 8 + count * width {
        return Err(Refusal::Damaged);
    }
    Ok((0..count)
        .map(|index| {
            let at = 8 + index * width;
            if width == 4 {
                u64::from(u32::from_be_bytes([
                    body[at],
                    body[at + 1],
                    body[at + 2],
                    body[at + 3],
                ]))
            } else {
                u64::from_be_bytes([
                    body[at],
                    body[at + 1],
                    body[at + 2],
                    body[at + 3],
                    body[at + 4],
                    body[at + 5],
                    body[at + 6],
                    body[at + 7],
                ])
            }
        })
        .collect())
}

/// Reads a file again and applies the plan as the bytes pass: the same length, every other byte
/// where it was.
pub struct Cleaner<R> {
    inner: R,
    plan: Plan,
    pos: u64,
}

impl<R: Read> Cleaner<R> {
    pub fn new(inner: R, plan: Plan) -> Self {
        Self {
            inner,
            plan,
            pos: 0,
        }
    }
}

impl<R: Read> Read for Cleaner<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n == 0 {
            return Ok(0);
        }
        let (from, to) = (self.pos, self.pos + n as u64);
        // Zeroed ranges first, then the box types, so a renamed box keeps its new name.
        for &(start, length) in &self.plan.zero {
            let (lo, hi) = (start.max(from), (start + length).min(to));
            if lo < hi {
                buf[(lo - from) as usize..(hi - from) as usize].fill(0);
            }
        }
        for &(at, kind) in &self.plan.types {
            for (offset, byte) in kind.iter().enumerate() {
                let place = at + offset as u64;
                if place >= from && place < to {
                    buf[(place - from) as usize] = *byte;
                }
            }
        }
        self.pos = to;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bx(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(payload);
        out
    }

    fn full(kind: &[u8; 4], flags: u32, payload: &[u8]) -> Vec<u8> {
        let mut body = flags.to_be_bytes().to_vec();
        body.extend_from_slice(payload);
        bx(kind, &body)
    }

    fn ftyp(major: &[u8; 4]) -> Vec<u8> {
        let mut body = major.to_vec();
        body.extend_from_slice(&[0, 0, 0, 0]);
        body.extend_from_slice(b"isom");
        bx(b"ftyp", &body)
    }

    fn hdlr(kind: &[u8; 4]) -> Vec<u8> {
        let mut body = vec![0_u8; 4];
        body.extend_from_slice(kind);
        body.extend_from_slice(&[0_u8; 12]);
        full(b"hdlr", 0, &body)
    }

    fn stsd(entry: &[u8; 4]) -> Vec<u8> {
        let entry_box = bx(entry, &[0_u8; 78]);
        let mut body = 1_u32.to_be_bytes().to_vec();
        body.extend_from_slice(&entry_box);
        full(b"stsd", 0, &body)
    }

    fn dref(self_contained: bool) -> Vec<u8> {
        let flags = u32::from(self_contained);
        let entry = full(b"url ", flags, &[]);
        let mut body = 1_u32.to_be_bytes().to_vec();
        body.extend_from_slice(&entry);
        bx(b"dinf", &full(b"dref", 0, &body))
    }

    /// A sample table with one chunk of one sample, at `chunk` (offset, size).
    fn tables(chunk: (u64, u32)) -> Vec<u8> {
        let mut out = Vec::new();
        let mut stsz = 0_u32.to_be_bytes().to_vec();
        stsz.extend_from_slice(&1_u32.to_be_bytes());
        stsz.extend_from_slice(&chunk.1.to_be_bytes());
        out.extend(full(b"stsz", 0, &stsz));
        let mut stsc = 1_u32.to_be_bytes().to_vec();
        for value in [1_u32, 1, 1] {
            stsc.extend_from_slice(&value.to_be_bytes());
        }
        out.extend(full(b"stsc", 0, &stsc));
        let mut stco = 1_u32.to_be_bytes().to_vec();
        stco.extend_from_slice(&(chunk.0 as u32).to_be_bytes());
        out.extend(full(b"stco", 0, &stco));
        out
    }

    fn tkhd(width: u32, height: u32) -> Vec<u8> {
        let mut body = vec![0_u8; 72];
        body.extend_from_slice(&(width << 16).to_be_bytes());
        body.extend_from_slice(&(height << 16).to_be_bytes());
        full(b"tkhd", 0, &body)
    }

    fn trak(kind: &[u8; 4], entry: &[u8; 4], own: bool, chunk: (u64, u32)) -> Vec<u8> {
        let mut stbl = stsd(entry);
        stbl.extend(tables(chunk));
        let mut minf = dref(own);
        minf.extend(bx(b"stbl", &stbl));
        let mut mdia = hdlr(kind);
        mdia.extend(bx(b"minf", &minf));
        let mut parts = tkhd(1920, 1080);
        parts.extend(bx(b"mdia", &mdia));
        bx(b"trak", &parts)
    }

    const MARK: &[u8; 16] = b"PLACE+43.65-79.4";

    /// The file's bytes: ftyp, mdat (holding the marker, then the video's own bytes) and the moov.
    fn video(moov_first: bool, extra_moov: &[u8], extra_tracks: &[Vec<u8>]) -> Vec<u8> {
        let ftyp = ftyp(b"isom");
        // mdat: the marker for the metadata track, then 64 bytes of "video".
        let mut mdat_payload = MARK.to_vec();
        mdat_payload.extend_from_slice(&[7_u8; 64]);
        let mdat = bx(b"mdat", &mdat_payload);
        let build_moov = |mdat_start: u64| {
            let mut moov = full(b"mvhd", 0, &[0_u8; 96]);
            moov.extend(trak(b"vide", b"avc1", true, (mdat_start + 8 + 16, 32)));
            moov.extend(trak(b"soun", b"mp4a", true, (mdat_start + 8 + 48, 32)));
            for track in extra_tracks {
                // The metadata track points at the marker, the first 16 bytes of the mdat.
                let _ = track;
            }
            moov.extend_from_slice(extra_moov);
            for track in extra_tracks {
                moov.extend_from_slice(track);
            }
            bx(b"moov", &moov)
        };
        let mut file = ftyp.clone();
        if moov_first {
            // The moov's size does not depend on the offsets, so one trial gives the real start.
            let size = build_moov(0).len() as u64;
            let mdat_start = ftyp.len() as u64 + size;
            file.extend(build_moov(mdat_start));
            file.extend(&mdat);
        } else {
            let mdat_start = ftyp.len() as u64;
            file.extend(&mdat);
            file.extend(build_moov(mdat_start));
        }
        file
    }

    fn mdat_start(file: &[u8]) -> u64 {
        file.windows(4).position(|w| w == b"mdat").unwrap() as u64 - 4
    }

    #[test]
    fn a_plain_h264_aac_mp4_is_accepted_and_needs_no_change() {
        for moov_first in [false, true] {
            let file = video(moov_first, &[], &[]);
            let plan = analyse(&file[..], MAX_VIDEO_BYTES_DESKTOP).unwrap();
            assert!(plan.is_clean(), "moov_first {moov_first}");
            assert!(plan.has_audio);
            assert_eq!((plan.width, plan.height), (1920, 1080));
            assert_eq!(plan.length, file.len() as u64);
            let mut out = Vec::new();
            Cleaner::new(&file[..], plan).read_to_end(&mut out).unwrap();
            assert_eq!(out, file);
        }
    }

    #[test]
    fn places_and_devices_are_removed_and_nothing_moves() {
        let udta = bx(b"udta", &bx(b"\xa9xyz", b"+43.6532-079.3832/"));
        let meta = full(b"meta", 0, b"com.apple.quicktime.model iPhone");
        let mut extra = udta.clone();
        extra.extend_from_slice(&meta);
        let file = video(false, &extra, &[]);
        let text = |bytes: &[u8], needle: &[u8]| bytes.windows(needle.len()).any(|w| w == needle);
        assert!(text(&file, b"+43.6532") && text(&file, b"iPhone"));
        let plan = analyse(&file[..], MAX_VIDEO_BYTES_DESKTOP).unwrap();
        assert!(!plan.is_clean());
        let mut out = Vec::new();
        Cleaner::new(&file[..], plan).read_to_end(&mut out).unwrap();
        assert_eq!(out.len(), file.len());
        assert!(!text(&out, b"+43.6532") && !text(&out, b"iPhone"));
        // The result is a plain video, with the same picture and sound, and nothing more to do.
        let again = analyse(&out[..], MAX_VIDEO_BYTES_DESKTOP).unwrap();
        assert!(again.is_clean() || again.zero.is_empty());
        assert_eq!(
            (again.width, again.height, again.has_audio),
            (1920, 1080, true)
        );
    }

    #[test]
    fn a_location_track_and_the_samples_it_keeps_are_removed() {
        let file0 = video(false, &[], &[]);
        let start = mdat_start(&file0);
        // A metadata track whose one sample is the marker at the front of the media data.
        let meta_track = trak(b"meta", b"mebx", true, (start + 8, 16));
        let file = video(false, &[], &[meta_track]);
        let text = |bytes: &[u8], needle: &[u8]| bytes.windows(needle.len()).any(|w| w == needle);
        assert!(text(&file, MARK));
        let plan = analyse(&file[..], MAX_VIDEO_BYTES_DESKTOP).unwrap();
        let mut out = Vec::new();
        Cleaner::new(&file[..], plan).read_to_end(&mut out).unwrap();
        assert_eq!(out.len(), file.len());
        assert!(!text(&out, MARK), "the samples are zeroed");
        // The picture's own bytes are untouched.
        assert!(text(&out, &[7_u8; 64]));
        assert!(analyse(&out[..], MAX_VIDEO_BYTES_DESKTOP).is_ok());
    }

    #[test]
    fn what_is_not_a_playable_h264_aac_mp4_is_refused_with_its_own_reason() {
        let bad = |file: Vec<u8>| analyse(&file[..], MAX_VIDEO_BYTES_DESKTOP).unwrap_err();
        let make = |video_entry: &[u8; 4], sound_entry: &[u8; 4]| {
            let mut moov = full(b"mvhd", 0, &[0_u8; 96]);
            moov.extend(trak(b"vide", video_entry, true, (40, 8)));
            moov.extend(trak(b"soun", sound_entry, true, (48, 8)));
            let mut file = ftyp(b"isom");
            file.extend(bx(b"mdat", &[1_u8; 64]));
            file.extend(bx(b"moov", &moov));
            file
        };
        assert_eq!(bad(make(b"hvc1", b"mp4a")), Refusal::Hevc);
        assert_eq!(bad(make(b"hev1", b"mp4a")), Refusal::Hevc);
        assert_eq!(bad(make(b"vp09", b"mp4a")), Refusal::VideoCodec);
        assert_eq!(bad(make(b"avc1", b"ac-3")), Refusal::AudioCodec);
        // No picture at all: a voice memo.
        let mut moov = full(b"mvhd", 0, &[0_u8; 96]);
        moov.extend(trak(b"soun", b"mp4a", true, (40, 8)));
        let mut memo = ftyp(b"isom");
        memo.extend(bx(b"mdat", &[1_u8; 64]));
        memo.extend(bx(b"moov", &moov));
        assert_eq!(bad(memo), Refusal::NoVideo);
        // A still picture or audio brand is not a video, whatever else is in the file.
        for brand in [b"heic", b"mif1", b"M4A ", b"avif"] {
            let mut file = ftyp(brand);
            file.extend(bx(b"mdat", &[1_u8; 8]));
            assert_eq!(bad(file), Refusal::NotVideo, "{brand:?}");
        }
        // A brand nobody listed.
        assert_eq!(bad(ftyp(b"zzzz")), Refusal::NotVideo);
    }

    #[test]
    fn data_outside_the_file_and_fragmented_movies_are_refused() {
        let mut moov = full(b"mvhd", 0, &[0_u8; 96]);
        moov.extend(trak(b"vide", b"avc1", false, (40, 8)));
        let mut external = ftyp(b"isom");
        external.extend(bx(b"mdat", &[1_u8; 64]));
        external.extend(bx(b"moov", &moov));
        assert_eq!(
            analyse(&external[..], MAX_VIDEO_BYTES_DESKTOP).unwrap_err(),
            Refusal::External
        );
        let mut moov = full(b"mvhd", 0, &[0_u8; 96]);
        moov.extend(trak(b"vide", b"avc1", true, (40, 8)));
        moov.extend(bx(b"mvex", &[]));
        let mut fragmented = ftyp(b"isom");
        fragmented.extend(bx(b"moov", &moov));
        fragmented.extend(bx(b"moof", &[0_u8; 8]));
        assert_eq!(
            analyse(&fragmented[..], MAX_VIDEO_BYTES_DESKTOP).unwrap_err(),
            Refusal::Fragmented
        );
    }

    #[test]
    fn a_file_over_the_limit_a_cut_off_file_and_not_a_video_are_refused() {
        let file = video(false, &[], &[]);
        assert_eq!(
            analyse(&file[..], file.len() as u64 - 1).unwrap_err(),
            Refusal::TooLarge
        );
        assert!(analyse(&file[..], file.len() as u64).is_ok());
        let cut = &file[..file.len() - 10];
        assert_eq!(
            analyse(cut, MAX_VIDEO_BYTES_DESKTOP).unwrap_err(),
            Refusal::Damaged
        );
        assert_eq!(
            analyse(&b"%PDF-1.7 not a video at all"[..], MAX_VIDEO_BYTES_DESKTOP).unwrap_err(),
            Refusal::NotVideo
        );
        assert_eq!(
            analyse(&b""[..], MAX_VIDEO_BYTES_DESKTOP).unwrap_err(),
            Refusal::NotVideo
        );
        // Two movies in one file, and no movie at all.
        let mut twice = file.clone();
        twice.extend(bx(b"moov", &[]));
        assert_eq!(
            analyse(&twice[..], MAX_VIDEO_BYTES_DESKTOP).unwrap_err(),
            Refusal::Damaged
        );
        let mut none = ftyp(b"isom");
        none.extend(bx(b"mdat", &[1_u8; 8]));
        assert_eq!(
            analyse(&none[..], MAX_VIDEO_BYTES_DESKTOP).unwrap_err(),
            Refusal::Damaged
        );
    }

    #[test]
    fn a_hostile_track_table_cannot_point_the_clean_up_at_the_files_own_structure() {
        // A metadata track whose "sample" claims the first bytes of the file: zeroing it would
        // destroy the ftyp. The plan is still made, but the zeroing is bounded and the file then
        // fails its own check rather than playing.
        let meta_track = trak(b"meta", b"mebx", true, (0, 16));
        let file = video(false, &[], &[meta_track]);
        let plan = analyse(&file[..], MAX_VIDEO_BYTES_DESKTOP).unwrap();
        let mut out = Vec::new();
        Cleaner::new(&file[..], plan).read_to_end(&mut out).unwrap();
        assert_eq!(out.len(), file.len());
        assert!(analyse(&out[..], MAX_VIDEO_BYTES_DESKTOP).is_err());
    }

    #[test]
    fn a_picture_larger_than_the_limit_is_refused() {
        let mut moov = full(b"mvhd", 0, &[0_u8; 96]);
        let mut track = trak(b"vide", b"avc1", true, (40, 8));
        // Replace the 1920 x 1080 in the track header with 9000 x 1080.
        let want = (1920_u32 << 16).to_be_bytes();
        let at = track.windows(4).position(|w| w == want).unwrap();
        track[at..at + 4].copy_from_slice(&(9000_u32 << 16).to_be_bytes());
        moov.extend(track);
        let mut file = ftyp(b"isom");
        file.extend(bx(b"mdat", &[1_u8; 64]));
        file.extend(bx(b"moov", &moov));
        assert_eq!(
            analyse(&file[..], MAX_VIDEO_BYTES_DESKTOP).unwrap_err(),
            Refusal::TooBig
        );
    }
}

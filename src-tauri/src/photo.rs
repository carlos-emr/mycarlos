//! Photos taken with the camera. The app's own canvas encodes them, so they
//! carry no Exif block, GPS position or camera details. These checks run anyway,
//! in Rust, before a photo is encrypted and before one is shown: the bytes must
//! be one complete baseline or progressive JPEG within the size caps, and every
//! segment that can carry metadata is dropped. Nothing here decodes pixels: it
//! walks the JPEG's markers only, so it needs no image decoder.

use zeroize::Zeroizing;

/// The most bytes a photo may have, before or after cleaning.
pub const MAX_PHOTO_BYTES: usize = 25 * 1024 * 1024;
/// The most pixels a photo may have on either side.
pub const MAX_PHOTO_SIDE: u16 = 8192;

#[derive(Debug, PartialEq, Eq)]
pub enum PhotoError {
    /// Not one complete 8-bit baseline or progressive JPEG.
    NotJpeg,
    /// Not one complete, well formed, still PNG (`photo_png`).
    NotPng,
    /// Over `MAX_PHOTO_BYTES`, or over `MAX_PHOTO_SIDE` on a side (or, for a PNG, over the pixel
    /// cap).
    TooLarge,
}

/// A kind of picture the vault shows, decided by the file's own first bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PictureKind {
    Jpeg,
    Png,
}

impl PictureKind {
    /// The suffix a picture of this kind is named with when it has none that fits.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => ".jpg",
            Self::Png => ".png",
        }
    }

    /// Whether `name` (trimmed) is a nonempty name followed by a suffix that describes this kind:
    /// `.jpg` or `.jpeg` for a JPEG, `.png` for a PNG, in any case.
    pub fn names(self, name: &str) -> bool {
        name.trim().rsplit_once('.').is_some_and(|(stem, extension)| {
            !stem.trim().is_empty()
                && match self {
                    Self::Jpeg => {
                        extension.eq_ignore_ascii_case("jpg")
                            || extension.eq_ignore_ascii_case("jpeg")
                    }
                    Self::Png => extension.eq_ignore_ascii_case("png"),
                }
        })
    }

    /// The type of the `data:` URL the viewer is given.
    pub fn media_type(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
        }
    }
}

/// The kind of picture `bytes` starts as, if any: FF D8 FF is a JPEG, the 8-byte signature a PNG.
pub fn picture_kind(bytes: &[u8]) -> Option<PictureKind> {
    if looks_like_jpeg(bytes) {
        Some(PictureKind::Jpeg)
    } else if crate::photo_png::looks_like_png(bytes) {
        Some(PictureKind::Png)
    } else {
        None
    }
}

/// How many bytes at the start of a file say what kind of picture it is.
pub const SNIFF_BYTES: usize = 8;

/// Whether the first bytes seen so far (fewer than `SNIFF_BYTES` is fine) can still be the start of
/// a JPEG or a PNG, so that a reader can stop at the first byte that cannot be.
pub fn could_start_a_picture(prefix: &[u8]) -> bool {
    JPEG_START.starts_with(&prefix[..prefix.len().min(JPEG_START.len())])
        || prefix.starts_with(&JPEG_START)
        || crate::photo_png::PNG_SIGNATURE
            .starts_with(&prefix[..prefix.len().min(crate::photo_png::PNG_SIGNATURE.len())])
        || prefix.starts_with(&crate::photo_png::PNG_SIGNATURE)
}

/// The cleaned picture a patient brought, and which kind it is: a JPEG goes through
/// `clean_picture` (orientation and a plain colour profile kept), a PNG through
/// `photo_png::clean_png` (only the chunks that draw it). The same function runs when a picture is
/// imported and every time it is shown.
pub fn clean_any(input: &[u8]) -> Result<(PictureKind, Zeroizing<Vec<u8>>), PhotoError> {
    match picture_kind(input) {
        Some(PictureKind::Jpeg) => clean_picture(input).map(|bytes| (PictureKind::Jpeg, bytes)),
        Some(PictureKind::Png) => {
            crate::photo_png::clean_png(input).map(|bytes| (PictureKind::Png, bytes))
        }
        None if input.len() > MAX_PHOTO_BYTES => Err(PhotoError::TooLarge),
        None => Err(PhotoError::NotJpeg),
    }
}

const SOI: u8 = 0xd8;
const EOI: u8 = 0xd9;
const SOS: u8 = 0xda;
const APP0: u8 = 0xe0;
/// A JFIF header with no thumbnail: "JFIF\0", version, units, two densities
/// and a 0 x 0 thumbnail, after the two length bytes.
const JFIF_LENGTH: usize = 16;

/// How every JPEG starts: the start-of-image marker and the first byte of the
/// next marker.
pub const JPEG_START: [u8; 3] = [0xff, SOI, 0xff];

/// Whether the bytes start as every JPEG does.
pub fn looks_like_jpeg(bytes: &[u8]) -> bool {
    bytes.starts_with(&JPEG_START)
}

/// Returns the JPEG with only what is needed to draw it: the start and end
/// markers, a plain JFIF header, the quantization and Huffman tables, the
/// restart interval, the one frame header, and the scans with their data.
/// Every APP1 to APP15 segment (Exif with GPS, XMP, IPTC, ICC profiles, maker
/// data), a JFIF header that carries a thumbnail or an extension, comments,
/// and anything after the end marker are dropped. Anything else the markers
/// do not describe as a single 8-bit baseline or progressive image of at most
/// `MAX_PHOTO_SIDE` pixels a side is refused.
pub fn clean_jpeg(input: &[u8]) -> Result<Zeroizing<Vec<u8>>, PhotoError> {
    clean_core(input)
}

/// `clean_jpeg` for a picture the patient brought (imported, or shown after it was): the same
/// walk, then two things the patient needs are put back, **rebuilt, never copied**:
/// - the **orientation** (Exif tag 0x0112, a value 1 to 8), as the only entry of a minimal Exif
///   block, so that a portrait photo a phone stored sideways still shows upright. An orientation
///   of 1 (or none) needs no block. No place, time, device or thumbnail survives: the block is
///   built here, 34 bytes, and holds nothing else.
/// - a **colour profile, rebuilt** (`rebuild_icc`): a matrix and curve RGB profile (what phones
///   write) is read for its colour numbers only and written again with a zeroed header and our own
///   fixed description and copyright, so no maker, model, date, creator, id or text survives. Skin
///   and rash colours matter in a health picture. A profile of any other kind is dropped and the
///   picture shows as sRGB.
///
/// Whatever follows the first end-of-image marker (the gain map and MPF index that Ultra HDR and
/// iPhone files append) is never copied: only the primary image is kept.
///
/// Running it again on its own output gives the same bytes.
pub fn clean_picture(input: &[u8]) -> Result<Zeroizing<Vec<u8>>, PhotoError> {
    let core = clean_core(input)?;
    let (orientation, profile) = wanted_metadata(input);
    let mut extra = Vec::new();
    if let Some(orientation) = orientation {
        extra.extend_from_slice(&orientation_block(orientation));
    }
    if let Some(profile) = profile {
        extra.extend_from_slice(&icc_segment(&profile));
    }
    if extra.is_empty() {
        return Ok(core);
    }
    // After the JFIF header, which `clean_core` writes first when the picture has a plain one.
    let at = if core.get(2..4) == Some(&[0xff, APP0]) {
        2 + 2 + JFIF_LENGTH
    } else {
        2
    };
    let mut output = Zeroizing::new(Vec::with_capacity(core.len() + extra.len()));
    output.extend_from_slice(&core[..at]);
    output.extend_from_slice(&extra);
    output.extend_from_slice(&core[at..]);
    if output.len() > MAX_PHOTO_BYTES {
        return Err(PhotoError::TooLarge);
    }
    Ok(output)
}

fn clean_core(input: &[u8]) -> Result<Zeroizing<Vec<u8>>, PhotoError> {
    if input.len() > MAX_PHOTO_BYTES {
        return Err(PhotoError::TooLarge);
    }
    if !looks_like_jpeg(input) {
        return Err(PhotoError::NotJpeg);
    }
    let mut output = Zeroizing::new(Vec::with_capacity(input.len()));
    output.extend_from_slice(&[0xff, SOI]);
    let mut position = 2;
    let mut frames = 0_u8;
    let mut scans = 0_usize;
    loop {
        // A marker is 0xFF, any number of 0xFF fill bytes, then its code.
        if input.get(position) != Some(&0xff) {
            return Err(PhotoError::NotJpeg);
        }
        while input.get(position) == Some(&0xff) {
            position += 1;
        }
        let code = *input.get(position).ok_or(PhotoError::NotJpeg)?;
        position += 1;
        match code {
            EOI if scans > 0 => {
                output.extend_from_slice(&[0xff, EOI]);
                // What follows the end of the image is not part of it: a
                // phone may append a video or its own metadata there.
                return Ok(output);
            }
            // The end before any scan, a second start, a restart marker
            // outside a scan, or a stuffed zero where a marker belongs.
            EOI | SOI | 0x00 | 0x01 | 0xd0..=0xd7 => return Err(PhotoError::NotJpeg),
            _ => {}
        }
        let length = input
            .get(position..position + 2)
            .map(|bytes| usize::from(u16::from_be_bytes([bytes[0], bytes[1]])))
            .filter(|length| *length >= 2)
            .ok_or(PhotoError::NotJpeg)?;
        let end = position + length;
        // The segment, from its length bytes on.
        let segment = input.get(position..end).ok_or(PhotoError::NotJpeg)?;
        let keep = match code {
            APP0 => plain_jfif(segment),
            // Quantization tables, Huffman tables, the restart interval.
            0xdb | 0xc4 => true,
            0xdd => {
                if length != 4 {
                    return Err(PhotoError::NotJpeg);
                }
                true
            }
            // Exif (with any GPS position), XMP, ICC, IPTC, maker data;
            // comments.
            0xe1..=0xef | 0xfe => false,
            // Baseline and progressive frames.
            0xc0 | 0xc2 => {
                frames += 1;
                if frames > 1 {
                    return Err(PhotoError::NotJpeg);
                }
                check_frame(segment)?;
                true
            }
            SOS => {
                if frames != 1 {
                    return Err(PhotoError::NotJpeg);
                }
                check_scan(segment)?;
                true
            }
            // Other frames (extended, lossless, hierarchical, arithmetic
            // coding), DNL, DHP, EXP, and the reserved codes.
            _ => return Err(PhotoError::NotJpeg),
        };
        if keep {
            output.extend_from_slice(&[0xff, code]);
            output.extend_from_slice(segment);
        }
        position = end;
        if code == SOS {
            scans += 1;
            // The scan's data runs to the next marker that is not a stuffed
            // zero or a restart marker.
            let start = position;
            loop {
                let next = input[position..]
                    .iter()
                    .position(|byte| *byte == 0xff)
                    .map(|offset| position + offset)
                    .ok_or(PhotoError::NotJpeg)?;
                match input.get(next + 1) {
                    Some(0x00 | 0xd0..=0xd7) => position = next + 2,
                    Some(_) => {
                        position = next;
                        break;
                    }
                    None => return Err(PhotoError::NotJpeg),
                }
            }
            output.extend_from_slice(&input[start..position]);
        }
    }
}

/// The most bytes of a colour profile that is kept: it then fits in one APP2 segment.
pub const MAX_ICC_BYTES: usize = 64 * 1024 - 64;
const APP1: u8 = 0xe1;
const APP2: u8 = 0xe2;
const ICC_TAG: &[u8; 12] = b"ICC_PROFILE\0";
/// The most APP2 segments a colour profile may come in.
const MAX_ICC_CHUNKS: usize = 9;

/// The orientation (2 to 8; 1 means upright and is not worth a block) and the colour profile the
/// header of `input` carries, read leniently: anything unreadable or odd is "none". It stops at
/// the first scan. `clean_core` has already accepted `input` as a whole.
fn wanted_metadata(input: &[u8]) -> (Option<u16>, Option<Vec<u8>>) {
    let mut orientation = None;
    let mut chunks: Vec<(u8, u8, &[u8])> = Vec::new();
    let mut position = 2;
    let mut exif_seen = false;
    let mut too_many_chunks = false;
    while input.get(position) == Some(&0xff) {
        while input.get(position) == Some(&0xff) {
            position += 1;
        }
        let Some(&code) = input.get(position) else {
            break;
        };
        position += 1;
        if code == SOS || code == EOI {
            break;
        }
        let Some(length) = input
            .get(position..position + 2)
            .map(|bytes| usize::from(u16::from_be_bytes([bytes[0], bytes[1]])))
            .filter(|length| *length >= 2)
        else {
            break;
        };
        let Some(payload) = input.get(position + 2..position + length) else {
            break;
        };
        match code {
            // Only the first Exif block counts.
            APP1 if !exif_seen && payload.starts_with(b"Exif\0\0") => {
                exif_seen = true;
                orientation = exif_orientation(&payload[6..]).filter(|value| *value != 1);
            }
            APP2 if payload.starts_with(ICC_TAG) && payload.len() >= ICC_TAG.len() + 2 => {
                // A profile is at most `MAX_ICC_CHUNKS` pieces; more than that is no profile, and
                // the rest are not collected.
                if chunks.len() >= MAX_ICC_CHUNKS {
                    too_many_chunks = true;
                } else {
                    let (sequence, total) = (payload[12], payload[13]);
                    chunks.push((sequence, total, &payload[14..]));
                }
            }
            _ => {}
        }
        position += length;
    }
    let profile = if too_many_chunks {
        None
    } else {
        join_icc(chunks)
    };
    (orientation, profile)
}

/// The profile in its chunks (each APP2 segment carries a sequence number and the total), when
/// they are all there, once each, and the whole can be rebuilt as a plain profile (`rebuild_icc`).
fn join_icc(mut chunks: Vec<(u8, u8, &[u8])>) -> Option<Vec<u8>> {
    let total = usize::from(chunks.first()?.1);
    if total == 0
        || total > MAX_ICC_CHUNKS
        || chunks.len() != total
        || chunks.iter().any(|c| usize::from(c.1) != total)
    {
        return None;
    }
    chunks.sort_by_key(|chunk| chunk.0);
    if chunks
        .iter()
        .enumerate()
        .any(|(index, chunk)| usize::from(chunk.0) != index + 1)
    {
        return None;
    }
    let profile: Vec<u8> = chunks
        .iter()
        .flat_map(|chunk| chunk.2.iter().copied())
        .collect();
    rebuild_icc(&profile)
}

/// A colour profile **rebuilt**, never copied: what the picture needs to show its colours and
/// nothing a camera or a person put in the file. A profile carries free text (its description, its
/// copyright, the device's maker and model) and a header of device and date fields, and a file may
/// hide bytes between its tags; none of that is data about the picture, but all of it can be data
/// about the person, so only the numbers that make the colours are read out of the input and a
/// new profile is written around them:
/// - only an RGB display profile with an XYZ connection space is rebuilt (class `mntr`, colour
///   space `RGB `, connection space `XYZ `, a version of 4 or less): the matrix and curve kind
///   that phone cameras write (sRGB, Display P3, Adobe RGB). A profile built on lookup tables
///   (`A2B0` and the like), a gray, CMYK or other profile, and anything malformed gives `None`, and
///   the picture shows as sRGB;
/// - of its tags only `rXYZ gXYZ bXYZ rTRC gTRC bTRC wtpt` (all required) and `chad` and `cicp`
///   (when there) are read, each checked down to its type, exact size and reserved bytes, the
///   colour numbers within a sane range and each curve non-decreasing, so no text and little else
///   can ride in them; every other tag, whatever it is called, is dropped;
/// - the header is written new with zeros everywhere a device, a date, a maker, a model, a
///   creator or a profile id would go; only the class, the colour spaces, the rendering intent
///   (0 to 3) and the standard D50 illuminant are set, and the version is written as 4.3;
/// - the description and the copyright are our own fixed words, the tags are laid end to end on
///   four-byte boundaries with zero padding, and the result is at most [`MAX_ICC_BYTES`].
///
/// Running it again on its own output gives the same bytes.
fn rebuild_icc(profile: &[u8]) -> Option<Vec<u8>> {
    const HEADER: usize = 128;
    if profile.len() < HEADER + 4 || profile.len() > MAX_ICC_BYTES {
        return None;
    }
    let word = |at: usize| -> Option<u32> {
        Some(u32::from_be_bytes(
            profile.get(at..at.checked_add(4)?)?.try_into().ok()?,
        ))
    };
    if word(0)? as usize != profile.len()
        || profile.get(36..40)? != b"acsp"
        || profile[8] > 4
        || profile.get(12..16)? != b"mntr"
        || profile.get(16..20)? != b"RGB "
        || profile.get(20..24)? != b"XYZ "
    {
        return None;
    }
    let intent = word(64)?;
    if intent > 3 {
        return None;
    }
    let count = word(HEADER)? as usize;
    if count == 0 || count > 100 || HEADER + 4 + 12 * count > profile.len() {
        return None;
    }
    // The wanted tags, each at most once, as (signature, its bytes).
    let mut taken: Vec<([u8; 4], Vec<u8>)> = Vec::new();
    for index in 0..count {
        let entry = HEADER + 4 + 12 * index;
        let signature: [u8; 4] = profile.get(entry..entry + 4)?.try_into().ok()?;
        let wanted = matches!(
            &signature,
            b"rXYZ" | b"gXYZ" | b"bXYZ" | b"rTRC" | b"gTRC" | b"bTRC" | b"wtpt" | b"chad" | b"cicp"
        );
        if !wanted {
            continue;
        }
        if taken.iter().any(|(seen, _)| *seen == signature) {
            return None;
        }
        let offset = word(entry + 4)? as usize;
        let size = word(entry + 8)? as usize;
        let data = profile.get(offset..offset.checked_add(size)?)?;
        if !tag_is_plain(&signature, data) {
            return None;
        }
        taken.push((signature, data.to_vec()));
    }
    for required in [
        b"rXYZ", b"gXYZ", b"bXYZ", b"rTRC", b"gTRC", b"bTRC", b"wtpt",
    ] {
        if !taken.iter().any(|(seen, _)| seen == required) {
            return None;
        }
    }
    taken.push((*b"desc", mluc("Colour profile")));
    taken.push((*b"cprt", mluc("No copyright")));
    taken.sort_by_key(|tag| tag.0);

    let table = HEADER + 4 + 12 * taken.len();
    let mut offsets = Vec::with_capacity(taken.len());
    let mut at = table;
    for (_, data) in &taken {
        offsets.push(at);
        at += data.len().div_ceil(4) * 4;
    }
    if at > MAX_ICC_BYTES {
        return None;
    }
    let mut out = vec![0_u8; at];
    out[0..4].copy_from_slice(&u32::try_from(at).ok()?.to_be_bytes());
    out[8..12].copy_from_slice(&[4, 0x30, 0, 0]);
    out[12..16].copy_from_slice(b"mntr");
    out[16..20].copy_from_slice(b"RGB ");
    out[20..24].copy_from_slice(b"XYZ ");
    out[36..40].copy_from_slice(b"acsp");
    out[64..68].copy_from_slice(&intent.to_be_bytes());
    // The standard D50 illuminant (X 0.9642, Y 1.0, Z 0.8249) as s15Fixed16.
    out[68..72].copy_from_slice(&0x0000_f6d6_u32.to_be_bytes());
    out[72..76].copy_from_slice(&0x0001_0000_u32.to_be_bytes());
    out[76..80].copy_from_slice(&0x0000_d32d_u32.to_be_bytes());
    out[HEADER..HEADER + 4].copy_from_slice(&u32::try_from(taken.len()).ok()?.to_be_bytes());
    for (index, (signature, data)) in taken.iter().enumerate() {
        let entry = HEADER + 4 + 12 * index;
        out[entry..entry + 4].copy_from_slice(signature);
        out[entry + 4..entry + 8]
            .copy_from_slice(&u32::try_from(offsets[index]).ok()?.to_be_bytes());
        out[entry + 8..entry + 12].copy_from_slice(&u32::try_from(data.len()).ok()?.to_be_bytes());
        out[offsets[index]..offsets[index] + data.len()].copy_from_slice(data);
    }
    Some(out)
}

/// A tag read from a profile, accepted only if it is exactly the kind of tag its name says and
/// nothing else: the right type, the exact size, zero reserved bytes, numbers in a sane range.
fn tag_is_plain(signature: &[u8; 4], data: &[u8]) -> bool {
    let kind = data.get(..4);
    let is = |wanted: &[u8; 4]| kind == Some(&wanted[..]);
    // Reserved bytes 4 to 8 of every tag type are zero.
    if data.len() < 8 || data[4..8] != [0, 0, 0, 0] {
        return false;
    }
    let be32 = |at: usize| -> Option<u32> {
        Some(u32::from_be_bytes(data.get(at..at + 4)?.try_into().ok()?))
    };
    match signature {
        // A colour: three s15Fixed16 numbers, each between 0 and 2.
        b"rXYZ" | b"gXYZ" | b"bXYZ" | b"wtpt" => {
            data.len() == 20
                && is(b"XYZ ")
                && (0..3).all(|index| be32(8 + 4 * index).is_some_and(|value| value <= 0x0002_0000))
        }
        b"rTRC" | b"gTRC" | b"bTRC" => {
            if is(b"curv") {
                // A table of 16-bit values that never goes down; 0 entries is the identity and
                // 1 a gamma.
                let Some(entries) = be32(8).map(|n| n as usize) else {
                    return false;
                };
                entries <= 4096
                    && data.len() == 12 + 2 * entries
                    && data[12..]
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .map(|pair| u16::from_be_bytes(*pair))
                        .is_sorted()
            } else if is(b"para") {
                // A parametric curve: a function type 0 to 4 and its 1, 3, 4, 5 or 7 parameters.
                let function = data.get(8..10).map_or(usize::MAX, |bytes| {
                    usize::from(u16::from_be_bytes([bytes[0], bytes[1]]))
                });
                let parameters = [1_usize, 3, 4, 5, 7].get(function).copied();
                data.get(10..12) == Some(&[0_u8, 0][..])
                    && parameters.is_some_and(|n| data.len() == 12 + 4 * n)
            } else {
                false
            }
        }
        // The chromatic adaptation matrix: nine s15Fixed16 numbers, each between -4 and 4.
        b"chad" => {
            data.len() == 44
                && is(b"sf32")
                && (0..9).all(|index| {
                    be32(8 + 4 * index).is_some_and(|value| {
                        let signed = value as i32;
                        (-0x0004_0000..=0x0004_0000).contains(&signed)
                    })
                })
        }
        // Colour codes: four one-byte codes.
        b"cicp" => data.len() == 12 && is(b"cicp"),
        _ => false,
    }
}

/// A multi-localized text tag with one English record: the words are ours, never the file's.
fn mluc(text: &str) -> Vec<u8> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut tag = b"mluc".to_vec();
    tag.extend_from_slice(&[0, 0, 0, 0]);
    tag.extend_from_slice(&1_u32.to_be_bytes());
    tag.extend_from_slice(&12_u32.to_be_bytes());
    tag.extend_from_slice(b"enUS");
    tag.extend_from_slice(&u32::try_from(units.len() * 2).unwrap_or(0).to_be_bytes());
    tag.extend_from_slice(&28_u32.to_be_bytes());
    for unit in units {
        tag.extend_from_slice(&unit.to_be_bytes());
    }
    tag
}

/// The orientation of an Exif TIFF block: IFD0's tag 0x0112, a SHORT of count 1 with a value of
/// 1 to 8. Every read is bounds-checked; anything odd is `None`.
fn exif_orientation(tiff: &[u8]) -> Option<u16> {
    let big = match tiff.get(..2)? {
        b"MM" => true,
        b"II" => false,
        _ => return None,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let bytes: [u8; 2] = tiff.get(at..at + 2)?.try_into().ok()?;
        Some(if big {
            u16::from_be_bytes(bytes)
        } else {
            u16::from_le_bytes(bytes)
        })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let bytes: [u8; 4] = tiff.get(at..at + 4)?.try_into().ok()?;
        Some(if big {
            u32::from_be_bytes(bytes)
        } else {
            u32::from_le_bytes(bytes)
        })
    };
    if u16_at(2)? != 42 {
        return None;
    }
    let ifd = usize::try_from(u32_at(4)?).ok()?;
    let entries = usize::from(u16_at(ifd)?);
    for index in 0..entries.min(512) {
        let entry = ifd.checked_add(2 + 12 * index)?;
        if u16_at(entry)? == 0x0112 {
            // Type SHORT (3), count 1; the value sits in the first two bytes of the value field.
            if u16_at(entry + 2)? != 3 || u32_at(entry + 4)? != 1 {
                return None;
            }
            return u16_at(entry + 8).filter(|value| (1..=8).contains(value));
        }
    }
    None
}

/// An Exif APP1 segment with the orientation and nothing else (big-endian TIFF, one IFD entry).
fn orientation_block(orientation: u16) -> Vec<u8> {
    let mut block = vec![0xff, APP1, 0x00, 0x22];
    block.extend_from_slice(b"Exif\0\0MM\0\x2a\0\0\0\x08");
    block.extend_from_slice(&[0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1]);
    block.extend_from_slice(&orientation.to_be_bytes());
    block.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
    block
}

/// The profile as one APP2 segment (it is at most [`MAX_ICC_BYTES`]).
fn icc_segment(profile: &[u8]) -> Vec<u8> {
    let length = u16::try_from(2 + ICC_TAG.len() + 2 + profile.len()).unwrap_or(u16::MAX);
    let mut segment = vec![0xff, APP2];
    segment.extend_from_slice(&length.to_be_bytes());
    segment.extend_from_slice(ICC_TAG);
    segment.extend_from_slice(&[1, 1]);
    segment.extend_from_slice(profile);
    segment
}

/// A JFIF header and nothing else: no thumbnail, and not the JFXX extension,
/// which carries one.
fn plain_jfif(segment: &[u8]) -> bool {
    segment.len() == JFIF_LENGTH && segment[2..7] == *b"JFIF\0" && segment[14..16] == [0, 0]
}

/// One 8-bit frame of one to four components, at least one and at most
/// `MAX_PHOTO_SIDE` pixels a side.
fn check_frame(segment: &[u8]) -> Result<(), PhotoError> {
    let [_, _, precision, height_high, height_low, width_high, width_low, components, ..] =
        *segment
    else {
        return Err(PhotoError::NotJpeg);
    };
    if precision != 8
        || !(1..=4).contains(&components)
        || segment.len() != 8 + 3 * usize::from(components)
    {
        return Err(PhotoError::NotJpeg);
    }
    let height = u16::from_be_bytes([height_high, height_low]);
    let width = u16::from_be_bytes([width_high, width_low]);
    // A height of 0 would be given later, by a DNL marker, which is refused.
    if height == 0 || width == 0 {
        return Err(PhotoError::NotJpeg);
    }
    if height > MAX_PHOTO_SIDE || width > MAX_PHOTO_SIDE {
        return Err(PhotoError::TooLarge);
    }
    Ok(())
}

/// A scan header for one to four components.
fn check_scan(segment: &[u8]) -> Result<(), PhotoError> {
    match segment.get(2) {
        Some(&components)
            if (1..=4).contains(&components)
                && segment.len() == 6 + 2 * usize::from(components) =>
        {
            Ok(())
        }
        _ => Err(PhotoError::NotJpeg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::LazyLock;

    /// A 16 x 8 JPEG that Chromium's canvas encoded (`toBlob("image/jpeg",
    /// 0.9)`), as the camera dialog does: a JFIF header, an sRGB colour
    /// profile (APP2), tables, one baseline frame and scan. See
    /// testdata/README.md.
    const CANVAS_JPEG: &[u8] = include_bytes!("../testdata/canvas-photo.jpg");
    /// The same JPEG without its colour profile, found by hand here rather
    /// than by the code under test: what cleaning it should give.
    static PLAIN: LazyLock<Vec<u8>> = LazyLock::new(|| {
        let profile = 2 + 2 + JFIF_LENGTH;
        assert_eq!(CANVAS_JPEG[profile..profile + 2], [0xff, 0xe2]);
        let length = usize::from(u16::from_be_bytes([
            CANVAS_JPEG[profile + 2],
            CANVAS_JPEG[profile + 3],
        ]));
        [
            &CANVAS_JPEG[..profile],
            &CANVAS_JPEG[profile + 2 + length..],
        ]
        .concat()
    });

    fn segment(code: u8, payload: &[u8]) -> Vec<u8> {
        let length = u16::try_from(payload.len() + 2).unwrap();
        let mut bytes = vec![0xff, code];
        bytes.extend_from_slice(&length.to_be_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    /// An Exif block as a phone camera writes one: a TIFF header, an IFD0
    /// with the camera's make and a pointer to a GPS IFD holding a latitude
    /// and longitude (43° 39′ 12″ N, 79° 22′ 48″ W).
    fn exif_with_gps() -> Vec<u8> {
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"MM\0\x2a\0\0\0\x08");
        // IFD0 at 8: two entries, Make (ASCII, at 38) and GPSInfo (at 50).
        tiff.extend_from_slice(&[0, 2]);
        tiff.extend_from_slice(&[0x01, 0x0f, 0, 2, 0, 0, 0, 12, 0, 0, 0, 38]);
        tiff.extend_from_slice(&[0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 50]);
        tiff.extend_from_slice(&[0, 0, 0, 0]);
        tiff.extend_from_slice(b"FAKE Phone\0\0");
        assert_eq!(tiff.len(), 50);
        // The GPS IFD: LatitudeRef "N", Latitude (3 rationals at 104),
        // LongitudeRef "W", Longitude (3 rationals at 128).
        tiff.extend_from_slice(&[0, 4]);
        tiff.extend_from_slice(&[0, 1, 0, 2, 0, 0, 0, 2, b'N', 0, 0, 0]);
        tiff.extend_from_slice(&[0, 2, 0, 5, 0, 0, 0, 3, 0, 0, 0, 104]);
        tiff.extend_from_slice(&[0, 3, 0, 2, 0, 0, 0, 2, b'W', 0, 0, 0]);
        tiff.extend_from_slice(&[0, 4, 0, 5, 0, 0, 0, 3, 0, 0, 0, 128]);
        tiff.extend_from_slice(&[0, 0, 0, 0]);
        assert_eq!(tiff.len(), 104);
        for value in [43_u32, 39, 12, 79, 22, 48] {
            tiff.extend_from_slice(&value.to_be_bytes());
            tiff.extend_from_slice(&1_u32.to_be_bytes());
        }
        let mut exif = b"Exif\0\0".to_vec();
        exif.extend_from_slice(&tiff);
        exif
    }

    /// The canvas JPEG with the metadata a phone or editor adds, after its
    /// JFIF header: Exif with GPS, XMP, an ICC profile, IPTC, a comment, a
    /// thumbnail extension, and a video appended after the end marker.
    fn with_metadata(jpeg: &[u8]) -> Vec<u8> {
        let mut bytes = jpeg[..2 + 2 + JFIF_LENGTH].to_vec();
        bytes.extend(segment(0xe1, &exif_with_gps()));
        bytes.extend(segment(
            0xe1,
            b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><exif:GPSLatitude>43,39.2N</exif:GPSLatitude></x:xmpmeta>",
        ));
        bytes.extend(segment(0xe2, b"ICC_PROFILE\0\x01\x01FAKE profile"));
        bytes.extend(segment(0xed, b"Photoshop 3.0\08BIM FAKE caption"));
        bytes.extend(segment(0xfe, b"FAKE comment: taken at home"));
        bytes.extend(segment(0xe0, b"JFXX\0\x10FAKE thumbnail"));
        bytes.extend_from_slice(&jpeg[2 + 2 + JFIF_LENGTH..]);
        bytes.extend_from_slice(b"ftypmp42 FAKE motion photo video");
        bytes
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }

    /// The marker codes in a JPEG, outside its scan data.
    fn markers(jpeg: &[u8]) -> Vec<u8> {
        let mut codes = vec![jpeg[1]];
        let mut position = 2;
        loop {
            let code = jpeg[position + 1];
            codes.push(code);
            if code == EOI {
                return codes;
            }
            position +=
                2 + usize::from(u16::from_be_bytes([jpeg[position + 2], jpeg[position + 3]]));
            if code == SOS {
                while !(jpeg[position] == 0xff && !matches!(jpeg[position + 1], 0x00 | 0xd0..=0xd7))
                {
                    position += 1;
                }
            }
        }
    }

    #[test]
    fn a_canvas_photo_loses_only_its_colour_profile() {
        assert_eq!(
            markers(CANVAS_JPEG),
            [SOI, APP0, 0xe2, 0xdb, 0xdb, 0xc0, 0xc4, 0xc4, 0xc4, 0xc4, SOS, EOI],
            "the fixture is not the canvas output these tests assume"
        );
        assert_eq!(*clean_jpeg(CANVAS_JPEG).unwrap(), *PLAIN);
        // Cleaning is idempotent: a cleaned photo is kept byte for byte.
        assert_eq!(*clean_jpeg(&PLAIN).unwrap(), *PLAIN);
    }

    #[test]
    fn gps_and_every_other_kind_of_metadata_are_removed() {
        let tagged = with_metadata(&PLAIN);
        assert!(contains(&tagged, &exif_with_gps()));
        let cleaned = clean_jpeg(&tagged).unwrap();
        // Exactly the canvas photo again: the image segments are unchanged,
        // and nothing of what was added is left.
        assert_eq!(*cleaned, *PLAIN);
        for added in [
            &b"Exif"[..],
            b"FAKE Phone",
            b"GPSLatitude",
            b"ICC_PROFILE",
            b"8BIM",
            b"taken at home",
            b"JFXX",
            b"motion photo",
        ] {
            assert!(
                !contains(&cleaned, added),
                "{:?}",
                String::from_utf8_lossy(added)
            );
        }
        assert!(!markers(&cleaned)
            .iter()
            .any(|code| matches!(code, 0xe1..=0xef | 0xfe)));
    }

    #[test]
    fn a_jfif_header_with_a_thumbnail_is_dropped() {
        let mut thumbnail = PLAIN[4..4 + JFIF_LENGTH - 2].to_vec();
        // A 1 x 1 thumbnail, and its one RGB pixel.
        thumbnail[12..14].copy_from_slice(&[1, 1]);
        thumbnail.extend_from_slice(&[0xff, 0, 0]);
        let mut jpeg = vec![0xff, SOI];
        jpeg.extend(segment(APP0, &thumbnail));
        jpeg.extend_from_slice(&PLAIN[2 + 2 + JFIF_LENGTH..]);
        let cleaned = clean_jpeg(&jpeg).unwrap();
        assert_eq!(cleaned[..2], [0xff, SOI]);
        assert_eq!(
            *cleaned,
            [&[0xff, SOI][..], &PLAIN[2 + 2 + JFIF_LENGTH..]].concat()
        );
    }

    #[test]
    fn stuffed_bytes_and_restart_markers_stay_in_the_scan() {
        let sos = PLAIN
            .windows(2)
            .position(|window| window == [0xff, SOS])
            .unwrap();
        let header = 2 + usize::from(u16::from_be_bytes([PLAIN[sos + 2], PLAIN[sos + 3]]));
        let mut jpeg = PLAIN[..sos + header].to_vec();
        let data = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd7, 0x78];
        jpeg.extend_from_slice(&data);
        jpeg.extend_from_slice(&[0xff, EOI]);
        let cleaned = clean_jpeg(&jpeg).unwrap();
        assert_eq!(*cleaned, jpeg);
    }

    #[test]
    fn a_progressive_photo_keeps_its_tables_between_scans() {
        let sos = PLAIN
            .windows(2)
            .position(|window| window == [0xff, SOS])
            .unwrap();
        let mut jpeg = PLAIN[..sos].to_vec();
        let frame = jpeg
            .windows(2)
            .position(|window| window == [0xff, 0xc0])
            .unwrap();
        jpeg[frame + 1] = 0xc2;
        let scan = segment(SOS, &[1, 1, 0x00, 0, 63, 0]);
        jpeg.extend(&scan);
        jpeg.extend_from_slice(&[0x12, 0x34]);
        jpeg.extend(segment(0xfe, b"FAKE note between scans"));
        jpeg.extend(segment(0xc4, &[0x10; 17]));
        jpeg.extend(&scan);
        jpeg.extend_from_slice(&[0x56]);
        jpeg.extend_from_slice(&[0xff, EOI]);
        let cleaned = clean_jpeg(&jpeg).unwrap();
        assert!(!contains(&cleaned, b"FAKE note"));
        assert_eq!(
            markers(&cleaned)
                .iter()
                .filter(|code| **code == SOS)
                .count(),
            2
        );
        assert_eq!(
            markers(&cleaned)
                .iter()
                .filter(|code| **code == 0xc4)
                .count(),
            5
        );
    }

    #[test]
    fn anything_that_is_not_one_complete_jpeg_is_refused() {
        let sos = PLAIN
            .windows(2)
            .position(|window| window == [0xff, SOS])
            .unwrap();
        let frame_at = PLAIN
            .windows(2)
            .position(|window| window == [0xff, 0xc0])
            .unwrap();
        let frame_end = frame_at
            + 2
            + usize::from(u16::from_be_bytes([
                PLAIN[frame_at + 2],
                PLAIN[frame_at + 3],
            ]));
        let with_code = |at: usize, code: u8| {
            let mut jpeg = PLAIN.to_vec();
            jpeg[at + 1] = code;
            jpeg
        };
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("empty", Vec::new()),
            ("a PNG", png),
            ("only the start marker", vec![0xff, SOI]),
            ("cut off in the scan", PLAIN[..PLAIN.len() - 2].to_vec()),
            ("cut off in a segment", PLAIN[..frame_at + 5].to_vec()),
            ("no scan", [&PLAIN[..sos], &[0xff, EOI][..]].concat()),
            (
                "no frame",
                [&PLAIN[..frame_at], &PLAIN[frame_end..]].concat(),
            ),
            (
                "two frames",
                [&PLAIN[..frame_end], &PLAIN[frame_at..]].concat(),
            ),
            ("an extended frame", with_code(frame_at, 0xc1)),
            ("a lossless frame", with_code(frame_at, 0xc3)),
            ("an arithmetic-coded frame", with_code(frame_at, 0xc9)),
            ("a second start marker", with_code(frame_at, SOI)),
            ("a restart marker outside a scan", with_code(frame_at, 0xd0)),
            ("a DNL marker", with_code(frame_at, 0xdc)),
            ("a reserved marker", with_code(frame_at, 0xf0)),
            (
                "garbage between segments",
                [&PLAIN[..frame_at], &[0x00][..], &PLAIN[frame_at..]].concat(),
            ),
            (
                "a length under 2",
                [
                    &PLAIN[..frame_at],
                    &[0xff, 0xfe, 0, 1][..],
                    &PLAIN[frame_at..],
                ]
                .concat(),
            ),
        ];
        for (case, bytes) in cases {
            assert_eq!(
                clean_jpeg(&bytes).unwrap_err(),
                PhotoError::NotJpeg,
                "{case}"
            );
        }
        let mut twelve_bit = PLAIN.to_vec();
        twelve_bit[frame_at + 4] = 12;
        assert_eq!(clean_jpeg(&twelve_bit).unwrap_err(), PhotoError::NotJpeg);
        let mut no_height = PLAIN.to_vec();
        no_height[frame_at + 5..frame_at + 7].copy_from_slice(&[0, 0]);
        assert_eq!(clean_jpeg(&no_height).unwrap_err(), PhotoError::NotJpeg);
    }

    #[test]
    fn photos_over_the_caps_are_refused() {
        let frame_at = PLAIN
            .windows(2)
            .position(|window| window == [0xff, 0xc0])
            .unwrap();
        for (height, width) in [(8193_u16, 16_u16), (8, 8193), (u16::MAX, u16::MAX)] {
            let mut jpeg = PLAIN.to_vec();
            jpeg[frame_at + 5..frame_at + 7].copy_from_slice(&height.to_be_bytes());
            jpeg[frame_at + 7..frame_at + 9].copy_from_slice(&width.to_be_bytes());
            assert_eq!(
                clean_jpeg(&jpeg).unwrap_err(),
                PhotoError::TooLarge,
                "{height} x {width}"
            );
        }
        let mut largest = PLAIN.to_vec();
        largest[frame_at + 5..frame_at + 9].copy_from_slice(&[0x20, 0, 0x20, 0]);
        assert!(clean_jpeg(&largest).is_ok(), "8192 x 8192 is allowed");

        let comment = segment(0xfe, &[b'x'; 65_533]);
        let mut big = PLAIN[..2].to_vec();
        while big.len() + comment.len() + PLAIN.len() <= MAX_PHOTO_BYTES {
            big.extend_from_slice(&comment);
        }
        let mut exactly = big.clone();
        exactly.extend_from_slice(&PLAIN[2..]);
        exactly.resize(MAX_PHOTO_BYTES, 0);
        assert!(
            clean_jpeg(&exactly).is_ok(),
            "{} bytes is allowed",
            MAX_PHOTO_BYTES
        );
        exactly.push(0);
        assert_eq!(clean_jpeg(&exactly).unwrap_err(), PhotoError::TooLarge);
    }

    #[test]
    fn the_magic_bytes_decide_what_looks_like_a_jpeg() {
        assert!(looks_like_jpeg(&PLAIN));
        assert!(!looks_like_jpeg(b"%PDF-1.7"));
        assert!(!looks_like_jpeg(&[0xff, SOI]));
        assert!(!looks_like_jpeg(&[0xff, 0xd9, 0xff]));
    }

    // ---- pictures the patient brings: orientation and a plain colour profile are kept ----

    /// The canvas photo (no colour profile) with `segments` after its JFIF header.
    fn with_segments(segments: &[Vec<u8>]) -> Vec<u8> {
        let mut bytes = PLAIN[..2 + 2 + JFIF_LENGTH].to_vec();
        for segment in segments {
            bytes.extend_from_slice(segment);
        }
        bytes.extend_from_slice(&PLAIN[2 + 2 + JFIF_LENGTH..]);
        bytes
    }

    /// An Exif block as a phone writes it for a portrait photo: Make, Orientation, GPSInfo.
    fn exif_with(orientation: u16, big_endian: bool) -> Vec<u8> {
        let word = |value: u16| {
            if big_endian {
                value.to_be_bytes()
            } else {
                value.to_le_bytes()
            }
        };
        let long = |value: u32| {
            if big_endian {
                value.to_be_bytes()
            } else {
                value.to_le_bytes()
            }
        };
        let mut tiff = if big_endian {
            b"MM".to_vec()
        } else {
            b"II".to_vec()
        };
        tiff.extend_from_slice(&word(42));
        tiff.extend_from_slice(&long(8));
        tiff.extend_from_slice(&word(3));
        for (tag, kind, count, value) in [
            (0x010f_u16, 2_u16, 12_u32, 50_u32),
            (0x0112, 3, 1, 0),
            (0x8825, 4, 1, 62),
        ] {
            tiff.extend_from_slice(&word(tag));
            tiff.extend_from_slice(&word(kind));
            tiff.extend_from_slice(&long(count));
            if tag == 0x0112 {
                tiff.extend_from_slice(&word(orientation));
                tiff.extend_from_slice(&[0, 0]);
            } else {
                tiff.extend_from_slice(&long(value));
            }
        }
        tiff.extend_from_slice(&long(0));
        assert_eq!(tiff.len(), 50);
        tiff.extend_from_slice(b"FAKE Phone\0\0");
        // A GPS IFD with one entry (a latitude reference).
        tiff.extend_from_slice(&word(1));
        tiff.extend_from_slice(&word(1));
        tiff.extend_from_slice(&word(2));
        tiff.extend_from_slice(&long(2));
        tiff.extend_from_slice(&[b'N', 0, 0, 0]);
        tiff.extend_from_slice(&long(0));
        let mut exif = b"Exif\0\0".to_vec();
        exif.extend_from_slice(&tiff);
        exif
    }

    fn fixed(value: f64) -> [u8; 4] {
        ((value * 65536.0).round() as i32 as u32).to_be_bytes()
    }

    fn xyz_tag(x: f64, y: f64, z: f64) -> Vec<u8> {
        let mut tag = b"XYZ \0\0\0\0".to_vec();
        for value in [x, y, z] {
            tag.extend_from_slice(&fixed(value));
        }
        tag
    }

    fn curv_tag(values: &[u16]) -> Vec<u8> {
        let mut tag = b"curv\0\0\0\0".to_vec();
        tag.extend_from_slice(&u32::try_from(values.len()).unwrap().to_be_bytes());
        for value in values {
            tag.extend_from_slice(&value.to_be_bytes());
        }
        tag
    }

    fn para_tag(function: u16, parameters: usize) -> Vec<u8> {
        let mut tag = b"para\0\0\0\0".to_vec();
        tag.extend_from_slice(&function.to_be_bytes());
        tag.extend_from_slice(&[0, 0]);
        for _ in 0..parameters {
            tag.extend_from_slice(&fixed(2.2));
        }
        tag
    }

    fn chad_tag() -> Vec<u8> {
        let mut tag = b"sf32\0\0\0\0".to_vec();
        for value in [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0] {
            tag.extend_from_slice(&fixed(value));
        }
        tag
    }

    fn text_tag(text: &str) -> Vec<u8> {
        mluc(text)
    }

    /// A profile as a phone writes it, with every place a camera or a person can leave a mark
    /// filled with a FAKE one: the header's maker, model, creator, id and date, the description and
    /// copyright, a device maker and model tag, a target data tag, and bytes between the tags.
    fn phone_profile_with(
        extra_tags: &[([u8; 4], Vec<u8>)],
        edit: impl FnOnce(&mut Vec<([u8; 4], Vec<u8>)>),
    ) -> Vec<u8> {
        let mut tags: Vec<([u8; 4], Vec<u8>)> = vec![
            (*b"rXYZ", xyz_tag(0.4361, 0.2225, 0.0139)),
            (*b"gXYZ", xyz_tag(0.3851, 0.7169, 0.0971)),
            (*b"bXYZ", xyz_tag(0.1431, 0.0606, 0.7141)),
            (*b"rTRC", curv_tag(&[0, 600, 4000, 20000, 40000, 65535])),
            (*b"gTRC", para_tag(3, 5)),
            (*b"bTRC", curv_tag(&[0, 600, 4000, 20000, 40000, 65535])),
            (*b"wtpt", xyz_tag(0.9642, 1.0, 0.8249)),
            (*b"chad", chad_tag()),
            (*b"desc", text_tag("FAKE Camera Model profile")),
            (*b"cprt", text_tag("FAKE Owner copyright")),
            (*b"dmnd", text_tag("FAKE Maker")),
            (*b"dmdd", text_tag("FAKE Camera Model")),
            (*b"targ", b"text\0\0\0\0FAKE target data".to_vec()),
        ];
        tags.extend(extra_tags.iter().cloned());
        edit(&mut tags);
        let table = 128 + 4 + 12 * tags.len();
        let mut body = Vec::new();
        let mut entries = Vec::new();
        for (signature, data) in &tags {
            let offset = table + body.len();
            entries.push((*signature, offset, data.len()));
            body.extend_from_slice(data);
            // Padding to four bytes, and then bytes a profile reader never looks at.
            while body.len() % 4 != 0 {
                body.push(0);
            }
            body.extend_from_slice(b"FAKE-GAP-SECRET!");
        }
        let length = table + body.len();
        let mut profile = vec![0_u8; 128];
        profile[0..4].copy_from_slice(&u32::try_from(length).unwrap().to_be_bytes());
        profile[4..8].copy_from_slice(b"FAKE");
        profile[8..12].copy_from_slice(&[2, 0x10, 0, 0]);
        profile[12..16].copy_from_slice(b"mntr");
        profile[16..20].copy_from_slice(b"RGB ");
        profile[20..24].copy_from_slice(b"XYZ ");
        profile[24..36].copy_from_slice(&[7, 0xe9, 0, 11, 0, 24, 0, 9, 0, 30, 0, 15]);
        profile[36..40].copy_from_slice(b"acsp");
        profile[40..44].copy_from_slice(b"APPL");
        profile[44..48].copy_from_slice(&[0, 0, 0, 1]);
        profile[48..52].copy_from_slice(b"FAKE");
        profile[52..56].copy_from_slice(b"MODL");
        profile[56..64].copy_from_slice(b"FAKEATTR");
        profile[68..72].copy_from_slice(&0x0000_f6d6_u32.to_be_bytes());
        profile[72..76].copy_from_slice(&0x0001_0000_u32.to_be_bytes());
        profile[76..80].copy_from_slice(&0x0000_d32d_u32.to_be_bytes());
        profile[80..84].copy_from_slice(b"FAKE");
        profile[84..100].copy_from_slice(b"FAKE-PROFILE-ID!");
        profile[100..128].copy_from_slice(b"FAKE-RESERVED-HEADER-BYTES!!");
        profile.extend_from_slice(&u32::try_from(tags.len()).unwrap().to_be_bytes());
        for (signature, offset, size) in entries {
            profile.extend_from_slice(&signature);
            profile.extend_from_slice(&u32::try_from(offset).unwrap().to_be_bytes());
            profile.extend_from_slice(&u32::try_from(size).unwrap().to_be_bytes());
        }
        profile.extend_from_slice(&body);
        assert_eq!(profile.len(), length);
        profile
    }

    fn phone_profile() -> Vec<u8> {
        phone_profile_with(&[], |_| {})
    }

    /// Every FAKE mark `phone_profile` carries as plain bytes (header fields, the gap bytes, a text
    /// tag of plain text).
    const FAKE_MARKS: [&[u8]; 7] = [
        b"FAKE",
        b"MODL",
        b"APPL",
        b"GAP-SECRET",
        b"PROFILE-ID",
        b"RESERVED",
        b"target data",
    ];

    /// The FAKE words inside the profile's text tags, which are UTF-16.
    fn fake_texts() -> Vec<Vec<u8>> {
        ["Camera Model", "Owner", "Maker"]
            .iter()
            .map(|text| text.encode_utf16().flat_map(u16::to_be_bytes).collect())
            .collect()
    }

    /// Whether `bytes` carry any FAKE mark of `phone_profile`, plain or as text.
    fn carries_a_fake_mark(bytes: &[u8]) -> Option<Vec<u8>> {
        FAKE_MARKS
            .iter()
            .map(|mark| mark.to_vec())
            .chain(fake_texts())
            .find(|mark| contains(bytes, mark))
    }

    /// The profile a cleaned picture carries, from its (one) APP2 segment, if it has one.
    fn kept_profile(cleaned: &[u8]) -> Option<Vec<u8>> {
        let at = cleaned.windows(12).position(|w| w == b"ICC_PROFILE\0")?;
        let length = usize::from(u16::from_be_bytes([cleaned[at - 2], cleaned[at - 1]]));
        Some(cleaned[at + 14..at - 2 + length].to_vec())
    }

    fn icc_chunk(sequence: u8, total: u8, bytes: &[u8]) -> Vec<u8> {
        let mut payload = b"ICC_PROFILE\0".to_vec();
        payload.extend_from_slice(&[sequence, total]);
        payload.extend_from_slice(bytes);
        segment(0xe2, &payload)
    }

    #[test]
    fn a_sideways_picture_keeps_only_its_orientation_in_a_block_built_here() {
        for big_endian in [true, false] {
            for orientation in 2..=8_u16 {
                let input = with_segments(&[segment(0xe1, &exif_with(orientation, big_endian))]);
                let cleaned = clean_picture(&input).unwrap();
                // The orientation, as the only entry of a block of 36 bytes, after the JFIF header.
                let mut expected = PLAIN[..2 + 2 + JFIF_LENGTH].to_vec();
                expected.extend_from_slice(&orientation_block(orientation));
                expected.extend_from_slice(&PLAIN[2 + 2 + JFIF_LENGTH..]);
                assert_eq!(*cleaned, expected, "{orientation} {big_endian}");
                assert_eq!(orientation_block(orientation).len(), 36);
                // Nothing of the original block survives: no make, no GPS.
                assert!(!contains(&cleaned, b"FAKE Phone"));
                assert!(!contains(&cleaned, b"\x88\x25"));
                // Cleaning it again changes nothing.
                assert_eq!(*clean_picture(&cleaned).unwrap(), *cleaned);
            }
        }
    }

    #[test]
    fn an_upright_or_unreadable_orientation_leaves_no_block_at_all() {
        let upright = with_segments(&[segment(0xe1, &exif_with(1, true))]);
        assert_eq!(*clean_picture(&upright).unwrap(), *PLAIN);
        for orientation in [0_u16, 9, 300] {
            let odd = with_segments(&[segment(0xe1, &exif_with(orientation, true))]);
            assert_eq!(*clean_picture(&odd).unwrap(), *PLAIN, "{orientation}");
        }
        // A block that is cut short, one of the wrong type, and one that is not Exif.
        let mut cut = exif_with(6, true);
        cut.truncate(20);
        let mut wrong_type = exif_with(6, true);
        wrong_type[6 + 8 + 2 + 12 + 2 + 1] = 4;
        for payload in [
            cut,
            wrong_type,
            b"Exif\0\0nonsense".to_vec(),
            b"NotExif".to_vec(),
        ] {
            let input = with_segments(&[segment(0xe1, &payload)]);
            assert_eq!(*clean_picture(&input).unwrap(), *PLAIN);
        }
    }

    #[test]
    fn a_phone_colour_profile_is_rebuilt_and_nothing_a_camera_or_person_put_in_it_survives() {
        let original = phone_profile();
        for mark in FAKE_MARKS
            .iter()
            .map(|mark| mark.to_vec())
            .chain(fake_texts())
        {
            assert!(contains(&original, &mark), "the fixture carries {mark:?}");
        }
        let input = with_segments(&[icc_chunk(1, 1, &original)]);
        let cleaned = clean_picture(&input).unwrap();
        assert_eq!(carries_a_fake_mark(&cleaned), None, "a FAKE mark survived");
        let rebuilt = kept_profile(&cleaned).expect("a matrix profile is kept, rebuilt");
        assert!(rebuilt.len() <= MAX_ICC_BYTES);
        // The header is new: zeros everywhere a device, a date, a maker, a model, a creator or a
        // profile id would go, and only these fields set.
        let mut expected = [0_u8; 128];
        expected[0..4].copy_from_slice(&u32::try_from(rebuilt.len()).unwrap().to_be_bytes());
        expected[8..12].copy_from_slice(&[4, 0x30, 0, 0]);
        expected[12..16].copy_from_slice(b"mntr");
        expected[16..20].copy_from_slice(b"RGB ");
        expected[20..24].copy_from_slice(b"XYZ ");
        expected[36..40].copy_from_slice(b"acsp");
        expected[68..72].copy_from_slice(&0x0000_f6d6_u32.to_be_bytes());
        expected[72..76].copy_from_slice(&0x0001_0000_u32.to_be_bytes());
        expected[76..80].copy_from_slice(&0x0000_d32d_u32.to_be_bytes());
        assert_eq!(rebuilt[..128], expected[..]);
        // Only the colour tags and our own two texts, in order, laid end to end with zero padding.
        let count = u32::from_be_bytes(rebuilt[128..132].try_into().unwrap()) as usize;
        let signatures: Vec<&[u8]> = (0..count)
            .map(|index| &rebuilt[132 + 12 * index..136 + 12 * index])
            .collect();
        assert_eq!(
            signatures,
            [
                &b"bTRC"[..],
                b"bXYZ",
                b"chad",
                b"cprt",
                b"desc",
                b"gTRC",
                b"gXYZ",
                b"rTRC",
                b"rXYZ",
                b"wtpt"
            ]
        );
        assert!(contains(&rebuilt, &mluc("Colour profile")));
        assert!(contains(&rebuilt, &mluc("No copyright")));
        // The colour numbers themselves are the file's.
        assert!(contains(&rebuilt, &xyz_tag(0.4361, 0.2225, 0.0139)));
        assert!(contains(
            &rebuilt,
            &curv_tag(&[0, 600, 4000, 20000, 40000, 65535])
        ));
        // Rebuilding the rebuilt profile changes nothing, and neither does cleaning again.
        assert_eq!(rebuild_icc(&rebuilt).as_deref(), Some(&rebuilt[..]));
        assert_eq!(*clean_picture(&cleaned).unwrap(), *cleaned);
        // The strict cleaner (camera photos) still drops every profile.
        assert_eq!(*clean_jpeg(&input).unwrap(), *PLAIN);
    }

    #[test]
    fn a_profile_that_is_not_a_plain_rgb_matrix_profile_is_dropped() {
        let base = phone_profile();
        let edit = |change: &dyn Fn(&mut Vec<u8>)| {
            let mut profile = base.clone();
            change(&mut profile);
            profile
        };
        // The offset of a tag's data and its table entry, by signature.
        let entry_of = |profile: &[u8], signature: &[u8; 4]| {
            let count = u32::from_be_bytes(profile[128..132].try_into().unwrap()) as usize;
            (0..count)
                .map(|index| 132 + 12 * index)
                .find(|entry| profile[*entry..*entry + 4] == signature[..])
                .unwrap()
        };
        let data_of = |profile: &[u8], signature: &[u8; 4]| {
            let entry = entry_of(profile, signature);
            u32::from_be_bytes(profile[entry + 4..entry + 8].try_into().unwrap()) as usize
        };
        let without = |signature: &[u8; 4]| {
            phone_profile_with(&[], |tags| {
                tags.retain(|(name, _)| name != signature);
            })
        };
        let lut = phone_profile_with(&[(*b"A2B0", vec![0; 32])], |tags| {
            tags.retain(|(name, _)| !matches!(name, b"rXYZ" | b"gXYZ" | b"bXYZ"));
        });
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("a lookup-table profile", lut),
            ("no red colorant", without(b"rXYZ")),
            ("no white point", without(b"wtpt")),
            ("no blue curve", without(b"bTRC")),
            (
                "a repeated tag",
                phone_profile_with(&[(*b"wtpt", xyz_tag(0.9642, 1.0, 0.8249))], |_| {}),
            ),
            (
                "a colorant of the wrong type",
                phone_profile_with(&[], |tags| {
                    tags[0].1 = curv_tag(&[0, 65535]);
                }),
            ),
            (
                "a colorant out of range",
                phone_profile_with(&[], |tags| {
                    tags[0].1 = xyz_tag(40.0, 0.2, 0.0);
                }),
            ),
            (
                "a colorant with a reserved byte set",
                phone_profile_with(&[], |tags| {
                    tags[0].1[5] = 1;
                }),
            ),
            (
                "a curve that goes down",
                phone_profile_with(&[], |tags| {
                    tags[3].1 = curv_tag(&[0, 40000, 100, 65535]);
                }),
            ),
            (
                "a curve of 5000 entries",
                phone_profile_with(&[], |tags| {
                    tags[3].1 = curv_tag(&[7; 5000]);
                }),
            ),
            (
                "a curve whose size does not match its count",
                phone_profile_with(&[], |tags| {
                    tags[3].1.extend_from_slice(&[0, 0]);
                }),
            ),
            (
                "a parametric curve of an unknown function",
                phone_profile_with(&[], |tags| {
                    tags[4].1 = para_tag(9, 5);
                }),
            ),
            (
                "a parametric curve of the wrong size",
                phone_profile_with(&[], |tags| {
                    tags[4].1 = para_tag(3, 4);
                }),
            ),
            (
                "an adaptation matrix of the wrong size",
                phone_profile_with(&[], |tags| {
                    tags[7].1.truncate(40);
                }),
            ),
            (
                "an adaptation matrix out of range",
                phone_profile_with(&[], |tags| {
                    tags[7].1[8..12].copy_from_slice(&fixed(100.0));
                }),
            ),
            ("a version of 5", edit(&|p| p[8] = 5)),
            (
                "a printer profile",
                edit(&|p| p[12..16].copy_from_slice(b"prtr")),
            ),
            (
                "a gray profile",
                edit(&|p| p[16..20].copy_from_slice(b"GRAY")),
            ),
            (
                "a Lab connection space",
                edit(&|p| p[20..24].copy_from_slice(b"Lab ")),
            ),
            ("a rendering intent of 4", edit(&|p| p[67] = 4)),
            ("no acsp signature", edit(&|p| p[36] = b'x')),
            ("the wrong length", edit(&|p| p[3] ^= 1)),
            (
                "a tag past the end",
                edit(&|p| {
                    let entry = entry_of(p, b"rXYZ");
                    p[entry + 8..entry + 12].copy_from_slice(&u32::MAX.to_be_bytes());
                }),
            ),
            (
                "a tag offset that wraps",
                edit(&|p| {
                    let entry = entry_of(p, b"rXYZ");
                    p[entry + 4..entry + 8].copy_from_slice(&u32::MAX.to_be_bytes());
                }),
            ),
            (
                "a table past the end",
                edit(&|p| p[128..132].copy_from_slice(&200_u32.to_be_bytes())),
            ),
            (
                "no tags",
                edit(&|p| p[128..132].copy_from_slice(&0_u32.to_be_bytes())),
            ),
            ("too short", vec![0_u8; 100]),
            ("too big", vec![0_u8; MAX_ICC_BYTES + 1]),
        ];
        // The fixture's own tags are where the cases above assume.
        assert_eq!(data_of(&base, b"rXYZ") % 4, 0);
        for (name, profile) in cases {
            assert_eq!(rebuild_icc(&profile), None, "{name}");
            let input = with_segments(&[icc_chunk(1, 1, &profile)]);
            assert_eq!(*clean_picture(&input).unwrap(), *PLAIN, "{name}");
        }
        // And the unedited one is accepted.
        assert!(rebuild_icc(&base).is_some());
    }

    #[test]
    fn a_colour_profile_in_several_segments_is_joined_only_when_complete() {
        let plain = phone_profile();
        let (first, second) = plain.split_at(100);
        let both = with_segments(&[icc_chunk(2, 2, second), icc_chunk(1, 2, first)]);
        let cleaned = clean_picture(&both).unwrap();
        assert_eq!(kept_profile(&cleaned), rebuild_icc(&plain));
        assert!(kept_profile(&cleaned).is_some());
        for (name, chunks) in [
            ("one missing", vec![icc_chunk(1, 2, first)]),
            (
                "a repeat",
                vec![icc_chunk(1, 2, first), icc_chunk(1, 2, first)],
            ),
            (
                "totals disagree",
                vec![icc_chunk(1, 2, first), icc_chunk(2, 3, second)],
            ),
            ("a total of zero", vec![icc_chunk(1, 0, first)]),
        ] {
            assert_eq!(
                *clean_picture(&with_segments(&chunks)).unwrap(),
                *PLAIN,
                "{name}"
            );
        }
    }

    #[test]
    fn more_than_nine_profile_segments_mean_no_profile_and_are_not_collected() {
        // Ten one-byte pieces: far fewer bytes than a profile, but more segments than allowed.
        let chunks: Vec<Vec<u8>> = (1..=10).map(|n| icc_chunk(n, 10, &[0])).collect();
        assert_eq!(*clean_picture(&with_segments(&chunks)).unwrap(), *PLAIN);
        // Nine pieces that are a whole profile are still accepted.
        let profile = phone_profile();
        let size = profile.len().div_ceil(9);
        let nine: Vec<Vec<u8>> = profile
            .chunks(size)
            .enumerate()
            .map(|(index, piece)| icc_chunk(u8::try_from(index + 1).unwrap(), 9, piece))
            .collect();
        assert_eq!(nine.len(), 9);
        let cleaned = clean_picture(&with_segments(&nine)).unwrap();
        assert_eq!(kept_profile(&cleaned), rebuild_icc(&profile));
    }

    #[test]
    fn a_picture_with_place_time_and_a_profile_keeps_exactly_orientation_and_profile() {
        let plain = phone_profile();
        let tagged = with_segments(&[
            segment(0xe1, &exif_with_gps()),
            segment(0xe1, b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>"),
            icc_chunk(1, 1, &plain),
            segment(0xed, b"Photoshop 3.0\08BIM FAKE caption"),
            segment(0xfe, b"FAKE comment: taken at home"),
        ]);
        let cleaned = clean_picture(&tagged).unwrap();
        // exif_with_gps has no orientation, so only the rebuilt profile comes back.
        let rebuilt = rebuild_icc(&plain).unwrap();
        let mut expected = PLAIN[..2 + 2 + JFIF_LENGTH].to_vec();
        expected.extend_from_slice(&icc_segment(&rebuilt));
        expected.extend_from_slice(&PLAIN[2 + 2 + JFIF_LENGTH..]);
        assert_eq!(*cleaned, expected);
        for gone in [
            &b"FAKE Phone"[..],
            b"xmpmeta",
            b"FAKE caption",
            b"taken at home",
        ] {
            assert!(!contains(&cleaned, gone));
        }
        // And the same with an orientation: the block is ours, the original's GPS is not in it.
        let with_both =
            with_segments(&[segment(0xe1, &exif_with(6, true)), icc_chunk(1, 1, &plain)]);
        let cleaned = clean_picture(&with_both).unwrap();
        assert!(contains(&cleaned, &orientation_block(6)));
        assert_eq!(kept_profile(&cleaned), Some(rebuilt));
        assert!(!contains(&cleaned, b"FAKE Phone"));
        assert_eq!(carries_a_fake_mark(&cleaned), None, "a FAKE mark survived");
    }

    #[test]
    fn a_gain_map_and_index_appended_after_the_picture_are_not_copied() {
        // Ultra HDR and iPhone files: an MPF index in an APP2 segment, and a second, smaller JPEG
        // (the gain map) after the first image's end marker.
        let mpf = segment(0xe2, b"MPF\0FAKE-MPF-INDEX-WITH-OFFSETS");
        let mut input = with_segments(&[mpf]);
        let mut gain_map = vec![0xff, 0xd8, 0xff, 0xe1];
        gain_map.extend_from_slice(&[0, 40]);
        gain_map.extend_from_slice(b"Exif\0\0FAKE gain map GPS 43.65 -79.38");
        gain_map.extend_from_slice(&[0xff, 0xd9]);
        input.extend_from_slice(&gain_map);
        let cleaned = clean_picture(&input).unwrap();
        // Only the primary image: exactly what the same picture without the extras cleans to.
        assert_eq!(*cleaned, *PLAIN);
        assert!(!contains(&cleaned, b"MPF"));
        assert!(!contains(&cleaned, b"gain map"));
        assert!(!contains(&cleaned, b"43.65"));
        // The same through the strict cleaner (camera photos).
        assert_eq!(*clean_jpeg(&input).unwrap(), *PLAIN);
        // With an orientation and a profile in front of it all, those still come back.
        let phone = with_segments(&[
            segment(0xe1, &exif_with(6, true)),
            icc_chunk(1, 1, &phone_profile()),
            segment(0xe2, b"MPF\0FAKE-MPF-INDEX-WITH-OFFSETS"),
        ]);
        let mut phone = phone;
        phone.extend_from_slice(&gain_map);
        let cleaned = clean_picture(&phone).unwrap();
        assert!(contains(&cleaned, &orientation_block(6)));
        assert!(kept_profile(&cleaned).is_some());
        assert!(!contains(&cleaned, b"gain map") && !contains(&cleaned, b"MPF"));
    }

    #[test]
    fn cleaning_a_picture_is_stable_and_a_picture_with_nothing_to_keep_matches_the_strict_cleaner()
    {
        let plain = phone_profile();
        let with_profile = [
            with_segments(&[segment(0xe1, &exif_with(6, true)), icc_chunk(1, 1, &plain)]),
            with_segments(&[icc_chunk(1, 1, &plain)]),
        ];
        let without_profile = [
            with_segments(&[segment(0xe1, &exif_with(8, false))]),
            with_metadata(&PLAIN),
            PLAIN.clone(),
        ];
        // The canvas photo carries a profile of its own (its three curves share one table, so
        // rebuilt with a table each it can be larger): stable, but not "never larger".
        let canvas = CANVAS_JPEG.to_vec();
        for input in with_profile.iter().chain(&without_profile).chain([&canvas]) {
            let cleaned = clean_picture(input).unwrap();
            assert!(cleaned.len() <= MAX_PHOTO_BYTES);
            assert_eq!(*clean_picture(&cleaned).unwrap(), *cleaned);
        }
        // Without a profile or an orientation to put back, a picture is never larger than it came.
        for input in &without_profile {
            let cleaned = clean_picture(input).unwrap();
            assert!(
                cleaned.len() <= input.len(),
                "{} > {}",
                cleaned.len(),
                input.len()
            );
        }
        // What the camera dialog stores (already cleaned strictly) is shown as it is.
        assert_eq!(*clean_picture(&PLAIN).unwrap(), *PLAIN);
        assert_eq!(
            *clean_picture(&with_metadata(&PLAIN)).unwrap(),
            *clean_jpeg(&with_metadata(&PLAIN)).unwrap()
        );
        // Everything the strict cleaner refuses is refused here too.
        for refused in [
            &b""[..],
            b"%PDF-1.7",
            &[0xff, 0xd8, 0xff][..],
            &PLAIN[..PLAIN.len() - 2],
        ] {
            assert!(clean_picture(refused).is_err());
        }
    }
}

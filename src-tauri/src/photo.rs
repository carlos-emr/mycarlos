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
/// - a **plain colour profile**: one ICC profile of at most [`MAX_ICC_BYTES`] whose header and
///   tag table are well formed and whose tags are all standard colour tags (see
///   `plain_icc_profile`). Skin and rash colours matter in a health picture, and such a profile
///   holds no personal data. Anything else is dropped.
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

/// The orientation (2 to 8; 1 means upright and is not worth a block) and the colour profile the
/// header of `input` carries, read leniently: anything unreadable or odd is "none". It stops at
/// the first scan. `clean_core` has already accepted `input` as a whole.
fn wanted_metadata(input: &[u8]) -> (Option<u16>, Option<Vec<u8>>) {
    let mut orientation = None;
    let mut chunks: Vec<(u8, u8, &[u8])> = Vec::new();
    let mut position = 2;
    let mut exif_seen = false;
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
                let (sequence, total) = (payload[12], payload[13]);
                chunks.push((sequence, total, &payload[14..]));
            }
            _ => {}
        }
        position += length;
    }
    (orientation, join_icc(chunks))
}

/// The profile in its chunks (each APP2 segment carries a sequence number and the total), when
/// they are all there, once each, and the whole is a plain profile within the cap.
fn join_icc(mut chunks: Vec<(u8, u8, &[u8])>) -> Option<Vec<u8>> {
    let total = usize::from(chunks.first()?.1);
    if total == 0
        || total > 8
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
    plain_icc_profile(&profile).then_some(profile)
}

/// Whether `profile` is an ordinary colour profile: at most [`MAX_ICC_BYTES`], a header that
/// agrees with its length (signature "acsp" at 36, a version of 4 or less), a tag table that fits
/// inside it, and **every tag one of the standard colour tags** (so no private or vendor tag can
/// carry anything else). Text inside the description and copyright tags is the profile's own name
/// and licence, not data about the person.
fn plain_icc_profile(profile: &[u8]) -> bool {
    const HEADER: usize = 128;
    if profile.len() < HEADER + 4 || profile.len() > MAX_ICC_BYTES {
        return false;
    }
    let word = |at: usize| {
        u32::from_be_bytes([
            profile[at],
            profile[at + 1],
            profile[at + 2],
            profile[at + 3],
        ])
    };
    if word(0) as usize != profile.len() || &profile[36..40] != b"acsp" || profile[8] > 4 {
        return false;
    }
    let count = word(HEADER) as usize;
    let table_end = HEADER + 4 + 12 * count;
    if count == 0 || count > 100 || table_end > profile.len() {
        return false;
    }
    const STANDARD: [&[u8; 4]; 52] = [
        b"A2B0", b"A2B1", b"A2B2", b"B2A0", b"B2A1", b"B2A2", b"B2D0", b"B2D1", b"B2D2", b"B2D3",
        b"D2B0", b"D2B1", b"D2B2", b"D2B3", b"bXYZ", b"bTRC", b"bkpt", b"calt", b"chad", b"chrm",
        b"cicp", b"clro", b"clrt", b"cprt", b"desc", b"dmdd", b"dmnd", b"gamt", b"gXYZ", b"gTRC",
        b"kTRC", b"lumi", b"meas", b"mmod", b"ncl2", b"pre0", b"pre1", b"pre2", b"resp", b"rXYZ",
        b"rTRC", b"scrd", b"scrn", b"tech", b"vued", b"view", b"wtpt", b"ps2i", b"ps2s", b"targ",
        b"bfd ", b"dscm",
    ];
    (0..count).all(|index| {
        let entry = HEADER + 4 + 12 * index;
        let (offset, size) = (word(entry + 4) as usize, word(entry + 8) as usize);
        STANDARD
            .iter()
            .any(|tag| profile[entry..entry + 4] == tag[..])
            && offset
                .checked_add(size)
                .is_some_and(|end| end <= profile.len())
    })
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

    /// A small, well-formed ICC profile: the 128-byte header, a tag table of `tags` (each
    /// pointing at 4 bytes of data) and that data. Display P3 in spirit, FAKE in content.
    fn icc_profile(tags: &[&[u8; 4]]) -> Vec<u8> {
        let table = 128 + 4 + 12 * tags.len();
        let length = table + 4 * tags.len();
        let mut profile = vec![0_u8; 128];
        profile[0..4].copy_from_slice(&u32::try_from(length).unwrap().to_be_bytes());
        profile[8] = 4;
        profile[36..40].copy_from_slice(b"acsp");
        profile.extend_from_slice(&u32::try_from(tags.len()).unwrap().to_be_bytes());
        for (index, tag) in tags.iter().enumerate() {
            profile.extend_from_slice(*tag);
            profile.extend_from_slice(&u32::try_from(table + 4 * index).unwrap().to_be_bytes());
            profile.extend_from_slice(&4_u32.to_be_bytes());
        }
        profile.extend_from_slice(&vec![7_u8; 4 * tags.len()]);
        assert_eq!(profile.len(), length);
        profile
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
    fn a_plain_colour_profile_is_kept_and_anything_else_is_dropped() {
        let plain = icc_profile(&[
            b"desc", b"wtpt", b"rXYZ", b"gXYZ", b"bXYZ", b"rTRC", b"cprt",
        ]);
        let input = with_segments(&[icc_chunk(1, 1, &plain)]);
        let cleaned = clean_picture(&input).unwrap();
        let mut expected = PLAIN[..2 + 2 + JFIF_LENGTH].to_vec();
        expected.extend_from_slice(&icc_segment(&plain));
        expected.extend_from_slice(&PLAIN[2 + 2 + JFIF_LENGTH..]);
        assert_eq!(*cleaned, expected);
        assert_eq!(*clean_picture(&cleaned).unwrap(), *cleaned);
        // The strict cleaner (camera photos) still drops it.
        assert_eq!(*clean_jpeg(&input).unwrap(), *PLAIN);

        let mut wrong_length = plain.clone();
        wrong_length[3] ^= 1;
        let mut no_signature = plain.clone();
        no_signature[36] = b'x';
        let mut table_past_end = plain.clone();
        table_past_end[131] = 200;
        let mut tag_past_end = plain.clone();
        tag_past_end[128 + 4 + 8..128 + 4 + 12].copy_from_slice(&u32::MAX.to_be_bytes());
        for (name, profile) in [
            ("a private tag", icc_profile(&[b"desc", b"FAKE"])),
            ("no tags", icc_profile(&[])),
            ("the wrong length", wrong_length),
            ("no acsp signature", no_signature),
            ("a table past the end", table_past_end),
            ("a tag past the end", tag_past_end),
            ("too short", vec![0_u8; 100]),
            ("too big", vec![0_u8; MAX_ICC_BYTES + 1]),
        ] {
            let input = with_segments(&[icc_chunk(1, 1, &profile)]);
            assert_eq!(*clean_picture(&input).unwrap(), *PLAIN, "{name}");
        }
    }

    #[test]
    fn a_colour_profile_in_several_segments_is_joined_only_when_complete() {
        let plain = icc_profile(&[b"desc", b"wtpt", b"rXYZ"]);
        let (first, second) = plain.split_at(100);
        let both = with_segments(&[icc_chunk(2, 2, second), icc_chunk(1, 2, first)]);
        let mut expected = PLAIN[..2 + 2 + JFIF_LENGTH].to_vec();
        expected.extend_from_slice(&icc_segment(&plain));
        expected.extend_from_slice(&PLAIN[2 + 2 + JFIF_LENGTH..]);
        assert_eq!(*clean_picture(&both).unwrap(), expected);
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
    fn a_picture_with_place_time_and_a_profile_keeps_exactly_orientation_and_profile() {
        let plain = icc_profile(&[b"desc", b"wtpt"]);
        let tagged = with_segments(&[
            segment(0xe1, &exif_with_gps()),
            segment(0xe1, b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>"),
            icc_chunk(1, 1, &plain),
            segment(0xed, b"Photoshop 3.0\08BIM FAKE caption"),
            segment(0xfe, b"FAKE comment: taken at home"),
        ]);
        let cleaned = clean_picture(&tagged).unwrap();
        // exif_with_gps has no orientation, so only the profile comes back.
        let mut expected = PLAIN[..2 + 2 + JFIF_LENGTH].to_vec();
        expected.extend_from_slice(&icc_segment(&plain));
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
        assert!(contains(&cleaned, &plain));
        assert!(!contains(&cleaned, b"FAKE Phone"));
    }

    #[test]
    fn cleaning_a_picture_never_grows_it_and_a_picture_with_nothing_to_keep_matches_the_strict_cleaner(
    ) {
        let plain = icc_profile(&[b"desc", b"wtpt", b"rXYZ"]);
        let inputs = [
            with_segments(&[segment(0xe1, &exif_with(6, true)), icc_chunk(1, 1, &plain)]),
            with_segments(&[segment(0xe1, &exif_with(8, false))]),
            with_segments(&[icc_chunk(1, 1, &plain)]),
            with_metadata(&PLAIN),
            PLAIN.clone(),
            CANVAS_JPEG.to_vec(),
        ];
        for input in &inputs {
            let cleaned = clean_picture(input).unwrap();
            assert!(
                cleaned.len() <= input.len(),
                "{} > {}",
                cleaned.len(),
                input.len()
            );
            assert_eq!(*clean_picture(&cleaned).unwrap(), *cleaned);
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

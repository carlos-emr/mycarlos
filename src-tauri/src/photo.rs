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
    /// Over `MAX_PHOTO_BYTES`, or over `MAX_PHOTO_SIDE` on a side.
    TooLarge,
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
}

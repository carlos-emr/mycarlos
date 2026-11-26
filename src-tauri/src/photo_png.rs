//! PNG pictures a patient brings from their files (a screenshot of a letter or an app). Same idea
//! as `photo::clean_jpeg`: the bytes are never decoded here. The file is read as a list of chunks,
//! each chunk's length is checked against the file and its CRC against its bytes, and a new file is
//! written holding **only the chunks that draw the picture**: IHDR, PLTE, tRNS, the colour hints
//! gAMA, cHRM and sRGB, the IDAT data and IEND. Text (tEXt, zTXt, iTXt), the Exif block (eXIf), the
//! time (tIME), the print size (pHYs), background, palette hints, every unknown ancillary chunk and
//! anything after IEND are dropped. The embedded colour profile (iCCP) is never copied: a JPEG's
//! profile can be checked field by field, but a PNG's is deflate-compressed, and reading it would
//! need an inflater on the path from an untrusted file. Its NAME is not compressed, though, so the
//! two names phones use are told apart without reading the profile: exactly "Display P3" is
//! replaced by a fixed cICP chunk (primaries 12, transfer 13, matrix 0, full range) and exactly
//! "sRGB" by a fixed sRGB chunk; any other profile is dropped and the picture shows as sRGB. An
//! animated PNG (acTL, fcTL, fdAT) is refused. What is kept is copied byte for byte, so what the system's own decoder draws is what the
//! patient chose, and cleaning its own output gives the same bytes.
//!
//! The size is bounded before anything could be drawn: at most `MAX_PHOTO_SIDE` pixels a side and
//! `MAX_PICTURE_PIXELS` in all, so a small file cannot declare a picture that fills memory when the
//! webview decodes it, and at most `MAX_PHOTO_BYTES` of file. Every length is read with checked
//! arithmetic and anything odd is refused (fail closed).

use crate::photo::{PhotoError, MAX_PHOTO_BYTES, MAX_PHOTO_SIDE};
use zeroize::Zeroizing;

/// How every PNG starts.
pub const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
/// The most pixels a picture may declare (width times height) on a computer.
pub const MAX_PICTURE_PIXELS_DESKTOP: u64 = 50_000_000;
/// The most on a phone, which has less memory to decode into.
pub const MAX_PICTURE_PIXELS_MOBILE: u64 = 24_000_000;
/// The most that applies on this device.
pub const MAX_PICTURE_PIXELS: u64 = if cfg!(any(target_os = "android", target_os = "ios")) {
    MAX_PICTURE_PIXELS_MOBILE
} else {
    MAX_PICTURE_PIXELS_DESKTOP
};
/// The colour codes a Display P3 picture is given: primaries 12 (P3 with a D65 white), transfer 13
/// (the sRGB curve), matrix 0 (RGB), full range.
const CICP_DISPLAY_P3: [u8; 4] = [12, 13, 0, 1];
/// The most a chunk's length field may say (the PNG specification's own limit).
const MAX_CHUNK_LENGTH: usize = 0x7fff_ffff;

/// Whether the bytes start as every PNG does.
pub fn looks_like_png(bytes: &[u8]) -> bool {
    bytes.starts_with(&PNG_SIGNATURE)
}

/// The CRC-32 of a chunk's type and data (the PNG specification's: reflected, 0xEDB88320).
fn crc32(parts: &[&[u8]]) -> u32 {
    const TABLE: [u32; 256] = {
        let mut table = [0_u32; 256];
        let mut n = 0;
        while n < 256 {
            let mut c = n as u32;
            let mut k = 0;
            while k < 8 {
                c = if c & 1 == 1 {
                    0xedb8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
                k += 1;
            }
            table[n] = c;
            n += 1;
        }
        table
    };
    let mut crc = 0xffff_ffff_u32;
    for part in parts {
        for byte in *part {
            crc = TABLE[((crc ^ u32::from(*byte)) & 0xff) as usize] ^ (crc >> 8);
        }
    }
    !crc
}

/// A chunk this module writes itself.
fn chunk_of(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut bytes = (data.len() as u32).to_be_bytes().to_vec();
    bytes.extend_from_slice(kind);
    bytes.extend_from_slice(data);
    bytes.extend_from_slice(&crc32(&[kind, data]).to_be_bytes());
    bytes
}

/// One chunk of the file, after its length and CRC were checked.
struct Chunk<'a> {
    kind: [u8; 4],
    data: &'a [u8],
    /// Length, type, data and CRC, as they are in the file.
    whole: &'a [u8],
}

/// The chunk that starts at `at` and the position after it. Refuses a chunk that runs past the
/// file, a length over the specification's limit, a type that is not four letters (with the
/// reserved bit clear), and a CRC that does not match.
fn next_chunk(input: &[u8], at: usize) -> Result<(Chunk<'_>, usize), PhotoError> {
    let header = at
        .checked_add(8)
        .and_then(|end| input.get(at..end))
        .ok_or(PhotoError::NotPng)?;
    let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
    if length > MAX_CHUNK_LENGTH {
        return Err(PhotoError::NotPng);
    }
    let kind = [header[4], header[5], header[6], header[7]];
    // Four ASCII letters; the third (reserved) one must be upper case.
    if !kind.iter().all(u8::is_ascii_alphabetic) || kind[2].is_ascii_lowercase() {
        return Err(PhotoError::NotPng);
    }
    let data_end = at
        .checked_add(8)
        .and_then(|start| start.checked_add(length))
        .ok_or(PhotoError::NotPng)?;
    let end = data_end.checked_add(4).ok_or(PhotoError::NotPng)?;
    let whole = input.get(at..end).ok_or(PhotoError::NotPng)?;
    let data = &whole[8..8 + length];
    let stored = u32::from_be_bytes([
        whole[8 + length],
        whole[9 + length],
        whole[10 + length],
        whole[11 + length],
    ]);
    if crc32(&[&kind, data]) != stored {
        return Err(PhotoError::NotPng);
    }
    Ok((Chunk { kind, data, whole }, end))
}

/// What a colour profile's name says it is: the two names phones write, and anything else.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ProfileName {
    DisplayP3,
    Srgb,
    Other,
}

/// The profile an iCCP chunk's data names, read from its uncompressed start only: a keyword of
/// 1 to 79 bytes, a zero byte, the compression method (0) and a compressed profile that is at
/// least a zlib header and a checksum long. The name must be exactly "Display P3" or "sRGB":
/// anything else, a name with a stray byte, and a chunk that is not built that way, is `Other`.
/// The compressed profile itself is not read, so a profile that does not match its name is
/// replaced by what the name says; nothing of its bytes is carried.
fn profile_name_of(data: &[u8]) -> ProfileName {
    let Some(end) = data.iter().position(|byte| *byte == 0) else {
        return ProfileName::Other;
    };
    if end == 0 || end > 79 || data.get(end + 1) != Some(&0) || data.len() < end + 2 + 6 {
        return ProfileName::Other;
    }
    match &data[..end] {
        b"Display P3" => ProfileName::DisplayP3,
        b"sRGB" => ProfileName::Srgb,
        _ => ProfileName::Other,
    }
}

/// What the header says about the picture.
struct Header {
    color_type: u8,
    bit_depth: u8,
}

fn parse_header(data: &[u8], max_pixels: u64) -> Result<Header, PhotoError> {
    if data.len() != 13 {
        return Err(PhotoError::NotPng);
    }
    let width = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
    let height = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
    let (bit_depth, color_type, compression, filter, interlace) =
        (data[8], data[9], data[10], data[11], data[12]);
    if width == 0 || height == 0 || compression != 0 || filter != 0 || interlace > 1 {
        return Err(PhotoError::NotPng);
    }
    let depths: &[u8] = match color_type {
        0 => &[1, 2, 4, 8, 16],
        2 | 4 | 6 => &[8, 16],
        3 => &[1, 2, 4, 8],
        _ => return Err(PhotoError::NotPng),
    };
    if !depths.contains(&bit_depth) {
        return Err(PhotoError::NotPng);
    }
    if width > u32::from(MAX_PHOTO_SIDE)
        || height > u32::from(MAX_PHOTO_SIDE)
        || u64::from(width) * u64::from(height) > max_pixels
    {
        return Err(PhotoError::TooLarge);
    }
    Ok(Header {
        color_type,
        bit_depth,
    })
}

/// Whether the two bytes that start a zlib stream are a deflate header (RFC 1950): method 8, a
/// window of at most 32 KiB, a check value that divides by 31, and no preset dictionary.
fn zlib_header(first: u8, second: u8) -> bool {
    first & 0x0f == 8
        && first >> 4 <= 7
        && (u16::from(first) * 256 + u16::from(second)) % 31 == 0
        && second & 0x20 == 0
}

/// The picture with only the chunks that draw it (see the module's description), or an error:
/// `TooLarge` for a file or a declared size over the caps, `NotPng` for anything else that is not
/// one complete, well formed, still PNG.
pub fn clean_png(input: &[u8]) -> Result<Zeroizing<Vec<u8>>, PhotoError> {
    clean_png_within(input, MAX_PICTURE_PIXELS)
}

/// `clean_png` with the pixel cap named (the tests run both devices' caps).
pub fn clean_png_within(input: &[u8], max_pixels: u64) -> Result<Zeroizing<Vec<u8>>, PhotoError> {
    if input.len() > MAX_PHOTO_BYTES {
        return Err(PhotoError::TooLarge);
    }
    if !looks_like_png(input) {
        return Err(PhotoError::NotPng);
    }
    let mut at = PNG_SIGNATURE.len();
    let (first, next) = next_chunk(input, at)?;
    if &first.kind != b"IHDR" {
        return Err(PhotoError::NotPng);
    }
    let header = parse_header(first.data, max_pixels)?;
    at = next;

    let ihdr = first.whole;
    let mut chrm: Option<&[u8]> = None;
    let mut gama: Option<&[u8]> = None;
    let mut srgb: Option<&[u8]> = None;
    let mut plte: Option<&[u8]> = None;
    let mut trns: Option<&[u8]> = None;
    let mut cicp: Option<&[u8]> = None;
    let mut seen_icc = false;
    let mut profile_name = ProfileName::Other;
    let mut palette_entries = 0_usize;
    let mut idat: Vec<&[u8]> = Vec::new();
    let mut idat_over = false;
    let mut zlib_start = Vec::with_capacity(2);
    let mut end: Option<&[u8]> = None;
    while end.is_none() {
        let (chunk, next) = next_chunk(input, at)?;
        at = next;
        let started = !idat.is_empty();
        // Each of these chunks comes once, before the image data.
        let once = |slot: &Option<&[u8]>| started || slot.is_some();
        match &chunk.kind {
            b"IHDR" | b"acTL" | b"fcTL" | b"fdAT" => return Err(PhotoError::NotPng),
            b"PLTE" => {
                let usable = matches!(header.color_type, 2 | 3 | 6)
                    && chunk.data.len() % 3 == 0
                    && !chunk.data.is_empty()
                    && chunk.data.len() <= 3 * 256
                    && (header.color_type != 3
                        || chunk.data.len() / 3 <= 1_usize << header.bit_depth);
                if once(&plte) || trns.is_some() || !usable {
                    return Err(PhotoError::NotPng);
                }
                palette_entries = chunk.data.len() / 3;
                plte = Some(chunk.whole);
            }
            b"tRNS" => {
                let usable = match header.color_type {
                    0 => chunk.data.len() == 2,
                    2 => chunk.data.len() == 6,
                    3 => plte.is_some() && chunk.data.len() <= palette_entries,
                    _ => false,
                };
                if once(&trns) || !usable {
                    return Err(PhotoError::NotPng);
                }
                trns = Some(chunk.whole);
            }
            b"gAMA" => {
                if once(&gama) || chunk.data.len() != 4 {
                    return Err(PhotoError::NotPng);
                }
                gama = Some(chunk.whole);
            }
            b"cHRM" => {
                if once(&chrm) || chunk.data.len() != 32 {
                    return Err(PhotoError::NotPng);
                }
                chrm = Some(chunk.whole);
            }
            b"sRGB" => {
                if once(&srgb) || chunk.data.len() != 1 || chunk.data[0] > 3 {
                    return Err(PhotoError::NotPng);
                }
                srgb = Some(chunk.whole);
            }
            // Never copied (see the module's description), but still once and before the image
            // data, as a decoder would insist. Only its uncompressed name is looked at.
            b"iCCP" => {
                if started || seen_icc {
                    return Err(PhotoError::NotPng);
                }
                seen_icc = true;
                profile_name = profile_name_of(chunk.data);
            }
            // Colour codes: kept when they are ones the standard gives, as for a JPEG's.
            b"cICP" => {
                let &[primaries, transfer, matrix, range] = chunk.data else {
                    return Err(PhotoError::NotPng);
                };
                if once(&cicp) || primaries > 22 || transfer > 22 || matrix != 0 || range > 1 {
                    return Err(PhotoError::NotPng);
                }
                cicp = Some(chunk.whole);
            }
            b"IDAT" => {
                if idat_over || (header.color_type == 3 && plte.is_none()) {
                    return Err(PhotoError::NotPng);
                }
                for byte in chunk.data.iter().take(2 - zlib_start.len().min(2)) {
                    zlib_start.push(*byte);
                }
                idat.push(chunk.whole);
            }
            b"IEND" => {
                if !chunk.data.is_empty() || idat.is_empty() {
                    return Err(PhotoError::NotPng);
                }
                end = Some(chunk.whole);
            }
            other => {
                // A chunk a decoder must understand, and this one does not, is refused. The rest
                // (text, Exif, time, print size, background, unknown ancillary) are dropped.
                if other[0].is_ascii_uppercase() {
                    return Err(PhotoError::NotPng);
                }
            }
        }
        // Image data ends at the first chunk of another kind: a second run of IDAT is damaged.
        if &chunk.kind != b"IDAT" && !idat.is_empty() {
            idat_over = true;
        }
    }
    if zlib_start.len() < 2 || !zlib_header(zlib_start[0], zlib_start[1]) {
        return Err(PhotoError::NotPng);
    }

    let mut output = Zeroizing::new(Vec::with_capacity(input.len().min(at)));
    output.extend_from_slice(&PNG_SIGNATURE);
    output.extend_from_slice(ihdr);
    // The order the specification gives: colour hints, palette, transparency, image data, end.
    // What the picture's profile says, when the file gave no colour codes of its own: Display P3
    // is a fixed cICP chunk, sRGB a fixed sRGB chunk. Colour codes, from the file or from a
    // profile named Display P3, take the place of the other colour hints, as a decoder prefers them.
    let p3 = chunk_of(b"cICP", &CICP_DISPLAY_P3);
    let srgb_fixed = chunk_of(b"sRGB", &[0]);
    let codes: Option<&[u8]> = match (cicp, profile_name) {
        (Some(own), _) => Some(own),
        (None, ProfileName::DisplayP3) => Some(&p3),
        _ => None,
    };
    let rendering: Option<&[u8]> = match (codes, srgb, profile_name) {
        (Some(_), _, _) => None,
        (None, Some(own), _) => Some(own),
        (None, None, ProfileName::Srgb) => Some(&srgb_fixed),
        _ => None,
    };
    let hints = codes.is_none();
    for chunk in [
        chrm.filter(|_| hints),
        gama.filter(|_| hints),
        codes,
        rendering,
        plte,
        trns,
    ]
    .into_iter()
    .flatten()
    {
        output.extend_from_slice(chunk);
    }
    for chunk in idat {
        output.extend_from_slice(chunk);
    }
    output.extend_from_slice(end.unwrap_or_default());
    Ok(output)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A chunk as it is in a file: length, type, data and CRC.
    pub(crate) fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut bytes = (data.len() as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(data);
        bytes.extend_from_slice(&crc32(&[kind, data]).to_be_bytes());
        bytes
    }

    /// `raw` as a zlib stream of stored blocks (what a decoder reads back as `raw`).
    pub(crate) fn zlib_stored(raw: &[u8]) -> Vec<u8> {
        let mut out = vec![0x78, 0x01];
        let blocks: Vec<&[u8]> = if raw.is_empty() {
            vec![&[][..]]
        } else {
            raw.chunks(65_535).collect()
        };
        for (index, block) in blocks.iter().enumerate() {
            out.push(u8::from(index + 1 == blocks.len()));
            out.extend_from_slice(&(block.len() as u16).to_le_bytes());
            out.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
            out.extend_from_slice(block);
        }
        let (mut a, mut b) = (1_u32, 0_u32);
        for byte in raw {
            a = (a + u32::from(*byte)) % 65_521;
            b = (b + a) % 65_521;
        }
        out.extend_from_slice(&((b << 16) | a).to_be_bytes());
        out
    }

    pub(crate) fn header(width: u32, height: u32, depth: u8, color: u8) -> Vec<u8> {
        let mut data = width.to_be_bytes().to_vec();
        data.extend_from_slice(&height.to_be_bytes());
        data.extend_from_slice(&[depth, color, 0, 0, 0]);
        chunk(b"IHDR", &data)
    }

    pub(crate) fn file(chunks: &[Vec<u8>]) -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        for one in chunks {
            bytes.extend_from_slice(one);
        }
        bytes
    }

    /// A 2 by 2 picture in 8-bit RGB (FAKE pixels): one filter byte and six bytes a row.
    pub(crate) fn pixels() -> Vec<u8> {
        zlib_stored(&[0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 0])
    }

    pub(crate) fn plain() -> Vec<Vec<u8>> {
        vec![
            header(2, 2, 8, 2),
            chunk(b"IDAT", &pixels()),
            chunk(b"IEND", &[]),
        ]
    }

    /// The types of the chunks of a cleaned file, in order.
    fn kinds(bytes: &[u8]) -> Vec<String> {
        let mut at = PNG_SIGNATURE.len();
        let mut kinds = Vec::new();
        while at < bytes.len() {
            let (one, next) = next_chunk(bytes, at).expect("a cleaned file is well formed");
            kinds.push(String::from_utf8(one.kind.to_vec()).unwrap());
            at = next;
        }
        kinds
    }

    fn contains(bytes: &[u8], needle: &[u8]) -> bool {
        bytes.windows(needle.len()).any(|window| window == needle)
    }

    fn insert_after_header(base: &[Vec<u8>], extra: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
        let mut all = vec![base[0].clone()];
        all.extend(extra);
        all.extend_from_slice(&base[1..]);
        all
    }

    #[test]
    fn the_checksum_is_the_one_the_specification_gives() {
        assert_eq!(crc32(&[b"IEND"]), 0xae42_6082);
        assert_eq!(crc32(&[b"123456789"]), 0xcbf4_3926);
        assert_eq!(crc32(&[b"1234", b"56789"]), 0xcbf4_3926);
    }

    #[test]
    fn a_picture_the_system_can_decode_has_the_same_pixels_after_cleaning() {
        let source = image::RgbaImage::from_fn(37, 23, |x, y| {
            image::Rgba([
                (x * 6) as u8,
                (y * 10) as u8,
                (x + y) as u8,
                255 - (x as u8),
            ])
        });
        let mut encoded = std::io::Cursor::new(Vec::new());
        source
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();
        let encoded = encoded.into_inner();
        // The same picture with a place and a time written into it.
        let mut dirty = encoded[..8 + 25].to_vec();
        dirty.extend(chunk(b"tEXt", b"Location\0FAKE 51.05,-114.07"));
        dirty.extend(chunk(b"tIME", &[7, 234, 11, 25, 12, 30, 0]));
        dirty.extend_from_slice(&encoded[8 + 25..]);
        assert!(contains(&dirty, b"FAKE 51.05"));
        let cleaned = clean_png(&dirty).unwrap();
        assert!(!contains(&cleaned, b"FAKE"));
        assert!(cleaned.len() <= dirty.len());
        let decode = |bytes: &[u8]| {
            image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
                .unwrap()
                .to_rgba8()
        };
        assert_eq!(decode(&cleaned), source);
        assert_eq!(decode(&cleaned), decode(&dirty));
    }

    #[test]
    fn place_time_and_camera_chunks_are_all_dropped() {
        let extra = vec![
            chunk(b"tEXt", b"Location\0FAKE 51.05,-114.07"),
            chunk(b"zTXt", b"Comment\0\0FAKE camera Phone X"),
            chunk(b"iTXt", b"Author\0\0\0\0\0FAKE Person Name"),
            chunk(b"eXIf", b"MM\0*\0\0\0\x08FAKE Make GPS"),
            chunk(b"tIME", &[7, 234, 11, 25, 12, 30, 0]),
            chunk(b"pHYs", &[0, 0, 11, 19, 0, 0, 11, 19, 1]),
            chunk(b"bKGD", &[0, 0, 0, 0, 0, 0]),
            chunk(b"sBIT", &[8, 8, 8]),
            chunk(b"iCCP", b"FAKE profile\0\0FAKE-DEFLATE"),
            chunk(b"prVt", b"FAKE private place"),
            chunk(b"oFFs", &[0; 9]),
        ];
        let mut dirty = file(&insert_after_header(&plain(), extra));
        dirty.extend_from_slice(b"FAKE data hidden after the end");
        for fake in [
            &b"FAKE 51.05"[..],
            b"FAKE camera",
            b"FAKE Person",
            b"FAKE Make",
            b"FAKE profile",
            b"FAKE private",
            b"hidden after",
        ] {
            assert!(contains(&dirty, fake));
        }
        let cleaned = clean_png(&dirty).unwrap();
        assert_eq!(kinds(&cleaned[..]), ["IHDR", "IDAT", "IEND"]);
        assert!(!contains(&cleaned, b"FAKE") && !contains(&cleaned, b"hidden"));
        assert_eq!(*cleaned, file(&plain()));
    }

    #[test]
    fn what_draws_the_picture_is_kept_byte_for_byte_in_the_specified_order() {
        let palette: Vec<u8> = (0..4_u8).flat_map(|n| [n * 60, 255 - n * 60, n]).collect();
        let (srgb, gama) = (chunk(b"sRGB", &[0]), chunk(b"gAMA", &[0, 1, 0x86, 0xa0]));
        let (chrm, plte) = (chunk(b"cHRM", &[7; 32]), chunk(b"PLTE", &palette));
        let trns = chunk(b"tRNS", &[255, 128]);
        let idat = [
            chunk(b"IDAT", &zlib_stored(&[0, 0, 1, 2, 3])[..10]),
            chunk(b"IDAT", &zlib_stored(&[0, 0, 1, 2, 3])[10..]),
        ];
        // In an order a file may not use, with a split run of image data.
        let dirty = file(&[
            header(4, 1, 8, 3),
            srgb.clone(),
            gama.clone(),
            chrm.clone(),
            plte.clone(),
            trns.clone(),
            idat[0].clone(),
            idat[1].clone(),
            chunk(b"IEND", &[]),
        ]);
        let cleaned = clean_png(&dirty).unwrap();
        assert_eq!(
            kinds(&cleaned[..]),
            ["IHDR", "cHRM", "gAMA", "sRGB", "PLTE", "tRNS", "IDAT", "IDAT", "IEND"]
        );
        for kept in [&srgb, &gama, &chrm, &plte, &trns, &idat[0], &idat[1]] {
            assert!(contains(&cleaned, kept));
        }
        // Cleaning what was written changes nothing.
        assert_eq!(*clean_png(&cleaned).unwrap(), *cleaned);
    }

    #[test]
    fn an_animated_picture_is_refused_in_each_of_its_forms() {
        let actl = chunk(b"acTL", &[0, 0, 0, 2, 0, 0, 0, 0]);
        let fctl = chunk(b"fcTL", &[0; 26]);
        let fdat = chunk(b"fdAT", &[0, 0, 0, 1, 1, 2, 3]);
        let first = insert_after_header(&plain(), vec![actl.clone()]);
        assert_eq!(clean_png(&file(&first)), Err(PhotoError::NotPng));
        let mut frames = plain();
        frames.splice(2..2, [fctl.clone(), fdat.clone()]);
        assert_eq!(clean_png(&file(&frames)), Err(PhotoError::NotPng));
        // The animation's control chunk alone, or only a frame's data, is also not a still picture.
        for lone in [fctl, fdat, actl] {
            let mut one = plain();
            one.insert(2, lone);
            assert_eq!(clean_png(&file(&one)), Err(PhotoError::NotPng));
        }
    }

    #[test]
    fn a_declared_size_over_the_caps_is_refused_before_anything_is_drawn() {
        let with = |width: u32, height: u32| {
            let mut chunks = plain();
            chunks[0] = header(width, height, 8, 2);
            clean_png(&file(&chunks))
        };
        // A file of a few dozen bytes that says it is far larger than anything it holds.
        for (width, height) in [
            (u32::MAX, 1),
            (1, u32::MAX),
            (100_000, 1),
            (8193, 1),
            (1, 8193),
            (0x8000_0000, 0x8000_0000),
            (8192, 8192),
            (8192, 6104),
        ] {
            assert_eq!(
                with(width, height),
                Err(PhotoError::TooLarge),
                "{width}x{height}"
            );
        }
        // Up to the caps is accepted: 8192 a side, and 50 million pixels in all.
        assert!(with(8192, 6103).is_ok());
        assert!(with(8192, 1).is_ok());
        assert!(with(1, 8192).is_ok());
        assert_eq!(with(0, 5), Err(PhotoError::NotPng));
        assert_eq!(with(5, 0), Err(PhotoError::NotPng));
        // A file of more than 25 MiB is refused whatever it holds.
        let mut huge = file(&plain());
        huge.resize(MAX_PHOTO_BYTES + 1, 0);
        assert_eq!(clean_png(&huge), Err(PhotoError::TooLarge));
    }

    #[test]
    fn a_wrong_checksum_in_any_chunk_is_refused_even_in_one_that_would_be_dropped() {
        let mut chunks = insert_after_header(
            &plain(),
            vec![
                chunk(b"tEXt", b"FAKE"),
                chunk(b"gAMA", &[0, 1, 0x86, 0xa0]),
                chunk(b"prVt", b"FAKE"),
            ],
        );
        chunks.insert(1, chunk(b"cHRM", &[7; 32]));
        let whole = file(&chunks);
        assert!(clean_png(&whole).is_ok());
        let mut at = PNG_SIGNATURE.len();
        while at < whole.len() {
            let (one, next) = next_chunk(&whole, at).unwrap();
            let (data_start, crc_start) = (at + 8, next - 4);
            // One bit of the checksum, and one bit of the data (or of the type when empty).
            for flip in [crc_start, crc_start + 3, data_start.min(crc_start - 1)] {
                let mut damaged = whole.clone();
                damaged[flip] ^= 0x01;
                assert!(
                    clean_png(&damaged).is_err(),
                    "{} at {flip}",
                    String::from_utf8_lossy(&one.kind)
                );
            }
            at = next;
        }
    }

    #[test]
    fn a_file_cut_anywhere_is_refused_and_never_read_past_its_end() {
        let whole = file(&insert_after_header(
            &plain(),
            vec![chunk(b"tEXt", b"FAKE"), chunk(b"gAMA", &[0, 1, 0x86, 0xa0])],
        ));
        assert!(clean_png(&whole).is_ok());
        for length in 0..whole.len() {
            assert!(clean_png(&whole[..length]).is_err(), "cut at {length}");
        }
        // The end chunk is needed, even when everything else is there.
        let no_end = file(&plain()[..2]);
        assert_eq!(clean_png(&no_end), Err(PhotoError::NotPng));
    }

    #[test]
    fn a_chunk_length_that_runs_past_the_file_or_overflows_is_refused() {
        let base = file(&plain());
        // Rewrite the length of the image data chunk (the second one) to each of these.
        let idat_at = PNG_SIGNATURE.len() + 25;
        let real = u32::from_be_bytes(base[idat_at..idat_at + 4].try_into().unwrap());
        for length in [
            real + 1,
            real + 12,
            real + 100_000,
            0x7fff_ffff,
            0x8000_0000,
            0xffff_fff0,
            0xffff_ffff,
        ] {
            let mut bytes = base.clone();
            bytes[idat_at..idat_at + 4].copy_from_slice(&length.to_be_bytes());
            assert_eq!(clean_png(&bytes), Err(PhotoError::NotPng), "{length:#x}");
        }
        // A length that is too small leaves the checksum in the wrong place.
        let mut small = base.clone();
        small[idat_at..idat_at + 4].copy_from_slice(&(real - 1).to_be_bytes());
        assert!(clean_png(&small).is_err());
        // The header's length too, and a length at the very end of the file.
        let mut header_long = base.clone();
        header_long[8..12].copy_from_slice(&0xffff_ffff_u32.to_be_bytes());
        assert!(clean_png(&header_long).is_err());
        let mut tail = base.clone();
        tail.extend_from_slice(&0xffff_ffff_u32.to_be_bytes());
        // Bytes after the end are never read, however they look.
        assert_eq!(*clean_png(&tail).unwrap(), base);
    }

    #[test]
    fn a_file_that_breaks_the_rules_of_the_format_is_refused() {
        let ok_data = chunk(b"IDAT", &pixels());
        let end = chunk(b"IEND", &[]);
        let cases: Vec<(&str, Vec<Vec<u8>>)> = vec![
            (
                "no header first",
                vec![ok_data.clone(), header(2, 2, 8, 2), end.clone()],
            ),
            (
                "a second header",
                vec![
                    header(2, 2, 8, 2),
                    header(2, 2, 8, 2),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            ("no image data", vec![header(2, 2, 8, 2), end.clone()]),
            (
                "image data split by another chunk",
                vec![
                    header(2, 2, 8, 2),
                    ok_data.clone(),
                    chunk(b"tEXt", b"FAKE"),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            (
                "an end with data",
                vec![header(2, 2, 8, 2), ok_data.clone(), chunk(b"IEND", &[1])],
            ),
            (
                "an unknown critical chunk",
                vec![
                    header(2, 2, 8, 2),
                    chunk(b"ZZZZ", &[]),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            (
                "a type that is not letters",
                vec![
                    header(2, 2, 8, 2),
                    chunk(b"te1t", &[]),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            (
                "the reserved bit set",
                vec![
                    header(2, 2, 8, 2),
                    chunk(b"tExt", &[]),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            (
                "a palette after the data",
                vec![
                    header(2, 2, 8, 2),
                    ok_data.clone(),
                    chunk(b"PLTE", &[0; 3]),
                    end.clone(),
                ],
            ),
            (
                "a colour hint after the data",
                vec![
                    header(2, 2, 8, 2),
                    ok_data.clone(),
                    chunk(b"gAMA", &[0; 4]),
                    end.clone(),
                ],
            ),
            (
                "two palettes",
                vec![
                    header(2, 2, 8, 2),
                    chunk(b"PLTE", &[0; 3]),
                    chunk(b"PLTE", &[0; 3]),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            (
                "a palette of a length that is not whole colours",
                vec![
                    header(2, 2, 8, 2),
                    chunk(b"PLTE", &[0; 4]),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            (
                "an indexed picture without a palette",
                vec![header(2, 2, 8, 3), ok_data.clone(), end.clone()],
            ),
            (
                "a palette in a grey picture",
                vec![
                    header(2, 2, 8, 0),
                    chunk(b"PLTE", &[0; 3]),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            (
                "more palette entries than the depth allows",
                vec![
                    header(2, 2, 1, 3),
                    chunk(b"PLTE", &[0; 9]),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            (
                "transparency in a picture with its own",
                vec![
                    header(2, 2, 8, 6),
                    chunk(b"tRNS", &[0; 2]),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            (
                "transparency before the palette",
                vec![
                    header(2, 2, 8, 3),
                    chunk(b"tRNS", &[0]),
                    chunk(b"PLTE", &[0; 3]),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            (
                "a colour hint of the wrong length",
                vec![
                    header(2, 2, 8, 2),
                    chunk(b"gAMA", &[0; 3]),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            (
                "two of one colour hint",
                vec![
                    header(2, 2, 8, 2),
                    chunk(b"sRGB", &[0]),
                    chunk(b"sRGB", &[0]),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            (
                "a rendering intent past the last",
                vec![
                    header(2, 2, 8, 2),
                    chunk(b"sRGB", &[4]),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            (
                "two colour profiles",
                vec![
                    header(2, 2, 8, 2),
                    chunk(b"iCCP", b"a\0\0x"),
                    chunk(b"iCCP", b"a\0\0x"),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            (
                "a depth the colour type does not have",
                vec![header(2, 2, 4, 2), ok_data.clone(), end.clone()],
            ),
            (
                "a colour type that does not exist",
                vec![header(2, 2, 8, 5), ok_data.clone(), end.clone()],
            ),
            (
                "an unknown compression method",
                vec![
                    chunk(b"IHDR", &[0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 1, 0, 0]),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            (
                "an unknown interlace method",
                vec![
                    chunk(b"IHDR", &[0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 2]),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            (
                "a short header",
                vec![
                    chunk(b"IHDR", &[0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0]),
                    ok_data.clone(),
                    end.clone(),
                ],
            ),
            (
                "image data that is not a zlib stream",
                vec![
                    header(2, 2, 8, 2),
                    chunk(b"IDAT", &[1, 2, 3, 4]),
                    end.clone(),
                ],
            ),
            (
                "image data too short to start a zlib stream",
                vec![header(2, 2, 8, 2), chunk(b"IDAT", &[0x78]), end.clone()],
            ),
            (
                "a zlib stream that asks for a dictionary",
                vec![
                    header(2, 2, 8, 2),
                    chunk(b"IDAT", &[0x78, 0xbb, 0, 0]),
                    end.clone(),
                ],
            ),
        ];
        assert!(clean_png(&file(&[header(2, 2, 8, 2), ok_data.clone(), end.clone()])).is_ok());
        for (what, chunks) in cases {
            assert_eq!(clean_png(&file(&chunks)), Err(PhotoError::NotPng), "{what}");
        }
        // Not a PNG at all, by its first bytes.
        for other in [
            &b""[..],
            b"\x89PNG",
            b"\x89PNG\r\n\x1a",
            b"GIF89a",
            b"\xff\xd8\xff\xe0",
            b"%PDF-1.7",
        ] {
            assert_eq!(clean_png(other), Err(PhotoError::NotPng));
        }
    }

    #[test]
    fn a_split_zlib_header_and_a_palette_with_transparency_are_accepted() {
        // The two header bytes in two chunks of image data.
        let stream = pixels();
        let split = file(&[
            header(2, 2, 8, 2),
            chunk(b"IDAT", &stream[..1]),
            chunk(b"IDAT", &stream[1..]),
            chunk(b"IEND", &[]),
        ]);
        assert!(clean_png(&split).is_ok());
        let indexed = file(&[
            header(2, 2, 2, 3),
            chunk(b"PLTE", &[0, 0, 0, 255, 255, 255]),
            chunk(b"tRNS", &[0]),
            chunk(b"IDAT", &zlib_stored(&[0, 0b0001_1011, 0, 0b1110_0100])),
            chunk(b"IEND", &[]),
        ]);
        assert_eq!(
            kinds(&clean_png(&indexed).unwrap()[..]),
            ["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]
        );
    }

    /// A small deterministic generator, so a failure can be run again.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self, below: usize) -> usize {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((self.0 >> 33) as usize) % below
        }
    }

    #[test]
    fn cleaning_never_grows_a_file_never_panics_and_gives_the_same_bytes_again() {
        let kinds_pool: [&[u8; 4]; 17] = [
            b"IHDR", b"PLTE", b"tRNS", b"gAMA", b"cHRM", b"sRGB", b"iCCP", b"IDAT", b"IEND",
            b"cICP", b"tEXt", b"eXIf", b"tIME", b"acTL", b"prVt", b"ZZZZ", b"pHYs",
        ];
        let mut rng = Lcg(0x5eed);
        let (mut accepted, mut refused) = (0, 0);
        for _ in 0..6_000 {
            // Mostly well formed lists with a few things out of place.
            let mut chunks = vec![header(
                1 + rng.next(6) as u32,
                1 + rng.next(6) as u32,
                [1, 2, 4, 8, 16][rng.next(5)],
                [0, 2, 3, 4, 6][rng.next(5)],
            )];
            for _ in 0..rng.next(8) {
                let kind = kinds_pool[rng.next(kinds_pool.len())];
                let length = [0, 1, 2, 3, 4, 6, 9, 13, 32][rng.next(9)];
                let data: Vec<u8> = (0..length).map(|_| rng.next(256) as u8).collect();
                let data = if kind == b"IDAT" { pixels() } else { data };
                chunks.push(chunk(kind, &data));
            }
            if rng.next(4) != 0 {
                chunks.push(chunk(b"IDAT", &pixels()));
            }
            if rng.next(8) != 0 {
                chunks.push(chunk(b"IEND", &[]));
            }
            let mut bytes = file(&chunks);
            if rng.next(5) == 0 {
                let at = rng.next(bytes.len());
                bytes[at] ^= 1 << rng.next(8);
            }
            if rng.next(5) == 0 {
                bytes.truncate(rng.next(bytes.len() + 1));
            }
            match clean_png(&bytes) {
                Ok(cleaned) => {
                    accepted += 1;
                    assert!(cleaned.len() <= bytes.len());
                    assert_eq!(*clean_png(&cleaned).unwrap(), *cleaned);
                    let list = kinds(&cleaned[..]);
                    assert_eq!(list.first().map(String::as_str), Some("IHDR"));
                    assert_eq!(list.last().map(String::as_str), Some("IEND"));
                    for kept in &list {
                        assert!(
                            [
                                "IHDR", "PLTE", "tRNS", "gAMA", "cHRM", "sRGB", "cICP", "IDAT",
                                "IEND"
                            ]
                            .contains(&kept.as_str()),
                            "{kept}"
                        );
                    }
                }
                Err(_) => refused += 1,
            }
        }
        // The generator reaches both outcomes, so neither half of this test is empty.
        assert!(accepted > 100 && refused > 100, "{accepted} {refused}");
    }

    /// An iCCP chunk: a name, the zero byte, the compression method and some "profile" bytes.
    fn iccp(name: &[u8], method: u8, profile: &[u8]) -> Vec<u8> {
        let mut data = name.to_vec();
        data.extend_from_slice(&[0, method]);
        data.extend_from_slice(profile);
        chunk(b"iCCP", &data)
    }

    fn cleaned_with(extra: Vec<Vec<u8>>) -> Vec<u8> {
        clean_png(&file(&insert_after_header(&plain(), extra)))
            .unwrap()
            .to_vec()
    }

    /// The data of the first chunk of `kind` in a cleaned file.
    fn data_of(bytes: &[u8], kind: &[u8; 4]) -> Option<Vec<u8>> {
        let mut at = PNG_SIGNATURE.len();
        while at < bytes.len() {
            let (one, next) = next_chunk(bytes, at).unwrap();
            if &one.kind == kind {
                return Some(one.data.to_vec());
            }
            at = next;
        }
        None
    }

    #[test]
    fn a_profile_named_display_p3_becomes_a_fixed_colour_codes_chunk() {
        let profile = [0x78, 0x9c, b'F', b'A', b'K', b'E', 1, 2, 3, 4, 5, 6];
        // The hints a phone also writes are replaced, as the colour codes come first.
        let cleaned = cleaned_with(vec![
            iccp(b"Display P3", 0, &profile),
            chunk(b"sRGB", &[0]),
            chunk(b"gAMA", &[0, 1, 0x86, 0xa0]),
        ]);
        assert_eq!(kinds(&cleaned), ["IHDR", "cICP", "IDAT", "IEND"]);
        assert_eq!(data_of(&cleaned, b"cICP").unwrap(), [12, 13, 0, 1]);
        assert!(!contains(&cleaned, b"Display") && !contains(&cleaned, b"FAKE"));
        assert_eq!(*clean_png(&cleaned).unwrap(), cleaned);
    }

    #[test]
    fn a_profile_named_srgb_becomes_a_fixed_srgb_chunk_once() {
        let profile = [0x78, 0x9c, b'F', b'A', b'K', b'E', 1, 2, 3, 4, 5, 6];
        let cleaned = cleaned_with(vec![iccp(b"sRGB", 0, &profile)]);
        assert_eq!(kinds(&cleaned), ["IHDR", "sRGB", "IDAT", "IEND"]);
        assert_eq!(data_of(&cleaned, b"sRGB").unwrap(), [0]);
        assert!(!contains(&cleaned, b"FAKE"));
        // A file that also has its own sRGB chunk (any intent) does not get a second one.
        let both = cleaned_with(vec![iccp(b"sRGB", 0, &profile), chunk(b"sRGB", &[2])]);
        assert_eq!(kinds(&both), ["IHDR", "sRGB", "IDAT", "IEND"]);
        assert_eq!(data_of(&both, b"sRGB").unwrap(), [2]);
        // With colour codes of its own the file keeps them, and nothing is added.
        let own = cleaned_with(vec![
            iccp(b"sRGB", 0, &profile),
            chunk(b"cICP", &[1, 13, 0, 0]),
        ]);
        assert_eq!(kinds(&own), ["IHDR", "cICP", "IDAT", "IEND"]);
        assert_eq!(data_of(&own, b"cICP").unwrap(), [1, 13, 0, 0]);
    }

    #[test]
    fn any_other_profile_or_a_name_that_is_not_exactly_one_of_two_is_dropped() {
        let profile = [0x78, 0x9c, b'F', b'A', b'K', b'E', 1, 2, 3, 4, 5, 6];
        for name in [
            &b"FAKE Camera Profile"[..],
            b"Adobe RGB (1998)",
            b"sRGB IEC61966-2.1",
            b"display p3",
            b"Display P3 ",
            b" Display P3",
            b"Display-P3",
            b"DisplayP3",
            b"SRGB",
            b"srgb",
            b"sRGB\xff",
            b"Display P3\x01",
            b"",
        ] {
            let cleaned = cleaned_with(vec![iccp(name, 0, &profile)]);
            assert_eq!(kinds(&cleaned), ["IHDR", "IDAT", "IEND"], "{name:?}");
            assert!(!contains(&cleaned, b"FAKE"), "{name:?}");
        }
        // A chunk that is not built as one: no end to the name, a name over 79 bytes, a
        // compression method that is not 0, no room for a profile, a stray byte after the name.
        let mut no_end = b"sRGB".to_vec();
        no_end.extend_from_slice(&[b'x'; 8]);
        let long = [&[b'a'; 80][..], &[0, 0], &profile[..]].concat();
        for bad in [
            chunk(b"iCCP", &no_end),
            chunk(b"iCCP", &long),
            iccp(b"sRGB", 1, &profile),
            iccp(b"sRGB", 0, &profile[..3]),
            iccp(b"Display P3", 0, &[]),
            chunk(b"iCCP", b"sRGB\0"),
            chunk(b"iCCP", b"Display P3\0\0\0"),
        ] {
            let cleaned = cleaned_with(vec![bad]);
            assert_eq!(kinds(&cleaned), ["IHDR", "IDAT", "IEND"]);
        }
        // Two colour profiles, or one after the image data, are still refused.
        let mut two = plain();
        two.splice(
            1..1,
            [iccp(b"sRGB", 0, &profile), iccp(b"sRGB", 0, &profile)],
        );
        assert_eq!(clean_png(&file(&two)), Err(PhotoError::NotPng));
        // The colour codes' own limits.
        for bad in [[23, 13, 0, 1], [1, 23, 0, 1], [1, 13, 1, 1], [1, 13, 0, 2]] {
            let mut codes = plain();
            codes.insert(1, chunk(b"cICP", &bad));
            assert_eq!(clean_png(&file(&codes)), Err(PhotoError::NotPng), "{bad:?}");
        }
        let mut short = plain();
        short.insert(1, chunk(b"cICP", &[1, 13, 0]));
        assert_eq!(clean_png(&file(&short)), Err(PhotoError::NotPng));
    }

    #[test]
    fn a_phone_allows_fewer_pixels_than_a_computer() {
        let with = |max: u64, width: u32, height: u32| {
            let mut chunks = plain();
            chunks[0] = header(width, height, 8, 2);
            clean_png_within(&file(&chunks), max)
        };
        // 8192 x 2929 is 23,994,368 pixels, 8192 x 2930 is 24,002,560.
        assert!(with(MAX_PICTURE_PIXELS_MOBILE, 8192, 2929).is_ok());
        assert_eq!(
            with(MAX_PICTURE_PIXELS_MOBILE, 8192, 2930),
            Err(PhotoError::TooLarge)
        );
        assert!(with(MAX_PICTURE_PIXELS_DESKTOP, 8192, 2930).is_ok());
        assert!(with(MAX_PICTURE_PIXELS_DESKTOP, 8192, 6103).is_ok());
        assert_eq!(
            with(MAX_PICTURE_PIXELS_DESKTOP, 8192, 6104),
            Err(PhotoError::TooLarge)
        );
        // This build's cap is the one for its device.
        assert_eq!(
            MAX_PICTURE_PIXELS,
            if cfg!(any(target_os = "android", target_os = "ios")) {
                24_000_000
            } else {
                50_000_000
            }
        );
    }
}

//! Showing a stored PDF inside myCarlos (#48).
//!
//! A page is drawn in the same helper process that unlocks PDFs (`pdf_unlock`), never beside
//! the vault keys and never in the app's webview: the helper gets one decrypted document, its
//! password if it has one, a page number and a width, and answers with that page as a PNG
//! picture plus the page's text, for screen readers and copying. Nothing is written to disk.
//! `hayro` draws the page and `lopdf` reads its text. `hayro`, `hayro-interpret` and `lopdf`
//! forbid unsafe code in their own crates; `hayro-syntax` and the decoders below it do not
//! (flate2 with zlib-rs, memchr, SIMD image decoders; see DEPENDENCY_REVIEW). That is one more
//! reason all of it runs only in the helper. PDF scripts, links, attachments and forms are not
//! run or followed: the picture has none of them.
//!
//! One page is drawn at a time: each request takes a `ViewTicket`, and a newer request, a lock
//! or the reader closing (`cancel_views`) stops the helper still drawing an older one.

use crate::pdf_unlock::{self, Refusal, Request};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(desktop)]
use zeroize::Zeroizing;

/// The latest page request; an older one still drawing is stopped.
static VIEW_GENERATION: AtomicU64 = AtomicU64::new(0);
static IDENTITY_GENERATION: AtomicU64 = AtomicU64::new(0);

/// One page request. It stays current until a newer request, a lock or the reader closing.
#[derive(Clone, Copy)]
pub(crate) struct ViewTicket(u64, bool);

impl ViewTicket {
    pub(crate) fn new() -> Self {
        Self(VIEW_GENERATION.fetch_add(1, Ordering::SeqCst) + 1, false)
    }

    /// Background suggestions cannot supersede the reader's page request.
    pub(crate) fn identity() -> Self {
        Self(IDENTITY_GENERATION.fetch_add(1, Ordering::SeqCst) + 1, true)
    }

    pub(crate) fn is_current(&self) -> bool {
        let generation = if self.1 {
            &IDENTITY_GENERATION
        } else {
            &VIEW_GENERATION
        };
        generation.load(Ordering::SeqCst) == self.0
    }
}

/// Stops any page being drawn: when the vault locks and when the reader closes.
pub(crate) fn cancel_views() {
    IDENTITY_GENERATION.fetch_add(1, Ordering::SeqCst);
    VIEW_GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// The request that asks the helper for a page.
pub(crate) const VIEW_MAGIC: &[u8; 8] = b"MCPDFVW1";
/// Versioned independently from the unlock response: includes both text representations.
const VIEW_RESPONSE_MAGIC: &[u8; 8] = b"MCPDFVR2";
/// The widest or tallest page picture, in pixels: larger asks are scaled down.
pub(crate) const MAX_SIDE: u32 = 4096;
/// The most page text sent back; longer text is cut, at a character boundary.
pub(crate) const MAX_PAGE_TEXT_BYTES: usize = 256 * 1024;
/// The largest picture taken back: a 4096 x 4096 page as PNG stays well below it.
const MAX_PNG_BYTES: usize = 96 * 1024 * 1024;

/// One page, as shown.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Page {
    pub(crate) page_count: u32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) png: Vec<u8>,
    /// Legacy extraction used by exact-text consumers.
    pub(crate) text: String,
    /// Reader-only extraction retaining supported vertical line movements.
    pub(crate) readable_text: String,
}

/// What asking the helper for a page came to.
pub(crate) enum Outcome {
    Shown(Page),
    Refused(Refusal),
    /// This device cannot run the helper: phones cannot start a second process.
    #[cfg_attr(desktop, allow(dead_code))]
    Unavailable,
    /// The helper could not be started, ran out of time or memory, or answered wrongly.
    Failed,
    /// The helper could not be sandboxed on this system, so it was given nothing to read.
    NoSandbox,
    /// A newer request, a lock or the reader closing stopped it.
    Cancelled,
}

/// Draws page `index` (from 0) of `pdf`, `width` pixels wide at most, opening it with
/// `password` first if it is locked. This is what runs inside the helper.
pub(crate) fn render(pdf: &[u8], password: &str, index: u32, width: u32) -> Result<Page, Refusal> {
    use hayro::hayro_interpret::InterpreterSettings;
    use hayro::hayro_syntax::Pdf;
    use hayro::{PixmapSettings, RenderCache, RenderSettings};
    // hayro cannot open a locked document: unlock it first, in this same process.
    let unlocked;
    let bytes: &[u8] = match pdf_unlock::unlock(pdf, password) {
        Ok(open) => {
            unlocked = open;
            &unlocked
        }
        Err(Refusal::NotEncrypted) => pdf,
        Err(refusal) => return Err(refusal),
    };
    let document = Pdf::new(bytes.to_vec()).map_err(|_| Refusal::Damaged)?;
    let pages = document.pages();
    let page_count = u32::try_from(pages.len()).map_err(|_| Refusal::Damaged)?;
    let page = pages.get(index as usize).ok_or(Refusal::NoSuchPage)?;
    let (page_width, page_height) = page.render_dimensions();
    if !(page_width >= 1.0 && page_height >= 1.0) {
        return Err(Refusal::Damaged);
    }
    let scale = (width.clamp(1, MAX_SIDE) as f32 / page_width)
        .min(MAX_SIDE as f32 / page_height)
        .max(f32::MIN_POSITIVE);
    let pixmap = hayro::render(
        page,
        &RenderCache::new(),
        &InterpreterSettings::default(),
        &RenderSettings::default(),
        &PixmapSettings {
            x_scale: scale,
            y_scale: scale,
            bg_color: hayro::vello_cpu::color::palette::css::WHITE,
        },
    );
    let (width, height) = (u32::from(pixmap.width()), u32::from(pixmap.height()));
    if width == 0 || height == 0 {
        return Err(Refusal::Damaged);
    }
    // On an opaque white background every pixel is opaque, so premultiplied is plain RGBA.
    let picture = image::RgbaImage::from_raw(width, height, pixmap.data_as_u8_slice().to_vec())
        .ok_or(Refusal::Damaged)?;
    let mut png = Vec::new();
    picture
        .write_to(&mut io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|_| Refusal::Damaged)?;
    if png.len() > MAX_PNG_BYTES {
        return Err(Refusal::TooLarge);
    }
    let text = page_text(bytes, index);
    let readable_text = readable_page_text(bytes, index, &text);
    Ok(Page {
        page_count,
        width,
        height,
        png,
        text,
        readable_text,
    })
}

/// The text on page `index`, for screen readers and copying, or nothing when it cannot be read.
fn page_text(pdf: &[u8], index: u32) -> String {
    let Ok(document) = lopdf::Document::load_mem(pdf) else {
        return String::new();
    };
    let mut text = document
        .extract_text_with_limit(&[index + 1], 16 * 1024 * 1024)
        .unwrap_or_default();
    if text.len() > MAX_PAGE_TEXT_BYTES {
        let mut end = MAX_PAGE_TEXT_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

/// Preserve unambiguous Td/TD line movements for the reader only. The original PDF,
/// rendering, and legacy extraction are never changed. Unsupported transforms and fonts
/// retain the legacy text; this deliberately does not infer arbitrary PDF page layout.
fn readable_page_text(pdf: &[u8], index: u32, legacy: &str) -> String {
    positioned_page_text(pdf, index).unwrap_or_else(|| legacy.to_owned())
}

fn positioned_page_text(pdf: &[u8], index: u32) -> Option<String> {
    use lopdf::content::{Content, Operation};
    const CONTENT_LIMIT: usize = 16 * 1024 * 1024;
    let mut document = lopdf::Document::load_mem(pdf).ok()?;
    let number = index.checked_add(1)?;
    let page_id = *document.get_pages().get(&number)?;
    let horizontal_fonts: Vec<Vec<u8>> = document
        .get_page_fonts(page_id)
        .ok()?
        .into_iter()
        .filter_map(|(name, font)| {
            let subtype = font.get(b"Subtype").ok()?.as_name().ok()?;
            let horizontal = match subtype {
                b"Type1" | b"MMType1" | b"TrueType" => true,
                b"Type0" => font
                    .get(b"Encoding")
                    .and_then(lopdf::Object::as_name)
                    .is_ok_and(|encoding| encoding.ends_with(b"-H")),
                _ => false,
            };
            horizontal.then_some(name)
        })
        .collect();
    let content = Content::decode(
        &document
            .get_page_content_with_limit(page_id, CONTENT_LIMIT)
            .ok()?,
    )
    .ok()?;
    let mut operations = Vec::with_capacity(content.operations.len());
    let mut font_size: Option<f32> = None;
    let mut previous_size: Option<f32> = None;
    let mut has_text = false;
    for operation in content.operations {
        match operation.operator.as_str() {
            // These require graphics/text-matrix tracking, outside this conservative path.
            "cm" | "Tm" | "q" | "Q" => return None,
            "Tf" => {
                font_size = operation
                    .operands
                    .first()
                    .and_then(|name| name.as_name().ok())
                    .filter(|name| {
                        horizontal_fonts
                            .iter()
                            .any(|known| known.as_slice() == *name)
                    })
                    .and_then(|_| operation.operands.get(1)?.as_float().ok())
                    .filter(|size| size.is_finite() && *size > 0.0);
            }
            "BT" | "ET" | "T*" => {
                has_text = false;
                previous_size = None;
            }
            "Td" | "TD" => {
                if let (true, Some(current), Some(previous)) = (has_text, font_size, previous_size)
                {
                    if operation
                        .operands
                        .get(1)
                        .and_then(|value| value.as_float().ok())
                        .is_some_and(|dy| dy.is_finite() && dy.abs() >= current.max(previous))
                    {
                        operations.push(Operation::new("T*", vec![]));
                        has_text = false;
                        previous_size = None;
                    }
                }
            }
            "Tj" | "TJ" | "'" | "\"" => {
                has_text = true;
                previous_size = font_size;
            }
            _ => {}
        }
        operations.push(operation);
    }
    let original = document
        .extract_text_with_limit(&[number], CONTENT_LIMIT)
        .ok()?;
    let encoded = Content { operations }.encode().ok()?;
    if encoded.len() > CONTENT_LIMIT {
        return None;
    }
    // This private parsed copy exists only for extraction; it is never saved or rendered.
    let stream = document.add_object(lopdf::Stream::new(lopdf::Dictionary::new(), encoded));
    document
        .get_object_mut(page_id)
        .ok()?
        .as_dict_mut()
        .ok()?
        .set("Contents", stream);
    let mut readable = document
        .extract_text_with_limit(&[number], CONTENT_LIMIT)
        .ok()?;
    // The adjustment may add whitespace only, never change words, numbers or punctuation.
    if !original
        .chars()
        .filter(|c| !c.is_whitespace())
        .eq(readable.chars().filter(|c| !c.is_whitespace()))
    {
        return None;
    }
    let mut end = readable.len().min(MAX_PAGE_TEXT_BYTES);
    while !readable.is_char_boundary(end) {
        end -= 1;
    }
    readable.truncate(end);
    Some(readable)
}

#[cfg(any(desktop, test))]
fn write_view_request(
    out: &mut impl Write,
    pdf: &[u8],
    password: &str,
    index: u32,
    width: u32,
) -> io::Result<()> {
    if password.len() > pdf_unlock::MAX_PASSWORD_BYTES {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    out.write_all(VIEW_MAGIC)?;
    pdf_unlock::write_password_and_pdf(out, password.as_bytes(), pdf)?;
    out.write_all(&index.to_le_bytes())?;
    out.write_all(&width.to_le_bytes())
}

/// Answers one page request in the helper, after `VIEW_MAGIC` was read. Returns the exit code.
pub(crate) fn answer(input: &mut impl Read, out: &mut impl Write) -> i32 {
    let result = match pdf_unlock::read_password_and_pdf(input) {
        Ok(Request::Read { password, pdf }) => {
            let mut numbers = [0u8; 8];
            if input.read_exact(&mut numbers).is_err() {
                return 3;
            }
            let index = u32::from_le_bytes(numbers[..4].try_into().unwrap_or_default());
            let width = u32::from_le_bytes(numbers[4..].try_into().unwrap_or_default());
            render(&pdf, &password, index, width)
        }
        Ok(Request::TooLarge) => Err(Refusal::TooLarge),
        Ok(Request::Malformed) | Err(_) => return 3,
    };
    match write_view_response(out, &result) {
        Ok(()) => 0,
        Err(_) => 4,
    }
}

fn write_view_response(out: &mut impl Write, result: &Result<Page, Refusal>) -> io::Result<()> {
    out.write_all(VIEW_RESPONSE_MAGIC)?;
    match result {
        Ok(page) => {
            // Together these field limits bound the payload to 96 MiB + 512 KiB.
            if page.png.len() > MAX_PNG_BYTES
                || page.text.len() > MAX_PAGE_TEXT_BYTES
                || page.readable_text.len() > MAX_PAGE_TEXT_BYTES
            {
                return Err(io::ErrorKind::InvalidInput.into());
            }
            out.write_all(&[0])?;
            for number in [page.page_count, page.width, page.height] {
                out.write_all(&number.to_le_bytes())?;
            }
            out.write_all(&(page.png.len() as u64).to_le_bytes())?;
            out.write_all(&page.png)?;
            out.write_all(&(page.text.len() as u64).to_le_bytes())?;
            out.write_all(page.text.as_bytes())?;
            out.write_all(&(page.readable_text.len() as u64).to_le_bytes())?;
            out.write_all(page.readable_text.as_bytes())?;
        }
        Err(refusal) => out.write_all(&[refusal.code()])?,
    }
    out.flush()
}

/// The helper's answer to a page request, or `None` when it is not one. The picture must be a
/// PNG of the size declared, decoded within fixed limits and encoded again from its pixels.
#[cfg(any(desktop, test))]
fn read_view_response(input: &mut impl Read) -> Option<Result<Page, Refusal>> {
    let mut head = [0u8; 9];
    input.read_exact(&mut head).ok()?;
    if &head[..8] != VIEW_RESPONSE_MAGIC {
        return None;
    }
    let answer = if head[8] != 0 {
        Err(Refusal::from_code(head[8])?)
    } else {
        let mut numbers = [0u8; 12];
        input.read_exact(&mut numbers).ok()?;
        let number = |at: usize| u32::from_le_bytes(numbers[at..at + 4].try_into().unwrap());
        let (page_count, width, height) = (number(0), number(4), number(8));
        if width == 0 || height == 0 || width > MAX_SIDE || height > MAX_SIDE {
            return None;
        }
        let png = clean_png(&read_sized(input, MAX_PNG_BYTES)?, width, height)?;
        let text = String::from_utf8(read_sized(input, MAX_PAGE_TEXT_BYTES)?).ok()?;
        let readable_text = String::from_utf8(read_sized(input, MAX_PAGE_TEXT_BYTES)?).ok()?;
        Ok(Page {
            page_count,
            width,
            height,
            png,
            text,
            readable_text,
        })
    };
    // Nothing may follow the answer.
    let mut extra = [0u8; 1];
    matches!(input.read(&mut extra), Ok(0)).then_some(answer)
}

/// Whether `png` starts as a PNG does, with an IHDR of `width` x `height`. Nothing is decoded.
#[cfg(any(desktop, test))]
fn png_of_size(png: &[u8], width: u32, height: u32) -> bool {
    png.len() >= 24
        && png.starts_with(b"\x89PNG\r\n\x1a\n")
        && &png[12..16] == b"IHDR"
        && png[16..20] == width.to_be_bytes()
        && png[20..24] == height.to_be_bytes()
}

/// Only the helper's RGBA8 format is accepted. Check dimensions and pixel storage before
/// starting the decoder; its own allocation limit also bounds PNG metadata and workspace.
/// The webview receives a fresh PNG containing only the decoded pixels.
#[cfg(any(desktop, test))]
fn clean_png(png: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    const MAX_DECODED_BYTES: u64 = MAX_SIDE as u64 * MAX_SIDE as u64 * 4;
    if !(1..=MAX_SIDE).contains(&width)
        || !(1..=MAX_SIDE).contains(&height)
        || !png_of_size(png, width, height)
        || png.len() < 33
        || png[24] != 8
        || png[25] != 6
    {
        return None;
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(width);
    limits.max_image_height = Some(height);
    limits.max_alloc = Some(MAX_DECODED_BYTES);
    let mut reader = image::ImageReader::with_format(io::Cursor::new(png), image::ImageFormat::Png);
    reader.limits(limits);
    let pixels = reader.decode().ok()?;
    if (pixels.width(), pixels.height()) != (width, height)
        || pixels.color() != image::ColorType::Rgba8
    {
        return None;
    }
    let mut clean = Vec::new();
    pixels
        .write_to(&mut io::Cursor::new(&mut clean), image::ImageFormat::Png)
        .ok()?;
    (clean.len() <= MAX_PNG_BYTES).then_some(clean)
}

#[cfg(any(desktop, test))]
fn read_sized(input: &mut impl Read, limit: usize) -> Option<Vec<u8>> {
    let mut length = [0u8; 8];
    input.read_exact(&mut length).ok()?;
    let length = usize::try_from(u64::from_le_bytes(length)).ok()?;
    if length > limit {
        return None;
    }
    let mut bytes = vec![0u8; length];
    input.read_exact(&mut bytes).ok()?;
    Some(bytes)
}

/// Shows page `index` of `pdf` through the helper, unless `ticket` stops being current. Phones
/// cannot start it: `Unavailable`.
pub(crate) fn view_in_helper(
    pdf: &[u8],
    password: &str,
    index: u32,
    width: u32,
    ticket: &ViewTicket,
) -> Outcome {
    #[cfg(desktop)]
    {
        if !ticket.is_current() {
            return Outcome::Cancelled;
        }
        if password.len() > pdf_unlock::MAX_PASSWORD_BYTES {
            return Outcome::Failed;
        }
        if pdf.len() > pdf_unlock::MAX_LOCKED_PDF_BYTES {
            return Outcome::Refused(Refusal::TooLarge);
        }
        let Ok(executable) = std::env::current_exe() else {
            return Outcome::Failed;
        };
        let command = pdf_unlock::helper_command(&executable);
        let mut request = Zeroizing::new(Vec::with_capacity(pdf.len() + password.len() + 28));
        if write_view_request(&mut *request, pdf, password, index, width).is_err() {
            return Outcome::Failed;
        }
        let answer = pdf_unlock::exchange(
            command,
            request,
            pdf_unlock::HELPER_TIME_LIMIT,
            read_view_response,
            &|| !ticket.is_current(),
        );
        if !ticket.is_current() {
            return Outcome::Cancelled;
        }
        match answer {
            Ok(Ok(page)) => Outcome::Shown(page),
            Ok(Err(refusal)) => Outcome::Refused(refusal),
            Err(_) if !ticket.is_current() => Outcome::Cancelled,
            Err(pdf_unlock::Unanswered::NoSandbox) => Outcome::NoSandbox,
            Err(pdf_unlock::Unanswered::Failed) => Outcome::Failed,
        }
    }
    #[cfg(mobile)]
    {
        let _ = (pdf, password, index, width, ticket);
        Outcome::Unavailable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWORD: &str = "FAKE-portal-2026";

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/locked-pdf")
                .join(name),
        )
        .unwrap()
    }

    fn is_png(bytes: &[u8]) -> bool {
        bytes.starts_with(b"\x89PNG\r\n\x1a\n")
    }

    #[test]
    fn fake_imaging_report_keeps_its_positioned_lines_readable() {
        // Exact output of scripts/generate-fake-dev-data.mjs, not rewritten PDF text.
        let pdf =
            include_bytes!("../tests/fixtures/reader-lines/FAKE_Morgan_Patient_Imaging_Report.pdf");
        let before = pdf.to_vec();
        let raw = page_text(pdf, 0);
        assert_eq!(raw, "FAKE Imaging ReportPatient: FAKE Morgan PatientProvider: FAKE Riverside ImagingFinding: Synthetic normal studyGenerated for myCarlos durable-vault testing\n");
        let text = readable_page_text(pdf, 0, &raw);
        assert_eq!(text, "FAKE Imaging Report\nPatient: FAKE Morgan Patient\nProvider: FAKE Riverside Imaging\nFinding: Synthetic normal study\nGenerated for myCarlos durable-vault testing\n");
        let rendered = render(pdf, "", 0, 300).unwrap();
        assert_eq!(rendered.text, raw);
        assert_eq!(rendered.readable_text, text);
        assert_eq!(pdf.as_slice(), before);
        assert_eq!(page_text(pdf, 0), raw);
    }

    fn pdf_with_operators(operators: &str) -> Vec<u8> {
        use lopdf::{dictionary, Document, Object, Stream};
        let mut document = Document::with_version("1.5");
        let pages = document.new_object_id();
        let font = document.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding"
        });
        let resources = document.add_object(dictionary! { "Font" => dictionary! { "F1" => font } });
        let content =
            document.add_object(Stream::new(dictionary! {}, operators.as_bytes().to_vec()));
        let page = document.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages, "Resources" => resources,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()], "Contents" => content
        });
        document.objects.insert(
            pages,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1
            }),
        );
        let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        document.trailer.set("Root", catalog);
        let mut pdf = Vec::new();
        document.save_to(&mut pdf).unwrap();
        pdf
    }

    #[test]
    fn reader_keeps_glyph_fragments_clinical_values_and_small_baseline_shifts_together() {
        let pdf = pdf_with_operators(
            r#"BT /F1 11 Tf 72 740 Td
            (Hb) Tj (A1c: ) Tj [(1.) 0 (5)] TJ (mg; BP: 120/80; cm) Tj
            0 3 Td /F1 7 Tf (2) Tj 0 -3 Td /F1 11 Tf
            8 0 Td (.) Tj 0 -24 TD (Patient: FAKE Morgan Patient) Tj
            0 -24 Td (Provider: FAKE Riverside Imaging) Tj ET"#,
        );
        let raw = page_text(&pdf, 0);
        assert_eq!(raw, "HbA1c: 1.5 mg; BP: 120/80; cm2.Patient: FAKE Morgan PatientProvider: FAKE Riverside Imaging\n");
        let readable = readable_page_text(&pdf, 0, &raw);
        assert_eq!(readable, "HbA1c: 1.5 mg; BP: 120/80; cm2.\nPatient: FAKE Morgan Patient\nProvider: FAKE Riverside Imaging\n");
        assert_eq!(page_text(&pdf, 0), raw);
    }

    #[test]
    fn reader_falls_back_for_unsupported_transforms_and_fonts() {
        for operators in [
            "BT /F1 11 Tf 1 0 0 1 72 740 Tm (FAKE) Tj 0 -24 Td (field) Tj ET",
            "q 1 0 0 1 0 0 cm BT /F1 11 Tf (FAKE) Tj 0 -24 Td (field) Tj ET Q",
            "BT /Unknown 11 Tf (FAKE) Tj 0 -24 Td (field) Tj ET",
        ] {
            let pdf = pdf_with_operators(operators);
            let raw = page_text(&pdf, 0);
            assert_eq!(readable_page_text(&pdf, 0, &raw), raw);
        }
    }

    #[test]
    fn reader_compares_complete_text_before_truncating_at_a_utf8_boundary() {
        let pdf = pdf_with_operators(&format!(
            "BT /F1 11 Tf 72 740 Td (FAKE) Tj 0 -24 Td ({}) Tj ET",
            "\\351".repeat(MAX_PAGE_TEXT_BYTES / 2)
        ));
        let raw = page_text(&pdf, 0);
        let readable = readable_page_text(&pdf, 0, &raw);
        assert_eq!(raw.len(), MAX_PAGE_TEXT_BYTES);
        assert_eq!(readable.len(), MAX_PAGE_TEXT_BYTES - 1);
        assert!(readable.starts_with("FAKE\néé"));
        assert!(raw.starts_with("FAKEéé"));
        assert!(readable.is_char_boundary(readable.len()));
    }

    #[test]
    fn draws_each_page_with_its_text() {
        let pdf = fixture("text-original.pdf");
        for index in 0..2 {
            let page = render(&pdf, "", index, 800).unwrap();
            assert_eq!(page.page_count, 2);
            assert_eq!(page.width, 800);
            assert!(
                page.height > page.width,
                "a letter page is taller than wide"
            );
            assert!(is_png(&page.png));
            let decoded = image::load_from_memory(&page.png).unwrap();
            assert_eq!(
                (decoded.width(), decoded.height()),
                (page.width, page.height)
            );
            assert!(
                decoded.to_rgba8().pixels().any(|pixel| {
                    pixel[3] > 0 && pixel.0[..3].iter().any(|channel| *channel < 245)
                }),
                "the rendered page must contain visible content"
            );
            assert!(page.text.contains("FAKE Hemoglobin"));
            assert!(page.text.contains(&format!("Page {} of 2", index + 1)));
        }
        for name in [
            "image-original.pdf",
            "form-original.pdf",
            "eform-original.pdf",
        ] {
            assert!(
                is_png(&render(&fixture(name), "", 0, 600).unwrap().png),
                "{name}"
            );
        }
    }

    #[test]
    fn opens_a_locked_document_with_its_password() {
        let locked = fixture("text-aes256.pdf");
        let page = render(&locked, PASSWORD, 1, 400).unwrap();
        assert_eq!(page.page_count, 2);
        assert!(page.text.contains("Page 2 of 2"));
        assert_eq!(
            render(&locked, "", 0, 400).unwrap_err(),
            Refusal::WrongPassword
        );
        assert_eq!(
            render(&locked, "FAKE-wrong", 0, 400).unwrap_err(),
            Refusal::WrongPassword
        );
    }

    #[test]
    fn keeps_the_picture_within_its_limits() {
        let pdf = fixture("text-original.pdf");
        assert_eq!(render(&pdf, "", 2, 400).unwrap_err(), Refusal::NoSuchPage);
        assert_eq!(
            render(&pdf, "", u32::MAX, 400).unwrap_err(),
            Refusal::NoSuchPage
        );
        let huge = render(&pdf, "", 0, u32::MAX).unwrap();
        assert!(huge.width <= MAX_SIDE && huge.height <= MAX_SIDE);
        assert_eq!(huge.height, MAX_SIDE, "a tall page is held by its height");
        let tiny = render(&pdf, "", 0, 0).unwrap();
        assert!(tiny.width >= 1);
        assert_eq!(
            render(&fixture("text-aes256-damaged.pdf"), PASSWORD, 0, 400).unwrap_err(),
            Refusal::Damaged
        );
        assert_eq!(
            render(b"%PDF-1.7 FAKE", "", 0, 400).unwrap_err(),
            Refusal::Damaged
        );
    }

    /// A header alone: it must never be accepted as a complete page picture.
    fn png_head(width: u32, height: u32) -> Vec<u8> {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        png.extend_from_slice(&width.to_be_bytes());
        png.extend_from_slice(&height.to_be_bytes());
        png.extend_from_slice(b"FAKE");
        png
    }

    fn png_image(width: u32, height: u32) -> Vec<u8> {
        let pixels = image::RgbaImage::from_pixel(width, height, image::Rgba([24, 48, 72, 255]));
        let mut png = Vec::new();
        pixels
            .write_to(&mut io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        png
    }

    fn response_with_png(png: Vec<u8>, width: u32, height: u32) -> Vec<u8> {
        let mut response = Vec::new();
        write_view_response(
            &mut response,
            &Ok(Page {
                page_count: 1,
                width,
                height,
                png,
                text: "FAKE page".into(),
                readable_text: "FAKE page".into(),
            }),
        )
        .unwrap();
        response
    }

    #[test]
    fn refuses_incomplete_or_corrupt_page_images() {
        let valid = png_image(10, 20);
        for png in [png_head(10, 20), valid[..40].to_vec()] {
            let response = response_with_png(png, 10, 20);
            assert!(read_view_response(&mut &response[..]).is_none());
        }
        // Oversized declared dimensions are refused before trying to decode any pixels.
        let response = response_with_png(png_head(MAX_SIDE + 1, MAX_SIDE), MAX_SIDE + 1, MAX_SIDE);
        assert!(read_view_response(&mut &response[..]).is_none());
    }

    #[test]
    fn returns_only_a_fresh_png_of_the_decoded_pixels() {
        let mut png = png_image(10, 20);
        let original = image::load_from_memory(&png).unwrap().to_rgba8();
        png.extend_from_slice(b"FAKE trailing data not part of the picture");
        let response = response_with_png(png, 10, 20);
        let page = read_view_response(&mut &response[..]).unwrap().unwrap();
        assert!(!page
            .png
            .ends_with(b"FAKE trailing data not part of the picture"));
        assert_eq!(
            image::load_from_memory(&page.png).unwrap().to_rgba8(),
            original
        );
    }

    #[test]
    fn refuses_an_oversized_password_before_writing_any_request() {
        let mut request = Vec::new();
        let password = "é".repeat(pdf_unlock::MAX_PASSWORD_BYTES / 2 + 1);
        assert!(write_view_request(&mut request, b"FAKE PDF", &password, 0, 300).is_err());
        assert!(request.is_empty());
        let password = "a".repeat(pdf_unlock::MAX_PASSWORD_BYTES);
        assert!(write_view_request(&mut request, b"FAKE PDF", &password, 0, 300).is_ok());
    }

    #[test]
    fn takes_only_a_png_of_the_size_declared() {
        assert!(png_of_size(&png_head(10, 20), 10, 20));
        assert!(!png_of_size(&png_head(10, 21), 10, 20));
        assert!(!png_of_size(b"GIF89a FAKE FAKE FAKE FAKE", 10, 20));
        assert!(!png_of_size(&png_head(10, 20)[..20], 10, 20));
        let page = render(&fixture("text-original.pdf"), "", 0, 300).unwrap();
        assert!(png_of_size(&page.png, page.width, page.height));
        let mut response = Vec::new();
        write_view_response(
            &mut response,
            &Ok(Page {
                png: png_head(11, 20),
                width: 10,
                height: 20,
                page_count: 1,
                text: String::new(),
                readable_text: String::new(),
            }),
        )
        .unwrap();
        assert!(read_view_response(&mut &response[..]).is_none());
    }

    #[test]
    fn a_newer_request_a_lock_or_closing_stops_a_page_being_drawn() {
        // Only what other tests in this binary cannot disturb: they may move the shared
        // counter on, never back.
        let older = ViewTicket::new();
        let newer = ViewTicket::new();
        assert!(!older.is_current());
        cancel_views();
        assert!(!newer.is_current());
        // A request already stopped never starts the helper.
        assert!(matches!(
            view_in_helper(&fixture("text-original.pdf"), "", 0, 300, &newer),
            Outcome::Cancelled
        ));
    }

    #[test]
    fn reader_protocol_refuses_oversized_or_invalid_second_text_and_old_responses() {
        let png = png_image(1, 1);
        let mut page = Page {
            page_count: 1,
            width: 1,
            height: 1,
            png: png.clone(),
            text: "FAKE".into(),
            readable_text: "FAKE\nfield".into(),
        };
        let mut response = Vec::new();
        write_view_response(
            &mut response,
            &Ok(Page {
                page_count: page.page_count,
                width: page.width,
                height: page.height,
                png: page.png.clone(),
                text: page.text.clone(),
                readable_text: page.readable_text.clone(),
            }),
        )
        .unwrap();
        let length_at = 9 + 12 + 8 + png.len() + 8 + page.text.len();
        let mut oversized = response[..length_at].to_vec();
        oversized.extend_from_slice(&((MAX_PAGE_TEXT_BYTES + 1) as u64).to_le_bytes());
        assert!(read_view_response(&mut oversized.as_slice()).is_none());
        let mut invalid = response.clone();
        *invalid.last_mut().unwrap() = 0xff;
        assert!(read_view_response(&mut invalid.as_slice()).is_none());
        response[..8].copy_from_slice(pdf_unlock::RESPONSE_MAGIC);
        assert!(read_view_response(&mut response.as_slice()).is_none());
        page.readable_text = "a".repeat(MAX_PAGE_TEXT_BYTES + 1);
        assert!(write_view_response(&mut Vec::new(), &Ok(page)).is_err());
    }

    #[test]
    fn the_page_protocol_carries_a_page_and_each_refusal() {
        let page = Page {
            page_count: 3,
            width: 10,
            height: 20,
            png: png_image(10, 20),
            text: "FAKE text é".to_owned(),
            readable_text: "FAKE\ntext é".to_owned(),
        };
        let mut response = Vec::new();
        write_view_response(&mut response, &Ok(page)).unwrap();
        let read = read_view_response(&mut &response[..]).unwrap().unwrap();
        assert_eq!(read.text, "FAKE text é");
        assert_eq!(read.readable_text, "FAKE\ntext é");
        assert_eq!((read.page_count, read.width, read.height), (3, 10, 20));
        assert!(read_view_response(&mut &response[..response.len() - 1]).is_none());
        let mut longer = response.clone();
        longer.push(0);
        assert!(read_view_response(&mut &longer[..]).is_none());
        for refusal in [
            Refusal::WrongPassword,
            Refusal::NoSuchPage,
            Refusal::Damaged,
        ] {
            let mut response = Vec::new();
            write_view_response(&mut response, &Err(refusal)).unwrap();
            assert_eq!(
                read_view_response(&mut &response[..]).unwrap(),
                Err(refusal)
            );
        }
        let mut request = Vec::new();
        write_view_request(&mut request, b"%PDF-1.7 FAKE", PASSWORD, 4, 900).unwrap();
        assert_eq!(&request[..8], VIEW_MAGIC);
        let mut body = &request[8..];
        let mut out = Vec::new();
        // A real request reaches the renderer: this one is too short to be a PDF.
        assert_eq!(answer(&mut body, &mut out), 0);
        assert_eq!(
            read_view_response(&mut &out[..]).unwrap(),
            Err(Refusal::Damaged)
        );
    }
}

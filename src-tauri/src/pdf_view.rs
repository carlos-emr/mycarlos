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

use crate::pdf_unlock::{self, Refusal, Request, RESPONSE_MAGIC};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(desktop)]
use zeroize::Zeroizing;

/// The latest page request; an older one still drawing is stopped.
static VIEW_GENERATION: AtomicU64 = AtomicU64::new(0);

/// One page request. It stays current until a newer request, a lock or the reader closing.
pub(crate) struct ViewTicket(u64);

impl ViewTicket {
    pub(crate) fn new() -> Self {
        Self(VIEW_GENERATION.fetch_add(1, Ordering::SeqCst) + 1)
    }

    pub(crate) fn is_current(&self) -> bool {
        VIEW_GENERATION.load(Ordering::SeqCst) == self.0
    }
}

/// Stops any page being drawn: when the vault locks and when the reader closes.
pub(crate) fn cancel_views() {
    VIEW_GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// The request that asks the helper for a page.
pub(crate) const VIEW_MAGIC: &[u8; 8] = b"MCPDFVW1";
/// The widest or tallest page picture, in pixels: larger asks are scaled down.
pub(crate) const MAX_SIDE: u32 = 4096;
/// The most page text sent back; longer text is cut, at a character boundary.
const MAX_PAGE_TEXT_BYTES: usize = 256 * 1024;
/// The largest picture taken back: a 4096 x 4096 page as PNG stays well below it.
const MAX_PNG_BYTES: usize = 96 * 1024 * 1024;

/// One page, as shown.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Page {
    pub(crate) page_count: u32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) png: Vec<u8>,
    pub(crate) text: String,
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
    Ok(Page {
        page_count,
        width,
        height,
        png,
        text: page_text(bytes, index),
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

#[cfg(any(desktop, test))]
fn write_view_request(
    out: &mut impl Write,
    pdf: &[u8],
    password: &str,
    index: u32,
    width: u32,
) -> io::Result<()> {
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
    out.write_all(RESPONSE_MAGIC)?;
    match result {
        Ok(page) => {
            out.write_all(&[0])?;
            for number in [page.page_count, page.width, page.height] {
                out.write_all(&number.to_le_bytes())?;
            }
            out.write_all(&(page.png.len() as u64).to_le_bytes())?;
            out.write_all(&page.png)?;
            out.write_all(&(page.text.len() as u64).to_le_bytes())?;
            out.write_all(page.text.as_bytes())?;
        }
        Err(refusal) => out.write_all(&[refusal.code()])?,
    }
    out.flush()
}

/// The helper's answer to a page request, or `None` when it is not one. The picture must be a
/// PNG of the size declared, so the webview is never handed anything else.
#[cfg(any(desktop, test))]
fn read_view_response(input: &mut impl Read) -> Option<Result<Page, Refusal>> {
    let mut head = [0u8; 9];
    input.read_exact(&mut head).ok()?;
    if &head[..8] != RESPONSE_MAGIC {
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
        let png = read_sized(input, MAX_PNG_BYTES)?;
        if !png_of_size(&png, width, height) {
            return None;
        }
        let text = String::from_utf8(read_sized(input, MAX_PAGE_TEXT_BYTES)?).ok()?;
        Ok(Page {
            page_count,
            width,
            height,
            png,
            text,
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
        if pdf.len() > pdf_unlock::MAX_LOCKED_PDF_BYTES {
            return Outcome::Refused(Refusal::TooLarge);
        }
        let Ok(executable) = std::env::current_exe() else {
            return Outcome::Failed;
        };
        let mut command = std::process::Command::new(executable);
        command.arg(pdf_unlock::HELPER_ARG);
        let mut request = Zeroizing::new(Vec::with_capacity(pdf.len() + password.len() + 28));
        if write_view_request(&mut *request, pdf, password, index, width).is_err() {
            return Outcome::Failed;
        }
        match pdf_unlock::exchange(
            command,
            request,
            pdf_unlock::HELPER_TIME_LIMIT,
            read_view_response,
            &|| !ticket.is_current(),
        ) {
            Some(Ok(page)) => Outcome::Shown(page),
            Some(Err(refusal)) => Outcome::Refused(refusal),
            None if !ticket.is_current() => Outcome::Cancelled,
            None => Outcome::Failed,
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

    /// The start of a PNG of `width` x `height`: enough for the parent's check.
    fn png_head(width: u32, height: u32) -> Vec<u8> {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        png.extend_from_slice(&width.to_be_bytes());
        png.extend_from_slice(&height.to_be_bytes());
        png.extend_from_slice(b"FAKE");
        png
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
    fn the_page_protocol_carries_a_page_and_each_refusal() {
        let page = Page {
            page_count: 3,
            width: 10,
            height: 20,
            png: png_head(10, 20),
            text: "FAKE text é".to_owned(),
        };
        let mut response = Vec::new();
        write_view_response(&mut response, &Ok(page)).unwrap();
        let read = read_view_response(&mut &response[..]).unwrap().unwrap();
        assert_eq!(read.text, "FAKE text é");
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

//! The PDF helper's pipe protocol for a page and for a quote's boxes, beyond what `pdf_view`'s own
//! tests reach (coverage batch 3).
//!
//! The parent never trusts what the confined helper writes back: the picture must be an RGBA8 PNG
//! of exactly the size declared and is encoded again from its pixels, every length has a limit,
//! a refusal or an absence code must be one the helper has, and nothing may follow the answer. And
//! the helper never trusts what the parent sends: a request that is short, has a bad password length
//! or a document claimed over the limit gets a refusal or a failed exit, never a guess. FAKE
//! documents only.

use super::*;

fn rgba_png(width: u32, height: u32) -> Vec<u8> {
    let picture = image::RgbaImage::from_pixel(width, height, image::Rgba([10, 20, 30, 255]));
    let mut bytes = Vec::new();
    picture
        .write_to(&mut io::Cursor::new(&mut bytes), image::ImageFormat::Png)
        .unwrap();
    bytes
}

fn rgb_png(width: u32, height: u32) -> Vec<u8> {
    let picture = image::RgbImage::from_pixel(width, height, image::Rgb([10, 20, 30]));
    let mut bytes = Vec::new();
    picture
        .write_to(&mut io::Cursor::new(&mut bytes), image::ImageFormat::Png)
        .unwrap();
    bytes
}

fn sized(bytes: &[u8]) -> Vec<u8> {
    let mut out = (bytes.len() as u64).to_le_bytes().to_vec();
    out.extend_from_slice(bytes);
    out
}

/// A page answer as the helper writes it, built by hand so that each field can be wrong.
fn page_answer(numbers: [u32; 3], png: &[u8], text: &[u8], readable: &[u8]) -> Vec<u8> {
    let mut out = VIEW_RESPONSE_MAGIC.to_vec();
    out.push(0);
    for number in numbers {
        out.extend_from_slice(&number.to_le_bytes());
    }
    out.extend_from_slice(&sized(png));
    out.extend_from_slice(&sized(text));
    out.extend_from_slice(&sized(readable));
    out
}

fn page_of(bytes: &[u8]) -> Option<Result<Page, Refusal>> {
    read_view_response(&mut &bytes[..])
}

#[test]
fn a_page_answer_is_read_back_exactly_and_only_in_its_one_good_form() {
    let png = rgba_png(2, 3);
    let good = page_answer([7, 2, 3], &png, b"plain text", b"readable text");
    let page = page_of(&good).unwrap().unwrap();
    assert_eq!((page.page_count, page.width, page.height), (7, 2, 3));
    assert_eq!(
        (page.text.as_str(), page.readable_text.as_str()),
        ("plain text", "readable text")
    );
    // The picture the webview gets is a PNG of its own, encoded from the decoded pixels.
    assert!(png_of_size(&page.png, 2, 3));
    // Nothing may follow the answer.
    let mut extra = good.clone();
    extra.push(0);
    assert!(page_of(&extra).is_none());
    // Cut anywhere, it is not an answer.
    for cut in [0, 5, 8, 9, 15, 21, good.len() - 1] {
        assert!(page_of(&good[..cut]).is_none(), "{cut}");
    }
    // A wrong magic.
    let mut wrong = good.clone();
    wrong[0] ^= 1;
    assert!(page_of(&wrong).is_none());
}

#[test]
fn a_page_answer_with_a_bad_size_picture_or_text_is_not_an_answer() {
    let png = rgba_png(2, 3);
    // A size of zero, or past the side limit, whatever the picture is.
    for numbers in [
        [1, 0, 3],
        [1, 2, 0],
        [1, MAX_SIDE + 1, 3],
        [1, 2, MAX_SIDE + 1],
    ] {
        assert!(
            page_of(&page_answer(numbers, &png, b"", b"")).is_none(),
            "{numbers:?}"
        );
    }
    // A picture of another size than declared, or in another colour format, or not a PNG at all.
    assert!(page_of(&page_answer([1, 3, 2], &png, b"", b"")).is_none());
    assert!(page_of(&page_answer([1, 2, 3], &rgb_png(2, 3), b"", b"")).is_none());
    assert!(page_of(&page_answer(
        [1, 2, 3],
        b"not a png at all, but long enough",
        b"",
        b""
    ))
    .is_none());
    assert!(page_of(&page_answer([1, 2, 3], &png[..png.len() / 2], b"", b"")).is_none());
    // Text that is not UTF-8, in either field.
    assert!(page_of(&page_answer([1, 2, 3], &png, &[0xff, 0xfe], b"")).is_none());
    assert!(page_of(&page_answer([1, 2, 3], &png, b"", &[0xc3])).is_none());
    // A length past the limit is refused before any of it is read.
    let mut over = VIEW_RESPONSE_MAGIC.to_vec();
    over.push(0);
    for number in [1_u32, 2, 3] {
        over.extend_from_slice(&number.to_le_bytes());
    }
    over.extend_from_slice(&((MAX_PNG_BYTES as u64) + 1).to_le_bytes());
    assert!(page_of(&over).is_none());
    let mut text_over = page_answer([1, 2, 3], &png, b"", b"");
    let at = text_over.len() - 16;
    text_over.truncate(at);
    text_over.extend_from_slice(&((MAX_PAGE_TEXT_BYTES as u64) + 1).to_le_bytes());
    assert!(page_of(&text_over).is_none());
}

#[test]
fn every_refusal_the_helper_has_is_read_back_and_no_other_code_is() {
    for code in 1..=6_u8 {
        let mut bytes = VIEW_RESPONSE_MAGIC.to_vec();
        bytes.push(code);
        match page_of(&bytes).unwrap() {
            Err(read) => assert_eq!(read, Refusal::from_code(code).unwrap(), "{code}"),
            Ok(_) => panic!("{code} is a refusal, not a page"),
        }
        assert_eq!(Refusal::from_code(code).unwrap().code(), code);
    }
    for code in [7_u8, 8, 100, 255] {
        let mut bytes = VIEW_RESPONSE_MAGIC.to_vec();
        bytes.push(code);
        assert!(page_of(&bytes).is_none(), "{code}");
        assert_eq!(Refusal::from_code(code), None);
    }
    assert_eq!(Refusal::from_code(0), None);
}

#[test]
fn the_helper_writes_what_the_parent_reads_and_refuses_to_write_an_oversized_field() {
    let page = Page {
        page_count: 4,
        width: 2,
        height: 3,
        png: rgba_png(2, 3),
        text: "FAKE text".to_owned(),
        readable_text: "FAKE readable".to_owned(),
    };
    let mut out = Vec::new();
    write_view_response(&mut out, &Ok(page)).unwrap();
    let back = page_of(&out).unwrap().unwrap();
    assert_eq!((back.page_count, back.text.as_str()), (4, "FAKE text"));
    // A refusal is the magic and its one code.
    let mut refused = Vec::new();
    write_view_response(&mut refused, &Err(Refusal::NoSuchPage)).unwrap();
    assert_eq!(refused, [VIEW_RESPONSE_MAGIC.as_slice(), &[6]].concat());
    // Text one byte over its limit is never written.
    for (text, readable) in [
        ("x".repeat(MAX_PAGE_TEXT_BYTES + 1), String::new()),
        (String::new(), "x".repeat(MAX_PAGE_TEXT_BYTES + 1)),
    ] {
        let big = Page {
            page_count: 1,
            width: 2,
            height: 3,
            png: rgba_png(2, 3),
            text,
            readable_text: readable,
        };
        let error = write_view_response(&mut Vec::new(), &Ok(big)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }
}

// ---- the helper's side: a request that cannot be answered ---------------------------------------

struct Closed;

impl Write for Closed {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        Err(io::Error::other("FAKE closed pipe"))
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn body(password: &[u8], pdf: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    pdf_unlock::write_password_and_pdf(&mut bytes, password, pdf).unwrap();
    bytes
}

/// A request body that claims a document past the limit and sends none of it.
fn claims_too_large() -> Vec<u8> {
    let mut bytes = 0_u32.to_le_bytes().to_vec();
    bytes.extend_from_slice(&((pdf_unlock::MAX_LOCKED_PDF_BYTES as u64) + 1).to_le_bytes());
    bytes
}

fn run_page(input: &[u8]) -> (i32, Vec<u8>) {
    let mut out = Vec::new();
    let code = answer(&mut &input[..], &mut out);
    (code, out)
}

fn run_boxes(input: &[u8]) -> (i32, Vec<u8>) {
    let mut out = Vec::new();
    let code = answer_boxes(&mut &input[..], &mut out);
    (code, out)
}

#[test]
fn a_page_request_that_is_short_malformed_or_too_large_is_answered_or_failed_as_it_deserves() {
    // Nothing, a password longer than allowed, a password that is not text.
    assert_eq!(run_page(&[]).0, 3);
    let long = vec![b'p'; pdf_unlock::MAX_PASSWORD_BYTES + 1];
    assert_eq!(run_page(&body(&long, b"")).0, 3);
    assert_eq!(run_page(&body(&[0xff, 0xfe], b"")).0, 3);
    // A request whose page numbers are missing.
    assert_eq!(run_page(&body(b"", b"%PDF-1.7 FAKE")).0, 3);
    // A document claimed over the limit is a refusal, written in full.
    let (code, out) = run_page(&claims_too_large());
    assert_eq!(code, 0);
    assert_eq!(
        out,
        [VIEW_RESPONSE_MAGIC.as_slice(), &[Refusal::TooLarge.code()]].concat()
    );
    // A document that is not a PDF is a refusal too, never a guess.
    let mut request = body(b"", b"this is not a pdf at all");
    request.extend_from_slice(&0_u32.to_le_bytes());
    request.extend_from_slice(&600_u32.to_le_bytes());
    let (code, out) = run_page(&request);
    assert_eq!(code, 0);
    assert_eq!(&out[..8], VIEW_RESPONSE_MAGIC);
    assert_eq!(out.len(), 9);
    assert!(Refusal::from_code(out[8]).is_some());
    // An answer that cannot be written is exit 4, and a request that cannot be read is 3.
    assert_eq!(answer(&mut &request[..], &mut Closed), 4);
}

#[test]
fn a_boxes_request_that_is_short_malformed_or_too_large_is_answered_or_failed_as_it_deserves() {
    assert_eq!(run_boxes(&[]).0, 3);
    let long = vec![b'p'; pdf_unlock::MAX_PASSWORD_BYTES + 1];
    assert_eq!(run_boxes(&body(&long, b"")).0, 3);
    // Numbers missing, then the quoted text missing, then not UTF-8, then too long.
    assert_eq!(run_boxes(&body(b"", b"%PDF-1.7 FAKE")).0, 3);
    let numbers = |request: &mut Vec<u8>| {
        for number in [0_u32, 0, 1] {
            request.extend_from_slice(&number.to_le_bytes());
        }
    };
    let mut no_text = body(b"", b"%PDF-1.7 FAKE");
    numbers(&mut no_text);
    assert_eq!(run_boxes(&no_text).0, 3);
    let mut bad_text = body(b"", b"%PDF-1.7 FAKE");
    numbers(&mut bad_text);
    bad_text.extend_from_slice(&sized(&[0xff, 0xfe]));
    assert_eq!(run_boxes(&bad_text).0, 3);
    let mut long_text = body(b"", b"%PDF-1.7 FAKE");
    numbers(&mut long_text);
    long_text.extend_from_slice(&((page_boxes::MAX_SPAN_TEXT_BYTES as u64) + 1).to_le_bytes());
    assert_eq!(run_boxes(&long_text).0, 3);
    // A document claimed over the limit.
    let (code, out) = run_boxes(&claims_too_large());
    assert_eq!(code, 0);
    assert_eq!(
        out,
        [BOXES_RESPONSE_MAGIC.as_slice(), &[Refusal::TooLarge.code()]].concat()
    );
    // Something that is not a PDF is a refusal, and a closed pipe is exit 4.
    let mut garbage = body(b"", b"this is not a pdf at all");
    numbers(&mut garbage);
    garbage.extend_from_slice(&sized(b"quote"));
    let (code, out) = run_boxes(&garbage);
    assert_eq!(code, 0);
    assert_eq!(&out[..8], BOXES_RESPONSE_MAGIC);
    assert_eq!(answer_boxes(&mut &garbage[..], &mut Closed), 4);
}

// ---- the boxes answer --------------------------------------------------------------------------

fn boxes_of(bytes: &[u8]) -> Option<BoxesOutcome> {
    read_boxes_response(&mut &bytes[..])
}

fn found(count: u32, rects: &[[u16; 4]]) -> Vec<u8> {
    let mut out = BOXES_RESPONSE_MAGIC.to_vec();
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&count.to_le_bytes());
    for rect in rects {
        for side in rect {
            out.extend_from_slice(&side.to_le_bytes());
        }
    }
    out
}

#[test]
fn a_boxes_answer_is_read_back_and_only_with_whole_non_empty_rectangles_within_the_limit() {
    let rects = [[10, 20, 30, 40], [0, 0, 1, 1]];
    let Some(BoxesOutcome::Found(read)) = boxes_of(&found(2, &rects)) else {
        panic!("a good answer is read");
    };
    assert_eq!(read, rects);
    // Zero rectangles, more than the limit, a count the bytes do not hold.
    assert!(boxes_of(&found(0, &[])).is_none());
    assert!(boxes_of(&found(page_boxes::MAX_LINES as u32 + 1, &[])).is_none());
    assert!(boxes_of(&found(3, &rects)).is_none());
    // The most is allowed.
    let full = vec![[1, 1, 2, 2]; page_boxes::MAX_LINES];
    let Some(BoxesOutcome::Found(read)) = boxes_of(&found(page_boxes::MAX_LINES as u32, &full))
    else {
        panic!("the limit itself is read");
    };
    assert_eq!(read.len(), page_boxes::MAX_LINES);
    // An empty or inverted rectangle in either direction.
    for bad in [[5, 5, 5, 9], [5, 5, 9, 5], [9, 5, 5, 9], [5, 9, 9, 5]] {
        assert!(boxes_of(&found(1, &[bad])).is_none(), "{bad:?}");
    }
    // Nothing may follow, and a cut answer is not one.
    let mut extra = found(1, &[[1, 1, 2, 2]]);
    extra.push(0);
    assert!(boxes_of(&extra).is_none());
    let good = found(2, &rects);
    for cut in [0, 7, 8, 9, 10, 13, good.len() - 1] {
        assert!(boxes_of(&good[..cut]).is_none(), "{cut}");
    }
    let mut wrong = good.clone();
    wrong[7] ^= 1;
    assert!(boxes_of(&wrong).is_none());
}

#[test]
fn a_boxes_answer_names_only_an_absence_or_a_refusal_the_helper_has() {
    for code in 1..=8_u8 {
        let mut bytes = BOXES_RESPONSE_MAGIC.to_vec();
        bytes.extend_from_slice(&[0, code]);
        let Some(BoxesOutcome::Absent(reason)) = boxes_of(&bytes) else {
            panic!("absence {code}");
        };
        assert_eq!(reason.code(), code);
    }
    for code in [9_u8, 10, 255] {
        let mut bytes = BOXES_RESPONSE_MAGIC.to_vec();
        bytes.extend_from_slice(&[0, code]);
        assert!(boxes_of(&bytes).is_none(), "{code}");
    }
    for code in 1..=6_u8 {
        let mut bytes = BOXES_RESPONSE_MAGIC.to_vec();
        bytes.push(code);
        assert!(
            matches!(boxes_of(&bytes), Some(BoxesOutcome::Refused(_))),
            "{code}"
        );
    }
    for code in [7_u8, 200] {
        let mut bytes = BOXES_RESPONSE_MAGIC.to_vec();
        bytes.push(code);
        assert!(boxes_of(&bytes).is_none(), "{code}");
    }
}

#[test]
fn the_helper_writes_boxes_the_parent_reads_and_never_an_empty_or_oversized_list() {
    let rects = vec![[1_u16, 2, 3, 4], [5, 6, 7, 8]];
    let mut out = Vec::new();
    write_boxes_response(&mut out, &Ok(Ok(rects.clone()))).unwrap();
    let Some(BoxesOutcome::Found(read)) = boxes_of(&out) else {
        panic!("written boxes are read");
    };
    assert_eq!(read, rects);
    let mut absent = Vec::new();
    write_boxes_response(&mut absent, &Ok(Err(page_boxes::Absent::Skewed))).unwrap();
    assert!(matches!(
        boxes_of(&absent),
        Some(BoxesOutcome::Absent(page_boxes::Absent::Skewed))
    ));
    let mut refused = Vec::new();
    write_boxes_response(&mut refused, &Err(Refusal::Damaged)).unwrap();
    assert!(matches!(
        boxes_of(&refused),
        Some(BoxesOutcome::Refused(Refusal::Damaged))
    ));
    for bad in [
        Vec::new(),
        vec![[1_u16, 1, 2, 2]; page_boxes::MAX_LINES + 1],
    ] {
        let error = write_boxes_response(&mut Vec::new(), &Ok(Ok(bad))).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }
}

#[test]
fn a_request_with_a_password_or_a_quote_over_the_limit_is_never_written() {
    let mut out = Vec::new();
    let long = "p".repeat(pdf_unlock::MAX_PASSWORD_BYTES + 1);
    assert_eq!(
        write_view_request(&mut out, b"%PDF", &long, 0, 100)
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidInput
    );
    let quote = "q".repeat(page_boxes::MAX_SPAN_TEXT_BYTES + 1);
    assert_eq!(
        write_boxes_request(&mut out, b"%PDF", "", 0, 0, 1, &quote)
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidInput
    );
    assert_eq!(
        write_boxes_request(&mut out, b"%PDF", &long, 0, 0, 1, "q")
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidInput
    );
    assert!(out.is_empty(), "nothing was written before the refusal");
}

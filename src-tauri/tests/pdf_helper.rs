//! The real myCarlos executable, started as the PDF unlock helper (src/pdf_unlock.rs), answers
//! one request on stdin and exits. This drives it the way the app does, byte for byte.

use std::io::{Read, Write};
use std::process::{Command, Stdio};

const HELPER_ARG: &str = "--mycarlos-pdf-helper";
const PASSWORD: &str = "FAKE-portal-2026";

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/locked-pdf")
            .join(name),
    )
    .unwrap()
}

/// Sends one request; returns the exit code and what came back.
fn ask(request: &[u8]) -> (Option<i32>, Vec<u8>) {
    let mut helper = Command::new(env!("CARGO_BIN_EXE_mycarlos-tauri-poc"))
        .arg(HELPER_ARG)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = helper.stdin.take().unwrap();
    let request = request.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&request);
    });
    let mut answer = Vec::new();
    helper
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut answer)
        .unwrap();
    writer.join().unwrap();
    (helper.wait().unwrap().code(), answer)
}

fn request(password: &str, pdf: &[u8]) -> Vec<u8> {
    let mut request = b"MCPDFRQ1".to_vec();
    request.extend_from_slice(&(password.len() as u32).to_le_bytes());
    request.extend_from_slice(password.as_bytes());
    request.extend_from_slice(&(pdf.len() as u64).to_le_bytes());
    request.extend_from_slice(pdf);
    request
}

#[test]
fn the_helper_unlocks_a_document_and_names_a_wrong_password() {
    let (code, answer) = ask(&request(PASSWORD, &fixture("text-aes256.pdf")));
    assert_eq!(code, Some(0));
    assert_eq!(&answer[..9], b"MCPDFRS1\0");
    let length = u64::from_le_bytes(answer[9..17].try_into().unwrap()) as usize;
    let unlocked = &answer[17..];
    assert_eq!(unlocked.len(), length);
    let document = lopdf::Document::load_mem(unlocked).unwrap();
    assert!(!document.is_encrypted());
    assert!(!unlocked.windows(8).any(|window| window == b"/Encrypt"));

    let (code, answer) = ask(&request("FAKE-wrong", &fixture("text-aes256.pdf")));
    assert_eq!(code, Some(0));
    assert_eq!(answer, b"MCPDFRS1\x01\0\0\0\0\0\0\0\0");
}

#[test]
fn the_helper_answers_nothing_to_a_request_it_cannot_read() {
    let (code, answer) = ask(b"not a request");
    assert_ne!(code, Some(0));
    assert!(answer.is_empty());
}

#[test]
fn the_helper_draws_a_page_of_a_locked_document() {
    let mut view = b"MCPDFVW1".to_vec();
    view.extend_from_slice(&request(PASSWORD, &fixture("text-aes256.pdf"))[8..]);
    view.extend_from_slice(&1u32.to_le_bytes());
    view.extend_from_slice(&500u32.to_le_bytes());
    let (code, answer) = ask(&view);
    assert_eq!(code, Some(0));
    assert_eq!(&answer[..9], b"MCPDFRS1\0");
    let number = |at: usize| u32::from_le_bytes(answer[at..at + 4].try_into().unwrap());
    assert_eq!((number(9), number(13)), (2, 500), "2 pages, drawn 500 wide");
    let png_length = u64::from_le_bytes(answer[21..29].try_into().unwrap()) as usize;
    let png = &answer[29..29 + png_length];
    assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
    let text = &answer[29 + png_length + 8..];
    assert!(String::from_utf8_lossy(text).contains("Page 2 of 2"));
}

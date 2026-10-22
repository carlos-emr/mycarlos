//! The real myCarlos executable, started as the PDF unlock helper (src/pdf_unlock.rs), answers
//! one request on stdin and exits. This drives it the way the app does, byte for byte: started by
//! myCarlos's own code, so sandboxed as in the app (on Windows, in its AppContainer).

const PASSWORD: &str = "FAKE-portal-2026";

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/locked-pdf")
            .join(name),
    )
    .unwrap()
}

/// The executable, which AppContainers may read and run on Windows, as the installer allows.
fn executable() -> &'static std::path::Path {
    let executable = std::path::Path::new(env!("CARGO_BIN_EXE_mycarlos-tauri-poc"));
    #[cfg(windows)]
    for path in [executable, executable.parent().unwrap()] {
        let status = std::process::Command::new("icacls")
            .arg(path)
            .args(["/grant", "*S-1-15-2-1:(RX)"])
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "{}", path.display());
    }
    executable
}

/// Sends one request; returns the exit code and what came back.
fn ask(request: &[u8]) -> (Option<i32>, Vec<u8>) {
    mycarlos_tauri_poc_lib::pdf_ask_helper_at(executable(), request)
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
fn the_confined_signature_helper_reports_structure_and_exact_plain_and_encrypted_manifests() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let fixture: serde_json::Value =
        serde_json::from_slice(include_bytes!("fixtures/mycarlos-signed-pdf-fixtures.json"))
            .unwrap();
    for name in ["signed-send-to-mycarlos.pdf", "signed-email-encrypted.pdf"] {
        let document = fixture["documents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|document| document["name"].as_str() == Some(name))
            .unwrap();
        let pdf = STANDARD
            .decode(document["pdf_b64"].as_str().unwrap())
            .unwrap();
        for stage in [0, 1] {
            let password = if stage == 1 {
                document["password"].as_str().unwrap_or("")
            } else {
                ""
            };
            let mut message = b"MCPDFSG1".to_vec();
            message.push(stage);
            message.extend_from_slice(&(password.len() as u32).to_le_bytes());
            message.extend_from_slice(password.as_bytes());
            message.extend_from_slice(&(pdf.len() as u64).to_le_bytes());
            message.extend_from_slice(&pdf);
            let (code, answer) = ask(&message);
            assert_eq!(code, Some(0), "{name} stage {stage}");
            assert_eq!(&answer[..8], b"MCPDFSA1");
            let size = u32::from_le_bytes(answer[8..12].try_into().unwrap()) as usize;
            assert!(size <= 128 * 1024);
            assert_eq!(answer.len(), size + 12);
            let response: serde_json::Value = serde_json::from_slice(&answer[12..]).unwrap();
            let report = response
                .get("Ok")
                .unwrap_or_else(|| panic!("helper refused {name} stage {stage}"));
            assert_eq!(report["layout"]["byte_ranges"], document["byte_ranges"]);
            if stage == 0 {
                assert!(report["manifest"].is_null());
            } else {
                let bytes: Vec<u8> = serde_json::from_value(report["manifest"].clone()).unwrap();
                assert_eq!(
                    bytes,
                    STANDARD
                        .decode(document["manifest_bytes_b64"].as_str().unwrap())
                        .unwrap()
                );
            }
        }
    }
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

/// Started as myCarlos starts it: limited before and after it starts (on Windows, the job
/// object), its memory watched (on macOS), and the request and answer handled by myCarlos's own
/// code.
#[test]
fn mycarlos_starts_the_helper_and_takes_its_answer() {
    let executable = executable();
    let locked = fixture("text-aes256.pdf");
    let unlocked =
        mycarlos_tauri_poc_lib::pdf_unlock_with_helper_at(executable, &locked, PASSWORD).unwrap();
    assert!(!lopdf::Document::load_mem(&unlocked).unwrap().is_encrypted());
    assert_eq!(
        mycarlos_tauri_poc_lib::pdf_unlock_with_helper_at(executable, &locked, "FAKE-wrong"),
        Err("WrongPassword".to_owned())
    );
}

#[test]
fn the_helper_answers_nothing_to_a_request_it_cannot_read() {
    let (code, answer) = ask(b"not a request");
    assert_ne!(code, Some(0));
    assert!(answer.is_empty());
}

/// On Windows the helper is sandboxed only when myCarlos starts it in its AppContainer. Started
/// any other way, it reads nothing and says why with its exit code.
#[cfg(windows)]
#[test]
fn the_helper_started_outside_its_app_container_reads_nothing() {
    use std::io::Write;
    let mut helper = std::process::Command::new(executable())
        .arg(mycarlos_tauri_poc_lib::PDF_HELPER_ARG)
        .env_clear()
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let _ = helper
        .stdin
        .take()
        .unwrap()
        .write_all(&request(PASSWORD, &fixture("text-aes256.pdf")));
    let output = helper.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
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
    let decoded = image::load_from_memory(png).unwrap().to_rgba8();
    assert_eq!((decoded.width(), decoded.height()), (500, number(17)));
    assert!(
        decoded
            .pixels()
            .any(|pixel| { pixel[3] > 0 && pixel.0[..3].iter().any(|channel| *channel < 245) }),
        "the real helper must draw visible page content"
    );
    let text = &answer[29 + png_length + 8..];
    assert!(String::from_utf8_lossy(text).contains("Page 2 of 2"));
}

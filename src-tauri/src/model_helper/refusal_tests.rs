//! What the helper's stream and exit codes promise to the program that starts it (coverage batch
//! 2): the first line it writes, a write that fails, a request line it refuses to read, and the
//! exit codes the parent tells apart. FAKE model names and hashes only.

use super::*;
use std::io;

#[test]
fn the_exit_codes_are_the_ones_the_parent_tells_apart_and_none_is_success() {
    let codes = [
        ("NO_SANDBOX", exit::NO_SANDBOX, 2),
        ("INPUT", exit::INPUT, 3),
        ("OUTPUT", exit::OUTPUT, 4),
        ("UNSUPPORTED_CPU", exit::UNSUPPORTED_CPU, 5),
        ("UNSUPPORTED_PLATFORM", exit::UNSUPPORTED_PLATFORM, 6),
        ("NO_MODEL", exit::NO_MODEL, 7),
        ("ARGUMENTS", exit::ARGUMENTS, 64),
    ];
    for (name, code, expected) in codes {
        assert_eq!(code, expected, "{name}");
    }
    let mut seen: Vec<i32> = codes.iter().map(|(_, code, _)| *code).collect();
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(seen.len(), codes.len(), "every failure has its own code");
    assert!(!seen.contains(&0), "0 is a clean end");
}

#[test]
fn the_first_line_names_the_contract_and_the_model_and_carries_the_card_only_when_there_is_one() {
    let sha = "0".repeat(64);
    let bare: serde_json::Value =
        serde_json::from_str(&hello_line("fake-model", &sha, None)).unwrap();
    assert_eq!(bare["hello"], CONTRACT);
    assert_eq!(bare["model"]["name"], "fake-model");
    assert_eq!(bare["model"]["sha256"], sha);
    assert!(
        bare.get("card").is_none(),
        "no card was read, none is claimed"
    );

    let card = crate::model_limits::ModelCard {
        architecture: "fake-arch".to_owned(),
        trained_context: 8_192,
        context_made: 4_096,
        parameters: 1_000_000_000,
        layers: 24,
        vocabulary: 32_000,
        recurrent: false,
        hybrid: false,
        kv_bytes_per_token: 0,
        weights_bytes: 0,
    };
    let with: serde_json::Value =
        serde_json::from_str(&hello_line("fake-model", &sha, Some(&card))).unwrap();
    assert_eq!(with["card"]["architecture"], "fake-arch");
    assert_eq!(with["card"]["contextMade"], 4_096);
    // One line: the parent reads the greeting a line at a time.
    assert!(!hello_line("fake-model", &sha, Some(&card)).contains('\n'));
}

struct Refusing {
    fail_write: bool,
    fail_flush: bool,
    written: Vec<u8>,
}

impl io::Write for Refusing {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.fail_write {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "FAKE closed"));
        }
        self.written.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        if self.fail_flush {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "FAKE closed"))
        } else {
            Ok(())
        }
    }
}

#[test]
fn a_line_is_sent_whole_with_its_newline_and_a_failure_to_write_or_flush_says_so() {
    let mut output = Refusing {
        fail_write: false,
        fail_flush: false,
        written: Vec::new(),
    };
    assert!(send(&mut output, "{\"id\":1}"));
    assert_eq!(output.written, b"{\"id\":1}\n");

    let mut closed = Refusing {
        fail_write: true,
        fail_flush: false,
        written: Vec::new(),
    };
    assert!(!send(&mut closed, "{}"));
    assert!(closed.written.is_empty());

    // The text went out but could not be flushed: the parent may not have it, so it is a failure.
    let mut stuck = Refusing {
        fail_write: false,
        fail_flush: true,
        written: Vec::new(),
    };
    assert!(!send(&mut stuck, "{}"));
}

#[test]
fn a_request_line_is_text_of_at_most_the_limit_and_ends_at_its_newline() {
    // The last line needs no newline; an empty line is a line, not the end.
    assert_eq!(next_line(&mut &b"{}"[..]).as_deref(), Some("{}"));
    assert_eq!(next_line(&mut &b"\n{}\n"[..]).as_deref(), Some(""));
    // Only the newline is dropped.
    assert_eq!(next_line(&mut &b"{}\r\n"[..]).as_deref(), Some("{}\r"));
    // Not UTF-8: refused, so the helper ends rather than guess.
    assert_eq!(next_line(&mut &[0xff, 0xfe, b'\n'][..]), None);
    // Exactly the limit, with or without the newline, is read; one more is not.
    let exact = vec![b'x'; MAX_REQUEST_BYTES - 1];
    let mut with_newline = exact.clone();
    with_newline.push(b'\n');
    assert_eq!(
        next_line(&mut with_newline.as_slice()).map(|line| line.len()),
        Some(MAX_REQUEST_BYTES - 1)
    );
    let full = vec![b'x'; MAX_REQUEST_BYTES];
    assert_eq!(
        next_line(&mut full.as_slice()).map(|line| line.len()),
        Some(MAX_REQUEST_BYTES)
    );
    let mut over = full;
    over.push(b'x');
    assert_eq!(next_line(&mut over.as_slice()), None);
}

//! A vault format number is never reused, skipped or left undocumented.
//!
//! VAULT_FORMAT.md, "Format numbers are taken at merge": each branch takes main's next number when
//! it merges, with no gap, and sets `VAULT_FORMAT`, its section heading and its gates to it. Two
//! open branches that each took "the next number" before either merged would both say 14; the
//! second one to merge then textually merges cleanly and gates its fields at the wrong number
//! (#418 and #448 did exactly that against main's 14 to 16). This reads `src/vault.rs` and
//! `VAULT_FORMAT.md` and fails loudly instead:
//!
//! - no two `MANIFEST_FORMAT_*` constants share a value;
//! - `VAULT_FORMAT` is the highest of them;
//! - the document's "Format N" headings name each number once, in increasing order, with no gap;
//! - the highest heading is `VAULT_FORMAT`, and every constant from the first heading's number up
//!   has a heading.
//!
//! The checks work on text, so the tests below feed them made-up files to show each one fires.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The number a `const` line is set to: the text after `=`, without a trailing `// comment` and the
/// `;`, as a Rust integer literal (underscores allowed: `1_4` is 14).
fn number_in(after_equals: &str) -> Option<u32> {
    let text = after_equals
        .split("//")
        .next()?
        .trim()
        .trim_end_matches(';')
        .trim();
    text.replace('_', "").parse().ok()
}

/// Whether only a visibility stands before `const`: nothing, `pub`, or `pub(crate)`, `pub(super)`,
/// `pub(in path)`.
fn only_visibility(before: &str) -> bool {
    let before = before.trim();
    before.is_empty() || before == "pub" || (before.starts_with("pub(") && before.ends_with(')'))
}

/// Every line that names a `MANIFEST_FORMAT_*` constant: those read as (name, value), and the text of
/// each one that could not be read. A line that names a constant and is not understood is never
/// skipped (its number would go unchecked): it is returned so that the checks can fail with it.
fn format_constants(source: &str) -> (Vec<(String, u32)>, Vec<String>) {
    let mut constants = Vec::new();
    let mut unreadable = Vec::new();
    for line in source.lines() {
        let trimmed = line.trim_start();
        // A comment that mentions a constant is not one.
        if trimmed.starts_with("//") {
            continue;
        }
        let Some(at) = trimmed.find("const MANIFEST_FORMAT_") else {
            continue;
        };
        let read = || {
            if !only_visibility(&trimmed[..at]) {
                return None;
            }
            let (name, tail) = trimmed[at + "const ".len()..].split_once(':')?;
            let after_equals = tail
                .trim_start()
                .strip_prefix("u32")?
                .trim_start()
                .strip_prefix('=')?;
            Some((name.trim().to_owned(), number_in(after_equals)?))
        };
        match read() {
            Some(constant) => constants.push(constant),
            None => unreadable.push(line.trim().to_owned()),
        }
    }
    (constants, unreadable)
}

/// What `const VAULT_FORMAT: u32 = ...;` is set to: a number, or the constant it names.
fn vault_format(source: &str, constants: &[(String, u32)]) -> Option<u32> {
    let line = source.lines().find(|line| {
        let trimmed = line.trim_start();
        !trimmed.starts_with("//") && trimmed.contains("const VAULT_FORMAT: u32")
    })?;
    let after_equals = line.split_once('=')?.1;
    number_in(after_equals).or_else(|| {
        let name = after_equals
            .split("//")
            .next()?
            .trim()
            .trim_end_matches(';')
            .trim();
        constants
            .iter()
            .find(|(constant, _)| constant == name)
            .map(|(_, value)| *value)
    })
}

/// The numbers of the headings written "Format N" (`## Format 14 (provisional): ...`,
/// `#### Format 9: ...`), in document order.
fn headings(document: &str) -> Vec<u32> {
    document
        .lines()
        .filter(|line| line.starts_with('#'))
        .filter_map(|line| {
            let title = line.trim_start_matches('#').trim_start();
            let digits: String = title
                .strip_prefix("Format ")?
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            digits.parse().ok()
        })
        .collect()
}

/// The first "Format N" heading of VAULT_FORMAT.md. Formats 1 to 5 are written as "Manifest format N"
/// sections, so the numbered "Format N" headings start here; losing the lowest one would otherwise
/// move the start of the range and go unnoticed.
const FIRST_FORMAT_HEADING: u32 = 6;

/// Everything wrong with the pair of files, one sentence each; empty when they agree.
/// `first_heading` is the number the document's first "Format N" heading must have.
fn problems_from(source: &str, document: &str, first_heading: u32) -> Vec<String> {
    let mut found = Vec::new();
    let (constants, unreadable) = format_constants(source);
    for line in &unreadable {
        found.push(format!(
            "a MANIFEST_FORMAT_ constant this test cannot read, so its number is unchecked: {line}"
        ));
    }
    if constants.is_empty() {
        found.push("no MANIFEST_FORMAT_* constants were found in src/vault.rs".to_owned());
    }
    let mut seen: Vec<(u32, &str)> = Vec::new();
    for (name, value) in &constants {
        if let Some((_, other)) = seen.iter().find(|(seen_value, _)| seen_value == value) {
            found.push(format!(
                "{name} and {other} are both format {value}: a format number is never reused"
            ));
        }
        seen.push((*value, name));
    }
    let highest_constant = constants.iter().map(|(_, value)| *value).max();
    let current = vault_format(source, &constants);
    if current.is_none() || current != highest_constant {
        found.push(format!(
            "VAULT_FORMAT is {current:?} but the highest MANIFEST_FORMAT_* is {highest_constant:?}"
        ));
    }

    let numbers = headings(document);
    let mut documented = BTreeSet::new();
    for number in &numbers {
        if !documented.insert(*number) {
            found.push(format!(
                "VAULT_FORMAT.md has more than one \"Format {number}\" heading"
            ));
        }
    }
    if numbers.windows(2).any(|pair| pair[1] <= pair[0]) {
        found.push(format!(
            "VAULT_FORMAT.md's \"Format N\" headings are not in increasing order: {numbers:?}"
        ));
    }
    if let (Some(first), Some(last)) = (documented.first(), documented.last()) {
        if *first != first_heading {
            found.push(format!(
                "the lowest \"Format N\" heading is {first}, expected {first_heading}: a heading was \
                 removed or renumbered"
            ));
        }
        for missing in (*first..=*last).filter(|n| !documented.contains(n)) {
            found.push(format!(
                "VAULT_FORMAT.md has no \"Format {missing}\" heading between {first} and {last}"
            ));
        }
        if current != Some(*last) {
            found.push(format!(
                "the last \"Format N\" heading is {last} but VAULT_FORMAT is {current:?}"
            ));
        }
        for (name, value) in &constants {
            if value >= first && !documented.contains(value) {
                found.push(format!(
                    "{name} is format {value} but VAULT_FORMAT.md has no \"Format {value}\" heading"
                ));
            }
        }
    } else {
        found.push("VAULT_FORMAT.md has no \"Format N\" headings".to_owned());
    }
    found
}

#[test]
fn the_format_numbers_in_the_code_and_the_document_agree_and_are_never_reused() {
    let source = fs::read_to_string(manifest_dir().join("src/vault.rs")).unwrap();
    let document = fs::read_to_string(manifest_dir().join("../VAULT_FORMAT.md")).unwrap();
    assert_eq!(
        problems_from(&source, &document, FIRST_FORMAT_HEADING),
        Vec::<String>::new()
    );
    // Not vacuous: the files really hold the numbers this reads.
    let (constants, _) = format_constants(&source);
    assert!(constants.len() >= 10, "{constants:?}");
    assert!(headings(&document).len() >= 10, "{:?}", headings(&document));
}

/// The made-up files below start their numbered headings at 12.
fn problems(source: &str, document: &str) -> Vec<String> {
    problems_from(source, document, 12)
}

const GOOD_SOURCE: &str = "\
const MANIFEST_FORMAT_ALPHA: u32 = 12;
/// A comment.
const MANIFEST_FORMAT_BETA: u32 = 13;
const MANIFEST_FORMAT_GAMMA: u32 = 14;
const VAULT_FORMAT: u32 = MANIFEST_FORMAT_GAMMA;
";
const GOOD_DOCUMENT: &str = "\
# Durable vault format v1
#### Format 12: alpha
## Format 13: beta
## Format 14 (provisional): gamma
## Something else
";

#[test]
fn consistent_files_have_no_problems() {
    assert_eq!(problems(GOOD_SOURCE, GOOD_DOCUMENT), Vec::<String>::new());
}

#[test]
fn two_constants_with_one_number_are_refused() {
    // What #448 did: its link fields gate at 14 while main's handover is already 14.
    let source = GOOD_SOURCE.replace("BETA: u32 = 13", "BETA: u32 = 14");
    let found = problems(&source, GOOD_DOCUMENT);
    assert!(
        found.iter().any(|line| line.contains("are both format 14")),
        "{found:?}"
    );
}

#[test]
fn a_vault_format_below_the_highest_constant_is_refused() {
    let source = GOOD_SOURCE.replace("= MANIFEST_FORMAT_GAMMA;", "= MANIFEST_FORMAT_BETA;");
    let found = problems(&source, GOOD_DOCUMENT);
    assert!(
        found.iter().any(|line| line.contains("VAULT_FORMAT is")),
        "{found:?}"
    );
}

#[test]
fn a_number_documented_twice_is_refused() {
    let document = format!("{GOOD_DOCUMENT}## Format 14: a second gamma\n");
    let found = problems(GOOD_SOURCE, &document);
    assert!(
        found
            .iter()
            .any(|line| line.contains("more than one \"Format 14\"")),
        "{found:?}"
    );
}

#[test]
fn a_gap_between_documented_numbers_is_refused() {
    let document = GOOD_DOCUMENT.replace("## Format 13: beta\n", "");
    let found = problems(GOOD_SOURCE, &document);
    assert!(
        found
            .iter()
            .any(|line| line.contains("no \"Format 13\" heading between 12 and 14")),
        "{found:?}"
    );
    // The constant for 13 is also undocumented.
    assert!(
        found.iter().any(|line| line.contains("BETA is format 13")),
        "{found:?}"
    );
}

#[test]
fn headings_out_of_order_are_refused() {
    let document = "#### Format 13: beta\n#### Format 12: alpha\n#### Format 14: gamma\n";
    let found = problems(GOOD_SOURCE, document);
    assert!(
        found
            .iter()
            .any(|line| line.contains("not in increasing order")),
        "{found:?}"
    );
}

#[test]
fn a_last_heading_that_is_not_the_current_format_is_refused() {
    let document = format!("{GOOD_DOCUMENT}## Format 15: documented but not yet in the code\n");
    let found = problems(GOOD_SOURCE, &document);
    assert!(
        found
            .iter()
            .any(|line| line.contains("last \"Format N\" heading is 15")),
        "{found:?}"
    );
}

#[test]
fn only_headings_that_say_format_and_a_number_count() {
    let document = "## Formatting 14\n### Manifest format 4: x\n#### Format-5 custody\ntext Format 99\n#### Format 7: ok\n";
    assert_eq!(headings(document), vec![7]);
}

/// A second constant at 14 written in a form a plain `= 14;` match would not read.
fn with_second_constant_at_14(line: &str) -> Vec<String> {
    let source = GOOD_SOURCE.replace("const MANIFEST_FORMAT_BETA: u32 = 13;", line);
    problems(&source, GOOD_DOCUMENT)
}

#[test]
fn a_duplicate_written_with_a_trailing_comment_is_still_refused() {
    let found = with_second_constant_at_14("const MANIFEST_FORMAT_BETA: u32 = 14; // provisional");
    assert!(
        found.iter().any(|line| line.contains("are both format 14")),
        "{found:?}"
    );
}

#[test]
fn a_duplicate_written_with_an_underscore_is_still_refused() {
    let found = with_second_constant_at_14("const MANIFEST_FORMAT_BETA: u32 = 1_4;");
    assert!(
        found.iter().any(|line| line.contains("are both format 14")),
        "{found:?}"
    );
}

#[test]
fn a_duplicate_with_a_narrower_visibility_is_still_refused() {
    for visibility in ["pub", "pub(crate)", "pub(super)", "pub(in crate::vault)"] {
        let found = with_second_constant_at_14(&format!(
            "{visibility} const MANIFEST_FORMAT_BETA: u32 = 14;"
        ));
        assert!(
            found.iter().any(|line| line.contains("are both format 14")),
            "{visibility}: {found:?}"
        );
    }
}

#[test]
fn a_constant_line_this_test_cannot_read_fails_instead_of_being_skipped() {
    for unreadable in [
        "const MANIFEST_FORMAT_BETA: u32 = 7 + 7;",
        "const MANIFEST_FORMAT_BETA: u32 = SOME_OTHER_CONSTANT;",
        "const MANIFEST_FORMAT_BETA: u64 = 13;",
        "#[allow(dead_code)] const MANIFEST_FORMAT_BETA: u32 = 13;",
    ] {
        let found = with_second_constant_at_14(unreadable);
        assert!(
            found
                .iter()
                .any(|line| line.contains("cannot read") && line.contains(unreadable)),
            "{unreadable}: {found:?}"
        );
    }
}

#[test]
fn a_comment_that_names_a_constant_is_not_one() {
    let source = format!(
        "{GOOD_SOURCE}// const MANIFEST_FORMAT_OLD: u32 = 14;\n/// const MANIFEST_FORMAT_DOC: u32 = 14;\n"
    );
    assert_eq!(problems(&source, GOOD_DOCUMENT), Vec::<String>::new());
}

#[test]
fn the_lowest_heading_removed_is_refused() {
    // The range then starts one higher and nothing is "missing" inside it; the pinned first
    // heading catches it.
    let document = GOOD_DOCUMENT.replace("#### Format 12: alpha\n", "");
    let found = problems(GOOD_SOURCE, &document);
    assert!(
        found
            .iter()
            .any(|line| line.contains("lowest \"Format N\" heading is 13, expected 12")),
        "{found:?}"
    );
}

#[test]
fn a_vault_format_with_a_trailing_comment_is_still_read() {
    let source = GOOD_SOURCE.replace(
        "= MANIFEST_FORMAT_GAMMA;",
        "= MANIFEST_FORMAT_GAMMA; // the newest",
    );
    assert_eq!(problems(&source, GOOD_DOCUMENT), Vec::<String>::new());
}

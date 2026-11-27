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

/// `const MANIFEST_FORMAT_X: u32 = N;` lines, as (name, value).
fn format_constants(source: &str) -> Vec<(String, u32)> {
    source
        .lines()
        .filter_map(|line| {
            let line = line.trim_start();
            let line = line
                .strip_prefix("pub(crate) ")
                .or_else(|| line.strip_prefix("pub "))
                .unwrap_or(line);
            let rest = line.strip_prefix("const MANIFEST_FORMAT_")?;
            let (name, tail) = rest.split_once(':')?;
            let value = tail
                .trim_start()
                .strip_prefix("u32")?
                .trim_start()
                .strip_prefix('=')?
                .trim()
                .trim_end_matches(';')
                .trim();
            Some((format!("MANIFEST_FORMAT_{name}"), value.parse().ok()?))
        })
        .collect()
}

/// What `const VAULT_FORMAT: u32 = ...;` is set to: a number, or the constant it names.
fn vault_format(source: &str, constants: &[(String, u32)]) -> Option<u32> {
    let line = source
        .lines()
        .find(|line| line.trim_start().starts_with("const VAULT_FORMAT: u32"))?;
    let rhs = line.split_once('=')?.1.trim().trim_end_matches(';').trim();
    rhs.parse().ok().or_else(|| {
        constants
            .iter()
            .find(|(name, _)| name == rhs)
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

/// Everything wrong with the pair of files, one sentence each; empty when they agree.
fn problems(source: &str, document: &str) -> Vec<String> {
    let mut found = Vec::new();
    let constants = format_constants(source);
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
    assert_eq!(problems(&source, &document), Vec::<String>::new());
    // Not vacuous: the files really hold the numbers this reads.
    let constants = format_constants(&source);
    assert!(constants.len() >= 10, "{constants:?}");
    assert!(headings(&document).len() >= 10, "{:?}", headings(&document));
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

//! Putting the real details back into an answer written from placeholder text (design 5.4), in
//! Rust, so the restored text is never supplied by the page (the kept answer's rule, AI-06).
//!
//! This is a port of the page's `restoreChecked` (src/deidentify/deidentify.ts) for the marks of
//! one export in one language: each placeholder written exactly as it was sent becomes what it
//! stood for (the first original written for it); anything placeholder-shaped that is not exactly
//! one of this export's, and any near miss, is left as written and listed. The two are kept in
//! step by one shared fixture, `tests/fixtures/cloud-restore-cases.json`, that this module's test
//! and `src/deidentify/restoreFixture.test.ts` both run.

use std::collections::{HashMap, HashSet};

use zeroize::Zeroize;

/// The most placeholders, and the most bytes of replacement and of original, a send may carry
/// (the page supplies them; `validate_removed` is the native side's check).
pub(crate) const MAX_REMOVED: usize = 5_000;
const MAX_REPLACEMENT_BYTES: usize = 120;
const MAX_ORIGINAL_BYTES: usize = 2_000;
const MAX_ORIGINALS_TOTAL_BYTES: usize = 512 * 1024;
/// The document's own text, as the page read it, for the "marker already in the source" rule.
pub(crate) const MAX_SOURCE_BYTES: usize = 4 * 1024 * 1024;

/// What one placeholder of this export stood for. Personal text: zeroed on drop, never printed.
#[derive(Clone)]
pub(crate) struct Removed {
    pub replacement: String,
    pub original: String,
    /// A mark the patient added by hand (kind "manual"): old snapshots could give one mark to two
    /// different details, and then it is not put back.
    pub manual: bool,
}

impl Drop for Removed {
    fn drop(&mut self) {
        self.original.zeroize();
        self.replacement.zeroize();
    }
}

impl std::fmt::Debug for Removed {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Removed(..)")
    }
}

/// Why the list the page sent is refused.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RemovedError {
    TooMany,
    TooLarge,
    /// A replacement that is not exactly one placeholder of a known word, or that does not stand
    /// in the text that was sent.
    BadReplacement,
    /// An original that is empty or holds a forbidden code point.
    BadOriginal,
    BadLabels,
}

/// The placeholder words ("NAME", "DATE"): a few short plain words.
pub(crate) fn labels_ok(labels: &[String]) -> bool {
    !labels.is_empty()
        && labels.len() <= 16
        && labels.iter().all(|word| {
            !word.is_empty()
                && word.len() <= 32
                && !word.starts_with(|c: char| c.is_ascii_digit())
                && !word
                    .chars()
                    .any(|c| c.is_control() || matches!(c, '[' | ']' | ',' | ' ' | '(' | ')'))
        })
}

/// What the native side can check of a list it did not make: every replacement is exactly one
/// placeholder of this export's words and stands in the text that is being sent, the sizes are
/// bounded, and no original holds a forbidden code point. It cannot know that an original is what
/// the document said at that place (the page holds the document), so a compromised page can still
/// choose what a mark stands for: that is the stated residual of AI-06, not a check made here.
pub(crate) fn validate_removed(
    removed: &[Removed],
    sent: &str,
    labels: &[String],
) -> Result<(), RemovedError> {
    if !labels_ok(labels) {
        return Err(RemovedError::BadLabels);
    }
    if removed.len() > MAX_REMOVED {
        return Err(RemovedError::TooMany);
    }
    let mut total = 0usize;
    for part in removed {
        if part.replacement.len() > MAX_REPLACEMENT_BYTES
            || part.original.len() > MAX_ORIGINAL_BYTES
        {
            return Err(RemovedError::TooLarge);
        }
        total += part.original.len();
        if total > MAX_ORIGINALS_TOTAL_BYTES {
            return Err(RemovedError::TooLarge);
        }
        if part.original.is_empty()
            || !crate::text_recheck::forbidden_ranges(&part.original).is_empty()
        {
            return Err(RemovedError::BadOriginal);
        }
        let exact = placeholder_shape(&part.replacement) == Some(part.replacement.len());
        let word = part
            .replacement
            .strip_prefix('[')
            .and_then(|inner| inner.split(' ').next());
        if !exact
            || !word.is_some_and(|word| labels.iter().any(|label| label == word))
            || !sent.contains(part.replacement.as_str())
        {
            return Err(RemovedError::BadReplacement);
        }
    }
    Ok(())
}

/// The mark without its note: "[DATE 2, 14 days after DATE 1]" is "[DATE 2]" (the page's `baseOf`).
fn base_of(replacement: &str) -> String {
    let Some(body) = replacement.strip_suffix(']') else {
        return replacement.to_owned();
    };
    let boundary = body.rfind(['[', ']']).map_or(0, |at| at + 1);
    match body[boundary..].find(',') {
        Some(comma) => format!("{}]", &body[..boundary + comma]),
        None => replacement.to_owned(),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Restored {
    pub text: String,
    /// Placeholder-shaped text that was not put back, as written.
    pub flagged: Vec<String>,
}

/// `labels` are this export's placeholder words ("NAME", "DATE"): a mark written with one of them
/// and a number, in brackets or bare, is flagged when it is not exactly one of the keys. `source`
/// is the document's text: a mark whose base already stands in it, and a manual mark given to two
/// different details, are never put back (the page's two "ambiguous marker" rules).
pub(crate) fn restore(
    answer: &str,
    removed: &[Removed],
    source: &str,
    labels: &[&str],
) -> Restored {
    let mut back: HashMap<&str, &str> = HashMap::new();
    let manual: HashSet<&str> = removed
        .iter()
        .filter(|part| part.manual)
        .map(|part| part.replacement.as_str())
        .collect();
    let mut conflicting: HashSet<&str> = HashSet::new();
    for part in removed {
        // An empty mark would match everywhere and never advance.
        if part.replacement.is_empty() {
            continue;
        }
        match back.get(part.replacement.as_str()) {
            Some(previous) => {
                if manual.contains(part.replacement.as_str()) && *previous != part.original {
                    conflicting.insert(part.replacement.as_str());
                }
            }
            None => {
                back.insert(part.replacement.as_str(), part.original.as_str());
            }
        }
    }
    for part in removed {
        let base = base_of(&part.replacement);
        let comma_form = format!("{},", base.trim_end_matches(']'));
        if conflicting.contains(part.replacement.as_str())
            || source.contains(&base)
            || source.contains(&comma_form)
        {
            back.remove(part.replacement.as_str());
        }
    }
    // Longest first, so "[NAME 1]" never stands inside "[NAME 10]"'s place.
    let mut keys: Vec<&str> = back.keys().copied().collect();
    keys.sort_by_key(|key| std::cmp::Reverse(key.len()));
    let mut words: Vec<&str> = labels.to_vec();
    words.sort_by_key(|word| std::cmp::Reverse(word.len()));

    let mut text = String::with_capacity(answer.len());
    let mut flagged = Vec::new();
    let mut at = 0;
    while at < answer.len() {
        let rest = &answer[at..];
        if let Some(key) = keys.iter().find(|key| rest.starts_with(**key)) {
            text.push_str(back[key]);
            at += key.len();
        } else if let Some(end) = placeholder_shape(rest)
            .or_else(|| bracketed_near_miss(rest, &words))
            .or_else(|| bare_near_miss(answer, at, &words))
        {
            text.push_str(&rest[..end]);
            flagged.push(rest[..end].to_owned());
            at += end;
        } else {
            let step = rest.chars().next().map_or(1, char::len_utf8);
            text.push_str(&rest[..step]);
            at += step;
        }
    }
    Restored { text, flagged }
}

/// The length of a placeholder-shaped mark at the start of `rest`: `[`, a word that does not start
/// with a digit or a comma and holds no bracket or comma, a space, a number, and perhaps a note
/// after a comma and a space, then `]`. No line end stands inside.
fn placeholder_shape(rest: &str) -> Option<usize> {
    let inner_start = rest.strip_prefix('[')?;
    let close = inner_start.find([']', '[', '\n'])?;
    if inner_start.as_bytes()[close] != b']' {
        return None;
    }
    let inner = &inner_start[..close];
    let first = inner.chars().next()?;
    if first.is_ascii_digit() || first == ',' {
        return None;
    }
    // The smallest word that leaves " <digits>" and a valid end, as a lazy match does.
    for (space, _) in inner.match_indices(' ') {
        if space == 0 {
            continue;
        }
        let word = &inner[..space];
        if word.contains(',') {
            break;
        }
        let after = &inner[space + 1..];
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            continue;
        }
        let tail = &after[digits..];
        if tail.is_empty() || tail.strip_prefix(", ").is_some_and(|note| !note.is_empty()) {
            return Some(1 + close + 1);
        }
    }
    None
}

/// `[` or `(`, spaces, one of the words (any case), spaces, a number, then up to 80 more
/// characters that are not a closing bracket or a line end, then `]` or `)`.
fn bracketed_near_miss(rest: &str, words: &[&str]) -> Option<usize> {
    let after_open = rest.strip_prefix(['[', '('])?;
    let trimmed = after_open.trim_start_matches([' ', '\t']);
    let word = words.iter().find(|word| {
        trimmed.len() >= word.len()
            && trimmed.is_char_boundary(word.len())
            && trimmed[..word.len()].eq_ignore_ascii_case(word)
    })?;
    let after_word = trimmed[word.len()..].trim_start_matches([' ', '\t']);
    let digits = after_word.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let tail = &after_word[digits..];
    // At most 80 characters, none a closing bracket or a line end, before the closing bracket.
    let (offset, close) = tail
        .char_indices()
        .take(81)
        .find(|(_, c)| matches!(c, ']' | ')' | '\n'))?;
    if close == '\n' {
        return None;
    }
    Some(rest.len() - tail.len() + offset + close.len_utf8())
}

/// A bare mark ("DATE 2") in capitals, as written: not after a letter or digit, one space or a
/// no-break space (or none), a number not followed by another digit.
fn bare_near_miss(answer: &str, at: usize, words: &[&str]) -> Option<usize> {
    if answer[..at]
        .chars()
        .next_back()
        .is_some_and(|c| c.is_alphanumeric())
    {
        return None;
    }
    let rest = &answer[at..];
    let word = words.iter().find(|word| rest.starts_with(**word))?;
    let mut after = &rest[word.len()..];
    if let Some(stripped) = after.strip_prefix([' ', '\u{a0}']) {
        after = stripped;
    }
    let digits = after.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let end = rest.len() - after.len() + digits;
    if rest[end..].chars().next().is_some_and(char::is_numeric) {
        return None;
    }
    Some(end)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../tests/fixtures/cloud-restore-cases.json");

    #[test]
    fn every_shared_case_restores_as_the_page_does() {
        let fixture: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        let labels: Vec<&str> = fixture["labels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|label| label.as_str().unwrap())
            .collect();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 10);
        for case in cases {
            let removed: Vec<Removed> = case["removed"]
                .as_array()
                .unwrap()
                .iter()
                .map(|part| Removed {
                    replacement: part["replacement"].as_str().unwrap().to_owned(),
                    original: part["original"].as_str().unwrap().to_owned(),
                    manual: part["kind"] == "manual",
                })
                .collect();
            let source = case["source"].as_str().unwrap_or("");
            let result = restore(case["answer"].as_str().unwrap(), &removed, source, &labels);
            let name = case["name"].as_str().unwrap();
            assert_eq!(result.text, case["text"].as_str().unwrap(), "{name}");
            let flagged: Vec<&str> = case["flagged"]
                .as_array()
                .unwrap()
                .iter()
                .map(|flag| flag.as_str().unwrap())
                .collect();
            assert_eq!(result.flagged, flagged, "{name}");
        }
    }

    #[test]
    fn a_reordered_or_repeated_answer_restores_each_mark_where_it_stands() {
        let removed = [
            Removed {
                replacement: "[NAME 1]".into(),
                original: "FAKE Peter Bell".into(),
                manual: false,
            },
            Removed {
                replacement: "[NAME 1, other form 1]".into(),
                original: "FAKE Bell".into(),
                manual: false,
            },
        ];
        let out = restore(
            "[NAME 1, other form 1], [NAME 1], [NAME 1, other form 1], [NAME 1].",
            &removed,
            "",
            &["NAME"],
        );
        assert_eq!(
            out.text,
            "FAKE Bell, FAKE Peter Bell, FAKE Bell, FAKE Peter Bell."
        );
        assert!(out.flagged.is_empty());
    }

    #[test]
    fn text_with_multibyte_characters_and_no_marks_passes_through() {
        let out = restore("Résumé: 患者は元気です。[NAME 1]é", &[], "", &["NAME"]);
        assert_eq!(out.text, "Résumé: 患者は元気です。[NAME 1]é");
        assert_eq!(out.flagged, ["[NAME 1]"]);
    }

    fn part(replacement: &str, original: &str) -> Removed {
        Removed {
            replacement: replacement.into(),
            original: original.into(),
            manual: false,
        }
    }

    fn labels() -> Vec<String> {
        vec!["NAME".into(), "DATE".into()]
    }

    #[test]
    fn an_empty_replacement_neither_loops_nor_matches() {
        let removed = [part("", "FAKE Peter Bell")];
        let out = restore("the [NAME 1] saw the doctor", &removed, "", &["NAME"]);
        assert_eq!(out.text, "the [NAME 1] saw the doctor");
        assert_eq!(out.flagged, ["[NAME 1]"]);
    }

    #[test]
    fn the_list_the_page_sends_is_checked_before_anything_is_kept() {
        let sent = "Patient [NAME 1] on [DATE 2, 14 days after DATE 1].";
        let good = [
            part("[NAME 1]", "FAKE Peter Bell"),
            part("[DATE 2, 14 days after DATE 1]", "2026-05-01"),
        ];
        assert_eq!(validate_removed(&good, sent, &labels()), Ok(()));
        for bad in [
            part("", "x"),
            part("the", "FAKE text"),
            part(" ", "x"),
            part("[NAME 1] and more", "x"),
            part("[NAME 9]", "FAKE Peter Bell"),
            part("[OTHER 1]", "FAKE Peter Bell"),
            part("[1 NAME]", "FAKE Peter Bell"),
        ] {
            assert_eq!(
                validate_removed(&[bad], sent, &labels()),
                Err(RemovedError::BadReplacement)
            );
        }
        assert_eq!(
            validate_removed(&[part("[NAME 1]", "")], sent, &labels()),
            Err(RemovedError::BadOriginal)
        );
        assert_eq!(
            validate_removed(&[part("[NAME 1]", "a\u{202e}b")], sent, &labels()),
            Err(RemovedError::BadOriginal)
        );
        assert_eq!(
            validate_removed(&[part("[NAME 1]", &"x".repeat(2_001))], sent, &labels()),
            Err(RemovedError::TooLarge)
        );
        let many: Vec<Removed> = (0..=MAX_REMOVED)
            .map(|_| part("[NAME 1]", "FAKE"))
            .collect();
        assert_eq!(
            validate_removed(&many, sent, &labels()),
            Err(RemovedError::TooMany)
        );
        assert_eq!(
            validate_removed(&good, sent, &[]),
            Err(RemovedError::BadLabels)
        );
        assert_eq!(
            validate_removed(&good, sent, &["a b".to_owned()]),
            Err(RemovedError::BadLabels)
        );
    }

    #[test]
    fn a_removed_part_never_prints_its_text() {
        let shown = format!("{:?}", part("[NAME 1]", "FAKE Peter Bell"));
        assert!(
            !shown.contains("Peter") && !shown.contains("NAME"),
            "{shown}"
        );
    }

    #[test]
    fn the_base_of_a_mark_drops_its_note() {
        assert_eq!(base_of("[DATE 2, 14 days after DATE 1]"), "[DATE 2]");
        assert_eq!(base_of("[NAME 1]"), "[NAME 1]");
        assert_eq!(base_of("[NAME 1, other form 2]"), "[NAME 1]");
    }
}

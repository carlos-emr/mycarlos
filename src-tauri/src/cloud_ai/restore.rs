//! Putting the real details back into an answer written from placeholder text (design 5.4), in
//! Rust, so the restored text is never supplied by the page (the kept answer's rule, AI-06).
//!
//! This is a port of the page's `restoreChecked` (src/deidentify/deidentify.ts) for the marks of
//! one export in one language: each placeholder written exactly as it was sent becomes what it
//! stood for (the first original written for it); anything placeholder-shaped that is not exactly
//! one of this export's, and any near miss, is left as written and listed. The two are kept in
//! step by one shared fixture, `tests/fixtures/cloud-restore-cases.json`, that this module's test
//! and `src/deidentify/restoreFixture.test.ts` both run.

use std::collections::HashMap;

/// What one placeholder of this export stood for.
#[derive(Clone, Debug)]
pub(crate) struct Removed {
    pub replacement: String,
    pub original: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Restored {
    pub text: String,
    /// Placeholder-shaped text that was not put back, as written.
    pub flagged: Vec<String>,
}

/// `labels` are this export's placeholder words ("NAME", "DATE"): a mark written with one of them
/// and a number, in brackets or bare, is flagged when it is not exactly one of the keys.
pub(crate) fn restore(answer: &str, removed: &[Removed], labels: &[&str]) -> Restored {
    let mut back: HashMap<&str, &str> = HashMap::new();
    for part in removed {
        back.entry(part.replacement.as_str())
            .or_insert(part.original.as_str());
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
                })
                .collect();
            let result = restore(case["answer"].as_str().unwrap(), &removed, &labels);
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
            },
            Removed {
                replacement: "[NAME 1, other form 1]".into(),
                original: "FAKE Bell".into(),
            },
        ];
        let out = restore(
            "[NAME 1, other form 1], [NAME 1], [NAME 1, other form 1], [NAME 1].",
            &removed,
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
        let out = restore("Résumé: 患者は元気です。[NAME 1]é", &[], &["NAME"]);
        assert_eq!(out.text, "Résumé: 患者は元気です。[NAME 1]é");
        assert_eq!(out.flagged, ["[NAME 1]"]);
    }
}

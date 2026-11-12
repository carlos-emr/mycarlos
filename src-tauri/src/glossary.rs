//! K19 (evaluation only): a reviewed, versioned glossary ("glossary-1.txt") puts a short plain
//! explanation beside the first use of each medical word, germ, test or unit in a summary
//! sentence: "creatinine (a blood test of how well the kidneys work) 120 µmol/L (a unit for
//! blood test results)". Ben (12 Nov) kept the plain-language rule as written: a sentence with
//! an unexplained medical term counts as technical.
//!
//! An explanation is the word's general meaning only: never anything about the patient, no cause
//! of the patient's illness, no claim, no digit. The step only inserts; it never drops or
//! changes a word, number or sentence. Rules:
//! - each listed term's first use in a sentence gets " (<explanation>)" right after it, or
//!   ", <explanation>," when it is already inside brackets (", <explanation>" before the
//!   closing bracket);
//! - longer terms first, never overlapping; a "plain" phrase ("LDL cholesterol") keeps a
//!   shorter term inside it unexplained;
//! - a term with no lower-case letter matches with its case ("PO", not "po"), others without;
//! - a unit may follow a digit ("120µmol/L"); other terms need a non-letter, non-digit before
//!   them; every term needs a non-letter, non-digit after it;
//! - nothing is inserted when the term is already explained: a bracket or ", a/an/the/which",
//!   "called" or "known as" right after it, "called" or "known as" right before it, or its
//!   explanation already in the sentence;
//! - English and French summaries only (the glossary has both); others are left as they are.
//!
//! Pure std, so its tests run on their own: `rustc --edition 2021 --test src/glossary.rs`. The
//! cases are shared with the evaluation's Python port (`glossary_cases.txt`).

use std::sync::OnceLock;

/// The glossary's name in a measurement.
#[allow(dead_code)]
pub(crate) const NAME: &str = "glossary-1";

const GLOSSARY: &str = include_str!("glossary-1.txt");

/// One sentence the glossary step changed, for measuring: never shown, never logged with words.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Explained {
    pub(crate) index: usize,
    pub(crate) before: String,
    pub(crate) after: String,
    pub(crate) terms: Vec<String>,
}

struct Entry {
    unit: bool,
    terms: Vec<Vec<char>>,
    en: String,
    fr: String,
}

fn entries() -> &'static [Entry] {
    static ENTRIES: OnceLock<Vec<Entry>> = OnceLock::new();
    ENTRIES.get_or_init(|| {
        GLOSSARY
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
            .map(|line| {
                let parts: Vec<&str> = line.split(" | ").map(str::trim).collect();
                assert_eq!(parts.len(), 4, "glossary line: {line}");
                Entry {
                    unit: parts[0] == "unit",
                    terms: parts[1]
                        .split(';')
                        .map(str::trim)
                        .filter(|t| !t.is_empty())
                        .map(|t| t.chars().collect())
                        .collect(),
                    en: parts[2].to_owned(),
                    fr: parts[3].to_owned(),
                }
            })
            .collect()
    })
}

fn same(a: char, b: char, cased: bool) -> bool {
    if cased {
        a == b
    } else {
        a.to_lowercase().eq(b.to_lowercase())
    }
}

/// The sentence with its explanations, and each (term as written, explanation) inserted, in
/// order; `None` when nothing is inserted.
pub(crate) fn explain(sentence: &str, lang: &str) -> Option<(String, Vec<(String, String)>)> {
    if lang != "en" && lang != "fr" {
        return None;
    }
    let chars: Vec<char> = sentence.chars().collect();
    let n = chars.len();
    let mut claimed = vec![false; n];
    let glossary = entries();
    let mut variants: Vec<(&Vec<char>, usize)> = glossary
        .iter()
        .enumerate()
        .flat_map(|(index, entry)| entry.terms.iter().map(move |term| (term, index)))
        .collect();
    variants.sort_by_key(|(term, _)| std::cmp::Reverse(term.len()));
    // Each listed term's first use: (term, start, end, entry), in the order first found.
    let mut first: Vec<(&Vec<char>, usize, usize, usize)> = Vec::new();
    for (term, index) in variants {
        let cased = !term.iter().any(|c| c.is_lowercase());
        let unit = glossary[index].unit;
        let m = term.len();
        if m > n {
            continue;
        }
        for i in 0..=n - m {
            let starts = i == 0 || {
                let before = chars[i - 1];
                if unit {
                    !before.is_alphabetic()
                } else {
                    !before.is_alphanumeric()
                }
            };
            let ends = i + m >= n || !chars[i + m].is_alphanumeric();
            if !starts || !ends || !(0..m).all(|k| same(chars[i + k], term[k], cased)) {
                continue;
            }
            if claimed[i..i + m].iter().any(|c| *c) {
                continue;
            }
            claimed[i..i + m].iter_mut().for_each(|c| *c = true);
            match first.iter_mut().find(|(t, ..)| *t == term) {
                Some(found) if i < found.1 => *found = (term, i, i + m, index),
                Some(_) => {}
                None => first.push((term, i, i + m, index)),
            }
        }
    }
    let text = |i: usize, j: usize| chars[i..j].iter().collect::<String>();
    let lower_sentence = sentence.to_lowercase();
    let mut inserts: Vec<(usize, String, String, String)> = Vec::new();
    for (_, i, j, index) in first {
        let entry = &glossary[index];
        let explanation = if lang == "fr" { &entry.fr } else { &entry.en };
        if explanation == "-" {
            continue;
        }
        let rest = text(j, n);
        let after = rest.trim_start();
        let after_lower = after.to_lowercase();
        let rest_lower = rest.to_lowercase();
        let before = text(0, i).trim_end().to_lowercase();
        let explained = after.starts_with('(')
            || [
                ", a ",
                ", an ",
                ", the ",
                ", which ",
                "called ",
                "known as ",
            ]
            .iter()
            .any(|p| after_lower.starts_with(p))
            || [
                ", a ",
                ", an ",
                ", the ",
                ", which ",
                " called",
                " known as",
            ]
            .iter()
            .any(|p| rest_lower.starts_with(p))
            || ["called", "known as", "appelée", "appelé"]
                .iter()
                .any(|p| before.ends_with(p))
            || lower_sentence.contains(&explanation.to_lowercase());
        if explained {
            continue;
        }
        let head = text(0, i);
        let inside = head.matches('(').count() > head.matches(')').count();
        let insert = if inside {
            let next = after.chars().next();
            if matches!(next, None | Some(')')) {
                format!(", {explanation}")
            } else {
                format!(", {explanation},")
            }
        } else {
            format!(" ({explanation})")
        };
        inserts.push((j, insert, text(i, j), explanation.clone()));
    }
    if inserts.is_empty() {
        return None;
    }
    inserts.sort_by_key(|(j, ..)| *j);
    let mut out = String::new();
    let mut at = 0;
    for (j, insert, ..) in &inserts {
        out.push_str(&text(at, *j));
        out.push_str(insert);
        at = *j;
    }
    out.push_str(&text(at, n));
    let log = inserts
        .into_iter()
        .map(|(_, _, term, e)| (term, e))
        .collect();
    Some((out, log))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CASES: &str = include_str!("glossary_cases.txt");

    fn check(name: &str) {
        for block in CASES.split("\n===\n").skip(1) {
            let field = |key: &str| {
                block
                    .lines()
                    .find_map(|line| line.strip_prefix(&format!("{key}: ")))
                    .unwrap_or_else(|| panic!("{name}: no {key}"))
                    .to_owned()
            };
            if field("name") != name {
                continue;
            }
            let sentence = field("sentence");
            let got = explain(&sentence, &field("lang")).map_or(sentence, |(out, _)| out);
            assert_eq!(got, field("expect"), "{name}");
            return;
        }
        panic!("no case {name}");
    }

    #[test]
    fn every_shared_case_has_a_test_below() {
        let me = include_str!("glossary.rs");
        for name in CASES
            .split("\n===\n")
            .skip(1)
            .filter_map(|b| b.lines().find_map(|l| l.strip_prefix("name: ")))
        {
            assert!(me.contains(&format!("check(\"{name}\")")), "{name}");
        }
    }

    #[test]
    fn given_the_glossary_when_read_then_no_explanation_has_a_digit_and_every_line_has_both_languages(
    ) {
        for entry in entries() {
            assert!(!entry.terms.is_empty());
            for text in [&entry.en, &entry.fr] {
                assert!(!text.is_empty());
                assert!(!text.chars().any(|c| c.is_ascii_digit()), "{text}");
            }
        }
    }

    #[test]
    fn given_a_lab_value_with_its_unit_when_explained_then_both_get_a_plain_explanation() {
        check("a_lab_value_with_its_unit");
    }

    #[test]
    fn given_a_term_already_explained_with_called_when_explained_then_the_sentence_is_unchanged() {
        check("a_term_already_explained_with_called");
    }

    #[test]
    fn given_a_term_already_explained_in_brackets_when_explained_then_the_sentence_is_unchanged() {
        check("a_term_already_explained_in_brackets");
    }

    #[test]
    fn given_a_term_inside_brackets_when_explained_then_the_explanation_goes_after_a_comma() {
        check("a_term_inside_brackets");
    }

    #[test]
    fn given_a_plain_phrase_when_explained_then_its_short_term_stays_unexplained() {
        check("a_plain_phrase_keeps_its_short_term_unexplained");
    }

    #[test]
    fn given_an_upper_case_abbreviation_when_explained_then_only_its_upper_case_form_matches() {
        check("an_upper_case_abbreviation_matches_only_in_upper_case");
    }

    #[test]
    fn given_a_term_used_twice_when_explained_then_only_its_first_use_gets_the_explanation() {
        check("only_the_first_use_in_a_sentence");
    }

    #[test]
    fn given_two_terms_of_one_glossary_line_when_explained_then_each_gets_its_own() {
        check("each_distinct_term_gets_its_own");
    }

    #[test]
    fn given_a_french_summary_when_explained_then_the_explanations_are_french() {
        check("a_french_summary");
    }

    #[test]
    fn given_a_summary_in_another_language_when_explained_then_it_is_left_as_it_is() {
        check("another_language_is_left_as_it_is");
    }

    #[test]
    fn given_a_unit_right_after_its_number_when_explained_then_the_unit_is_explained() {
        check("a_unit_right_after_its_number");
    }

    #[test]
    fn given_a_term_inside_a_longer_term_when_explained_then_the_longer_term_wins() {
        check("the_longest_term_first");
    }

    #[test]
    fn given_a_term_inside_a_longer_word_when_explained_then_it_is_not_matched() {
        check("a_term_inside_a_longer_word");
    }

    #[test]
    fn given_a_plain_sentence_when_explained_then_it_is_left_as_it_is() {
        check("a_plain_sentence");
    }
}

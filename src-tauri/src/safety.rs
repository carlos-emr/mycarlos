//! K20 (evaluation only): code checks after the model has written a summary, with the
//! document's own sentence as the fallback. They run after K17's addressee step and before the
//! glossary step (which leaves a fallback quote as it is).
//!
//! - **Numbers.** Every number in a summary sentence must be in the pages read (digits compared
//!   without separators or leading zeros; a number word counts: "two" for 2). A sentence that
//!   fails becomes the document's own sentence at its quote, marked as a quote:
//!   `The document says: “…”`. A sentence whose quote was not found stays as it is.
//! - **Get-help rules.** Every sentence of the pages read that is a rule about when to call or
//!   get help (an action word and a condition word) needs one summary sentence that has an
//!   action word and every trigger of the rule (a trigger counts when one of its content words,
//!   or a word starting with its first five letters, is there). A summary sentence that covers
//!   the rule in part (its quote lies in the rule, or it has an action word and one of the
//!   rule's content words) becomes the rule, quoted; with none, the rule is added, quoted, at the
//!   end. Only English rules are checked (the summary is English); the writer's own line to
//!   another doctor ("please call me …") is no rule for the patient (K17 handles it).
//! - **The rule's whole span (safety-2).** The quote is the rule with what it needs: in a
//!   bulleted or numbered step, the whole step up to the rule ("Weigh yourself every morning.
//!   Call if …"); otherwise, for a rule that refers back ("it", "this", "they", "these", "that",
//!   or "the pain" when a word of the sentence before has the noun's first five letters, as in
//!   "nosebleed" for "the bleeding"), the sentence before it too, when it is in the same
//!   paragraph and ends as a sentence. The sentence replaced is the one whose quote lies in the
//!   rule itself, else one with an action word and a trigger; a sentence that gives only the
//!   lead-in stays, and the whole rule is added after.
//! - Nothing is translated, nothing is dropped: a quote replaces a sentence or is added.
//!
//! Pure std (with `addressee`), tested on its own: see the tests' note.

use crate::addressee::{ends_sentence, find_folded, source_sentence, wraps, CONTACT_OFFERS};

/// The checks' name in a measurement.
#[allow(dead_code)]
pub(crate) const NAME: &str = "safety-2";

/// How a fallback sentence starts; later steps leave such a sentence as it is.
pub(crate) const QUOTE_MARK: &str = "The document says: ";

/// A summary sentence for the checks: its words, its quote (empty when not found), and whether
/// it is a fallback quote already.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Line {
    pub(crate) text: String,
    pub(crate) quote: String,
}

/// One fallback, for measuring: which check, the sentence's place, and the words before (none
/// when the quote was added) and after.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Fallback {
    pub(crate) check: &'static str,
    pub(crate) index: usize,
    pub(crate) before: Option<String>,
    pub(crate) after: String,
}

const NUMBER_WORDS: &[(&str, &str)] = &[
    ("one", "1"),
    ("two", "2"),
    ("three", "3"),
    ("four", "4"),
    ("five", "5"),
    ("six", "6"),
    ("seven", "7"),
    ("eight", "8"),
    ("nine", "9"),
    ("ten", "10"),
    ("eleven", "11"),
    ("twelve", "12"),
    ("twice", "2"),
    ("once", "1"),
    ("half", "5"),
    ("un", "1"),
    ("une", "1"),
    ("deux", "2"),
    ("trois", "3"),
    ("quatre", "4"),
    ("cinq", "5"),
    ("sept", "7"),
    ("huit", "8"),
    ("neuf", "9"),
    ("dix", "10"),
    ("douze", "12"),
    ("first", "1"),
    ("second", "2"),
    ("third", "3"),
    ("single", "1"),
    ("both", "2"),
    ("dozen", "12"),
    ("fortnight", "14"),
];
const ACTIONS: &[&str] = &[
    "call",
    "phone",
    "contact",
    "seek",
    "go to",
    "come back",
    "return",
    "attend",
    "see a doctor",
    "appeler",
    "appelez",
    "consulter",
    "consultez",
    "revenir",
    "revenez",
    "urgence",
    "urgences",
    "emergency",
    "911",
    "112",
    "999",
    "811",
];
const CONDITIONS: &[&str] = &[
    "if",
    "when",
    "unless",
    "whenever",
    "si",
    "lorsque",
    "quand",
    "en cas de",
    "en cas d",
];
const STOP: &[&str] = &[
    "the",
    "a",
    "an",
    "and",
    "or",
    "of",
    "to",
    "in",
    "on",
    "at",
    "for",
    "with",
    "your",
    "you",
    "yours",
    "if",
    "when",
    "unless",
    "than",
    "more",
    "less",
    "over",
    "under",
    "this",
    "that",
    "these",
    "those",
    "it",
    "its",
    "is",
    "are",
    "be",
    "been",
    "get",
    "gets",
    "got",
    "goes",
    "going",
    "go",
    "come",
    "comes",
    "very",
    "much",
    "any",
    "some",
    "lasts",
    "last",
    "has",
    "have",
    "had",
    "not",
    "no",
    "do",
    "does",
    "did",
    "after",
    "before",
    "from",
    "into",
    "out",
    "up",
    "down",
    "by",
    "as",
    "their",
    "they",
    "them",
    "he",
    "she",
    "him",
    "her",
    "his",
    "hers",
    "our",
    "we",
    "us",
    "also",
    "still",
    "only",
    "just",
    "then",
    "there",
    "here",
    "what",
    "which",
    "who",
    "whom",
    "whose",
    "where",
    "why",
    "how",
    "please",
    "call",
    "phone",
    "contact",
    "seek",
    "return",
    "back",
    "emergency",
    "department",
    "doctor",
    "family",
    "clinic",
];
const ENGLISH: &[&str] = &[
    "if", "your", "the", "call", "you", "when", "or", "and", "to", "of",
];

/// Lower-case words with their char spans: runs of letters and digits.
fn tokens(text: &str) -> Vec<(String, usize, usize)> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut start = 0;
    for (i, c) in text.chars().enumerate() {
        if c.is_alphanumeric() {
            if word.is_empty() {
                start = i;
            }
            word.extend(c.to_lowercase());
        } else if !word.is_empty() {
            out.push((std::mem::take(&mut word), start, i));
        }
    }
    if !word.is_empty() {
        out.push((word, start, text.chars().count()));
    }
    out
}

/// The first (char start, char end) of any phrase (as words) in `tokens`, at or after `from`.
fn find_phrase(
    toks: &[(String, usize, usize)],
    phrases: &[&str],
    from: usize,
) -> Option<(usize, usize)> {
    let lists: Vec<Vec<&str>> = phrases.iter().map(|p| p.split(' ').collect()).collect();
    for k in 0..toks.len() {
        if toks[k].1 < from {
            continue;
        }
        for words in &lists {
            if k + words.len() <= toks.len()
                && words.iter().enumerate().all(|(o, w)| toks[k + o].0 == *w)
            {
                return Some((toks[k].1, toks[k + words.len() - 1].2));
            }
        }
    }
    None
}

/// Numbers as written, each with its digits (no separators, no leading zeros).
fn numbers(text: &str) -> Vec<(String, String)> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len()
            && (chars[i].is_ascii_digit()
                || (matches!(chars[i], '.' | ',')
                    && chars.get(i + 1).is_some_and(|c| c.is_ascii_digit())))
        {
            i += 1;
        }
        let raw: String = chars[start..i].iter().collect();
        let digits: String = raw.chars().filter(char::is_ascii_digit).collect();
        let trimmed = digits.trim_start_matches('0');
        out.push((
            raw,
            if trimmed.is_empty() {
                "0".to_owned()
            } else {
                trimmed.to_owned()
            },
        ));
    }
    out
}

fn page_numbers(pages: &str) -> std::collections::HashSet<String> {
    let mut found: std::collections::HashSet<String> =
        numbers(pages).into_iter().map(|(_, d)| d).collect();
    for (word, ..) in tokens(pages) {
        if let Some((_, n)) = NUMBER_WORDS.iter().find(|(w, _)| *w == word) {
            found.insert((*n).to_owned());
        }
    }
    for (raw, _) in numbers(pages) {
        for part in raw.split(['.', ',']) {
            let t = part.trim_start_matches('0');
            found.insert(if t.is_empty() {
                "0".to_owned()
            } else {
                t.to_owned()
            });
        }
    }
    found
}

/// The pages' sentences, cut as the addressee step cuts a quote's sentence: (start, end) bytes.
fn sentences_of(pages: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < pages.len() {
        while at < pages.len() && pages[at..].starts_with(char::is_whitespace) {
            at += pages[at..].chars().next().map_or(1, char::len_utf8);
        }
        if at >= pages.len() {
            break;
        }
        let mut to = pages.len();
        for (offset, c) in pages[at..].char_indices() {
            let k = at + offset;
            if matches!(c, '.' | '!' | '?') && ends_sentence(pages, k) {
                to = k + 1;
                break;
            }
            if c == '\n' {
                let line_start = pages[..k].rfind('\n').map_or(0, |i| i + 1);
                if !wraps(&pages[line_start..k]) {
                    to = k;
                    break;
                }
            }
        }
        if !pages[at..to].trim().is_empty() {
            out.push((at, to));
        }
        at = to.max(at + pages[at..].chars().next().map_or(1, char::len_utf8));
    }
    out
}

/// The rule's triggers, each a list of content words: what follows its condition word (up to
/// the action when the condition comes first), split on commas, ";", "or", "ou", "and".
fn triggers(rule: &str) -> Vec<Vec<String>> {
    let toks = tokens(rule);
    let Some((_, cond_end)) = find_phrase(&toks, CONDITIONS, 0) else {
        return Vec::new();
    };
    let cond_start = find_phrase(&toks, CONDITIONS, 0).map_or(0, |c| c.0);
    let first_action = find_phrase(&toks, ACTIONS, 0);
    let chars: Vec<char> = rule.chars().collect();
    let end = match (first_action, find_phrase(&toks, ACTIONS, cond_end)) {
        (Some((a, _)), Some((b, _))) if a > cond_start => b,
        _ => chars.len(),
    };
    let tail: String = chars[cond_end..end.max(cond_end)].iter().collect();
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    for c in tail.chars() {
        if c == ',' || c == ';' {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(c);
        }
    }
    parts.push(current);
    let mut out = Vec::new();
    for part in parts {
        let mut group: Vec<String> = Vec::new();
        for (word, ..) in tokens(&part) {
            if matches!(word.as_str(), "or" | "ou" | "and") {
                if !group.is_empty() {
                    out.push(std::mem::take(&mut group));
                }
                continue;
            }
            let digits = word.chars().all(|c| c.is_ascii_digit());
            if !STOP.contains(&word.as_str()) && (word.chars().count() >= 3 || digits) {
                group.push(word);
            }
        }
        if !group.is_empty() {
            out.push(group);
        }
    }
    out
}

fn carries(sentence: &str, trigger: &[String]) -> bool {
    let words: Vec<String> = tokens(sentence).into_iter().map(|t| t.0).collect();
    trigger.iter().any(|w| {
        words.contains(w)
            || (w.chars().count() >= 5 && {
                let head: String = w.chars().take(5).collect();
                words.iter().any(|x| x.starts_with(&head))
            })
    })
}

fn has_action(text: &str) -> bool {
    find_phrase(&tokens(text), ACTIONS, 0).is_some()
}

fn carries_rule(sentence: &str, trigs: &[Vec<String>]) -> bool {
    has_action(sentence) && trigs.iter().all(|t| carries(sentence, t))
}

fn is_english(text: &str) -> bool {
    let words: std::collections::HashSet<String> = tokens(text).into_iter().map(|t| t.0).collect();
    ENGLISH.iter().filter(|w| words.contains(**w)).count() >= 2
}

fn quoted(text: &str) -> String {
    format!("{QUOTE_MARK}\u{201C}{text}\u{201D}")
}

fn flat(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_bullet(line: &str) -> bool {
    let t = line.trim_start();
    if t.starts_with(['-', '*', '\u{2022}', '\u{2013}']) {
        return true;
    }
    let digits = t.chars().take_while(char::is_ascii_digit).count();
    digits > 0 && t[digits..].starts_with(['.', ')']) && t[digits + 1..].starts_with(' ')
}

/// Where the quote of a rule at `at` starts: the start of its bulleted step, or of the sentence
/// before it when the rule refers back to it (see the module notes), or the rule itself.
fn rule_start(pages: &str, at: usize, previous: Option<(usize, usize)>, rule: &str) -> usize {
    // A bulleted or numbered step: back over its continuation lines to its marker.
    let mut line_start = pages[..at].rfind('\n').map_or(0, |i| i + 1);
    loop {
        let line_end = pages[line_start..]
            .find('\n')
            .map_or(pages.len(), |i| line_start + i);
        let line = &pages[line_start..line_end];
        if is_bullet(line) {
            let marker = line.trim_start();
            let skip = line.len() - marker.len();
            let body = marker.trim_start_matches(|c: char| {
                c.is_ascii_digit() || matches!(c, '-' | '*' | '\u{2022}' | '\u{2013}' | '.' | ')')
            });
            return line_start
                + skip
                + (marker.len() - body.len())
                + (body.len() - body.trim_start().len());
        }
        if line_start == 0 {
            break;
        }
        let prev_start = pages[..line_start - 1].rfind('\n').map_or(0, |i| i + 1);
        let prev = &pages[prev_start..line_start - 1];
        let continued = line.starts_with([' ', '\t']) || wraps(prev);
        if prev.trim().is_empty() || !continued {
            break;
        }
        line_start = prev_start;
    }
    // A rule that refers back to the sentence before it.
    let Some((p_at, p_to)) = previous else {
        return at;
    };
    let before = pages[p_at..p_to].trim();
    if pages[p_to..at].contains("\n\n") || !before.ends_with(['.', '!', '?']) {
        return at;
    }
    let words: Vec<String> = tokens(rule).into_iter().map(|t| t.0).collect();
    let w = |k: usize| words.get(k).map(String::as_str);
    let start = if w(0) == Some("if") { 1 } else { 0 };
    let refers = match w(start) {
        Some("it" | "this" | "these" | "they" | "that" | "so" | "not") => true,
        Some("the") => w(start + 1).is_some_and(|noun| {
            let head: String = noun.chars().take(5).collect();
            noun.chars().count() >= 3 && tokens(before).iter().any(|t| t.0.contains(head.as_str()))
        }),
        _ => false,
    };
    if refers {
        p_at
    } else {
        at
    }
}

fn is_contact_offer(rule: &str) -> bool {
    let lower = format!(" {}", rule.to_lowercase().replace('\u{2019}', "'"));
    CONTACT_OFFERS.iter().any(|offer| {
        lower.match_indices(offer).any(|(at, _)| {
            !lower[..at]
                .chars()
                .next_back()
                .is_some_and(char::is_alphabetic)
                && !lower[at + offer.len()..]
                    .chars()
                    .next()
                    .is_some_and(char::is_alphabetic)
        })
    })
}

/// Runs both checks on an English summary's sentences, in place: replaces or adds quotes.
pub(crate) fn check(pages: &str, lines: &mut Vec<Line>) -> Vec<Fallback> {
    let mut log = Vec::new();
    let have = page_numbers(pages);
    for (index, line) in lines.iter_mut().enumerate() {
        let missing = numbers(&line.text).iter().any(|(_, d)| !have.contains(d));
        if !missing || line.quote.is_empty() {
            continue;
        }
        if let Some((start, end)) = find_folded(pages, &line.quote) {
            let after = quoted(&flat(source_sentence(pages, start, end)));
            let before = std::mem::replace(&mut line.text, after.clone());
            log.push(Fallback {
                check: "numbers",
                index,
                before: Some(before),
                after,
            });
        }
    }
    let spans = sentences_of(pages);
    for (k, &(at, to)) in spans.iter().enumerate() {
        let rule = flat(&pages[at..to]);
        let rule = rule
            .trim_start_matches(['-', '*', '\u{2022}', '\u{2013}', ' '])
            .trim()
            .to_owned();
        let toks = tokens(&rule);
        if find_phrase(&toks, ACTIONS, 0).is_none()
            || find_phrase(&toks, CONDITIONS, 0).is_none()
            || !is_english(&rule)
            || is_contact_offer(&rule)
        {
            continue;
        }
        let trigs = triggers(&rule);
        if trigs.is_empty() || lines.iter().any(|l| carries_rule(&l.text, &trigs)) {
            continue;
        }
        let start = rule_start(pages, at, k.checked_sub(1).map(|p| spans[p]), &rule);
        let span = flat(&pages[start..to])
            .trim_start_matches(['-', '*', '\u{2022}', '\u{2013}', ' '])
            .trim()
            .to_owned();
        let after = quoted(&span);
        if lines.iter().any(|l| l.text == after) {
            continue;
        }
        let quote_in = |l: &Line, from: usize| {
            !l.quote.is_empty()
                && find_folded(pages, &l.quote).is_some_and(|(s, e)| s >= from && e <= to)
        };
        let open = |l: &&Line| !l.text.starts_with(QUOTE_MARK);
        let partial = lines
            .iter()
            .position(|l| open(&l) && quote_in(l, at))
            .or_else(|| {
                lines.iter().position(|l| {
                    let some_word = trigs
                        .iter()
                        .flatten()
                        .filter(|w| w.chars().count() >= 4)
                        .any(|w| l.text.to_lowercase().contains(w.as_str()));
                    open(&l)
                        && has_action(&l.text)
                        && trigs.iter().any(|t| carries(&l.text, t))
                        && some_word
                })
            });
        match partial {
            Some(index) => {
                let before = std::mem::replace(&mut lines[index].text, after.clone());
                log.push(Fallback {
                    check: "get-help",
                    index,
                    before: Some(before),
                    after,
                });
            }
            None => {
                let quote: String = span.chars().take(240).collect();
                log.push(Fallback {
                    check: "get-help",
                    index: lines.len(),
                    before: None,
                    after: after.clone(),
                });
                lines.push(Line { text: after, quote });
            }
        }
    }
    log
}

#[cfg(test)]
mod tests {
    // Run on their own with a harness file that has `#[path] mod addressee; #[path] mod safety;`
    // (safety uses addressee's sentence and quote helpers); see the evaluation notes.
    use super::*;

    const CASES: &str = include_str!("safety_cases.txt");

    fn check_case(name: &str) {
        for block in CASES.split("\n===\n").skip(1) {
            let field = |key: &str| {
                block
                    .lines()
                    .find_map(|line| line.strip_prefix(&format!("{key}: ")))
                    .map(str::to_owned)
            };
            if field("name").as_deref() != Some(name) {
                continue;
            }
            let pages = block
                .split_once("pages:\n")
                .and_then(|(_, rest)| rest.split_once("\nsummary:\n"))
                .map(|(p, _)| p.to_owned())
                .unwrap();
            let summary = block.split_once("\nsummary:\n").unwrap().1;
            let summary = summary.split_once("\nexpect:\n").unwrap().0;
            let expect = block.split_once("\nexpect:\n").unwrap().1;
            let mut lines: Vec<Line> = summary
                .lines()
                .map(|l| {
                    let (text, quote) = l.split_once(" ||").map_or((l, ""), |(t, q)| (t, q.trim()));
                    Line {
                        text: text.to_owned(),
                        quote: quote.to_owned(),
                    }
                })
                .collect();
            check(&pages, &mut lines);
            let got: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
            let want: Vec<&str> = expect.lines().filter(|l| !l.is_empty()).collect();
            assert_eq!(got, want, "{name}");
            return;
        }
        panic!("no case {name}");
    }

    #[test]
    fn every_shared_case_has_a_test_below() {
        let me = include_str!("safety.rs");
        for name in CASES
            .split("\n===\n")
            .skip(1)
            .filter_map(|b| b.lines().find_map(|l| l.strip_prefix("name: ")))
        {
            assert!(me.contains(&format!("check_case(\"{name}\")")), "{name}");
        }
    }

    #[test]
    fn given_a_get_help_rule_with_a_trigger_left_out_when_checked_then_the_sentence_becomes_the_rule_quoted(
    ) {
        check_case("a_rule_with_a_trigger_left_out");
    }

    #[test]
    fn given_a_get_help_rule_missing_from_the_summary_when_checked_then_the_rule_is_added_quoted() {
        check_case("a_rule_missing_from_the_summary");
    }

    #[test]
    fn given_a_rule_whose_condition_comes_first_when_checked_then_its_action_is_no_trigger() {
        check_case("a_condition_before_its_action");
    }

    #[test]
    fn given_a_summary_that_carries_every_trigger_when_checked_then_nothing_changes() {
        check_case("a_rule_carried_whole");
    }

    #[test]
    fn given_trigger_words_in_a_sentence_without_the_action_when_checked_then_it_does_not_carry_the_rule(
    ) {
        check_case("trigger_words_without_the_action");
    }

    #[test]
    fn given_a_number_not_in_the_document_when_checked_then_the_sentence_becomes_its_quoted_sentence(
    ) {
        check_case("a_number_not_in_the_document");
    }

    #[test]
    fn given_a_number_the_document_writes_as_a_word_when_checked_then_nothing_changes() {
        check_case("a_number_written_as_a_word");
    }

    #[test]
    fn given_a_number_not_in_the_document_and_no_quote_found_when_checked_then_the_sentence_stays()
    {
        check_case("a_wrong_number_with_no_quote");
    }

    #[test]
    fn given_the_writers_own_line_to_another_doctor_when_checked_then_it_is_no_rule() {
        check_case("the_writers_line_is_no_rule");
    }

    #[test]
    fn given_a_rule_that_refers_back_to_the_sentence_before_when_quoted_then_that_sentence_comes_with_it(
    ) {
        check_case("a_rule_that_refers_back");
    }

    #[test]
    fn given_a_rule_that_starts_with_if_it_when_quoted_then_the_sentence_before_comes_with_it() {
        check_case("a_rule_that_refers_back_with_it");
    }

    #[test]
    fn given_a_rule_in_a_bulleted_step_when_quoted_then_the_whole_step_is_quoted() {
        check_case("a_rule_in_a_bulleted_step");
    }

    #[test]
    fn given_a_rule_wrapped_over_two_lines_of_a_step_when_quoted_then_the_whole_step_is_quoted() {
        check_case("a_rule_wrapped_in_a_bulleted_step");
    }

    #[test]
    fn given_a_french_rule_when_checked_then_it_is_not_checked() {
        check_case("a_french_rule_is_not_checked");
    }
}

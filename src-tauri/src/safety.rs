//! K20 (evaluation only): code checks after the model has written a summary, with the
//! document's own sentence as the fallback. They run after K17's addressee step and before the
//! glossary step (which leaves a fallback quote as it is).
//!
//! - **Numbers.** Every number a summary sentence writes in digits must be in the pages read, by
//!   its value (see `numbers`): a decimal stays a decimal ("2.5" is not "25"; ".5" after a
//!   space, "(" or the start is "0.5"), thousands separators and leading zeros go, and a number
//!   the pages give as a word counts ("two" for 2, "half" for 0.5). A number that reads two ways
//!   ("1,500") or is date-like ("12.03.2024") must be written as the pages write it (a date's
//!   parts also count). A sentence that fails becomes the document's own sentence at its quote,
//!   marked as a quote: `The document says: “…”`. A sentence whose quote was not found stays as
//!   it is.
//! - **Get-help rules.** Every sentence of the pages read that is a rule about when to call or
//!   get help (an action word and a condition word) needs one summary sentence that has an
//!   action word and every trigger of the rule (see `carries`: one of the trigger's content
//!   words, or a word sharing its first five letters, and the trigger's count when it has one:
//!   its digits, or a counted number word from two to twelve, or "twice", written in the
//!   sentence as digits or as a number word; "one", "once" and "half" are no count). When none
//!   has, the rule is put in, quoted. A summary sentence that covers the rule in part (its quote
//!   lies in the rule, or it has an action word, carries one trigger and has one of the
//!   trigger's words of four letters or more as written; never a line that is a quote already)
//!   is replaced by the rule only when it says nothing the rule's span does not (`covered_by`);
//!   otherwise it keeps its words and the rule is added just after it. With no such sentence,
//!   the rule is added at the end. Only English rules are checked (the summary is English); the
//!   writer's own line to another doctor ("please call me …") is no rule for the patient (K17
//!   handles it).
//! - **The rule's whole span (safety-2).** The quote is the rule with what it needs: in a
//!   bulleted or numbered step, the whole step up to the rule ("Weigh yourself every morning.
//!   Call if …"); otherwise, for a rule that refers back ("it", "this", "they", "these", "that",
//!   or "the pain" when a word of the sentence before has the noun's first five letters, as in
//!   "nosebleed" for "the bleeding"), the sentence before it too, when it is in the same
//!   paragraph and ends as a sentence. The sentence that covers the rule in part is the one
//!   whose quote lies in the rule itself, else one with an action word and a trigger (replaced
//!   or followed by the rule, as above); a sentence that gives only the lead-in stays, and the
//!   whole rule is added.
//! - **The rule's lead-in step (safety-3).** When the rule's condition points back to a step
//!   before it ("the pain", "your weight": "the", "your", "this" or "that", then a noun whose
//!   first five letters are in the step), in its span or before the action in its own sentence
//!   ("For chest pain, use the spray once." before "If the pain is not gone after 5 minutes, call
//!   911."), that step is required too: its content words (not the writer's "given"/"asked", not
//!   the trigger's own words; "once" also as "1" or "one") must all be in the sentence that
//!   carries the rule or in the summary sentence just before it. Otherwise the rule counts as not
//!   carried and gets its whole-span quote, as above. A separate instruction before the rule
//!   ("have blood tests …, and call the clinic if they get a fever") is no step.
//! - Nothing is translated, nothing is dropped: a quote replaces a sentence or is added.
//!
//! Pure std (with `addressee` and `quote_locate`), tested on its own: see the tests' note.

use crate::addressee::{ends_sentence, find_folded, source_sentence, wraps, CONTACT_OFFERS};

/// The checks' name in a measurement.
#[allow(dead_code)]
pub(crate) const NAME: &str = "safety-3";

/// How a fallback sentence starts; later steps leave such a sentence as it is.
pub(crate) const QUOTE_MARK: &str = "The document says: ";

/// A summary sentence for the checks: its words, its quote (empty when not found), and whether
/// it is a fallback quote already.
#[cfg_attr(test, derive(Debug))]
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Line {
    pub(crate) text: String,
    pub(crate) quote: String,
}
redact_debug!(Line);

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
    ("half", "0.5"),
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
    "should",
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

/// A word in compatibility-composed form (NFKC): a ligature ("ﬁ") is its letters, a name written with a
/// combining accent ("Gagne" + U+0301) is the precomposed one. Only the word is folded (and `tokens` keeps a
/// combining mark inside its word), so the char spans `tokens` returns still index the text it was given.
fn folded(word: String) -> String {
    use unicode_normalization::UnicodeNormalization;
    if word.is_ascii() {
        word
    } else {
        word.nfkc().collect()
    }
}

/// Lower-case words with their char spans: runs of letters and digits.
fn tokens(text: &str) -> Vec<(String, usize, usize)> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut start = 0;
    for (i, c) in text.chars().enumerate() {
        if c.is_alphanumeric()
            || (!word.is_empty() && unicode_normalization::char::is_combining_mark(c))
        {
            if word.is_empty() {
                start = i;
            }
            word.extend(c.to_lowercase());
        } else if !word.is_empty() {
            out.push((folded(std::mem::take(&mut word)), start, i));
        }
    }
    if !word.is_empty() {
        out.push((folded(word), start, text.chars().count()));
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

/// Numbers as written, each with its value as text, so that a decimal is never read as a whole
/// number ("2.5" is not "25", "0.5" is not "5"):
/// - a decimal point or comma keeps its place: "2.5" and "2,5" (a French letter) are both "2.5",
///   ".5" is "0.5", and trailing zeros go ("0.50" is "0.5", "1.0" is "1");
/// - thousands separators go when the number says so: "1,000.5" and "1.000,5" (two different
///   separators: the last one is the decimal) are "1000.5", "1,000,000" is "1000000";
/// - leading zeros go ("05" is "5");
/// - a number that reads both ways ("1,500" is 1500 in an English letter and 1.5 in a French one,
///   and the same for "1.500") is kept as written, marked with "~", and so is a number whose groups
///   are not thousands ("12.03.2024", a date): the summary must write it the same way, or the
///   sentence falls back to the document's own words.
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
        // ".5": a decimal written without its leading zero (not "2.5", whose "5" follows a digit).
        // Only after a space, "(" or the start: "5 mg,10 mg" is two numbers, not 5 and 0.1.
        let bare_decimal = start >= 1
            && matches!(chars[start - 1], '.' | ',')
            && (start == 1 || chars[start - 2].is_whitespace() || chars[start - 2] == '(');
        let value = if bare_decimal {
            number_value(&format!("0.{raw}"))
        } else {
            number_value(&raw)
        };
        out.push((raw, value));
    }
    out
}

/// A whole number's digits without leading zeros ("0" for none).
fn whole(digits: &str) -> String {
    let t = digits.trim_start_matches('0');
    if t.is_empty() {
        "0".to_owned()
    } else {
        t.to_owned()
    }
}

/// The value of one number as written (digits joined by "." or ","), as `numbers` describes.
fn number_value(raw: &str) -> String {
    let separators: Vec<char> = raw.chars().filter(|c| matches!(c, '.' | ',')).collect();
    let groups: Vec<&str> = raw.split(['.', ',']).collect();
    let decimal = |int: &str, fraction: &str| {
        let fraction = fraction.trim_end_matches('0');
        if fraction.is_empty() {
            whole(int)
        } else {
            format!("{}.{fraction}", whole(int))
        }
    };
    match separators.as_slice() {
        [] => whole(raw),
        [_] => {
            let (int, fraction) = (groups[0], groups[1]);
            // "1,500" / "1.500": thousands in one convention, a decimal in the other.
            if fraction.len() == 3 && int.len() <= 3 && !int.starts_with('0') {
                format!("~{raw}")
            } else {
                decimal(int, fraction)
            }
        }
        [first, rest @ ..] => {
            let last = *rest.last().unwrap_or(first);
            let thousands = |g: &[&str]| g.iter().all(|g| g.len() == 3);
            if rest.iter().all(|c| c == first) {
                // One separator, used again: thousands ("1,000,000"), or a date-like number.
                if groups[0].len() <= 3 && thousands(&groups[1..]) {
                    whole(&groups.concat())
                } else {
                    format!("~{raw}")
                }
            } else if separators[..separators.len() - 1]
                .iter()
                .all(|c| *c != last)
                && thousands(&groups[1..groups.len() - 1])
            {
                // "1,000.5" / "1.000,5": the last, different separator is the decimal.
                decimal(
                    &groups[..groups.len() - 1].concat(),
                    groups[groups.len() - 1],
                )
            } else {
                format!("~{raw}")
            }
        }
    }
}

fn page_numbers(pages: &str) -> std::collections::HashSet<String> {
    let mut found: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (raw, value) in numbers(pages) {
        // A number kept as written with two or more separators (a date such as "12.03.2024", a
        // phone number such as "613.555.0142") also gives its parts, which a summary may write
        // apart ("12 March 2024"). A decimal never does: "2.5" must not allow "2" or "5".
        if value.starts_with('~') && raw.matches(['.', ',']).count() >= 2 {
            for part in raw.split(['.', ',']) {
                found.insert(whole(part));
            }
        }
        found.insert(value);
    }
    for (word, ..) in tokens(pages) {
        if let Some((_, n)) = NUMBER_WORDS.iter().find(|(w, _)| *w == word) {
            found.insert((*n).to_owned());
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

/// Number words that are a rule's count when they stand in its trigger ("after five minutes"):
/// "one", "once", "first" and the like are left out, as they are seldom a condition ("if one of
/// these happens").
const COUNTED: &[&str] = &[
    "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "twice",
];

/// The number a word stands for: its digits (no leading zeros), or a number word's ("five": 5).
fn number_of(word: &str) -> Option<String> {
    if !word.is_empty() && word.chars().all(|c| c.is_ascii_digit()) {
        let trimmed = word.trim_start_matches('0');
        return Some(if trimmed.is_empty() { "0" } else { trimmed }.to_owned());
    }
    NUMBER_WORDS
        .iter()
        .find(|(w, _)| *w == word)
        .map(|(_, n)| (*n).to_owned())
}

/// Whether a sentence carries a trigger: one of its content words (or a word sharing its first
/// five letters), and every number it holds, as digits or as a number word ("after 5 minutes",
/// "over 38.5"). A rule's waiting time, dose or temperature is its condition: "after using the
/// spray" does not carry "after 5 minutes". Words without a number keep the one-word rule, so
/// a paraphrase still carries ("does not go away" for "is not gone"); a trigger cut in the
/// middle with no number in it ("trouble" for "trouble breathing") still passes too.
fn carries(sentence: &str, trigger: &[String]) -> bool {
    let words: Vec<String> = tokens(sentence).into_iter().map(|t| t.0).collect();
    let numbers: Vec<String> = words.iter().filter_map(|w| number_of(w)).collect();
    let numbers_kept = trigger
        .iter()
        .filter(|w| w.chars().all(|c| c.is_ascii_digit()) || COUNTED.contains(&w.as_str()))
        .filter_map(|w| number_of(w))
        .all(|n| numbers.contains(&n));
    numbers_kept
        && trigger.iter().any(|w| {
            words.contains(w)
                || (w.chars().count() >= 5 && {
                    let head: String = w.chars().take(5).collect();
                    words.iter().any(|x| x.starts_with(&head))
                })
        })
}

/// Words of a lead-in step that need not be carried: the writer's narrative verbs and filler.
const STEP_STOP: &[&str] = &[
    "yourself",
    "yourselves",
    "every",
    "each",
    "use",
    "using",
    "take",
    "taking",
    "keep",
    "given",
    "gave",
    "give",
    "asked",
    "ask",
    "told",
    "tell",
    "advised",
    "advise",
    "instructed",
    "first",
    "then",
    "please",
];

/// The content words of the rule's lead-in step: its span before the rule (`start..at`), and the
/// rule's own words before its first action or condition word; none when the rule's condition
/// does not point back to them.
fn step_words(
    pages: &str,
    start: usize,
    at: usize,
    rule: &str,
    trigs: &[Vec<String>],
) -> Vec<String> {
    let toks = tokens(rule);
    let condition = find_phrase(&toks, CONDITIONS, 0);
    let first = [find_phrase(&toks, ACTIONS, 0), condition]
        .into_iter()
        .flatten()
        .map(|(s, _)| s)
        .min()
        .unwrap_or(0);
    let head: String = rule.chars().take(first).collect();
    // A rule whose sentence starts at its bullet marker has no lead-in span: rule_start returns
    // the step's body, just past the marker, so `start` can lie past `at`. Slicing would panic.
    let lead_in = if start <= at { &pages[start..at] } else { "" };
    let lead = format!("{lead_in} {head}");
    let lead_words: Vec<String> = tokens(&lead).into_iter().map(|t| t.0).collect();
    let after: Vec<&String> = condition.map_or(Vec::new(), |(_, end)| {
        toks.iter().filter(|t| t.1 >= end).map(|t| &t.0).collect()
    });
    let points_back = matches!(
        after.first().map(|w| w.as_str()),
        Some("the" | "your" | "this" | "that")
    ) && after.get(1).is_some_and(|noun| {
        let head: String = noun.chars().take(5).collect();
        noun.chars().count() >= 3 && lead_words.iter().any(|w| w.contains(head.as_str()))
    });
    if !points_back {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    for word in lead_words {
        let digits = word.chars().all(|c| c.is_ascii_digit());
        if STOP.contains(&word.as_str())
            || STEP_STOP.contains(&word.as_str())
            || !(word.chars().count() >= 3 || digits)
            || trigs.iter().flatten().any(|t| *t == word)
            || out.contains(&word)
        {
            continue;
        }
        out.push(word);
    }
    out
}

/// Whether a sentence has every lead-in word: as written, as its number ("once" as "1" or
/// "one"), or with an ending ("spray" in "sprays").
fn carries_step(sentence: &str, step: &[String]) -> bool {
    let words: Vec<String> = tokens(sentence).into_iter().map(|t| t.0).collect();
    let digit = |w: &str| NUMBER_WORDS.iter().find(|(n, _)| *n == w).map(|(_, d)| *d);
    step.iter().all(|w| {
        words.iter().any(|x| {
            x == w
                || digit(w).is_some_and(|d| x == d || digit(x) == Some(d))
                || x.strip_prefix(w.as_str())
                    .is_some_and(|rest| matches!(rest, "s" | "es" | "d" | "ed" | "ing"))
        })
    })
}

/// Whether every content word of `sentence` (three letters or more, or a number, not a stop word)
/// is in `span`, as written or sharing its first five letters: the sentence says nothing the
/// span does not.
fn covered_by(sentence: &str, span: &str) -> bool {
    // Who says it and how ("the patient must", "he was told"): no instruction of its own.
    const FILLER: &[&str] = &[
        "patient", "must", "was", "were", "will", "should", "need", "needs", "can", "may",
    ];
    let have: Vec<String> = tokens(span).into_iter().map(|t| t.0).collect();
    tokens(sentence).into_iter().map(|t| t.0).all(|w| {
        let digits = w.chars().all(|c| c.is_ascii_digit());
        STOP.contains(&w.as_str())
            || STEP_STOP.contains(&w.as_str())
            || FILLER.contains(&w.as_str())
            || !(w.chars().count() >= 3 || digits)
            || have.contains(&w)
            || (w.chars().count() >= 5 && {
                let head: String = w.chars().take(5).collect();
                have.iter().any(|x| x.starts_with(&head))
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

/// Credentials and suffixes that follow a doctor's name ("Dr. Henrietta Fakeham MD"): the name ends before them.
const CREDENTIALS: &[&str] = &[
    "md", "mbbs", "mbchb", "mbbch", "phd", "frcpc", "frcsc", "facs", "facp", "faap", "rn", "np",
    "pa", "dds", "dmd", "od", "dvm", "msc", "mph", "jr", "sr", "ii", "iii",
];

/// The surnames (as lower-case word lists) of the doctors a sentence names: "Dr." or "Doctor",
/// then capitalised words ("Dr. Henrietta Fakeham", "Doctor Ian Sampleton's", "Dr. M. O'Neil"):
/// the last full word is the surname; initials alone do not count. A name with a hyphen is its
/// parts ("Smith-Jones" is "smith", "jones"), a possessive's "'s" goes.
fn doctor_surnames(text: &str) -> Vec<Vec<String>> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < words.len() {
        let title = words[i]
            .trim_matches(|c: char| {
                !c.is_alphanumeric() && !unicode_normalization::char::is_combining_mark(c)
            })
            .to_lowercase();
        if title != "dr" && title != "doctor" {
            i += 1;
            continue;
        }
        let mut surname: Option<&str> = None;
        let mut j = i + 1;
        while j < words.len() && j <= i + 3 {
            let bare = words[j].trim_matches(|c: char| {
                !c.is_alphanumeric() && !unicode_normalization::char::is_combining_mark(c)
            });
            let bare = bare
                .strip_suffix("\u{2019}s")
                .or_else(|| bare.strip_suffix("'s"))
                .unwrap_or(bare);
            // "MD", "M.D." and "Jr." end the name; "DO" is not listed (it is also a surname).
            let letters: String = bare.chars().filter(|c| *c != '.').collect();
            if !bare.chars().next().is_some_and(char::is_uppercase)
                || CREDENTIALS.contains(&letters.to_lowercase().as_str())
            {
                break;
            }
            if bare.chars().count() >= 2 {
                surname = Some(bare);
            }
            // A sentence-ending or other punctuation after the word ends the name.
            if words[j].ends_with([',', ';', ':', '.', '!', '?']) && bare.chars().count() >= 2 {
                break;
            }
            j += 1;
        }
        if let Some(name) = surname {
            let parts: Vec<String> = tokens(name).into_iter().map(|t| t.0).collect();
            if !parts.is_empty() {
                out.push(parts);
            }
        }
        i = j.max(i + 1);
    }
    out
}

/// Whether the sentence names a doctor that its source sentence in the letter does not: the
/// sentence was written from the model's reading of the whole letter, and a name taken from the
/// signature or the greeting puts the wrong doctor in a request (a referral's "please see them"
/// is the receiving doctor's, not the writer's).
fn names_a_doctor_the_source_lacks(sentence: &str, source: &str) -> bool {
    let have: std::collections::HashSet<String> = tokens(source).into_iter().map(|t| t.0).collect();
    doctor_surnames(sentence)
        .iter()
        .any(|parts| !parts.iter().all(|p| have.contains(p)))
}

/// Which way a medicine instruction goes. A summary sentence that says the opposite does not carry it:
/// "keep taking X" is not "stop taking X".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Direction {
    Stop,
    Keep,
    Start,
    Dose,
}

/// How a letter tells the patient to start, stop, go on with or change a medicine (lower-case words,
/// apostrophes removed), and which way. Imperative or advice only: "stopped taking" and "keeps taking"
/// describe the past or another person, which is history, not an instruction.
const CHANGE_PHRASES: &[(&str, Direction)] = &[
    ("keep taking", Direction::Keep),
    ("continue taking", Direction::Keep),
    ("continue to take", Direction::Keep),
    ("resume taking", Direction::Keep),
    ("stop taking", Direction::Stop),
    ("do not take", Direction::Stop),
    ("dont take", Direction::Stop),
    ("must not take", Direction::Stop),
    ("should not take", Direction::Stop),
    ("no longer take", Direction::Stop),
    ("start taking", Direction::Start),
    ("begin taking", Direction::Start),
    ("increase the dose", Direction::Dose),
    ("decrease the dose", Direction::Dose),
    ("reduce the dose", Direction::Dose),
    ("lower the dose", Direction::Dose),
];

/// Third-person phrases ("Ferrous fumarate stops after the infusion.", "…, then stop it."): they count only
/// when the medicine is named BEFORE them, so "The infusion stops after 30 minutes." (no medicine named) is
/// not a medicine change. A bare "stop it" is not here: "we will try to stop it once the methotrexate works"
/// is the clinician's plan, not an instruction to stop now.
const CHANGE_PHRASES_AFTER_THE_MEDICINE: &[&str] = &["stops after", "stop after", "then stop"];

/// Words in a sentence that show which way it goes (see `Direction`); a sentence may show several. A "not",
/// "dont" or "never" just before the word turns it round: "do not stop taking" is Keep, "do not keep taking"
/// is Stop, "do not start" is Stop, "do not increase" is Keep.
fn directions_of(text: &str) -> Vec<Direction> {
    let toks = tokens(&text.replace(['\'', '\u{2019}'], ""));
    let mut out = Vec::new();
    let mut push = |direction: Direction| {
        if !out.contains(&direction) {
            out.push(direction);
        }
    };
    for (i, (word, ..)) in toks.iter().enumerate() {
        let word = word.as_str();
        // "until <date>" ends a course: "take X until 31 October" says when to stop.
        let direction = if ["stop", "stops", "stopped", "stopping", "until", "till"].contains(&word)
        {
            Direction::Stop
        } else if ["keep", "keeps", "continue", "continues", "resume"].contains(&word) {
            Direction::Keep
        } else if ["start", "starts", "begin", "begins"].contains(&word) {
            Direction::Start
        } else if [
            "increase", "decrease", "reduce", "lower", "change", "double", "halve",
        ]
        .contains(&word)
        {
            Direction::Dose
        } else {
            continue;
        };
        let negated = i > 0 && ["not", "dont", "never"].contains(&toks[i - 1].0.as_str());
        push(match (negated, direction) {
            (false, direction) => direction,
            (true, Direction::Stop) => Direction::Keep,
            (true, Direction::Keep) => Direction::Stop,
            (true, Direction::Start) => Direction::Stop,
            (true, Direction::Dose) => Direction::Keep,
        });
    }
    // "do not take", "no longer": a stop without the word.
    if find_phrase(
        &toks,
        &[
            "do not take",
            "dont take",
            "no longer",
            "must not take",
            "should not take",
        ],
        0,
    )
    .is_some()
    {
        push(Direction::Stop);
    }
    out
}

/// Phrases that make a sentence a question or a request for an opinion, with or without a "?".
const QUESTION_MARKERS: &[&str] = &[
    "whether",
    "advise",
    "advice",
    "consider",
    "opinion",
    "recommend",
    "wondering",
    "would you",
    "could you",
    "do you think",
    "should she",
    "should he",
    "should they",
    "should the patient",
    "should we",
    "should i",
];

/// Phrases that make a sentence history: what a patient was told or did before, not an instruction now.
const HISTORY_MARKERS: &[&str] = &[
    "was told",
    "were told",
    "was advised",
    "were advised",
    "was asked",
    "were asked",
    "had been told",
    "previously",
    "used to",
    "in the past",
    "last year",
    "years ago",
    "was taking",
    "were taking",
    "has been taking",
    "had stopped",
];

/// Words that show a sentence is about a medicine: a kind of medicine or dose, or the salt that
/// ends a generic drug's name ("ferrous fumarate"). A drug named alone ("aspirin") is not
/// found, so the rule misses some; it never fires on a sentence about anything else.
const MEDICINE_WORDS: &[&str] = &[
    "medicine",
    "medicines",
    "medication",
    "medications",
    "tablet",
    "tablets",
    "pill",
    "pills",
    "capsule",
    "capsules",
    "inhaler",
    "inhalers",
    "puffer",
    "dose",
    "doses",
    "insulin",
    "antibiotic",
    "antibiotics",
    "drops",
    "cream",
    "ointment",
    "patch",
    "suppository",
    "mg",
    "mcg",
    "units",
    "fumarate",
    "sulfate",
    "sulphate",
    "hydrochloride",
    "chloride",
    "tartrate",
    "maleate",
    "succinate",
    "acetate",
    "phosphate",
    "citrate",
    "besylate",
    "mesylate",
];

/// Words that say what kind of thing or when, not which one: they do not count toward the two content words a
/// summary sentence must share with a medicine line ("tablets" and "morning" are in many sentences).
const GENERIC_MEDICINE_WORDS: &[&str] = &[
    "medicine",
    "medicines",
    "medication",
    "medications",
    "tablet",
    "tablets",
    "pill",
    "pills",
    "capsule",
    "capsules",
    "inhaler",
    "inhalers",
    "puffer",
    "dose",
    "doses",
    "drops",
    "cream",
    "ointment",
    "patch",
    "hour",
    "hours",
    "minute",
    "minutes",
    "second",
    "seconds",
    "morning",
    "evening",
    "night",
    "daily",
    "today",
    "tomorrow",
    "week",
    "weeks",
    "month",
    "months",
    "days",
    "once",
    "twice",
    "regular",
    "regularly",
    "usual",
    "usually",
    "other",
    "others",
    "same",
    "again",
    "still",
];

/// The most medicine lines the check adds to one summary: a letter that says this many times over
/// is a medicine list, and the summary has no room for all of it.
const MEDICINE_LINES_MAX: usize = 3;

/// A letter sentence that tells the patient to start, stop, continue or change a medicine.
#[derive(Debug, PartialEq, Eq)]
struct MedicineChange {
    direction: Direction,
    /// The content words a summary sentence must share (two, or one when there is one).
    words: Vec<String>,
    /// The sentence has no medicine NAME ("Keep taking your other medicines as usual."): a summary sentence
    /// carries it only when it says the same direction, since the shared words are generic.
    direction_required: bool,
}

/// Whether a sentence is a question or a request for an opinion (with or without a "?", even inside quotes or
/// brackets), or history (what the patient was told or did before): none of them is an instruction.
fn is_question_or_history(sentence: &str) -> bool {
    let end = sentence
        .trim_end_matches(|c: char| c.is_whitespace() || ")]\"'\u{201D}\u{2019}".contains(c));
    if end.ends_with('?') {
        return true;
    }
    let line = format!(
        " {} ",
        tokens(&sentence.replace(['\'', '\u{2019}'], ""))
            .into_iter()
            .map(|t| t.0)
            .collect::<Vec<_>>()
            .join(" ")
    );
    QUESTION_MARKERS
        .iter()
        .chain(HISTORY_MARKERS)
        .any(|marker| line.contains(&format!(" {marker} ")))
}

/// The change a letter sentence tells the patient to make (`CHANGE_PHRASES`, or
/// `CHANGE_PHRASES_AFTER_THE_MEDICINE` with the medicine named before it, in a sentence that is about a
/// medicine, `MEDICINE_WORDS`), or `None` when it is not one: a question, an opinion request or history is
/// none, and the phrase's own words, the common words (`STOP`, `STEP_STOP`) and the generic ones
/// (`GENERIC_MEDICINE_WORDS`) are not content words.
fn medicine_change(sentence: &str) -> Option<MedicineChange> {
    if is_question_or_history(sentence) {
        return None;
    }
    // "don't take" and "don\u{2019}t take" are "dont take".
    let toks = tokens(&sentence.replace(['\'', '\u{2019}'], ""));
    let names: Vec<&str> = CHANGE_PHRASES.iter().map(|p| p.0).collect();
    let about_a_medicine = |before: usize| {
        toks.iter()
            .any(|t| t.1 < before && MEDICINE_WORDS.contains(&t.0.as_str()))
    };
    let ((from, to), direction) = if let Some(found) = find_phrase(&toks, &names, 0) {
        if !about_a_medicine(usize::MAX) {
            return None;
        }
        let said: Vec<&str> = toks
            .iter()
            .filter(|t| t.1 >= found.0 && t.2 <= found.1)
            .map(|t| t.0.as_str())
            .collect();
        let direction = CHANGE_PHRASES
            .iter()
            .find(|p| p.0 == said.join(" "))
            .map(|p| p.1)?;
        (found, direction)
    } else {
        let found = find_phrase(&toks, CHANGE_PHRASES_AFTER_THE_MEDICINE, 0)?;
        if !about_a_medicine(found.0) {
            return None;
        }
        (found, Direction::Stop)
    };
    let content = |generic_ok: bool| -> Vec<String> {
        toks.iter()
            .filter(|t| !(t.1 >= from && t.2 <= to))
            .map(|t| t.0.clone())
            .filter(|w| {
                w.chars().count() >= 4
                    && !STOP.contains(&w.as_str())
                    && !STEP_STOP.contains(&w.as_str())
                    && if generic_ok {
                        MEDICINE_WORDS.contains(&w.as_str())
                    } else {
                        !GENERIC_MEDICINE_WORDS.contains(&w.as_str())
                    }
                    && !w.chars().all(|c| c.is_ascii_digit())
            })
            .collect()
    };
    let words = content(false);
    if !words.is_empty() {
        return Some(MedicineChange {
            direction,
            words,
            direction_required: false,
        });
    }
    // No name, only generic words ("Keep taking your other medicines as usual."): the kind of medicine is what
    // there is to share, so the direction must match too.
    let kinds = content(true);
    (!kinds.is_empty()).then_some(MedicineChange {
        direction,
        words: kinds,
        direction_required: true,
    })
}

/// The content words of `medicine_change`, for the tests.
#[cfg(test)]
fn medicine_change_words(sentence: &str) -> Option<Vec<String>> {
    medicine_change(sentence).map(|change| change.words)
}

/// Whether a summary sentence carries a medicine change: it shares at least two of the letter
/// sentence's content words (one when it has only one), a plural counting as its singular
/// ("infusion", "infusions"), and does not say the opposite ("keep taking X" does not carry "stop taking
/// X"). Names that differ by a letter are two medicines.
fn carries_medicine(sentence: &str, change: &MedicineChange) -> bool {
    let stem = |w: &str| {
        w.strip_suffix('s')
            .filter(|_| w.len() > 4)
            .unwrap_or(w)
            .to_owned()
    };
    let have: Vec<String> = tokens(sentence).into_iter().map(|t| stem(&t.0)).collect();
    let shared = change
        .words
        .iter()
        .filter(|w| have.contains(&stem(w)))
        .count();
    if shared < change.words.len().min(2) {
        return false;
    }
    // A stop, start or dose change needs a sentence that says the direction ("Your ramipril was reviewed."
    // does not carry "Stop taking ramipril"); a "keep taking" line may also be carried by a sentence that
    // says nothing of the direction, unless it has only generic words.
    let said = directions_of(sentence);
    if change.direction_required || change.direction != Direction::Keep {
        said.contains(&change.direction)
    } else {
        said.is_empty() || said.contains(&change.direction)
    }
}

/// Whether a sentence ends something at a time its source sentence does not give: it says "until
/// <words>" (or "till") and a content word of those words (four letters or more, no number) is not
/// in the source sentence, even by its first five letters. A time written from another part of the
/// letter ("keep eating gluten until the biopsy", from a question asking how long) is not what the
/// quote says. A trial check (#353): only "until" and "till", so it fires rarely.
fn time_limit_the_source_lacks(sentence: &str, source: &str) -> bool {
    let toks = tokens(sentence);
    let chars: Vec<char> = sentence.chars().collect();
    let Some(at) = toks.iter().position(|t| t.0 == "until" || t.0 == "till") else {
        return false;
    };
    let have: Vec<String> = tokens(source).into_iter().map(|t| t.0).collect();
    let mut previous_end = toks[at].2;
    for t in &toks[at + 1..] {
        // Punctuation between two words ends the clause.
        if chars[previous_end..t.1]
            .iter()
            .any(|c| matches!(c, ',' | ';' | ':' | '.' | '!' | '?'))
        {
            break;
        }
        previous_end = t.2;
        let word = &t.0;
        if word.chars().count() < 4
            || STOP.contains(&word.as_str())
            || STEP_STOP.contains(&word.as_str())
            || word.chars().any(|c| c.is_ascii_digit())
        {
            continue;
        }
        let found = have.iter().any(|h| {
            h == word
                || (word.chars().count() >= 5
                    && h.chars().count() >= 5
                    && word.chars().take(5).eq(h.chars().take(5)))
        });
        if !found {
            return true;
        }
    }
    false
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
#[cfg(test)]
pub(crate) fn check(pages: &str, lines: &mut Vec<Line>) -> Vec<Fallback> {
    check_guarded(pages, lines, |_, _, _, _| {
        Ok::<(), std::convert::Infallible>(())
    })
    .unwrap_or_else(|never| match never {})
}

/// Checks a complete proposed edit before cloning its log or changing the candidate.
/// Error discards the caller's entire temporary candidate, never a subset of rules.
pub(crate) fn check_guarded<E>(
    pages: &str,
    lines: &mut Vec<Line>,
    mut guard: impl FnMut(&[Line], Option<usize>, &str, &str) -> Result<(), E>,
) -> Result<Vec<Fallback>, E> {
    let mut log = Vec::new();
    let have = page_numbers(pages);
    for index in 0..lines.len() {
        let line = &lines[index];
        if line.quote.is_empty() {
            continue;
        }
        // Every line here is model-written, including one that starts "The document says: “…”": the quote mark
        // does not make its words the letter's, so all three checks apply to it.
        let missing = numbers(&line.text).iter().any(|(_, d)| !have.contains(d));
        if let Some((start, end)) = find_folded(pages, &line.quote) {
            let source = source_sentence(pages, start, end);
            // A number the pages lack, or a doctor the quote's own sentence does not name.
            let check = if missing {
                "numbers"
            } else if names_a_doctor_the_source_lacks(&line.text, source) {
                "doctor-name"
            } else if is_english(source) && time_limit_the_source_lacks(&line.text, source) {
                "time-limit"
            } else {
                continue;
            };
            let after = quoted(&flat(source));
            guard(lines, Some(index), &after, &line.quote)?;
            let before = std::mem::replace(&mut lines[index].text, after.clone());
            log.push(Fallback {
                check,
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
        if trigs.is_empty() {
            continue;
        }
        let start = rule_start(pages, at, k.checked_sub(1).map(|p| spans[p]), &rule);
        let step = step_words(pages, start, at, &rule, &trigs);
        let carried = lines.iter().enumerate().any(|(i, l)| {
            carries_rule(&l.text, &trigs)
                && (carries_step(&l.text, &step)
                    || i.checked_sub(1)
                        .is_some_and(|p| carries_step(&lines[p].text, &step)))
        });
        if carried {
            continue;
        }
        let span = flat(&pages[start..to])
            .trim_start_matches(['-', '*', '\u{2022}', '\u{2013}', ' '])
            .trim()
            .to_owned();
        let after = quoted(&span);
        if lines.iter().any(|l| l.text == after) {
            continue;
        }
        // The fallback's source is this same span, not the model's old quote.
        // Keep source whitespace verbatim and cap characters, never UTF-8 bytes.
        let quote: String = pages[start..to].trim().chars().take(240).collect();
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
        // The partial sentence is replaced only when it says nothing the rule's span does not
        // (every content word of it is in the span). A sentence that also says something else
        // keeps its words, and the rule goes in just after it: a dose ("Take FAKEDRUG 2 tablets
        // daily; call the clinic if you get a rash"), or other advice even when its quote lies
        // inside the rule ("… if your lips swell, and keep taking your other medicines").
        let replace = partial.filter(|&i| covered_by(&lines[i].text, &pages[start..to]));
        if let (Some(index), None) = (partial, replace) {
            guard(lines, None, &after, &quote)?;
            // Every logged line after the new one moves down by one, so the log keeps naming
            // each line where it finally stands (`moved_to` relies on it).
            for logged in &mut log {
                if logged.index > index {
                    logged.index += 1;
                }
            }
            log.push(Fallback {
                check: "get-help",
                index: index + 1,
                before: None,
                after: after.clone(),
            });
            lines.insert(index + 1, Line { text: after, quote });
            continue;
        }
        guard(lines, partial, &after, &quote)?;
        match partial {
            Some(index) => {
                let before = std::mem::replace(&mut lines[index].text, after.clone());
                lines[index].quote = quote;
                log.push(Fallback {
                    check: "get-help",
                    index,
                    before: Some(before),
                    after,
                });
            }
            None => {
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
    // A medicine that starts, stops, goes on or changes, which no summary sentence carries: the
    // letter's own sentence goes in, quoted, at the end (a summary at its sentence limit crowds
    // these out). Up to `MEDICINE_LINES_MAX`; only English letters' phrases are known.
    let mut added = 0;
    for &(at, to) in &spans {
        if added == MEDICINE_LINES_MAX {
            break;
        }
        let sentence = flat(&pages[at..to])
            .trim_start_matches(['-', '*', '\u{2022}', '\u{2013}', ' '])
            .trim()
            .to_owned();
        // A line that offers to be called ("please call me if you want to stop taking it") is no instruction.
        if is_contact_offer(&sentence) {
            continue;
        }
        let Some(change) = medicine_change(&sentence) else {
            continue;
        };
        if lines.iter().any(|l| carries_medicine(&l.text, &change)) {
            continue;
        }
        let after = quoted(&sentence);
        // Keep source whitespace verbatim and cap characters, never UTF-8 bytes.
        let quote: String = pages[at..to].trim().chars().take(240).collect();
        guard(lines, None, &after, &quote)?;
        log.push(Fallback {
            check: "medicine",
            index: lines.len(),
            before: None,
            after: after.clone(),
        });
        lines.push(Line { text: after, quote });
        added += 1;
    }
    Ok(log)
}

/// Where each line that was there before `check_guarded` now stands: `to[i]` is line `i`'s
/// final index among `len` final lines. The checks only add lines (a rule put in after a
/// sentence, or at the end), each logged with no `before` at its final index; every other line
/// keeps its order. Anything recorded by line index before the checks (unfound quotes, the
/// addressee rewrites) is moved with this.
pub(crate) fn moved_to(log: &[Fallback], len: usize) -> Vec<usize> {
    let added: std::collections::HashSet<usize> = log
        .iter()
        .filter(|f| f.before.is_none())
        .map(|f| f.index)
        .collect();
    (0..len).filter(|i| !added.contains(i)).collect()
}

#[cfg(test)]
mod tests {
    // Run on their own with a harness file that has `#[path] mod addressee; #[path] mod safety;
    // #[path] mod quote_locate;` and the `unicode-normalization` crate (safety uses addressee's
    // sentence and quote helpers, and addressee finds quotes with `quote_locate`); see the
    // evaluation notes.
    use super::*;

    const CASES: &str = include_str!("safety_cases.txt");

    #[test]
    fn a_partial_rule_replaces_an_unrelated_located_quote_with_its_own_source() {
        let unrelated = "The clinic reviews chest pain at the next appointment.";
        let rule = "If chest pain returns or you have trouble breathing, call 911 now.";
        let pages = format!("FAKE document.\n{unrelated}\n{rule}");
        let mut lines = vec![Line {
            text: "Call the clinic if chest pain returns.".to_owned(),
            quote: unrelated.to_owned(),
        }];
        let log = check(&pages, &mut lines);
        assert_eq!(log.len(), 1);
        assert_eq!(lines[0].text, quoted(rule));
        assert_eq!(lines[0].quote, rule);
        assert!(pages.contains(&lines[0].quote));
    }

    #[test]
    fn an_appended_rule_uses_the_same_verbatim_source_span() {
        let rule = "If chest pain returns or you have trouble breathing during the night,\n  call 911 now.";
        let pages = format!("FAKE document.\n{rule}");
        let mut lines = Vec::new();
        let log = check(&pages, &mut lines);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].before, None);
        assert_eq!(lines[0].text, quoted(&flat(rule)));
        assert_eq!(lines[0].quote, rule);
        assert!(pages.contains(&lines[0].quote));
    }

    #[test]
    fn a_long_unicode_rule_caps_its_quote_by_characters_without_changing_the_rule() {
        let rule = format!(
            "If chest pain returns or {}, call 911 now.",
            "new café-related symptoms and ".repeat(12)
        );
        let pages = format!("FAKE document.\n{rule}");
        for original in [
            Vec::new(),
            vec![Line {
                text: "Call the clinic if chest pain returns.".to_owned(),
                quote: "FAKE document.".to_owned(),
            }],
        ] {
            let mut lines = original;
            assert_eq!(check(&pages, &mut lines).len(), 1);
            assert_eq!(lines[0].text, quoted(&rule));
            assert_eq!(lines[0].quote.chars().count(), 240);
            assert!(lines[0].quote.len() > 240);
            assert!(rule.starts_with(&lines[0].quote));
            assert!(pages.contains(&lines[0].quote));
        }
    }

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
    fn given_a_decimal_dose_written_as_a_whole_number_when_checked_then_the_sentence_is_quoted() {
        check_case("a_decimal_dose_written_as_a_whole_number");
    }

    #[test]
    fn given_a_half_milligram_dose_written_as_five_when_checked_then_the_sentence_is_quoted() {
        check_case("a_half_milligram_dose_written_as_five");
    }

    #[test]
    fn given_half_a_tablet_written_as_five_when_checked_then_the_sentence_is_quoted() {
        check_case("half_a_tablet_written_as_five");
    }

    #[test]
    fn given_a_decimal_without_its_leading_zero_written_as_five_when_checked_then_it_is_quoted() {
        check_case("a_decimal_without_its_leading_zero");
    }

    #[test]
    fn given_decimal_doses_written_the_same_when_checked_then_nothing_changes() {
        check_case("a_decimal_dose_kept");
    }

    #[test]
    fn given_a_french_decimal_comma_when_written_with_a_point_then_nothing_changes() {
        check_case("a_french_decimal_comma_read_as_its_value");
    }

    #[test]
    fn given_a_french_decimal_comma_written_as_a_whole_number_when_checked_then_it_is_quoted() {
        check_case("a_french_decimal_comma_written_as_a_whole_number");
    }

    #[test]
    fn given_thousands_and_trailing_zeros_written_another_way_when_checked_then_nothing_changes() {
        check_case("thousands_and_trailing_zeros_kept");
    }

    #[test]
    fn given_a_number_that_reads_both_ways_rewritten_when_checked_then_the_sentence_is_quoted() {
        check_case("a_number_that_reads_both_ways_rewritten");
    }

    #[test]
    fn given_a_dotted_date_written_out_when_checked_then_nothing_changes() {
        check_case("a_dotted_date_written_out");
    }

    #[test]
    fn given_a_comma_with_no_space_before_a_number_when_checked_then_it_is_two_numbers() {
        check_case("a_comma_with_no_space_before_a_number");
    }

    #[test]
    fn given_a_number_that_reads_both_ways_written_without_its_separator_then_it_is_quoted() {
        check_case("a_number_that_reads_both_ways_written_without_its_separator");
    }

    #[test]
    fn numbers_keep_a_decimal_apart_from_a_whole_number() {
        let value = |raw: &str| numbers(raw).into_iter().map(|(_, v)| v).collect::<Vec<_>>();
        assert_eq!(value("2.5"), ["2.5"]);
        assert_eq!(value("2,5"), ["2.5"]);
        assert_eq!(value("25"), ["25"]);
        assert_eq!(value("0.5"), ["0.5"]);
        assert_eq!(value("0,500"), ["0.5"]);
        assert_eq!(value("0.50"), ["0.5"]);
        assert_eq!(value("1.0"), ["1"]);
        assert_eq!(value("05"), ["5"]);
        assert_eq!(value("take .5 mg"), ["0.5"]);
        assert_eq!(value("(.5 mg)"), ["0.5"]);
        assert_eq!(value("5 mg,10 mg"), ["5", "10"]);
        assert_eq!(value("twice,5 days"), ["5"]);
        assert_eq!(value("1,000.5"), ["1000.5"]);
        assert_eq!(value("1.000,5"), ["1000.5"]);
        assert_eq!(value("1,000,000"), ["1000000"]);
        assert_eq!(value("1,500"), ["~1,500"]);
        assert_eq!(value("1.500"), ["~1.500"]);
        assert_eq!(value("12.03.2024"), ["~12.03.2024"]);
        assert_eq!(value("12.250"), ["~12.250"]);
        assert_ne!(value("2.5"), value("25"));
        let have = page_numbers("Take 2.5 mg, then half, on 12.03.2024.");
        for allowed in ["2.5", "0.5", "~12.03.2024", "12", "3", "2024"] {
            assert!(have.contains(allowed), "{allowed}");
        }
        for refused in ["25", "2", "5"] {
            assert!(!have.contains(refused), "{refused}");
        }
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

    // A trigger that holds a number needs that number (18 Nov 2026): the shape the graded
    // review marked unsafe ("Call 911 if chest pain is not gone after using the spray once"
    // for "If the pain is not gone after 5 minutes, call 911"), and its neighbours.
    #[test]
    fn given_a_rule_whose_waiting_time_is_left_out_when_checked_then_the_rule_is_quoted() {
        check_case("a_rule_whose_waiting_time_is_left_out");
    }

    #[test]
    fn given_a_rule_cut_before_its_number_when_checked_then_the_rule_is_quoted() {
        check_case("a_rule_cut_before_its_number");
    }

    #[test]
    fn given_a_rule_whose_number_is_written_as_a_word_when_checked_then_it_stays() {
        check_case("a_rule_whose_number_is_written_as_a_word");
    }

    #[test]
    fn given_a_rule_cut_right_after_if_when_checked_then_the_rule_is_quoted() {
        check_case("a_rule_cut_right_after_if");
    }

    #[test]
    fn given_a_rule_cut_at_or_with_its_number_left_out_when_checked_then_the_rule_is_quoted() {
        check_case("a_rule_cut_at_or_with_its_number_left_out");
    }

    #[test]
    fn given_a_rule_cut_at_or_before_its_last_trigger_when_checked_then_the_rule_is_quoted() {
        check_case("a_rule_cut_at_or_before_its_last_trigger");
    }

    #[test]
    fn given_a_rule_with_a_decimal_and_an_abbreviation_when_checked_then_the_rule_is_quoted() {
        check_case("a_rule_with_a_decimal_and_an_abbreviation");
    }

    #[test]
    fn given_a_rule_with_its_number_and_an_abbreviated_unit_when_checked_then_it_stays() {
        check_case("a_rule_with_its_number_and_an_abbreviated_unit");
    }

    // By design, not closed: a trigger cut in the middle with no number in it still carries
    // (one of its words is there). A stricter rule would turn paraphrases into quotes.
    #[test]
    fn given_a_trigger_cut_in_the_middle_without_a_number_when_checked_then_it_still_passes() {
        check_case("a_trigger_cut_in_the_middle_without_a_number_still_passes");
    }

    // 18 Nov 2026: a sentence that carries a rule only in part, but also says something else (a
    // dose), keeps its words; the rule is added just after it instead of replacing it.
    #[test]
    fn given_a_rule_inside_a_sentence_that_also_gives_a_dose_when_checked_then_the_dose_stays() {
        check_case("a_rule_inside_a_sentence_that_also_gives_a_dose");
    }

    // "not" and "no" are not counted as content: a sentence that says the opposite of the rule
    // is replaced by the rule in the letter's own words, which is the safe direction.
    #[test]
    fn given_a_sentence_negating_the_rule_when_checked_then_the_rule_replaces_it() {
        check_case("a_sentence_negating_what_the_rule_says_is_replaced_by_the_rule");
    }

    // The independent acceptance set for the 18 Nov 2026 fixes (written apart from them, from
    // bf4b06b9): ACT cases the step must still handle, KEEP cases it must leave whole.
    #[test]
    fn acceptance_m3_act_a_rule_missing_is_added() {
        check_case("m3_act_a_rule_missing_is_added");
    }

    #[test]
    fn acceptance_m3_act_a_sentence_inside_the_rule_is_replaced_by_it() {
        check_case("m3_act_a_sentence_inside_the_rule_is_replaced_by_it");
    }

    #[test]
    fn acceptance_m3_act_the_partial_sentence_is_replaced_and_the_dose_sentence_is_untouched() {
        check_case("m3_act_the_partial_sentence_is_replaced_and_the_dose_sentence_is_untouched");
    }

    #[test]
    fn acceptance_m3_keep_a_dose_and_half_a_rule() {
        check_case("m3_keep_a_dose_and_half_a_rule");
    }

    #[test]
    fn acceptance_m3_keep_a_dose_limit_and_one_trigger() {
        check_case("m3_keep_a_dose_limit_and_one_trigger");
    }

    #[test]
    fn acceptance_m3_keep_a_night_dose_and_one_trigger() {
        check_case("m3_keep_a_night_dose_and_one_trigger");
    }

    #[test]
    fn acceptance_m3_keep_quote_inside_the_rule_but_other_advice_in_the_sentence() {
        check_case("m3_keep_quote_inside_the_rule_but_other_advice_in_the_sentence");
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
    fn given_a_rule_whose_first_step_is_left_out_when_checked_then_the_sentence_becomes_the_whole_step_quoted(
    ) {
        check_case("a_first_step_left_out");
    }

    #[test]
    fn given_a_rule_carried_with_its_first_step_when_checked_then_nothing_changes() {
        check_case("a_first_step_carried");
    }

    #[test]
    fn given_a_first_step_in_the_summary_sentence_just_before_when_checked_then_nothing_changes() {
        check_case("a_first_step_in_the_sentence_before");
    }

    #[test]
    fn given_a_first_step_in_the_rules_own_sentence_when_left_out_then_the_sentence_is_quoted() {
        check_case("a_first_step_in_the_same_sentence");
    }

    #[test]
    fn given_the_writers_narrative_verbs_before_a_rule_when_checked_then_only_its_objects_are_required(
    ) {
        check_case("the_writers_narrative_verbs_are_no_step");
    }

    #[test]
    fn given_a_separate_instruction_before_a_rule_when_checked_then_it_is_no_step() {
        check_case("a_separate_instruction_is_no_step");
    }

    #[test]
    fn given_a_french_rule_when_checked_then_it_is_not_checked() {
        check_case("a_french_rule_is_not_checked");
    }

    /// The FAKE long hospital record's going-home list, as the runner read it: the last step's
    /// sentence starts at its "- " marker, while its quote starts after the marker. The real
    /// hard-10 and messy runs panicked here ("byte range starts at 21344 but ends at 21342").
    const BULLETED_RULES: &str = "- Do not take loperamide (Imodium) for the diarrhea.\n\
        - Do not restart perindopril until your family physician tells you to.\n\
        - Drink about 6 to 8 glasses of fluid a day unless told otherwise.\n\
        - Check your blood sugar once a day before breakfast and write it down; bring the list \
        to your family physician.\n\
        - Come back to the emergency department if you have a fever over 38 °C, shivers, new \
        confusion, pain in your side, if you pass very little urine, or if you have more than 6 \
        loose stools a day or blood in the stool.";

    #[test]
    fn given_a_rule_whose_sentence_starts_at_its_bullet_when_checked_then_it_is_quoted_without_a_panic(
    ) {
        let mut lines = vec![Line {
            text: "Drink 6 to 8 glasses of fluid a day.".to_owned(),
            quote: "Drink about 6 to 8 glasses of fluid a day".to_owned(),
        }];
        let log = check(BULLETED_RULES, &mut lines);
        let rule = "Come back to the emergency department if you have a fever over 38 °C, shivers, new \
            confusion, pain in your side, if you pass very little urine, or if you have more than 6 \
            loose stools a day or blood in the stool.";
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].check, "get-help");
        assert_eq!(log[0].after, quoted(rule));
        assert_eq!(
            lines.last().map(|l| l.text.as_str()),
            Some(quoted(rule).as_str())
        );
    }

    #[test]
    fn given_a_bulleted_rule_carried_whole_when_checked_then_nothing_is_added() {
        let mut lines = vec![Line {
            text: "Come back to the emergency department if you have a fever over 38 °C, shivers, \
                new confusion, pain in your side, if you pass very little urine, or if you have more \
                than 6 loose stools a day or blood in the stool."
                .to_owned(),
            quote: "Come back to the emergency department".to_owned(),
        }];
        assert!(check(BULLETED_RULES, &mut lines).is_empty());
        assert_eq!(lines.len(), 1);
    }

    #[test]
    fn given_the_writer_named_as_the_doctor_to_see_the_patient_when_checked_then_the_letters_sentence_is_quoted(
    ) {
        check_case("the_writer_named_as_the_doctor_asked_to_see_the_patient");
    }

    #[test]
    fn given_a_doctor_the_quoted_sentence_names_when_checked_then_nothing_changes() {
        check_case("a_doctor_named_in_the_quoted_sentence_stays");
    }

    #[test]
    fn given_a_possessive_doctor_name_in_the_quote_when_checked_then_nothing_changes() {
        check_case("a_possessive_doctor_name_found_in_the_quote");
    }

    #[test]
    fn given_a_doctor_named_from_elsewhere_in_the_letter_when_checked_then_the_sentence_is_quoted()
    {
        check_case("a_doctor_named_from_elsewhere_in_the_letter");
    }

    #[test]
    fn given_no_doctor_name_when_checked_then_the_name_check_leaves_the_sentence() {
        check_case("a_sentence_with_no_doctor_name_is_left_alone");
    }

    #[test]
    fn given_a_sentence_without_a_found_quote_when_checked_then_the_name_check_leaves_it() {
        check_case("a_sentence_without_a_found_quote_is_left_alone");
    }

    #[test]
    fn given_doctor_titles_when_names_are_read_then_the_surnames_are_the_last_full_words() {
        let names = |t: &str| doctor_surnames(t);
        assert_eq!(
            names("Dr. Henrietta Fakeham will see you"),
            vec![vec!["fakeham"]]
        );
        assert_eq!(
            names("See Doctor Ian Sampleton\u{2019}s clinic."),
            vec![vec!["sampleton"]]
        );
        assert_eq!(names("Dr. M. O'Neil, MD"), vec![vec!["o", "neil"]]);
        assert_eq!(names("Dr Smith-Jones called"), vec![vec!["smith", "jones"]]);
        assert_eq!(
            names("Dr. Chen and Dr. Park"),
            vec![vec!["chen"], vec!["park"]]
        );
        // No name after the title, a lower-case word, or initials only: nothing to check.
        assert!(names("Ask the doctor about it").is_empty());
        assert!(names("Dr. M. will call").is_empty());
        assert!(names("a dr. who film").is_empty());
    }

    #[test]
    fn given_the_first_check_fires_when_the_log_is_read_then_it_names_the_doctor_check() {
        let pages = "Dear Dr. Sampleton,\nI would be grateful if they could be seen within 4 weeks.\nDr. Henrietta Fakeham";
        let mut lines = vec![Line {
            text: "They must be seen by Dr. Henrietta Fakeham within 4 weeks.".to_owned(),
            quote: "they could be seen within 4 weeks".to_owned(),
        }];
        let log = check(pages, &mut lines);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].check, "doctor-name");
        assert_eq!(log[0].index, 0);
        assert_eq!(
            log[0].before.as_deref(),
            Some("They must be seen by Dr. Henrietta Fakeham within 4 weeks.")
        );
    }

    #[test]
    fn given_a_medicine_stop_left_out_when_checked_then_the_letters_sentence_is_added() {
        check_case("a_medicine_stop_left_out_of_the_summary");
    }

    #[test]
    fn given_a_medicine_stop_the_summary_carries_when_checked_then_nothing_is_added() {
        check_case("a_medicine_stop_carried_by_the_summary");
    }

    #[test]
    fn given_keep_taking_left_out_when_checked_then_the_letters_sentence_is_added() {
        check_case("keep_taking_left_out_of_the_summary");
    }

    #[test]
    fn given_a_stop_that_is_not_about_a_medicine_when_checked_then_nothing_is_added() {
        check_case("a_stop_that_is_not_about_a_medicine");
    }

    #[test]
    fn given_many_medicine_changes_left_out_when_checked_then_three_are_added() {
        check_case("at_most_three_medicine_lines_are_added");
    }

    #[test]
    fn given_a_medicine_line_is_added_when_the_log_is_read_then_it_is_a_medicine_check_without_a_before(
    ) {
        let pages = "Keep taking sumatriptan and the salbutamol inhaler as before.";
        let mut lines = vec![Line {
            text: "Come back in six weeks.".to_owned(),
            quote: String::new(),
        }];
        let log = check(pages, &mut lines);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].check, "medicine");
        assert_eq!(log[0].index, 1);
        assert_eq!(log[0].before, None);
        // The quote is the letter's own span, found in the pages as written.
        assert_eq!(lines[1].quote, pages);
        assert_eq!(moved_to(&log, lines.len()), vec![0]);
    }

    #[test]
    fn given_medicine_sentences_when_read_then_the_change_words_exclude_the_phrase_and_common_words(
    ) {
        assert_eq!(
            medicine_change_words("Keep taking sumatriptan and the salbutamol inhaler as before."),
            Some(vec!["sumatriptan".to_owned(), "salbutamol".to_owned()])
        );
        assert_eq!(
            medicine_change_words("Ferrous fumarate stops after the infusion."),
            Some(vec![
                "ferrous".to_owned(),
                "fumarate".to_owned(),
                "infusion".to_owned()
            ])
        );
        // A change phrase with no medicine in the sentence, and a medicine with no change.
        assert_eq!(
            medicine_change_words("The bleeding stops after 10 minutes."),
            None
        );
        assert_eq!(
            medicine_change_words("Take vitamin D3 2,000 units once a day."),
            None
        );
    }

    #[test]
    fn given_a_time_limit_taken_from_a_question_when_checked_then_the_letters_sentence_is_quoted() {
        check_case("a_time_limit_taken_from_a_question");
    }

    #[test]
    fn given_a_time_limit_the_quoted_sentence_gives_when_checked_then_nothing_changes() {
        check_case("a_time_limit_the_quoted_sentence_gives");
    }

    #[test]
    fn given_an_until_with_no_content_word_when_checked_then_nothing_changes() {
        check_case("an_until_with_no_content_word_is_left_alone");
    }

    #[test]
    fn given_an_until_clause_when_read_then_it_ends_at_punctuation_and_skips_numbers() {
        assert!(time_limit_the_source_lacks(
            "Rest until the biopsy.",
            "Rest for now."
        ));
        assert!(!time_limit_the_source_lacks(
            "Rest until the biopsy.",
            "Rest until the biopsy."
        ));
        // Only the words of the clause count: "biopsies" shares its first five letters with "biopsy".
        assert!(!time_limit_the_source_lacks(
            "Rest until the biopsy.",
            "Rest until the biopsies are back."
        ));
        // The clause stops at a comma: "next week" is not part of it.
        assert!(!time_limit_the_source_lacks(
            "Rest until the biopsy, then call next week.",
            "Rest until the biopsy."
        ));
        // A number in the clause is the number check's business, not this one's.
        assert!(!time_limit_the_source_lacks("Rest until 5 pm.", "Rest."));
        // No "until" or "till", nothing to check.
        assert!(!time_limit_the_source_lacks("Rest for now.", "Rest."));
    }

    #[test]
    fn given_a_model_written_quote_line_with_a_number_not_in_the_letter_when_checked_then_it_is_replaced(
    ) {
        check_case("a_model_written_quote_line_is_still_checked_for_numbers");
    }

    #[test]
    fn given_a_quote_line_with_a_wrong_name_or_time_when_checked_then_it_is_replaced() {
        // "The document says:" does not make the words the letter's: a model-written quote line is checked.
        check_case("a_quote_line_naming_a_doctor_the_quote_lacks_is_replaced");
        check_case("a_quote_line_with_a_time_limit_the_quote_lacks_is_replaced");
    }

    #[test]
    fn given_a_doctor_with_credentials_when_checked_then_the_surname_is_found() {
        check_case("a_doctor_with_credentials_is_found_by_surname");
        assert_eq!(
            doctor_surnames("Dr. Henrietta Fakeham MD will see you"),
            vec![vec!["fakeham"]]
        );
        assert_eq!(
            doctor_surnames("Dr. Ian Sampleton, MBBS, FRCPC"),
            vec![vec!["sampleton"]]
        );
    }

    #[test]
    fn given_a_french_letter_when_checked_then_the_time_limit_check_leaves_the_summary() {
        check_case("a_time_limit_in_a_french_letter_is_left_alone");
    }

    #[test]
    fn given_a_medicine_question_when_checked_then_nothing_is_added() {
        check_case("a_medicine_question_is_not_an_instruction");
    }

    #[test]
    fn given_a_contact_offer_about_a_medicine_when_checked_then_nothing_is_added() {
        check_case("a_contact_offer_about_a_medicine_is_not_an_instruction");
    }

    #[test]
    fn given_a_past_or_third_person_medicine_phrase_when_checked_then_nothing_is_added() {
        check_case("a_past_or_third_person_medicine_phrase_is_history");
    }

    #[test]
    fn given_a_stop_with_no_medicine_before_it_when_checked_then_nothing_is_added() {
        check_case("a_stop_with_no_medicine_before_it_is_not_a_medicine_change");
    }

    #[test]
    fn given_a_dont_take_with_an_apostrophe_when_checked_then_the_sentence_is_added() {
        check_case("a_dont_take_with_an_apostrophe_is_an_instruction");
    }

    #[test]
    fn given_generic_words_when_medicine_words_are_read_then_they_do_not_count() {
        // "tablets" and "morning" are in many sentences: only the names count toward the two shared words.
        assert_eq!(
            medicine_change_words("Stop taking FAKEDRUGA tablets every morning."),
            Some(vec!["fakedruga".to_owned()])
        );
        // Only generic words: the kind of medicine is what there is to share, and the direction must match.
        assert_eq!(
            medicine_change("Keep taking your tablets every morning."),
            Some(MedicineChange {
                direction: Direction::Keep,
                words: vec!["tablets".to_owned()],
                direction_required: true
            })
        );
        assert_eq!(
            medicine_change_words("Keep taking FAKEDRUG tablets for 24 hours."),
            Some(vec!["fakedrug".to_owned()])
        );
        assert_eq!(
            medicine_change_words("Should she stop taking the iron tablets?"),
            None
        );
        assert_eq!(
            medicine_change_words("She stopped taking the iron tablets."),
            None
        );
        assert_eq!(
            medicine_change_words("He keeps taking his FAKEDRUG tablets."),
            None
        );
        assert!(medicine_change_words("Do not take FAKEDRUG tablets.").is_some());
        assert!(medicine_change_words("Don\u{2019}t take FAKEDRUG tablets.").is_some());
    }

    #[test]
    fn given_a_ligature_when_words_are_read_then_they_are_their_letters() {
        // The letter's PDF text has "\u{FB01}rst" (a ligature); the summary has "first".
        assert!(!time_limit_the_source_lacks(
            "Rest until the first dose.",
            "Rest until the \u{FB01}rst dose."
        ));
        assert_eq!(
            tokens("\u{FB01}rst dose")
                .iter()
                .map(|t| t.0.as_str())
                .collect::<Vec<_>>(),
            ["first", "dose"]
        );
    }

    #[test]
    fn given_keep_taking_for_a_stop_instruction_when_checked_then_the_stop_is_added() {
        check_case("keep_taking_does_not_carry_stop_taking");
    }

    #[test]
    fn given_stop_taking_for_a_stop_instruction_when_checked_then_nothing_is_added() {
        check_case("stop_taking_carries_stop_taking");
    }

    #[test]
    fn given_a_question_without_a_question_mark_when_checked_then_nothing_is_added() {
        check_case("a_question_without_a_question_mark_is_not_an_instruction");
        for question in [
            "(Should she stop taking the FAKEDRUG tablets?)",
            "She asked \u{201C}should I stop taking the FAKEDRUG tablets?\u{201D}",
            "Please advise whether to stop taking the FAKEDRUG tablets.",
            "We would value your opinion on stopping the FAKEDRUG tablets: stop taking them?",
            "She was told to stop taking the FAKEDRUG tablets in 2019.",
        ] {
            assert!(medicine_change(question).is_none(), "{question}");
        }
        assert!(medicine_change("Stop taking the FAKEDRUG tablets on 24 November 2026.").is_some());
    }

    #[test]
    fn given_only_generic_medicine_words_when_checked_then_a_keep_sentence_carries_it() {
        check_case("keep_taking_other_medicines_is_added_unless_the_summary_says_keep");
        check_case("keep_taking_other_medicines_carried_by_a_keep_sentence");
    }

    #[test]
    fn given_a_combining_accent_when_names_are_read_then_the_precomposed_name_matches() {
        assert_eq!(
            doctor_surnames("See Dr. Gagne\u{301} today"),
            vec![vec!["gagn\u{e9}"]]
        );
        assert!(!names_a_doctor_the_source_lacks(
            "You must see Dr. Gagne\u{301}.",
            "Please see Dr. Gagn\u{e9} within 6 weeks."
        ));
    }

    #[test]
    fn given_credentials_and_a_surname_that_is_one_when_names_are_read_then_only_the_credentials_end_the_name(
    ) {
        assert_eq!(
            doctor_surnames("Dr. Fakeham M.D. will call"),
            vec![vec!["fakeham"]]
        );
        assert_eq!(
            doctor_surnames("Dr. Henrietta Fakeham, M.D."),
            vec![vec!["fakeham"]]
        );
        assert_eq!(doctor_surnames("Dr. Anh Do will see you"), vec![vec!["do"]]);
    }

    #[test]
    fn given_a_negated_stop_when_checked_then_it_does_not_carry_a_stop() {
        check_case("do_not_stop_taking_does_not_carry_stop_taking");
        check_case("do_not_take_carries_stop_taking");
    }

    #[test]
    fn given_a_sentence_with_no_direction_when_checked_then_it_carries_a_keep_but_not_a_stop() {
        check_case("a_sentence_with_no_direction_does_not_carry_a_stop");
        check_case("a_sentence_with_no_direction_may_carry_a_keep");
    }

    #[test]
    fn given_negation_when_directions_are_read_then_the_direction_turns_round() {
        assert_eq!(directions_of("Stop taking it."), vec![Direction::Stop]);
        assert_eq!(
            directions_of("Do not stop taking it."),
            vec![Direction::Keep]
        );
        assert_eq!(
            directions_of("Don\u{2019}t stop taking it."),
            vec![Direction::Keep]
        );
        assert_eq!(
            directions_of("Never stop it on your own."),
            vec![Direction::Keep]
        );
        assert_eq!(
            directions_of("Do not keep taking it."),
            vec![Direction::Stop]
        );
        assert_eq!(directions_of("Do not start it."), vec![Direction::Stop]);
        assert_eq!(
            directions_of("Do not increase the dose."),
            vec![Direction::Keep]
        );
        assert_eq!(directions_of("Do not take it."), vec![Direction::Stop]);
        assert_eq!(
            directions_of("Your ramipril was reviewed."),
            Vec::<Direction>::new()
        );
        assert_eq!(
            directions_of("Take it twice daily until 31 October."),
            vec![Direction::Stop]
        );
        let both = directions_of("Keep taking the first and stop taking the second.");
        assert!(both.contains(&Direction::Keep) && both.contains(&Direction::Stop));
    }

    #[test]
    fn given_an_until_date_when_checked_then_it_carries_a_then_stop() {
        check_case("an_until_date_carries_a_then_stop");
    }
}

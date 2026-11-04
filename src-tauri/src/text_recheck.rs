//! The native re-check before an anonymized text is written (#72 part B,
//! threat model AI-02). Page code holds the text and runs the remover; this
//! module refuses, and never edits. It refuses text that still holds a code
//! point the cleaning drops or replaces (one pinned table, shared with page
//! code: `unicode_cleaning_table`), and text in which one of the vault's own
//! identifiers still stands: a profile's or a person's name, whole or by its
//! parts, in any order and case, with accents and look-alike letters folded
//! as the remover folds them; a profile's birth date in the forms the
//! remover reads; and the patient's name and birth date from the document's
//! delivery manifest. Ranges come back in UTF-16 units, which page code
//! counts in.

use crate::unicode_cleaning_table::{REMOVED, REPLACED};
use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

/// A range of the text, in UTF-16 units.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct Hit {
    pub(crate) start: u32,
    pub(crate) end: u32,
}

fn in_ranges(table: &[(u32, u32)], code_point: u32) -> bool {
    table
        .binary_search_by(|&(start, end)| {
            if code_point < start {
                std::cmp::Ordering::Greater
            } else if code_point > end {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// Runs of code points the cleaning would drop or replace, still in the
/// text: a page that skipped the cleaning, or a payload.
pub(crate) fn forbidden_ranges(text: &str) -> Vec<Hit> {
    let mut hits = Vec::new();
    let mut at = 0u32;
    let mut run: Option<Hit> = None;
    for character in text.chars() {
        let length = character.len_utf16() as u32;
        let code_point = character as u32;
        if in_ranges(REMOVED, code_point) || in_ranges(REPLACED, code_point) {
            run = Some(match run {
                Some(hit) => Hit {
                    start: hit.start,
                    end: at + length,
                },
                None => Hit {
                    start: at,
                    end: at + length,
                },
            });
        } else if let Some(hit) = run.take() {
            hits.push(hit);
        }
        at += length;
    }
    if let Some(hit) = run {
        hits.push(hit);
    }
    hits
}

// Format characters (Cf) outside the dropped table, folded away for matching.
const FORMAT: &[(u32, u32)] = &[
    (0x0600, 0x0605),
    (0x06dd, 0x06dd),
    (0x070f, 0x070f),
    (0x0890, 0x0891),
    (0x08e2, 0x08e2),
    (0xfff9, 0xfffb),
    (0x110bd, 0x110bd),
    (0x110cd, 0x110cd),
    (0x13430, 0x1343f),
];

/// Letters that `matchingCopy` in page code folds the same way.
fn direct_fold(character: char) -> Option<&'static str> {
    Some(match character {
        // Hyphen look-alikes PDFs write in dates and ranges, as in page code.
        '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2212}' => "-",
        'ł' | 'Ł' => "l",
        'ø' | 'Ø' => "o",
        'đ' | 'Đ' => "d",
        'ß' | 'ẞ' => "ss",
        'æ' | 'Æ' => "ae",
        'œ' | 'Œ' => "oe",
        'ı' => "i",
        'ħ' | 'Ħ' => "h",
        'ŧ' | 'Ŧ' => "t",
        'а' | 'А' | 'α' | 'Α' => "a",
        'е' | 'Е' | 'ҽ' | 'Ε' => "e",
        'о' | 'О' | 'ο' | 'Ο' => "o",
        'р' | 'Р' | 'ρ' | 'Ρ' => "p",
        'с' | 'С' => "c",
        'х' | 'Х' | 'Χ' => "x",
        'у' | 'Υ' => "y",
        'і' | 'І' | 'ι' | 'Ι' => "i",
        'ѕ' | 'Ѕ' => "s",
        'ј' | 'Ј' => "j",
        'һ' | 'Н' | 'Η' => "h",
        'ԁ' => "d",
        'ԛ' => "q",
        'ѡ' => "w",
        'В' | 'Β' => "b",
        'К' | 'κ' | 'Κ' => "k",
        'М' | 'Μ' => "m",
        'Т' | 'τ' | 'Τ' => "t",
        'ν' => "v",
        'υ' => "u",
        'Ζ' => "z",
        'Ν' => "n",
        _ => return None,
    })
}

/// The text folded for matching: lower case, compatibility forms, no
/// accents, look-alikes as Latin letters, no format characters. Each folded
/// character carries the UTF-16 range of the character it came from.
struct Folded {
    characters: Vec<char>,
    ranges: Vec<(u32, u32)>,
}

fn fold(text: &str) -> Folded {
    let mut folded = Folded {
        characters: Vec::with_capacity(text.len()),
        ranges: Vec::with_capacity(text.len()),
    };
    let mut at = 0u32;
    let mut piece = String::new();
    for character in text.chars() {
        let length = character.len_utf16() as u32;
        let range = (at, at + length);
        at += length;
        piece.clear();
        if character.is_ascii() {
            piece.push(character.to_ascii_lowercase());
        } else {
            for compatible in character.nfkc() {
                if let Some(direct) = direct_fold(compatible) {
                    piece.push_str(direct);
                    continue;
                }
                for base in compatible.nfd() {
                    if is_combining_mark(base)
                        || in_ranges(REMOVED, base as u32)
                        || in_ranges(FORMAT, base as u32)
                    {
                        continue;
                    }
                    piece.extend(base.to_lowercase());
                }
            }
        }
        for folded_character in piece.chars() {
            folded.characters.push(folded_character);
            folded.ranges.push(range);
        }
    }
    folded
}

fn fold_to_string(value: &str) -> String {
    fold(value).characters.into_iter().collect()
}

const PARTICLES: &[&str] = &[
    "de", "du", "des", "la", "le", "les", "van", "von", "der", "den", "ter", "ten", "bin", "ibn",
    "al", "el", "da", "dos", "das", "di", "del", "della", "degli",
];
// The remover's ordinary and relationship words, which it never removes on
// their own; the re-check must not demand more than the remover takes.
const NOT_ALONE: &[&str] = &[
    "major",
    "iris",
    "mark",
    "may",
    "grace",
    "brown",
    "rose",
    "will",
    "hope",
    "faith",
    "joy",
    "june",
    "april",
    "august",
    "bill",
    "pat",
    "dawn",
    "summer",
    "river",
    "white",
    "black",
    "green",
    "young",
    "king",
    "page",
    "rich",
    "guy",
    "ray",
    "lane",
    "dale",
    "glen",
    "art",
    "frank",
    "sunny",
    "claire",
    "blanc",
    "petit",
    "grand",
    "roy",
    "pierre",
    "me",
    "mom",
    "mum",
    "dad",
    "mother",
    "father",
    "son",
    "daughter",
    "wife",
    "husband",
    "spouse",
    "partner",
    "brother",
    "sister",
    "grandma",
    "grandpa",
    "nana",
    "papa",
    "baby",
    "moi",
    "maman",
    "mere",
    "pere",
    "fils",
    "fille",
    "conjoint",
    "conjointe",
];

fn is_han(character: char) -> bool {
    matches!(character as u32, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0x20000..=0x323af)
}

/// The forms of a name that must not stand in the text: the whole name in
/// either order and surname first, and each part alone (three letters or
/// more; a run of two or more characters of a Han name).
fn name_forms(name: &str) -> Vec<Vec<char>> {
    let folded = fold_to_string(name);
    let parts: Vec<String> = folded
        .split(|c: char| !(c.is_alphabetic() || c == '\'' || c == '’' || c == '-'))
        .map(|part| part.trim_matches(|c| c == '\'' || c == '’' || c == '-'))
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect();
    let mut forms: Vec<String> = Vec::new();
    let mut words: Vec<String> = Vec::new();
    for part in &parts {
        for piece in std::iter::once(part.as_str())
            .chain(part.split('-'))
            .chain(std::iter::once(
                part.trim_start_matches("d'").trim_start_matches("d’"),
            ))
        {
            let piece = piece.trim_matches(|c| c == '\'' || c == '’' || c == '-');
            if piece.is_empty() {
                continue;
            }
            if piece.chars().any(is_han) {
                let characters: Vec<char> = piece.chars().collect();
                for from in 0..characters.len() {
                    for to in from + 2..=characters.len() {
                        words.push(characters[from..to].iter().collect());
                    }
                }
                continue;
            }
            if piece.chars().count() >= 3
                && !PARTICLES.contains(&piece)
                && !NOT_ALONE.contains(&piece)
            {
                words.push(piece.to_owned());
            }
        }
    }
    if parts.len() > 1 || !words.is_empty() {
        forms.push(parts.join(" "));
    }
    if parts.len() > 1 {
        let last = parts[parts.len() - 1].clone();
        let rest = parts[..parts.len() - 1].join(" ");
        forms.push(format!("{last}, {rest}"));
        forms.push(format!("{last} {rest}"));
        let mut reversed = parts.clone();
        reversed.reverse();
        forms.push(reversed.join(" "));
    }
    forms.extend(words);
    forms.sort();
    forms.dedup();
    forms
        .into_iter()
        .map(|form| form.chars().collect())
        .collect()
}

const MONTHS_EN: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];
const MONTHS_FR: [&str; 12] = [
    "janvier",
    "fevrier",
    "mars",
    "avril",
    "mai",
    "juin",
    "juillet",
    "aout",
    "septembre",
    "octobre",
    "novembre",
    "decembre",
];
const MONTHS_FR_SHORT: [&str; 12] = [
    "janv.", "fevr.", "mars", "avr.", "mai", "juin", "juil.", "aout", "sept.", "oct.", "nov.",
    "dec.",
];

/// The written forms of a birth date "1961-04-17" the remover reads.
fn date_forms(iso: &str) -> Vec<Vec<char>> {
    let mut parts = iso.split('-');
    let (Some(year), Some(month), Some(day), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Vec::new();
    };
    let (Ok(y), Ok(m), Ok(d)) = (
        year.parse::<u32>(),
        month.parse::<usize>(),
        day.parse::<u32>(),
    ) else {
        return Vec::new();
    };
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return Vec::new();
    }
    let yy = y % 100;
    let mut forms = vec![
        format!("{y}-{m:02}-{d:02}"),
        format!("{y}/{m:02}/{d:02}"),
        format!("{y}/{m}/{d}"),
        format!("{d:02}/{m:02}/{y}"),
        format!("{d}/{m}/{y}"),
        format!("{m:02}/{d:02}/{y}"),
        format!("{m}/{d}/{y}"),
        format!("{d:02}.{m:02}.{y}"),
        format!("{d}.{m}.{y}"),
        format!("{m:02}.{d:02}.{y}"),
        format!("{d:02}/{m:02}/{yy:02}"),
        format!("{d}/{m}/{yy:02}"),
        format!("{m:02}/{d:02}/{yy:02}"),
        format!("{m}/{d}/{yy:02}"),
    ];
    let en = MONTHS_EN[m - 1];
    let en_short = &en[..3];
    let fr = MONTHS_FR[m - 1];
    let fr_short = MONTHS_FR_SHORT[m - 1];
    for month_word in [en, en_short, "sept"] {
        if month_word == "sept" && m != 9 {
            continue;
        }
        forms.push(format!("{d} {month_word} {y}"));
        forms.push(format!("{d}-{month_word}-{y}"));
        forms.push(format!("{month_word} {d}, {y}"));
        forms.push(format!("{month_word}. {d}, {y}"));
        forms.push(format!("{month_word} {d} {y}"));
        forms.push(format!("{y}-{month_word}-{d:02}"));
        forms.push(format!("{y}-{month_word}-{d}"));
    }
    for month_word in [fr, fr_short] {
        forms.push(format!("{d} {month_word} {y}"));
        forms.push(format!("{d}-{month_word}-{y}"));
        if d == 1 {
            forms.push(format!("1er {month_word} {y}"));
        }
    }
    forms.sort();
    forms.dedup();
    forms
        .into_iter()
        .map(|form| form.chars().collect())
        .collect()
}

fn is_word_character(character: char) -> bool {
    character.is_alphanumeric()
}

/// Where `needle` stands in the folded text as a whole word (Han needles
/// anywhere), as ranges of the original text.
fn find_all(folded: &Folded, needle: &[char], hits: &mut Vec<Hit>) {
    if needle.is_empty() || needle.len() > folded.characters.len() {
        return;
    }
    let han = needle.iter().any(|&c| is_han(c));
    let text = &folded.characters;
    let mut at = 0;
    while at + needle.len() <= text.len() {
        if text[at..at + needle.len()] == *needle {
            let before_ok = han || at == 0 || !is_word_character(text[at - 1]);
            let after = at + needle.len();
            let after_ok = han || after == text.len() || !is_word_character(text[after]);
            if before_ok && after_ok {
                hits.push(Hit {
                    start: folded.ranges[at].0,
                    end: folded.ranges[after - 1].1,
                });
                at = after;
                continue;
            }
        }
        at += 1;
    }
}

// ------------------------------------------------------------ real dates
//
// The remover sends no date: each becomes a placeholder (#72, AI-01). This
// refuses a text in which a date the remover reads still stands. It reads the
// same forms, in the same order, as the page code's `DATE_FORMS` in
// `deidentify.ts`; `fixtures/date-forms.json` holds cases both sides must
// agree on, and a test on each side runs them.

fn month_number(word: &str) -> Option<u32> {
    // English in full and by its first three letters ("may" is whole), "sept",
    // and French in full and by the short forms, all folded (no accents).
    for (index, english) in MONTHS_EN.iter().enumerate() {
        let number = index as u32 + 1;
        if word == *english || (english.len() > 3 && word == &english[..3]) {
            return Some(number);
        }
    }
    if word == "sept" {
        return Some(9);
    }
    for (index, french) in MONTHS_FR.iter().enumerate() {
        if word == *french {
            return Some(index as u32 + 1);
        }
    }
    for (index, short) in MONTHS_FR_SHORT.iter().enumerate() {
        if word == short.trim_end_matches('.') {
            return Some(index as u32 + 1);
        }
    }
    None
}

fn is_word(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

fn calendar_day(year: u32, month: u32, day: u32) -> bool {
    if !(1..=12).contains(&month) || day < 1 {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    day <= days
}

/// Reads up to `max` digits at `at` (at least `min`): the value and the end.
fn digits(text: &[char], at: usize, min: usize, max: usize) -> Option<(u32, usize)> {
    let mut end = at;
    let mut value = 0u32;
    while end < text.len() && end - at < max && text[end].is_ascii_digit() {
        value = value * 10 + text[end].to_digit(10)?;
        end += 1;
    }
    (end - at >= min).then_some((value, end))
}

/// Four digits not followed by a word character.
fn year_at(text: &[char], at: usize) -> Option<(u32, usize)> {
    let (year, end) = digits(text, at, 4, 4)?;
    (end == text.len() || !is_word(text[end])).then_some((year, end))
}

/// A month word (and its full stop, if any) at `at`: the number and the end.
fn month_at(text: &[char], at: usize) -> Option<(u32, usize)> {
    let mut end = at;
    while end < text.len() && text[end].is_alphabetic() {
        end += 1;
    }
    if end == at {
        return None;
    }
    let word: String = text[at..end].iter().collect();
    let month = month_number(&word)?;
    if end < text.len() && text[end] == '.' {
        end += 1;
    }
    Some((month, end))
}

fn skip(text: &[char], mut at: usize, allowed: &[char]) -> usize {
    while at < text.len() && allowed.contains(&text[at]) {
        at += 1;
    }
    at
}

fn numeric_date(a: u32, b: u32, year: u32) -> bool {
    // Either part over 12 settles it; both 12 or under and different cannot
    // be told apart and are a date all the same (the remover gives it a plain
    // placeholder). Otherwise the day-first reading is checked.
    if a <= 12 && b <= 12 && a != b {
        return true;
    }
    let (day, month) = if a > 12 || b <= 12 { (a, b) } else { (b, a) };
    calendar_day(year, month, day)
}

/// The cue words a year alone follows, folded.
const YEAR_CUES: [&str; 17] = [
    "in",
    "since",
    "from",
    "until",
    "till",
    "by",
    "during",
    "before",
    "after",
    "en",
    "depuis",
    "des",
    "avant",
    "apres",
    "jusqu'en",
    "jusqu\u{2019}en",
    "vers",
];

fn after_date_label(text: &[char], at: usize) -> bool {
    // "Date: ", "Visit date: ", "dated ", "Collected:" and the like, on this line.
    let mut end = at;
    while end > 0 && (text[end - 1] == ' ' || text[end - 1] == '\t') {
        end -= 1;
    }
    let line_start = text[..end]
        .iter()
        .rposition(|&c| c == '\n')
        .map_or(0, |i| i + 1);
    let before: String = text[line_start..end].iter().collect();
    if let Some(label) = before.strip_suffix(':') {
        for word in [
            "collected",
            "received",
            "reported",
            "admitted",
            "discharged",
            "signed",
        ] {
            if label.trim_end_matches([' ', '\t']).ends_with(word) {
                return true;
            }
        }
        // "date" then up to 30 characters that are not a colon.
        let mut from = 0;
        while let Some(found) = label[from..].find("date") {
            let position = from + found;
            let tail = &label[position + 4..];
            let separated = label[..position]
                .chars()
                .next_back()
                .is_none_or(|c| !c.is_alphabetic());
            let next_ok = tail.chars().next().is_none_or(|c| !c.is_alphabetic());
            if separated && next_ok && tail.chars().count() <= 30 && !tail.contains(':') {
                return true;
            }
            from = position + 4;
        }
        false
    } else {
        before.ends_with("dated")
            && !before
                .strip_suffix("dated")
                .and_then(|rest| rest.chars().next_back())
                .is_some_and(|c| c.is_alphabetic())
    }
}

/// An English ordinal suffix (or the French "er") after a day number: the end after it.
fn ordinal(text: &[char], at: usize) -> usize {
    for suffix in ["er", "st", "nd", "rd", "th"] {
        let suffix: Vec<char> = suffix.chars().collect();
        if text[at..].starts_with(&suffix) {
            return at + 2;
        }
    }
    at
}

/// The end of a day written 1 or 2 digits long with its ordinal: (day, end).
fn day_at(text: &[char], at: usize) -> Option<(u32, usize)> {
    let (day, end) = digits(text, at, 1, 2)?;
    Some((day, ordinal(text, end)))
}

fn not_word_after(text: &[char], at: usize) -> bool {
    at == text.len() || !is_word(text[at])
}

/// The end of an ISO date's day: not followed by a word character, but "T" and a digit
/// (a timestamp) may follow, and the time stays out of the date.
fn iso_end_ok(text: &[char], at: usize) -> bool {
    not_word_after(text, at)
        || (text[at] == 't' && at + 1 < text.len() && text[at + 1].is_ascii_digit())
}

/// The end of a date that starts at `at`, if one does.
fn date_at(text: &[char], at: usize) -> Option<usize> {
    let first = text[at];
    let before = if at == 0 { None } else { Some(text[at - 1]) };
    if first.is_ascii_digit() && before.is_none_or(|c| !is_word(c)) {
        if let Some((a, i)) = digits(text, at, 1, 4) {
            if i - at == 4 {
                // 2026-10-08 (and a timestamp), 2026/10/08, 2026-Oct-08, 2026.10.08
                if i < text.len() && text[i] == '-' {
                    if let Some((m, j)) = digits(text, i + 1, 2, 2) {
                        if j < text.len() && text[j] == '-' {
                            if let Some((d, k)) = digits(text, j + 1, 2, 2) {
                                if iso_end_ok(text, k) && calendar_day(a, m, d) {
                                    return Some(k);
                                }
                            }
                        }
                    }
                    if let Some((m, j)) = month_at(text, i + 1) {
                        if j < text.len() && text[j] == '-' {
                            if let Some((d, k)) = digits(text, j + 1, 1, 2) {
                                if not_word_after(text, k) && calendar_day(a, m, d) {
                                    return Some(k);
                                }
                            }
                        }
                    }
                }
                for separator in ['/', '.'] {
                    if i < text.len() && text[i] == separator {
                        if let Some((m, j)) = digits(text, i + 1, 1, 2) {
                            if j < text.len() && text[j] == separator {
                                if let Some((d, k)) = digits(text, j + 1, 1, 2) {
                                    if not_word_after(text, k) && calendar_day(a, m, d) {
                                        return Some(k);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        // 20261008, and 20261008074500: eight digits that read as a day; a time may follow
        if before.is_none_or(|c| !is_word(c)) {
            if let Some((_, end)) = digits(text, at, 8, 8) {
                let year = digits(text, at, 4, 4).map(|(y, _)| y).unwrap_or(0);
                let month = digits(text, at + 4, 2, 2).map(|(m, _)| m).unwrap_or(0);
                let day = digits(text, at + 6, 2, 2).map(|(d, _)| d).unwrap_or(0);
                let rest = text[end..]
                    .iter()
                    .take_while(|c| c.is_ascii_digit())
                    .count();
                if (1900..=2099).contains(&year)
                    && (rest == 0 || rest == 4 || rest == 6)
                    && calendar_day(year, month, day)
                {
                    return Some(end);
                }
            }
        }
        if let Some((day, i)) = day_at(text, at) {
            // 8 October 2026, 17-Apr-1961, 1er mars 1958, 8th of October 2026
            let mut j = i;
            if text[j..].starts_with(&[' ', 'o', 'f']) {
                j += 3;
            }
            if j < text.len() && (text[j] == ' ' || text[j] == '-') {
                if let Some((month, k)) = month_at(text, j + 1) {
                    let after = skip(text, k, &[' ', ',', '-']);
                    if let Some((year, end)) = year_at(text, after) {
                        if calendar_day(year, month, day) {
                            return Some(end);
                        }
                    }
                    // 8 October, le 8 octobre: no year (not the lower-case word "may"). When a
                    // year follows, the with-year form decided (and an impossible day is no date).
                    if year_at(text, after).is_none()
                        && (k >= text.len() || !text[k].is_alphanumeric())
                        && month != 5
                        && calendar_day(2000, month, day)
                        && j < text.len()
                        && text[j] == ' '
                    {
                        return Some(k);
                    }
                }
            }
            // 08/10/2026, 10.08.2026 or 08-10-2026
            let i = digits(text, at, 1, 2).map(|(_, e)| e)?;
            let is_separator = |c: char| c == '/' || c == '.' || c == '-';
            if i < text.len() && is_separator(text[i]) {
                if let Some((b, j)) = digits(text, i + 1, 1, 2) {
                    if j < text.len() && is_separator(text[j]) {
                        if let Some((year, end)) = year_at(text, j + 1) {
                            if numeric_date(day, b, year) {
                                return Some(end);
                            }
                        }
                        // 08/10/26, slashes only, after a date label
                        if text[i] == '/' && text[j] == '/' {
                            if let Some((yy, end)) = digits(text, j + 1, 2, 2) {
                                if (end == text.len() || !is_word(text[end]))
                                    && after_date_label(text, at)
                                    && numeric_date(day, b, 2000 + yy)
                                {
                                    return Some(end);
                                }
                            }
                        }
                    }
                }
            }
        }
        return None;
    }
    if first.is_alphabetic() && before.is_none_or(|c| !c.is_alphabetic()) {
        if let Some((month, i)) = month_at(text, at) {
            // October 8, 2026 and Oct. 8th 2026
            if i < text.len() && text[i] == ' ' {
                if let Some((day, j)) = digits(text, i + 1, 1, 2) {
                    let mut k = ordinal(text, j);
                    let day_end = k;
                    if k < text.len() && text[k] == ',' {
                        k += 1;
                    }
                    if k < text.len() && text[k] == ' ' {
                        if let Some((year, end)) = year_at(text, k + 1) {
                            if calendar_day(year, month, day) {
                                return Some(end);
                            }
                        }
                    }
                    // Oct 8, Oct 8th: no year (not the lower-case word "may"). When a year
                    // follows, the with-year form decided.
                    let year_follows = {
                        let mut y = day_end;
                        if y < text.len() && text[y] == ',' {
                            y += 1;
                        }
                        y < text.len() && text[y] == ' ' && year_at(text, y + 1).is_some()
                    };
                    if !year_follows
                        && month != 5
                        && calendar_day(2000, month, day)
                        && !before.is_some_and(|c| c.is_ascii_digit())
                        && (day_end >= text.len() || !text[day_end].is_alphanumeric())
                    {
                        return Some(day_end);
                    }
                }
            }
            // October 2026: not after a digit or a digit and a space or hyphen
            let after_digit = before.is_some_and(|c| c.is_ascii_digit())
                || (at >= 2
                    && (text[at - 1] == ' ' || text[at - 1] == '-')
                    && text[at - 2].is_ascii_digit());
            if !after_digit {
                let mut k = i;
                while k < text.len() && (text[k] == ' ' || text[k] == ',') {
                    k += 1;
                }
                if k > i {
                    if let Some((_, end)) = year_at(text, k) {
                        return Some(end);
                    }
                }
            }
        }
        // A year alone after a cue: "in 2019", "depuis 2019"
        for cue in YEAR_CUES {
            let cue: Vec<char> = cue.chars().collect();
            if text[at..].starts_with(&cue) {
                let mut k = at + cue.len();
                let spaced = k;
                while k < text.len() && (text[k] == ' ' || text[k] == '\t') {
                    k += 1;
                }
                if k > spaced && k + 4 <= text.len() {
                    let century = (text[k] == '1' && text[k + 1] == '9')
                        || (text[k] == '2' && text[k + 1] == '0');
                    if century {
                        if let Some((_, end)) = year_at(text, k) {
                            return Some(end);
                        }
                    }
                }
            }
        }
    }
    None
}

/// The dates still standing in `text`, as ranges of it: a whole date, a month
/// and year, or a year after a cue word, in the forms the remover reads.
pub(crate) fn date_hits(text: &str) -> Vec<Hit> {
    let folded = fold(text);
    let characters = &folded.characters;
    let mut hits = Vec::new();
    let mut at = 0;
    while at < characters.len() {
        if let Some(end) = date_at(characters, at) {
            hits.push(Hit {
                start: folded.ranges[at].0,
                end: folded.ranges[end - 1].1,
            });
            at = end;
        } else {
            at += 1;
        }
    }
    hits
}

/// The vault's identifiers still standing in `text`, as ranges of it.
pub(crate) fn identifier_hits(text: &str, names: &[String], birth_dates: &[String]) -> Vec<Hit> {
    let folded = fold(text);
    let mut hits = Vec::new();
    for name in names {
        for form in name_forms(name) {
            find_all(&folded, &form, &mut hits);
        }
    }
    for date in birth_dates {
        for form in date_forms(date) {
            find_all(&folded, &form, &mut hits);
        }
    }
    hits.sort_by_key(|hit| (hit.start, hit.end));
    // Overlapping hits become one range.
    let mut merged: Vec<Hit> = Vec::new();
    for hit in hits {
        match merged.last_mut() {
            Some(last) if hit.start <= last.end => last.end = last.end.max(hit.end),
            _ => merged.push(hit),
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ranges(hits: &[Hit]) -> Vec<(u32, u32)> {
        hits.iter().map(|hit| (hit.start, hit.end)).collect()
    }

    #[test]
    fn refuses_code_points_the_cleaning_drops_or_replaces() {
        let text = "ok\u{200b}\u{ad}x\u{e000}\u{10ffff}y\u{e0041}";
        assert_eq!(
            ranges(&forbidden_ranges(text)),
            vec![(2, 4), (5, 8), (9, 11)]
        );
        assert!(forbidden_ranges("plain \u{fffd} text ≥ 10⁹/L").is_empty());
    }

    #[test]
    fn finds_a_vault_name_whole_by_parts_in_any_order_and_case() {
        let names = vec!["Renée Côté".to_owned(), "Avery Example".to_owned()];
        let text = "COTE, Renee; cоté (look-alike o); Example Avery; avery; Cot; example.";
        let hits = identifier_hits(text, &names, &[]);
        let found: Vec<&str> = hits
            .iter()
            .map(|hit| {
                let units: Vec<u16> = text.encode_utf16().collect();
                String::from_utf16(&units[hit.start as usize..hit.end as usize]).unwrap()
            })
            .map(|s| Box::leak(s.into_boxed_str()) as &str)
            .collect();
        assert_eq!(
            found,
            vec!["COTE, Renee", "cоté", "Example Avery", "avery", "example"]
        );
    }

    #[test]
    fn leaves_short_parts_common_words_and_relationship_words_alone() {
        let names = vec![
            "Jo Major".to_owned(),
            "Mom".to_owned(),
            "Pat Graves".to_owned(),
        ];
        assert!(identifier_hits("Jo, Mom and the major issue.", &names, &[]).is_empty());
        // A whole name still counts, and so does a part that is a disease.
        assert_eq!(identifier_hits("Jo Major came.", &names, &[]).len(), 1);
        assert_eq!(identifier_hits("Graves disease", &names, &[]).len(), 1);
    }

    #[test]
    fn finds_a_birth_date_in_the_forms_the_remover_reads() {
        let dates = vec!["1961-04-17".to_owned()];
        for text in [
            "DOB 1961-04-17",
            "17/04/1961",
            "04/17/61",
            "17 April 1961",
            "Apr. 17, 1961",
            "17-Apr-1961",
            "le 17 avril 1961",
            "2026-04-17 is not it",
        ] {
            let hits = identifier_hits(text, &[], &dates);
            assert_eq!(hits.len(), usize::from(!text.ends_with("not it")), "{text}");
        }
        assert!(identifier_hits("117/04/1961", &[], &dates).is_empty());
    }

    #[test]
    fn finds_a_han_name_inside_running_text() {
        let names = vec!["王小明".to_owned()];
        let hits = identifier_hits("他的妻子王小明陪同；小明在场。", &names, &[]);
        assert_eq!(ranges(&hits), vec![(4, 7), (10, 12)]);
    }

    #[test]
    fn reports_utf16_ranges_past_a_supplementary_character() {
        let names = vec!["Avery".to_owned()];
        let hits = identifier_hits("😀 Avery", &names, &[]);
        assert_eq!(ranges(&hits), vec![(3, 8)]);
    }

    #[test]
    fn date_hits_agree_with_the_remover_on_the_shared_cases() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../src/deidentify/fixtures/date-forms.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let text = case["text"].as_str().unwrap();
            let expected = case["date"].as_bool().unwrap();
            assert_eq!(!date_hits(text).is_empty(), expected, "{text}");
        }
    }

    #[test]
    fn date_hits_cover_the_whole_date_and_count_utf16_units() {
        let hits = date_hits("😀 Seen 8 October 2026 at 07:40.");
        assert_eq!(ranges(&hits), vec![(8, 22)]);
        assert!(date_hits("[DATE 2, 14 days after DATE 1]").is_empty());
    }
}

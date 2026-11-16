//! Evaluation candidate (16 Nov 2026): the document trim. Before the helper fits the pages, whole
//! administrative lines leave the letter, so the model reads fewer tokens of a faxed or printed
//! copy. Only fixed line shapes go:
//! - a fax transmission line: it starts with a date and a time and ends with a page counter
//!   ("P.2/3", "STR. 1/2");
//! - a page counter on its own ("Page 1 of 3", "Page 1 de 2", "Strona 1 z 2", with "CONFIDENTIAL"
//!   or a print stamp) and a report marker ("*** FINAL REPORT ***");
//! - a print or copy footer ("… copy · printed <date> <time> by <id> · <organization> ·
//!   CONFIDENTIAL");
//! - a fax cover title, a page-count field, and a "From:" field naming no doctor;
//! - a confidentiality notice about a misdirected fax (its whole paragraph, at most 4 lines);
//! - a dictation or transcription stamp ("Dictated but not read", "D: … T: …", "Job …").
//!
//! A line naming a patient ("Re:", "Patient:", "DOB:", "MRN:") never goes. A fax line, a footer
//! or a "From:" field goes only if every name word in it (4 letters or more) also starts a word
//! of a line that stays (Ben, 16 Nov): a hospital or clinic named only there keeps its line.
//! Nothing else is touched: no letterhead, test banner, closing, name, date field or clinical
//! line, however often it repeats. A trimmed page keeps its other lines, in order.
//!
//! Pure std, so its tests run on their own: `rustc --edition 2021 --test src/document_trim.rs`.
//! The cases are shared with the evaluation's Python port (`document_trim_cases.txt`).

/// The trim's name in a measurement.
#[allow(dead_code)]
pub(crate) const NAME: &str = "document-trim-1";

/// Words that never name an organization in these lines.
const ADMIN: &[&str] = &[
    "fax",
    "faks",
    "from",
    "page",
    "pages",
    "health",
    "records",
    "record",
    "copy",
    "printed",
    "confidential",
    "department",
];

/// The letter's pages with the administrative lines taken out (same number of pages).
pub(crate) fn trim(pages: &[&str]) -> Vec<String> {
    let lines: Vec<(usize, &str)> = pages
        .iter()
        .enumerate()
        .flat_map(|(page, text)| text.split('\n').map(move |line| (page, line)))
        .collect();
    let texts: Vec<&str> = lines.iter().map(|(_, line)| *line).collect();
    let found = candidates(&texts);
    let kept_words: Vec<String> = texts
        .iter()
        .enumerate()
        .filter(|(index, _)| !found.iter().any(|(at, _)| at == index))
        .flat_map(|(_, line)| words(line))
        .collect();
    let mut out = vec![Vec::new(); pages.len()];
    for (index, (page, line)) in lines.iter().enumerate() {
        let drop = found.iter().any(|(at, names)| {
            *at == index
                && names
                    .as_ref()
                    .is_none_or(|text| named_elsewhere(text, &kept_words))
        });
        if !drop {
            out[*page].push(*line);
        }
    }
    out.into_iter().map(|kept| kept.join("\n")).collect()
}

/// Lines with a fixed shape, before the name check: (line, the text whose names must be found
/// elsewhere, or `None` when the line goes as it is).
fn candidates(lines: &[&str]) -> Vec<(usize, Option<String>)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if notice_start(line) {
            let mut end = i;
            while end < lines.len() && !lines[end].trim().is_empty() && end - i < 4 {
                end += 1;
            }
            let paragraph = lines[i..end].join(" ");
            let folded = fold(&paragraph);
            if ["in error", "par erreur", "by mistake"]
                .iter()
                .any(|marker| folded.contains(marker))
                && !names_a_patient(&paragraph)
            {
                out.extend((i..end).map(|at| (at, None)));
                i = end;
                continue;
            }
        }
        if names_a_patient(line) {
            i += 1;
            continue;
        }
        if fax_line(line) {
            out.push((i, Some(line.to_owned())));
        } else if page_line(line)
            || marker_line(line)
            || cover_title(line)
            || pages_field(line)
            || stamp_line(line)
        {
            out.push((i, None));
        } else if let Some(who) = from_field(line) {
            if !names_a_doctor(&who) {
                out.push((i, Some(who)));
            }
        } else if let Some(names) = footer(line) {
            out.push((i, Some(names)));
        }
        i += 1;
    }
    out
}

// --- Words ----------------------------------------------------------------------------------

/// Lower case, accents dropped (letters that decompose to a base letter and marks), and the OCR
/// swaps 0→o and 1→l inside a word that has letters ("C0MMUNITY", "Hospita1").
fn fold(text: &str) -> String {
    const FROM: &str = "àáâãäåçèéêëìíîïñòóôõöùúûüýÿąćęńśźż";
    const TO: &str = "aaaaaaceeeeiiiinooooouuuuyyacenszz";
    let lower = text.to_lowercase();
    let mapped: String = lower
        .chars()
        .map(|c| {
            FROM.chars()
                .position(|f| f == c)
                .map_or(c, |at| TO.chars().nth(at).unwrap())
        })
        .collect();
    mapped
        .split_inclusive(|c: char| !c.is_alphanumeric())
        .map(|piece| {
            let word: String = piece.chars().filter(|c| c.is_alphanumeric()).collect();
            let has_letter = word.chars().any(char::is_alphabetic);
            let has_digit = word.chars().any(|c| c.is_ascii_digit());
            if has_letter && has_digit {
                piece.replace('0', "o").replace('1', "l")
            } else {
                piece.to_owned()
            }
        })
        .collect()
}

/// The folded words (letters and digits) of a text.
fn words(text: &str) -> Vec<String> {
    fold(text)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Every name word (4 letters or more, not a number, not an administrative word) starts a word
/// of a line that stays.
fn named_elsewhere(text: &str, kept_words: &[String]) -> bool {
    words(text)
        .iter()
        .filter(|word| {
            word.chars().count() >= 4
                && !word.chars().all(|c| c.is_ascii_digit())
                && !ADMIN.contains(&word.as_str())
        })
        .all(|word| {
            kept_words
                .iter()
                .any(|kept| kept.starts_with(word.as_str()))
        })
}

/// "Re:", "Patient:", "DOB:", "MRN:" and the like: the line is about a patient.
fn names_a_patient(line: &str) -> bool {
    const LABELS: &[&str] = &[
        "re", "patient", "patiente", "pacjent", "dob", "mrn", "name", "nom",
    ];
    let folded = fold(line);
    let chars: Vec<char> = folded.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_alphanumeric() && (i == 0 || !chars[i - 1].is_alphanumeric()) {
            let start = i;
            while i < chars.len() && chars[i].is_alphanumeric() {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            let mut after = i;
            while after < chars.len() && chars[after] == ' ' {
                after += 1;
            }
            if LABELS.contains(&word.as_str()) && chars.get(after) == Some(&':') {
                return true;
            }
        } else {
            i += 1;
        }
    }
    false
}

fn names_a_doctor(text: &str) -> bool {
    const TITLES: &[&str] = &["dr", "dre", "doctor", "docteur", "md", "lek", "prof"];
    words(text)
        .iter()
        .any(|word| TITLES.contains(&word.as_str()))
}

// --- Dates, times, counters -----------------------------------------------------------------

fn digits(text: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&text.len()) && text.chars().all(|c| c.is_ascii_digit())
}

fn letters(text: &str, count: usize) -> bool {
    text.chars().count() == count && text.chars().all(|c| c.is_ascii_alphabetic())
}

/// A date in one token ("2026-10-20", "19/10/2026", "28-Oct-2026", "OCT-19-2026").
fn date_token(token: &str) -> bool {
    let parts: Vec<&str> = token.split(['-', '/', '.']).collect();
    if parts.len() != 3 {
        return false;
    }
    (token.matches('-').count() == 2
        && digits(parts[0], 4, 4)
        && digits(parts[1], 2, 2)
        && digits(parts[2], 2, 2))
        || (digits(parts[0], 1, 2) && digits(parts[1], 1, 2) && digits(parts[2], 2, 4))
        || (digits(parts[0], 1, 2) && letters(parts[1], 3) && digits(parts[2], 4, 4))
        || (letters(parts[0], 3) && digits(parts[1], 1, 2) && digits(parts[2], 4, 4))
}

/// How many tokens a date at `at` takes: 1 ("2026-10-20") or 3 ("OCT 28 2026", "Oct 28, 2026").
fn date_at(tokens: &[&str], at: usize) -> Option<usize> {
    let token = tokens.get(at)?;
    if date_token(token) {
        return Some(1);
    }
    let day = tokens.get(at + 1)?.trim_end_matches(',');
    let year = tokens.get(at + 2)?;
    (letters(token, 3) && digits(day, 1, 2) && digits(year, 4, 4)).then_some(3)
}

fn time_token(token: &str) -> bool {
    token
        .split_once(':')
        .is_some_and(|(hours, minutes)| digits(hours, 1, 2) && digits(minutes, 2, 2))
}

/// "P.2/3", "P. 2/3", "STR. 1/2", "P.002/004" in the last tokens.
fn ends_with_counter(tokens: &[&str]) -> bool {
    (1..=4.min(tokens.len())).any(|k| {
        let tail: String = tokens[tokens.len() - k..].concat().to_lowercase();
        let rest = ["str", "p", "s"]
            .iter()
            .find_map(|marker| tail.strip_prefix(*marker))
            .map(|rest| rest.strip_prefix('.').unwrap_or(rest));
        rest.and_then(|rest| rest.split_once('/'))
            .is_some_and(|(page, of)| digits(page, 1, 3) && digits(of, 1, 3))
    })
}

// --- Line shapes ----------------------------------------------------------------------------

fn fax_line(line: &str) -> bool {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    date_at(&tokens, 0).is_some_and(|n| {
        tokens.get(n).is_some_and(|token| time_token(token)) && ends_with_counter(&tokens[n + 1..])
    })
}

/// "Page 2 of 3" from `at`: the number of tokens it takes.
fn page_words_at(tokens: &[&str], at: usize) -> Option<usize> {
    const PAGE: &[&str] = &["page", "strona", "pagina", "seite"];
    const OF: &[&str] = &["of", "de", "z", "von", "di", "sur"];
    let word = |i: usize| tokens.get(at + i).map(|token| fold(token));
    (word(0).is_some_and(|w| PAGE.contains(&w.as_str()))
        && tokens.get(at + 1).is_some_and(|t| digits(t, 1, 4))
        && word(2).is_some_and(|w| OF.contains(&w.as_str()))
        && tokens.get(at + 3).is_some_and(|t| digits(t, 1, 4)))
    .then_some(4)
}

fn page_line(line: &str) -> bool {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let mut at = 0;
    if tokens.first().is_some_and(|t| fold(t) == "confidential") {
        at = 1;
        if tokens.get(1).is_some_and(|t| ["·", ":", "-"].contains(t)) {
            at = 2;
        }
    }
    let Some(n) = page_words_at(&tokens, at) else {
        return false;
    };
    at += n;
    if at == tokens.len() {
        return true;
    }
    // "Page 1 of 3   Printed 2026-10-20 15:12 by FAKE-CLERK"
    printed_at(&tokens, at) == Some(tokens.len())
}

/// "printed <date> <time> by <id>" from `at`: the index after it.
fn printed_at(tokens: &[&str], at: usize) -> Option<usize> {
    if fold(tokens.get(at)?) != "printed" {
        return None;
    }
    let n = date_at(tokens, at + 1)?;
    let time = at + 1 + n;
    (time_token(tokens.get(time)?)
        && fold(tokens.get(time + 1)?) == "by"
        && tokens.get(time + 2).is_some())
    .then_some(time + 3)
}

fn marker_line(line: &str) -> bool {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let stars = |t: &&str| t.len() >= 2 && t.chars().all(|c| c == '*');
    if !tokens.first().is_some_and(stars) {
        return false;
    }
    let inner: Vec<String> = tokens[1..].iter().map(|t| fold(t)).collect();
    let starts = |words: &[&str]| {
        inner.len() >= words.len() && inner.iter().zip(words).all(|(t, w)| t.as_str() == *w)
    };
    let after = if starts(&["final", "report"]) {
        3
    } else if starts(&["end", "of", "report"]) {
        4
    } else {
        return false;
    };
    tokens.get(after).is_some_and(stars)
        && (after + 1 == tokens.len()
            || page_words_at(&tokens, after + 1) == Some(tokens.len() - after - 1))
}

fn cover_title(line: &str) -> bool {
    let folded = fold(line.trim());
    if [
        "fax cover sheet",
        "bordereau de telecopie",
        "fax transmittal",
    ]
    .contains(&folded.as_str())
    {
        return true;
    }
    // "FAX — ONE REFERRAL ENCLOSED"
    folded
        .strip_prefix("fax")
        .map(str::trim_start)
        .and_then(|rest| rest.strip_prefix(['—', '–', '-']))
        .is_some_and(|rest| rest.ends_with("enclosed") && rest.chars().count() <= 50)
}

fn pages_field(line: &str) -> bool {
    let Some((label, value)) = line.rsplit_once(':') else {
        return false;
    };
    let label = fold(label.trim());
    digits(value.trim(), 1, 3)
        && (label.starts_with("pages (including")
            || label.starts_with("page (including")
            || label.starts_with("pages (incl")
            || label == "pages including cover"
            || label.starts_with("nombre de pages"))
}

/// "From: <who>   Fax: <number>": who, when the line has that shape.
fn from_field(line: &str) -> Option<String> {
    let (label, rest) = line.trim_start().split_once(':')?;
    if !["from", "expediteur", "od"].contains(&fold(label.trim()).as_str()) {
        return None;
    }
    for marker in ["fax", "telec.", "telec", "faks"] {
        let folded = fold(rest);
        let Some(at) = folded.rfind(marker) else {
            continue;
        };
        // Folding keeps the char count; find the same place in the original text.
        let start: usize = rest
            .char_indices()
            .nth(folded[..at].chars().count())
            .map(|(i, _)| i)?;
        let who = &rest[..start];
        let after = rest[start..]
            .chars()
            .skip(marker.chars().count())
            .collect::<String>();
        let Some(number) = after.trim_start().strip_prefix(':') else {
            continue;
        };
        if who.ends_with("  ")
            && !who.trim().is_empty()
            && !number.trim().is_empty()
            && number
                .chars()
                .all(|c| c.is_ascii_digit() || " ()+.-".contains(c))
        {
            return Some(who.trim().to_owned());
        }
    }
    None
}

/// "… copy · printed <date> <time> by <id> · <organization> · CONFIDENTIAL": the organization
/// parts, when the line has that shape.
fn footer(line: &str) -> Option<String> {
    let parts: Vec<&str> = line.split('·').map(str::trim).collect();
    if parts.len() < 2 {
        return None;
    }
    if !parts.iter().any(|part| printed_part(part)) {
        return None;
    }
    let rest: Vec<&str> = parts
        .iter()
        .copied()
        .filter(|part| {
            let folded = fold(part);
            !printed_part(part)
                && !["copy", "health records copy", "confidential"].contains(&folded.as_str())
        })
        .collect();
    let clean = |part: &&str| {
        !part.contains(':')
            && !part
                .as_bytes()
                .windows(2)
                .any(|pair| pair[0].is_ascii_digit() && pair[1].is_ascii_digit())
    };
    rest.iter().all(clean).then(|| rest.join(" "))
}

/// "printed <date> <time> by <id>" and nothing else.
fn printed_part(part: &str) -> bool {
    let tokens: Vec<&str> = part.split_whitespace().collect();
    printed_at(&tokens, 0) == Some(tokens.len())
}

fn stamp_line(line: &str) -> bool {
    let tokens: Vec<String> = line
        .split_whitespace()
        .map(|t| fold(t).trim_end_matches(['.', ',']).to_owned())
        .collect();
    let raw: Vec<&str> = line.split_whitespace().collect();
    if tokens.is_empty() {
        return false;
    }
    let phrase = |at: usize, words: &[&str]| {
        (tokens.len() >= at + words.len()
            && tokens[at..at + words.len()]
                .iter()
                .zip(words)
                .all(|(t, w)| t.as_str() == *w))
        .then_some(at + words.len())
    };
    let mut at = 0;
    while at < tokens.len() {
        let next = phrase(at, &["dictated", "but", "not", "read"])
            .or_else(|| phrase(at, &["signed", "electronically", "to", "avoid", "delay"]))
            .or_else(|| phrase(at, &["dicte", "mais", "non", "relu"]))
            .or_else(|| {
                phrase(
                    at,
                    &[
                        "dokument",
                        "dyktowany",
                        "nieprzeczytany",
                        "przez",
                        "lekarza",
                    ],
                )
            })
            .or_else(|| {
                // "D: <date> <time>" and "T: <date> <time>"
                (["d:", "t:"].contains(&fold(raw[at]).as_str()))
                    .then(|| date_at(&raw, at + 1))
                    .flatten()
                    .and_then(|n| {
                        raw.get(at + 1 + n)
                            .is_some_and(|t| time_token(t))
                            .then_some(at + 2 + n)
                    })
            })
            .or_else(|| (tokens[at] == "job" && at + 1 < tokens.len()).then_some(at + 2))
            .or_else(|| {
                // "Transcribed <date> by <id>"
                (tokens[at] == "transcribed")
                    .then(|| date_at(&raw, at + 1))
                    .flatten()
                    .and_then(|n| {
                        (tokens.get(at + 1 + n).map(String::as_str) == Some("by")
                            && at + 2 + n < tokens.len())
                        .then_some(at + 3 + n)
                    })
            });
        match next {
            Some(next) => at = next,
            None => return false,
        }
    }
    true
}

fn notice_start(line: &str) -> bool {
    let folded = fold(line.trim_start());
    [
        "confidentiality notice",
        "avis de confidentialit",
        "this fax is confidential",
        "this message is confidential",
        "this document is confidential",
    ]
    .iter()
    .any(|start| folded.starts_with(start))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CASES: &str = include_str!("document_trim_cases.txt");

    fn case(name: &str) -> (Vec<String>, Vec<String>) {
        for block in CASES.split("\n===\n").skip(1) {
            let (first, body) = block.split_once('\n').unwrap();
            if first.strip_prefix("name: ") != Some(name) {
                continue;
            }
            let body = body.strip_prefix("input:\n").expect("input:");
            let (input, expect) = body.split_once("\nexpect:\n").expect("expect:");
            let pages = |text: &str| text.split("\n<<page>>\n").map(str::to_owned).collect();
            return (pages(input), pages(expect.trim_end_matches('\n')));
        }
        panic!("no case {name}");
    }

    fn check(name: &str) {
        let (input, expect) = case(name);
        let pages: Vec<&str> = input.iter().map(String::as_str).collect();
        let got = trim(&pages);
        assert_eq!(got, expect, "{name}");
        let again: Vec<&str> = got.iter().map(String::as_str).collect();
        assert_eq!(trim(&again), got, "{name}: not stable on a second run");
    }

    #[test]
    fn every_shared_case_has_a_test_below() {
        let me = include_str!("document_trim.rs");
        for name in CASES
            .split("\n===\n")
            .skip(1)
            .filter_map(|b| b.lines().next()?.strip_prefix("name: "))
        {
            assert!(me.contains(&format!("check(\"{name}\")")), "{name}");
        }
    }

    #[test]
    fn given_a_fax_line_whose_sender_is_named_elsewhere_when_trimmed_then_it_goes() {
        check("a_fax_transmission_line_goes_when_its_sender_is_named_in_a_kept_line");
    }

    #[test]
    fn given_a_fax_line_that_is_the_sole_mention_of_its_sender_when_trimmed_then_it_stays() {
        check("a_fax_transmission_line_stays_when_it_is_the_only_mention_of_its_sender");
    }

    #[test]
    fn given_a_fax_line_with_digit_swaps_and_no_from_marker_when_trimmed_then_it_goes() {
        check("a_fax_line_without_a_from_marker_and_with_digit_swaps_still_matches");
    }

    #[test]
    fn given_a_polish_fax_line_when_trimmed_then_it_goes() {
        check("a_polish_fax_line_goes");
    }

    #[test]
    fn given_a_fax_line_naming_a_patient_when_trimmed_then_it_stays() {
        check("a_fax_line_naming_a_patient_stays");
    }

    #[test]
    fn given_page_counters_in_several_languages_when_trimmed_then_they_go() {
        check("page_counters_go_in_any_of_the_languages");
    }

    #[test]
    fn given_a_page_counter_inside_a_sentence_when_trimmed_then_it_stays() {
        check("a_page_counter_inside_a_sentence_stays");
    }

    #[test]
    fn given_print_footers_whose_hospital_is_named_elsewhere_when_trimmed_then_they_go() {
        check("a_print_footer_goes_when_its_organization_is_named_in_a_kept_line");
    }

    #[test]
    fn given_a_print_footer_that_is_the_sole_mention_of_its_hospital_when_trimmed_then_it_stays() {
        check("a_print_footer_stays_when_it_is_the_only_mention_of_its_hospital");
    }

    #[test]
    fn given_a_fax_cover_sheet_when_trimmed_then_only_its_nameless_and_dateless_fields_go() {
        check("fax_cover_fields_without_a_name_go_and_fields_with_a_name_or_a_date_stay");
    }

    #[test]
    fn given_a_from_field_naming_a_doctor_when_trimmed_then_it_stays() {
        check("a_from_field_naming_a_doctor_stays");
    }

    #[test]
    fn given_confidentiality_notices_when_trimmed_then_their_paragraphs_go() {
        check("a_confidentiality_notice_goes_whole_in_english_and_french");
    }

    #[test]
    fn given_a_sentence_about_confidentiality_when_trimmed_then_it_stays() {
        check("a_sentence_about_confidentiality_without_a_misdirected_fax_stays");
    }

    #[test]
    fn given_dictation_stamps_when_trimmed_then_they_go_and_the_signature_stays() {
        check("dictation_stamps_go");
    }

    #[test]
    fn given_report_markers_when_trimmed_then_they_go() {
        check("report_markers_go");
    }

    #[test]
    fn given_a_clean_letter_when_trimmed_then_it_is_unchanged() {
        check("a_clean_letter_is_left_exactly_as_it_is");
    }

    #[test]
    fn given_no_pages_or_an_empty_page_when_trimmed_then_the_pages_are_kept() {
        assert!(trim(&[]).is_empty());
        assert_eq!(trim(&[""]), vec![String::new()]);
        assert_eq!(trim(&["a", "", "b"]), vec!["a", "", "b"]);
    }

    /// The evaluation's clean letters (the 30 in the repository's harness, which hold the hard 10)
    /// come out byte for byte the same, so every frozen fact and anchor in them is still there.
    /// Compiled by cargo only: it reads the harness with serde_json (the standalone `rustc --test`
    /// run has no features, so it leaves this module out).
    #[cfg(feature = "default")]
    mod harness_letters {
        use super::super::trim;
        use std::path::Path;

        fn pages(document: &serde_json::Value) -> Vec<String> {
            document["pages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|page| page["text"].as_str().unwrap().to_owned())
                .collect()
        }

        fn letters() -> Vec<(String, Vec<String>, serde_json::Value)> {
            let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/summary-evaluation");
            let mut out = Vec::new();
            let mut paths: Vec<_> = std::fs::read_dir(root.join("harness/documents"))
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| path.extension().is_some_and(|e| e == "json"))
                .collect();
            paths.sort();
            for path in paths {
                let document: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
                out.push((
                    document["id"].as_str().unwrap().to_owned(),
                    pages(&document),
                    document["facts"].clone(),
                ));
            }
            let fixtures: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(root.join("fixtures.json")).unwrap())
                    .unwrap();
            for case in fixtures["cases"].as_array().unwrap() {
                out.push((
                    case["case_id"].as_str().unwrap().to_owned(),
                    pages(case),
                    case["facts"].clone(),
                ));
            }
            out
        }

        #[test]
        fn given_the_thirty_clean_harness_letters_when_trimmed_then_each_is_unchanged_and_keeps_its_facts(
        ) {
            let letters = letters();
            assert_eq!(letters.len(), 30);
            for (id, pages, facts) in letters {
                let input: Vec<&str> = pages.iter().map(String::as_str).collect();
                let got = trim(&input);
                assert_eq!(got, pages, "{id}: a clean letter changed");
                let joined = got.join("\n\n");
                let collapse = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
                for fact in facts.as_array().unwrap() {
                    if let Some(evidence) = fact["source_evidence"].as_str() {
                        if collapse(&pages.join("\n\n")).contains(&collapse(evidence)) {
                            assert!(
                                collapse(&joined).contains(&collapse(evidence)),
                                "{id}: {evidence}"
                            );
                        }
                    }
                    for anchor in fact["anchors"].as_array().into_iter().flatten() {
                        let anchor = anchor.as_str().unwrap().to_lowercase();
                        if pages.join("\n\n").to_lowercase().contains(&anchor) {
                            assert!(
                                joined.to_lowercase().contains(&anchor),
                                "{id}: anchor {anchor}"
                            );
                        }
                    }
                }
            }
        }
    }
}

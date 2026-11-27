//! Where a model's quote is in the pages, matched exactly as the reader matches it
//! (`src/ai/locateQuote.ts`).
//!
//! The runner's gate (a quote the pages do not contain is emptied), the addressee step and the
//! safety checks all look a quote up. When they matched it by a stricter rule than the reader,
//! a quote the reader would have linked was thrown away first and the sentence showed "No source
//! found" (a real PDF's "conﬁrmed" with its ligature, "oﬃce", "µg" against "μg", a comma the PDF
//! put at the start of the next line). They now share this one rule, and its twin in
//! `locateQuote.ts` must change with it:
//!
//! - Both texts are folded one character at a time: any white space is one space; curly and
//!   corner quotes are straight ones; every other character is decomposed (NFKD: a ligature
//!   becomes its letters, a micro sign the Greek mu, a full-width digit its digit), lower-cased,
//!   and stripped of combining marks (accents). A space right before a comma is dropped, since a
//!   PDF's text often puts the comma of a wrapped line at the start of the next one.
//! - A quote is cut at each "..." or "…" into parts. Each part is folded and trimmed of spaces,
//!   quote marks and `.,;:` at its ends, and the parts must be found in the text in that order,
//!   each after the end of the one before. Text between two parts is allowed; text between two
//!   words inside one part is not (white space aside).
//! - A part has to be worth finding: at least [`MIN_CHARACTERS`] characters (UTF-16 units, as the
//!   reader counts them) or [`MIN_WORDS`] words (a run of letters or digits, or one Chinese,
//!   Japanese or Korean character), so that "mg" or "the right" cannot link to any page. **The
//!   one place this module is looser than the reader:** a quote of a single part is found
//!   whatever its length ("Non-smoker", a short Korean sentence), as the runner's gate has always
//!   kept the short findings of a letter so that their sentences still get the addressee and
//!   safety steps (the reader shows such a sentence without a link). Every part of a quote of
//!   several parts must be worth finding, as in the reader.
//!
//! The reader matches page by page and the runner joins the pages it read: [`find`] and
//! [`is_located`] take one text, and the caller decides whether that is one page or all of them.

use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

/// A part of a quote needs at least this many characters (as UTF-16 units) ...
const MIN_CHARACTERS: usize = 12;
/// ... or at least this many words.
const MIN_WORDS: usize = 3;

/// A text folded as the reader folds it, with the place of each folded byte in the original.
struct Folded {
    text: String,
    /// For each byte of `text`, where its source character starts and ends in the original.
    at: Vec<(usize, usize)>,
}

/// White space as the reader's `/\s/` sees it (a no-break space and the byte order mark count;
/// the next-line control, which Rust counts, does not).
fn is_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// The straight quote a curly or corner quote stands for.
fn straight_quote(c: char) -> Option<char> {
    match c {
        '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => Some('\''),
        '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{AB}' | '\u{BB}' | '\u{300C}' | '\u{300D}' => {
            Some('"')
        }
        _ => None,
    }
}

fn fold(original: &str) -> Folded {
    let mut text = String::with_capacity(original.len());
    let mut at: Vec<(usize, usize)> = Vec::with_capacity(original.len());
    for (start, c) in original.char_indices() {
        let end = start + c.len_utf8();
        let mut piece = String::new();
        if is_space(c) {
            piece.push(' ');
        } else if let Some(straight) = straight_quote(c) {
            piece.push(straight);
        } else {
            for decomposed in std::iter::once(c).nfkd() {
                for lower in decomposed.to_lowercase() {
                    if !is_combining_mark(lower) {
                        piece.push(lower);
                    }
                }
            }
        }
        if piece == " " && text.ends_with(' ') {
            continue;
        }
        if piece == "," && text.ends_with(' ') {
            text.pop();
            at.pop();
        }
        for _ in 0..piece.len() {
            at.push((start, end));
        }
        text.push_str(&piece);
    }
    Folded { text, at }
}

/// What a quote part may start or end with that is not part of it (after folding, so the quote
/// marks are straight ones).
fn trim_ends(text: &str) -> &str {
    text.trim_matches(|c: char| matches!(c, ' ' | '"' | '\'' | '.' | ',' | ';' | ':'))
}

/// The folded, trimmed parts of a quote, cut at "..." and "…"; empty parts are left out.
fn quote_parts(quote: &str) -> Vec<String> {
    quote
        .split("...")
        .flat_map(|part| part.split('\u{2026}'))
        .map(|part| trim_ends(&fold(part).text).to_owned())
        .filter(|part| !part.is_empty())
        .collect()
}

/// A line, folded and trimmed as a quote's part is (for comparing it with a quote that must be a
/// whole line).
pub(crate) fn folded_line(line: &str) -> String {
    trim_ends(&fold(line).text).to_owned()
}

/// The folded quote when it is one part, as a whole-line quote is; `None` for no part or for a
/// quote joined from several.
pub(crate) fn single_part(quote: &str) -> Option<String> {
    let mut parts = quote_parts(quote);
    if parts.len() == 1 {
        parts.pop()
    } else {
        None
    }
}

/// Whether one quote part is worth finding (see the module doc).
fn substantial(part: &str) -> bool {
    part.encode_utf16().count() >= MIN_CHARACTERS || words(part) >= MIN_WORDS
}

/// The words of a folded part as the reader counts them: a Chinese, Japanese or Korean character
/// is a word by itself unless it follows a letter or digit of the same run (the reader's pattern
/// starts a run only at a letter or digit that is not one of those, then takes every letter and
/// digit after it).
fn words(part: &str) -> usize {
    let mut count = 0;
    let mut in_run = false;
    for c in part.chars() {
        let letter_or_digit = (c.is_alphabetic() && !is_combining_mark(c)) || c.is_numeric();
        if in_run {
            in_run = letter_or_digit;
        } else if is_cjk(c) {
            count += 1;
        } else if letter_or_digit {
            count += 1;
            in_run = true;
        }
    }
    count
}

/// The main blocks of the Han, Hiragana, Katakana and Hangul scripts (the reader's
/// `\p{Script=…}`); after folding, compatibility forms and Hangul syllables are already
/// decomposed into these.
fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x1100..=0x11FF // Hangul Jamo
        | 0x2E80..=0x2FDF // CJK radicals
        | 0x3005 | 0x3007 | 0x3021..=0x3029 | 0x3038..=0x303B // Han marks
        | 0x3041..=0x3096 | 0x309D..=0x309F // Hiragana
        | 0x30A1..=0x30FA | 0x30FD..=0x30FF | 0x31F0..=0x31FF // Katakana
        | 0x3131..=0x318E // Hangul compatibility Jamo
        | 0x3400..=0x4DBF | 0x4E00..=0x9FFF // Han
        | 0xA960..=0xA97C | 0xD7B0..=0xD7FB // Hangul Jamo extensions
        | 0xF900..=0xFAFF // Han compatibility
        | 0x1B000..=0x1B16F // Kana supplement and extended
        | 0x20000..=0x323AF // Han extensions
    )
}

/// Each part, in order, found after the end of the one before; the range in the original text
/// from the start of the first part's first character to the end of the last part's last
/// character.
fn match_parts(folded: &Folded, parts: &[String]) -> Option<(usize, usize)> {
    let mut from = 0;
    let mut first = None;
    let mut last = 0;
    for part in parts {
        let found = from + folded.text[from..].find(part.as_str())?;
        if first.is_none() {
            first = Some(found);
        }
        last = found + part.len() - 1;
        from = found + part.len();
    }
    Some((folded.at[first?].0, folded.at[last].1))
}

/// The byte range of `quote` in `text`, matched as the reader matches it but without its length
/// rule: the addressee and safety steps look up quotes the gate already accepted and the
/// document's own sentences that the safety checks write, however short.
pub(crate) fn find(text: &str, quote: &str) -> Option<(usize, usize)> {
    let parts = quote_parts(quote);
    if parts.is_empty() {
        return None;
    }
    match_parts(&fold(text), &parts)
}

/// Whether `text` contains the quote as the reader's `locateQuote` finds it: all parts found in
/// order, and, for a quote of several parts, each worth finding (a quote of one part may be
/// short; see the module doc).
pub(crate) fn is_located(text: &str, quote: &str) -> bool {
    let parts = quote_parts(quote);
    if parts.is_empty() || (parts.len() > 1 && !parts.iter().all(|part| substantial(part))) {
        return false;
    }
    match_parts(&fold(text), &parts).is_some()
}

/// Whether the reader itself would link the quote: every part worth finding, even the only one.
#[cfg(test)]
pub(crate) fn reader_accepts(text: &str, quote: &str) -> bool {
    let parts = quote_parts(quote);
    !parts.is_empty()
        && parts.iter().all(|part| substantial(part))
        && match_parts(&fold(text), &parts).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    // A synthetic letter laid out as a PDF's text layer gives it: ligature characters, a comma
    // at the start of a wrapped line, a micro sign, and the Bloods line before the Diagnosis.
    const LETTER: &str = "Results\n\
        Bloods (3 November 2026): hemoglobin 101 g/L, ferritin 5 \u{b5}g/L, tissue\n\
        transglutaminase IgA 92 U/mL (normal below 15), vitamin D 41 nmol/L (low).\n\
        Diagnosis\n\
        Celiac disease, con\u{fb01}rmed by biopsy\n\
        , with iron de\u{fb01}ciency anemia from poor absorption\n\
        and a low vitamin D.\n\
        Plan\n\
        1. \n\
        A strict gluten-free diet, starting now.\n\
        4. \n\
        Referral to our clinic dietitian, Robin FAKE-Dietwell; the dietitian's o\u{fb03}ce\n\
        will call within 2\n\
        weeks.\n";

    fn quoted<'a>(text: &'a str, quote: &str) -> &'a str {
        let (start, end) = find(text, quote).unwrap_or_else(|| panic!("not found: {quote}"));
        &text[start..end]
    }

    #[test]
    fn a_ligature_in_the_letter_matches_the_letters_a_model_types() {
        assert!(is_located(LETTER, "Celiac disease, confirmed by biopsy"));
        assert!(is_located(
            LETTER,
            "iron deficiency anemia from poor absorption"
        ));
        // And the other way: the model copies the ligature, the text has the letters.
        assert!(is_located(
            "Celiac disease, confirmed by biopsy.",
            "Celiac disease, con\u{fb01}rmed by biopsy"
        ));
    }

    #[test]
    fn the_micro_sign_and_the_greek_mu_are_one_letter() {
        assert!(is_located(
            LETTER,
            "hemoglobin 101 g/L, ferritin 5 \u{3bc}g/L"
        ));
        assert!(is_located(
            LETTER,
            "hemoglobin 101 g/L, ferritin 5 \u{b5}g/L"
        ));
    }

    #[test]
    fn office_matches_the_ffi_ligature_and_a_curly_apostrophe_a_straight_one() {
        for quote in [
            "Referral to our clinic dietitian, Robin FAKE-Dietwell; the dietitian's office will call within 2 weeks.",
            "Referral to our clinic dietitian, Robin FAKE-Dietwell; the dietitian\u{2019}s o\u{fb03}ce will call within 2 weeks.",
            "the dietitian\u{2019}s office will call",
        ] {
            assert!(is_located(LETTER, quote), "{quote}");
        }
        // The letter's own curly apostrophe against a typed straight one.
        assert!(is_located(
            "She said the clinic\u{2019}s office will call.",
            "the clinic's office will call"
        ));
    }

    #[test]
    fn a_comma_that_the_pdf_put_at_the_start_of_the_next_line_still_follows_its_word() {
        // The letter has "biopsy\n, with": a space before the comma once folded.
        assert!(is_located(
            LETTER,
            "Celiac disease, confirmed by biopsy, with iron deficiency anemia"
        ));
        // A model that copies the stray space is found as well.
        assert!(is_located(
            LETTER,
            "Celiac disease, con\u{fb01}rmed by biopsy , with iron de\u{fb01}ciency anemia"
        ));
        assert!(is_located(
            "Pain , relief is expected.",
            "pain, relief is expected"
        ));
    }

    #[test]
    fn a_quote_of_parts_joined_by_dots_is_found_when_every_part_is_there_in_order() {
        // The letter writes the Bloods line before the Diagnosis line.
        assert!(is_located(
            LETTER,
            "hemoglobin 101 g/L, ferritin 5 \u{3bc}g/L ... Celiac disease, confirmed by biopsy"
        ));
        assert!(is_located(
            LETTER,
            "hemoglobin 101 g/L\u{2026}ferritin 5 \u{b5}g/L\u{2026}Celiac disease, confirmed by biopsy."
        ));
        assert!(is_located(
            LETTER,
            "...Celiac disease, confirmed by biopsy..."
        ));
        // Out of order: the second part is before the first in the letter.
        assert!(!is_located(
            LETTER,
            "Celiac disease, confirmed by biopsy ... hemoglobin 101 g/L, ferritin 5 \u{b5}g/L"
        ));
        // A part that is not in the letter loses the whole quote.
        assert!(!is_located(
            LETTER,
            "hemoglobin 101 g/L, ferritin 5 \u{b5}g/L ... Celiac disease, confirmed by colonoscopy"
        ));
        // A part may not be used twice.
        assert!(!is_located(
            LETTER,
            "Celiac disease, confirmed by biopsy ... Celiac disease, confirmed by biopsy"
        ));
    }

    #[test]
    fn a_tiny_part_cannot_make_a_quote_of_several_parts_match_anything() {
        // "mg" and "the right" are in many letters; a link to them would say nothing.
        let text = "Take 5 mg of the right one. Heart size normal.";
        assert!(!is_located(text, "mg ... Heart size normal"));
        assert!(!is_located(text, "Take 5 mg of the ... the right"));
        assert!(!is_located(
            LETTER,
            "tissue ... Celiac disease, confirmed by biopsy"
        ));
        assert!(!is_located("右上肺６毫米结节，无变化。", "结节 ... 无变化"));
        // Three words, or twelve characters, is enough for a part; so is one of each.
        assert!(is_located(text, "5 mg of ... Heart size normal"));
        assert!(is_located(LETTER, "Referral to our clinic dietitian"));
        assert!(is_located(
            LETTER,
            "Diagnosis Celiac ... will call within 2 weeks"
        ));
        assert!(is_located(
            "右上肺６毫米结节，无变化。",
            "右上肺 ... 无变化"
        ));
        // The reader's own words for Chinese: each character is a word, so three are enough.
        assert!(reader_accepts("右上肺６毫米结节，无变化。", "无变化"));
        assert!(!reader_accepts("右上肺６毫米结节，无变化。", "结节"));
    }

    #[test]
    fn a_short_quote_of_one_part_is_kept_as_the_runner_always_kept_it() {
        // The reader would show no link for these, the runner keeps the quote for its checks.
        for (text, quote) in [
            (
                "Social history\nNon-smoker\nPlan as discussed.",
                "Non-smoker",
            ),
            ("Take 5 mg of the right one.", "mg"),
            ("右上肺６毫米结节，无变化。", "结节"),
        ] {
            assert!(is_located(text, quote), "{quote}");
            assert!(!reader_accepts(text, quote), "{quote}");
        }
        assert!(!is_located("Take 5 mg of the right one.", "xyz"));
        // `find` is for quotes the gate accepted and the safety steps' own sentences.
        assert!(find("Call 911.", "Call 911.").is_some());
    }

    #[test]
    fn words_that_are_not_in_the_letter_or_a_made_up_quote_stay_unlocated() {
        for quote in [
            "Referral to our clinic dietitian, Robin FAKE-Dietwell; the dietitian's office will phone within 2 weeks.",
            "Celiac disease, confirmed by colonoscopy",
            "The patient must stop all gluten and start steroids immediately.",
            "hemoglobin 111 g/L",
            "",
            "   ",
            " :.;'\" ",
            "...",
            "… … …",
        ] {
            assert!(!is_located(LETTER, quote), "{quote:?}");
            assert!(find(LETTER, quote).is_none(), "{quote:?}");
        }
    }

    #[test]
    fn a_quote_over_two_lines_with_only_white_space_between_is_found_but_not_over_other_text() {
        // The lines "Diagnosis" and "Celiac disease, ..." are next to each other.
        assert!(is_located(
            LETTER,
            "Diagnosis Celiac disease, confirmed by biopsy"
        ));
        assert!(is_located(
            LETTER,
            "Diagnosis\nCeliac disease, confirmed by biopsy"
        ));
        // "1." is between "Plan" and "A strict gluten-free diet": it is not white space.
        assert!(is_located(LETTER, "Plan 1. A strict gluten-free diet"));
        assert!(!is_located(LETTER, "Plan A strict gluten-free diet"));
        // The ordinary join of two lines of one sentence.
        assert!(is_located(LETTER, "will call within 2 weeks"));
    }

    #[test]
    fn the_range_covers_the_whole_source_characters_of_the_first_and_last_part() {
        assert_eq!(
            quoted(LETTER, "iron deficiency anemia"),
            "iron de\u{fb01}ciency anemia"
        );
        assert_eq!(
            quoted(LETTER, "Celiac disease, confirmed by biopsy, with iron"),
            "Celiac disease, con\u{fb01}rmed by biopsy\n, with iron"
        );
        // A quote that stops inside a ligature takes the ligature whole.
        assert_eq!(quoted(LETTER, "dietitian's of"), "dietitian's o\u{fb03}");
        assert_eq!(
            quoted(LETTER, "hemoglobin 101 g/L ... confirmed by biopsy"),
            &LETTER[LETTER.find("hemoglobin").unwrap()
                ..LETTER.find("biopsy").unwrap() + "biopsy".len()]
        );
    }

    #[test]
    fn accents_case_and_full_width_forms_do_not_count() {
        assert_eq!(
            quoted(
                "Écho cardiaque : fraction d’éjection à 35 %.",
                "fraction d'ejection a 35 %"
            ),
            "fraction d’éjection à 35 %"
        );
        assert_eq!(
            quoted(
                "右上肺６毫米结节，与２０２５年相比无变化。",
                "右上肺6毫米结节"
            ),
            "右上肺６毫米结节"
        );
        assert!(is_located(
            "\u{130}stanbul clinic: 6 mm nodule",
            "istanbul clinic"
        ));
    }

    #[test]
    fn a_heading_helper_folds_a_line_and_a_quote_alike() {
        assert_eq!(folded_line("  Follow-up:  "), "follow-up");
        assert_eq!(folded_line("De\u{fb01}nite  plan"), "definite plan");
        assert_eq!(single_part("\"Follow-up:\""), Some("follow-up".to_owned()));
        assert_eq!(single_part("Diagnosis ... Plan"), None);
        assert_eq!(single_part("..."), None);
    }

    #[test]
    fn every_block_of_the_cjk_scripts_starts_and_ends_where_the_reader_says() {
        // (first, last) of each block `is_cjk` names; a character one before the first and one
        // after the last is outside it, unless the next block begins right there.
        let blocks: [(u32, u32); 17] = [
            (0x1100, 0x11FF),   // Hangul Jamo
            (0x2E80, 0x2FDF),   // CJK radicals
            (0x3021, 0x3029),   // Han marks (the run of eight and nine)
            (0x3038, 0x303B),   // Han marks
            (0x3041, 0x3096),   // Hiragana
            (0x309D, 0x309F),   // Hiragana iteration marks
            (0x30A1, 0x30FA),   // Katakana
            (0x30FD, 0x30FF),   // Katakana iteration marks and koto
            (0x31F0, 0x31FF),   // Katakana phonetic extensions
            (0x3131, 0x318E),   // Hangul compatibility Jamo
            (0x3400, 0x4DBF),   // Han extension A
            (0x4E00, 0x9FFF),   // Han
            (0xA960, 0xA97C),   // Hangul Jamo extension A
            (0xD7B0, 0xD7FB),   // Hangul Jamo extension B
            (0xF900, 0xFAFF),   // Han compatibility
            (0x1B000, 0x1B16F), // Kana supplement and extended
            (0x20000, 0x323AF), // Han extensions B to H
        ];
        let is = |code: u32| char::from_u32(code).is_some_and(is_cjk);
        for (first, last) in blocks {
            assert!(is(first), "{first:#x} starts a block");
            assert!(is(last), "{last:#x} ends a block");
            assert!(
                is((first + last) / 2),
                "the middle of {first:#x}..={last:#x}"
            );
            // Just outside: not CJK, unless another block starts or ends exactly there.
            let touches = |code: u32| blocks.iter().any(|(a, b)| (*a..=*b).contains(&code));
            assert_eq!(is(first - 1), touches(first - 1), "{:#x}", first - 1);
            assert_eq!(is(last + 1), touches(last + 1), "{:#x}", last + 1);
        }
        // The single Han marks are letters of their own, and the neighbours of each are not.
        for single in [0x3005_u32, 0x3007] {
            assert!(is(single), "{single:#x}");
        }
        for outside in [0x3006_u32, 0x3008, 0x3004, 0x3000] {
            assert!(!is(outside), "{outside:#x}");
        }
        // Ordinary letters, digits and punctuation never count, nor does a surrogate gap.
        for plain in [
            'a', 'Z', 'é', '7', ' ', '.', 'ß', '\u{0416}', '\u{05D0}', '\u{0627}',
        ] {
            assert!(!is_cjk(plain), "{plain:?}");
        }
        assert!(char::from_u32(0xD800).is_none());
    }
}

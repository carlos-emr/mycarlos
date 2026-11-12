//! K19 (evaluation only): a reviewed, versioned glossary ("glossary-2.1.txt") puts a short plain
//! explanation beside the first use of a medical word, germ, test or unit in a summary sentence:
//! "creatinine (a waste product in the blood that shows how well the kidneys work)". Ben (12 Nov)
//! kept the plain-language rule as written: a sentence with an unexplained medical term counts
//! as technical. glossary-2 follows the medical review of glossary-1 (12 Nov): its rewordings, its
//! blocked clash phrases, and its code findings M1–M3, S1–S4 and C3–C5. glossary-2.1 follows the
//! blind review of glossary-2's output: each different unit gets its own explanation, a line can
//! name words that stop it (an insulin strength in U/mL is no lab result), and a unit matches
//! only as written ("G/L", a French cell count, is not "g/l").
//!
//! An explanation is the word's general meaning only: never anything about the patient, no cause
//! of the patient's illness, no claim, no digit, and no listed term (so a second run changes
//! nothing). The step only inserts; it never drops or changes a word, number or sentence. Rules:
//! - each glossary line's first use in a sentence gets " (<explanation>)" right after it, or
//!   ", <explanation>," inside brackets (", <explanation>" before a closing bracket, a comma or
//!   a semicolon);
//! - a unit's first use counts per spelling ("µmol/L" and then "mmol/L" each get one), a
//!   word's per glossary line ("eGFR" and then "GFR": only the first);
//! - a line with a "block:" column is skipped when one of its words is in the sentence (whole
//!   words, any case);
//! - longer terms first, never overlapping; a "plain" phrase ("LDL-C", "Ringer's lactate",
//!   "pulmonary hypertension") keeps a shorter term inside it unexplained;
//! - a unit, or a term with an upper-case letter, matches only as written ("EGFR" is not
//!   "eGFR"); any other all-lower-case term matches in any case;
//! - a term needs a non-letter, non-digit on both sides (a unit may follow a digit), and a hyphen
//!   or slash joining it to a letter or digit is no break ("LDL-C", "albumin/creatinine");
//! - nothing is inserted when the term is already explained: a bracket right after it; ", a",
//!   ", an", ", the", ", which", "called", "known as" (English) or ", un", ", une", ", qui",
//!   "c'est-à-dire", "appelé(e)(s)", "connu(e) sous le nom de" (French) right after it; "called",
//!   "known as", "appelé(e)(s)", "connu(e) sous le nom de", "c'est-à-dire" as whole words right
//!   before it; its explanation right after it (", <explanation>"); or, for a word that is not a
//!   unit, its explanation anywhere in the sentence;
//! - English and French summaries ("en", "fr", "en-CA", "fr-CA", …); accents are recomposed
//!   first (an "é" written as "e" + a combining accent still matches);
//! - a sentence its explanations would make longer than the runner's limit is left as it is.
//!
//! Pure std, so its tests run on their own: `rustc --edition 2021 --test src/glossary.rs`. The
//! cases are shared with the evaluation's Python port (`glossary_cases.txt`).

use std::sync::OnceLock;

/// The glossary's name in a measurement.
#[allow(dead_code)]
pub(crate) const NAME: &str = "glossary-2.1";

const GLOSSARY: &str = include_str!("glossary-2.1.txt");

/// The runner's longest sentence (`local_runner::MAX_SENTENCE_CHARS`).
const MAX_CHARS: usize = 2_000;

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
    /// Lower-case words that stop this line's explanation anywhere in the sentence.
    block: Vec<String>,
}

fn entries() -> &'static [Entry] {
    static ENTRIES: OnceLock<Vec<Entry>> = OnceLock::new();
    ENTRIES.get_or_init(|| {
        GLOSSARY
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
            .map(|line| {
                let parts: Vec<&str> = line.split(" | ").map(str::trim).collect();
                assert!(parts.len() == 4 || parts.len() == 5, "glossary line: {line}");
                let block = parts.get(4).map_or(Vec::new(), |column| {
                    column
                        .strip_prefix("block:")
                        .unwrap_or_else(|| panic!("glossary line: {line}"))
                        .split(';')
                        .map(|w| nfc(w.trim()).to_lowercase())
                        .filter(|w| !w.is_empty())
                        .collect()
                });
                Entry {
                    unit: parts[0] == "unit",
                    terms: parts[1]
                        .split(';')
                        .map(str::trim)
                        .filter(|t| !t.is_empty())
                        .map(|t| nfc(t).chars().collect())
                        .collect(),
                    en: parts[2].to_owned(),
                    fr: parts[3].to_owned(),
                    block,
                }
            })
            .collect()
    })
}

/// Accents written as a letter and a combining mark, recomposed (the French and English
/// letters; enough for this glossary).
fn nfc(text: &str) -> String {
    const MARKS: &[(char, &str, &str)] = &[
        ('\u{301}', "aeiouyAEIOUYc", "áéíóúýÁÉÍÓÚÝć"),
        ('\u{300}', "aeiouAEIOU", "àèìòùÀÈÌÒÙ"),
        ('\u{302}', "aeiouAEIOU", "âêîôûÂÊÎÔÛ"),
        ('\u{308}', "aeiouyAEIOUY", "äëïöüÿÄËÏÖÜŸ"),
        ('\u{327}', "cC", "çÇ"),
    ];
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some(&mark) = chars.get(i + 1) {
            if let Some((_, bases, composed)) = MARKS.iter().find(|(m, ..)| *m == mark) {
                if let Some(at) = bases.chars().position(|b| b == c) {
                    out.push(composed.chars().nth(at).unwrap());
                    i += 2;
                    continue;
                }
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

fn same(a: char, b: char, cased: bool) -> bool {
    if cased {
        a == b
    } else {
        a.to_lowercase().eq(b.to_lowercase())
    }
}

/// Whether `pattern` ends `text` as whole words.
fn ends_with_words(text: &str, pattern: &str) -> bool {
    text.strip_suffix(pattern)
        .is_some_and(|head| !head.chars().next_back().is_some_and(char::is_alphabetic))
}

const AFTER: &[&str] = &[
    ", a ",
    ", an ",
    ", the ",
    ", which ",
    " called ",
    " known as ",
    ", un ",
    ", une ",
    ", qui ",
    ", c'est-à-dire",
    " appelé",
    " appelée",
    " appelés",
    " appelées",
    " aussi appelé",
    " connu sous le nom de",
    " connue sous le nom de",
];
const BEFORE: &[&str] = &[
    "called",
    "known as",
    "appelé",
    "appelée",
    "appelés",
    "appelées",
    "connu sous le nom de",
    "connue sous le nom de",
    "c'est-à-dire",
];

/// The sentence with its explanations, and each (term as written, explanation) inserted, in
/// order; `None` when nothing is inserted.
pub(crate) fn explain(sentence: &str, lang: &str) -> Option<(String, Vec<(String, String)>)> {
    let primary = lang
        .split(['-', '_'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if primary != "en" && primary != "fr" {
        return None;
    }
    let composed = nfc(sentence);
    let chars: Vec<char> = composed.chars().collect();
    let n = chars.len();
    let mut claimed = vec![false; n];
    let glossary = entries();
    let mut variants: Vec<(&Vec<char>, usize, usize)> = glossary
        .iter()
        .enumerate()
        .flat_map(|(index, entry)| {
            entry
                .terms
                .iter()
                .enumerate()
                .map(move |(spelling, term)| (term, index, spelling))
        })
        .collect();
    variants.sort_by_key(|(term, ..)| std::cmp::Reverse(term.len()));
    let joined = |k: usize| matches!(chars.get(k), Some('-' | '/'));
    // Each first use: (line, spelling for a unit or usize::MAX, start, end), in the order first
    // found.
    let mut first: Vec<(usize, usize, usize, usize)> = Vec::new();
    for (term, index, spelling) in variants {
        let unit = glossary[index].unit;
        let cased = unit || term.iter().any(|c| c.is_uppercase());
        let key = if unit { spelling } else { usize::MAX };
        let m = term.len();
        if m > n {
            continue;
        }
        for i in 0..=n - m {
            let j = i + m;
            let starts = i == 0 || {
                let before = chars[i - 1];
                let free = if unit {
                    !before.is_alphabetic()
                } else {
                    !before.is_alphanumeric()
                };
                free && (unit || !(i >= 2 && joined(i - 1) && chars[i - 2].is_alphanumeric()))
            };
            let ends = j >= n
                || (!chars[j].is_alphanumeric()
                    && (unit
                        || !(joined(j) && chars.get(j + 1).is_some_and(|c| c.is_alphanumeric()))));
            if !starts || !ends || !(0..m).all(|k| same(chars[i + k], term[k], cased)) {
                continue;
            }
            if claimed[i..j].iter().any(|c| *c) {
                continue;
            }
            claimed[i..j].iter_mut().for_each(|c| *c = true);
            match first
                .iter_mut()
                .find(|(line, k, ..)| *line == index && *k == key)
            {
                Some(found) if i < found.2 => *found = (index, key, i, j),
                Some(_) => {}
                None => first.push((index, key, i, j)),
            }
        }
    }
    let text = |i: usize, j: usize| chars[i..j].iter().collect::<String>();
    let lower_sentence = composed.to_lowercase();
    let words: Vec<&str> = lower_sentence
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let mut inserts: Vec<(usize, String, String, String)> = Vec::new();
    for (index, _, i, j) in first {
        let entry = &glossary[index];
        if entry.block.iter().any(|b| words.contains(&b.as_str())) {
            continue;
        }
        let explanation = if primary == "fr" {
            &entry.fr
        } else {
            &entry.en
        };
        if explanation == "-" {
            continue;
        }
        let rest = text(j, n);
        let rest_lower = rest.to_lowercase();
        let before = text(0, i).trim_end().to_lowercase();
        let explanation_lower = explanation.to_lowercase();
        let explained = rest.trim_start().starts_with('(')
            || AFTER.iter().any(|p| rest_lower.starts_with(p))
            || BEFORE.iter().any(|p| ends_with_words(&before, p))
            || rest_lower.starts_with(&format!(", {explanation_lower}"))
            || (!entry.unit && lower_sentence.contains(&explanation_lower));
        if explained {
            continue;
        }
        let head = text(0, i);
        let inside = head.matches('(').count() > head.matches(')').count();
        let insert = if inside {
            if matches!(rest.trim_start().chars().next(), None | Some(')' | ',' | ';')) {
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
    if out.chars().count() > MAX_CHARS {
        return None;
    }
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

    fn case(name: &str) -> (String, String, String) {
        for block in CASES.split("\n===\n").skip(1) {
            let field = |key: &str| {
                block
                    .lines()
                    .find_map(|line| line.strip_prefix(&format!("{key}: ")))
                    .unwrap_or_else(|| panic!("{name}: no {key}"))
                    .to_owned()
            };
            if field("name") == name {
                return (field("lang"), field("sentence"), field("expect"));
            }
        }
        panic!("no case {name}");
    }

    fn check(name: &str) {
        let (lang, sentence, expect) = case(name);
        let got = explain(&sentence, &lang).map_or(nfc(&sentence), |(out, _)| out);
        assert_eq!(got, expect, "{name}");
        // S2: a second run changes nothing.
        let again = explain(&got, &lang).map_or(got.clone(), |(out, _)| out);
        assert_eq!(again, got, "{name}: not stable on a second run");
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
    fn given_the_glossary_when_read_then_no_explanation_has_a_digit_or_a_listed_term_and_every_line_has_both_languages(
    ) {
        for entry in entries() {
            assert!(!entry.terms.is_empty());
            for text in [&entry.en, &entry.fr] {
                assert!(!text.is_empty());
                assert!(!text.chars().any(|c| c.is_ascii_digit()), "{text}");
                if text != "-" {
                    assert!(explain(text, "en").is_none(), "{text}");
                    assert!(explain(text, "fr").is_none(), "{text}");
                }
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
    fn given_terms_of_two_glossary_lines_when_explained_then_each_gets_its_own() {
        check("each_glossary_line_gets_its_own");
    }

    #[test]
    fn given_two_spellings_of_one_glossary_line_when_explained_then_only_the_first_is_explained() {
        check("two_spellings_of_one_line");
    }

    #[test]
    fn given_two_names_of_one_germ_when_explained_then_only_the_first_is_explained() {
        check("two_names_of_one_germ");
    }

    #[test]
    fn given_a_french_summary_when_explained_then_the_explanations_are_french() {
        check("a_french_summary");
    }

    #[test]
    fn given_a_canadian_french_tag_when_explained_then_it_is_french() {
        check("a_canadian_french_tag");
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

    #[test]
    fn given_a_mixed_case_abbreviation_written_in_capitals_when_explained_then_it_is_not_matched() {
        check("egfr_mutation_is_not_egfr");
    }

    #[test]
    fn given_a_capitalised_name_that_spells_a_term_when_explained_then_it_is_not_matched() {
        check("a_grocery_store_is_not_iga");
    }

    #[test]
    fn given_a_unit_written_in_another_case_when_explained_then_it_is_not_matched() {
        check("fluid_ounces_are_not_femtolitres");
    }

    #[test]
    fn given_a_term_joined_by_a_hyphen_when_explained_then_it_is_not_split() {
        check("ldl_c_is_not_split");
    }

    #[test]
    fn given_a_joined_test_name_when_explained_then_it_is_explained_once_as_a_whole() {
        check("ttg_iga_as_one_term");
    }

    #[test]
    fn given_a_formula_name_joined_by_a_hyphen_when_explained_then_it_is_left_as_it_is() {
        check("ckd_epi_is_left_alone");
    }

    #[test]
    fn given_a_creatinine_ratio_in_urine_when_explained_then_creatinine_inside_it_is_not_explained()
    {
        check("a_urine_albumin_creatinine_ratio");
    }

    #[test]
    fn given_a_protein_to_creatinine_ratio_when_explained_then_it_is_explained_as_a_ratio() {
        check("a_protein_to_creatinine_ratio");
    }

    #[test]
    fn given_urine_creatinine_in_french_when_explained_then_the_urine_meaning_is_used() {
        check("urine_creatinine_in_french");
    }

    #[test]
    fn given_an_iv_fluid_named_after_lactate_when_explained_then_it_is_left_as_it_is() {
        check("ringers_lactate_is_a_fluid");
    }

    #[test]
    fn given_another_test_named_after_lactate_when_explained_then_it_is_left_as_it_is() {
        check("lactate_dehydrogenase_is_another_test");
    }

    #[test]
    fn given_a_breath_test_named_after_urea_when_explained_then_it_is_left_as_it_is() {
        check("urea_breath_test");
    }

    #[test]
    fn given_a_cream_named_after_urea_when_explained_then_it_is_left_as_it_is() {
        check("urea_cream");
    }

    #[test]
    fn given_pulmonary_hypertension_when_explained_then_high_blood_pressure_is_not_used() {
        check("pulmonary_hypertension");
    }

    #[test]
    fn given_ocular_hypertension_when_explained_then_high_blood_pressure_is_not_used() {
        check("ocular_hypertension");
    }

    #[test]
    fn given_stomach_erosions_when_explained_then_the_explanation_is_not_about_bone() {
        check("gastric_erosions");
    }

    #[test]
    fn given_arthritis_criteria_named_acr_when_explained_then_they_are_left_as_they_are() {
        check("acr_eular_criteria");
    }

    #[test]
    fn given_an_insulin_strength_when_explained_then_its_unit_is_not_called_a_lab_unit() {
        check("insulin_strength_unit");
    }

    #[test]
    fn given_glycated_hemoglobin_when_explained_then_it_gets_the_average_sugar_meaning() {
        check("glycated_hemoglobin");
    }

    #[test]
    fn given_french_hemoglobin_a1c_when_explained_then_it_gets_the_average_sugar_meaning_once() {
        check("hemoglobine_a1c_in_french");
    }

    #[test]
    fn given_recalled_before_a_term_when_explained_then_the_term_is_still_explained() {
        check("recalled_is_not_called");
    }

    #[test]
    fn given_a_french_term_already_explained_with_appelee_when_explained_then_it_is_unchanged() {
        check("french_appelee_before");
    }

    #[test]
    fn given_a_french_term_followed_by_qui_when_explained_then_it_is_unchanged() {
        check("french_qui_after");
    }

    #[test]
    fn given_accents_written_with_combining_marks_when_explained_then_the_french_term_matches() {
        check("a_decomposed_accent");
    }

    #[test]
    fn given_a_list_with_the_after_a_term_when_explained_then_it_is_left_unexplained_safely() {
        check("a_list_after_a_term");
    }

    #[test]
    fn given_a_lab_value_in_units_per_millilitre_when_explained_then_the_unit_is_explained() {
        check("a_lab_value_in_units_per_millilitre");
    }

    #[test]
    fn given_an_insulin_brand_strength_when_explained_then_its_unit_is_left_as_it_is() {
        check("an_insulin_brand_strength");
    }

    #[test]
    fn given_two_different_units_of_one_line_when_explained_then_each_gets_its_own() {
        check("two_different_units_of_one_line");
    }

    #[test]
    fn given_one_unit_used_twice_when_explained_then_only_its_first_use_is_explained() {
        check("one_unit_twice");
    }

    #[test]
    fn given_a_unit_with_a_lower_case_l_when_explained_then_it_is_explained() {
        check("a_unit_with_a_lower_case_l");
    }

    #[test]
    fn given_a_french_cell_count_in_capitals_when_explained_then_it_is_not_taken_for_grams() {
        check("a_french_cell_count_is_not_grams");
    }

    #[test]
    fn given_the_polish_count_unit_when_explained_then_it_is_explained() {
        check("the_polish_count_unit");
    }

    #[test]
    fn given_oxygen_saturation_when_explained_then_it_gets_the_oxygen_meaning() {
        check("oxygen_saturation");
    }

    #[test]
    fn given_transferrin_saturation_when_explained_then_it_is_left_as_it_is() {
        check("transferrin_saturation_is_an_iron_test");
    }

    #[test]
    fn given_a_unit_per_millilitre_inside_brackets_when_explained_twice_then_the_second_run_changes_nothing() {
        check("a_unit_per_millilitre_inside_brackets");
    }

    #[test]
    fn given_a_term_in_a_list_inside_brackets_when_explained_then_no_comma_is_doubled() {
        check("a_list_inside_brackets");
    }

    #[test]
    fn given_the_glossary_when_read_then_every_block_word_is_one_lower_case_word() {
        for entry in entries() {
            for word in &entry.block {
                assert!(word.chars().all(char::is_alphanumeric), "{word}");
                assert_eq!(word, &word.to_lowercase(), "{word}");
            }
        }
    }

    #[test]
    fn given_a_sentence_near_the_length_limit_when_explained_then_it_is_left_as_it_is() {
        let long = format!("The creatinine was high. {}", "x".repeat(MAX_CHARS - 30));
        assert!(explain(&long, "en").is_none());
    }
}

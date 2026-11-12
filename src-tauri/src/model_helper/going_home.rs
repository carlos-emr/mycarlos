//! K18 (evaluation only): whether a document has a going-home part, decided in code, so the
//! going-home rule (K15b's two sentences) is in the prompt only for a hospital record that has
//! one. K15b put the rule in every prompt, and on letters it was never for it cost a fever rule
//! (a short French instruction list written as "found" sentences) and added two wrong sentences.
//!
//! A going-home heading is a line of at most 8 words, with no digit, not ended by `.`, `!` or
//! `?`, that has a going-home word: "discharge", "discharged", "sortie", "congé", "alta", a
//! word starting "wypis", or "going home", "go home", "retour à domicile". It is decided on all
//! the pages sent, before they are fitted.
//!
//! Pure std, so its tests run on their own: `rustc --edition 2021 --test going_home.rs`. The
//! cases are shared with the evaluation's Python port (`going_home_cases.txt`).

/// Whether any page has a going-home heading.
pub(crate) fn has_going_home_part<'a>(pages: impl IntoIterator<Item = &'a str>) -> bool {
    pages
        .into_iter()
        .any(|page| page.lines().any(is_going_home_heading))
}

/// "Discharge medications", "DISCHARGE SUMMARY", "Leki przy wypisie", "Instructions de sortie:".
fn is_going_home_heading(line: &str) -> bool {
    let line = line.trim();
    if line.is_empty()
        || line.split_whitespace().count() > 8
        || line.chars().any(|c| c.is_ascii_digit())
        || line.ends_with(['.', '!', '?'])
    {
        return false;
    }
    let lower = line.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let single = words.iter().any(|w| {
        matches!(
            *w,
            "discharge" | "discharged" | "sortie" | "congé" | "conge" | "alta"
        ) || w.starts_with("wypis")
    });
    let pair = words
        .windows(2)
        .any(|p| p[1] == "home" && (p[0] == "going" || p[0] == "go"));
    let triple = words
        .windows(3)
        .any(|t| t[0] == "retour" && (t[1] == "à" || t[1] == "a") && t[2] == "domicile");
    single || pair || triple
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared cases (also run by the evaluation's Python port): "on:" or "off:", then a
    /// document whose lines are separated by " / ".
    const CASES: &str = include_str!("going_home_cases.txt");

    fn check(name: &str) {
        let line = CASES
            .lines()
            .find(|l| l.starts_with(&format!("{name}: ")))
            .unwrap_or_else(|| panic!("no case {name}"));
        let rest = &line[name.len() + 2..];
        let (want, doc) = rest.split_once(' ').unwrap();
        let pages = doc
            .split(" // ")
            .map(|page| page.replace(" / ", "\n"))
            .collect::<Vec<_>>();
        let got = has_going_home_part(pages.iter().map(String::as_str));
        assert_eq!(got, want == "on", "{name}");
    }

    #[test]
    fn every_shared_case_has_a_test_below() {
        let me = include_str!("going_home.rs");
        for line in CASES
            .lines()
            .filter(|l| !l.starts_with('#') && l.contains(": "))
        {
            let name = line.split(": ").next().unwrap();
            assert!(me.contains(&format!("check(\"{name}\")")), "{name}");
        }
    }

    #[test]
    fn given_a_discharge_summary_heading_when_gated_then_the_going_home_rule_is_on() {
        check("discharge_summary_title");
    }

    #[test]
    fn given_a_medications_at_discharge_heading_on_a_later_page_when_gated_then_the_rule_is_on() {
        check("discharge_medications_on_a_later_page");
    }

    #[test]
    fn given_a_polish_discharge_medicines_heading_when_gated_then_the_rule_is_on() {
        check("polish_wypis_heading");
    }

    #[test]
    fn given_a_french_going_home_heading_when_gated_then_the_rule_is_on() {
        check("french_retour_a_domicile");
    }

    #[test]
    fn given_a_short_french_instruction_list_with_no_going_home_part_when_gated_then_the_rule_is_off(
    ) {
        check("french_instruction_list");
    }

    #[test]
    fn given_a_referral_letter_when_gated_then_the_rule_is_off() {
        check("referral_letter");
    }

    #[test]
    fn given_a_discharge_date_line_with_digits_when_gated_then_it_is_no_heading() {
        check("discharge_date_line");
    }

    #[test]
    fn given_a_sentence_about_discharge_when_gated_then_it_is_no_heading() {
        check("discharge_in_a_sentence");
    }

    #[test]
    fn given_a_long_line_with_discharge_when_gated_then_it_is_no_heading() {
        check("discharge_in_a_long_line");
    }

    #[test]
    fn given_discharge_inside_another_word_when_gated_then_it_is_no_going_home_word() {
        check("discharge_inside_a_word");
    }
}

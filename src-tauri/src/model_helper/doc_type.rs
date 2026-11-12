//! K22 (evaluation only): which kind of document this is, decided in code before the model runs,
//! so the summary request can add one sentence for that kind (step 4 of the 12 Nov plan). Ben
//! asked how it handles a document it cannot identify: such a document is `Unknown` and gets
//! today's request (E5's) byte for byte, so it is never worse off than now.
//!
//! In order, on all the pages sent, before they are fitted:
//! 1. `GoingHome`: K18's gate (`going_home`), unchanged;
//! 2. otherwise exactly one of
//!    - `Lab`: "laborat…", "clinical chemistry", "biochimie", "cumulative report", "hematology",
//!      "hématologie", "microbiology", "microbiologie" or "pathology report" in a title line,
//!    - `Imaging`: "imaging", "imagerie", "radiology", "ultrasound", "échographie", "MRI",
//!      "IRM", "x-ray", … as a word of a title line,
//!    - `Letter`: a salutation line ("Dear …,", "Cher collègue,", "Docteure …,", "Prezada …,");
//! 3. otherwise `Unknown`, two kinds at once included.
//!
//! A title line is one of the first 15 non-empty lines, with at most 10 words, not ended by `.`,
//! `!`, `?` or `,`; a digit "0" in it reads as "o" for the lab words ("LAB0RATORIES" in a fax).
//! A salutation line is one of the first 80 lines, with at most 8 words, ended by `,`, whose
//! first word is a greeting or a title ("dear", "cher", "chère", "docteur", "dr", "dra", …).
//!
//! Pure std, so its tests run on their own (with `going_home`): see the tests' note. The cases
//! are shared with the evaluation's Python port (`doc_type_cases.txt`).

/// The kind of document, for choosing the summary request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DocType {
    GoingHome,
    Letter,
    Lab,
    Imaging,
    Unknown,
}

impl DocType {
    /// Its name in a measurement.
    #[allow(dead_code)]
    pub(crate) fn name(self) -> &'static str {
        match self {
            DocType::GoingHome => "going-home",
            DocType::Letter => "letter",
            DocType::Lab => "lab",
            DocType::Imaging => "imaging",
            DocType::Unknown => "unknown",
        }
    }
}

const HEADER_LINES: usize = 15;
const SALUTATION_LINES: usize = 80;
const IMAGING: &[&str] = &[
    "imaging",
    "imagerie",
    "radiology",
    "radiologie",
    "radiologia",
    "ultrasound",
    "échographie",
    "echographie",
    "ecografia",
    "tomography",
    "tomodensitométrie",
    "mri",
    "irm",
    "radiographie",
    "mammography",
    "mammographie",
    "x-ray",
];
const LAB: &[&str] = &[
    "laborat",
    "labor ",
    "clinical chemistry",
    "biochimie",
    "cumulative report",
    "hematology",
    "hématologie",
    "microbiology",
    "microbiologie",
    "pathology report",
];
const SALUTES: &[&str] = &[
    "dear", "cher", "chère", "chere", "prezado", "prezada", "caro", "cara", "estimado", "estimada",
    "szanowny", "szanowna", "szanowni", "docteur", "docteure", "dr", "dre", "dra",
];

/// Lower-case words, a hyphen kept inside a word ("x-ray").
fn words(line: &str) -> Vec<String> {
    line.to_lowercase()
        .split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-'))
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

fn is_title(line: &str) -> bool {
    let t = line.trim();
    !t.is_empty() && t.split_whitespace().count() <= 10 && !t.ends_with(['.', '!', '?', ','])
}

fn is_salutation(line: &str) -> bool {
    let t = line.trim();
    let first = words(&t.replace('.', " ")).into_iter().next();
    first.is_some_and(|w| SALUTES.contains(&w.as_str()))
        && t.split_whitespace().count() <= 8
        && t.ends_with(',')
}

/// The kind of document the pages make.
pub(crate) fn doc_type<'a>(pages: impl IntoIterator<Item = &'a str>) -> DocType {
    let pages: Vec<&str> = pages.into_iter().collect();
    if super::going_home::has_going_home_part(pages.iter().copied()) {
        return DocType::GoingHome;
    }
    let text = pages.join("\n");
    let lines: Vec<&str> = text.lines().collect();
    let titles: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|l| !l.trim().is_empty())
        .take(HEADER_LINES)
        .filter(|l| is_title(l))
        .collect();
    let imaging = titles
        .iter()
        .any(|l| words(l).iter().any(|w| IMAGING.contains(&w.as_str())));
    let lab = titles.iter().any(|l| {
        let low = format!("{} ", l.to_lowercase().replace('0', "o"));
        LAB.iter().any(|p| low.contains(p))
    });
    let letter = lines
        .iter()
        .take(SALUTATION_LINES)
        .any(|l| is_salutation(l));
    match (lab, imaging, letter) {
        (true, false, false) => DocType::Lab,
        (false, true, false) => DocType::Imaging,
        (false, false, true) => DocType::Letter,
        _ => DocType::Unknown,
    }
}

#[cfg(test)]
mod tests {
    // Run on their own with a harness file that has `#[path] mod going_home;` and
    // `#[path] mod doc_type;` inside a `mod model_helper` (doc_type uses the going-home gate).
    use super::*;

    /// The shared cases: "<kind>: <name>: " then a document whose lines are separated by " / ".
    const CASES: &str = include_str!("doc_type_cases.txt");

    fn check(name: &str) {
        let line = CASES
            .lines()
            .find(|l| l.split(": ").nth(1) == Some(name))
            .unwrap_or_else(|| panic!("no case {name}"));
        let mut parts = line.splitn(3, ": ");
        let want = parts.next().unwrap();
        let doc = parts.nth(1).unwrap().replace(" / ", "\n");
        assert_eq!(doc_type([doc.as_str()]).name(), want, "{name}");
    }

    #[test]
    fn every_shared_case_has_a_test_below() {
        let me = include_str!("doc_type.rs");
        for line in CASES.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()) {
            let name = line.split(": ").nth(1).unwrap();
            assert!(me.contains(&format!("check(\"{name}\")")), "{name}");
        }
    }

    #[test]
    fn given_a_discharge_heading_when_typed_then_it_is_going_home() {
        check("a_discharge_summary");
    }

    #[test]
    fn given_a_discharge_heading_and_a_salutation_when_typed_then_going_home_wins() {
        check("going_home_before_letter");
    }

    #[test]
    fn given_a_laboratory_title_when_typed_then_it_is_a_lab_report() {
        check("a_lab_report");
    }

    #[test]
    fn given_a_faxed_laboratory_title_with_zeros_when_typed_then_it_is_a_lab_report() {
        check("a_faxed_lab_report");
    }

    #[test]
    fn given_an_imaging_title_when_typed_then_it_is_an_imaging_report() {
        check("an_imaging_report");
    }

    #[test]
    fn given_a_french_imaging_title_when_typed_then_it_is_an_imaging_report() {
        check("a_french_imaging_report");
    }

    #[test]
    fn given_dear_doctor_when_typed_then_it_is_a_letter() {
        check("a_letter");
    }

    #[test]
    fn given_cher_collegue_when_typed_then_it_is_a_letter() {
        check("a_french_letter");
    }

    #[test]
    fn given_a_title_and_name_as_salutation_when_typed_then_it_is_a_letter() {
        check("a_docteure_letter");
    }

    #[test]
    fn given_a_letter_with_an_x_ray_sentence_when_typed_then_it_stays_a_letter() {
        check("a_letter_with_an_x_ray_sentence");
    }

    #[test]
    fn given_a_short_note_when_typed_then_it_is_unknown() {
        check("a_short_note");
    }

    #[test]
    fn given_a_lab_title_and_a_salutation_when_typed_then_it_is_unknown() {
        check("two_kinds_at_once");
    }

    #[test]
    fn given_laboratory_in_a_sentence_when_typed_then_it_is_no_title() {
        check("laboratory_in_a_sentence");
    }

    #[test]
    fn given_a_salutation_after_eighty_lines_when_typed_then_it_is_not_read() {
        let mut doc = "line\n".repeat(80);
        doc.push_str("Dear Dr. Sample,\n");
        assert_eq!(doc_type([doc.as_str()]), DocType::Unknown);
    }

    #[test]
    fn given_two_pages_when_typed_then_they_are_read_as_one_document() {
        assert_eq!(
            doc_type(["Test Clinic", "Dear Dr. Sample,\nThank you."]),
            DocType::Letter
        );
    }
}

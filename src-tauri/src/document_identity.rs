//! Conservative suggestions from the existing sandbox's bounded first-page text.
//! These labels are hints only. They never establish clinic provenance or move a record.
use serde::Serialize;

#[derive(Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FoundIdentity {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub birth_date: Option<String>,
}

pub(crate) fn from_text(text: &str) -> Option<FoundIdentity> {
    // The helper truncates at a UTF-8 boundary: refuse a possibly cut page rather
    // than treating the missing tail (which could name another patient) as absent.
    if text.len() >= crate::pdf_view::MAX_PAGE_TEXT_BYTES.saturating_sub(3) {
        return None;
    }
    let mut name_line = None;
    let mut date_line = None;
    let mut name: Option<String> = None;
    let mut birth_date: Option<String> = None;
    for (index, line) in text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
    {
        let Some((label, value)) = line.split_once(':') else {
            continue;
        };
        let label = label.trim().to_ascii_lowercase();
        let value = value.trim();
        match label.as_str() {
            "patient name" | "patient full name" => {
                // Do not interpret addresses, identifiers, partial labels, initials or a
                // second person's name as patient identity. Unsupported layouts find none.
                if value.chars().count() > 120
                    || !value.chars().all(|c| {
                        c.is_alphabetic() || matches!(c, ' ' | '-' | '\'' | '’' | ',' | '.')
                    })
                    || value
                        .split(|c: char| !c.is_alphabetic())
                        .filter(|word| word.chars().count() > 1)
                        .count()
                        < 2
                    || name.is_some()
                {
                    return None;
                }
                name = Some(value.to_owned());
                name_line = Some(index);
            }
            "dob" | "date of birth" | "birth date" => {
                if !crate::vault::valid_birth_date(value)
                    || value
                        > crate::vault::utc_date_text(crate::now_ms().saturating_add(86_400_000))
                            .as_str()
                    || birth_date.is_some()
                {
                    return None;
                }
                birth_date = Some(value.to_owned());
                date_line = Some(index);
            }
            _ => (),
        }
    }
    // A date separated by another labelled field or prose could belong to a
    // different person. Only adjacent identity labels form a pair.
    if date_line.is_some_and(|date| name_line.is_none_or(|name: usize| name.abs_diff(date) != 1)) {
        return None;
    }
    Some(FoundIdentity {
        name: name?,
        birth_date,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_unambiguous_labels_only() {
        let found = from_text("Patient name: SMITH, Mary\nDOB: 1958-03-12").unwrap();
        assert_eq!(found.name, "SMITH, Mary");
        assert_eq!(found.birth_date.as_deref(), Some("1958-03-12"));
        assert!(from_text("Mary Smith\n1958-03-12").is_none());
        assert!(from_text("Provider name: Mary Smith\nDOB: 1958-03-12").is_none());
        for text in [
            "Patient name: Mary Smith\nDOB: 03/12/1958",
            "Patient name: Mary Smith\nDOB: 1900-02-29",
            "Patient name: Mary Smith\nDOB: 2999-01-01",
            "Patient name: Mary Smith\nPatient name: John Doe",
            "Patient name: Mary Smith\nDOB: 1958-03-12\nDOB: 1958-12-03",
            "Patient name: Mary Smith DOB: 1958-03-12",
            "Patient name: Mary Smith 123456",
            "Patient name: M S",
            "Patient name: Mary Smith\nNext of kin: John Doe\nDOB: 1958-03-12",
            "Patient name: Mary Smith\nPatient name: Mary Smith",
        ] {
            assert!(from_text(text).is_none());
        }
        assert!(from_text("Patient full name: Élodie Martin").is_some());
    }
    #[test]
    fn identity_from_a_real_pdf_page() {
        let pdf = include_bytes!("../tests/fixtures/shared-identity/labelled.pdf");
        // Exercise the production render/text-extraction path. In the app this runs
        // in the sandbox helper; this unit test does not claim a process-boundary test.
        let page = crate::pdf_view::render(pdf, "", 0, 1).unwrap();
        let found =
            from_text(&page.text).unwrap_or_else(|| panic!("FAKE fixture text: {:?}", page.text));
        assert_eq!(found.name, "FAKE Mary Smith");
        assert_eq!(found.birth_date.as_deref(), Some("1958-03-12"));
        let flat = include_bytes!("../tests/fixtures/shared-identity/flat-text.pdf");
        let page = crate::pdf_view::render(flat, "", 0, 1).unwrap();
        assert!(
            from_text(&page.text).is_none(),
            "flattened label boundaries must not be guessed"
        );
    }
}

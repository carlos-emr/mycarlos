//! Original unfound model quotes, tied to their sentence rather than a moving queue.

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct UnlocatedQuotes(Vec<(usize, String)>);

impl UnlocatedQuotes {
    pub(crate) fn record(&mut self, index: usize, quote: String) {
        self.0.push((index, quote));
    }

    pub(crate) fn original(&self, index: usize) -> Option<&str> {
        self.0
            .iter()
            .find(|(at, _)| *at == index)
            .map(|(_, quote)| quote.as_str())
    }

    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }

    /// A repaired source is located; otherwise recover only this sentence's
    /// original missing quote. Original model-quoting diagnostics stay intact.
    pub(crate) fn for_measurement(&self, index: usize, current: String) -> (String, bool) {
        if current.is_empty() {
            (self.original(index).unwrap_or_default().to_owned(), false)
        } else {
            (current, true)
        }
    }

    pub(crate) fn into_quotes(self) -> Vec<String> {
        self.0.into_iter().map(|(_, quote)| quote).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::safety::{self, Line};

    #[test]
    fn repairing_the_first_missing_quote_keeps_the_next_original_with_its_sentence() {
        let rule = "If chest pain returns or you have trouble breathing, call 911 now.";
        let pages = format!("FAKE document.\n{rule}");
        let mut missing = UnlocatedQuotes::default();
        missing.record(0, "FAKE first unmatched model quote".to_owned());
        missing.record(1, "FAKE second unmatched model quote".to_owned());
        let mut lines = vec![
            Line {
                text: "Call the clinic if chest pain returns.".to_owned(),
                quote: String::new(),
            },
            Line {
                text: "The appointment is on Monday.".to_owned(),
                quote: String::new(),
            },
        ];
        assert_eq!(safety::check(&pages, &mut lines).len(), 1);
        assert_eq!(lines[0].quote, rule);
        assert_eq!(
            missing.for_measurement(0, lines[0].quote.clone()),
            (rule.to_owned(), true)
        );
        assert_eq!(
            missing.for_measurement(1, lines[1].quote.clone()),
            ("FAKE second unmatched model quote".to_owned(), false)
        );
        assert_eq!(
            missing.original(0),
            Some("FAKE first unmatched model quote")
        );
        assert_eq!(
            missing.original(1),
            Some("FAKE second unmatched model quote")
        );
        assert_eq!(missing.len(), 2);
        assert_eq!(
            missing.into_quotes(),
            vec![
                "FAKE first unmatched model quote",
                "FAKE second unmatched model quote"
            ]
        );
    }

    #[test]
    fn repairing_middle_and_later_quotes_does_not_shift_unchanged_originals() {
        let mut missing = UnlocatedQuotes::default();
        for (index, quote) in ["FAKE first", "FAKE middle", "FAKE third", "FAKE last"]
            .iter()
            .enumerate()
        {
            missing.record(index, (*quote).to_owned());
        }
        assert_eq!(missing.original(0), Some("FAKE first"));
        assert_eq!(
            missing.for_measurement(1, "FAKE real middle source".to_owned()),
            ("FAKE real middle source".to_owned(), true)
        );
        assert_eq!(missing.original(2), Some("FAKE third"));
        assert_eq!(
            missing.for_measurement(3, "FAKE real last source".to_owned()),
            ("FAKE real last source".to_owned(), true)
        );
        assert_eq!(
            missing.for_measurement(0, String::new()),
            ("FAKE first".to_owned(), false)
        );
        assert_eq!(
            missing.for_measurement(2, String::new()),
            ("FAKE third".to_owned(), false)
        );
        assert_eq!(missing.len(), 4);
    }

    #[test]
    fn unchanged_missing_quotes_keep_their_original_indices_and_values() {
        let mut missing = UnlocatedQuotes::default();
        missing.record(1, "FAKE missing second".to_owned());
        missing.record(4, "FAKE missing fifth".to_owned());
        assert_eq!(missing.original(0), None);
        assert_eq!(missing.original(1), Some("FAKE missing second"));
        assert_eq!(missing.original(4), Some("FAKE missing fifth"));
        assert_eq!(missing.len(), 2);
    }

    #[test]
    fn an_appended_quote_has_no_original_model_entry_and_is_located() {
        let mut missing = UnlocatedQuotes::default();
        missing.record(0, "FAKE missing first".to_owned());
        assert_eq!(
            missing.for_measurement(1, "FAKE appended source".to_owned()),
            ("FAKE appended source".to_owned(), true)
        );
        assert_eq!(missing.original(1), None);
        assert_eq!(missing.len(), 1);
    }
}

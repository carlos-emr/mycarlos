//! Original unfound model quotes, tied to their sentence rather than a moving queue.

#[cfg_attr(test, derive(Debug))]
#[derive(Clone, Default, PartialEq, Eq)]
pub(crate) struct UnlocatedQuotes(Vec<(usize, String)>);
redact_debug!(UnlocatedQuotes);

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

    /// The sentences moved: sentence `i` is now at `to[i]` (`safety::moved_to`, after the
    /// safety checks inserted a rule between two sentences). Each original quote follows its
    /// sentence, so the measured sheet never shows it beside the line before.
    pub(crate) fn remap(&mut self, to: &[usize]) {
        for (index, _) in &mut self.0 {
            *index = to[*index];
        }
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
    fn an_unfound_quote_after_an_inserted_rule_stays_with_its_sentence() {
        // The same calls as the runner: the checks put the rule in after sentence 0, then
        // the recorded unfound quote of sentence 1 moves with it to index 2.
        let rule = "Call the clinic if you get a rash or your lips swell.";
        let pages = format!("Going home\nTake FAKEDRUG 2 tablets daily. {rule}\nFAKE visit.");
        let mut missing = UnlocatedQuotes::default();
        missing.record(1, "FAKE unmatched model quote".to_owned());
        let mut lines = vec![
            Line {
                text: "Take FAKEDRUG 2 tablets daily; call the clinic if you get a rash."
                    .to_owned(),
                quote: "Take FAKEDRUG 2 tablets daily".to_owned(),
            },
            Line {
                text: "The appointment is on Monday.".to_owned(),
                quote: String::new(),
            },
        ];
        let log = safety::check(&pages, &mut lines);
        assert_eq!(log.len(), 1);
        assert_eq!((log[0].index, log[0].before.is_none()), (1, true));
        assert_eq!(lines.len(), 3);
        let moved = safety::moved_to(&log, lines.len());
        assert_eq!(moved, vec![0, 2]);
        missing.remap(&moved);
        let measured: Vec<(String, bool)> = lines
            .iter()
            .enumerate()
            .map(|(i, l)| missing.for_measurement(i, l.quote.clone()))
            .collect();
        assert_eq!(
            measured[0],
            ("Take FAKEDRUG 2 tablets daily".to_owned(), true)
        );
        assert_eq!(measured[1], (rule.to_owned(), true));
        assert_eq!(
            measured[2],
            ("FAKE unmatched model quote".to_owned(), false)
        );
    }

    #[test]
    fn an_earlier_logged_line_moves_when_a_rule_is_put_in_before_it() {
        // The first rule is not in the summary and goes at the end (index 2); the second is
        // put in after sentence 0, so the first one's log entry must move on to index 3.
        let pages = "Going home\nCall 911 if you have chest pain. Take FAKEDRUG 2 tablets daily. \
                     Call the clinic if you get a rash or your lips swell.";
        let mut lines = vec![
            Line {
                text: "Take FAKEDRUG 2 tablets daily; call the clinic if you get a rash."
                    .to_owned(),
                quote: "Take FAKEDRUG 2 tablets daily".to_owned(),
            },
            Line {
                text: "The appointment is on Monday.".to_owned(),
                quote: String::new(),
            },
        ];
        let log = safety::check(pages, &mut lines);
        let added: Vec<(usize, bool)> = log
            .iter()
            .map(|f| (f.index, f.after.contains("911")))
            .collect();
        assert_eq!(added, vec![(3, true), (1, false)]);
        for f in &log {
            assert_eq!(lines[f.index].text, f.after);
        }
        assert_eq!(safety::moved_to(&log, lines.len()), vec![0, 2]);
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

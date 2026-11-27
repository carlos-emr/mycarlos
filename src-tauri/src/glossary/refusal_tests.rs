//! What the glossary step refuses to do (coverage batch 2): a language it does not speak, a
//! sentence shorter than any term, text with nothing to explain. It only inserts, so every refusal
//! is `None`. FAKE sentences only.

use super::*;

#[test]
fn only_english_and_french_summaries_are_explained() {
    let sentence = "The creatinine was measured.";
    assert!(explain(sentence, "en").is_some());
    assert!(explain(sentence, "en-CA").is_some());
    assert!(explain(sentence, "en_GB").is_some());
    for refused in [
        "es", "pl", "pt-BR", "zh-CN", "zh-TW", "", "-", "e", "english",
    ] {
        assert_eq!(explain(sentence, refused), None, "{refused:?}");
    }
    // The language is read in any case.
    assert!(explain(sentence, "EN").is_some());
}

#[test]
fn a_sentence_with_nothing_to_explain_or_shorter_than_every_term_is_left_alone() {
    for text in ["", " ", "Ok.", "A", "The visit went well."] {
        assert_eq!(explain(text, "en"), None, "{text:?}");
    }
}

#[test]
fn a_sentence_its_explanations_would_make_too_long_is_left_as_it_is() {
    // A long sentence of plain words, then a term: its explanation would pass the runner's limit.
    let filler = "word ".repeat((MAX_CHARS - 40) / 5);
    let sentence = format!("{filler}creatinine.");
    assert!(sentence.chars().count() <= MAX_CHARS);
    assert_eq!(explain(&sentence, "en"), None);
    // The same term in a short sentence is explained.
    assert!(explain("The creatinine was measured.", "en").is_some());
}

#[test]
fn an_explanation_is_inserted_only_and_the_words_the_patient_read_stay_in_order() {
    let sentence = "The creatinine was measured.";
    let (after, terms) = explain(sentence, "en").unwrap();
    // Dropping the inserted bracket leaves the sentence as it was.
    let (open, close) = (after.find(" (").unwrap(), after.find(')').unwrap());
    assert_eq!(
        format!("{}{}", &after[..open], &after[close + 1..]),
        sentence
    );
    assert_eq!(terms.len(), 1);
    assert_eq!(terms[0].0, "creatinine");
    assert!(after.contains(&terms[0].1));
}

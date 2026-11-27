//! The summary byte contract's refusals that `summary_contract`'s own tests do not reach: the cardinality bounds, the edit reservation, the source-span bounds and the decoder's
//! bound on a collection. FAKE text only.

use super::*;
use serde::de::value::{Error as ValueError, SeqDeserializer};

fn lines(count: usize, text: &str) -> Vec<(String, String)> {
    (0..count)
        .map(|_| (text.to_owned(), String::new()))
        .collect()
}

fn reserved(lines: &[(String, String)]) -> Result<usize, Error> {
    reserve(
        lines
            .iter()
            .map(|(text, quote)| (text.as_str(), quote.as_str())),
        "FAKE model",
        &"a".repeat(64),
        "en",
    )
}

#[test]
fn a_summary_needs_a_line_that_says_something_and_a_quote_that_fits() {
    assert_eq!(reserved(&[]), Err(Error::Invalid));
    for blank in ["", " ", "\n\t  "] {
        assert_eq!(reserved(&lines(1, blank)), Err(Error::Invalid), "{blank:?}");
    }
    let quote = |chars: usize| vec![("a sentence".to_owned(), "q".repeat(chars))];
    assert!(reserved(&quote(MAX_QUOTE_CHARS)).is_ok());
    assert_eq!(reserved(&quote(MAX_QUOTE_CHARS + 1)), Err(Error::Invalid));
    // Counted in characters, not bytes: 240 two-byte letters are a fit.
    let wide = vec![("a sentence".to_owned(), "é".repeat(MAX_QUOTE_CHARS))];
    assert!(reserved(&wide).is_ok());
}

#[test]
fn too_many_lines_or_too_many_bytes_is_too_large_and_never_clipped() {
    assert!(reserved(&lines(100, "x")).is_ok());
    // More lines than the decoder would ever read back.
    assert_eq!(
        reserved(&lines(MAX_SOURCE_ELEMENTS + 1, "x")),
        Err(Error::TooLarge)
    );
    // Fewer lines, but their bytes do not fit the budget.
    assert_eq!(
        reserved(&lines(1, &"x".repeat(MAX_BYTES))),
        Err(Error::TooLarge)
    );
}

#[test]
fn an_edit_is_reserved_before_it_is_made_and_an_index_past_the_end_is_invalid() {
    let base = lines(3, "a line");
    let edit = |replace: Option<usize>, text: &str, quote: &str| {
        reserve_edit(
            base.iter()
                .map(|(text, quote)| (text.as_str(), quote.as_str())),
            replace,
            text,
            quote,
            "FAKE model",
            &"a".repeat(64),
            "en",
        )
    };
    // Replacing each line, and adding one.
    for index in 0..3 {
        assert_eq!(edit(Some(index), "another", ""), Ok(()));
    }
    assert_eq!(edit(None, "a fourth", ""), Ok(()));
    // One past the end is not a line.
    assert_eq!(edit(Some(3), "another", ""), Err(Error::Invalid));
    assert_eq!(edit(Some(usize::MAX), "another", ""), Err(Error::Invalid));
    // The edit itself is checked as a summary line is.
    assert_eq!(edit(Some(0), "  ", ""), Err(Error::Invalid));
    assert_eq!(
        edit(None, "ok", &"q".repeat(MAX_QUOTE_CHARS + 1)),
        Err(Error::Invalid)
    );
    // An edit that makes the summary too big is refused whole, whatever a later rewrite might do.
    assert_eq!(
        edit(Some(1), &"x".repeat(MAX_BYTES), ""),
        Err(Error::TooLarge)
    );
    assert_eq!(edit(None, &"x".repeat(MAX_BYTES), ""), Err(Error::TooLarge));
}

#[test]
fn a_source_span_stays_on_a_page_the_reader_could_have_read() {
    let span = |page: u32, start: u32, end: u32| SourceSpan { page, start, end };
    let last_page = (MAX_PAGES - 1) as u32;
    let edge = MAX_PAGE_BYTES as u32;
    assert!(source_valid(&span(0, 0, 0)));
    assert!(source_valid(&span(last_page, edge, edge)));
    assert!(!source_valid(&span(last_page + 1, 0, 0)));
    assert!(!source_valid(&span(0, 5, 4)));
    assert!(!source_valid(&span(0, 0, edge + 1)));
    assert!(!source_valid(&span(0, edge + 1, edge + 1)));
}

#[test]
fn a_summary_is_saved_only_with_one_source_for_each_sentence_all_on_real_pages() {
    let model = ModelInfo {
        name: "FAKE model".to_owned(),
        sha256: "a".repeat(64),
    };
    let sentences = vec![
        Sentence {
            text: "First.".to_owned(),
            quote: "one".to_owned(),
        },
        Sentence {
            text: "Second.".to_owned(),
            quote: "two".to_owned(),
        },
    ];
    let metadata = |last_page: u32| Metadata {
        created_at: 1,
        partial: true,
        last_page,
        pages_missing: true,
    };
    let good = [
        Some(SourceSpan {
            page: 0,
            start: 0,
            end: 3,
        }),
        None,
    ];
    let saved = serialize_summary(&sentences, &model, "en", metadata(2), &good).unwrap();
    let back: StoredSummary = serde_json::from_str(&saved).unwrap();
    assert_eq!((back.last_page, back.sentences.len()), (2, 2));
    assert!(back.sentences[0].source.is_some() && back.sentences[1].source.is_none());
    validate_stored(&back).unwrap();
    // One source short, one too many, a page past the last, a last page past the limit.
    assert_eq!(
        serialize_summary(&sentences, &model, "en", metadata(2), &good[..1]),
        Err(Error::Invalid)
    );
    let three = [good[0], good[1], None];
    assert_eq!(
        serialize_summary(&sentences, &model, "en", metadata(2), &three),
        Err(Error::Invalid)
    );
    let off_page = [
        Some(SourceSpan {
            page: MAX_PAGES as u32,
            start: 0,
            end: 0,
        }),
        None,
    ];
    assert_eq!(
        serialize_summary(&sentences, &model, "en", metadata(2), &off_page),
        Err(Error::Invalid)
    );
    assert_eq!(
        serialize_summary(
            &sentences,
            &model,
            "en",
            metadata(MAX_PAGES as u32 + 1),
            &good
        ),
        Err(Error::Invalid)
    );
    // A stored summary that says another tool, or a last page past the limit, is not one.
    let mut other: StoredSummary = serde_json::from_str(&saved).unwrap();
    other.tool = "explain".to_owned();
    assert_eq!(validate_stored(&other), Err(Error::Invalid));
    let mut far: StoredSummary = serde_json::from_str(&saved).unwrap();
    far.last_page = MAX_PAGES as u32 + 1;
    assert_eq!(validate_stored(&far), Err(Error::Invalid));
    let mut bad_source: StoredSummary = serde_json::from_str(&saved).unwrap();
    bad_source.sentences[0].source = Some(SourceSpan {
        page: 0,
        start: 9,
        end: 1,
    });
    assert_eq!(validate_stored(&bad_source), Err(Error::Invalid));
}

#[test]
fn a_collection_longer_than_the_decoder_bound_is_refused_whatever_tells_its_length() {
    // A deserializer that knows its length up front: refused before anything is allocated.
    let known: Vec<u8> = vec![1; MAX_SOURCE_ELEMENTS + 1];
    let from_known =
        deserialize_vec::<_, u8>(SeqDeserializer::<_, ValueError>::new(known.into_iter()));
    assert!(from_known.unwrap_err().to_string().contains("too large"));
    // JSON does not say: the bound is counted as the elements are read.
    let json = |count: usize| format!("[{}]", vec!["1"; count].join(","));
    let bounded = |text: String| {
        let mut deserializer = serde_json::Deserializer::from_str(&text);
        deserialize_vec::<_, u8>(&mut deserializer)
    };
    assert_eq!(
        bounded(json(MAX_SOURCE_ELEMENTS)).unwrap().len(),
        MAX_SOURCE_ELEMENTS
    );
    assert!(bounded(json(MAX_SOURCE_ELEMENTS + 1))
        .unwrap_err()
        .to_string()
        .contains("too large"));
    // The same inside the stored summary's sources: null is none, a list is bounded.
    #[derive(Deserialize)]
    struct Holder {
        #[serde(default, deserialize_with = "deserialize_sources")]
        sources: Option<Vec<Option<SourceSpan>>>,
    }
    let none: Holder = serde_json::from_str(r#"{"sources":null}"#).unwrap();
    assert!(none.sources.is_none());
    let some: Holder =
        serde_json::from_str(r#"{"sources":[null,{"page":1,"start":2,"end":3}]}"#).unwrap();
    assert_eq!(some.sources.unwrap().len(), 2);
    let many = format!(
        r#"{{"sources":[{}]}}"#,
        vec!["null"; MAX_SOURCE_ELEMENTS + 1].join(",")
    );
    assert!(serde_json::from_str::<Holder>(&many).is_err());
}

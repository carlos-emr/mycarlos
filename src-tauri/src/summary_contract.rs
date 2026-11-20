//! One final summary/save byte contract, independent of the model's raw grammar.
//! Every irreversible builder edit must fit its reserved envelope. This deliberately
//! refuses an intermediate oversize candidate even if a later rewrite might shrink it.
use crate::local_runner::{ModelInfo, Sentence};
use crate::model_runtime::{SourceSpan, MAX_PAGES, MAX_PAGE_BYTES};
use serde::de::{Error as _, SeqAccess, Visitor};
use serde::ser::SerializeSeq;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::io::{self, Write};

pub(crate) const MAX_BYTES: usize = 64 * 1024;
// Decoder-only bound, not final admission: a minimum reserved entry plus comma is 73
// canonical bytes. Final admission ALWAYS counts the actual production serializer.
pub(crate) const MAX_SOURCE_ELEMENTS: usize = MAX_BYTES / 73;
const MAX_QUOTE_CHARS: usize = crate::model_helper::MAX_QUOTE_CHARS;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Error {
    TooLarge,
    Invalid,
}

struct BoundedWriter {
    length: usize,
    bytes: Option<Vec<u8>>,
    exceeded: bool,
}
impl Write for BoundedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let Some(length) = self
            .length
            .checked_add(bytes.len())
            .filter(|&n| n <= MAX_BYTES)
        else {
            self.exceeded = true;
            return Err(io::Error::other("summary byte budget exceeded"));
        };
        if let Some(output) = &mut self.bytes {
            output.extend_from_slice(bytes);
        }
        self.length = length;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn encode(value: &impl Serialize, keep: bool) -> Result<BoundedWriter, Error> {
    let mut output = BoundedWriter {
        length: 0,
        bytes: keep.then(Vec::new),
        exceeded: false,
    };
    if serde_json::to_writer(&mut output, value).is_err() {
        return Err(if output.exceeded {
            Error::TooLarge
        } else {
            Error::Invalid
        });
    }
    Ok(output)
}
pub(crate) fn bounded_json(value: &impl Serialize) -> Result<String, Error> {
    String::from_utf8(encode(value, true)?.bytes.ok_or(Error::Invalid)?).map_err(|_| Error::Invalid)
}
#[derive(Serialize)]
struct Model<'a> {
    name: &'a str,
    sha256: &'a str,
}
#[derive(Serialize)]
struct Line<'a> {
    text: &'a str,
    quote: &'a str,
    source: Option<SourceSpan>,
}
struct Lines<I>(I);
impl<'a, I> Serialize for Lines<I>
where
    I: Iterator<Item = (&'a str, &'a str, Option<SourceSpan>)> + Clone,
{
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(None)?;
        for (text, quote, source) in self.0.clone() {
            seq.serialize_element(&Line {
                text,
                quote,
                source,
            })?;
        }
        seq.end()
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<'a, S> {
    tool: &'static str,
    sentences: S,
    model: Model<'a>,
    lang: &'a str,
    created_at: u64,
    partial: bool,
    last_page: u32,
    pages_missing: bool,
}
pub(crate) fn reserve<'a, I>(
    lines: I,
    model_name: &str,
    model_sha: &str,
    lang: &str,
) -> Result<usize, Error>
where
    I: Iterator<Item = (&'a str, &'a str)> + Clone,
{
    let count = lines.clone().take(MAX_SOURCE_ELEMENTS + 1).count();
    if count == 0 {
        return Err(Error::Invalid);
    }
    if count > MAX_SOURCE_ELEMENTS {
        return Err(Error::TooLarge);
    }
    if lines
        .clone()
        .any(|(text, quote)| text.trim().is_empty() || quote.chars().count() > MAX_QUOTE_CHARS)
    {
        return Err(Error::Invalid);
    }
    let reserved = lines.map(|(text, quote)| {
        (
            text,
            quote,
            Some(SourceSpan {
                page: (MAX_PAGES - 1) as u32,
                start: MAX_PAGE_BYTES as u32,
                end: MAX_PAGE_BYTES as u32,
            }),
        )
    });
    let view = Envelope {
        tool: "summary",
        sentences: Lines(reserved),
        model: Model {
            name: model_name,
            sha256: model_sha,
        },
        lang,
        created_at: u64::MAX,
        partial: false,
        last_page: MAX_PAGES as u32,
        pages_missing: false,
    };
    Ok(encode(&view, false)?.length)
}
pub(crate) fn reserve_edit<'a, I>(
    lines: I,
    replace: Option<usize>,
    text: &'a str,
    quote: &'a str,
    model_name: &str,
    model_sha: &str,
    lang: &str,
) -> Result<(), Error>
where
    I: Iterator<Item = (&'a str, &'a str)> + Clone,
{
    if replace.is_some_and(|index| index >= lines.clone().take(MAX_SOURCE_ELEMENTS + 1).count()) {
        return Err(Error::Invalid);
    }
    let edited = lines
        .enumerate()
        .map(|(index, old)| {
            if replace == Some(index) {
                (text, quote)
            } else {
                old
            }
        })
        .chain(replace.is_none().then_some((text, quote)));
    reserve(edited, model_name, model_sha, lang).map(|_| ())
}
pub(crate) fn source_valid(source: &SourceSpan) -> bool {
    source.page < MAX_PAGES as u32
        && source.start <= source.end
        && source.end <= MAX_PAGE_BYTES as u32
}
#[derive(Clone, Copy)]
pub(crate) struct Metadata {
    pub created_at: u64,
    pub partial: bool,
    pub last_page: u32,
    pub pages_missing: bool,
}
pub(crate) fn serialize_summary(
    sentences: &[Sentence],
    model: &ModelInfo,
    lang: &str,
    metadata: Metadata,
    sources: &[Option<SourceSpan>],
) -> Result<String, Error> {
    reserve(
        sentences
            .iter()
            .map(|s| (s.text.as_str(), s.quote.as_str())),
        &model.name,
        &model.sha256,
        lang,
    )?;
    if sentences.len() != sources.len()
        || metadata.last_page > MAX_PAGES as u32
        || sources.iter().flatten().any(|s| !source_valid(s))
    {
        return Err(Error::Invalid);
    }
    let view = Envelope {
        tool: "summary",
        sentences: Lines(
            sentences
                .iter()
                .zip(sources)
                .map(|(s, source)| (s.text.as_str(), s.quote.as_str(), *source)),
        ),
        model: Model {
            name: &model.name,
            sha256: &model.sha256,
        },
        lang,
        created_at: metadata.created_at,
        partial: metadata.partial,
        last_page: metadata.last_page,
        pages_missing: metadata.pages_missing,
    };
    bounded_json(&view)
}

// Bounds the native collection allocation, not framework JSON parsing or raw IPC bytes.
pub(crate) fn deserialize_vec<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct Bounded<T>(std::marker::PhantomData<T>);
    impl<'de, T: Deserialize<'de>> Visitor<'de> for Bounded<T> {
        type Value = Vec<T>;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a bounded summary collection")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<T>, A::Error> {
            if seq.size_hint().is_some_and(|n| n > MAX_SOURCE_ELEMENTS) {
                return Err(A::Error::custom("summary collection too large"));
            }
            let mut items =
                Vec::with_capacity(seq.size_hint().unwrap_or(0).min(MAX_SOURCE_ELEMENTS));
            while items.len() < MAX_SOURCE_ELEMENTS {
                match seq.next_element()? {
                    Some(item) => items.push(item),
                    None => return Ok(items),
                }
            }
            if seq.next_element::<serde::de::IgnoredAny>()?.is_some() {
                return Err(A::Error::custom("summary collection too large"));
            }
            Ok(items)
        }
    }
    deserializer.deserialize_seq(Bounded(std::marker::PhantomData))
}
pub(crate) fn deserialize_sources<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<Option<SourceSpan>>>, D::Error> {
    #[derive(Deserialize)]
    struct Sources(#[serde(deserialize_with = "deserialize_vec")] Vec<Option<SourceSpan>>);
    Option::<Sources>::deserialize(deserializer).map(|v| v.map(|s| s.0))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StoredModel {
    pub name: String,
    pub sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StoredSentence {
    pub text: String,
    pub quote: String,
    pub source: Option<SourceSpan>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredSummary {
    pub tool: String,
    #[serde(deserialize_with = "deserialize_vec")]
    pub sentences: Vec<StoredSentence>,
    pub model: StoredModel,
    pub lang: String,
    #[allow(dead_code)]
    pub created_at: u64,
    #[allow(dead_code)]
    pub partial: bool,
    pub last_page: u32,
    #[allow(dead_code)]
    pub pages_missing: bool,
}
pub(crate) fn validate_stored(value: &StoredSummary) -> Result<(), Error> {
    if value.tool != "summary"
        || value.last_page > MAX_PAGES as u32
        || value
            .sentences
            .iter()
            .filter_map(|s| s.source.as_ref())
            .any(|s| !source_valid(s))
    {
        return Err(Error::Invalid);
    }
    reserve(
        value
            .sentences
            .iter()
            .map(|s| (s.text.as_str(), s.quote.as_str())),
        &value.model.name,
        &value.model.sha256,
        &value.lang,
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn model() -> ModelInfo {
        ModelInfo {
            name: "FAKE contract model".to_owned(),
            sha256: "a".repeat(64),
        }
    }
    fn line(text: &str, quote: &str) -> Sentence {
        Sentence {
            text: text.to_owned(),
            quote: quote.to_owned(),
        }
    }
    fn budget(lines: &[Sentence]) -> Result<usize, Error> {
        let model = model();
        reserve(
            lines.iter().map(|s| (s.text.as_str(), s.quote.as_str())),
            &model.name,
            &model.sha256,
            "en",
        )
    }
    fn max_source() -> SourceSpan {
        SourceSpan {
            page: 49,
            start: 262144,
            end: 262144,
        }
    }
    fn metadata() -> Metadata {
        Metadata {
            created_at: u64::MAX,
            partial: false,
            last_page: 50,
            pages_missing: false,
        }
    }
    fn exact_fixture(padding: usize) -> Vec<Sentence> {
        let rule = format!("If amber, {}, call the test desk.", "q".repeat(padding));
        vec![
            line("FAKE summary.", "FAKE document."),
            line(
                &format!("The document says: “{rule}”"),
                &rule.chars().take(240).collect::<String>(),
            ),
        ]
    }
    #[test]
    fn full_text_above_raw_and_glossary_caps_is_preserved_under_the_byte_budget() {
        for length in [301, 2001, 4096] {
            let lines = vec![line(&"x".repeat(length), "FAKE source")];
            let text = serialize_summary(&lines, &model(), "en", metadata(), &[None]).unwrap();
            let saved: StoredSummary = serde_json::from_str(&text).unwrap();
            validate_stored(&saved).unwrap();
            assert_eq!(saved.sentences[0].text.len(), length);
        }
    }
    #[test]
    fn the_actual_serializer_admits_exact_65536_and_refuses_65537_without_clipping() {
        let lines = exact_fixture(64826);
        assert_eq!(budget(&lines), Ok(MAX_BYTES));
        let text = serialize_summary(&lines, &model(), "en", metadata(), &[Some(max_source()); 2])
            .unwrap();
        assert_eq!(text.len(), MAX_BYTES);
        let saved: StoredSummary = serde_json::from_str(&text).unwrap();
        assert_eq!(saved.sentences[1].text, lines[1].text);
        assert_eq!(saved.sentences[1].quote.chars().count(), 240);
        assert_eq!(budget(&exact_fixture(64827)), Err(Error::TooLarge));
    }
    #[test]
    fn decoder_cardinality_is_derived_from_reserved_serialization_not_twenty() {
        let m = model();
        let empty = Envelope {
            tool: "summary",
            sentences: Lines(std::iter::empty::<(&str, &str, Option<SourceSpan>)>()),
            model: Model {
                name: &m.name,
                sha256: &m.sha256,
            },
            lang: "en",
            created_at: u64::MAX,
            partial: false,
            last_page: 50,
            pages_missing: false,
        };
        let envelope = encode(&empty, false).unwrap().length;
        assert_eq!(envelope, 244);
        let one = budget(&[line("a", "")]).unwrap() - envelope;
        assert_eq!(one, 72);
        let capacity = (MAX_BYTES - envelope + 1) / (one + 1);
        assert_eq!(capacity, 894);
        assert!(capacity <= MAX_SOURCE_ELEMENTS);
        assert!(budget(&vec![line("a", ""); capacity]).is_ok());
        assert_eq!(
            budget(&vec![line("a", ""); capacity + 1]),
            Err(Error::TooLarge)
        );
        for count in [20, 21, 22] {
            assert!(budget(&vec![line("FAKE complete rule.", ""); count]).is_ok());
        }
    }
    #[test]
    fn utf8_escaping_is_counted_by_serde_and_null_sources_cannot_overflow_the_reserve() {
        let lines = vec![line(&"é🙂\"\\\n\u{0001}".repeat(100), "FAKE source")];
        let reserved = budget(&lines).unwrap();
        let actual = serialize_summary(&lines, &model(), "en", metadata(), &[None]).unwrap();
        assert_eq!(reserved - actual.len(), 35);
        assert_eq!(
            serde_json::from_str::<StoredSummary>(&actual)
                .unwrap()
                .sentences[0]
                .text,
            lines[0].text
        );
        let mut metadata = metadata();
        metadata.created_at = 1;
        metadata.last_page = 1;
        metadata.partial = true;
        metadata.pages_missing = true;
        assert!(
            serialize_summary(&lines, &model(), "en", metadata, &[None])
                .unwrap()
                .len()
                <= reserved
        );
    }
    #[test]
    fn null_only_actual_fit_does_not_waive_the_explicit_reservation_policy() {
        let base = budget(&[line("x", "")]).unwrap();
        let lines = vec![line(&"x".repeat(MAX_BYTES - base + 2), "")];
        assert_eq!(budget(&lines), Err(Error::TooLarge));
        let actual = serde_json::json!({"tool":"summary","sentences":[{"text":lines[0].text,"quote":"","source":null}],
            "model":model(),"lang":"en","createdAt":1,"partial":true,"lastPage":1,"pagesMissing":true}).to_string();
        assert!(actual.len() < MAX_BYTES);
        assert_eq!(
            serialize_summary(&lines, &model(), "en", metadata(), &[None]),
            Err(Error::TooLarge)
        );
    }
    #[test]
    fn exact_source_count_and_existing_utf16_geometry_are_retained() {
        let lines = vec![line("FAKE.", "FAKE")];
        assert_eq!(
            serialize_summary(&lines, &model(), "en", metadata(), &[]),
            Err(Error::Invalid)
        );
        assert_eq!(
            serialize_summary(&lines, &model(), "en", metadata(), &[None, None]),
            Err(Error::Invalid)
        );
        for span in [
            SourceSpan {
                page: 50,
                start: 0,
                end: 1,
            },
            SourceSpan {
                page: 0,
                start: 2,
                end: 1,
            },
            SourceSpan {
                page: 0,
                start: 0,
                end: 262145,
            },
        ] {
            assert_eq!(
                serialize_summary(&lines, &model(), "en", metadata(), &[Some(span)]),
                Err(Error::Invalid)
            );
        }
        // Offsets remain UTF-16 units with existing absolute bounds, not Rust scalar counts.
        assert!(serialize_summary(
            &lines,
            &model(),
            "en",
            metadata(),
            &[Some(SourceSpan {
                page: 0,
                start: 2,
                end: 4
            })]
        )
        .is_ok());
    }
    #[test]
    fn native_source_decoder_bounds_allocation_and_preserves_null_absence() {
        #[derive(Deserialize)]
        struct Request {
            #[serde(default, deserialize_with = "deserialize_sources")]
            sources: Option<Vec<Option<SourceSpan>>>,
        }
        assert!(serde_json::from_str::<Request>("{}")
            .unwrap()
            .sources
            .is_none());
        assert!(serde_json::from_str::<Request>("{\"sources\":null}")
            .unwrap()
            .sources
            .is_none());
        let bytes =
            serde_json::json!({"sources":vec![None::<SourceSpan>;MAX_SOURCE_ELEMENTS]}).to_string();
        assert_eq!(
            serde_json::from_str::<Request>(&bytes)
                .unwrap()
                .sources
                .unwrap()
                .len(),
            MAX_SOURCE_ELEMENTS
        );
        let bytes = serde_json::json!({"sources":vec![None::<SourceSpan>;MAX_SOURCE_ELEMENTS+1]})
            .to_string();
        assert!(serde_json::from_str::<Request>(&bytes).is_err());
    }
    #[test]
    fn counting_overflow_is_an_error_not_wraparound() {
        let mut writer = BoundedWriter {
            length: usize::MAX,
            bytes: None,
            exceeded: false,
        };
        assert!(writer.write(b"x").is_err());
        assert!(writer.exceeded);
        assert_eq!(writer.length, usize::MAX);
    }
    fn guarded(
        pages: &str,
        lines: &mut Vec<crate::safety::Line>,
    ) -> Result<Vec<crate::safety::Fallback>, Error> {
        let m = model();
        crate::safety::check_guarded(pages, lines, |lines, replace, text, quote| {
            reserve_edit(
                lines.iter().map(|l| (l.text.as_str(), l.quote.as_str())),
                replace,
                text,
                quote,
                &m.name,
                &m.sha256,
                "en",
            )
        })
    }
    #[test]
    fn full_long_rule_and_all_twenty_one_distinct_rules_survive_under_budget() {
        let rule = format!("If amber, {}, call the test desk.", "x".repeat(4096));
        let pages = format!("FAKE document.\n{rule}");
        let initial = vec![crate::safety::Line {
            text: "FAKE summary.".to_owned(),
            quote: "FAKE document.".to_owned(),
        }];
        let mut lines = initial.clone();
        guarded(&pages, &mut lines).unwrap();
        assert_eq!(lines.len(), 2);
        assert!(lines[1].text.contains(&rule));
        assert_eq!(lines[1].quote.chars().count(), 240);
        let words = [
            "amber", "birch", "cobalt", "dahlia", "ember", "fjord", "garnet", "hazel", "indigo",
            "juniper", "kelp", "lilac", "maple", "nectar", "ochre", "pearl", "quartz", "russet",
            "sable", "topaz", "umber",
        ];
        let pages = format!(
            "FAKE document.\n{}",
            words
                .iter()
                .map(|w| format!("If {w}, call the test desk."))
                .collect::<Vec<_>>()
                .join("\n")
        );
        let mut lines = initial;
        guarded(&pages, &mut lines).unwrap();
        assert_eq!(lines.len(), 22);
        for word in words {
            assert!(lines
                .iter()
                .any(|line| line.text.contains(&format!("If {word},"))));
        }
    }
    #[test]
    fn guarded_under_budget_policy_matches_the_original_and_oversize_fails_before_edit() {
        let pages = "FAKE document.\nIf amber, call the test desk.";
        let initial = vec![crate::safety::Line {
            text: "FAKE summary.".to_owned(),
            quote: "FAKE document.".to_owned(),
        }];
        let mut expected = initial.clone();
        let expected_log = crate::safety::check(pages, &mut expected);
        let mut actual = initial.clone();
        let actual_log = guarded(pages, &mut actual).unwrap();
        assert_eq!(actual, expected);
        assert_eq!(actual_log, expected_log);
        let too_large = format!(
            "FAKE document.\nIf amber, {}, call the test desk.",
            "x".repeat(MAX_BYTES)
        );
        let mut lines = initial.clone();
        assert_eq!(guarded(&too_large, &mut lines), Err(Error::TooLarge));
        assert_eq!(lines, initial);
    }
}

//! Every answer the provider can give, turned into a summary or a plain failure (design 4.6).
//! No body, header or error text is ever kept, shown or logged: only the status, the request id
//! the provider names (an identifier in the patient's own account, not personal data) and counts.

use serde::Deserialize;

/// The most sentences, and the longest sentence and quote, an answer may hold: the same shape the
/// local helper's answers have.
pub(crate) const MAX_SENTENCES: usize = 10;
const MAX_SENTENCE_CHARS: usize = 2_000;
const MAX_QUOTE_CHARS: usize = 500;
/// The whole answer, as the kept-answer contract bounds one (`summary_contract::MAX_BYTES`).
pub(crate) const MAX_ANSWER_BYTES: usize = 64 * 1024;

/// What a `Transport` brings back.
pub(crate) struct ProviderResponse {
    pub status: u16,
    /// The provider's `request-id` header, when it came back.
    pub request_id: Option<String>,
    /// `retry-after`, in seconds, when it came back.
    pub retry_after_secs: Option<u64>,
    pub body: Vec<u8>,
}

/// One sentence of an answer and the quote it rests on, still with placeholders in them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AnswerSentence {
    pub text: String,
    pub quote: String,
}

/// A usable answer.
#[derive(Debug)]
pub(crate) struct Answer {
    pub sentences: Vec<AnswerSentence>,
    pub request_id: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

/// Why there is no answer, in the words the patient is told (the screens map these; the strings
/// here are only names).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    /// 200 with `stop_reason: max_tokens`: cut short, nothing kept.
    Truncated,
    /// 200 with `stop_reason: refusal`: declined, never retried silently.
    Declined,
    /// Not valid JSON, not the schema, or over the bounds.
    Unusable,
    /// 400.
    InvalidRequest,
    /// 401: the key was not accepted.
    KeyRejected,
    /// 402: a billing problem with the account.
    Billing,
    /// 403.
    Forbidden,
    /// 404: this key's account cannot use this model.
    ModelUnavailable,
    /// 413.
    TooLarge,
    /// 429, with `retry-after` when given.
    RateLimited { retry_after_secs: Option<u64> },
    /// 500 and 529.
    Busy,
    /// Any other status.
    Unexpected,
    /// No response at all. `maybe_arrived` is true when the failure came after the request was sent.
    Unreachable { maybe_arrived: bool },
    /// The patient cancelled (or a lock ended it) while waiting.
    Cancelled,
}

impl Failure {
    /// A stable name for the history and the screens' message keys.
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::Truncated => "truncated",
            Self::Declined => "declined",
            Self::Unusable => "unusable",
            Self::InvalidRequest => "invalidRequest",
            Self::KeyRejected => "keyRejected",
            Self::Billing => "billing",
            Self::Forbidden => "forbidden",
            Self::ModelUnavailable => "modelUnavailable",
            Self::TooLarge => "tooLarge",
            Self::RateLimited { .. } => "rateLimited",
            Self::Busy => "busy",
            Self::Unexpected => "unexpected",
            Self::Unreachable { .. } => "unreachable",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    stop_reason: Option<String>,
    #[serde(default)]
    content: Vec<Block>,
    #[serde(default)]
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct Block {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Deserialize)]
struct Usage {
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Summary {
    sentences: Vec<RawSentence>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSentence {
    text: String,
    quote: String,
}

/// An answer, or why there is none.
pub(crate) fn interpret(response: &ProviderResponse) -> Result<Answer, Failure> {
    match response.status {
        200 => {}
        400 => return Err(Failure::InvalidRequest),
        401 => return Err(Failure::KeyRejected),
        402 => return Err(Failure::Billing),
        403 => return Err(Failure::Forbidden),
        404 => return Err(Failure::ModelUnavailable),
        413 => return Err(Failure::TooLarge),
        429 => {
            return Err(Failure::RateLimited {
                retry_after_secs: response.retry_after_secs,
            })
        }
        500 | 529 => return Err(Failure::Busy),
        _ => return Err(Failure::Unexpected),
    }
    if response.body.len() > 4 * MAX_ANSWER_BYTES {
        return Err(Failure::Unusable);
    }
    let message: Message = serde_json::from_slice(&response.body).map_err(|_| Failure::Unusable)?;
    match message.stop_reason.as_deref() {
        Some("end_turn") | Some("stop_sequence") => {}
        Some("max_tokens") => return Err(Failure::Truncated),
        Some("refusal") => return Err(Failure::Declined),
        _ => return Err(Failure::Unusable),
    }
    let text = message
        .content
        .iter()
        .find(|block| block.kind == "text")
        .and_then(|block| block.text.as_deref())
        .ok_or(Failure::Unusable)?;
    if text.len() > MAX_ANSWER_BYTES {
        return Err(Failure::Unusable);
    }
    let summary: Summary = serde_json::from_str(text).map_err(|_| Failure::Unusable)?;
    if summary.sentences.is_empty() || summary.sentences.len() > MAX_SENTENCES {
        return Err(Failure::Unusable);
    }
    let mut sentences = Vec::with_capacity(summary.sentences.len());
    for raw in summary.sentences {
        let clean = |value: &str, most: usize| {
            let chars = value.chars().count();
            chars >= 1 && chars <= most && !value.chars().any(|c| c.is_control() && c != '\n')
        };
        if !clean(&raw.text, MAX_SENTENCE_CHARS) || !clean(&raw.quote, MAX_QUOTE_CHARS) {
            return Err(Failure::Unusable);
        }
        sentences.push(AnswerSentence {
            text: raw.text,
            quote: raw.quote,
        });
    }
    let usage = message.usage;
    Ok(Answer {
        sentences,
        request_id: response
            .request_id
            .clone()
            .filter(|id| id.len() <= 128 && id.bytes().all(|b| b.is_ascii_graphic())),
        input_tokens: usage.as_ref().and_then(|usage| usage.input_tokens),
        output_tokens: usage.as_ref().and_then(|usage| usage.output_tokens),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(status: u16, body: &str) -> ProviderResponse {
        ProviderResponse {
            status,
            request_id: Some("req_FAKE123".into()),
            retry_after_secs: None,
            body: body.as_bytes().to_vec(),
        }
    }

    fn ok_body(stop: &str, summary: &str) -> String {
        serde_json::json!({
            "stop_reason": stop,
            "content": [{ "type": "text", "text": summary }],
            "usage": { "input_tokens": 2914, "output_tokens": 611 }
        })
        .to_string()
    }

    const SUMMARY: &str = r#"{"sentences":[{"text":"[NAME 1] has a fever.","quote":"Patient [NAME 1] presents with fever"}]}"#;

    #[test]
    fn a_valid_answer_keeps_its_sentences_ids_and_counts() {
        let answer = interpret(&response(200, &ok_body("end_turn", SUMMARY))).unwrap();
        assert_eq!(answer.sentences.len(), 1);
        assert_eq!(answer.sentences[0].text, "[NAME 1] has a fever.");
        assert_eq!(answer.request_id.as_deref(), Some("req_FAKE123"));
        assert_eq!(answer.input_tokens, Some(2914));
        assert_eq!(answer.output_tokens, Some(611));
    }

    #[test]
    fn every_status_has_its_own_plain_failure() {
        let named = |status| interpret(&response(status, "{}")).err().unwrap();
        assert_eq!(named(400), Failure::InvalidRequest);
        assert_eq!(named(401), Failure::KeyRejected);
        assert_eq!(named(402), Failure::Billing);
        assert_eq!(named(403), Failure::Forbidden);
        assert_eq!(named(404), Failure::ModelUnavailable);
        assert_eq!(named(413), Failure::TooLarge);
        assert_eq!(named(500), Failure::Busy);
        assert_eq!(named(529), Failure::Busy);
        assert_eq!(named(302), Failure::Unexpected);
        assert_eq!(named(418), Failure::Unexpected);
        let mut limited = response(429, "{}");
        limited.retry_after_secs = Some(30);
        assert_eq!(
            interpret(&limited).err(),
            Some(Failure::RateLimited {
                retry_after_secs: Some(30)
            })
        );
        assert_eq!(
            interpret(&response(429, "{}")).err(),
            Some(Failure::RateLimited {
                retry_after_secs: None
            })
        );
    }

    #[test]
    fn a_cut_short_or_declined_answer_keeps_nothing() {
        assert_eq!(
            interpret(&response(200, &ok_body("max_tokens", SUMMARY))).err(),
            Some(Failure::Truncated)
        );
        assert_eq!(
            interpret(&response(200, &ok_body("refusal", SUMMARY))).err(),
            Some(Failure::Declined)
        );
        assert_eq!(
            interpret(&response(200, &ok_body("tool_use", SUMMARY))).err(),
            Some(Failure::Unusable)
        );
    }

    #[test]
    fn bad_json_a_broken_schema_and_oversize_answers_are_unusable() {
        for body in [
            "not json".to_owned(),
            "{}".to_owned(),
            ok_body("end_turn", "not json"),
            ok_body("end_turn", r#"{"sentences":[]}"#),
            ok_body("end_turn", r#"{"sentences":[{"text":"a"}]}"#),
            ok_body(
                "end_turn",
                r#"{"sentences":[{"text":"a","quote":"b","extra":1}]}"#,
            ),
            ok_body("end_turn", r#"{"sentences":[{"text":"","quote":"b"}]}"#),
            ok_body(
                "end_turn",
                r#"{"sentences":[{"text":"a\u0007b","quote":"b"}]}"#,
            ),
            ok_body(
                "end_turn",
                &format!(
                    r#"{{"sentences":[{{"text":"a","quote":"{}"}}]}}"#,
                    "q".repeat(501)
                ),
            ),
            ok_body(
                "end_turn",
                &format!(
                    r#"{{"sentences":[{}]}}"#,
                    [r#"{"text":"a","quote":"b"}"#; MAX_SENTENCES + 1].join(",")
                ),
            ),
            serde_json::json!({"stop_reason":"end_turn","content":[{"type":"thinking"}]})
                .to_string(),
        ] {
            assert_eq!(
                interpret(&response(200, &body)).err(),
                Some(Failure::Unusable),
                "{}",
                &body[..body.len().min(60)]
            );
        }
        let huge = ProviderResponse {
            status: 200,
            request_id: None,
            retry_after_secs: None,
            body: vec![b' '; 4 * MAX_ANSWER_BYTES + 1],
        };
        assert_eq!(interpret(&huge).err(), Some(Failure::Unusable));
    }

    #[test]
    fn a_request_id_that_is_not_plain_is_dropped() {
        let mut odd = response(200, &ok_body("end_turn", SUMMARY));
        odd.request_id = Some("req with spaces".into());
        assert_eq!(interpret(&odd).unwrap().request_id, None);
        odd.request_id = Some("r".repeat(129));
        assert_eq!(interpret(&odd).unwrap().request_id, None);
    }

    #[test]
    fn failure_names_are_stable() {
        assert_eq!(
            Failure::Unreachable {
                maybe_arrived: true
            }
            .name(),
            "unreachable"
        );
        assert_eq!(Failure::Cancelled.name(), "cancelled");
        assert_eq!(
            Failure::RateLimited {
                retry_after_secs: None
            }
            .name(),
            "rateLimited"
        );
    }
}

//! Google Gemini (`generateContent`). **Every request shape, header and model id here is VERIFY**:
//! none was run against the live service. They are pinned by the one live contract check (Ben, a
//! real key on FAKE text) before this provider can be chosen: until then `VERIFIED_MODELS` is empty,
//! so `Provider::selectable()` is false and nothing is built from these shapes outside the tests.
//!
//! The key goes in the `x-goog-api-key` header, **never in the address** (the service also accepts
//! a `key=` query parameter; it is not used, because an address is logged and shown more freely
//! than a header).

use super::{KeyShape, Method, ModelSpec, PlannedRequest, Provider, RequestError};
use crate::cloud_ai::request::summary_system_prompt;
use crate::ui_text::UiLocale;

pub(crate) const HOST: &str = "generativelanguage.googleapis.com";
/// The key test lists models.
pub(crate) const LIST_PATH: &str = "/v1beta/models";
/// A summary is short; the cap on the answer.
const MAX_ANSWER_TOKENS: u32 = 8000;

/// The models, with prices, once each has been verified against Google's current documentation and
/// the live check. **Deliberately empty:** no id or price is written from memory.
pub(crate) const VERIFIED_MODELS: &[ModelSpec] = &[];

#[cfg(test)]
const TEST_MODELS: &[ModelSpec] = &[ModelSpec {
    id: "fake-gemini-model",
    label: "FAKE Gemini model",
    input_per_mtok: Some(0.5),
    output_per_mtok: Some(2.0),
}];

pub(crate) fn models() -> &'static [ModelSpec] {
    #[cfg(test)]
    {
        TEST_MODELS
    }
    #[cfg(not(test))]
    {
        VERIFIED_MODELS
    }
}

/// The path that asks one listed model for an answer. The model id is the provider's own text: it
/// must be only lower-case letters, digits, dots and hyphens (checked by `valid_model_segment`).
pub(crate) fn generate_path(model_id: &str) -> String {
    format!("/v1beta/models/{model_id}:generateContent")
}

fn valid_model_segment(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-'
        })
}

/// A Google API key: `AIza` and 35 more characters of letters, digits, `-` and `_` (VERIFY the length).
pub(crate) fn check_key(key: &str) -> Result<(), KeyShape> {
    super::printable_key(key)?;
    if !key.starts_with("AIza") {
        return Err(KeyShape::WrongProvider);
    }
    if key.len() != 39
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(KeyShape::Malformed);
    }
    Ok(())
}

fn auth(key: &str) -> (&'static str, String) {
    ("x-goog-api-key", key.to_owned())
}

/// The structured answer asked for. Gemini's schema subset has no `additionalProperties` (VERIFY the
/// type spelling and the field, `responseSchema` or `responseJsonSchema`).
fn summary_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "sentences": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "text": { "type": "string" },
                        "quote": { "type": "string" }
                    },
                    "required": ["text", "quote"]
                }
            }
        },
        "required": ["sentences"]
    })
}

pub(crate) fn summary_request(
    key: &str,
    model: &ModelSpec,
    language: UiLocale,
    text: &str,
) -> Result<PlannedRequest, RequestError> {
    if !valid_model_segment(model.id) {
        return Err(RequestError::UnknownModel);
    }
    let body = serde_json::json!({
        "systemInstruction": { "parts": [ { "text": summary_system_prompt(language) } ] },
        "contents": [ { "role": "user", "parts": [ { "text": text } ] } ],
        "generationConfig": {
            "maxOutputTokens": MAX_ANSWER_TOKENS,
            "responseMimeType": "application/json",
            "responseSchema": summary_schema()
        }
    });
    Ok(PlannedRequest {
        provider: Provider::Gemini,
        method: Method::Post,
        path: generate_path(model.id),
        headers: vec![auth(key), ("content-type", "application/json".to_owned())],
        body: serde_json::to_vec(&body).map_err(|_| RequestError::BadText)?,
    })
}

pub(crate) fn key_test_request(key: &str) -> Result<PlannedRequest, RequestError> {
    Ok(PlannedRequest {
        provider: Provider::Gemini,
        method: Method::Get,
        path: LIST_PATH.to_owned(),
        headers: vec![auth(key)],
        body: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_ai::provider::{build_key_test_request, build_summary_request, url_allowed};

    const KEY: &str = "AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEa1b";

    #[test]
    fn the_key_is_in_the_google_header_and_the_model_is_in_the_path_only_from_the_list() {
        let request = build_summary_request(
            Provider::Gemini,
            KEY,
            "fake-gemini-model",
            UiLocale::En,
            "FAKE text [NAME 1].",
        )
        .unwrap();
        assert_eq!(
            request.url(),
            "https://generativelanguage.googleapis.com/v1beta/models/fake-gemini-model:generateContent"
        );
        assert!(url_allowed(&request.url()));
        let names: Vec<_> = request.headers.iter().map(|(name, _)| *name).collect();
        assert_eq!(names, ["x-goog-api-key", "content-type"]);
        let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        let mut keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["contents", "generationConfig", "systemInstruction"]);
        assert_eq!(
            body["contents"][0]["parts"][0]["text"],
            "FAKE text [NAME 1]."
        );
        for forbidden in ["tools", "safetySettings", "cachedContent"] {
            assert!(body.get(forbidden).is_none(), "{forbidden}");
        }
        // The same path for a model that is not on the list is not allowed.
        assert!(!url_allowed(
            "https://generativelanguage.googleapis.com/v1beta/models/other-model:generateContent"
        ));
    }

    #[test]
    fn a_model_id_that_could_change_the_path_is_never_built() {
        for odd in ["a/b", "a:b", "a b", "A", "", "a?b=1", "../x", "a\n"] {
            assert!(!valid_model_segment(odd), "{odd:?}");
        }
        let spec = ModelSpec {
            id: "evil/../model",
            label: "x",
            input_per_mtok: None,
            output_per_mtok: None,
        };
        assert_eq!(
            summary_request(KEY, &spec, UiLocale::En, "x").err(),
            Some(RequestError::UnknownModel)
        );
    }

    #[test]
    fn the_key_test_lists_models_with_no_key_in_the_address() {
        let request = build_key_test_request(Provider::Gemini, KEY).unwrap();
        assert_eq!(request.method, Method::Get);
        assert_eq!(
            request.url(),
            "https://generativelanguage.googleapis.com/v1beta/models"
        );
        assert!(!request.url().contains("key"));
        assert!(request.body.is_empty());
    }

    #[test]
    fn key_shapes() {
        assert!(check_key(KEY).is_ok());
        assert_eq!(
            check_key("sk-ant-api03-FAKEFAKEFAKEFAKEFAKEa1b2"),
            Err(KeyShape::WrongProvider)
        );
        assert_eq!(
            check_key("sk-proj-FAKEFAKEFAKEFAKEFAKEFAKEa1b2"),
            Err(KeyShape::WrongProvider)
        );
        assert_eq!(
            check_key("AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEa1"),
            Err(KeyShape::Malformed)
        );
        assert_eq!(
            check_key("AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKE.AKEa1b"),
            Err(KeyShape::Malformed)
        );
    }

    #[test]
    fn the_shipped_model_list_is_empty_until_it_is_verified() {
        assert!(VERIFIED_MODELS.is_empty());
    }
}

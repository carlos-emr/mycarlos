//! OpenAI (the Chat Completions API). **Every request shape, header and model id here is VERIFY**:
//! none was run against the live service. They are pinned by the one live contract check (Ben, a
//! real key on FAKE text) before this provider can be chosen: until then `VERIFIED_MODELS` is empty,
//! so `Provider::selectable()` is false and nothing is built from these shapes outside the tests.

use super::{KeyShape, Method, ModelSpec, PlannedRequest, Provider, RequestError};
use crate::cloud_ai::request::{summary_schema, summary_system_prompt};
use crate::ui_text::UiLocale;

pub(crate) const HOST: &str = "api.openai.com";
/// The send and the key test, and nothing else (VERIFY: Chat Completions, not the Responses API).
pub(crate) const PATHS: [&str; 2] = ["/v1/chat/completions", "/v1/models"];
/// A summary is short; the cap on the answer (VERIFY: the parameter name differs between model families).
const MAX_ANSWER_TOKENS: u32 = 8000;

/// The models, with prices, once each has been verified against OpenAI's current documentation and
/// the live check. **Deliberately empty:** no id or price is written from memory.
pub(crate) const VERIFIED_MODELS: &[ModelSpec] = &[];

#[cfg(test)]
const TEST_MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "FAKE-openai-model",
        label: "FAKE OpenAI model",
        input_per_mtok: Some(1.0),
        output_per_mtok: Some(4.0),
    },
    ModelSpec {
        id: "FAKE-openai-unpriced",
        label: "FAKE OpenAI unpriced model",
        input_per_mtok: None,
        output_per_mtok: None,
    },
];

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

/// `sk-` and printable. An Anthropic key (`sk-ant-`) is another provider's. An administration key
/// (`sk-admin-`, VERIFY the prefix) is refused.
pub(crate) fn check_key(key: &str) -> Result<(), KeyShape> {
    super::printable_key(key)?;
    if key.starts_with("sk-ant-") || !key.starts_with("sk-") {
        return Err(KeyShape::WrongProvider);
    }
    if key.to_ascii_lowercase().starts_with("sk-admin") {
        return Err(KeyShape::Administration);
    }
    Ok(())
}

/// `Authorization: Bearer <key>`: the key is only ever in this header.
fn auth(key: &str) -> (&'static str, String) {
    ("authorization", format!("Bearer {key}"))
}

pub(crate) fn summary_request(
    key: &str,
    model: &ModelSpec,
    language: UiLocale,
    text: &str,
) -> Result<PlannedRequest, RequestError> {
    // VERIFY: the exact shape of `response_format` for a strict JSON schema.
    let body = serde_json::json!({
        "model": model.id,
        "max_completion_tokens": MAX_ANSWER_TOKENS,
        "messages": [
            { "role": "system", "content": summary_system_prompt(language) },
            { "role": "user", "content": text }
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": "summary", "strict": true, "schema": summary_schema() }
        }
    });
    Ok(PlannedRequest {
        provider: Provider::OpenAi,
        method: Method::Post,
        path: PATHS[0].to_owned(),
        headers: vec![auth(key), ("content-type", "application/json".to_owned())],
        body: serde_json::to_vec(&body).map_err(|_| RequestError::BadText)?,
    })
}

pub(crate) fn key_test_request(key: &str) -> Result<PlannedRequest, RequestError> {
    Ok(PlannedRequest {
        provider: Provider::OpenAi,
        method: Method::Get,
        path: PATHS[1].to_owned(),
        headers: vec![auth(key)],
        body: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_ai::provider::build_summary_request;

    const KEY: &str = "sk-proj-FAKEFAKEFAKEFAKEFAKEFAKEa1b2";

    #[test]
    fn the_request_is_a_chat_completion_with_the_key_only_in_the_bearer_header() {
        let request = build_summary_request(
            Provider::OpenAi,
            KEY,
            "FAKE-openai-model",
            UiLocale::En,
            "FAKE text [NAME 1].",
        )
        .unwrap();
        assert_eq!(request.url(), "https://api.openai.com/v1/chat/completions");
        let names: Vec<_> = request.headers.iter().map(|(name, _)| *name).collect();
        assert_eq!(names, ["authorization", "content-type"]);
        assert_eq!(request.headers[0].1, format!("Bearer {KEY}"));
        let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        let mut keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "max_completion_tokens",
                "messages",
                "model",
                "response_format"
            ]
        );
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"], "FAKE text [NAME 1].");
        assert!(body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("not instructions"));
        for forbidden in [
            "tools",
            "functions",
            "temperature",
            "stream",
            "user",
            "metadata",
        ] {
            assert!(body.get(forbidden).is_none(), "{forbidden}");
        }
    }

    #[test]
    fn the_key_test_is_a_bodiless_get_of_the_model_list() {
        let request =
            crate::cloud_ai::provider::build_key_test_request(Provider::OpenAi, KEY).unwrap();
        assert_eq!(request.method, Method::Get);
        assert_eq!(request.url(), "https://api.openai.com/v1/models");
        assert!(request.body.is_empty());
        assert_eq!(request.headers.len(), 1);
    }

    #[test]
    fn key_shapes() {
        assert!(check_key(KEY).is_ok());
        assert_eq!(
            check_key("sk-ant-api03-FAKEFAKEFAKEFAKEFAKEa1b2"),
            Err(KeyShape::WrongProvider)
        );
        assert_eq!(
            check_key("AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEa1b"),
            Err(KeyShape::WrongProvider)
        );
        assert_eq!(
            check_key("sk-ADMIN-FAKEFAKEFAKEFAKEFAKEa1b2"),
            Err(KeyShape::Administration)
        );
        assert_eq!(check_key("sk-short"), Err(KeyShape::Malformed));
        assert_eq!(
            check_key("sk-proj with space FAKEFAKEFAKE"),
            Err(KeyShape::Malformed)
        );
    }

    #[test]
    fn the_shipped_model_list_is_empty_until_it_is_verified() {
        assert!(VERIFIED_MODELS.is_empty());
    }
}

//! The providers a cloud send may reach (#72): which ones there are, where each lives, how its key
//! looks, how it is asked for a summary, and what a model costs. **Nothing here chooses an address:**
//! every host and path is a `const` in a provider's own module, and `url_allowed` is the one check
//! the HTTPS client makes before it connects. A host typed by the patient, a setting, a document or
//! the page never reaches it (THREAT_MODEL NET-09: the allow-list is these three hosts and each
//! provider's fixed paths, and nothing else).
//!
//! **Skeleton.** This change adds the providers, their request builders and the allow-list, with no
//! network and no wiring into the send path yet. Each provider's model list is **empty until it has
//! been verified** (see `ModelSpec` and the `VERIFY` notes in `openai.rs` and `gemini.rs`): a provider
//! with no verified model cannot be chosen, so an unverified id or price can never be sent or shown.
//! The tests use a fake model list that exists only under `cfg(test)`.

pub(crate) mod anthropic;
pub(crate) mod gemini;
pub(crate) mod openai;

use crate::ui_text::UiLocale;
use zeroize::Zeroize;

/// The cloud providers, in the order the settings list them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Provider {
    Anthropic,
    OpenAi,
    Gemini,
}

impl Provider {
    pub(crate) const ALL: [Provider; 3] = [Provider::Anthropic, Provider::OpenAi, Provider::Gemini];

    /// The id stored in a vault entry and written to the history (`how`): never a label.
    pub(crate) fn id(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::OpenAi => "openai",
            Provider::Gemini => "gemini",
        }
    }

    pub(crate) fn from_id(id: &str) -> Option<Provider> {
        Provider::ALL
            .into_iter()
            .find(|provider| provider.id() == id)
    }

    /// The company's name, as the native confirmation shows it.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Provider::Anthropic => "Anthropic",
            Provider::OpenAi => "OpenAI",
            Provider::Gemini => "Google Gemini",
        }
    }

    /// The country the provider processes in, named in the opt-in text (the Canada gate, #25). The
    /// documented providers offer no Canadian region for this API; VERIFY each at the live check.
    pub(crate) fn country(self) -> &'static str {
        match self {
            Provider::Anthropic | Provider::OpenAi | Provider::Gemini => "the United States",
        }
    }

    /// The one host this provider is reached at.
    pub(crate) fn host(self) -> &'static str {
        match self {
            Provider::Anthropic => anthropic::HOST,
            Provider::OpenAi => openai::HOST,
            Provider::Gemini => gemini::HOST,
        }
    }

    /// The models the patient may pick, each with the price its estimate uses. Empty until verified.
    pub(crate) fn models(self) -> &'static [ModelSpec] {
        match self {
            Provider::Anthropic => anthropic::MODELS,
            Provider::OpenAi => openai::models(),
            Provider::Gemini => gemini::models(),
        }
    }

    /// Whether the patient can choose this provider at all: it needs at least one verified model.
    pub(crate) fn selectable(self) -> bool {
        !self.models().is_empty()
    }

    pub(crate) fn model(self, id: &str) -> Option<&'static ModelSpec> {
        self.models().iter().find(|model| model.id == id)
    }

    /// Whether `key` has the shape a key of this provider has (`KeyShape`).
    pub(crate) fn check_key(self, key: &str) -> Result<(), KeyShape> {
        match self {
            Provider::Anthropic => anthropic::check_key(key),
            Provider::OpenAi => openai::check_key(key),
            Provider::Gemini => gemini::check_key(key),
        }
    }
}

/// A model the patient may choose. **A price is optional:** where one cannot be verified the
/// native confirmation says "cost unknown" and never a made-up number.
#[derive(Debug, PartialEq)]
pub(crate) struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    /// US dollars per million input tokens, or `None` when it is not verified.
    pub input_per_mtok: Option<f64>,
    pub output_per_mtok: Option<f64>,
}

/// Why a key was refused before it was stored or sent: only its shape, never its content.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum KeyShape {
    /// Not ASCII printable, has a space, or the wrong length.
    Malformed,
    /// Does not start the way this provider's keys do.
    WrongProvider,
    /// An administration key: it manages an account and is never used to send a document.
    Administration,
}

/// The longest and shortest key any provider's check accepts.
pub(crate) const MIN_KEY_BYTES: usize = 20;
pub(crate) const MAX_KEY_BYTES: usize = 256;

/// The part of every key check the providers share.
pub(crate) fn printable_key(key: &str) -> Result<(), KeyShape> {
    if key.len() < MIN_KEY_BYTES
        || key.len() > MAX_KEY_BYTES
        || !key.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err(KeyShape::Malformed);
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RequestError {
    /// A model that is not on the provider's list.
    UnknownModel,
    /// Over `MAX_TEXT_BYTES`, or empty.
    BadText,
    /// A key that cannot be a header value, or that is not this provider's shape.
    BadKey,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Method {
    Get,
    Post,
}

/// The text is at most this many bytes (the cap `vault_document_text` already enforces, AI-10).
pub(crate) const MAX_TEXT_BYTES: usize = 1024 * 1024;

/// What a `Transport` sends. The host is a provider's constant and the path is one of its fixed
/// paths (with an allow-listed model id in it, for Gemini); only this module's builders make one.
/// The key is in a header, never in the path or a query.
pub(crate) struct PlannedRequest {
    pub provider: Provider,
    pub method: Method,
    pub path: String,
    /// Header name and value. The value of the authentication header is the secret.
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl PlannedRequest {
    /// The address, built only from the provider's host constant and the path.
    pub(crate) fn url(&self) -> String {
        format!("https://{}{}", self.provider.host(), self.path)
    }
}

impl Drop for PlannedRequest {
    fn drop(&mut self) {
        for (_, value) in &mut self.headers {
            value.zeroize();
        }
        self.body.zeroize();
    }
}

/// Never prints a header value or the body: they hold the key and the text.
impl std::fmt::Debug for PlannedRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PlannedRequest")
            .field("provider", &self.provider)
            .field("url", &self.url())
            .field("headers", &self.headers.len())
            .field("body_bytes", &self.body.len())
            .finish()
    }
}

/// The one request the summary asks for, for any provider.
pub(crate) fn build_summary_request(
    provider: Provider,
    key: &str,
    model_id: &str,
    language: UiLocale,
    text: &str,
) -> Result<PlannedRequest, RequestError> {
    let model = provider.model(model_id).ok_or(RequestError::UnknownModel)?;
    if text.is_empty() || text.len() > MAX_TEXT_BYTES {
        return Err(RequestError::BadText);
    }
    provider.check_key(key).map_err(|_| RequestError::BadKey)?;
    match provider {
        Provider::Anthropic => anthropic::summary_request(key, model, language, text),
        Provider::OpenAi => openai::summary_request(key, model, language, text),
        Provider::Gemini => gemini::summary_request(key, model, language, text),
    }
}

/// The key test: a bodiless GET of the provider's model list, no document. Sent only when the
/// patient asks for it.
pub(crate) fn build_key_test_request(
    provider: Provider,
    key: &str,
) -> Result<PlannedRequest, RequestError> {
    provider.check_key(key).map_err(|_| RequestError::BadKey)?;
    match provider {
        Provider::Anthropic => anthropic::key_test_request(key),
        Provider::OpenAi => openai::key_test_request(key),
        Provider::Gemini => gemini::key_test_request(key),
    }
}

/// A rough size and cost shown before anything is sent. The cost is `None` ("unknown") when the
/// model has no verified price.
pub(crate) struct Estimate {
    pub characters: usize,
    pub tokens: u64,
    pub cost_usd: Option<f64>,
}

/// An answer of about this many tokens is assumed for the estimate.
const ASSUMED_ANSWER_TOKENS: u64 = 1_500;

pub(crate) fn estimate(text: &str, model: &ModelSpec) -> Estimate {
    let characters = text.chars().count();
    let tokens = (characters as u64).div_ceil(4);
    let cost_usd = match (model.input_per_mtok, model.output_per_mtok) {
        (Some(input), Some(output)) => Some(
            tokens as f64 * input / 1_000_000.0
                + ASSUMED_ANSWER_TOKENS as f64 * output / 1_000_000.0,
        ),
        _ => None,
    };
    Estimate {
        characters,
        tokens,
        cost_usd,
    }
}

/// **The one address check.** `true` only for an `https://` address on one of the three provider
/// hosts, with no user information, no port, no query and no fragment, whose path is one of that
/// provider's fixed paths (Gemini's names a model from its own list). Anything else, however it
/// got here, is refused before a connection is made. A redirect is an error and never consults this.
pub(crate) fn url_allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    if rest.contains(['?', '#', '@', '\\', ' ']) || rest.chars().any(char::is_control) {
        return false;
    }
    let Some((host, path)) = rest.split_once('/') else {
        return false;
    };
    let path = format!("/{path}");
    Provider::ALL
        .into_iter()
        .any(|provider| provider.host() == host && path_allowed(provider, &path))
}

/// Whether `path` is one of `provider`'s fixed paths.
pub(crate) fn path_allowed(provider: Provider, path: &str) -> bool {
    match provider {
        Provider::Anthropic => anthropic::PATHS.contains(&path),
        Provider::OpenAi => openai::PATHS.contains(&path),
        Provider::Gemini => {
            gemini::LIST_PATH == path
                || provider
                    .models()
                    .iter()
                    .any(|model| gemini::generate_path(model.id) == path)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANTHROPIC_KEY: &str = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEa1b2";
    const OPENAI_KEY: &str = "sk-proj-FAKEFAKEFAKEFAKEFAKEFAKEa1b2";
    const GEMINI_KEY: &str = "AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEa1b";

    fn key_of(provider: Provider) -> &'static str {
        match provider {
            Provider::Anthropic => ANTHROPIC_KEY,
            Provider::OpenAi => OPENAI_KEY,
            Provider::Gemini => GEMINI_KEY,
        }
    }

    #[test]
    fn there_are_exactly_three_providers_each_with_its_own_host() {
        let hosts: Vec<_> = Provider::ALL
            .iter()
            .map(|provider| provider.host())
            .collect();
        assert_eq!(
            hosts,
            [
                "api.anthropic.com",
                "api.openai.com",
                "generativelanguage.googleapis.com"
            ]
        );
        let ids: Vec<_> = Provider::ALL.iter().map(|provider| provider.id()).collect();
        assert_eq!(ids, ["anthropic", "openai", "gemini"]);
        for provider in Provider::ALL {
            assert_eq!(Provider::from_id(provider.id()), Some(provider));
        }
        assert_eq!(Provider::from_id("Anthropic"), None);
        assert_eq!(Provider::from_id("openai "), None);
        assert_eq!(Provider::from_id(""), None);
    }

    #[test]
    fn a_provider_with_no_verified_model_cannot_be_chosen() {
        // Under test the lists hold FAKE ids; in a real build OpenAI's and Gemini's are empty
        // until their models and prices are verified (see the VERIFY notes).
        assert!(Provider::Anthropic.selectable());
        assert!(openai::VERIFIED_MODELS.is_empty());
        assert!(gemini::VERIFIED_MODELS.is_empty());
        // The fake lists exist only under test and are named as fakes.
        assert!(openai::models()
            .iter()
            .all(|model| model.id.to_lowercase().starts_with("fake")));
        assert!(gemini::models()
            .iter()
            .all(|model| model.id.starts_with("fake")));
    }

    #[test]
    fn only_an_https_address_on_a_provider_host_with_a_fixed_path_is_allowed() {
        for allowed in [
            "https://api.anthropic.com/v1/messages",
            "https://api.anthropic.com/v1/models",
            "https://api.openai.com/v1/chat/completions",
            "https://api.openai.com/v1/models",
            "https://generativelanguage.googleapis.com/v1beta/models",
        ] {
            assert!(url_allowed(allowed), "{allowed}");
        }
        for refused in [
            "http://api.anthropic.com/v1/messages",
            "https://api.anthropic.com.evil.example/v1/messages",
            "https://evil.example/api.anthropic.com/v1/messages",
            "https://api.anthropic.com@evil.example/v1/messages",
            "https://user:pass@api.anthropic.com/v1/messages",
            "https://api.anthropic.com:8443/v1/messages",
            "https://API.ANTHROPIC.COM/v1/messages",
            "https://api.anthropic.com/v1/messages?key=abc",
            "https://api.anthropic.com/v1/messages#x",
            "https://api.anthropic.com/v1/other",
            "https://api.anthropic.com/v1/messages/",
            "https://api.anthropic.com/v1/../v1/messages",
            "https://api.anthropic.com",
            "https://api.anthropic.com/",
            "https://api.openai.com/v1/messages",
            "https://api.anthropic.com/v1/chat/completions",
            "https://generativelanguage.googleapis.com/v1/models",
            "https://generativelanguage.googleapis.com/v1beta/models/unlisted:generateContent",
            "https://generativelanguage.googleapis.com/v1beta/models?key=abc",
            "https://169.254.169.254/latest/meta-data",
            "https://localhost/v1/messages",
            "https:/api.anthropic.com/v1/messages",
            "ftp://api.anthropic.com/v1/messages",
            "api.anthropic.com/v1/messages",
            "https://api.anthropic.com/v1/messages\n",
            "https://api.anthropic.com/v1/messages ",
            "",
        ] {
            assert!(!url_allowed(refused), "{refused:?}");
        }
    }

    #[test]
    fn a_path_of_one_provider_is_not_allowed_on_another() {
        for provider in Provider::ALL {
            for other in Provider::ALL {
                if provider == other {
                    continue;
                }
                let url = format!(
                    "https://{}{}",
                    other.host(),
                    match provider {
                        Provider::Anthropic => anthropic::PATHS[0],
                        Provider::OpenAi => openai::PATHS[0],
                        Provider::Gemini => gemini::LIST_PATH,
                    }
                );
                assert!(!url_allowed(&url), "{url}");
            }
        }
    }

    #[test]
    fn no_request_holds_its_key_in_the_address_and_every_address_is_allowed() {
        for provider in Provider::ALL {
            let key = key_of(provider);
            let test = build_key_test_request(provider, key).unwrap();
            let mut requests = vec![test];
            for model in provider.models() {
                requests.push(
                    build_summary_request(
                        provider,
                        key,
                        model.id,
                        UiLocale::En,
                        "FAKE text [NAME 1].",
                    )
                    .unwrap(),
                );
            }
            for request in &requests {
                let url = request.url();
                assert!(url_allowed(&url), "{url}");
                assert!(!url.contains(key), "{url}");
                assert!(
                    !url.contains('?') && !url.contains('#') && !url.contains('@'),
                    "{url}"
                );
                let body = String::from_utf8_lossy(&request.body);
                // The key is in exactly one header and nowhere else.
                assert_eq!(
                    request
                        .headers
                        .iter()
                        .filter(|(_, value)| value.contains(key))
                        .count(),
                    1,
                    "{provider:?}"
                );
                assert!(!body.contains(key), "{provider:?}");
                assert!(!format!("{request:?}").contains(key));
            }
        }
    }

    #[test]
    fn an_unlisted_model_a_bad_text_or_a_wrong_key_builds_nothing() {
        for provider in Provider::ALL {
            let key = key_of(provider);
            assert_eq!(
                build_summary_request(provider, key, "not-a-model", UiLocale::En, "x").err(),
                Some(RequestError::UnknownModel)
            );
            if let Some(model) = provider.models().first() {
                assert_eq!(
                    build_summary_request(provider, key, model.id, UiLocale::En, "").err(),
                    Some(RequestError::BadText)
                );
                let over = "x".repeat(MAX_TEXT_BYTES + 1);
                assert_eq!(
                    build_summary_request(provider, key, model.id, UiLocale::En, &over).err(),
                    Some(RequestError::BadText)
                );
                for bad in [
                    "",
                    "short",
                    "bad key with spaces 0123456789",
                    "key\nwith\nnewlines0123456",
                ] {
                    assert_eq!(
                        build_summary_request(provider, bad, model.id, UiLocale::En, "x").err(),
                        Some(RequestError::BadKey),
                        "{bad:?}"
                    );
                }
            }
            assert_eq!(
                build_key_test_request(provider, "short").err(),
                Some(RequestError::BadKey)
            );
        }
    }

    #[test]
    fn each_provider_refuses_the_other_providers_keys() {
        for provider in Provider::ALL {
            for other in Provider::ALL {
                if provider == other {
                    continue;
                }
                assert!(
                    provider.check_key(key_of(other)).is_err(),
                    "{provider:?} took {other:?}'s key"
                );
            }
            assert!(provider.check_key(key_of(provider)).is_ok());
        }
    }

    #[test]
    fn a_price_that_is_not_verified_is_cost_unknown_never_a_number() {
        let priced = ModelSpec {
            id: "FAKE-priced",
            label: "FAKE priced",
            input_per_mtok: Some(2.0),
            output_per_mtok: Some(10.0),
        };
        let unpriced = ModelSpec {
            id: "FAKE-unpriced",
            label: "FAKE unpriced",
            input_per_mtok: None,
            output_per_mtok: Some(10.0),
        };
        let text = "x".repeat(8_000);
        let known = estimate(&text, &priced);
        assert_eq!(known.characters, 8_000);
        assert_eq!(known.tokens, 2_000);
        assert!((known.cost_usd.unwrap() - (0.004 + 0.015)).abs() < 1e-9);
        assert_eq!(estimate(&text, &unpriced).cost_usd, None);
    }
}

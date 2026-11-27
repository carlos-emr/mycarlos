//! Anthropic (the Messages API), as #392 built it: this module only restates it in the shared
//! provider shape. The request itself is `cloud_ai::request::build_summary_request`, unchanged.

use super::{KeyShape, Method, ModelSpec, PlannedRequest, Provider, RequestError};
use crate::cloud_ai::request;
use crate::ui_text::UiLocale;

pub(crate) const HOST: &str = request::HOST;
/// The send and the key test, and nothing else.
pub(crate) const PATHS: [&str; 2] = ["/v1/messages", "/v1/models"];

/// The same list and published prices as `request::MODELS` (copied from the design's table).
pub(crate) const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        input_per_mtok: Some(4.0),
        output_per_mtok: Some(20.0),
    },
    ModelSpec {
        id: "claude-sonnet-5-5",
        label: "Claude Sonnet 5.5",
        input_per_mtok: Some(2.0),
        output_per_mtok: Some(10.0),
    },
    ModelSpec {
        id: "claude-haiku-5-5",
        label: "Claude Haiku 5.5",
        input_per_mtok: Some(0.10),
        output_per_mtok: Some(0.50),
    },
];

/// `sk-ant-` and printable; an administration key (`sk-ant-admin…`, any case) is refused.
pub(crate) fn check_key(key: &str) -> Result<(), KeyShape> {
    super::printable_key(key)?;
    if !key.starts_with("sk-ant-") {
        return Err(KeyShape::WrongProvider);
    }
    if key.to_ascii_lowercase().starts_with("sk-ant-admin") {
        return Err(KeyShape::Administration);
    }
    Ok(())
}

fn planned(mut request: request::ProviderRequest, path: &str) -> PlannedRequest {
    let planned = PlannedRequest {
        provider: Provider::Anthropic,
        method: match request.method {
            request::Method::Get => Method::Get,
            request::Method::Post => Method::Post,
        },
        path: path.to_owned(),
        headers: std::mem::take(&mut request.headers),
        body: std::mem::take(&mut request.body),
    };
    debug_assert_eq!(format!("https://{HOST}{path}"), request.url);
    planned
}

pub(crate) fn summary_request(
    key: &str,
    model: &ModelSpec,
    language: UiLocale,
    text: &str,
) -> Result<PlannedRequest, RequestError> {
    let built = request::build_summary_request(key, model.id, language, text)
        .map_err(|_| RequestError::BadKey)?;
    Ok(planned(built, PATHS[0]))
}

pub(crate) fn key_test_request(key: &str) -> Result<PlannedRequest, RequestError> {
    let built = request::build_key_test_request(key).map_err(|_| RequestError::BadKey)?;
    Ok(planned(built, PATHS[1]))
}

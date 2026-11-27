//! The iPhone push token, as the app takes it from the plugin (`tauri-plugin-ios-push`): what makes
//! a token acceptable, which Apple service it is for, and why a refusal happened. The plugin itself
//! only compiles for iOS; this part is plain Rust and is tested everywhere.
#![cfg_attr(not(test), allow(dead_code))]

use serde_json::Value;
use std::fmt;
use zeroize::Zeroizing;

/// What Apple gave this install. The token is a secret of the device: `Debug` shows only that it is
/// there.
pub(crate) struct Token {
    /// Wiped from memory when dropped.
    pub(crate) token: Zeroizing<String>,
    /// `sandbox` or `production`: which Apple push service the token belongs to.
    pub(crate) environment: String,
}

impl PartialEq for Token {
    fn eq(&self, other: &Self) -> bool {
        *self.token == *other.token && self.environment == other.environment
    }
}
impl Eq for Token {}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Token")
            .field("token", &"<redacted>")
            .field("environment", &self.environment)
            .finish()
    }
}

/// Why no token came back, kept apart so that Settings can say which.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum Refusal {
    /// The patient said no to notices (or already had).
    PermissionRefused,
    /// Apple gave no token in time.
    TimedOut,
    /// Apple, or the plugin, could not produce one.
    Unavailable,
    /// This build has no iPhone push plugin (not an iPhone).
    // Built only by the app piece that follows, so the test build on Linux sees it as unused.
    #[allow(dead_code)]
    NotAnIphone,
    /// The plugin answered something this app does not accept (a malformed token or an unknown
    /// Apple service).
    Invalid,
}

/// How the plugin's reject text reads.
pub(crate) fn refusal_from_reason(reason: Option<&str>) -> Refusal {
    match reason {
        Some("push_permission_refused") => Refusal::PermissionRefused,
        Some("push_token_timeout") => Refusal::TimedOut,
        _ => Refusal::Unavailable,
    }
}

/// The plugin's reply `{token, environment}`, accepted only if the token is what the portal takes
/// (64 to 200 hexadecimal characters) and the service is one Apple has.
pub(crate) fn token_from_reply(reply: &Value) -> Result<Token, Refusal> {
    let object = reply.as_object().ok_or(Refusal::Invalid)?;
    if object.len() != 2 {
        return Err(Refusal::Invalid);
    }
    let text = object
        .get("token")
        .and_then(Value::as_str)
        .ok_or(Refusal::Invalid)?;
    let environment = object
        .get("environment")
        .and_then(Value::as_str)
        .ok_or(Refusal::Invalid)?;
    let hex = (64..=200).contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !hex || !matches!(environment, "sandbox" | "production") {
        return Err(Refusal::Invalid);
    }
    Ok(Token {
        token: Zeroizing::new(text.to_ascii_lowercase()),
        environment: environment.to_owned(),
    })
}

/// Asks the plugin for the token (and, the first time, for permission).
#[cfg(target_os = "ios")]
pub(crate) async fn request_token<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Token, Refusal> {
    use tauri_plugin_ios_push::Failure;
    match tauri_plugin_ios_push::request_token(app).await {
        Ok(reply) => token_from_reply(&reply),
        Err(Failure::Rejected(reason)) => Err(refusal_from_reason(reason.as_deref())),
        Err(Failure::NotAnIphone) => Err(Refusal::NotAnIphone),
        Err(Failure::Other) => Err(Refusal::Unavailable),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn reply(token: &str, environment: &str) -> Value {
        json!({"token": token, "environment": environment})
    }

    #[test]
    fn debug_never_shows_the_token() {
        let token = token_from_reply(&reply(&"ab".repeat(32), "sandbox")).unwrap();
        let shown = format!("{token:?}");
        assert!(!shown.contains("abab"), "{shown}");
        assert!(shown.contains("<redacted>") && shown.contains("sandbox"));
    }

    #[test]
    fn only_hex_of_the_right_length_for_a_known_service_is_accepted_and_lower_cased() {
        let token = token_from_reply(&reply(&"AB".repeat(100), "production")).unwrap();
        assert_eq!(*token.token, "ab".repeat(100));
        assert_eq!(token.environment, "production");
        for bad in [
            reply(&"ab".repeat(31), "sandbox"),
            reply(&"ab".repeat(101), "sandbox"),
            reply(&"zz".repeat(32), "sandbox"),
            reply(&"ab".repeat(32), "development"),
            reply(&"ab".repeat(32), ""),
            json!({"token": "ab".repeat(32)}),
            json!({"token": "ab".repeat(32), "environment": "sandbox", "extra": 1}),
            json!({"token": 7, "environment": "sandbox"}),
            json!("text"),
            Value::Null,
        ] {
            assert_eq!(
                token_from_reply(&bad).unwrap_err(),
                Refusal::Invalid,
                "{bad}"
            );
        }
    }

    #[test]
    fn a_refusal_keeps_its_reason() {
        assert_eq!(
            refusal_from_reason(Some("push_permission_refused")),
            Refusal::PermissionRefused
        );
        assert_eq!(
            refusal_from_reason(Some("push_token_timeout")),
            Refusal::TimedOut
        );
        assert_eq!(
            refusal_from_reason(Some("push_token_unavailable")),
            Refusal::Unavailable
        );
        assert_eq!(
            refusal_from_reason(Some("anything else")),
            Refusal::Unavailable
        );
        assert_eq!(refusal_from_reason(None), Refusal::Unavailable);
    }
}

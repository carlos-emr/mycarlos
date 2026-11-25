//! The iPhone push handle, app side (iPhone push, piece 1): binding Apple's device token to the
//! destination myCarlos enrolled, and what Settings can say about it.
//!
//! The portal route is `POST /api/mycarlos/availability/handles`, signed by the link's device key
//! like every availability route (carlos-portal, `mycarlos_availability`). The body is
//! `{destination_id, platform: "ios_apns", environment, token}`. The order is fixed: the
//! destination is enrolled first (`document_push::SUBSCRIPTIONS`), and only an enrolled
//! destination is bound; an unknown destination is a 404, and a 404 is never retried in a loop.
//!
//! "Send only if changed": the token is a secret of the device, so what is remembered between runs
//! is only a SHA-256 digest of destination, Apple service and token, kept in the iPhone's Keychain
//! through the plugin (`HandleMemory`). The portal is asked again only when the digest differs, that
//! is when Apple handed out another token, the build moved between sandbox and production, or the
//! destination is a new one. This module is plain Rust and tested everywhere; the Keychain half is
//! Swift (`PushPlugin`) and unverified until macOS CI builds it.
#![cfg_attr(not(test), allow(dead_code))]

use crate::document_notifications::{Permission, Platform};
use crate::document_push::PushSource;
use crate::ios_push::{Refusal, Token};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use uuid::Uuid;
use zeroize::Zeroizing;

pub(crate) const HANDLES: &str = "/api/mycarlos/availability/handles";
/// The answer is `{}`; anything bigger is not the portal.
pub(crate) const MAX_HANDLE_REPLY: usize = 1024;

/// The request body: the destination the device enrolled and its Apple token for the service the
/// build belongs to.
pub(crate) fn handle_body(destination: Uuid, token: &Token) -> Zeroizing<Vec<u8>> {
    // Written by hand, so that the token is never in a value that is not wiped when dropped. Every
    // part is plain text that needs no escaping: a UUID, a service name from a fixed pair, the
    // platform's wire name, and a token that `token_from_reply` accepted as hexadecimal only.
    debug_assert!(token.token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    debug_assert!(matches!(
        token.environment.as_str(),
        "sandbox" | "production"
    ));
    let mut body = Zeroizing::new(Vec::with_capacity(token.token.len() + 160));
    for part in [
        r#"{"destination_id":""#,
        &destination.to_string(),
        r#"","platform":""#,
        Platform::IosApns.wire(),
        r#"","environment":""#,
        &token.environment,
        r#"","token":""#,
        &token.token,
        r#""}"#,
    ] {
        body.extend_from_slice(part.as_bytes());
    }
    body
}

/// What identifies a binding without being the token: a domain-separated digest over the
/// destination, the Apple service and the token, each length-prefixed so no two inputs share one
/// byte string.
pub(crate) fn handle_digest(destination: Uuid, token: &Token) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"myCarlos iPhone push handle v1");
    hash.update(destination.as_bytes());
    for part in [token.environment.as_bytes(), token.token.as_bytes()] {
        hash.update((part.len() as u32).to_be_bytes());
        hash.update(part);
    }
    hash.finalize().into()
}

/// The digest as the Keychain keeps it: 64 lower-case hexadecimal characters.
pub(crate) fn digest_to_hex(digest: &[u8; 32]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The digest read back; anything that is not exactly what `digest_to_hex` makes is not a digest.
pub(crate) fn digest_from_hex(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64 || !text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let mut digest = [0u8; 32];
    for (index, byte) in digest.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(digest)
}

/// What the portal's answer means for the device.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum Binding {
    /// The portal holds this token for the destination (201 new, 200 replaced).
    Bound,
    /// 404: the portal does not know the destination, or refused the device's signed request
    /// (clock skew, a replay, an expired assertion, all of which answer 404 too). Never retried in a
    /// loop: the first one is only noted (`SUSPECT`) and kept as it is; a second one at a later
    /// pass means the destination is gone, and it is revoked and enrolled anew.
    ReEnroll,
    /// 400: the portal refused what the device sent (`invalid_handle`, `invalid_environment`,
    /// `invalid_platform`). That is a bug in the app, never fixed by sending it again.
    Refused,
    /// 503 (the portal has no key to store tokens under), another status, or an answer that is not
    /// `{}`: nothing is known to be stored; try again at a later opening.
    Later,
}

pub(crate) fn binding_reply(status: u16, body: &[u8]) -> Binding {
    match status {
        200 | 201 => match serde_json::from_slice::<serde_json::Value>(body) {
            Ok(serde_json::Value::Object(map)) if map.is_empty() => Binding::Bound,
            _ => Binding::Later,
        },
        404 => Binding::ReEnroll,
        400 => Binding::Refused,
        _ => Binding::Later,
    }
}

/// What the memory holds in place of a digest after the portal answered 404 for a destination
/// once. A 404 can also mean a refused device assertion (clock skew, a replay, an expired one), so
/// the first one is only noted; a second 404 at a later pass is the portal not knowing the
/// destination. It is not any digest (a SHA-256 is never all ones), so a noted destination is sent
/// again, and a successful send replaces it.
pub(crate) const SUSPECT: [u8; 32] = [0xFF; 32];

/// The device's memory of what the portal holds, one digest per destination. On an iPhone it is the
/// Keychain (through the plugin); tests use a fake.
pub(crate) trait HandleMemory: Send + Sync {
    fn recall(&self, destination: Uuid) -> Option<[u8; 32]>;
    /// Whether the digest was kept. A memory that cannot keep it makes the next opening send again,
    /// which is safe (the portal replaces).
    fn remember(&self, destination: Uuid, digest: [u8; 32]) -> bool;
    fn forget(&self, destination: Uuid);
}

/// What Settings says about the iPhone setting, as `vault_iphone_push_status` returns it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PushState {
    Ok,
    /// The patient said no when the iPhone asked.
    Refused,
    /// Notices are off for myCarlos in the iPhone's Settings.
    IosOff,
    /// The iPhone or Apple could not give a token.
    Unavailable,
    /// Apple did not answer in time.
    TimedOut,
    /// Everything on the iPhone is in order, but the portal does not keep a place for notices: it
    /// did not know the destination twice, and enrolling a new one did not work either.
    NeedsAttention,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IphonePushStatus {
    pub(crate) supported: bool,
    pub(crate) enabled: bool,
    pub(crate) state: PushState,
}

impl IphonePushStatus {
    /// Every build that is not an iPhone.
    pub(crate) const NOT_AN_IPHONE: Self = Self {
        supported: false,
        enabled: false,
        state: PushState::Ok,
    };
}

/// The plugin's permission words (`authorized`, `denied`, ...), as a `Permission`.
pub(crate) fn permission_from_status(status: &str) -> Permission {
    match status {
        "authorized" | "provisional" | "ephemeral" => Permission::Granted,
        "denied" => Permission::Denied,
        _ => Permission::Unknown,
    }
}

#[derive(Debug, Default)]
struct Observed {
    permission: Permission,
    refusal: Option<Refusal>,
    /// The last pass could not bind the token to a place at the portal, even after enrolling anew.
    attention: bool,
}

/// What this run knows about iPhone push: the permission the plugin last reported and why the last
/// ask failed. In memory only. It is the `PushSource` the vault's remote-notice policy asks.
#[derive(Debug, Default)]
pub(crate) struct IosPushState(Mutex<Observed>);

impl IosPushState {
    pub(crate) fn record_permission(&self, status: &str) {
        let mut seen = self.0.lock().unwrap_or_else(|e| e.into_inner());
        seen.permission = permission_from_status(status);
        // The patient allowed notices again in the iPhone's Settings: that refusal is over.
        if seen.permission == Permission::Granted
            && seen.refusal == Some(Refusal::PermissionRefused)
        {
            seen.refusal = None;
        }
    }

    pub(crate) fn record_refusal(&self, refusal: Refusal) {
        let mut seen = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if refusal == Refusal::PermissionRefused {
            seen.permission = Permission::Denied;
        }
        seen.refusal = Some(refusal);
    }

    /// A token came back: the ask worked, so any earlier failure of it is over.
    pub(crate) fn record_token(&self) {
        let mut seen = self.0.lock().unwrap_or_else(|e| e.into_inner());
        seen.permission = Permission::Granted;
        seen.refusal = None;
    }

    /// Whether the last pass could not leave a place for notices at the portal.
    pub(crate) fn record_attention(&self, attention: bool) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).attention = attention;
    }

    pub(crate) fn state(&self) -> PushState {
        let seen = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match seen.refusal {
            Some(Refusal::PermissionRefused) => PushState::Refused,
            Some(Refusal::TimedOut) => PushState::TimedOut,
            Some(Refusal::Unavailable | Refusal::Invalid | Refusal::NotAnIphone) => {
                PushState::Unavailable
            }
            None if seen.permission == Permission::Denied => PushState::IosOff,
            None if seen.attention => PushState::NeedsAttention,
            None => PushState::Ok,
        }
    }
}

impl PushSource for IosPushState {
    fn platform(&self) -> Platform {
        Platform::IosApns
    }
    fn permission(&self) -> Permission {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).permission
    }
}

/// A memory for tests: a map, with a switch that makes writes fail.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct FakeHandleMemory {
    pub(crate) kept: Mutex<std::collections::HashMap<Uuid, [u8; 32]>>,
    pub(crate) refuse_writes: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl HandleMemory for FakeHandleMemory {
    fn recall(&self, destination: Uuid) -> Option<[u8; 32]> {
        self.kept.lock().unwrap().get(&destination).copied()
    }
    fn remember(&self, destination: Uuid, digest: [u8; 32]) -> bool {
        if self.refuse_writes.load(std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        self.kept.lock().unwrap().insert(destination, digest);
        true
    }
    fn forget(&self, destination: Uuid) {
        self.kept.lock().unwrap().remove(&destination);
    }
}

#[cfg(test)]
pub(crate) fn fake_token(environment: &str, hex: &str) -> Token {
    crate::ios_push::token_from_reply(&serde_json::json!({
        "token": hex.repeat(32),
        "environment": environment,
    }))
    .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    #[test]
    fn the_body_names_the_destination_the_service_and_the_token_and_nothing_else() {
        let token = fake_token("sandbox", "ab");
        let body: serde_json::Value =
            serde_json::from_slice(&handle_body(id(7), &token)[..]).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "destination_id": id(7).to_string(),
                "platform": "ios_apns",
                "environment": "sandbox",
                "token": "ab".repeat(32),
            })
        );
    }

    #[test]
    fn the_digest_changes_with_any_of_the_destination_the_service_or_the_token() {
        let base = handle_digest(id(1), &fake_token("sandbox", "ab"));
        assert_eq!(base, handle_digest(id(1), &fake_token("sandbox", "ab")));
        assert_ne!(base, handle_digest(id(2), &fake_token("sandbox", "ab")));
        assert_ne!(base, handle_digest(id(1), &fake_token("production", "ab")));
        assert_ne!(base, handle_digest(id(1), &fake_token("sandbox", "cd")));
        // The digest is not the token.
        assert!(!base.windows(4).any(|w| w == [0xab; 4]));
    }

    #[test]
    fn a_digest_survives_the_keychain_text_and_nothing_else_reads_as_one() {
        let digest = handle_digest(id(1), &fake_token("sandbox", "ab"));
        let text = digest_to_hex(&digest);
        assert_eq!(text.len(), 64);
        assert_eq!(digest_from_hex(&text), Some(digest));
        for bad in [
            "",
            &text[..62],
            &text.to_uppercase(),
            &format!("{text}0"),
            "zz".repeat(32).as_str(),
        ] {
            assert_eq!(digest_from_hex(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_portals_answers_mean_what_the_device_does_next() {
        for status in [200, 201] {
            assert_eq!(binding_reply(status, b"{}"), Binding::Bound, "{status}");
            // An answer that is not the empty object is not the portal's, so nothing is remembered.
            assert_eq!(binding_reply(status, b"{\"a\":1}"), Binding::Later);
            assert_eq!(binding_reply(status, b"not json"), Binding::Later);
            assert_eq!(binding_reply(status, b""), Binding::Later);
        }
        assert_eq!(binding_reply(404, b"{}"), Binding::ReEnroll);
        assert_eq!(
            binding_reply(400, br#"{"code":"invalid_handle"}"#),
            Binding::Refused
        );
        for status in [401, 403, 409, 413, 429, 500, 502, 503] {
            assert_eq!(binding_reply(status, b"{}"), Binding::Later, "{status}");
        }
    }

    #[test]
    fn the_permission_words_of_the_plugin_map_to_the_policys_three() {
        for granted in ["authorized", "provisional", "ephemeral"] {
            assert_eq!(permission_from_status(granted), Permission::Granted);
        }
        assert_eq!(permission_from_status("denied"), Permission::Denied);
        for unknown in ["notDetermined", "unknown", ""] {
            assert_eq!(permission_from_status(unknown), Permission::Unknown);
        }
    }

    #[test]
    fn each_failure_has_its_own_state_and_a_refusal_ends_when_notices_are_allowed_again() {
        let state = IosPushState::default();
        assert_eq!(state.state(), PushState::Ok);
        assert_eq!(state.permission(), Permission::Unknown);
        assert_eq!(state.platform(), Platform::IosApns);

        state.record_refusal(Refusal::PermissionRefused);
        assert_eq!(state.state(), PushState::Refused);
        assert_eq!(state.permission(), Permission::Denied);
        // Still denied when polled: still the patient's refusal.
        state.record_permission("denied");
        assert_eq!(state.state(), PushState::Refused);
        // Allowed in iPhone Settings meanwhile.
        state.record_permission("authorized");
        assert_eq!(state.state(), PushState::Ok);
        assert_eq!(state.permission(), Permission::Granted);

        // Notices turned off in iPhone Settings later, with no refusal of ours.
        state.record_permission("denied");
        assert_eq!(state.state(), PushState::IosOff);

        for (refusal, expected) in [
            (Refusal::TimedOut, PushState::TimedOut),
            (Refusal::Unavailable, PushState::Unavailable),
            (Refusal::Invalid, PushState::Unavailable),
            (Refusal::NotAnIphone, PushState::Unavailable),
        ] {
            state.record_refusal(refusal);
            assert_eq!(state.state(), expected, "{refusal:?}");
        }
        // Those do not clear because the permission looks fine: only a token does.
        state.record_permission("authorized");
        assert_eq!(state.state(), PushState::Unavailable);
        state.record_token();
        assert_eq!(state.state(), PushState::Ok);
    }

    #[test]
    fn the_status_is_camel_case_and_a_computer_is_not_an_iphone() {
        let shown = serde_json::to_value(IphonePushStatus {
            supported: true,
            enabled: true,
            state: PushState::TimedOut,
        })
        .unwrap();
        assert_eq!(
            shown,
            serde_json::json!({"supported": true, "enabled": true, "state": "timedOut"})
        );
        let off = serde_json::to_value(IphonePushStatus::NOT_AN_IPHONE).unwrap();
        assert_eq!(off["supported"], false);
        for (state, word) in [
            (PushState::Ok, "ok"),
            (PushState::Refused, "refused"),
            (PushState::IosOff, "iosOff"),
            (PushState::Unavailable, "unavailable"),
        ] {
            assert_eq!(serde_json::to_value(state).unwrap(), word);
        }
    }
}

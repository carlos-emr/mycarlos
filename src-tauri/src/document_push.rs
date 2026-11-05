//! The myCarlos side of remote "documents ready" notices (#192, M1), platform-neutral.
//!
//! A platform push hook (Android FCM, APNs, WNS: later PRs, each with its own device test)
//! implements `PushSource` and hands every incoming provider message's opaque token to
//! `VaultStore::push_received`. Only a fake source exists here; no provider SDK is linked.
//!
//! The device enrolls a destination per completed link at the portal
//! (`POST /api/mycarlos/availability/subscriptions`, carlos-portal#81) and revokes it
//! (`POST /api/mycarlos/availability/revocations`, carlos-portal P4), each request signed by
//! that link's device key exactly as the mailbox requests are (`portal_client::api`). A token
//! is never decoded (carlos-portal#80): it only says "check", and the device reconciles through
//! its own authenticated document check.

use crate::document_notifications::{Destination, NoticeToken, Permission, Platform, RecentTokens};
use uuid::Uuid;

pub(crate) const SUBSCRIPTIONS: &str = "/api/mycarlos/availability/subscriptions";
pub(crate) const REVOCATIONS: &str = "/api/mycarlos/availability/revocations";
/// A subscription record or a revocation answer is a few hundred bytes.
pub(crate) const MAX_REPLY: usize = 4096;
/// The only remote consent version the portal knows.
const REMOTE_CONSENT_VERSION: u8 = 1;

/// A platform's push channel. It registers its own provider handle with the platform; the
/// portal only ever learns the device-made destination id.
pub(crate) trait PushSource: Send + Sync {
    fn platform(&self) -> Platform;
    /// The OS permission to show notices, as the platform reports it now.
    fn permission(&self) -> Permission;
}

/// The portal request a link's device key signs: the same shape `portal_client::api` has.
pub(crate) trait Exchange:
    Fn(
    &crate::portal_link::StoredLink,
    &str,
    &str,
    Vec<u8>,
    Option<&str>,
    usize,
    &dyn Fn() -> bool,
) -> Result<crate::portal_client::ApiResponse, crate::portal_link::LinkError>
{
}

impl<F> Exchange for F where
    F: Fn(
        &crate::portal_link::StoredLink,
        &str,
        &str,
        Vec<u8>,
        Option<&str>,
        usize,
        &dyn Fn() -> bool,
    ) -> Result<crate::portal_client::ApiResponse, crate::portal_link::LinkError>
{
}

/// The enrollment the portal stores: what the device reports, never a provider token.
pub(crate) fn enrollment_body(destination: &Destination) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "platform": destination.platform().wire(),
        "destination_id": destination.id().to_string(),
        "remote_enabled": true,
        "remote_consent_version": REMOTE_CONSENT_VERSION,
        "permission_observed": true,
    }))
    .unwrap_or_default()
}

pub(crate) fn revocation_body(destination: &Destination) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "platform": destination.platform().wire(),
        "destination_id": destination.id().to_string(),
    }))
    .unwrap_or_default()
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Enrollment {
    /// The portal enrolled the destination under this subscription id.
    Enrolled(Uuid),
    /// The portal will never enrol this id: it is revoked there, another device holds it, or
    /// this device was removed. Nothing is left to stop.
    Forget,
    /// Not now (the routes are off, the portal is busy, the answer was not understood): try
    /// again on a later sync.
    Later,
}

fn code(body: &[u8]) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()?
        .get("code")?
        .as_str()
        .map(str::to_owned)
}

pub(crate) fn enrollment_reply(destination: &Destination, status: u16, body: &[u8]) -> Enrollment {
    match status {
        200 | 201 => {
            let Ok(record) = serde_json::from_slice::<serde_json::Value>(body) else {
                return Enrollment::Later;
            };
            let named = record["destination_id"].as_str() == Some(&destination.id().to_string())
                && record["platform"].as_str() == Some(destination.platform().wire())
                && record["revoked"] == serde_json::Value::Bool(false);
            match record["subscription_id"]
                .as_str()
                .and_then(|id| Uuid::parse_str(id).ok())
            {
                Some(id) if named && !id.is_nil() => Enrollment::Enrolled(id),
                _ => Enrollment::Later,
            }
        }
        403 if code(body).as_deref() == Some("device_removed") => Enrollment::Forget,
        409 if matches!(
            code(body).as_deref(),
            Some("destination_revoked" | "destination_taken")
        ) =>
        {
            Enrollment::Forget
        }
        _ => Enrollment::Later,
    }
}

/// Whether a revocation's answer is final, so the entry leaves the queue (carlos-portal P4).
/// The queue shares its places with the active destinations, so an entry the portal can never
/// clear is dropped rather than retried forever. Final: 200 naming this id (committed, or it was
/// revoked already); 409 `destination_taken` (another device's, never this one's); 400 with
/// `invalid_*` (never accepted); 403 `device_removed` (the portal never sends to it). Anything
/// else (404 refused assertion, 403 `device_inactive` or `recipient_mismatch`, 413, 5xx, no
/// answer) is retried: nothing is known to be committed.
pub(crate) fn revocation_final(destination: &Destination, status: u16, body: &[u8]) -> bool {
    match (status, code(body).as_deref()) {
        (200, _) => serde_json::from_slice::<serde_json::Value>(body).is_ok_and(|v| {
            v["destination_id"].as_str() == Some(&destination.id().to_string())
                && v["revoked"] == serde_json::Value::Bool(true)
        }),
        (409, Some("destination_taken"))
        | (400, Some("invalid_enrollment" | "invalid_destination" | "invalid_platform"))
        | (403, Some("device_removed")) => true,
        _ => false,
    }
}

/// What a push did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PushOutcome {
    /// Not a notice token, a token already handled, or remote notices are off.
    Ignored,
    /// The vault was open: its document check ran.
    Checked,
    /// Kept for later: the vault is locked, or the check could not run now. myCarlos checks
    /// once when the vault is next opened.
    Pending,
}

/// The tokens this run handled and whether a check is still owed. In memory only.
#[derive(Debug, Default)]
pub(crate) struct PushInbox {
    recent: RecentTokens,
    pending: bool,
}

impl PushInbox {
    pub(crate) fn first_time(&mut self, token: &NoticeToken) -> bool {
        self.recent.first_time(token)
    }
    pub(crate) fn owe_check(&mut self) {
        self.pending = true;
    }
    /// Whether a check was owed; it is not owed any more.
    pub(crate) fn take_pending(&mut self) -> bool {
        std::mem::take(&mut self.pending)
    }
}

/// A push source for tests only: the platform and the permission it reports.
#[cfg(test)]
pub(crate) struct FakePushSource {
    pub(crate) platform: Platform,
    pub(crate) permission: std::sync::Mutex<Permission>,
}

#[cfg(test)]
impl FakePushSource {
    pub(crate) fn granted() -> Self {
        Self {
            platform: Platform::WindowsWns,
            permission: std::sync::Mutex::new(Permission::Granted),
        }
    }
}

#[cfg(test)]
impl PushSource for FakePushSource {
    fn platform(&self) -> Platform {
        self.platform
    }
    fn permission(&self) -> Permission {
        *self.permission.lock().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document_notifications::{Owner, Policy};

    fn destination() -> Destination {
        let mut policy = Policy::default();
        policy.opt_in();
        policy.permission_changed(Permission::Granted);
        let owner = Owner::new(Uuid::from_u128(2), "A".repeat(43)).unwrap();
        policy
            .reserve_destination(owner, Uuid::from_u128(3), Platform::WindowsWns)
            .unwrap();
        policy.unenrolled().remove(0)
    }

    #[test]
    fn the_enrollment_reports_consent_and_never_a_provider_token() {
        let body: serde_json::Value =
            serde_json::from_slice(&enrollment_body(&destination())).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "platform": "windows_wns",
                "destination_id": Uuid::from_u128(3).to_string(),
                "remote_enabled": true,
                "remote_consent_version": 1,
                "permission_observed": true,
            })
        );
        let body: serde_json::Value =
            serde_json::from_slice(&revocation_body(&destination())).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"platform": "windows_wns", "destination_id": Uuid::from_u128(3).to_string()})
        );
    }

    #[test]
    fn only_a_record_naming_this_destination_enrols_it() {
        let d = destination();
        let record = |destination: Uuid, platform: &str, revoked: bool| {
            serde_json::to_vec(&serde_json::json!({
                "subscription_id": Uuid::from_u128(30).to_string(),
                "epoch": Uuid::from_u128(40).to_string(),
                "destination_id": destination.to_string(),
                "platform": platform,
                "remote_enabled": true,
                "remote_consent_version": 1,
                "permission_observed": true,
                "enrolled_at": "2026-11-05T00:00:00Z",
                "revoked": revoked,
            }))
            .unwrap()
        };
        let mine = record(Uuid::from_u128(3), "windows_wns", false);
        assert_eq!(
            enrollment_reply(&d, 201, &mine),
            Enrollment::Enrolled(Uuid::from_u128(30))
        );
        assert_eq!(
            enrollment_reply(&d, 200, &mine),
            Enrollment::Enrolled(Uuid::from_u128(30))
        );
        for other in [
            record(Uuid::from_u128(4), "windows_wns", false),
            record(Uuid::from_u128(3), "android_fcm", false),
            record(Uuid::from_u128(3), "windows_wns", true),
            b"not json".to_vec(),
        ] {
            assert_eq!(enrollment_reply(&d, 201, &other), Enrollment::Later);
        }
        let refused =
            |code: &str| serde_json::to_vec(&serde_json::json!({ "code": code })).unwrap();
        assert_eq!(
            enrollment_reply(&d, 409, &refused("destination_revoked")),
            Enrollment::Forget
        );
        assert_eq!(
            enrollment_reply(&d, 409, &refused("destination_taken")),
            Enrollment::Forget
        );
        assert_eq!(
            enrollment_reply(&d, 403, &refused("device_removed")),
            Enrollment::Forget
        );
        for (status, body) in [
            (409, refused("destination_capacity")),
            (422, refused("consent_required")),
            (404, br#"{"detail":"not found"}"#.to_vec()),
            (503, Vec::new()),
        ] {
            assert_eq!(
                enrollment_reply(&d, status, &body),
                Enrollment::Later,
                "{status}"
            );
        }
    }

    #[test]
    fn a_revocation_leaves_the_queue_only_on_a_final_answer() {
        let d = destination();
        let answer = |id: Uuid, revoked: bool| {
            serde_json::to_vec(
                &serde_json::json!({"destination_id": id.to_string(), "revoked": revoked}),
            )
            .unwrap()
        };
        let refused =
            |code: &str| serde_json::to_vec(&serde_json::json!({ "code": code })).unwrap();
        assert!(revocation_final(&d, 200, &answer(Uuid::from_u128(3), true)));
        for (status, code) in [
            (409, "destination_taken"),
            (400, "invalid_enrollment"),
            (400, "invalid_destination"),
            (400, "invalid_platform"),
            (403, "device_removed"),
        ] {
            assert!(
                revocation_final(&d, status, &refused(code)),
                "{status} {code}"
            );
        }
        assert!(!revocation_final(
            &d,
            200,
            &answer(Uuid::from_u128(4), true)
        ));
        assert!(!revocation_final(
            &d,
            200,
            &answer(Uuid::from_u128(3), false)
        ));
        for (status, body) in [
            (404, br#"{"detail":"not found"}"#.to_vec()),
            (403, refused("device_inactive")),
            (403, refused("recipient_mismatch")),
            (409, refused("destination_revoked")),
            (413, Vec::new()),
            (500, Vec::new()),
        ] {
            assert!(!revocation_final(&d, status, &body), "{status}");
        }
    }

    #[test]
    fn the_inbox_owes_one_check_however_many_pushes_came() {
        let mut inbox = PushInbox::default();
        let token = NoticeToken::parse("AbCdEfGhIjKlMnOpQr-_01").unwrap();
        assert!(inbox.first_time(&token));
        assert!(!inbox.first_time(&token));
        inbox.owe_check();
        inbox.owe_check();
        assert!(inbox.take_pending());
        assert!(!inbox.take_pending());
    }
}

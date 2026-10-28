//! First-device M3 intent and clinic acceptance. Portal status is advisory;
//! only a bound signature from this link's pinned clinic establishes approval.
use serde::{Deserialize, Serialize};
use uuid::Uuid;
pub const MAX_APPROVAL_REQUESTS: usize = 16;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalState {
    Pending,
    ChallengeReady,
    Accepted,
    Refused,
    Expired,
    Cancelled,
}
impl ApprovalState {
    pub fn terminal_failure(self) -> bool {
        matches!(self, Self::Refused | Self::Expired | Self::Cancelled)
    }
    #[cfg(feature = "portal-linking")]
    pub fn code(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::ChallengeReady => "challenge_ready",
            Self::Accepted => "accepted",
            Self::Refused => "refused",
            Self::Expired => "expired",
            Self::Cancelled => "cancelled",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalReason {
    InvalidProof,
    CandidateChanged,
    BindingChanged,
    PredecessorNotAccepted,
    PredecessorRemoved,
    StalePredecessor,
    ChallengeExpired,
    ChallengeCancelled,
    StaffRequired,
    NoAcceptedApprover,
    /// Five wrong codes were sent for this request (clinic code v1): final.
    CodeAttempts,
}
impl ApprovalReason {
    #[cfg(feature = "portal-linking")]
    pub fn needs_clinic(self) -> bool {
        matches!(self, Self::StaffRequired | Self::NoAcceptedApprover)
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attempt {
    pub request_id: Uuid,
    pub intent: String,
    pub expires_at: u64,
    pub challenge: Option<String>,
    pub acceptance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ApprovalState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<ApprovalReason>,
}
impl Attempt {
    pub fn state(&self) -> ApprovalState {
        if self.acceptance.is_some() {
            ApprovalState::Accepted
        } else {
            self.status.unwrap_or(ApprovalState::Pending)
        }
    }
}
mod native {
    use super::*;
    use crate::{
        portal_delivery as wire,
        portal_link::{LinkError, StoredLink},
        vault::VaultError,
    };
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine as _};
    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Intent {
        aud: String,
        candidate_device_key_id: String,
        candidate_ed25519_public_key: String,
        candidate_x25519_public_key: String,
        clinic_id: String,
        exp: u64,
        iat: u64,
        iss: String,
        #[serde(deserialize_with = "nullable")]
        predecessor_device_key_id: Option<String>,
        public_portal_base_url: String,
        recipient_id: String,
        #[serde(deserialize_with = "uuid4")]
        request_id: Uuid,
        typ: String,
        v: u8,
    }
    fn uuid4<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Uuid, D::Error> {
        let s = String::deserialize(d)?;
        if !wire::uuid4(&s) {
            return Err(serde::de::Error::custom("invalid request id"));
        }
        Uuid::parse_str(&s).map_err(serde::de::Error::custom)
    }
    fn nullable<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
        Option::deserialize(d)
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Challenge {
        v: u8,
        typ: String,
        aud: String,
        clinic_id: String,
        recipient_id: String,
        public_portal_base_url: String,
        #[serde(deserialize_with = "uuid4")]
        request_id: Uuid,
        challenge_id: String,
        candidate_device_key_id: String,
        candidate_x25519_public_key: String,
        candidate_ed25519_public_key: String,
        candidate_intent_sha256: String,
        approval_kind: String,
        #[serde(deserialize_with = "nullable")]
        predecessor_device_key_id: Option<String>,
        #[serde(deserialize_with = "nullable")]
        predecessor_version: Option<String>,
        issued_at: u64,
        expires_at: u64,
        kid: String,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Acceptance {
        v: u8,
        typ: String,
        aud: String,
        clinic_id: String,
        recipient_id: String,
        public_portal_base_url: String,
        #[serde(deserialize_with = "uuid4")]
        request_id: Uuid,
        challenge_id: String,
        challenge_sha256: String,
        candidate_device_key_id: String,
        candidate_x25519_public_key: String,
        candidate_ed25519_public_key: String,
        approval_kind: String,
        #[serde(deserialize_with = "nullable")]
        predecessor_device_key_id: Option<String>,
        #[serde(deserialize_with = "nullable")]
        approval_sha256: Option<String>,
        accepted_at: u64,
        accepted_version: String,
        kid: String,
    }
    #[cfg(feature = "portal-linking")]
    pub(crate) fn create(link: &StoredLink, now: u64) -> Result<Attempt, VaultError> {
        let clinic = link.clinic.as_ref().ok_or(VaultError::Invalid)?;
        if now > 9_007_199_254_740_000 {
            return Err(VaultError::Invalid);
        }
        let (x, ed) = link.keys.public();
        let request_id = Uuid::new_v4();
        let intent = Intent {
            aud: "carlos-mycarlos-device-approval-intent".into(),
            candidate_device_key_id: link.keys.device_key_id(),
            candidate_ed25519_public_key: B64.encode(ed),
            candidate_x25519_public_key: B64.encode(x),
            clinic_id: clinic.clinic_id.clone(),
            exp: now + 600,
            iat: now,
            iss: "mycarlos".into(),
            predecessor_device_key_id: None,
            public_portal_base_url: link.portal_base.clone(),
            recipient_id: clinic.recipient_id.clone(),
            request_id,
            typ: "mycarlos-device-approval-intent".into(),
            v: 1,
        };
        Ok(Attempt {
            request_id,
            intent: link
                .keys
                .sign(&serde_json::to_vec(&intent).map_err(|_| VaultError::Storage)?),
            expires_at: now + 600,
            challenge: None,
            acceptance: None,
            status: Some(ApprovalState::Pending),
            reason: None,
        })
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    #[cfg(feature = "portal-linking")]
    struct Status {
        #[serde(deserialize_with = "uuid4")]
        request_id: Uuid,
        status: ApprovalState,
        #[serde(deserialize_with = "nullable")]
        challenge: Option<String>,
        #[serde(deserialize_with = "nullable")]
        acceptance: Option<String>,
        #[serde(deserialize_with = "nullable_reason")]
        reason: Option<ApprovalReason>,
    }
    #[cfg(feature = "portal-linking")]
    fn nullable_reason<'de, D: serde::Deserializer<'de>>(
        d: D,
    ) -> Result<Option<ApprovalReason>, D::Error> {
        Option::deserialize(d)
    }
    #[cfg(feature = "portal-linking")]
    pub(crate) fn parse_status(
        link: &StoredLink,
        attempt: &Attempt,
        bytes: &[u8],
    ) -> Result<Attempt, VaultError> {
        let bad = || VaultError::Portal(LinkError::InvalidResponse);
        let reply: Status = serde_json::from_slice(bytes).map_err(|_| bad())?;
        if (attempt.acceptance.is_some() && reply.status != ApprovalState::Accepted)
            || reply.request_id != attempt.request_id
            || (reply.status == ApprovalState::ChallengeReady && reply.challenge.is_none())
            || (reply.status == ApprovalState::Accepted
                && (reply.acceptance.is_none()
                    || reply.challenge.is_none()
                    || reply.reason.is_some()))
            || (reply.status != ApprovalState::Accepted && reply.acceptance.is_some())
            || (!reply.status.terminal_failure() && reply.reason.is_some())
            || (attempt.state().terminal_failure()
                && reply.status != ApprovalState::Accepted
                && reply.status != attempt.state())
        {
            return Err(bad());
        }
        let mut next = attempt.clone();
        if let Some(challenge) = reply.challenge {
            if attempt
                .challenge
                .as_ref()
                .is_some_and(|old| old != &challenge)
            {
                return Err(bad());
            }
            verify_challenge(link, attempt, &challenge, true)?;
            next.challenge = Some(challenge);
        }
        if let Some(acceptance) = reply.acceptance {
            verify_acceptance(
                link,
                attempt,
                next.challenge.as_deref().ok_or_else(bad)?,
                &acceptance,
                true,
            )?;
            if attempt
                .acceptance
                .as_ref()
                .is_some_and(|old| old != &acceptance)
            {
                return Err(bad());
            }
            next.acceptance = Some(acceptance);
        }
        // A signed acceptance remains authoritative historical evidence even
        // when a later unsigned transport status is inconsistent.
        if attempt.acceptance.is_some() && next.acceptance != attempt.acceptance {
            return Err(bad());
        }
        next.status = Some(reply.status);
        next.reason = reply.reason;
        Ok(next)
    }
    #[cfg(feature = "portal-linking")]
    pub(crate) fn publish(
        link: &StoredLink,
        attempt: &Attempt,
        anchor: &str,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Attempt, VaultError> {
        let body = serde_json::to_vec(&serde_json::json!({"intent":attempt.intent}))
            .map_err(|_| VaultError::Storage)?;
        let response = crate::portal_client::api(
            link,
            "POST",
            "/api/mycarlos/device-approval-requests",
            body,
            Some(anchor),
            32768,
            cancelled,
        )
        .map_err(VaultError::Portal)?;
        refuse_rate_limited(&response)?;
        if response.status != 200 && response.status != 201 {
            return Err(VaultError::Portal(LinkError::Network));
        }
        parse_status(link, attempt, &response.body)
    }
    /// The portal asked to be asked less often: said as such, with the wait it
    /// gave, never as a network failure or a state of the request (#131).
    #[cfg(feature = "portal-linking")]
    pub(crate) fn refuse_rate_limited(
        response: &crate::portal_client::ApiResponse,
    ) -> Result<(), VaultError> {
        if response.status == 429 {
            return Err(VaultError::Portal(LinkError::RateLimited(
                response.retry_after,
            )));
        }
        Ok(())
    }
    /// Sends the code the patient typed, once it has been checked against this
    /// clinic, for the clinic to compare (clinic code v1). Only the 6 digits
    /// the clinic made go to the portal, never the check digits.
    #[cfg(feature = "portal-linking")]
    pub(crate) fn send_code(
        link: &StoredLink,
        attempt: &Attempt,
        code_r: &str,
        anchor: &str,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(), VaultError> {
        let (route, body) = code_request(attempt, code_r)?;
        let response = crate::portal_client::api(
            link,
            "POST",
            &route,
            body.to_vec(),
            Some(anchor),
            4096,
            cancelled,
        )
        .map_err(VaultError::Portal)?;
        read_code_reply(&response)
    }
    /// The route and exact body that send a code: `{"code_r":"482193"}`.
    #[cfg(feature = "portal-linking")]
    pub(crate) fn code_request(
        attempt: &Attempt,
        code_r: &str,
    ) -> Result<(String, zeroize::Zeroizing<Vec<u8>>), VaultError> {
        if code_r.len() != 6 || !code_r.bytes().all(|b| b.is_ascii_digit()) {
            return Err(VaultError::Invalid);
        }
        Ok((
            format!("/api/mycarlos/device-approvals/{}/code", attempt.request_id),
            zeroize::Zeroizing::new(format!("{{\"code_r\":\"{code_r}\"}}").into_bytes()),
        ))
    }
    /// What the portal said to a sent code. Only `202 {"status":"submitted"}`
    /// means the clinic has it; the clinic's answer comes later, through the
    /// usual status checks.
    #[cfg(feature = "portal-linking")]
    pub(crate) fn read_code_reply(
        response: &crate::portal_client::ApiResponse,
    ) -> Result<(), VaultError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Submitted {
            status: String,
        }
        #[derive(Deserialize)]
        struct Refusal {
            code: Option<String>,
        }
        if response.status == 202 {
            return serde_json::from_slice::<Submitted>(&response.body)
                .ok()
                .filter(|reply| reply.status == "submitted")
                .map(|_| ())
                .ok_or(VaultError::Portal(LinkError::InvalidResponse));
        }
        let code = serde_json::from_slice::<Refusal>(&response.body)
            .ok()
            .and_then(|refusal| refusal.code);
        Err(match (response.status, code.as_deref()) {
            // Five codes were already sent for this request: final, whatever
            // wait the portal also gives.
            (429, Some("code_attempts")) => VaultError::ApprovalCodeLocked,
            (429, _) => VaultError::Portal(LinkError::RateLimited(response.retry_after)),
            (403, Some("device_removed")) => VaultError::Portal(LinkError::DeviceRemoved),
            (404, Some("approval_not_found")) => VaultError::ApprovalRequestMissing,
            (409, Some("approval_not_code" | "approval_not_pending")) => {
                VaultError::ApprovalCodeNotOpen
            }
            (410, Some("approval_expired")) => {
                VaultError::ApprovalTerminal(ApprovalState::Expired, None)
            }
            (status, _) => VaultError::Portal(LinkError::HttpRefused(status, response.retry_after)),
        })
    }
    /// The saved request's status, and the portal's clock when it replied
    /// (Unix seconds, display only), if it said.
    #[cfg(feature = "portal-linking")]
    pub(crate) fn refresh(
        link: &StoredLink,
        attempt: &Attempt,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(Option<Attempt>, Option<u64>), VaultError> {
        let response = crate::portal_client::api(
            link,
            "GET",
            &format!(
                "/api/mycarlos/device-approval-requests/{}",
                attempt.request_id
            ),
            Vec::new(),
            None,
            32768,
            cancelled,
        )
        .map_err(VaultError::Portal)?;
        read_status(link, attempt, &response)
    }
    /// A status reply as `refresh` reads it: the request's state (`None`: the
    /// portal does not have it) and the portal's clock from its `Date`
    /// header. Kept apart from the HTTP call so that it can be tested.
    #[cfg(feature = "portal-linking")]
    pub(crate) fn read_status(
        link: &StoredLink,
        attempt: &Attempt,
        response: &crate::portal_client::ApiResponse,
    ) -> Result<(Option<Attempt>, Option<u64>), VaultError> {
        refuse_rate_limited(response)?;
        if response.status == 404 {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Missing {
                code: String,
            }
            if serde_json::from_slice::<Missing>(&response.body)
                .ok()
                .is_some_and(|v| v.code == "approval_not_found")
            {
                return Ok((None, response.date));
            }
        }
        if response.status != 200 {
            // The portal answered, but not with the request's state: a
            // refused device assertion, maintenance, or this device removed
            // from the patient's portal account. Not a connection failure
            // (#131); other clinic operations still word it as one.
            return Err(VaultError::Portal(if device_removed(response) {
                LinkError::DeviceRemoved
            } else {
                LinkError::HttpRefused(response.status, response.retry_after)
            }));
        }
        parse_status(link, attempt, &response.body).map(|reply| (Some(reply), response.date))
    }
    /// The portal says this device was removed from the patient's portal
    /// account: 403 with the code `device_removed` (#131). The status check
    /// and the document check (#128) read it the same way.
    #[cfg(feature = "portal-linking")]
    pub(crate) fn device_removed(response: &crate::portal_client::ApiResponse) -> bool {
        #[derive(Deserialize)]
        struct Refusal {
            code: Option<String>,
        }
        response.status == 403
            && serde_json::from_slice::<Refusal>(&response.body)
                .ok()
                .and_then(|r| r.code)
                .is_some_and(|code| code == "device_removed")
    }
    /// When the portal treats this request as ended, in Unix seconds: the
    /// intent's own expiry, or the saved, verified challenge's when it is
    /// earlier (the portal moves its expiry to the challenge's then).
    pub(crate) fn request_expires_at(link: &StoredLink, attempt: &Attempt) -> u64 {
        attempt
            .challenge
            .as_deref()
            .and_then(|challenge| verify_challenge(link, attempt, challenge, false).ok())
            .map_or(attempt.expires_at, |c| c.expires_at.min(attempt.expires_at))
    }
    /// The `approval_kind` of a challenge that asks the patient for the code
    /// their clinic emailed (clinic code v1).
    const CODE_KIND: &str = "code";
    /// Whether this request's saved challenge, as verified, asks for an
    /// emailed code.
    fn asks_for_code(link: &StoredLink, attempt: &Attempt, current: bool) -> bool {
        attempt
            .challenge
            .as_deref()
            .and_then(|challenge| verify_challenge(link, attempt, challenge, current).ok())
            .is_some_and(|c| c.approval_kind == CODE_KIND)
    }
    /// Whether the device card is about a code request: the request that
    /// approved this device, when one did, else the current one.
    pub(crate) fn approval_by_code(link: &StoredLink) -> bool {
        if currently_approved(link) {
            link.approval
                .iter()
                .chain(link.approval_history.iter())
                .filter(|attempt| {
                    matches!((&attempt.challenge, &attempt.acceptance), (Some(challenge), Some(acceptance))
                        if verify_acceptance(link, attempt, challenge, acceptance, true).is_ok())
                })
                .any(|attempt| asks_for_code(link, attempt, true))
        } else {
            link.approval
                .as_ref()
                .is_some_and(|attempt| asks_for_code(link, attempt, true))
        }
    }
    /// The clinic key id that signed this request's code challenge, checked
    /// against the link's pinned, active clinic keys as every challenge is.
    /// Refused when the clinic has not asked this request for a code.
    #[cfg(feature = "portal-linking")]
    pub(crate) fn code_challenge_kid(
        link: &StoredLink,
        attempt: &Attempt,
    ) -> Result<String, VaultError> {
        let challenge = attempt
            .challenge
            .as_deref()
            .ok_or(VaultError::ApprovalCodeNotOpen)?;
        let c = verify_challenge(link, attempt, challenge, true)?;
        if c.approval_kind != CODE_KIND {
            return Err(VaultError::ApprovalCodeNotOpen);
        }
        Ok(c.kid)
    }
    fn verify_challenge(
        link: &StoredLink,
        attempt: &Attempt,
        compact: &str,
        current: bool,
    ) -> Result<Challenge, VaultError> {
        let bad = || VaultError::Portal(LinkError::InvalidResponse);
        let clinic = link.clinic.as_ref().ok_or_else(bad)?;
        let payload = (if current {
            wire::signed_payload(compact, &clinic.clinic_keys, 8192)
        } else {
            wire::retained_payload(compact, &clinic.clinic_keys, 8192)
        })
        .map_err(|_| bad())?;
        let c: Challenge = serde_json::from_slice(&payload).map_err(|_| bad())?;
        let (x, ed) = link.keys.public();
        if c.v != 1
            || c.typ != "mycarlos-device-approval-challenge"
            || c.aud != "carlos-mycarlos-device-approval"
            || c.clinic_id != clinic.clinic_id
            || c.recipient_id != clinic.recipient_id
            || c.public_portal_base_url != link.portal_base
            || c.request_id != attempt.request_id
            || !wire::key_id(&c.challenge_id)
            || c.candidate_device_key_id != link.keys.device_key_id()
            || c.candidate_x25519_public_key != B64.encode(x)
            || c.candidate_ed25519_public_key != B64.encode(ed)
            || c.candidate_intent_sha256 != wire::sha256(attempt.intent.as_bytes())
            // Staff approval, or a code the clinic emailed (clinic code v1).
            // Neither has a predecessor.
            || !matches!(c.approval_kind.as_str(), "staff_first" | CODE_KIND)
            || c.predecessor_device_key_id.is_some()
            || c.predecessor_version.is_some()
            || c.expires_at <= c.issued_at
            || c.expires_at - c.issued_at > 600
            || c.expires_at > attempt.expires_at
            || !wire::key_id(&c.kid)
        {
            return Err(bad());
        }
        Ok(c)
    }
    fn verify_acceptance(
        link: &StoredLink,
        attempt: &Attempt,
        challenge: &str,
        compact: &str,
        current: bool,
    ) -> Result<(), VaultError> {
        let bad = || VaultError::Portal(LinkError::InvalidResponse);
        let c = verify_challenge(link, attempt, challenge, current)?;
        let clinic = link.clinic.as_ref().ok_or_else(bad)?;
        let payload = (if current {
            wire::signed_payload(compact, &clinic.clinic_keys, 8192)
        } else {
            wire::retained_payload(compact, &clinic.clinic_keys, 8192)
        })
        .map_err(|_| bad())?;
        let a: Acceptance = serde_json::from_slice(&payload).map_err(|_| bad())?;
        if a.v != 1
            || a.typ != "mycarlos-device-acceptance"
            || a.aud != "carlos-mycarlos-device-approval"
            || a.clinic_id != c.clinic_id
            || a.recipient_id != c.recipient_id
            || a.public_portal_base_url != c.public_portal_base_url
            || a.request_id != attempt.request_id
            || a.challenge_id != c.challenge_id
            || a.challenge_sha256 != wire::sha256(challenge.as_bytes())
            || a.candidate_device_key_id != c.candidate_device_key_id
            || a.candidate_x25519_public_key != c.candidate_x25519_public_key
            || a.candidate_ed25519_public_key != c.candidate_ed25519_public_key
            || a.approval_kind != c.approval_kind
            || a.predecessor_device_key_id.is_some()
            || a.approval_sha256.is_some()
            || a.accepted_version != "0"
            || a.accepted_at < c.issued_at
            || a.accepted_at >= c.expires_at
            || !wire::key_id(&a.kid)
        {
            return Err(bad());
        }
        Ok(())
    }
    pub(crate) fn valid_saved(link: &StoredLink, attempt: &Attempt) -> bool {
        let Some(clinic) = &link.clinic else {
            return false;
        };
        if (attempt.status == Some(ApprovalState::Accepted) && attempt.acceptance.is_none())
            || (attempt.acceptance.is_some()
                && attempt.status.is_some_and(|v| v != ApprovalState::Accepted))
            || (attempt.reason.is_some() && !attempt.state().terminal_failure())
        {
            return false;
        }

        let Ok((payload, signature)) = wire::split_compact(&attempt.intent, 8192) else {
            return false;
        };
        let Ok(intent) = serde_json::from_slice::<Intent>(&payload) else {
            return false;
        };
        let (x, ed) = link.keys.public();
        use ed25519_dalek::{Signature, Verifier, VerifyingKey};
        let Ok(key) = VerifyingKey::from_bytes(&ed) else {
            return false;
        };
        let Ok(signature) = Signature::from_slice(&signature) else {
            return false;
        };
        if key.verify(&payload, &signature).is_err()
            || intent.v != 1
            || intent.typ != "mycarlos-device-approval-intent"
            || intent.aud != "carlos-mycarlos-device-approval-intent"
            || intent.iss != "mycarlos"
            || intent.request_id != attempt.request_id
            || intent.candidate_device_key_id != link.keys.device_key_id()
            || intent.candidate_x25519_public_key != B64.encode(x)
            || intent.candidate_ed25519_public_key != B64.encode(ed)
            || intent.clinic_id != clinic.clinic_id
            || intent.recipient_id != clinic.recipient_id
            || intent.public_portal_base_url != link.portal_base
            || intent.predecessor_device_key_id.is_some()
            || intent.exp <= intent.iat
            || intent.exp - intent.iat > 600
            || intent.exp != attempt.expires_at
            || intent.exp > 9_007_199_254_740_991
        {
            return false;
        }
        if let Some(challenge) = &attempt.challenge {
            if verify_challenge(link, attempt, challenge, false).is_err() {
                return false;
            }
            if let Some(acceptance) = &attempt.acceptance {
                if verify_acceptance(link, attempt, challenge, acceptance, false).is_err() {
                    return false;
                }
            }
        } else if attempt.acceptance.is_some() {
            return false;
        }
        true
    }
    pub(crate) fn currently_approved(link: &StoredLink) -> bool {
        link.approval
            .iter()
            .chain(link.approval_history.iter())
            .any(|attempt| {
                let (Some(challenge), Some(acceptance)) = (&attempt.challenge, &attempt.acceptance)
                else {
                    return false;
                };
                verify_acceptance(link, attempt, challenge, acceptance, true).is_ok()
            })
    }
    #[cfg(all(test, feature = "portal-linking"))]
    mod tests {
        use super::*;
        use crate::portal_link::KeyStatus;
        #[test]
        fn should_match_all_shared_first_device_challenge_and_acceptance_vectors() {
            let (x, link, attempt) = crate::portal_approval::first_fixture();
            let first = &x["flows"]["first"];
            let challenge = first["challenge"]["compact"].as_str().unwrap();
            let mut count = 0;
            for vector in x["signed_object_vectors"].as_array().unwrap() {
                let id = vector["id"].as_str().unwrap();
                let kind = vector["kind"].as_str().unwrap();
                if !id.starts_with("first_") || !["challenge", "acceptance"].contains(&kind) {
                    continue;
                }
                let mut link = link.clone();
                if vector["clinic_key_status"] == "revoked" {
                    link.clinic.as_mut().unwrap().clinic_keys[0].status = KeyStatus::Revoked;
                }
                let compact = vector["compact"].as_str().unwrap();
                let accepted = if kind == "challenge" {
                    verify_challenge(&link, &attempt, compact, true).is_ok()
                } else {
                    verify_acceptance(&link, &attempt, challenge, compact, true).is_ok()
                };
                assert_eq!(accepted, vector["valid"].as_bool().unwrap(), "{id}");
                count += 1;
            }
            assert_eq!(count, 36);
            let mut trusted = link.clone();
            let mut accepted = attempt.clone();
            accepted.challenge = Some(challenge.to_owned());
            accepted.acceptance = Some(first["acceptance"]["compact"].as_str().unwrap().to_owned());
            accepted.status = Some(ApprovalState::Accepted);
            trusted.approval = Some(accepted.clone());
            assert!(valid_saved(&trusted, &accepted));
            assert!(currently_approved(&trusted));
            trusted.clinic.as_mut().unwrap().clinic_keys[0].status = KeyStatus::Revoked;
            assert!(
                valid_saved(&trusted, &accepted),
                "revocation must preserve historical evidence"
            );
            assert!(
                !currently_approved(&trusted),
                "historical evidence cannot grant current trust"
            );
            let generated = create(&link, x["now"].as_u64().unwrap()).unwrap();
            let (bytes, sig) = wire::split_compact(&generated.intent, 8192).unwrap();
            let intent: Intent = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(intent.candidate_device_key_id, link.keys.device_key_id());
            assert!(intent.predecessor_device_key_id.is_none());
            assert_eq!(intent.public_portal_base_url, link.portal_base);
            use ed25519_dalek::{Signature, Verifier, VerifyingKey};
            VerifyingKey::from_bytes(&link.keys.public().1)
                .unwrap()
                .verify(&bytes, &Signature::from_slice(&sig).unwrap())
                .unwrap();
        }
        fn reply(
            status: u16,
            body: serde_json::Value,
            date: Option<u64>,
        ) -> crate::portal_client::ApiResponse {
            crate::portal_client::ApiResponse {
                status,
                body: zeroize::Zeroizing::new(serde_json::to_vec(&body).unwrap()),
                date,
                retry_after: Some(30),
            }
        }
        #[test]
        fn a_status_reply_keeps_the_portals_clock_and_tells_missing_waiting_and_bad_apart() {
            let (x, link, attempt) = crate::portal_approval::first_fixture();
            let clock = Some(x["now"].as_u64().unwrap());
            let pending = serde_json::json!({"request_id":attempt.request_id,"status":"pending","challenge":null,"acceptance":null,"reason":null});
            let (state, date) = read_status(&link, &attempt, &reply(200, pending, clock)).unwrap();
            assert_eq!(state.unwrap().state(), ApprovalState::Pending);
            assert_eq!(date, clock);
            let missing = serde_json::json!({"code":"approval_not_found"});
            let (state, date) =
                read_status(&link, &attempt, &reply(404, missing.clone(), clock)).unwrap();
            assert!(state.is_none());
            assert_eq!(date, clock);
            assert!(matches!(
                read_status(&link, &attempt, &reply(429, missing, clock)),
                Err(VaultError::Portal(LinkError::RateLimited(Some(30))))
            ));
            // Refusals are not connection failures; a removed device is
            // told apart.
            for (status, body) in [
                (404, serde_json::json!({"code":"other"})),
                (404, serde_json::json!({"detail":"not found"})),
                (403, serde_json::json!({"code":"recipient_mismatch"})),
                (500, serde_json::json!({})),
                (503, serde_json::json!({})),
            ] {
                assert!(matches!(
                    read_status(&link, &attempt, &reply(status, body, clock)),
                    Err(VaultError::Portal(LinkError::HttpRefused(s, Some(30)))) if s == status
                ));
            }
            assert!(matches!(
                read_status(
                    &link,
                    &attempt,
                    &reply(403, serde_json::json!({"code":"device_removed"}), clock)
                ),
                Err(VaultError::Portal(LinkError::DeviceRemoved))
            ));
            // "Accepted" with the challenge offered as its acceptance.
            let challenge = &x["flows"]["first"]["challenge"]["compact"];
            let forged = serde_json::json!({"request_id":attempt.request_id,"status":"accepted","challenge":challenge,"acceptance":challenge,"reason":null});
            assert!(matches!(
                read_status(&link, &attempt, &reply(200, forged, clock)),
                Err(VaultError::Portal(LinkError::InvalidResponse))
            ));
        }
        #[test]
        fn should_compute_every_shared_clinic_code_vector() {
            let x: serde_json::Value =
                serde_json::from_str(include_str!("../tests/fixtures/clinic-code-v1.json"))
                    .unwrap();
            assert_eq!(x["version"], "clinic-code-v1");
            assert_eq!(x["label"], "carlos-mycarlos-clinic-code-check-v1");
            let vectors = x["vectors"].as_array().unwrap();
            assert_eq!(vectors.len(), 5);
            for v in vectors {
                let field = |name: &str| v[name].as_str().unwrap();
                let check = crate::portal_approval::code_check(
                    field("clinic_kid"),
                    field("device_key_id"),
                    field("request_id"),
                    field("code_r"),
                );
                assert_eq!(check.as_str(), field("check_t"), "{v}");
                assert_eq!(
                    format!("{}{}", field("code_r"), check.as_str()),
                    field("code")
                );
                let code = field("code");
                assert_eq!(
                    format!("{} {} {}", &code[..3], &code[3..6], &code[6..]),
                    field("display")
                );
                // The code as shown to the patient is what myCarlos reads.
                assert_eq!(
                    crate::portal_approval::code_digits(field("display"))
                        .unwrap()
                        .as_str(),
                    code
                );
            }
        }
        #[test]
        fn should_take_9_digits_with_or_without_spaces_and_dashes_only() {
            for typed in [
                "482193644",
                "482 193 644",
                "482-193-644",
                " 482 193-644 ",
                "48 21 93 64 4",
            ] {
                assert_eq!(
                    crate::portal_approval::code_digits(typed).unwrap().as_str(),
                    "482193644",
                    "{typed}"
                );
            }
            for typed in [
                "",
                "48219364",
                "4821936440",
                "482193 64a",
                "482_193_644",
                "482.193.644",
                "482\u{a0}193\u{a0}644",
                "482\t193\t644",
                "\u{ff14}82193644",
                "\u{0664}82193644",
                &"4".repeat(65),
                &format!("482193644{}", " ".repeat(60)),
            ] {
                assert!(
                    matches!(
                        crate::portal_approval::code_digits(typed),
                        Err(VaultError::Invalid)
                    ),
                    "{typed:?}"
                );
            }
        }
        #[test]
        fn should_verify_code_challenges_and_only_acceptances_of_the_same_kind() {
            let (_, link, attempt) = crate::portal_approval::first_fixture();
            let with_kind = |kind: &'static str| {
                crate::portal_approval::fixture_challenge_with(|c| c["approval_kind"] = kind.into())
            };
            let code = with_kind("code");
            let staff = with_kind("staff_first");
            assert_eq!(
                verify_challenge(&link, &attempt, &code, true)
                    .unwrap()
                    .approval_kind,
                "code"
            );
            // Code requests have no predecessor; other kinds stay refused.
            for refused in [
                with_kind("accepted_device"),
                with_kind("Code"),
                crate::portal_approval::fixture_challenge_with(|c| {
                    c["approval_kind"] = "code".into();
                    c["predecessor_device_key_id"] = "FAKE-device-key-0002".into();
                }),
                crate::portal_approval::fixture_challenge_with(|c| {
                    c["approval_kind"] = "code".into();
                    c["predecessor_version"] = "1".into();
                }),
            ] {
                assert!(verify_challenge(&link, &attempt, &refused, true).is_err());
            }
            let accept = |challenge: &str, kind: &'static str| {
                crate::portal_approval::fixture_acceptance_with(challenge, |a| {
                    a["approval_kind"] = kind.into()
                })
            };
            assert!(
                verify_acceptance(&link, &attempt, &code, &accept(&code, "code"), true).is_ok()
            );
            assert!(verify_acceptance(
                &link,
                &attempt,
                &staff,
                &accept(&staff, "staff_first"),
                true
            )
            .is_ok());
            // The acceptance must be of the kind the challenge asked for,
            // and a code acceptance carries no approval hash either.
            assert!(
                verify_acceptance(&link, &attempt, &code, &accept(&code, "staff_first"), true)
                    .is_err()
            );
            assert!(
                verify_acceptance(&link, &attempt, &staff, &accept(&staff, "code"), true).is_err()
            );
            let hashed = crate::portal_approval::fixture_acceptance_with(&code, |a| {
                a["approval_kind"] = "code".into();
                a["approval_sha256"] = crate::portal_delivery::sha256(b"FAKE approval").into();
            });
            assert!(verify_acceptance(&link, &attempt, &code, &hashed, true).is_err());
            // The card is about a code request, open or approved.
            let mut open = link.clone();
            let mut asked = attempt.clone();
            asked.challenge = Some(code.clone());
            asked.status = Some(ApprovalState::ChallengeReady);
            open.approval = Some(asked.clone());
            assert!(valid_saved(&open, &asked));
            assert!(approval_by_code(&open));
            assert_eq!(
                code_challenge_kid(&open, &asked).unwrap(),
                link.clinic.as_ref().unwrap().clinic_keys[0].kid
            );
            let mut approved = open.clone();
            let mut accepted = asked.clone();
            accepted.acceptance = Some(accept(&code, "code"));
            accepted.status = Some(ApprovalState::Accepted);
            approved.approval = Some(accepted.clone());
            assert!(valid_saved(&approved, &accepted));
            assert!(currently_approved(&approved));
            assert!(approval_by_code(&approved));
            let mut by_staff = link.clone();
            let mut staff_asked = attempt.clone();
            staff_asked.challenge = Some(staff.clone());
            staff_asked.status = Some(ApprovalState::ChallengeReady);
            by_staff.approval = Some(staff_asked.clone());
            assert!(!approval_by_code(&by_staff));
            assert!(matches!(
                code_challenge_kid(&by_staff, &staff_asked),
                Err(VaultError::ApprovalCodeNotOpen)
            ));
            assert!(matches!(
                code_challenge_kid(&link, &attempt),
                Err(VaultError::ApprovalCodeNotOpen)
            ));
        }
        #[test]
        fn should_send_only_the_clinics_6_digits_in_the_exact_body() {
            let (_, _, attempt) = crate::portal_approval::first_fixture();
            let (route, body) = code_request(&attempt, "482193").unwrap();
            assert_eq!(
                route,
                format!("/api/mycarlos/device-approvals/{}/code", attempt.request_id)
            );
            assert!(!route.contains('?'));
            assert_eq!(body.as_slice(), br#"{"code_r":"482193"}"#);
            for code_r in ["48219", "4821930", "48219a", "482193644", ""] {
                assert!(matches!(
                    code_request(&attempt, code_r),
                    Err(VaultError::Invalid)
                ));
            }
        }
        #[test]
        fn should_read_every_code_route_reply() {
            let answer = |status: u16, body: &[u8]| crate::portal_client::ApiResponse {
                status,
                body: zeroize::Zeroizing::new(body.to_vec()),
                date: None,
                retry_after: Some(60),
            };
            assert!(read_code_reply(&answer(202, br#"{"status":"submitted"}"#)).is_ok());
            for body in [
                &br#"{"status":"submitted","attempt":1}"#[..],
                br#"{"status":"accepted"}"#,
                br#"{}"#,
                b"",
            ] {
                assert!(matches!(
                    read_code_reply(&answer(202, body)),
                    Err(VaultError::Portal(LinkError::InvalidResponse))
                ));
            }
            // Final for the request: its generic wait is not used.
            assert!(matches!(
                read_code_reply(&answer(429, br#"{"code":"code_attempts"}"#)),
                Err(VaultError::ApprovalCodeLocked)
            ));
            assert!(matches!(
                read_code_reply(&answer(429, br#"{"detail":"slow down"}"#)),
                Err(VaultError::Portal(LinkError::RateLimited(Some(60))))
            ));
            assert!(matches!(
                read_code_reply(&answer(403, br#"{"code":"device_removed"}"#)),
                Err(VaultError::Portal(LinkError::DeviceRemoved))
            ));
            assert!(matches!(
                read_code_reply(&answer(404, br#"{"code":"approval_not_found"}"#)),
                Err(VaultError::ApprovalRequestMissing)
            ));
            for code in ["approval_not_code", "approval_not_pending"] {
                assert!(matches!(
                    read_code_reply(&answer(409, format!(r#"{{"code":"{code}"}}"#).as_bytes())),
                    Err(VaultError::ApprovalCodeNotOpen)
                ));
            }
            assert!(matches!(
                read_code_reply(&answer(410, br#"{"code":"approval_expired"}"#)),
                Err(VaultError::ApprovalTerminal(ApprovalState::Expired, None))
            ));
            for (status, body) in [
                (403, &br#"{"code":"recipient_mismatch"}"#[..]),
                (404, br#"{"detail":"not found"}"#),
                (400, br#"{"code":"invalid_approval"}"#),
                (413, br#"{"detail":"request too large"}"#),
                (409, br#"{"code":"other"}"#),
                (200, br#"{"status":"submitted"}"#),
                (500, b""),
            ] {
                assert!(
                    matches!(
                        read_code_reply(&answer(status, body)),
                        Err(VaultError::Portal(LinkError::HttpRefused(s, Some(60)))) if s == status
                    ),
                    "{status}"
                );
            }
        }
        #[test]
        fn a_request_ends_at_the_earlier_of_its_intent_and_its_saved_challenge() {
            let (x, link, attempt) = crate::portal_approval::first_fixture();
            assert_eq!(request_expires_at(&link, &attempt), attempt.expires_at);
            let mut challenged = attempt.clone();
            challenged.challenge = Some(
                x["flows"]["first"]["challenge"]["compact"]
                    .as_str()
                    .unwrap()
                    .into(),
            );
            assert_eq!(request_expires_at(&link, &challenged), attempt.expires_at);
            challenged.challenge = Some(crate::portal_approval::fixture_challenge_expiring_at(
                attempt.expires_at - 300,
            ));
            verify_challenge(
                &link,
                &challenged,
                challenged.challenge.as_ref().unwrap(),
                true,
            )
            .unwrap();
            assert_eq!(
                request_expires_at(&link, &challenged),
                attempt.expires_at - 300
            );
        }
        #[test]
        fn a_reply_date_stands_for_the_portals_clock_only_when_it_can_be() {
            use crate::portal_approval::{portal_clock, PORTAL_CLOCK_BOUND_SECONDS as BOUND};
            let local = 1_792_454_400;
            let end = local + 500;
            for usable in [local, local - BOUND, local + BOUND, local + 200] {
                assert_eq!(
                    portal_clock(Some(usable), end, local),
                    Some(usable),
                    "{usable}"
                );
            }
            // A stuck or far-off date, or none at all: this device's clock is
            // used instead.
            for unusable in [local - BOUND - 1, local + BOUND + 1, 0, u64::MAX] {
                assert_eq!(portal_clock(Some(unusable), end, local), None, "{unusable}");
            }
            assert_eq!(portal_clock(None, end, local), None);
            // Nor does a date leaving the request an hour or more count.
            assert_eq!(portal_clock(Some(local), local + 3_600, local), None);
            assert_eq!(portal_clock(Some(local), local + 3_599, local), Some(local));
        }
        #[test]
        fn approval_http_keeps_the_last_portal_clock_it_was_given() {
            use crate::portal_approval::{ApprovalExchange, ApprovalHttp};
            let http = ApprovalHttp::default();
            assert_eq!(http.portal_time(), None);
            http.remember(Some(5));
            http.remember(None);
            assert_eq!(http.portal_time(), Some(5));
            http.remember(Some(7));
            assert_eq!(http.portal_time(), Some(7));
        }
        #[test]
        fn a_portal_asking_to_wait_is_neither_a_network_failure_nor_a_request_state() {
            let reply = |status, retry_after| crate::portal_client::ApiResponse {
                status,
                body: zeroize::Zeroizing::new(br#"{"code":"rate_limited"}"#.to_vec()),
                date: None,
                retry_after,
            };
            assert!(matches!(
                refuse_rate_limited(&reply(429, Some(30))),
                Err(VaultError::Portal(LinkError::RateLimited(Some(30))))
            ));
            assert!(matches!(
                refuse_rate_limited(&reply(429, None)),
                Err(VaultError::Portal(LinkError::RateLimited(None)))
            ));
            for status in [200, 201, 404, 500, 503] {
                assert!(refuse_rate_limited(&reply(status, Some(30))).is_ok());
            }
        }
    }
}
pub(crate) use native::request_expires_at;
#[cfg(feature = "portal-linking")]
pub(crate) use native::{code_challenge_kid, send_code};
#[cfg(feature = "portal-linking")]
pub(crate) use native::{create, device_removed, publish, refresh};

/// How far a reply's `Date` may be from this device's clock and still be
/// taken as the portal's clock (#131). The portal accepts this device's
/// signed requests only while its own clock is between 30 s behind and
/// 90 s ahead of this device's, so a date further off than this is not the
/// clock that judged the request: a stuck header, or another server's.
#[cfg(feature = "portal-linking")]
pub const PORTAL_CLOCK_BOUND_SECONDS: u64 = 300;

/// The portal's clock from its reply, when it can stand for it: near this
/// device's clock (`PORTAL_CLOCK_BOUND_SECONDS`), and leaving the request
/// less than an hour (requests last ten minutes). Otherwise `None`, and
/// this device's clock is used, as when the portal gave no date. Shared by
/// the time left, the restart offer and the restart itself.
#[cfg(feature = "portal-linking")]
pub(crate) fn portal_clock(
    portal_now: Option<u64>,
    request_end: u64,
    local_now: u64,
) -> Option<u64> {
    portal_now.filter(|&now| {
        now.abs_diff(local_now) <= PORTAL_CLOCK_BOUND_SECONDS
            && request_end.saturating_sub(now) < 3_600
    })
}

/// The portal's clock for deciding whether this request has ended, when it
/// can be used: the portal has the request (`portal_has_it`; a request it
/// does not have is judged by this device's clock) and its date can stand
/// for its clock (`portal_clock`). `None`: use this device's clock. One
/// choice for the status check and the restart (#131).
#[cfg(feature = "portal-linking")]
pub(crate) fn deciding_portal_time(
    portal_now: Option<u64>,
    link: &StoredLink,
    attempt: &Attempt,
    portal_has_it: bool,
    local_now: u64,
) -> Option<u64> {
    portal_has_it
        .then(|| portal_clock(portal_now, request_expires_at(link, attempt), local_now))
        .flatten()
}

/// Whether this request has ended by `clock`: the portal said so, or its end
/// has passed. The portal says "expired" only once the clinic's system has
/// (which needs a challenge), so for a request it never picked up the time
/// is the only way to tell.
pub(crate) fn request_ended(link: &StoredLink, attempt: &Attempt, clock: u64) -> bool {
    matches!(
        attempt.state(),
        ApprovalState::Expired | ApprovalState::Cancelled
    ) || request_expires_at(link, attempt) <= clock
}

/// Whether a new request may start for this device by `clock`: a slot is
/// left, no acceptance is kept, and the current request was not refused and
/// has ended. One rule for the saved summary (this device's clock) and the
/// status check and restart (the portal's clock when it can be used).
pub(crate) fn can_restart(link: &StoredLink, clock: u64) -> bool {
    let requests = link.approval_history.len() + usize::from(link.approval.is_some());
    let accepted = link
        .approval
        .iter()
        .chain(link.approval_history.iter())
        .any(|a| a.acceptance.is_some());
    requests < MAX_APPROVAL_REQUESTS
        && !accepted
        && link
            .approval
            .as_ref()
            .is_some_and(|a| a.state() != ApprovalState::Refused && request_ended(link, a, clock))
}

#[cfg(all(test, feature = "portal-linking"))]
pub(crate) use native::parse_status;
pub(crate) use native::{approval_by_code, currently_approved, valid_saved};

/// Clinic code v1 (mycarlos#141). The patient's code is the 6 digits the
/// clinic made and 3 check digits that bind it to the clinic key that signed
/// the request's code challenge, this device and this request. myCarlos
/// checks them before anything is sent, so a code read from a look-alike
/// portal, or for another device or request, is never sent.
#[cfg(feature = "portal-linking")]
const CODE_CHECK_LABEL: &str = "carlos-mycarlos-clinic-code-check-v1";

/// The 3 check digits: the first 8 bytes of SHA-256 over the label and the
/// four fields joined by LF, as a big-endian number, mod 1000, zero-padded.
#[cfg(feature = "portal-linking")]
pub(crate) fn code_check(
    clinic_kid: &str,
    device_key_id: &str,
    request_id: &str,
    code_r: &str,
) -> zeroize::Zeroizing<String> {
    use sha2::{Digest, Sha256};
    let input = zeroize::Zeroizing::new(
        [
            CODE_CHECK_LABEL,
            clinic_kid,
            device_key_id,
            request_id,
            code_r,
        ]
        .join("\n"),
    );
    let digest = Sha256::digest(input.as_bytes());
    let mut first = [0_u8; 8];
    first.copy_from_slice(&digest[..8]);
    zeroize::Zeroizing::new(format!("{:03}", u64::from_be_bytes(first) % 1000))
}

/// The 9 digits of a code as typed, with spaces and dashes taken out.
/// Anything else is refused before it is checked.
#[cfg(feature = "portal-linking")]
pub(crate) fn code_digits(typed: &str) -> Result<zeroize::Zeroizing<String>, VaultError> {
    if typed.len() > 64 {
        return Err(VaultError::Invalid);
    }
    let digits: zeroize::Zeroizing<String> =
        zeroize::Zeroizing::new(typed.chars().filter(|c| !matches!(*c, ' ' | '-')).collect());
    if digits.len() != 9 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(VaultError::Invalid);
    }
    Ok(digits)
}

#[cfg(all(test, feature = "portal-linking"))]
pub(crate) fn first_fixture() -> (serde_json::Value, crate::portal_link::StoredLink, Attempt) {
    use crate::portal_delivery as wire;
    use crate::portal_link::{ClinicKey, KeyStatus, LinkedClinic, PrivateKeys, StoredLink};
    use sha2::{Digest, Sha256};
    let x: serde_json::Value = serde_json::from_str(include_str!(
        "../tests/fixtures/device-approval-contract-v1.json"
    ))
    .unwrap();
    assert_eq!(
        wire::sha256(include_bytes!(
            "../tests/fixtures/device-approval-contract-v1.json"
        )),
        "2f20211f6bcfe14ff0723745b28def15e6453f54c428d1b9a1656e0d091505b6"
    );
    let first = &x["flows"]["first"];
    let k = &x["keys"]["first"];
    let seed = |name: &str| Sha256::digest(k[name].as_str().unwrap().as_bytes()).to_vec();
    let keys: PrivateKeys = serde_json::from_value(
        serde_json::json!({"x25519":seed("x25519_seed_text"),"ed25519":seed("ed25519_seed_text")}),
    )
    .unwrap();
    let clinic = &x["keys"]["clinic"];
    let link = StoredLink {
        id: Uuid::new_v4(),
        portal_base: x["public_portal_base_url"].as_str().unwrap().into(),
        device_name: "myCarlos on Windows".into(),
        profile_id: None,
        created_at_ms: 1,
        keys,
        clinic: Some(LinkedClinic {
            recipient_id: x["recipient_id"].as_str().unwrap().into(),
            device_key_id: k["device_key_id"].as_str().unwrap().into(),
            clinic_id: x["clinic_id"].as_str().unwrap().into(),
            clinic_name: "FAKE M3 clinic".into(),
            clinic_keys: vec![ClinicKey {
                kid: clinic["kid"].as_str().unwrap().into(),
                spki: clinic["spki"].as_str().unwrap().into(),
                status: KeyStatus::Active,
            }],
        }),
        approval: None,
        approval_history: Vec::new(),
    };
    let attempt = Attempt {
        request_id: Uuid::parse_str(first["intent"]["claims"]["request_id"].as_str().unwrap())
            .unwrap(),
        intent: first["intent"]["compact"].as_str().unwrap().into(),
        expires_at: first["intent"]["claims"]["exp"].as_u64().unwrap(),
        challenge: None,
        acceptance: None,
        status: Some(ApprovalState::Pending),
        reason: None,
    };
    (x, link, attempt)
}

/// The fixture's first-device challenge with a different expiry, signed
/// again with the shared fixture's FAKE clinic key, read from the fixture
/// at run time (#131).
#[cfg(all(test, feature = "portal-linking"))]
pub(crate) fn fixture_challenge_expiring_at(expires_at: u64) -> String {
    let (x, _, _) = first_fixture();
    let mut claims = x["flows"]["first"]["challenge"]["claims"].clone();
    claims["expires_at"] = expires_at.into();
    sign_fixture_claims(&claims)
}

/// A first-device challenge for this link's saved request, issued and
/// ending at the given times, signed with the fixture's FAKE clinic key (the
/// link must carry the fixture's clinic, as test links do).
#[cfg(all(test, feature = "portal-linking"))]
pub(crate) fn signed_challenge(
    link: &crate::portal_link::StoredLink,
    attempt: &Attempt,
    issued_at: u64,
    expires_at: u64,
) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine as _};
    let (x, _, _) = first_fixture();
    let clinic = link.clinic.as_ref().unwrap();
    let (x25519, ed25519) = link.keys.public();
    let mut claims = x["flows"]["first"]["challenge"]["claims"].clone();
    claims["request_id"] = attempt.request_id.to_string().into();
    claims["candidate_device_key_id"] = link.keys.device_key_id().into();
    claims["candidate_x25519_public_key"] = B64.encode(x25519).into();
    claims["candidate_ed25519_public_key"] = B64.encode(ed25519).into();
    claims["candidate_intent_sha256"] =
        crate::portal_delivery::sha256(attempt.intent.as_bytes()).into();
    claims["clinic_id"] = clinic.clinic_id.clone().into();
    claims["recipient_id"] = clinic.recipient_id.clone().into();
    claims["public_portal_base_url"] = link.portal_base.clone().into();
    claims["issued_at"] = issued_at.into();
    claims["expires_at"] = expires_at.into();
    sign_fixture_claims(&claims)
}

/// The fixture's first-device challenge, changed by `change` and signed
/// again with the fixture's FAKE clinic key (clinic code v1 tests).
#[cfg(all(test, feature = "portal-linking"))]
pub(crate) fn fixture_challenge_with(change: impl FnOnce(&mut serde_json::Value)) -> String {
    let (x, _, _) = first_fixture();
    let mut claims = x["flows"]["first"]["challenge"]["claims"].clone();
    change(&mut claims);
    sign_fixture_claims(&claims)
}

/// The fixture's first-device acceptance of `challenge` (its hash put in),
/// changed by `change` and signed again with the fixture's FAKE clinic key.
#[cfg(all(test, feature = "portal-linking"))]
pub(crate) fn fixture_acceptance_with(
    challenge: &str,
    change: impl FnOnce(&mut serde_json::Value),
) -> String {
    let (x, _, _) = first_fixture();
    let mut claims = x["flows"]["first"]["acceptance"]["claims"].clone();
    claims["challenge_sha256"] = crate::portal_delivery::sha256(challenge.as_bytes()).into();
    change(&mut claims);
    sign_fixture_claims(&claims)
}

#[cfg(all(test, feature = "portal-linking"))]
fn sign_fixture_claims(claims: &serde_json::Value) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine as _};
    use p256::ecdsa::{signature::Signer, Signature, SigningKey};
    use p256::pkcs8::{DecodePrivateKey, EncodePublicKey};
    let (x, _, _) = first_fixture();
    let clinic = &x["keys"]["clinic"];
    let key = SigningKey::from_pkcs8_der(
        &B64.decode(clinic["FAKE_private_pkcs8_b64url"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        B64.encode(key.verifying_key().to_public_key_der().unwrap().as_bytes()),
        clinic["spki"].as_str().unwrap(),
        "the fixture's clinic key"
    );
    let payload = serde_json::to_vec(claims).unwrap();
    let signature: Signature = key.sign(&payload);
    format!(
        "{}.{}",
        B64.encode(&payload),
        B64.encode(signature.to_bytes())
    )
}

use crate::portal_link::StoredLink;
#[cfg(feature = "portal-linking")]
use crate::vault::VaultError;
#[cfg(feature = "portal-linking")]
pub(crate) trait ApprovalExchange {
    fn get(
        &self,
        link: &StoredLink,
        attempt: &crate::portal_approval::Attempt,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Option<crate::portal_approval::Attempt>, VaultError>;
    fn post(
        &self,
        link: &StoredLink,
        attempt: &crate::portal_approval::Attempt,
        anchor: &str,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<crate::portal_approval::Attempt, VaultError>;
    /// Sends a code already checked against this clinic (clinic code v1).
    fn submit_code(
        &self,
        link: &StoredLink,
        attempt: &crate::portal_approval::Attempt,
        code_r: &str,
        anchor: &str,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(), VaultError>;
    /// The portal's clock (Unix seconds) when it last answered a status read
    /// through this exchange, if it said. It only shows how long a request
    /// has left, by the portal's clock rather than this device's (#131).
    fn portal_time(&self) -> Option<u64> {
        None
    }
}
#[cfg(feature = "portal-linking")]
#[derive(Default)]
pub(crate) struct ApprovalHttp {
    portal_time: std::cell::Cell<Option<u64>>,
}
#[cfg(feature = "portal-linking")]
impl ApprovalHttp {
    /// Keeps the portal's clock from a status reply that gave one; a reply
    /// without it leaves the last one known.
    fn remember(&self, date: Option<u64>) {
        if date.is_some() {
            self.portal_time.set(date);
        }
    }
}
#[cfg(feature = "portal-linking")]
impl ApprovalExchange for ApprovalHttp {
    fn get(
        &self,
        link: &StoredLink,
        attempt: &crate::portal_approval::Attempt,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Option<crate::portal_approval::Attempt>, VaultError> {
        let (reply, date) = crate::portal_approval::refresh(link, attempt, cancelled)?;
        self.remember(date);
        Ok(reply)
    }
    fn portal_time(&self) -> Option<u64> {
        self.portal_time.get()
    }
    fn post(
        &self,
        link: &StoredLink,
        attempt: &crate::portal_approval::Attempt,
        anchor: &str,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<crate::portal_approval::Attempt, VaultError> {
        crate::portal_approval::publish(link, attempt, anchor, cancelled)
    }
    fn submit_code(
        &self,
        link: &StoredLink,
        attempt: &crate::portal_approval::Attempt,
        code_r: &str,
        anchor: &str,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(), VaultError> {
        crate::portal_approval::send_code(link, attempt, code_r, anchor, cancelled)
    }
}

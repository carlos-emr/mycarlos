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
            return Err(VaultError::Portal(LinkError::Network));
        }
        parse_status(link, attempt, &response.body).map(|reply| (Some(reply), response.date))
    }
    /// When the portal treats this request as ended, in Unix seconds: the
    /// intent's own expiry, or the saved, verified challenge's when it is
    /// earlier (the portal moves its expiry to the challenge's then). Both
    /// are compared with the portal's clock, never this device's.
    #[cfg(feature = "portal-linking")]
    pub(crate) fn request_expires_at(link: &StoredLink, attempt: &Attempt) -> u64 {
        attempt
            .challenge
            .as_deref()
            .and_then(|challenge| verify_challenge(link, attempt, challenge, false).ok())
            .map_or(attempt.expires_at, |c| c.expires_at.min(attempt.expires_at))
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
            || c.approval_kind != "staff_first"
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
            || a.approval_kind != "staff_first"
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
            for (status, body) in [
                (404, serde_json::json!({"code":"other"})),
                (500, serde_json::json!({})),
            ] {
                assert!(matches!(
                    read_status(&link, &attempt, &reply(status, body, clock)),
                    Err(VaultError::Portal(LinkError::Network))
                ));
            }
            // "Accepted" with the challenge offered as its acceptance.
            let challenge = &x["flows"]["first"]["challenge"]["compact"];
            let forged = serde_json::json!({"request_id":attempt.request_id,"status":"accepted","challenge":challenge,"acceptance":challenge,"reason":null});
            assert!(matches!(
                read_status(&link, &attempt, &reply(200, forged, clock)),
                Err(VaultError::Portal(LinkError::InvalidResponse))
            ));
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
#[cfg(feature = "portal-linking")]
pub(crate) use native::{create, publish, refresh, request_expires_at};

#[cfg(all(test, feature = "portal-linking"))]
pub(crate) use native::parse_status;
pub(crate) use native::{currently_approved, valid_saved};

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
    let mut claims = x["flows"]["first"]["challenge"]["claims"].clone();
    claims["expires_at"] = expires_at.into();
    let payload = serde_json::to_vec(&claims).unwrap();
    let signature: Signature = key.sign(&payload);
    format!(
        "{}.{}",
        B64.encode(&payload),
        B64.encode(signature.to_bytes())
    )
}

#[cfg(feature = "portal-linking")]
use crate::{portal_link::StoredLink, vault::VaultError};
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
}

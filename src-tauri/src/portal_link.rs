//! Native-only v1 link state. Private seeds are serialized only inside the
//! encrypted vault manifest; the public snapshot uses `summary`, never this type.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use p256::pkcs8::{DecodePublicKey, EncodePublicKey};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Url;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

pub const MAX_LINKS: usize = 16;
pub const MAX_PORTAL_UTF8_BYTES: usize = 1024;
#[cfg(any(feature = "portal-linking", test))]
pub const MAX_RESPONSE_BYTES: usize = 32 * 1024;
const CODE_ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub const fn enabled() -> bool {
    cfg!(feature = "portal-linking")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkError {
    Disabled,
    Unavailable,
    InvalidPortal,
    InvalidCode,
    InvalidDeviceName,
    InvalidResponse,
    #[cfg_attr(not(feature = "portal-linking"), allow(dead_code))]
    Network,
    #[cfg_attr(not(feature = "portal-linking"), allow(dead_code))]
    CodeRejected,
    #[cfg_attr(not(feature = "portal-linking"), allow(dead_code))]
    ClinicKeysMissing,
    #[cfg_attr(not(feature = "portal-linking"), allow(dead_code))]
    DeviceExists,
    #[cfg_attr(not(feature = "portal-linking"), allow(dead_code))]
    Busy,
    /// The portal refused for too many requests (HTTP 429), with the seconds
    /// it asked to wait, if it said (#131).
    #[cfg_attr(not(feature = "portal-linking"), allow(dead_code))]
    RateLimited(Option<u64>),
    /// The portal refused because this device was removed from the patient's
    /// portal account (403 `device_removed`, #131).
    #[cfg_attr(not(feature = "portal-linking"), allow(dead_code))]
    DeviceRemoved,
    /// The portal answered with this other HTTP status instead of what was
    /// asked: a refused device assertion, maintenance… (#131).
    #[cfg_attr(not(feature = "portal-linking"), allow(dead_code))]
    HttpRefused(u16),
    Cancelled,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PrivateKeys {
    x25519: [u8; 32],
    ed25519: [u8; 32],
}

impl PrivateKeys {
    fn generate() -> Self {
        let mut result = Self {
            x25519: [0; 32],
            ed25519: [0; 32],
        };
        OsRng.fill_bytes(&mut result.x25519);
        OsRng.fill_bytes(&mut result.ed25519);
        result
    }

    pub(crate) fn public(&self) -> ([u8; 32], [u8; 32]) {
        let x = x25519_dalek::StaticSecret::from(self.x25519);
        let ed = SigningKey::from_bytes(&self.ed25519);
        (
            x25519_dalek::PublicKey::from(&x).to_bytes(),
            ed.verifying_key().to_bytes(),
        )
    }

    pub fn device_key_id(&self) -> String {
        let (x, ed) = self.public();
        let mut digest = Sha256::new();
        digest.update(b"mycarlos-device-key-v1");
        digest.update(frame(&[&x, &ed]));
        B64.encode(digest.finalize())
    }

    #[cfg(feature = "portal-linking")]
    pub(crate) fn sign(&self, payload: &[u8]) -> String {
        let signature = SigningKey::from_bytes(&self.ed25519).sign(payload);
        format!(
            "{}.{}",
            B64.encode(payload),
            B64.encode(signature.to_bytes())
        )
    }

    #[cfg(feature = "portal-linking")]
    pub(crate) fn open_seal(&self, sealed: &[u8], aad: &[u8]) -> Result<Zeroizing<Vec<u8>>, ()> {
        use hpke::{
            aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256, Deserializable, Kem,
            OpModeR,
        };
        type K = X25519HkdfSha256;
        if sealed.len() < 49 {
            return Err(());
        }
        let private = <K as Kem>::PrivateKey::from_bytes(&self.x25519).map_err(|_| ())?;
        let enc = <K as Kem>::EncappedKey::from_bytes(&sealed[..32]).map_err(|_| ())?;
        let mut context = hpke::setup_receiver::<ChaCha20Poly1305, HkdfSha256, K>(
            &OpModeR::Base,
            &private,
            &enc,
            b"carlos-emr/mycarlos-delivery/v1",
        )
        .map_err(|_| ())?;
        context
            .open(&sealed[32..], aad)
            .map(Zeroizing::new)
            .map_err(|_| ())
    }

    pub(crate) fn anchor(&self, head: &[u8; 32]) -> Result<String, LinkError> {
        use hmac::{Hmac, Mac};
        let mut key = Zeroizing::new([0; 32]);
        hkdf::Hkdf::<Sha256>::new(None, &self.ed25519)
            .expand(b"mycarlos/vault-head/v1", key.as_mut())
            .map_err(|_| LinkError::InvalidResponse)?;
        let mut mac =
            Hmac::<Sha256>::new_from_slice(key.as_ref()).map_err(|_| LinkError::InvalidResponse)?;
        mac.update(head);
        Ok(hex(&mac.finalize().into_bytes()))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyStatus {
    Active,
    Revoked,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClinicKey {
    pub kid: String,
    pub spki: String,
    pub status: KeyStatus,
}

impl ClinicKey {
    fn validate(&self) -> Result<(), LinkError> {
        let der = B64
            .decode(&self.spki)
            .map_err(|_| LinkError::InvalidResponse)?;
        if B64.encode(&der) != self.spki || B64.encode(Sha256::digest(&der)) != self.kid {
            return Err(LinkError::InvalidResponse);
        }
        let key =
            p256::PublicKey::from_public_key_der(&der).map_err(|_| LinkError::InvalidResponse)?;
        let canonical = key
            .to_public_key_der()
            .map_err(|_| LinkError::InvalidResponse)?;
        if canonical.as_bytes() != der {
            return Err(LinkError::InvalidResponse);
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinkedClinic {
    pub recipient_id: String,
    pub device_key_id: String,
    pub clinic_id: String,
    pub clinic_name: String,
    pub clinic_keys: Vec<ClinicKey>,
}

impl LinkedClinic {
    pub fn validate(&self, expected_device: &str) -> Result<(), LinkError> {
        if self.device_key_id != expected_device
            || !opaque_id(&self.recipient_id)
            || !bounded_label(&self.clinic_id, 128)
            || !bounded_label(&self.clinic_name, 240)
            || self.clinic_keys.is_empty()
            || self.clinic_keys.len() > 16
        {
            return Err(LinkError::InvalidResponse);
        }
        let mut seen = std::collections::HashSet::new();
        for key in &self.clinic_keys {
            if !seen.insert(&key.kid) {
                return Err(LinkError::InvalidResponse);
            }
            key.validate()?;
        }
        Ok(())
    }

    /// The portal refuses a new link without an active clinic key. Stored
    /// inventories must also represent a later complete revocation faithfully.
    pub fn validate_initial(&self, expected_device: &str) -> Result<(), LinkError> {
        self.validate(expected_device)?;
        if !self
            .clinic_keys
            .iter()
            .any(|key| key.status == KeyStatus::Active)
        {
            return Err(LinkError::InvalidResponse);
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StoredLink {
    pub id: Uuid,
    pub portal_base: String,
    pub device_name: String,
    pub profile_id: Option<Uuid>,
    pub created_at_ms: u64,
    pub keys: PrivateKeys,
    /// None means an incomplete attempt, never a trusted clinic link.
    pub clinic: Option<LinkedClinic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<crate::portal_approval::Attempt>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub approval_history: Vec<crate::portal_approval::Attempt>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkSummary {
    pub id: Uuid,
    pub portal_base: String,
    pub device_name: String,
    pub profile_id: Option<Uuid>,
    pub clinic_name: Option<String>,
    pub fingerprints: Vec<String>,
    pub incomplete: bool,
    pub device_key_id: String,
    pub device_fingerprint: String,
    pub approval_requested: bool,
    pub clinic_approved: bool,
    pub approval_status: Option<crate::portal_approval::ApprovalState>,
    pub approval_reason: Option<crate::portal_approval::ApprovalReason>,
    pub approval_can_restart: bool,
    pub approval_request_limit_reached: bool,
}

impl StoredLink {
    pub fn pending(
        portal: &str,
        device_name: &str,
        profile_id: Option<Uuid>,
        now_ms: u64,
    ) -> Result<Self, LinkError> {
        let portal_base = normalize_portal(portal)?;
        if !bounded_label(device_name, 64) {
            return Err(LinkError::InvalidDeviceName);
        }
        Ok(Self {
            id: Uuid::new_v4(),
            portal_base,
            device_name: device_name.to_owned(),
            profile_id,
            created_at_ms: now_ms,
            keys: PrivateKeys::generate(),
            clinic: None,
            approval: None,
            approval_history: Vec::new(),
        })
    }

    pub fn validate(&self) -> Result<(), LinkError> {
        if self.id.is_nil()
            || normalize_portal(&self.portal_base)? != self.portal_base
            || !bounded_label(&self.device_name, 64)
        {
            return Err(LinkError::InvalidResponse);
        }
        let mut request_ids = std::collections::HashSet::new();
        if self.approval_history.len() + usize::from(self.approval.is_some())
            > crate::portal_approval::MAX_APPROVAL_REQUESTS
            || (!self.approval_history.is_empty() && self.approval.is_none())
            || self
                .approval
                .iter()
                .chain(self.approval_history.iter())
                .any(|a| {
                    !request_ids.insert(a.request_id)
                        || !crate::portal_approval::valid_saved(self, a)
                })
        {
            return Err(LinkError::InvalidResponse);
        }
        if let Some(clinic) = &self.clinic {
            clinic.validate(&self.keys.device_key_id())?;
        }
        Ok(())
    }

    pub fn summary(&self) -> LinkSummary {
        let approved = crate::portal_approval::currently_approved(self);
        let accepted = self
            .approval
            .iter()
            .chain(self.approval_history.iter())
            .any(|a| a.acceptance.is_some());
        LinkSummary {
            id: self.id,
            portal_base: self.portal_base.clone(),
            device_name: self.device_name.clone(),
            profile_id: self.profile_id,
            clinic_name: self.clinic.as_ref().map(|c| c.clinic_name.clone()),
            fingerprints: self
                .clinic
                .as_ref()
                .map(|c| c.clinic_keys.iter().map(|k| k.kid.clone()).collect())
                .unwrap_or_default(),
            incomplete: self.clinic.is_none(),
            approval_requested: self.approval.is_some(),
            clinic_approved: approved,
            approval_status: if accepted {
                Some(crate::portal_approval::ApprovalState::Accepted)
            } else {
                self.approval.as_ref().map(|a| a.state())
            },
            approval_reason: if accepted {
                None
            } else {
                self.approval.as_ref().and_then(|a| a.reason)
            },
            approval_request_limit_reached: !accepted
                && self.approval_history.len() + usize::from(self.approval.is_some())
                    >= crate::portal_approval::MAX_APPROVAL_REQUESTS,
            // By this device's clock here; a status check uses the portal's
            // when it can (#131). One rule for both.
            approval_can_restart: crate::portal_approval::can_restart(self, crate::now_ms() / 1000),
            device_key_id: self.keys.device_key_id(),
            device_fingerprint: hex(&B64
                .decode(self.keys.device_key_id())
                .expect("generated device id")),
        }
    }

    /// Fixed route, including any deployment prefix. Never accepts a URL from
    /// the response, a PDF or a manifest.
    pub fn endpoint(&self) -> Result<Url, LinkError> {
        Url::parse(&format!("{}/api/mycarlos/link", self.portal_base))
            .map_err(|_| LinkError::InvalidPortal)
    }

    pub fn request(&self, code: &str, now: u64) -> Result<LinkRequest, LinkError> {
        let code = normalize_code(code)?;
        let (x, ed) = self.keys.public();
        // Fields are in JCS order. These objects contain only strings and
        // bounded integer seconds; serde emits their canonical UTF-8 encoding.
        #[derive(Serialize)]
        struct Body<'a> {
            code: &'a str,
            device_name: &'a str,
            ed25519_public_key: String,
            link_id: &'a str,
            x25519_public_key: String,
        }
        let body = Zeroizing::new(
            serde_json::to_vec(&Body {
                code: &code[8..],
                device_name: &self.device_name,
                ed25519_public_key: B64.encode(ed),
                link_id: &code[..8],
                x25519_public_key: B64.encode(x),
            })
            .map_err(|_| LinkError::InvalidCode)?,
        );
        let endpoint = self.endpoint()?;
        let request_hash = hex(&Sha256::digest(frame(&[
            b"POST",
            endpoint.path().as_bytes(),
            b"",
            &body,
        ])));
        #[derive(Serialize)]
        struct Claims<'a> {
            aud: &'a str,
            exp: u64,
            iat: u64,
            iss: &'a str,
            jti: Uuid,
            kid: String,
            request_hash: String,
        }
        if now > 9_007_199_254_740_000 {
            return Err(LinkError::InvalidResponse);
        }
        let payload = serde_json::to_vec(&Claims {
            aud: "carlos-patient-portal-device-link",
            exp: now + 60,
            iat: now,
            iss: "mycarlos",
            jti: Uuid::new_v4(),
            kid: self.keys.device_key_id(),
            request_hash,
        })
        .map_err(|_| LinkError::InvalidResponse)?;
        let signature = SigningKey::from_bytes(&self.keys.ed25519).sign(&payload);
        Ok(LinkRequest {
            endpoint,
            body,
            assertion: format!(
                "{}.{}",
                B64.encode(payload),
                B64.encode(signature.to_bytes())
            ),
        })
    }
}

/// Not serializable or Debug: a one-use code must never enter IPC output or logs.
pub struct LinkRequest {
    pub endpoint: Url,
    pub body: Zeroizing<Vec<u8>>,
    pub assertion: String,
}

pub fn normalize_portal(input: &str) -> Result<String, LinkError> {
    if input.len() > MAX_PORTAL_UTF8_BYTES || input.trim() != input || input.contains('\\') {
        return Err(LinkError::InvalidPortal);
    }
    let url = Url::parse(input).map_err(|_| LinkError::InvalidPortal)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(LinkError::InvalidPortal);
    }
    let canonical = url.as_str().trim_end_matches('/').to_owned();
    if canonical.len() > MAX_PORTAL_UTF8_BYTES {
        return Err(LinkError::InvalidPortal);
    }
    Ok(canonical)
}

pub fn normalize_code(input: &str) -> Result<Zeroizing<String>, LinkError> {
    if input.len() > 80 || !input.is_ascii() {
        return Err(LinkError::InvalidCode);
    }
    let result = Zeroizing::new(
        input
            .chars()
            .filter(|c| !matches!(c, ' ' | '-'))
            .map(|c| match c.to_ascii_uppercase() {
                'O' => '0',
                'I' | 'L' => '1',
                other => other,
            })
            .collect::<String>(),
    );
    if result.len() != 18 || !result.chars().all(|c| CODE_ALPHABET.contains(c)) {
        return Err(LinkError::InvalidCode);
    }
    Ok(result)
}

fn bounded_label(input: &str, max: usize) -> bool {
    !input.is_empty()
        && input.trim() == input
        && input.chars().count() <= max
        && !input.chars().any(char::is_control)
}

fn opaque_id(input: &str) -> bool {
    !input.is_empty()
        && input.len() <= 64
        && input
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

pub fn frame(parts: &[&[u8]]) -> Vec<u8> {
    let mut result = Vec::new();
    for part in parts {
        result.extend_from_slice(&(part.len() as u64).to_be_bytes());
        result.extend_from_slice(part);
    }
    result
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Typed structs reject repeated recognized members and unknown fields, including
/// key entries. No untyped JSON value can silently discard duplicate members.
#[cfg(any(feature = "portal-linking", test))]
pub fn parse_response(bytes: &[u8], expected_device: &str) -> Result<LinkedClinic, LinkError> {
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(LinkError::InvalidResponse);
    }
    let clinic: LinkedClinic =
        serde_json::from_slice(bytes).map_err(|_| LinkError::InvalidResponse)?;
    clinic.validate_initial(expected_device)?;
    Ok(clinic)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, VerifyingKey};

    fn vectors() -> serde_json::Value {
        serde_json::from_str(include_str!("../tests/fixtures/delivery-contract.json")).unwrap()
    }

    #[test]
    fn portal_link_shared_code_vectors_and_strict_addresses() {
        let v = vectors();
        for case in v["portal"]["link_code_display_examples"]
            .as_array()
            .unwrap()
        {
            let result = normalize_code(case["typed"].as_str().unwrap());
            if case.get("expect").is_some() {
                assert!(result.is_err());
            } else {
                assert_eq!(
                    result.unwrap().as_str(),
                    format!(
                        "{}{}",
                        case["link_id"].as_str().unwrap(),
                        case["code"].as_str().unwrap()
                    )
                );
            }
        }
        for bad in [
            "http://fake.example",
            "https://user@fake.example",
            "https://fake.example?code=FAKE",
            "https://fake.example#FAKE",
            " https://fake.example",
            "https://fake.example\\evil",
        ] {
            assert_eq!(normalize_portal(bad), Err(LinkError::InvalidPortal));
        }
        assert_eq!(
            normalize_portal("https://fake.example/patient/"),
            Ok("https://fake.example/patient".to_owned())
        );
    }

    #[test]
    fn portal_link_unicode_expansion_respects_the_stored_canonical_bound() {
        let base = "https://fake.example/";
        let allowed = (1024 - base.len()) / 6;
        let padding = "x".repeat(1024 - base.len() - allowed * 6);
        let near = format!("{base}{}{padding}", "é".repeat(allowed));
        let canonical = normalize_portal(&near).unwrap();
        assert_eq!(
            canonical,
            format!("{base}{}{padding}", "%C3%A9".repeat(allowed))
        );
        assert_eq!(canonical.len(), 1024);
        assert_eq!(normalize_portal(&canonical).unwrap(), canonical);
        let one_over = format!("{near}x");
        assert!(one_over.len() <= 1024);
        assert_eq!(normalize_portal(&one_over), Err(LinkError::InvalidPortal));
        let expanded = format!("{base}{}", "é".repeat(allowed + 1));
        assert!(
            expanded.len() <= 1024,
            "the raw input passes its separate byte bound"
        );
        assert_eq!(normalize_portal(&expanded), Err(LinkError::InvalidPortal));
        assert!(StoredLink::pending(&expanded, "myCarlos", None, 1).is_err());
    }

    #[test]
    fn portal_link_stored_inventory_retains_revoked_status_through_roundtrip() {
        use p256::ecdsa::SigningKey as ClinicSigningKey;
        let mut link = StoredLink::pending("https://fake.example", "myCarlos", None, 1).unwrap();
        let spki = ClinicSigningKey::from_slice(&[7; 32])
            .unwrap()
            .verifying_key()
            .to_public_key_der()
            .unwrap();
        link.clinic = Some(LinkedClinic {
            recipient_id: "FAKE_recipient".to_owned(),
            device_key_id: link.keys.device_key_id(),
            clinic_id: "FAKE_clinic".to_owned(),
            clinic_name: "FAKE Clinic".to_owned(),
            clinic_keys: vec![ClinicKey {
                kid: B64.encode(Sha256::digest(spki.as_bytes())),
                spki: B64.encode(spki.as_bytes()),
                status: KeyStatus::Revoked,
            }],
        });
        assert!(
            link.validate().is_ok(),
            "revocation must remain persistable"
        );
        let bytes = Zeroizing::new(serde_json::to_vec(&link).unwrap());
        let reopened: StoredLink = serde_json::from_slice(&bytes).unwrap();
        assert!(reopened.validate().is_ok());
        assert_eq!(
            reopened.clinic.as_ref().unwrap().clinic_keys[0].status,
            KeyStatus::Revoked
        );
        assert!(
            parse_response(
                &serde_json::to_vec(reopened.clinic.as_ref().unwrap()).unwrap(),
                &link.keys.device_key_id()
            )
            .is_err(),
            "a new link still needs an active key"
        );
    }

    #[test]
    fn portal_link_device_ids_match_shared_vectors_and_keys_are_per_link() {
        let v = vectors();
        for name in ["device", "device_link_b", "other_device", "new_device"] {
            let key = &v["keys"][name];
            let keys = PrivateKeys {
                x25519: Sha256::digest(key["x25519_seed_text"].as_str().unwrap().as_bytes()).into(),
                ed25519: Sha256::digest(key["ed25519_seed_text"].as_str().unwrap().as_bytes())
                    .into(),
            };
            assert_eq!(keys.device_key_id(), key["device_key_id"].as_str().unwrap());
            let (x, ed) = keys.public();
            assert_eq!(B64.encode(x), key["x25519_public_key"].as_str().unwrap());
            assert_eq!(B64.encode(ed), key["ed25519_public_key"].as_str().unwrap());
        }
        let first = PrivateKeys::generate();
        let second = PrivateKeys::generate();
        assert_ne!(first.device_key_id(), second.device_key_id());
    }

    #[test]
    fn portal_link_request_proves_possession_and_binds_the_prefixed_route() {
        let link = StoredLink::pending(
            "https://fake.example/patient",
            "myCarlos on Windows",
            None,
            1,
        )
        .unwrap();
        let request = link.request("FAKE0001-FAKE7-Q2M4K", 1_700_000_000).unwrap();
        assert_eq!(request.endpoint.path(), "/patient/api/mycarlos/link");
        let (payload, signature) = request.assertion.split_once('.').unwrap();
        let bytes = B64.decode(payload).unwrap();
        let signature = Signature::from_slice(&B64.decode(signature).unwrap()).unwrap();
        let (_, public) = link.keys.public();
        VerifyingKey::from_bytes(&public)
            .unwrap()
            .verify_strict(&bytes, &signature)
            .unwrap();
        let claims: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(claims["aud"], "carlos-patient-portal-device-link");
        assert_eq!(
            claims["exp"].as_u64().unwrap() - claims["iat"].as_u64().unwrap(),
            60
        );
        assert_eq!(
            claims["request_hash"],
            hex(&Sha256::digest(frame(&[
                b"POST",
                b"/patient/api/mycarlos/link",
                b"",
                &request.body
            ])))
        );
        assert_ne!(
            claims["request_hash"],
            hex(&Sha256::digest(frame(&[
                b"POST",
                b"/api/mycarlos/link",
                b"",
                &request.body
            ])))
        );
        let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["code"], "FAKE7Q2M4K");
        assert_eq!(body["link_id"], "FAKE0001");
        assert_eq!(body.as_object().unwrap().len(), 5);
    }

    #[test]
    fn portal_link_response_requires_a_canonical_active_p256_inventory() {
        use p256::ecdsa::SigningKey as ClinicSigningKey;
        let device = PrivateKeys::generate().device_key_id();
        let signing = ClinicSigningKey::from_slice(&[7; 32]).unwrap();
        let spki = signing.verifying_key().to_public_key_der().unwrap();
        let kid = B64.encode(Sha256::digest(spki.as_bytes()));
        let clinic = LinkedClinic {
            recipient_id: "FAKE_recipient".to_owned(),
            device_key_id: device.clone(),
            clinic_id: "FAKE_clinic".to_owned(),
            clinic_name: "FAKE Clinic".to_owned(),
            clinic_keys: vec![ClinicKey {
                kid: kid.clone(),
                spki: B64.encode(spki.as_bytes()),
                status: KeyStatus::Active,
            }],
        };
        let bytes = serde_json::to_vec(&clinic).unwrap();
        assert!(parse_response(&bytes, &device).is_ok());
        assert!(parse_response(&bytes, "FAKE_other_device").is_err());
        let mut wrong = clinic.clone();
        wrong.clinic_keys[0].kid = "FAKE_wrong_kid".to_owned();
        assert!(parse_response(&serde_json::to_vec(&wrong).unwrap(), &device).is_err());
        let mut revoked = clinic.clone();
        revoked.clinic_keys[0].status = KeyStatus::Revoked;
        assert!(parse_response(&serde_json::to_vec(&revoked).unwrap(), &device).is_err());
        let mut repeated = clinic.clone();
        repeated.clinic_keys.push(repeated.clinic_keys[0].clone());
        assert!(parse_response(&serde_json::to_vec(&repeated).unwrap(), &device).is_err());
        let duplicate = String::from_utf8(bytes.clone()).unwrap().replacen(
            "{",
            "{\"recipient_id\":\"FAKE_attack\",",
            1,
        );
        assert!(parse_response(duplicate.as_bytes(), &device).is_err());
        assert!(parse_response(&vec![b' '; MAX_RESPONSE_BYTES + 1], &device).is_err());
    }

    #[test]
    fn portal_link_summary_does_not_expose_private_keys_or_recipient() {
        let pending = StoredLink::pending("https://fake.example", "myCarlos", None, 1).unwrap();
        let summary = serde_json::to_value(pending.summary()).unwrap();
        assert!(summary.get("keys").is_none());
        assert!(summary.get("recipientId").is_none());
        assert!(summary.get("clinic").is_none());
        assert_eq!(summary["incomplete"], true);
    }
}

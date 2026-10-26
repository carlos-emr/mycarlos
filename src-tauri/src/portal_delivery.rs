//! Frozen delivery-v1 package checks. Untrusted wire values never grant custody.
//! PDF verification and durable filing are separate mandatory steps in the vault.

use crate::portal_link::{frame, ClinicKey, KeyStatus, StoredLink};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine as _};
use p256::{
    ecdsa::{signature::Verifier, Signature, VerifyingKey},
    pkcs8::DecodePublicKey,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

pub const MAX_SEALED: usize = 20 * 1024 * 1024;
const MAX_COMPACT: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    UnsupportedVersion,
    HashMismatch,
    WrongRecipient,
    WrongDevice,
    DecryptFailed,
    BadPackage,
    BadManifest,
    WrongClinic,
    UnknownClinicKey,
    RevokedClinicKey,
    BadSignature,
    IdMismatch,
    DocumentHashMismatch,
    Expired,
    Replayed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Suite {
    pub kem_id: u16,
    pub kdf_id: u16,
    pub aead_id: u16,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Outer {
    pub v: u8,
    pub suite: Suite,
    pub delivery_id: String,
    pub recipient_id: String,
    pub device_key_id: String,
    pub size: u64,
    pub ciphertext_sha256: String,
    pub created_at: u64,
    pub expires_at: u64,
}
impl Outer {
    pub fn validate(&self) -> Result<(), Refusal> {
        if self.v != 1
            || self.suite
                != (Suite {
                    kem_id: 32,
                    kdf_id: 1,
                    aead_id: 3,
                })
        {
            return Err(Refusal::UnsupportedVersion);
        }
        if !uuid4(&self.delivery_id)
            || !opaque(&self.recipient_id)
            || !key_id(&self.device_key_id)
            || !hash(&self.ciphertext_sha256)
            || !(49..=MAX_SEALED as u64).contains(&self.size)
            || self.created_at >= self.expires_at
            || self.expires_at - self.created_at > 604800
            || self.expires_at > 9_007_199_254_740_991
        {
            return Err(Refusal::BadPackage);
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Patient {
    pub name: String,
    pub birth_date: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub title: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub service_date: String,
    pub media_type: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub v: u8,
    pub typ: String,
    pub delivery_id: String,
    pub recipient_id: String,
    pub device_key_id: String,
    pub clinic_id: String,
    pub clinic_name: String,
    pub provider_name: String,
    pub patient: Patient,
    pub document: Document,
    pub created_at: u64,
    pub expires_at: u64,
    pub kid: String,
}

pub struct Opened {
    pub manifest: Manifest,
    pub manifest_compact: String,
    pub pdf: Zeroizing<Vec<u8>>,
}

/// Exact input signature; never reserialize attacker-controlled claims to verify.
pub fn signed_payload(compact: &str, keys: &[ClinicKey], limit: usize) -> Result<Vec<u8>, Refusal> {
    verify_compact(compact, keys, limit, true)
}

/// Validate retained historical evidence without granting current trust.
pub(crate) fn retained_payload(
    compact: &str,
    keys: &[ClinicKey],
    limit: usize,
) -> Result<Vec<u8>, Refusal> {
    verify_compact(compact, keys, limit, false)
}

fn verify_compact(
    compact: &str,
    keys: &[ClinicKey],
    limit: usize,
    require_active: bool,
) -> Result<Vec<u8>, Refusal> {
    let (payload, signature) = split_compact(compact, limit)?;
    #[derive(Deserialize)]
    struct Kid {
        kid: String,
    }
    // The full caller-specific struct subsequently rejects all unknown and duplicate fields.
    let kid = serde_json::from_slice::<Kid>(&payload)
        .map_err(|_| Refusal::BadManifest)?
        .kid;
    let key = keys
        .iter()
        .find(|key| key.kid == kid)
        .ok_or(Refusal::UnknownClinicKey)?;
    if require_active && key.status == KeyStatus::Revoked {
        return Err(Refusal::RevokedClinicKey);
    }
    let der = decode(&key.spki).ok_or(Refusal::BadSignature)?;
    let key = VerifyingKey::from_public_key_der(&der).map_err(|_| Refusal::BadSignature)?;
    let signature = Signature::from_slice(&signature).map_err(|_| Refusal::BadSignature)?;
    key.verify(&payload, &signature)
        .map_err(|_| Refusal::BadSignature)?;
    Ok(payload)
}

#[cfg(feature = "portal-linking")]
pub fn open(
    outer: &Outer,
    sealed: &[u8],
    link: &StoredLink,
    other_keys: &[String],
    now: u64,
) -> Result<Opened, Refusal> {
    outer.validate()?;
    if sealed.len() as u64 != outer.size || sha256(sealed) != outer.ciphertext_sha256 {
        return Err(Refusal::HashMismatch);
    }
    let clinic = link.clinic.as_ref().ok_or(Refusal::WrongRecipient)?;
    if outer.recipient_id != clinic.recipient_id {
        return Err(Refusal::WrongRecipient);
    }
    if outer.device_key_id != link.keys.device_key_id() {
        return Err(Refusal::WrongDevice);
    }
    let aad = frame(&[
        outer.delivery_id.as_bytes(),
        outer.recipient_id.as_bytes(),
        outer.device_key_id.as_bytes(),
    ]);
    let plain = link
        .keys
        .open_seal(sealed, &aad)
        .map_err(|_| Refusal::DecryptFailed)?;
    let parts = unframe(&plain)?;
    if parts[0] != b"mycarlos-delivery/1" {
        return Err(if parts[0].starts_with(b"mycarlos-delivery/") {
            Refusal::UnsupportedVersion
        } else {
            Refusal::BadPackage
        });
    }
    if !(3..=4).contains(&parts.len()) {
        return Err(Refusal::BadPackage);
    }
    let compact = std::str::from_utf8(parts[1]).map_err(|_| Refusal::BadManifest)?;
    let (payload, _) = split_compact(compact, MAX_COMPACT)?;
    let manifest: Manifest = serde_json::from_slice(&payload).map_err(|_| Refusal::BadManifest)?;
    if manifest.v != 1
        || manifest.typ != "mycarlos-delivery-manifest"
        || !uuid4(&manifest.delivery_id)
        || !opaque(&manifest.recipient_id)
        || !key_id(&manifest.device_key_id)
        || !key_id(&manifest.kid)
        || !label(&manifest.clinic_id, 128)
        || !label(&manifest.clinic_name, 240)
        || !label(&manifest.provider_name, 240)
        || !label(&manifest.patient.name, 240)
        || !date(&manifest.patient.birth_date)
        || !date(&manifest.document.service_date)
        || !label(&manifest.document.title, 240)
        || !label(&manifest.document.kind, 64)
        || manifest.document.media_type != "application/pdf"
        || !hash(&manifest.document.sha256)
        || manifest.document.size > MAX_SEALED as u64
        || manifest.created_at >= manifest.expires_at
        || manifest.expires_at - manifest.created_at > 604800
        || manifest.expires_at > 9_007_199_254_740_991
    {
        return Err(Refusal::BadManifest);
    }
    if !clinic.clinic_keys.iter().any(|k| k.kid == manifest.kid)
        && other_keys.contains(&manifest.kid)
    {
        return Err(Refusal::WrongClinic);
    }
    if manifest.clinic_id != clinic.clinic_id {
        return Err(Refusal::WrongClinic);
    }
    signed_payload(compact, &clinic.clinic_keys, MAX_COMPACT)?;
    if manifest.delivery_id != outer.delivery_id
        || manifest.recipient_id != outer.recipient_id
        || manifest.device_key_id != outer.device_key_id
    {
        return Err(Refusal::IdMismatch);
    }
    if parts[2].len() as u64 != manifest.document.size
        || sha256(parts[2]) != manifest.document.sha256
    {
        return Err(Refusal::DocumentHashMismatch);
    }
    if now > manifest.expires_at.saturating_add(86400) {
        return Err(Refusal::Expired);
    }
    Ok(Opened {
        manifest,
        manifest_compact: compact.to_owned(),
        pdf: Zeroizing::new(parts[2].to_vec()),
    })
}

fn unframe(mut bytes: &[u8]) -> Result<Vec<&[u8]>, Refusal> {
    let mut parts = Vec::new();
    while !bytes.is_empty() {
        if parts.len() == 4 || bytes.len() < 8 {
            return Err(Refusal::BadPackage);
        }
        let length = u64::from_be_bytes(bytes[..8].try_into().map_err(|_| Refusal::BadPackage)?);
        bytes = &bytes[8..];
        let length = usize::try_from(length).map_err(|_| Refusal::BadPackage)?;
        if length > bytes.len() {
            return Err(Refusal::BadPackage);
        }
        parts.push(&bytes[..length]);
        bytes = &bytes[length..];
    }
    if parts.is_empty() {
        return Err(Refusal::BadPackage);
    }
    Ok(parts)
}
pub fn split_compact(compact: &str, limit: usize) -> Result<(Vec<u8>, Vec<u8>), Refusal> {
    if compact.len() > limit {
        return Err(Refusal::BadManifest);
    }
    let (payload, signature) = compact.split_once('.').ok_or(Refusal::BadManifest)?;
    let payload = decode(payload).ok_or(Refusal::BadManifest)?;
    let signature = decode(signature)
        .filter(|s| s.len() == 64)
        .ok_or(Refusal::BadManifest)?;
    Ok((payload, signature))
}
pub fn decode(s: &str) -> Option<Vec<u8>> {
    let bytes = B64.decode(s).ok()?;
    (B64.encode(&bytes) == s).then_some(bytes)
}
pub fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub fn hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn opaque(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
pub fn key_id(s: &str) -> bool {
    s.len() == 43 && decode(s).is_some_and(|b| b.len() == 32)
}
pub fn uuid4(s: &str) -> bool {
    Uuid::parse_str(s).is_ok_and(|u| u.get_version_num() == 4 && u.to_string() == s)
}
fn label(s: &str, max: usize) -> bool {
    !s.is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control)
}
fn date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10
        || !b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
    {
        return false;
    }
    let (Ok(y), Ok(m), Ok(d)) = (
        s[..4].parse::<u32>(),
        s[5..7].parse::<u32>(),
        s[8..].parse::<u32>(),
    ) else {
        return false;
    };
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => 0,
    };
    y > 0 && d > 0 && d <= days
}

#[cfg(all(test, feature = "portal-linking"))]
pub(crate) mod tests {
    use super::*;
    use crate::portal_link::{LinkedClinic, PrivateKeys};
    use serde_json::{json, Value};
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/delivery-contract.json")).unwrap()
    }
    pub(crate) fn fixture_link(x: &Value) -> StoredLink {
        let seed = |name: &str| {
            Sha256::digest(x["keys"]["device"][name].as_str().unwrap().as_bytes()).to_vec()
        };
        let keys: PrivateKeys = serde_json::from_value(
            json!({"x25519":seed("x25519_seed_text"),"ed25519":seed("ed25519_seed_text")}),
        )
        .unwrap();
        let mut linked = x["receiver"]["links"][0].clone();
        let key_values = linked["clinic_keys"].as_array_mut().unwrap();
        for key in key_values.iter_mut() {
            key.as_object_mut().unwrap().remove("clinic_id");
        }
        let clinic = LinkedClinic {
            recipient_id: linked["recipient_id"].as_str().unwrap().into(),
            device_key_id: keys.device_key_id(),
            clinic_id: linked["clinic_id"].as_str().unwrap().into(),
            clinic_name: "FAKE Demo Clinic".into(),
            clinic_keys: serde_json::from_value(linked["clinic_keys"].clone()).unwrap(),
        };
        StoredLink {
            id: Uuid::new_v4(),
            portal_base: "https://portal.example.test/prefix".into(),
            device_name: "myCarlos on Windows".into(),
            profile_id: None,
            created_at_ms: 1,
            keys,
            clinic: Some(clinic),
            approval: None,
            approval_history: Vec::new(),
        }
    }
    #[test]
    fn should_match_every_unchanged_shared_package_vector() {
        let x = fixture();
        let link = fixture_link(&x);
        let other = vec![x["keys"]["clinic_b"]["kid"].as_str().unwrap().into()];
        for case in x["packages"]["accept"]
            .as_array()
            .unwrap()
            .iter()
            .chain(x["packages"]["refuse"].as_array().unwrap())
        {
            let outer: Outer = serde_json::from_value(case["outer"].clone()).unwrap();
            let sealed = decode(case["blob"].as_str().unwrap()).unwrap();
            let result = open(
                &outer,
                &sealed,
                &link,
                &other,
                case["now"].as_u64().unwrap(),
            );
            let result = result.and_then(|_| {
                match x["receiver"]["filed"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|seen| seen["delivery_id"] == outer.delivery_id)
                {
                    Some(seen) if seen["ciphertext_sha256"] != outer.ciphertext_sha256 => {
                        Err(Refusal::Replayed)
                    }
                    Some(_) => Ok("already_filed"),
                    None => Ok("file"),
                }
            });
            let actual = match result {
                Ok(s) => s.into(),
                Err(reason) => serde_json::to_value(reason)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned(),
            };
            assert_eq!(actual, case["expect"].as_str().unwrap(), "{}", case["name"]);
        }
    }
    #[test]
    fn should_match_per_link_history_anchor_vectors() {
        let x = fixture();
        for expected in x["vault_head_link_examples"].as_array().unwrap() {
            let mut values = x.clone();
            values["keys"]["device"] = x["keys"][expected["keys"].as_str().unwrap()].clone();
            let link = fixture_link(&values);
            let head = head_bytes(expected["head"].as_str().unwrap()).unwrap();
            assert_eq!(
                link.keys.anchor(&head).unwrap(),
                expected["vault_head_link"]
            );
        }
    }
    #[test]
    fn should_open_rfc9180_a2_1_sequence_zero_with_library() {
        use hpke::{
            aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256, Deserializable, Kem,
            OpModeR,
        };
        type K = X25519HkdfSha256;
        let x = fixture();
        let f = &x["hpke_rfc9180_a2_1"];
        let bytes = |s: &Value| {
            let s = s.as_str().unwrap();
            (0..s.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
                .collect::<Vec<_>>()
        };
        let (sk, _) = K::derive_keypair(&bytes(&f["ikmR"]));
        let enc = <K as Kem>::EncappedKey::from_bytes(&bytes(&f["enc"])).unwrap();
        let mut context = hpke::setup_receiver::<ChaCha20Poly1305, HkdfSha256, K>(
            &OpModeR::Base,
            &sk,
            &enc,
            &bytes(&f["info"]),
        )
        .unwrap();
        let e = &f["encryptions"][0];
        assert_eq!(
            context.open(&bytes(&e["ct"]), &bytes(&e["aad"])).unwrap(),
            bytes(&e["pt"])
        );
    }
    #[test]
    fn should_reject_oversized_trailing_frames_and_invalid_dates_without_panicking() {
        assert_eq!(unframe(&u64::MAX.to_be_bytes()), Err(Refusal::BadPackage));
        assert_eq!(
            unframe(&frame(&[
                b"magic",
                b"manifest",
                b"pdf",
                b"padding",
                b"extra"
            ])),
            Err(Refusal::BadPackage)
        );
        for invalid in [
            "2025-02-29",
            "2026-13-01",
            "2026-00-01",
            "2026-01-00",
            "aéçé-01",
        ] {
            assert!(!date(invalid));
        }
        assert!(date("2024-02-29"));
    }
}

/// Retained inside the encrypted record, outside the history chain. The signed
/// receipt anchors the filing entry's head; it cannot be included in that head.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Custody {
    pub link_id: Uuid,
    pub outer: Outer,
    pub manifest: Manifest,
    pub manifest_compact: String,
    pub pdf_document_id: String,
    pub pdf_version: u32,
    pub checked_at_ms: u64,
    pub anchor_head: String,
    pub receipt: String,
    pub receipt_outcome: Option<ReceiptOutcome>,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptOutcome {
    PickedUp,
    Gone,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub aud: String,
    pub ciphertext_sha256: String,
    pub delivery_id: String,
    pub device_key_id: String,
    pub document_sha256: String,
    pub jti: Uuid,
    pub picked_up_at: u64,
    pub recipient_id: String,
    pub typ: String,
    pub vault_head_link: String,
}
impl Receipt {
    pub fn new(outer: &Outer, manifest: &Manifest, anchor: String, now: u64) -> Self {
        Self {
            aud: "carlos-delivery-receipt".into(),
            ciphertext_sha256: outer.ciphertext_sha256.clone(),
            delivery_id: outer.delivery_id.clone(),
            device_key_id: outer.device_key_id.clone(),
            document_sha256: manifest.document.sha256.clone(),
            jti: Uuid::new_v4(),
            picked_up_at: now,
            recipient_id: outer.recipient_id.clone(),
            typ: "mycarlos-delivery-receipt".into(),
            vault_head_link: anchor,
        }
    }
}
pub fn head_bytes(head: &str) -> Option<[u8; 32]> {
    if !hash(head) {
        return None;
    }
    let mut bytes = [0; 32];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&head[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(bytes)
}

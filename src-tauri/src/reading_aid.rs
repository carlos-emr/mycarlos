//! Reading-aid receiver (carlos-portal delivery contract, "Reading aids: a paired second
//! delivery"). An aid is a clinician-approved AI summary delivered as its own copy, bound to
//! the original it reads. Like `portal_delivery`, this module only checks untrusted wire
//! values: parsing grants no custody, filing and receipts are the vault's separate steps.
//! Every rule here mirrors the contract's device steps and its public vectors.

use crate::portal_delivery::{
    hash, key_id, label, opaque, sha256, signed_payload, split_compact, unframe, uuid4, Outer,
    Receipt, Refusal, MAX_COMPACT,
};
use crate::portal_link::{frame, StoredLink};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use zeroize::Zeroizing;

pub const KIND: &str = "reading-aid/1";
pub const MEDIA_TYPE: &str = "application/vnd.carlos.reading-aid+json";
const MAGIC: &[u8] = b"mycarlos-reading-aid/1";
const MANIFEST_TYPE: &str = "mycarlos-reading-aid-manifest";
const AID_TYPE: &str = "mycarlos-reading-aid";
const REVIEWER_ROLES: [&str; 1] = ["clinician"];
/// The canonical JSON inside the seal.
pub const MAX_JSON: usize = 64 * 1024;
/// The sealed copy: refused from the listing's outer size, before any download.
pub const MAX_SEALED_AID: u64 = 1024 * 1024;
const MAX_POINTS: usize = 50;
const MAX_EVIDENCE: usize = 5;
const SKEW_SECONDS: u64 = 86_400;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Patient {
    pub name: String,
    pub birth_date: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pair {
    pub pair_id: String,
    pub original_delivery_id: String,
    pub original_document_sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AidClaim {
    pub media_type: String,
    pub size: u64,
    pub sha256: String,
    pub language: String,
    pub summary_version: String,
    pub generated_at: u64,
    pub revised_at: Option<u64>,
    pub notice_version: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Approval {
    pub id: String,
    pub reviewer_role: String,
    pub reviewed_at: u64,
}
/// The aid's signed manifest: exactly the contract's fifteen claims.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AidManifest {
    pub v: u8,
    pub typ: String,
    pub delivery_id: String,
    pub recipient_id: String,
    pub device_key_id: String,
    pub clinic_id: String,
    pub clinic_name: String,
    pub provider_name: String,
    pub patient: Patient,
    pub pair: Pair,
    pub reading_aid: AidClaim,
    pub approval: Approval,
    pub created_at: u64,
    pub expires_at: u64,
    pub kid: String,
}

/// What the device already holds for this link, by delivery ID.
#[derive(Default)]
pub struct PairState {
    /// Filed originals: sealed-copy hash, PDF hash and lifetime.
    pub filed_originals: HashMap<String, FiledOriginal>,
    /// Filed aids: the ciphertext hash each was filed with.
    pub filed_aids: HashMap<String, String>,
    /// Aids kept while their original is not filed: the ciphertext hash each was kept with.
    pub waiting_aids: HashMap<String, String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FiledOriginal {
    pub ciphertext_sha256: String,
    pub document_sha256: String,
    pub created_at: u64,
    pub expires_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Verified and its original is filed with the same PDF and lifetime.
    File,
    /// The same copy was filed before: send the kept receipt again, file nothing.
    AlreadyFiled,
    /// Verified, but its original is not filed yet: keep the copy, send no receipt.
    WaitingForOriginal,
}

pub struct OpenedAid {
    pub manifest: AidManifest,
    pub manifest_compact: String,
    pub json: Zeroizing<Vec<u8>>,
    pub outcome: Outcome,
}

/// From the portal's listing alone, before any download: the outer record is well formed and
/// a reading aid is not larger than its limit.
pub fn check_listing(outer: &Outer) -> Result<(), Refusal> {
    outer.validate()?;
    if outer.kind.as_deref() == Some(KIND) && outer.size > MAX_SEALED_AID {
        return Err(Refusal::TooLarge);
    }
    Ok(())
}

/// Every device that implements this module names the kind in its pickup (`?accept=`): the
/// handshake is a format-version guard, not an old-device rule.
pub fn accepted_kinds() -> [&'static str; 1] {
    [KIND]
}

pub fn open(
    outer: &Outer,
    sealed: &[u8],
    link: &StoredLink,
    other_keys: &[String],
    state: &PairState,
    now: u64,
) -> Result<OpenedAid, Refusal> {
    check_listing(outer)?;
    if outer.kind.as_deref() != Some(KIND) {
        return Err(Refusal::BadPackage);
    }
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
    if parts[0] != MAGIC {
        return Err(if parts[0].starts_with(b"mycarlos-reading-aid/") {
            Refusal::UnsupportedVersion
        } else {
            // An original's label (or anything else) under a reading-aid kind.
            Refusal::BadPackage
        });
    }
    if !(3..=4).contains(&parts.len()) {
        return Err(Refusal::BadPackage);
    }
    let compact = std::str::from_utf8(parts[1]).map_err(|_| Refusal::BadManifest)?;
    let (payload, _) = split_compact(compact, MAX_COMPACT)?;
    let manifest: AidManifest =
        serde_json::from_slice(&payload).map_err(|_| Refusal::BadManifest)?;
    manifest_shape(&manifest)?;
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
    let json = parts[2];
    if json.len() as u64 != manifest.reading_aid.size || sha256(json) != manifest.reading_aid.sha256
    {
        return Err(Refusal::ReadingAidHashMismatch);
    }
    reading_aid_shape(json, &manifest.reading_aid)?;
    if now > manifest.expires_at.saturating_add(SKEW_SECONDS) {
        return Err(Refusal::Expired);
    }
    let id = &manifest.delivery_id;
    // One delivery-ID space: an aid never reuses a filed original's ID.
    if state.filed_originals.contains_key(id) {
        return Err(Refusal::Replayed);
    }
    if let Some(filed) = state.filed_aids.get(id) {
        return if filed == &outer.ciphertext_sha256 {
            Ok(opened(manifest, compact, json, Outcome::AlreadyFiled))
        } else {
            Err(Refusal::Replayed)
        };
    }
    if state
        .waiting_aids
        .get(id)
        .is_some_and(|kept| kept != &outer.ciphertext_sha256)
    {
        return Err(Refusal::Replayed);
    }
    let Some(original) = state
        .filed_originals
        .get(&manifest.pair.original_delivery_id)
    else {
        return Ok(opened(manifest, compact, json, Outcome::WaitingForOriginal));
    };
    if original.document_sha256 != manifest.pair.original_document_sha256
        || (original.created_at, original.expires_at) != (manifest.created_at, manifest.expires_at)
    {
        return Err(Refusal::PairMismatch);
    }
    Ok(opened(manifest, compact, json, Outcome::File))
}

fn opened(manifest: AidManifest, compact: &str, json: &[u8], outcome: Outcome) -> OpenedAid {
    OpenedAid {
        manifest,
        manifest_compact: compact.to_owned(),
        json: Zeroizing::new(json.to_vec()),
        outcome,
    }
}

/// The receipt of a filed aid: the delivery contract's receipt, with `document_sha256` the
/// hash of the aid's JSON.
pub fn receipt(outer: &Outer, manifest: &AidManifest, anchor: String, now: u64) -> Receipt {
    Receipt {
        aud: "carlos-delivery-receipt".into(),
        ciphertext_sha256: outer.ciphertext_sha256.clone(),
        delivery_id: outer.delivery_id.clone(),
        device_key_id: outer.device_key_id.clone(),
        document_sha256: manifest.reading_aid.sha256.clone(),
        jti: uuid::Uuid::new_v4(),
        picked_up_at: now,
        recipient_id: outer.recipient_id.clone(),
        typ: "mycarlos-delivery-receipt".into(),
        vault_head_link: anchor,
    }
}

fn manifest_shape(m: &AidManifest) -> Result<(), Refusal> {
    let language_tag = language_primary(&m.reading_aid.language);
    let notice_tag = notice_language(&m.reading_aid.notice_version);
    let ok = m.v == 1
        && m.typ == MANIFEST_TYPE
        && uuid4(&m.delivery_id)
        && opaque(&m.recipient_id)
        && key_id(&m.device_key_id)
        && key_id(&m.kid)
        && label(&m.clinic_id, 128)
        && label(&m.clinic_name, 240)
        && label(&m.provider_name, 240)
        && label(&m.patient.name, 240)
        && date_ok(&m.patient.birth_date)
        && uuid4(&m.pair.pair_id)
        && uuid4(&m.pair.original_delivery_id)
        && m.pair.original_delivery_id != m.delivery_id
        && hash(&m.pair.original_document_sha256)
        && m.reading_aid.media_type == MEDIA_TYPE
        && (1..=MAX_JSON as u64).contains(&m.reading_aid.size)
        && hash(&m.reading_aid.sha256)
        && language_tag.is_some()
        && hash(&m.reading_aid.summary_version)
        && m.reading_aid.generated_at <= 9_007_199_254_740_991
        && m.reading_aid
            .revised_at
            .is_none_or(|t| t <= 9_007_199_254_740_991)
        && notice_tag.is_some()
        && notice_tag == language_tag
        && label(&m.approval.id, 64)
        && REVIEWER_ROLES.contains(&m.approval.reviewer_role.as_str())
        && m.approval.reviewed_at <= 9_007_199_254_740_991
        && m.created_at < m.expires_at
        && m.expires_at - m.created_at <= 604_800
        && m.expires_at <= 9_007_199_254_740_991;
    if ok {
        Ok(())
    } else {
        Err(Refusal::BadManifest)
    }
}

fn date_ok(s: &str) -> bool {
    // The same YYYY-MM-DD rule the original's manifest applies to a birth date.
    crate::portal_delivery::service_date(s) && !s.is_empty()
}

/// `[a-z]{2,3}(-[A-Za-z0-9]{2,8})*`; returns the primary subtag.
fn language_primary(language: &str) -> Option<&str> {
    let mut parts = language.split('-');
    let primary = parts.next()?;
    let primary_ok =
        (2..=3).contains(&primary.len()) && primary.bytes().all(|b| b.is_ascii_lowercase());
    let rest_ok =
        parts.all(|p| (2..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric()));
    (primary_ok && rest_ok).then_some(primary)
}

/// A notice version is `<scheme>-<language>-<n>`; the language tag is read by that shape.
fn notice_language(version: &str) -> Option<&str> {
    let (rest, number) = version.rsplit_once('-')?;
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (scheme, tag) = rest.rsplit_once('-')?;
    let scheme_ok = !scheme.is_empty()
        && scheme
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    ((2..=3).contains(&tag.len()) && tag.bytes().all(|b| b.is_ascii_lowercase()) && scheme_ok)
        .then_some(tag)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Notice {
    version: String,
    heading: String,
    body: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Point {
    text: String,
    evidence: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AidJson {
    v: u8,
    #[serde(rename = "typ")]
    kind: String,
    language: String,
    notice: Notice,
    overview: String,
    points: Vec<Point>,
}

/// The aid's JSON: canonical (RFC 8785) bytes, the documented shape, the manifest's language
/// and notice version.
fn reading_aid_shape(bytes: &[u8], claim: &AidClaim) -> Result<(), Refusal> {
    let bad = || Refusal::BadReadingAid;
    let text = std::str::from_utf8(bytes).map_err(|_| bad())?;
    let aid: AidJson = serde_json::from_str(text).map_err(|_| bad())?;
    let value: Value = serde_json::from_str(text).map_err(|_| bad())?;
    // Re-serializing the parsed value must give the received bytes exactly: this refuses
    // whitespace, key disorder, duplicate keys and any non-canonical escape.
    if canonical(&value).ok_or_else(bad)? != bytes {
        return Err(bad());
    }
    let present = |s: &str| !s.trim().is_empty();
    if aid.v != 1
        || aid.kind != AID_TYPE
        || aid.language != claim.language
        || aid.notice.version != claim.notice_version
        || !present(&aid.notice.heading)
        || !present(&aid.notice.body)
        || !present(&aid.overview)
        || !(1..=MAX_POINTS).contains(&aid.points.len())
    {
        return Err(bad());
    }
    for point in &aid.points {
        if !present(&point.text)
            || !(1..=MAX_EVIDENCE).contains(&point.evidence.len())
            || !point.evidence.iter().all(|e| present(e))
        {
            return Err(bad());
        }
    }
    Ok(())
}

/// RFC 8785 for objects, arrays, strings, null and non-negative integers: keys by UTF-16 code
/// units; strings with JSON's required escapes only. Anything else (floats, negatives, bools)
/// is not part of the aid and returns None.
fn canonical(value: &Value) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    write(&mut out, value)?;
    Some(out)
}
fn write(out: &mut Vec<u8>, value: &Value) -> Option<()> {
    match value {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Number(n) => out.extend_from_slice(
            n.as_u64()
                .filter(|&n| n <= 9_007_199_254_740_991)?
                .to_string()
                .as_bytes(),
        ),
        Value::String(s) => out.extend_from_slice(serde_json::to_string(s).ok()?.as_bytes()),
        Value::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write(out, item)?;
            }
            out.push(b']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push(b'{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                out.extend_from_slice(serde_json::to_string(key).ok()?.as_bytes());
                out.push(b':');
                write(out, &map[key])?;
            }
            out.push(b'}');
        }
        Value::Bool(_) => return None,
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::portal_delivery::{decode, kind_ok, tests::fixture_link};
    use serde_json::json;

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../tests/fixtures/reading-aid-pair-contract.json"
        ))
        .unwrap()
    }
    fn delivery_fixture() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/delivery-contract.json")).unwrap()
    }
    fn state(x: &Value) -> PairState {
        let originals = x["receiver"]["filed_originals"].as_object().unwrap();
        PairState {
            filed_originals: originals
                .iter()
                .map(|(id, v)| {
                    (
                        id.clone(),
                        FiledOriginal {
                            ciphertext_sha256: v["ciphertext_sha256"].as_str().unwrap().into(),
                            document_sha256: v["document_sha256"].as_str().unwrap().into(),
                            created_at: v["created_at"].as_u64().unwrap(),
                            expires_at: v["expires_at"].as_u64().unwrap(),
                        },
                    )
                })
                .collect(),
            filed_aids: strings(&x["receiver"]["filed_aids"]),
            waiting_aids: strings(&x["receiver"]["waiting_aids"]),
        }
    }
    fn strings(v: &Value) -> HashMap<String, String> {
        v.as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().into()))
            .collect()
    }
    fn run(vector: &Value, x: &Value) -> Result<OpenedAid, Refusal> {
        let link = fixture_link(x);
        let outer: Outer = serde_json::from_value(vector["outer"].clone()).unwrap();
        let sealed = decode(vector["blob"].as_str().unwrap()).unwrap();
        open(
            &outer,
            &sealed,
            &link,
            &[],
            &state(x),
            vector["now"].as_u64().unwrap(),
        )
    }
    fn code(refusal: Refusal) -> String {
        serde_json::to_value(refusal)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn should_give_every_accept_vector_exactly_the_listed_outcome() {
        let x = fixture();
        for vector in x["packages"]["accept"].as_array().unwrap() {
            let name = vector["name"].as_str().unwrap();
            let opened = run(vector, &x).unwrap_or_else(|e| panic!("{name}: refused {}", code(e)));
            let expected = match vector["expect"].as_str().unwrap() {
                "file" => Outcome::File,
                "already_filed" => Outcome::AlreadyFiled,
                "waiting_for_original" => Outcome::WaitingForOriginal,
                other => panic!("unknown outcome {other}"),
            };
            assert_eq!(opened.outcome, expected, "{name}");
            assert_eq!(
                opened.manifest.delivery_id, vector["outer"]["delivery_id"],
                "{name}"
            );
        }
    }

    #[test]
    fn should_refuse_every_refuse_vector_with_exactly_the_listed_code() {
        let x = fixture();
        let mut seen = 0;
        for vector in x["packages"]["refuse"].as_array().unwrap() {
            let name = vector["name"].as_str().unwrap();
            let expect = vector["expect"].as_str().unwrap();
            if vector.get("receiver").and_then(Value::as_str) == Some("v1_original_receiver") {
                // An older receiver that only knows originals: the copy carries no kind there.
                let link = fixture_link(&x);
                let mut outer = vector["outer"].clone();
                outer.as_object_mut().unwrap().remove("kind");
                let outer: Outer = serde_json::from_value(outer).unwrap();
                let sealed = decode(vector["blob"].as_str().unwrap()).unwrap();
                let refused = crate::portal_delivery::open(
                    &outer,
                    &sealed,
                    &link,
                    &[],
                    vector["now"].as_u64().unwrap(),
                )
                .err()
                .unwrap_or_else(|| panic!("{name}: a v1 receiver opened an aid"));
                assert_eq!(code(refused), expect, "{name}");
                seen += 1;
                continue;
            }
            // too_large is decided from the listing, before any download or hash.
            let outer: Outer = serde_json::from_value(vector["outer"].clone()).unwrap();
            let refused = check_listing(&outer)
                .err()
                .or_else(|| run(vector, &x).err())
                .unwrap_or_else(|| panic!("{name}: opened but expected {expect}"));
            assert_eq!(code(refused), expect, "{name}");
            seen += 1;
        }
        assert!(seen >= 27, "every refuse vector ran: {seen}");
    }

    #[test]
    fn should_refuse_an_oversize_aid_from_the_listing_alone() {
        let x = fixture();
        let vector = x["packages"]["refuse"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["expect"] == "too_large")
            .unwrap();
        let outer: Outer = serde_json::from_value(vector["outer"].clone()).unwrap();
        assert_eq!(check_listing(&outer), Err(Refusal::TooLarge));
        assert_eq!(outer.size, MAX_SEALED_AID + 1);
        let mut at_limit = outer.clone();
        at_limit.size = MAX_SEALED_AID;
        assert_eq!(check_listing(&at_limit), Ok(()));
    }

    #[test]
    fn should_file_a_waiting_aid_once_its_original_is_filed_and_refuse_a_changed_one() {
        let x = fixture();
        let waiting = x["packages"]["accept"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["expect"] == "waiting_for_original")
            .unwrap();
        let opened = run(waiting, &x).unwrap();
        let pair = opened.manifest.pair.clone();
        let mut filed = state(&x);
        filed.filed_originals.insert(
            pair.original_delivery_id.clone(),
            FiledOriginal {
                ciphertext_sha256: sha256(b"FAKE the late original's copy"),
                document_sha256: pair.original_document_sha256.clone(),
                created_at: opened.manifest.created_at,
                expires_at: opened.manifest.expires_at,
            },
        );
        let link = fixture_link(&x);
        let outer: Outer = serde_json::from_value(waiting["outer"].clone()).unwrap();
        let sealed = decode(waiting["blob"].as_str().unwrap()).unwrap();
        let now = waiting["now"].as_u64().unwrap();
        assert_eq!(
            open(&outer, &sealed, &link, &[], &filed, now)
                .unwrap()
                .outcome,
            Outcome::File
        );
        let original = filed
            .filed_originals
            .get_mut(&pair.original_delivery_id)
            .unwrap();
        original.document_sha256 = sha256(b"FAKE an edited PDF");
        assert_eq!(
            open(&outer, &sealed, &link, &[], &filed, now).err(),
            Some(Refusal::PairMismatch)
        );
        let original = filed
            .filed_originals
            .get_mut(&pair.original_delivery_id)
            .unwrap();
        original.document_sha256 = pair.original_document_sha256.clone();
        original.expires_at += 1;
        assert_eq!(
            open(&outer, &sealed, &link, &[], &filed, now).err(),
            Some(Refusal::PairMismatch)
        );
    }

    #[test]
    fn should_keep_the_same_copy_waiting_and_refuse_a_different_one_under_its_id() {
        let x = fixture();
        let waiting = x["packages"]["accept"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["expect"] == "waiting_for_original")
            .unwrap();
        let mut s = state(&x);
        assert_eq!(s.waiting_aids.len(), 1);
        let link = fixture_link(&x);
        let mut outer: Outer = serde_json::from_value(waiting["outer"].clone()).unwrap();
        let sealed = decode(waiting["blob"].as_str().unwrap()).unwrap();
        let now = waiting["now"].as_u64().unwrap();
        assert!(open(&outer, &sealed, &link, &[], &s, now).is_ok());
        // The same ID kept with another hash: the copy now offered is a different one.
        for kept in s.waiting_aids.values_mut() {
            *kept = sha256(b"FAKE an earlier copy");
        }
        assert_eq!(
            open(&outer, &sealed, &link, &[], &s, now).err(),
            Some(Refusal::Replayed)
        );
        outer.kind = None;
        assert_eq!(
            open(&outer, &sealed, &link, &[], &s, now).err(),
            Some(Refusal::BadPackage)
        );
    }

    #[test]
    fn should_never_open_an_aid_as_an_original_nor_an_original_as_an_aid() {
        let x = fixture();
        let link = fixture_link(&x);
        let aid = &x["packages"]["accept"][0];
        let outer: Outer = serde_json::from_value(aid["outer"].clone()).unwrap();
        let sealed = decode(aid["blob"].as_str().unwrap()).unwrap();
        assert_eq!(
            crate::portal_delivery::open(&outer, &sealed, &link, &[], aid["now"].as_u64().unwrap())
                .err(),
            Some(Refusal::BadPackage)
        );
        let original = &x["original_package"];
        let outer: Outer = serde_json::from_value(original["outer"].clone()).unwrap();
        assert!(outer.kind.is_none());
        let sealed = decode(original["blob"].as_str().unwrap()).unwrap();
        let now = x["packages"]["accept"][0]["now"].as_u64().unwrap();
        assert!(crate::portal_delivery::open(&outer, &sealed, &link, &[], now).is_ok());
        // Under a reading-aid kind, an original's plaintext is not an aid.
        let mut mislabelled = outer.clone();
        mislabelled.kind = Some(KIND.into());
        assert_eq!(
            open(
                &mislabelled,
                &sealed,
                &link,
                &[],
                &PairState::default(),
                now
            )
            .err(),
            Some(Refusal::BadPackage)
        );
    }

    #[test]
    fn should_match_the_contract_fixtures_original_with_the_deliverys_own() {
        let (a, b) = (fixture(), delivery_fixture());
        assert_eq!(a["sender"]["original_manifest"], b["sender"]["manifest"]);
        assert_eq!(a["keys"]["device"], b["keys"]["device"]);
        assert_eq!(a["keys"]["clinic_a"], b["keys"]["clinic_a"]);
    }

    #[test]
    fn should_bound_the_kind_exactly_as_the_contract_does() {
        let x = fixture();
        for example in x["portal"]["kind"].as_array().unwrap() {
            let ok = example["ok"].as_bool().unwrap();
            match example["kind"].as_str() {
                Some(kind) => assert_eq!(kind_ok(kind), ok, "{kind:?}"),
                None => assert!(!ok, "a non-string kind is never valid"),
            }
        }
        assert_eq!(accepted_kinds(), [KIND]);
    }

    #[test]
    fn should_write_canonical_json_with_sorted_keys_and_minimal_escapes() {
        let value = json!({"b": [1, null, "x"], "a\u{e9}": "tab\there \"q\" \\ \u{1} \u{e9}\u{4e2d}", "A": 0});
        assert_eq!(
            String::from_utf8(canonical(&value).unwrap()).unwrap(),
            "{\"A\":0,\"a\u{e9}\":\"tab\\there \\\"q\\\" \\\\ \\u0001 \u{e9}\u{4e2d}\",\"b\":[1,null,\"x\"]}"
        );
        for bad in [json!(1.5), json!(-1), json!(true), json!({"k": false})] {
            assert!(canonical(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn should_read_the_notice_language_by_shape() {
        assert_eq!(notice_language("carlos-5537-en-1"), Some("en"));
        assert_eq!(notice_language("clinic-notice-fr-12"), Some("fr"));
        for bad in [
            "carlos-5537-1",
            "carlos-5537-en",
            "CARLOS-5537-en-1",
            "en-1",
            "",
            "carlos-5537-english-1",
        ] {
            assert_eq!(notice_language(bad), None, "{bad}");
        }
        assert_eq!(language_primary("pt-BR"), Some("pt"));
        assert_eq!(language_primary("EN"), None);
    }

    #[test]
    fn should_make_a_receipt_over_the_aids_json_hash() {
        let x = fixture();
        let opened = run(&x["packages"]["accept"][0], &x).unwrap();
        let outer: Outer =
            serde_json::from_value(x["packages"]["accept"][0]["outer"].clone()).unwrap();
        let receipt = receipt(&outer, &opened.manifest, "a".repeat(64), 1_792_454_400);
        assert_eq!(receipt.document_sha256, x["sender"]["reading_aid_sha256"]);
        assert_eq!(receipt.document_sha256, sha256(&opened.json));
        assert_eq!(receipt.delivery_id, outer.delivery_id);
        assert_eq!(receipt.ciphertext_sha256, outer.ciphertext_sha256);
    }
}

//! The pure check of a clinic's key inventory and its replacement proofs (carlos-portal
//! `docs/architecture/mycarlos-link-lifecycle-v1.md`, the frozen spec; the reference is the
//! portal's `clinic_key_proofs.py`).
//!
//! **Inert.** Nothing in the app calls this yet: no refresh, no storage, no format change, no UI.
//! It is the first step (M1) of the clinic-key refresh design, built so that the rules can be
//! reviewed and tested against the portal's shared fixture before anything depends on them.
//! What a caller does with an accepted inventory (store it, show a notice, re-check documents)
//! is a separate decision.
//!
//! What it checks, in the portal's order, for one clinic:
//! - the inventory has 1 to 16 distinct key ids (`InvalidKeyList`);
//! - **immutable history** against the inventory the device already holds: no key may disappear
//!   (`KeyMissing`), none may change its key or its replacement proof (`KeyChanged`), and a
//!   revoked key never becomes active again (`KeyRevoked`);
//! - every key is a canonical P-256 SubjectPublicKeyInfo named by the SHA-256 of those bytes;
//! - every replacement proof is an ECDSA P-256/SHA-256 signature, 64 bytes `r || s`, by the
//!   predecessor over a framed statement; either S value is accepted; the pair of fields comes
//!   together; a key replaces one listed key and a key has at most one successor; there is no
//!   cycle;
//! - when the device already holds an inventory: a **revoked key authorises no new edge**, and
//!   every new signed edge reaches back to a key the device held as active or to a new
//!   **unsigned root**. Unsigned roots are accepted and returned, so that whoever consumes the
//!   result can tell the patient plainly; there is no acknowledgement gate.
//!
//! The functions never change their input and never keep a signature in a different form.
//!
//! Of the portal's shared fixture this module's tests run `proof_vectors` (10) and
//! `inventory_vectors` (20). They do not run `recovery_vectors` (21: the lost-answer recovery
//! request's assertion and the portal's answers to it) or `state_cases` (7: what a device must do
//! with an accepted result: persist it atomically, keep notices and history, cancel on a lock):
//! those describe request signing and the apply step, which belong to the refresh client and the
//! storage step, not to this pure check. The tests assert the four counts, so that a new fixture
//! with more vectors is noticed instead of silently skipped.

// Nothing calls this yet (see above); the tests call all of it.
#![allow(dead_code)]

use std::collections::{HashMap, HashSet};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine as _};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use p256::pkcs8::{DecodePublicKey, EncodePublicKey};
use sha2::{Digest, Sha256};

use crate::portal_link::{frame, KeyStatus};

/// The most keys one inventory may list (and so at most 15 replacement edges).
pub(crate) const MAX_KEYS: usize = 16;

/// Domain separation of the statement a predecessor signs, with its terminating zero byte.
pub(crate) const REPLACEMENT_DOMAIN: &[u8] = b"mycarlos-clinic-key-replacement-v1\x00";

/// One key as the inventory states it, with the proof that it replaces another, if it does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct KeyMaterial {
    pub(crate) kid: String,
    /// Canonical DER SubjectPublicKeyInfo.
    pub(crate) spki: Vec<u8>,
    pub(crate) status: KeyStatus,
    pub(crate) replaces_kid: Option<String>,
    /// As supplied: only an exactly 64-byte value can verify. Kept as supplied, never rewritten.
    pub(crate) replacement_signature: Option<Vec<u8>>,
}

impl KeyMaterial {
    /// A key from its wire spelling: `spki` and the signature are canonical unpadded base64url
    /// (padding, another alphabet, or a value that does not re-encode to the same text is
    /// refused). Whether the pair of replacement fields is complete is checked with the
    /// inventory, not here.
    pub(crate) fn from_wire(
        kid: &str,
        spki: &str,
        status: KeyStatus,
        replaces_kid: Option<&str>,
        replacement_signature: Option<&str>,
    ) -> Result<Self, InventoryError> {
        Ok(Self {
            kid: kid.to_owned(),
            spki: canonical_b64(spki)?,
            status,
            replaces_kid: replaces_kid.map(str::to_owned),
            replacement_signature: replacement_signature.map(canonical_b64).transpose()?,
        })
    }
}

fn canonical_b64(text: &str) -> Result<Vec<u8>, InventoryError> {
    let raw = B64.decode(text).map_err(|_| InventoryError::Invalid)?;
    if B64.encode(&raw) != text {
        return Err(InventoryError::Invalid);
    }
    Ok(raw)
}

/// Why an inventory or a proof is refused. The codes are the portal publisher's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InventoryError {
    /// No keys, more than 16, or one key id listed twice.
    InvalidKeyList,
    /// A key the device already holds is not listed.
    KeyMissing,
    /// A held key's bytes or replacement proof differ.
    KeyChanged,
    /// A revoked key is listed as active.
    KeyRevoked,
    /// A malformed key, key id, proof or graph.
    Invalid,
    /// A new link needs at least one active key (`validate_bootstrap` only).
    NoActiveKey,
}

/// What an accepted inventory asks a caller to tell the patient. Derived from how it differs from
/// the inventory the device held: the shared fixture's `required_notice`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Notice {
    /// Nothing changed that needs saying (also: the first inventory, at linking).
    None,
    /// New keys, each vouched for by a key the device trusted. It does **not** mean that nothing
    /// was revoked: an answer that adds a key and revokes the old one (the usual rotation) is
    /// `Signed`. Read the keys' statuses for revocations; this says only that something new, and
    /// vouched for, arrived.
    Signed,
    /// A new key that no key vouched for: said plainly, never silently.
    Unsigned,
    /// Keys were revoked and no key was added.
    Revocation,
}

/// An accepted inventory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Accepted {
    /// The key ids that are new and vouched for by nobody, in the inventory's order.
    pub(crate) unsigned_roots: Vec<String>,
    pub(crate) notice: Notice,
}

/// The bytes a predecessor signs to vouch for `successor`:
/// `"mycarlos-clinic-key-replacement-v1" 0x00 || frame(clinic_id, predecessor_kid, new_kid,
/// canonical_DER(new_spki))`, each part as UTF-8 or DER with its length as eight bytes big endian.
pub(crate) fn replacement_statement(
    clinic_id: &str,
    predecessor_kid: &str,
    successor: &KeyMaterial,
) -> Vec<u8> {
    let mut statement = REPLACEMENT_DOMAIN.to_vec();
    statement.extend(frame(&[
        clinic_id.as_bytes(),
        predecessor_kid.as_bytes(),
        successor.kid.as_bytes(),
        &successor.spki,
    ]));
    statement
}

/// The key if it is a P-256 SubjectPublicKeyInfo in its one canonical (uncompressed) encoding
/// and the key id is the SHA-256 of exactly those bytes.
fn checked_public_key(key: &KeyMaterial) -> Result<VerifyingKey, InventoryError> {
    let public =
        p256::PublicKey::from_public_key_der(&key.spki).map_err(|_| InventoryError::Invalid)?;
    let canonical = public
        .to_public_key_der()
        .map_err(|_| InventoryError::Invalid)?;
    // As the portal's reference: the id is the hash of the CANONICAL bytes, and the stored bytes
    // must be those bytes. Hashing the canonical encoding (not the stored one) keeps the two
    // checks independent: the same key spelled another way under its canonical id is refused by
    // the second alone, which a test pins.
    if canonical.as_bytes() != key.spki.as_slice()
        || B64.encode(Sha256::digest(canonical.as_bytes())) != key.kid
    {
        return Err(InventoryError::Invalid);
    }
    Ok(VerifyingKey::from(&public))
}

/// `successor`'s proof that `predecessor` vouches for it, checked in `clinic_id`.
pub(crate) fn verify_replacement_proof(
    clinic_id: &str,
    predecessor: &KeyMaterial,
    successor: &KeyMaterial,
) -> Result<(), InventoryError> {
    let old_public = checked_public_key(predecessor)?;
    checked_public_key(successor)?;
    let (Some(replaces), Some(signature)) = (
        successor.replaces_kid.as_deref(),
        successor.replacement_signature.as_deref(),
    ) else {
        return Err(InventoryError::Invalid);
    };
    if replaces != predecessor.kid || signature.len() != 64 {
        return Err(InventoryError::Invalid);
    }
    // Standard ECDSA accepts both S representations; the spec says so. `normalize_s` is the same
    // check on the low-S form, so a high-S proof verifies and the supplied bytes stay as they are.
    let signature = Signature::from_slice(signature)
        .map_err(|_| InventoryError::Invalid)?
        .normalize_s();
    old_public
        .verify(
            &replacement_statement(clinic_id, &predecessor.kid, successor),
            &signature,
        )
        .map_err(|_| InventoryError::Invalid)
}

/// An inventory for a new link: the whole graph validates with no previous inventory, and at
/// least one key is active (the portal refuses a link without one).
pub(crate) fn validate_bootstrap(
    clinic_id: &str,
    incoming: &[KeyMaterial],
) -> Result<Accepted, InventoryError> {
    let accepted = validate_inventory(clinic_id, incoming, &[])?;
    if !incoming.iter().any(|key| key.status == KeyStatus::Active) {
        return Err(InventoryError::NoActiveKey);
    }
    Ok(accepted)
}

/// An inventory the portal answers for a link that already holds `previous` (empty: nothing is
/// held, as at linking). An all-revoked inventory is valid: a completed link may reach it.
pub(crate) fn validate_inventory(
    clinic_id: &str,
    incoming: &[KeyMaterial],
    previous: &[KeyMaterial],
) -> Result<Accepted, InventoryError> {
    if incoming.is_empty() || incoming.len() > MAX_KEYS {
        return Err(InventoryError::InvalidKeyList);
    }
    let listed: HashMap<&str, &KeyMaterial> =
        incoming.iter().map(|key| (key.kid.as_str(), key)).collect();
    let old: HashMap<&str, &KeyMaterial> =
        previous.iter().map(|key| (key.kid.as_str(), key)).collect();
    if listed.len() != incoming.len() {
        return Err(InventoryError::InvalidKeyList);
    }
    // Immutable history first: no proof can excuse a changed historical binding.
    if old.keys().any(|kid| !listed.contains_key(kid)) {
        return Err(InventoryError::KeyMissing);
    }
    for (kid, before) in &old {
        let after = listed[kid];
        if before.spki != after.spki
            || before.replaces_kid != after.replaces_kid
            || before.replacement_signature != after.replacement_signature
        {
            return Err(InventoryError::KeyChanged);
        }
        if before.status == KeyStatus::Revoked && after.status != KeyStatus::Revoked {
            return Err(InventoryError::KeyRevoked);
        }
    }
    // Every key, every proof, one successor per predecessor.
    let mut successors: HashSet<&str> = HashSet::new();
    for key in incoming {
        checked_public_key(key)?;
        if key.replaces_kid.is_some() != key.replacement_signature.is_some() {
            return Err(InventoryError::Invalid);
        }
        if let Some(replaces) = key.replaces_kid.as_deref() {
            let predecessor = *listed.get(replaces).ok_or(InventoryError::Invalid)?;
            if predecessor.kid == key.kid {
                return Err(InventoryError::Invalid);
            }
            verify_replacement_proof(clinic_id, predecessor, key)?;
            if !successors.insert(predecessor.kid.as_str()) {
                return Err(InventoryError::Invalid);
            }
        }
    }
    // No cycle: following predecessors from any key must end, within the 16-key bound.
    for key in incoming {
        let mut seen: HashSet<&str> = HashSet::new();
        let mut current = Some(key);
        while let Some(next) = current {
            if !seen.insert(next.kid.as_str()) {
                return Err(InventoryError::Invalid);
            }
            current = next
                .replaces_kid
                .as_deref()
                .and_then(|replaces| listed.get(replaces).copied());
        }
    }
    if old.is_empty() {
        return Ok(Accepted {
            unsigned_roots: Vec::new(),
            notice: Notice::None,
        });
    }
    let unsigned_roots: Vec<String> = incoming
        .iter()
        .filter(|key| !old.contains_key(key.kid.as_str()) && key.replaces_kid.is_none())
        .map(|key| key.kid.clone())
        .collect();
    for key in incoming {
        let Some(replaces) = key.replaces_kid.as_deref() else {
            continue;
        };
        if old.contains_key(key.kid.as_str()) {
            continue; // a held edge stays valid, even if its predecessor was revoked since
        }
        let predecessor = listed[replaces];
        // A key revoked before this answer vouches for nothing new.
        if old
            .get(predecessor.kid.as_str())
            .is_some_and(|held| held.status == KeyStatus::Revoked)
        {
            return Err(InventoryError::Invalid);
        }
        // Reach back to a key the device held as active, or to a new unsigned root.
        let mut current = predecessor;
        loop {
            if old
                .get(current.kid.as_str())
                .is_some_and(|held| held.status == KeyStatus::Active)
                || unsigned_roots.contains(&current.kid)
            {
                break;
            }
            let Some(next) = current.replaces_kid.as_deref() else {
                return Err(InventoryError::Invalid);
            };
            current = listed[next];
        }
    }
    let notice = if !unsigned_roots.is_empty() {
        Notice::Unsigned
    } else if incoming
        .iter()
        .any(|key| !old.contains_key(key.kid.as_str()))
    {
        Notice::Signed
    } else if incoming.iter().any(|key| {
        key.status == KeyStatus::Revoked
            && old
                .get(key.kid.as_str())
                .is_some_and(|held| held.status == KeyStatus::Active)
    }) {
        Notice::Revocation
    } else {
        Notice::None
    };
    Ok(Accepted {
        unsigned_roots,
        notice,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../tests/fixtures/link-lifecycle-v1.json");
    /// The portal's fixture at carlos-portal main `0cd0199f`, copied unchanged.
    const FIXTURE_SHA256: &str = "4a4ef7b6ae5e0531b1c377aeb5aee5c603c3919b6fce909a20a0f80e8e7b8879";

    fn fixture() -> serde_json::Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len() / 2)
            .map(|at| u8::from_str_radix(&text[at * 2..at * 2 + 2], 16).unwrap())
            .collect()
    }

    fn status(text: &str) -> KeyStatus {
        match text {
            "active" => KeyStatus::Active,
            "revoked" => KeyStatus::Revoked,
            other => panic!("status {other}"),
        }
    }

    /// A key entry of the fixture, through the wire constructor (so that its spelling is checked).
    fn material(entry: &serde_json::Value) -> Result<KeyMaterial, InventoryError> {
        KeyMaterial::from_wire(
            entry["kid"].as_str().unwrap(),
            entry["spki"].as_str().unwrap(),
            status(entry["status"].as_str().unwrap()),
            entry["replaces_kid"].as_str(),
            entry["replacement_signature"].as_str(),
        )
    }

    fn materials(list: &serde_json::Value) -> Vec<KeyMaterial> {
        list.as_array()
            .unwrap()
            .iter()
            .map(|entry| material(entry).unwrap())
            .collect()
    }

    #[test]
    fn the_fixture_is_the_portals_copied_unchanged() {
        assert_eq!(
            format!("{:x}", Sha256::digest(FIXTURE.as_bytes())),
            FIXTURE_SHA256
        );
        let fixture = fixture();
        // The sets this module runs, and the two it does not (see the module documentation).
        assert_eq!(fixture["proof_vectors"].as_array().unwrap().len(), 10);
        assert_eq!(fixture["inventory_vectors"].as_array().unwrap().len(), 20);
        assert_eq!(fixture["recovery_vectors"].as_array().unwrap().len(), 21);
        assert_eq!(fixture["state_cases"].as_array().unwrap().len(), 7);
        assert_eq!(fixture["constants"]["maximum_keys"], MAX_KEYS);
        assert_eq!(
            hex(fixture["constants"]["replacement_domain_hex"]
                .as_str()
                .unwrap()),
            REPLACEMENT_DOMAIN
        );
    }

    #[test]
    fn every_proof_vector_gives_the_fixtures_answer_and_its_statement() {
        let fixture = fixture();
        let vectors = fixture["proof_vectors"].as_array().unwrap();
        assert_eq!(vectors.len(), 10);
        for vector in vectors {
            let name = vector["name"].as_str().unwrap();
            let clinic = vector["clinic_id"].as_str().unwrap();
            let predecessor = KeyMaterial {
                kid: vector["replaces_kid"].as_str().unwrap().to_owned(),
                spki: canonical_b64(vector["predecessor_spki"].as_str().unwrap()).unwrap(),
                status: KeyStatus::Active,
                replaces_kid: None,
                replacement_signature: None,
            };
            // The padded spelling is refused while the key is being read, which is an answer too.
            let result = KeyMaterial::from_wire(
                vector["kid"].as_str().unwrap(),
                vector["spki"].as_str().unwrap(),
                KeyStatus::Active,
                vector["replaces_kid"].as_str(),
                vector["signature"].as_str(),
            )
            .and_then(|successor| {
                assert_eq!(
                    replacement_statement(clinic, &predecessor.kid, &successor),
                    hex(vector["statement_hex"].as_str().unwrap()),
                    "{name}: the statement bytes"
                );
                verify_replacement_proof(clinic, &predecessor, &successor)
            });
            assert_eq!(
                result.is_ok(),
                vector["expect_valid"].as_bool().unwrap(),
                "{name}: {result:?}"
            );
        }
    }

    /// Half the order of the P-256 group, rounded down: an S above it is the "high" form.
    const HALF_N: [u8; 32] = [
        0x7f, 0xff, 0xff, 0xff, 0x80, 0x00, 0x00, 0x00, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xde, 0x73, 0x7d, 0x56, 0xd3, 0x8b, 0xcf, 0x42, 0x79, 0xdc, 0xe5, 0x61, 0x7e, 0x31,
        0x92, 0xa8,
    ];

    #[test]
    fn high_and_low_s_proofs_are_what_they_say_and_both_verify() {
        let fixture = fixture();
        let vectors = fixture["proof_vectors"].as_array().unwrap();
        let by = |name: &str| {
            vectors
                .iter()
                .find(|vector| vector["name"] == name)
                .unwrap()
        };
        let s_of = |name: &str| {
            let raw = canonical_b64(by(name)["signature"].as_str().unwrap()).unwrap();
            assert_eq!(raw.len(), 64, "{name}");
            let s: [u8; 32] = raw[32..].try_into().unwrap();
            s
        };
        // Big-endian byte strings of equal length compare as the numbers they are.
        assert!(
            s_of("valid-low-s") < HALF_N,
            "the low-S vector's S is below n/2"
        );
        assert!(
            s_of("valid-high-s") > HALF_N,
            "the high-S vector's S is above n/2"
        );
        // The same key and statement, two S values, both valid (the pipeline test above runs
        // each through `verify_replacement_proof`; `expect_valid` is true for both).
        assert!(by("valid-low-s")["expect_valid"].as_bool().unwrap());
        assert!(by("valid-high-s")["expect_valid"].as_bool().unwrap());
        // MUTANT_RESULT_PLACEHOLDER
    }

    #[test]
    fn every_inventory_vector_gives_the_fixtures_answer_and_notice() {
        let fixture = fixture();
        let clinic = "clinic-a";
        let vectors = fixture["inventory_vectors"].as_array().unwrap();
        assert_eq!(vectors.len(), 20);
        for vector in vectors {
            let name = vector["name"].as_str().unwrap();
            let incoming = materials(&vector["incoming"]);
            let previous = materials(&vector["previous"]);
            let result = if vector["mode"] == "bootstrap" {
                validate_bootstrap(clinic, &incoming)
            } else {
                validate_inventory(clinic, &incoming, &previous)
            };
            assert_eq!(
                result.is_ok(),
                vector["expect_accept"].as_bool().unwrap(),
                "{name}: {result:?}"
            );
            if let Ok(accepted) = result {
                let expected = match vector["required_notice"].as_str() {
                    None => Notice::None,
                    Some("signed") => Notice::Signed,
                    Some("unsigned") => Notice::Unsigned,
                    Some("revocation") => Notice::Revocation,
                    Some(other) => panic!("{name}: notice {other}"),
                };
                assert_eq!(accepted.notice, expected, "{name}");
            }
        }
    }

    #[test]
    fn each_refusal_in_the_fixture_has_its_own_reason() {
        let fixture = fixture();
        let clinic = "clinic-a";
        let expected = [
            ("bootstrap-all-revoked", InventoryError::NoActiveKey),
            (
                "previously-revoked-cannot-authorize-new-edge",
                InventoryError::Invalid,
            ),
            (
                "revocation-replay-cannot-revive",
                InventoryError::KeyRevoked,
            ),
            ("omitted-historical-key", InventoryError::KeyMissing),
            (
                "valid-resigned-proof-cannot-replace-immutable-bytes",
                InventoryError::KeyChanged,
            ),
            ("fork-two-valid-successors", InventoryError::Invalid),
            ("cycle-valid-individual-signatures", InventoryError::Invalid),
            ("missing-predecessor", InventoryError::Invalid),
            ("invalid-proof-is-not-unsigned", InventoryError::Invalid),
            ("one-paired-field-missing", InventoryError::Invalid),
            ("seventeen-keys-over-limit", InventoryError::InvalidKeyList),
        ];
        for (name, reason) in expected {
            let vector = fixture["inventory_vectors"]
                .as_array()
                .unwrap()
                .iter()
                .find(|vector| vector["name"] == name)
                .unwrap_or_else(|| panic!("no vector {name}"));
            let incoming = materials(&vector["incoming"]);
            let previous = materials(&vector["previous"]);
            let result = if vector["mode"] == "bootstrap" {
                validate_bootstrap(clinic, &incoming)
            } else {
                validate_inventory(clinic, &incoming, &previous)
            };
            assert_eq!(result.unwrap_err(), reason, "{name}");
        }
    }

    #[test]
    fn unsigned_roots_are_returned_in_the_inventorys_order() {
        let fixture = fixture();
        let named = |name: &str| {
            fixture["inventory_vectors"]
                .as_array()
                .unwrap()
                .iter()
                .find(|vector| vector["name"] == name)
                .unwrap()
                .clone()
        };
        for (name, root) in [
            ("unsigned-replacement", "B"),
            ("offline-unsigned-root-then-signed-child", "B"),
        ] {
            let vector = named(name);
            let accepted = validate_inventory(
                "clinic-a",
                &materials(&vector["incoming"]),
                &materials(&vector["previous"]),
            )
            .unwrap();
            assert_eq!(
                accepted.unsigned_roots,
                vec![fixture["keys"][root]["kid"].as_str().unwrap().to_owned()],
                "{name}"
            );
        }
        // A vouched-for key is not an unsigned root, and a first inventory has none to report.
        let signed = named("signed-replacement");
        let accepted = validate_inventory(
            "clinic-a",
            &materials(&signed["incoming"]),
            &materials(&signed["previous"]),
        )
        .unwrap();
        assert!(accepted.unsigned_roots.is_empty());
        let first = named("bootstrap-historical-chain");
        assert!(
            validate_bootstrap("clinic-a", &materials(&first["incoming"]))
                .unwrap()
                .unsigned_roots
                .is_empty()
        );
    }

    #[test]
    fn a_wire_spelling_that_is_not_canonical_is_refused() {
        let fixture = fixture();
        let a = &fixture["keys"]["A"];
        let (kid, spki) = (a["kid"].as_str().unwrap(), a["spki"].as_str().unwrap());
        let ok = |spki: &str| KeyMaterial::from_wire(kid, spki, KeyStatus::Active, None, None);
        assert!(ok(spki).is_ok());
        assert!(ok(&format!("{spki}=")).is_err(), "padding");
        assert!(ok("not*base64").is_err(), "another alphabet");
        // A 91-byte value is 122 characters with four unused bits in the last one, which a
        // canonical spelling leaves zero: a last character with one of them set decodes to the
        // same bytes in some decoders, and is not this key's spelling.
        assert!(spki.ends_with(['A', 'Q', 'g', 'w']));
        let mut loose = spki.to_owned();
        loose.pop();
        loose.push('B');
        assert!(ok(&loose).is_err(), "unused bits set");
        // The same for a proof's signature (64 bytes, 86 characters).
        let signature = fixture["proof_vectors"][0]["signature"].as_str().unwrap();
        assert!(signature.ends_with(['A', 'Q', 'g', 'w']));
        let mut loose = signature.to_owned();
        loose.pop();
        loose.push('B');
        assert!(
            KeyMaterial::from_wire(kid, spki, KeyStatus::Active, Some(kid), Some(&loose)).is_err()
        );
    }

    #[test]
    fn a_key_in_another_spelling_or_under_another_name_is_refused() {
        let fixture = fixture();
        let a = &fixture["keys"]["A"];
        let b = &fixture["keys"]["B"];
        let key = |kid: &str, spki: &str| {
            KeyMaterial::from_wire(kid, spki, KeyStatus::Active, None, None).unwrap()
        };
        // Another key's id, and an id that is not the key's hash.
        let other_kid = key(b["kid"].as_str().unwrap(), a["spki"].as_str().unwrap());
        assert_eq!(
            validate_bootstrap("clinic-a", &[other_kid]),
            Err(InventoryError::Invalid)
        );
        let not_a_hash = key("FAKE-kid", a["spki"].as_str().unwrap());
        assert_eq!(
            validate_bootstrap("clinic-a", &[not_a_hash]),
            Err(InventoryError::Invalid)
        );
        // The same point written compressed, under the canonical key's own id: it loads, but the
        // stored bytes must be the canonical ones.
        let canonical = canonical_b64(a["spki"].as_str().unwrap()).unwrap();
        assert_eq!(canonical.len(), 91);
        let header = hex("3039301306072a8648ce3d020106082a8648ce3d030107032200");
        let mut x = canonical[27..59].to_vec();
        let y_odd = canonical[90] & 1 == 1;
        let mut compressed = header.clone();
        compressed.push(if y_odd { 3 } else { 2 });
        compressed.append(&mut x);
        assert!(p256::PublicKey::from_public_key_der(&compressed).is_ok());
        let spelled = KeyMaterial {
            kid: a["kid"].as_str().unwrap().to_owned(),
            spki: compressed,
            status: KeyStatus::Active,
            replaces_kid: None,
            replacement_signature: None,
        };
        assert_eq!(
            validate_bootstrap("clinic-a", &[spelled]),
            Err(InventoryError::Invalid)
        );
        // A real key of another curve, and a real key of another algorithm, each under the hash of
        // its own bytes (so that only the kind of key can refuse them): a P-384 point and an
        // Ed25519 key, both made with OpenSSL for this test.
        let p384 = hex(
            "3076301006072a8648ce3d020106052b8104002203620004707c1a42d8dbbf8db8b6dc493a1e9df19637abd8\
             35776ec31716d110fd145869bc5e31961be531af119e61925f54509a14590014c530657ecf4268f66de50461\
             a932205f3c97b2b36341b78103bf82393192da25d6fe7ec91315d16fcf313e5d",
        );
        let ed25519 =
            hex("302a300506032b6570032100c2f916dea4c805e469996d19cb6004722572e3f83964a809d315291d6666337c");
        for (name, spki) in [("P-384", p384), ("Ed25519", ed25519)] {
            let other = KeyMaterial {
                kid: B64.encode(Sha256::digest(&spki)),
                spki,
                status: KeyStatus::Active,
                replaces_kid: None,
                replacement_signature: None,
            };
            assert_eq!(
                validate_bootstrap("clinic-a", &[other]),
                Err(InventoryError::Invalid),
                "{name}"
            );
        }
        // Bytes that are no key at all.
        let garbage = KeyMaterial {
            kid: a["kid"].as_str().unwrap().to_owned(),
            spki: vec![0; 91],
            status: KeyStatus::Active,
            replaces_kid: None,
            replacement_signature: None,
        };
        assert_eq!(
            validate_bootstrap("clinic-a", &[garbage]),
            Err(InventoryError::Invalid)
        );
    }

    #[test]
    fn the_list_limits_and_duplicates_are_the_list_code() {
        let fixture = fixture();
        let a = material(&serde_json::json!({
            "kid": fixture["keys"]["A"]["kid"],
            "spki": fixture["keys"]["A"]["spki"],
            "status": "active",
        }))
        .unwrap();
        assert_eq!(
            validate_bootstrap("clinic-a", &[]),
            Err(InventoryError::InvalidKeyList)
        );
        assert_eq!(
            validate_bootstrap("clinic-a", &[a.clone(), a.clone()]),
            Err(InventoryError::InvalidKeyList)
        );
        assert!(validate_bootstrap("clinic-a", &[a]).is_ok());
        // Exactly sixteen is accepted (a fixture chain of sixteen keys and fifteen edges).
        let sixteen = fixture["inventory_vectors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|vector| vector["name"] == "sixteen-keys-fifteen-edges")
            .unwrap();
        assert_eq!(sixteen["incoming"].as_array().unwrap().len(), MAX_KEYS);
        assert!(validate_inventory(
            "clinic-a",
            &materials(&sixteen["incoming"]),
            &materials(&sixteen["previous"]),
        )
        .is_ok());
    }

    #[test]
    fn a_proof_is_for_one_clinic_and_one_statement_only() {
        let fixture = fixture();
        let incoming = materials(&fixture["inventory_vectors"][0]["incoming"]);
        assert!(validate_bootstrap("clinic-a", &incoming).is_ok());
        // The same inventory under another clinic's name: every proof was made for clinic-a.
        assert_eq!(
            validate_bootstrap("clinic-b", &incoming),
            Err(InventoryError::Invalid)
        );
        // A proof moved onto another key does not verify.
        let mut moved = incoming.clone();
        moved[2].replacement_signature = moved[1].replacement_signature.clone();
        assert_eq!(
            validate_bootstrap("clinic-a", &moved),
            Err(InventoryError::Invalid)
        );
    }

    #[test]
    fn the_input_is_never_changed() {
        let fixture = fixture();
        let vector = &fixture["inventory_vectors"][4];
        let incoming = materials(&vector["incoming"]);
        let previous = materials(&vector["previous"]);
        let (incoming_before, previous_before) = (incoming.clone(), previous.clone());
        validate_inventory("clinic-a", &incoming, &previous).unwrap();
        assert_eq!(incoming, incoming_before);
        assert_eq!(previous, previous_before);
    }
}

//! Carried clinic evidence (#360): what a record that arrived in a profile handover keeps of
//! the clinic delivery it was filed from, when the clinic link it was checked through is not in
//! this vault. See `portal_delivery::Carried` for what is kept and what never is.
//!
//! `delivery::valid_custody` needs the link (its keys, its clinic, the device's private keys)
//! and rejects a record whose link is missing, so carried evidence is a field of its own with
//! a validator of its own. This one needs no link: the clinic's keys are the snapshot the
//! source pinned, and the receipts are checked against the source device's public key.
//!
//! What it cannot check, and so does not claim: the receipt's anchor to the source vault's
//! history head (this vault has another chain, and the anchor needs the device's private key).
//! A receipt here proves that the source device acknowledged the delivery, nothing about this
//! vault. Whoever wrote the package could have invented the keys, so a valid record is
//! only "what the file says", never "verified by the clinic" and never stated as fact: only a link of this
//! vault to the same clinic, whose key list holds the signing key, reaches that
//! (`verified_clinic`).
use super::*;
use crate::portal_delivery::{self as wire, Receipt};
use crate::portal_link::{device_key_id_of, KeyStatus};

/// The receipt in `compact`, when its signature checks with the source device's signing key.
fn signed_receipt(compact: &str, ed25519: &[u8; 32]) -> Option<Receipt> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let (payload, signature) = wire::split_compact(compact, 4096).ok()?;
    let receipt = serde_json::from_slice::<Receipt>(&payload).ok()?;
    let key = VerifyingKey::from_bytes(ed25519).ok()?;
    let signature = Signature::from_slice(&signature).ok()?;
    key.verify(&payload, &signature).ok()?;
    Some(receipt)
}

/// The receipt fields that hold without the link: its type and audience, a version 4 id,
/// the time the delivery was checked, and an anchor in the form the source wrote (its value
/// belongs to the source vault's chain and is not checked here).
fn receipt_fits(receipt: &Receipt, checked_at_ms: u64, anchor_head: &str) -> bool {
    receipt.aud == "carlos-delivery-receipt"
        && receipt.typ == "mycarlos-delivery-receipt"
        && receipt.jti.get_version_num() == 4
        && receipt.picked_up_at == checked_at_ms / 1000
        && wire::head_bytes(anchor_head).is_some()
        && wire::hash(&receipt.vault_head_link)
}

/// How long after a delivery expired its check may still be dated (clock skew between the
/// clinic's server and the source device).
const CHECK_GRACE_MS: u64 = 24 * 60 * 60 * 1000;

/// The time a carried check is dated is the package's to choose, so it is held to the
/// delivery's own life: not before the clinic made it, not long after it expired.
fn checked_within(created_at: u64, expires_at: u64, checked_at_ms: u64) -> bool {
    checked_at_ms >= created_at.saturating_mul(1000)
        && checked_at_ms
            <= expires_at
                .saturating_mul(1000)
                .saturating_add(CHECK_GRACE_MS)
}

/// A carried record is checked again every time the manifest is read. It is a delivered
/// original of one clinic, with the original PDF, and carries nothing a filed delivery has:
/// the clinic's signed manifest under the snapshot's keys, the hash of the PDF, the source
/// device's keys and the receipts it signed all agree.
pub(super) fn valid_carried(record: &StoredRecord) -> bool {
    use serde_json::Value;
    let Some(carried) = &record.carried else {
        return true;
    };
    // A record is filed here or carried, never both: the new vault must not hold two
    // accounts of one delivery, and a carried record has no link to send a receipt through.
    if record.delivery.is_some() || record.reading_aid.is_some() {
        return false;
    }
    let Some(original) = &record.original_pdf else {
        return false;
    };
    let Some((x25519, ed25519)) = carried.device_keys() else {
        return false;
    };
    let device = device_key_id_of(&x25519, &ed25519);
    let clinic = &carried.clinic;
    if clinic.validate(&device).is_err() {
        return false;
    }
    let c = &carried.delivery;
    if c.outer.validate().is_err()
        || c.outer.kind.is_some()
        || c.outer.recipient_id != clinic.recipient_id
        || c.outer.device_key_id != device
        || c.manifest.clinic_id != clinic.clinic_id
        || c.manifest.delivery_id != c.outer.delivery_id
        || c.manifest.recipient_id != c.outer.recipient_id
        || c.manifest.device_key_id != c.outer.device_key_id
        || c.manifest.document.sha256 != original.sha256
        || c.manifest.document.size != original.plaintext_size
        || !wire::service_date(&c.manifest.document.service_date)
        || c.pdf_document_id.is_empty()
        || c.pdf_document_id.len() > 128
        || c.pdf_version == 0
    {
        return false;
    }
    // The clinic signed these exact bytes with a key the snapshot holds. A key that was
    // revoked since is no reason to refuse what it signed before: this is history.
    let Ok(payload) = wire::retained_payload(&c.manifest_compact, &clinic.clinic_keys, 16 * 1024)
    else {
        return false;
    };
    if serde_json::from_slice::<wire::Manifest>(&payload)
        .ok()
        .as_ref()
        != Some(&c.manifest)
    {
        return false;
    }
    if !checked_within(
        c.manifest.created_at,
        c.manifest.expires_at,
        c.checked_at_ms,
    ) {
        return false;
    }
    let Some(receipt) = signed_receipt(&c.receipt, &ed25519) else {
        return false;
    };
    if !receipt_fits(&receipt, c.checked_at_ms, &c.anchor_head)
        || receipt.delivery_id != c.outer.delivery_id
        || receipt.device_key_id != c.outer.device_key_id
        || receipt.recipient_id != c.outer.recipient_id
        || receipt.ciphertext_sha256 != c.outer.ciphertext_sha256
        || receipt.document_sha256 != original.sha256
    {
        return false;
    }
    let Some(a) = &carried.reading_aid else {
        return true;
    };
    if a.outer.validate().is_err()
        || a.outer.kind.as_deref() != Some("reading-aid/1")
        || a.outer.delivery_id == c.outer.delivery_id
        || a.outer.recipient_id != clinic.recipient_id
        || a.outer.device_key_id != device
        || a.json.is_empty()
        || a.json.len() > 64 * 1024
    {
        return false;
    }
    let Ok(payload) = wire::retained_payload(&a.manifest_compact, &clinic.clinic_keys, 16 * 1024)
    else {
        return false;
    };
    let Ok(m) = serde_json::from_slice::<Value>(&payload) else {
        return false;
    };
    let text = |path: &str| m.pointer(path).and_then(Value::as_str);
    if text("/delivery_id") != Some(a.outer.delivery_id.as_str())
        || text("/clinic_id") != Some(clinic.clinic_id.as_str())
        || text("/recipient_id") != Some(a.outer.recipient_id.as_str())
        || text("/device_key_id") != Some(a.outer.device_key_id.as_str())
        || text("/pair/original_delivery_id") != Some(c.outer.delivery_id.as_str())
        || text("/pair/original_document_sha256") != Some(original.sha256.as_str())
        || text("/reading_aid/sha256") != Some(wire::sha256(a.json.as_bytes()).as_str())
        || m.pointer("/reading_aid/size").and_then(Value::as_u64) != Some(a.json.len() as u64)
        || m.pointer("/created_at").and_then(Value::as_u64) != Some(c.manifest.created_at)
        || m.pointer("/expires_at").and_then(Value::as_u64) != Some(c.manifest.expires_at)
    {
        return false;
    }
    if !checked_within(
        c.manifest.created_at,
        c.manifest.expires_at,
        a.checked_at_ms,
    ) {
        return false;
    }
    let Some(receipt) = signed_receipt(&a.receipt, &ed25519) else {
        return false;
    };
    receipt_fits(&receipt, a.checked_at_ms, &a.anchor_head)
        && receipt.delivery_id == a.outer.delivery_id
        && receipt.device_key_id == a.outer.device_key_id
        && receipt.recipient_id == a.outer.recipient_id
        && receipt.ciphertext_sha256 == a.outer.ciphertext_sha256
        && receipt.document_sha256 == wire::sha256(a.json.as_bytes())
}

/// The name of a clinic this vault is linked to that holds the key a carried record's clinic
/// signed with, as an active key: the same clinic (its id), and the same key (a key id is the
/// hash of the key). This is the second of the three levels (#360, section 7); it needs a
/// link made on this device, and the carried snapshot alone never gives it.
pub(super) fn verified_clinic(record: &StoredRecord, links: &[StoredLink]) -> Option<String> {
    let carried = record.carried.as_ref()?;
    let kid = &carried.delivery.manifest.kid;
    // A link of the same clinic that lists the key as Revoked outweighs one that lists it Active.
    if clinic_view(record, links).is_some_and(|view| view.key_revoked) {
        return None;
    }
    links.iter().find_map(|link| {
        let clinic = link.clinic.as_ref()?;
        (clinic.clinic_id == carried.clinic.clinic_id
            && clinic
                .clinic_keys
                .iter()
                .any(|k| &k.kid == kid && k.status == KeyStatus::Active))
        .then(|| clinic.clinic_name.clone())
    })
}

/// The clinic of a carried record as the library shows it: the links of this vault to the same
/// clinic (by id) that hold the signing key. Conservative when they disagree: if ANY of them lists
/// the key as Revoked, it is revoked; it is Verified only when some link lists it Active and none
/// lists it Revoked. A link that does not hold the key says nothing.
pub(super) fn clinic_view(
    record: &StoredRecord,
    links: &[StoredLink],
) -> Option<super::delivery::ClinicView> {
    let carried = record.carried.as_ref()?;
    let kid = &carried.delivery.manifest.kid;
    let mut active = None;
    for link in links {
        let Some(clinic) = link.clinic.as_ref() else {
            continue;
        };
        if clinic.clinic_id != carried.clinic.clinic_id {
            continue;
        }
        let view = |key_revoked| super::delivery::ClinicView {
            id: clinic.clinic_id.clone(),
            name: clinic.clinic_name.clone(),
            key_revoked,
        };
        match super::delivery::key_status(clinic, kid) {
            Some(KeyStatus::Revoked) => return Some(view(true)),
            Some(KeyStatus::Active) => {
                active.get_or_insert_with(|| view(false));
            }
            None => {}
        }
    }
    active
}

/// The clinic evidence of a filed delivery, as a handover carries it: the public and signed
/// half of what the link and the record hold. None when the record holds none, when its link
/// is not here, or when what would travel does not stand up on its own (`valid_carried`
/// is the same check a vault makes when it reads it), so that nothing is exported that the
/// receiving vault would refuse.
pub(super) fn from_filed(
    record: &StoredRecord,
    links: &[StoredLink],
) -> Option<crate::portal_delivery::Carried> {
    use crate::portal_delivery::{Carried, CarriedAid, CarriedDelivery};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let c = record.delivery.as_ref()?;
    let link = links.iter().find(|l| l.id == c.link_id)?;
    let (x25519, ed25519) = link.keys.public();
    let carried = Carried {
        clinic: link.clinic.clone()?,
        device_x25519: URL_SAFE_NO_PAD.encode(x25519),
        device_ed25519: URL_SAFE_NO_PAD.encode(ed25519),
        delivery: CarriedDelivery {
            outer: c.outer.clone(),
            manifest: c.manifest.clone(),
            manifest_compact: c.manifest_compact.clone(),
            pdf_document_id: c.pdf_document_id.clone(),
            pdf_version: c.pdf_version,
            checked_at_ms: c.checked_at_ms,
            anchor_head: c.anchor_head.clone(),
            receipt: c.receipt.clone(),
            receipt_outcome: c.receipt_outcome,
        },
        reading_aid: record.reading_aid.as_ref().map(|a| CarriedAid {
            outer: a.outer.clone(),
            manifest_compact: a.manifest_compact.clone(),
            json: a.json.clone(),
            checked_at_ms: a.checked_at_ms,
            anchor_head: a.anchor_head.clone(),
            receipt: a.receipt.clone(),
            receipt_outcome: a.receipt_outcome,
        }),
    };
    let mut probe = record.clone();
    probe.delivery = None;
    probe.reading_aid = None;
    probe.carried = Some(carried.clone());
    valid_carried(&probe).then_some(carried)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_check_is_dated_within_the_deliverys_own_life_and_a_day_after() {
        let (created, expires) = (1_000_000, 1_000_000 + 3_600);
        let ms = |s: u64| s * 1000;
        assert!(checked_within(created, expires, ms(created)));
        assert!(checked_within(created, expires, ms(created + 10)));
        assert!(checked_within(created, expires, ms(expires)));
        assert!(checked_within(
            created,
            expires,
            ms(expires) + CHECK_GRACE_MS
        ));
        // Before the clinic made it, long after it expired, or a date no calendar can show.
        assert!(!checked_within(created, expires, ms(created) - 1));
        assert!(!checked_within(
            created,
            expires,
            ms(expires) + CHECK_GRACE_MS + 1
        ));
        assert!(!checked_within(created, expires, 8_640_000_000_000_001));
        assert!(!checked_within(created, expires, u64::MAX));
    }
}

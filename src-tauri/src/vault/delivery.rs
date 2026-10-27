//! Native custody transaction. No network call is permitted while a vault lock is held.
use super::*;
use crate::portal_delivery::{self as wire, Receipt};
#[cfg(feature = "portal-linking")]
use crate::portal_delivery::{Custody, ReceiptOutcome};
use crate::portal_link::KeyStatus;

pub(super) fn valid_custody(record: &StoredRecord, links: &[StoredLink]) -> bool {
    let Some(c) = &record.delivery else {
        return true;
    };
    let Some(link) = links.iter().find(|l| l.id == c.link_id) else {
        return false;
    };
    let Some(clinic) = &link.clinic else {
        return false;
    };
    let Some(original) = &record.original_pdf else {
        return false;
    };
    if c.outer.validate().is_err()
        || c.outer.recipient_id != clinic.recipient_id
        || c.outer.device_key_id != link.keys.device_key_id()
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
    let Ok((payload, _)) = wire::split_compact(&c.manifest_compact, 16 * 1024) else {
        return false;
    };
    if serde_json::from_slice::<wire::Manifest>(&payload)
        .ok()
        .as_ref()
        != Some(&c.manifest)
    {
        return false;
    }
    let Some(head) = wire::head_bytes(&c.anchor_head) else {
        return false;
    };
    let Ok(anchor) = link.keys.anchor(&head) else {
        return false;
    };
    let Ok((payload, signature)) = wire::split_compact(&c.receipt, 4096) else {
        return false;
    };
    let Ok(receipt) = serde_json::from_slice::<Receipt>(&payload) else {
        return false;
    };
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let (_, public) = link.keys.public();
    let Ok(key) = VerifyingKey::from_bytes(&public) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(&signature) else {
        return false;
    };
    key.verify(&payload, &signature).is_ok()
        && receipt.aud == "carlos-delivery-receipt"
        && receipt.typ == "mycarlos-delivery-receipt"
        && receipt.delivery_id == c.outer.delivery_id
        && receipt.device_key_id == c.outer.device_key_id
        && receipt.recipient_id == c.outer.recipient_id
        && receipt.ciphertext_sha256 == c.outer.ciphertext_sha256
        && receipt.document_sha256 == original.sha256
        && receipt.vault_head_link == anchor
        && receipt.jti.get_version_num() == 4
        && receipt.picked_up_at == c.checked_at_ms / 1000
}

pub(super) fn verified_clinic(record: &StoredRecord, links: &[StoredLink]) -> Option<String> {
    let c = record.delivery.as_ref()?;
    let link = links.iter().find(|l| l.id == c.link_id)?;
    let clinic = link.clinic.as_ref()?;
    clinic
        .clinic_keys
        .iter()
        .any(|k| k.kid == c.manifest.kid && k.status == KeyStatus::Active)
        .then(|| clinic.clinic_name.clone())
}

#[cfg(feature = "portal-linking")]
pub(super) struct PortalWork<'a>(&'a AtomicBool);

#[cfg(feature = "portal-linking")]
impl Drop for PortalWork<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[cfg(feature = "portal-linking")]
impl VaultStore {
    /// Reserve portal work without queuing it behind another session's HTTP.
    /// Local reads and the short vault commits remain independent of this guard.
    pub(super) fn start_portal_work(&self) -> Result<PortalWork<'_>, VaultError> {
        self.portal_check_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| PortalWork(&self.portal_check_running))
            .map_err(|_| VaultError::Portal(portal_link::LinkError::Busy))
    }

    pub(crate) fn check_documents(
        &self,
        session: u64,
    ) -> Result<crate::portal_pickup::CheckResult, VaultError> {
        let _running = self.start_portal_work()?;
        crate::portal_pickup::check(self, session)
    }

    /// A snapshot is cloned under the lock, used for HTTP/parsing outside it,
    /// then compared again under the commit lock. Locking cancels old tickets.
    pub(crate) fn delivery_links(&self, session: u64) -> Result<Vec<StoredLink>, VaultError> {
        if !crate::portal_client::available() {
            return Err(VaultError::Portal(portal_link::LinkError::Unavailable));
        }
        if self.portal_link_ticket() != session {
            return Err(VaultError::Cancelled);
        }
        let guard = self.session();
        let open = guard.as_ref().ok_or(VaultError::Locked)?;
        if open.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        Ok(open
            .manifest
            .portal_links
            .iter()
            .filter(|l| l.clinic.is_some())
            .cloned()
            .collect())
    }
    pub(crate) fn delivery_anchor(
        &self,
        link: &StoredLink,
        session: u64,
    ) -> Result<String, VaultError> {
        let guard = self.session();
        let open = guard.as_ref().ok_or(VaultError::Locked)?;
        if open.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        if self.portal_link_ticket() != session {
            return Err(VaultError::Cancelled);
        }
        if !open.manifest.portal_links.contains(link) {
            return Err(VaultError::Invalid);
        }
        let head = wire::head_bytes(&open.manifest.history.head).ok_or(VaultError::Corrupt)?;
        link.keys.anchor(&head).map_err(VaultError::Portal)
    }
    pub(crate) fn pending_receipts(
        &self,
        link: &StoredLink,
        session: u64,
    ) -> Result<Vec<Custody>, VaultError> {
        let guard = self.session();
        let open = guard.as_ref().ok_or(VaultError::Locked)?;
        if self.portal_link_ticket() != session {
            return Err(VaultError::Cancelled);
        }
        if open.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        if !open.manifest.portal_links.contains(link) {
            return Err(VaultError::Invalid);
        }
        let keys = derive_keys(open.manifest.vault_id, &open.master_key)?;
        let mut pending = Vec::new();
        for record in &open.manifest.records {
            if let Some(c) = &record.delivery {
                if c.link_id == link.id && c.receipt_outcome.is_none() {
                    // A restored/damaged object must never be acknowledged merely
                    // because its metadata and old receipt are still readable.
                    for object in record.objects() {
                        read_object_ref(
                            &self.root.join("objects").join(object.object_name),
                            open.manifest.vault_id,
                            &keys,
                            object,
                            io::sink(),
                        )?;
                    }
                    pending.push(c.clone());
                }
            }
        }
        Ok(pending)
    }
    pub(crate) fn settle_receipt(
        &self,
        link: &StoredLink,
        c: &Custody,
        outcome: ReceiptOutcome,
        session: u64,
    ) -> Result<(), VaultError> {
        self.mutate_recorded(|manifest, entries| {
            if self.portal_link_ticket() != session {
                return Err(VaultError::Cancelled);
            }
            if !manifest.portal_links.contains(link) {
                return Err(VaultError::Invalid);
            }
            let record = manifest
                .records
                .iter_mut()
                .find(|r| {
                    r.delivery.as_ref().is_some_and(|d| {
                        d.link_id == link.id && d.outer.delivery_id == c.outer.delivery_id
                    })
                })
                .ok_or(VaultError::NotFound)?;
            let saved = record.delivery.as_mut().ok_or(VaultError::Corrupt)?;
            if saved.receipt != c.receipt {
                return Err(VaultError::Corrupt);
            }
            if saved.receipt_outcome.is_none() {
                saved.receipt_outcome = Some(outcome);
                let mut entry =
                    HistoryEntry::new(HistoryEvent::DeliveryReceiptSettled, crate::now_ms());
                entry.record_id = Some(record.id);
                entry.portal_link_id = Some(link.id);
                entry.delivery_id = Some(c.outer.delivery_id.clone());
                entry.ciphertext_sha256 = Some(c.outer.ciphertext_sha256.clone());
                entry.how = Some(
                    match outcome {
                        ReceiptOutcome::PickedUp => "picked_up",
                        ReceiptOutcome::Gone => "delivery_not_found",
                    }
                    .into(),
                );
                entries.push(entry);
            }
            Ok(())
        })
    }
    pub(crate) fn receive_delivery(
        &self,
        outer: &wire::Outer,
        sealed: &[u8],
        link: &StoredLink,
        session: u64,
    ) -> Result<(Uuid, bool), VaultError> {
        let cancelled = || self.portal_link_ticket() != session;
        if cancelled() {
            return Err(VaultError::Cancelled);
        }
        let others = self
            .delivery_links(session)?
            .iter()
            .filter(|l| l.id != link.id)
            .filter_map(|l| l.clinic.as_ref())
            .flat_map(|c| c.clinic_keys.iter().map(|k| k.kid.clone()))
            .collect::<Vec<_>>();
        let opened = wire::open(outer, sealed, link, &others, crate::now_ms() / 1000)
            .map_err(|_| VaultError::PickupRefused)?;
        let clinic = link.clinic.as_ref().ok_or(VaultError::Invalid)?;
        let pins = crate::signed_pdf::PinnedLink {
            clinic_id: clinic.clinic_id.clone(),
            recipient_id: clinic.recipient_id.clone(),
            signer_kids: clinic
                .clinic_keys
                .iter()
                .filter(|k| k.status == KeyStatus::Active)
                .map(|k| k.kid.clone())
                .collect(),
        };
        let checked = crate::signed_pdf_helper::verify(&opened.pdf, "", &[pins], &cancelled)
            .map_err(|_| VaultError::PickupRefused)?;
        let crate::signed_pdf::Verdict::Verified { kid, manifest: pdf } = checked else {
            return Err(VaultError::PickupRefused);
        };
        if kid != opened.manifest.kid
            || pdf.patient.name.as_deref() != Some(&opened.manifest.patient.name)
            || pdf.patient.birth_date.as_deref() != Some(&opened.manifest.patient.birth_date)
            || pdf.clinic_id.as_deref() != Some(&clinic.clinic_id)
            || pdf.recipient_id.as_deref() != Some(&clinic.recipient_id)
            || pdf
                .document
                .title
                .as_ref()
                .is_some_and(|v| v != &opened.manifest.document.title)
            || pdf
                .document
                .kind
                .as_ref()
                .is_some_and(|v| v != &opened.manifest.document.kind)
            || !wire::service_dates_match(
                pdf.document.service_date.as_deref(),
                &opened.manifest.document.service_date,
            )
            || pdf.document.media_type != opened.manifest.document.media_type
            || pdf
                .clinic_name
                .as_ref()
                .is_some_and(|v| v != &opened.manifest.clinic_name)
            || pdf
                .provider_name
                .as_ref()
                .is_some_and(|v| v != &opened.manifest.provider_name)
        {
            return Err(VaultError::PickupRefused);
        }
        if cancelled() {
            return Err(VaultError::Cancelled);
        }
        self.commit_delivery(outer, opened, link, &pdf, crate::now_ms(), session)
    }

    fn commit_delivery(
        &self,
        outer: &wire::Outer,
        opened: wire::Opened,
        link: &StoredLink,
        pdf: &crate::signed_pdf::Manifest,
        now: u64,
        session: u64,
    ) -> Result<(Uuid, bool), VaultError> {
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        if self.portal_link_ticket() != session {
            return Err(VaultError::Cancelled);
        }
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        if !unlocked.manifest.portal_links.contains(link) {
            return Err(VaultError::Invalid);
        }
        if let Some(record) = unlocked.manifest.records.iter().find(|r| {
            r.delivery
                .as_ref()
                .is_some_and(|c| c.link_id == link.id && c.outer.delivery_id == outer.delivery_id)
        }) {
            let saved = record.delivery.as_ref().ok_or(VaultError::Corrupt)?;
            if saved.outer.ciphertext_sha256 != outer.ciphertext_sha256 {
                return Err(VaultError::PickupRefused);
            }
            return Ok((record.id, false));
        }
        let shared = shared_profile_id(unlocked.manifest.vault_id);
        let person = &opened.manifest.patient;
        let matches = unlocked
            .manifest
            .profiles
            .iter()
            .filter(|p| {
                p.id != shared
                    && p.full_name.as_deref() == Some(person.name.as_str())
                    && p.birth_date.as_deref() == Some(person.birth_date.as_str())
            })
            .filter(|p| link.profile_id.is_none_or(|id| p.id == id))
            .map(|p| p.id)
            .collect::<Vec<_>>();
        let profile_id = if matches.len() == 1 {
            matches[0]
        } else {
            shared
        };
        let stage = self.root.join("staging").join(Uuid::new_v4().to_string());
        create_private_dir_all(&stage)?;
        let keys = derive_keys(unlocked.manifest.vault_id, &unlocked.master_key)?;
        let id = Uuid::new_v4();
        let object_name = format!("{}.mcobj", Uuid::new_v4());
        let mut key = Zeroizing::new([0; 32]);
        OsRng.fill_bytes(key.as_mut());
        let mut published = Vec::new();
        let mut history_written = Vec::new();
        let mut commit_attempted = false;
        let result = (|| {
            let encrypted = encrypt_object(
                Box::new(io::Cursor::new(opened.pdf)),
                &stage.join(&object_name),
                ObjectContext {
                    vault_id: unlocked.manifest.vault_id,
                    record_id: id,
                    profile_id,
                },
                &key,
                &keys.fingerprint,
            )?;
            let mut record = StoredRecord {
                id,
                profile_id,
                folder_ids: Vec::new(),
                display_name: sanitize_basename(&format!("{}.pdf", opened.manifest.document.title)),
                source_label: MANUAL_IMPORT_LABEL.into(),
                media_type: "application/octet-stream".into(),
                plaintext_size: encrypted.plaintext_size,
                imported_at_ms: now,
                object_name,
                fingerprint: BASE64.encode(encrypted.fingerprint),
                wrapped_object_key: wrap_secret(&keys.object_wrap, &key, id.as_bytes())?,
                hidden: None,
                original_pdf: None,
                delivery: None,
            };
            record.original_pdf = Some(self.stage_original_pdf(
                unlocked.manifest.vault_id,
                &keys,
                &record,
                &stage.join(&record.object_name),
                &stage,
            )?);
            let original = record.original_pdf.as_ref().ok_or(VaultError::Corrupt)?;
            if original.sha256 != opened.manifest.document.sha256
                || original.plaintext_size != opened.manifest.document.size
            {
                return Err(VaultError::PickupRefused);
            }
            for object in record.objects() {
                publish_object(
                    &stage.join(object.object_name),
                    &self.root.join("objects").join(object.object_name),
                )?;
                published.push(object.object_name.to_owned());
                terminate_at_test_boundary("delivery.after-object-publication");
                fail_at_test_boundary("delivery.after-object-publication")?;
            }
            let mut entry = record_entry(HistoryEvent::DeliveryFiled, now, &record);
            entry.portal_link_id = Some(link.id);
            entry.delivery_id = Some(outer.delivery_id.clone());
            entry.ciphertext_sha256 = Some(outer.ciphertext_sha256.clone());
            entry.profile_id = Some(profile_id);
            let prepared = prepare_history(
                &self.root,
                &unlocked.master_key,
                &unlocked.manifest,
                vec![entry],
            )?;
            history_written = prepared.written;
            let head = wire::head_bytes(&prepared.state.head).ok_or(VaultError::Corrupt)?;
            let anchor = link.keys.anchor(&head).map_err(VaultError::Portal)?;
            let claims = Receipt::new(outer, &opened.manifest, anchor, now / 1000);
            let receipt = link
                .keys
                .sign(&serde_json::to_vec(&claims).map_err(|_| VaultError::Storage)?);
            record.delivery = Some(Custody {
                link_id: link.id,
                outer: outer.clone(),
                manifest: opened.manifest,
                manifest_compact: opened.manifest_compact,
                pdf_document_id: pdf.document_id.clone(),
                pdf_version: pdf.version,
                checked_at_ms: now,
                anchor_head: prepared.state.head.clone(),
                receipt,
                receipt_outcome: None,
            });
            let mut next = unlocked.manifest.clone();
            if profile_id == shared && !next.profiles.iter().any(|p| p.id == shared) {
                next.profiles.push(PatientProfile {
                    id: shared,
                    display_name: SHARED_PROFILE_NAME.into(),
                    created_at_ms: now,
                    full_name: None,
                    birth_date: None,
                });
            }
            next.history = prepared.state;
            next.records.push(record);
            if self.portal_link_ticket() != session {
                return Err(VaultError::Cancelled);
            }
            terminate_at_test_boundary("delivery.before-custody-commit");
            fail_at_test_boundary("delivery.before-custody-commit")?;
            commit_attempted = true;
            let redundant = commit_manifest_redundant(
                &self.root,
                &unlocked.master_key,
                &mut unlocked.manifest,
                next,
                || {
                    remove_objects(
                        &self.root,
                        &prepared.superseded,
                        Removable::SupersededSegment,
                    );
                    Ok(())
                },
            )?;
            // Ownership has transferred to the committed manifest, including a
            // degraded second-slot write. Never remove those objects on error.
            published.clear();
            history_written.clear();
            unlocked.recovery = (!redundant).then_some(RecoveryReason::WriteFailed);
            terminate_at_test_boundary("delivery.after-custody-commit");
            if !redundant {
                return Err(VaultError::RecoveryMode);
            }
            Ok((id, true))
        })();
        if result.is_err() && commit_attempted {
            // Atomic publication can report a later sync failure after the
            // new slot became visible. Preserve all references until restart
            // selects the authentic state; never delete possibly owned data.
            unlocked.recovery = Some(RecoveryReason::WriteFailed);
        } else {
            remove_objects(&self.root, &published, Removable::UncommittedObject);
            remove_objects(&self.root, &history_written, Removable::UncommittedObject);
        }
        let _ = remove_owned_dir_all(&stage, Removable::ImportStaging);
        result
    }
}

#[cfg(all(test, feature = "portal-linking"))]
mod unknown_service_date_tests {
    use super::*;
    use serde_json::{json, Value};
    const PASSWORD: &str = "meadow-planet-copper-window-743";

    fn packet(canonical: bool) -> Value {
        serde_json::from_str(if canonical {
            include_str!("../../tests/fixtures/java-unknown-date-canonical-v1.json")
        } else {
            include_str!("../../tests/fixtures/java-unknown-date-legacy-v1.json")
        })
        .unwrap()
    }
    fn link(packet: &Value) -> StoredLink {
        let mut shared: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/delivery-contract.json"))
                .unwrap();
        shared["receiver"] = packet["receiver"].clone();
        wire::tests::fixture_link(&shared)
    }
    fn store(root: PathBuf, link: &StoredLink) -> VaultStore {
        let store = VaultStore::new(root);
        store
            .create(PASSWORD, "FAKE Unknown Date Patient", 1)
            .unwrap();
        store
            .mutate_recorded(|m, _| {
                m.portal_links.push(link.clone());
                Ok(())
            })
            .unwrap();
        store
    }

    #[test]
    fn unknown_service_date_survives_real_signed_custody_and_reopen_without_date_inference() {
        for canonical in [true, false] {
            let packet = packet(canonical);
            let link = link(&packet);
            let outer: wire::Outer = serde_json::from_value(packet["outer"].clone()).unwrap();
            let sealed = wire::decode(packet["blob"].as_str().unwrap()).unwrap();
            let opened =
                wire::open(&outer, &sealed, &link, &[], packet["now"].as_u64().unwrap()).unwrap();
            assert!(opened.manifest.document.service_date.is_empty());
            let original = BASE64
                .decode(packet["pdf_base64"].as_str().unwrap())
                .unwrap();
            assert_eq!(original.as_slice(), opened.pdf.as_slice());
            let manifest = BASE64
                .decode(packet["embedded_manifest_base64"].as_str().unwrap())
                .unwrap();
            let layout = crate::signed_pdf::SignatureLayout {
                byte_ranges: vec![serde_json::from_value(packet["byte_ranges"].clone()).unwrap()],
                update_after_signature: false,
                encrypted: false,
            };
            let clinic = link.clinic.as_ref().unwrap();
            let pins = crate::signed_pdf::PinnedLink {
                clinic_id: clinic.clinic_id.clone(),
                recipient_id: clinic.recipient_id.clone(),
                signer_kids: clinic
                    .clinic_keys
                    .iter()
                    .filter(|k| k.status == KeyStatus::Active)
                    .map(|k| k.kid.clone())
                    .collect(),
            };
            let crate::signed_pdf::Verdict::Verified {
                manifest: checked, ..
            } = crate::signed_pdf::check(&original, &layout, Some(&manifest), &[pins]).unwrap()
            else {
                panic!("actual Java CMS and embedded manifest must verify");
            };
            assert_eq!(
                checked.document.service_date.as_deref(),
                if canonical { None } else { Some("") }
            );
            assert!(wire::service_dates_match(
                checked.document.service_date.as_deref(),
                &opened.manifest.document.service_date
            ));
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("vault");
            let store = store(root.clone(), &link);
            // Date added is deliberately different from the fixture's dates.
            let added_at = 1_701_234_567_890;
            let (id, added) = store
                .commit_delivery(
                    &outer,
                    opened,
                    &link,
                    &checked,
                    added_at,
                    store.portal_link_ticket(),
                )
                .unwrap();
            assert!(added);
            let receipt = store
                .pending_receipts(&link, store.portal_link_ticket())
                .unwrap()[0]
                .receipt
                .clone();
            store.lock();
            drop(store);
            let reopened = VaultStore::new(root);
            reopened.unlock(PASSWORD).unwrap();
            let snapshot = reopened.snapshot().unwrap();
            assert_eq!(snapshot.records[0].clinic_service_date.as_deref(), Some(""));
            assert_eq!(snapshot.records[0].imported_at_ms, added_at);
            let mut saved = Vec::new();
            reopened.export(id, &mut saved).unwrap();
            assert_eq!(saved, original);
            assert_eq!(
                reopened
                    .pending_receipts(&link, reopened.portal_link_ticket())
                    .unwrap()[0]
                    .receipt,
                receipt
            );
            let guard = reopened.session();
            let open = guard.as_ref().unwrap();
            assert!(open.manifest.records[0]
                .delivery
                .as_ref()
                .unwrap()
                .manifest
                .document
                .service_date
                .is_empty());
            assert!(valid_custody(
                &open.manifest.records[0],
                &open.manifest.portal_links
            ));
            drop(guard);
            assert_eq!(
                crate::vault::history_events_for_test(&reopened)
                    .iter()
                    .filter(|e| e.event == HistoryEvent::DeliveryFiled)
                    .count(),
                1
            );
        }
    }

    #[test]
    #[ignore = "requires the actual confined helper; explicit synthetic date binding evidence"]
    fn signed_pdf_unknown_and_known_date_conflicts_refuse_before_custody() {
        assert!(std::env::var_os("MYCARLOS_TEST_SIGNED_HELPER_EXE").is_some());
        let known: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/java-delivery-interop-v1.json"
        ))
        .unwrap();
        for (packet, date) in [
            (packet(true), "2024-02-29"),
            (packet(false), "2024-02-29"),
            (known.clone(), ""),
            (known, "2000-02-29"),
        ] {
            let now = crate::now_ms() / 1000;
            let (mut outer, sealed, link, _) = wire::tests::mutated_packet(&packet, |m| {
                m["document"]["service_date"] = json!(date);
                m["created_at"] = json!(now);
                m["expires_at"] = json!(now + 3600);
            });
            outer.created_at = now;
            outer.expires_at = now + 3600;
            let opened = wire::open(&outer, &sealed, &link, &[], now).unwrap();
            let clinic = link.clinic.as_ref().unwrap();
            let pins = crate::signed_pdf::PinnedLink {
                clinic_id: clinic.clinic_id.clone(),
                recipient_id: clinic.recipient_id.clone(),
                signer_kids: clinic
                    .clinic_keys
                    .iter()
                    .filter(|k| k.status == KeyStatus::Active)
                    .map(|k| k.kid.clone())
                    .collect(),
            };
            assert!(matches!(
                crate::signed_pdf_helper::verify(&opened.pdf, "", &[pins], &|| false),
                Ok(crate::signed_pdf::Verdict::Verified { .. })
            ));
            let temp = tempfile::tempdir().unwrap();
            let store = store(temp.path().join("vault"), &link);
            let history_before = crate::vault::history_events_for_test(&store).len();
            assert!(matches!(
                store.receive_delivery(&outer, &sealed, &link, store.portal_link_ticket()),
                Err(VaultError::PickupRefused)
            ));
            assert!(store.snapshot().unwrap().records.is_empty());
            assert!(store
                .pending_receipts(&link, store.portal_link_ticket())
                .unwrap()
                .is_empty());
            assert_eq!(
                crate::vault::history_events_for_test(&store).len(),
                history_before
            );
        }
    }
}

#[cfg(all(test, feature = "portal-linking"))]
mod tests {
    use super::*;
    use serde_json::Value;
    const PASSWORD: &str = "meadow-planet-copper-window-743";
    fn inputs() -> (Value, wire::Outer, Vec<u8>, StoredLink) {
        let file = std::env::var("MYCARLOS_TEST_DELIVERY_PACKAGE")
            .expect("explicit FAKE producer package required");
        let packet: Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        let mut shared: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/delivery-contract.json"))
                .unwrap();
        shared["receiver"] = packet["receiver"].clone();
        let link = wire::tests::fixture_link(&shared);
        let outer = serde_json::from_value(packet["outer"].clone()).unwrap();
        let sealed = wire::decode(packet["blob"].as_str().unwrap()).unwrap();
        (packet, outer, sealed, link)
    }
    fn template(path: &Path, link: &StoredLink) -> VaultStore {
        let store = VaultStore::new(path.to_path_buf());
        store.create(PASSWORD, "FAKE Interop Patient", 1).unwrap();
        // Explicit test trust only, never a production linking/approval API.
        store
            .mutate_recorded(|m, _| {
                m.portal_links.push(link.clone());
                Ok(())
            })
            .unwrap();
        store
    }
    #[test]
    #[ignore = "requires real helper and explicit synthetic Java package; not native Windows end-to-end"]
    fn should_keep_exact_java_signed_original_history_and_receipt_across_restart() {
        assert!(std::env::var_os("MYCARLOS_TEST_SIGNED_HELPER_EXE").is_some());
        let (packet, outer, sealed, link) = inputs();
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let store = template(&root, &link);
        let session = store.portal_link_ticket();
        let (id, added) = store
            .receive_delivery(&outer, &sealed, &link, session)
            .unwrap();
        assert!(added);
        let mut original = Vec::new();
        store.export(id, &mut original).unwrap();
        assert_eq!(wire::sha256(&original), packet["expected_document_sha256"]);
        let pending = store.pending_receipts(&link, session).unwrap();
        assert_eq!(pending.len(), 1);
        let receipt = pending[0].receipt.clone();
        let events = crate::vault::history_events_for_test(&store);
        let filed = events
            .iter()
            .filter(|e| e.event == HistoryEvent::DeliveryFiled)
            .collect::<Vec<_>>();
        assert_eq!(filed.len(), 1);
        assert_eq!(filed[0].record_id, Some(id));
        assert_eq!(
            filed[0].delivery_id.as_deref(),
            Some(outer.delivery_id.as_str())
        );
        assert_eq!(
            filed[0].ciphertext_sha256.as_deref(),
            Some(outer.ciphertext_sha256.as_str())
        );
        store.lock();
        drop(store);
        let store = VaultStore::new(root);
        store.unlock(PASSWORD).unwrap();
        let session = store.portal_link_ticket();
        assert_eq!(
            store.pending_receipts(&link, session).unwrap()[0].receipt,
            receipt
        );
        assert_eq!(
            store
                .receive_delivery(&outer, &sealed, &link, session)
                .unwrap(),
            (id, false)
        );
        assert_eq!(store.snapshot().unwrap().records.len(), 1);
        let mut restarted_original = Vec::new();
        store.export(id, &mut restarted_original).unwrap();
        assert_eq!(restarted_original, original);
        let mut altered = sealed.clone();
        *altered.last_mut().unwrap() ^= 1;
        assert!(matches!(
            store.receive_delivery(&outer, &altered, &link, session),
            Err(VaultError::PickupRefused)
        ));
        assert_eq!(
            store.pending_receipts(&link, session).unwrap()[0].receipt,
            receipt
        );
        let mut backup = Vec::new();
        store.backup(&mut backup, crate::now_ms()).unwrap();
        let restored = VaultStore::new(temp.path().join("restored"));
        restored
            .restore(
                io::Cursor::new(backup),
                RestoreCredential::Passphrase(PASSWORD),
                false,
            )
            .unwrap();
        restored.unlock(PASSWORD).unwrap();
        let restored_session = restored.portal_link_ticket();
        assert_eq!(
            restored.pending_receipts(&link, restored_session).unwrap()[0].receipt,
            receipt
        );
        if let Some(path) = std::env::var_os("MYCARLOS_TEST_RECEIPT_OUTPUT") {
            fs::write(path, receipt.as_bytes()).unwrap();
        }
    }
    #[test]
    #[ignore = "requires real helper and explicit synthetic Java package; subprocess crash evidence"]
    fn should_send_no_receipt_before_custody_and_keep_identical_receipt_after_crash() {
        let (_packet, outer, _sealed, link) = inputs();
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("template");
        let store = template(&base, &link);
        store.lock();
        drop(store);
        for (boundary, committed) in [
            ("delivery.after-object-publication", false),
            ("history.after-segment-write", false),
            ("delivery.before-custody-commit", false),
            ("manifest.after-first-write", true),
            ("manifest.after-second-write", true),
            ("delivery.after-custody-commit", true),
        ] {
            let root = temp.path().join(boundary);
            copy(&base, &root);
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "vault::delivery::tests::interop_termination_child",
                ])
                .env("MYCARLOS_TEST_ROOT", &root)
                .env("MYCARLOS_TEST_TERMINATE_AT", boundary)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            assert_eq!(
                status.code(),
                Some(TEST_TERMINATION_EXIT_CODE),
                "{boundary}"
            );
            let store = VaultStore::new(root.clone());
            store.unlock(PASSWORD).unwrap();
            let session = store.portal_link_ticket();
            assert_eq!(
                store.snapshot().unwrap().records.len(),
                usize::from(committed),
                "{boundary}"
            );
            let pending = store.pending_receipts(&link, session).unwrap();
            assert_eq!(pending.len(), usize::from(committed), "{boundary}");
            let events = crate::vault::history_events_for_test(&store);
            assert_eq!(
                events
                    .iter()
                    .filter(|e| e.event == HistoryEvent::DeliveryFiled)
                    .count(),
                usize::from(committed),
                "{boundary}"
            );
            if committed {
                assert_eq!(pending[0].outer.delivery_id, outer.delivery_id);
                let receipt = pending[0].receipt.clone();
                store.lock();
                drop(store);
                let again = VaultStore::new(root);
                again.unlock(PASSWORD).unwrap();
                assert_eq!(
                    again
                        .pending_receipts(&link, again.portal_link_ticket())
                        .unwrap()[0]
                        .receipt,
                    receipt,
                    "{boundary}"
                );
            }
        }
    }
    fn copy(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy(&entry.path(), &target);
            } else {
                fs::copy(entry.path(), target).unwrap();
            }
        }
    }
    #[test]
    #[ignore = "only called by process-crash parent"]
    fn interop_termination_child() {
        let root = std::env::var_os("MYCARLOS_TEST_ROOT").unwrap();
        let (_packet, outer, sealed, _) = inputs();
        let store = VaultStore::new(root.into());
        ENV_BOUNDARIES_HELD.store(true, Ordering::Release);
        store.unlock(PASSWORD).unwrap();
        ENV_BOUNDARIES_HELD.store(false, Ordering::Release);
        let link = store
            .delivery_links(store.portal_link_ticket())
            .unwrap()
            .remove(0);
        store
            .receive_delivery(&outer, &sealed, &link, store.portal_link_ticket())
            .unwrap();
        panic!("crash boundary not reached");
    }
}

#[cfg(feature = "portal-linking")]
use crate::portal_approval::{ApprovalExchange, ApprovalHttp};

/// What a read-only status check of a linked device's approval found (#131).
#[cfg_attr(not(feature = "portal-linking"), allow(dead_code))]
pub(crate) struct ApprovalCheck {
    /// The device's saved state after the check, in the same session.
    pub link: portal_link::LinkSummary,
    /// For a request still open: what the portal leaves it, by the portal's
    /// own clock when it replied (its `Date` header), so a wrong clock on
    /// this device does not change it. Display only: it never decides a
    /// state, and `None` when the portal gave no time.
    pub expires_in_ms: Option<u64>,
    /// Why the check could not finish (no connection, a portal asking to
    /// wait, or a request it does not have). Nothing saved changed for it.
    pub issue: Option<VaultError>,
}

#[cfg(feature = "portal-linking")]
struct ApprovalReconciliation {
    saved: StoredLink,
    missing: bool,
    deferred: Option<VaultError>,
}
#[cfg(feature = "portal-linking")]
impl VaultStore {
    pub(super) fn connect_portal_using(
        &self,
        session: u64,
        link: impl FnOnce() -> Result<portal_link::LinkSummary, VaultError>,
        http: &impl ApprovalExchange,
    ) -> Result<(portal_link::LinkSummary, Option<VaultError>), VaultError> {
        let _running = self.start_portal_work()?;
        let linked = link()?;
        run_at_test_boundary("portal.connected-before-approval");
        // Both operations use the ticket captured before IPC was queued. A
        // lock/reopen between them must not authorize work in the new session.
        let approval_error = self
            .request_staff_approval_using(linked.id, session, false, http)
            .err();
        // Publish only current persisted state in that same writable session.
        // A failed second step never starts a replacement link or request.
        let current = self
            .delivery_links(session)?
            .into_iter()
            .find(|saved| saved.id == linked.id)
            .ok_or(VaultError::NotFound)?;
        Ok((current.summary(), approval_error))
    }

    pub(crate) fn request_staff_approval(
        &self,
        link_id: Uuid,
        session: u64,
    ) -> Result<(), VaultError> {
        let _running = self.start_portal_work()?;
        self.request_staff_approval_using(link_id, session, false, &ApprovalHttp::default())
    }
    pub(crate) fn restart_staff_approval(
        &self,
        link_id: Uuid,
        session: u64,
    ) -> Result<(), VaultError> {
        let _running = self.start_portal_work()?;
        self.request_staff_approval_using(link_id, session, true, &ApprovalHttp::default())
    }
    /// Reads one linked device's approval status for the clinic view's
    /// automatic refresh (#131). It only reads the portal (GET) and saves what
    /// the clinic answered, through the same strict parsing and acceptance
    /// verification as every other read: it never sends, re-sends or starts a
    /// request, so a poll cannot mint requests or wear down the request limit.
    /// Same admission guard, session ticket and recovery-mode refusal as all
    /// other clinic work.
    pub(crate) fn poll_staff_approval(
        &self,
        link_id: Uuid,
        session: u64,
    ) -> Result<ApprovalCheck, VaultError> {
        self.poll_staff_approval_using(link_id, session, &ApprovalHttp::default())
    }
    fn poll_staff_approval_using(
        &self,
        link_id: Uuid,
        session: u64,
        http: &impl ApprovalExchange,
    ) -> Result<ApprovalCheck, VaultError> {
        let _running = self.start_portal_work()?;
        let find = || -> Result<StoredLink, VaultError> {
            self.delivery_links(session)?
                .into_iter()
                .find(|l| l.id == link_id)
                .ok_or(VaultError::NotFound)
        };
        let recovery = self.reconcile_approvals(&find()?, session, http)?;
        // Publish only the persisted state, read again in the same session.
        let current = find()?;
        let link = current.summary();
        let open = !link.clinic_approved
            && matches!(
                link.approval_status,
                Some(
                    crate::portal_approval::ApprovalState::Pending
                        | crate::portal_approval::ApprovalState::ChallengeReady
                )
            );
        let expires_in_ms = match (&current.approval, http.portal_time()) {
            (Some(attempt), Some(portal_now)) if open && !recovery.missing => {
                let left = attempt.expires_at.saturating_sub(portal_now);
                // Requests last minutes: a day or more means a clock that
                // cannot be read sensibly, so no time is shown.
                (left < 86_400).then_some(left * 1000)
            }
            _ => None,
        };
        Ok(ApprovalCheck {
            link,
            expires_in_ms,
            issue: if recovery.missing {
                Some(VaultError::ApprovalRequestMissing)
            } else {
                recovery.deferred
            },
        })
    }
    fn approval_error(link: &StoredLink, missing: bool) -> Result<(), VaultError> {
        if crate::portal_approval::currently_approved(link) {
            return Ok(());
        }
        if link
            .approval
            .iter()
            .chain(link.approval_history.iter())
            .any(|a| a.acceptance.is_some())
        {
            return Err(VaultError::ApprovalNeedsClinic);
        }
        if let Some(attempt) = &link.approval {
            if attempt.state().terminal_failure() {
                return Err(VaultError::ApprovalTerminal(
                    attempt.state(),
                    attempt.reason,
                ));
            }
            if missing {
                return Err(VaultError::ApprovalRequestMissing);
            }
        }
        Ok(())
    }
    fn save_approval_state(
        &self,
        old: &StoredLink,
        next: StoredLink,
        session: u64,
        restarted: bool,
    ) -> Result<StoredLink, VaultError> {
        if &next == old {
            return Ok(next);
        }
        self.mutate_recorded(|m, entries| {
            if self.portal_link_ticket() != session {
                return Err(VaultError::Cancelled);
            }
            let current = m
                .portal_links
                .iter_mut()
                .find(|l| l.id == old.id)
                .ok_or(VaultError::NotFound)?;
            if current != old {
                return Err(VaultError::Invalid);
            }
            let newly_accepted =
                next.approval
                    .iter()
                    .chain(next.approval_history.iter())
                    .any(|a| {
                        a.acceptance.is_some()
                            && !old.approval.iter().chain(old.approval_history.iter()).any(
                                |before| {
                                    before.request_id == a.request_id
                                        && before.acceptance == a.acceptance
                                },
                            )
                    });
            let event = if restarted {
                HistoryEvent::DeviceApprovalRequestRestarted
            } else if old.approval.is_none() {
                HistoryEvent::DeviceApprovalRequested
            } else if newly_accepted {
                HistoryEvent::DeviceApprovalVerified
            } else {
                HistoryEvent::DeviceApprovalStatusChanged
            };
            let mut entry = HistoryEntry::new(event, crate::now_ms());
            entry.portal_link_id = Some(old.id);
            entry.how = Some(
                next.approval
                    .as_ref()
                    .map(|a| a.state().code())
                    .unwrap_or("pending")
                    .into(),
            );
            entries.push(entry);
            *current = next.clone();
            Ok(next)
        })
    }
    fn reconcile_approvals(
        &self,
        link: &StoredLink,
        session: u64,
        http: &impl ApprovalExchange,
    ) -> Result<ApprovalReconciliation, VaultError> {
        if crate::portal_approval::currently_approved(link) {
            return Ok(ApprovalReconciliation {
                saved: link.clone(),
                missing: false,
                deferred: None,
            });
        }
        let cancelled = || self.portal_link_ticket() != session;
        let mut saved = link.clone();
        let mut missing = false;
        let mut deferred = None;
        if let Some(attempt) = link.approval.as_ref().filter(|a| a.acceptance.is_none()) {
            let reply = http.get(link, attempt, &cancelled);
            if cancelled() {
                return Err(VaultError::Cancelled);
            }
            match reply {
                Ok(Some(reply)) => {
                    let mut next = saved.clone();
                    next.approval = Some(reply);
                    saved = self.save_approval_state(&saved, next, session, false)?;
                }
                Ok(None) => missing = true,
                Err(error) if crate::portal_pickup::is_per_link_failure(&error) => {
                    deferred = Some(error)
                }
                Err(error) => return Err(error),
            }
            if crate::portal_approval::currently_approved(&saved) {
                return Ok(ApprovalReconciliation {
                    saved,
                    missing: false,
                    deferred: None,
                });
            }
        }
        for (index, attempt) in link.approval_history.iter().enumerate() {
            if attempt.acceptance.is_some() {
                continue;
            }
            let reply = http.get(&saved, attempt, &cancelled);
            if cancelled() {
                return Err(VaultError::Cancelled);
            }
            match reply {
                Ok(Some(reply)) => {
                    let mut next = saved.clone();
                    next.approval_history[index] = reply;
                    saved = self.save_approval_state(&saved, next, session, false)?;
                }
                Ok(None) => {}
                Err(error) if crate::portal_pickup::is_per_link_failure(&error) => {
                    if deferred.is_none() {
                        deferred = Some(error);
                    }
                }
                Err(error) => return Err(error),
            }
            // Once a verified current acceptance is durable, broken historical
            // endpoints must not prevent this independently eligible link.
            if crate::portal_approval::currently_approved(&saved) {
                return Ok(ApprovalReconciliation {
                    saved,
                    missing: false,
                    deferred: None,
                });
            }
        }
        Ok(ApprovalReconciliation {
            saved,
            missing,
            deferred,
        })
    }
    fn request_staff_approval_using(
        &self,
        link_id: Uuid,
        session: u64,
        restart: bool,
        http: &impl ApprovalExchange,
    ) -> Result<(), VaultError> {
        let initial = self
            .delivery_links(session)?
            .into_iter()
            .find(|l| l.id == link_id)
            .ok_or(VaultError::NotFound)?;
        let recovery = self.reconcile_approvals(&initial, session, http)?;
        let mut link = recovery.saved;
        if crate::portal_approval::currently_approved(&link) {
            return Ok(());
        }
        if link
            .approval
            .iter()
            .chain(link.approval_history.iter())
            .any(|a| a.acceptance.is_some())
        {
            return Err(VaultError::ApprovalNeedsClinic);
        }
        if let Some(error) = recovery.deferred {
            return Err(error);
        }
        let now = crate::now_ms() / 1000;
        if restart {
            let prior = link.approval.as_ref().ok_or(VaultError::Invalid)?;
            if prior.state() == crate::portal_approval::ApprovalState::Refused {
                return Err(VaultError::ApprovalTerminal(prior.state(), prior.reason));
            }
            // The portal's word that the request expired stands even while
            // this device's clock says it has time left (#131).
            if prior.expires_at > now
                && !matches!(
                    prior.state(),
                    crate::portal_approval::ApprovalState::Cancelled
                        | crate::portal_approval::ApprovalState::Expired
                )
            {
                return Err(VaultError::Invalid);
            }
            if link.approval_history.len() + 1 >= crate::portal_approval::MAX_APPROVAL_REQUESTS {
                return Err(VaultError::ApprovalNeedsClinic);
            }
            let mut next = link.clone();
            next.approval_history.push(prior.clone());
            next.approval = Some(crate::portal_approval::create(&link, now)?);
            link = self.save_approval_state(&link, next, session, true)?;
        } else if link.approval.is_none() {
            let mut next = link.clone();
            next.approval = Some(crate::portal_approval::create(&link, now)?);
            link = self.save_approval_state(&link, next, session, false)?;
        } else {
            Self::approval_error(&link, false)?;
        }
        // A saved request is always retried byte-for-byte, including after its
        // local clock expiry. Only explicit restart creates another ID.
        self.delivery_links(session)?;
        let attempt = link.approval.as_ref().ok_or(VaultError::Invalid)?;
        let anchor = self.delivery_anchor(&link, session)?;
        let reply = http.post(&link, attempt, &anchor, &|| {
            self.portal_link_ticket() != session
        })?;
        let mut next = link.clone();
        next.approval = Some(reply);
        let saved = self.save_approval_state(&link, next, session, false)?;
        Self::approval_error(&saved, false)
    }
    pub(crate) fn refresh_staff_approval_for_check(
        &self,
        link: &StoredLink,
        session: u64,
        http: &impl ApprovalExchange,
    ) -> Result<(StoredLink, Option<VaultError>), VaultError> {
        let recovery = self.reconcile_approvals(link, session, http)?;
        Self::approval_error(&recovery.saved, recovery.missing)?;
        Ok((recovery.saved, recovery.deferred))
    }
    #[cfg(test)]
    fn refresh_staff_approval_using(
        &self,
        link: &StoredLink,
        session: u64,
        http: &impl ApprovalExchange,
    ) -> Result<StoredLink, VaultError> {
        let (saved, warning) = self.refresh_staff_approval_for_check(link, session, http)?;
        if let Some(error) = warning {
            return Err(error);
        }
        Ok(saved)
    }
}

#[cfg(all(test, feature = "portal-linking"))]
mod approval_recovery_tests {
    use super::*;
    use crate::portal_approval::{self, ApprovalReason as Reason, ApprovalState as State, Attempt};
    use std::collections::VecDeque;
    const PASSWORD: &str = "meadow-planet-copper-window-743";
    enum Reply {
        Accepted,
        /// Says "accepted" with a proof that is not this request's signed
        /// acceptance (#131): it must never count as approval.
        UnverifiedAccepted,
        Pending,
        Terminal(State, Reason),
        Missing,
        Network,
        RateLimited(Option<u64>),
    }
    struct Script<'a> {
        gets: Mutex<VecDeque<Reply>>,
        posts: Mutex<VecDeque<Reply>>,
        calls: Mutex<Vec<(&'static str, Uuid, String)>>,
        lock_on_get: Option<&'a VaultStore>,
        check_saved_on_post: Option<&'a VaultStore>,
        /// The portal's clock its replies give (Unix seconds).
        portal_time: Option<u64>,
        /// Other clinic work tried while a status read is under way.
        busy_on_get: Option<(&'a VaultStore, Uuid)>,
    }
    impl<'a> Script<'a> {
        fn new(gets: Vec<Reply>, posts: Vec<Reply>) -> Self {
            Self {
                gets: Mutex::new(gets.into()),
                posts: Mutex::new(posts.into()),
                calls: Mutex::new(Vec::new()),
                lock_on_get: None,
                check_saved_on_post: None,
                portal_time: None,
                busy_on_get: None,
            }
        }
        fn response(
            reply: Reply,
            link: &StoredLink,
            attempt: &Attempt,
        ) -> Result<Option<Attempt>, VaultError> {
            let fixture: serde_json::Value = serde_json::from_str(include_str!(
                "../../tests/fixtures/device-approval-contract-v1.json"
            ))
            .unwrap();
            let body = match reply {
                Reply::Missing => return Ok(None),
                Reply::Network => return Err(VaultError::Portal(portal_link::LinkError::Network)),
                Reply::RateLimited(wait) => {
                    return Err(VaultError::Portal(portal_link::LinkError::RateLimited(
                        wait,
                    )))
                }
                Reply::Accepted => {
                    serde_json::json!({"request_id":attempt.request_id,"status":"accepted","challenge":fixture["flows"]["first"]["challenge"]["compact"],"acceptance":fixture["flows"]["first"]["acceptance"]["compact"],"reason":null})
                }
                Reply::UnverifiedAccepted => {
                    // The clinic-signed challenge offered as the acceptance.
                    let challenge = &fixture["flows"]["first"]["challenge"]["compact"];
                    serde_json::json!({"request_id":attempt.request_id,"status":"accepted","challenge":challenge,"acceptance":challenge,"reason":null})
                }
                Reply::Pending => {
                    serde_json::json!({"request_id":attempt.request_id,"status":"pending","challenge":null,"acceptance":null,"reason":null})
                }
                Reply::Terminal(state, reason) => {
                    serde_json::json!({"request_id":attempt.request_id,"status":state,"challenge":null,"acceptance":null,"reason":reason})
                }
            };
            // Exercise the real strict HTTP response/proof parser. The script
            // supplies only synthetic wire replies, never a trusted boolean.
            decode(link, attempt, &serde_json::to_vec(&body).unwrap()).map(Some)
        }
    }
    fn decode(link: &StoredLink, attempt: &Attempt, bytes: &[u8]) -> Result<Attempt, VaultError> {
        portal_approval::parse_status(link, attempt, bytes)
    }
    impl ApprovalExchange for Script<'_> {
        fn get(
            &self,
            link: &StoredLink,
            attempt: &Attempt,
            _: &dyn Fn() -> bool,
        ) -> Result<Option<Attempt>, VaultError> {
            self.calls
                .lock()
                .unwrap()
                .push(("GET", attempt.request_id, attempt.intent.clone()));
            if let Some(store) = self.lock_on_get {
                store.lock();
            }
            if let Some((store, link_id)) = self.busy_on_get {
                let session = store.portal_link_ticket();
                let busy =
                    |error| matches!(error, VaultError::Portal(portal_link::LinkError::Busy));
                assert!(busy(
                    store
                        .request_staff_approval(link_id, session)
                        .err()
                        .unwrap()
                ));
                assert!(busy(
                    store
                        .restart_staff_approval(link_id, session)
                        .err()
                        .unwrap()
                ));
                assert!(busy(store.check_documents(session).err().unwrap()));
                assert!(busy(
                    store.poll_staff_approval(link_id, session).err().unwrap()
                ));
            }
            Self::response(
                self.gets
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("unexpected GET"),
                link,
                attempt,
            )
        }
        fn post(
            &self,
            link: &StoredLink,
            attempt: &Attempt,
            _: &str,
            _: &dyn Fn() -> bool,
        ) -> Result<Attempt, VaultError> {
            if let Some(store) = self.check_saved_on_post {
                let saved = store.delivery_links(store.portal_link_ticket()).unwrap();
                assert_eq!(
                    saved[0].approval.as_ref().unwrap().intent,
                    attempt.intent,
                    "intent must be durable before HTTP"
                );
                assert!(crate::vault::history_events_for_test(store)
                    .iter()
                    .any(|e| e.event == HistoryEvent::DeviceApprovalRequested));
            }
            self.calls
                .lock()
                .unwrap()
                .push(("POST", attempt.request_id, attempt.intent.clone()));
            Self::response(
                self.posts
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("unexpected POST"),
                link,
                attempt,
            )?
            .ok_or(VaultError::Invalid)
        }
        fn portal_time(&self) -> Option<u64> {
            self.portal_time
        }
    }
    fn new_connect_store() -> (tempfile::TempDir, VaultStore) {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "FAKE Connect Patient", 1).unwrap();
        (temp, store)
    }

    fn finish_connect_link(
        store: &VaultStore,
        session: u64,
    ) -> Result<portal_link::LinkSummary, VaultError> {
        store.link_portal_using(
            "https://fake.example",
            "FAKE0001-FAKE7-Q2M4K",
            "myCarlos FAKE device",
            None,
            (crate::now_ms(), session),
            |_, device_id, _| {
                let (_, fixture, _) = portal_approval::first_fixture();
                let mut clinic = fixture.clinic.unwrap();
                clinic.device_key_id = device_id.to_owned();
                Ok(clinic)
            },
        )
    }

    #[test]
    fn connect_submits_only_for_the_exact_durably_linked_device_without_granting_approval() {
        let (_temp, store) = new_connect_store();
        let session = store.portal_link_ticket();
        let mut http = Script::new(vec![], vec![Reply::Pending]);
        http.check_saved_on_post = Some(&store);
        let (result, error) = store
            .connect_portal_using(session, || finish_connect_link(&store, session), &http)
            .unwrap();
        assert!(error.is_none());
        assert!(!result.incomplete && result.approval_requested && !result.clinic_approved);
        let current = saved(&store);
        assert_eq!(current.id, result.id);
        assert_eq!(current.keys.device_key_id(), result.device_key_id);
        assert_eq!(
            store
                .session()
                .as_ref()
                .unwrap()
                .manifest
                .portal_links
                .len(),
            1
        );
        assert!(current.approval_history.is_empty());
        let calls = http.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0],
            (
                "POST",
                current.approval.as_ref().unwrap().request_id,
                current.approval.as_ref().unwrap().intent.clone()
            )
        );
    }

    #[test]
    fn connect_lost_approval_reply_keeps_the_original_link_keys_and_request_for_retry_after_reopen()
    {
        let (_temp, store) = new_connect_store();
        let session = store.portal_link_ticket();
        let http = Script::new(vec![], vec![Reply::Network]);
        let (result, error) = store
            .connect_portal_using(session, || finish_connect_link(&store, session), &http)
            .unwrap();
        assert!(matches!(
            error,
            Some(VaultError::Portal(portal_link::LinkError::Network))
        ));
        let original = saved(&store);
        assert_eq!(original.id, result.id);
        assert!(!result.incomplete && result.approval_requested && !result.clinic_approved);
        let store = restart(store);
        let http = Script::new(vec![Reply::Missing], vec![Reply::Pending]);
        store
            .request_staff_approval_using(result.id, store.portal_link_ticket(), false, &http)
            .unwrap();
        let retried = saved(&store);
        assert_eq!(original.id, retried.id);
        assert_eq!(original.keys.device_key_id(), retried.keys.device_key_id());
        assert_eq!(
            original.approval.as_ref().unwrap().request_id,
            retried.approval.as_ref().unwrap().request_id
        );
        assert_eq!(
            original.approval.as_ref().unwrap().intent,
            retried.approval.as_ref().unwrap().intent
        );
        assert!(retried.approval_history.is_empty());
        assert_eq!(
            store
                .session()
                .as_ref()
                .unwrap()
                .manifest
                .portal_links
                .len(),
            1
        );
    }

    #[test]
    fn connect_lock_and_reopen_between_link_and_request_never_posts_in_the_new_session() {
        let (_temp, store) = new_connect_store();
        let store = Arc::new(store);
        let session = store.portal_link_ticket();
        let locker = Arc::clone(&store);
        AT_TEST_BOUNDARY.with(|slot| {
            *slot.borrow_mut() = Some((
                "portal.connected-before-approval",
                Box::new(move || {
                    locker.lock();
                    locker.unlock(PASSWORD).unwrap();
                }),
            ));
        });
        let http = Script::new(vec![], vec![]);
        let result =
            store.connect_portal_using(session, || finish_connect_link(&store, session), &http);
        assert!(matches!(result, Err(VaultError::Cancelled)));
        assert!(http.calls.lock().unwrap().is_empty());
        let current = saved(&store);
        assert!(!current.summary().incomplete);
        assert!(current.approval.is_none());
        assert_eq!(
            store
                .session()
                .as_ref()
                .unwrap()
                .manifest
                .portal_links
                .len(),
            1
        );
    }

    #[test]
    fn connect_lost_link_reply_keeps_incomplete_attempt_without_requesting_approval() {
        let (_temp, store) = new_connect_store();
        let session = store.portal_link_ticket();
        let http = Script::new(vec![], vec![]);
        let result = store.connect_portal_using(
            session,
            || {
                store.link_portal_using(
                    "https://fake.example",
                    "FAKE0001-FAKE7-Q2M4K",
                    "myCarlos",
                    None,
                    (crate::now_ms(), session),
                    |_, _, _| Err(portal_link::LinkError::Network),
                )
            },
            &http,
        );
        assert!(matches!(
            result,
            Err(VaultError::Portal(portal_link::LinkError::Network))
        ));
        assert!(http.calls.lock().unwrap().is_empty());
        let guard = store.session();
        let links = &guard.as_ref().unwrap().manifest.portal_links;
        assert_eq!(links.len(), 1);
        assert!(links[0].summary().incomplete && links[0].approval.is_none());
        drop(guard);
        assert!(
            store.start_portal_work().is_ok(),
            "failed work releases admission"
        );
    }

    #[test]
    fn connect_shared_admission_rejects_repeated_callbacks_and_other_portal_work_without_queuing() {
        let (_temp, store) = new_connect_store();
        let session = store.portal_link_ticket();
        let running = store.start_portal_work().unwrap();
        let stale = session.wrapping_add(1);
        let busy = |error| matches!(error, VaultError::Portal(portal_link::LinkError::Busy));
        assert!(busy(
            store
                .connect_portal_using(
                    stale,
                    || panic!("duplicate link must not generate keys"),
                    &Script::new(vec![], vec![])
                )
                .err()
                .unwrap()
        ));
        assert!(busy(
            store
                .link_portal(
                    "https://fake.example",
                    "FAKE0001-FAKE7-Q2M4K",
                    "myCarlos",
                    None,
                    1,
                    stale
                )
                .err()
                .unwrap()
        ));
        assert!(busy(
            store
                .request_staff_approval(Uuid::nil(), stale)
                .err()
                .unwrap()
        ));
        assert!(busy(
            store
                .restart_staff_approval(Uuid::nil(), stale)
                .err()
                .unwrap()
        ));
        assert!(busy(store.check_documents(stale).err().unwrap()));
        assert!(
            store.snapshot().unwrap().portal_links.is_empty(),
            "local records remain readable"
        );
        drop(running);
        let http = Script::new(vec![], vec![Reply::Pending]);
        assert!(store
            .connect_portal_using(session, || finish_connect_link(&store, session), &http)
            .is_ok());
    }

    #[test]
    fn connect_recovery_mode_and_stale_tickets_never_link_or_request_approval() {
        for recovery in [false, true] {
            let (_temp, store) = new_connect_store();
            let session = store.portal_link_ticket();
            if recovery {
                store.session().as_mut().unwrap().recovery = Some(RecoveryReason::WriteFailed);
            } else {
                store.lock();
                store.unlock(PASSWORD).unwrap();
            }
            let before = store.session().as_ref().unwrap().manifest.clone();
            let http = Script::new(vec![], vec![]);
            let result = store.connect_portal_using(
                session,
                || {
                    store.link_portal_using(
                        "https://fake.example",
                        "FAKE0001-FAKE7-Q2M4K",
                        "myCarlos",
                        None,
                        (crate::now_ms(), session),
                        |_, _, _| panic!("ineligible session must not send HTTP"),
                    )
                },
                &http,
            );
            if recovery {
                assert!(matches!(result, Err(VaultError::RecoveryMode)));
            } else {
                assert!(matches!(
                    result,
                    Err(VaultError::Portal(portal_link::LinkError::Cancelled))
                ));
            }
            assert!(http.calls.lock().unwrap().is_empty());
            assert!(before == store.session().as_ref().unwrap().manifest);
        }
    }

    fn setup(saved: bool) -> (tempfile::TempDir, VaultStore, StoredLink, Attempt) {
        let (_, mut link, attempt) = portal_approval::first_fixture();
        if saved {
            link.approval = Some(attempt.clone());
        }
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "FAKE Approval Patient", 1).unwrap();
        store
            .mutate_recorded(|m, _| {
                m.portal_links.push(link.clone());
                Ok(())
            })
            .unwrap();
        (temp, store, link, attempt)
    }
    fn restart(store: VaultStore) -> VaultStore {
        let root = store.root.clone();
        store.lock();
        drop(store);
        let store = VaultStore::new(root);
        store.unlock(PASSWORD).unwrap();
        store
    }
    fn saved(store: &VaultStore) -> StoredLink {
        store
            .delivery_links(store.portal_link_ticket())
            .unwrap()
            .remove(0)
    }
    #[test]
    fn should_recover_original_acceptance_after_expiry_and_restart_before_request_or_explicit_restart(
    ) {
        for explicit_restart in [false, true] {
            let (_temp, store, link, attempt) = setup(true);
            let store = restart(store);
            assert!(attempt.expires_at < crate::now_ms() / 1000);
            let http = Script::new(vec![Reply::Accepted], vec![]);
            store
                .request_staff_approval_using(
                    link.id,
                    store.portal_link_ticket(),
                    explicit_restart,
                    &http,
                )
                .unwrap();
            let current = saved(&store);
            assert_eq!(
                current.approval.as_ref().unwrap().request_id,
                attempt.request_id
            );
            assert!(current.approval_history.is_empty());
            assert!(current.summary().clinic_approved);
            let calls = http.calls.lock().unwrap();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].0, "GET");
            assert_eq!(calls[0].1, attempt.request_id);
            let store = restart(store);
            assert!(saved(&store).summary().clinic_approved);
        }
    }
    #[test]
    fn should_retry_identical_expired_intent_after_lost_reply_without_minting_another_request() {
        let (_temp, store, link, attempt) = setup(true);
        let http = Script::new(vec![Reply::Missing], vec![Reply::Network]);
        assert!(store
            .request_staff_approval_using(link.id, store.portal_link_ticket(), false, &http)
            .is_err());
        let store = restart(store);
        let http = Script::new(vec![Reply::Missing], vec![Reply::Pending]);
        store
            .request_staff_approval_using(link.id, store.portal_link_ticket(), false, &http)
            .unwrap();
        let current = saved(&store);
        assert_eq!(
            current.approval.as_ref().unwrap().request_id,
            attempt.request_id
        );
        assert_eq!(current.approval.as_ref().unwrap().intent, attempt.intent);
        assert!(current.approval_history.is_empty());
        let calls = http.calls.lock().unwrap();
        assert_eq!(calls[1], ("POST", attempt.request_id, attempt.intent));
    }
    #[test]
    fn should_persist_terminal_get_status_and_reason_and_report_a_controlled_error() {
        for (state, reason) in [
            (State::Refused, Reason::StaffRequired),
            (State::Expired, Reason::ChallengeExpired),
            (State::Cancelled, Reason::ChallengeCancelled),
        ] {
            let (_temp, store, link, _) = setup(true);
            let http = Script::new(vec![Reply::Terminal(state, reason)], vec![]);
            assert!(
                matches!(store.refresh_staff_approval_using(&link,store.portal_link_ticket(),&http),Err(VaultError::ApprovalTerminal(s,Some(r))) if s==state && r==reason)
            );
            let store = restart(store);
            let current = saved(&store);
            assert_eq!(current.summary().approval_status, Some(state));
            assert_eq!(current.summary().approval_reason, Some(reason));
            assert!(!current.summary().clinic_approved);
            assert!(crate::vault::history_events_for_test(&store)
                .iter()
                .any(|e| e.event == HistoryEvent::DeviceApprovalStatusChanged));
        }
    }
    #[test]
    fn should_persist_terminal_post_response_after_durable_intent_and_return_an_error() {
        for (state, reason) in [
            (State::Refused, Reason::NoAcceptedApprover),
            (State::Expired, Reason::ChallengeExpired),
            (State::Cancelled, Reason::ChallengeCancelled),
        ] {
            let (_temp, store, link, _) = setup(false);
            let mut http = Script::new(vec![], vec![Reply::Terminal(state, reason)]);
            http.check_saved_on_post = Some(&store);
            assert!(
                matches!(store.request_staff_approval_using(link.id,store.portal_link_ticket(),false,&http),Err(VaultError::ApprovalTerminal(s,Some(r))) if s==state && r==reason)
            );
            drop(http);
            let store = restart(store);
            let current = saved(&store);
            assert_eq!(current.approval.as_ref().unwrap().state(), state);
            assert_eq!(current.approval.as_ref().unwrap().reason, Some(reason));
            assert!(!current.summary().clinic_approved);
        }
    }
    #[test]
    fn should_retain_prior_id_on_explicit_restart_and_recover_its_later_signed_acceptance() {
        let (_temp, store, link, attempt) = setup(true);
        let http = Script::new(
            vec![Reply::Terminal(State::Expired, Reason::ChallengeExpired)],
            vec![Reply::Pending],
        );
        store
            .request_staff_approval_using(link.id, store.portal_link_ticket(), true, &http)
            .unwrap();
        let current = saved(&store);
        assert_ne!(
            current.approval.as_ref().unwrap().request_id,
            attempt.request_id
        );
        assert_eq!(current.approval_history.len(), 1);
        assert_eq!(current.approval_history[0].intent, attempt.intent);
        let store = restart(store);
        let current = saved(&store);
        let http = Script::new(vec![Reply::Pending, Reply::Accepted], vec![]);
        let current = store
            .refresh_staff_approval_using(&current, store.portal_link_ticket(), &http)
            .unwrap();
        assert!(current.summary().clinic_approved);
        assert_eq!(current.approval_history[0].request_id, attempt.request_id);
        let store = restart(store);
        assert!(saved(&store).summary().clinic_approved);
    }
    #[test]
    fn should_preserve_original_request_when_status_reconciliation_fails() {
        let (_temp, store, link, attempt) = setup(true);
        let http = Script::new(vec![Reply::Network], vec![]);
        assert!(store
            .request_staff_approval_using(link.id, store.portal_link_ticket(), true, &http)
            .is_err());
        let current = saved(&store);
        assert_eq!(current.approval.as_ref().unwrap().intent, attempt.intent);
        assert!(current.approval_history.is_empty());
        assert_eq!(http.calls.lock().unwrap().len(), 1);
    }
    #[test]
    fn should_refuse_valid_late_status_after_lock_without_committing_approval() {
        let (_temp, store, link, attempt) = setup(true);
        let mut http = Script::new(vec![Reply::Accepted], vec![]);
        http.lock_on_get = Some(&store);
        assert!(matches!(
            store.request_staff_approval_using(link.id, store.portal_link_ticket(), false, &http),
            Err(VaultError::Cancelled)
        ));
        drop(http);
        store.unlock(PASSWORD).unwrap();
        let current = saved(&store);
        assert_eq!(
            current.approval.as_ref().unwrap().request_id,
            attempt.request_id
        );
        assert!(current.approval.as_ref().unwrap().acceptance.is_none());
        assert!(!current.summary().clinic_approved);
    }
    fn manifest(store: &VaultStore) -> Manifest {
        store.session().as_ref().unwrap().manifest.clone()
    }
    fn only_gets(http: &Script<'_>) -> Vec<Uuid> {
        let calls = http.calls.lock().unwrap();
        assert!(
            calls.iter().all(|(method, _, _)| *method == "GET"),
            "a status check must never send a request"
        );
        calls.iter().map(|(_, id, _)| *id).collect()
    }

    #[test]
    fn poll_only_reads_status_and_gives_time_left_by_the_portals_clock_not_this_devices() {
        let (_temp, store, link, attempt) = setup(true);
        let session = store.portal_link_ticket();
        let before = manifest(&store);
        // This device's clock is long past the request's expiry (the fixture
        // was made in the past); the portal's clock says 100 seconds are left.
        assert!(attempt.expires_at < crate::now_ms() / 1000);
        let mut http = Script::new(vec![Reply::Pending], vec![]);
        http.portal_time = Some(attempt.expires_at - 100);
        let check = store
            .poll_staff_approval_using(link.id, session, &http)
            .unwrap();
        assert!(check.issue.is_none());
        assert_eq!(check.expires_in_ms, Some(100_000));
        assert_eq!(check.link.approval_status, Some(State::Pending));
        assert!(!check.link.clinic_approved);
        assert_eq!(only_gets(&http), vec![attempt.request_id]);
        // Nothing changed, so nothing was written or added to the history.
        assert!(before == manifest(&store));
        // A portal that gives no time gives no countdown.
        let http = Script::new(vec![Reply::Pending], vec![]);
        let check = store
            .poll_staff_approval_using(link.id, session, &http)
            .unwrap();
        assert_eq!(check.expires_in_ms, None);
        // Nor does one whose clock is already past the expiry say time is left.
        let mut http = Script::new(vec![Reply::Pending], vec![]);
        http.portal_time = Some(attempt.expires_at + 5);
        let check = store
            .poll_staff_approval_using(link.id, session, &http)
            .unwrap();
        assert_eq!(check.expires_in_ms, Some(0));
    }

    #[test]
    fn poll_shows_approval_only_from_a_verified_acceptance_and_keeps_it_across_restart() {
        let (_temp, store, link, attempt) = setup(true);
        let session = store.portal_link_ticket();
        let mut http = Script::new(vec![Reply::UnverifiedAccepted], vec![]);
        http.portal_time = Some(attempt.expires_at - 60);
        let check = store
            .poll_staff_approval_using(link.id, session, &http)
            .unwrap();
        assert!(matches!(
            check.issue,
            Some(VaultError::Portal(portal_link::LinkError::InvalidResponse))
        ));
        assert!(!check.link.clinic_approved);
        assert_eq!(check.link.approval_status, Some(State::Pending));
        assert!(saved(&store)
            .approval
            .as_ref()
            .unwrap()
            .acceptance
            .is_none());
        // Pending, then a late but real signed acceptance.
        let mut http = Script::new(vec![Reply::Pending], vec![]);
        http.portal_time = Some(attempt.expires_at - 30);
        let check = store
            .poll_staff_approval_using(link.id, session, &http)
            .unwrap();
        assert!(!check.link.clinic_approved);
        let http = Script::new(vec![Reply::Accepted], vec![]);
        let check = store
            .poll_staff_approval_using(link.id, session, &http)
            .unwrap();
        assert!(check.issue.is_none());
        assert!(check.link.clinic_approved);
        assert_eq!(check.link.approval_status, Some(State::Accepted));
        assert_eq!(check.expires_in_ms, None);
        assert_eq!(only_gets(&http), vec![attempt.request_id]);
        assert!(crate::vault::history_events_for_test(&store)
            .iter()
            .any(|e| e.event == HistoryEvent::DeviceApprovalVerified));
        let store = restart(store);
        assert!(saved(&store).summary().clinic_approved);
        // An approved device needs no further reads.
        let http = Script::new(vec![], vec![]);
        let check = store
            .poll_staff_approval_using(link.id, store.portal_link_ticket(), &http)
            .unwrap();
        assert!(check.link.clinic_approved);
        assert!(http.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn poll_never_sends_or_starts_a_request_for_a_missing_or_finished_one() {
        for reply in [
            Reply::Missing,
            Reply::Terminal(State::Expired, Reason::ChallengeExpired),
            Reply::Terminal(State::Cancelled, Reason::ChallengeCancelled),
            Reply::Terminal(State::Refused, Reason::StaffRequired),
        ] {
            let terminal = match reply {
                Reply::Terminal(state, _) => Some(state),
                _ => None,
            };
            let (_temp, store, link, attempt) = setup(true);
            let session = store.portal_link_ticket();
            let mut http = Script::new(vec![reply], vec![]);
            http.portal_time = Some(attempt.expires_at - 60);
            let check = store
                .poll_staff_approval_using(link.id, session, &http)
                .unwrap();
            assert_eq!(only_gets(&http), vec![attempt.request_id]);
            let current = saved(&store);
            assert_eq!(
                current.approval.as_ref().unwrap().request_id,
                attempt.request_id
            );
            assert_eq!(current.approval.as_ref().unwrap().intent, attempt.intent);
            assert!(current.approval_history.is_empty());
            assert_eq!(check.expires_in_ms, None);
            assert!(!check.link.clinic_approved);
            match terminal {
                None => {
                    assert!(matches!(
                        check.issue,
                        Some(VaultError::ApprovalRequestMissing)
                    ));
                    assert_eq!(check.link.approval_status, Some(State::Pending));
                }
                Some(state) => {
                    assert!(check.issue.is_none());
                    assert_eq!(check.link.approval_status, Some(state));
                    assert_eq!(
                        check.link.approval_can_restart,
                        state != State::Refused,
                        "{state:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn poll_reports_an_unreachable_or_waiting_portal_without_calling_the_request_expired() {
        for reply in [
            Reply::Network,
            Reply::RateLimited(Some(30)),
            Reply::RateLimited(None),
        ] {
            let rate_limited = matches!(reply, Reply::RateLimited(_));
            let (_temp, store, link, attempt) = setup(true);
            let session = store.portal_link_ticket();
            let before = manifest(&store);
            let http = Script::new(vec![reply], vec![]);
            let check = store
                .poll_staff_approval_using(link.id, session, &http)
                .unwrap();
            assert_eq!(only_gets(&http), vec![attempt.request_id]);
            assert!(before == manifest(&store));
            assert_eq!(check.link.approval_status, Some(State::Pending));
            assert!(!check.link.clinic_approved);
            assert_eq!(check.expires_in_ms, None);
            let issue = check.issue.expect("the failure is reported");
            assert_eq!(
                matches!(
                    issue,
                    VaultError::Portal(portal_link::LinkError::RateLimited(_))
                ),
                rate_limited
            );
            assert!(matches!(issue, VaultError::Portal(_)));
        }
    }

    #[test]
    fn poll_shares_admission_ticket_and_recovery_rules_with_all_clinic_work() {
        let (_temp, store, link, attempt) = setup(true);
        let session = store.portal_link_ticket();
        let busy = |error| matches!(error, VaultError::Portal(portal_link::LinkError::Busy));
        // Another clinic operation holds the guard: refused at once, no HTTP.
        let running = store.start_portal_work().unwrap();
        let http = Script::new(vec![], vec![]);
        assert!(busy(
            store
                .poll_staff_approval_using(link.id, session, &http)
                .err()
                .unwrap()
        ));
        drop(running);
        // A check under way holds it in turn for every other clinic action.
        let mut http = Script::new(vec![Reply::Pending], vec![]);
        http.busy_on_get = Some((&store, link.id));
        store
            .poll_staff_approval_using(link.id, session, &http)
            .unwrap();
        drop(http);
        // A ticket from before a lock, recovery mode, and a lock during the
        // read: nothing is read, or what was read is not saved.
        let before = manifest(&store);
        let http = Script::new(vec![], vec![]);
        assert!(matches!(
            store.poll_staff_approval_using(link.id, session.wrapping_add(1), &http),
            Err(VaultError::Cancelled)
        ));
        store.session().as_mut().unwrap().recovery = Some(RecoveryReason::WriteFailed);
        assert!(matches!(
            store.poll_staff_approval_using(link.id, session, &http),
            Err(VaultError::RecoveryMode)
        ));
        store.session().as_mut().unwrap().recovery = None;
        assert!(http.calls.lock().unwrap().is_empty());
        assert!(before == manifest(&store));
        let mut http = Script::new(vec![Reply::Accepted], vec![]);
        http.lock_on_get = Some(&store);
        assert!(matches!(
            store.poll_staff_approval_using(link.id, session, &http),
            Err(VaultError::Cancelled)
        ));
        drop(http);
        store.unlock(PASSWORD).unwrap();
        let current = saved(&store);
        assert_eq!(
            current.approval.as_ref().unwrap().request_id,
            attempt.request_id
        );
        assert!(current.approval.as_ref().unwrap().acceptance.is_none());
        assert!(!current.summary().clinic_approved);
        assert!(matches!(
            store.poll_staff_approval_using(
                Uuid::nil(),
                store.portal_link_ticket(),
                &Script::new(vec![], vec![])
            ),
            Err(VaultError::NotFound)
        ));
    }

    #[test]
    fn restart_follows_the_portals_expiry_on_the_same_device_when_this_clock_is_behind() {
        let (_temp, store) = new_connect_store();
        let session = store.portal_link_ticket();
        let linked = finish_connect_link(&store, session).unwrap();
        store
            .request_staff_approval_using(
                linked.id,
                session,
                false,
                &Script::new(vec![], vec![Reply::Pending]),
            )
            .unwrap();
        let first = saved(&store);
        let old = first.approval.clone().unwrap();
        // By this device's clock the request still has minutes left.
        assert!(old.expires_at > crate::now_ms() / 1000 + 60);
        let http = Script::new(
            vec![Reply::Terminal(State::Expired, Reason::ChallengeExpired)],
            vec![],
        );
        let check = store
            .poll_staff_approval_using(linked.id, session, &http)
            .unwrap();
        assert_eq!(check.link.approval_status, Some(State::Expired));
        assert!(check.link.approval_can_restart);
        assert!(
            saved(&store).approval_history.is_empty(),
            "a poll never restarts"
        );
        // The patient starts a new request: the same link, keys and device.
        let http = Script::new(
            vec![Reply::Terminal(State::Expired, Reason::ChallengeExpired)],
            vec![Reply::Pending],
        );
        store
            .request_staff_approval_using(linked.id, session, true, &http)
            .unwrap();
        let current = saved(&store);
        assert_eq!(current.id, first.id);
        assert!(current.keys == first.keys);
        assert_eq!(current.keys.device_key_id(), linked.device_key_id);
        assert_eq!(manifest(&store).portal_links.len(), 1);
        assert_eq!(current.approval_history.len(), 1);
        assert_eq!(current.approval_history[0].request_id, old.request_id);
        assert_eq!(current.approval_history[0].intent, old.intent);
        assert_eq!(current.approval_history[0].state(), State::Expired);
        let new = current.approval.clone().unwrap();
        assert_ne!(new.request_id, old.request_id);
        {
            let calls = http.calls.lock().unwrap();
            assert_eq!(calls.len(), 2);
            assert_eq!(calls[0], ("GET", old.request_id, old.intent.clone()));
            assert_eq!(calls[1], ("POST", new.request_id, new.intent.clone()));
        }
        // Checking the new request reads both, and sends nothing.
        let http = Script::new(
            vec![
                Reply::Pending,
                Reply::Terminal(State::Expired, Reason::ChallengeExpired),
            ],
            vec![],
        );
        let check = store
            .poll_staff_approval_using(linked.id, session, &http)
            .unwrap();
        assert_eq!(check.link.approval_status, Some(State::Pending));
        assert_eq!(only_gets(&http), vec![new.request_id, old.request_id]);
    }

    #[test]
    fn poll_recovers_a_late_acceptance_of_the_old_request_after_a_new_one_started() {
        let (_temp, store, link, attempt) = setup(true);
        let session = store.portal_link_ticket();
        let http = Script::new(
            vec![Reply::Terminal(State::Expired, Reason::ChallengeExpired)],
            vec![Reply::Pending],
        );
        store
            .request_staff_approval_using(link.id, session, true, &http)
            .unwrap();
        let http = Script::new(vec![Reply::Pending, Reply::Accepted], vec![]);
        let check = store
            .poll_staff_approval_using(link.id, session, &http)
            .unwrap();
        assert!(check.link.clinic_approved);
        assert_eq!(check.expires_in_ms, None);
        let calls = only_gets(&http);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1], attempt.request_id);
        let store = restart(store);
        assert!(saved(&store).summary().clinic_approved);
    }

    fn add_signed_pending_delivery(store: &VaultStore) -> (StoredLink, Uuid, String) {
        let packet: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/java-delivery-interop-v1.json"
        ))
        .unwrap();
        assert_eq!(
            wire::sha256(include_bytes!(
                "../../tests/fixtures/java-delivery-interop-v1.json"
            )),
            "1072a30c81c71723b3470445ddf487ce8b362ef9d11ff4e94c1274d134cfa630"
        );
        let mut shared: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/delivery-contract.json"))
                .unwrap();
        shared["receiver"] = packet["receiver"].clone();
        let link = wire::tests::fixture_link(&shared);
        store
            .mutate_recorded(|m, _| {
                m.portal_links.push(link.clone());
                Ok(())
            })
            .unwrap();
        let outer: wire::Outer = serde_json::from_value(packet["outer"].clone()).unwrap();
        let sealed = wire::decode(packet["blob"].as_str().unwrap()).unwrap();
        // Reference-clock input is a checked-in synthetic Java package. Verify
        // its real HPKE/ES256 and actual CMS signature before exercising the
        // durable-store/HTTP boundary; this is not a live helper/UI test.
        let opened =
            wire::open(&outer, &sealed, &link, &[], packet["now"].as_u64().unwrap()).unwrap();
        let signed: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/mycarlos-signed-pdf-fixtures.json"
        ))
        .unwrap();
        let signed = &signed["documents"][0];
        let pdf = BASE64.decode(signed["pdf_b64"].as_str().unwrap()).unwrap();
        assert_eq!(opened.pdf.as_slice(), pdf);
        let manifest = BASE64
            .decode(signed["manifest_bytes_b64"].as_str().unwrap())
            .unwrap();
        let layout = crate::signed_pdf::SignatureLayout {
            byte_ranges: serde_json::from_value(signed["byte_ranges"].clone()).unwrap(),
            update_after_signature: false,
            encrypted: false,
        };
        let clinic = link.clinic.as_ref().unwrap();
        let pins = crate::signed_pdf::PinnedLink {
            clinic_id: clinic.clinic_id.clone(),
            recipient_id: clinic.recipient_id.clone(),
            signer_kids: clinic
                .clinic_keys
                .iter()
                .filter(|k| k.status == KeyStatus::Active)
                .map(|k| k.kid.clone())
                .collect(),
        };
        let crate::signed_pdf::Verdict::Verified {
            manifest: checked, ..
        } = crate::signed_pdf::check(&pdf, &layout, Some(&manifest), &[pins]).unwrap()
        else {
            panic!("actual signed original must match this test link");
        };
        let (id, added) = store
            .commit_delivery(
                &outer,
                opened,
                &link,
                &checked,
                crate::now_ms(),
                store.portal_link_ticket(),
            )
            .unwrap();
        assert!(added);
        let receipt = store
            .pending_receipts(&link, store.portal_link_ticket())
            .unwrap()[0]
            .receipt
            .clone();
        (link, id, receipt)
    }
    fn empty_page() -> crate::portal_client::ApiResponse {
        crate::portal_client::ApiResponse {
            status: 200,
            body: Zeroizing::new(
                br#"{"deliveries":[],"next_cursor":null,"through":"0","anchor_recorded":true}"#
                    .to_vec(),
            ),
            date: None,
            retry_after: None,
        }
    }
    fn picked_up() -> crate::portal_client::ApiResponse {
        crate::portal_client::ApiResponse {
            status: 200,
            body: Zeroizing::new(br#"{"status":"picked_up"}"#.to_vec()),
            date: None,
            retry_after: None,
        }
    }
    #[test]
    fn should_continue_a_second_links_real_saved_receipt_when_first_link_is_terminal() {
        let (_temp, store, first, _) = setup(true);
        let (healthy, id, receipt) = add_signed_pending_delivery(&store);
        let approvals = Script::new(
            vec![Reply::Terminal(State::Expired, Reason::ChallengeExpired)],
            vec![],
        );
        let calls = Mutex::new(Vec::new());
        let result = crate::portal_pickup::check_using(
            &store,
            store.portal_link_ticket(),
            &approvals,
            |link, method, path, body, _, _, _| {
                assert_eq!(
                    link.id, healthy.id,
                    "terminal first link must not block or list the healthy one"
                );
                calls.lock().unwrap().push(method.to_owned());
                if path.ends_with("/receipt") {
                    assert_eq!(method, "POST");
                    assert_eq!(
                        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["receipt"],
                        receipt
                    );
                    Ok(picked_up())
                } else {
                    Ok(empty_page())
                }
            },
        )
        .unwrap();
        assert_eq!(result.issues.len(), 1);
        assert_eq!(result.issues[0].link_id, first.id);
        assert_eq!(result.issues[0].code, "approval_expired");
        assert_eq!(result.receipts_pending, 0);
        assert!(calls.lock().unwrap().iter().any(|m| m == "POST"));
        let store = restart(store);
        let links = store.delivery_links(store.portal_link_ticket()).unwrap();
        let healthy = links.iter().find(|l| l.id == healthy.id).unwrap();
        assert!(store
            .pending_receipts(healthy, store.portal_link_ticket())
            .unwrap()
            .is_empty());
        let guard = store.session();
        let open = guard.as_ref().unwrap();
        assert!(
            open.manifest
                .records
                .iter()
                .find(|r| r.id == id)
                .unwrap()
                .delivery
                .as_ref()
                .unwrap()
                .receipt_outcome
                == Some(wire::ReceiptOutcome::PickedUp)
        );
        assert_eq!(
            links
                .iter()
                .find(|l| l.id == first.id)
                .unwrap()
                .summary()
                .approval_status,
            Some(State::Expired)
        );
    }
    #[test]
    fn should_return_real_pending_count_on_lost_reply_and_retry_identical_receipt_after_restart() {
        let (_temp, store, _, _) = setup(false);
        let (healthy, _, receipt) = add_signed_pending_delivery(&store);
        let bodies = Mutex::new(Vec::new());
        let approvals = Script::new(vec![], vec![]);
        let result = crate::portal_pickup::check_using(
            &store,
            store.portal_link_ticket(),
            &approvals,
            |link, _, path, body, _, _, _| {
                if path.ends_with("/receipt") {
                    assert_eq!(link.id, healthy.id);
                    bodies.lock().unwrap().push(body);
                    Err(portal_link::LinkError::Network)
                } else {
                    Ok(empty_page())
                }
            },
        )
        .unwrap();
        assert_eq!(result.receipts_pending, 1);
        assert_eq!(result.issues.len(), 1);
        assert_eq!(result.issues[0].link_id, healthy.id);
        let store = restart(store);
        let result = crate::portal_pickup::check_using(
            &store,
            store.portal_link_ticket(),
            &approvals,
            |_, _, path, body, _, _, _| {
                if path.ends_with("/receipt") {
                    bodies.lock().unwrap().push(body);
                    Ok(picked_up())
                } else {
                    Ok(empty_page())
                }
            },
        )
        .unwrap();
        assert_eq!(result.receipts_pending, 0);
        assert!(result.issues.is_empty());
        let bodies = bodies.lock().unwrap();
        assert_eq!(bodies.len(), 2);
        assert_eq!(bodies[0], bodies[1]);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bodies[1]).unwrap()["receipt"],
            receipt
        );
    }
    #[test]
    fn should_stop_all_link_processing_on_global_lock_cancellation() {
        let (_temp, store, _, _) = setup(true);
        let (healthy, _, _) = add_signed_pending_delivery(&store);
        let mut http = Script::new(vec![Reply::Accepted], vec![]);
        http.lock_on_get = Some(&store);
        assert!(matches!(
            crate::portal_pickup::check_using(
                &store,
                store.portal_link_ticket(),
                &http,
                |_, _, _, _, _, _, _| panic!("no later-link HTTP after lock")
            ),
            Err(VaultError::Cancelled)
        ));
        drop(http);
        store.unlock(PASSWORD).unwrap();
        assert_eq!(
            store
                .pending_receipts(&healthy, store.portal_link_ticket())
                .unwrap()
                .len(),
            1
        );
    }
    fn with_archives(store: &VaultStore, count: usize) -> StoredLink {
        let mut link = saved(store);
        for _ in 0..count {
            link.approval_history
                .push(portal_approval::create(&link, crate::now_ms() / 1000).unwrap());
        }
        store
            .mutate_recorded(|m, _| {
                m.portal_links[0] = link.clone();
                Ok(())
            })
            .unwrap();
        link
    }
    #[test]
    fn should_commit_current_acceptance_before_a_broken_archive_can_be_fetched() {
        let (_temp, store, _, _) = setup(true);
        let link = with_archives(&store, 1);
        let http = Script::new(vec![Reply::Accepted, Reply::Network], vec![]);
        let current = store
            .refresh_staff_approval_using(&link, store.portal_link_ticket(), &http)
            .unwrap();
        assert!(current.summary().clinic_approved);
        assert_eq!(http.calls.lock().unwrap().len(), 1);
        let store = restart(store);
        assert!(saved(&store).summary().clinic_approved);
        assert!(crate::vault::history_events_for_test(&store)
            .iter()
            .any(|e| e.event == HistoryEvent::DeviceApprovalVerified));
    }
    #[test]
    fn should_commit_terminal_current_state_before_an_archive_network_error() {
        let (_temp, store, _, _) = setup(true);
        let link = with_archives(&store, 1);
        let http = Script::new(
            vec![
                Reply::Terminal(State::Cancelled, Reason::ChallengeCancelled),
                Reply::Network,
            ],
            vec![],
        );
        assert!(matches!(
            store.refresh_staff_approval_using(&link, store.portal_link_ticket(), &http),
            Err(VaultError::ApprovalTerminal(
                State::Cancelled,
                Some(Reason::ChallengeCancelled)
            ))
        ));
        let store = restart(store);
        let current = saved(&store);
        assert_eq!(current.approval.as_ref().unwrap().state(), State::Cancelled);
        assert_eq!(
            current.approval_history[0].intent,
            link.approval_history[0].intent
        );
        assert!(crate::vault::history_events_for_test(&store)
            .iter()
            .any(|e| e.event == HistoryEvent::DeviceApprovalStatusChanged));
    }
    #[test]
    fn should_keep_earlier_archive_terminal_update_and_allow_mailbox_when_a_later_archive_fails() {
        let (_temp, store, _, _) = setup(true);
        let link = with_archives(&store, 2);
        let http = Script::new(
            vec![
                Reply::Pending,
                Reply::Terminal(State::Refused, Reason::StaffRequired),
                Reply::Network,
            ],
            vec![],
        );
        let calls = Mutex::new(0);
        let result = crate::portal_pickup::check_using(
            &store,
            store.portal_link_ticket(),
            &http,
            |_, _, _, _, _, _, _| {
                *calls.lock().unwrap() += 1;
                Ok(empty_page())
            },
        )
        .unwrap();
        assert_eq!(*calls.lock().unwrap(), 1);
        assert_eq!(result.issues.len(), 1);
        assert!(!saved(&store).summary().clinic_approved);
        let store = restart(store);
        let current = saved(&store);
        assert_eq!(current.approval_history[0].state(), State::Refused);
        assert_eq!(
            current.approval_history[0].reason,
            Some(Reason::StaffRequired)
        );
        assert_eq!(
            current.approval_history[1].intent,
            link.approval_history[1].intent
        );
    }
    #[test]
    fn should_preserve_exact_pending_and_accepted_format6_approval_evidence_during_upgrade() {
        for accepted in [false, true] {
            let (_temp, store, link, attempt) = setup(true);
            let evidence = if accepted {
                Script::response(Reply::Accepted, &link, &attempt)
                    .unwrap()
                    .unwrap()
            } else {
                attempt
            };
            let (master, mut old) = {
                let guard = store.session();
                let open = guard.as_ref().unwrap();
                (Zeroizing::new(*open.master_key), open.manifest.clone())
            };
            old.format_version = 6;
            let mut legacy = evidence.clone();
            legacy.status = None;
            legacy.reason = None;
            old.portal_links[0].approval = Some(legacy.clone());
            assert!(serde_json::to_value(&legacy)
                .unwrap()
                .get("status")
                .is_none());
            assert!(serde_json::to_value(&legacy)
                .unwrap()
                .get("reason")
                .is_none());
            store.lock();
            for _ in 0..2 {
                old.generation += 1;
                write_manifest_at(&store.root, &master, &old).unwrap();
            }
            let root = store.root.clone();
            drop(store);
            let store = VaultStore::new(root);
            store.unlock(PASSWORD).unwrap();
            let current = saved(&store);
            assert_eq!(current.approval.as_ref().unwrap().intent, legacy.intent);
            assert_eq!(
                current.approval.as_ref().unwrap().challenge,
                legacy.challenge
            );
            assert_eq!(
                current.approval.as_ref().unwrap().acceptance,
                legacy.acceptance
            );
            assert_eq!(current.summary().clinic_approved, accepted);
            assert_eq!(
                store.session().as_ref().unwrap().manifest.format_version,
                VAULT_FORMAT
            );
        }
    }
    #[test]
    fn should_hide_restart_and_keep_clinic_guidance_when_all_request_slots_are_retained() {
        let (_temp, store, _, _) = setup(true);
        let link = with_archives(&store, portal_approval::MAX_APPROVAL_REQUESTS - 1);
        assert!(!link.summary().approval_can_restart);
        assert!(link.summary().approval_request_limit_reached);
        let store = restart(store);
        assert_eq!(
            saved(&store).approval_history.len(),
            portal_approval::MAX_APPROVAL_REQUESTS - 1
        );
    }
}

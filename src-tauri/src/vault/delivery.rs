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

/// One link's unsettled receipts: the ones whose documents still read back,
/// and how many were skipped because a document the vault still shows is
/// damaged.
#[cfg(feature = "portal-linking")]
#[derive(Default)]
pub(crate) struct PendingReceipts {
    pub ready: Vec<Custody>,
    pub damaged: usize,
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

/// How far one clinic code request has got in this run of the app (clinic
/// code v1). Never the code itself.
#[cfg(feature = "portal-linking")]
#[derive(Clone, Copy, Default)]
pub(super) struct CodeProgress {
    /// Codes typed that did not match this clinic. None of them was sent.
    mismatches: u8,
    /// The portal took a code; the clinic has yet to answer.
    pub(super) submitted: bool,
    /// No more codes are taken for this request.
    pub(super) locked: bool,
}

/// After this many codes that do not match the clinic, a request takes no
/// more (clinic code v1).
#[cfg(feature = "portal-linking")]
const MAX_CODE_MISMATCHES: u8 = 5;

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
    #[cfg(test)]
    pub(crate) fn pending_receipts(
        &self,
        link: &StoredLink,
        session: u64,
    ) -> Result<Vec<Custody>, VaultError> {
        Ok(self.pending_receipts_checked(link, session)?.ready)
    }
    /// Unsettled receipts for one link. A record whose saved objects no longer
    /// read back (damaged or missing) is not returned: it is never
    /// acknowledged, and it does not stop the other records or clinics from
    /// being checked. It is counted in `damaged` while the vault still shows
    /// it; once the patient has removed it as damaged it is held without
    /// being counted, and if its file comes back intact its receipt is ready
    /// again.
    pub(crate) fn pending_receipts_checked(
        &self,
        link: &StoredLink,
        session: u64,
    ) -> Result<PendingReceipts, VaultError> {
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
        let mut pending = PendingReceipts::default();
        for record in &open.manifest.records {
            if let Some(c) = &record.delivery {
                if c.link_id == link.id && c.receipt_outcome.is_none() {
                    // A restored/damaged object must never be acknowledged merely
                    // because its metadata and old receipt are still readable.
                    let readable = record.objects().try_for_each(|object| {
                        read_object_ref(
                            &self.root.join("objects").join(object.object_name),
                            open.manifest.vault_id,
                            &keys,
                            object,
                            io::sink(),
                        )
                    });
                    match readable {
                        Ok(()) => pending.ready.push(c.clone()),
                        // Damage stays until the patient restores a good copy;
                        // a failed read that a retry can get past still stops.
                        Err(VaultError::Corrupt) => {
                            if object_required(record) {
                                pending.damaged += 1;
                            }
                        }
                        Err(error) => return Err(error),
                    }
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
    /// For a request still open: the time the portal leaves it. Its end
    /// (`expires_at`) was set from this device's clock when the request was
    /// made, but the portal enforces that same number with its own clock, so
    /// what is left is counted from the portal's clock when it replied (its
    /// `Date` header), not from this device's. Display only: it never
    /// decides a state, and `None` when the portal gave no time.
    pub expires_in_ms: Option<u64>,
    /// Why the check could not finish (no connection, a refusal, a portal
    /// asking to wait, a reply that did not verify, a request it does not
    /// have). What the check could read before it is still saved; the
    /// failure itself saves nothing.
    pub issue: Option<VaultError>,
    /// The vault went into read-only recovery during the check (a save that
    /// reached only one copy): the renderer must read the vault again.
    pub recovery: bool,
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
        Ok((self.link_summary(&current), approval_error))
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
    pub(super) fn code_progress(&self, request_id: Uuid) -> CodeProgress {
        self.approval_codes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&request_id)
            .copied()
            .unwrap_or_default()
    }
    fn update_code_progress(&self, request_id: Uuid, change: impl FnOnce(&mut CodeProgress)) {
        change(
            self.approval_codes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .entry(request_id)
                .or_default(),
        );
    }
    /// Takes the code the patient typed for this link's open code request
    /// (clinic code v1). It is checked here first, against the clinic key that
    /// signed the request's verified challenge, this device and this request:
    /// a code that does not match is never sent, and after five of those the
    /// request takes no more. A code that matches is sent to the portal in a
    /// signed device request; the clinic's answer comes through the usual
    /// status checks. The code is never saved or logged.
    pub(crate) fn submit_approval_code(
        &self,
        link_id: Uuid,
        typed: &str,
        session: u64,
    ) -> Result<(), VaultError> {
        self.submit_approval_code_using(link_id, typed, session, &ApprovalHttp::default())
    }
    fn submit_approval_code_using(
        &self,
        link_id: Uuid,
        typed: &str,
        session: u64,
        http: &impl ApprovalExchange,
    ) -> Result<(), VaultError> {
        let _running = self.start_portal_work()?;
        // Refuses a locked vault, another session's ticket and recovery mode.
        let link = self
            .delivery_links(session)?
            .into_iter()
            .find(|l| l.id == link_id)
            .ok_or(VaultError::NotFound)?;
        let attempt = link
            .approval
            .as_ref()
            .filter(|attempt| {
                !crate::portal_approval::currently_approved(&link)
                    && attempt.acceptance.is_none()
                    && attempt.state() == crate::portal_approval::ApprovalState::ChallengeReady
            })
            .ok_or(VaultError::ApprovalCodeNotOpen)?;
        let kid = crate::portal_approval::code_challenge_kid(&link, attempt)?;
        if self.code_progress(attempt.request_id).locked {
            return Err(VaultError::ApprovalCodeLocked);
        }
        let digits = crate::portal_approval::code_digits(typed)?;
        let (code_r, check) = digits.split_at(6);
        let expected = crate::portal_approval::code_check(
            &kid,
            &link.keys.device_key_id(),
            &attempt.request_id.to_string(),
            code_r,
        );
        if expected.as_str() != check {
            let mut locked = false;
            self.update_code_progress(attempt.request_id, |progress| {
                progress.mismatches = progress.mismatches.saturating_add(1);
                progress.locked |= progress.mismatches >= MAX_CODE_MISMATCHES;
                locked = progress.locked;
            });
            return Err(if locked {
                VaultError::ApprovalCodeLocked
            } else {
                VaultError::ApprovalCodeMismatch
            });
        }
        let anchor = self.delivery_anchor(&link, session)?;
        let cancelled = || self.portal_link_ticket() != session;
        let sent = http.submit_code(&link, attempt, code_r, &anchor, &cancelled);
        // Kept even if the vault locked meanwhile: the portal has the code.
        match &sent {
            Ok(()) => {
                self.update_code_progress(attempt.request_id, |progress| progress.submitted = true)
            }
            Err(VaultError::ApprovalCodeLocked) => {
                self.update_code_progress(attempt.request_id, |progress| progress.locked = true)
            }
            Err(_) => {}
        }
        if cancelled() {
            return Err(VaultError::Cancelled);
        }
        sent
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
        // The first failure ends the check: a patient's own clinic action
        // waits for it, and should not wait behind more time-outs.
        let recovery = self.reconcile_approvals(&find()?, session, http, true)?;
        // Publish only the persisted state, read again in the same session.
        // Read directly: a save during this check that reached only one copy
        // has just put the vault into read-only recovery, which the caller
        // must be told, with the state that was saved.
        if self.portal_link_ticket() != session {
            return Err(VaultError::Cancelled);
        }
        let (current, in_recovery) = {
            let guard = self.session();
            let open = guard.as_ref().ok_or(VaultError::Locked)?;
            let current = open
                .manifest
                .portal_links
                .iter()
                .find(|l| l.id == link_id && l.clinic.is_some())
                .cloned()
                .ok_or(VaultError::NotFound)?;
            (current, open.recovery.is_some())
        };
        let mut link = self.link_summary(&current);
        let open = !link.clinic_approved
            && matches!(
                link.approval_status,
                Some(
                    crate::portal_approval::ApprovalState::Pending
                        | crate::portal_approval::ApprovalState::ChallengeReady
                )
            );
        // The portal's clock when it can stand for it, else this device's:
        // the same choice the restart makes.
        let local_now = crate::now_ms() / 1000;
        let portal_now = current.approval.as_ref().and_then(|attempt| {
            crate::portal_approval::deciding_portal_time(
                http.portal_time(),
                &current,
                attempt,
                !recovery.missing,
                local_now,
            )
        });
        link.approval_can_restart =
            crate::portal_approval::can_restart(&current, portal_now.unwrap_or(local_now));
        let mut expires_in_ms = None;
        if let (Some(attempt), Some(portal_now)) = (&current.approval, portal_now) {
            if open && !recovery.missing && recovery.deferred.is_none() {
                let end = crate::portal_approval::request_expires_at(&current, attempt);
                expires_in_ms = Some(end.saturating_sub(portal_now) * 1000);
            }
        }
        Ok(ApprovalCheck {
            link,
            expires_in_ms,
            issue: if recovery.missing {
                Some(VaultError::ApprovalRequestMissing)
            } else {
                recovery.deferred
            },
            recovery: in_recovery,
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
    /// Reads the portal's status of each request of `link` not yet accepted
    /// (the current one, then kept older ones) and saves what changed. A
    /// portal asking to wait ends it at once; with `stop_early`, so does any
    /// other failure (the status check); otherwise the first is kept and the
    /// rest are still read.
    fn reconcile_approvals(
        &self,
        link: &StoredLink,
        session: u64,
        http: &impl ApprovalExchange,
        stop_early: bool,
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
                // The portal asked to wait: nothing more is asked of it now,
                // not even the older requests (#131).
                Err(error @ VaultError::Portal(portal_link::LinkError::RateLimited(_))) => {
                    return Ok(ApprovalReconciliation {
                        saved,
                        missing: false,
                        deferred: Some(error),
                    });
                }
                Err(error) if crate::portal_pickup::is_per_link_failure(&error) => {
                    if stop_early {
                        return Ok(ApprovalReconciliation {
                            saved,
                            missing: false,
                            deferred: Some(error),
                        });
                    }
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
                Err(error @ VaultError::Portal(portal_link::LinkError::RateLimited(_))) => {
                    return Ok(ApprovalReconciliation {
                        saved,
                        missing,
                        deferred: Some(error),
                    });
                }
                Err(error) if crate::portal_pickup::is_per_link_failure(&error) => {
                    if stop_early {
                        return Ok(ApprovalReconciliation {
                            saved,
                            missing,
                            deferred: Some(error),
                        });
                    }
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
        let recovery = self.reconcile_approvals(&initial, session, http, false)?;
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
            // The portal's word, and its clock, decide whether the request
            // is still open (#131). It would accept a second open request
            // for this device, so none is started while the one it has can
            // still be approved. Its clock is used only when it can stand
            // for it (`portal_clock`); otherwise, or when it does not have
            // the request, this device's clock decides, so a stuck or far-off
            // date can never hold a new request back for good.
            let clock = crate::portal_approval::deciding_portal_time(
                http.portal_time(),
                &link,
                prior,
                !recovery.missing,
                now,
            );
            if !crate::portal_approval::request_ended(&link, prior, clock.unwrap_or(now)) {
                // "Still open on the portal" only when the portal has it.
                return Err(if recovery.missing {
                    VaultError::ApprovalRequestMissing
                } else {
                    VaultError::ApprovalStillOpen
                });
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
        let recovery = self.reconcile_approvals(link, session, http, false)?;
        // The portal asked to wait: this link's document check stops here
        // too, rather than asking it again at once.
        if let Some(error @ VaultError::Portal(portal_link::LinkError::RateLimited(_))) =
            recovery.deferred
        {
            return Err(error);
        }
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
        /// "Challenge ready" with this clinic-signed challenge.
        ChallengeReady(String),
        Terminal(State, Reason),
        Missing,
        Network,
        RateLimited(Option<u64>),
        /// The portal answered with another status (maintenance, a refused
        /// device assertion…).
        Refused(u16),
        /// The portal says this device was removed from the account.
        DeviceRemoved,
        /// "Accepted" with this signed challenge and acceptance.
        AcceptedWith(String, String),
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
        /// Replies to sent codes, in order; a code sent with none left fails
        /// the test.
        code_replies: Mutex<VecDeque<Result<(), VaultError>>>,
        /// Each code sent: request id, the 6 digits, and the vault anchor.
        sent_codes: Mutex<Vec<(Uuid, String, String)>>,
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
                code_replies: Mutex::new(VecDeque::new()),
                sent_codes: Mutex::new(Vec::new()),
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
                Reply::Refused(status) => {
                    return Err(VaultError::Portal(portal_link::LinkError::HttpRefused(
                        status, None,
                    )))
                }
                Reply::DeviceRemoved => {
                    return Err(VaultError::Portal(portal_link::LinkError::DeviceRemoved))
                }
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
                Reply::AcceptedWith(challenge, acceptance) => {
                    serde_json::json!({"request_id":attempt.request_id,"status":"accepted","challenge":challenge,"acceptance":acceptance,"reason":null})
                }
                Reply::ChallengeReady(challenge) => {
                    serde_json::json!({"request_id":attempt.request_id,"status":"challenge_ready","challenge":challenge,"acceptance":null,"reason":null})
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
                assert!(busy(
                    store
                        .submit_approval_code(link_id, "000000000", session)
                        .err()
                        .unwrap()
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
        fn submit_code(
            &self,
            _: &StoredLink,
            attempt: &Attempt,
            code_r: &str,
            anchor: &str,
            _: &dyn Fn() -> bool,
        ) -> Result<(), VaultError> {
            self.sent_codes.lock().unwrap().push((
                attempt.request_id,
                code_r.to_owned(),
                anchor.to_owned(),
            ));
            self.code_replies
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected code sent")
        }
    }
    /// A vault whose one link has an open request that the clinic answered
    /// with a code challenge (clinic code v1), and the code that matches it.
    fn code_setup() -> (tempfile::TempDir, VaultStore, StoredLink, String) {
        let (_, mut link, mut attempt) = portal_approval::first_fixture();
        attempt.challenge = Some(portal_approval::fixture_challenge_with(|c| {
            c["approval_kind"] = "code".into()
        }));
        attempt.status = Some(State::ChallengeReady);
        link.approval = Some(attempt.clone());
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "FAKE Code Patient", 1).unwrap();
        store
            .mutate_recorded(|m, _| {
                m.portal_links.push(link.clone());
                Ok(())
            })
            .unwrap();
        let code = code_for(&link, &link.clinic.as_ref().unwrap().clinic_keys[0].kid);
        (temp, store, link, code)
    }
    /// The 9-digit code `482193` + check digits made with `kid` for this
    /// link's device and current request.
    fn code_for(link: &StoredLink, kid: &str) -> String {
        let attempt = link.approval.as_ref().unwrap();
        format!(
            "482193{}",
            portal_approval::code_check(
                kid,
                &link.keys.device_key_id(),
                &attempt.request_id.to_string(),
                "482193"
            )
            .as_str()
        )
    }
    fn shown(store: &VaultStore) -> portal_link::LinkSummary {
        store.snapshot().unwrap().portal_links.remove(0)
    }
    #[test]
    fn should_check_a_code_natively_and_never_send_one_that_does_not_match_this_clinic() {
        let (_temp, store, link, code) = code_setup();
        let attempt = link.approval.as_ref().unwrap();
        let session = store.portal_link_ticket();
        let script = Script::new(vec![], vec![]);
        let submit =
            |typed: &str| store.submit_approval_code_using(link.id, typed, session, &script);
        // Not 9 digits: refused before any check, and not counted.
        for typed in ["48219364", "482 193 64x", ""] {
            assert!(matches!(submit(typed), Err(VaultError::Invalid)));
        }
        // A code made for another clinic key (a look-alike portal's), another
        // device, another request, or with a digit wrong.
        let other_device = portal_approval::code_check(
            &link.clinic.as_ref().unwrap().clinic_keys[0].kid,
            "FAKE-device-key-0002",
            &attempt.request_id.to_string(),
            "482193",
        );
        let other_request = portal_approval::code_check(
            &link.clinic.as_ref().unwrap().clinic_keys[0].kid,
            &link.keys.device_key_id(),
            &Uuid::new_v4().to_string(),
            "482193",
        );
        let mut typo = code.clone().into_bytes();
        typo[0] = if typo[0] == b'9' { b'0' } else { typo[0] + 1 };
        let wrong = [
            code_for(&link, "FAKE-kid-clinic-B-0001"),
            format!("482193{}", other_device.as_str()),
            format!("482193{}", other_request.as_str()),
            String::from_utf8(typo).unwrap(),
        ]
        .into_iter()
        .filter(|candidate| candidate != &code)
        .collect::<Vec<_>>();
        assert!(wrong.len() >= 3, "the check digits tell these apart");
        let mut tries = 0;
        for candidate in wrong.iter().cycle() {
            tries += 1;
            let result = submit(candidate);
            if tries < 5 {
                assert!(
                    matches!(result, Err(VaultError::ApprovalCodeMismatch)),
                    "{tries}"
                );
                assert!(!shown(&store).approval_code_locked);
            } else {
                // The fifth says that no more are taken.
                assert!(matches!(result, Err(VaultError::ApprovalCodeLocked)));
                break;
            }
        }
        assert!(shown(&store).approval_code_locked);
        // Now even the right code is refused, and still nothing was sent.
        assert!(matches!(submit(&code), Err(VaultError::ApprovalCodeLocked)));
        assert!(script.sent_codes.lock().unwrap().is_empty());
        let summary = shown(&store);
        assert!(summary.approval_by_code && !summary.approval_code_submitted);
    }
    #[test]
    fn should_send_a_matching_code_with_the_vault_anchor_and_show_it_submitted_until_accepted() {
        let (_temp, store, link, code) = code_setup();
        let attempt = link.approval.clone().unwrap();
        let session = store.portal_link_ticket();
        let script = Script::new(vec![], vec![]);
        script.code_replies.lock().unwrap().push_back(Ok(()));
        let summary = shown(&store);
        assert!(summary.approval_by_code);
        assert!(!summary.approval_code_submitted && !summary.approval_code_locked);
        // Typed as the email shows it.
        let typed = format!("{} {}-{}", &code[..3], &code[3..6], &code[6..]);
        store
            .submit_approval_code_using(link.id, &typed, session, &script)
            .unwrap();
        assert_eq!(
            *script.sent_codes.lock().unwrap(),
            vec![(
                attempt.request_id,
                "482193".to_owned(),
                store.delivery_anchor(&link, session).unwrap()
            )]
        );
        let summary = shown(&store);
        assert!(summary.approval_code_submitted && !summary.clinic_approved);
        // The usual status check then finds the clinic's code acceptance.
        let challenge = attempt.challenge.clone().unwrap();
        let acceptance = portal_approval::fixture_acceptance_with(&challenge, |a| {
            a["approval_kind"] = "code".into()
        });
        let check = Script::new(vec![Reply::AcceptedWith(challenge, acceptance)], vec![]);
        let found = store
            .poll_staff_approval_using(link.id, session, &check)
            .unwrap();
        assert!(found.link.clinic_approved && found.link.approval_by_code);
        assert!(saved(&store).summary().clinic_approved);
        // Approved: no code is taken any more, and none is sent.
        assert!(matches!(
            store.submit_approval_code_using(link.id, &code, session, &script),
            Err(VaultError::ApprovalCodeNotOpen)
        ));
        assert_eq!(script.sent_codes.lock().unwrap().len(), 1);
    }
    #[test]
    fn should_take_no_more_codes_once_the_portal_has_had_five() {
        let (_temp, store, link, code) = code_setup();
        let session = store.portal_link_ticket();
        let script = Script::new(vec![], vec![]);
        script
            .code_replies
            .lock()
            .unwrap()
            .push_back(Err(VaultError::ApprovalCodeLocked));
        assert!(matches!(
            store.submit_approval_code_using(link.id, &code, session, &script),
            Err(VaultError::ApprovalCodeLocked)
        ));
        assert!(shown(&store).approval_code_locked);
        assert!(matches!(
            store.submit_approval_code_using(link.id, &code, session, &script),
            Err(VaultError::ApprovalCodeLocked)
        ));
        assert_eq!(script.sent_codes.lock().unwrap().len(), 1);
        // The clinic's final refusal is kept with its reason.
        let check = Script::new(
            vec![Reply::Terminal(State::Refused, Reason::CodeAttempts)],
            vec![],
        );
        let found = store
            .poll_staff_approval_using(link.id, session, &check)
            .unwrap();
        assert_eq!(found.link.approval_status, Some(State::Refused));
        assert_eq!(found.link.approval_reason, Some(Reason::CodeAttempts));
    }
    #[test]
    fn should_send_no_code_for_a_request_that_is_not_waiting_for_one() {
        // Staff approval, and a request with no challenge yet.
        let (_temp, store, link, _) = setup(true);
        let session = store.portal_link_ticket();
        let script = Script::new(vec![], vec![]);
        let code = code_for(&link, &link.clinic.as_ref().unwrap().clinic_keys[0].kid);
        assert!(matches!(
            store.submit_approval_code_using(link.id, &code, session, &script),
            Err(VaultError::ApprovalCodeNotOpen)
        ));
        let mut staff = link.clone();
        let attempt = staff.approval.as_mut().unwrap();
        attempt.challenge = Some(portal_approval::fixture_challenge_with(|_| {}));
        attempt.status = Some(State::ChallengeReady);
        store
            .mutate_recorded(|m, _| {
                m.portal_links[0] = staff.clone();
                Ok(())
            })
            .unwrap();
        assert!(!shown(&store).approval_by_code);
        assert!(matches!(
            store.submit_approval_code_using(link.id, &code, session, &script),
            Err(VaultError::ApprovalCodeNotOpen)
        ));
        // A locked vault takes none either.
        let (_temp, store, link, code) = code_setup();
        let session = store.portal_link_ticket();
        store.lock();
        assert!(store
            .submit_approval_code_using(link.id, &code, session, &script)
            .is_err());
        assert!(script.sent_codes.lock().unwrap().is_empty());
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
    /// A linked FAKE device whose saved request was made at `made_at` (Unix
    /// seconds), so that its end is near this device's clock (#131).
    fn connect_with_request_made_at(
        made_at: u64,
    ) -> (tempfile::TempDir, VaultStore, StoredLink, Attempt) {
        let (temp, store) = new_connect_store();
        let session = store.portal_link_ticket();
        let linked = finish_connect_link(&store, session).unwrap();
        let link = saved(&store);
        assert_eq!(link.id, linked.id);
        let attempt = portal_approval::create(&link, made_at).unwrap();
        store
            .mutate_recorded(|m, _| {
                m.portal_links[0].approval = Some(attempt.clone());
                Ok(())
            })
            .unwrap();
        let current = saved(&store);
        (temp, store, current, attempt)
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
        // By this device's clock the request ran out 10 s ago; the portal's
        // clock, 110 s behind it, gives it 100 s more.
        let now = crate::now_ms() / 1000;
        let (_temp, store, link, attempt) = connect_with_request_made_at(now - 610);
        let session = store.portal_link_ticket();
        let before = manifest(&store);
        assert!(attempt.expires_at <= now);
        let mut http = Script::new(vec![Reply::Pending], vec![]);
        http.portal_time = Some(attempt.expires_at - 100);
        let check = store
            .poll_staff_approval_using(link.id, session, &http)
            .unwrap();
        assert!(check.issue.is_none());
        assert_eq!(check.expires_in_ms, Some(100_000));
        assert_eq!(check.link.approval_status, Some(State::Pending));
        assert!(!check.link.clinic_approved);
        // No new request is offered while the portal gives this one time.
        assert!(link.summary().approval_can_restart);
        assert!(!check.link.approval_can_restart);
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
        assert!(check.link.approval_can_restart);
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

    #[test]
    fn checks_and_document_checks_stop_asking_once_the_portal_asks_to_wait() {
        let (_temp, store, link, attempt) = setup(true);
        let session = store.portal_link_ticket();
        // A kept older request, which a status check reads too.
        store
            .request_staff_approval_using(
                link.id,
                session,
                true,
                &Script::new(
                    vec![Reply::Terminal(State::Expired, Reason::ChallengeExpired)],
                    vec![Reply::Pending],
                ),
            )
            .unwrap();
        let current = saved(&store);
        assert_eq!(current.approval_history[0].request_id, attempt.request_id);
        let new_id = current.approval.as_ref().unwrap().request_id;
        // One read, refused with a wait: nothing more is asked.
        let http = Script::new(vec![Reply::RateLimited(Some(300))], vec![]);
        let check = store
            .poll_staff_approval_using(link.id, session, &http)
            .unwrap();
        assert!(matches!(
            check.issue,
            Some(VaultError::Portal(portal_link::LinkError::RateLimited(
                Some(300)
            )))
        ));
        assert_eq!(only_gets(&http), vec![new_id]);
        // The document check's approval step stops that link the same way.
        let http = Script::new(vec![Reply::RateLimited(None)], vec![]);
        assert!(matches!(
            store.refresh_staff_approval_for_check(&current, session, &http),
            Err(VaultError::Portal(portal_link::LinkError::RateLimited(
                None
            )))
        ));
        assert_eq!(only_gets(&http), vec![new_id]);
        // A wait asked on the older request stops there too.
        let http = Script::new(vec![Reply::Pending, Reply::RateLimited(Some(60))], vec![]);
        let check = store
            .poll_staff_approval_using(link.id, session, &http)
            .unwrap();
        assert!(matches!(
            check.issue,
            Some(VaultError::Portal(portal_link::LinkError::RateLimited(
                Some(60)
            )))
        ));
        assert_eq!(only_gets(&http), vec![new_id, attempt.request_id]);
    }

    #[test]
    fn poll_counts_time_left_to_the_portals_end_of_the_request_by_its_clock() {
        let now = crate::now_ms() / 1000;
        let (_temp, store, link, attempt) = connect_with_request_made_at(now);
        let session = store.portal_link_ticket();
        // The clinic's system published a challenge that ends 400 s
        // before the intent does: the portal moves the request's end to it.
        let challenge = portal_approval::signed_challenge(&link, &attempt, now - 10, now + 200);
        let mut http = Script::new(vec![Reply::ChallengeReady(challenge.clone())], vec![]);
        http.portal_time = Some(now + 100);
        let check = store
            .poll_staff_approval_using(link.id, session, &http)
            .unwrap();
        assert!(check.issue.is_none());
        assert_eq!(check.link.approval_status, Some(State::ChallengeReady));
        assert_eq!(check.expires_in_ms, Some(100_000));
        assert!(!check.link.approval_can_restart);
        // Past the challenge's end by the portal's clock: time is up, and a
        // new request may start, before the intent's own end, and while this
        // device's clock still gives the request time.
        let mut http = Script::new(vec![Reply::ChallengeReady(challenge.clone())], vec![]);
        http.portal_time = Some(now + 205);
        let check = store
            .poll_staff_approval_using(link.id, session, &http)
            .unwrap();
        assert_eq!(check.expires_in_ms, Some(0));
        assert!(check.link.approval_can_restart);
        assert!(!saved(&store).summary().approval_can_restart);
        // A date that cannot be the portal's clock gives no time at all.
        let mut http = Script::new(vec![Reply::ChallengeReady(challenge)], vec![]);
        http.portal_time = Some(now - portal_approval::PORTAL_CLOCK_BOUND_SECONDS - 60);
        let check = store
            .poll_staff_approval_using(link.id, session, &http)
            .unwrap();
        assert_eq!(check.expires_in_ms, None);
        assert!(!check.link.approval_can_restart);
    }
    #[test]
    fn restart_never_opens_a_second_request_while_the_portals_clock_gives_the_first_time() {
        // By this device's clock the request ran out 10 s ago; the portal's,
        // 110 s behind, gives it 100 s more.
        let now = crate::now_ms() / 1000;
        let (_temp, store, link, attempt) = connect_with_request_made_at(now - 610);
        let session = store.portal_link_ticket();
        let before = manifest(&store);
        let mut http = Script::new(vec![Reply::Pending], vec![]);
        http.portal_time = Some(attempt.expires_at - 100);
        assert!(matches!(
            store.request_staff_approval_using(link.id, session, true, &http),
            Err(VaultError::ApprovalStillOpen)
        ));
        assert_eq!(only_gets(&http), vec![attempt.request_id]);
        assert!(before == manifest(&store));
        assert_eq!(
            crate::PublicError::from(VaultError::ApprovalStillOpen).code,
            "approval_still_open"
        );
        // Once its time is up by the portal's clock, even before the portal
        // says "expired", a new request starts for the same device.
        let mut http = Script::new(vec![Reply::Pending], vec![Reply::Pending]);
        http.portal_time = Some(attempt.expires_at + 5);
        store
            .request_staff_approval_using(link.id, session, true, &http)
            .unwrap();
        let current = saved(&store);
        assert_eq!(current.approval_history.len(), 1);
        assert_eq!(current.approval_history[0].request_id, attempt.request_id);
        assert_ne!(current.approval.unwrap().request_id, attempt.request_id);
    }

    #[test]
    fn restart_is_never_held_back_by_a_date_that_cannot_be_the_portals_clock() {
        let now = crate::now_ms() / 1000;
        // Stuck at the epoch, an hour behind, and far ahead: none can be the
        // clock that accepted this device's signed request.
        for stuck in [0, now - 3_600, now + 7_200] {
            // By this device's clock the request ran out 10 s ago.
            let (_temp, store, link, attempt) = connect_with_request_made_at(now - 610);
            let session = store.portal_link_ticket();
            let mut http = Script::new(vec![Reply::Pending], vec![]);
            http.portal_time = Some(stuck);
            let check = store
                .poll_staff_approval_using(link.id, session, &http)
                .unwrap();
            assert_eq!(check.expires_in_ms, None, "{stuck}");
            assert!(check.link.approval_can_restart, "{stuck}");
            let mut http = Script::new(vec![Reply::Pending], vec![Reply::Pending]);
            http.portal_time = Some(stuck);
            store
                .request_staff_approval_using(link.id, session, true, &http)
                .unwrap();
            let current = saved(&store);
            assert_eq!(current.approval_history[0].request_id, attempt.request_id);
        }
        // With no usable date, this device's clock still refuses while the
        // request has time left.
        let (_temp, store, link, _) = connect_with_request_made_at(now);
        let mut http = Script::new(vec![Reply::Pending], vec![]);
        http.portal_time = Some(0);
        assert!(matches!(
            store.request_staff_approval_using(link.id, store.portal_link_ticket(), true, &http),
            Err(VaultError::ApprovalStillOpen)
        ));
    }

    #[test]
    fn a_request_the_portal_does_not_have_is_judged_by_this_devices_clock_in_check_and_restart() {
        // This device's clock gives the request 30 s; the portal's clock is
        // 60 s ahead (past its end), but the portal does not have it.
        let now = crate::now_ms() / 1000;
        let (_temp, store, link, attempt) = connect_with_request_made_at(now - 570);
        let session = store.portal_link_ticket();
        let mut http = Script::new(vec![Reply::Missing], vec![]);
        http.portal_time = Some(now + 60);
        let check = store
            .poll_staff_approval_using(link.id, session, &http)
            .unwrap();
        assert!(matches!(
            check.issue,
            Some(VaultError::ApprovalRequestMissing)
        ));
        assert!(
            !check.link.approval_can_restart,
            "no offer the restart refuses"
        );
        let mut http = Script::new(vec![Reply::Missing], vec![]);
        http.portal_time = Some(now + 60);
        // Never "still open on the portal" for a request the portal lacks.
        assert!(matches!(
            store.request_staff_approval_using(link.id, session, true, &http),
            Err(VaultError::ApprovalRequestMissing)
        ));
        assert_eq!(only_gets(&http), vec![attempt.request_id]);
        assert!(saved(&store).approval_history.is_empty());
    }

    #[test]
    fn poll_stops_at_its_first_failure_and_the_document_check_still_reads_on() {
        let (_temp, store, link, attempt) = setup(true);
        let session = store.portal_link_ticket();
        store
            .request_staff_approval_using(
                link.id,
                session,
                true,
                &Script::new(
                    vec![Reply::Terminal(State::Expired, Reason::ChallengeExpired)],
                    vec![Reply::Pending],
                ),
            )
            .unwrap();
        let current = saved(&store);
        let new_id = current.approval.as_ref().unwrap().request_id;
        for failure in [Reply::Network, Reply::Refused(503), Reply::DeviceRemoved] {
            let http = Script::new(vec![failure], vec![]);
            let check = store
                .poll_staff_approval_using(link.id, session, &http)
                .unwrap();
            assert!(matches!(check.issue, Some(VaultError::Portal(_))));
            assert_eq!(only_gets(&http), vec![new_id], "one read only");
        }
        // The current request read, then a failure on the older one: stop.
        let http = Script::new(vec![Reply::Pending, Reply::Network], vec![]);
        store
            .poll_staff_approval_using(link.id, session, &http)
            .unwrap();
        assert_eq!(only_gets(&http), vec![new_id, attempt.request_id]);
        // The document check's step reads on past a failure (unchanged).
        let http = Script::new(vec![Reply::Network, Reply::Pending], vec![]);
        let (_, warning) = store
            .refresh_staff_approval_for_check(&current, session, &http)
            .unwrap();
        assert!(matches!(
            warning,
            Some(VaultError::Portal(portal_link::LinkError::Network))
        ));
        assert_eq!(only_gets(&http), vec![new_id, attempt.request_id]);
    }
    #[test]
    fn restart_follows_the_portals_clock_when_this_device_is_behind_it() {
        // By this device's clock the request has 200 s left; the portal's
        // clock, 205 s ahead, is past its end. It is still "pending" there
        // (no "expired" until the clinic's system says so), but can no
        // longer be approved.
        let now = crate::now_ms() / 1000;
        let (_temp, store, link, old) = connect_with_request_made_at(now - 400);
        let session = store.portal_link_ticket();
        let mut http = Script::new(vec![Reply::Pending], vec![Reply::Pending]);
        http.portal_time = Some(now + 205);
        store
            .request_staff_approval_using(link.id, session, true, &http)
            .unwrap();
        let current = saved(&store);
        assert_eq!(current.approval_history[0].request_id, old.request_id);
        assert_ne!(current.approval.unwrap().request_id, old.request_id);
    }
    #[test]
    fn poll_reports_read_only_recovery_when_its_save_reaches_one_copy() {
        struct FailSecondCopy;
        impl Drop for FailSecondCopy {
            fn drop(&mut self) {
                FAIL_AT_TEST_BOUNDARY.set(&[]);
            }
        }
        let (_temp, store, link, _) = setup(true);
        let session = store.portal_link_ticket();
        let http = Script::new(vec![Reply::Pending], vec![]);
        assert!(
            !store
                .poll_staff_approval_using(link.id, session, &http)
                .unwrap()
                .recovery
        );
        let failing = FailSecondCopy;
        FAIL_AT_TEST_BOUNDARY.set(&["manifest.after-first-write"]);
        let http = Script::new(
            vec![Reply::Terminal(State::Expired, Reason::ChallengeExpired)],
            vec![],
        );
        let check = store
            .poll_staff_approval_using(link.id, session, &http)
            .unwrap();
        drop(failing);
        assert!(check.recovery, "the vault is read-only now");
        assert_eq!(check.link.approval_status, Some(State::Expired));
        assert!(matches!(
            store.poll_staff_approval_using(link.id, session, &Script::new(vec![], vec![])),
            Err(VaultError::RecoveryMode)
        ));
    }

    /// The checked-in FAKE package and the link it was sealed for.
    fn fixture_package() -> (StoredLink, wire::Outer, Vec<u8>, u64) {
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
        let outer: wire::Outer = serde_json::from_value(packet["outer"].clone()).unwrap();
        let sealed = wire::decode(packet["blob"].as_str().unwrap()).unwrap();
        (link, outer, sealed, packet["now"].as_u64().unwrap())
    }
    fn add_link(store: &VaultStore, link: &StoredLink) {
        store
            .mutate_recorded(|m, _| {
                m.portal_links.push(link.clone());
                Ok(())
            })
            .unwrap();
    }
    /// The package opened at its reference clock, and its signed original
    /// checked in process (unit tests have no PDF helper).
    fn opened_fixture(
        link: &StoredLink,
        outer: &wire::Outer,
        sealed: &[u8],
        now: u64,
    ) -> (wire::Opened, crate::signed_pdf::Manifest) {
        // Reference-clock input is a checked-in synthetic Java package. Verify
        // its real HPKE/ES256 and actual CMS signature before exercising the
        // durable-store/HTTP boundary; this is not a live helper/UI test.
        let opened = wire::open(outer, sealed, link, &[], now).unwrap();
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
        (opened, checked)
    }
    /// The checked-in synthetic Java delivery, opened and its signed PDF
    /// verified, ready to commit: its link, envelope, contents and manifest.
    fn signed_delivery() -> (
        StoredLink,
        wire::Outer,
        wire::Opened,
        crate::signed_pdf::Manifest,
    ) {
        let (link, outer, sealed, now) = fixture_package();
        let (opened, checked) = opened_fixture(&link, &outer, &sealed, now);
        (link, outer, opened, checked)
    }
    fn add_signed_pending_delivery(store: &VaultStore) -> (StoredLink, Uuid, String) {
        let (link, outer, sealed, now) = fixture_package();
        add_link(store, &link);
        let (opened, checked) = opened_fixture(&link, &outer, &sealed, now);
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
    /// Each unlock checks for new documents once (#128). A delivery its
    /// portal lists again at a later unlock, because the pickup confirmation
    /// did not reach the portal, is the one already filed: no second record,
    /// history entry or receipt. The next unlock's check then sends that same
    /// saved receipt, through `check_using`, and files nothing.
    ///
    /// The re-listing itself is committed directly: through `check_using`,
    /// `receive_delivery` verifies the PDF again with the confined helper
    /// and this device's clock before it reaches the record already filed,
    /// and the checked-in synthetic delivery needs its own reference clock
    /// (see the ignored helper tests).
    #[test]
    fn should_file_a_delivery_listed_again_after_lock_and_unlock_only_once() {
        let (_temp, store, _, _) = setup(false);
        let (link, id, receipt) = add_signed_pending_delivery(&store);
        let filed = |store: &VaultStore| {
            crate::vault::history_events_for_test(store)
                .iter()
                .filter(|e| e.event == HistoryEvent::DeliveryFiled)
                .count()
        };
        assert_eq!(filed(&store), 1);
        for _ in 0..2 {
            let ended = store.portal_link_ticket();
            store.lock();
            store.unlock(PASSWORD).unwrap();
            let session = store.portal_link_ticket();
            assert_ne!(session, ended, "a new session after the unlock");
            let history = crate::vault::history_events_for_test(&store).len();
            let (_, outer, opened, checked) = signed_delivery();
            assert_eq!(
                store
                    .commit_delivery(&outer, opened, &link, &checked, crate::now_ms(), session)
                    .unwrap(),
                (id, false)
            );
            assert_eq!(store.snapshot().unwrap().records.len(), 1);
            assert_eq!(filed(&store), 1);
            assert_eq!(crate::vault::history_events_for_test(&store).len(), history);
            let pending = store.pending_receipts(&link, session).unwrap();
            assert_eq!(pending.len(), 1);
            assert_eq!(pending[0].receipt, receipt);
        }
        store.lock();
        store.unlock(PASSWORD).unwrap();
        let session = store.portal_link_ticket();
        let sent = Mutex::new(Vec::new());
        let result = crate::portal_pickup::check_using(
            &store,
            session,
            &Script::new(vec![], vec![]),
            |to, method, path, body, _, _, _| {
                if path.ends_with("/receipt") {
                    assert_eq!((to.id, method), (link.id, "POST"));
                    sent.lock()
                        .unwrap()
                        .push(serde_json::from_slice::<serde_json::Value>(&body).unwrap());
                    Ok(picked_up())
                } else {
                    Ok(empty_page())
                }
            },
        )
        .unwrap();
        assert_eq!(
            (result.added, result.refused, result.receipts_pending),
            (0, 0, 0)
        );
        assert!(result.issues.is_empty());
        let sent = sent.into_inner().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["receipt"], receipt);
        assert_eq!(store.snapshot().unwrap().records.len(), 1);
        assert_eq!(filed(&store), 1);
        assert!(store.pending_receipts(&link, session).unwrap().is_empty());
    }
    /// Ben's D132c with clinic code v1 (#141, root-87's review of #138): a
    /// device the clinic approved by code is asked, and its documents are
    /// listed, like one approved by staff.
    #[test]
    fn should_ask_a_clinic_that_approved_this_device_by_code() {
        let (_, mut link, mut attempt) = portal_approval::first_fixture();
        let challenge =
            portal_approval::fixture_challenge_with(|c| c["approval_kind"] = "code".into());
        attempt.acceptance = Some(portal_approval::fixture_acceptance_with(&challenge, |a| {
            a["approval_kind"] = "code".into()
        }));
        attempt.challenge = Some(challenge);
        attempt.status = Some(State::Accepted);
        link.approval = Some(attempt);
        assert!(portal_approval::currently_approved(&link));
        assert!(portal_approval::approval_by_code(&link));
        assert!(crate::portal_pickup::worth_asking(&link));
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store
            .create(PASSWORD, "FAKE Code Approved Patient", 1)
            .unwrap();
        store
            .mutate_recorded(|m, _| {
                m.portal_links.push(link.clone());
                Ok(())
            })
            .unwrap();
        let listed = Mutex::new(Vec::new());
        let result = crate::portal_pickup::check_asking_using(
            &store,
            store.portal_link_ticket(),
            // Approved already: its status is not read again.
            &Script::new(vec![], vec![]),
            |l, method, path, _, _, _, _| {
                assert_eq!(method, "GET");
                assert!(path.starts_with("/api/mycarlos/deliveries?"));
                listed.lock().unwrap().push(l.id);
                Ok(empty_page())
            },
        )
        .unwrap();
        assert_eq!(listed.into_inner().unwrap(), vec![link.id]);
        assert!(result.issues.is_empty());
    }
    /// Ben's D132c: the check after unlocking, and Check for new documents,
    /// ask only clinics that approved this device or have a request still
    /// open. No saved request, or one refused or ended, is no reason to ask.
    #[test]
    fn should_ask_only_clinics_that_approved_this_device_or_have_an_open_request() {
        for (state, asked) in [
            (None, false),
            (Some(State::Refused), false),
            (Some(State::Expired), false),
            (Some(State::Cancelled), false),
            (Some(State::Pending), true),
        ] {
            // A device the clinic approved, checked first.
            let (x, mut approved, mut accepted) = portal_approval::first_fixture();
            let first = &x["flows"]["first"];
            accepted.challenge = Some(first["challenge"]["compact"].as_str().unwrap().into());
            accepted.acceptance = Some(first["acceptance"]["compact"].as_str().unwrap().into());
            accepted.status = Some(State::Accepted);
            approved.approval = Some(accepted);
            // A second clinic's device, with a request in `state`.
            let (mut other, _, _, _) = signed_delivery();
            if let Some(state) = state {
                let mut attempt = portal_approval::create(&other, crate::now_ms() / 1000).unwrap();
                attempt.status = Some(state);
                other.approval = Some(attempt);
            }
            let temp = tempfile::tempdir().unwrap();
            let store = VaultStore::new(temp.path().join("vault"));
            store.create(PASSWORD, "FAKE Asking Patient", 1).unwrap();
            store
                .mutate_recorded(|m, _| {
                    m.portal_links.push(approved.clone());
                    m.portal_links.push(other.clone());
                    Ok(())
                })
                .unwrap();
            assert!(crate::portal_pickup::worth_asking(&approved));
            assert_eq!(
                crate::portal_pickup::worth_asking(&other),
                asked,
                "{state:?}"
            );
            let approvals = Script::new(if asked { vec![Reply::Pending] } else { vec![] }, vec![]);
            let listed = Mutex::new(Vec::new());
            let result = crate::portal_pickup::check_asking_using(
                &store,
                store.portal_link_ticket(),
                &approvals,
                |link, method, path, _, _, _, _| {
                    assert_eq!(method, "GET");
                    assert!(path.starts_with("/api/mycarlos/deliveries?"));
                    listed.lock().unwrap().push(link.id);
                    Ok(empty_page())
                },
            )
            .unwrap();
            let expected = if asked {
                vec![approved.id, other.id]
            } else {
                vec![approved.id]
            };
            assert_eq!(listed.into_inner().unwrap(), expected, "{state:?}");
            // Its status is read only when its request is open.
            assert_eq!(
                approvals.calls.lock().unwrap().len(),
                usize::from(asked),
                "{state:?}"
            );
            assert!(result.issues.is_empty(), "{state:?}");
        }
        // A request the clinic has picked up is still open.
        let (mut other, _, _, _) = signed_delivery();
        let mut attempt = portal_approval::create(&other, crate::now_ms() / 1000).unwrap();
        attempt.status = Some(State::ChallengeReady);
        other.approval = Some(attempt);
        assert!(crate::portal_pickup::worth_asking(&other));
        // So is a saved request with no status yet: it reads as pending.
        other.approval.as_mut().unwrap().status = None;
        assert!(crate::portal_pickup::worth_asking(&other));
    }
    fn not_found_page() -> crate::portal_client::ApiResponse {
        crate::portal_client::ApiResponse {
            status: 404,
            body: Zeroizing::new(br#"{"detail":"not found"}"#.to_vec()),
            date: None,
            retry_after: None,
        }
    }
    /// An approved device, and a second device of this vault with a request
    /// still open, on the same portal (all FAKE). The second stands for a
    /// device a reset portal deleted. It comes first: the portal's answer to
    /// the working one, later in the check, still counts.
    fn store_with_a_gone_device(temp: &tempfile::TempDir) -> (VaultStore, StoredLink, StoredLink) {
        let (x, mut working, mut accepted) = portal_approval::first_fixture();
        let first = &x["flows"]["first"];
        accepted.challenge = Some(first["challenge"]["compact"].as_str().unwrap().into());
        accepted.acceptance = Some(first["acceptance"]["compact"].as_str().unwrap().into());
        accepted.status = Some(State::Accepted);
        working.approval = Some(accepted);
        let (mut gone, _, _, _) = signed_delivery();
        // Same portal first: the request it signs names it.
        gone.portal_base = working.portal_base.clone();
        let mut attempt = portal_approval::create(&gone, crate::now_ms() / 1000).unwrap();
        attempt.status = Some(State::Pending);
        gone.approval = Some(attempt);
        let store = VaultStore::new(temp.path().join("vault"));
        store
            .create(PASSWORD, "FAKE Gone Device Patient", 1)
            .unwrap();
        store
            .mutate_recorded(|m, _| {
                m.portal_links.push(gone.clone());
                m.portal_links.push(working.clone());
                Ok(())
            })
            .unwrap();
        assert!(crate::portal_pickup::worth_asking(&gone));
        assert!(crate::portal_pickup::worth_asking(&working));
        (store, working, gone)
    }
    /// Demo fix (29 Oct, Ben): a device a reset portal deleted answers "not
    /// found". The portal answered another device of this vault in the same
    /// check, so it is said removed and not asked again in this run: not its
    /// documents, not its request's status.
    #[test]
    fn should_not_ask_again_about_a_device_its_portal_no_longer_knows() {
        let temp = tempfile::tempdir().unwrap();
        let (store, working, gone) = store_with_a_gone_device(&temp);
        // One status read: the first check's. A second would find no reply.
        let approvals = Script::new(vec![Reply::Pending], vec![]);
        let asked = Mutex::new(Vec::new());
        let check = || {
            crate::portal_pickup::check_asking_using(
                &store,
                store.portal_link_ticket(),
                &approvals,
                |l, _, _, _, _, _, _| {
                    asked.lock().unwrap().push(l.id);
                    Ok(if l.id == working.id {
                        empty_page()
                    } else {
                        not_found_page()
                    })
                },
            )
            .unwrap()
        };
        let removed = |result: &crate::portal_pickup::CheckResult| {
            result
                .issues
                .iter()
                .filter(|i| i.link_id == gone.id)
                .map(|i| i.code.as_str())
                .collect::<Vec<_>>()
                == vec!["portal_device_removed"]
        };
        let first = check();
        assert_eq!(*asked.lock().unwrap(), vec![gone.id, working.id]);
        assert!(
            removed(&first),
            "{:?}",
            first.issues.iter().map(|i| &i.code).collect::<Vec<_>>()
        );
        assert!(!first.issues.iter().any(|i| i.link_id == working.id));
        assert!(store.link_gone(gone.id));
        asked.lock().unwrap().clear();
        let second = check();
        assert_eq!(*asked.lock().unwrap(), vec![working.id]);
        assert!(removed(&second));
        assert_eq!(approvals.calls.lock().unwrap().len(), 1);
        // A status refresh does not ask about it either.
        assert!(matches!(
            store.refresh_device_approval(gone.id, store.portal_link_ticket()),
            Err(VaultError::Portal(portal_link::LinkError::DeviceRemoved))
        ));
    }
    /// root-53's review: a "not found" for one receipt (a delivery the portal
    /// no longer has) says nothing about the device. A device whose receipt
    /// got one, and whose check then failed, is not marked gone, even though
    /// the same portal answered another device of this vault.
    #[test]
    fn should_not_mark_a_device_gone_for_a_receipt_not_found() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store
            .create(PASSWORD, "FAKE Receipt Not Found Patient", 1)
            .unwrap();
        let (with_receipt, _, _) = add_signed_pending_delivery(&store);
        // Another device of this vault on the same portal, which answers.
        let (_, mut other, _) = portal_approval::first_fixture();
        other.approval = None;
        other.portal_base = with_receipt.portal_base.clone();
        add_link(&store, &other);
        let posted = Mutex::new(0);
        for _ in 0..2 {
            crate::portal_pickup::check_using(
                &store,
                store.portal_link_ticket(),
                &Script::new(vec![], vec![]),
                |l, method, _, _, _, _, _| {
                    if l.id == other.id {
                        return Ok(empty_page());
                    }
                    assert_eq!(method, "POST");
                    *posted.lock().unwrap() += 1;
                    Ok(not_found_page())
                },
            )
            .unwrap();
            assert!(!store.link_gone(with_receipt.id));
        }
        // Asked again on the second check.
        assert_eq!(*posted.lock().unwrap(), 2);
    }
    /// The control: "not found" from a portal that answered no device of
    /// this vault may be a portal that is not there; it is asked again.
    #[test]
    fn should_ask_again_when_the_portal_answered_no_device() {
        let temp = tempfile::tempdir().unwrap();
        let (store, working, gone) = store_with_a_gone_device(&temp);
        let approvals = Script::new(vec![Reply::Pending, Reply::Pending], vec![]);
        let asked = Mutex::new(0);
        for _ in 0..2 {
            crate::portal_pickup::check_asking_using(
                &store,
                store.portal_link_ticket(),
                &approvals,
                |_, _, _, _, _, _, _| {
                    *asked.lock().unwrap() += 1;
                    Ok(not_found_page())
                },
            )
            .unwrap();
        }
        assert_eq!(*asked.lock().unwrap(), 4);
        assert!(!store.link_gone(gone.id) && !store.link_gone(working.id));
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
    fn refusal(code: &str) -> crate::portal_client::ApiResponse {
        crate::portal_client::ApiResponse {
            status: 403,
            body: Zeroizing::new(serde_json::to_vec(&serde_json::json!({ "code": code })).unwrap()),
            date: None,
            retry_after: None,
        }
    }
    fn reply(status: u16, body: &[u8]) -> crate::portal_client::ApiResponse {
        crate::portal_client::ApiResponse {
            status,
            body: Zeroizing::new(body.to_vec()),
            date: None,
            retry_after: None,
        }
    }
    fn issues(result: &crate::portal_pickup::CheckResult) -> Vec<(Uuid, &str)> {
        result
            .issues
            .iter()
            .map(|issue| (issue.link_id, issue.code.as_str()))
            .collect()
    }
    /// The document check says a device the portal removed as it is (#128),
    /// as the status check does (#131): checking again cannot help it.
    #[test]
    fn should_say_an_approved_device_whose_document_list_says_it_was_removed() {
        let (_temp, store, link, _) = setup(true);
        let result = crate::portal_pickup::check_using(
            &store,
            store.portal_link_ticket(),
            &Script::new(vec![Reply::Accepted], vec![]),
            |_, method, path, _, _, _, _| {
                assert_eq!(method, "GET");
                assert!(path.starts_with("/api/mycarlos/deliveries?"));
                Ok(refusal("device_removed"))
            },
        )
        .unwrap();
        assert!(saved(&store).summary().clinic_approved);
        assert_eq!(issues(&result), vec![(link.id, "portal_device_removed")]);
    }
    #[test]
    fn should_say_a_waiting_device_whose_status_read_says_it_was_removed() {
        let (_temp, store, link, _) = setup(true);
        let result = crate::portal_pickup::check_using(
            &store,
            store.portal_link_ticket(),
            &Script::new(vec![Reply::DeviceRemoved], vec![]),
            |_, _, _, _, _, _, _| Ok(empty_page()),
        )
        .unwrap();
        assert!(!saved(&store).summary().clinic_approved);
        assert_eq!(issues(&result), vec![(link.id, "portal_device_removed")]);
    }
    #[test]
    fn should_say_a_removed_device_whose_saved_receipt_is_refused_and_keep_the_receipt() {
        let (_temp, store, _, _) = setup(false);
        let (healthy, _, _) = add_signed_pending_delivery(&store);
        let result = crate::portal_pickup::check_using(
            &store,
            store.portal_link_ticket(),
            &Script::new(vec![], vec![]),
            |_, _, path, _, _, _, _| {
                Ok(if path.ends_with("/receipt") {
                    refusal("device_removed")
                } else {
                    empty_page()
                })
            },
        )
        .unwrap();
        assert_eq!(issues(&result), vec![(healthy.id, "portal_device_removed")]);
        assert_eq!(result.receipts_pending, 1);
    }
    #[test]
    fn should_keep_other_refusals_of_the_document_list_a_connection_failure() {
        let (_temp, store, link, _) = setup(false);
        let result = crate::portal_pickup::check_using(
            &store,
            store.portal_link_ticket(),
            &Script::new(vec![], vec![]),
            |_, _, _, _, _, _, _| Ok(refusal("forbidden")),
        )
        .unwrap();
        assert_eq!(issues(&result), vec![(link.id, "portal_link_incomplete")]);
    }
    fn listing(outers: &[wire::Outer]) -> crate::portal_client::ApiResponse {
        reply(
            200,
            &serde_json::to_vec(&serde_json::json!({
                "deliveries": outers,
                "next_cursor": null,
                "through": outers.len().to_string(),
                "anchor_recorded": true,
            }))
            .unwrap(),
        )
    }
    /// A filed delivery for `other`, a second clinic in this vault, made from
    /// the checked-in package with that clinic's ids. Its manifest signature
    /// is not the clinic's: tests use only its saved custody and receipt,
    /// never a pickup.
    fn add_unsent_delivery_for(store: &VaultStore, other: &StoredLink) -> Uuid {
        let (fixture, mut outer, sealed, now) = fixture_package();
        let (mut opened, checked) = opened_fixture(&fixture, &outer, &sealed, now);
        let clinic = other.clinic.as_ref().unwrap();
        outer.delivery_id = Uuid::new_v4().to_string();
        outer.recipient_id = clinic.recipient_id.clone();
        outer.device_key_id = other.keys.device_key_id();
        let manifest = &mut opened.manifest;
        manifest.delivery_id = outer.delivery_id.clone();
        manifest.recipient_id = outer.recipient_id.clone();
        manifest.device_key_id = outer.device_key_id.clone();
        manifest.clinic_id = clinic.clinic_id.clone();
        let (_, signature) = opened.manifest_compact.split_once('.').unwrap();
        opened.manifest_compact = format!(
            "{}.{signature}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&opened.manifest).unwrap())
        );
        let (id, added) = store
            .commit_delivery(
                &outer,
                opened,
                other,
                &checked,
                crate::now_ms(),
                store.portal_link_ticket(),
            )
            .unwrap();
        assert!(added);
        id
    }
    /// The path, bytes and permissions of a record's saved document.
    fn object_file(store: &VaultStore, record: Uuid) -> (PathBuf, Vec<u8>, fs::Permissions) {
        let name = store
            .session()
            .as_ref()
            .unwrap()
            .manifest
            .records
            .iter()
            .find(|r| r.id == record)
            .unwrap()
            .object_name
            .clone();
        let path = store.root.join("objects").join(name);
        let bytes = fs::read(&path).unwrap();
        let permissions = fs::metadata(&path).unwrap().permissions();
        (path, bytes, permissions)
    }
    /// Writes a saved document's file as `bytes`, with `permissions`.
    // Tests remove files on purpose, to simulate damage and loss (#71).
    #[allow(clippy::disallowed_methods)]
    fn replace_object(path: &Path, bytes: &[u8], permissions: fs::Permissions) {
        let _ = fs::remove_file(path);
        fs::write(path, bytes).unwrap();
        fs::set_permissions(path, permissions).unwrap();
    }
    /// Changes one byte of a record's saved document. The vault still shows
    /// the record and takes changes.
    fn alter(store: &VaultStore, record: Uuid) {
        let (path, mut bytes, permissions) = object_file(store, record);
        *bytes.last_mut().unwrap() ^= 1;
        replace_object(&path, &bytes, permissions);
    }
    /// Deletes a record's saved document and removes the record as damaged,
    /// as the patient must before a vault missing a document it shows takes
    /// changes again.
    // Tests remove files on purpose, to simulate damage and loss (#71).
    #[allow(clippy::disallowed_methods)]
    fn remove_as_damaged(store: &VaultStore, record: Uuid) {
        let (path, _, _) = object_file(store, record);
        fs::remove_file(&path).unwrap();
        store
            .mutate_recorded(|m, _| {
                m.records
                    .iter_mut()
                    .find(|r| r.id == record)
                    .unwrap()
                    .hidden = Some(Hidden {
                    at_ms: crate::now_ms(),
                    reason: HiddenReason::Damaged,
                });
                Ok(())
            })
            .unwrap();
    }
    /// One mailbox check where every listing is empty and every receipt is
    /// answered picked_up: the result, the links listed in order, and each
    /// receipt sent with its link.
    fn check_recording(
        store: &VaultStore,
    ) -> (
        crate::portal_pickup::CheckResult,
        Vec<Uuid>,
        Vec<(Uuid, serde_json::Value)>,
    ) {
        let listed = Mutex::new(Vec::new());
        let posted = Mutex::new(Vec::new());
        let result = crate::portal_pickup::check_using(
            store,
            store.portal_link_ticket(),
            &Script::new(vec![], vec![]),
            |link, method, path, body, _, _, _| {
                if path.ends_with("/receipt") {
                    assert_eq!(method, "POST");
                    let sent: serde_json::Value = serde_json::from_slice(&body).unwrap();
                    posted
                        .lock()
                        .unwrap()
                        .push((link.id, sent["receipt"].clone()));
                    Ok(picked_up())
                } else {
                    assert!(path.starts_with("/api/mycarlos/deliveries?"));
                    listed.lock().unwrap().push(link.id);
                    Ok(empty_page())
                }
            },
        )
        .unwrap();
        (
            result,
            listed.into_inner().unwrap(),
            posted.into_inner().unwrap(),
        )
    }
    fn receipt_outcome(store: &VaultStore, record: Uuid) -> Option<wire::ReceiptOutcome> {
        store
            .session()
            .as_ref()
            .unwrap()
            .manifest
            .records
            .iter()
            .find(|r| r.id == record)
            .unwrap()
            .delivery
            .as_ref()
            .unwrap()
            .receipt_outcome
    }
    #[test]
    fn should_hold_a_damaged_records_receipt_and_still_check_and_send_the_other_clinics() {
        // The clinic with the damaged record is checked first.
        let (_temp, store, damaged_link, _) = setup(false);
        let (healthy, healthy_id, receipt) = add_signed_pending_delivery(&store);
        let damaged_id = add_unsent_delivery_for(&store, &damaged_link);
        alter(&store, damaged_id);
        for round in 0..2 {
            let (result, listed, posted) = check_recording(&store);
            assert_eq!(listed, vec![damaged_link.id, healthy.id]);
            // The healthy clinic's receipt is sent once; the damaged record's
            // receipt is never sent.
            let expected = if round == 0 {
                vec![(healthy.id, serde_json::Value::from(receipt.clone()))]
            } else {
                vec![]
            };
            assert_eq!(posted, expected);
            assert_eq!(result.issues.len(), 1);
            assert_eq!(result.issues[0].link_id, damaged_link.id);
            assert_eq!(result.issues[0].code, crate::portal_pickup::DAMAGED_CODE);
            assert_eq!(result.receipts_pending, 0);
        }
        assert!(receipt_outcome(&store, healthy_id) == Some(wire::ReceiptOutcome::PickedUp));
        assert!(receipt_outcome(&store, damaged_id).is_none());
    }
    #[test]
    fn should_stop_reporting_a_record_removed_as_damaged_and_send_its_receipt_if_its_file_returns()
    {
        let (_temp, store, damaged_link, _) = setup(false);
        let (healthy, _, _) = add_signed_pending_delivery(&store);
        let damaged_id = add_unsent_delivery_for(&store, &damaged_link);
        let damaged_receipt = store
            .pending_receipts(&damaged_link, store.portal_link_ticket())
            .unwrap()[0]
            .receipt
            .clone();
        let (path, intact, permissions) = object_file(&store, damaged_id);
        // Damaged while the vault still shows it: reported.
        alter(&store, damaged_id);
        let (result, _, posted) = check_recording(&store);
        assert_eq!(
            posted.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            vec![healthy.id]
        );
        assert_eq!(result.issues.len(), 1);
        assert_eq!(result.issues[0].link_id, damaged_link.id);
        assert_eq!(result.issues[0].code, crate::portal_pickup::DAMAGED_CODE);
        // Removed by the patient as damaged: still held, no longer reported,
        // and both clinics are still checked.
        remove_as_damaged(&store, damaged_id);
        for _ in 0..2 {
            let (result, listed, posted) = check_recording(&store);
            assert_eq!(listed, vec![damaged_link.id, healthy.id]);
            assert!(posted.is_empty());
            assert!(result.issues.is_empty());
            assert_eq!(result.receipts_pending, 0);
        }
        assert!(receipt_outcome(&store, damaged_id).is_none());
        // Its file comes back intact: the vault holds the document again, so
        // its kept receipt is sent, byte for byte.
        replace_object(&path, &intact, permissions);
        let (result, _, posted) = check_recording(&store);
        assert_eq!(
            posted,
            vec![(damaged_link.id, serde_json::Value::from(damaged_receipt))]
        );
        assert!(result.issues.is_empty());
        assert!(receipt_outcome(&store, damaged_id) == Some(wire::ReceiptOutcome::PickedUp));
    }
    #[test]
    fn should_report_a_failed_download_and_still_fetch_the_clinics_next_delivery() {
        use portal_link::LinkError;
        type Failure = fn() -> Result<crate::portal_client::ApiResponse, LinkError>;
        let failures: [Failure; 4] = [
            || Err(LinkError::Network),
            || Err(LinkError::InvalidResponse),
            || Ok(reply(500, b"{}")),
            || Ok(reply(404, br#"{"code":"not_ready"}"#)),
        ];
        for failure in failures {
            let (_temp, store, _, _) = setup(false);
            let (link, second, sealed, _) = fixture_package();
            add_link(&store, &link);
            let mut first = second.clone();
            first.delivery_id = Uuid::new_v4().to_string();
            let fetched = Mutex::new(Vec::new());
            let result = crate::portal_pickup::check_using(
                &store,
                store.portal_link_ticket(),
                &Script::new(vec![], vec![]),
                |l, method, path, _, _, _, _| {
                    if l.id != link.id {
                        return Ok(empty_page());
                    }
                    assert_eq!(method, "GET", "nothing is filed, so no receipt is sent");
                    fetched.lock().unwrap().push(path.to_owned());
                    if path.starts_with("/api/mycarlos/deliveries?") {
                        Ok(listing(&[first.clone(), second.clone()]))
                    } else if path.ends_with(&first.delivery_id) {
                        failure()
                    } else {
                        Ok(reply(200, &sealed))
                    }
                },
            )
            .unwrap();
            assert_eq!(
                fetched.into_inner().unwrap(),
                vec![
                    "/api/mycarlos/deliveries?limit=50".to_owned(),
                    format!("/api/mycarlos/deliveries/{}", first.delivery_id),
                    format!("/api/mycarlos/deliveries/{}", second.delivery_id),
                ]
            );
            // The second delivery was downloaded and checked. Unit tests have
            // no PDF helper and the checked-in package is past its pickup
            // window, so it is refused here instead of filed.
            assert_eq!((result.added, result.refused), (0, 1));
            assert_eq!(result.issues.len(), 1);
            assert_eq!(result.issues[0].link_id, link.id);
            assert_eq!(result.issues[0].code, "portal_link_incomplete");
        }
    }
    #[test]
    fn should_stop_a_clinic_after_three_downloads_in_a_row_get_no_reply() {
        // None is no reply at all; Some is an HTTP status, which resets the count.
        for (replies, fetched) in [
            (vec![None, None, None, None], 3),
            (vec![None, None, Some(500), None, None, None, None], 6),
        ] {
            let (_temp, store, _, _) = setup(false);
            let (link, outer, _, _) = fixture_package();
            add_link(&store, &link);
            let listed = replies
                .iter()
                .map(|_| {
                    let mut outer = outer.clone();
                    outer.delivery_id = Uuid::new_v4().to_string();
                    outer
                })
                .collect::<Vec<_>>();
            let downloads = Mutex::new(0);
            let result = crate::portal_pickup::check_using(
                &store,
                store.portal_link_ticket(),
                &Script::new(vec![], vec![]),
                |l, _, path, _, _, _, _| {
                    if l.id != link.id {
                        return Ok(empty_page());
                    }
                    if path.starts_with("/api/mycarlos/deliveries?") {
                        return Ok(listing(&listed));
                    }
                    let mut downloads = downloads.lock().unwrap();
                    let index = listed
                        .iter()
                        .position(|o| path.ends_with(&o.delivery_id))
                        .unwrap();
                    assert_eq!(index, *downloads, "listed order");
                    *downloads += 1;
                    match replies[index] {
                        None => Err(portal_link::LinkError::Network),
                        Some(status) => Ok(reply(status, b"{}")),
                    }
                },
            )
            .unwrap();
            assert_eq!(downloads.into_inner().unwrap(), fetched);
            assert_eq!(result.issues.len(), 1);
            assert_eq!(result.issues[0].link_id, link.id);
            assert_eq!(result.issues[0].code, "portal_link_incomplete");
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

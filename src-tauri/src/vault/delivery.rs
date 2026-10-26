//! Native custody transaction. No network call is permitted while a vault lock is held.
use super::*;
use crate::portal_delivery::{self as wire, Custody, Receipt, ReceiptOutcome};
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
impl VaultStore {
    pub(crate) fn check_documents(
        &self,
        session: u64,
    ) -> Result<crate::portal_pickup::CheckResult, VaultError> {
        if self
            .portal_check_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(VaultError::Invalid);
        }
        struct Running<'a>(&'a AtomicBool);
        impl Drop for Running<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _running = Running(&self.portal_check_running);
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
            || pdf
                .document
                .service_date
                .as_ref()
                .is_some_and(|v| v != &opened.manifest.document.service_date)
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
        self.commit_delivery(
            outer,
            opened,
            link,
            &pdf.document_id,
            pdf.version,
            crate::now_ms(),
            session,
        )
    }

    fn commit_delivery(
        &self,
        outer: &wire::Outer,
        opened: wire::Opened,
        link: &StoredLink,
        pdf_id: &str,
        pdf_version: u32,
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
                pdf_document_id: pdf_id.into(),
                pdf_version,
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
impl VaultStore {
    pub(crate) fn request_staff_approval(
        &self,
        link_id: Uuid,
        session: u64,
    ) -> Result<(), VaultError> {
        let link = self
            .delivery_links(session)?
            .into_iter()
            .find(|l| l.id == link_id)
            .ok_or(VaultError::NotFound)?;
        if link
            .approval
            .as_ref()
            .is_some_and(|a| a.acceptance.is_some())
        {
            return Ok(());
        }
        let now = crate::now_ms();
        let attempt = match &link.approval {
            Some(a) if a.expires_at > now / 1000 => a.clone(),
            _ => crate::portal_approval::create(&link, now / 1000)?,
        };
        let saved = self.mutate_recorded(|m, entries| {
            if self.portal_link_ticket() != session {
                return Err(VaultError::Cancelled);
            }
            let current = m
                .portal_links
                .iter_mut()
                .find(|l| l.id == link_id)
                .ok_or(VaultError::NotFound)?;
            if current != &link {
                return Err(VaultError::Invalid);
            }
            if current.approval.as_ref() != Some(&attempt) {
                current.approval = Some(attempt.clone());
                let mut entry = HistoryEntry::new(HistoryEvent::DeviceApprovalRequested, now);
                entry.portal_link_id = Some(link_id);
                entry.how = Some("staff_first".into());
                entries.push(entry);
            }
            Ok(current.clone())
        })?;
        // A degraded local commit retains exact intent but cannot publish a
        // new action until the vault has repaired its redundant manifest.
        self.delivery_links(session)?;
        let anchor = self.delivery_anchor(&saved, session)?;
        crate::portal_approval::publish(&saved, &attempt, &anchor, &|| {
            self.portal_link_ticket() != session
        })
    }
    pub(crate) fn refresh_staff_approval(
        &self,
        link: &StoredLink,
        session: u64,
    ) -> Result<StoredLink, VaultError> {
        let Some(attempt) = &link.approval else {
            return Ok(link.clone());
        };
        if attempt.acceptance.is_some() {
            return Ok(link.clone());
        }
        let next = crate::portal_approval::refresh(link, attempt, &|| {
            self.portal_link_ticket() != session
        })?;
        if &next == attempt {
            return Ok(link.clone());
        }
        self.mutate_recorded(|m, entries| {
            if self.portal_link_ticket() != session {
                return Err(VaultError::Cancelled);
            }
            let current = m
                .portal_links
                .iter_mut()
                .find(|l| l.id == link.id)
                .ok_or(VaultError::NotFound)?;
            if current != link {
                return Err(VaultError::Invalid);
            }
            if next.acceptance.is_some() {
                let mut entry =
                    HistoryEntry::new(HistoryEvent::DeviceApprovalVerified, crate::now_ms());
                entry.portal_link_id = Some(link.id);
                entries.push(entry);
            }
            current.approval = Some(next);
            Ok(current.clone())
        })
    }
}

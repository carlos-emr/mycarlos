//! Explicit ignored integration harness for the real native APIs. It does not
//! supply clinic pins, device keys, acceptance proofs, packages or receipts.
//! Those must come from the actual HTTPS portal and production native flow.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    synthetic: bool,
    vault_root: PathBuf,
    report: PathBuf,
    passphrase: String,
    portal_base: String,
    link_code: Option<String>,
    device_name: Option<String>,
    expected_original_sha256: Option<String>,
}
impl Drop for Config {
    fn drop(&mut self) {
        self.passphrase.zeroize();
        if let Some(code) = &mut self.link_code {
            code.zeroize();
        }
    }
}
fn verify_original(store: &VaultStore, expected: &str) {
    assert!(
        crate::portal_delivery::hash(expected),
        "expected original hash must be lowercase SHA256"
    );
    let record = {
        let guard = store.session();
        let open = guard.as_ref().unwrap();
        let matches = open
            .manifest
            .records
            .iter()
            .filter(|r| {
                r.delivery
                    .as_ref()
                    .is_some_and(|c| c.manifest.document.sha256 == expected)
            })
            .collect::<Vec<_>>();
        assert_eq!(
            matches.len(),
            1,
            "exactly one expected native delivery is required"
        );
        assert!(
            matches[0].delivery.as_ref().unwrap().receipt_outcome
                == Some(crate::portal_delivery::ReceiptOutcome::PickedUp),
            "portal pickup response must have been durably recorded"
        );
        (*matches[0]).clone()
    };
    let mut original = Zeroizing::new(Vec::new());
    store.export(record.id, &mut *original).unwrap();
    assert_eq!(
        crate::portal_delivery::sha256(&original),
        expected,
        "saved signed original differs"
    );
    crate::vault::history_events_for_test(store);
}

#[test]
#[ignore = "real HTTPS synthetic environment only; requires private config and actual native helper"]
fn native_portal_real_https_flow() {
    let config_path = std::env::var_os("MYCARLOS_NATIVE_FLOW_CONFIG")
        .expect("explicit private synthetic config is required");
    let config_bytes =
        Zeroizing::new(fs::read(config_path).expect("cannot read private synthetic config"));
    let config: Config =
        serde_json::from_slice(&config_bytes).expect("invalid private synthetic config structure");
    assert!(
        config.synthetic && config.vault_root.is_absolute() && config.report.is_absolute(),
        "owned synthetic absolute paths are required"
    );
    let phase =
        std::env::var("MYCARLOS_NATIVE_FLOW_ACTION").expect("explicit native phase required");
    assert!(
        [
            "link",
            "request",
            "restart-request",
            "check",
            "inspect",
            "verify"
        ]
        .contains(&phase.as_str()),
        "unsupported native phase"
    );
    let store = VaultStore::new(config.vault_root.clone());
    match store.status().unwrap() {
        VaultStatus::Absent => {
            assert_eq!(phase, "link", "link the actual native vault first");
            store
                .create(&config.passphrase, "FAKE Native Patient", crate::now_ms())
                .unwrap();
        }
        VaultStatus::Locked => store.unlock(&config.passphrase).unwrap(),
        _ => panic!("unexpected native vault status"),
    }
    let mut check_result = None;
    let operation: Result<(), VaultError> = (|| {
        let session = store.portal_link_ticket();
        if phase == "link" {
            assert!(
                store.snapshot()?.portal_links.is_empty(),
                "do not silently create a second native link"
            );
            store.link_portal(
                &config.portal_base,
                config
                    .link_code
                    .as_deref()
                    .expect("actual portal linking code is required"),
                config.device_name.as_deref().unwrap_or("myCarlos on Linux"),
                None,
                crate::now_ms(),
                session,
            )?;
            return Ok(());
        }
        let links = store.delivery_links(session)?;
        assert_eq!(links.len(), 1, "one actual linked device is required");
        assert_eq!(
            links[0].portal_base,
            crate::portal_link::normalize_portal(&config.portal_base).unwrap(),
            "saved portal target differs from the consented test target"
        );
        match phase.as_str() {
            "request" => store.request_staff_approval(links[0].id, session)?,
            "restart-request" => store.restart_staff_approval(links[0].id, session)?,
            "check" => check_result = Some(store.check_documents(session)?),
            "verify" => verify_original(
                &store,
                config
                    .expected_original_sha256
                    .as_deref()
                    .expect("expected original hash required for verification"),
            ),
            "inspect" => {}
            _ => unreachable!(),
        }
        Ok(())
    })();
    let error_code = operation
        .err()
        .map(|error| crate::PublicText::from(error).code);
    store.lock();
    drop(store);
    let reopened = VaultStore::new(config.vault_root.clone());
    reopened.unlock(&config.passphrase).unwrap();
    if phase == "verify" && error_code.is_none() {
        verify_original(
            &reopened,
            config.expected_original_sha256.as_deref().unwrap(),
        );
    }
    let snapshot = reopened.snapshot().unwrap();
    let records = {
        let guard = reopened.session();
        let open = guard.as_ref().unwrap();
        open.manifest.records.iter().filter_map(|r|r.delivery.as_ref().map(|c|serde_json::json!({"recordId":r.id,"deliveryId":c.outer.delivery_id,"keptReceiptSha256":crate::portal_delivery::sha256(c.receipt.as_bytes()),"originalSha256":c.manifest.document.sha256,"receiptPending":c.receipt_outcome.is_none(),"receiptOutcome":c.receipt_outcome,"verified":super::delivery::verified_clinic(r,&open.manifest.portal_links).is_some()}))).collect::<Vec<_>>()
    };
    let report = serde_json::json!({"scope":"actual native APIs and HTTPS; does not establish Windows/native UI behavior","phase":phase,"vaultReopened":true,"nativeErrorCode":error_code,"recovery":snapshot.recovery,"links":snapshot.portal_links,"records":records,"checkResult":check_result});
    fs::write(&config.report, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    assert!(
        error_code.is_none(),
        "native phase failed; inspect the content-free report"
    );
    assert!(
        snapshot.recovery.is_none(),
        "native vault entered recovery; no success claim"
    );
}

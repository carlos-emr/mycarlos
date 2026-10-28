//! Explicit ignored integration harness for the real native APIs. It does not
//! supply clinic pins, device keys, acceptance proofs, packages or receipts.
//! Those must come from the actual HTTPS portal and production native flow.
use super::*;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReceiptLoss {
    receipt_post_attempts: usize,
    delivery_id: Option<String>,
    reply_dropped: bool,
    successful_status: Option<u16>,
    receipt_request_body_sha256: Option<String>,
    kept_receipt_sha256: Option<String>,
}

fn check_tracing_receipts(
    store: &VaultStore,
    session: u64,
    drop_delivery_id: Option<&str>,
    trace: &std::cell::RefCell<ReceiptLoss>,
) -> Result<crate::portal_pickup::CheckResult, VaultError> {
    store
        .portal_check_running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| VaultError::Invalid)?;
    struct Running<'a>(&'a AtomicBool);
    impl Drop for Running<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }
    let _running = Running(&store.portal_check_running);
    crate::portal_pickup::check_asking_using(
        store,
        session,
        &crate::portal_approval::ApprovalHttp::default(),
        |link, method, suffix, body, anchor, max, cancelled| {
            let receipt_post = method == "POST" && suffix.ends_with("/receipt");
            if let Some(target) = drop_delivery_id {
                let target_path = format!("/api/mycarlos/deliveries/{target}");
                if (method == "GET"
                    && suffix.starts_with("/api/mycarlos/deliveries/")
                    && suffix != target_path)
                    || (receipt_post && suffix != format!("{target_path}/receipt"))
                {
                    return Err(crate::portal_link::LinkError::InvalidResponse);
                }
            }
            let hashes = if receipt_post {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct ReceiptBody<'a> {
                    receipt: &'a str,
                }
                let parsed: ReceiptBody<'_> = serde_json::from_slice(&body)
                    .map_err(|_| crate::portal_link::LinkError::InvalidResponse)?;
                trace.borrow_mut().receipt_post_attempts += 1;
                Some((
                    crate::portal_delivery::sha256(&body),
                    crate::portal_delivery::sha256(parsed.receipt.as_bytes()),
                ))
            } else {
                None
            };
            // The original production transport performs the real HTTPS call,
            // including every saved-origin, assertion, cancellation and TLS check.
            let response =
                crate::portal_client::api(link, method, suffix, body, anchor, max, cancelled)?;
            if let Some((body_hash, receipt_hash)) = hashes {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Status {
                    status: String,
                }
                let picked_up = response.status == 200
                    && serde_json::from_slice::<Status>(&response.body)
                        .ok()
                        .is_some_and(|s| s.status == "picked_up");
                let mut trace = trace.borrow_mut();
                trace.delivery_id = suffix
                    .strip_prefix("/api/mycarlos/deliveries/")
                    .and_then(|v| v.strip_suffix("/receipt"))
                    .map(str::to_owned);
                trace.receipt_request_body_sha256 = Some(body_hash);
                trace.kept_receipt_sha256 = Some(receipt_hash);
                if picked_up {
                    trace.successful_status = Some(response.status);
                }
                if picked_up && drop_delivery_id.is_some() && !trace.reply_dropped {
                    trace.reply_dropped = true;
                    // Lose only this already successful response. Do not replay
                    // the POST, alter proof bytes, or settle native custody.
                    return Err(crate::portal_link::LinkError::Network);
                }
            }
            Ok(response)
        },
    )
}

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

/// Read both independent payloads through their actual production read paths.
/// Object identities come only from the unlocked authenticated index.
fn inspect_delivery_payloads(store: &VaultStore) -> serde_json::Value {
    let (records, history_objects, history_head) = {
        let guard = store.session();
        let open = guard.as_ref().unwrap();
        let records = open
            .manifest
            .records
            .iter()
            .filter(|r| r.delivery.is_some())
            .cloned()
            .collect::<Vec<_>>();
        let history_objects = open.manifest.history.segments.iter().map(|s| serde_json::json!({"objectId":s.id,"objectName":s.object_name,"firstSeq":s.first_seq,"entryCount":s.entry_count})).collect::<Vec<_>>();
        (records, history_objects, open.manifest.history.head.clone())
    };
    assert!(
        !records.is_empty(),
        "actual saved deliveries are required for payload inspection"
    );
    let mut inspected = Vec::new();
    for record in records {
        let custody = record.delivery.as_ref().unwrap();
        let original_ref = record
            .original_pdf
            .as_ref()
            .expect("clinic custody must retain an independent original");
        assert_ne!(record.object_name, original_ref.object_name);
        assert_ne!(record.id, original_ref.id);
        let mut working = Zeroizing::new(Vec::new());
        store
            .read_for_view(record.id, &mut *working)
            .expect("working view payload must authenticate and read");
        let mut original = Zeroizing::new(Vec::new());
        store
            .export(record.id, &mut *original)
            .expect("retained original must authenticate and read");
        let working_hash = crate::portal_delivery::sha256(&working);
        let original_hash = crate::portal_delivery::sha256(&original);
        assert_eq!(
            original_hash, custody.manifest.document.sha256,
            "retained original differs from the signed delivery hash"
        );
        inspected.push(serde_json::json!({
            "recordId":record.id,"deliveryId":custody.outer.delivery_id,
            "working":{"objectId":record.id,"objectName":record.object_name,"sha256":working_hash,"bytesRead":working.len()},
            "original":{"objectId":original_ref.id,"objectName":original_ref.object_name,"sha256":original_hash,"bytesRead":original.len()},
            "workingMatchesSignedOriginal":working_hash==custody.manifest.document.sha256,
            "keptReceiptSha256":crate::portal_delivery::sha256(custody.receipt.as_bytes())
        }));
    }
    let history_entries = crate::vault::history_events_for_test(store);
    serde_json::json!({"records":inspected,"history":{"objects":history_objects,"head":history_head,"authenticatedEntryCount":history_entries.len()}})
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
            "check-drop-receipt-reply",
            "inspect",
            "inspect-payloads",
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
    let receipt_loss = std::cell::RefCell::new(ReceiptLoss::default());
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
            "check" => {
                check_result = Some(check_tracing_receipts(
                    &store,
                    session,
                    None,
                    &receipt_loss,
                )?)
            }
            "check-drop-receipt-reply" => {
                assert!(
                    store.pending_receipts(&links[0], session)?.is_empty(),
                    "start lost-reply evidence without an older pending receipt"
                );
                let target = std::env::var("MYCARLOS_NATIVE_FLOW_DROP_DELIVERY_ID")
                    .expect("explicit public target delivery UUID is required");
                assert!(
                    crate::portal_delivery::uuid4(&target),
                    "target must be canonical UUIDv4"
                );
                check_result = Some(check_tracing_receipts(
                    &store,
                    session,
                    Some(&target),
                    &receipt_loss,
                )?);
            }
            "verify" => verify_original(
                &store,
                config
                    .expected_original_sha256
                    .as_deref()
                    .expect("expected original hash required for verification"),
            ),
            "inspect" | "inspect-payloads" => {}
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
        open.manifest.records.iter().filter_map(|r|r.delivery.as_ref().map(|c|serde_json::json!({"recordId":r.id,"deliveryId":c.outer.delivery_id,"keptReceiptSha256":crate::portal_delivery::sha256(c.receipt.as_bytes()),"originalSha256":c.manifest.document.sha256,"serviceDate":c.manifest.document.service_date,"receiptPending":c.receipt_outcome.is_none(),"receiptOutcome":c.receipt_outcome,"verified":super::delivery::verified_clinic(r,&open.manifest.portal_links).is_some()}))).collect::<Vec<_>>()
    };
    let loss = receipt_loss.into_inner();
    let payload_inspection =
        (phase == "inspect-payloads").then(|| inspect_delivery_payloads(&reopened));
    let report = serde_json::json!({"scope":"actual native APIs and HTTPS; does not establish Windows/native UI behavior","phase":phase,"vaultReopened":true,"nativeErrorCode":error_code,"recovery":snapshot.recovery,"links":snapshot.portal_links,"records":records,"checkResult":check_result,"receiptTrace":if phase=="check" || phase=="check-drop-receipt-reply" {Some(&loss)}else{None},"payloadInspection":payload_inspection});
    fs::write(&config.report, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    if phase == "check-drop-receipt-reply" {
        assert!(
            loss.reply_dropped && loss.successful_status == Some(200),
            "one actual successful receipt response must have been dropped"
        );
        assert_eq!(
            loss.receipt_post_attempts, 1,
            "the lost-reply phase must perform exactly one receipt POST"
        );
        assert!(
            records.iter().any(|r| r["keptReceiptSha256"].as_str()
                == loss.kept_receipt_sha256.as_deref()
                && r["receiptPending"] == true
                && r["receiptOutcome"].is_null()),
            "the exact kept receipt must remain pending after native lock/reopen"
        );
    }
    assert!(
        error_code.is_none(),
        "native phase failed; inspect the content-free report"
    );
    assert!(
        snapshot.recovery.is_none(),
        "native vault entered recovery; no success claim"
    );
}

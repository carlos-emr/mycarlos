//! SOURCE ONLY: import as a cfg(test) child of vault.
//! Uses the actual VaultStore and check_cycle with checked-in signed approvals.
//! HTTP is a deterministic synthetic exchange; no socket, PDF helper, timer,
//! successful custody, installed Windows or execution claim is made here.

use super::*;
use crate::{
    document_collection::{CycleControl, StopReason},
    document_collection_pickup::{check_cycle, ResumeCache},
    portal_approval::{self, ApprovalExchange, ApprovalState, Attempt},
    portal_client::ApiResponse,
    portal_delivery::{Outer, Suite},
    portal_link::{LinkError, PrivateKeys, StoredLink},
};
use sha2::{Digest, Sha256};
use std::{
    cell::{Cell, RefCell},
    sync::{atomic::AtomicBool, Arc},
    time::Instant,
};

const PASSWORD: &str = "meadow-planet-copper-window-743";

/// Accepted fixture proofs must make the real reconciliation short-circuit;
/// a test cannot substitute an `approved: true` answer for native verification.
struct NoApprovalRequests;
impl ApprovalExchange for NoApprovalRequests {
    fn get(
        &self,
        _: &StoredLink,
        _: &Attempt,
        _: &dyn Fn() -> bool,
    ) -> Result<Option<Attempt>, VaultError> {
        panic!("a native-verified accepted link must not request approval")
    }
    fn post(
        &self,
        _: &StoredLink,
        _: &Attempt,
        _: &str,
        _: &dyn Fn() -> bool,
    ) -> Result<Attempt, VaultError> {
        panic!("a native-verified accepted link must not publish approval")
    }
}

fn accepted_links() -> [StoredLink; 2] {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use p256::ecdsa::{signature::Signer, Signature, SigningKey};

    let (fixture, mut first, attempt) = portal_approval::first_fixture();
    let accept = |link: &StoredLink, attempt: &Attempt, flow: &serde_json::Value| {
        let response = serde_json::json!({
            "request_id": attempt.request_id,
            "status": "accepted",
            "challenge": flow["challenge"]["compact"],
            "acceptance": flow["acceptance"]["compact"],
            "reason": null,
        });
        portal_approval::parse_status(link, attempt, &serde_json::to_vec(&response).unwrap())
            .unwrap()
    };
    first.approval = Some(accept(&first, &attempt, &fixture["flows"]["first"]));

    // This prototype verifies staff-first approval only. Derive another signed
    // staff-first fixture with a distinct device and recipient at the same FAKE
    // clinic; the frozen later-device flow is deliberately unsupported here.
    // This tests LINK-ID rotation, not independently provisioned clinics.
    let candidate = &fixture["keys"]["candidate"];
    let seed = |name: &str| Sha256::digest(candidate[name].as_str().unwrap().as_bytes()).to_vec();
    let mut second = first.clone();
    second.id = Uuid::new_v4();
    second.keys = serde_json::from_value::<PrivateKeys>(serde_json::json!({
        "x25519": seed("x25519_seed_text"),
        "ed25519": seed("ed25519_seed_text"),
    }))
    .unwrap();
    second.clinic.as_mut().unwrap().device_key_id =
        candidate["device_key_id"].as_str().unwrap().to_owned();
    second.clinic.as_mut().unwrap().recipient_id = "FAKE-m3-recipient-automatic-0002".into();
    second.approval = None;
    let mut flow = fixture["flows"]["first"].clone();
    let request_id = Uuid::new_v4();
    for kind in ["intent", "challenge", "acceptance"] {
        let claims = &mut flow[kind]["claims"];
        claims["recipient_id"] = serde_json::json!(second.clinic.as_ref().unwrap().recipient_id);
        claims["request_id"] = serde_json::json!(request_id);
        for (claim, key) in [
            ("candidate_device_key_id", "device_key_id"),
            ("candidate_x25519_public_key", "x25519_public_key"),
            ("candidate_ed25519_public_key", "ed25519_public_key"),
        ] {
            claims[claim] = candidate[key].clone();
        }
    }
    let intent = second
        .keys
        .sign(&serde_json::to_vec(&flow["intent"]["claims"]).unwrap());
    flow["intent"]["compact"] = serde_json::json!(intent);
    let challenge_id = URL_SAFE_NO_PAD.encode(Sha256::digest(request_id.as_bytes()));
    flow["challenge"]["claims"]["challenge_id"] = serde_json::json!(challenge_id);
    flow["acceptance"]["claims"]["challenge_id"] = serde_json::json!(challenge_id);
    flow["challenge"]["claims"]["candidate_intent_sha256"] =
        serde_json::json!(crate::portal_delivery::sha256(intent.as_bytes()));

    // Reuse the public FAKE-key signing pattern from portal_delivery tests.
    // This fixture scalar is SHA256(seed)+1 and is below the P-256 order.
    let mut scalar: [u8; 32] = Sha256::digest(
        fixture["keys"]["clinic"]["seed_text"]
            .as_str()
            .unwrap()
            .as_bytes(),
    )
    .into();
    for byte in scalar.iter_mut().rev() {
        let (value, carry) = byte.overflowing_add(1);
        *byte = value;
        if !carry {
            break;
        }
    }
    let signer = SigningKey::from_slice(&scalar).unwrap();
    let sign = |claims: &serde_json::Value| {
        let payload = serde_json::to_vec(claims).unwrap();
        let signature: Signature = signer.sign(&payload);
        format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(&payload),
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        )
    };
    let challenge = sign(&flow["challenge"]["claims"]);
    flow["challenge"]["compact"] = serde_json::json!(challenge);
    flow["acceptance"]["claims"]["challenge_sha256"] =
        serde_json::json!(crate::portal_delivery::sha256(challenge.as_bytes()));
    let acceptance = sign(&flow["acceptance"]["claims"]);
    flow["acceptance"]["compact"] = serde_json::json!(acceptance);
    let attempt = Attempt {
        request_id,
        intent,
        expires_at: flow["intent"]["claims"]["exp"].as_u64().unwrap(),
        challenge: None,
        acceptance: None,
        status: Some(ApprovalState::Pending),
        reason: None,
    };
    second.approval = Some(accept(&second, &attempt, &flow));
    for link in [&first, &second] {
        link.validate().unwrap();
        assert!(portal_approval::currently_approved(link));
    }
    assert_ne!(first.keys.device_key_id(), second.keys.device_key_id());
    assert_ne!(
        first.clinic.as_ref().unwrap().recipient_id,
        second.clinic.as_ref().unwrap().recipient_id
    );
    [first, second]
}

struct Notices;
impl crate::document_notification_runtime::active::Backend for Notices {
    fn permission(&self) -> crate::document_notification_runtime::Permission {
        crate::document_notification_runtime::Permission::Allowed
    }
    fn accept(
        &self,
        _body: &str,
        current: &dyn Fn() -> bool,
    ) -> Result<(), crate::document_notification_runtime::Error> {
        if current() {
            Ok(())
        } else {
            Err(crate::document_notification_runtime::Error::Cancelled)
        }
    }
}

fn store_with(links: &[StoredLink]) -> (tempfile::TempDir, VaultStore, ResumeCache) {
    let temp = tempfile::tempdir().unwrap();
    let store = VaultStore::new(temp.path().join("vault"));
    store.create(PASSWORD, "FAKE automatic fixture", 1).unwrap();
    store
        .mutate_recorded(|manifest, _| {
            manifest.portal_links.extend_from_slice(links);
            Ok(())
        })
        .unwrap();
    let runtime = crate::document_notification_runtime::Runtime::load_for_test(
        temp.path().join("notices.json"),
        Box::new(Notices),
    );
    assert!(store.notifications.set(Arc::new(runtime)).is_ok());
    store.set_notifications(true).ok().unwrap();
    store.set_automatic_checks(true).ok().unwrap();
    assert!(store.automatic_collection_allowed());
    let vault_id = store.session().as_ref().unwrap().manifest.vault_id;
    let mut cache = ResumeCache::default();
    cache.bind(
        vault_id,
        store.portal_link_ticket(),
        store.collection.cache_epoch(),
    );
    (temp, store, cache)
}

fn delivery_id(index: usize) -> String {
    format!("00000000-0000-4000-8000-{index:012x}")
}

fn outer(link: &StoredLink, index: usize) -> Outer {
    let now = crate::now_ms() / 1000;
    let value = Outer {
        v: 1,
        suite: Suite {
            kem_id: 32,
            kdf_id: 1,
            aead_id: 3,
        },
        delivery_id: delivery_id(index),
        recipient_id: link.clinic.as_ref().unwrap().recipient_id.clone(),
        device_key_id: link.keys.device_key_id(),
        size: 49,
        ciphertext_sha256: "a".repeat(64),
        created_at: now,
        expires_at: now + 600,
        kind: None,
    };
    value.validate().unwrap();
    value
}

fn page(link: &StoredLink, ids: &[usize], next: Option<&str>) -> ApiResponse {
    ApiResponse {
        status: 200,
        body: zeroize::Zeroizing::new(
            serde_json::to_vec(&serde_json::json!({
                "deliveries": ids.iter().map(|id| outer(link, *id)).collect::<Vec<_>>(),
                "through": "100",
                "next_cursor": next,
                "anchor_recorded": true,
            }))
            .unwrap(),
        ),
    }
}

fn page_for_path(link: &StoredLink, path: &str) -> ApiResponse {
    match path {
        "/api/mycarlos/deliveries?limit=50" => page(link, &[1, 2], Some("2")),
        "/api/mycarlos/deliveries?after=2&through=100&limit=50" => page(link, &[3, 4], Some("4")),
        "/api/mycarlos/deliveries?after=4&through=100&limit=50" => page(link, &[5, 6], None),
        _ => panic!("unexpected or invented server cursor: {path}"),
    }
}

#[test]
fn actual_picker_three_pages_reaches_later_ids_despite_first_download_failure() {
    let links = accepted_links();
    let (_temp, store, mut cache) = store_with(&links[..1]);
    let bodies = RefCell::new(Vec::new());
    let lists = RefCell::new(Vec::new());
    for _ in 0..2 {
        let control = CycleControl::new(Instant::now(), Arc::new(AtomicBool::new(false)));
        let calls = Cell::new(0);
        let result = check_cycle(
            &store,
            store.portal_link_ticket(),
            &control,
            &mut cache,
            &NoApprovalRequests,
            |link, method, path, body, anchor, cap, stopped| {
                assert_eq!(method, "GET", "no receipt may precede custody");
                assert!(body.is_empty() && !stopped());
                calls.set(calls.get() + 1);
                assert!(calls.get() <= 8);
                if path.contains('?') {
                    assert!(anchor.is_some());
                    assert_eq!(cap, 524_288);
                    lists.borrow_mut().push(path.to_owned());
                    Ok(page_for_path(link, path))
                } else {
                    assert!(anchor.is_none());
                    assert_eq!(cap, 49);
                    bodies.borrow_mut().push(path.to_owned());
                    Err(LinkError::Network)
                }
            },
        )
        .unwrap();
        assert_eq!((result.added, result.refused), (0, 0));
    }
    assert_eq!(
        *bodies.borrow(),
        (1..=6)
            .map(|id| format!("/api/mycarlos/deliveries/{}", delivery_id(id)))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        lists.borrow().len(),
        3,
        "exact three server pages, no prefix reset"
    );
    assert!(store.snapshot().unwrap().records.is_empty());
}

#[test]
fn actual_picker_midpage_cancellation_resumes_after_attempted_id_without_ack() {
    let links = accepted_links();
    let (_temp, store, mut cache) = store_with(&links[..1]);
    let bodies = RefCell::new(Vec::new());
    for round in 0..2 {
        let token = Arc::new(AtomicBool::new(false));
        let control = CycleControl::new(Instant::now(), token.clone());
        let result = check_cycle(
            &store,
            store.portal_link_ticket(),
            &control,
            &mut cache,
            &NoApprovalRequests,
            |link, method, path, body, _, _, stopped| {
                assert_eq!(method, "GET", "cancelled work must not ACK");
                assert!(body.is_empty() && !stopped());
                if path.contains('?') {
                    Ok(page_for_path(link, path))
                } else {
                    bodies.borrow_mut().push(path.to_owned());
                    if round == 0 {
                        token.store(true, std::sync::atomic::Ordering::Release);
                        assert!(stopped(), "actual exchange receives the cycle stop");
                    }
                    Err(LinkError::Network)
                }
            },
        )
        .unwrap();
        assert_eq!((result.added, result.refused), (0, 0));
        if round == 0 {
            assert_eq!(bodies.borrow().len(), 1);
            assert_eq!(control.reason(), Some(StopReason::User));
        }
    }
    assert_eq!(
        *bodies.borrow(),
        (1..=6)
            .map(|id| format!("/api/mycarlos/deliveries/{}", delivery_id(id)))
            .collect::<Vec<_>>()
    );
    assert!(store.snapshot().unwrap().records.is_empty());
}

#[test]
fn actual_picker_cancelled_first_accepted_link_yields_next_cycle_to_other_link() {
    let links = accepted_links();
    let (_temp, store, mut cache) = store_with(&links);
    let visited = RefCell::new(Vec::new());
    for round in 0..2 {
        let token = Arc::new(AtomicBool::new(false));
        let control = CycleControl::new(Instant::now(), token.clone());
        check_cycle(
            &store,
            store.portal_link_ticket(),
            &control,
            &mut cache,
            &NoApprovalRequests,
            |link, method, path, _, anchor, _, stopped| {
                assert_eq!(method, "GET");
                assert_eq!(path, "/api/mycarlos/deliveries?limit=50");
                assert!(anchor.is_some() && !stopped());
                visited.borrow_mut().push(link.id);
                if round == 0 {
                    token.store(true, std::sync::atomic::Ordering::Release);
                    assert!(stopped());
                }
                Ok(page(link, &[], None))
            },
        )
        .unwrap();
        if round == 0 {
            assert_eq!(*visited.borrow(), vec![links[0].id]);
        }
    }
    assert_eq!(
        *visited.borrow(),
        vec![links[0].id, links[1].id, links[0].id]
    );
    assert!(store.snapshot().unwrap().records.is_empty());
}

#[test]
fn actual_picker_request_exhaustion_does_not_permanently_skip_boundary_delivery() {
    let links = accepted_links();
    let (_temp, store, mut cache) = store_with(&links[..1]);
    let attempted = RefCell::new(std::collections::BTreeSet::new());
    for _ in 0..4 {
        let control = CycleControl::new(Instant::now(), Arc::new(AtomicBool::new(false)));
        let calls = Cell::new(0);
        check_cycle(
            &store,
            store.portal_link_ticket(),
            &control,
            &mut cache,
            &NoApprovalRequests,
            |link, method, path, _, _, _, stopped| {
                assert_eq!(method, "GET", "failed downloads never ACK");
                assert!(!stopped());
                calls.set(calls.get() + 1);
                assert!(calls.get() <= 8, "fairness must not raise the request cap");
                if path.contains('?') {
                    assert_eq!(path, "/api/mycarlos/deliveries?limit=50");
                    Ok(page(link, &(1..=10).collect::<Vec<_>>(), None))
                } else {
                    attempted.borrow_mut().insert(path.to_owned());
                    Err(LinkError::Network)
                }
            },
        )
        .unwrap();
    }
    assert!(
        attempted
            .borrow()
            .contains(&format!("/api/mycarlos/deliveries/{}", delivery_id(8))),
        "metadata plus seven failed GETs must not exclude item8 every snapshot round"
    );
    assert_eq!(attempted.borrow().len(), 10);
    assert!(store.snapshot().unwrap().records.is_empty());
}

#[test]
fn actual_picker_download_byte_deferral_retries_unattempted_boundary_packet() {
    let links = accepted_links();
    let (_temp, store, mut cache) = store_with(&links[..1]);
    let attempted = RefCell::new(std::collections::BTreeSet::new());
    for _ in 0..3 {
        let control = CycleControl::new(Instant::now(), Arc::new(AtomicBool::new(false)));
        let bytes = Cell::new(0usize);
        check_cycle(&store,store.portal_link_ticket(),&control,&mut cache,&NoApprovalRequests,
            |link,method,path,_,_,cap,stop|{
                assert_eq!(method,"GET");assert!(!stop());
                if path.contains('?') {
                    let mut a=outer(link,1);let mut b=outer(link,2);a.size=12*1024*1024;b.size=a.size;
                    Ok(ApiResponse{status:200,body:zeroize::Zeroizing::new(serde_json::to_vec(&serde_json::json!({
                        "deliveries":[a,b],"through":"100","next_cursor":null,"anchor_recorded":true,
                    })).unwrap())})
                } else {
                    bytes.set(bytes.get()+cap);assert!(bytes.get()<=20*1024*1024);
                    attempted.borrow_mut().insert(path.to_owned());Err(LinkError::Network)
                }
            }).unwrap();
    }
    assert_eq!(
        attempted.borrow().len(),
        2,
        "local byte deferral cannot skip packet2 every round"
    );
    assert!(store.snapshot().unwrap().records.is_empty());
}

#[test]
fn actual_wire_open_error_after_observed_cancel_is_cancelled_not_refused() {
    let links = accepted_links();
    let (_temp, store, _) = store_with(&links[..1]);
    let token = Arc::new(AtomicBool::new(false));
    let switched = token.clone();
    AT_TEST_BOUNDARY.with(|slot| {
        *slot.borrow_mut() = Some((
            "notifications.after-delivery-open",
            Box::new(move || {
                switched.store(true, Ordering::Release);
            }),
        ))
    });
    let result = store.receive_delivery_controlled(
        &outer(&links[0], 1),
        &[],
        &links[0],
        store.portal_link_ticket(),
        &|| token.load(Ordering::Acquire),
    );
    assert!(matches!(result, Err(VaultError::Cancelled)));
    assert!(store.snapshot().unwrap().records.is_empty());
}

// SOURCE ONLY: insert inside vault::automatic_collection_tests.
// Requires source05 PendingReceipts::{budget_deferred,manual_required}.
// Uses actual native encrypted files and the existing derived-custody helper.
// Changing the primary object's bytes exercises local readability; the signed
// original PDF stays unchanged. This is no new clinic-signature, pickup, HTTP,
// OS-display proof. One actual check_cycle fixture below covers retry_first;
// no tests executed here. Requires the cfg(test) delivery custody seam.

fn replace_primary_with_physical_fixture(store: &VaultStore, id: Uuid, bytes: u64) -> usize {
    let (context, keys) = {
        let guard = store.session();
        let open = guard.as_ref().unwrap();
        let record = open.manifest.records.iter().find(|r| r.id == id).unwrap();
        (
            ObjectContext {
                vault_id: open.manifest.vault_id,
                record_id: id,
                profile_id: record.profile_id,
            },
            derive_keys(open.manifest.vault_id, &open.master_key).unwrap(),
        )
    };
    let name = format!("{}.mcobj", Uuid::new_v4());
    let key = [0x5a; 32];
    let encrypted = encrypt_object(
        Box::new(io::repeat(0x71).take(bytes)),
        &store.root.join("objects").join(&name),
        context,
        &key,
        &keys.fingerprint,
    )
    .unwrap();
    let wrapped = wrap_secret(&keys.object_wrap, &key, id.as_bytes()).unwrap();
    store
        .mutate_recorded(|manifest, _| {
            let record = manifest.records.iter_mut().find(|r| r.id == id).unwrap();
            assert!(
                record.original_pdf.is_some(),
                "keep the independent signed original"
            );
            record.object_name = name;
            record.plaintext_size = encrypted.plaintext_size;
            record.fingerprint = BASE64.encode(encrypted.fingerprint);
            record.wrapped_object_key = wrapped;
            Ok(())
        })
        .unwrap();
    let guard = store.session();
    let record = guard
        .as_ref()
        .unwrap()
        .manifest
        .records
        .iter()
        .find(|r| r.id == id)
        .unwrap();
    record
        .objects()
        .map(|object| {
            fs::metadata(store.root.join("objects").join(object.object_name))
                .unwrap()
                .len() as usize
        })
        .sum()
}

/// These fixtures test the byte budget, not the clock. A debug build reading tens of MiB of
/// them on a busy machine can outlast the 30-second cycle, which then stops on Deadline first.
fn physical_fixture_deadline() -> Instant {
    Instant::now() + std::time::Duration::from_secs(15 * 60)
}

fn physical_fixture_control(store: &VaultStore) -> crate::document_collection::CycleControl {
    crate::document_collection::CycleControl::new(
        std::time::Instant::now(),
        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    )
    .with_test_deadline(physical_fixture_deadline())
    .with_session(store.portal_session.clone(), store.portal_link_ticket())
}

fn physical_fixture_delivery_id(store: &VaultStore, id: Uuid) -> String {
    let guard = store.session();
    guard
        .as_ref()
        .unwrap()
        .manifest
        .records
        .iter()
        .find(|r| r.id == id)
        .unwrap()
        .delivery
        .as_ref()
        .unwrap()
        .outer
        .delivery_id
        .clone()
}

fn assert_physical_fixture_unsettled(store: &VaultStore, count: usize) {
    let guard = store.session();
    let records = &guard.as_ref().unwrap().manifest.records;
    assert_eq!(records.len(), count);
    assert!(records
        .iter()
        .all(|r| r.delivery.as_ref().unwrap().receipt_outcome.is_none()));
}

#[test]
fn actual_pending_physical_budget_retains_second_record_for_fresh_cycle() {
    use crate::document_collection::{ScanCursor, StopReason, MAX_PHYSICAL_READ};
    let links = accepted_links();
    let (_temp, store, _) = store_with(&links[..1]);
    let link = &links[0];
    let a = super::delivery::automatic_pending_fixture_for_test(&store, link);
    let b = super::delivery::automatic_pending_fixture_for_test(&store, link);
    let a_bytes = replace_primary_with_physical_fixture(&store, a, 24 * 1024 * 1024);
    let b_bytes = replace_primary_with_physical_fixture(&store, b, 24 * 1024 * 1024);
    assert!(a_bytes < MAX_PHYSICAL_READ && b_bytes < MAX_PHYSICAL_READ);
    assert!(a_bytes + b_bytes > MAX_PHYSICAL_READ);
    let expected_b = physical_fixture_delivery_id(&store, b);
    let mut cursor = ScanCursor::default();
    let cycle = physical_fixture_control(&store);
    let first = store
        .pending_receipts_controlled(link, store.portal_link_ticket(), &cycle, &mut cursor)
        .unwrap();
    assert_eq!(first.ready.len(), 1);
    assert_eq!(
        first.ready[0].outer.delivery_id,
        physical_fixture_delivery_id(&store, a)
    );
    assert!(!first.budget_deferred && !first.manual_required);
    assert_eq!(cycle.test_counts().2, a_bytes);
    // The first custody remains unsettled: cursor retention must select b on
    // the fresh cycle rather than wrapping back to the still-readable a.
    let deferred = store
        .pending_receipts_controlled(link, store.portal_link_ticket(), &cycle, &mut cursor)
        .unwrap();
    assert!(deferred.ready.is_empty() && deferred.budget_deferred && !deferred.manual_required);
    assert_eq!(deferred.damaged, 0);
    assert_eq!(cycle.reason(), Some(StopReason::Budget));
    assert!(cycle.test_counts().2 <= MAX_PHYSICAL_READ);
    let next = physical_fixture_control(&store);
    let resumed = store
        .pending_receipts_controlled(link, store.portal_link_ticket(), &next, &mut cursor)
        .unwrap();
    assert_eq!(resumed.ready.len(), 1);
    assert_eq!(resumed.ready[0].outer.delivery_id, expected_b);
    assert_eq!(resumed.damaged, 0);
    assert!(!resumed.budget_deferred && !resumed.manual_required);
    assert_eq!(next.test_counts(), (1, 1, b_bytes));
    assert_eq!(next.reason(), None);
    assert_physical_fixture_unsettled(&store, 2);
}

#[test]
fn actual_pending_other_link_residual_budget_defers_without_damage_or_manual_pause() {
    use crate::document_collection::{ScanCursor, StopReason, MAX_PHYSICAL_READ};
    let links = accepted_links();
    let (_temp, store, _) = store_with(&links);
    let a_link = &links[0];
    let b_link = &links[1];
    let a = super::delivery::automatic_pending_fixture_for_test(&store, a_link);
    let b = super::delivery::automatic_pending_fixture_for_test(&store, b_link);
    let a_bytes = replace_primary_with_physical_fixture(&store, a, 24 * 1024 * 1024);
    let b_bytes = replace_primary_with_physical_fixture(&store, b, 24 * 1024 * 1024);
    assert!(a_bytes < MAX_PHYSICAL_READ && b_bytes < MAX_PHYSICAL_READ);
    let expected_b = physical_fixture_delivery_id(&store, b);
    let mut a_cursor = ScanCursor::default();
    let mut b_cursor = ScanCursor::default();
    let shared = physical_fixture_control(&store);
    let first = store
        .pending_receipts_controlled(a_link, store.portal_link_ticket(), &shared, &mut a_cursor)
        .unwrap();
    assert_eq!(first.ready.len(), 1);
    let deferred = store
        .pending_receipts_controlled(b_link, store.portal_link_ticket(), &shared, &mut b_cursor)
        .unwrap();
    assert!(deferred.ready.is_empty() && deferred.budget_deferred && !deferred.manual_required);
    assert_eq!(deferred.damaged, 0);
    assert_eq!(shared.reason(), Some(StopReason::Budget));
    assert!(shared.test_counts().2 <= MAX_PHYSICAL_READ);
    let fresh = physical_fixture_control(&store);
    let resumed = store
        .pending_receipts_controlled(b_link, store.portal_link_ticket(), &fresh, &mut b_cursor)
        .unwrap();
    assert_eq!(resumed.ready.len(), 1);
    assert_eq!(resumed.ready[0].outer.delivery_id, expected_b);
    assert!(!resumed.budget_deferred && !resumed.manual_required);
    assert_eq!(resumed.damaged, 0);
    assert_eq!(fresh.test_counts(), (1, 1, b_bytes));
    assert_physical_fixture_unsettled(&store, 2);
}

#[test]
fn actual_pending_single_record_over_full_budget_requires_manual_only_for_that_link() {
    use crate::document_collection::{ScanCursor, StopReason, MAX_PHYSICAL_READ};
    let links = accepted_links();
    let (_temp, store, _) = store_with(&links);
    let a_link = &links[0];
    let b_link = &links[1];
    let oversized = super::delivery::automatic_pending_fixture_for_test(&store, a_link);
    let _later_same_link = super::delivery::automatic_pending_fixture_for_test(&store, a_link);
    let other = super::delivery::automatic_pending_fixture_for_test(&store, b_link);
    assert!(
        replace_primary_with_physical_fixture(&store, oversized, 41 * 1024 * 1024)
            > MAX_PHYSICAL_READ
    );
    let mut a_cursor = ScanCursor::default();
    let cycle = physical_fixture_control(&store);
    let pending = store
        .pending_receipts_controlled(a_link, store.portal_link_ticket(), &cycle, &mut a_cursor)
        .unwrap();
    assert!(pending.ready.is_empty() && pending.manual_required && !pending.budget_deferred);
    assert_eq!(
        pending.damaged, 0,
        "a valid oversized ciphertext is not damage"
    );
    assert_eq!(cycle.reason(), Some(StopReason::Budget));
    assert!(cycle.test_counts().2 <= MAX_PHYSICAL_READ);
    let mut b_cursor = ScanCursor::default();
    let fresh = physical_fixture_control(&store);
    let other_pending = store
        .pending_receipts_controlled(b_link, store.portal_link_ticket(), &fresh, &mut b_cursor)
        .unwrap();
    assert_eq!(other_pending.ready.len(), 1);
    assert_eq!(
        other_pending.ready[0].outer.delivery_id,
        physical_fixture_delivery_id(&store, other)
    );
    assert_eq!(other_pending.damaged, 0);
    assert!(!other_pending.budget_deferred && !other_pending.manual_required);
    assert_eq!(fresh.reason(), None);
    assert_physical_fixture_unsettled(&store, 3);
}

#[test]
fn actual_picker_physical_deferral_prioritizes_other_link_before_repeated_failed_receipt() {
    use crate::document_collection::{StopReason, MAX_PHYSICAL_READ};
    let links = accepted_links();
    let (_temp, store, mut cache) = store_with(&links);
    let a = super::delivery::automatic_pending_fixture_for_test(&store, &links[0]);
    let b = super::delivery::automatic_pending_fixture_for_test(&store, &links[1]);
    assert!(replace_primary_with_physical_fixture(&store, a, 24 * 1024 * 1024) < MAX_PHYSICAL_READ);
    assert!(replace_primary_with_physical_fixture(&store, b, 24 * 1024 * 1024) < MAX_PHYSICAL_READ);
    let attempts = RefCell::new(Vec::new());
    for round in 0..2 {
        let token = Arc::new(AtomicBool::new(false));
        let control = CycleControl::new(Instant::now(), token.clone())
            .with_test_deadline(physical_fixture_deadline())
            .with_session(store.portal_session.clone(), store.portal_link_ticket());
        let result = check_cycle(
            &store,
            store.portal_link_ticket(),
            &control,
            &mut cache,
            &NoApprovalRequests,
            |link, method, path, body, anchor, cap, stopped| {
                assert_eq!(
                    method, "POST",
                    "pending custody precedes listing or download"
                );
                assert!(path.ends_with("/receipt"));
                assert!(!body.is_empty() && anchor.is_some() && !stopped());
                assert_eq!(cap, 8192);
                attempts.borrow_mut().push(link.id);
                if round == 1 {
                    // The assertion catches a stale last_visited-only rotation:
                    // that would choose A again, exhaust the shared allowance,
                    // and leave B at the same residual-budget boundary forever.
                    assert_eq!(link.id, links[1].id);
                    token.store(true, Ordering::Release);
                    assert!(stopped());
                }
                Err(LinkError::Network)
            },
        )
        .unwrap();
        assert_eq!((result.added, result.refused), (0, 0));
        assert!(control.test_counts().2 <= MAX_PHYSICAL_READ);
        assert!(
            !cache.needs_manual(),
            "a record fitting fresh allowance is retryable"
        );
        if round == 0 {
            assert_eq!(control.reason(), Some(StopReason::Budget));
            assert_eq!(*attempts.borrow(), vec![links[0].id]);
        } else {
            assert_eq!(control.reason(), Some(StopReason::User));
        }
    }
    assert_eq!(*attempts.borrow(), vec![links[0].id, links[1].id]);
    // Neither synthetic failed exchange may settle or manufacture custody.
    assert_physical_fixture_unsettled(&store, 2);
}

#[test]
fn actual_picker_oversized_pending_record_pauses_only_its_link() {
    use crate::document_collection::{StopReason, MAX_PHYSICAL_READ};
    let links = accepted_links();
    let (_temp, store, mut cache) = store_with(&links);
    let oversized = super::delivery::automatic_pending_fixture_for_test(&store, &links[0]);
    let _later_same_link = super::delivery::automatic_pending_fixture_for_test(&store, &links[0]);
    let _other = super::delivery::automatic_pending_fixture_for_test(&store, &links[1]);
    assert!(
        replace_primary_with_physical_fixture(&store, oversized, 41 * 1024 * 1024)
            > MAX_PHYSICAL_READ
    );
    let first = physical_fixture_control(&store);
    check_cycle(
        &store,
        store.portal_link_ticket(),
        &first,
        &mut cache,
        &NoApprovalRequests,
        |_, _, _, _, _, _, _| panic!("oversized first record must not send a receipt or list"),
    )
    .unwrap();
    assert_eq!(first.reason(), Some(StopReason::Budget));
    assert!(first.test_counts().2 <= MAX_PHYSICAL_READ);
    assert!(cache.needs_manual());
    let fresh = physical_fixture_control(&store);
    let attempts = RefCell::new(Vec::new());
    check_cycle(
        &store,
        store.portal_link_ticket(),
        &fresh,
        &mut cache,
        &NoApprovalRequests,
        |link, method, path, _, _, _, stopped| {
            assert_eq!(link.id, links[1].id, "only the oversized link is paused");
            assert_eq!(method, "POST");
            assert!(path.ends_with("/receipt") && !stopped());
            attempts.borrow_mut().push(link.id);
            Err(LinkError::Network)
        },
    )
    .unwrap();
    assert_eq!(*attempts.borrow(), vec![links[1].id]);
    assert!(cache.needs_manual());
    assert_eq!(fresh.reason(), None);
    assert!(fresh.test_counts().2 <= MAX_PHYSICAL_READ);
    assert_physical_fixture_unsettled(&store, 3);
}

//! `check_cycle`'s answers to a portal that says something unusable, and to the receipt it sends
//! (the background check of a clinic's deliveries). SOURCE ONLY: a `cfg(test)` child of vault.
//!
//! These use the real `VaultStore`, the real `check_cycle` and the harness of
//! `automatic_collection_tests` (a checked-in signed approval, a synthetic exchange). No socket is
//! opened and no clinic key is trusted here: they pin what the cycle does with each reply, not the
//! network. FAKE data only.

use super::automatic_collection_tests::{accepted_links, page, store_with, NoApprovalRequests};
use super::*;
use crate::{
    document_collection::CycleControl,
    document_collection_pickup::{check_cycle, ResumeCache},
    portal_client::ApiResponse,
    portal_delivery::ReceiptOutcome,
    portal_link::{LinkError, StoredLink},
    portal_pickup::CheckResult,
};
use std::{
    cell::{Cell, RefCell},
    sync::{atomic::AtomicBool, Arc},
    time::Instant,
};

fn answer(status: u16, body: &[u8]) -> Result<ApiResponse, LinkError> {
    Ok(ApiResponse {
        status,
        body: zeroize::Zeroizing::new(body.to_vec()),
        date: None,
        retry_after: None,
    })
}

/// The first server page of the picker's list, changed by `change` before it is sent.
fn changed_page(
    link: &StoredLink,
    ids: &[usize],
    change: impl FnOnce(&mut serde_json::Value),
) -> Result<ApiResponse, LinkError> {
    let mut value: serde_json::Value = serde_json::from_slice(&page(link, ids, None).body).unwrap();
    change(&mut value);
    answer(200, &serde_json::to_vec(&value).unwrap())
}

fn empty_page() -> Result<ApiResponse, LinkError> {
    answer(
        200,
        br#"{"deliveries":[],"through":"100","next_cursor":null,"anchor_recorded":true}"#,
    )
}

/// One whole check cycle against `exchange`, with a fresh budget.
fn cycle<F>(store: &VaultStore, cache: &mut ResumeCache, exchange: F) -> CheckResult
where
    F: Fn(
        &StoredLink,
        &str,
        &str,
        Vec<u8>,
        Option<&str>,
        usize,
        &dyn Fn() -> bool,
    ) -> Result<ApiResponse, LinkError>,
{
    let control = CycleControl::new(Instant::now(), Arc::new(AtomicBool::new(false)));
    check_cycle(
        store,
        store.portal_link_ticket(),
        &control,
        cache,
        &NoApprovalRequests,
        exchange,
    )
    .unwrap()
}

fn receipt_outcome(store: &VaultStore, record: Uuid) -> Option<ReceiptOutcome> {
    let guard = store.session();
    let record = guard
        .as_ref()
        .unwrap()
        .manifest
        .records
        .iter()
        .find(|r| r.id == record)
        .unwrap();
    record.delivery.as_ref().unwrap().receipt_outcome
}

#[test]
fn a_refused_list_that_is_not_a_removed_device_is_asked_again_next_cycle() {
    let links = accepted_links();
    let (_temp, store, mut cache) = store_with(&links[..1]);
    let calls = Cell::new(0);
    let busy = |_: &StoredLink,
                _: &str,
                path: &str,
                _: Vec<u8>,
                _: Option<&str>,
                _: usize,
                _: &dyn Fn() -> bool| {
        calls.set(calls.get() + 1);
        assert!(path.contains('?'), "only the list is asked");
        answer(503, br#"{"code":"maintenance"}"#)
    };
    for round in 1..=2 {
        let result = cycle(&store, &mut cache, busy);
        assert_eq!((result.added, result.refused), (0, 0));
        assert_eq!(calls.get(), round, "asked again, not skipped");
    }
    // Not the device being gone, and not a page to wait on a person for.
    assert!(!store.link_gone(links[0].id));
    assert!(!cache.needs_manual());
}

/// What a list reply can get wrong; the cycle pauses that link's automatic checks (a person looks)
/// instead of acting on it or asking the same thing again.
#[test]
fn a_list_page_that_cannot_be_used_pauses_the_link_and_is_not_asked_again() {
    let links = accepted_links();
    let link = &links[0];
    type Case = (
        &'static str,
        Box<dyn Fn(&StoredLink) -> Result<ApiResponse, LinkError>>,
    );
    let cases: Vec<Case> = vec![
        (
            "a body that is not JSON",
            Box::new(|_| answer(200, b"<html>maintenance</html>")),
        ),
        (
            "a snapshot number that is not a plain number",
            Box::new(|link| changed_page(link, &[1], |v| v["through"] = "abc".into())),
        ),
        (
            "a snapshot number with leading zeros",
            Box::new(|link| changed_page(link, &[1], |v| v["through"] = "0100".into())),
        ),
        (
            "a snapshot number past what a database counts",
            Box::new(|link| {
                changed_page(link, &[1], |v| v["through"] = "9223372036854775808".into())
            }),
        ),
        (
            "a next cursor that is not a number",
            Box::new(|link| changed_page(link, &[1], |v| v["next_cursor"] = "x".into())),
        ),
        (
            "a next cursor that does not move forward",
            Box::new(|link| changed_page(link, &[1], |v| v["next_cursor"] = "0".into())),
        ),
        (
            "a next cursor past the snapshot",
            Box::new(|link| changed_page(link, &[1], |v| v["next_cursor"] = "101".into())),
        ),
        (
            "an anchor the portal did not record",
            Box::new(|link| changed_page(link, &[1], |v| v["anchor_recorded"] = false.into())),
        ),
        (
            "more than 100 deliveries",
            Box::new(|link| changed_page(link, &(1..=101).collect::<Vec<_>>(), |_| {})),
        ),
        (
            "the same delivery twice",
            Box::new(|link| changed_page(link, &[3, 3], |_| {})),
        ),
        (
            "a delivery of an unsupported version",
            Box::new(|link| changed_page(link, &[1], |v| v["deliveries"][0]["v"] = 2.into())),
        ),
        (
            "a delivery with a size no package can have",
            Box::new(|link| changed_page(link, &[1], |v| v["deliveries"][0]["size"] = 3.into())),
        ),
        (
            "a delivery that already expired",
            Box::new(|link| {
                changed_page(link, &[1], |v| {
                    let now = crate::now_ms() / 1000;
                    v["deliveries"][0]["created_at"] = (now - 100).into();
                    v["deliveries"][0]["expires_at"] = (now - 1).into();
                })
            }),
        ),
    ];
    for (name, reply) in cases {
        let (_temp, store, mut cache) = store_with(&links[..1]);
        let calls = Cell::new(0);
        let exchange = |l: &StoredLink,
                        _: &str,
                        path: &str,
                        _: Vec<u8>,
                        _: Option<&str>,
                        _: usize,
                        _: &dyn Fn() -> bool| {
            calls.set(calls.get() + 1);
            assert!(path.contains('?'), "{name}: nothing is downloaded from it");
            reply(l)
        };
        let result = cycle(&store, &mut cache, exchange);
        assert_eq!((result.added, result.refused), (0, 0), "{name}");
        assert_eq!(calls.get(), 1, "{name}");
        assert!(cache.needs_manual(), "{name}: the link waits for a person");
        // The next cycle does not ask a portal that said that.
        cycle(&store, &mut cache, exchange);
        assert_eq!(calls.get(), 1, "{name}: not asked again");
        assert!(
            !store.link_gone(link.id),
            "{name}: a bad page does not make the device gone"
        );
        assert!(store.snapshot().unwrap().records.is_empty(), "{name}");
    }
}

#[test]
fn a_delivery_the_portal_will_not_hand_over_is_skipped_and_the_next_one_is_tried() {
    let links = accepted_links();
    let (_temp, store, mut cache) = store_with(&links[..1]);
    let asked = RefCell::new(Vec::new());
    let result = cycle(&store, &mut cache, |link, _, path, _, _, _, _| {
        if path.contains('?') {
            return Ok(page(link, &[1, 2, 3], None));
        }
        asked.borrow_mut().push(path.to_owned());
        // The first is gone and the second is refused: neither is a failure of the link.
        match asked.borrow().len() {
            1 => answer(404, br#"{"code":"delivery_not_found"}"#),
            2 => answer(500, b"{}"),
            _ => Err(LinkError::Network),
        }
    });
    assert_eq!((result.added, result.refused), (0, 0));
    assert_eq!(asked.borrow().len(), 3, "each of the three was tried");
    assert!(store.snapshot().unwrap().records.is_empty());
    assert!(!cache.needs_manual());
}

#[test]
fn a_package_that_is_not_what_was_listed_is_refused_not_kept() {
    let links = accepted_links();
    let (_temp, store, mut cache) = store_with(&links[..1]);
    let result = cycle(&store, &mut cache, |link, _, path, _, _, _, _| {
        if path.contains('?') {
            Ok(page(link, &[1], None))
        } else {
            // 49 bytes, as listed, but not the ciphertext whose hash the portal listed.
            answer(200, &[0x41; 49])
        }
    });
    assert_eq!((result.added, result.refused), (0, 1));
    assert!(store.snapshot().unwrap().records.is_empty());
}

/// The receipt a picked-up document owes the portal: what each of its answers settles.
#[test]
fn a_receipt_is_settled_by_the_portals_picked_up_or_not_found_and_by_nothing_else() {
    let links = accepted_links();
    let link = &links[0];
    let cases: [(&str, u16, &[u8], Option<ReceiptOutcome>); 8] = [
        (
            "picked up",
            200,
            br#"{"status":"picked_up"}"#,
            Some(ReceiptOutcome::PickedUp),
        ),
        (
            "the delivery is gone",
            404,
            br#"{"code":"delivery_not_found"}"#,
            Some(ReceiptOutcome::Gone),
        ),
        (
            "200 with another status",
            200,
            br#"{"status":"queued"}"#,
            None,
        ),
        (
            "200 with an extra field",
            200,
            br#"{"status":"picked_up","extra":1}"#,
            None,
        ),
        ("200 with no JSON", 200, b"ok", None),
        ("404 with another code", 404, br#"{"code":"nope"}"#, None),
        ("a server error", 500, br#"{"status":"picked_up"}"#, None),
        (
            "picked up said with a 201",
            201,
            br#"{"status":"picked_up"}"#,
            None,
        ),
    ];
    for (name, status, body, settled) in cases {
        let (_temp, store, mut cache) = store_with(&links[..1]);
        let record = super::delivery::automatic_pending_fixture_for_test(&store, link);
        let posts = RefCell::new(Vec::new());
        let lists = Cell::new(0);
        let result = cycle(
            &store,
            &mut cache,
            |_, method, path, request, anchor, cap, _| {
                if method == "POST" {
                    assert!(path.ends_with("/receipt"), "{name}");
                    assert_eq!(cap, 8192, "{name}");
                    assert!(
                        anchor.is_some(),
                        "{name}: the receipt carries the vault anchor"
                    );
                    posts.borrow_mut().push(request);
                    answer(status, body)
                } else {
                    lists.set(lists.get() + 1);
                    empty_page()
                }
            },
        );
        assert_eq!(posts.borrow().len(), 1, "{name}: one receipt is sent");
        let sent: serde_json::Value = serde_json::from_slice(&posts.borrow()[0]).unwrap();
        assert_eq!(
            sent.as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>()),
            Some(vec!["receipt".to_owned()]),
            "{name}: the body is the receipt and nothing else"
        );
        assert!(!sent["receipt"].is_null(), "{name}");
        assert_eq!((result.added, result.refused), (0, 0), "{name}");
        match settled {
            Some(outcome) => {
                assert!(receipt_outcome(&store, record) == Some(outcome), "{name}");
                assert_eq!(lists.get(), 1, "{name}: then the list is read");
            }
            None => {
                assert!(
                    receipt_outcome(&store, record).is_none(),
                    "{name}: not settled"
                );
                assert_eq!(
                    lists.get(),
                    0,
                    "{name}: a failed receipt ends this link's turn"
                );
            }
        }
    }
}

#[test]
fn a_device_the_portal_removed_while_answering_a_list_is_marked_gone_and_not_asked_again() {
    // The list says "device_removed" (403): the same reading as the manual check's.
    let links = accepted_links();
    let (_temp, store, mut cache) = store_with(&links[..1]);
    let calls = Cell::new(0);
    let removed = |_: &StoredLink,
                   _: &str,
                   _: &str,
                   _: Vec<u8>,
                   _: Option<&str>,
                   _: usize,
                   _: &dyn Fn() -> bool| {
        calls.set(calls.get() + 1);
        answer(403, br#"{"code":"device_removed"}"#)
    };
    cycle(&store, &mut cache, removed);
    assert!(store.link_gone(links[0].id));
    cycle(&store, &mut cache, removed);
    assert_eq!(calls.get(), 1);
    // A 403 that says something else is only a refusal.
    let (_temp, store, mut cache) = store_with(&links[..1]);
    cycle(&store, &mut cache, |_, _, _, _, _, _, _| {
        answer(403, br#"{"code":"forbidden"}"#)
    });
    assert!(!store.link_gone(links[0].id));
}

#[test]
fn no_request_is_made_when_the_cycle_was_stopped_before_it_began() {
    let links = accepted_links();
    let (_temp, store, mut cache) = store_with(&links[..1]);
    let token = Arc::new(AtomicBool::new(true));
    let control = CycleControl::new(Instant::now(), token);
    let result = check_cycle(
        &store,
        store.portal_link_ticket(),
        &control,
        &mut cache,
        &NoApprovalRequests,
        |_: &StoredLink,
         _: &str,
         _: &str,
         _: Vec<u8>,
         _: Option<&str>,
         _: usize,
         _: &dyn Fn() -> bool|
         -> Result<ApiResponse, LinkError> { panic!("a stopped cycle sends nothing") },
    )
    .unwrap();
    assert_eq!((result.added, result.refused), (0, 0));
}

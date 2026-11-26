//! What a saved or a reported device-approval request must be, and what is refused. FAKE keys only,
//! from the shared fixture; every case changes ONE thing a check looks at.

use super::*;
use crate::portal_approval::{
    create, first_fixture, fixture_acceptance_with, fixture_challenge_with, parse_status,
    valid_saved,
};
use crate::vault::VaultError;

fn status_body(
    attempt: &Attempt,
    status: &str,
    challenge: Option<&str>,
    acceptance: Option<&str>,
) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "request_id": attempt.request_id.to_string(),
        "status": status,
        "challenge": challenge,
        "acceptance": acceptance,
        "reason": null,
    }))
    .unwrap()
}

fn refused<T>(result: Result<T, VaultError>) {
    // (An attempt is never printed: it holds signed objects.)
    assert!(
        matches!(
            result,
            Err(VaultError::Portal(
                crate::portal_link::LinkError::InvalidResponse
            ))
        ),
        "expected the report to be refused as an invalid response"
    );
}

#[test]
fn a_request_is_not_made_for_a_clock_past_the_most_a_time_can_hold() {
    let (x, link, _) = first_fixture();
    let now = x["now"].as_u64().unwrap();
    assert!(create(&link, now).is_ok());
    // The clock is the number of seconds a safe integer can hold, no more.
    assert!(matches!(
        create(&link, 9_007_199_254_740_001),
        Err(VaultError::Invalid)
    ));
    // And a link with no clinic has nobody to ask.
    let mut bare = link.clone();
    bare.clinic = None;
    assert!(matches!(create(&bare, now), Err(VaultError::Invalid)));
}

#[test]
fn a_report_that_changes_what_was_already_signed_is_refused() {
    let (x, link, attempt) = first_fixture();
    let first = &x["flows"]["first"];
    let challenge = first["challenge"]["compact"].as_str().unwrap().to_owned();
    // The request holds a challenge; the portal now reports another (a different signed one).
    let mut holding = attempt.clone();
    holding.challenge = Some(challenge.clone());
    holding.status = Some(ApprovalState::ChallengeReady);
    let other = fixture_challenge_with(|claims| {
        claims["challenge_id"] = "FAKE-another-challenge-id".into();
    });
    assert_ne!(other, challenge);
    refused(parse_status(
        &link,
        &holding,
        &status_body(&holding, "challenge_ready", Some(&other), None),
    ));
    // The same challenge again is fine.
    assert!(parse_status(
        &link,
        &holding,
        &status_body(&holding, "challenge_ready", Some(&challenge), None),
    )
    .is_ok());
    // A request that holds an acceptance is never given another one, even a signed one.
    let accepted = first["acceptance"]["compact"].as_str().unwrap().to_owned();
    let mut done = holding.clone();
    done.acceptance = Some(accepted.clone());
    done.status = Some(ApprovalState::Accepted);
    let another = fixture_acceptance_with(&challenge, |claims| {
        claims["accepted_at"] = (claims["accepted_at"].as_u64().unwrap() + 1).into();
    });
    assert_ne!(another, accepted);
    assert!(parse_status(
        &link,
        &done,
        &status_body(&done, "accepted", Some(&challenge), Some(&another)),
    )
    .is_err());
}

#[test]
fn a_saved_request_that_contradicts_itself_is_not_trusted() {
    let (_, link, attempt) = first_fixture();
    assert!(valid_saved(&link, &attempt));
    let with = |change: &dyn Fn(&mut Attempt)| {
        let mut changed = attempt.clone();
        change(&mut changed);
        changed
    };
    // Accepted with no acceptance; an acceptance with a status that is not accepted; a reason
    // for a request that has not failed.
    assert!(!valid_saved(
        &link,
        &with(&|a| a.status = Some(ApprovalState::Accepted))
    ));
    assert!(!valid_saved(
        &link,
        &with(&|a| {
            a.acceptance = Some("FAKE.acceptance".to_owned());
            a.status = Some(ApprovalState::Pending);
        })
    ));
    assert!(!valid_saved(
        &link,
        &with(&|a| a.reason = Some(ApprovalReason::InvalidProof))
    ));
    // An acceptance with no challenge to accept.
    assert!(!valid_saved(
        &link,
        &with(&|a| {
            a.acceptance = Some("FAKE.acceptance".to_owned());
            a.status = Some(ApprovalState::Accepted);
        })
    ));
    // A link with no clinic trusts nothing.
    let mut bare = link.clone();
    bare.clinic = None;
    assert!(!valid_saved(&bare, &attempt));
}

#[test]
fn a_saved_request_whose_intent_is_not_the_one_this_device_signed_is_not_trusted() {
    let (_, link, attempt) = first_fixture();
    let with_intent = |intent: &str| Attempt {
        intent: intent.to_owned(),
        ..attempt.clone()
    };
    // Not a compact signed object at all; one whose payload is not the intent's JSON.
    assert!(!valid_saved(&link, &with_intent("")));
    assert!(!valid_saved(&link, &with_intent("not-compact")));
    assert!(!valid_saved(&link, &with_intent("e30.AAAA")));
    // The real intent with the signature's last character changed: it no longer verifies.
    let mut broken = attempt.intent.clone();
    let last = broken.pop().unwrap();
    broken.push(if last == 'A' { 'B' } else { 'A' });
    assert!(!valid_saved(&link, &with_intent(&broken)));
    // The real intent for another request, another expiry or another device's saved request.
    assert!(!valid_saved(
        &link,
        &Attempt {
            request_id: uuid::Uuid::new_v4(),
            ..attempt.clone()
        }
    ));
    assert!(!valid_saved(
        &link,
        &Attempt {
            expires_at: attempt.expires_at + 1,
            ..attempt.clone()
        }
    ));
}

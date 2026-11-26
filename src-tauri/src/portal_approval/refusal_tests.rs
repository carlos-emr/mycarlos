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
    // The clock is the number of seconds a safe integer can hold, no more: the limit itself is
    // allowed, one past it is not.
    assert!(create(&link, 9_007_199_254_740_000).is_ok());
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
    // (The fixture's own challenge and its real acceptance, so that without the status rule this
    // request would be trusted: only that rule refuses it.)
    let (x, _, _) = first_fixture();
    let first = &x["flows"]["first"];
    let complete = |status: ApprovalState| {
        with(&|a| {
            a.challenge = Some(first["challenge"]["compact"].as_str().unwrap().to_owned());
            a.acceptance = Some(first["acceptance"]["compact"].as_str().unwrap().to_owned());
            a.status = Some(status);
        })
    };
    assert!(valid_saved(&link, &complete(ApprovalState::Accepted)));
    assert!(!valid_saved(&link, &complete(ApprovalState::Pending)));
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

/// The saved request's own intent, with ONE field changed, signed again by this device's key (so
/// only the check on that field can refuse it); `expires_at` follows `exp` when `exp` is changed,
/// so the check that the two agree is not what refuses.
fn resigned(
    link: &crate::portal_link::StoredLink,
    attempt: &Attempt,
    change: impl FnOnce(&mut serde_json::Value),
) -> Attempt {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine as _};
    let payload = attempt.intent.split('.').next().unwrap();
    let mut intent: serde_json::Value =
        serde_json::from_slice(&B64.decode(payload).unwrap()).unwrap();
    change(&mut intent);
    Attempt {
        intent: link.keys.sign(&serde_json::to_vec(&intent).unwrap()),
        expires_at: intent["exp"].as_u64().unwrap(),
        ..attempt.clone()
    }
}

/// One field of the intent changed.
type Change = Box<dyn Fn(&mut serde_json::Value)>;

#[test]
fn a_saved_intent_is_trusted_only_while_each_of_its_fields_is_what_this_device_signed() {
    let (x, link, _) = first_fixture();
    let now = x["now"].as_u64().unwrap();
    let base = create(&link, now).unwrap();
    // Re-signing it unchanged is accepted, so every refusal below is the one changed field.
    assert!(valid_saved(&link, &resigned(&link, &base, |_| {})));
    let other = |v: &mut serde_json::Value, field: &str| {
        let text = format!("{}x", v[field].as_str().unwrap());
        v[field] = text.into();
    };
    let refused: Vec<(&str, Change)> = vec![
        ("v", Box::new(|v| v["v"] = 2.into())),
        ("typ", Box::new(move |v| other(v, "typ"))),
        ("aud", Box::new(move |v| other(v, "aud"))),
        ("iss", Box::new(move |v| other(v, "iss"))),
        (
            "candidate_device_key_id",
            Box::new(move |v| other(v, "candidate_device_key_id")),
        ),
        (
            "candidate_x25519_public_key",
            Box::new(move |v| other(v, "candidate_x25519_public_key")),
        ),
        (
            "candidate_ed25519_public_key",
            Box::new(move |v| other(v, "candidate_ed25519_public_key")),
        ),
        ("clinic_id", Box::new(move |v| other(v, "clinic_id"))),
        ("recipient_id", Box::new(move |v| other(v, "recipient_id"))),
        (
            "public_portal_base_url",
            Box::new(move |v| other(v, "public_portal_base_url")),
        ),
        (
            "predecessor_device_key_id",
            Box::new(|v| v["predecessor_device_key_id"] = "FAKE-earlier-key".into()),
        ),
        // The lifetime: not after it began, and at most ten minutes.
        ("exp = iat", Box::new(|v| v["iat"] = v["exp"].clone())),
        (
            "exp < iat",
            Box::new(|v| v["iat"] = (v["exp"].as_u64().unwrap() + 1).into()),
        ),
        (
            "lifetime 601",
            Box::new(|v| v["iat"] = (v["exp"].as_u64().unwrap() - 601).into()),
        ),
        // Past the most a time can hold (iat moved with it, so the lifetime is still 600).
        (
            "exp past a safe integer",
            Box::new(|v| {
                v["exp"] = 9_007_199_254_740_992u64.into();
                v["iat"] = (9_007_199_254_740_992u64 - 600).into();
            }),
        ),
    ];
    for (name, change) in refused {
        assert!(
            !valid_saved(&link, &resigned(&link, &base, change)),
            "a changed {name} is still trusted"
        );
    }
    // The edges that ARE allowed: exactly ten minutes, a shorter life, and the largest time.
    assert!(valid_saved(
        &link,
        &resigned(&link, &base, |v| v["iat"] =
            (v["exp"].as_u64().unwrap() - 600).into())
    ));
    assert!(valid_saved(
        &link,
        &resigned(&link, &base, |v| v["iat"] =
            (v["exp"].as_u64().unwrap() - 1).into())
    ));
    assert!(valid_saved(
        &link,
        &resigned(&link, &base, |v| {
            v["exp"] = 9_007_199_254_740_991u64.into();
            v["iat"] = (9_007_199_254_740_991u64 - 600).into();
        })
    ));
}

#[test]
fn a_saved_challenge_or_acceptance_that_no_longer_verifies_is_not_trusted() {
    let (x, link, attempt) = first_fixture();
    let first = &x["flows"]["first"];
    let good_challenge = first["challenge"]["compact"].as_str().unwrap().to_owned();
    let good_acceptance = first["acceptance"]["compact"].as_str().unwrap().to_owned();
    // Another request's id, fixed (a valid version 4 id) so a failure repeats.
    let other = "6f3a1c52-8d4e-4b7a-9c10-2e5f7a3b9d01".to_string();
    let complete = |challenge: &str, acceptance: Option<&str>, status: ApprovalState| Attempt {
        challenge: Some(challenge.to_owned()),
        acceptance: acceptance.map(str::to_owned),
        status: Some(status),
        ..attempt.clone()
    };
    // The control: the fixture's own challenge, and with its acceptance, are trusted.
    assert!(valid_saved(
        &link,
        &complete(&good_challenge, None, ApprovalState::ChallengeReady)
    ));
    assert!(valid_saved(
        &link,
        &complete(
            &good_challenge,
            Some(&good_acceptance),
            ApprovalState::Accepted
        )
    ));
    // The helpers' re-signing alone changes nothing: the same pair made with no change is trusted
    // in the same shape, so the request id is the one thing refused below.
    let resigned_challenge = fixture_challenge_with(|_| {});
    let resigned_acceptance = fixture_acceptance_with(&good_challenge, |_| {});
    assert!(valid_saved(
        &link,
        &complete(&resigned_challenge, None, ApprovalState::ChallengeReady)
    ));
    assert!(valid_saved(
        &link,
        &complete(
            &good_challenge,
            Some(&resigned_acceptance),
            ApprovalState::Accepted
        )
    ));
    // A challenge about another request (signed properly by the clinic's key, so only the check
    // that it is for THIS request refuses it).
    let wrong_challenge =
        fixture_challenge_with(|claims| claims["request_id"] = other.clone().into());
    assert!(!valid_saved(
        &link,
        &complete(&wrong_challenge, None, ApprovalState::ChallengeReady)
    ));
    // An acceptance of another request, with the good challenge in place.
    let wrong_acceptance = fixture_acceptance_with(&good_challenge, |claims| {
        claims["request_id"] = other.clone().into()
    });
    assert!(!valid_saved(
        &link,
        &complete(
            &good_challenge,
            Some(&wrong_acceptance),
            ApprovalState::Accepted
        )
    ));
}

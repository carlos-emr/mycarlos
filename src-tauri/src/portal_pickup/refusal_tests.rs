//! What decides which links a check asks, and how a failure of one link is told. FAKE data only.

use super::*;
use crate::portal_approval::{first_fixture, ApprovalState, Attempt};
use crate::portal_link::LinkError;
use crate::vault::VaultError;

#[test]
fn only_a_failure_of_one_link_goes_on_to_the_next_link() {
    // A check that was cancelled, or whose portal is unavailable, ends for every link; so does a
    // failure of the vault itself.
    for stops in [
        VaultError::Portal(LinkError::Cancelled),
        VaultError::Portal(LinkError::Unavailable),
        VaultError::Locked,
        VaultError::Storage,
        VaultError::Corrupt,
        VaultError::NoSpace,
    ] {
        assert!(!is_per_link_failure(&stops), "{stops:?}");
    }
    // What is wrong with one clinic's link is that link's issue, and the next link is still asked.
    for per_link in [
        VaultError::Portal(LinkError::InvalidResponse),
        VaultError::Portal(LinkError::Network),
        VaultError::Portal(LinkError::DeviceRemoved),
        VaultError::Portal(LinkError::RateLimited(Some(5))),
        VaultError::Portal(LinkError::HttpRefused(503, None)),
        VaultError::ApprovalTerminal(ApprovalState::Refused, None),
        VaultError::ApprovalRequestMissing,
        VaultError::ApprovalNeedsClinic,
        VaultError::NotFound,
        VaultError::Invalid,
    ] {
        assert!(is_per_link_failure(&per_link), "{per_link:?}");
    }
}

#[test]
fn a_request_is_still_open_only_while_it_is_pending_or_ready_for_the_clinic() {
    for (state, open) in [
        (ApprovalState::Pending, true),
        (ApprovalState::ChallengeReady, true),
        (ApprovalState::Accepted, false),
        (ApprovalState::Refused, false),
        (ApprovalState::Expired, false),
        (ApprovalState::Cancelled, false),
    ] {
        assert_eq!(still_open(state), open, "{state:?}");
    }
}

#[test]
fn a_clinic_is_asked_only_with_an_approval_or_a_request_still_open() {
    let (_, link, attempt) = first_fixture();
    // No request saved: no reason to ask.
    assert!(link.approval.is_none());
    assert!(!worth_asking(&link));
    let with = |status: Option<ApprovalState>, acceptance: Option<String>| {
        let mut link = link.clone();
        link.approval = Some(Attempt {
            status,
            acceptance,
            ..attempt.clone()
        });
        link
    };
    // A request with no status yet reads as pending, and is asked; so is one ready for the clinic.
    assert!(worth_asking(&with(None, None)));
    assert!(worth_asking(&with(Some(ApprovalState::Pending), None)));
    assert!(worth_asking(&with(
        Some(ApprovalState::ChallengeReady),
        None
    )));
    // A refused, expired or cancelled one is not a reason to ask.
    for ended in [
        ApprovalState::Refused,
        ApprovalState::Expired,
        ApprovalState::Cancelled,
    ] {
        assert!(!worth_asking(&with(Some(ended), None)), "{ended:?}");
    }
    // An acceptance the clinic's current keys cannot prove is not an approval either.
    assert!(!worth_asking(&with(
        Some(ApprovalState::Accepted),
        Some("FAKE.acceptance".to_owned())
    )));
}

#[test]
fn an_issue_names_the_clinic_once_and_says_what_a_removed_or_incomplete_link_means() {
    let (_, link, _) = first_fixture();
    let mut result = CheckResult::default();
    add_issue(&mut result, &link, VaultError::Invalid);
    add_issue(&mut result, &link, VaultError::NotFound);
    // Both say the link is incomplete, and one issue is kept for one code.
    assert_eq!(result.issues.len(), 1);
    assert_eq!(result.issues[0].code, "portal_link_incomplete");
    assert_eq!(result.issues[0].link_id, link.id);
    assert_eq!(result.issues[0].clinic_name, "FAKE M3 clinic");
    add_issue(
        &mut result,
        &link,
        VaultError::Portal(LinkError::DeviceRemoved),
    );
    assert_eq!(result.issues.len(), 2);
    assert_eq!(result.issues[1].code, "portal_device_removed");
    // Any other error is said by its own public code, and a link with no clinic has no name.
    let mut other = CheckResult::default();
    let mut bare = link.clone();
    bare.clinic = None;
    add_issue(&mut other, &bare, VaultError::Locked);
    assert_eq!(other.issues.len(), 1);
    assert!(!other.issues[0].code.is_empty());
    assert_ne!(other.issues[0].code, "portal_link_incomplete");
    assert_eq!(other.issues[0].clinic_name, "");
}

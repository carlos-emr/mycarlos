//! Explicit foreground mailbox check. All requests use saved link destinations;
//! the only receipt source is a successfully committed vault custody record.
use serde::Serialize;
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub added: usize,
    pub refused: usize,
    pub receipts_pending: usize,
    pub issues: Vec<CheckIssue>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckIssue {
    pub link_id: uuid::Uuid,
    pub clinic_name: String,
    pub code: String,
}

pub(crate) fn is_per_link_failure(error: &crate::vault::VaultError) -> bool {
    use crate::{portal_link::LinkError, vault::VaultError};
    match error {
        VaultError::Portal(LinkError::Cancelled | LinkError::Unavailable) => false,
        VaultError::Portal(_)
        | VaultError::ApprovalTerminal(_, _)
        | VaultError::ApprovalRequestMissing
        | VaultError::ApprovalNeedsClinic
        | VaultError::NotFound
        | VaultError::Invalid => true,
        _ => false,
    }
}
fn add_issue(
    result: &mut CheckResult,
    link: &crate::portal_link::StoredLink,
    error: crate::vault::VaultError,
) {
    let code = match &error {
        crate::vault::VaultError::Invalid | crate::vault::VaultError::NotFound => {
            "portal_link_incomplete"
        }
        // Said as it is, as the status check says it (#131): checking again
        // cannot help a device the portal removed (#128).
        crate::vault::VaultError::Portal(crate::portal_link::LinkError::DeviceRemoved) => {
            "portal_device_removed"
        }
        _ => crate::PublicText::from(error).code,
    };
    add_issue_code(result, link, code);
}
/// A saved clinic document that no longer reads back: its receipt is held,
/// never sent, and the rest of the check goes on.
pub(crate) const DAMAGED_CODE: &str = "pickup_damaged";
/// Download failures in a row (no reply at all) after which the portal or
/// the connection is taken to be down for this clinic, rather than waiting
/// out a timeout for every delivery still listed.
const MAX_DOWNLOAD_FAILURES_IN_A_ROW: usize = 3;
/// A portal from before reading aids (the 29 Oct demo portal, 1705edb) refuses a listing
/// that names the kinds this device understands: it answers any query key it does not know
/// with 400 `{"code":"invalid_cursor"}`.
fn refuses_unknown_query(response: &crate::portal_client::ApiResponse) -> bool {
    response.status == 400
        && serde_json::from_slice::<serde_json::Value>(&response.body)
            .ok()
            .is_some_and(|body| body.get("code").and_then(|c| c.as_str()) == Some("invalid_cursor"))
}
fn add_issue_code(result: &mut CheckResult, link: &crate::portal_link::StoredLink, code: &str) {
    if result
        .issues
        .iter()
        .any(|i| i.link_id == link.id && i.code == code)
    {
        return;
    }
    result.issues.push(CheckIssue {
        link_id: link.id,
        clinic_name: link
            .clinic
            .as_ref()
            .map(|c| c.clinic_name.clone())
            .unwrap_or_default(),
        code: code.into(),
    });
}
/// Whether a check for new documents contacts this link's clinic (Ben,
/// D132c): only for a device the clinic approved, or with a request still
/// open as last saved (pending, or ready for the clinic). A link with no
/// saved request, or whose request was refused or has ended, is no reason to
/// ask; a saved request with no status yet reads as pending, and is asked.
/// The check after unlocking and Check for new documents both go by it.
///
/// "Approved" is judged by the clinic's current keys (`currently_approved`).
/// That holds while a link's clinic keys are fixed when it is made; when key
/// refresh or revocation comes, decide whether an acceptance signed by a
/// retired key still counts here, or an approved device stops being asked.
pub(crate) fn worth_asking(link: &crate::portal_link::StoredLink) -> bool {
    crate::portal_approval::currently_approved(link)
        || link
            .approval
            .as_ref()
            .is_some_and(|attempt| attempt.acceptance.is_none() && still_open(attempt.state()))
}
/// Whether a request in this state can still be approved. Every state is
/// named, so that a new one has to be decided here.
fn still_open(state: crate::portal_approval::ApprovalState) -> bool {
    use crate::portal_approval::ApprovalState;
    match state {
        ApprovalState::Pending | ApprovalState::ChallengeReady => true,
        ApprovalState::Accepted
        | ApprovalState::Refused
        | ApprovalState::Expired
        | ApprovalState::Cancelled => false,
    }
}
pub(crate) fn check(
    store: &crate::vault::VaultStore,
    session: u64,
) -> Result<CheckResult, crate::vault::VaultError> {
    check_asking_using(
        store,
        session,
        &crate::portal_approval::ApprovalHttp::default(),
        crate::portal_client::api,
    )
}
/// The check as the app runs it: only the clinics worth asking.
pub(crate) fn check_asking_using<F>(
    store: &crate::vault::VaultStore,
    session: u64,
    approval: &impl crate::portal_approval::ApprovalExchange,
    exchange: F,
) -> Result<CheckResult, crate::vault::VaultError>
where
    F: Fn(
        &crate::portal_link::StoredLink,
        &str,
        &str,
        Vec<u8>,
        Option<&str>,
        usize,
        &dyn Fn() -> bool,
    ) -> Result<crate::portal_client::ApiResponse, crate::portal_link::LinkError>,
{
    check_links_using(store, session, approval, exchange, &worth_asking)
}
/// Every linked clinic, whatever its approval: for tests of the pipeline.
#[cfg(test)]
pub(crate) fn check_using<F>(
    store: &crate::vault::VaultStore,
    session: u64,
    approval: &impl crate::portal_approval::ApprovalExchange,
    exchange: F,
) -> Result<CheckResult, crate::vault::VaultError>
where
    F: Fn(
        &crate::portal_link::StoredLink,
        &str,
        &str,
        Vec<u8>,
        Option<&str>,
        usize,
        &dyn Fn() -> bool,
    ) -> Result<crate::portal_client::ApiResponse, crate::portal_link::LinkError>,
{
    check_links_using(store, session, approval, exchange, &|_| true)
}
fn check_links_using<F>(
    store: &crate::vault::VaultStore,
    session: u64,
    approval: &impl crate::portal_approval::ApprovalExchange,
    exchange: F,
    include: &dyn Fn(&crate::portal_link::StoredLink) -> bool,
) -> Result<CheckResult, crate::vault::VaultError>
where
    F: Fn(
        &crate::portal_link::StoredLink,
        &str,
        &str,
        Vec<u8>,
        Option<&str>,
        usize,
        &dyn Fn() -> bool,
    ) -> Result<crate::portal_client::ApiResponse, crate::portal_link::LinkError>,
{
    use crate::{
        portal_delivery::{Outer, ReceiptOutcome},
        portal_link::{LinkError, StoredLink},
        vault::VaultError,
    };
    use serde::Deserialize;
    let cancelled = || store.portal_link_ticket() != session;
    // A refusal that says the portal removed this device is told apart from
    // a connection failure (#128); any other answer is not one this check
    // can use.
    let refused = |response: &crate::portal_client::ApiResponse| {
        VaultError::Portal(if crate::portal_approval::device_removed(response) {
            LinkError::DeviceRemoved
        } else {
            LinkError::Network
        })
    };
    // Posts one kept receipt (an original's or a reading aid's) and returns what the
    // portal answered; settling it in the vault is the caller's step.
    let post_receipt = |link: &StoredLink,
                        delivery_id: &str,
                        receipt: &str|
     -> Result<ReceiptOutcome, VaultError> {
        let anchor = store.delivery_anchor(link, session)?;
        let body = serde_json::to_vec(&serde_json::json!({"receipt":receipt}))
            .map_err(|_| VaultError::Storage)?;
        let response = exchange(
            link,
            "POST",
            &format!("/api/mycarlos/deliveries/{delivery_id}/receipt"),
            body,
            Some(&anchor),
            8192,
            &cancelled,
        )
        .map_err(VaultError::Portal)?;
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Status {
            status: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Code {
            code: String,
        }
        match response.status {
            200 if serde_json::from_slice::<Status>(&response.body)
                .ok()
                .is_some_and(|v| v.status == "picked_up") =>
            {
                Ok(ReceiptOutcome::PickedUp)
            }
            404 if serde_json::from_slice::<Code>(&response.body)
                .ok()
                .is_some_and(|v| v.code == "delivery_not_found") =>
            {
                Ok(ReceiptOutcome::Gone)
            }
            _ => Err(refused(&response)),
        }
    };
    let send = |link: &StoredLink, c: &crate::portal_delivery::Custody| -> Result<(), VaultError> {
        let outcome = post_receipt(link, &c.outer.delivery_id, &c.receipt)?;
        store.settle_receipt(link, c, outcome, session)
    };
    let send_aid =
        |link: &StoredLink, a: &crate::portal_delivery::AidCustody| -> Result<(), VaultError> {
            let outcome = post_receipt(link, &a.outer.delivery_id, &a.receipt)?;
            store.settle_aid_receipt(link, a, outcome, session)
        };
    // Both kinds of kept receipt for one link, in one place.
    let send_pending = |link: &StoredLink| -> Result<(), VaultError> {
        let pending = store.pending_receipts_checked(link, session)?;
        for c in &pending.ready {
            send(link, c)?;
        }
        for a in &pending.ready_aids {
            send_aid(link, a)?;
        }
        Ok(())
    };
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Page {
        deliveries: Vec<Outer>,
        #[serde(deserialize_with = "nullable")]
        next_cursor: Option<String>,
        through: String,
        anchor_recorded: bool,
    }
    fn nullable<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
        Option::deserialize(d)
    }
    let cursor = |s: &str| -> Result<u64, VaultError> {
        let n = s
            .parse::<u64>()
            .map_err(|_| VaultError::Portal(LinkError::InvalidResponse))?;
        if n > i64::MAX as u64 || n.to_string() != s {
            return Err(VaultError::Portal(LinkError::InvalidResponse));
        }
        Ok(n)
    };
    let mut result = CheckResult::default();
    for original in store
        .delivery_links(session)?
        .into_iter()
        .filter(|link| include(link))
    {
        let outcome = (|| -> Result<(), VaultError> {
            // Known durable custody is independent of advisory approval refresh.
            // Retry it first, including for a link whose new request was refused.
            // Damaged records are skipped here and reported once below.
            send_pending(&original)?;
            let (link, warning) =
                store.refresh_staff_approval_for_check(&original, session, approval)?;
            if let Some(error) = warning {
                add_issue(&mut result, &link, error);
            }
            let mut after = 0;
            let mut through = None;
            let mut seen = std::collections::HashSet::new();
            let mut download_failures = 0;
            // The kinds this device understands, named in every listing: the portal only
            // lists a reading aid to a device that asks for it (a format-version guard).
            // A portal from before reading aids refuses the unknown key (see
            // refuses_unknown_query) and never lists an aid either: for this link and this
            // check its first page is asked again once without the kinds, and its later
            // pages leave them out. Any other refusal stays an error.
            let accept = format!("&accept={}", crate::reading_aid::accepted_kinds().join(","));
            let mut ask_kinds = true;
            // Reading aids wait until every original of this check is filed, so an aid
            // delivered with its original is filed in the same check.
            let mut aids: Vec<Outer> = Vec::new();
            for page_number in 0..100 {
                if cancelled() {
                    return Err(VaultError::Cancelled);
                }
                let list = |kinds: &str| -> Result<crate::portal_client::ApiResponse, VaultError> {
                    let suffix = match through {
                        None => format!("/api/mycarlos/deliveries?limit=50{kinds}"),
                        Some(t) => format!(
                            "/api/mycarlos/deliveries?after={after}&through={t}&limit=50{kinds}"
                        ),
                    };
                    let anchor = store.delivery_anchor(&link, session)?;
                    exchange(
                        &link,
                        "GET",
                        &suffix,
                        Vec::new(),
                        Some(&anchor),
                        524288,
                        &cancelled,
                    )
                    .map_err(VaultError::Portal)
                };
                let mut response = list(if ask_kinds { accept.as_str() } else { "" })?;
                if ask_kinds && page_number == 0 && refuses_unknown_query(&response) {
                    ask_kinds = false;
                    response = list("")?;
                }
                if response.status != 200 {
                    return Err(refused(&response));
                }
                let page: Page = serde_json::from_slice(&response.body)
                    .map_err(|_| VaultError::Portal(LinkError::InvalidResponse))?;
                let high = cursor(&page.through)?;
                if !page.anchor_recorded
                    || page.deliveries.len() > 100
                    || through.is_some_and(|t| t != high)
                    || high < after
                {
                    return Err(VaultError::Portal(LinkError::InvalidResponse));
                }
                through = Some(high);
                for outer in page.deliveries {
                    outer
                        .validate()
                        .map_err(|_| VaultError::Portal(LinkError::InvalidResponse))?;
                    if !seen.insert(outer.delivery_id.clone()) {
                        return Err(VaultError::Portal(LinkError::InvalidResponse));
                    }
                    if outer.kind.is_some() {
                        match crate::reading_aid::check_listing(&outer) {
                            Ok(()) => aids.push(outer),
                            Err(_) => result.refused += 1,
                        }
                        continue;
                    }
                    // A delivery that can't be downloaded is reported and
                    // skipped: the clinic's later deliveries are still fetched,
                    // and the next check tries this one again.
                    let response = match exchange(
                        &link,
                        "GET",
                        &format!("/api/mycarlos/deliveries/{}", outer.delivery_id),
                        Vec::new(),
                        None,
                        outer.size as usize,
                        &cancelled,
                    ) {
                        Ok(response) => {
                            download_failures = 0;
                            response
                        }
                        Err(error) => {
                            let error = VaultError::Portal(error);
                            if !is_per_link_failure(&error) {
                                return Err(error);
                            }
                            if matches!(error, VaultError::Portal(LinkError::Network)) {
                                download_failures += 1;
                                if download_failures == MAX_DOWNLOAD_FAILURES_IN_A_ROW {
                                    return Err(error);
                                }
                            }
                            add_issue(&mut result, &link, error);
                            continue;
                        }
                    };
                    if response.status != 200 {
                        #[derive(Deserialize)]
                        #[serde(deny_unknown_fields)]
                        struct Missing {
                            code: String,
                        }
                        if response.status == 404
                            && serde_json::from_slice::<Missing>(&response.body)
                                .ok()
                                .is_some_and(|v| v.code == "delivery_not_found")
                        {
                            continue;
                        }
                        // A device the portal removed can fetch nothing more:
                        // this clinic's check ends there (#128). Any other
                        // refusal is this delivery's alone (#124's fix).
                        let error = refused(&response);
                        if matches!(error, VaultError::Portal(LinkError::DeviceRemoved)) {
                            return Err(error);
                        }
                        add_issue(&mut result, &link, error);
                        continue;
                    }
                    match store.receive_delivery(&outer, &response.body, &link, session) {
                        Ok((record_id, added)) => {
                            result.added += usize::from(added);
                            #[cfg(windows)]
                            if added {
                                store.notify_local_arrival(record_id, &link, session);
                            }
                            #[cfg(not(windows))]
                            let _ = record_id;
                            send_pending(&link)?;
                        }
                        Err(VaultError::PickupRefused) => result.refused += 1,
                        Err(error) => return Err(error),
                    }
                }
                match page.next_cursor {
                    None => break,
                    Some(next) => {
                        let next = cursor(&next)?;
                        if next <= after || next > high || page_number == 99 {
                            return Err(VaultError::Portal(LinkError::InvalidResponse));
                        }
                        after = next;
                    }
                }
            }
            // Aids kept waiting are looked at again now that this check's originals are filed.
            let rechecked = store.recheck_waiting_aids(&link, session)?;
            result.refused += rechecked.refused;
            for (delivery_id, receipt) in &rechecked.not_filed {
                result.refused += 1;
                // Not filed because a newer-reviewed aid is held: the receipt only tells the portal
                // to stop offering it, so a failed post is simply tried again on the next check.
                let _ = post_receipt(&link, delivery_id, receipt);
            }
            if rechecked.filed > 0 {
                send_pending(&link)?;
            }
            for outer in aids {
                if cancelled() {
                    return Err(VaultError::Cancelled);
                }
                match store.aid_listed(&outer, &link, session)? {
                    // Kept or filed under this ID and hash: never downloaded again.
                    crate::reading_aid::Listed::Kept | crate::reading_aid::Listed::Filed => {
                        continue
                    }
                    crate::reading_aid::Listed::Replayed => {
                        result.refused += 1;
                        continue;
                    }
                    crate::reading_aid::Listed::New => {}
                }
                let response = match exchange(
                    &link,
                    "GET",
                    &format!("/api/mycarlos/deliveries/{}", outer.delivery_id),
                    Vec::new(),
                    None,
                    outer.size as usize,
                    &cancelled,
                ) {
                    Ok(response) if response.status == 200 => response,
                    // Gone or unavailable: the next check asks again.
                    Ok(_) => continue,
                    Err(error) => {
                        let error = VaultError::Portal(error);
                        if !is_per_link_failure(&error) {
                            return Err(error);
                        }
                        add_issue(&mut result, &link, error);
                        continue;
                    }
                };
                match store.receive_aid(&outer, &response.body, &link, session) {
                    Ok(crate::vault::AidFiling::NotFiled(receipt)) => {
                        result.refused += 1;
                        let _ = post_receipt(&link, &outer.delivery_id, &receipt);
                    }
                    Ok(_) => send_pending(&link)?,
                    Err(VaultError::PickupRefused) => result.refused += 1,
                    Err(error) => return Err(error),
                }
            }
            Ok(())
        })();
        if let Err(error) = outcome {
            if !is_per_link_failure(&error) {
                return Err(error);
            }
            add_issue(&mut result, &original, error);
        }
        // Approval reconciliation may have updated the link. Re-read its
        // current immutable identity/state before validating kept custody.
        let current = store
            .delivery_links(session)?
            .into_iter()
            .find(|l| l.id == original.id)
            .ok_or(VaultError::NotFound)?;
        let pending = store.pending_receipts_checked(&current, session)?;
        result.receipts_pending += pending.ready.len();
        if pending.damaged > 0 {
            add_issue_code(&mut result, &current, DAMAGED_CODE);
        }
    }
    Ok(result)
}

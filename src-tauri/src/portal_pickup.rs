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

#[cfg(feature = "portal-linking")]
pub(crate) fn is_per_link_failure(error: &crate::vault::VaultError) -> bool {
    use crate::{portal_link::LinkError, vault::VaultError};
    match error {
        VaultError::Portal(LinkError::Cancelled | LinkError::Disabled | LinkError::Unavailable) => {
            false
        }
        VaultError::Portal(_)
        | VaultError::ApprovalTerminal(_, _)
        | VaultError::ApprovalRequestMissing
        | VaultError::ApprovalNeedsClinic
        | VaultError::NotFound
        | VaultError::Invalid => true,
        _ => false,
    }
}
#[cfg(feature = "portal-linking")]
fn add_issue(
    result: &mut CheckResult,
    link: &crate::portal_link::StoredLink,
    error: crate::vault::VaultError,
) {
    let code = match &error {
        crate::vault::VaultError::Invalid | crate::vault::VaultError::NotFound => {
            "portal_link_incomplete"
        }
        _ => crate::PublicText::from(error).code,
    };
    add_issue_code(result, link, code);
}
/// A saved clinic document that no longer reads back: its receipt is held,
/// never sent, and the rest of the check goes on.
#[cfg(feature = "portal-linking")]
pub(crate) const DAMAGED_CODE: &str = "pickup_damaged";
/// Download failures in a row (no reply at all) after which the portal or
/// the connection is taken to be down for this clinic, rather than waiting
/// out a timeout for every delivery still listed.
#[cfg(feature = "portal-linking")]
const MAX_DOWNLOAD_FAILURES_IN_A_ROW: usize = 3;
#[cfg(feature = "portal-linking")]
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
#[cfg(feature = "portal-linking")]
pub(crate) fn check(
    store: &crate::vault::VaultStore,
    session: u64,
) -> Result<CheckResult, crate::vault::VaultError> {
    check_using(
        store,
        session,
        &crate::portal_approval::ApprovalHttp::default(),
        crate::portal_client::api,
    )
}
#[cfg(feature = "portal-linking")]
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
    use crate::{
        portal_delivery::{Outer, ReceiptOutcome},
        portal_link::{LinkError, StoredLink},
        vault::VaultError,
    };
    use serde::Deserialize;
    let cancelled = || store.portal_link_ticket() != session;
    let send = |link: &StoredLink, c: &crate::portal_delivery::Custody| -> Result<(), VaultError> {
        let anchor = store.delivery_anchor(link, session)?;
        let body = serde_json::to_vec(&serde_json::json!({"receipt":c.receipt}))
            .map_err(|_| VaultError::Storage)?;
        let response = exchange(
            link,
            "POST",
            &format!("/api/mycarlos/deliveries/{}/receipt", c.outer.delivery_id),
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
        let outcome = match response.status {
            200 if serde_json::from_slice::<Status>(&response.body)
                .ok()
                .is_some_and(|v| v.status == "picked_up") =>
            {
                ReceiptOutcome::PickedUp
            }
            404 if serde_json::from_slice::<Code>(&response.body)
                .ok()
                .is_some_and(|v| v.code == "delivery_not_found") =>
            {
                ReceiptOutcome::Gone
            }
            _ => return Err(VaultError::Portal(LinkError::Network)),
        };
        store.settle_receipt(link, c, outcome, session)
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
    for original in store.delivery_links(session)? {
        let outcome = (|| -> Result<(), VaultError> {
            // Known durable custody is independent of advisory approval refresh.
            // Retry it first, including for a link whose new request was refused.
            // Damaged records are skipped here and reported once below.
            for c in store.pending_receipts_checked(&original, session)?.ready {
                send(&original, &c)?;
            }
            let (link, warning) =
                store.refresh_staff_approval_for_check(&original, session, approval)?;
            if let Some(error) = warning {
                add_issue(&mut result, &link, error);
            }
            let mut after = 0;
            let mut through = None;
            let mut seen = std::collections::HashSet::new();
            let mut download_failures = 0;
            for page_number in 0..100 {
                if cancelled() {
                    return Err(VaultError::Cancelled);
                }
                let suffix = match through {
                    None => "/api/mycarlos/deliveries?limit=50".to_owned(),
                    Some(t) => {
                        format!("/api/mycarlos/deliveries?after={after}&through={t}&limit=50")
                    }
                };
                let anchor = store.delivery_anchor(&link, session)?;
                let response = exchange(
                    &link,
                    "GET",
                    &suffix,
                    Vec::new(),
                    Some(&anchor),
                    524288,
                    &cancelled,
                )
                .map_err(VaultError::Portal)?;
                if response.status != 200 {
                    return Err(VaultError::Portal(LinkError::Network));
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
                        add_issue(&mut result, &link, VaultError::Portal(LinkError::Network));
                        continue;
                    }
                    match store.receive_delivery(&outer, &response.body, &link, session) {
                        Ok((_, added)) => {
                            result.added += usize::from(added);
                            for c in store.pending_receipts_checked(&link, session)?.ready {
                                send(&link, &c)?;
                            }
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

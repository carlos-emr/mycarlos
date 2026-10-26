//! Explicit foreground mailbox check. All requests use saved link destinations;
//! the only receipt source is a successfully committed vault custody record.
use serde::Serialize;
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub added: usize,
    pub refused: usize,
    pub receipts_pending: usize,
}

#[cfg(feature = "portal-linking")]
pub(crate) fn check(
    store: &crate::vault::VaultStore,
    session: u64,
) -> Result<CheckResult, crate::vault::VaultError> {
    use crate::{
        portal_client,
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
        let response = portal_client::api(
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
    for link in store.delivery_links(session)? {
        let link = store.refresh_staff_approval(&link, session)?;
        // Restart and lost-reply retries happen before listing. Terminal portal
        // copies disappear from the list, so list-only retry would lose them.
        for c in store.pending_receipts(&link, session)? {
            send(&link, &c)?;
        }
        let mut after = 0;
        let mut through = None;
        let mut seen = std::collections::HashSet::new();
        for page_number in 0..100 {
            if cancelled() {
                return Err(VaultError::Cancelled);
            }
            let suffix = match through {
                None => "/api/mycarlos/deliveries?limit=50".to_owned(),
                Some(t) => format!("/api/mycarlos/deliveries?after={after}&through={t}&limit=50"),
            };
            let anchor = store.delivery_anchor(&link, session)?;
            let response = portal_client::api(
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
                let response = portal_client::api(
                    &link,
                    "GET",
                    &format!("/api/mycarlos/deliveries/{}", outer.delivery_id),
                    Vec::new(),
                    None,
                    outer.size as usize,
                    &cancelled,
                )
                .map_err(VaultError::Portal)?;
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
                    return Err(VaultError::Portal(LinkError::Network));
                }
                match store.receive_delivery(&outer, &response.body, &link, session) {
                    Ok((_, added)) => {
                        result.added += usize::from(added);
                        for c in store.pending_receipts(&link, session)? {
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
        result.receipts_pending += store.pending_receipts(&link, session)?.len();
    }
    Ok(result)
}

//! Bounded, resumable automatic collection. Explicit manual checks retain their
//! existing implementation. No timer is started by this module.
use crate::{
    document_collection::{CycleControl, ScanCursor, BODY_TIME, METADATA_TIME},
    portal_approval::{ApprovalExchange, Attempt},
    portal_delivery::{Custody, Outer, ReceiptOutcome},
    portal_link::{LinkError, StoredLink},
    portal_pickup::CheckResult,
    vault::{VaultError, VaultStore},
};
use serde::Deserialize;
use std::{
    mem::size_of,
    time::{Duration, Instant},
};
use uuid::Uuid;

const SLOTS: usize = 16;
const PAGE_BYTES: usize = 448 * 1024;
const CACHE_BYTES: usize = 8 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(900);

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
fn cursor(s: &str) -> Result<u64, VaultError> {
    let n = s
        .parse::<u64>()
        .map_err(|_| VaultError::Portal(LinkError::InvalidResponse))?;
    if n > i64::MAX as u64 || n.to_string() != s {
        return Err(VaultError::Portal(LinkError::InvalidResponse));
    }
    Ok(n)
}

struct LinkResume {
    id: Uuid,
    // Hash of the native current device identity, never a renderer input/token.
    device: [u8; 32],
    scan: ScanCursor,
    through: Option<u64>,
    after: u64,
    next_cursor: Option<u64>,
    page: Vec<Outer>,
    position: usize,
    admitted: Option<Instant>,
    expires_at: u64,
    manual_required: bool,
}
impl LinkResume {
    fn new(link: &StoredLink) -> Self {
        use sha2::{Digest, Sha256};
        Self {
            id: link.id,
            device: Sha256::digest(link.keys.device_key_id().as_bytes()).into(),
            scan: ScanCursor::default(),
            through: None,
            after: 0,
            next_cursor: None,
            page: Vec::new(),
            position: 0,
            admitted: None,
            expires_at: u64::MAX,
            manual_required: false,
        }
    }
    fn pause(&mut self) {
        self.manual_required = true;
        self.page = Vec::new();
        self.position = 0;
    }
    fn bytes(&self) -> usize {
        Self::page_bytes(&self.page)
    }
    fn page_bytes(page: &Vec<Outer>) -> usize {
        page.capacity() * size_of::<Outer>()
            + page
                .iter()
                .map(|o| {
                    o.delivery_id.capacity()
                        + o.recipient_id.capacity()
                        + o.device_key_id.capacity()
                        + o.ciphertext_sha256.capacity()
                })
                .sum::<usize>()
    }
    fn expired(&self, now: Instant, wall: u64) -> bool {
        self.admitted
            .is_some_and(|t| now.saturating_duration_since(t) >= TTL)
            || wall >= self.expires_at
    }
}

pub(crate) struct ResumeCache {
    owner: Option<(Uuid, u64, usize)>,
    slots: [Option<LinkResume>; SLOTS],
    last_visited: Option<Uuid>,
    retry_first: Option<Uuid>,
}
impl Default for ResumeCache {
    fn default() -> Self {
        Self {
            owner: None,
            slots: std::array::from_fn(|_| None),
            last_visited: None,
            retry_first: None,
        }
    }
}
impl ResumeCache {
    pub(crate) fn bind(&mut self, vault: Uuid, session: u64, consent_epoch: usize) {
        if self.owner != Some((vault, session, consent_epoch)) {
            *self = Self::default();
            self.owner = Some((vault, session, consent_epoch));
        }
    }
    pub(crate) fn needs_manual(&self) -> bool {
        self.slots.iter().flatten().any(|s| s.manual_required)
    }
    fn bytes(&self) -> usize {
        size_of::<Self>()
            + self
                .slots
                .iter()
                .flatten()
                .map(LinkResume::bytes)
                .sum::<usize>()
    }
    fn allows_page(&self, index: usize, page: &Vec<Outer>) -> bool {
        let bytes = LinkResume::page_bytes(page);
        bytes <= PAGE_BYTES
            && self
                .bytes()
                .saturating_sub(self.slots[index].as_ref().unwrap().bytes())
                .saturating_add(bytes)
                <= CACHE_BYTES
    }
    fn slot(&mut self, link: &StoredLink) -> Result<usize, VaultError> {
        use sha2::{Digest, Sha256};
        if let Some(i) = self
            .slots
            .iter()
            .position(|s| s.as_ref().is_some_and(|s| s.id == link.id))
        {
            let device: [u8; 32] = Sha256::digest(link.keys.device_key_id().as_bytes()).into();
            if self.slots[i].as_ref().unwrap().device != device {
                self.slots[i] = Some(LinkResume::new(link));
            }
            return Ok(i);
        }
        let i = self
            .slots
            .iter()
            .position(Option::is_none)
            .ok_or(VaultError::Invalid)?;
        self.slots[i] = Some(LinkResume::new(link));
        Ok(i)
    }
}

struct BoundedApproval<'a, A> {
    inner: &'a A,
    control: &'a CycleControl,
    stop: &'a dyn Fn() -> bool,
}
impl<A: ApprovalExchange> ApprovalExchange for BoundedApproval<'_, A> {
    fn get(
        &self,
        link: &StoredLink,
        attempt: &Attempt,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Option<Attempt>, VaultError> {
        if !self.control.request() {
            return Err(VaultError::Cancelled);
        }
        let deadline = Instant::now() + METADATA_TIME;
        let stop =
            || cancelled() || (self.stop)() || self.control.stopped() || Instant::now() >= deadline;
        if stop() {
            return Err(VaultError::Cancelled);
        }
        let result = self.inner.get(link, attempt, &stop);
        if stop() {
            Err(VaultError::Cancelled)
        } else {
            result
        }
    }
    fn post(
        &self,
        link: &StoredLink,
        attempt: &Attempt,
        anchor: &str,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Attempt, VaultError> {
        if !self.control.request() {
            return Err(VaultError::Cancelled);
        }
        let deadline = Instant::now() + METADATA_TIME;
        let stop =
            || cancelled() || (self.stop)() || self.control.stopped() || Instant::now() >= deadline;
        if stop() {
            return Err(VaultError::Cancelled);
        }
        let result = self.inner.post(link, attempt, anchor, &stop);
        if stop() {
            Err(VaultError::Cancelled)
        } else {
            result
        }
    }
    // A clinic code is sent only from the clinic view, never by a background
    // check; bounded the same way all the same, as the trait asks (#141).
    fn submit_code(
        &self,
        link: &StoredLink,
        attempt: &Attempt,
        code_r: &str,
        anchor: &str,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(), VaultError> {
        if !self.control.request() {
            return Err(VaultError::Cancelled);
        }
        let deadline = Instant::now() + METADATA_TIME;
        let stop =
            || cancelled() || (self.stop)() || self.control.stopped() || Instant::now() >= deadline;
        if stop() {
            return Err(VaultError::Cancelled);
        }
        let result = self.inner.submit_code(link, attempt, code_r, anchor, &stop);
        if stop() {
            Err(VaultError::Cancelled)
        } else {
            result
        }
    }
    // The portal's clock from the last status read, so a background check
    // decides whether a request is still open as a manual one does (#131).
    fn portal_time(&self) -> Option<u64> {
        self.inner.portal_time()
    }
}

pub(crate) fn check_cycle<F, A>(
    store: &VaultStore,
    session: u64,
    control: &CycleControl,
    cache: &mut ResumeCache,
    approval: &A,
    exchange: F,
) -> Result<CheckResult, VaultError>
where
    A: ApprovalExchange,
    F: Fn(
        &StoredLink,
        &str,
        &str,
        Vec<u8>,
        Option<&str>,
        usize,
        &dyn Fn() -> bool,
    ) -> Result<crate::portal_client::ApiResponse, LinkError>,
{
    let stopped = || {
        if store.portal_link_ticket() != session {
            control.session_changed();
        }
        control.stopped() || !store.automatic_collection_allowed()
    };
    let request = |link: &StoredLink,
                   method: &str,
                   path: &str,
                   body: Vec<u8>,
                   anchor: Option<&str>,
                   cap: usize,
                   large: bool,
                   reserved: bool| {
        if stopped() || (!reserved && !control.request()) {
            return Err(VaultError::Cancelled);
        }
        let deadline = Instant::now() + if large { BODY_TIME } else { METADATA_TIME };
        let stop = || stopped() || Instant::now() >= deadline;
        let response =
            exchange(link, method, path, body, anchor, cap, &stop).map_err(VaultError::Portal);
        if stop() {
            Err(VaultError::Cancelled)
        } else {
            response
        }
    };
    let send = |link: &StoredLink, c: &Custody| -> Result<(), VaultError> {
        if stopped() {
            return Err(VaultError::Cancelled);
        }
        let anchor = store.delivery_anchor(link, session)?;
        let body = serde_json::to_vec(&serde_json::json!({"receipt":c.receipt}))
            .map_err(|_| VaultError::Storage)?;
        let reply = request(
            link,
            "POST",
            &format!("/api/mycarlos/deliveries/{}/receipt", c.outer.delivery_id),
            body,
            Some(&anchor),
            8192,
            false,
            false,
        )?;
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
        let outcome = match reply.status {
            200 if serde_json::from_slice::<Status>(&reply.body)
                .ok()
                .is_some_and(|s| s.status == "picked_up") =>
            {
                ReceiptOutcome::PickedUp
            }
            404 if serde_json::from_slice::<Code>(&reply.body)
                .ok()
                .is_some_and(|s| s.code == "delivery_not_found") =>
            {
                ReceiptOutcome::Gone
            }
            _ => return Err(VaultError::Portal(LinkError::Network)),
        };
        if stopped() {
            return Err(VaultError::Cancelled);
        }
        store.settle_receipt_controlled(link, c, outcome, session, &stopped)
    };
    let mut links = store.delivery_links(session)?;
    // A saved candidate is insufficient: only a currently signed accepted link
    // is eligible for implicit collection. Explicit manual approval is separate.
    links.retain(crate::portal_approval::currently_approved);
    // A device this run of the app found gone from its portal (#168; a manual,
    // after-unlock, status or earlier background check found it) is not asked
    // again. Left out before the rotation, so it spends none of the cycle's
    // link visits.
    links.retain(|link| !store.link_gone(link.id));
    let deferred = cache
        .retry_first
        .take()
        .and_then(|id| links.iter().position(|link| link.id == id));
    if let Some(index) = deferred {
        // A residual global-budget denial must actually receive fresh budget;
        // rotate AFTERlastVisited alone would restart A before deferred B forever.
        links.rotate_left(index);
    } else if let Some(last) = cache.last_visited {
        if let Some(index) = links.iter().position(|link| link.id == last) {
            let len = links.len();
            links.rotate_left((index + 1) % len);
        }
    }
    let bounded = BoundedApproval {
        inner: approval,
        control,
        stop: &stopped,
    };
    let mut result = CheckResult::default();
    for original in links {
        if stopped() || !control.visit_link() {
            break;
        }
        // Rotate BEFORE even the first pending read or request, including failure.
        cache.last_visited = Some(original.id);
        let i = cache.slot(&original)?;
        if cache.slots[i].as_ref().unwrap().manual_required {
            continue;
        }
        let outcome = (|| -> Result<(), VaultError> {
            // Verify/settle one at a time: a big pending scan cannot consume the
            // entire physical budget before any verified receipt is sent.
            loop {
                let pending = store.pending_receipts_controlled(
                    &original,
                    session,
                    control,
                    &mut cache.slots[i].as_mut().unwrap().scan,
                )?;
                if pending.manual_required {
                    cache.slots[i].as_mut().unwrap().pause();
                    return Ok(());
                }
                if pending.budget_deferred {
                    cache.retry_first = Some(original.id);
                    return Ok(());
                }
                if let Some(c) = pending.ready.first() {
                    send(&original, c)?;
                } else {
                    break;
                }
            }
            let (link, _warning) =
                store.refresh_staff_approval_controlled(&original, session, &bounded, &stopped)?;
            loop {
                if stopped() {
                    return Err(VaultError::Cancelled);
                }
                if cache.slots[i]
                    .as_ref()
                    .unwrap()
                    .expired(Instant::now(), crate::now_ms() / 1000)
                {
                    cache.slots[i].as_mut().unwrap().pause();
                    break;
                }
                let need_page = {
                    let s = cache.slots[i].as_ref().unwrap();
                    s.page.is_empty()
                };
                if need_page {
                    if !control.admit_page() {
                        break;
                    }
                    let s = cache.slots[i].as_ref().unwrap();
                    let path = match s.through {
                        None => "/api/mycarlos/deliveries?limit=50".to_owned(),
                        Some(t) => format!(
                            "/api/mycarlos/deliveries?after={}&through={t}&limit=50",
                            s.after
                        ),
                    };
                    let anchor = store.delivery_anchor(&link, session)?;
                    let reply = request(
                        &link,
                        "GET",
                        &path,
                        Vec::new(),
                        Some(&anchor),
                        524288,
                        false,
                        false,
                    )?;
                    if reply.status != 200 {
                        // A portal that removed this device says so (#128, as
                        // the manual check reads it); any other answer is not
                        // one this check can use. A "not found" for the list is
                        // a network failure here on purpose: the manual check's
                        // rule (another device of this vault answered by the
                        // same portal) is not applied. A device a reset portal
                        // deleted is asked again until a manual or after-unlock
                        // check marks it gone, which happens at the next unlock.
                        return Err(VaultError::Portal(
                            if crate::portal_approval::device_removed(&reply) {
                                LinkError::DeviceRemoved
                            } else {
                                LinkError::Network
                            },
                        ));
                    }
                    let page: Page = serde_json::from_slice(&reply.body).map_err(|_| {
                        cache.slots[i].as_mut().unwrap().pause();
                        VaultError::Portal(LinkError::InvalidResponse)
                    })?;
                    let high = cursor(&page.through).inspect_err(|_| {
                        cache.slots[i].as_mut().unwrap().pause();
                    })?;
                    let capacity_ok = cache.allows_page(i, &page.deliveries);
                    let s = cache.slots[i].as_mut().unwrap();
                    let next = page
                        .next_cursor
                        .as_deref()
                        .map(cursor)
                        .transpose()
                        .inspect_err(|_| {
                            s.pause();
                        })?;
                    if !page.anchor_recorded
                        || page.deliveries.len() > 100
                        || high < s.after
                        || s.through.is_some_and(|t| t != high)
                        || next.is_some_and(|n| n <= s.after || n > high)
                    {
                        s.pause();
                        return Err(VaultError::Portal(LinkError::InvalidResponse));
                    }
                    for (index, o) in page.deliveries.iter().enumerate() {
                        o.validate().map_err(|_| {
                            s.pause();
                            VaultError::Portal(LinkError::InvalidResponse)
                        })?;
                        if page.deliveries[..index]
                            .iter()
                            .any(|prior| prior.delivery_id == o.delivery_id)
                        {
                            s.pause();
                            return Err(VaultError::Portal(LinkError::InvalidResponse));
                        }
                    }
                    if !capacity_ok {
                        s.pause();
                        break;
                    }
                    let expiry = page
                        .deliveries
                        .iter()
                        .map(|o| o.expires_at)
                        .min()
                        .unwrap_or(u64::MAX);
                    if crate::now_ms() / 1000 >= expiry {
                        s.pause();
                        break;
                    }
                    // The decoded page is an active bounded work buffer until
                    // all owned-capacity checks pass. Only now admit to cache.
                    s.through = Some(high);
                    s.next_cursor = next;
                    s.page = page.deliveries;
                    s.position = 0;
                    s.admitted.get_or_insert_with(Instant::now);
                    s.expires_at = s.expires_at.min(expiry);
                }
                let s = cache.slots[i].as_mut().unwrap();
                if s.position >= s.page.len() {
                    s.page = Vec::new();
                    s.position = 0;
                    match s.next_cursor.take() {
                        Some(n) => s.after = n,
                        None => {
                            s.through = None;
                            s.after = 0;
                            s.admitted = None;
                            s.expires_at = u64::MAX;
                            break;
                        }
                    }
                    continue;
                }
                let outer = s.page[s.position].clone();
                // Local admission denial retains the first UNATTEMPTED item.
                // Otherwise stable cap alignment could skip the same item in
                // every snapshot round. Advance only admitted real attempts,
                // before HTTP, so attempted failures still allow later work.
                if !control.request() || !control.download(outer.size as usize) {
                    break;
                }
                s.position += 1;
                let reply = match request(
                    &link,
                    "GET",
                    &format!("/api/mycarlos/deliveries/{}", outer.delivery_id),
                    Vec::new(),
                    None,
                    outer.size as usize,
                    true,
                    true,
                ) {
                    Ok(r) => r,
                    Err(e) if crate::portal_pickup::is_per_link_failure(&e) => continue,
                    Err(e) => return Err(e),
                };
                if reply.status != 200 {
                    continue;
                }
                match store.receive_delivery_controlled(
                    &outer,
                    &reply.body,
                    &link,
                    session,
                    &stopped,
                ) {
                    Ok((record, added)) => {
                        result.added += usize::from(added);
                        #[cfg(windows)]
                        if added {
                            store.notify_local_arrival_controlled(record, &link, session, &stopped);
                        }
                        #[cfg(not(windows))]
                        let _ = record;
                        // Receipt verification and settlement is bounded on the
                        // next scan/cycle; custody already committed truthfully.
                    }
                    Err(VaultError::PickupRefused) => result.refused += 1,
                    Err(e) => return Err(e),
                }
            }
            Ok(())
        })();
        if let Err(error) = outcome {
            if stopped() {
                break;
            }
            if !crate::portal_pickup::is_per_link_failure(&error) {
                return Err(error);
            }
            // The portal said this device was removed: not asked again in
            // this run of the app (#168).
            if matches!(
                error,
                VaultError::Portal(crate::portal_link::LinkError::DeviceRemoved)
            ) {
                store.mark_link_gone(original.id);
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    fn link() -> StoredLink {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/delivery-contract.json")).unwrap();
        crate::portal_delivery::tests::fixture_link(&fixture)
    }
    #[test]
    fn owned_capacity_overflow_is_rejected_and_pause_preserves_cursor() {
        let link = link();
        let mut cache = ResumeCache::default();
        cache.bind(Uuid::from_u128(1), 3, 2);
        let i = cache.slot(&link).unwrap();
        let huge = Vec::<Outer>::with_capacity(PAGE_BYTES / size_of::<Outer>() + 1);
        assert!(!cache.allows_page(i, &huge));
        let s = cache.slots[i].as_mut().unwrap();
        s.after = 17;
        s.through = Some(44);
        s.pause();
        assert_eq!(s.after, 17);
        assert_eq!(s.through, Some(44));
        assert!(s.manual_required);
        assert!(cache.needs_manual());
        assert!(cache.bytes() <= CACHE_BYTES);
        cache.bind(Uuid::from_u128(1), 3, 2);
        assert!(cache.needs_manual());
        cache.bind(Uuid::from_u128(1), 4, 2);
        assert!(!cache.needs_manual());
    }
    #[test]
    fn snapshot_age_and_outer_expiry_pause_without_prefix_restart() {
        let mut s = LinkResume::new(&link());
        let now = Instant::now();
        s.admitted = Some(now);
        s.after = 99;
        assert!(!s.expired(now, 100));
        assert!(s.expired(now + TTL, 100));
        s.expires_at = 100;
        assert!(s.expired(now, 100));
        s.pause();
        assert_eq!(s.after, 99);
    }
    #[test]
    fn bounded_approval_passes_on_the_portal_clock() {
        // Without it a background check read the default (none) and fell back
        // to this device's clock where the portal had given its own (#131).
        struct Clock;
        impl ApprovalExchange for Clock {
            fn get(
                &self,
                _: &StoredLink,
                _: &Attempt,
                _: &dyn Fn() -> bool,
            ) -> Result<Option<Attempt>, VaultError> {
                unreachable!("only the clock is read")
            }
            fn post(
                &self,
                _: &StoredLink,
                _: &Attempt,
                _: &str,
                _: &dyn Fn() -> bool,
            ) -> Result<Attempt, VaultError> {
                unreachable!("only the clock is read")
            }
            fn submit_code(
                &self,
                _: &StoredLink,
                _: &Attempt,
                _: &str,
                _: &str,
                _: &dyn Fn() -> bool,
            ) -> Result<(), VaultError> {
                unreachable!("only the clock is read")
            }
            fn portal_time(&self) -> Option<u64> {
                Some(1_700_000_000)
            }
        }
        let control = CycleControl::new(Instant::now(), Arc::new(AtomicBool::new(false)));
        let bound = BoundedApproval {
            inner: &Clock,
            control: &control,
            stop: &|| false,
        };
        assert_eq!(bound.portal_time(), Some(1_700_000_000));
    }
    #[test]
    fn approval_get_and_publish_observe_same_old_token_and_request_budget() {
        struct Exchange {
            token: Arc<AtomicBool>,
            gets: AtomicUsize,
            posts: AtomicUsize,
        }
        impl ApprovalExchange for Exchange {
            fn get(
                &self,
                _: &StoredLink,
                _: &Attempt,
                stop: &dyn Fn() -> bool,
            ) -> Result<Option<Attempt>, VaultError> {
                assert!(!stop());
                self.gets.fetch_add(1, Ordering::SeqCst);
                self.token.store(true, Ordering::Release);
                assert!(stop());
                Err(VaultError::Cancelled)
            }
            fn post(
                &self,
                _: &StoredLink,
                _: &Attempt,
                _: &str,
                stop: &dyn Fn() -> bool,
            ) -> Result<Attempt, VaultError> {
                assert!(!stop());
                self.posts.fetch_add(1, Ordering::SeqCst);
                self.token.store(true, Ordering::Release);
                assert!(stop());
                Err(VaultError::Cancelled)
            }
            fn submit_code(
                &self,
                _: &StoredLink,
                _: &Attempt,
                _: &str,
                _: &str,
                _: &dyn Fn() -> bool,
            ) -> Result<(), VaultError> {
                unreachable!("this test sends no clinic code")
            }
        }
        let l = link();
        let a = Attempt {
            request_id: Uuid::from_u128(4),
            intent: "synthetic".into(),
            expires_at: 100,
            challenge: None,
            acceptance: None,
            status: None,
            reason: None,
        };
        for publish in [false, true] {
            let token = Arc::new(AtomicBool::new(false));
            let c = CycleControl::new(Instant::now(), token.clone());
            let inner = Exchange {
                token,
                gets: AtomicUsize::new(0),
                posts: AtomicUsize::new(0),
            };
            let bound = BoundedApproval {
                inner: &inner,
                control: &c,
                stop: &|| false,
            };
            if publish {
                assert!(matches!(
                    bound.post(&l, &a, "synthetic", &|| false),
                    Err(VaultError::Cancelled)
                ));
            } else {
                assert!(matches!(
                    bound.get(&l, &a, &|| false),
                    Err(VaultError::Cancelled)
                ));
            }
            assert_eq!(
                inner.gets.load(Ordering::SeqCst) + inner.posts.load(Ordering::SeqCst),
                1
            );
            assert!(c.stopped());
        }
        // This tests callback forwarding through the real adapter, not actual
        // HTTP socket cancellation, helper death or installed Windows behavior.
    }
}

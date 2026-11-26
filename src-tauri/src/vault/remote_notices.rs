//! Remote "documents ready" notices, vault side (#192, M1). The state lives in the encrypted
//! manifest (format 9). No network call is made while the vault lock is held: each portal
//! request runs on a snapshot, and its answer is applied in a commit of its own after checking
//! that the session is still the one that sent it.

use super::*;
use crate::document_notifications::Platform;
use crate::document_notifications::{Activation, NoticeToken, Owner, Policy};
use crate::document_push::{
    enrollment_body, enrollment_reply, revocation_body, revocation_final, Enrollment, Exchange,
    PushOutcome, PushSource, MAX_REPLY, REVOCATIONS, SUBSCRIPTIONS,
};
use crate::ios_push::Token;
use crate::ios_push_handles::{
    binding_reply, handle_body, handle_digest, Binding, HandleMemory, HANDLES, MAX_HANDLE_REPLY,
    SUSPECT,
};

/// What the vault can say about remote notices: counts only, never which clinics.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteNoticeStatus {
    /// Whether this build has a push source for this platform.
    pub(crate) supported: bool,
    pub(crate) opted_in: bool,
    pub(crate) destinations: usize,
    pub(crate) enrolled: usize,
    pub(crate) pending_revocations: usize,
}

/// What one sync achieved. Requests still waiting are retried on the next sync.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct RemoteSync {
    pub(crate) enrolled: usize,
    pub(crate) forgotten: usize,
    pub(crate) revoked: usize,
    pub(crate) waiting: usize,
}

/// What binding the iPhone token achieved. Entries still waiting are retried at a later opening.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct HandleSync {
    /// The portal took the token.
    pub(crate) bound: usize,
    /// Already bound with this very token: nothing was sent.
    pub(crate) unchanged: usize,
    /// The portal did not know the destination a second time, at a later pass: it was revoked here
    /// (so no place is left behind) and one new one was enrolled in the same pass.
    pub(crate) re_enroll: usize,
    /// The portal did not know the destination once: kept, and sent again at a later pass (the
    /// answer is also the portal's refusal of a skewed or replayed request).
    pub(crate) suspected: usize,
    /// Even after enrolling anew, the portal holds no place for the token: Settings says so.
    pub(crate) needs_attention: bool,
    /// The portal refused what was sent (a bug); not sent again.
    pub(crate) refused: usize,
    pub(crate) waiting: usize,
}

/// The flag after a pass: `needs_attention` sets it; a pass that bound the token, or found it
/// already bound, clears it; a pass that learned nothing about the portal (offline, waiting, the
/// patient said no) leaves it as it was.
pub(crate) fn attention_after(prior: bool, pass: &HandleSync) -> bool {
    if pass.needs_attention {
        true
    } else if pass.bound + pass.unchanged > 0 {
        false
    } else {
        prior
    }
}

/// Whether a failed refresh is something the patient should look at. A vault that locked meanwhile,
/// a session that ended (a lock and an unlock in between) and a recovery session are not failures of
/// notices; everything else (the vault's own storage, a manifest that does not read) is.
fn failure_needs_a_look(error: &VaultError) -> bool {
    !matches!(
        error,
        VaultError::Cancelled | VaultError::Locked | VaultError::RecoveryMode
    )
}

impl VaultStore {
    fn remote_policy(manifest: &Manifest) -> Result<Policy, VaultError> {
        Policy::new(manifest.remote_notices.clone()).map_err(|_| VaultError::Corrupt)
    }

    pub(crate) fn remote_notice_status(
        &self,
        source: Option<&dyn PushSource>,
    ) -> Result<RemoteNoticeStatus, VaultError> {
        let guard = self.session();
        let open = guard.as_ref().ok_or(VaultError::Locked)?;
        let saved = &open.manifest.remote_notices;
        Ok(RemoteNoticeStatus {
            supported: source.is_some(),
            opted_in: saved.opted_in(),
            destinations: saved.active().len(),
            enrolled: saved
                .active()
                .iter()
                .filter(|d| d.subscription_id().is_some())
                .count(),
            pending_revocations: saved.revocations().len(),
        })
    }

    /// The patient's own choice, from Preferences; never called at startup or by a timer.
    /// Turning it on reserves and saves a destination for each completed link before any is
    /// enrolled; turning it off queues every destination for revocation. Then it syncs.
    pub(crate) fn set_remote_notices(
        &self,
        enabled: bool,
        source: &dyn PushSource,
        session: u64,
        exchange: &impl Exchange,
    ) -> Result<RemoteSync, VaultError> {
        if self.portal_link_ticket() != session {
            return Err(VaultError::Cancelled);
        }
        let permission = source.permission();
        self.mutate_recorded(|manifest, _| {
            let mut policy = Self::remote_policy(manifest)?;
            policy.permission_changed(permission);
            if enabled {
                policy.opt_in();
                if policy.can_notify() {
                    for link in manifest.portal_links.iter().filter(|l| l.clinic.is_some()) {
                        if policy.destination_for(link.id).is_some() {
                            continue;
                        }
                        let owner = Owner::new(link.id, link.keys.device_key_id())
                            .map_err(|_| VaultError::Invalid)?;
                        policy
                            .reserve_destination(owner, Uuid::new_v4(), source.platform())
                            .map_err(|_| VaultError::Invalid)?;
                    }
                }
            } else {
                policy.opt_out();
            }
            manifest.remote_notices = policy.saved().clone();
            Ok(())
        })?;
        self.sync_remote_notices(Some(source), session, exchange)
    }

    /// Sends what is waiting: revocations first (they need no push source), then enrollments
    /// (only while the patient is opted in and the OS permission holds).
    pub(crate) fn sync_remote_notices(
        &self,
        source: Option<&dyn PushSource>,
        session: u64,
        exchange: &impl Exchange,
    ) -> Result<RemoteSync, VaultError> {
        let cancelled = || self.portal_link_ticket() != session;
        if cancelled() {
            return Err(VaultError::Cancelled);
        }
        let (revocations, enrollments, links) = {
            let guard = self.session();
            let open = guard.as_ref().ok_or(VaultError::Locked)?;
            if open.recovery.is_some() {
                return Err(VaultError::RecoveryMode);
            }
            let mut policy = Self::remote_policy(&open.manifest)?;
            if let Some(source) = source {
                policy.permission_changed(source.permission());
            }
            let enrollments = if policy.can_notify() {
                policy.unenrolled()
            } else {
                Vec::new()
            };
            (
                policy.pending_revocations(),
                enrollments,
                open.manifest.portal_links.clone(),
            )
        };
        let link_for = |d: &crate::document_notifications::Destination| {
            links.iter().find(|l| {
                l.id == d.owner().link_id()
                    && l.clinic.is_some()
                    && l.keys.device_key_id() == d.owner().device_key_id()
            })
        };
        let mut sync = RemoteSync::default();
        for destination in revocations {
            // A destination whose link or key is gone cannot be signed for; it waits.
            let Some(link) = link_for(&destination) else {
                sync.waiting += 1;
                continue;
            };
            match exchange(
                link,
                "POST",
                REVOCATIONS,
                revocation_body(&destination),
                None,
                MAX_REPLY,
                &cancelled,
            ) {
                Ok(reply) if revocation_final(&destination, reply.status, &reply.body) => {
                    self.apply_remote(session, |policy| {
                        policy.revocation_acknowledged(destination.id())
                    })?;
                    sync.revoked += 1;
                }
                Err(crate::portal_link::LinkError::Cancelled) => return Err(VaultError::Cancelled),
                _ => sync.waiting += 1,
            }
        }
        for destination in enrollments {
            // Never enrol an id whose revocation is queued (an opt-out meanwhile): the portal
            // may prune tombstones of ids it never enrolled.
            if !self.still_active(destination.id()) {
                continue;
            }
            let Some(link) = link_for(&destination) else {
                sync.waiting += 1;
                continue;
            };
            let reply = match exchange(
                link,
                "POST",
                SUBSCRIPTIONS,
                enrollment_body(&destination),
                None,
                MAX_REPLY,
                &cancelled,
            ) {
                Ok(reply) => enrollment_reply(&destination, reply.status, &reply.body),
                Err(crate::portal_link::LinkError::Cancelled) => return Err(VaultError::Cancelled),
                Err(_) => Enrollment::Later,
            };
            match reply {
                Enrollment::Enrolled(subscription) => {
                    // Opted out meanwhile: the destination is in the revocation queue already,
                    // and the next sync revokes it.
                    self.apply_remote(session, |policy| {
                        let _ = policy.enrolled(destination.id(), subscription);
                    })?;
                    sync.enrolled += 1;
                }
                Enrollment::Forget => {
                    self.apply_remote(session, |policy| {
                        policy.forget_destination(destination.id())
                    })?;
                    sync.forgotten += 1;
                }
                Enrollment::Later => sync.waiting += 1,
            }
        }
        Ok(sync)
    }

    /// The patient's choice from the iPhone Settings switch. Turning it on opts in (an enrollment
    /// for each completed link) and then binds the token Apple gave, when there is one; turning it
    /// off queues the revocations and forgets what the Keychain remembered about each destination.
    /// `token` is `None` when the ask was refused, timed out or failed: the choice is kept and
    /// nothing is enrolled, because the permission the policy sees is not granted.
    pub(crate) fn set_iphone_push(
        &self,
        enabled: bool,
        token: Option<&Token>,
        state: &crate::ios_push_handles::IosPushState,
        memory: &dyn HandleMemory,
        session: u64,
        exchange: &impl Exchange,
    ) -> Result<(RemoteSync, HandleSync), VaultError> {
        if !enabled {
            for id in self.iphone_destination_ids()? {
                memory.forget(id);
            }
        }
        let synced = self.set_remote_notices(enabled, state, session, exchange)?;
        let bound = match token {
            Some(token) if enabled => {
                self.bind_with_one_repair(token, state, memory, session, exchange, synced)?
            }
            _ => HandleSync::default(),
        };
        Ok((synced, bound))
    }

    /// The ids of the iPhone destinations this vault holds, enrolled or not.
    pub(crate) fn iphone_destination_ids(&self) -> Result<Vec<Uuid>, VaultError> {
        let guard = self.session();
        let open = guard.as_ref().ok_or(VaultError::Locked)?;
        Ok(open
            .manifest
            .remote_notices
            .active()
            .iter()
            .filter(|d| d.platform() == Platform::IosApns)
            .map(|d| d.id())
            .collect())
    }

    /// Enrolls what is waiting, and only then binds the iPhone token to the enrolled destinations:
    /// the portal knows a destination only once it was enrolled, so the order is fixed.
    pub(crate) fn sync_and_bind_push_handle(
        &self,
        source: &dyn PushSource,
        token: Option<&Token>,
        memory: &dyn HandleMemory,
        session: u64,
        exchange: &impl Exchange,
    ) -> Result<(RemoteSync, HandleSync), VaultError> {
        let synced = self.sync_remote_notices(Some(source), session, exchange)?;
        let bound = match token {
            Some(token) => {
                self.bind_with_one_repair(token, source, memory, session, exchange, synced)?
            }
            None => HandleSync::default(),
        };
        Ok((synced, bound))
    }

    /// The first step of the refresh at opening: reads the vault's remembered attention flag into
    /// `state` (so Settings is right before any network call, and one vault's flag never shows on
    /// another), and says whether there is anything to refresh at all: the vault is open (not in
    /// recovery) and the patient has remote notices on. Asks Apple and the portal nothing.
    pub(crate) fn iphone_push_refresh_due(
        &self,
        state: &crate::ios_push_handles::IosPushState,
        memory: &dyn HandleMemory,
    ) -> bool {
        let guard = self.session();
        let Some(open) = guard.as_ref() else {
            return false;
        };
        state.record_attention(memory.attention(open.manifest.vault_id));
        open.recovery.is_none() && open.manifest.remote_notices.opted_in()
    }

    /// Keeps the attention flag (in `state` for Settings, in `memory` across restarts) as the pass
    /// that just ran leaves it; off whenever notices are off.
    pub(crate) fn settle_attention(
        &self,
        enabled: bool,
        pass: &HandleSync,
        state: &crate::ios_push_handles::IosPushState,
        memory: &dyn HandleMemory,
    ) {
        let Some(vault) = self.open_vault_id() else {
            return;
        };
        let prior = memory.attention(vault);
        let now = enabled && attention_after(prior, pass);
        state.record_attention(now);
        if now != prior {
            memory.set_attention(vault, now);
        }
    }

    /// The refresh at opening, while remote notices are on: the destination for each completed link
    /// is made good (enrolled, and a new one reserved for a link left with none), and the token
    /// Apple just gave is bound to each enrolled destination whose remembered digest differs, with
    /// the one repair `bind_with_one_repair` allows. `token` is `None` when Apple gave none (the
    /// reason is in `state`): nothing is bound, and what is remembered stays.
    ///
    /// Nothing here is an unlock error. A vault that is locked meanwhile, a session that ended or a
    /// recovery session passes silently as the error it is; any other failure sets the attention
    /// flag (Settings says that notices need a look) and is returned for the caller to drop.
    /// Offline or a portal that answers later is only "waiting": the next opening tries again.
    pub(crate) fn refresh_push_handle(
        &self,
        token: Option<&Token>,
        state: &crate::ios_push_handles::IosPushState,
        memory: &dyn HandleMemory,
        session: u64,
        exchange: &impl Exchange,
    ) -> Result<HandleSync, VaultError> {
        let (vault, missing) = {
            let guard = self.session();
            let open = guard.as_ref().ok_or(VaultError::Locked)?;
            if open.recovery.is_some() {
                return Err(VaultError::RecoveryMode);
            }
            let policy = Self::remote_policy(&open.manifest)?;
            if !policy.saved().opted_in() {
                return Ok(HandleSync::default());
            }
            let missing = open
                .manifest
                .portal_links
                .iter()
                .any(|l| l.clinic.is_some() && policy.destination_for(l.id).is_none());
            (open.manifest.vault_id, missing)
        };
        // Denied is saved by `set_remote_notices` (the revocations are queued in the vault first,
        // then sent); `sync_remote_notices` alone only reads the permission, so a revoked
        // destination would stay "active" here.
        let denied = state.permission() == crate::document_notifications::Permission::Denied;
        let result = if missing || denied {
            // A link with no destination (a new link, or one the portal did not know twice): the
            // same reserve, enrol and bind as turning the switch on. Also the way a denied
            // permission is acted on.
            self.set_iphone_push(true, token, state, memory, session, exchange)
                .map(|(_, bound)| bound)
        } else {
            self.sync_and_bind_push_handle(state, token, memory, session, exchange)
                .map(|(_, bound)| bound)
        };
        match result {
            Ok(pass) => {
                self.settle_attention(true, &pass, state, memory);
                Ok(pass)
            }
            Err(error) => {
                if failure_needs_a_look(&error) {
                    state.record_attention(true);
                    memory.set_attention(vault, true);
                }
                Err(error)
            }
        }
    }

    /// Binds the token. If a destination was dropped on the way (the portal did not know it when it
    /// was enrolled, or twice when the token was bound), there is nothing left to send notices to
    /// until a new one is reserved and enrolled: that is done once, here, and the token is bound
    /// once more. Never in a loop. If that does not work either, `needs_attention` says so, and
    /// Settings does not claim that notices are on.
    fn bind_with_one_repair(
        &self,
        token: &Token,
        source: &dyn PushSource,
        memory: &dyn HandleMemory,
        session: u64,
        exchange: &impl Exchange,
        synced: RemoteSync,
    ) -> Result<HandleSync, VaultError> {
        let mut bound = self.bind_push_handles(token, memory, session, exchange)?;
        if synced.forgotten == 0 && bound.re_enroll == 0 {
            return Ok(bound);
        }
        // Only what the repair itself enrolls is bound again: a destination the pass above just
        // noted (its first 404) must not meet its second one in the same pass.
        let held = self.iphone_destination_ids()?;
        let again_synced = self.set_remote_notices(true, source, session, exchange)?;
        let fresh: Vec<Uuid> = self
            .iphone_destination_ids()?
            .into_iter()
            .filter(|id| !held.contains(id))
            .collect();
        let again = self.bind_push_handles_for(token, memory, session, exchange, Some(&fresh))?;
        bound.bound += again.bound;
        bound.unchanged += again.unchanged;
        bound.suspected += again.suspected;
        bound.refused += again.refused;
        bound.waiting += again.waiting;
        bound.needs_attention = again_synced.forgotten > 0
            || again.re_enroll > 0
            || again.suspected > 0
            || again.refused > 0;
        Ok(bound)
    }

    /// Sends the Apple token for each enrolled iPhone destination whose remembered digest differs
    /// from this token's. A 200 or 201 is remembered; the first 404 is noted and kept, the second one
    /// at a later pass revokes the destination (no retry here); a 400 is a bug and is not sent again;
    /// anything else waits for a later opening. No network call is made under the vault lock.
    pub(crate) fn bind_push_handles(
        &self,
        token: &Token,
        memory: &dyn HandleMemory,
        session: u64,
        exchange: &impl Exchange,
    ) -> Result<HandleSync, VaultError> {
        self.bind_push_handles_for(token, memory, session, exchange, None)
    }

    /// `bind_push_handles`, for the destinations named only (`None`: every enrolled one).
    fn bind_push_handles_for(
        &self,
        token: &Token,
        memory: &dyn HandleMemory,
        session: u64,
        exchange: &impl Exchange,
        only: Option<&[Uuid]>,
    ) -> Result<HandleSync, VaultError> {
        let cancelled = || self.portal_link_ticket() != session;
        if cancelled() {
            return Err(VaultError::Cancelled);
        }
        let (destinations, links) = {
            let guard = self.session();
            let open = guard.as_ref().ok_or(VaultError::Locked)?;
            if open.recovery.is_some() {
                return Err(VaultError::RecoveryMode);
            }
            let policy = Self::remote_policy(&open.manifest)?;
            let enrolled = policy
                .saved()
                .active()
                .iter()
                .filter(|d| d.platform() == Platform::IosApns && d.subscription_id().is_some())
                .filter(|d| only.is_none_or(|ids| ids.contains(&d.id())))
                .cloned()
                .collect::<Vec<_>>();
            (enrolled, open.manifest.portal_links.clone())
        };
        let mut sync = HandleSync::default();
        for destination in destinations {
            let digest = handle_digest(destination.id(), token);
            if memory.recall(destination.id()) == Some(digest) {
                sync.unchanged += 1;
                continue;
            }
            let Some(link) = links.iter().find(|l| {
                l.id == destination.owner().link_id()
                    && l.clinic.is_some()
                    && l.keys.device_key_id() == destination.owner().device_key_id()
            }) else {
                sync.waiting += 1;
                continue;
            };
            // Moved out of the wiping guard into the request, which owns it from here.
            let mut body = handle_body(destination.id(), token);
            let reply = match exchange(
                link,
                "POST",
                HANDLES,
                std::mem::take(&mut *body),
                None,
                MAX_HANDLE_REPLY,
                &cancelled,
            ) {
                Ok(reply) => binding_reply(reply.status, &reply.body),
                Err(crate::portal_link::LinkError::Cancelled) => return Err(VaultError::Cancelled),
                Err(_) => Binding::Later,
            };
            match reply {
                Binding::Bound => {
                    // A memory that cannot keep the digest only means one more send next time.
                    let _ = memory.remember(destination.id(), digest);
                    sync.bound += 1;
                }
                Binding::ReEnroll => {
                    if memory.recall(destination.id()) == Some(SUSPECT) {
                        // Twice: the portal does not know it. Its place there, if any, is revoked
                        // rather than dropped, so that none is left behind.
                        memory.forget(destination.id());
                        self.apply_remote(session, |policy| {
                            policy.revoke_destination(destination.id())
                        })?;
                        sync.re_enroll += 1;
                    } else {
                        // The first time is only noted: a refused assertion answers 404 as well.
                        let _ = memory.remember(destination.id(), SUSPECT);
                        sync.suspected += 1;
                    }
                }
                Binding::Refused => sync.refused += 1,
                Binding::Later => sync.waiting += 1,
            }
        }
        Ok(sync)
    }

    fn still_active(&self, id: Uuid) -> bool {
        self.session().as_ref().is_some_and(|open| {
            open.manifest
                .remote_notices
                .active()
                .iter()
                .any(|d| d.id() == id)
        })
    }

    fn apply_remote(
        &self,
        session: u64,
        change: impl FnOnce(&mut Policy),
    ) -> Result<(), VaultError> {
        if self.portal_link_ticket() != session {
            return Err(VaultError::Cancelled);
        }
        self.mutate_recorded(|manifest, _| {
            let mut policy = Self::remote_policy(manifest)?;
            change(&mut policy);
            manifest.remote_notices = policy.saved().clone();
            Ok(())
        })
    }

    /// After the vault opens (unlock or recovery key): revocations still waiting are sent, then
    /// one check runs if a push left one owed. Nothing at all happens for a vault that never
    /// turned remote notices on.
    pub(crate) fn after_open(&self) {
        let session = self.portal_link_ticket();
        let revocations = self
            .session()
            .as_ref()
            .is_some_and(|o| !o.manifest.remote_notices.revocations().is_empty());
        if revocations {
            let _ = self.sync_remote_notices(None, session, &crate::portal_client::api);
        }
        let _ = self.reconcile_after_unlock(session, |session| self.check_documents(session));
    }

    /// A push source hands every provider message's token here. The token only says "check":
    /// with the vault open and remote notices on, the document check runs now (`check` is the
    /// normal one, `check_documents`); otherwise one check is owed for the next opening.
    pub(crate) fn push_received(
        &self,
        token: &str,
        check: impl FnOnce(u64) -> Result<crate::portal_pickup::CheckResult, VaultError>,
    ) -> PushOutcome {
        let Ok(token) = NoticeToken::parse(token) else {
            return PushOutcome::Ignored;
        };
        let Ok(mut inbox) = self.push_inbox.lock() else {
            return PushOutcome::Ignored;
        };
        if !inbox.first_time(&token) {
            return PushOutcome::Ignored;
        }
        let session = self.portal_link_ticket();
        let open = {
            let guard = self.session();
            guard
                .as_ref()
                .map(|o| o.recovery.is_none() && o.manifest.remote_notices.opted_in())
        };
        match open {
            // Locked: whether remote notices are on is in the vault. Owe one check; opening
            // decides.
            None => {
                inbox.owe_check();
                PushOutcome::Pending
            }
            Some(false) => PushOutcome::Ignored,
            Some(true) => {
                drop(inbox);
                self.owed_check(session, check)
            }
        }
    }

    /// The patient opened a remote notice. Navigation only: it unlocks nothing.
    pub(crate) fn push_activated(&self, token: &str) -> Option<Activation> {
        NoticeToken::parse(token).ok()?;
        let unlocked = self.session().is_some();
        if !unlocked {
            self.push_inbox.lock().ok()?.owe_check();
        }
        Some(Activation::for_vault(unlocked))
    }

    /// After the vault opens: one check, if a push left one owed and remote notices are on.
    pub(crate) fn reconcile_after_unlock(
        &self,
        session: u64,
        check: impl FnOnce(u64) -> Result<crate::portal_pickup::CheckResult, VaultError>,
    ) -> PushOutcome {
        let owed = self
            .push_inbox
            .lock()
            .is_ok_and(|mut inbox| inbox.take_pending());
        if !owed {
            return PushOutcome::Ignored;
        }
        let opted_in = self
            .session()
            .as_ref()
            .is_some_and(|o| o.recovery.is_none() && o.manifest.remote_notices.opted_in());
        if !opted_in {
            return PushOutcome::Ignored;
        }
        self.owed_check(session, check)
    }

    fn owed_check(
        &self,
        session: u64,
        check: impl FnOnce(u64) -> Result<crate::portal_pickup::CheckResult, VaultError>,
    ) -> PushOutcome {
        match check(session) {
            Ok(_) => PushOutcome::Checked,
            // Busy (a check already runs), offline or locked meanwhile: keep it owed.
            Err(_) => {
                if let Ok(mut inbox) = self.push_inbox.lock() {
                    inbox.owe_check();
                }
                PushOutcome::Pending
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document_notifications::Permission;
    use crate::document_push::FakePushSource;
    use crate::portal_client::ApiResponse;
    use crate::portal_link::LinkError;
    use std::cell::RefCell;

    const PASSWORD: &str = "harbor-lantern-violet-meadow-582";
    const TOKEN: &str = "AbCdEfGhIjKlMnOpQr-_01";

    /// One request the fake portal saw: link, method, path and body.
    type Seen = (Uuid, String, String, serde_json::Value);

    fn store_with_links() -> (tempfile::TempDir, VaultStore, [StoredLink; 2]) {
        let links = super::super::automatic_collection_tests::accepted_links();
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "FAKE remote notices", 1).unwrap();
        store
            .mutate_recorded(|manifest, _| {
                manifest.portal_links.extend_from_slice(&links);
                Ok(())
            })
            .unwrap();
        (temp, store, links)
    }

    fn reply(status: u16, body: serde_json::Value) -> Result<ApiResponse, LinkError> {
        Ok(ApiResponse {
            status,
            body: zeroize::Zeroizing::new(serde_json::to_vec(&body).unwrap()),
            date: None,
            retry_after: None,
        })
    }

    /// A FAKE portal: enrollments get a record naming the destination; revocations are
    /// confirmed. `refuse` answers instead when it returns Some.
    fn portal<'a>(
        seen: &'a RefCell<Vec<Seen>>,
        refuse: impl Fn(&str) -> Option<(u16, serde_json::Value)> + 'a,
    ) -> impl Exchange + 'a {
        move |link: &StoredLink,
              method: &str,
              path: &str,
              body: Vec<u8>,
              anchor: Option<&str>,
              max: usize,
              _: &dyn Fn() -> bool| {
            assert_eq!((method, anchor, max), ("POST", None, MAX_REPLY));
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            seen.borrow_mut()
                .push((link.id, method.into(), path.into(), body.clone()));
            if let Some((status, answer)) = refuse(path) {
                return reply(status, answer);
            }
            let destination = body["destination_id"].clone();
            if path == SUBSCRIPTIONS {
                reply(
                    201,
                    serde_json::json!({
                        "subscription_id": Uuid::new_v4().to_string(),
                        "epoch": Uuid::new_v4().to_string(),
                        "destination_id": destination,
                        "platform": body["platform"],
                        "remote_enabled": true,
                        "remote_consent_version": 1,
                        "permission_observed": true,
                        "enrolled_at": "2026-11-05T00:00:00Z",
                        "revoked": false,
                    }),
                )
            } else {
                assert_eq!(path, REVOCATIONS);
                reply(
                    200,
                    serde_json::json!({"destination_id": destination, "revoked": true}),
                )
            }
        }
    }

    fn saved(store: &VaultStore) -> crate::document_notifications::RemoteNotices {
        store
            .session()
            .as_ref()
            .unwrap()
            .manifest
            .remote_notices
            .clone()
    }

    /// Every file's bytes under `root`, but the open store's lock file: it is empty, and on
    /// Windows its byte-range lock refuses a read while the store is open (OS error 33).
    fn files_under(root: &Path) -> Vec<Vec<u8>> {
        let mut found = Vec::new();
        for entry in walk(root) {
            if entry
                .file_name()
                .is_some_and(|name| name.to_string_lossy().ends_with(".lock"))
            {
                assert_eq!(
                    fs::metadata(&entry).unwrap().len(),
                    0,
                    "{}",
                    entry.display()
                );
                continue;
            }
            found.push(fs::read(entry).unwrap());
        }
        found
    }

    fn walk(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                out.extend(walk(&path));
            } else {
                out.push(path);
            }
        }
        out
    }

    #[test]
    fn opting_in_saves_a_destination_per_link_before_the_portal_enrols_it() {
        let (temp, store, links) = store_with_links();
        let seen = RefCell::new(Vec::new());
        let session = store.portal_link_ticket();
        let checked = RefCell::new(0);
        let inner = portal(&seen, |_| None);
        // No vault lock is held while a request is sent, and its destination is already saved.
        let exchange = |link: &StoredLink,
                        method: &str,
                        path: &str,
                        body: Vec<u8>,
                        anchor: Option<&str>,
                        max: usize,
                        cancelled: &dyn Fn() -> bool| {
            let guard = store
                .unlocked
                .try_lock()
                .expect("no network under the vault lock");
            let destination: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert!(guard
                .as_ref()
                .unwrap()
                .manifest
                .remote_notices
                .active()
                .iter()
                .any(|d| d.id().to_string() == destination["destination_id"]));
            drop(guard);
            *checked.borrow_mut() += 1;
            inner(link, method, path, body, anchor, max, cancelled)
        };
        let sync = store
            .set_remote_notices(true, &FakePushSource::granted(), session, &exchange)
            .unwrap();
        assert_eq!((sync.enrolled, sync.waiting), (2, 0));
        assert_eq!(*checked.borrow(), 2);
        let seen = seen.borrow().clone();
        assert_eq!(
            seen.iter().map(|s| s.0).collect::<Vec<_>>(),
            links.iter().map(|l| l.id).collect::<Vec<_>>()
        );
        for (_, _, path, body) in &seen {
            assert_eq!(path, SUBSCRIPTIONS);
            assert_eq!(
                body.as_object().unwrap().keys().collect::<Vec<_>>(),
                [
                    "destination_id",
                    "permission_observed",
                    "platform",
                    "remote_consent_version",
                    "remote_enabled"
                ]
            );
        }
        let state = saved(&store);
        assert!(state.opted_in());
        assert!(state.active().iter().all(|d| d.subscription_id().is_some()));
        assert_eq!(
            store
                .remote_notice_status(Some(&FakePushSource::granted()))
                .unwrap(),
            RemoteNoticeStatus {
                supported: true,
                opted_in: true,
                destinations: 2,
                enrolled: 2,
                pending_revocations: 0,
            }
        );
        // Nothing outside the encryption names a clinic link or a destination.
        let ids = links
            .iter()
            .map(|l| l.id.to_string())
            .chain(state.active().iter().map(|d| d.id().to_string()))
            .collect::<Vec<_>>();
        for bytes in files_under(temp.path()) {
            let text = String::from_utf8_lossy(&bytes);
            assert!(ids.iter().all(|id| !text.contains(id.as_str())));
        }
        // Again: nothing more to enrol.
        let again = store
            .sync_remote_notices(
                Some(&FakePushSource::granted()),
                session,
                &portal(&RefCell::default(), |_| None),
            )
            .unwrap();
        assert_eq!(again, RemoteSync::default());
    }

    #[test]
    fn a_refused_destination_is_forgotten_and_an_unreachable_portal_is_asked_again() {
        let (_temp, store, _) = store_with_links();
        let session = store.portal_link_ticket();
        let seen = RefCell::new(Vec::new());
        let first = RefCell::new(true);
        let refusing = portal(&seen, |_| {
            if std::mem::replace(&mut *first.borrow_mut(), false) {
                Some((409, serde_json::json!({"code": "destination_revoked"})))
            } else {
                Some((404, serde_json::json!({"detail": "not found"})))
            }
        });
        let sync = store
            .set_remote_notices(true, &FakePushSource::granted(), session, &refusing)
            .unwrap();
        assert_eq!((sync.enrolled, sync.forgotten, sync.waiting), (0, 1, 1));
        let state = saved(&store);
        assert_eq!(state.active().len(), 1);
        assert!(state.revocations().is_empty());
        // A later sync enrols the one that waited.
        let seen = RefCell::new(Vec::new());
        let sync = store
            .sync_remote_notices(
                Some(&FakePushSource::granted()),
                session,
                &portal(&seen, |_| None),
            )
            .unwrap();
        assert_eq!((sync.enrolled, sync.waiting), (1, 0));
        // Turning it on again gives the forgotten link a fresh destination.
        let sync = store
            .set_remote_notices(
                true,
                &FakePushSource::granted(),
                session,
                &portal(&seen, |_| None),
            )
            .unwrap();
        assert_eq!(sync.enrolled, 1);
        assert_eq!(saved(&store).active().len(), 2);
    }

    #[test]
    fn opting_out_revokes_and_is_acknowledged_only_when_the_portal_confirms() {
        let (_temp, store, _) = store_with_links();
        let session = store.portal_link_ticket();
        let seen = RefCell::new(Vec::new());
        store
            .set_remote_notices(
                true,
                &FakePushSource::granted(),
                session,
                &portal(&seen, |_| None),
            )
            .unwrap();
        let enrolled = saved(&store).active().to_vec();
        // The revocation route is not there yet (an older portal): both wait.
        let seen = RefCell::new(Vec::new());
        let sync = store
            .set_remote_notices(
                false,
                &FakePushSource::granted(),
                session,
                &portal(&seen, |path| {
                    (path == REVOCATIONS).then(|| (404, serde_json::json!({"detail": "not found"})))
                }),
            )
            .unwrap();
        assert_eq!((sync.revoked, sync.waiting, sync.enrolled), (0, 2, 0));
        let state = saved(&store);
        assert!(!state.opted_in() && state.active().is_empty());
        assert_eq!(state.revocations(), enrolled.as_slice());
        let seen = seen.into_inner();
        assert!(seen.iter().all(|s| s.2 == REVOCATIONS));
        assert_eq!(
            seen.iter()
                .map(|s| s.3["destination_id"].clone())
                .collect::<Vec<_>>(),
            enrolled
                .iter()
                .map(|d| serde_json::Value::from(d.id().to_string()))
                .collect::<Vec<_>>()
        );
        // The next sync, with no push source at all (as after opening the vault), revokes them.
        let sync = store
            .sync_remote_notices(None, session, &portal(&RefCell::default(), |_| None))
            .unwrap();
        assert_eq!(sync.revoked, 2);
        assert!(saved(&store).is_empty());
    }

    #[test]
    fn without_os_permission_nothing_is_enrolled_and_held_destinations_are_revoked() {
        let (_temp, store, _) = store_with_links();
        let session = store.portal_link_ticket();
        let source = FakePushSource::granted();
        store
            .set_remote_notices(
                true,
                &source,
                session,
                &portal(&RefCell::default(), |_| None),
            )
            .unwrap();
        *source.permission.lock().unwrap() = Permission::Denied;
        let seen = RefCell::new(Vec::new());
        let sync = store
            .set_remote_notices(true, &source, session, &portal(&seen, |_| None))
            .unwrap();
        assert_eq!((sync.revoked, sync.enrolled), (2, 0));
        let state = saved(&store);
        assert!(state.opted_in() && state.active().is_empty() && state.revocations().is_empty());
        assert!(seen.into_inner().iter().all(|s| s.2 == REVOCATIONS));
    }

    #[test]
    fn an_answer_for_a_session_that_ended_is_not_applied() {
        let (_temp, store, _) = store_with_links();
        let session = store.portal_link_ticket();
        let log = RefCell::new(Vec::new());
        let inner = portal(&log, |_| None);
        let ending = |link: &StoredLink,
                      method: &str,
                      path: &str,
                      body: Vec<u8>,
                      anchor: Option<&str>,
                      max: usize,
                      cancelled: &dyn Fn() -> bool| {
            store.portal_session.fetch_add(1, Ordering::AcqRel);
            inner(link, method, path, body, anchor, max, cancelled)
        };
        assert!(matches!(
            store.set_remote_notices(true, &FakePushSource::granted(), session, &ending),
            Err(VaultError::Cancelled)
        ));
        assert!(saved(&store)
            .active()
            .iter()
            .all(|d| d.subscription_id().is_none()));
    }

    #[test]
    fn a_push_checks_now_when_open_and_once_after_opening_when_locked() {
        let (_temp, store, _) = store_with_links();
        let checks = RefCell::new(0);
        let check = |_: u64| {
            *checks.borrow_mut() += 1;
            Ok(crate::portal_pickup::CheckResult::default())
        };
        // Remote notices off: a push is ignored.
        assert_eq!(store.push_received(TOKEN, check), PushOutcome::Ignored);
        let session = store.portal_link_ticket();
        store
            .set_remote_notices(
                true,
                &FakePushSource::granted(),
                session,
                &portal(&RefCell::default(), |_| None),
            )
            .unwrap();
        let token = |n: u8| format!("{TOKEN:.21}{n}");
        assert_eq!(store.push_received(&token(2), check), PushOutcome::Checked);
        assert_eq!(store.push_received(&token(2), check), PushOutcome::Ignored);
        assert_eq!(
            store.push_received("not a notice token", check),
            PushOutcome::Ignored
        );
        assert_eq!(*checks.borrow(), 1);
        // A check that cannot run now stays owed.
        assert_eq!(
            store.push_received(&token(3), |_| Err(VaultError::DocumentCheckBusy)),
            PushOutcome::Pending
        );
        // Locked: two pushes owe one check, which runs once after opening.
        store.lock();
        assert_eq!(store.push_received(&token(4), check), PushOutcome::Pending);
        assert_eq!(store.push_received(&token(5), check), PushOutcome::Pending);
        assert_eq!(*checks.borrow(), 1);
        store.unlock(PASSWORD).unwrap();
        let session = store.portal_link_ticket();
        assert_eq!(
            store.reconcile_after_unlock(session, check),
            PushOutcome::Checked
        );
        assert_eq!(
            store.reconcile_after_unlock(session, check),
            PushOutcome::Ignored
        );
        assert_eq!(*checks.borrow(), 2);
        // Owed while locked, but turned off meanwhile: nothing runs.
        store
            .set_remote_notices(
                false,
                &FakePushSource::granted(),
                session,
                &portal(&RefCell::default(), |_| None),
            )
            .unwrap();
        store.lock();
        assert_eq!(store.push_received(&token(6), check), PushOutcome::Pending);
        store.unlock(PASSWORD).unwrap();
        assert_eq!(
            store.reconcile_after_unlock(store.portal_link_ticket(), check),
            PushOutcome::Ignored
        );
        assert_eq!(*checks.borrow(), 2);
    }

    #[test]
    fn opening_a_notice_only_navigates() {
        let (_temp, store, _) = store_with_links();
        assert_eq!(
            store.push_activated(TOKEN),
            Some(Activation::ClinicDocuments)
        );
        assert_eq!(store.push_activated("{\"subscription_id\":1}"), None);
        store.lock();
        assert_eq!(
            store.push_activated(TOKEN),
            Some(Activation::UnlockThenClinicDocuments)
        );
        assert!(store.session().is_none());
    }

    #[test]
    fn the_manifest_keeps_remote_notices_only_from_format_9_and_for_its_own_links() {
        let (_temp, store, links) = store_with_links();
        let session = store.portal_link_ticket();
        store
            .set_remote_notices(
                true,
                &FakePushSource::granted(),
                session,
                &portal(&RefCell::default(), |_| None),
            )
            .unwrap();
        let manifest = store.session().as_ref().unwrap().manifest.clone();
        assert!(validate_manifest_structure(&manifest, manifest.vault_id).is_ok());
        let mut older = manifest.clone();
        older.format_version = 8;
        assert!(validate_manifest_structure(&older, older.vault_id).is_err());
        let mut unknown = manifest.clone();
        unknown.portal_links.retain(|l| l.id != links[0].id);
        assert!(validate_manifest_structure(&unknown, unknown.vault_id).is_err());
        let mut rekeyed = manifest.clone();
        rekeyed.portal_links[0].keys = rekeyed.portal_links[1].keys.clone();
        assert!(validate_manifest_structure(&rekeyed, rekeyed.vault_id).is_err());
        // An older manifest without the field reads as nothing saved.
        let mut value = serde_json::to_value(&manifest).unwrap();
        value.as_object_mut().unwrap().remove("remoteNotices");
        let without: Manifest = serde_json::from_value(value).unwrap();
        assert!(without.remote_notices.is_empty());
    }

    // ---- the iPhone push handle (piece 1) ----

    mod handles {
        use super::*;
        use crate::ios_push::Refusal;
        use crate::ios_push_handles::{fake_token, FakeHandleMemory, IosPushState};

        /// A FAKE portal for an iPhone: enrolls, and answers the handles route as `handles` says.
        fn iphone_portal<'a>(
            seen: &'a RefCell<Vec<Seen>>,
            handles: impl Fn(&serde_json::Value) -> (u16, serde_json::Value) + 'a,
        ) -> impl Exchange + 'a {
            move |link: &StoredLink,
                  method: &str,
                  path: &str,
                  body: Vec<u8>,
                  anchor: Option<&str>,
                  _max: usize,
                  _: &dyn Fn() -> bool| {
                assert_eq!((method, anchor), ("POST", None));
                let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                seen.borrow_mut()
                    .push((link.id, method.into(), path.into(), body.clone()));
                if path == HANDLES {
                    let (status, answer) = handles(&body);
                    return reply(status, answer);
                }
                if path == REVOCATIONS {
                    return reply(
                        200,
                        serde_json::json!({"destination_id": body["destination_id"], "revoked": true}),
                    );
                }
                assert_eq!(path, SUBSCRIPTIONS);
                reply(
                    201,
                    serde_json::json!({
                        "subscription_id": Uuid::new_v4().to_string(),
                        "epoch": Uuid::new_v4().to_string(),
                        "destination_id": body["destination_id"],
                        "platform": body["platform"],
                        "remote_enabled": true,
                        "remote_consent_version": 1,
                        "permission_observed": true,
                        "enrolled_at": "2026-11-05T00:00:00Z",
                        "revoked": false,
                    }),
                )
            }
        }

        fn allowed() -> IosPushState {
            let state = IosPushState::default();
            state.record_permission("authorized");
            state
        }

        fn opted_in(store: &VaultStore, state: &IosPushState, exchange: &impl Exchange) {
            // Opting in enrolls first; the token is bound afterwards, by `sync_and_bind_push_handle`.
            store
                .set_remote_notices(true, state, store.portal_link_ticket(), exchange)
                .unwrap();
        }

        fn paths(seen: &RefCell<Vec<Seen>>) -> Vec<String> {
            seen.borrow().iter().map(|s| s.2.clone()).collect()
        }

        #[test]
        fn the_destination_is_enrolled_before_its_token_is_bound() {
            let (_temp, store, links) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let exchange = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            let state = allowed();
            let memory = FakeHandleMemory::default();
            let token = fake_token("sandbox", "ab");
            let (synced, bound) = store
                .sync_and_bind_push_handle(
                    &state,
                    Some(&token),
                    &memory,
                    store.portal_link_ticket(),
                    &exchange,
                )
                .unwrap();
            // Not opted in yet: nothing is enrolled, so nothing is bound.
            assert_eq!((synced.enrolled, bound.bound), (0, 0));
            assert!(paths(&seen).is_empty());

            opted_in(&store, &state, &exchange);
            seen.borrow_mut().clear();
            let (_, bound) = store
                .sync_and_bind_push_handle(
                    &state,
                    Some(&token),
                    &memory,
                    store.portal_link_ticket(),
                    &exchange,
                )
                .unwrap();
            assert_eq!((bound.bound, bound.unchanged), (2, 0));
            assert!(paths(&seen).iter().all(|p| p == HANDLES));
            // Each enrolled destination, once, signed for its own link.
            let seen = seen.borrow().clone();
            assert_eq!(
                seen.iter().map(|s| s.0).collect::<Vec<_>>(),
                links.iter().map(|l| l.id).collect::<Vec<_>>()
            );
            for (_, _, _, body) in &seen {
                assert_eq!(
                    body.as_object().unwrap().keys().collect::<Vec<_>>(),
                    ["destination_id", "environment", "platform", "token"]
                );
                assert_eq!(body["platform"], "ios_apns");
                assert_eq!(body["environment"], "sandbox");
                assert_eq!(body["token"], "ab".repeat(32));
            }
        }

        #[test]
        fn enrolling_comes_first_when_both_are_owed() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let exchange = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            let state = allowed();
            // Reserved but not yet enrolled: the portal is unreachable at opting in.
            let down = |_: &StoredLink,
                        _: &str,
                        _: &str,
                        _: Vec<u8>,
                        _: Option<&str>,
                        _: usize,
                        _: &dyn Fn() -> bool| Err(LinkError::Network);
            let _ = store.set_remote_notices(true, &state, store.portal_link_ticket(), &down);
            let memory = FakeHandleMemory::default();
            let token = fake_token("production", "cd");
            let (synced, bound) = store
                .sync_and_bind_push_handle(
                    &state,
                    Some(&token),
                    &memory,
                    store.portal_link_ticket(),
                    &exchange,
                )
                .unwrap();
            assert_eq!((synced.enrolled, bound.bound), (2, 2));
            let order = paths(&seen);
            assert_eq!(
                order,
                [SUBSCRIPTIONS, SUBSCRIPTIONS, HANDLES, HANDLES],
                "every enrollment is sent before any token"
            );
        }

        #[test]
        fn a_token_the_portal_already_holds_is_not_sent_again_but_a_new_one_is() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let exchange = iphone_portal(&seen, |_| (200, serde_json::json!({})));
            let state = allowed();
            opted_in(&store, &state, &exchange);
            let memory = FakeHandleMemory::default();
            let session = || store.portal_link_ticket();
            let first = fake_token("sandbox", "ab");
            let bind = |token: &Token| {
                store
                    .bind_push_handles(token, &memory, session(), &exchange)
                    .unwrap()
            };
            seen.borrow_mut().clear();
            assert_eq!(bind(&first).bound, 2);
            assert_eq!(seen.borrow().len(), 2);
            // The next unlock gives the same token: nothing goes to the portal.
            seen.borrow_mut().clear();
            let again = bind(&first);
            assert_eq!((again.bound, again.unchanged), (0, 2));
            assert!(seen.borrow().is_empty());
            // Apple handed out another token, or the build moved to production: sent again.
            for next in [fake_token("sandbox", "cd"), fake_token("production", "ab")] {
                seen.borrow_mut().clear();
                assert_eq!(bind(&next).bound, 2, "{next:?}");
                assert_eq!(seen.borrow().len(), 2);
                assert_eq!(bind(&next).unchanged, 2);
            }
        }

        #[test]
        fn a_memory_that_cannot_keep_the_digest_only_means_another_send() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let exchange = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            let state = allowed();
            opted_in(&store, &state, &exchange);
            let memory = FakeHandleMemory::default();
            memory
                .refuse_writes
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let token = fake_token("sandbox", "ab");
            for _ in 0..2 {
                let done = store
                    .bind_push_handles(&token, &memory, store.portal_link_ticket(), &exchange)
                    .unwrap();
                assert_eq!((done.bound, done.unchanged), (2, 0));
            }
        }

        #[test]
        fn the_first_404_is_only_noted_and_the_second_revokes_the_destination() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let refusing =
                iphone_portal(&seen, |_| (404, serde_json::json!({"detail": "not found"})));
            let state = allowed();
            opted_in(&store, &state, &refusing);
            let before: Vec<Uuid> = saved(&store).active().iter().map(|d| d.id()).collect();
            let memory = FakeHandleMemory::default();
            for id in &before {
                memory.remember(*id, [9; 32]);
            }
            let token = fake_token("sandbox", "ab");
            seen.borrow_mut().clear();
            // The first 404 may be a refused assertion (skew, replay, expiry): kept, and noted.
            let done = store
                .bind_push_handles(&token, &memory, store.portal_link_ticket(), &refusing)
                .unwrap();
            assert_eq!(
                (done.re_enroll, done.suspected, done.bound, done.waiting),
                (0, 2, 0, 0)
            );
            // One request each: no retry in the same pass.
            assert_eq!(seen.borrow().len(), 2);
            let kept: Vec<Uuid> = saved(&store).active().iter().map(|d| d.id()).collect();
            assert_eq!(kept, before);
            assert!(saved(&store).revocations().is_empty());
            assert!(before.iter().all(|id| memory.recall(*id) == Some(SUSPECT)));
            // The second 404, at a later pass, is the portal not knowing it: revoked, not dropped.
            seen.borrow_mut().clear();
            let done = store
                .bind_push_handles(&token, &memory, store.portal_link_ticket(), &refusing)
                .unwrap();
            assert_eq!((done.re_enroll, done.suspected), (2, 0));
            assert_eq!(seen.borrow().len(), 2);
            assert!(saved(&store).active().is_empty());
            let revoking: Vec<Uuid> = saved(&store).revocations().iter().map(|d| d.id()).collect();
            assert_eq!(revoking.len(), 2);
            assert!(before.iter().all(|id| revoking.contains(id)));
            assert!(before.iter().all(|id| memory.recall(*id).is_none()));
        }

        #[test]
        fn a_noted_404_is_cleared_by_a_send_that_works() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let ok = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            let state = allowed();
            opted_in(&store, &state, &ok);
            let ids: Vec<Uuid> = saved(&store).active().iter().map(|d| d.id()).collect();
            let memory = FakeHandleMemory::default();
            for id in &ids {
                memory.remember(*id, SUSPECT);
            }
            let token = fake_token("sandbox", "ab");
            // A noted destination is sent again, and a good answer replaces the note.
            let done = store
                .bind_push_handles(&token, &memory, store.portal_link_ticket(), &ok)
                .unwrap();
            assert_eq!(done.bound, 2);
            assert!(ids
                .iter()
                .all(|id| memory.recall(*id) == Some(handle_digest(*id, &token))));
        }

        #[test]
        fn after_a_destination_is_revoked_one_new_one_is_enrolled_and_bound_in_the_same_pass() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let state = allowed();
            let first = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            opted_in(&store, &state, &first);
            let old: Vec<Uuid> = saved(&store).active().iter().map(|d| d.id()).collect();
            // The portal knows only destinations it did not already lose.
            let lost = old.iter().map(Uuid::to_string).collect::<Vec<_>>();
            let portal = iphone_portal(&seen, |body| {
                let id = body["destination_id"].as_str().unwrap().to_owned();
                if lost.contains(&id) {
                    (404, serde_json::json!({"detail": "not found"}))
                } else {
                    (201, serde_json::json!({}))
                }
            });
            let memory = FakeHandleMemory::default();
            let token = fake_token("sandbox", "ab");
            let pass = || {
                store
                    .sync_and_bind_push_handle(
                        &state,
                        Some(&token),
                        &memory,
                        store.portal_link_ticket(),
                        &portal,
                    )
                    .unwrap()
            };
            // The first pass notes the 404s and keeps what it has.
            let (_, bound) = pass();
            assert_eq!(
                (bound.suspected, bound.re_enroll, bound.needs_attention),
                (2, 0, false)
            );
            // The second revokes them, enrolls two new ones and binds them, once.
            seen.borrow_mut().clear();
            let (_, bound) = pass();
            assert_eq!((bound.re_enroll, bound.bound), (2, 2));
            assert!(!bound.needs_attention);
            let now: Vec<Uuid> = saved(&store).active().iter().map(|d| d.id()).collect();
            assert_eq!(now.len(), 2);
            assert!(now.iter().all(|id| !old.contains(id)));
            // Two lost ones, their two revocations, two enrollments, two bindings: not a loop.
            assert_eq!(seen.borrow().len(), 8);
            assert!(
                saved(&store).revocations().is_empty(),
                "and the portal confirmed them"
            );
        }

        #[test]
        fn the_repair_binds_only_what_it_enrolled_and_not_a_destination_just_noted() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let state = allowed();
            let first = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            opted_in(&store, &state, &first);
            let ids: Vec<Uuid> = saved(&store).active().iter().map(|d| d.id()).collect();
            let (lost, noted) = (ids[0], ids[1]);
            // The portal does not know either of them; the new one it knows.
            let portal = iphone_portal(&seen, |body| {
                let id = body["destination_id"].as_str().unwrap();
                if id == lost.to_string() || id == noted.to_string() {
                    (404, serde_json::json!({"detail": "not found"}))
                } else {
                    (201, serde_json::json!({}))
                }
            });
            // Different histories: the first has already had a 404 at an earlier pass, the second
            // has not.
            let memory = FakeHandleMemory::default();
            memory.remember(lost, SUSPECT);
            let token = fake_token("sandbox", "ab");
            seen.borrow_mut().clear();
            let (_, bound) = store
                .sync_and_bind_push_handle(
                    &state,
                    Some(&token),
                    &memory,
                    store.portal_link_ticket(),
                    &portal,
                )
                .unwrap();
            // One revoked (its second 404) and replaced and bound; one noted (its first 404).
            assert_eq!(
                (
                    bound.re_enroll,
                    bound.suspected,
                    bound.bound,
                    bound.needs_attention
                ),
                (1, 1, 1, false)
            );
            // The noted one was asked once in the whole pass, and is still there, still noted.
            let to_noted = seen
                .borrow()
                .iter()
                .filter(|s| s.2 == HANDLES && s.3["destination_id"] == noted.to_string())
                .count();
            assert_eq!(to_noted, 1);
            let active: Vec<Uuid> = saved(&store).active().iter().map(|d| d.id()).collect();
            assert!(active.contains(&noted) && !active.contains(&lost));
            assert_eq!(active.len(), 2);
            assert_eq!(memory.recall(noted), Some(SUSPECT));
        }

        #[test]
        fn when_enrolling_anew_does_not_work_either_it_is_said_and_nothing_loops() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let state = allowed();
            let refusing =
                iphone_portal(&seen, |_| (404, serde_json::json!({"detail": "not found"})));
            opted_in(&store, &state, &refusing);
            let memory = FakeHandleMemory::default();
            let token = fake_token("sandbox", "ab");
            let pass = || {
                store
                    .sync_and_bind_push_handle(
                        &state,
                        Some(&token),
                        &memory,
                        store.portal_link_ticket(),
                        &refusing,
                    )
                    .unwrap()
                    .1
            };
            assert!(!pass().needs_attention);
            seen.borrow_mut().clear();
            let second = pass();
            assert!(second.needs_attention);
            // 2 lost + 2 revocations + 2 enrollments + 2 bindings of the new ones (only noted).
            assert_eq!(seen.borrow().len(), 8);
            assert_eq!(second.suspected, 2);
            state.record_attention(second.needs_attention);
            assert_eq!(
                state.state(),
                crate::ios_push_handles::PushState::NeedsAttention
            );
        }

        #[test]
        fn a_400_is_a_bug_and_a_503_is_later_and_neither_is_remembered() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let state = allowed();
            let ok = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            opted_in(&store, &state, &ok);
            let memory = FakeHandleMemory::default();
            let token = fake_token("sandbox", "ab");

            let bug = iphone_portal(&seen, |_| {
                (400, serde_json::json!({"code": "invalid_handle"}))
            });
            let done = store
                .bind_push_handles(&token, &memory, store.portal_link_ticket(), &bug)
                .unwrap();
            assert_eq!((done.refused, done.waiting, done.bound), (2, 0, 0));
            assert_eq!(saved(&store).active().len(), 2, "destinations are kept");

            let busy = iphone_portal(&seen, |_| {
                (503, serde_json::json!({"code": "handles_unavailable"}))
            });
            let done = store
                .bind_push_handles(&token, &memory, store.portal_link_ticket(), &busy)
                .unwrap();
            assert_eq!((done.waiting, done.refused, done.bound), (2, 0, 0));
            assert!(memory.kept.lock().unwrap().is_empty());

            // Later it works: sent, then remembered.
            let done = store
                .bind_push_handles(&token, &memory, store.portal_link_ticket(), &ok)
                .unwrap();
            assert_eq!(done.bound, 2);
            assert_eq!(memory.kept.lock().unwrap().len(), 2);
        }

        #[test]
        fn no_answer_waits_and_an_ended_session_is_cancelled() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let state = allowed();
            let ok = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            opted_in(&store, &state, &ok);
            let memory = FakeHandleMemory::default();
            let token = fake_token("sandbox", "ab");
            let offline = |_: &StoredLink,
                           _: &str,
                           _: &str,
                           _: Vec<u8>,
                           _: Option<&str>,
                           _: usize,
                           _: &dyn Fn() -> bool| Err(LinkError::Network);
            let done = store
                .bind_push_handles(&token, &memory, store.portal_link_ticket(), &offline)
                .unwrap();
            assert_eq!((done.waiting, done.bound), (2, 0));
            let stale = store.portal_link_ticket().wrapping_add(1);
            assert!(matches!(
                store.bind_push_handles(&token, &memory, stale, &ok),
                Err(VaultError::Cancelled)
            ));
        }

        #[test]
        fn only_enrolled_iphone_destinations_get_a_token_and_none_when_notices_are_off() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let ok = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            // Notices refused by the iPhone: the policy cannot notify, so nothing is enrolled.
            let state = IosPushState::default();
            state.record_refusal(Refusal::PermissionRefused);
            store
                .set_remote_notices(true, &state, store.portal_link_ticket(), &ok)
                .unwrap();
            assert!(paths(&seen).is_empty());
            let memory = FakeHandleMemory::default();
            let token = fake_token("sandbox", "ab");
            let done = store
                .bind_push_handles(&token, &memory, store.portal_link_ticket(), &ok)
                .unwrap();
            assert_eq!(done, HandleSync::default());
            assert!(paths(&seen).is_empty());
        }

        #[test]
        fn the_token_is_never_written_into_the_vault_files() {
            let (temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let ok = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            let state = allowed();
            opted_in(&store, &state, &ok);
            let memory = FakeHandleMemory::default();
            let token = fake_token("sandbox", "ab");
            store
                .bind_push_handles(&token, &memory, store.portal_link_ticket(), &ok)
                .unwrap();
            let needle = "ab".repeat(32);
            for bytes in files_under(temp.path()) {
                assert!(
                    !bytes.windows(needle.len()).any(|w| w == needle.as_bytes()),
                    "the token is in a vault file"
                );
            }
        }

        #[test]
        fn turning_it_on_enrolls_then_binds_and_off_revokes_and_forgets_what_was_kept() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let exchange = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            let state = allowed();
            let memory = FakeHandleMemory::default();
            let token = fake_token("production", "ef");
            let (synced, bound) = store
                .set_iphone_push(
                    true,
                    Some(&token),
                    &state,
                    &memory,
                    store.portal_link_ticket(),
                    &exchange,
                )
                .unwrap();
            assert_eq!((synced.enrolled, bound.bound), (2, 2));
            assert_eq!(
                paths(&seen),
                [SUBSCRIPTIONS, SUBSCRIPTIONS, HANDLES, HANDLES]
            );
            assert_eq!(memory.kept.lock().unwrap().len(), 2);
            let ids = store.iphone_destination_ids().unwrap();
            assert_eq!(ids.len(), 2);

            seen.borrow_mut().clear();
            let confirm = |link: &StoredLink,
                           method: &str,
                           path: &str,
                           body: Vec<u8>,
                           _: Option<&str>,
                           _: usize,
                           _: &dyn Fn() -> bool| {
                assert_eq!((method, path), ("POST", REVOCATIONS));
                let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                seen.borrow_mut()
                    .push((link.id, method.into(), path.into(), body.clone()));
                reply(
                    200,
                    serde_json::json!({"destination_id": body["destination_id"], "revoked": true}),
                )
            };
            store
                .set_iphone_push(
                    false,
                    None,
                    &state,
                    &memory,
                    store.portal_link_ticket(),
                    &confirm,
                )
                .unwrap();
            assert!(memory.kept.lock().unwrap().is_empty());
            assert_eq!(paths(&seen), [REVOCATIONS, REVOCATIONS]);
        }

        #[test]
        fn a_refused_ask_keeps_the_choice_and_enrolls_and_binds_nothing() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let exchange = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            let state = IosPushState::default();
            state.record_refusal(Refusal::PermissionRefused);
            let memory = FakeHandleMemory::default();
            let (synced, bound) = store
                .set_iphone_push(
                    true,
                    None,
                    &state,
                    &memory,
                    store.portal_link_ticket(),
                    &exchange,
                )
                .unwrap();
            assert_eq!(
                (synced, bound),
                (RemoteSync::default(), HandleSync::default())
            );
            assert!(paths(&seen).is_empty());
            assert!(store.remote_notice_status(Some(&state)).unwrap().opted_in);
        }
        // ---- the refresh at opening ----

        fn refresh(
            store: &VaultStore,
            token: Option<&Token>,
            state: &IosPushState,
            memory: &FakeHandleMemory,
            exchange: &impl Exchange,
        ) -> Result<HandleSync, VaultError> {
            store.refresh_push_handle(token, state, memory, store.portal_link_ticket(), exchange)
        }

        #[test]
        fn the_opening_refresh_sends_the_token_only_when_its_digest_changed() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let exchange = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            let state = allowed();
            let memory = FakeHandleMemory::default();
            let first = fake_token("sandbox", "ab");
            store
                .set_iphone_push(
                    true,
                    Some(&first),
                    &state,
                    &memory,
                    store.portal_link_ticket(),
                    &exchange,
                )
                .unwrap();
            // The next opening: Apple gives the same token, and nothing goes to the portal.
            seen.borrow_mut().clear();
            let same = refresh(&store, Some(&first), &state, &memory, &exchange).unwrap();
            assert_eq!((same.bound, same.unchanged), (0, 2));
            assert!(seen.borrow().is_empty());
            // Another token (or the other Apple service): one send for each destination.
            for next in [fake_token("sandbox", "cd"), fake_token("production", "cd")] {
                seen.borrow_mut().clear();
                let moved = refresh(&store, Some(&next), &state, &memory, &exchange).unwrap();
                assert_eq!((moved.bound, moved.unchanged), (2, 0));
                assert_eq!(paths(&seen), [HANDLES, HANDLES]);
                // The token is in the request body only, never in what the vault keeps.
                assert!(!files_under(_temp.path())
                    .iter()
                    .any(|file| file.windows(4).any(|w| w == b"cdcd")));
            }
            assert!(!state
                .state()
                .eq(&crate::ios_push_handles::PushState::NeedsAttention));
        }

        #[test]
        fn the_opening_refresh_does_nothing_while_notices_are_off() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let exchange = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            let state = allowed();
            let memory = FakeHandleMemory::default();
            let token = fake_token("sandbox", "ab");
            assert!(!store.iphone_push_refresh_due(&state, &memory));
            let done = refresh(&store, Some(&token), &state, &memory, &exchange).unwrap();
            assert_eq!(done, HandleSync::default());
            assert!(paths(&seen).is_empty());
            assert!(memory.kept.lock().unwrap().is_empty());
            assert!(store.iphone_destination_ids().unwrap().is_empty());
        }

        #[test]
        fn the_refresh_is_due_only_for_an_open_vault_with_notices_on() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let exchange = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            let state = allowed();
            let memory = FakeHandleMemory::default();
            assert!(!store.iphone_push_refresh_due(&state, &memory));
            opted_in(&store, &state, &exchange);
            assert!(store.iphone_push_refresh_due(&state, &memory));
            store.lock();
            assert!(!store.iphone_push_refresh_due(&state, &memory));
            assert!(matches!(
                refresh(&store, None, &state, &memory, &exchange),
                Err(VaultError::Locked)
            ));
        }

        #[test]
        fn no_token_binds_nothing_and_what_is_remembered_stays() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let exchange = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            let state = allowed();
            let memory = FakeHandleMemory::default();
            let token = fake_token("sandbox", "ab");
            store
                .set_iphone_push(
                    true,
                    Some(&token),
                    &state,
                    &memory,
                    store.portal_link_ticket(),
                    &exchange,
                )
                .unwrap();
            let kept = memory.kept.lock().unwrap().clone();
            seen.borrow_mut().clear();
            // Apple gave none this time (the reason is in `state`).
            state.record_refusal(Refusal::TimedOut);
            let done = refresh(&store, None, &state, &memory, &exchange).unwrap();
            assert_eq!(done, HandleSync::default());
            assert!(paths(&seen).is_empty());
            assert_eq!(*memory.kept.lock().unwrap(), kept);
            // Settings says why, and nothing is said to need attention.
            assert_eq!(state.state(), crate::ios_push_handles::PushState::TimedOut);
        }

        #[test]
        fn the_attention_flag_is_kept_across_a_restart_and_a_working_pass_clears_it() {
            let (_temp, store, _) = store_with_links();
            let vault = store.open_vault_id().unwrap();
            let seen = RefCell::new(Vec::new());
            let state = allowed();
            let memory = FakeHandleMemory::default();
            let token = fake_token("sandbox", "ab");
            let refusing =
                iphone_portal(&seen, |_| (404, serde_json::json!({"detail": "not found"})));
            opted_in(&store, &state, &refusing);
            // The first 404 is only noted; the second repairs once and then says so.
            let first = refresh(&store, Some(&token), &state, &memory, &refusing).unwrap();
            assert!(!first.needs_attention);
            assert!(!memory.attention(vault));
            let second = refresh(&store, Some(&token), &state, &memory, &refusing).unwrap();
            assert!(second.needs_attention);
            assert!(memory.attention(vault));
            assert_eq!(
                state.state(),
                crate::ios_push_handles::PushState::NeedsAttention
            );
            // A restart: a fresh state reads the flag at opening, before any network call.
            let restarted = allowed();
            assert_eq!(restarted.state(), crate::ios_push_handles::PushState::Ok);
            assert!(store.iphone_push_refresh_due(&restarted, &memory));
            assert_eq!(
                restarted.state(),
                crate::ios_push_handles::PushState::NeedsAttention
            );
            // A pass that learns nothing (the portal does not answer in time) leaves it on.
            let unreachable =
                |_: &StoredLink,
                 _: &str,
                 _: &str,
                 _: Vec<u8>,
                 _: Option<&str>,
                 _: usize,
                 _: &dyn Fn() -> bool| { Err(LinkError::Network) };
            let waiting = refresh(&store, Some(&token), &restarted, &memory, &unreachable).unwrap();
            assert_eq!((waiting.bound, waiting.unchanged), (0, 0));
            assert!(memory.attention(vault));
            // The portal works again: the token is bound, and the flag is cleared everywhere.
            let working = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            let healed = refresh(&store, Some(&token), &restarted, &memory, &working).unwrap();
            assert!(healed.bound + healed.unchanged > 0);
            assert!(!memory.attention(vault));
            assert_eq!(restarted.state(), crate::ios_push_handles::PushState::Ok);
        }

        #[test]
        fn a_link_left_with_no_destination_gets_a_new_one_at_the_next_opening() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let exchange = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            let state = allowed();
            let memory = FakeHandleMemory::default();
            let token = fake_token("sandbox", "ab");
            store
                .set_iphone_push(
                    true,
                    Some(&token),
                    &state,
                    &memory,
                    store.portal_link_ticket(),
                    &exchange,
                )
                .unwrap();
            // The portal did not know one destination twice: it was revoked here, and nothing
            // replaced it (a pass that could not).
            let lost = store.iphone_destination_ids().unwrap()[0];
            store
                .apply_remote(store.portal_link_ticket(), |policy| {
                    policy.revoke_destination(lost)
                })
                .unwrap();
            memory.forget(lost);
            assert_eq!(store.iphone_destination_ids().unwrap().len(), 1);
            seen.borrow_mut().clear();
            let done = refresh(&store, Some(&token), &state, &memory, &exchange).unwrap();
            // Its revocation, a new destination enrolled, and the token bound to it alone.
            let mut sent = paths(&seen);
            sent.sort();
            assert_eq!(sent, [HANDLES, REVOCATIONS, SUBSCRIPTIONS]);
            assert_eq!((done.bound, done.unchanged), (1, 1));
            let now = store.iphone_destination_ids().unwrap();
            assert_eq!(now.len(), 2);
            assert!(!now.contains(&lost));
            assert!(!done.needs_attention);
        }

        #[test]
        fn a_denied_permission_at_opening_queues_the_revocations_and_sends_no_handle() {
            let (_temp, store, _) = store_with_links();
            let seen = RefCell::new(Vec::new());
            let exchange = iphone_portal(&seen, |_| (201, serde_json::json!({})));
            let state = allowed();
            let memory = FakeHandleMemory::default();
            let token = fake_token("sandbox", "ab");
            store
                .set_iphone_push(
                    true,
                    Some(&token),
                    &state,
                    &memory,
                    store.portal_link_ticket(),
                    &exchange,
                )
                .unwrap();
            assert_eq!(saved(&store).active().len(), 2);
            // iPhone Settings now says no: no token is asked for, so none is passed.
            let denied = IosPushState::default();
            denied.record_permission("denied");
            // The portal does not answer: the two revocations are queued in the vault, nothing is
            // active, and no handle was sent.
            seen.borrow_mut().clear();
            let offline = |_: &StoredLink,
                           _: &str,
                           path: &str,
                           _: Vec<u8>,
                           _: Option<&str>,
                           _: usize,
                           _: &dyn Fn() -> bool| {
                seen.borrow_mut().push((
                    Uuid::nil(),
                    "POST".into(),
                    path.into(),
                    serde_json::json!({}),
                ));
                Err(LinkError::Network)
            };
            let first = refresh(&store, None, &denied, &memory, &offline).unwrap();
            assert_eq!(first, HandleSync::default());
            let queued = saved(&store);
            assert!(queued.opted_in(), "the patient's choice is kept");
            assert!(queued.active().is_empty());
            assert_eq!(queued.revocations().len(), 2);
            assert_eq!(paths(&seen), [REVOCATIONS, REVOCATIONS]);
            // At the next opening the portal answers: the revocations are acknowledged, still
            // with no handle.
            seen.borrow_mut().clear();
            refresh(&store, None, &denied, &memory, &exchange).unwrap();
            assert!(saved(&store).revocations().is_empty());
            assert!(!paths(&seen).contains(&HANDLES.to_string()));
            // What the Keychain remembered stays: a later allowed opening finds the vault with no
            // destination and makes one (the token is bound to that one only).
            seen.borrow_mut().clear();
            let again = refresh(&store, Some(&token), &state, &memory, &exchange).unwrap();
            assert_eq!(again.bound, 2);
            assert_eq!(saved(&store).active().len(), 2);
        }

        #[test]
        fn turning_notices_off_clears_the_flag_and_a_refresh_without_a_session_sets_none() {
            let (_temp, store, _) = store_with_links();
            let vault = store.open_vault_id().unwrap();
            let state = allowed();
            let memory = FakeHandleMemory::default();
            memory.set_attention(vault, true);
            state.record_attention(true);
            let off = HandleSync::default();
            store.settle_attention(false, &off, &state, &memory);
            assert!(!memory.attention(vault));
            assert_eq!(state.state(), crate::ios_push_handles::PushState::Ok);
            // On, with a pass that says so: set in both places.
            let needs = HandleSync {
                needs_attention: true,
                ..HandleSync::default()
            };
            store.settle_attention(true, &needs, &state, &memory);
            assert!(memory.attention(vault));
            assert_eq!(
                state.state(),
                crate::ios_push_handles::PushState::NeedsAttention
            );
            // A locked vault has no id to key the flag by: nothing is written.
            store.lock();
            memory.set_attention(vault, false);
            store.settle_attention(true, &needs, &state, &memory);
            assert!(!memory.attention(vault));
        }

        #[test]
        fn what_a_pass_does_to_the_flag_and_which_failures_set_it() {
            let none = HandleSync::default();
            let bound = HandleSync { bound: 1, ..none };
            let unchanged = HandleSync {
                unchanged: 2,
                ..none
            };
            let attention = HandleSync {
                needs_attention: true,
                bound: 1,
                ..none
            };
            let waiting = HandleSync {
                waiting: 2,
                suspected: 1,
                refused: 1,
                ..none
            };
            for prior in [false, true] {
                assert!(attention_after(prior, &attention), "needs attention wins");
                assert!(!attention_after(prior, &bound));
                assert!(!attention_after(prior, &unchanged));
                // Learned nothing about the portal: as it was.
                assert_eq!(attention_after(prior, &none), prior);
                assert_eq!(attention_after(prior, &waiting), prior);
            }
            for quiet in [
                VaultError::Cancelled,
                VaultError::Locked,
                VaultError::RecoveryMode,
            ] {
                assert!(!failure_needs_a_look(&quiet), "{quiet:?}");
            }
            for loud in [
                VaultError::Storage,
                VaultError::Corrupt,
                VaultError::Invalid,
            ] {
                assert!(failure_needs_a_look(&loud), "{loud:?}");
            }
        }
    }
}

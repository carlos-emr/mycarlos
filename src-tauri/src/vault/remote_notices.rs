//! Remote "documents ready" notices, vault side (#192, M1). The state lives in the encrypted
//! manifest (format 9). No network call is made while the vault lock is held: each portal
//! request runs on a snapshot, and its answer is applied in a commit of its own after checking
//! that the session is still the one that sent it.

use super::*;
use crate::document_notifications::{Activation, NoticeToken, Owner, Policy};
use crate::document_push::{
    enrollment_body, enrollment_reply, revocation_body, revocation_final, Enrollment, Exchange,
    PushOutcome, PushSource, MAX_REPLY, REVOCATIONS, SUBSCRIPTIONS,
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
}

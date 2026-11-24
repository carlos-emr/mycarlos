//! Notice keys, vault side (#230): the vault is open, so the device key can enrol a link's notice
//! key with its Portal, and a link that is gone or no longer wanted loses its key. The decisions
//! are `tray_notices::sync_keys`; this only reads the links and runs the Portal request without
//! holding the vault lock.

use super::*;
use crate::document_push::Exchange;
use crate::notice_key::{NoticeKeyEntry, NoticeKeys, WrapKeyStore};
use crate::tray_notices::{
    enrollment_body, registration_from, sync_keys, LinkView, NoticeSync, Registration,
    MAX_ENROLL_REPLY, WAITING_KEYS,
};

impl VaultStore {
    /// Brings the notice keys in line with `wanted` (see `sync_keys`). No network call is made
    /// while the vault lock is held: the links are copied first. A session that ended meanwhile
    /// (`session` no longer the portal session) stops it.
    pub(crate) fn sync_notice_keys_with<S: WrapKeyStore>(
        &self,
        keys: &NoticeKeys<S>,
        wanted: bool,
        session: u64,
        exchange: &impl Exchange,
        give_up: &mut dyn FnMut(&NoticeKeyEntry),
    ) -> Result<NoticeSync, VaultError> {
        if self.portal_link_ticket() != session {
            return Err(VaultError::Cancelled);
        }
        let (vault_id, links) = {
            let guard = self.session();
            let open = guard.as_ref().ok_or(VaultError::Locked)?;
            if open.recovery.is_some() {
                return Err(VaultError::RecoveryMode);
            }
            (open.manifest.vault_id, open.manifest.portal_links.clone())
        };
        let cancelled = || self.portal_link_ticket() != session;
        let views: Vec<LinkView> = links
            .iter()
            .map(|link| LinkView {
                id: link.id,
                portal_base: &link.portal_base,
                linked: link.clinic.is_some(),
            })
            .collect();
        sync_keys(
            keys,
            vault_id,
            &views,
            &|id| self.link_gone(id),
            wanted,
            &mut |link_id, made| {
                let Some(link) = links.iter().find(|link| link.id == link_id) else {
                    return Registration::Later;
                };
                match exchange(
                    link,
                    "POST",
                    WAITING_KEYS,
                    enrollment_body(made),
                    None,
                    MAX_ENROLL_REPLY,
                    &cancelled,
                ) {
                    Ok(reply) => registration_from(reply.status),
                    Err(_) => Registration::Later,
                }
            },
            give_up,
        )
        .map_err(|_| VaultError::Storage)
    }

    /// The real thing: this process's notice keys, the Portal over HTTPS, and a key that is
    /// finished told so with the key itself. `None` where the build keeps no notice keys.
    pub(crate) fn sync_notice_keys(&self) -> Option<Result<NoticeSync, VaultError>> {
        // One sync at a time: unlock, a switch, a link and a wipe can each start one, and two
        // that overlap would each make a key for the same link.
        static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _turn = ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let keys = crate::notice_key::kept()?;
        let session = self.portal_link_ticket();
        Some(self.sync_notice_keys_with(
            keys,
            crate::tray_notices::wanted(),
            session,
            &crate::portal_client::api,
            &mut crate::tray_notices::give_up_remote,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notice_key::FakeWrapKeyStore;
    use crate::portal_client::ApiResponse;
    use crate::portal_link::{LinkError, StoredLink};
    use serde_json::Value;
    use std::cell::RefCell;
    use zeroize::Zeroizing;

    const PASSWORD: &str = "river-azimuth-cobalt-sparrow-934";

    /// A FAKE clinic link (the checked-in contract's device and clinic), complete: a clinic's key
    /// is pinned, so it is one a notice key can be made for.
    fn linked() -> StoredLink {
        let packet: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/java-delivery-interop-v1.json"
        ))
        .unwrap();
        let mut shared: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/delivery-contract.json"))
                .unwrap();
        shared["receiver"] = packet["receiver"].clone();
        crate::portal_delivery::tests::fixture_link(&shared)
    }

    /// An unlocked vault holding `links`, and notice keys (a fake OS store) beside it.
    fn setup(
        links: &[StoredLink],
    ) -> (tempfile::TempDir, VaultStore, NoticeKeys<FakeWrapKeyStore>) {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "FAKE Person", 1).unwrap();
        for link in links {
            store
                .mutate_recorded(|m, _| {
                    m.portal_links.push(link.clone());
                    Ok(())
                })
                .unwrap();
        }
        let keys = NoticeKeys::new(temp.path(), FakeWrapKeyStore::default());
        (temp, store, keys)
    }

    fn answer(status: u16) -> Result<ApiResponse, LinkError> {
        Ok(ApiResponse {
            status,
            body: Zeroizing::new(Vec::new()),
            date: None,
            retry_after: None,
        })
    }

    type Call = (uuid::Uuid, String, String, Vec<u8>);

    #[test]
    fn a_session_that_ended_stops_the_sync_before_anything_is_read_or_sent() {
        let (_temp, store, keys) = setup(&[linked()]);
        let calls = RefCell::new(Vec::<Call>::new());
        let exchange = |link: &StoredLink,
                        method: &str,
                        path: &str,
                        body: Vec<u8>,
                        _: Option<&str>,
                        _: usize,
                        _: &dyn Fn() -> bool| {
            calls
                .borrow_mut()
                .push((link.id, method.into(), path.into(), body));
            answer(200)
        };
        let stale = store.portal_link_ticket().wrapping_add(1);
        let result = store.sync_notice_keys_with(&keys, true, stale, &exchange, &mut |_| {});
        assert!(matches!(result, Err(VaultError::Cancelled)));
        assert!(calls.borrow().is_empty());
        assert_eq!(keys.entries(), Ok(vec![]));
    }

    #[test]
    fn a_locked_vault_cannot_sync_and_makes_no_key() {
        let (_temp, store, keys) = setup(&[linked()]);
        store.lock();
        let session = store.portal_link_ticket();
        let result = store.sync_notice_keys_with(
            &keys,
            true,
            session,
            &|_: &StoredLink,
              _: &str,
              _: &str,
              _: Vec<u8>,
              _: Option<&str>,
              _: usize,
              _: &dyn Fn() -> bool| answer(200),
            &mut |_| {},
        );
        assert!(matches!(result, Err(VaultError::Locked)));
        assert_eq!(keys.entries(), Ok(vec![]));
    }

    #[test]
    fn with_notices_wanted_a_complete_link_gets_one_key_sent_to_its_portal_and_kept_for_this_vault()
    {
        let link = linked();
        let (_temp, store, keys) = setup(std::slice::from_ref(&link));
        let calls = RefCell::new(Vec::<Call>::new());
        let exchange = |link: &StoredLink,
                        method: &str,
                        path: &str,
                        body: Vec<u8>,
                        _: Option<&str>,
                        _: usize,
                        _: &dyn Fn() -> bool| {
            calls
                .borrow_mut()
                .push((link.id, method.into(), path.into(), body));
            answer(201)
        };
        let session = store.portal_link_ticket();
        let sync = store
            .sync_notice_keys_with(&keys, true, session, &exchange, &mut |_| {})
            .unwrap();
        assert_eq!((sync.made, sync.waiting, sync.wiped), (1, 0, 0));
        let entries = keys.entries().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].link_id, link.id);
        assert_eq!(Some(entries[0].vault_id), store.open_vault_id());
        // The one request: the link's own, `POST` to the waiting-keys route, naming the new key.
        let calls = calls.borrow();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, link.id);
        assert_eq!(
            (calls[0].1.as_str(), calls[0].2.as_str()),
            ("POST", WAITING_KEYS)
        );
        let body: Value = serde_json::from_slice(&calls[0].3).unwrap();
        assert_eq!(body["key_id"], entries[0].key_id.as_str());
        assert_eq!(body["alg"], "ed25519");
        assert_eq!(body["public_key"].as_str().unwrap().len(), 43);
    }

    #[test]
    fn a_key_already_kept_for_a_link_is_not_made_or_sent_again() {
        let (_temp, store, keys) = setup(&[linked()]);
        let sent = RefCell::new(0);
        let exchange = |_: &StoredLink,
                        _: &str,
                        _: &str,
                        _: Vec<u8>,
                        _: Option<&str>,
                        _: usize,
                        _: &dyn Fn() -> bool| {
            *sent.borrow_mut() += 1;
            answer(200)
        };
        let session = store.portal_link_ticket();
        for round in 0..2 {
            let sync = store
                .sync_notice_keys_with(&keys, true, session, &exchange, &mut |_| {})
                .unwrap();
            assert_eq!(sync.made, usize::from(round == 0), "round {round}");
        }
        assert_eq!(*sent.borrow(), 1);
        assert_eq!(keys.entries().unwrap().len(), 1);
    }

    #[test]
    fn a_portal_that_refuses_or_cannot_be_reached_leaves_no_key_and_is_counted_as_waiting() {
        for outcome in [
            answer(404),
            answer(409),
            answer(500),
            Err(LinkError::Network),
        ] {
            let (_temp, store, keys) = setup(&[linked()]);
            let once = RefCell::new(Some(outcome));
            let exchange = |_: &StoredLink,
                            _: &str,
                            _: &str,
                            _: Vec<u8>,
                            _: Option<&str>,
                            _: usize,
                            _: &dyn Fn() -> bool| {
                once.borrow_mut().take().expect("asked once")
            };
            let session = store.portal_link_ticket();
            let sync = store
                .sync_notice_keys_with(&keys, true, session, &exchange, &mut |_| {})
                .unwrap();
            assert_eq!((sync.made, sync.waiting), (0, 1));
            // The secret never outlives a registration that did not happen.
            assert_eq!(keys.entries(), Ok(vec![]));
        }
    }

    #[test]
    fn a_link_that_is_not_complete_gets_no_key_and_no_request() {
        let mut incomplete = linked();
        incomplete.clinic = None;
        let (_temp, store, keys) = setup(&[incomplete]);
        let sent = RefCell::new(0);
        let exchange = |_: &StoredLink,
                        _: &str,
                        _: &str,
                        _: Vec<u8>,
                        _: Option<&str>,
                        _: usize,
                        _: &dyn Fn() -> bool| {
            *sent.borrow_mut() += 1;
            answer(200)
        };
        let session = store.portal_link_ticket();
        let sync = store
            .sync_notice_keys_with(&keys, true, session, &exchange, &mut |_| {})
            .unwrap();
        assert_eq!((sync.made, sync.waiting, sync.wiped), (0, 0, 0));
        assert_eq!(*sent.borrow(), 0);
        assert_eq!(keys.entries(), Ok(vec![]));
    }

    #[test]
    fn turning_notices_off_gives_up_and_wipes_this_vaults_keys_and_not_another_vaults() {
        let link = linked();
        let (_temp, store, keys) = setup(std::slice::from_ref(&link));
        let exchange = |_: &StoredLink,
                        _: &str,
                        _: &str,
                        _: Vec<u8>,
                        _: Option<&str>,
                        _: usize,
                        _: &dyn Fn() -> bool| answer(200);
        let session = store.portal_link_ticket();
        store
            .sync_notice_keys_with(&keys, true, session, &exchange, &mut |_| {})
            .unwrap();
        // Another vault of the device has a key of its own.
        let other_vault = uuid::Uuid::from_u128(0xFAC0_0000_0000_4000_8000_0000_0000_0002);
        let other_link = uuid::Uuid::from_u128(0xFAC0_0000_0000_4000_8000_0000_0000_0020);
        keys.make_for(other_vault, other_link, "https://other.example.test")
            .unwrap();
        assert_eq!(keys.entries().unwrap().len(), 2);
        let mut given_up = Vec::new();
        let sync = store
            .sync_notice_keys_with(&keys, false, session, &exchange, &mut |entry| {
                given_up.push(entry.link_id)
            })
            .unwrap();
        assert_eq!((sync.made, sync.wiped), (0, 1));
        // Told to the Portal as finished (the hook), then wiped: only this vault's.
        assert_eq!(given_up, vec![link.id]);
        let left = keys.entries().unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(
            (left[0].vault_id, left[0].link_id),
            (other_vault, other_link)
        );
    }

    #[test]
    fn a_link_that_is_gone_loses_its_key_and_is_not_given_a_new_one() {
        let link = linked();
        let (_temp, store, keys) = setup(std::slice::from_ref(&link));
        let exchange = |_: &StoredLink,
                        _: &str,
                        _: &str,
                        _: Vec<u8>,
                        _: Option<&str>,
                        _: usize,
                        _: &dyn Fn() -> bool| answer(200);
        let session = store.portal_link_ticket();
        store
            .sync_notice_keys_with(&keys, true, session, &exchange, &mut |_| {})
            .unwrap();
        assert_eq!(keys.entries().unwrap().len(), 1);
        // The Portal said this device was removed: the link is marked gone for this run.
        store.mark_link_gone(link.id);
        let mut given_up = 0;
        let sync = store
            .sync_notice_keys_with(&keys, true, session, &exchange, &mut |_| given_up += 1)
            .unwrap();
        assert_eq!((sync.made, sync.wiped), (0, 1));
        assert_eq!(given_up, 1);
        assert_eq!(keys.entries(), Ok(vec![]));
    }

    #[test]
    fn the_exchange_is_told_to_stop_when_the_session_ends() {
        // `cancelled` the sync hands the exchange turns true once the portal session moves on (a
        // lock, an unlock): checked here before and after a lock.
        let (_temp, store, keys) = setup(&[linked()]);
        let seen = RefCell::new(Vec::new());
        let exchange = |_: &StoredLink,
                        _: &str,
                        _: &str,
                        _: Vec<u8>,
                        _: Option<&str>,
                        _: usize,
                        cancelled: &dyn Fn() -> bool| {
            seen.borrow_mut().push(cancelled());
            store.lock();
            seen.borrow_mut().push(cancelled());
            Err(LinkError::Cancelled)
        };
        let session = store.portal_link_ticket();
        let sync = store
            .sync_notice_keys_with(&keys, true, session, &exchange, &mut |_| {})
            .unwrap();
        assert_eq!(*seen.borrow(), vec![false, true]);
        // A request that was cancelled leaves no key behind.
        assert_eq!((sync.made, sync.waiting), (0, 1));
        assert_eq!(keys.entries(), Ok(vec![]));
    }
}

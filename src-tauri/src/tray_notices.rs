//! Notices while locked in the tray (#230, "Tray mode, choice B").
//!
//! With myCarlos in the tray the vault is locked, so the device key is unreachable. A separate
//! **notice key** per linked Portal (`notice_key.rs`, kept outside the vault) lets the locked app
//! ask that Portal one question, "is anything waiting for this device?", and nothing else (the
//! Portal calls it a *waiting key*, carlos-portal#87).
//!
//! This module has the part that needs the vault open: **enrolling** each link's key with the
//! Portal (signed by the device key, `POST waiting-keys`) and **wiping** keys that should not
//! exist: notices or tray mode turned off, a link gone, another vault. The decisions are the
//! plain function `sync_keys` over small traits, so they are tested with a fake keyring and a
//! fake Portal. Nothing here reads page text, a document or a person's name.
//!
//! Supervisor default while Ben is away (#230): a key is made when tray notices are **wanted**
//! (tray mode on and notices on) and the vault is unlocked: at link time, at unlock, and when a
//! switch turns on. It is not made while a switch is off, so a vault that never turns tray
//! notices on keeps no key outside the vault at all.
#![cfg_attr(not(test), allow(dead_code))]

use crate::notice_key::{NewNoticeKey, NoticeKeyEntry, NoticeKeyError, NoticeKeys, WrapKeyStore};
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;

/// The device-signed enrollment route: `POST {key_id, public_key, alg}`.
pub(crate) const WAITING_KEYS: &str = "/api/mycarlos/availability/waiting-keys";
/// The waiting-key-signed route: `POST` asks, `DELETE` gives the key up.
pub(crate) const WAITING: &str = "/api/mycarlos/availability/waiting";
/// An enrollment reply is a few hundred bytes.
pub(crate) const MAX_ENROLL_REPLY: usize = 4096;

static KEEP_RUNNING: AtomicBool = AtomicBool::new(false);
static NOTICES: AtomicBool = AtomicBool::new(false);

/// The tray switch (keep myCarlos running in the background): set at startup from what it saved
/// and whenever it changes.
pub(crate) fn set_keep_running(on: bool) {
    KEEP_RUNNING.store(on, Ordering::SeqCst);
}

/// The notices switch: set from the vault when it is unlocked (that is where it is kept) and
/// whenever it changes. While locked it keeps its last value.
pub(crate) fn set_notices(on: bool) {
    NOTICES.store(on, Ordering::SeqCst);
}

/// Whether tray notices are wanted now: tray mode on **and** notices on.
pub(crate) fn wanted() -> bool {
    KEEP_RUNNING.load(Ordering::SeqCst) && NOTICES.load(Ordering::SeqCst)
}

/// Tells a Portal that a key is finished, with the key itself (it works without the vault).
/// Best effort: a failure is not retried, because the secret is wiped either way.
pub(crate) fn give_up_remote(entry: &NoticeKeyEntry) {
    #[cfg(not(target_os = "android"))]
    {
        let _ = crate::portal_client::waiting_api(entry, "DELETE", &|| false);
    }
    #[cfg(target_os = "android")]
    {
        let _ = entry;
    }
}

/// What the Portal said to an enrollment.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum Registration {
    /// 200 or 201: the Portal holds the public key.
    Registered,
    /// A refusal that will not change (400, 409 and the like): do not keep the key.
    Refused,
    /// Unreachable or a transient answer: try again later (the key is not kept meanwhile).
    Later,
}

/// What one sync did, for tests and the status line.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct NoticeSync {
    pub(crate) made: usize,
    pub(crate) wiped: usize,
    pub(crate) waiting: usize,
}

/// A link, as the sync needs to see it.
pub(crate) struct LinkView<'a> {
    pub(crate) id: Uuid,
    pub(crate) portal_base: &'a str,
    /// Its clinic is known (a completed link, not an attempt).
    pub(crate) linked: bool,
}

/// Brings the kept keys in line with what is wanted, for `vault_id`'s `links`.
///
/// - Not wanted: every key goes.
/// - Wanted: a key of another vault, of a link that is gone from the vault or from the Portal
///   (`gone`), or of a link no longer linked goes; each completed link without a key gets one
///   (`make_for`), which `register` enrols with the Portal; a key the Portal refuses, or could
///   not be asked about, is **not kept**: a key outside the vault that the Portal does not know
///   is only a secret at rest.
/// - Each key about to go is first offered to `give_up`, which may tell the Portal the key is
///   finished (the waiting key can give itself up without the vault). Whether that works or not,
///   the key is wiped: the secret never outlives the wipe.
pub(crate) fn sync_keys<S: WrapKeyStore>(
    keys: &NoticeKeys<S>,
    vault_id: Uuid,
    links: &[LinkView],
    gone: &dyn Fn(Uuid) -> bool,
    wanted: bool,
    register: &mut dyn FnMut(Uuid, &NewNoticeKey) -> Registration,
    give_up: &mut dyn FnMut(&NoticeKeyEntry),
) -> Result<NoticeSync, NoticeKeyError> {
    let mut sync = NoticeSync::default();
    let linked = |id: Uuid| links.iter().any(|link| link.id == id && link.linked) && !gone(id);
    let kept = keys.entries()?;
    for entry in kept
        .iter()
        .filter(|entry| !wanted || entry.vault_id != vault_id || !linked(entry.link_id))
    {
        give_up(entry);
    }
    let wiped =
        keys.wipe(|entry| !wanted || entry.vault_id != vault_id || !linked(entry.link_id))?;
    sync.wiped = wiped.key_ids.len();
    if !wanted {
        return Ok(sync);
    }
    let have: Vec<Uuid> = keys.entries()?.iter().map(|entry| entry.link_id).collect();
    for link in links
        .iter()
        .filter(|link| link.linked && !gone(link.id) && !have.contains(&link.id))
    {
        let made = keys.make_for(vault_id, link.id, link.portal_base)?;
        match register(link.id, &made) {
            Registration::Registered => sync.made += 1,
            Registration::Refused | Registration::Later => {
                keys.wipe_link(link.id)?;
                sync.waiting += 1;
            }
        }
    }
    Ok(sync)
}

/// The enrollment body the Portal takes: exactly `key_id`, `public_key` (43 unpadded base64url
/// characters) and `alg`.
pub(crate) fn enrollment_body(key: &NewNoticeKey) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "key_id": key.key_id,
        "public_key": key.public_key_b64url(),
        "alg": "ed25519",
    }))
    .unwrap_or_default()
}

/// How an enrollment answer reads.
pub(crate) fn registration_from(status: u16) -> Registration {
    match status {
        200 | 201 => Registration::Registered,
        400 | 404 | 409 | 422 => Registration::Refused,
        _ => Registration::Later,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notice_key::FakeWrapKeyStore;

    const ORIGIN: &str = "https://portal.example.invalid";

    fn keys() -> (tempfile::TempDir, NoticeKeys<FakeWrapKeyStore>) {
        let temp = tempfile::tempdir().unwrap();
        let keys = NoticeKeys::new(temp.path(), FakeWrapKeyStore::default());
        (temp, keys)
    }

    fn uuid(n: u128) -> Uuid {
        Uuid::from_u128(0xFAC0_0000_0000_4000_8000_0000_0000_0000 + n)
    }

    fn link(n: u128, linked: bool) -> LinkView<'static> {
        LinkView {
            id: uuid(n),
            portal_base: ORIGIN,
            linked,
        }
    }

    /// One sync with a recording Portal. `answer` is what enrollment gets.
    struct Run {
        sync: Result<NoticeSync, NoticeKeyError>,
        registered: Vec<Uuid>,
        given_up: Vec<String>,
    }

    fn run(
        keys: &NoticeKeys<FakeWrapKeyStore>,
        links: &[LinkView],
        gone: &[Uuid],
        wanted: bool,
        answer: Registration,
    ) -> Run {
        let mut registered = Vec::new();
        let mut given_up = Vec::new();
        let sync = sync_keys(
            keys,
            uuid(1),
            links,
            &|id| gone.contains(&id),
            wanted,
            &mut |link, _| {
                registered.push(link);
                answer
            },
            &mut |entry| given_up.push(entry.key_id.clone()),
        );
        Run {
            sync,
            registered,
            given_up,
        }
    }

    #[test]
    fn wanted_gives_each_completed_link_one_registered_key() {
        let (_temp, keys) = keys();
        let links = [link(10, true), link(11, true), link(12, false)];
        let done = run(&keys, &links, &[], true, Registration::Registered);
        assert_eq!(
            done.sync.unwrap(),
            NoticeSync {
                made: 2,
                wiped: 0,
                waiting: 0
            }
        );
        // The attempt that is not a completed link gets nothing.
        assert_eq!(done.registered, vec![uuid(10), uuid(11)]);
        let kept = keys.entries().unwrap();
        assert_eq!(kept.len(), 2);
        assert!(kept.iter().all(|entry| entry.vault_id == uuid(1)));
        // Run again with nothing changed: nothing is made or enrolled twice.
        let again = run(&keys, &links, &[], true, Registration::Registered);
        assert_eq!(again.sync.unwrap(), NoticeSync::default());
        assert!(again.registered.is_empty() && again.given_up.is_empty());
    }

    #[test]
    fn not_wanted_wipes_every_key_and_offers_each_to_give_up_first() {
        let (_temp, keys) = keys();
        let links = [link(10, true), link(11, true)];
        run(&keys, &links, &[], true, Registration::Registered)
            .sync
            .unwrap();
        let ids: Vec<String> = keys
            .entries()
            .unwrap()
            .iter()
            .map(|e| e.key_id.clone())
            .collect();
        let off = run(&keys, &links, &[], false, Registration::Registered);
        assert_eq!(off.sync.unwrap().wiped, 2);
        assert!(off.registered.is_empty(), "nothing is made while off");
        let mut offered = off.given_up.clone();
        offered.sort();
        let mut wanted_ids = ids;
        wanted_ids.sort();
        assert_eq!(offered, wanted_ids);
        assert!(keys.entries().unwrap().is_empty());
    }

    #[test]
    fn a_key_the_portal_refuses_or_cannot_be_asked_about_is_not_kept() {
        for answer in [Registration::Refused, Registration::Later] {
            let (_temp, keys) = keys();
            let done = run(&keys, &[link(10, true)], &[], true, answer);
            assert_eq!(
                done.sync.unwrap(),
                NoticeSync {
                    made: 0,
                    wiped: 0,
                    waiting: 1
                }
            );
            assert!(
                keys.entries().unwrap().is_empty(),
                "an unregistered key is only a secret at rest"
            );
        }
    }

    #[test]
    fn a_link_that_is_gone_or_no_longer_linked_loses_its_key_and_the_others_stay() {
        let (_temp, keys) = keys();
        let links = [link(10, true), link(11, true)];
        run(&keys, &links, &[], true, Registration::Registered)
            .sync
            .unwrap();
        let gone_key = keys
            .entries()
            .unwrap()
            .into_iter()
            .find(|entry| entry.link_id == uuid(10))
            .unwrap()
            .key_id;
        // The Portal says the device is gone.
        let after = run(&keys, &links, &[uuid(10)], true, Registration::Registered);
        assert_eq!(after.sync.unwrap().wiped, 1);
        assert_eq!(after.given_up, vec![gone_key]);
        let left = keys.entries().unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].link_id, uuid(11));
        // A link removed from the vault entirely.
        let removed = run(&keys, &[], &[], true, Registration::Registered);
        assert_eq!(removed.sync.unwrap().wiped, 1);
        assert!(keys.entries().unwrap().is_empty());
    }

    #[test]
    fn another_vaults_key_is_wiped_and_not_replaced_by_this_ones_registration_of_its_own() {
        let (_temp, keys) = keys();
        keys.make_for(uuid(99), uuid(10), ORIGIN).unwrap();
        let done = run(
            &keys,
            &[link(10, true)],
            &[],
            true,
            Registration::Registered,
        );
        let sync = done.sync.unwrap();
        // The other vault's key went; this vault got its own for the same link id.
        assert_eq!((sync.wiped, sync.made), (1, 1));
        let kept = keys.entries().unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].vault_id, uuid(1));
    }

    #[test]
    fn without_a_keyring_nothing_is_made_or_enrolled() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = FakeWrapKeyStore::default();
        store.absent = true;
        let keys = NoticeKeys::new(temp.path(), store);
        let done = run(
            &keys,
            &[link(10, true)],
            &[],
            true,
            Registration::Registered,
        );
        assert_eq!(done.sync, Err(NoticeKeyError::NoKeyring));
        assert!(done.registered.is_empty());
    }

    #[test]
    fn the_enrollment_body_is_exactly_the_three_fields_the_portal_reads() {
        let (_temp, keys) = keys();
        let made = keys.make_for(uuid(1), uuid(10), ORIGIN).unwrap();
        let body: serde_json::Value = serde_json::from_slice(&enrollment_body(&made)).unwrap();
        let object = body.as_object().unwrap();
        assert_eq!(object.len(), 3);
        assert_eq!(object["key_id"], made.key_id);
        assert_eq!(object["public_key"], made.public_key_b64url());
        assert_eq!(object["alg"], "ed25519");
        assert_eq!(registration_from(201), Registration::Registered);
        assert_eq!(registration_from(200), Registration::Registered);
        assert_eq!(registration_from(409), Registration::Refused);
        assert_eq!(registration_from(503), Registration::Later);
    }
}

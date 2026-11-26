//! The "New" marker on a vault (`new_marker.rs`): which documents are new, what clears them, and
//! what a lock, a restore and a missing file do. FAKE data only. The vault's own manifest is
//! never written by it: only the small sealed file beside `vault-home`.
use super::*;
use crate::new_marker::{self, Context, SeenState};

const PASSWORD: &str = "meadow-planet-copper-window-743";

/// A vault with one document a linked clinic delivered, filed at `at` milliseconds, and the seen
/// state starting at `seen_up_to`.
fn vault(at: u64, seen_up_to: u64) -> (tempfile::TempDir, VaultStore, Uuid) {
    let (temp, store, _link, id) = delivery::pair_original_fixture_for_test();
    // The fixture's delivery waits in Shared with me: file it under the person, as a delivery
    // for them is.
    store
        .mutate_recorded(|manifest, _| {
            let shared = shared_profile_id(manifest.vault_id);
            let person = manifest
                .profiles
                .iter()
                .find(|profile| profile.id != shared)
                .unwrap()
                .id;
            manifest
                .records
                .iter_mut()
                .find(|record| record.id == id)
                .unwrap()
                .profile_id = person;
            Ok(())
        })
        .unwrap();
    set_filed(&store, id, at);
    set_state(&store, SeenState::starting_at(seen_up_to));
    (temp, store, id)
}

fn set_filed(store: &VaultStore, id: Uuid, at: u64) {
    store
        .mutate_recorded(|manifest, _| {
            manifest
                .records
                .iter_mut()
                .find(|record| record.id == id)
                .unwrap()
                .imported_at_ms = at;
            Ok(())
        })
        .unwrap();
}

fn set_state(store: &VaultStore, state: SeenState) {
    let guard = store.session();
    let unlocked = guard.as_ref().unwrap();
    unlocked
        .new_marker
        .update(&store.new_marker_context(unlocked), 1, |current| {
            *current = state;
            true
        })
        .unwrap();
}

fn is_new(store: &VaultStore, id: Uuid) -> bool {
    store
        .snapshot()
        .unwrap()
        .records
        .iter()
        .find(|record| record.id == id)
        .unwrap()
        .is_new
}

fn seen_file(store: &VaultStore) -> std::path::PathBuf {
    let vault_id = store.session().as_ref().unwrap().manifest.vault_id;
    new_marker::path_beside(vault_home(&store.root).unwrap(), vault_id).unwrap()
}

#[test]
fn a_clinic_document_filed_after_seen_up_to_is_new_and_one_filed_before_is_not() {
    let (_temp, store, id) = vault(5_000, 1_000);
    assert!(is_new(&store, id));
    set_filed(&store, id, 1_000);
    assert!(!is_new(&store, id));
    set_filed(&store, id, 999);
    assert!(!is_new(&store, id));
}

#[test]
fn opening_a_document_clears_that_one_and_only_that_one_and_nothing_else_does() {
    let (_temp, store, id) = vault(5_000, 1_000);
    // Looking at the list, unlocking again and time passing do not clear it.
    for _ in 0..3 {
        assert!(is_new(&store, id));
    }
    store.lock();
    store.unlock(PASSWORD).unwrap();
    assert!(is_new(&store, id));
    // An id that is not a new clinic document is ignored and changes nothing.
    store.mark_seen(&[Uuid::new_v4()]).unwrap();
    assert!(is_new(&store, id));
    store.mark_seen(&[id]).unwrap();
    assert!(!is_new(&store, id));
    // It stays seen after a lock and an unlock: the state is in the file.
    store.lock();
    store.unlock(PASSWORD).unwrap();
    assert!(!is_new(&store, id));
}

#[test]
fn mark_all_as_seen_clears_everything_filed_so_far_and_a_later_arrival_is_new() {
    let (_temp, store, id) = vault(5_000, 1_000);
    store.mark_all_seen().unwrap();
    assert!(!is_new(&store, id));
    // The same vault later receives another document: filed after what was marked.
    set_filed(&store, id, 9_000);
    assert!(is_new(&store, id));
    store.mark_all_seen().unwrap();
    assert!(!is_new(&store, id));
}

#[test]
fn a_document_the_patient_added_themselves_is_never_new() {
    let (_temp, store, id) = vault(5_000, 1_000);
    store
        .mutate_recorded(|manifest, _| {
            manifest
                .records
                .iter_mut()
                .find(|record| record.id == id)
                .unwrap()
                .delivery = None;
            Ok(())
        })
        .unwrap();
    assert!(!is_new(&store, id));
    // Nor does it enter the opened list.
    store.mark_seen(&[id]).unwrap();
    let guard = store.session();
    let unlocked = guard.as_ref().unwrap();
    let state = unlocked
        .new_marker
        .state(&store.new_marker_context(unlocked), 1);
    assert!(state.opened().is_empty());
}

#[test]
fn a_hidden_document_is_not_new_and_is_new_again_only_when_it_is_shown() {
    let (_temp, store, id) = vault(5_000, 1_000);
    store.hide_record(id, 6_000).unwrap();
    assert!(!is_new(&store, id));
    store.unhide_record(id).unwrap();
    assert!(is_new(&store, id));
}

#[test]
fn only_a_delivered_visible_document_outside_shared_with_me_that_was_not_carried_can_be_new() {
    // Every combination of the four things the rule looks at: only one of them is a candidate.
    for bits in 0..16_u8 {
        let (delivered, carried, hidden, in_shared) =
            (bits & 1 != 0, bits & 2 != 0, bits & 4 != 0, bits & 8 != 0);
        assert_eq!(
            new_marker_rule(delivered, carried, hidden, in_shared),
            bits == 1,
            "{bits:04b}"
        );
    }
    // And on a real record: waiting in Shared with me is out, a person who is hidden has none.
    let (_temp, store, id) = vault(5_000, 1_000);
    let guard = store.session();
    let unlocked = guard.as_ref().unwrap();
    let record = unlocked
        .manifest
        .records
        .iter()
        .find(|record| record.id == id)
        .unwrap();
    assert!(is_new_candidate(
        record,
        shared_profile_id(unlocked.manifest.vault_id)
    ));
    assert!(!is_new_candidate(record, record.profile_id));
    assert!(new_marker_candidates(unlocked).contains_key(&id));
}

#[test]
fn a_missing_file_means_nothing_is_new_and_the_file_is_written_at_once() {
    let (_temp, store, id) = vault(5_000, 1_000);
    assert!(is_new(&store, id));
    let path = seen_file(&store);
    assert!(path.exists());
    assert_eq!(
        std::fs::metadata(&path).unwrap().len(),
        new_marker::FILE_BYTES as u64
    );
    // A restored backup, a vault moved to another folder or a deleted file starts at "now": the
    // documents already there are not new.
    store.lock();
    std::fs::rename(&path, path.with_extension("moved")).unwrap();
    store.unlock(PASSWORD).unwrap();
    assert!(!is_new(&store, id));
    assert!(path.exists());
    // A file that does not belong (damaged, changed) is the same: never "everything is new".
    store.lock();
    std::fs::write(&path, b"not ours").unwrap();
    store.unlock(PASSWORD).unwrap();
    assert!(!is_new(&store, id));
    assert_eq!(
        std::fs::metadata(&path).unwrap().len(),
        new_marker::FILE_BYTES as u64
    );
}

#[test]
fn the_file_sits_beside_vault_home_and_the_vault_itself_is_not_touched() {
    let (_temp, store, id) = vault(5_000, 1_000);
    let path = seen_file(&store);
    let home = vault_home(&store.root).unwrap().to_path_buf();
    assert_eq!(path.parent(), home.parent());
    assert!(!path.starts_with(&home));
    let before = std::fs::read(store.root.join("manifest")).ok();
    store.mark_seen(&[id]).unwrap();
    store.mark_all_seen().unwrap();
    assert_eq!(std::fs::read(store.root.join("manifest")).ok(), before);
}

#[test]
fn asking_to_mark_needs_an_unlocked_vault_and_a_sane_number_of_ids() {
    let (_temp, store, id) = vault(5_000, 1_000);
    let too_many = vec![id; new_marker::MAX_OPENED + 1];
    assert!(matches!(
        store.mark_seen(&too_many),
        Err(VaultError::Invalid)
    ));
    assert!(is_new(&store, id));
    store.lock();
    assert!(matches!(store.mark_seen(&[id]), Err(VaultError::Locked)));
    assert!(matches!(store.mark_all_seen(), Err(VaultError::Locked)));
}

#[test]
fn the_state_is_per_vault_not_shared_by_two_vaults_on_one_device() {
    let (_a, one, id) = vault(5_000, 1_000);
    let (_b, two, other) = vault(5_000, 1_000);
    one.mark_all_seen().unwrap();
    assert!(!is_new(&one, id));
    assert!(is_new(&two, other));
    let context = |store: &VaultStore| {
        let guard = store.session();
        let unlocked = guard.as_ref().unwrap();
        let context: Context<'_> = store.new_marker_context(unlocked);
        (
            context.vault_id,
            new_marker::path_beside(context.vault_home.unwrap(), context.vault_id).unwrap(),
        )
    };
    assert_ne!(context(&one), context(&two));
}

#[test]
fn setting_the_vault_aside_removes_its_own_seen_file_and_no_other() {
    for locked in [false, true] {
        let (_temp, store, id) = vault(5_000, 1_000);
        assert!(is_new(&store, id));
        let path = seen_file(&store);
        assert!(path.exists());
        // Another vault's file, beside the same folder: it is not this vault's to remove.
        let other = path.with_file_name(new_marker::file_name(Uuid::new_v4()));
        std::fs::write(&other, b"another vault's").unwrap();
        if locked {
            store.lock();
        }
        store.reset().unwrap();
        assert!(!path.exists(), "locked: {locked}");
        assert!(other.exists(), "locked: {locked}");
    }
}

/// The slot of the open session (the tests' way in).
fn with_slot<R>(store: &VaultStore, then: impl FnOnce(&crate::new_marker::Slot) -> R) -> R {
    let guard = store.session();
    then(&guard.as_ref().unwrap().new_marker)
}

#[test]
fn a_file_that_cannot_be_read_for_now_is_never_written_over_not_at_unlock_and_not_at_a_later_mark()
{
    let (_temp, store, id) = vault(5_000, 1_000);
    store.mark_seen(&[id]).unwrap();
    let path = seen_file(&store);
    let sealed = std::fs::read(&path).unwrap();
    // The next read of the file fails as an input or output error does (a permission would not
    // stop root): the session is read again, as an unlock reads it.
    with_slot(&store, |slot| {
        slot.make_unreadable_for_test(true);
        slot.forget_for_test();
    });
    // At unlock: the session starts at "now" in memory, and the file is as it was.
    assert!(!is_new(&store, id));
    assert_eq!(std::fs::read(&path).unwrap(), sealed);
    // A later mark works in memory too and does not replace the file with the "now" state.
    store.mark_seen(&[id]).unwrap();
    store.mark_all_seen().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), sealed);
    // When the file can be read again, its own history is what is read (not the "now" state).
    with_slot(&store, |slot| {
        slot.make_unreadable_for_test(false);
        slot.forget_for_test();
    });
    assert!(!is_new(&store, id));
    let state = {
        let guard = store.session();
        let unlocked = guard.as_ref().unwrap();
        unlocked
            .new_marker
            .state(&store.new_marker_context(unlocked), 1)
    };
    assert_eq!(state.opened(), [id]);
}

#[test]
fn a_file_that_is_missing_or_damaged_is_written_again_at_the_next_read() {
    let (_temp, store, _id) = vault(5_000, 1_000);
    let path = seen_file(&store);
    std::fs::write(&path, b"not ours").unwrap();
    with_slot(&store, |slot| slot.forget_for_test());
    store.snapshot().unwrap();
    assert_eq!(
        std::fs::metadata(&path).unwrap().len(),
        new_marker::FILE_BYTES as u64
    );
}

#[test]
fn setting_a_locked_vault_aside_removes_the_file_of_every_header_candidate() {
    let (_temp, store, _id) = vault(5_000, 1_000);
    let path = seen_file(&store);
    let ids: Vec<Uuid> = {
        // The header's own id, as a locked vault reads it, and the file is there.
        read_header_files(&store.root)
            .candidates
            .iter()
            .map(|header| header.vault_id)
            .collect()
    };
    assert!(!ids.is_empty());
    assert!(path.exists());
    store.lock();
    // A second candidate's file (another id) beside it is not named by any header: it stays.
    let stranger = path.with_file_name(new_marker::file_name(Uuid::new_v4()));
    std::fs::write(&stranger, b"someone else's").unwrap();
    store.reset().unwrap();
    for id in ids {
        let own = path.with_file_name(new_marker::file_name(id));
        assert!(!own.exists(), "{id}");
    }
    assert!(stranger.exists());
}

#[test]
fn a_clock_that_ran_ahead_does_not_hide_a_document_filed_after_mark_all() {
    let now = new_marker::now_ms();
    // The delivery was stamped a day ahead of the clock.
    let (_temp, store, id) = vault(now + 86_400_000, 1_000);
    assert!(is_new(&store, id));
    store.mark_all_seen().unwrap();
    // The one that was marked stays seen.
    assert!(!is_new(&store, id));
    // "Seen up to" is not past now: a document stamped an hour from now would be new.
    let guard = store.session();
    let unlocked = guard.as_ref().unwrap();
    let state = unlocked
        .new_marker
        .state(&store.new_marker_context(unlocked), now);
    assert!(state.seen_up_to_ms() <= new_marker::now_ms());
    assert!(state.is_new(Uuid::new_v4(), now + 3_600_000));
}

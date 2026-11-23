//! Hiding a whole person and bringing them back (#360 PR 7). FAKE data only.
//!
//! What is pinned: one flag and one history entry each way; a hidden person's documents,
//! folders and AI answers out of every list and out of every lookup by id; each document's own
//! `hidden` untouched, so a restore returns exactly what was visible; the last visible person
//! and Shared with me never hidden; export still allowed; the flag in a backup; and a process
//! killed at each write boundary leaving the person fully visible or fully hidden.
use super::*;
use crate::vault::profile_export::ExportOptions;
use crate::vault::profile_package::{generate_package_key, PackageSecret};
use std::io::Cursor;

const PASSWORD: &str = "correct horse battery staple 9173";

fn source(name: &str, data: &[u8]) -> ImportSource {
    ImportSource {
        display_name: name.to_owned(),
        reader: Box::new(Cursor::new(data.to_vec())),
    }
}

struct Vault {
    _temp: tempfile::TempDir,
    store: VaultStore,
    parent: Uuid,
    child: Uuid,
    folder: Uuid,
    /// The child's documents: one plain, one the patient hid on its own, one with an AI answer.
    plain: Uuid,
    own_hidden: Uuid,
    answered: Uuid,
}

/// FAKE Parent (one document) and FAKE Child (a folder, three documents).
fn vault() -> Vault {
    let temp = tempfile::tempdir().unwrap();
    let store = VaultStore::new(temp.path().join("vault"));
    store.create(PASSWORD, "FAKE Parent", 1).unwrap();
    let parent = store.snapshot().unwrap().profiles[0].id;
    let child = store.create_profile("FAKE Child", 2).unwrap();
    let folder = store.create_folder(child, None, "FAKE Letters", 3).unwrap();
    store
        .import(
            parent,
            vec![],
            vec![source("FAKE Parent Letter.pdf", b"FAKE-PARENT-BYTES")],
            4,
        )
        .unwrap();
    let mut ids = Vec::new();
    for name in ["FAKE Child A.pdf", "FAKE Child B.pdf", "FAKE Child C.pdf"] {
        let outcome = store
            .import(
                child,
                vec![folder],
                vec![source(name, format!("FAKE-{name}").as_bytes())],
                5,
            )
            .unwrap();
        ids.push(outcome.imported[0]);
    }
    store.hide_record(ids[1], 6).unwrap();
    store
        .save_ai_result(
            ids[2],
            crate::vault::ai_results::AiResultInput {
                tool: crate::vault::ai_results::AiTool::Summary,
                lang: "en".into(),
                term: None,
                model_name: "FAKE model".into(),
                model_sha256: "00".repeat(32),
            },
            b"{\"v\":1}",
            7,
        )
        .unwrap();
    Vault {
        _temp: temp,
        store,
        parent,
        child,
        folder,
        plain: ids[0],
        own_hidden: ids[1],
        answered: ids[2],
    }
}

fn generation(store: &VaultStore) -> u64 {
    store.session().as_ref().unwrap().manifest.generation
}

fn events(store: &VaultStore, event: HistoryEvent) -> Vec<HistoryEntry> {
    store
        .history_entries()
        .unwrap()
        .into_iter()
        .filter(|entry| entry.event == event)
        .collect()
}

#[test]
fn hiding_a_person_takes_them_and_all_their_documents_out_of_every_list_and_restoring_brings_exactly_those_back(
) {
    let v = vault();
    let before = v.store.snapshot().unwrap();
    assert_eq!(before.records.len(), 4);
    assert!(before.hidden_profiles.is_empty());

    v.store.hide_profile(v.child, 100).unwrap();
    let hidden = v.store.snapshot().unwrap();
    // The library, its people, folders and documents: the child is in none of them.
    assert_eq!(hidden.profiles.len(), 1);
    assert_eq!(hidden.profiles[0].id, v.parent);
    assert!(hidden.folders.iter().all(|f| f.profile_id != v.child));
    assert!(hidden.records.iter().all(|r| r.profile_id == v.parent));
    assert_eq!(hidden.records.len(), 1);
    // Only Security's Hidden people list knows them: a name, when, and how many documents
    // (all three, the one hidden on its own included).
    assert_eq!(
        hidden.hidden_profiles,
        vec![HiddenProfile {
            id: v.child,
            display_name: "FAKE Child".into(),
            hidden_at_ms: 100,
            documents: 3,
        }]
    );
    // Nothing was deleted or re-encrypted: the objects, the manifest's records and every
    // document's own hidden state are as they were.
    let manifest = v.store.session().as_ref().unwrap().manifest.clone();
    assert_eq!(manifest.records.len(), 4);
    assert!(manifest
        .records
        .iter()
        .find(|r| r.id == v.own_hidden)
        .unwrap()
        .hidden
        .is_some());
    assert!(manifest
        .records
        .iter()
        .find(|r| r.id == v.plain)
        .unwrap()
        .hidden
        .is_none());
    assert!(v.store.verify_for_backup().is_ok());

    let arrived = v.store.restore_profile(v.child).unwrap();
    assert!(arrived.is_empty());
    let restored = v.store.snapshot().unwrap();
    assert!(restored.hidden_profiles.is_empty());
    assert_eq!(restored.profiles.len(), 2);
    assert_eq!(restored.records.len(), 4);
    assert_eq!(restored.folders.len(), before.folders.len());
    // The document hidden on its own stays hidden; the others are visible again.
    let state = |id: Uuid| {
        restored
            .records
            .iter()
            .find(|r| r.id == id)
            .unwrap()
            .hidden
            .is_some()
    };
    assert!(state(v.own_hidden));
    assert!(!state(v.plain));
    assert!(!state(v.answered));
}

#[test]
fn hiding_and_restoring_are_one_commit_and_one_history_entry_each_with_the_name_and_no_documents() {
    let v = vault();
    // What one ordinary commit adds to the generation (it is written to two slots).
    let start = generation(&v.store);
    v.store.rename_record(v.plain, "FAKE Renamed.pdf").unwrap();
    let one_commit = generation(&v.store) - start;
    let generation_before = generation(&v.store);
    v.store.hide_profile(v.child, 100).unwrap();
    assert_eq!(generation(&v.store), generation_before + one_commit);
    let hidden = events(&v.store, HistoryEvent::ProfileHidden);
    assert_eq!(hidden.len(), 1);
    assert_eq!(hidden[0].profile_id, Some(v.child));
    assert_eq!(hidden[0].name.as_deref(), Some("FAKE Child"));
    assert_eq!(hidden[0].record_id, None);
    // Hiding again changes and records nothing.
    v.store.hide_profile(v.child, 101).unwrap();
    assert_eq!(generation(&v.store), generation_before + one_commit);
    assert_eq!(events(&v.store, HistoryEvent::ProfileHidden).len(), 1);

    v.store.restore_profile(v.child).unwrap();
    assert_eq!(generation(&v.store), generation_before + 2 * one_commit);
    let restored = events(&v.store, HistoryEvent::ProfileRestored);
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].profile_id, Some(v.child));
    // Restoring a person who is not hidden changes and records nothing.
    assert!(v.store.restore_profile(v.child).unwrap().is_empty());
    assert_eq!(generation(&v.store), generation_before + 2 * one_commit);
}

#[test]
fn the_last_visible_person_and_shared_with_me_cannot_be_hidden() {
    let v = vault();
    let shared = v.store.shared_profile().unwrap();
    assert!(matches!(
        v.store.hide_profile(shared, 100),
        Err(VaultError::Invalid)
    ));
    v.store.hide_profile(v.child, 100).unwrap();
    // The parent is the last visible person; Shared with me is a folder, not a person.
    assert!(matches!(
        v.store.hide_profile(v.parent, 101),
        Err(VaultError::LastVisibleProfile)
    ));
    assert!(matches!(
        v.store.hide_profile(Uuid::new_v4(), 102),
        Err(VaultError::NotFound)
    ));
    v.store.restore_profile(v.child).unwrap();
    v.store.hide_profile(v.parent, 103).unwrap();
    assert!(matches!(
        v.store.hide_profile(v.child, 104),
        Err(VaultError::LastVisibleProfile)
    ));
}

#[test]
fn a_hidden_persons_documents_are_out_of_reach_by_id_until_they_are_restored() {
    let v = vault();
    v.store.hide_profile(v.child, 100).unwrap();
    let mut sink = Vec::new();
    let refused = |result: Result<(), VaultError>| matches!(result, Err(VaultError::NotFound));
    // The reader and every save of a copy.
    assert!(refused(v.store.export(v.plain, &mut sink)));
    assert!(matches!(
        v.store.export_name(v.plain),
        Err(VaultError::NotFound)
    ));
    // Changes to a document and what is kept with it.
    assert!(refused(v.store.rename_record(v.plain, "FAKE Renamed.pdf")));
    assert!(refused(v.store.hide_record(v.plain, 101)));
    assert!(refused(v.store.unhide_record(v.own_hidden)));
    assert!(refused(v.store.assign_folders(v.plain, vec![])));
    assert!(matches!(
        v.store.ai_results(v.answered),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        v.store.known_identifiers(v.plain),
        Err(VaultError::NotFound)
    ));
    // Nothing can be added to, moved into or out of, or renamed in a hidden person.
    assert!(matches!(
        v.store.import(
            v.child,
            vec![],
            vec![source("FAKE New.pdf", b"FAKE-NEW")],
            102
        ),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        v.store.move_to_profile(vec![v.plain], v.parent, vec![]),
        Err(VaultError::NotFound)
    ));
    let parent_doc = v.store.snapshot().unwrap().records[0].id;
    assert!(matches!(
        v.store.move_to_profile(vec![parent_doc], v.child, vec![]),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        v.store.rename_profile(v.child, "FAKE Renamed", 103),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        v.store.create_folder(v.child, None, "FAKE Folder", 104),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        v.store.update_folder(v.folder, None, "FAKE Renamed Folder"),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        v.store.update_profile_details(
            v.child,
            ProfileDetails {
                full_name: Some("FAKE Full Name".into()),
                ..ProfileDetails::default()
            },
            &utc_date_text(crate::now_ms()),
            crate::now_ms()
        ),
        Err(VaultError::NotFound)
    ));

    v.store.restore_profile(v.child).unwrap();
    let mut sink = Vec::new();
    v.store.export(v.plain, &mut sink).unwrap();
    assert_eq!(sink, b"FAKE-FAKE Child A.pdf");
    assert!(v.store.ai_results(v.answered).is_ok());
    v.store.rename_record(v.plain, "FAKE Renamed.pdf").unwrap();
}

#[test]
fn a_hidden_person_can_still_be_exported_and_the_package_carries_their_own_hidden_documents_as_hidden(
) {
    let v = vault();
    v.store.hide_profile(v.child, 100).unwrap();
    let (key, _) = generate_package_key();
    let written = v
        .store
        .export_profile(
            v.child,
            ExportOptions {
                include_history: true,
            },
            PackageSecret::Key(&key),
            Vec::new(),
            200,
        )
        .unwrap();
    assert!(!written.sink.is_empty());
    assert_eq!(written.report.documents, 3);
    assert_eq!(written.report.hidden, 1);
}

#[test]
fn the_flag_travels_in_a_backup_and_an_older_state_restores_as_it_was() {
    let v = vault();
    let dir = tempfile::tempdir().unwrap();
    let before = dir.path().join("before.mycarlosbackup");
    v.store.backup_atomic(&before, 50).unwrap();
    v.store.hide_profile(v.child, 100).unwrap();
    let after = dir.path().join("after.mycarlosbackup");
    v.store.backup_atomic(&after, 150).unwrap();
    v.store.lock();

    let from = |path: &std::path::Path| {
        let target = VaultStore::new(dir.path().join(format!(
            "restored-{}",
            path.file_stem().unwrap().to_string_lossy()
        )));
        target
            .restore(
                std::fs::File::open(path).unwrap(),
                RestoreCredential::Passphrase(PASSWORD),
                false,
            )
            .unwrap();
        target.unlock(PASSWORD).unwrap();
        target
    };
    // The newer backup keeps the person hidden, with the same documents behind them.
    let hidden = from(&after);
    let snapshot = hidden.snapshot().unwrap();
    assert_eq!(snapshot.hidden_profiles.len(), 1);
    assert_eq!(snapshot.hidden_profiles[0].documents, 3);
    assert_eq!(snapshot.profiles.len(), 1);
    // The older one is the earlier state: visible.
    let visible = from(&before);
    let snapshot = visible.snapshot().unwrap();
    assert!(snapshot.hidden_profiles.is_empty());
    assert_eq!(snapshot.profiles.len(), 2);
    assert_eq!(snapshot.records.len(), 4);
}

#[test]
fn a_hidden_person_needs_the_new_format_and_a_vault_with_nobody_visible_is_refused() {
    let v = vault();
    let manifest = v.store.session().as_ref().unwrap().manifest.clone();
    let vault_id = manifest.vault_id;
    let mut person = manifest
        .profiles
        .iter()
        .find(|p| p.id == v.child)
        .unwrap()
        .clone();
    person.hidden = Some(Hidden {
        at_ms: 1,
        reason: HiddenReason::Patient,
    });
    // The format that holds hidden people is the one after the handover's, and no earlier.
    assert_eq!(
        HIDDEN_PROFILES_FORMAT,
        Some(MANIFEST_FORMAT_HIDDEN_PROFILES)
    );
    const { assert!(MANIFEST_FORMAT_HIDDEN_PROFILES > MANIFEST_FORMAT_PROFILE_HANDOVER) };
    assert_eq!(VAULT_FORMAT, MANIFEST_FORMAT_HIDDEN_PROFILES);
    assert!(!valid_handover_fields(
        &person,
        MANIFEST_FORMAT_PROFILE_HANDOVER,
        vault_id
    ));
    assert!(valid_handover_fields(
        &person,
        MANIFEST_FORMAT_HIDDEN_PROFILES,
        vault_id
    ));
    // Shared with me and a damaged-file reason are never a hidden person.
    let mut damaged = person.clone();
    damaged.hidden = Some(Hidden {
        at_ms: 1,
        reason: HiddenReason::Damaged,
    });
    assert!(!valid_handover_fields(
        &damaged,
        MANIFEST_FORMAT_HIDDEN_PROFILES,
        vault_id
    ));

    // Everybody hidden is no manifest any build writes.
    let mut nobody = manifest.clone();
    for profile in &mut nobody.profiles {
        profile.hidden = Some(Hidden {
            at_ms: 1,
            reason: HiddenReason::Patient,
        });
    }
    assert!(matches!(
        validate_manifest_structure(&nobody, vault_id),
        Err(VaultError::Corrupt)
    ));
    // Someone visible, and Shared with me (never hidden) beside a hidden person, is fine.
    let mut one = manifest.clone();
    one.profiles
        .iter_mut()
        .find(|p| p.id == v.child)
        .unwrap()
        .hidden = person.hidden;
    assert!(validate_manifest_structure(&one, vault_id).is_ok());
    // The same manifest declared at the handover's format is refused: an older build must
    // never read a hidden person and list them.
    let mut early = one.clone();
    early.format_version = MANIFEST_FORMAT_PROFILE_HANDOVER;
    assert!(matches!(
        validate_manifest_structure(&early, vault_id),
        Err(VaultError::Corrupt)
    ));
}

#[test]
fn only_the_last_visible_person_rule_counts_people_not_shared_with_me() {
    let v = vault();
    // Shared with me exists as a profile once something is filed there.
    let shared = v.store.shared_profile().unwrap();
    v.store
        .import(
            shared,
            vec![],
            vec![source("FAKE Shared.pdf", b"FAKE-SHARED")],
            8,
        )
        .unwrap();
    v.store.hide_profile(v.child, 100).unwrap();
    // Shared with me is visible, yet the parent is still the last person.
    assert!(matches!(
        v.store.hide_profile(v.parent, 101),
        Err(VaultError::LastVisibleProfile)
    ));
    // Its documents are in the library, as they are without a hidden person.
    let snapshot = v.store.snapshot().unwrap();
    assert!(snapshot.records.iter().any(|r| r.profile_id == shared));
}

#[test]
fn clearing_the_ai_helper_and_the_lock_leave_the_flag_alone() {
    let v = vault();
    v.store.hide_profile(v.child, 100).unwrap();
    let root = v.store.root.clone();
    v.store.lock();
    let again = VaultStore::new(root);
    again.unlock(PASSWORD).unwrap();
    let snapshot = again.snapshot().unwrap();
    assert_eq!(snapshot.hidden_profiles.len(), 1);
    assert_eq!(snapshot.profiles.len(), 1);
    assert_eq!(
        snapshot.hidden_profiles[0].hidden_at_ms, 100,
        "the time is the one the patient hid them at"
    );
}

// --- A process killed at each write boundary -------------------------------------------------

fn run_child(root: &Path, test: &str, action: &str, profile: Uuid, boundary: &str) {
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", test])
        .env("MYCARLOS_TEST_ROOT", root)
        .env("MYCARLOS_TEST_ACTION", action)
        .env("MYCARLOS_TEST_PROFILE", profile.to_string())
        .env("MYCARLOS_TEST_TERMINATE_AT", boundary)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert_eq!(
        status.code(),
        Some(TEST_TERMINATION_EXIT_CODE),
        "{boundary}"
    );
}

#[test]
#[ignore = "invoked as an abrupt-termination subprocess by the hide matrix"]
fn hide_termination_child() {
    let Ok(root) = std::env::var("MYCARLOS_TEST_ROOT") else {
        return;
    };
    let action = std::env::var("MYCARLOS_TEST_ACTION").unwrap();
    let profile: Uuid = std::env::var("MYCARLOS_TEST_PROFILE")
        .unwrap()
        .parse()
        .unwrap();
    let store = VaultStore::new(PathBuf::from(root));
    // The unlock's own history commit must not be where the boundary is reached.
    ENV_BOUNDARIES_HELD.store(true, Ordering::Release);
    let unlocked = store.unlock(PASSWORD);
    ENV_BOUNDARIES_HELD.store(false, Ordering::Release);
    unlocked.unwrap();
    if action == "hide" {
        let _ = store.hide_profile(profile, 100);
    } else {
        let _ = store.restore_profile(profile);
    }
    panic!("configured termination boundary was not reached");
}

#[test]
fn a_process_killed_while_hiding_or_restoring_leaves_the_person_fully_visible_or_fully_hidden() {
    const TEST: &str = "vault::hidden_profiles_tests::hide_termination_child";
    for boundary in ["manifest.after-first-write", "manifest.after-second-write"] {
        // Hiding: killed after the commit's first write or its second, the person is hidden,
        // whole: no document is left half in the library.
        let v = vault();
        let root = v.store.root.clone();
        v.store.lock();
        run_child(&root, TEST, "hide", v.child, boundary);
        v.store.unlock(PASSWORD).unwrap();
        let snapshot = v.store.snapshot().unwrap();
        assert_eq!(snapshot.hidden_profiles.len(), 1, "{boundary}");
        assert!(
            snapshot.records.iter().all(|r| r.profile_id != v.child),
            "{boundary}"
        );
        assert!(
            snapshot.folders.iter().all(|f| f.profile_id != v.child),
            "{boundary}"
        );
        assert_eq!(events(&v.store, HistoryEvent::ProfileHidden).len(), 1);
        assert!(v.store.verify_for_backup().is_ok(), "{boundary}");

        // Restoring: the same, the other way round.
        let v = vault();
        v.store.hide_profile(v.child, 90).unwrap();
        let root = v.store.root.clone();
        v.store.lock();
        run_child(&root, TEST, "restore", v.child, boundary);
        v.store.unlock(PASSWORD).unwrap();
        let snapshot = v.store.snapshot().unwrap();
        assert!(snapshot.hidden_profiles.is_empty(), "{boundary}");
        assert_eq!(snapshot.records.len(), 4, "{boundary}");
        assert_eq!(events(&v.store, HistoryEvent::ProfileRestored).len(), 1);
        assert!(v.store.verify_for_backup().is_ok(), "{boundary}");
    }
}

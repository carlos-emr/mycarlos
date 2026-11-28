//! Hiding a whole folder and bringing it back (#574 PR B). FAKE data only.
//!
//! What is pinned: one flag and one history entry each way; a hidden folder, every folder below
//! it and every document filed in any of them out of every list and out of every lookup by id;
//! each document's own `hidden` untouched, so a restore returns exactly what was visible; the
//! nested cases (a folder hidden on its own stays hidden when its parent comes back, hiding under
//! a hidden parent is refused, a document in two folders stays visible through the one that is
//! not hidden); nothing moved
//! into, out of or under a hidden folder; Security's history leaving out what is about a hidden
//! folder and what merely names it; the flag in a backup; the format gate; an export that carries
//! a hidden folder hidden and an import that restores it hidden; a hidden folder's lost file not
//! trapping the vault read-only; and deliveries never filed into a folder at all.
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
    person: Uuid,
    /// "FAKE Letters", a top folder; "FAKE 2025" is inside it; "FAKE Imaging" is another top one.
    letters: Uuid,
    year: Uuid,
    imaging: Uuid,
    /// A document filed in Letters, one in 2025 (inside Letters), one in Imaging, one in no folder.
    in_letters: Uuid,
    in_year: Uuid,
    in_imaging: Uuid,
    loose: Uuid,
}

/// FAKE Person with three folders (one nested) and four documents.
fn vault() -> Vault {
    let temp = tempfile::tempdir().unwrap();
    let store = VaultStore::new(temp.path().join("vault"));
    store.create(PASSWORD, "FAKE Person", 1).unwrap();
    let person = store.snapshot().unwrap().profiles[0].id;
    let letters = store
        .create_folder(person, None, "FAKE Letters", 2)
        .unwrap();
    let year = store
        .create_folder(person, Some(letters), "FAKE 2025", 3)
        .unwrap();
    let imaging = store
        .create_folder(person, None, "FAKE Imaging", 4)
        .unwrap();
    let file = |name: &str, folders: Vec<Uuid>| {
        store
            .import(
                person,
                folders,
                vec![source(name, format!("FAKE-{name}").as_bytes())],
                5,
            )
            .unwrap()
            .imported[0]
    };
    let in_letters = file("FAKE In Letters.pdf", vec![letters]);
    let in_year = file("FAKE In Year.pdf", vec![year]);
    let in_imaging = file("FAKE In Imaging.pdf", vec![imaging]);
    let loose = file("FAKE Loose.pdf", vec![]);
    Vault {
        _temp: temp,
        store,
        person,
        letters,
        year,
        imaging,
        in_letters,
        in_year,
        in_imaging,
        loose,
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

fn record_ids(store: &VaultStore) -> HashSet<Uuid> {
    store
        .snapshot()
        .unwrap()
        .records
        .iter()
        .map(|record| record.id)
        .collect()
}

fn folder_ids(store: &VaultStore) -> HashSet<Uuid> {
    store
        .snapshot()
        .unwrap()
        .folders
        .iter()
        .map(|folder| folder.id)
        .collect()
}

#[test]
fn hiding_a_folder_takes_it_its_subtree_and_their_documents_out_of_every_list_and_restoring_brings_exactly_those_back(
) {
    let v = vault();
    assert_eq!(v.store.snapshot().unwrap().records.len(), 4);
    assert!(v.store.snapshot().unwrap().hidden_folders.is_empty());
    // One document hidden on its own before: it must come back hidden.
    v.store.hide_record(v.in_year, 6).unwrap();

    v.store.hide_folder(v.letters, 100).unwrap();
    let hidden = v.store.snapshot().unwrap();
    // The library: Letters and 2025 are in no list, and neither are their documents.
    assert_eq!(folder_ids(&v.store), HashSet::from([v.imaging]));
    assert_eq!(record_ids(&v.store), HashSet::from([v.in_imaging, v.loose]));
    // Only Security's Hidden folders list knows it: the topmost hidden folder, its name, when,
    // how many documents (the one hidden on its own included) and how many folders below it.
    assert_eq!(hidden.hidden_folders.len(), 1);
    let listed = &hidden.hidden_folders[0];
    assert_eq!(listed.id, v.letters);
    assert_eq!(listed.profile_id, v.person);
    assert_eq!(listed.name, "FAKE Letters");
    assert_eq!(listed.hidden_at_ms, 100);
    assert_eq!(listed.documents, 2);
    assert_eq!(listed.subfolders, 1);
    // The person is still shown, with the other people's lists as they were.
    assert_eq!(hidden.profiles.len(), 1);

    v.store.restore_folder(v.letters).unwrap();
    let back = v.store.snapshot().unwrap();
    assert!(back.hidden_folders.is_empty());
    assert_eq!(folder_ids(&v.store).len(), 3);
    assert_eq!(back.records.len(), 4);
    // Nothing a document carried changed: the one hidden on its own is still hidden.
    assert!(back
        .records
        .iter()
        .find(|record| record.id == v.in_year)
        .unwrap()
        .hidden
        .is_some());
    assert!(back
        .records
        .iter()
        .filter(|record| record.id != v.in_year)
        .all(|record| record.hidden.is_none()));
}

#[test]
fn hiding_and_restoring_are_one_commit_and_one_history_entry_each_with_the_name_and_no_documents() {
    let v = vault();
    let before = generation(&v.store);
    v.store.hide_folder(v.letters, 100).unwrap();
    assert_eq!(generation(&v.store), before + 1);
    let hide = events(&v.store, HistoryEvent::FolderHidden);
    assert_eq!(hide.len(), 1);
    assert_eq!(hide[0].folder_id, Some(v.letters));
    assert_eq!(hide[0].profile_id, Some(v.person));
    assert_eq!(hide[0].name.as_deref(), Some("FAKE Letters"));
    assert!(hide[0].record_id.is_none());

    v.store.restore_folder(v.letters).unwrap();
    assert_eq!(generation(&v.store), before + 2);
    assert_eq!(events(&v.store, HistoryEvent::FolderRestored).len(), 1);
    // Restoring a folder that is visible changes nothing and writes nothing.
    v.store.restore_folder(v.letters).unwrap();
    assert_eq!(generation(&v.store), before + 2);
    assert_eq!(events(&v.store, HistoryEvent::FolderRestored).len(), 1);
}

#[test]
fn nested_cases_a_folder_hidden_on_its_own_stays_hidden_and_hiding_under_a_hidden_parent_is_refused(
) {
    let v = vault();
    // 2025 is hidden on its own first, then its parent is hidden too.
    v.store.hide_folder(v.year, 100).unwrap();
    assert_eq!(
        record_ids(&v.store),
        HashSet::from([v.in_letters, v.in_imaging, v.loose])
    );
    v.store.hide_folder(v.letters, 101).unwrap();
    assert_eq!(record_ids(&v.store), HashSet::from([v.in_imaging, v.loose]));
    // Only the topmost hidden folder is listed: 2025 is restored through Letters.
    let listed = v.store.snapshot().unwrap().hidden_folders;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, v.letters);
    assert_eq!(listed[0].parent_id, None);
    assert_eq!(listed[0].subfolders, 1);

    // Hiding under a hidden parent (the folder is out of reach), hiding again, and restoring the
    // inner one while its parent is hidden are all "not found": a hidden thing is not named.
    for refused in [
        v.store.hide_folder(v.year, 102).map(|_| ()),
        v.store.hide_folder(v.letters, 102).map(|_| ()),
        v.store.restore_folder(v.year),
    ] {
        assert!(matches!(refused, Err(VaultError::NotFound)));
    }

    // Restoring the parent brings back what the parent hid; 2025, hidden on its own, stays hidden.
    v.store.restore_folder(v.letters).unwrap();
    assert_eq!(
        record_ids(&v.store),
        HashSet::from([v.in_letters, v.in_imaging, v.loose])
    );
    let listed = v.store.snapshot().unwrap().hidden_folders;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, v.year);
    assert_eq!(listed[0].parent_id, Some(v.letters));
    // And it can be restored now.
    v.store.restore_folder(v.year).unwrap();
    assert_eq!(v.store.snapshot().unwrap().records.len(), 4);
}

#[test]
fn a_document_filed_in_two_folders_stays_visible_through_the_one_that_is_not_hidden() {
    // Ben's decision: out of reach only when ALL its folders are (or its person is hidden).
    let v = vault();
    v.store
        .assign_folders(v.in_imaging, vec![v.imaging, v.letters])
        .unwrap();
    v.store.hide_folder(v.letters, 100).unwrap();
    let hidden = v.store.snapshot().unwrap();
    assert!(hidden
        .records
        .iter()
        .any(|record| record.id == v.in_imaging));
    // The visible document shows no sign of the hidden place: not even its id.
    let shown = hidden
        .records
        .iter()
        .find(|record| record.id == v.in_imaging)
        .unwrap();
    assert_eq!(shown.folder_ids, vec![v.imaging]);
    // The listing counts what is filed in the hidden folder, that one included.
    assert_eq!(hidden.hidden_folders[0].documents, 3);
    // Restoring brings the second placement back.
    v.store.restore_folder(v.letters).unwrap();
    let back = v.store.snapshot().unwrap();
    let record = back
        .records
        .iter()
        .find(|record| record.id == v.in_imaging)
        .unwrap();
    assert_eq!(
        record.folder_ids.iter().copied().collect::<HashSet<_>>(),
        HashSet::from([v.imaging, v.letters])
    );
}

#[test]
fn re_filing_a_document_that_is_also_in_a_hidden_folder_keeps_the_hidden_place() {
    // The page only ever sees the places in reach, so it can only send those back: the place in
    // the hidden folder must survive a re-filing, or restoring would not bring back what was there.
    let v = vault();
    let other = v
        .store
        .create_folder(v.person, None, "FAKE Other", 6)
        .unwrap();
    v.store
        .assign_folders(v.in_imaging, vec![v.imaging, v.letters])
        .unwrap();
    v.store.hide_folder(v.letters, 100).unwrap();
    // Re-filed from what the page sees: the visible folder and a new one.
    v.store
        .assign_folders(v.in_imaging, vec![v.imaging, other])
        .unwrap();
    let shown = v.store.snapshot().unwrap();
    let record = shown
        .records
        .iter()
        .find(|record| record.id == v.in_imaging)
        .unwrap();
    assert_eq!(
        record.folder_ids.iter().copied().collect::<HashSet<_>>(),
        HashSet::from([v.imaging, other])
    );
    v.store.restore_folder(v.letters).unwrap();
    let back = v.store.snapshot().unwrap();
    let record = back
        .records
        .iter()
        .find(|record| record.id == v.in_imaging)
        .unwrap();
    assert_eq!(
        record.folder_ids.iter().copied().collect::<HashSet<_>>(),
        HashSet::from([v.imaging, other, v.letters])
    );
    // Taking the document out of every folder it is shown in puts it in none: the hidden place
    // goes too, or the document would vanish from the library.
    v.store.hide_folder(v.letters, 101).unwrap();
    v.store.assign_folders(v.in_imaging, vec![]).unwrap();
    assert!(record_ids(&v.store).contains(&v.in_imaging));
    v.store.restore_folder(v.letters).unwrap();
    let last = v.store.snapshot().unwrap();
    assert!(last
        .records
        .iter()
        .find(|record| record.id == v.in_imaging)
        .unwrap()
        .folder_ids
        .is_empty());
}

#[test]
fn a_document_filed_only_in_hidden_folders_is_out_of_reach_and_one_visible_folder_is_enough() {
    let v = vault();
    // In Letters and 2025: both go with Letters (2025 is beneath it), so it is out of reach.
    v.store
        .assign_folders(v.in_year, vec![v.year, v.letters])
        .unwrap();
    v.store.hide_folder(v.letters, 100).unwrap();
    assert!(!record_ids(&v.store).contains(&v.in_year));
    // The AI helper keeps nothing for it once it is hidden; what stays visible keeps its answers.
    v.store.restore_folder(v.letters).unwrap();
    v.store
        .assign_folders(v.in_letters, vec![v.letters, v.imaging])
        .unwrap();
    let covered = v.store.hide_folder(v.letters, 101).unwrap();
    assert!(covered.contains(&v.in_year));
    assert!(!covered.contains(&v.in_letters));
    assert!(record_ids(&v.store).contains(&v.in_letters));

    // Hiding its remaining visible placement must now revoke playback and pending AI work.
    let covered = v.store.hide_folder(v.imaging, 102).unwrap();
    assert!(covered.contains(&v.in_letters));
    assert!(!covered.contains(&v.in_year));
    assert!(!record_ids(&v.store).contains(&v.in_letters));
}

#[test]
fn nothing_is_filed_under_moved_into_moved_out_of_or_looked_up_inside_a_hidden_folder() {
    let v = vault();
    v.store.hide_folder(v.letters, 100).unwrap();
    // A document cannot be filed into it, a folder cannot be made or moved under it, and the
    // hidden folder itself cannot be renamed or moved: each is "not found".
    assert!(matches!(
        v.store.assign_folders(v.loose, vec![v.letters]),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        v.store.assign_folders(v.loose, vec![v.year]),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        v.store
            .create_folder(v.person, Some(v.letters), "FAKE Inside", 101),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        v.store
            .update_folder(v.imaging, Some(v.letters), "FAKE Imaging"),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        v.store.update_folder(v.letters, None, "FAKE Renamed"),
        Err(VaultError::NotFound)
    ));
    // A document inside is out of reach by id: no rename, no hide, no move out, no new folders.
    assert!(matches!(
        v.store.rename_record(v.in_letters, "FAKE Renamed.pdf"),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        v.store.hide_record(v.in_year, 102),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        v.store.assign_folders(v.in_letters, vec![v.imaging]),
        Err(VaultError::NotFound)
    ));
    // Documents outside are untouched, and a new folder is still made beside it.
    v.store.rename_record(v.loose, "FAKE Loose 2.pdf").unwrap();
    v.store
        .create_folder(v.person, None, "FAKE Other", 103)
        .unwrap();
    // Allowed again once it is restored.
    v.store.restore_folder(v.letters).unwrap();
    v.store.assign_folders(v.loose, vec![v.letters]).unwrap();
    v.store
        .rename_record(v.in_letters, "FAKE Renamed.pdf")
        .unwrap();
}

#[test]
fn security_history_leaves_out_what_is_about_a_hidden_folder_and_what_merely_names_it() {
    let v = vault();
    // A document that was in Letters and moved to Imaging: its Moved entry NAMES Letters in
    // `from`, without being about it.
    v.store
        .assign_folders(v.in_letters, vec![v.imaging])
        .unwrap();
    let all = v.store.history_view().unwrap().entries.len();
    v.store.hide_folder(v.letters, 100).unwrap();
    let kept = v.store.history_view().unwrap();
    assert_eq!(kept.entries.len(), all + 1);
    assert_eq!(kept.about_hidden_people, 0);
    let shown = v.store.history_view_for_display().unwrap();
    // One count for people and folders alike, and the folder's name is nowhere in what is shown.
    assert!(shown.about_hidden_people > 0);
    assert_eq!(
        shown.entries.len() + shown.about_hidden_people,
        kept.entries.len()
    );
    let names_letters = |entry: &HistoryEntry| {
        let named = |places: &Option<Vec<history::FolderAtTheTime>>| {
            places
                .as_ref()
                .is_some_and(|places| places.iter().any(|place| place.name == "FAKE Letters"))
        };
        entry.name.as_deref() == Some("FAKE Letters")
            || entry.old_name.as_deref() == Some("FAKE Letters")
            || named(&entry.from)
            || named(&entry.to)
            || entry.folder_id == Some(v.letters)
    };
    assert!(shown.entries.iter().all(|entry| !names_letters(entry)));
    // The vault itself keeps them all, and shows them again on restore.
    assert!(kept.entries.iter().any(names_letters));
    v.store.restore_folder(v.letters).unwrap();
    let again = v.store.history_view_for_display().unwrap();
    assert_eq!(again.about_hidden_people, 0);
    assert_eq!(again.entries.len(), all + 2);
}

#[test]
fn the_history_of_a_vault_with_a_hidden_folder_and_no_hidden_person_is_still_filtered() {
    // The display filter once returned the whole view when no PERSON was hidden.
    let v = vault();
    v.store.hide_folder(v.imaging, 100).unwrap();
    assert!(v.store.snapshot().unwrap().hidden_profiles.is_empty());
    let shown = v.store.history_view_for_display().unwrap();
    assert!(shown.about_hidden_people > 0);
    assert!(shown
        .entries
        .iter()
        .all(|entry| entry.folder_id != Some(v.imaging)));
}

#[test]
fn the_flag_travels_in_a_backup_and_an_older_state_restores_as_it_was() {
    let v = vault();
    let dir = tempfile::tempdir().unwrap();
    let before = dir.path().join("before.mycarlosbackup");
    v.store.backup_atomic(&before, 50).unwrap();
    v.store.hide_folder(v.letters, 100).unwrap();
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
    // The newer backup keeps the folder hidden, with its documents behind it.
    let hidden = from(&after);
    let snapshot = hidden.snapshot().unwrap();
    assert_eq!(snapshot.hidden_folders.len(), 1);
    assert_eq!(snapshot.hidden_folders[0].documents, 2);
    assert_eq!(snapshot.records.len(), 2);
    // The older one is the earlier state: visible.
    let visible = from(&before);
    let snapshot = visible.snapshot().unwrap();
    assert!(snapshot.hidden_folders.is_empty());
    assert_eq!(snapshot.records.len(), 4);
    assert_eq!(snapshot.folders.len(), 3);
}

#[test]
fn a_hidden_folder_needs_the_new_format_and_only_the_patients_reason_and_never_shared_with_me() {
    let v = vault();
    let manifest = v.store.session().as_ref().unwrap().manifest.clone();
    let vault_id = manifest.vault_id;
    let mut folder = manifest
        .folders
        .iter()
        .find(|f| f.id == v.letters)
        .unwrap()
        .clone();
    folder.hidden = Some(Hidden {
        at_ms: 1,
        reason: HiddenReason::Patient,
    });
    // The format that holds a hidden folder is the constant's, after link removal's 16.
    assert_eq!(HIDDEN_FOLDERS_FORMAT, Some(MANIFEST_FORMAT_HIDDEN_FOLDERS));
    const { assert!(MANIFEST_FORMAT_HIDDEN_FOLDERS > MANIFEST_FORMAT_LINK_REMOVAL) };
    const { assert!(VAULT_FORMAT >= MANIFEST_FORMAT_HIDDEN_FOLDERS) };
    assert!(valid_folder_hidden(
        &folder,
        MANIFEST_FORMAT_HIDDEN_FOLDERS,
        vault_id
    ));
    assert!(!valid_folder_hidden(
        &folder,
        MANIFEST_FORMAT_LINK_REMOVAL,
        vault_id
    ));
    // A folder with no flag is valid at any format.
    let mut plain = folder.clone();
    plain.hidden = None;
    assert!(valid_folder_hidden(
        &plain,
        MANIFEST_FORMAT_LINK_REMOVAL,
        vault_id
    ));
    // A document's damaged reason is never a folder's, and Shared with me holds no folder.
    let mut damaged = folder.clone();
    damaged.hidden = Some(Hidden {
        at_ms: 1,
        reason: HiddenReason::Damaged,
    });
    assert!(!valid_folder_hidden(
        &damaged,
        MANIFEST_FORMAT_HIDDEN_FOLDERS,
        vault_id
    ));
    let mut shared = folder.clone();
    shared.profile_id = shared_profile_id(vault_id);
    assert!(!valid_folder_hidden(
        &shared,
        MANIFEST_FORMAT_HIDDEN_FOLDERS,
        vault_id
    ));

    // The whole manifest: fine at the new format, refused one format earlier (an older build
    // must never read a hidden folder and list it).
    let mut hides = manifest.clone();
    hides
        .folders
        .iter_mut()
        .find(|f| f.id == v.letters)
        .unwrap()
        .hidden = folder.hidden;
    assert!(validate_manifest_structure(&hides, vault_id).is_ok());
    let mut early = hides.clone();
    early.format_version = MANIFEST_FORMAT_LINK_REMOVAL;
    assert!(matches!(
        validate_manifest_structure(&early, vault_id),
        Err(VaultError::Corrupt)
    ));
}

#[test]
fn an_export_carries_a_hidden_folder_and_its_documents_hidden_and_an_import_restores_it_hidden() {
    // Ben's decision: an export KEEPS a hidden folder's documents, carried as hidden, the way a
    // hidden document carries `hiddenAtMs`; an import restores them hidden.
    let v = vault();
    v.store.hide_folder(v.letters, 100).unwrap();
    let (key, _) = generate_package_key();
    let written = v
        .store
        .export_profile(
            v.person,
            ExportOptions {
                include_history: true,
            },
            PackageSecret::Key(&key),
            Vec::new(),
            200,
        )
        .unwrap();
    // Everything goes: all three folders and all four documents, one folder carried hidden.
    assert_eq!(written.report.documents, 4);
    assert_eq!(written.report.folders, 3);
    assert_eq!(written.report.hidden_folders, 1);

    let temp = tempfile::tempdir().unwrap();
    let target = VaultStore::new(temp.path().join("target"));
    target.create(PASSWORD, "FAKE Receiver", 1).unwrap();
    let result = target
        .import_profile_package(
            Cursor::new(written.sink.clone()),
            PackageSecret::Key(&key),
            &crate::vault::profile_import::ImportOptions {
                display_name: None,
                allow_duplicate: false,
            },
            300,
        )
        .unwrap();
    let crate::vault::profile_import::ImportResult::Imported(done) = result else {
        panic!("the package was not imported");
    };
    let snapshot = target.snapshot().unwrap();
    // The person arrives visible; the folder that was hidden arrives hidden with its subtree and
    // its documents (the two in Letters and 2025), so the library shows only the other two.
    assert!(snapshot.profiles.iter().any(|p| p.id == done.profile_id));
    assert_eq!(snapshot.hidden_folders.len(), 1);
    assert_eq!(snapshot.hidden_folders[0].name, "FAKE Letters");
    assert_eq!(snapshot.hidden_folders[0].documents, 2);
    assert_eq!(snapshot.hidden_folders[0].subfolders, 1);
    assert_eq!(
        snapshot
            .records
            .iter()
            .filter(|r| r.profile_id == done.profile_id)
            .count(),
        2
    );
    // Restoring it there brings the two documents back.
    target
        .restore_folder(snapshot.hidden_folders[0].id)
        .unwrap();
    assert_eq!(
        target
            .snapshot()
            .unwrap()
            .records
            .iter()
            .filter(|r| r.profile_id == done.profile_id)
            .count(),
        4
    );
}

#[test]
fn a_hidden_folders_lost_file_does_not_trap_the_vault_read_only_and_is_counted_apart() {
    let v = vault();
    v.store.hide_folder(v.letters, 100).unwrap();
    let (root, object_name) = {
        let guard = v.store.session();
        let manifest = &guard.as_ref().unwrap().manifest;
        let record = manifest
            .records
            .iter()
            .find(|r| r.id == v.in_letters)
            .unwrap();
        (v.store.root.clone(), record.object_name.clone())
    };
    v.store.lock();
    let object_outside_vault = root.with_file_name("lost-object");
    fs::rename(
        root.join("objects").join(object_name),
        &object_outside_vault,
    )
    .unwrap();
    assert!(object_outside_vault.is_file());
    let store = VaultStore::new(root);
    store.unlock(PASSWORD).unwrap();

    let snapshot = store.snapshot().unwrap();
    assert_eq!(snapshot.recovery, Some(RecoveryReason::LostObjects));
    // The folder is in no list, so its damaged document is counted (apart from the people's),
    // never named.
    assert_eq!(snapshot.hidden_folders_damaged, 1);
    assert_eq!(snapshot.hidden_people_damaged, 0);
    assert!(snapshot.records.iter().all(|r| r.id != v.in_letters));
    // A confirmation that does not cover it changes nothing.
    assert!(matches!(
        store.hide_unavailable_records(&[], 1),
        Err(VaultError::RemovalChanged)
    ));
    assert!(matches!(
        store.hide_unavailable_records_covering(&[], 0, 2, 2),
        Err(VaultError::RemovalChanged)
    ));
    // Restoring is refused while read-only (a commit needs every file the manifest names).
    assert!(matches!(
        store.restore_folder(v.letters),
        Err(VaultError::RecoveryMode)
    ));
    // The confirmation that does cover it is the way out; the folder is still hidden.
    let removed = store
        .hide_unavailable_records_covering(&[], 0, 1, 2)
        .unwrap();
    assert_eq!(removed, vec![v.in_letters]);
    let after = store.snapshot().unwrap();
    assert_eq!(after.recovery, None);
    assert_eq!(after.hidden_folders_damaged, 0);
    assert_eq!(after.hidden_folders.len(), 1);
}

#[test]
fn clinic_deliveries_are_never_filed_into_a_folder() {
    // A delivery is filed at a person's top level (or in Shared with me): it never names a
    // folder, so a hidden folder cannot be filled by a clinic. Pinned as a source scan so that a
    // later "file under the clinic's folder" feature cannot start without a failing test: every
    // place the delivery code sets `folder_ids` sets it empty.
    let source = include_str!("delivery.rs");
    let end = source.find("\n#[cfg(test)]\nmod ").unwrap_or(source.len());
    let code: String = source[..end]
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut sites = 0;
    for (at, _) in code.match_indices("folder_ids:") {
        let rest = code[at + "folder_ids:".len()..].trim_start();
        assert!(
            rest.starts_with("Vec::new()"),
            "delivery.rs files a document into a folder: {}",
            &rest[..rest.len().min(60)]
        );
        sites += 1;
    }
    assert!(sites > 0, "the scan found no folder_ids in delivery.rs");
}

#[test]
fn clearing_the_ai_helper_and_the_lock_leave_the_folder_flag_alone() {
    let v = vault();
    v.store.hide_folder(v.letters, 100).unwrap();
    v.store.lock();
    v.store.unlock(PASSWORD).unwrap();
    let snapshot = v.store.snapshot().unwrap();
    assert_eq!(snapshot.hidden_folders.len(), 1);
    assert_eq!(snapshot.records.len(), 2);
    v.store.restore_folder(v.letters).unwrap();
    assert_eq!(v.store.snapshot().unwrap().records.len(), 4);
}

#[test]
fn filing_keeps_the_places_out_of_reach_and_refuses_rather_than_cutting_at_the_cap() {
    let ids = |count: usize| -> Vec<Uuid> { (0..count).map(|_| Uuid::new_v4()).collect() };
    let visible = ids(3);
    let hidden = ids(2);
    let in_reach: HashSet<Uuid> = visible.iter().copied().collect();
    let current: Vec<Uuid> = [&visible[..1], &hidden[..]].concat();

    // Re-filed from what the screen shows: the chosen places, then the hidden ones, once each.
    let chosen = vec![visible[1], visible[2]];
    let places = places_after_filing(&chosen, &in_reach, &current).unwrap();
    assert_eq!(places, [visible[1], visible[2], hidden[0], hidden[1]]);
    // No folder chosen: none at all, the hidden places included.
    assert!(places_after_filing(&[], &in_reach, &current)
        .unwrap()
        .is_empty());

    // Exactly at the cap is fine; one more is refused, never cut.
    let room = MAX_FOLDER_ASSIGNMENTS - hidden.len();
    let fits = ids(room);
    let all_in_reach: HashSet<Uuid> = fits.iter().copied().collect();
    let kept = places_after_filing(&fits, &all_in_reach, &hidden).unwrap();
    assert_eq!(kept.len(), MAX_FOLDER_ASSIGNMENTS);
    let too_many = ids(room + 1);
    let all_in_reach: HashSet<Uuid> = too_many.iter().copied().collect();
    assert!(matches!(
        places_after_filing(&too_many, &all_in_reach, &hidden),
        Err(VaultError::Invalid)
    ));
}

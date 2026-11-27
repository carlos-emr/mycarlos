//! The vault's refusals while it is read-only, and what a read-only vault still lets out (agent 4's
//! coverage batch for the vault side). FAKE data only.
//!
//! Read-only recovery (`recovery` set on the unlocked session) exists so that a damaged vault can
//! be looked at and its readable documents saved, never so that anything is written on top of
//! what may be a newer or intact state. So: every write refuses with `RecoveryMode` and leaves
//! the vault as it was; a document can still be exported; a person's hand-over package is NOT
//! made or imported (it is built from, or written into, the manifest the session cannot trust);
//! and a package can still be inspected.
use super::*;
use crate::vault::ai_results::{AiResultInput, AiTool};
use crate::vault::profile_export::ExportOptions;
use crate::vault::profile_import::ImportOptions;
use crate::vault::profile_package::{generate_package_key, PackageSecret};
use std::io::Cursor;

const PASSWORD: &str = "correct horse battery staple 9173";

fn source(name: &str, data: &[u8]) -> ImportSource {
    ImportSource {
        display_name: name.to_owned(),
        reader: Box::new(Cursor::new(data.to_vec())),
    }
}

struct Healthy {
    _temp: tempfile::TempDir,
    store: VaultStore,
    jamie: Uuid,
    robin: Uuid,
    folder: Uuid,
    record: Uuid,
}

/// FAKE Jamie (a folder and one document) and FAKE Robin (nobody's documents), unlocked.
fn healthy() -> Healthy {
    let temp = tempfile::tempdir().unwrap();
    let store = VaultStore::new(temp.path().join("vault"));
    store.create(PASSWORD, "FAKE Jamie", 1).unwrap();
    let jamie = store.snapshot().unwrap().profiles[0].id;
    let robin = store.create_profile("FAKE Robin", 2).unwrap();
    let folder = store.create_folder(jamie, None, "FAKE Folder", 3).unwrap();
    let outcome = store
        .import(
            jamie,
            vec![],
            vec![source("FAKE Letter.pdf", b"FAKE-LETTER-BYTES")],
            4,
        )
        .unwrap();
    let record = outcome.imported[0];
    Healthy {
        _temp: temp,
        store,
        jamie,
        robin,
        folder,
        record,
    }
}

/// What the library shows, as data: people, hidden people, folders and documents.
fn shape(store: &VaultStore) -> serde_json::Value {
    let snapshot = store.snapshot().unwrap();
    serde_json::json!({
        "profiles": snapshot.profiles,
        "hidden": snapshot.hidden_profiles,
        "folders": snapshot.folders,
        "records": snapshot.records,
    })
}

fn read_only(store: &VaultStore) {
    store.unlocked.lock().unwrap().as_mut().unwrap().recovery = Some(RecoveryReason::WriteFailed);
}

fn is_refused<T>(result: Result<T, VaultError>) -> bool {
    matches!(result, Err(VaultError::RecoveryMode))
}

#[test]
fn no_write_gets_through_while_the_vault_is_read_only_and_none_changes_anything() {
    let v = healthy();
    let before = shape(&v.store);
    read_only(&v.store);
    let s = &v.store;

    assert!(is_refused(s.create_profile("FAKE New Person", 10)));
    assert!(is_refused(s.create_folder(
        v.jamie,
        None,
        "FAKE New Folder",
        10
    )));
    assert!(is_refused(s.update_folder(
        v.folder,
        None,
        "FAKE Renamed Folder"
    )));
    assert!(is_refused(s.rename_profile(
        v.robin,
        "FAKE Renamed Person",
        10
    )));
    assert!(is_refused(s.assign_folders(v.record, vec![v.folder])));
    assert!(is_refused(
        s.assign_folders_batch(vec![v.record], vec![v.folder])
    ));
    assert!(is_refused(s.move_to_profile(
        vec![v.record],
        v.robin,
        vec![]
    )));
    assert!(is_refused(s.hide_record(v.record, 10)));
    assert!(is_refused(s.unhide_record(v.record)));
    assert!(is_refused(s.hide_profile(v.robin, 10)));
    assert!(is_refused(s.restore_profile(v.robin)));
    assert!(is_refused(s.ensure_import_allowed(v.jamie)));
    assert!(is_refused(s.import(
        v.jamie,
        vec![],
        vec![source("FAKE Second Letter.pdf", b"FAKE-SECOND")],
        10
    )));
    assert!(is_refused(s.change_passphrase(
        PASSWORD,
        "another FAKE passphrase 5521 horse"
    )));
    assert!(is_refused(s.begin_recovery_key(PASSWORD)));
    // Even with no key waiting to be confirmed, the refusal is the read-only one, not "no key".
    assert!(is_refused(s.confirm_recovery_key(&[(0, "AAAA")], 10)));
    assert!(is_refused(s.save_ai_result(
        v.record,
        AiResultInput {
            tool: AiTool::Summary,
            lang: "en".to_owned(),
            term: None,
            model_name: "FAKE model".to_owned(),
            model_sha256: "a".repeat(64),
        },
        b"FAKE summary",
        10
    )));

    assert_eq!(shape(s), before, "a refused write must change nothing");
}

#[test]
fn a_documents_bytes_can_still_be_saved_while_the_vault_is_read_only() {
    let v = healthy();
    read_only(&v.store);
    let mut sink: Vec<u8> = Vec::new();
    v.store.export(v.record, &mut sink).unwrap();
    assert_eq!(sink, b"FAKE-LETTER-BYTES");
}

#[test]
fn a_hand_over_package_is_neither_made_nor_previewed_while_the_vault_is_read_only() {
    let v = healthy();
    let (key, _) = generate_package_key();
    let options = ExportOptions {
        include_history: true,
    };
    // The same call works on the healthy vault, so the refusal below is the mode, not the input.
    v.store.profile_export_preview(v.jamie, options).unwrap();
    let before = shape(&v.store);
    read_only(&v.store);

    let mut sink: Vec<u8> = Vec::new();
    assert!(is_refused(v.store.export_profile(
        v.jamie,
        options,
        PackageSecret::Key(&key),
        &mut sink,
        20
    )));
    assert!(sink.is_empty(), "nothing is written before the refusal");
    assert!(is_refused(v.store.profile_export_preview(v.jamie, options)));
    assert!(is_refused(
        v.store.check_export(v.jamie, PackageSecret::Key(&key))
    ));
    assert_eq!(shape(&v.store), before);
}

#[test]
fn a_package_can_be_inspected_but_not_imported_while_the_vault_is_read_only() {
    let giver = healthy();
    let (key, _) = generate_package_key();
    let written = giver
        .store
        .export_profile(
            giver.jamie,
            ExportOptions {
                include_history: true,
            },
            PackageSecret::Key(&key),
            Vec::new(),
            20,
        )
        .unwrap();
    let bytes = written.sink;

    let temp = tempfile::tempdir().unwrap();
    let receiver = VaultStore::new(temp.path().join("vault"));
    receiver.create(PASSWORD, "FAKE Receiver", 1).unwrap();
    let before = shape(&receiver);
    read_only(&receiver);

    // Looking is allowed: the patient can see what a file holds.
    assert!(receiver
        .inspect_profile_package(Cursor::new(bytes.clone()), PackageSecret::Key(&key))
        .is_ok());
    // Making a person from it is not.
    let options = ImportOptions {
        display_name: None,
        allow_duplicate: false,
    };
    assert!(is_refused(receiver.import_profile_package(
        Cursor::new(bytes.clone()),
        PackageSecret::Key(&key),
        &options,
        30
    )));
    assert_eq!(shape(&receiver), before, "nothing was made");

    // A wrong key is refused as a wrong key, whatever the mode; it never reaches the vault.
    let (other, _) = generate_package_key();
    let wrong = receiver.import_profile_package(
        Cursor::new(bytes),
        PackageSecret::Key(&other),
        &options,
        30,
    );
    assert!(matches!(wrong, Err(ref error) if !matches!(error, VaultError::RecoveryMode)));
    assert_eq!(shape(&receiver), before);
}

#[test]
fn a_package_is_refused_by_a_locked_vault_after_it_has_been_read_with_the_right_key() {
    let giver = healthy();
    let (key, _) = generate_package_key();
    let bytes = giver
        .store
        .export_profile(
            giver.jamie,
            ExportOptions {
                include_history: false,
            },
            PackageSecret::Key(&key),
            Vec::new(),
            20,
        )
        .unwrap()
        .sink;
    let temp = tempfile::tempdir().unwrap();
    let receiver = VaultStore::new(temp.path().join("vault"));
    receiver.create(PASSWORD, "FAKE Receiver", 1).unwrap();
    receiver.lock();

    assert!(matches!(
        receiver.inspect_profile_package(Cursor::new(bytes.clone()), PackageSecret::Key(&key)),
        Err(VaultError::Locked)
    ));
    assert!(matches!(
        receiver.import_profile_package(
            Cursor::new(bytes),
            PackageSecret::Key(&key),
            &ImportOptions {
                display_name: None,
                allow_duplicate: false
            },
            30
        ),
        Err(VaultError::Locked)
    ));
}

#[test]
fn a_restore_needs_a_locked_vault_and_the_say_so_to_replace_and_a_wrong_secret_changes_nothing() {
    let v = healthy();
    let dir = tempfile::tempdir().unwrap();
    let backup = dir.path().join("FAKE.mycarlosbackup");
    v.store.backup_atomic(&backup, 50).unwrap();
    let before = shape(&v.store);
    let open = || std::fs::File::open(&backup).unwrap();

    // A vault that is open is not restored over: it would be replaced under the patient's hands.
    assert!(matches!(
        v.store
            .restore(open(), RestoreCredential::Passphrase(PASSWORD), true),
        Err(VaultError::Invalid)
    ));
    assert_eq!(shape(&v.store), before);

    // Locked, a vault that is there is replaced only when the caller says so.
    v.store.lock();
    assert!(matches!(
        v.store
            .restore(open(), RestoreCredential::Passphrase(PASSWORD), false),
        Err(VaultError::AlreadyExists)
    ));
    // And a secret that does not open the backup leaves the vault exactly as it was.
    assert!(matches!(
        v.store.restore(
            open(),
            RestoreCredential::Passphrase("a different FAKE passphrase 4410 river"),
            true
        ),
        Err(VaultError::WrongPassphrase)
    ));
    // A recovery key: a well-formed one the backup does not have is a wrong key; one that is not a
    // key at all is a typo.
    let other_key = encode_recovery_key(&[9_u8; RECOVERY_KEY_BYTES]);
    assert!(matches!(
        v.store
            .restore(open(), RestoreCredential::RecoveryKey(&other_key), true),
        Err(VaultError::WrongRecoveryKey)
    ));
    assert!(matches!(
        v.store.restore(
            open(),
            RestoreCredential::RecoveryKey("not a recovery key"),
            true
        ),
        Err(VaultError::RecoveryKeyTypo)
    ));
    v.store.unlock(PASSWORD).unwrap();
    assert_eq!(shape(&v.store), before);
}

#[test]
fn a_folder_refuses_a_parent_that_is_missing_another_persons_itself_or_below_it_and_changes_nothing(
) {
    let v = healthy();
    let child = v
        .store
        .create_folder(v.jamie, Some(v.folder), "FAKE Child Folder", 5)
        .unwrap();
    let grandchild = v
        .store
        .create_folder(v.jamie, Some(child), "FAKE Grandchild Folder", 7)
        .unwrap();
    let robins = v
        .store
        .create_folder(v.robin, None, "FAKE Robin Folder", 6)
        .unwrap();
    let before = shape(&v.store);
    let s = &v.store;

    // Making one.
    assert!(matches!(
        s.create_folder(v.jamie, Some(Uuid::new_v4()), "FAKE New", 10),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        s.create_folder(v.jamie, Some(robins), "FAKE New", 10),
        Err(VaultError::Invalid)
    ));
    // Changing one.
    assert!(matches!(
        s.update_folder(Uuid::new_v4(), None, "FAKE Renamed"),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        s.update_folder(v.folder, Some(v.folder), "FAKE Renamed"),
        Err(VaultError::Invalid)
    ));
    assert!(matches!(
        s.update_folder(v.folder, Some(Uuid::new_v4()), "FAKE Renamed"),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        s.update_folder(child, Some(robins), "FAKE Renamed"),
        Err(VaultError::Invalid)
    ));
    // A folder cannot move under what it holds, at any depth: that would be a loop.
    assert!(matches!(
        s.update_folder(v.folder, Some(child), "FAKE Renamed"),
        Err(VaultError::Invalid)
    ));
    assert!(matches!(
        s.update_folder(v.folder, Some(grandchild), "FAKE Renamed"),
        Err(VaultError::Invalid)
    ));
    assert!(matches!(
        s.update_folder(child, Some(grandchild), "FAKE Renamed"),
        Err(VaultError::Invalid)
    ));
    assert_eq!(shape(s), before);
    // And a move that is no loop still works, so the refusals above are not a blanket.
    s.update_folder(grandchild, Some(v.folder), "FAKE Grandchild Folder")
        .unwrap();
    assert_ne!(shape(s), before);
}

#[test]
fn a_filing_names_at_least_one_document_and_at_most_the_most_folders_and_nothing_else_changes() {
    let v = healthy();
    let before = shape(&v.store);
    assert!(matches!(
        v.store.assign_folders_batch(vec![], vec![v.folder]),
        Err(VaultError::Invalid)
    ));
    let too_many: Vec<Uuid> = (0..=MAX_FOLDER_ASSIGNMENTS)
        .map(|_| Uuid::new_v4())
        .collect();
    assert!(matches!(
        v.store
            .assign_folders_batch(vec![v.record], too_many.clone()),
        Err(VaultError::Invalid)
    ));
    // The same through the single-document form, and over the most documents.
    assert!(matches!(
        v.store.assign_folders(v.record, too_many),
        Err(VaultError::Invalid)
    ));
    assert!(matches!(
        v.store
            .assign_folders_batch(vec![v.record; MAX_FOLDER_ASSIGNMENTS + 1], vec![v.folder]),
        Err(VaultError::Invalid)
    ));
    // The count itself: the most is allowed, one more is not.
    assert!(validate_folder_assignment_count(MAX_FOLDER_ASSIGNMENTS).is_ok());
    assert!(matches!(
        validate_folder_assignment_count(MAX_FOLDER_ASSIGNMENTS + 1),
        Err(VaultError::Invalid)
    ));
    assert_eq!(shape(&v.store), before);
    // Exactly the most is accepted (the repeats of one real folder or document count in full, then
    // collapse), so the refusals above are the count and nothing else.
    v.store
        .assign_folders(v.record, vec![v.folder; MAX_FOLDER_ASSIGNMENTS])
        .unwrap();
    v.store
        .assign_folders_batch(vec![v.record; MAX_FOLDER_ASSIGNMENTS], vec![v.folder])
        .unwrap();
}

#[test]
fn hiding_what_is_hidden_or_restoring_what_is_visible_is_not_a_second_change() {
    let v = healthy();
    v.store.unhide_record(v.record).unwrap(); // already visible: nothing to do
    let visible = shape(&v.store);
    v.store.hide_record(v.record, 10).unwrap();
    let hidden = shape(&v.store);
    assert_ne!(hidden, visible, "hiding changed something");
    // Again, later: still hidden, and the first time is not overwritten.
    v.store.hide_record(v.record, 20).unwrap();
    assert_eq!(shape(&v.store), hidden);
    v.store.unhide_record(v.record).unwrap();
    assert_eq!(shape(&v.store), visible);
}

#[test]
fn a_passphrase_over_the_limit_is_refused_before_anything_is_tried_and_the_old_one_still_opens() {
    let v = healthy();
    let too_long = "a".repeat(MAX_PASSPHRASE_BYTES + 1);
    let before = shape(&v.store);
    assert!(matches!(
        v.store
            .change_passphrase(&too_long, "another FAKE passphrase 5521 horse"),
        Err(VaultError::Invalid)
    ));
    assert!(matches!(
        v.store.begin_recovery_key(&too_long),
        Err(VaultError::Invalid)
    ));
    // A NEW passphrase one byte over the limit is refused outright; exactly the limit is not
    // refused for its size (its strength is another rule).
    assert!(matches!(
        v.store
            .change_passphrase(PASSWORD, &"a".repeat(MAX_PASSPHRASE_BYTES + 1)),
        Err(VaultError::Invalid)
    ));
    assert!(matches!(
        judge_new_passphrase(&"a".repeat(MAX_PASSPHRASE_BYTES + 1), &[], true),
        Err(VaultError::Invalid)
    ));
    assert!(judge_new_passphrase(&"a".repeat(MAX_PASSPHRASE_BYTES), &[], true).is_ok());
    assert_eq!(shape(&v.store), before);
    v.store.lock();
    v.store.unlock(PASSWORD).unwrap();
    assert_eq!(shape(&v.store), before);
}

#[test]
fn importing_nothing_is_not_an_import_even_when_the_vault_is_read_only() {
    let v = healthy();
    let before = shape(&v.store);
    read_only(&v.store);
    let outcome = v.store.import(v.jamie, vec![], vec![], 10).unwrap();
    assert!(outcome.imported.is_empty() && outcome.skipped_duplicates.is_empty());
    assert_eq!(shape(&v.store), before);
}

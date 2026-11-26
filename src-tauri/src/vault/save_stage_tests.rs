//! The staging folder of a save to a place the patient chose (a recovery kit, a backup, a
//! hand-over package): it is journaled, it is gone when the save ends however it ends, and the
//! next start removes only what the journal names. FAKE data only.
//!
//! What is pinned: a kit and a backup that are saved leave only the file and no journal entry; a
//! save that fails leaves nothing; a save the process died in is removed at the next start, with
//! its partly written file, while a folder with a similar name that the journal does not name, a
//! `.atomicwrite…` folder of another program, and an ordinary file beside it are not touched; a
//! save still running in this process is skipped; and, on Windows, the kit is marked as not to be
//! indexed.
use super::*;

const PASSWORD: &str = "correct horse battery staple 9173";

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    out: PathBuf,
    store: VaultStore,
}

/// An unlocked vault of FAKE Jamie with one document, and an empty folder to save into.
fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("home").join("vault");
    let out = temp.path().join("out");
    fs::create_dir(&out).unwrap();
    let store = VaultStore::new(root.clone());
    store.create(PASSWORD, "FAKE Jamie", 1).unwrap();
    let jamie = store.snapshot().unwrap().profiles[0].id;
    store
        .import(
            jamie,
            vec![],
            vec![ImportSource {
                display_name: "FAKE Letter.pdf".to_owned(),
                reader: Box::new(std::io::Cursor::new(b"FAKE-LETTER-BYTES".to_vec())),
            }],
            2,
        )
        .unwrap();
    Fixture {
        _temp: temp,
        root,
        out,
        store,
    }
}

fn names_in(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn journal_entries(root: &Path) -> usize {
    let journal = vault_home(root).unwrap().join(EXPORT_JOURNAL);
    if journal.exists() {
        fs::read_dir(journal).unwrap().count()
    } else {
        0
    }
}

/// What a process that died during a save leaves: the stage, its journal entry and a partly
/// written file, with nothing in this process still using it.
fn die_during_a_save(f: &Fixture, destination: &Path) -> PathBuf {
    let stage = SaveStage::begin(&f.root, destination).unwrap();
    let dir = stage.dir().to_path_buf();
    fs::write(dir.join("partly-written.tmp"), b"FAKE-PARTLY-WRITTEN-KIT").unwrap();
    let id = Uuid::parse_str(
        dir.file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .strip_prefix(EXPORT_STAGE_PREFIX)
            .unwrap(),
    )
    .unwrap();
    std::mem::forget(stage);
    EXPORTS_IN_FLIGHT.lock().unwrap().remove(&id);
    dir
}

#[test]
fn a_saved_kit_and_a_saved_backup_leave_only_their_file_and_no_journal_entry() {
    let f = fixture();
    f.store.begin_recovery_key(PASSWORD).unwrap();
    let kit = f.out.join("kit.txt");
    f.store.save_recovery_kit(&kit, 1).unwrap();
    assert_eq!(names_in(&f.out), ["kit.txt"]);
    assert_eq!(journal_entries(&f.root), 0);
    let backup = f.out.join("backup.mycarlosbackup");
    f.store.backup_atomic(&backup, 3).unwrap();
    assert_eq!(names_in(&f.out), ["backup.mycarlosbackup", "kit.txt"]);
    assert_eq!(journal_entries(&f.root), 0);
    assert!(fs::read_to_string(&kit)
        .unwrap()
        .contains("myCarlos recovery kit"));
}

#[test]
fn a_save_that_fails_leaves_no_folder_and_no_journal_entry_and_the_place_as_it_was() {
    let f = fixture();
    f.store.begin_recovery_key(PASSWORD).unwrap();
    // A folder where the file should go: the rename cannot succeed.
    let taken = f.out.join("kit.txt");
    fs::create_dir(&taken).unwrap();
    fs::write(taken.join("keep.txt"), b"FAKE-KEPT").unwrap();
    assert!(f.store.save_recovery_kit(&taken, 1).is_err());
    assert_eq!(names_in(&f.out), ["kit.txt"]);
    assert_eq!(names_in(&taken), ["keep.txt"]);
    assert_eq!(journal_entries(&f.root), 0);
}

#[test]
fn a_save_the_process_died_in_is_removed_at_the_next_start_with_its_partly_written_file() {
    let f = fixture();
    let destination = f.out.join("kit.txt");
    let stage = die_during_a_save(&f, &destination);
    assert!(stage.join("partly-written.tmp").exists());
    assert_eq!(journal_entries(&f.root), 1);

    remove_abandoned_exports(&vault_home(&f.root).unwrap());
    assert!(!stage.exists());
    assert_eq!(journal_entries(&f.root), 0);
    assert!(names_in(&f.out).is_empty());
}

#[test]
fn the_next_start_removes_only_the_folders_the_journal_names() {
    let f = fixture();
    let destination = f.out.join("kit.txt");
    let named = die_during_a_save(&f, &destination);
    // Another program's temporary folder from the same crate, a folder named like ours that no
    // journal entry names, and an ordinary file: none is ours to remove.
    let other_program = f.out.join(".atomicwrite8Xk2Pq");
    fs::create_dir(&other_program).unwrap();
    fs::write(other_program.join("tmpfile.tmp"), b"FAKE-OTHER").unwrap();
    let unnamed = f
        .out
        .join(format!("{EXPORT_STAGE_PREFIX}{}", Uuid::new_v4()));
    fs::create_dir(&unnamed).unwrap();
    fs::write(unnamed.join("x"), b"FAKE-UNNAMED").unwrap();
    fs::write(f.out.join("notes.txt"), b"FAKE-NOTES").unwrap();

    remove_abandoned_exports(&vault_home(&f.root).unwrap());
    assert!(!named.exists());
    assert!(other_program.join("tmpfile.tmp").exists());
    assert!(unnamed.join("x").exists());
    assert!(f.out.join("notes.txt").exists());
}

#[test]
fn a_save_still_running_here_is_not_removed_by_the_sweep() {
    let f = fixture();
    let destination = f.out.join("kit.txt");
    let running = SaveStage::begin(&f.root, &destination).unwrap();
    fs::write(running.dir().join("tmpfile.tmp"), b"FAKE-IN-PROGRESS").unwrap();

    remove_abandoned_exports(&vault_home(&f.root).unwrap());
    assert!(running.dir().join("tmpfile.tmp").exists());
    assert_eq!(journal_entries(&f.root), 1);

    let dir = running.dir().to_path_buf();
    drop(running);
    assert!(!dir.exists());
    assert_eq!(journal_entries(&f.root), 0);
}

#[test]
fn the_stage_is_made_beside_the_destination_so_the_rename_stays_on_one_volume() {
    let f = fixture();
    let destination = f.out.join("backup.mycarlosbackup");
    let stage = SaveStage::begin(&f.root, &destination).unwrap();
    assert_eq!(stage.dir().parent(), Some(f.out.as_path()));
    assert!(is_export_stage_name(stage.dir()));
}

#[test]
fn a_save_into_a_missing_folder_refuses_and_journals_nothing_that_lingers() {
    let f = fixture();
    let destination = f.out.join("missing").join("kit.txt");
    assert!(SaveStage::begin(&f.root, &destination).is_err());
    assert_eq!(journal_entries(&f.root), 0);
}

#[test]
fn the_kit_is_asked_to_stay_out_of_the_windows_search_index() {
    // The attribute is the Windows value for "not content indexed".
    assert_eq!(FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, 0x2000);
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let f = fixture();
        f.store.begin_recovery_key(PASSWORD).unwrap();
        let kit = f.out.join("kit.txt");
        f.store.save_recovery_kit(&kit, 1).unwrap();
        let attributes = fs::metadata(&kit).unwrap().file_attributes();
        assert_ne!(attributes & FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, 0);
    }
}

/// Runs `save` with an observer at `boundary`, which is reached while the file is being written,
/// and says what the destination folder and the journal held at that moment.
fn seen_during(
    f: &Fixture,
    boundary: &'static str,
    save: impl FnOnce(&Fixture) -> Result<(), VaultError>,
) -> (Vec<String>, usize) {
    let seen = std::rc::Rc::new(std::cell::RefCell::new(None));
    let observer = {
        let seen = std::rc::Rc::clone(&seen);
        let out = f.out.clone();
        let root = f.root.clone();
        Box::new(move || {
            *seen.borrow_mut() = Some((names_in(&out), journal_entries(&root)));
        })
    };
    AT_TEST_BOUNDARY.with(|slot| *slot.borrow_mut() = Some((boundary, observer)));
    save(f).unwrap();
    let result = seen.borrow_mut().take();
    result.expect("the boundary inside the save was never reached")
}

/// While a file is being written its temporary file is inside one journaled staging folder: the
/// only thing beside the destination, no `.atomicwrite…` folder of the crate's own.
fn assert_staged_and_journaled((names, entries): (Vec<String>, usize)) {
    assert_eq!(
        entries, 1,
        "the save is in the journal while it runs: {names:?}"
    );
    assert_eq!(names.len(), 1, "only the stage is beside it: {names:?}");
    assert!(
        names[0].starts_with(EXPORT_STAGE_PREFIX),
        "not a stage: {names:?}"
    );
}

#[test]
fn a_kit_is_written_inside_a_journaled_stage_not_a_folder_of_the_crates_own() {
    let f = fixture();
    f.store.begin_recovery_key(PASSWORD).unwrap();
    let seen = seen_during(&f, "save.kit.during", |f| {
        f.store.save_recovery_kit(&f.out.join("kit.txt"), 1)
    });
    assert_staged_and_journaled(seen);
}

#[test]
fn a_backup_is_written_inside_a_journaled_stage_not_a_folder_of_the_crates_own() {
    let f = fixture();
    let seen = seen_during(&f, "save.backup.during", |f| {
        f.store.backup_atomic(&f.out.join("b.mycarlosbackup"), 3)
    });
    assert_staged_and_journaled(seen);
}

#[test]
fn a_hand_over_package_is_written_inside_a_journaled_stage_not_a_folder_of_the_crates_own() {
    use crate::vault::profile_export::ExportOptions;
    use crate::vault::profile_package::{generate_package_key, PackageSecret};
    let f = fixture();
    let jamie = f.store.snapshot().unwrap().profiles[0].id;
    let (key, _) = generate_package_key();
    let seen = seen_during(&f, "save.package.during", |f| {
        f.store
            .export_profile_atomic(
                jamie,
                ExportOptions {
                    include_history: false,
                },
                PackageSecret::Key(&key),
                &f.out.join("h.mycarlosprofile"),
                4,
            )
            .map(|_| ())
    });
    assert_staged_and_journaled(seen);
    assert_eq!(names_in(&f.out), ["h.mycarlosprofile"]);
    assert_eq!(journal_entries(&f.root), 0);
}

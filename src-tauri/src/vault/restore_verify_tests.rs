//! Error branches of the vault that no test reached (coverage gap #5 of the Rust coverage report):
//! `verify_object_controlled` on damaged or unreadable objects, the failures of a restore after the
//! backup itself was authenticated, `connect_portal` and its refusals before any request is sent,
//! and the notification status plumbing of the store. Tests only; every case drives the real code.
//!
//! The synthetic names and passphrase here are made up for these tests.

use super::*;
use crate::document_collection::CycleControl;
use std::io::Cursor;

const PASSWORD: &str = "orchard-lantern-basalt-quiver-318";
/// A portal code of the right shape (18 characters of the code alphabet, as typed with dashes).
const CODE: &str = "0123-4567-89AB-CDEF-GH";

fn object_context() -> (Uuid, Uuid, ObjectContext) {
    let (vault_id, record_id) = (Uuid::new_v4(), Uuid::new_v4());
    let context = ObjectContext {
        vault_id,
        record_id,
        profile_id: Uuid::new_v4(),
    };
    (vault_id, record_id, context)
}

/// An object file of `length` bytes of plaintext, and what is needed to verify it.
fn stored_object(dir: &Path, length: usize) -> (PathBuf, Uuid, Uuid) {
    let (vault_id, record_id, context) = object_context();
    let path = dir.join("object.mcobj");
    encrypt_object(
        Box::new(Cursor::new(vec![0x5a_u8; length])),
        &path,
        context,
        &[0x31_u8; 32],
        &[0x32_u8; 32],
    )
    .unwrap();
    (path, vault_id, record_id)
}

fn verify(path: &Path, vault_id: Uuid, record_id: Uuid, size: u64) -> Result<(), VaultError> {
    verify_object(path, io::sink(), vault_id, record_id, &[0x31_u8; 32], size)
}

mod verify_object_errors {
    use super::*;

    #[test]
    fn an_object_that_is_there_and_whole_verifies() {
        let temp = tempfile::tempdir().unwrap();
        let (path, vault, record) = stored_object(temp.path(), 5000);
        verify(&path, vault, record, 5000).unwrap();
        // The size the manifest recorded is part of what is checked.
        assert!(matches!(
            verify(&path, vault, record, 4999),
            Err(VaultError::Corrupt)
        ));
    }

    #[test]
    fn an_object_that_is_gone_is_damage_not_a_storage_failure() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("gone.mcobj");
        assert!(matches!(
            verify(&missing, Uuid::new_v4(), Uuid::new_v4(), 0),
            Err(VaultError::Corrupt)
        ));
    }

    #[test]
    fn something_that_is_not_a_regular_file_in_the_objects_place_is_damage() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("a-directory.mcobj");
        fs::create_dir(&directory).unwrap();
        assert!(matches!(
            verify(&directory, Uuid::new_v4(), Uuid::new_v4(), 0),
            Err(VaultError::Corrupt)
        ));
        #[cfg(unix)]
        {
            let (path, vault, record) = stored_object(temp.path(), 10);
            let link = temp.path().join("a-link.mcobj");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(matches!(
                verify(&link, vault, record, 10),
                Err(VaultError::Corrupt)
            ));
        }
    }

    #[test]
    fn a_path_that_cannot_be_looked_at_is_a_storage_failure_a_retry_can_get_past() {
        // The object's folder is a file: neither "not found" nor "not a regular file", so not damage.
        let temp = tempfile::tempdir().unwrap();
        let blocker = temp.path().join("not-a-folder");
        fs::write(&blocker, b"x").unwrap();
        assert!(matches!(
            verify(
                &blocker.join("object.mcobj"),
                Uuid::new_v4(),
                Uuid::new_v4(),
                0
            ),
            Err(VaultError::Storage)
        ));
    }

    #[test]
    fn an_object_written_for_another_chunk_size_is_damage() {
        let temp = tempfile::tempdir().unwrap();
        for size in [
            0_u32,
            1,
            CHUNK_SIZE as u32 - 1,
            CHUNK_SIZE as u32 + 1,
            u32::MAX,
        ] {
            let path = temp.path().join("odd.mcobj");
            let mut bytes = OBJECT_MAGIC.to_vec();
            bytes.extend_from_slice(&size.to_be_bytes());
            bytes.extend_from_slice(&[7_u8; 16]);
            fs::write(&path, bytes).unwrap();
            assert!(
                matches!(
                    verify(&path, Uuid::new_v4(), Uuid::new_v4(), 0),
                    Err(VaultError::Corrupt)
                ),
                "chunk size {size}"
            );
        }
    }

    #[test]
    fn an_object_with_a_changed_byte_anywhere_is_damage() {
        let temp = tempfile::tempdir().unwrap();
        let (path, vault, record) = stored_object(temp.path(), 3000);
        let original = fs::read(&path).unwrap();
        for at in [0, 6, 12, 25, 26, 30, original.len() / 2, original.len() - 1] {
            let mut changed = original.clone();
            changed[at] ^= 0x01;
            fs::write(&path, &changed).unwrap();
            assert!(
                verify(&path, vault, record, 3000).is_err(),
                "byte {at} changed"
            );
        }
        // Extra bytes after the last chunk are damage too.
        let mut longer = original.clone();
        longer.push(0);
        fs::write(&path, longer).unwrap();
        assert!(matches!(
            verify(&path, vault, record, 3000),
            Err(VaultError::Corrupt)
        ));
        fs::write(&path, &original).unwrap();
        verify(&path, vault, record, 3000).unwrap();
    }

    #[test]
    fn a_stopped_collection_cycle_stops_the_verification_and_never_calls_it_damage() {
        let temp = tempfile::tempdir().unwrap();
        let (path, vault, record) = stored_object(temp.path(), 200_000);
        let key = [0x31_u8; 32];
        // The byte budget runs out inside the header, between chunks and inside a chunk.
        for budget in [3_usize, 12, 29, 40, 100_000] {
            let control = CycleControl::with_physical_remaining(budget);
            let result = verify_object_controlled(
                &path,
                io::sink(),
                vault,
                record,
                &key,
                200_000,
                Some(&control),
            );
            assert!(
                matches!(result, Err(VaultError::Cancelled)),
                "budget {budget}: {result:?}"
            );
        }
        // With enough budget the same object verifies under a control.
        let control = CycleControl::with_physical_remaining(10_000_000);
        verify_object_controlled(
            &path,
            io::sink(),
            vault,
            record,
            &key,
            200_000,
            Some(&control),
        )
        .unwrap();
    }
}

mod restore_failures {
    use super::*;

    fn source(name: &str, data: &[u8]) -> ImportSource {
        ImportSource {
            display_name: name.to_owned(),
            reader: Box::new(Cursor::new(data.to_vec())),
        }
    }

    /// A vault with two documents, a recovery key is not needed here.
    fn vault_with_documents(root: &Path) -> VaultStore {
        let store = VaultStore::new(root.to_path_buf());
        store.create(PASSWORD, "FAKE Person", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        store
            .import(
                profile,
                vec![],
                vec![
                    source("first.pdf", b"first synthetic record"),
                    source("second.pdf", b"second synthetic record"),
                ],
                2,
            )
            .unwrap();
        store
    }

    fn leftovers(root: &Path) -> Vec<String> {
        fs::read_dir(root.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| {
                name.starts_with(RESTORE_STAGE_PREFIX) || name.ends_with(".restore-ready")
            })
            .collect()
    }

    #[test]
    fn a_document_damaged_on_disk_stops_the_backup_before_it_is_made_and_names_the_document() {
        // The backup authenticates every document first, so a restore never meets one that does not
        // (the check inside a restore is a second line of defence behind this one).
        let temp = tempfile::tempdir().unwrap();
        let from = temp.path().join("from").join("vault");
        let store = vault_with_documents(&from);
        let before: Vec<_> = {
            let mut ids: Vec<_> = store
                .snapshot()
                .unwrap()
                .records
                .iter()
                .map(|record| record.id)
                .collect();
            ids.sort();
            ids
        };
        for entry in fs::read_dir(from.join("objects")).unwrap() {
            let path = entry.unwrap().path();
            let mut bytes = fs::read(&path).unwrap();
            let middle = bytes.len() / 2;
            bytes[middle] ^= 0x40;
            fs::write(&path, bytes).unwrap();
        }
        let mut backup = Vec::new();
        match store.backup(&mut backup, 3) {
            Err(VaultError::DamagedDocument(id)) => assert!(before.contains(&id)),
            other => panic!("expected a damaged document, got {other:?}"),
        }
        // Nothing of a restore was started anywhere.
        assert!(leftovers(&from).is_empty());
    }

    #[test]
    #[allow(clippy::disallowed_methods)] // Removes a blocking file the test made in its own temp folder; no patient vault.
    fn a_restore_that_cannot_put_the_verified_copy_in_place_reports_it_and_leaves_no_stage() {
        let temp = tempfile::tempdir().unwrap();
        let from = temp.path().join("from").join("vault");
        let store = vault_with_documents(&from);
        let mut backup = Vec::new();
        store.backup(&mut backup, 3).unwrap();
        // The device has no vault; the name the verified copy takes is a file, which a directory
        // cannot be renamed onto.
        let to = temp.path().join("to").join("vault");
        let fresh = VaultStore::new(to.clone());
        let ready = restore_ready_path(&to).unwrap();
        fs::create_dir_all(ready.parent().unwrap()).unwrap();
        fs::write(&ready, b"in the way").unwrap();
        let result = fresh.restore(
            Cursor::new(backup.clone()),
            RestoreCredential::Passphrase(PASSWORD),
            false,
        );
        assert!(result.is_err(), "{result:?}");
        assert!(!to.exists(), "nothing was put in place");
        assert!(
            leftovers(&to)
                .iter()
                .all(|name| name.ends_with(".restore-ready")),
            "no stage is left behind: {:?}",
            leftovers(&to)
        );
        // Once what was in the way is gone, the same backup restores.
        fs::remove_file(&ready).unwrap();
        fresh
            .restore(
                Cursor::new(backup),
                RestoreCredential::Passphrase(PASSWORD),
                false,
            )
            .unwrap();
        fresh.unlock(PASSWORD).unwrap();
        assert_eq!(fresh.snapshot().unwrap().records.len(), 2);
    }
}

mod portal_connection {
    use super::*;
    use portal_link::LinkError;

    fn open_store(dir: &Path) -> VaultStore {
        let store = VaultStore::new(dir.join("vault"));
        store.create(PASSWORD, "FAKE Person", 1).unwrap();
        store
    }

    fn refused(
        result: Result<(portal_link::LinkSummary, Option<VaultError>), VaultError>,
    ) -> LinkError {
        match result {
            Err(VaultError::Portal(error)) => error,
            other => panic!("expected a portal refusal, got {:?}", other.map(|_| ())),
        }
    }

    #[test]
    fn connecting_with_a_portal_code_or_name_that_cannot_be_right_is_refused_before_any_request() {
        let temp = tempfile::tempdir().unwrap();
        let store = open_store(temp.path());
        let session = store.portal_session.load(Ordering::Acquire);
        let before = store.snapshot().unwrap().portal_links.len();
        // A portal that is not a clean https address.
        for portal in [
            "http://clinic.example",
            "",
            "clinic.example/path?x=1",
            "ftp://x",
        ] {
            assert!(
                matches!(
                    refused(store.connect_portal(portal, CODE, "FAKE Laptop", None, 5, session)),
                    LinkError::InvalidPortal
                ),
                "{portal:?}"
            );
        }
        // A code that is not ASCII or is far too long.
        for code in [
            "éééé-éééé",
            &"A".repeat(200),
            "ABCD-EFGH-JKMN",
            "0123-4567-89AB-CDEF-GU",
        ] {
            assert!(matches!(
                refused(store.connect_portal(
                    "https://clinic.example",
                    code,
                    "FAKE Laptop",
                    None,
                    5,
                    session
                )),
                LinkError::InvalidCode
            ));
        }
        // A device name that is empty or too long.
        for name in ["", &"n".repeat(65)] {
            assert!(matches!(
                refused(store.connect_portal(
                    "https://clinic.example",
                    CODE,
                    name,
                    None,
                    5,
                    session
                )),
                LinkError::InvalidDeviceName
            ));
        }
        assert_eq!(
            store.snapshot().unwrap().portal_links.len(),
            before,
            "a refused connection leaves no pending link"
        );
    }

    #[test]
    fn a_connection_for_a_session_that_has_ended_is_cancelled_and_one_in_progress_is_busy() {
        let temp = tempfile::tempdir().unwrap();
        let store = open_store(temp.path());
        let session = store.portal_session.load(Ordering::Acquire);
        assert!(matches!(
            refused(store.connect_portal(
                "https://clinic.example",
                CODE,
                "FAKE Laptop",
                None,
                5,
                session.wrapping_add(1)
            )),
            LinkError::Cancelled
        ));
        // Another portal operation holds the one place for portal work: this one waits for nothing.
        let held = store.start_portal_work().unwrap();
        assert!(matches!(
            refused(store.connect_portal(
                "https://clinic.example",
                CODE,
                "FAKE Laptop",
                None,
                5,
                session
            )),
            LinkError::Busy
        ));
        assert!(matches!(
            store.link_portal(
                "https://clinic.example",
                CODE,
                "FAKE Laptop",
                None,
                5,
                session
            ),
            Err(VaultError::Portal(LinkError::Busy))
        ));
        drop(held);
        assert!(store.snapshot().unwrap().portal_links.is_empty());
    }

    #[test]
    fn connecting_while_the_vault_is_locked_or_for_a_person_that_is_not_there_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let store = open_store(temp.path());
        let session = store.portal_session.load(Ordering::Acquire);
        // A person who is not in this vault: nothing is saved, nothing is sent.
        assert!(matches!(
            store.connect_portal(
                "https://clinic.example",
                CODE,
                "FAKE Laptop",
                Some(Uuid::new_v4()),
                5,
                session
            ),
            Err(VaultError::NotFound)
        ));
        assert!(store.snapshot().unwrap().portal_links.is_empty());
        store.lock();
        // Locking ends the session the connection was started under: that is a cancellation...
        assert!(matches!(
            store.connect_portal(
                "https://clinic.example",
                CODE,
                "FAKE Laptop",
                None,
                5,
                session
            ),
            Err(VaultError::Portal(LinkError::Cancelled))
        ));
        // ...and a connection begun now, with the vault locked, finds nothing to save a link in.
        let locked_session = store.portal_session.load(Ordering::Acquire);
        assert!(matches!(
            store.connect_portal(
                "https://clinic.example",
                CODE,
                "FAKE Laptop",
                None,
                5,
                locked_session
            ),
            Err(VaultError::Locked)
        ));
    }
}

mod notification_status {
    use super::*;
    use crate::document_notification_runtime::Status;

    #[test]
    fn a_store_with_no_notification_runtime_says_notices_are_unavailable_and_refuses_changes() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        let status = store.notification_status(None);
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::to_value(Status::unavailable()).unwrap()
        );
        assert!(!status.automatic_checks_paused);
        for enabled in [true, false] {
            assert!(
                matches!(store.set_notifications(enabled), Err(VaultError::Invalid)),
                "enabled={enabled}"
            );
        }
        assert!(!store.automatic_collection_allowed());
    }

    #[test]
    fn the_status_reports_a_paused_collection_and_a_runtime_that_cannot_change_says_storage() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.configure_notifications(temp.path().join("notices.json"), "test.app".to_owned());
        // This build has no operating-system notices to turn on: the runtime says so, and a
        // change is refused as a storage failure, never as success.
        let status = store.notification_status(Some(crate::ui_text::UiLocale::Fr));
        assert!(!status.available);
        assert!(!status.automatic_checks_paused);
        store.collection.set_paused(true);
        assert!(store.notification_status(None).automatic_checks_paused);
        store.collection.set_paused(false);
        assert!(matches!(
            store.set_notifications(true),
            Err(VaultError::Storage)
        ));
        assert!(matches!(
            store.set_notifications(false),
            Err(VaultError::Storage)
        ));
        assert!(!store.automatic_collection_allowed());
    }
}

//! Keeps the app's data out of device backups on iOS (#422, App Store guideline 5.1.3(ii): no
//! personal health information in iCloud).
//!
//! The vault, its manifests and the files beside it are ciphertext, but a backup would still copy
//! them to iCloud or a computer: the vault's existence, sizes and dates, and the header that
//! holds the key wrapping. The patient's own copy is the encrypted backup file they choose to
//! save (`vault_backup_*`), not an operating-system backup (PRIVACY_NOTICE_DRAFT.md).
//!
//! iOS excludes a file or folder from backups when it carries the attribute
//! `com.apple.MobileBackup` = 1, which is what `URLResourceValues.isExcludedFromBackup` sets
//! (Apple QA1719). A folder's flag covers everything inside it, files made later included, so
//! one call on the app's data folder at start is enough. Android is handled by the manifest
//! (`configure-android-security.mjs`); other systems have no such attribute and nothing is done.

use crate::vault::VaultError;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The folder to keep out of backups, set once at start (`configure`).
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Remembers the folder and excludes it. An error here does not stop the app from starting:
/// creating, unlocking and recovering a vault call `ensure`, which refuses while it fails.
pub(crate) fn configure(dir: PathBuf) -> Result<(), VaultError> {
    let _ = DATA_DIR.set(dir);
    ensure()
}

/// Ben's decision: the vault stays out of Apple backups, so when the flag cannot be set the vault
/// is neither created nor opened ("This phone could not keep the vault out of device backups; try
/// again"). The flag is set again on every call, so a failure that goes away stops refusing. Off iOS
/// it is the no-op `keep_out_of_device_backups` is.
pub(crate) fn ensure() -> Result<(), VaultError> {
    ensure_using(|| match DATA_DIR.get() {
        Some(dir) => keep_out_of_device_backups(dir),
        // No folder configured (tests, or before setup): nothing to exclude.
        None => Ok(()),
    })
}

fn ensure_using(attempt: impl FnOnce() -> io::Result<()>) -> Result<(), VaultError> {
    attempt().map_err(|_| VaultError::BackupExclusionFailed)
}

/// The attribute iOS reads as "exclude this from backups".
#[cfg_attr(not(any(target_os = "ios", test)), allow(dead_code))]
const IOS_EXCLUDE_ATTRIBUTE: &str = "com.apple.MobileBackup";

/// Excludes `dir` (made if it is missing) and all it will hold from iOS backups. Nothing on any
/// other platform.
pub(crate) fn keep_out_of_device_backups(dir: &Path) -> io::Result<()> {
    #[cfg(target_os = "ios")]
    {
        std::fs::create_dir_all(dir)?;
        set_flag(dir, IOS_EXCLUDE_ATTRIBUTE)?;
        // Read back: a flag that did not stick is reported, not assumed.
        if flag_is_set(dir, IOS_EXCLUDE_ATTRIBUTE)? {
            Ok(())
        } else {
            Err(io::Error::other("the backup exclusion flag did not stick"))
        }
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = dir;
        Ok(())
    }
}

/// Sets the one-byte flag attribute `name` to 1 on `path`, as iOS expects for its backup flag.
#[cfg(any(target_os = "ios", all(test, unix)))]
fn set_flag(path: &Path, name: &str) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let name = CString::new(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let value = [1u8];
    // SAFETY: both strings are NUL-terminated and `value` is one readable byte.
    #[cfg(target_vendor = "apple")]
    let status = unsafe {
        libc::setxattr(
            path.as_ptr(),
            name.as_ptr(),
            value.as_ptr().cast(),
            value.len(),
            0,
            0,
        )
    };
    // SAFETY: as above.
    #[cfg(not(target_vendor = "apple"))]
    let status = unsafe {
        libc::setxattr(
            path.as_ptr(),
            name.as_ptr(),
            value.as_ptr().cast(),
            value.len(),
            0,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Whether the one-byte flag attribute `name` on `path` is set to 1.
#[cfg(any(target_os = "ios", all(test, unix)))]
fn flag_is_set(path: &Path, name: &str) -> io::Result<bool> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let name = CString::new(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let mut value = [0u8; 4];
    // SAFETY: both strings are NUL-terminated and `value` is four writable bytes.
    #[cfg(target_vendor = "apple")]
    let length = unsafe {
        libc::getxattr(
            path.as_ptr(),
            name.as_ptr(),
            value.as_mut_ptr().cast(),
            value.len(),
            0,
            0,
        )
    };
    // SAFETY: as above.
    #[cfg(not(target_vendor = "apple"))]
    let length = unsafe {
        libc::getxattr(
            path.as_ptr(),
            name.as_ptr(),
            value.as_mut_ptr().cast(),
            value.len(),
        )
    };
    if length < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(length == 1 && value[0] == 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_attribute_is_the_one_ios_reads_as_excluded_from_backup() {
        assert_eq!(IOS_EXCLUDE_ATTRIBUTE, "com.apple.MobileBackup");
    }

    #[test]
    fn a_failed_exclusion_refuses_and_a_later_success_stops_refusing() {
        let fail = || Err(io::Error::other("FAKE the attribute could not be set"));
        assert!(matches!(
            ensure_using(fail),
            Err(VaultError::BackupExclusionFailed)
        ));
        // Retried on every call: nothing is remembered between them.
        assert!(ensure_using(|| Ok(())).is_ok());
        assert!(matches!(
            ensure_using(fail),
            Err(VaultError::BackupExclusionFailed)
        ));
    }

    #[test]
    fn the_refusal_is_said_in_its_own_words() {
        let public = crate::PublicError::from(VaultError::BackupExclusionFailed);
        assert_eq!(public.code, "backup_exclusion_failed");
        assert_eq!(public.message_key, "native.backupExclusionFailed");
        assert!(crate::ui_text_ids::MessageId::from_legacy_key(public.message_key).is_some());
    }

    /// Creating, unlocking, recovering and restoring a vault refuse before anything is read or
    /// written: right after the store is pinned (the multi-vault seam's first statement, which
    /// `vault_source` pins), and before the store is used.
    #[test]
    fn the_commands_that_open_a_vault_refuse_before_touching_it() {
        let lib = include_str!("lib.rs");
        for command in [
            "vault_create",
            "vault_unlock",
            "vault_recover",
            "vault_restore",
        ] {
            let start = lib
                .find(&format!("async fn {command}(\n"))
                .unwrap_or_else(|| panic!("{command} exists"));
            let body = &lib[start..start + 1500];
            let pin = body
                .find("let store = store.pin();")
                .expect("it pins the store");
            let guard = body
                .find("backup_exclusion::ensure()")
                .unwrap_or_else(|| panic!("{command} calls the guard"));
            assert!(pin < guard, "{command}: the store is pinned first");
            let used = body
                .find("store.arc()")
                .into_iter()
                .chain(body.find("run_blocking("))
                .min()
                .expect("it uses the store");
            assert!(
                guard < used,
                "{command}: the guard comes before the store is used"
            );
        }
    }

    /// A slot-creating command writes a new vault into the folder too. None exists yet (the
    /// registry's `add_slot` is not a command), so this fails when one is added, as a reminder to
    /// call `backup_exclusion::ensure()` first in it and to list it in the test above.
    #[test]
    fn no_command_creates_a_vault_slot_without_the_guard_yet() {
        let lib = include_str!("lib.rs");
        let production = lib.split("#[cfg(test)]").next().unwrap();
        assert!(
            !production.contains(".add_slot("),
            "a command now adds a vault slot: call backup_exclusion::ensure() first in it and add it \
             to the_commands_that_open_a_vault_refuse_before_touching_it"
        );
    }

    #[test]
    fn nothing_changes_off_ios() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("not-made");
        keep_out_of_device_backups(&missing).unwrap();
        #[cfg(not(target_os = "ios"))]
        assert!(!missing.exists(), "only iOS makes the folder");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_flag_is_written_as_one_byte_of_value_one_and_read_back() {
        let temp = tempfile::tempdir().unwrap();
        let name = "user.mycarlos-backup-flag-test";
        // The user namespace stands in for iOS's attribute, which only iOS honours.
        match set_flag(temp.path(), name) {
            // A file system without user attributes (some tmpfs and overlay set-ups): nothing to read back.
            Err(error) if error.raw_os_error() == Some(libc::ENOTSUP) => return,
            other => other.unwrap(),
        }
        assert!(flag_is_set(temp.path(), name).unwrap());
        // A folder that never had the flag is not reported as flagged.
        let other = temp.path().join("other");
        std::fs::create_dir(&other).unwrap();
        assert!(flag_is_set(&other, name).is_err());
    }

    /// The module must be built on every platform: iOS calls it. A `#[cfg]` line left above it
    /// (the line above a `mod` is whatever gate its neighbour had) built it for Linux and
    /// Windows only, which broke the iOS build and never excluded the vault.
    #[test]
    fn lib_declares_the_module_for_every_platform_and_keeps_the_camera_gate() {
        let lib = include_str!("lib.rs");
        let lines: Vec<&str> = lib.lines().collect();
        let at = lines
            .iter()
            .position(|line| *line == "mod backup_exclusion;")
            .expect("lib.rs declares backup_exclusion");
        assert!(
            !lines[at - 1].trim_start().starts_with("#["),
            "backup_exclusion must have no attribute above it: {}",
            lines[at - 1]
        );
        let camera = lines
            .iter()
            .position(|line| *line == "mod camera_permission;")
            .expect("lib.rs declares camera_permission");
        assert_eq!(
            lines[camera - 1],
            "#[cfg(any(target_os = \"linux\", windows))]",
            "camera_permission keeps its desktop gate"
        );
    }

    /// iOS is the only place the exclusion does anything, and it is not built here: the call
    /// site is pinned by source. It runs before any vault is opened, so nothing is written
    /// into a folder that a backup could take first.
    #[test]
    fn setup_excludes_the_data_folder_before_any_vault_opens() {
        let lib = include_str!("lib.rs");
        let call = lib
            .find("backup_exclusion::configure(app.path().app_local_data_dir()?)")
            .expect("setup excludes the app's local data folder");
        let open = lib
            .find("vault_slots::VaultSlots::open(")
            .expect("setup opens the vaults");
        assert!(call < open, "the exclusion comes before the vaults open");
    }

    #[cfg(unix)]
    #[test]
    fn a_missing_path_is_an_error_not_a_panic() {
        let temp = tempfile::tempdir().unwrap();
        assert!(set_flag(&temp.path().join("gone"), "user.x").is_err());
    }
}

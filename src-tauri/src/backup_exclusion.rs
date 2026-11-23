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

use std::io;
use std::path::Path;

/// The attribute iOS reads as "exclude this from backups".
#[cfg_attr(not(any(target_os = "ios", test)), allow(dead_code))]
const IOS_EXCLUDE_ATTRIBUTE: &str = "com.apple.MobileBackup";

/// Excludes `dir` (made if it is missing) and all it will hold from iOS backups. Nothing on any
/// other platform.
pub(crate) fn keep_out_of_device_backups(dir: &Path) -> io::Result<()> {
    #[cfg(target_os = "ios")]
    {
        std::fs::create_dir_all(dir)?;
        set_flag(dir, IOS_EXCLUDE_ATTRIBUTE)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_attribute_is_the_one_ios_reads_as_excluded_from_backup() {
        assert_eq!(IOS_EXCLUDE_ATTRIBUTE, "com.apple.MobileBackup");
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
    fn the_flag_is_written_as_one_byte_of_value_one() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let temp = tempfile::tempdir().unwrap();
        // The user namespace stands in for iOS's attribute, which only iOS honours.
        match set_flag(temp.path(), "user.mycarlos-backup-flag-test") {
            // A file system without user attributes (some tmpfs and overlay set-ups): nothing to read back.
            Err(error) if error.raw_os_error() == Some(libc::ENOTSUP) => return,
            other => other.unwrap(),
        }
        let path = CString::new(temp.path().as_os_str().as_bytes()).unwrap();
        let name = CString::new("user.mycarlos-backup-flag-test").unwrap();
        let mut value = [0u8; 4];
        // SAFETY: both strings are NUL-terminated and `value` is four writable bytes.
        let length = unsafe {
            libc::getxattr(
                path.as_ptr(),
                name.as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
            )
        };
        assert_eq!(length, 1);
        assert_eq!(value[0], 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_missing_path_is_an_error_not_a_panic() {
        let temp = tempfile::tempdir().unwrap();
        assert!(set_flag(&temp.path().join("gone"), "user.x").is_err());
    }
}

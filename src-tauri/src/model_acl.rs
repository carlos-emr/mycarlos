//! Windows: lets the model helper read the models folder (#72).
//!
//! The helper runs in an AppContainer (`mycarlos.modelhelper`) that can read
//! nothing of the user's by default, and the engine opens the model by path.
//! So the folder `models/` gets one inheritable read ACE for that
//! AppContainer's SID, added to whatever access it already has (nothing is
//! replaced): files added later inherit it. Done when the folder is made and
//! again for an existing one before the model is reported installed. The
//! folder holds only a public model file.

use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HLOCAL};
use windows::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
    GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
    TRUSTEE_W,
};
use windows::Win32::Security::Isolation::DeriveAppContainerSidFromAppContainerName;
use windows::Win32::Security::{
    FreeSid, ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    SUB_CONTAINERS_AND_OBJECTS_INHERIT,
};
use windows::Win32::Storage::FileSystem::{FILE_GENERIC_EXECUTE, FILE_GENERIC_READ};

/// The model helper's AppContainer name (`pdf_unlock`'s model profile).
pub(crate) use crate::model_helper::APP_CONTAINER;

/// Frees the SID when dropped.
struct Sid(PSID);

impl Drop for Sid {
    fn drop(&mut self) {
        // SAFETY: the SID came from DeriveAppContainerSidFromAppContainerName
        // and is freed once.
        unsafe {
            FreeSid(self.0);
        }
    }
}

/// Frees a block Windows allocated with LocalAlloc when dropped.
struct Local(*mut core::ffi::c_void);

impl Drop for Local {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: allocated by the security calls below; freed once.
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.0)));
            }
        }
    }
}

/// Adds the inheritable read ACE for `container` to `dir`'s DACL. `false`
/// when it could not be set: the helper could then not read the model, so
/// the caller does not report the model installed.
pub(crate) fn grant_read(dir: &Path, container: &str) -> bool {
    let wide_name: Vec<u16> = container.encode_utf16().chain([0]).collect();
    let wide_path: Vec<u16> = dir.as_os_str().encode_wide().chain([0]).collect();
    // SAFETY: every pointer below is to a buffer or struct that outlives its
    // call; the SID and the allocated security blocks are freed by their
    // guards; the new ACL is built from the old one, so nothing is lost.
    unsafe {
        let Ok(sid) = DeriveAppContainerSidFromAppContainerName(PCWSTR(wide_name.as_ptr())) else {
            return false;
        };
        let sid = Sid(sid);
        let mut old_acl: *mut ACL = std::ptr::null_mut();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        if GetNamedSecurityInfoW(
            PCWSTR(wide_path.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut old_acl),
            None,
            &mut descriptor,
        ) != ERROR_SUCCESS
        {
            return false;
        }
        let _descriptor = Local(descriptor.0);
        let access = EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_GENERIC_READ.0 | FILE_GENERIC_EXECUTE.0,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: PWSTR(sid.0 .0 as *mut u16),
            },
        };
        let mut new_acl: *mut ACL = std::ptr::null_mut();
        if SetEntriesInAclW(Some(&[access]), Some(old_acl), &mut new_acl) != ERROR_SUCCESS {
            return false;
        }
        let _new_acl = Local(new_acl.cast());
        SetNamedSecurityInfoW(
            PCWSTR(wide_path.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(new_acl),
            None,
        ) == ERROR_SUCCESS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Through the real calls: after `grant_read`, the folder's DACL holds an
    /// ACE for the AppContainer's SID that its files inherit, and the owner's
    /// own access is still there.
    #[test]
    fn the_models_folder_is_readable_by_the_helper_container_and_keeps_its_other_access() {
        let dir = tempfile::tempdir().unwrap();
        let models = dir.path().join("models");
        std::fs::create_dir(&models).unwrap();
        assert!(grant_read(&models, APP_CONTAINER));
        // Idempotent: a second grant changes nothing that breaks.
        assert!(grant_read(&models, APP_CONTAINER));
        // The owner can still write a file into it, and read it back.
        let file = models.join("file.gguf");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"x");
        // icacls lists the container's SID with an inherited read on the file.
        let sid = {
            let wide: Vec<u16> = APP_CONTAINER.encode_utf16().chain([0]).collect();
            // SAFETY: valid NUL-terminated name; freed below.
            unsafe {
                let sid = DeriveAppContainerSidFromAppContainerName(PCWSTR(wide.as_ptr())).unwrap();
                let mut text = PWSTR::null();
                windows::Win32::Security::Authorization::ConvertSidToStringSidW(sid, &mut text)
                    .unwrap();
                let s = text.to_string().unwrap();
                let _ = LocalFree(Some(HLOCAL(text.0.cast())));
                FreeSid(sid);
                s
            }
        };
        let out = std::process::Command::new("icacls")
            .arg(&file)
            .output()
            .unwrap();
        let listing = String::from_utf8_lossy(&out.stdout);
        assert!(listing.contains(&sid), "{listing}");
    }
}

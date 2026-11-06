//! Windows: the notice keys' wrap key (#230) in Credential Manager, as a
//! generic credential of this OS user that stays on this computer
//! (`CRED_PERSIST_LOCAL_MACHINE`, never roamed). Only the 32-byte wrap key is
//! there; the keys themselves are in the sealed file (`notice_key`).

use crate::notice_key::{NoticeKeyError, WrapKeyStore};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::ERROR_NOT_FOUND;
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};
use zeroize::Zeroizing;

/// The credential's name in Credential Manager.
const TARGET: &str = "myCarlos/notice-keys/v1";

pub(crate) struct CredentialManagerStore;

fn target() -> Vec<u16> {
    TARGET.encode_utf16().chain(Some(0)).collect()
}

fn not_found(error: &windows::core::Error) -> bool {
    error.code() == ERROR_NOT_FOUND.to_hresult()
}

impl WrapKeyStore for CredentialManagerStore {
    fn get(&self) -> Result<Option<Zeroizing<[u8; 32]>>, NoticeKeyError> {
        let name = target();
        let mut found: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `name` is NUL-terminated and outlives the call; on success
        // `found` is a credential the call allocated, freed below.
        match unsafe { CredReadW(PCWSTR(name.as_ptr()), CRED_TYPE_GENERIC, None, &mut found) } {
            Err(error) if not_found(&error) => return Ok(None),
            Err(_) => return Err(NoticeKeyError::Io),
            Ok(()) => {}
        }
        // SAFETY: CredReadW succeeded, so `found` points at its CREDENTIALW,
        // whose blob is `CredentialBlobSize` bytes. The blob is copied, then
        // zeroed before the credential is freed, so no copy of the key is
        // left in freed memory.
        let key = unsafe {
            let credential = &*found;
            let size = credential.CredentialBlobSize as usize;
            let key = if credential.CredentialBlob.is_null() || size != 32 {
                None
            } else {
                let blob = std::slice::from_raw_parts(credential.CredentialBlob, size);
                let mut key = Zeroizing::new([0_u8; 32]);
                key.copy_from_slice(blob);
                std::ptr::write_bytes(credential.CredentialBlob, 0, size);
                Some(key)
            };
            CredFree(found as *const _);
            key
        };
        key.map(Some).ok_or(NoticeKeyError::Damaged)
    }

    fn put(&self, key: &[u8; 32]) -> Result<(), NoticeKeyError> {
        let mut name = target();
        let mut blob = Zeroizing::new(*key);
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(name.as_mut_ptr()),
            CredentialBlobSize: 32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        // SAFETY: every pointer in `credential` is live for the call, which
        // copies what it keeps.
        unsafe { CredWriteW(&credential, 0) }.map_err(|_| NoticeKeyError::Io)
    }

    fn delete(&self) -> Result<(), NoticeKeyError> {
        let name = target();
        // SAFETY: `name` is NUL-terminated and outlives the call.
        match unsafe { CredDeleteW(PCWSTR(name.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(error) if not_found(&error) => Ok(()),
            Err(_) => Err(NoticeKeyError::Io),
        }
    }
}

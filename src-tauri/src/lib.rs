#[cfg(any(target_os = "linux", windows))]
mod camera_permission;
mod idle;
mod pdf_unlock;
mod pdf_view;
mod photo;
mod received;
mod throttle;
mod vault;
#[cfg(windows)]
mod windows_navigation;

/// For `main`: the first argument that starts this executable as the PDF unlock helper, and
/// the helper itself (see `pdf_unlock`).
pub use pdf_unlock::{
    helper_main as pdf_helper_main, protect_process_memory, HELPER_ARG as PDF_HELPER_ARG,
};

/// For tests/pdf_helper.rs only (see `pdf_unlock::unlock_with_helper_at`).
#[doc(hidden)]
#[cfg(desktop)]
pub use pdf_unlock::unlock_with_helper_at as pdf_unlock_with_helper_at;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use idle::{IdleDeadline, Opening};
use received::{ReceivedFiles, ReceivedSource};
use serde::{Deserialize, Serialize};
#[cfg(desktop)]
use std::io;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State, Url};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tauri_plugin_fs::{FsExt, OpenOptions};
use throttle::{Attempt, AttemptThrottle, Outcome};
use uuid::Uuid;
use vault::{
    ImportSource, PassphraseRules, RestoreCredential, RestorePreview, RestoreReplaces, VaultError,
    VaultSnapshot, VaultStatus, VaultStore,
};
use zeroize::{Zeroize, Zeroizing};

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    platform: String,
    architecture: String,
    app_version: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicError {
    code: &'static str,
    message: &'static str,
    /// The document a failure is about, for the renderer to name: a name is
    /// never put in an error.
    #[serde(skip_serializing_if = "Option::is_none")]
    record_id: Option<Uuid>,
    /// A sentence the renderer adds after the message, where it depends on
    /// how the failure came about rather than on what it was.
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<&'static str>,
    /// How long to wait before the next try, after wrong ones.
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_ms: Option<u64>,
}

/// What an error says, whatever it is about.
struct PublicText {
    code: &'static str,
    message: &'static str,
}

type CommandResult<T> = Result<T, PublicError>;

/// Where a backup that failed was being saved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackupDestination {
    /// A file path: written beside it and renamed over it only once
    /// complete, so a failure leaves nothing there.
    Path,
    /// An Android document provider's document, not yet opened.
    ProviderUntouched,
    /// The same, opened, which empties it.
    ProviderEmptied,
}

impl PublicError {
    /// A failure to save a backup, said of the backup: nothing was typed
    /// for it to check, and the older backups are to be kept. Where it was
    /// being saved adds what may be left there, whatever the failure.
    fn of_backup(self, destination: BackupDestination) -> Self {
        let message = match self.code {
            "unreadable" => "myCarlos could not read some of its files just now, so no backup was saved. Your documents have not been changed. Keep your older backups. Try again. If it happens again, close myCarlos and open it again; on a computer, also check that the drive is connected and pause any sync or antivirus tool.",
            "no_space" => "There is not enough space where you chose to save it. No backup was saved. Keep your older backups.",
            "storage" => "The backup could not be saved there. No backup was saved. Keep your older backups.",
            "cancelled" => "The backup stopped because the vault locked. No backup was saved. Keep your older backups.",
            _ => self.message,
        };
        // An Android document provider's document. Nothing is written to it
        // before it is open, so until then it is whole or empty (the provider
        // may empty it as it opens, even if the open then fails); once
        // opened, it may be empty or incomplete.
        let note = match destination {
            BackupDestination::Path => None,
            BackupDestination::ProviderUntouched => Some(
                "An empty file (0 bytes) may be left where you chose to save: you can delete it. Keep any backup that is not empty.",
            ),
            BackupDestination::ProviderEmptied => Some(
                "The file where you chose to save may be empty or incomplete; if you chose to save over an older backup, it was emptied. Delete that one, not your other backups.",
            ),
        };
        Self {
            message,
            note,
            ..self
        }
    }

    /// A secret tried again too soon after several wrong ones. The renderer
    /// adds how long is left, from `retry_after_ms`.
    fn wait(left_ms: u64) -> Self {
        Self {
            code: "too_many_attempts",
            message: "There have been several wrong tries in a row. To slow down anyone guessing, myCarlos waits a little before the next one: what you typed was not checked.",
            record_id: None,
            note: None,
            retry_after_ms: Some(left_ms),
        }
    }

    fn partial_export() -> Self {
        Self {
            code: "partial_export",
            message: "The selected destination may contain a partial readable copy. Delete that copy before retrying.",
            record_id: None,
            note: None,
            retry_after_ms: None,
        }
    }

    /// A failure to open a backup, said of the backup: a backup opens with
    /// the credentials its vault had when it was saved, which need not be
    /// the ones the vault has now.
    fn of_restore(self) -> Self {
        let message = match self.code {
            "wrong_recovery_key" => "That recovery key does not open this backup. A backup opens with the recovery key the vault had when it was saved, if it had one (not a key set up or replaced since), or with the passphrase it was made with.",
            "wrong_passphrase" => "That passphrase does not open this backup. A backup opens with the passphrase it was made with (not one changed since), or with the recovery key the vault had when it was saved, if it had one.",
            _ => return self,
        };
        Self { message, ..self }
    }

    /// The photo did not reach the vault as the camera window sent it. The
    /// code says which part was wrong, for a report: "photo_body" (the
    /// request's bytes or framing) or "photo_target" (whose records, folders,
    /// name).
    fn photo_not_received(code: &'static str) -> Self {
        Self {
            code,
            message: "The photo did not reach the vault, so it was not saved. Choose Use photo to try again.",
            record_id: None,
            note: None,
            retry_after_ms: None,
        }
    }

    fn removal_not_possible() -> Self {
        Self {
            code: "recovery_mode",
            message: "Nothing was removed. The vault cannot be changed right now; the notice above the documents says why.",
            record_id: None,
            note: None,
            retry_after_ms: None,
        }
    }
}

impl From<VaultError> for PublicText {
    fn from(error: VaultError) -> Self {
        match error {
            VaultError::Busy => Self {
                code: "busy",
                message: "A passphrase check or speed test is running. Wait for it to finish, then try again.",
            },
            VaultError::AlreadyExists => Self {
                code: "already_exists",
                message: "A vault already exists on this device.",
            },
            VaultError::Missing => Self {
                code: "missing",
                message: "No vault exists on this device.",
            },
            VaultError::Locked => Self {
                code: "locked",
                message: "Unlock the vault to continue.",
            },
            VaultError::InUse => Self {
                code: "in_use",
                message: "This vault is open in another myCarlos window. Lock or close that window, then try again.",
            },
            VaultError::WrongPassphrase => Self {
                code: "wrong_passphrase",
                message: "That passphrase didn't open myCarlos. Check Caps Lock and try again.",
            },
            VaultError::Corrupt => Self {
                code: "corrupt",
                message: "The vault is damaged or incomplete. No data was changed.",
            },
            VaultError::NotFound => Self {
                code: "not_found",
                message: "That item is no longer available.",
            },
            VaultError::Invalid => Self {
                code: "invalid",
                message: "Something you typed wasn't accepted. Check it and try again.",
            },
            VaultError::WeakPassphrase => Self {
                code: "weak_passphrase",
                message: "Choose a less predictable passphrase that is not based on common passwords, names, or myCarlos.",
            },
            VaultError::ImportBatchLimit => Self {
                code: "import_batch_limit",
                message: "Choose no more than 100 files in one import.",
            },
            VaultError::NotPdf => Self {
                code: "not_pdf",
                message: "One of the files is not a PDF document, so nothing was added. myCarlos keeps PDF documents only.",
            },
            // The reader asks for the document's password on this code (#64).
            VaultError::PdfLocked => Self {
                code: "pdf_locked",
                message: "This document is locked with a password. Enter the document password from your patient portal.",
            },
            VaultError::PdfNotLocked => Self {
                code: "pdf_not_locked",
                message: "This document is not locked with a password, so it opens as it is.",
            },
            VaultError::PdfAlreadyUnlocked => Self {
                code: "pdf_already_unlocked",
                message: "An unlocked copy of this document is already here, so nothing was added.",
            },
            VaultError::PdfWrongPassword => Self {
                code: "pdf_wrong_password",
                message: "That password did not open the document. Check the document password in your patient portal, then try again.",
            },
            VaultError::PdfUnlockFailed => Self {
                code: "pdf_unlock_failed",
                message: "myCarlos could not open this locked document. It may be damaged, or locked in a way myCarlos cannot open. The document is unchanged.",
            },
            VaultError::PdfUnlockUnavailable => Self {
                code: "pdf_unlock_unavailable",
                message: "myCarlos cannot open password-protected documents on this device yet. The document is unchanged.",
            },
            VaultError::PdfTooLarge => Self {
                code: "pdf_too_large",
                message: "This locked document is larger than 100 MB, so myCarlos cannot open it. The document is unchanged.",
            },
            VaultError::PdfViewFailed => Self {
                code: "pdf_view_failed",
                message: "myCarlos could not show this document. It may be damaged, or use features myCarlos cannot show yet. Save a copy to read it in another app.",
            },
            VaultError::PdfViewUnavailable => Self {
                code: "pdf_view_unavailable",
                message: "myCarlos cannot show documents on this device yet. Save a copy to read it in another app.",
            },
            VaultError::NoSpace => Self {
                code: "no_space",
                message: "There is not enough storage to complete this operation.",
            },
            VaultError::Storage => Self {
                code: "storage",
                message: "myCarlos couldn't read or write its files on this computer. Check that the drive holding myCarlos is connected and has free space, then try again. If you were changing something, first look at your records to see whether the change was made.",
            },
            VaultError::Cancelled => Self {
                code: "cancelled",
                message: "The operation stopped because the vault was locked.",
            },
            VaultError::UnsupportedStorage => Self {
                code: "unsupported_storage",
                message: "myCarlos cannot keep a vault safely on this device's storage, because it does not confirm when files are durably written (for example, a network home folder). Use myCarlos on a device with local storage.",
            },
            VaultError::RemovalChanged => Self {
                code: "removal_changed",
                message: "The list of damaged documents has changed. Nothing was removed. Check the list, then try again.",
            },
            VaultError::Unreadable => Self {
                code: "unreadable",
                message: "myCarlos could not read some of its files just now. Your documents have not been changed or deleted, so do not erase the vault. Check what you typed and try again. If it happens again, close myCarlos and open it again; on a computer, also check that the drive is connected and pause any sync or antivirus tool.",
            },
            VaultError::RecoveryMode => Self {
                code: "recovery_mode",
                message: "The vault is in read-only recovery mode. Export important records and free storage before retrying.",
            },
            VaultError::RecoveryKeyTypo => Self {
                code: "recovery_key_typo",
                message: "That doesn't match the recovery key. Check each group of characters and try again.",
            },
            VaultError::BackupChanged => Self {
                code: "backup_changed",
                message: "The backup file, or the vault on this device, changed after you chose to restore. Nothing on this device was changed. Choose the backup file again.",
            },
            VaultError::BackupUnreadable => Self {
                code: "backup_unreadable",
                message: "This file is not a complete myCarlos backup, or it was changed after it was saved. Nothing on this device was changed.",
            },
            VaultError::WrongRecoveryKey => Self {
                code: "wrong_recovery_key",
                message: "That recovery key does not open this vault. If you replaced your recovery key, use the newest one.",
            },
            VaultError::BackupNotOpened => Self {
                code: "backup_not_opened",
                message: "myCarlos could not open that file. If it is in a cloud or shared folder, copy it to a folder on this device and choose it there. Nothing on this device was changed.",
            },
            VaultError::DamagedDocument(_) => Self {
                code: "damaged_document",
                message: "A document in the vault is damaged and can no longer be read, so no backup was saved. Nothing was changed.",
            },
            VaultError::NotPhoto => Self {
                code: "not_a_photo",
                message: "This is not a photo myCarlos can save or show: it must be a complete JPEG picture of at most 25 MB and 8,192 pixels on each side. Nothing was changed.",
            },
            VaultError::RestoreUnfinished => Self {
                code: "restore_unfinished",
                message: "The backup was checked, but restoring it has not finished. Close myCarlos and open it again to finish. Then open the vault with the backup's passphrase or recovery key.",
            },
        }
    }
}

impl From<VaultError> for PublicError {
    fn from(error: VaultError) -> Self {
        let record_id = match error {
            VaultError::DamagedDocument(id) => Some(id),
            _ => None,
        };
        let PublicText { code, message } = PublicText::from(error);
        Self {
            code,
            message,
            record_id,
            note: None,
            retry_after_ms: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PassphraseRulesRequest {
    passphrase: String,
    initial_profile_name: String,
}

// Wiped however the command ends.
impl Drop for PassphraseRulesRequest {
    fn drop(&mut self) {
        self.passphrase.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateVaultRequest {
    passphrase: String,
    initial_profile_name: String,
}

// Wiped however the command ends.
impl Drop for CreateVaultRequest {
    fn drop(&mut self) {
        self.passphrase.zeroize();
    }
}

#[derive(Deserialize)]
struct RemoveUnavailableRequest {
    confirmed: Vec<Uuid>,
}

#[derive(Deserialize)]
struct PassphraseRequest {
    passphrase: String,
}

// Wiped however the command ends, including a try refused before it runs.
impl Drop for PassphraseRequest {
    fn drop(&mut self) {
        self.passphrase.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PickRequest {
    pick_id: Uuid,
}

/// The passphrase a backup was made with, or its recovery key: exactly one.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreRequest {
    pick_id: Uuid,
    passphrase: Option<String>,
    recovery_key: Option<String>,
    #[serde(default)]
    replace: bool,
}

impl RestoreRequest {
    fn credential(&self) -> Result<RestoreCredential<'_>, VaultError> {
        match (&self.passphrase, &self.recovery_key) {
            (Some(passphrase), None) => Ok(RestoreCredential::Passphrase(passphrase)),
            (None, Some(key)) => Ok(RestoreCredential::RecoveryKey(key)),
            _ => Err(VaultError::Invalid),
        }
    }

    fn zeroize(&mut self) {
        if let Some(passphrase) = &mut self.passphrase {
            passphrase.zeroize();
        }
        if let Some(key) = &mut self.recovery_key {
            key.zeroize();
        }
    }
}

// Wiped however the command ends, including the early returns that never
// reach the vault.
impl Drop for RestoreRequest {
    fn drop(&mut self) {
        self.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoverRequest {
    recovery_key: String,
    new_passphrase: String,
}

// Wiped however the command ends, including a try refused before it runs.
impl Drop for RecoverRequest {
    fn drop(&mut self) {
        self.recovery_key.zeroize();
        self.new_passphrase.zeroize();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoverResponse {
    /// False when the vault could only open read-only, leaving the passphrase
    /// unchanged.
    passphrase_replaced: bool,
    snapshot: VaultSnapshot,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryKeyGroup {
    index: usize,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfirmRecoveryKeyRequest {
    groups: Vec<RecoveryKeyGroup>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePassphraseRequest {
    current_passphrase: String,
    new_passphrase: String,
}

// Wiped however the command ends, including a try refused before it runs.
impl Drop for ChangePassphraseRequest {
    fn drop(&mut self) {
        self.current_passphrase.zeroize();
        self.new_passphrase.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NameRequest {
    display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderRequest {
    profile_id: Uuid,
    parent_id: Option<Uuid>,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateFolderRequest {
    folder_id: Uuid,
    parent_id: Option<Uuid>,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssignFoldersRequest {
    record_id: Uuid,
    folder_ids: Vec<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameRecordRequest {
    record_id: Uuid,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssignFoldersBatchRequest {
    record_ids: Vec<Uuid>,
    folder_ids: Vec<Uuid>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ImportRequest {
    profile_id: Uuid,
    folder_ids: Vec<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportRequest {
    record_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhotoRequest {
    record_id: Uuid,
}

/// Whose records a photo goes in, which folders, and its name: the start of a
/// photo request's body (see `split_photo_request`), as JSON
/// `{"profileId", "folderIds", "name"}`. Custom headers do not reach the app
/// on Windows (WebView2), so nothing rides in them.
#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PhotoTarget {
    profile_id: Uuid,
    folder_ids: Vec<Uuid>,
    name: String,
}

/// The most a photo request's target may take, before the JPEG.
const MAX_PHOTO_TARGET_BYTES: usize = 4096;

fn photo_target(json: &[u8]) -> Result<PhotoTarget, VaultError> {
    let target: PhotoTarget = serde_json::from_slice(json).map_err(|_| VaultError::Invalid)?;
    vault::validate_folder_assignment_count(target.folder_ids.len())?;
    let name = &target.name;
    // A photo's name ends in ".jpg", which says what an exported copy is.
    let stem = name
        .len()
        .checked_sub(4)
        .filter(|end| {
            name.get(*end..)
                .is_some_and(|tail| tail.eq_ignore_ascii_case(".jpg"))
        })
        .map(|end| &name[..end]);
    if stem.is_none_or(|stem| stem.trim().is_empty()) || name.trim() != name {
        return Err(VaultError::Invalid);
    }
    Ok(target)
}

/// A photo request is one body, which Tauri carries the same way on every
/// platform (`photo_bytes`): the target's length (4 bytes, big-endian), the
/// target, then the JPEG. Each part is bounded; the JPEG is copied into
/// memory that is overwritten, and so is the whole request.
fn split_photo_request(request: &[u8]) -> Result<(PhotoTarget, Zeroizing<Vec<u8>>), PublicError> {
    let framing = || PublicError::photo_not_received("photo_body");
    let length: [u8; 4] = request
        .get(..4)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(framing)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_PHOTO_TARGET_BYTES {
        return Err(framing());
    }
    let target = request.get(4..4 + length).ok_or_else(framing)?;
    let target =
        photo_target(target).map_err(|_| PublicError::photo_not_received("photo_target"))?;
    let jpeg = &request[4 + length..];
    if jpeg.len() > photo::MAX_PHOTO_BYTES {
        return Err(VaultError::NotPhoto.into());
    }
    Ok((target, Zeroizing::new(jpeg.to_vec())))
}

/// A photo request's bytes, however the IPC brought them, copied into memory
/// that is overwritten. The camera window sends them as the request's raw
/// body. When Tauri uses its postMessage channel instead, as it always does on
/// Android and does on Windows once its custom protocol has failed in a
/// session, the same bytes arrive as a JSON array of numbers.
fn photo_request(
    body: &tauri::ipc::InvokeBody,
) -> Result<(PhotoTarget, Zeroizing<Vec<u8>>), PublicError> {
    let request = photo_bytes_within(body, 4 + MAX_PHOTO_TARGET_BYTES + photo::MAX_PHOTO_BYTES)?;
    split_photo_request(&request)
}

fn photo_bytes_within(
    body: &tauri::ipc::InvokeBody,
    limit: usize,
) -> Result<Zeroizing<Vec<u8>>, PublicError> {
    match body {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            if bytes.len() > limit {
                return Err(VaultError::NotPhoto.into());
            }
            Ok(Zeroizing::new(bytes.clone()))
        }
        tauri::ipc::InvokeBody::Json(serde_json::Value::Array(values)) => {
            // Counted before anything is copied.
            if values.len() > limit {
                return Err(VaultError::NotPhoto.into());
            }
            let mut bytes = Zeroizing::new(Vec::with_capacity(values.len()));
            for value in values {
                let byte = value
                    .as_u64()
                    .and_then(|number| u8::try_from(number).ok())
                    .ok_or_else(|| PublicError::photo_not_received("photo_body"))?;
                bytes.push(byte);
            }
            Ok(bytes)
        }
        tauri::ipc::InvokeBody::Json(_) => Err(PublicError::photo_not_received("photo_body")),
    }
}

/// Cleans the photo (photo.rs) and encrypts it as one import: the same
/// encryption, verification, duplicate check and folder rules as a file the
/// patient picked, and the same source label and media type, so that the
/// vault's format is unchanged. The photo's bytes are overwritten once the
/// import has read them.
fn save_photo(
    store: &VaultStore,
    target: PhotoTarget,
    photo: Zeroizing<Vec<u8>>,
) -> Result<vault::ImportOutcome, VaultError> {
    let cleaned = photo::clean_jpeg(&photo).map_err(|_| VaultError::NotPhoto)?;
    drop(photo);
    store.import(
        target.profile_id,
        target.folder_ids,
        vec![ImportSource {
            display_name: target.name,
            reader: Box::new(std::io::Cursor::new(cleaned)),
        }],
        now_ms(),
    )
}

/// A record's file, decrypted for the photo view: at most a photo's size, and
/// no more than its first chunk when it does not start as a JPEG, so that
/// checking another kind of document is cheap. Overwritten when dropped,
/// including the smaller buffers it outgrows.
#[derive(Default)]
struct PhotoBuffer {
    bytes: Zeroizing<Vec<u8>>,
    refused: bool,
}

impl std::io::Write for PhotoBuffer {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let needed = self.bytes.len() + data.len();
        if needed > photo::MAX_PHOTO_BYTES {
            self.refused = true;
            return Err(std::io::Error::other("larger than a photo"));
        }
        if needed > self.bytes.capacity() {
            let capacity = needed
                .max(2 * self.bytes.capacity())
                .min(photo::MAX_PHOTO_BYTES);
            let mut larger = Zeroizing::new(Vec::with_capacity(capacity));
            larger.extend_from_slice(&self.bytes);
            self.bytes = larger;
        }
        self.bytes.extend_from_slice(data);
        // FF D8 FF, as far as the bytes so far go.
        let seen = self.bytes.len().min(photo::JPEG_START.len());
        if self.bytes[..seen] != photo::JPEG_START[..seen] {
            self.refused = true;
            return Err(std::io::Error::other("not a JPEG"));
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The first bytes of a record's file, and no more: once it has them, it stops
/// the export, so only the first chunk is decrypted.
#[derive(Default)]
struct FileStart {
    bytes: [u8; photo::JPEG_START.len()],
    seen: usize,
}

impl FileStart {
    fn complete(&self) -> bool {
        self.seen == self.bytes.len()
    }
}

impl std::io::Write for FileStart {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let take = data.len().min(self.bytes.len() - self.seen);
        self.bytes[self.seen..self.seen + take].copy_from_slice(&data[..take]);
        self.seen += take;
        if self.complete() {
            Err(std::io::Error::other("the first bytes are read"))
        } else {
            Ok(data.len())
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Whether a record's file starts as a JPEG does (FF D8 FF), whatever it is
/// called. A document's details ask this before offering View photo, so the
/// photo itself stays here until the patient asks to see it; `view_photo` then
/// checks the whole file.
fn is_photo(store: &VaultStore, record_id: Uuid) -> Result<bool, VaultError> {
    let mut start = FileStart::default();
    let exported = store.export(record_id, &mut start);
    if start.complete() {
        return Ok(start.bytes == photo::JPEG_START);
    }
    // Shorter than three bytes, or not read at all.
    exported.map(|()| false)
}

/// The photo a record holds, as a `data:image/jpeg` URL for the photo view
/// (the CSP allows `data:` images). The file's own bytes decide: it must start
/// with the JPEG marker FF D8 FF, whatever it is called, and pass the same
/// checks as a photo being saved, which also drop any metadata from what is
/// shown. The record is unchanged.
fn view_photo(store: &VaultStore, record_id: Uuid) -> Result<String, VaultError> {
    let mut buffer = PhotoBuffer::default();
    let exported = store.export(record_id, &mut buffer);
    if buffer.refused {
        return Err(VaultError::NotPhoto);
    }
    exported?;
    let cleaned = photo::clean_jpeg(&buffer.bytes).map_err(|_| VaultError::NotPhoto)?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        BASE64.encode(&*cleaned)
    ))
}

/// Whether a stored PDF may be locked with a password (#54), asked when its
/// details open. This is `pdf_unlock`'s names-only scan, which parses no object,
/// fed by the export: it stops at the first `/Encrypt`. A match is only a hint;
/// the helper decides when the patient unlocks it.
fn is_locked_pdf(store: &VaultStore, record_id: Uuid) -> Result<bool, VaultError> {
    let mut scan = pdf_unlock::LockScan::default();
    let exported = store.export(record_id, &mut scan);
    if scan.found() {
        return Ok(true);
    }
    exported?;
    Ok(scan.finish())
}

/// The name a locked original keeps once it is unlocked (#54, Ben's D66): its
/// own, with " (locked original)" before the extension, which a rename may not
/// change. The unlocked copy takes the name as it was. A name too long for the
/// words is shortened before them.
fn locked_original_name(name: &str) -> String {
    const WORDS: &str = " (locked original)";
    let extension = name
        .char_indices()
        .rev()
        .nth(3)
        .map(|(at, _)| at)
        .filter(|&at| name[at..].eq_ignore_ascii_case(".pdf"))
        .unwrap_or(name.len());
    let (stem, extension) = name.split_at(extension);
    let room = vault::MAX_RECORD_NAME_LEN - WORDS.chars().count() - extension.chars().count();
    let stem: String = stem.chars().take(room).collect();
    format!("{}{WORDS}{extension}", stem.trim_end())
}

/// What unlocking a PDF did: the unlocked copy, and the original's new name.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UnlockedPdf {
    record_id: Uuid,
    original_name: String,
}

/// Unlocks a stored PDF with the password the patient typed (#54). The
/// document is opened by the PDF helper (`unlock`, `pdf_unlock::unlock_in_helper`
/// outside tests), never beside the vault keys. The unlocked copy is stored
/// beside the original, in the same records and folders, with its name; the
/// locked original is kept (Ben's D66), renamed. The password is not kept.
fn unlock_pdf(
    store: &VaultStore,
    record_id: Uuid,
    password: &str,
    unlock: impl FnOnce(&[u8], &str) -> pdf_unlock::Outcome,
) -> Result<UnlockedPdf, VaultError> {
    use pdf_unlock::{Outcome, Refusal};
    let record = store
        .snapshot()?
        .records
        .into_iter()
        .find(|record| record.id == record_id)
        .ok_or(VaultError::NotFound)?;
    let mut locked = LimitedBuffer::new(pdf_unlock::MAX_LOCKED_PDF_BYTES);
    let exported = store.export(record_id, &mut locked);
    if locked.over {
        return Err(VaultError::PdfTooLarge);
    }
    exported?;
    let unlocked = match unlock(&locked.bytes, password) {
        Outcome::Unlocked(unlocked) => unlocked,
        Outcome::Refused(Refusal::NotEncrypted) => return Err(VaultError::PdfNotLocked),
        Outcome::Refused(Refusal::WrongPassword) => return Err(VaultError::PdfWrongPassword),
        Outcome::Refused(Refusal::TooLarge) => return Err(VaultError::PdfTooLarge),
        Outcome::Unavailable => return Err(VaultError::PdfUnlockUnavailable),
        Outcome::Refused(Refusal::Damaged | Refusal::Unsupported | Refusal::NoSuchPage)
        | Outcome::Failed => return Err(VaultError::PdfUnlockFailed),
    };
    drop(locked);
    let outcome = store.import(
        record.profile_id,
        record.folder_ids,
        vec![ImportSource {
            display_name: record.display_name.clone(),
            reader: Box::new(std::io::Cursor::new(unlocked)),
        }],
        now_ms(),
    )?;
    let Some(&copy) = outcome.imported.first() else {
        return Err(VaultError::PdfAlreadyUnlocked);
    };
    let original_name = locked_original_name(&record.display_name);
    store.rename_record(record_id, &original_name)?;
    Ok(UnlockedPdf {
        record_id: copy,
        original_name,
    })
}

/// A record's file, up to a limit: past it, the export stops and `over` says so.
/// Wiped when dropped.
struct LimitedBuffer {
    bytes: zeroize::Zeroizing<Vec<u8>>,
    limit: usize,
    over: bool,
}

impl LimitedBuffer {
    fn new(limit: usize) -> Self {
        Self {
            bytes: zeroize::Zeroizing::new(Vec::new()),
            limit,
            over: false,
        }
    }
}

impl std::io::Write for LimitedBuffer {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if self.bytes.len() + data.len() > self.limit {
            self.over = true;
            return Err(std::io::Error::other("the file is over the limit"));
        }
        self.bytes.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Finishes an import or export whose picker already closed. The paths the
/// picker returned stay native, under `pick_id`; the renderer never sees them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PickedImportRequest {
    pick_id: Uuid,
    profile_id: Uuid,
    folder_ids: Vec<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PickedExportRequest {
    pick_id: Uuid,
    record_id: Uuid,
}

/// Paths chosen in native pickers, waiting for the command that uses them.
///
/// A picker is a separate activity on Android, so while it is open the webview
/// is hidden. The renderer must not treat that as the app being backgrounded
/// and lock the vault under the picker, or nothing can ever be imported or
/// exported there. Splitting each operation into a pick and a run lets the
/// renderer tell a picker it opened from a real backgrounding, and lets a
/// manual lock, or the native idle deadline, during the I/O phase still cancel
/// the transfer (an automatic or background lock in the renderer waits for
/// it). Entries are dropped when used, when the vault locks or resets, and
/// after a bounded time.
///
/// A picker can still be open when the vault locks and return afterwards, so
/// each pick records the unlocked session its picker opened in and is refused
/// in any later one. A lock or reset ends a session, and an unlock or create
/// starts a new one. Each pick also records the request it was opened for, and is
/// refused for any other record, profile or folders.
#[derive(Default)]
struct PendingPicks {
    session: AtomicU64,
    imports: PickTable<(ImportRequest, Vec<tauri_plugin_fs::FilePath>)>,
    exports: PickTable<(Uuid, tauri_plugin_fs::FilePath)>,
    backups: PickTable<tauri_plugin_fs::FilePath>,
    restores: PickTable<tauri_plugin_fs::FilePath>,
}

// Long enough to cover the renderer's round trip after the picker closes, and
// short enough that a stale choice cannot be used much later.
const PICK_TTL: Duration = Duration::from_secs(120);
// A backup to restore is chosen, then its passphrase or recovery key typed,
// then what it replaces confirmed: long enough to read that warning.
const RESTORE_PICK_TTL: Duration = Duration::from_secs(15 * 60);
// What storing a pick prunes by: the longest any kind of pick may live. Each
// kind's own limit is applied when the pick is used.
const LONGEST_PICK_TTL: Duration = RESTORE_PICK_TTL;

/// One kind of pending pick, keyed by the id handed to the renderer.
struct PickTable<T>(Mutex<HashMap<Uuid, PickEntry<T>>>);

/// When the picker returned, the session its picker opened in, and the pick.
type PickEntry<T> = (Instant, u64, T);

impl<T> Default for PickTable<T> {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

impl<T> PickTable<T> {
    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<Uuid, PickEntry<T>>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn store(&self, session: u64, value: T) -> Uuid {
        let mut entries = self.entries();
        entries.retain(|_, (picked_at, _, _)| picked_at.elapsed() < LONGEST_PICK_TTL);
        let pick_id = Uuid::new_v4();
        entries.insert(pick_id, (Instant::now(), session, value));
        pick_id
    }

    /// Removes the pick whether or not it is still usable: a stale one, or one
    /// from an earlier session, is never used.
    fn take(&self, pick_id: Uuid, session: u64) -> Option<T> {
        self.take_within(pick_id, session, PICK_TTL)
    }

    fn take_within(&self, pick_id: Uuid, session: u64, ttl: Duration) -> Option<T> {
        let (picked_at, picked_in, value) = self.entries().remove(&pick_id)?;
        (picked_at.elapsed() < ttl && picked_in == session).then_some(value)
    }

    /// The pick, left in place for a later `take_within`.
    fn peek_within(&self, pick_id: Uuid, session: u64, ttl: Duration) -> Option<T>
    where
        T: Clone,
    {
        let entries = self.entries();
        let (picked_at, picked_in, value) = entries.get(&pick_id)?;
        (picked_at.elapsed() < ttl && *picked_in == session).then(|| value.clone())
    }

    fn clear(&self) {
        self.entries().clear();
    }
}

impl PendingPicks {
    /// The current unlocked session. Read it before opening a picker.
    fn session(&self) -> u64 {
        self.session.load(Ordering::SeqCst)
    }

    fn store_import(
        &self,
        session: u64,
        request: ImportRequest,
        paths: Vec<tauri_plugin_fs::FilePath>,
    ) -> Uuid {
        self.imports.store(session, (request, paths))
    }

    /// A pick is gone when it was used, expired, or cleared by a lock while the
    /// picker was open. None of those is a mistake in the request.
    fn take_import(
        &self,
        pick_id: Uuid,
        request: &ImportRequest,
    ) -> Result<Vec<tauri_plugin_fs::FilePath>, VaultError> {
        let (picked_for, paths) = self
            .imports
            .take(pick_id, self.session())
            .ok_or(VaultError::NotFound)?;
        if picked_for != *request {
            return Err(VaultError::Invalid);
        }
        Ok(paths)
    }

    fn store_export(
        &self,
        session: u64,
        record_id: Uuid,
        destination: tauri_plugin_fs::FilePath,
    ) -> Uuid {
        self.exports.store(session, (record_id, destination))
    }

    fn take_export(
        &self,
        pick_id: Uuid,
        record_id: Uuid,
    ) -> Result<tauri_plugin_fs::FilePath, VaultError> {
        let (picked_for, destination) = self
            .exports
            .take(pick_id, self.session())
            .ok_or(VaultError::NotFound)?;
        if picked_for != record_id {
            return Err(VaultError::Invalid);
        }
        Ok(destination)
    }

    /// Ends the session first, so that a picker returning during the clear
    /// stores a pick that can no longer be used.
    fn clear(&self) {
        self.session.fetch_add(1, Ordering::SeqCst);
        self.imports.clear();
        self.exports.clear();
        self.backups.clear();
        self.restores.clear();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteRecordRequest {
    record_id: Uuid,
}

#[derive(Deserialize)]
struct ResetRequest {
    confirmation: String,
}

fn current_runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        platform: std::env::consts::OS.to_owned(),
        architecture: std::env::consts::ARCH.to_owned(),
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        message: "Hello from the Tauri Rust boundary".to_owned(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

/// Name recorded for an imported file. Desktop pickers return a path, whose
/// final component the vault keeps. Mobile pickers return a URL: its final
/// segment is percent-encoded, and for Android document providers it is a
/// document id that either embeds the storage path ("primary:Documents/labs.pdf")
/// or is opaque ("msf:31").
fn import_display_name(path: &tauri_plugin_fs::FilePath) -> String {
    let tauri_plugin_fs::FilePath::Url(url) = path else {
        return path.to_string();
    };
    let segment = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or_default();
    let decoded = percent_encoding::percent_decode_str(segment).decode_utf8_lossy();
    if url.scheme() != "content" {
        // A file URL's final segment is the file name itself. It may hold a
        // colon ("Scan 10:30.pdf") and need not have an extension.
        return decoded.into_owned();
    }
    // The picker offers only PDFs, so a tail that does not end in ".pdf" is
    // part of an opaque id rather than a name. The fallback keeps the extension
    // so that an export still suggests a file the platform can open.
    // A document id is "<root>:<path>". Only the first colon separates them; a
    // later one belongs to the file name ("primary:Documents/Scan 10:30.pdf").
    let path = decoded.split_once(':').map_or(&*decoded, |(_, path)| path);
    let name = path.rsplit('/').next().unwrap_or_default();
    let is_pdf_name = name
        .rsplit_once('.')
        .is_some_and(|(stem, extension)| !stem.is_empty() && extension.eq_ignore_ascii_case("pdf"));
    if is_pdf_name {
        name.to_owned()
    } else {
        "Imported document.pdf".to_owned()
    }
}

#[tauri::command]
fn runtime_info() -> RuntimeInfo {
    current_runtime_info()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeedTestReport {
    #[serde(flatten)]
    measured: vault::KdfBenchmark,
    platform: String,
    architecture: String,
    app_version: String,
}

/// Times the passphrase key derivation on this device, for the record in
/// ARGON2_BENCHMARK.md. It uses a made-up passphrase, reads no vault and
/// changes nothing.
///
/// For testers, in the evaluation builds: to be taken out, with its section
/// in Security, before a release to patients.
///
/// Admission shares the vault's KDF guard, so a speed test cannot overlap
/// another passphrase operation. Locking remains available throughout.
#[tauri::command]
async fn kdf_benchmark(store: State<'_, Arc<VaultStore>>) -> CommandResult<SpeedTestReport> {
    let store = Arc::clone(store.inner());
    let measured = tauri::async_runtime::spawn_blocking(move || store.benchmark_kdf())
        .await
        .map_err(|_| PublicError {
            code: "speed_test_failed",
            message: "The speed test stopped before it finished. Nothing was changed. Try again.",
            record_id: None,
            note: None,
            retry_after_ms: None,
        })??;
    let RuntimeInfo {
        platform,
        architecture,
        app_version,
        ..
    } = current_runtime_info();
    Ok(SpeedTestReport {
        measured,
        platform,
        architecture,
        app_version,
    })
}

#[tauri::command]
async fn vault_status(store: State<'_, Arc<VaultStore>>) -> CommandResult<VaultStatus> {
    run_blocking(store.inner(), VaultStore::status).await
}

/// First setup's passphrase checklist (#69): three answers, only while no
/// vault exists. The request, passphrase and all, is wiped as the judgement
/// returns; nothing is kept, logged, or echoed in an error.
#[tauri::command]
async fn vault_passphrase_rules(
    store: State<'_, Arc<VaultStore>>,
    request: PassphraseRulesRequest,
) -> CommandResult<PassphraseRules> {
    run_blocking(store.inner(), move |store| {
        store.new_passphrase_rules(&request.passphrase, &request.initial_profile_name)
    })
    .await
}

#[tauri::command]
async fn vault_create(
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
    throttle: State<'_, Arc<AttemptThrottle>>,
    mut request: CreateVaultRequest,
) -> CommandResult<VaultSnapshot> {
    let picks = Arc::clone(picks.inner());
    let created = run_blocking(store.inner(), move |store| {
        let result = store
            .create(&request.passphrase, &request.initial_profile_name, now_ms())
            .inspect(|_| picks.clear())
            .and_then(|_| store.snapshot());
        request.passphrase.zeroize();
        result
    })
    .await;
    // Wrong tries at an earlier vault say nothing about this one.
    if created.is_ok() {
        forget_vault(throttle.inner()).await;
    }
    created
}

#[tauri::command]
async fn vault_unlock(
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
    throttle: State<'_, Arc<AttemptThrottle>>,
    mut request: PassphraseRequest,
) -> CommandResult<VaultSnapshot> {
    let picks = Arc::clone(picks.inner());
    tried(
        throttle.inner(),
        Attempt::Unlock,
        run_blocking(store.inner(), move |store| {
            let result = store
                .unlock(&request.passphrase)
                // A pick can read the session after a lock clears it but pass its
                // unlocked check before the lock lands. Starting a new session here
                // leaves such a pick in the one that ended.
                .inspect(|_| picks.clear());
            request.passphrase.zeroize();
            result
        }),
    )
    .await?;
    run_blocking(store.inner(), VaultStore::snapshot).await
}

#[tauri::command]
async fn vault_lock(
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
) -> CommandResult<()> {
    picks.clear();
    // A page still being drawn stops with the lock.
    pdf_view::cancel_views();
    run_blocking(store.inner(), |store| {
        store.lock();
        // Again once locked: a request that came in meanwhile stops too.
        pdf_view::cancel_views();
        Ok(())
    })
    .await
}

/// How often the native timer checks the idle deadline.
const IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(2);
/// The renderer reports input at most this often (`TOUCH_THROTTLE_MS`).
const RENDERER_TOUCH_THROTTLE: Duration = Duration::from_secs(10);
// The native deadline must not fire while the renderer is working: input
// reaches it up to one throttle late, which the margin must cover. The check
// interval only makes the native lock later.
const _: () = assert!(idle::MARGIN.as_secs() > RENDERER_TOUCH_THROTTLE.as_secs());

/// Locks the vault as the `vault_lock` command does, and clears pending picks,
/// once it has been idle past its deadline. Returns whether it locked. This is
/// the backstop for a renderer that hung, crashed or was suspended before its
/// own timer could lock.
fn lock_if_idle(store: &VaultStore, picks: &PendingPicks, now: Instant) -> bool {
    let locked = store.lock_if_idle(now);
    if locked {
        pdf_view::cancel_views();
        picks.clear();
    }
    locked
}

/// Counts time in a native picker as activity until it closes, capped by the
/// grace, on every path.
struct ActivityHold<'a>(&'a IdleDeadline);

impl<'a> ActivityHold<'a> {
    fn new(idle: &'a IdleDeadline) -> Self {
        idle.hold_started(Instant::now());
        Self(idle)
    }
}

impl Drop for ActivityHold<'_> {
    fn drop(&mut self) {
        self.0.hold_ended(Instant::now());
    }
}

/// The renderer reports user input, which the native idle deadline cannot see,
/// at most every 10 seconds.
#[tauri::command]
fn vault_touch(store: State<'_, Arc<VaultStore>>) {
    store.idle().touch(Instant::now());
}

#[derive(Deserialize)]
struct AutoLockRequest {
    minutes: u64,
}

/// The auto-lock setting lives in the renderer. It sends it when a session
/// starts and whenever it changes, retrying until one is accepted, so the
/// native deadline uses the same delay (clamped to 1-15 minutes). The renderer
/// restarts its own deadline then, so this counts as activity too.
#[tauri::command]
fn vault_set_auto_lock(store: State<'_, Arc<VaultStore>>, request: AutoLockRequest) {
    store
        .idle()
        .set_delay_minutes(request.minutes, Instant::now());
}

/// Runs a vault operation on the blocking thread pool.
///
/// Tauri runs a plain synchronous command on the main thread, and a synchronous
/// body marked `command(async)` on an async runtime worker. Neither may block,
/// and these operations all take the vault mutex, which import, export and
/// unlock hold for their whole duration; the mutating ones also make two fsynced
/// manifest commits. A stalled worker could also delay `vault_lock`.
async fn run_blocking<T, F>(store: &Arc<VaultStore>, operation: F) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce(&VaultStore) -> Result<T, VaultError> + Send + 'static,
{
    // A command is activity when it starts and again when it ends, so a long
    // one does not leave the deadline where it was before it began. One the
    // lock cut off (it returns `Cancelled`) is not: that lock must not be
    // undone by its own cancel. (A provider export's write pass reports a
    // partial copy instead, and is touched like any other failure.)
    let idle = Arc::clone(store.idle());
    idle.touch(Instant::now());
    let store = Arc::clone(store);
    let result = tauri::async_runtime::spawn_blocking(move || operation(&store))
        .await
        .map_err(|_| PublicError::from(VaultError::Storage))?;
    if !matches!(result, Err(VaultError::Cancelled)) {
        idle.touch(Instant::now());
    }
    result.map_err(Into::into)
}

#[tauri::command]
async fn vault_snapshot(store: State<'_, Arc<VaultStore>>) -> CommandResult<VaultSnapshot> {
    run_blocking(store.inner(), VaultStore::snapshot).await
}

#[tauri::command]
async fn vault_change_passphrase(
    store: State<'_, Arc<VaultStore>>,
    throttle: State<'_, Arc<AttemptThrottle>>,
    mut request: ChangePassphraseRequest,
) -> CommandResult<()> {
    // The current passphrase is checked as at unlock, and counted with it:
    // a vault left open must not let the passphrase be guessed without end.
    tried(
        throttle.inner(),
        Attempt::Unlock,
        run_blocking(store.inner(), move |store| {
            let result =
                store.change_passphrase(&request.current_passphrase, &request.new_passphrase);
            request.current_passphrase.zeroize();
            request.new_passphrase.zeroize();
            result
        }),
    )
    .await
}

/// A recovery key on its way to the renderer, wiped from native memory once
/// it has been serialized. (The serialized response is Tauri's to free.)
struct ShownRecoveryKey(zeroize::Zeroizing<String>);

impl Serialize for ShownRecoveryKey {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

/// The one place a key leaves the native side: the new recovery key, shown
/// once so that the patient can write it down. The current passphrase
/// authorizes it, as it does a passphrase change.
#[tauri::command]
async fn vault_recovery_key_begin(
    store: State<'_, Arc<VaultStore>>,
    throttle: State<'_, Arc<AttemptThrottle>>,
    mut request: PassphraseRequest,
) -> CommandResult<ShownRecoveryKey> {
    // As for a passphrase change: the passphrase is counted with unlock's.
    tried(
        throttle.inner(),
        Attempt::Unlock,
        run_blocking(store.inner(), move |store| {
            let result = store
                .begin_recovery_key(&request.passphrase)
                .map(ShownRecoveryKey);
            request.passphrase.zeroize();
            result
        }),
    )
    .await
}

/// The button of a native confirmation that closes it and changes nothing.
const NATIVE_CANCEL: &str = "Cancel";

/// Asks in a trusted native dialog, which page code cannot press, before
/// something that cannot be undone. Blocks until it is answered.
///
/// The first button keeps things as they are: on Windows and macOS it is
/// the Enter/Return default, and a dialog can appear while the patient is
/// typing. Linux has no explicit default and needs device testing. The button
/// that goes ahead comes second, and Cancel, which does what the first does,
/// third.
///
/// Three buttons, though two do the same, because each slot has a meaning
/// of its own on some platform. With two buttons and the safe one first,
/// the button that goes ahead would take the slot that Android reports
/// for the back button and a tap outside. And the third is titled "Cancel"
/// because that title is what gives a button the Escape key on macOS.
///
/// On a computer the dialog is given the app's window. On Windows and
/// macOS it then cannot end up behind it, and macOS shows it as an alert of
/// the window, whose keys are the documented ones. The Linux dialogs take
/// no notice of the window.
fn confirmed_natively<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    title: &str,
    message: impl Into<String>,
    keep: &str,
    go_ahead: &str,
) -> bool {
    // The dialog reports these words as answers of its own, not as the
    // button that was given them.
    debug_assert!(
        keep != go_ahead && !["Yes", "No", "Ok", NATIVE_CANCEL].contains(&go_ahead),
        "a button that goes ahead needs a label of its own"
    );
    let dialog = app
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            keep.to_owned(),
            go_ahead.to_owned(),
            NATIVE_CANCEL.to_owned(),
        ));
    #[cfg(desktop)]
    let dialog = match app.get_webview_window(MAIN_WINDOW) {
        Some(window) => dialog.parent(&window),
        None => dialog,
    };
    agreed_natively(&dialog.blocking_show_with_result(), go_ahead)
}

/// The label of the app's one window, which is the default one.
#[cfg(desktop)]
const MAIN_WINDOW: &str = "main";

/// Only the button that goes ahead counts as agreement: not the first
/// button, a closed dialog, or an answer the dialog could not give.
fn agreed_natively(answer: &MessageDialogResult, go_ahead: &str) -> bool {
    matches!(answer, MessageDialogResult::Custom(label) if label == go_ahead)
}

/// What the native confirmation says before a new recovery key takes the
/// place of the one the vault has.
const REPLACE_RECOVERY_KEY_WARNING: &str = "Your current recovery key will stop working once the new one is saved: a kit you saved or printed for it will no longer open this vault. Backups saved before now still open with the passphrase or recovery key they were saved with, the current key among them; once this is done, myCarlos says what to do about them. Before you continue, make sure you have written down or saved the new key. If you did not ask to replace your recovery key, choose Keep current key.";

impl ConfirmRecoveryKeyRequest {
    fn groups(&self) -> Vec<(usize, &str)> {
        self.groups
            .iter()
            .map(|group| (group.index, group.value.as_str()))
            .collect()
    }
}

impl Drop for ConfirmRecoveryKeyRequest {
    fn drop(&mut self) {
        for group in &mut self.groups {
            group.value.zeroize();
        }
    }
}

/// Makes the recovery key being set up the vault's. Replacing a key the
/// vault already has shuts the earlier one out, so, as for a reset, a
/// trusted native dialog confirms that first; the renderer's own check of
/// the key is not enough. Returns nothing if the patient cancelled there.
#[tauri::command]
async fn vault_recovery_key_confirm(
    app: tauri::AppHandle,
    store: State<'_, Arc<VaultStore>>,
    request: ConfirmRecoveryKeyRequest,
) -> CommandResult<Option<VaultSnapshot>> {
    run_blocking(store.inner(), move |store| {
        confirm_recovery_key_asking(store, &request.groups(), now_ms, || {
            confirmed_natively(
                &app,
                "Replace your recovery key?",
                REPLACE_RECOVERY_KEY_WARNING,
                "Keep current key",
                "Replace key",
            )
        })
    })
    .await
}

/// What `vault_recovery_key_confirm` decides, apart from the dialog, which
/// `confirm` shows: whether it answered yes.
fn confirm_recovery_key_asking(
    store: &VaultStore,
    groups: &[(usize, &str)],
    now_ms: impl FnOnce() -> u64,
    confirm: impl FnOnce() -> bool,
) -> Result<Option<VaultSnapshot>, VaultError> {
    // A mistyped answer is refused before anything is asked.
    let replaces = store.check_recovery_key(groups)?;
    // Held until the key is stored, for as long as a hold lasts, so that
    // the automatic lock does not fall while the dialog is read: it would
    // forget the key being set up, and the patient would press "Replace
    // key" to a vault that had locked.
    let _open = ActivityHold::new(store.idle());
    // A vault's first key replaces nothing, and is not asked about.
    if replaces && !confirm() {
        return Ok(None);
    }
    // Stored only if the key being set up, and whether it replaces one, are
    // still what the patient was asked about.
    store
        .confirm_recovery_key_replacing(groups, now_ms(), replaces)
        .map(Some)
}

/// The short label of the recovery key being set up, for the kit the page
/// prints. Not secret.
#[tauri::command]
async fn vault_recovery_key_label(store: State<'_, Arc<VaultStore>>) -> CommandResult<String> {
    run_blocking(store.inner(), VaultStore::pending_recovery_key_label).await
}

/// Saves the kit for the recovery key being set up to a file the patient
/// picks. Returns false if the picker was cancelled.
#[tauri::command]
async fn vault_recovery_kit_save(
    app: tauri::AppHandle,
    store: State<'_, Arc<VaultStore>>,
) -> CommandResult<bool> {
    // Nothing is asked for unless a key is waiting to be confirmed.
    let name = run_blocking(store.inner(), |store| store.recovery_kit_name(now_ms())).await?;
    // Held until the kit is written, so that the automatic lock cannot fall
    // between the picker closing and the write.
    let _open = ActivityHold::new(store.idle());
    let dialog = app.clone();
    let destination = tauri::async_runtime::spawn_blocking(move || {
        dialog
            .dialog()
            .file()
            .set_file_name(name)
            .blocking_save_file()
    })
    .await
    .map_err(|_| PublicError::from(VaultError::Storage))?;
    let Some(destination) = destination else {
        return Ok(false);
    };
    if let Ok(path) = destination.clone().into_path() {
        return run_blocking(store.inner(), move |store| {
            store.save_recovery_kit(&path, now_ms()).map(|()| true)
        })
        .await;
    }
    // Android content providers return a URI rather than a path.
    run_blocking(store.inner(), move |store| {
        use std::io::Write as _;
        let kit = store.recovery_kit(now_ms())?;
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        let mut output = app
            .fs()
            .open(destination, options)
            .map_err(|_| VaultError::Storage)?;
        output.write_all(kit.as_bytes())?;
        Ok(true)
    })
    .await
}

#[tauri::command]
async fn vault_recovery_key_cancel(store: State<'_, Arc<VaultStore>>) -> CommandResult<()> {
    run_blocking(store.inner(), |store| {
        store.cancel_recovery_key();
        Ok(())
    })
    .await
}

#[tauri::command]
async fn vault_recover(
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
    throttle: State<'_, Arc<AttemptThrottle>>,
    mut request: RecoverRequest,
) -> CommandResult<RecoverResponse> {
    let picks = Arc::clone(picks.inner());
    let passphrase_replaced = tried(
        throttle.inner(),
        Attempt::RecoveryKey,
        run_blocking(store.inner(), move |store| {
            let result = store
                .recover(&request.recovery_key, &request.new_passphrase)
                // As for unlock: a pick from the session that ended stays there.
                .inspect(|_| picks.clear());
            request.recovery_key.zeroize();
            request.new_passphrase.zeroize();
            result
        }),
    )
    .await?;
    Ok(RecoverResponse {
        passphrase_replaced,
        snapshot: run_blocking(store.inner(), VaultStore::snapshot).await?,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupPickRequest {
    /// Today's date on the patient's own calendar, `YYYY-MM-DD`.
    #[serde(default)]
    local_date: Option<String>,
}

/// Whether `text` reads as a date, `YYYY-MM-DD`: digits and two dashes,
/// nothing that could reach a file name otherwise.
fn is_plain_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

/// What a saved backup was: the name of the file written, where the
/// platform says it, and how many bytes it holds, which tells a complete
/// file from an empty or partial one.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedBackup {
    name: Option<String>,
    bytes: Option<u64>,
}

/// Counts what passes through it.
struct Counted<W> {
    inner: W,
    bytes: Arc<AtomicU64>,
}

impl<W: std::io::Write> std::io::Write for Counted<W> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buffer)?;
        self.bytes.fetch_add(written as u64, Ordering::Relaxed);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Runs a command that tries a secret for `attempt`: refused, before any
/// work, while the wait after earlier wrong tries runs. The try is counted
/// before it runs, so that tries sent together cannot all pass; a wrong
/// passphrase or recovery key then stays counted, the right one clears the
/// count, and anything else (a key mistyped in its check characters, a
/// storage error) is taken back off it, with the time of the wrong try
/// before it, unless another try has counted since. `command` is only the
/// check of the secret: what follows a right one (reading the vault's state)
/// runs after it, so that its failure does not leave the count.
async fn tried<T>(
    throttle: &Arc<AttemptThrottle>,
    attempt: Attempt,
    command: impl std::future::Future<Output = CommandResult<T>>,
) -> CommandResult<T> {
    // A try the app is killed during stays counted: that must not be a way
    // round the count.
    let now = now_ms();
    let started = on_throttle(throttle, move |throttle| throttle.begin(attempt, now))
        .await?
        .map_err(PublicError::wait)?;
    let result = command.await;
    let now = now_ms();
    let outcome = match &result {
        Ok(_) => Outcome::Right,
        Err(error) if matches!(error.code, "wrong_passphrase" | "wrong_recovery_key") => {
            Outcome::Wrong
        }
        Err(_) => Outcome::Neither,
    };
    // A settle lost to a failed thread leaves the try counted, as a kill does.
    let _ = on_throttle(throttle, move |throttle| {
        throttle.settle(attempt, started, outcome, now)
    })
    .await;
    result
}

/// The vault the counts were about is gone or replaced: its counts go too.
async fn forget_vault(throttle: &Arc<AttemptThrottle>) {
    let now = now_ms();
    // A clear lost to a failed thread leaves the counts as they were.
    let _ = on_throttle(throttle, move |throttle| throttle.forget_vault(now)).await;
}

/// Runs `work` on the throttle away from the async runtime, as it reads and
/// writes its file.
async fn on_throttle<R, F>(throttle: &Arc<AttemptThrottle>, work: F) -> CommandResult<R>
where
    R: Send + 'static,
    F: FnOnce(&AttemptThrottle) -> R + Send + 'static,
{
    let throttle = Arc::clone(throttle);
    tauri::async_runtime::spawn_blocking(move || work(&throttle))
        .await
        .map_err(|_| PublicError::from(VaultError::Storage))
}

/// Asks where to save an encrypted backup. The backup itself is written by
/// `vault_backup_picked`, so that the renderer can treat it as a transfer.
#[tauri::command]
async fn vault_backup_pick(
    app: tauri::AppHandle,
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
    request: BackupPickRequest,
) -> CommandResult<Option<Uuid>> {
    let session = picks.session();
    // Named by the patient's own date where the renderer gives one that
    // reads as a date, else by the UTC date.
    let date = request
        .local_date
        .as_deref()
        .filter(|date| is_plain_date(date))
        .map_or_else(|| vault::utc_date_text(now_ms()), str::to_owned);
    // Nothing is asked for unless there is a writable vault to back up.
    run_blocking(store.inner(), |store| match store.snapshot()?.recovery {
        None => Ok(()),
        Some(_) => Err(VaultError::RecoveryMode),
    })
    .await?;
    let name = run_blocking(store.inner(), move |store| store.backup_file_name(&date)).await?;
    let _open = ActivityHold::new(store.idle());
    let destination = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_file_name(name).blocking_save_file()
    })
    .await
    .map_err(|_| PublicError::from(VaultError::Storage))?;
    Ok(destination.map(|destination| picks.backups.store(session, destination)))
}

#[tauri::command]
async fn vault_backup_picked(
    app: tauri::AppHandle,
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
    request: PickRequest,
) -> CommandResult<SavedBackup> {
    let destination = picks
        .backups
        .take(request.pick_id, picks.session())
        .ok_or(VaultError::NotFound)?;
    if let Ok(path) = destination.clone().into_path() {
        // The name the patient gave it, or the one they saved over, for the
        // steps that follow a key replacement: the file to keep.
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned());
        // Written beside the destination and renamed over it only once
        // complete: a failure leaves nothing there.
        return run_blocking(store.inner(), move |store| {
            store.backup_atomic(&path, now_ms())?;
            Ok(SavedBackup {
                name,
                bytes: std::fs::metadata(&path).ok().map(|metadata| metadata.len()),
            })
        })
        .await
        .map_err(|error| error.of_backup(BackupDestination::Path));
    }
    // Android content providers return a URI rather than a path, and no
    // name. A backup holds only ciphertext, so a partial one left by a
    // failure is not readable, only incomplete, and restoring it is
    // refused. Whether the document was opened, and so emptied, decides
    // what a failure says may be left there.
    let emptied = Arc::new(AtomicBool::new(false));
    let opened = Arc::clone(&emptied);
    let bytes = Arc::new(AtomicU64::new(0));
    let counted = Arc::clone(&bytes);
    run_blocking(store.inner(), move |store| {
        // Opening the document empties it, and it may be an earlier backup:
        // find a document that cannot be backed up before that.
        store.verify_for_backup()?;
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        let opening = Opening::new(store.idle());
        let output = app
            .fs()
            .open(destination, options)
            .map_err(|_| VaultError::Storage)?;
        opened.store(true, Ordering::Release);
        drop(opening);
        store.backup(
            std::io::BufWriter::new(Counted {
                inner: output,
                bytes: counted,
            }),
            now_ms(),
        )
    })
    .await
    .map(|()| SavedBackup {
        name: None,
        bytes: Some(bytes.load(Ordering::Relaxed)),
    })
    .map_err(|error| {
        error.of_backup(if emptied.load(Ordering::Acquire) {
            BackupDestination::ProviderEmptied
        } else {
            BackupDestination::ProviderUntouched
        })
    })
}

/// Asks which backup to restore. Only while no vault is open.
#[tauri::command]
async fn vault_restore_pick(
    app: tauri::AppHandle,
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
) -> CommandResult<Option<Uuid>> {
    let session = picks.session();
    run_blocking(store.inner(), |store| match store.status()? {
        VaultStatus::Unlocked => Err(VaultError::Invalid),
        _ => Ok(()),
    })
    .await?;
    let source = tauri::async_runtime::spawn_blocking(move || {
        let picker = app.dialog().file();
        // Phone pickers filter by file type, and a backup has none they know,
        // so a filter there could hide every file.
        #[cfg(desktop)]
        let picker = picker.add_filter("myCarlos backups", &["mycarlosbackup"]);
        picker.blocking_pick_file()
    })
    .await
    .map_err(|_| PublicError::from(VaultError::Storage))?;
    Ok(source.map(|source| picks.restores.store(session, source)))
}

fn open_restore_source(
    app: &tauri::AppHandle,
    source: tauri_plugin_fs::FilePath,
) -> Result<Box<dyn std::io::Read + Send>, VaultError> {
    // Said of the file, and that nothing changed: a restore that cannot
    // start from it has not touched the vault.
    if let Ok(path) = source.clone().into_path() {
        // As for imports: a regular file, opened without following a link or
        // waiting on a pipe or device.
        return Ok(Box::new(std::io::BufReader::new(
            vault::open_regular_read(&path).map_err(|_| VaultError::BackupNotOpened)?,
        )));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    let file = app
        .fs()
        .open(source, options)
        .map_err(|_| VaultError::BackupNotOpened)?;
    Ok(Box::new(std::io::BufReader::new(file)))
}

/// Opens the chosen backup with its credential and says what restoring it
/// would replace. The pick stays for `vault_restore`.
#[tauri::command]
async fn vault_restore_inspect(
    app: tauri::AppHandle,
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
    throttle: State<'_, Arc<AttemptThrottle>>,
    mut request: RestoreRequest,
) -> CommandResult<RestorePreview> {
    let source = picks
        .restores
        .peek_within(request.pick_id, picks.session(), RESTORE_PICK_TTL)
        .ok_or(VaultError::NotFound)?;
    tried(throttle.inner(), Attempt::Backup, async move {
        run_blocking(store.inner(), move |store| {
            let result = request.credential().and_then(|credential| {
                store.inspect_backup(open_restore_source(&app, source)?, credential)
            });
            request.zeroize();
            result
        })
        .await
        .map_err(PublicError::of_restore)
    })
    .await
}

/// What the native confirmation says before a restore replaces a vault. It
/// is worked out here from the backup and the vault themselves, never taken
/// from the renderer.
fn restore_warning(preview: &RestorePreview) -> Option<String> {
    let documents = match preview.document_count {
        1 => "1 document".to_owned(),
        count => format!("{count} documents"),
    };
    match preview.replaces {
        RestoreReplaces::Nothing => None,
        RestoreReplaces::OtherVault => Some(format!(
            "The vault on this device is not the vault this backup was made from. Restoring permanently erases the vault on this device, and everything in it, and puts the backup ({documents}) in its place. This cannot be undone."
        )),
        RestoreReplaces::Unreadable => Some(format!(
            "The vault on this device could not be read, so myCarlos cannot tell whether it is the one this backup was made from. Restoring permanently erases the vault on this device, and everything in it, and puts the backup ({documents}) in its place. This cannot be undone."
        )),
        RestoreReplaces::SameVault if preview.differs_from_this_device => Some(format!(
            "The vault on this device may not be the same as this backup ({documents}): it may have changed since, or part of it could not be read. Restoring permanently replaces it: anything in the vault that is not in the backup is lost, and the passphrase and recovery key become the ones the backup was made with. This cannot be undone."
        )),
        RestoreReplaces::SameVault => Some(format!(
            "Restoring replaces the vault on this device with the backup, which holds the same {documents}. This cannot be undone."
        )),
    }
}

/// Restores the chosen backup. Replacing a vault erases it, so, as for a
/// reset, a trusted native dialog confirms that first, and says what would be
/// lost; the renderer's own agreement is not enough. Returns false if the
/// patient cancelled there.
#[tauri::command]
async fn vault_restore(
    app: tauri::AppHandle,
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
    throttle: State<'_, Arc<AttemptThrottle>>,
    request: RestoreRequest,
) -> CommandResult<bool> {
    // Checked before the dialog, and taken only after it, so that a cancelled
    // dialog leaves the pick for another try.
    let source = picks
        .restores
        .peek_within(request.pick_id, picks.session(), RESTORE_PICK_TTL)
        .ok_or(VaultError::NotFound)?;
    let request = Arc::new(request);
    let preview = {
        let (app, request) = (app.clone(), Arc::clone(&request));
        tried(
            throttle.inner(),
            Attempt::Backup,
            run_blocking(store.inner(), move |store| {
                store.inspect_backup(open_restore_source(&app, source)?, request.credential()?)
            }),
        )
        .await
        .map_err(PublicError::of_restore)?
    };
    if let Some(warning) = restore_warning(&preview) {
        // The renderer must have asked for a replacement too.
        if !request.replace {
            return Err(PublicError::from(VaultError::AlreadyExists));
        }
        let dialog_app = app.clone();
        let confirmed = tauri::async_runtime::spawn_blocking(move || {
            confirmed_natively(
                &dialog_app,
                "Replace the vault on this device?",
                warning,
                "Keep this vault",
                "Replace with backup",
            )
        })
        .await
        .map_err(|_| PublicError::from(VaultError::Storage))?;
        if !confirmed {
            return Ok(false);
        }
    }
    let source = picks
        .restores
        .take_within(request.pick_id, picks.session(), RESTORE_PICK_TTL)
        .ok_or(VaultError::NotFound)?;
    run_blocking(store.inner(), move |store| {
        // The file is opened again here. Another backup in its place by now,
        // or a vault that appeared or changed since, is not what the dialog
        // described, and is refused.
        store.restore_confirmed(
            open_restore_source(&app, source)?,
            request.credential()?,
            &preview,
        )
    })
    .await
    .map_err(PublicError::of_restore)?;
    // The vault the counts were about is replaced, or there was none.
    forget_vault(throttle.inner()).await;
    Ok(true)
}

#[tauri::command]
async fn vault_create_profile(
    store: State<'_, Arc<VaultStore>>,
    request: NameRequest,
) -> CommandResult<Uuid> {
    run_blocking(store.inner(), move |store| {
        store.create_profile(&request.display_name, now_ms())
    })
    .await
}

#[tauri::command]
async fn vault_create_folder(
    store: State<'_, Arc<VaultStore>>,
    request: FolderRequest,
) -> CommandResult<Uuid> {
    run_blocking(store.inner(), move |store| {
        store.create_folder(
            request.profile_id,
            request.parent_id,
            &request.name,
            now_ms(),
        )
    })
    .await
}

#[tauri::command]
async fn vault_update_folder(
    store: State<'_, Arc<VaultStore>>,
    request: UpdateFolderRequest,
) -> CommandResult<()> {
    run_blocking(store.inner(), move |store| {
        store.update_folder(request.folder_id, request.parent_id, &request.name)
    })
    .await
}

#[tauri::command]
async fn vault_rename_record(
    store: State<'_, Arc<VaultStore>>,
    request: RenameRecordRequest,
) -> CommandResult<()> {
    run_blocking(store.inner(), move |store| {
        store.rename_record(request.record_id, &request.name)
    })
    .await
}

#[tauri::command]
async fn vault_assign_folders(
    store: State<'_, Arc<VaultStore>>,
    request: AssignFoldersRequest,
) -> CommandResult<()> {
    run_blocking(store.inner(), move |store| {
        store.assign_folders(request.record_id, request.folder_ids)
    })
    .await
}

#[tauri::command]
async fn vault_assign_folders_batch(
    store: State<'_, Arc<VaultStore>>,
    request: AssignFoldersBatchRequest,
) -> CommandResult<()> {
    run_blocking(store.inner(), move |store| {
        store.assign_folders_batch(request.record_ids, request.folder_ids)
    })
    .await
}

/// Opens the file picker. Returns the id of the chosen files, or `None` when
/// the picker was cancelled. The import itself is `vault_import_picked`.
#[tauri::command]
async fn vault_import_pick(
    app: tauri::AppHandle,
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
    request: ImportRequest,
) -> CommandResult<Option<Uuid>> {
    vault::validate_folder_assignment_count(request.folder_ids.len()).map_err(PublicError::from)?;
    let session = picks.session();
    // Refuse before the picker opens; `import` still re-checks under its own lock.
    let profile_id = request.profile_id;
    run_blocking(store.inner(), move |store| {
        store.ensure_import_allowed(profile_id)
    })
    .await?;
    let _open = ActivityHold::new(store.idle());
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("PDF documents", &["pdf"])
            .blocking_pick_files()
    })
    .await
    .map_err(|_| PublicError::from(VaultError::Storage))?;
    let Some(paths) = picked else {
        return Ok(None);
    };
    vault::validate_import_count(paths.len()).map_err(PublicError::from)?;
    Ok(Some(picks.store_import(session, request, paths)))
}

#[tauri::command]
async fn vault_import_picked(
    app: tauri::AppHandle,
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
    request: PickedImportRequest,
) -> CommandResult<vault::ImportOutcome> {
    vault::validate_folder_assignment_count(request.folder_ids.len()).map_err(PublicError::from)?;
    let picked_for = ImportRequest {
        profile_id: request.profile_id,
        folder_ids: request.folder_ids.clone(),
    };
    let paths = picks.take_import(request.pick_id, &picked_for)?;
    // Opening a source can block: a network path, or a content provider that
    // fetches the document first. It belongs on the blocking pool with the import.
    run_blocking(store.inner(), move |store| {
        let mut sources = Vec::with_capacity(paths.len());
        {
            // A provider may download a whole document before the open returns,
            // with no progress to report meanwhile.
            let _opening = Opening::new(store.idle());
            for path in paths {
                sources.push(open_import_source(&app, path)?);
            }
        }
        store.import(request.profile_id, request.folder_ids, sources, now_ms())
    })
    .await
}

fn open_import_source(
    app: &tauri::AppHandle,
    path: tauri_plugin_fs::FilePath,
) -> Result<ImportSource, VaultError> {
    let display_name = import_display_name(&path);
    Ok(ImportSource {
        display_name,
        reader: require_pdf(open_source_reader(app, path)?)?,
    })
}

/// A received file, opened the way a picked one is. Its name was cleaned when it arrived.
fn open_received_source(
    app: &tauri::AppHandle,
    file: received::ReceivedFile,
) -> Result<ImportSource, VaultError> {
    Ok(ImportSource {
        reader: require_pdf(open_received_reader(app, &file)?)?,
        display_name: file.name,
    })
}

fn open_received_reader(
    app: &tauri::AppHandle,
    file: &received::ReceivedFile,
) -> Result<Box<dyn std::io::Read + Send>, VaultError> {
    let path = match &file.source {
        ReceivedSource::Path(path) => tauri_plugin_fs::FilePath::Path(path.clone()),
        ReceivedSource::ContentUri(url) => tauri_plugin_fs::FilePath::Url(url.clone()),
    };
    open_source_reader(app, path)
}

fn open_source_reader(
    app: &tauri::AppHandle,
    path: tauri_plugin_fs::FilePath,
) -> Result<Box<dyn std::io::Read + Send>, VaultError> {
    #[cfg(desktop)]
    {
        if let Ok(local_path) = path.clone().into_path() {
            let file = vault::open_regular_read(&local_path).map_err(import_source_error)?;
            return Ok(Box::new(file));
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    let file = app
        .fs()
        .open(path, options)
        .map_err(|_| VaultError::Storage)?;
    Ok(Box::new(file))
}

/// Refuses a file that does not start the way a PDF does. The start is read while the file is
/// opened, so a refused file stops the import before anything is staged.
fn require_pdf(
    reader: Box<dyn std::io::Read + Send>,
) -> Result<Box<dyn std::io::Read + Send>, VaultError> {
    received::require_pdf_header(reader).map_err(|error| {
        if received::is_not_pdf(&error) {
            VaultError::NotPdf
        } else {
            VaultError::from(error)
        }
    })
}

/// A picked file that cannot be opened is a problem with that file, not with
/// the vault, so only an unexplained failure is reported as a storage error.
#[cfg(desktop)]
fn import_source_error(error: io::Error) -> VaultError {
    match error.kind() {
        // Moved, renamed or deleted after it was picked.
        io::ErrorKind::NotFound => VaultError::NotFound,
        // Not a regular file, such as a link or a device.
        io::ErrorKind::InvalidData => VaultError::Invalid,
        _ => VaultError::Storage,
    }
}

/// What the renderer may see of the files received from other apps.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReceivedState {
    files: Vec<received::ReceivedSummary>,
    notice: received::ReceiveNotice,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveToPersonRequest {
    record_ids: Vec<Uuid>,
    profile_id: Uuid,
    folder_ids: Vec<Uuid>,
}

/// What adding the waiting files to Shared with me did (#61).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReceivedAcceptOutcome {
    imported: Vec<Uuid>,
    skipped_duplicates: Vec<String>,
    /// Files that are not PDF documents: not added, and forgotten.
    not_pdf: Vec<String>,
}

/// The files waiting for the patient, and what could not be taken since the last call. The
/// renderer asks at start, after an unlock, and whenever the window comes back to the front,
/// which is how a share arrives. Names stay off the lock screen: the renderer shows a count
/// there.
#[tauri::command]
fn received_list(received: State<'_, Arc<ReceivedFiles>>) -> ReceivedState {
    ReceivedState {
        files: received.list(),
        notice: received.take_notice(),
    }
}

/// Adds every waiting file to Shared with me (#61): the renderer asks at unlock, and whenever a
/// file arrives while the vault is open. A file that is not a PDF is not added and is forgotten,
/// and named in the outcome. When anything else fails, every file keeps waiting for the next ask.
#[tauri::command]
async fn received_accept(
    app: tauri::AppHandle,
    store: State<'_, Arc<VaultStore>>,
    received: State<'_, Arc<ReceivedFiles>>,
) -> CommandResult<ReceivedAcceptOutcome> {
    let ids: Vec<Uuid> = received.list().into_iter().map(|file| file.id).collect();
    if ids.is_empty() {
        return Ok(ReceivedAcceptOutcome {
            imported: Vec::new(),
            skipped_duplicates: Vec::new(),
            not_pdf: Vec::new(),
        });
    }
    let taken = received
        .take(&ids)
        .ok_or_else(|| PublicError::from(VaultError::NotFound))?;
    let files = taken.clone();
    let result = run_blocking(store.inner(), move |store| {
        let shared = store.shared_profile()?;
        let mut sources = Vec::with_capacity(files.len());
        let mut not_pdf = Vec::new();
        {
            let _opening = Opening::new(store.idle());
            for (_, file) in files {
                let name = file.name.clone();
                match open_received_source(&app, file) {
                    Ok(source) => sources.push(source),
                    Err(VaultError::NotPdf) => not_pdf.push(name),
                    Err(error) => return Err(error),
                }
            }
        }
        let outcome = store.import(shared, Vec::new(), sources, now_ms())?;
        Ok(ReceivedAcceptOutcome {
            imported: outcome.imported,
            skipped_duplicates: outcome.skipped_duplicates,
            not_pdf,
        })
    })
    .await;
    match result {
        Ok(outcome) => {
            received.finish(&taken);
            Ok(outcome)
        }
        Err(error) => {
            received.restore(taken);
            Err(error)
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewPageRequest {
    record_id: Uuid,
    page: u32,
    width: u32,
    /// The document's own password, when it is locked with one. Not the vault passphrase.
    password: Option<String>,
}

// Wiped however the command ends, including a try refused before it runs.
impl Drop for ViewPageRequest {
    fn drop(&mut self) {
        if let Some(password) = self.password.as_mut() {
            password.zeroize();
        }
    }
}

/// One page of a stored document, drawn by the PDF helper, and its text.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewedPage {
    page_count: u32,
    width: u32,
    height: u32,
    /// A `data:` URL of the PNG picture: the page's CSP allows only those for pictures.
    image: String,
    text: String,
}

/// Shows one page of a stored document. The record is decrypted into memory only and handed to
/// the PDF helper, which draws the page away from the vault keys (`pdf_view`).
#[tauri::command]
async fn vault_view_page(
    store: State<'_, Arc<VaultStore>>,
    mut request: ViewPageRequest,
) -> CommandResult<ViewedPage> {
    use base64::Engine;
    use pdf_unlock::Refusal;
    let (record_id, page, width) = (request.record_id, request.page, request.width);
    let given = request.password.is_some();
    let password = zeroize::Zeroizing::new(request.password.take().unwrap_or_default());
    drop(request);
    // Taken now: a newer page request, a lock or the reader closing stops this one.
    let ticket = pdf_view::ViewTicket::new();
    run_blocking(store.inner(), move |store| {
        let size = store
            .snapshot()?
            .records
            .iter()
            .find(|record| record.id == record_id)
            .ok_or(VaultError::NotFound)?
            .plaintext_size;
        if size > pdf_unlock::MAX_LOCKED_PDF_BYTES as u64 {
            return Err(VaultError::PdfTooLarge);
        }
        // Already replaced by a newer request: nothing to decrypt.
        if !ticket.is_current() {
            return Err(VaultError::Cancelled);
        }
        // Sized up front, so the document is never copied by a growing buffer.
        let mut document = zeroize::Zeroizing::new(Vec::with_capacity(size as usize));
        store.export(record_id, &mut *document)?;
        match pdf_view::view_in_helper(&document, &password, page, width, &ticket) {
            pdf_view::Outcome::Shown(shown) => Ok(ViewedPage {
                page_count: shown.page_count,
                width: shown.width,
                height: shown.height,
                image: format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(&shown.png)
                ),
                text: shown.text,
            }),
            pdf_view::Outcome::Refused(Refusal::WrongPassword) if given => {
                Err(VaultError::PdfWrongPassword)
            }
            pdf_view::Outcome::Refused(Refusal::WrongPassword) => Err(VaultError::PdfLocked),
            pdf_view::Outcome::Refused(Refusal::TooLarge) => Err(VaultError::PdfTooLarge),
            pdf_view::Outcome::Refused(Refusal::NoSuchPage) => Err(VaultError::Invalid),
            pdf_view::Outcome::Unavailable => Err(VaultError::PdfViewUnavailable),
            pdf_view::Outcome::Cancelled => Err(VaultError::Cancelled),
            pdf_view::Outcome::Refused(_) | pdf_view::Outcome::Failed => {
                Err(VaultError::PdfViewFailed)
            }
        }
    })
    .await
}

/// Stops any page being drawn: the reader closed.
#[tauri::command]
fn vault_view_cancel() {
    pdf_view::cancel_views();
}

/// Moves files from Shared with me to a person, into the folders chosen (#61). A file the
/// person already has stays where it is and is named in the outcome.
#[tauri::command]
async fn vault_move_to_person(
    store: State<'_, Arc<VaultStore>>,
    request: MoveToPersonRequest,
) -> CommandResult<vault::MoveOutcome> {
    vault::validate_folder_assignment_count(request.folder_ids.len()).map_err(PublicError::from)?;
    run_blocking(store.inner(), move |store| {
        store.move_to_profile(request.record_ids, request.profile_id, request.folder_ids)
    })
    .await
}

/// Files another app opened with myCarlos, on the Mac, iPhone and Android.
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
fn receive_opened(app: &tauri::AppHandle, urls: &[Url]) {
    let Some(received) = app.try_state::<Arc<ReceivedFiles>>() else {
        return;
    };
    #[cfg(target_os = "android")]
    let own_authority = format!("{}.fileprovider", app.config().identifier);
    #[cfg(target_os = "android")]
    let platform = received::OpenedPlatform::Android {
        own_authority: &own_authority,
    };
    #[cfg(not(target_os = "android"))]
    let platform = received::OpenedPlatform::Apple;
    let sources = urls
        .iter()
        .filter_map(|url| received::accept_opened_url(url, platform))
        .collect();
    received.receive(urls.len(), sources);
}

/// Opens the save picker with the record's name. Returns the id of the chosen
/// destination, or `None` when the picker was cancelled. The copy itself is
/// written by `vault_export_picked`.
#[tauri::command]
async fn vault_export_pick(
    app: tauri::AppHandle,
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
    request: ExportRequest,
) -> CommandResult<Option<Uuid>> {
    let record_id = request.record_id;
    let session = picks.session();
    let suggested_name =
        run_blocking(store.inner(), move |store| store.export_name(record_id)).await?;
    let _open = ActivityHold::new(store.idle());
    let destination = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(suggested_name)
            .blocking_save_file()
    })
    .await
    .map_err(|_| PublicError::from(VaultError::Storage))?;
    Ok(destination.map(|destination| picks.store_export(session, record_id, destination)))
}

#[tauri::command]
async fn vault_export_picked(
    app: tauri::AppHandle,
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
    request: PickedExportRequest,
) -> CommandResult<()> {
    let record_id = request.record_id;
    let destination = picks.take_export(request.pick_id, record_id)?;

    if let Ok(destination_path) = destination.clone().into_path() {
        return run_blocking(store.inner(), move |store| {
            store.export_atomic(record_id, &destination_path)
        })
        .await;
    }

    // Android content providers can return a content URI rather than a filesystem path, so an
    // atomic rename is unavailable. Authenticate the complete object before opening/truncating
    // the selected URI; the second pass streams the verified plaintext to the provider.
    run_blocking(store.inner(), move |store| {
        store.export(record_id, std::io::sink())
    })
    .await?;

    // Opening the provider's document can block too, so it shares the blocking
    // task with the write. Only a failure after the open, which truncates the
    // destination, can leave a partial copy; a failed open changed nothing.
    run_blocking(store.inner(), move |store| {
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        let opening = Opening::new(store.idle());
        let mut output = app
            .fs()
            .open(destination, options)
            .map_err(|_| VaultError::Storage)?;
        drop(opening);
        Ok(store.export(record_id, &mut output))
    })
    .await?
    .map_err(|_| PublicError::partial_export())
}

#[tauri::command]
async fn vault_remove_unavailable_records(
    store: State<'_, Arc<VaultStore>>,
    request: RemoveUnavailableRequest,
) -> CommandResult<Vec<Uuid>> {
    run_blocking(store.inner(), move |store| {
        store.remove_unavailable_records(&request.confirmed)
    })
    .await
    .map_err(|error| match error.code {
        "recovery_mode" => PublicError::removal_not_possible(),
        _ => error,
    })
}

/// Saves a photo taken with the camera dialog. The request's body is its
/// target and the JPEG (see `photo_request`).
#[tauri::command]
async fn vault_save_photo(
    store: State<'_, Arc<VaultStore>>,
    request: tauri::ipc::Request<'_>,
) -> CommandResult<vault::ImportOutcome> {
    // The IPC layer's own copy is freed when the call ends, but not
    // overwritten (THREAT_MODEL.md); these are.
    let (target, photo) = photo_request(request.body())?;
    run_blocking(store.inner(), move |store| save_photo(store, target, photo)).await
}

#[tauri::command]
async fn vault_is_photo(
    store: State<'_, Arc<VaultStore>>,
    request: PhotoRequest,
) -> CommandResult<bool> {
    run_blocking(store.inner(), move |store| {
        is_photo(store, request.record_id)
    })
    .await
}

#[tauri::command]
async fn vault_view_photo(
    store: State<'_, Arc<VaultStore>>,
    request: PhotoRequest,
) -> CommandResult<String> {
    run_blocking(store.inner(), move |store| {
        view_photo(store, request.record_id)
    })
    .await
}

#[tauri::command]
async fn vault_is_locked_pdf(
    store: State<'_, Arc<VaultStore>>,
    request: PhotoRequest,
) -> CommandResult<bool> {
    run_blocking(store.inner(), move |store| {
        is_locked_pdf(store, request.record_id)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnlockPdfRequest {
    record_id: Uuid,
    password: String,
}

// Wiped however the command ends, including a try refused before it runs.
impl Drop for UnlockPdfRequest {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

/// Unlocks a stored PDF with the password the patient typed (#54); see
/// `unlock_pdf`. The password is used once and wiped.
#[tauri::command]
async fn vault_unlock_pdf(
    store: State<'_, Arc<VaultStore>>,
    mut request: UnlockPdfRequest,
) -> CommandResult<UnlockedPdf> {
    let record_id = request.record_id;
    let password = zeroize::Zeroizing::new(std::mem::take(&mut request.password));
    drop(request);
    run_blocking(store.inner(), move |store| {
        // The helper's time counts as activity: the vault does not lock under it.
        let _opening = Opening::new(store.idle());
        unlock_pdf(store, record_id, &password, pdf_unlock::unlock_in_helper)
    })
    .await
}

#[tauri::command]
async fn vault_delete_record(
    store: State<'_, Arc<VaultStore>>,
    request: DeleteRecordRequest,
) -> CommandResult<()> {
    run_blocking(store.inner(), move |store| {
        store.delete_record(request.record_id)
    })
    .await
}

const ERASE_VAULT_WARNING: &str = "This permanently erases every encrypted document, profile, and folder in this vault. This cannot be undone.";

#[tauri::command]
async fn vault_reset(
    app: tauri::AppHandle,
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
    throttle: State<'_, Arc<AttemptThrottle>>,
    request: ResetRequest,
) -> CommandResult<bool> {
    if request.confirmation != "RESET MYCARLOS VAULT" {
        return Err(PublicError::from(VaultError::Invalid));
    }
    let dialog_app = app.clone();
    let confirmed = tauri::async_runtime::spawn_blocking(move || {
        confirmed_natively(
            &dialog_app,
            "Erase the entire myCarlos vault?",
            ERASE_VAULT_WARNING,
            "Keep this vault",
            "Erase vault",
        )
    })
    .await
    .map_err(|_| PublicError::from(VaultError::Storage))?;
    if !confirmed {
        return Ok(false);
    }
    picks.clear();
    run_blocking(store.inner(), VaultStore::reset).await?;
    // The vault the counts were about is gone.
    forget_vault(throttle.inner()).await;
    Ok(true)
}

/// The scheme and host the bundled pages are served from.
type Origin = (&'static str, &'static str);

/// Where this platform serves the bundled pages from. Windows and Android
/// cannot use the app's own scheme and use a host name instead.
///
/// The app has one window, so its setting is every webview's.
fn bundled_origin(config: &tauri::Config) -> Origin {
    let https = config
        .app
        .windows
        .first()
        .is_some_and(|window| window.use_https_scheme);
    origin_for(cfg!(windows) || cfg!(target_os = "android"), https)
}

fn origin_for(uses_host_name: bool, https: bool) -> Origin {
    match (uses_host_name, https) {
        (false, _) => ("tauri", "localhost"),
        (true, false) => ("http", "tauri.localhost"),
        (true, true) => ("https", "tauri.localhost"),
    }
}

/// Whether the app's window may load `url`: only the app's own bundled
/// pages, and in a development build the development server's.
///
/// The content security policy keeps page code from sending anything over
/// the network, but it does not govern where the window itself goes. Page
/// code that went to another site could take what it holds along in the
/// address, and that site could then imitate the unlock screen.
///
/// Only this platform's own origin counts as bundled. Another platform's
/// would be an address on the network here: `http://tauri.localhost` is
/// whatever listens on this machine's port 80.
fn navigation_allowed(url: &Url, bundled: Origin, dev_url: Option<&Url>) -> bool {
    let (scheme, host) = bundled;
    let is_bundled = url.scheme() == scheme
        && url.host_str() == Some(host)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    is_bundled || dev_url.is_some_and(|dev| url.origin() == dev.origin())
}

/// `navigation_allowed` for this build: the development server counts only
/// in a development build, though every build's configuration names it.
fn may_navigate(config: &tauri::Config, url: &Url) -> bool {
    let dev_url = tauri::is_dev()
        .then_some(config.build.dev_url.as_ref())
        .flatten();
    navigation_allowed(url, bundled_origin(config), dev_url)
}

// Keep app code from running until Windows request interception is installed.
#[cfg(any(windows, test))]
#[derive(Default)]
struct NavigationStartup {
    armed: bool,
    pending: Option<Url>,
}

#[cfg(any(windows, test))]
impl NavigationStartup {
    fn permit(&mut self, url: &Url, allowed: bool) -> bool {
        if !allowed {
            return false;
        }
        if !self.armed {
            self.pending = Some(url.clone());
            return false;
        }
        true
    }

    fn arm(&mut self) -> Option<Url> {
        self.armed = true;
        self.pending.take()
    }
}

/// Applies the rule to every webview the app creates.
fn navigation_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|webview, url| may_navigate(webview.config(), url))
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(navigation_guard())
        .setup(|app| {
            // The window is made here, not by the configuration, so that it
            // can refuse to open others: nothing in the app opens a window,
            // and one opened by page code would load whatever it was given.
            // (Desktop only: a phone's webview opens no windows.) It also
            // carries the navigation rule itself, which the library asks
            // before it looks for plugins, and even if it cannot find the
            // webview to ask them about.
            let config = app.config().clone();
            let window = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or("the main window is not configured")?;
            #[cfg(windows)]
            let startup = Arc::new(Mutex::new(NavigationStartup::default()));
            #[cfg(windows)]
            let navigation_startup = Arc::clone(&startup);
            let _webview = tauri::WebviewWindowBuilder::from_config(app.handle(), &window)?
                .on_navigation(move |url| {
                    let allowed = may_navigate(&config, url);
                    #[cfg(windows)]
                    return navigation_startup
                        .lock()
                        .expect("navigation startup mutex poisoned")
                        .permit(url, allowed);
                    #[cfg(not(windows))]
                    allowed
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            #[cfg(windows)]
            {
                windows_navigation::install(&_webview, app.config().clone())?;
                // The initial navigation may happen during build or be queued.
                // Replay it only if the startup gate already refused it.
                let pending = startup
                    .lock()
                    .expect("navigation startup mutex poisoned")
                    .arm();
                if let Some(url) = pending {
                    _webview.navigate(url)?;
                }
            }
            // The camera dialog's request is answered here, not by a webview
            // prompt (camera_permission.rs).
            #[cfg(any(target_os = "linux", windows))]
            camera_permission::install(&_webview, app.config().clone())?;
            // `vault-home` holds the vault and only what the vault manages beside
            // it (lock file, pending reset, create stage, export journal). Back
            // up or restore the whole directory. Machine-local data, because the
            // Windows roaming profile would copy it between machines, where each
            // would lock its own copy of the lock file. Earlier evaluation builds
            // kept the vault at `<data>/vault-v1`; that is left untouched and
            // never read.
            app.manage(Arc::new(VaultStore::new(
                app.path()
                    .app_local_data_dir()?
                    .join("vault-home")
                    .join("vault-v1"),
            )));
            // Wrong tries at a secret, counted beside the vault in
            // `attempts.json`, and read only when needed, not here.
            app.manage(Arc::new(AttemptThrottle::new(Some(
                app.path()
                    .app_local_data_dir()?
                    .join("vault-home")
                    .join("attempts.json"),
            ))));
            app.manage(Arc::new(PendingPicks::default()));
            app.manage(Arc::new(ReceivedFiles::default()));
            // "Open with" on Windows and a desktop entry on Linux pass files as arguments. A
            // second launch while the app is open is not forwarded yet (#53).
            #[cfg(any(windows, target_os = "linux"))]
            {
                let (offered, sources) = received::accept_command_line(std::env::args_os());
                app.state::<Arc<ReceivedFiles>>().receive(offered, sources);
            }
            let store = Arc::clone(app.state::<Arc<VaultStore>>().inner());
            let picks = Arc::clone(app.state::<Arc<PendingPicks>>().inner());
            std::thread::Builder::new()
                .name("vault-idle-lock".into())
                .spawn(move || loop {
                    std::thread::sleep(IDLE_CHECK_INTERVAL);
                    lock_if_idle(&store, &picks, Instant::now());
                })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            kdf_benchmark,
            vault_status,
            vault_passphrase_rules,
            vault_create,
            vault_unlock,
            vault_lock,
            vault_touch,
            vault_set_auto_lock,
            vault_snapshot,
            vault_change_passphrase,
            vault_recovery_key_begin,
            vault_recovery_key_confirm,
            vault_recovery_kit_save,
            vault_recovery_key_label,
            vault_recovery_key_cancel,
            vault_recover,
            vault_backup_pick,
            vault_backup_picked,
            vault_restore_pick,
            vault_restore_inspect,
            vault_restore,
            vault_create_profile,
            vault_create_folder,
            vault_update_folder,
            vault_rename_record,
            vault_assign_folders,
            vault_assign_folders_batch,
            vault_import_pick,
            vault_import_picked,
            received_list,
            received_accept,
            vault_move_to_person,
            vault_view_page,
            vault_view_cancel,
            vault_export_pick,
            vault_export_picked,
            vault_save_photo,
            vault_is_photo,
            vault_view_photo,
            vault_is_locked_pdf,
            vault_unlock_pdf,
            vault_delete_record,
            vault_remove_unavailable_records,
            vault_reset
        ])
        .build(tauri::generate_context!())
        .expect("error while building myCarlos")
        .run(|_app, _event| {
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                receive_opened(_app, &urls);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    const APP_SCHEME: Origin = ("tauri", "localhost");
    const HOST_NAME: Origin = ("http", "tauri.localhost");
    const SECURE_HOST_NAME: Origin = ("https", "tauri.localhost");

    #[test]
    fn the_window_may_only_load_the_apps_own_pages() {
        let url = |text: &str| Url::parse(text).unwrap();
        for (origin, pages) in [
            (
                APP_SCHEME,
                ["tauri://localhost", "tauri://localhost/index.html"],
            ),
            (
                HOST_NAME,
                ["http://tauri.localhost/", "http://tauri.localhost/a.js"],
            ),
            (
                SECURE_HOST_NAME,
                ["https://tauri.localhost/", "https://tauri.localhost/a.js"],
            ),
        ] {
            for page in pages {
                assert!(navigation_allowed(&url(page), origin, None), "{page}");
            }
        }
        for origin in [APP_SCHEME, HOST_NAME, SECURE_HOST_NAME] {
            for outside in [
                "https://example.com/?secret=1",
                "http://localhost:1420/",
                "http://localhost/",
                "https://tauri.localhost.example.com/",
                "https://tauri.localhost./",
                "https://tauri.localhost:8443/",
                "http://tauri.localhost:8080/",
                "http://someone@tauri.localhost/",
                "tauri://someone@localhost/",
                "https://user@example.com/tauri.localhost",
                "tauri://example.com/",
                "tauri://localhost.example.com/",
                "file:///etc/passwd",
                "data:text/html,<p>x</p>",
                "blob:https://tauri.localhost/0",
                "about:blank",
                "javascript:void(0)",
                "mailto:someone@example.com",
                "intent://example.com/#Intent;scheme=https;end",
            ] {
                assert!(
                    !navigation_allowed(&url(outside), origin, None),
                    "{outside} with {origin:?}"
                );
            }
        }
    }

    #[test]
    fn another_platforms_origin_is_an_outside_address_here() {
        let url = |text: &str| Url::parse(text).unwrap();
        for (origin, elsewhere) in [
            (
                APP_SCHEME,
                ["http://tauri.localhost/", "https://tauri.localhost/"],
            ),
            (HOST_NAME, ["tauri://localhost", "https://tauri.localhost/"]),
            (
                SECURE_HOST_NAME,
                ["tauri://localhost", "http://tauri.localhost/"],
            ),
        ] {
            for page in elsewhere {
                assert!(
                    !navigation_allowed(&url(page), origin, None),
                    "{page} with {origin:?}"
                );
            }
        }
    }

    #[test]
    fn this_platform_serves_its_pages_where_the_library_says() {
        let config: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let expected = if cfg!(windows) || cfg!(target_os = "android") {
            HOST_NAME
        } else {
            APP_SCHEME
        };
        assert_eq!(bundled_origin(&config), expected);
        // The library's own rule, for each kind of platform.
        assert_eq!(origin_for(false, false), APP_SCHEME);
        assert_eq!(origin_for(false, true), APP_SCHEME);
        assert_eq!(origin_for(true, false), HOST_NAME);
        assert_eq!(origin_for(true, true), SECURE_HOST_NAME);
    }

    #[test]
    fn a_development_build_may_also_load_its_development_server() {
        let url = |text: &str| Url::parse(text).unwrap();
        let dev = url("http://localhost:1420");
        assert!(navigation_allowed(
            &url("http://localhost:1420/src/main.tsx"),
            APP_SCHEME,
            Some(&dev)
        ));
        assert!(navigation_allowed(
            &url("tauri://localhost"),
            APP_SCHEME,
            Some(&dev)
        ));
        for outside in [
            "http://localhost:1421/",
            "https://localhost:1420/",
            "http://example.com:1420/",
        ] {
            assert!(
                !navigation_allowed(&url(outside), APP_SCHEME, Some(&dev)),
                "{outside}"
            );
        }
    }

    #[test]
    fn the_configuration_leaves_the_window_to_the_app() {
        // A window the configuration made would have no guard against
        // opening others.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0]["create"], false);
    }

    #[test]
    fn a_speed_test_report_says_the_platform_and_nothing_else_about_the_device() {
        let report = SpeedTestReport {
            measured: vault::KdfBenchmark {
                memory_kib: 65_536,
                iterations: 3,
                lanes: 4,
                samples_ms: vec![1, 2, 3, 4, 5],
                median_ms: 3,
                max_ms: 5,
                release: false,
                simulator: false,
            },
            platform: "android".to_owned(),
            architecture: "aarch64".to_owned(),
            app_version: "0.1.0".to_owned(),
        };
        let json = serde_json::to_value(&report).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "appVersion",
                "architecture",
                "iterations",
                "lanes",
                "maxMs",
                "medianMs",
                "memoryKib",
                "platform",
                "release",
                "samplesMs",
                "simulator"
            ]
        );
    }

    #[test]
    fn runtime_info_contains_only_non_sensitive_build_data() {
        let info = current_runtime_info();
        assert_eq!(info.platform, std::env::consts::OS);
        assert_eq!(info.architecture, std::env::consts::ARCH);
        assert_eq!(info.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(info.message, "Hello from the Tauri Rust boundary");
    }
    #[test]
    fn a_picked_file_that_is_gone_is_not_a_storage_error() {
        let dir = tempfile::tempdir().unwrap();
        let missing = vault::open_regular_read(&dir.path().join("moved.pdf")).unwrap_err();
        assert!(matches!(import_source_error(missing), VaultError::NotFound));
        let directory = vault::open_regular_read(dir.path()).unwrap_err();
        assert!(matches!(
            import_source_error(directory),
            VaultError::Invalid
        ));
        assert!(matches!(
            import_source_error(io::Error::other("device error")),
            VaultError::Storage
        ));
    }
    #[test]
    fn a_backup_that_could_not_read_the_vault_asks_nothing_to_be_checked() {
        let backup = PublicError::from(VaultError::Unreadable).of_backup(BackupDestination::Path);
        assert_eq!(backup.code, "unreadable");
        assert!(backup.message.contains("no backup was saved"));
        assert!(!backup.message.contains("typed"));
        let other = PublicError::from(VaultError::Corrupt).of_backup(BackupDestination::Path);
        assert_eq!(
            other.message,
            PublicError::from(VaultError::Corrupt).message
        );
    }

    #[test]
    fn a_backup_that_failed_says_to_keep_the_older_ones() {
        let failures: [fn() -> VaultError; 5] = [
            || VaultError::Unreadable,
            || VaultError::NoSpace,
            || VaultError::Storage,
            || VaultError::Cancelled,
            || VaultError::Corrupt,
        ];
        for failure in failures {
            for destination in [
                BackupDestination::Path,
                BackupDestination::ProviderUntouched,
                BackupDestination::ProviderEmptied,
            ] {
                let plain = PublicError::from(failure());
                let failed = PublicError::from(failure()).of_backup(destination);
                assert_eq!(failed.code, plain.code);
                if plain.code != "corrupt" {
                    assert!(failed
                        .message
                        .to_lowercase()
                        .contains("no backup was saved"));
                    assert!(failed.message.contains("Keep your older backups."));
                }
                // Whatever the failure, what may be left where it was saved
                // is said: a document not yet opened is whole or empty, and
                // only an empty one goes; one opened may be emptied.
                assert_eq!(
                    failed
                        .note
                        .is_some_and(|note| note.contains("Keep any backup that is not empty.")),
                    destination == BackupDestination::ProviderUntouched,
                    "{} {destination:?}",
                    plain.code
                );
                assert_eq!(
                    failed.note.is_some_and(
                        |note| note.contains("Delete that one, not your other backups")
                    ),
                    destination == BackupDestination::ProviderEmptied,
                    "{} {destination:?}",
                    plain.code
                );
            }
        }
    }

    #[test]
    fn a_backup_counts_what_reaches_its_file_not_what_waits_in_a_buffer() {
        use std::io::Write as _;
        let bytes = Arc::new(AtomicU64::new(0));
        let mut file = Vec::new();
        {
            let mut writer = std::io::BufWriter::new(Counted {
                inner: &mut file,
                bytes: Arc::clone(&bytes),
            });
            writer.write_all(&[7; 10_000]).unwrap();
            writer.flush().unwrap();
        }
        assert_eq!(bytes.load(Ordering::Relaxed), 10_000);
        assert_eq!(file.len(), 10_000);
    }

    #[test]
    fn only_a_plain_date_names_a_backup() {
        assert!(is_plain_date("2026-09-30"));
        for text in [
            "2026-9-30",
            "2026/09/30",
            "2026-09-30 ",
            "../x/09-30",
            "２０２６-09-30",
            "",
        ] {
            assert!(!is_plain_date(text), "{text}");
        }
    }

    #[test]
    fn a_secret_tried_too_soon_after_wrong_ones_waits_and_says_so() {
        let throttle = Arc::new(AttemptThrottle::new(None));
        let wrong = || async { Err::<(), _>(PublicError::from(VaultError::WrongPassphrase)) };
        for _ in 0..throttle::FREE_TRIES {
            assert!(
                tauri::async_runtime::block_on(tried(&throttle, Attempt::Unlock, wrong())).is_err()
            );
        }
        // Refused before the command runs: nothing is tried.
        let ran = std::cell::Cell::new(false);
        let waited = tauri::async_runtime::block_on(tried(&throttle, Attempt::Unlock, async {
            ran.set(true);
            Ok(())
        }))
        .unwrap_err();
        assert!(!ran.get());
        assert_eq!(waited.code, "too_many_attempts");
        assert!(waited
            .retry_after_ms
            .is_some_and(|ms| ms > 0 && ms <= 5_000));
        let value = serde_json::to_value(&waited).unwrap();
        assert!(value["retryAfterMs"].is_u64());
        assert!(waited.message.contains("To slow down anyone guessing"));
        // Another secret is not held up by this one's count.
        assert!(
            tauri::async_runtime::block_on(tried(&throttle, Attempt::Backup, async { Ok(()) }))
                .is_ok()
        );
    }

    #[test]
    fn every_command_that_checks_a_secret_is_counted() {
        let source = include_str!("lib.rs");
        for (command, attempt) in [
            ("async fn vault_unlock(", "Attempt::Unlock"),
            ("async fn vault_change_passphrase(", "Attempt::Unlock"),
            ("async fn vault_recovery_key_begin(", "Attempt::Unlock"),
            ("async fn vault_recover(", "Attempt::RecoveryKey"),
            ("async fn vault_restore_inspect(", "Attempt::Backup"),
            ("async fn vault_restore(", "Attempt::Backup"),
        ] {
            let body = source.split(command).nth(1).unwrap();
            let body = &body[..body.find("\n}\n").unwrap()];
            assert!(body.contains("tried("), "{command}");
            assert!(body.contains(attempt), "{command}");
        }
        // A new, erased or restored vault starts its counts again, and only
        // once it is: a create refused because a vault exists, or a restore
        // cancelled or failed, must not clear the counts of the one there.
        // The code is read without its comments, one line after another.
        for (command, clears) in [
            (
                "async fn vault_create(",
                "if created.is_ok() { forget_vault(throttle.inner()).await; }",
            ),
            (
                "async fn vault_reset(",
                "VaultStore::reset).await?; forget_vault(throttle.inner()).await; Ok(true)",
            ),
            (
                "async fn vault_restore(",
                ".map_err(PublicError::of_restore)?; forget_vault(throttle.inner()).await; Ok(true)",
            ),
        ] {
            let body = source.split(command).nth(1).unwrap();
            let body = &body[..body.find("\n}\n").unwrap()];
            let code = body
                .lines()
                .map(str::trim)
                .filter(|line| !line.starts_with("//"))
                .collect::<Vec<_>>()
                .join(" ");
            assert_eq!(code.matches("forget_vault(").count(), 1, "{command}");
            assert!(code.contains(clears), "{command}");
        }
        // What follows a right secret is outside the try, so that its failure
        // does not leave the count.
        for command in ["async fn vault_unlock(", "async fn vault_recover("] {
            let body = source.split(command).nth(1).unwrap();
            let body = &body[..body.find("\n}\n").unwrap()];
            let tried = &body[body.find("tried(").unwrap()..body.find(".await?;").unwrap()];
            assert!(!tried.contains("snapshot"), "{command}");
            assert!(body.contains("run_blocking(store.inner(), VaultStore::snapshot)"));
        }
        // The restore clears them at its very end, past every early return.
        let restore = source.split("async fn vault_restore(").nth(1).unwrap();
        let restore = &restore[..restore.find("\n}\n").unwrap()];
        assert!(restore.ends_with("forget_vault(throttle.inner()).await;\n    Ok(true)"));
    }

    #[test]
    fn a_try_refused_during_a_wait_adds_nothing_to_it() {
        let throttle = Arc::new(AttemptThrottle::new(None));
        let wrong = || async { Err::<(), _>(PublicError::from(VaultError::WrongPassphrase)) };
        for _ in 0..throttle::FREE_TRIES {
            let _ = tauri::async_runtime::block_on(tried(&throttle, Attempt::Unlock, wrong()));
        }
        let first = throttle.wait(Attempt::Unlock, now_ms()).unwrap();
        for _ in 0..10 {
            let _ = tauri::async_runtime::block_on(tried(&throttle, Attempt::Unlock, wrong()));
        }
        // Still the wait after five, not after fifteen.
        assert!(throttle.wait(Attempt::Unlock, now_ms()).unwrap() <= first);
    }

    #[test]
    fn busy_kdf_work_does_not_count_as_a_wrong_passphrase() {
        let throttle = Arc::new(AttemptThrottle::new(None));
        for _ in 0..throttle::FREE_TRIES + 3 {
            let result = tauri::async_runtime::block_on(tried(&throttle, Attempt::Unlock, async {
                Err::<(), _>(PublicError::from(VaultError::Busy))
            }));
            assert_eq!(result.unwrap_err().code, "busy");
        }
        assert_eq!(throttle.wait(Attempt::Unlock, now_ms()), None);
    }

    #[test]
    fn only_a_wrong_secret_counts_toward_a_wait() {
        let throttle = Arc::new(AttemptThrottle::new(None));
        // A key whose check characters are wrong is a typo, not a guess.
        for _ in 0..throttle::FREE_TRIES + 3 {
            let _ = tauri::async_runtime::block_on(tried(&throttle, Attempt::RecoveryKey, async {
                Err::<(), _>(PublicError::from(VaultError::RecoveryKeyTypo))
            }));
        }
        assert_eq!(throttle.wait(Attempt::RecoveryKey, now_ms()), None);
        for _ in 0..throttle::FREE_TRIES {
            let _ = tauri::async_runtime::block_on(tried(&throttle, Attempt::RecoveryKey, async {
                Err::<(), _>(PublicError::from(VaultError::WrongRecoveryKey))
            }));
        }
        assert!(throttle.wait(Attempt::RecoveryKey, now_ms()).is_some());
    }

    #[test]
    fn public_errors_do_not_expose_internal_details() {
        let error = PublicError::from(VaultError::Storage);
        assert_eq!(error.code, "storage");
        assert!(!error.message.contains('/'));

        let in_use = PublicError::from(VaultError::InUse);
        assert_eq!(in_use.code, "in_use");
        assert!(in_use.message.contains("Lock or close"));
        assert!(!in_use.message.contains('/'));

        let weak = PublicError::from(VaultError::WeakPassphrase);
        assert_eq!(weak.code, "weak_passphrase");
        assert!(weak.message.contains("less predictable"));

        let partial = PublicError::partial_export();
        assert_eq!(partial.code, "partial_export");
        assert!(partial.message.contains("partial readable copy"));
        assert!(partial.message.contains("Delete"));
    }

    #[test]
    fn a_damaged_document_is_named_by_id_only() {
        let id = Uuid::new_v4();
        let value =
            serde_json::to_value(PublicError::from(VaultError::DamagedDocument(id))).unwrap();
        assert_eq!(value["code"], "damaged_document");
        assert_eq!(value["recordId"], id.to_string());
        // Every other error leaves the field out.
        let value = serde_json::to_value(PublicError::from(VaultError::Corrupt)).unwrap();
        assert!(value.get("recordId").is_none());
    }

    #[test]
    fn a_backup_that_does_not_open_is_not_said_to_be_the_vault() {
        // A backup opens with what its vault had when it was saved, not with
        // a key or passphrase set since.
        let key = PublicError::from(VaultError::WrongRecoveryKey).of_restore();
        assert_eq!(key.code, "wrong_recovery_key");
        assert!(key.message.contains("does not open this backup"));
        assert!(key.message.contains("when it was saved"));
        assert!(!key.message.contains("newest"));
        let passphrase = PublicError::from(VaultError::WrongPassphrase).of_restore();
        assert_eq!(passphrase.code, "wrong_passphrase");
        assert!(passphrase.message.contains("does not open this backup"));
        // Anything else is said as it is everywhere.
        let other = PublicError::from(VaultError::BackupUnreadable).of_restore();
        assert_eq!(
            other.message,
            PublicError::from(VaultError::BackupUnreadable).message
        );
    }

    #[test]
    fn native_collection_limits_are_available_before_expensive_work() {
        assert!(vault::validate_import_count(vault::MAX_IMPORT_FILES).is_ok());
        assert!(matches!(
            vault::validate_import_count(vault::MAX_IMPORT_FILES + 1),
            Err(VaultError::ImportBatchLimit)
        ));
        assert!(vault::validate_folder_assignment_count(vault::MAX_FOLDER_ASSIGNMENTS).is_ok());
        assert!(matches!(
            vault::validate_folder_assignment_count(vault::MAX_FOLDER_ASSIGNMENTS + 1),
            Err(VaultError::Invalid)
        ));
    }

    #[cfg(all(unix, desktop))]
    #[test]
    fn local_import_does_not_block_on_a_fifo_swapped_in_after_the_check() {
        let temp = tempfile::tempdir().unwrap();
        let fifo = temp.path().join("selected.pdf");
        let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);

        // Opening a FIFO for reading blocks until a writer appears, which here
        // is never. The handle check must still get to reject it.
        assert_eq!(
            vault::open_without_following(&fifo).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn the_vault_is_rooted_in_machine_local_application_data() {
        // On Windows `app_data_dir` is the roaming profile. Roaming copies the
        // vault between machines at sign-in and sign-out, so each machine locks
        // its own copy of the lock file and both may write; the last upload wins
        // file by file. `app_local_data_dir` never roams, and on every other
        // platform it is the same directory.
        let library = include_str!("lib.rs");
        let setup = library
            .split("app.manage(Arc::new(VaultStore::new(")
            .nth(1)
            .unwrap();
        let root = &setup[..setup.find(")))").unwrap()];
        assert!(root.contains("app_local_data_dir()"), "{root}");
        assert!(!root.contains("app_data_dir()"), "{root}");
        // Earlier evaluation builds kept the vault itself at `<data>/vault-v1`,
        // and on macOS and Linux local and roaming data are one directory. A
        // home of that name would hold an old vault's files loose beside the new
        // one, where nothing cleans them up.
        let home = root.split(".join(\"").nth(1).unwrap();
        let home = &home[..home.find('"').unwrap()];
        assert_ne!(home, "vault-v1");
    }

    const PASSWORD: &str = "river-azimuth-cobalt-sparrow-934";
    /// Just past the default delay and the margin after `from`.
    fn idle_past(from: Instant) -> Instant {
        from + Duration::from_secs(15 * 60) + idle::MARGIN + Duration::from_secs(1)
    }

    #[test]
    fn the_desktop_window_lets_the_reader_zoom() {
        // Ctrl/Cmd with plus and minus scale the whole interface, as in a
        // browser. The page handles those keys (src/native/zoom.ts), so that
        // it can keep the level for the next start. The platform's own
        // handling, which forgets it, must be off, or each key would count
        // twice.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap();
        assert!(!windows.is_empty());
        for window in windows {
            assert_eq!(window["zoomHotkeysEnabled"], false);
        }
        // The page needs leave to set its own zoom, on a computer and for
        // nothing else: mobile has no such command.
        let zoom: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/zoom.json")).unwrap();
        assert_eq!(zoom["windows"], serde_json::json!(["main"]));
        assert_eq!(
            zoom["platforms"],
            serde_json::json!(["windows", "macOS", "linux"])
        );
        assert_eq!(
            zoom["permissions"],
            serde_json::json!(["core:webview:allow-set-webview-zoom"])
        );
        // Tauri loads every file in capabilities/, so no other may appear
        // without a test of its own.
        let mut files: Vec<String> =
            std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities"))
                .unwrap()
                .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                .collect();
        files.sort();
        assert_eq!(files, ["appearance.json", "default.json", "zoom.json"]);
    }

    #[test]
    fn the_desktop_window_follows_the_chosen_appearance() {
        // System, Light or Dark (src/native/nativeAppearance.ts) sets the
        // window's own theme, on a computer and for nothing else: the page
        // follows the choice on every platform without it.
        let appearance: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/appearance.json")).unwrap();
        assert_eq!(appearance["windows"], serde_json::json!(["main"]));
        assert_eq!(
            appearance["platforms"],
            serde_json::json!(["windows", "macOS", "linux"])
        );
        assert_eq!(
            appearance["permissions"],
            serde_json::json!(["core:window:allow-set-theme"])
        );
    }

    #[test]
    fn a_file_that_is_not_a_pdf_is_refused_and_named() {
        let text = std::io::Cursor::new(b"FAKE plain text".to_vec());
        assert!(matches!(
            require_pdf(Box::new(text)),
            Err(VaultError::NotPdf)
        ));
        let pdf = std::io::Cursor::new(b"%PDF-1.7 FAKE".to_vec());
        let mut kept = Vec::new();
        std::io::Read::read_to_end(&mut require_pdf(Box::new(pdf)).unwrap(), &mut kept).unwrap();
        assert_eq!(kept, b"%PDF-1.7 FAKE");
        let json = serde_json::to_value(PublicError::from(VaultError::NotPdf)).unwrap();
        assert_eq!(json["code"], "not_pdf");
    }

    /// A vault with a recovery key being set up, and that key's groups as
    /// typed back; with `replacing`, the vault has a key already, set up at 2.
    fn key_being_set_up(root: &std::path::Path, replacing: bool) -> (VaultStore, Vec<String>) {
        let store = VaultStore::new(root.to_path_buf());
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let groups = |store: &VaultStore| -> Vec<String> {
            let key = store.begin_recovery_key(PASSWORD).unwrap();
            key.split('-').map(str::to_owned).collect()
        };
        if replacing {
            let first = groups(&store);
            store.confirm_recovery_key(&typed_back(&first), 2).unwrap();
        }
        let pending = groups(&store);
        (store, pending)
    }

    fn typed_back(groups: &[String]) -> Vec<(usize, &str)> {
        groups.iter().map(String::as_str).enumerate().collect()
    }

    /// Every file directly in the vault folder, as it is.
    fn vault_files(root: &std::path::Path) -> Vec<(std::ffi::OsString, Vec<u8>)> {
        let mut files: Vec<_> = std::fs::read_dir(root)
            .unwrap()
            .map(|entry| entry.unwrap())
            .filter(|entry| entry.file_type().unwrap().is_file())
            .map(|entry| (entry.file_name(), std::fs::read(entry.path()).unwrap()))
            .collect();
        files.sort();
        files
    }

    #[test]
    fn replacing_a_key_says_older_backups_keep_their_key_and_tells_no_one_to_delete() {
        // Whether to delete them depends on why the key is replaced, which
        // the app asked; the dialog only says that they keep their key.
        let warning = REPLACE_RECOVERY_KEY_WARNING;
        assert!(warning.contains("Backups saved before now still open"));
        assert!(warning.contains("myCarlos says what to do about them"));
        assert!(!warning.contains("delete"));
    }

    #[test]
    fn a_first_recovery_key_is_stored_without_asking() {
        let temp = tempfile::tempdir().unwrap();
        let (store, groups) = key_being_set_up(&temp.path().join("vault"), false);
        let stored = confirm_recovery_key_asking(
            &store,
            &typed_back(&groups),
            || 5,
            || panic!("a first key replaces nothing, and is not asked about"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(stored.recovery_key_set_at_ms, Some(5));
    }

    #[test]
    fn replacing_a_recovery_key_is_asked_and_a_no_writes_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let (store, groups) = key_being_set_up(&root, true);
        let before = vault_files(&root);
        let mut asked = 0;
        let outcome = confirm_recovery_key_asking(
            &store,
            &typed_back(&groups),
            || 5,
            || {
                asked += 1;
                false
            },
        )
        .unwrap();
        assert_eq!(asked, 1);
        assert!(outcome.is_none());
        assert_eq!(vault_files(&root), before);
        assert_eq!(store.snapshot().unwrap().recovery_key_set_at_ms, Some(2));
        // The key is still being set up, and a yes stores it.
        let stored = confirm_recovery_key_asking(&store, &typed_back(&groups), || 6, || true)
            .unwrap()
            .unwrap();
        assert_eq!(stored.recovery_key_set_at_ms, Some(6));
    }

    #[test]
    fn part_of_a_key_is_refused_before_anything_is_asked() {
        let temp = tempfile::tempdir().unwrap();
        let (store, groups) = key_being_set_up(&temp.path().join("vault"), true);
        assert!(matches!(
            confirm_recovery_key_asking(
                &store,
                &typed_back(&groups)[..6],
                || 5,
                || { panic!("nothing is asked over part of a key") }
            ),
            Err(VaultError::Invalid)
        ));
    }

    #[test]
    fn a_mistyped_key_is_refused_before_anything_is_asked() {
        let temp = tempfile::tempdir().unwrap();
        let (store, mut groups) = key_being_set_up(&temp.path().join("vault"), true);
        groups[3] = "ZZZZ".to_owned();
        assert!(matches!(
            confirm_recovery_key_asking(
                &store,
                &typed_back(&groups),
                || 5,
                || { panic!("nothing is asked over a mistyped key") }
            ),
            Err(VaultError::RecoveryKeyTypo)
        ));
    }

    #[test]
    fn a_key_cancelled_while_the_dialog_was_open_is_not_stored() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let (store, groups) = key_being_set_up(&root, true);
        let before = vault_files(&root);
        // Cancelled from elsewhere while the patient read the dialog.
        let outcome = confirm_recovery_key_asking(
            &store,
            &typed_back(&groups),
            || 5,
            || {
                store.cancel_recovery_key();
                true
            },
        );
        assert!(matches!(outcome, Err(VaultError::Invalid)));
        assert_eq!(vault_files(&root), before);
    }

    #[test]
    fn lock_if_idle_locks_an_idle_vault_as_lock_now_does() {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let picks = PendingPicks::default();
        let path = || tauri_plugin_fs::FilePath::Path("/home/jamie/FAKE.pdf".into());
        let record_id = Uuid::new_v4();
        let pick_id = picks.store_export(picks.session(), record_id, path());
        let kept = picks.store_export(picks.session(), record_id, path());

        assert!(!lock_if_idle(&store, &picks, Instant::now()));
        assert!(matches!(store.status(), Ok(VaultStatus::Unlocked)));
        // A check that finds the vault not due leaves its picks alone.
        assert!(picks.take_export(kept, record_id).is_ok());

        assert!(lock_if_idle(&store, &picks, idle_past(Instant::now())));
        assert!(matches!(store.status(), Ok(VaultStatus::Locked)));
        // Picks made in the session are gone, as after "Lock now".
        assert!(matches!(
            picks.take_export(pick_id, record_id),
            Err(VaultError::NotFound)
        ));
        // A locked vault has no deadline, so the timer does not lock it again.
        assert!(!lock_if_idle(&store, &picks, idle_past(Instant::now())));
    }

    /// When the default delay and the margin after `from` run out, exactly.
    fn due_at(from: Instant) -> Instant {
        from + Duration::from_secs(15 * 60) + idle::MARGIN
    }

    #[test]
    fn a_command_counts_as_activity_when_it_starts_and_ends() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(VaultStore::new(temp.path().join("vault")));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let armed_at = Instant::now();
        store.idle().arm(armed_at);
        assert!(store.idle().is_due(due_at(armed_at)));
        // So that any later activity is strictly later than `armed_at`.
        std::thread::sleep(Duration::from_millis(2));
        let run = |operation: Box<dyn FnOnce(&VaultStore) -> bool + Send>| {
            tauri::async_runtime::block_on(run_blocking(&store, move |store| Ok(operation(store))))
                .unwrap_or_else(|_| panic!("the command failed"))
        };
        // When it starts: the command already sees a later deadline.
        assert!(!run(Box::new(move |store| store
            .idle()
            .is_due(due_at(armed_at)))));
        // And when it ends: a command that ran long moves it on again.
        run(Box::new(move |store| {
            store.idle().arm(armed_at);
            false
        }));
        assert!(!store.idle().is_due(due_at(armed_at)));
    }

    #[test]
    fn both_transfer_commands_hold_the_deadline_while_opening_what_was_chosen() {
        let source = include_str!("lib.rs");
        let body = |command: &str| {
            let body = source.split(command).nth(1).unwrap();
            body[..body.find("\n}\n").unwrap()].to_owned()
        };
        // Held across the opens, not dropped at once as `let _ =` would.
        let import = body("async fn vault_import_picked(");
        let guard = import
            .find("let _opening = Opening::new(store.idle());")
            .unwrap();
        assert!(guard < import.find("open_import_source(").unwrap());
        let export = body("async fn vault_export_picked(");
        let guard = export
            .find("let opening = Opening::new(store.idle());")
            .unwrap();
        let open = export[guard..].find(".open(destination, options)").unwrap() + guard;
        let dropped = export.find("drop(opening);").unwrap();
        assert!(guard < open && open < dropped);
        // User input the renderer reports is activity.
        assert!(body("fn vault_touch(").contains(".touch(Instant::now())"));
    }

    #[test]
    fn a_command_the_lock_cancelled_is_not_activity_when_it_ends() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(VaultStore::new(temp.path().join("vault")));
        store.create(PASSWORD, "Jamie", 1).unwrap();
        let armed_at = Instant::now();
        std::thread::sleep(Duration::from_millis(2));
        let result = tauri::async_runtime::block_on(run_blocking(&store, move |store| {
            // As if it had run since `armed_at`, then been cut off.
            store.idle().arm(armed_at);
            Err::<(), _>(VaultError::Cancelled)
        }));
        assert!(result.is_err());
        assert!(store.idle().is_due(due_at(armed_at)));
    }

    #[test]
    fn an_open_picker_counts_as_activity_until_it_closes() {
        let armed_at = Instant::now();
        let idle = IdleDeadline::new(armed_at);
        idle.arm(armed_at);
        std::thread::sleep(Duration::from_millis(2));
        {
            let _open = ActivityHold::new(&idle);
            assert!(!idle.is_due(due_at(armed_at)));
        }
        // Closed just now, so the delay restarts from here.
        assert!(!idle.is_due(due_at(armed_at)));
        assert!(idle.is_due(idle_past(Instant::now())));
    }

    #[test]
    fn a_pick_is_used_once_and_cleared_by_a_lock() {
        let picks = PendingPicks::default();
        let path = || tauri_plugin_fs::FilePath::Path("/home/jamie/FAKE.pdf".into());
        let request = ImportRequest {
            profile_id: Uuid::new_v4(),
            folder_ids: vec![Uuid::new_v4()],
        };
        let record_id = Uuid::new_v4();

        let pick_id = picks.store_import(picks.session(), request.clone(), vec![path()]);
        assert!(matches!(
            picks.take_import(Uuid::new_v4(), &request),
            Err(VaultError::NotFound)
        ));
        assert_eq!(picks.take_import(pick_id, &request).unwrap().len(), 1);
        // A pick is consumed by its run, so a replayed request finds nothing.
        assert!(matches!(
            picks.take_import(pick_id, &request),
            Err(VaultError::NotFound)
        ));

        let pick_id = picks.store_export(picks.session(), record_id, path());
        picks.clear();
        assert!(matches!(
            picks.take_export(pick_id, record_id),
            Err(VaultError::NotFound)
        ));

        // A picker opened before a lock can return after it. Its pick is
        // stored, but belongs to the ended session and is never used.
        let session = picks.session();
        picks.clear();
        let pick_id = picks.store_export(session, record_id, path());
        assert!(matches!(
            picks.take_export(pick_id, record_id),
            Err(VaultError::NotFound)
        ));

        // A pick can also read the session just after a lock cleared it, and
        // pass its unlocked check before the lock lands. Unlocking starts a
        // new session, so that pick is not usable after the next unlock.
        picks.clear();
        let session = picks.session();
        picks.clear();
        let pick_id = picks.store_export(session, record_id, path());
        assert!(matches!(
            picks.take_export(pick_id, record_id),
            Err(VaultError::NotFound)
        ));
        let source = include_str!("lib.rs");
        for command in [
            "async fn vault_unlock(",
            "async fn vault_create(",
            "async fn vault_recover(",
        ] {
            let body = source.split(command).nth(1).unwrap();
            let body = &body[..body.find("\n}\n").unwrap()];
            assert!(body.contains("picks.clear()"), "{command}");
        }

        // A stale pick is never used.
        picks.exports.entries().insert(
            pick_id,
            (
                Instant::now() - PICK_TTL,
                picks.session(),
                (record_id, path()),
            ),
        );
        assert!(matches!(
            picks.take_export(pick_id, record_id),
            Err(VaultError::NotFound)
        ));
    }

    #[test]
    fn only_the_button_that_goes_ahead_counts_as_agreement() {
        let custom = |label: &str| MessageDialogResult::Custom(label.to_owned());
        assert!(agreed_natively(&custom("Erase vault"), "Erase vault"));
        for answer in [
            custom("Keep this vault"),
            custom(NATIVE_CANCEL),
            custom("erase vault"),
            custom(""),
            // What the dialog reports when it is closed, or could not be
            // shown, and what another layout's buttons would report.
            MessageDialogResult::Cancel,
            MessageDialogResult::Ok,
            MessageDialogResult::Yes,
            MessageDialogResult::No,
        ] {
            assert!(!agreed_natively(&answer, "Erase vault"), "{answer:?}");
        }
    }

    #[test]
    fn the_restore_confirmation_says_what_would_be_lost() {
        let preview = |replaces, differs| RestorePreview {
            replaces,
            differs_from_this_device: differs,
            document_count: 3,
            fingerprint: [0; 32],
        };
        assert!(restore_warning(&preview(RestoreReplaces::Nothing, false)).is_none());
        let other = restore_warning(&preview(RestoreReplaces::OtherVault, false)).unwrap();
        assert!(
            other.contains("is not the vault this backup was made from")
                && other.contains("3 documents")
        );
        let unreadable = restore_warning(&preview(RestoreReplaces::Unreadable, false)).unwrap();
        assert!(unreadable.contains("cannot tell") && unreadable.contains("permanently erases"));
        let changed = restore_warning(&preview(RestoreReplaces::SameVault, true)).unwrap();
        assert!(changed.contains("may not be the same as") && changed.contains("passphrase"));
        assert!(changed.contains("could not be read"));
        let same = restore_warning(&preview(RestoreReplaces::SameVault, false)).unwrap();
        assert!(same.contains("the same 3 documents"));
    }

    #[test]
    fn a_restore_pick_can_be_checked_before_it_is_used() {
        let picks = PendingPicks::default();
        let path = || tauri_plugin_fs::FilePath::Path("/home/jamie/FAKE.mycarlosbackup".into());
        let pick = picks.restores.store(picks.session(), path());
        // Inspecting leaves it for the restore; the restore uses it up.
        for _ in 0..2 {
            assert!(picks
                .restores
                .peek_within(pick, picks.session(), RESTORE_PICK_TTL)
                .is_some());
        }
        assert!(picks
            .restores
            .take_within(pick, picks.session(), RESTORE_PICK_TTL)
            .is_some());
        assert!(picks
            .restores
            .peek_within(pick, picks.session(), RESTORE_PICK_TTL)
            .is_none());
        // An unlock or a lock in between ends it.
        let pick = picks.restores.store(picks.session(), path());
        picks.clear();
        assert!(picks
            .restores
            .take_within(pick, picks.session(), RESTORE_PICK_TTL)
            .is_none());
    }

    #[test]
    fn a_pick_is_only_used_for_the_request_it_was_opened_for() {
        let picks = PendingPicks::default();
        let path = || tauri_plugin_fs::FilePath::Path("/home/jamie/FAKE.pdf".into());
        let request = ImportRequest {
            profile_id: Uuid::new_v4(),
            folder_ids: vec![Uuid::new_v4()],
        };

        for other in [
            ImportRequest {
                profile_id: Uuid::new_v4(),
                ..request.clone()
            },
            ImportRequest {
                folder_ids: Vec::new(),
                ..request.clone()
            },
        ] {
            let pick_id = picks.store_import(picks.session(), request.clone(), vec![path()]);
            assert!(matches!(
                picks.take_import(pick_id, &other),
                Err(VaultError::Invalid)
            ));
            // The refused request still spent the pick.
            assert!(matches!(
                picks.take_import(pick_id, &request),
                Err(VaultError::NotFound)
            ));
        }

        let record_id = Uuid::new_v4();
        let pick_id = picks.store_export(picks.session(), record_id, path());
        assert!(matches!(
            picks.take_export(pick_id, Uuid::new_v4()),
            Err(VaultError::Invalid)
        ));
        assert!(matches!(
            picks.take_export(pick_id, record_id),
            Err(VaultError::NotFound)
        ));
    }

    #[test]
    fn mobile_imports_are_named_after_the_file_not_the_uri() {
        let named = |value: &str| {
            import_display_name(&tauri_plugin_fs::FilePath::Url(value.parse().unwrap()))
        };
        assert_eq!(
            named("file:///private/var/mobile/Inbox/My%20Report.pdf"),
            "My Report.pdf"
        );
        // Only a document id is split at a colon; a file name keeps its own.
        assert_eq!(
            named("file:///private/var/mobile/Inbox/Scan%2010%3A30.pdf"),
            "Scan 10:30.pdf"
        );
        // Android document ids embed the storage path in one encoded segment.
        assert_eq!(
            named("content://com.android.externalstorage.documents/document/primary%3ADocuments%2Flabs.pdf"),
            "labs.pdf"
        );
        assert_eq!(
            named("content://com.android.externalstorage.documents/document/primary%3ADocuments%2FScan%2010%3A30.pdf"),
            "Scan 10:30.pdf"
        );
        // An opaque provider id is not a name worth showing or exporting.
        assert_eq!(
            named("content://com.android.providers.downloads.documents/document/msf%3A31"),
            "Imported document.pdf"
        );
        // A dot inside an opaque id does not make it a file name.
        assert_eq!(
            named("content://com.example.cloud.documents/document/acc%3D1%3Bdoc%3Dv1.4f9a"),
            "Imported document.pdf"
        );
        assert_eq!(
            import_display_name(&tauri_plugin_fs::FilePath::Path(
                "/home/jamie/FAKE.pdf".into()
            )),
            "/home/jamie/FAKE.pdf"
        );
    }

    #[cfg(all(unix, desktop))]
    #[test]
    fn local_import_rejects_symbolic_links() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("record.pdf");
        let link = temp.path().join("selected.pdf");
        std::fs::write(&target, b"%PDF-synthetic").unwrap();
        symlink(&target, &link).unwrap();

        assert_eq!(
            vault::open_regular_read(&link).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn production_webview_configuration_has_no_development_network_access() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let security = &config["app"]["security"];
        let production_csp = security["csp"].as_str().unwrap();
        assert!(!production_csp.contains("ws:"));
        for directive in [
            "object-src 'none'",
            "frame-src 'none'",
            "worker-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
        ] {
            assert!(production_csp.contains(directive));
        }
        assert!(security["devCsp"].as_str().unwrap().contains("ws://*:1421"));
        assert_eq!(security["freezePrototype"], true);
        assert_eq!(config["build"]["removeUnusedCommands"], true);

        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        // build.rs declares the app commands, so this list is the only thing
        // that lets the renderer call them. It must cover exactly the registered
        // commands and must never grant a plugin (`plugin:permission`) scope.
        let permissions: Vec<&str> = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|permission| permission.as_str().unwrap())
            .collect();
        let library = include_str!("lib.rs");
        let build_script = include_str!("../build.rs");
        let command_marker = ["#[tauri", "::command]"].concat();
        assert_eq!(permissions.len(), library.matches(&command_marker).count());
        for permission in permissions {
            assert!(!permission.contains(':'));
            let command = permission.strip_prefix("allow-").unwrap().replace('-', "_");
            assert!(library.contains(&format!("fn {command}(")));
            assert!(
                library.contains(&format!("    {command},\n"))
                    || library.contains(&format!("    {command}\n"))
            );
            assert!(build_script.contains(&format!("\"{command}\"")));
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn arbitrary_ipc_payloads_never_panic_during_deserialization(
            payload in prop::collection::vec(any::<u8>(), 0..8192),
        ) {
            let _ = serde_json::from_slice::<CreateVaultRequest>(&payload);
            let _ = serde_json::from_slice::<PassphraseRulesRequest>(&payload);
            let _ = serde_json::from_slice::<PassphraseRequest>(&payload);
            let _ = serde_json::from_slice::<ChangePassphraseRequest>(&payload);
            let _ = serde_json::from_slice::<RecoverRequest>(&payload);
            let _ = serde_json::from_slice::<PickRequest>(&payload);
            let _ = serde_json::from_slice::<BackupPickRequest>(&payload);
            let _ = serde_json::from_slice::<RestoreRequest>(&payload);
            let _ = serde_json::from_slice::<ConfirmRecoveryKeyRequest>(&payload);
            let _ = serde_json::from_slice::<NameRequest>(&payload);
            let _ = serde_json::from_slice::<FolderRequest>(&payload);
            let _ = serde_json::from_slice::<UpdateFolderRequest>(&payload);
            let _ = serde_json::from_slice::<AssignFoldersRequest>(&payload);
            let _ = serde_json::from_slice::<AssignFoldersBatchRequest>(&payload);
            let _ = serde_json::from_slice::<ImportRequest>(&payload);
            let _ = serde_json::from_slice::<MoveToPersonRequest>(&payload);
            let _ = serde_json::from_slice::<ViewPageRequest>(&payload);
            let _ = serde_json::from_slice::<ExportRequest>(&payload);
            let _ = serde_json::from_slice::<PhotoRequest>(&payload);
            let _ = serde_json::from_slice::<UnlockPdfRequest>(&payload);
            let _ = serde_json::from_slice::<DeleteRecordRequest>(&payload);
            let _ = serde_json::from_slice::<RemoveUnavailableRequest>(&payload);
            let _ = serde_json::from_slice::<ResetRequest>(&payload);
        }
    }
}

#[cfg(test)]
mod navigation_startup_tests {
    use super::*;

    #[test]
    fn startup_replays_only_allowed_navigation_after_installation() {
        let bundled = Url::parse("http://tauri.localhost/").unwrap();
        let outside = Url::parse("https://example.invalid/").unwrap();
        let mut startup = NavigationStartup::default();
        assert!(!startup.permit(&bundled, true));
        assert!(!startup.permit(&outside, false));
        assert_eq!(startup.arm(), Some(bundled.clone()));
        assert!(startup.permit(&bundled, true));
        assert!(!startup.permit(&outside, false));
        assert_eq!(startup.arm(), None);
    }

    #[test]
    fn startup_handles_navigation_queued_until_after_installation() {
        let mut startup = NavigationStartup::default();
        assert_eq!(startup.arm(), None);
        assert!(startup.permit(&Url::parse("http://tauri.localhost/").unwrap(), true));
    }
}

#[cfg(test)]
mod photo_command_tests {
    use super::*;
    use std::io::{Cursor, Write};

    const PASSWORD: &str = "river-azimuth-cobalt-sparrow-934";
    /// What Chromium's canvas encodes (photo.rs tests, testdata/README.md).
    const CANVAS: &[u8] = include_bytes!("../testdata/canvas-photo.jpg");

    /// The canvas JPEG with an Exif block holding a FAKE GPS position after its
    /// JFIF header, as a phone camera's file would have.
    fn tagged() -> Vec<u8> {
        let payload = b"Exif\0\0MM\0\x2a\0\0\0\x08FAKE GPSLatitude 43/1 39/1 12/1 N";
        let length = u16::try_from(payload.len() + 2).unwrap().to_be_bytes();
        [
            &CANVAS[..20],
            &[0xff, 0xe1, length[0], length[1]][..],
            payload,
            &CANVAS[20..],
        ]
        .concat()
    }

    fn target(profile: &str, folders: &str, name: &str) -> Vec<u8> {
        format!(r#"{{"profileId":{profile},"folderIds":{folders},"name":{name}}}"#).into_bytes()
    }

    /// A photo request as the camera window frames it.
    fn framed(target: &[u8], jpeg: &[u8]) -> Vec<u8> {
        let length = u32::try_from(target.len()).unwrap().to_be_bytes();
        [&length[..], target, jpeg].concat()
    }

    fn unlocked_store(temp: &tempfile::TempDir) -> (VaultStore, Uuid) {
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "FAKE Patient", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        (store, profile)
    }

    fn exported(store: &VaultStore, record: Uuid) -> Vec<u8> {
        let mut bytes = Vec::new();
        store.export(record, &mut bytes).unwrap();
        bytes
    }

    #[test]
    fn the_target_says_where_a_photo_goes_and_its_name() {
        let profile = Uuid::new_v4();
        let folder = Uuid::new_v4();
        let id = format!("\"{profile}\"");
        let target_of = |folders: &str, name: &str| photo_target(&target(&id, folders, name));
        assert_eq!(
            target_of(
                &format!("[\"{folder}\"]"),
                "\"Photo, 17 Oct 2026, 3.05 PM.jpg\""
            )
            .unwrap(),
            PhotoTarget {
                profile_id: profile,
                folder_ids: vec![folder],
                name: "Photo, 17 Oct 2026, 3.05 PM.jpg".to_owned(),
            }
        );
        // No folder: My records. Any name in UTF-8.
        let my_records = target_of("[]", "\"Zdjęcie.JPG\"").unwrap();
        assert!(my_records.folder_ids.is_empty());
        assert_eq!(my_records.name, "Zdjęcie.JPG");

        let many = format!(
            "[{}]",
            vec![format!("\"{folder}\""); vault::MAX_FOLDER_ASSIGNMENTS + 1].join(",")
        );
        for (case, json) in [
            ("no profile", target("\"\"", "[]", "\"Photo.jpg\"")),
            (
                "a profile that is not an id",
                target("\"FAKE\"", "[]", "\"Photo.jpg\""),
            ),
            (
                "a folder that is not an id",
                target(&id, "[\"FAKE\"]", "\"Photo.jpg\""),
            ),
            (
                "more folders than a document can be in",
                target(&id, &many, "\"Photo.jpg\""),
            ),
            ("no .jpg", target(&id, "[]", "\"Photo.png\"")),
            ("only .jpg", target(&id, "[]", "\".jpg\"")),
            ("only spaces before .jpg", target(&id, "[]", "\"  .jpg\"")),
            ("a space at the start", target(&id, "[]", "\" Photo.jpg\"")),
            ("text after .jpg", target(&id, "[]", "\"Photo.jpg \"")),
            (
                "a field it does not know",
                format!(r#"{{"profileId":{id},"folderIds":[],"name":"Photo.jpg","x":1}}"#)
                    .into_bytes(),
            ),
            (
                "a field missing",
                format!(r#"{{"profileId":{id},"name":"Photo.jpg"}}"#).into_bytes(),
            ),
            (
                "not UTF-8",
                [&target(&id, "[]", "\"Photo")[..], b"\xff.jpg\"}"].concat(),
            ),
            ("not JSON", b"FAKE".to_vec()),
        ] {
            assert!(
                matches!(photo_target(&json), Err(VaultError::Invalid)),
                "{case}"
            );
        }
    }

    #[test]
    fn a_photo_request_is_its_target_then_the_jpeg() {
        let profile = Uuid::new_v4();
        let json = target(&format!("\"{profile}\""), "[]", "\"Photo.jpg\"");
        let (got, jpeg) = split_photo_request(&framed(&json, CANVAS)).ok().unwrap();
        assert_eq!(got.profile_id, profile);
        assert_eq!(*jpeg, CANVAS);
        let code = |request: &[u8]| split_photo_request(request).err().unwrap().code;
        // Too short for its length, a length over the bound, a length past
        // the end: the framing is wrong.
        assert_eq!(code(&[0, 0, 1]), "photo_body");
        let over = u32::try_from(MAX_PHOTO_TARGET_BYTES + 1)
            .unwrap()
            .to_be_bytes();
        assert_eq!(code(&[&over[..], &json].concat()), "photo_body");
        assert_eq!(code(&[0, 0, 1, 0, b'{']), "photo_body");
        // The target itself is wrong.
        assert_eq!(code(&framed(b"FAKE", CANVAS)), "photo_target");
        // The JPEG over its own limit.
        let large = vec![0_u8; photo::MAX_PHOTO_BYTES + 1];
        assert_eq!(code(&framed(&json, &large)), "not_a_photo");
    }

    #[test]
    fn a_saved_photo_is_cleaned_and_stored_as_an_import_in_the_open_folder() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = unlocked_store(&temp);
        let folder = store.create_folder(profile, None, "FAKE Cards", 2).unwrap();
        let photo = Zeroizing::new(tagged());
        let outcome = save_photo(
            &store,
            PhotoTarget {
                profile_id: profile,
                folder_ids: vec![folder],
                name: "Photo, 17 Oct 2026, 3.05 PM.jpg".to_owned(),
            },
            photo,
        )
        .unwrap();
        assert_eq!(outcome.imported.len(), 1);
        let snapshot = store.snapshot().unwrap();
        let record = &snapshot.records[0];
        assert_eq!(record.id, outcome.imported[0]);
        assert_eq!(record.display_name, "Photo, 17 Oct 2026, 3.05 PM.jpg");
        assert_eq!(record.folder_ids, [folder]);
        // The vault's format is unchanged: a photo is an import like any other.
        assert_eq!(record.source_label, "Manual import — unverified");
        assert_eq!(record.media_type, "application/octet-stream");
        let stored = exported(&store, record.id);
        assert_eq!(stored, *photo::clean_jpeg(CANVAS).unwrap());
        assert_eq!(record.plaintext_size, stored.len() as u64);
        assert!(!stored.windows(4).any(|window| window == b"Exif"));
        assert!(!stored.windows(4).any(|window| window == b"FAKE"));

        // The same photo again is a duplicate, as an import would be.
        let again = save_photo(
            &store,
            PhotoTarget {
                profile_id: profile,
                folder_ids: Vec::new(),
                name: "Photo, 17 Oct 2026, 3.06 PM.jpg".to_owned(),
            },
            Zeroizing::new(CANVAS.to_vec()),
        )
        .unwrap();
        assert!(again.imported.is_empty());
        assert_eq!(
            again.skipped_duplicates,
            ["Photo, 17 Oct 2026, 3.06 PM.jpg"]
        );
    }

    #[test]
    fn a_photo_that_is_not_a_jpeg_or_a_locked_vault_saves_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = unlocked_store(&temp);
        let target = || PhotoTarget {
            profile_id: profile,
            folder_ids: Vec::new(),
            name: "Photo.jpg".to_owned(),
        };
        for bytes in [
            b"%PDF-1.7 FAKE".to_vec(),
            CANVAS[..CANVAS.len() - 2].to_vec(),
            Vec::new(),
        ] {
            assert!(matches!(
                save_photo(&store, target(), Zeroizing::new(bytes)),
                Err(VaultError::NotPhoto)
            ));
        }
        assert!(store.snapshot().unwrap().records.is_empty());
        store.lock();
        assert!(matches!(
            save_photo(&store, target(), Zeroizing::new(CANVAS.to_vec())),
            Err(VaultError::Locked)
        ));
    }

    #[test]
    fn the_photo_view_goes_by_the_bytes_and_drops_their_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = unlocked_store(&temp);
        let sources = vec![
            // A JPEG renamed with no extension is still a photo.
            ImportSource {
                display_name: "FAKE insurance card".to_owned(),
                reader: Box::new(Cursor::new(tagged())),
            },
            ImportSource {
                display_name: "FAKE results.jpg".to_owned(),
                reader: Box::new(Cursor::new(b"%PDF-1.7 FAKE results".to_vec())),
            },
            ImportSource {
                display_name: "FAKE cut off.jpg".to_owned(),
                reader: Box::new(Cursor::new(CANVAS[..CANVAS.len() - 2].to_vec())),
            },
        ];
        let ids = store
            .import(profile, Vec::new(), sources, 2)
            .unwrap()
            .imported;

        let url = view_photo(&store, ids[0]).unwrap();
        let shown = BASE64
            .decode(url.strip_prefix("data:image/jpeg;base64,").unwrap())
            .unwrap();
        assert_eq!(shown, *photo::clean_jpeg(CANVAS).unwrap());
        // What is stored is not changed by viewing it.
        assert_eq!(exported(&store, ids[0]), tagged());

        for id in &ids[1..] {
            assert!(matches!(view_photo(&store, *id), Err(VaultError::NotPhoto)));
        }
        assert!(matches!(
            view_photo(&store, Uuid::new_v4()),
            Err(VaultError::NotFound)
        ));
        store.lock();
        assert!(matches!(
            view_photo(&store, ids[0]),
            Err(VaultError::Locked)
        ));
    }

    #[test]
    fn the_details_check_reads_only_a_files_first_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile) = unlocked_store(&temp);
        let files: [(&str, Vec<u8>); 5] = [
            ("FAKE insurance card", tagged()),
            ("FAKE results.jpg", b"%PDF-1.7 FAKE results".to_vec()),
            ("FAKE two bytes", vec![0xff, 0xd8]),
            ("FAKE empty", Vec::new()),
            ("FAKE cut off", CANVAS[..CANVAS.len() - 2].to_vec()),
        ];
        let sources = files
            .iter()
            .map(|(name, bytes)| ImportSource {
                display_name: (*name).to_owned(),
                reader: Box::new(Cursor::new(bytes.clone())),
            })
            .collect();
        let ids = store
            .import(profile, Vec::new(), sources, 2)
            .unwrap()
            .imported;
        let checked: Vec<bool> = ids
            .iter()
            .map(|id| is_photo(&store, *id).unwrap())
            .collect();
        // A JPEG with no extension is a photo; a PDF named ".jpg" is not.
        assert_eq!(checked, [true, false, false, false, true]);
        // The check goes by the first bytes only: the view checks the rest.
        assert!(matches!(
            view_photo(&store, ids[4]),
            Err(VaultError::NotPhoto)
        ));
        assert!(matches!(
            is_photo(&store, Uuid::new_v4()),
            Err(VaultError::NotFound)
        ));
        store.lock();
        assert!(matches!(is_photo(&store, ids[0]), Err(VaultError::Locked)));

        // It stops the export once it has three bytes.
        let mut start = FileStart::default();
        assert_eq!(start.write(&[0xff]).unwrap(), 1);
        assert!(start.write(&[0xd8, 0xff, 0xe0, 0x00]).is_err());
        assert!(start.complete());
        assert_eq!(start.bytes, photo::JPEG_START);
    }

    #[test]
    fn the_photo_buffer_stops_at_the_first_bytes_that_are_not_a_jpeg_or_past_the_cap() {
        let mut pdf = PhotoBuffer::default();
        assert!(pdf.write(b"%PDF-1.7").is_err());
        assert!(pdf.refused);
        // One byte at a time, as far as the bytes go.
        let mut jpeg = PhotoBuffer::default();
        for byte in &CANVAS[..3] {
            assert_eq!(jpeg.write(&[*byte]).unwrap(), 1);
        }
        let mut wrong_third = PhotoBuffer::default();
        assert!(wrong_third.write(&[0xff, 0xd8]).is_ok());
        assert!(wrong_third.write(&[0x00]).is_err());
        assert!(wrong_third.refused);

        let mut large = PhotoBuffer::default();
        let chunk = vec![0_u8; 1024 * 1024];
        large.write_all(&CANVAS[..3]).unwrap();
        while large.bytes.len() + chunk.len() <= photo::MAX_PHOTO_BYTES {
            large.write_all(&chunk).unwrap();
        }
        assert!(!large.refused);
        let room = photo::MAX_PHOTO_BYTES - large.bytes.len();
        large.write_all(&chunk[..room]).unwrap();
        assert_eq!(large.bytes.len(), photo::MAX_PHOTO_BYTES);
        assert!(large.write(&[0]).is_err());
        assert!(large.refused);
    }

    #[test]
    fn a_photo_arrives_as_raw_bytes_or_as_postmessage_numbers() {
        use tauri::ipc::InvokeBody;
        let jpeg = vec![0xff_u8, 0xd8, 0xff, 0x00, 0x10];
        // The custom protocol: the raw body.
        assert_eq!(
            *photo_bytes_within(&InvokeBody::Raw(jpeg.clone()), 8)
                .ok()
                .unwrap(),
            jpeg
        );
        // postMessage (Android always, Windows after a fallback): numbers.
        let numbers = InvokeBody::Json(serde_json::json!([255, 216, 255, 0, 16]));
        assert_eq!(*photo_bytes_within(&numbers, 8).ok().unwrap(), jpeg);
        // Over the limit either way: refused before anything is copied.
        for body in [
            InvokeBody::Raw(vec![0; 9]),
            InvokeBody::Json(serde_json::json!([0, 0, 0, 0, 0, 0, 0, 0, 0])),
        ] {
            assert_eq!(
                photo_bytes_within(&body, 8).unwrap_err().code,
                "not_a_photo"
            );
        }
        // Anything else is not a photo's bytes.
        for body in [
            serde_json::json!([256]),
            serde_json::json!([-1]),
            serde_json::json!([1.5]),
            serde_json::json!(["ff"]),
            serde_json::json!({ "0": 255 }),
            serde_json::json!(null),
        ] {
            assert_eq!(
                photo_bytes_within(&InvokeBody::Json(body), 8)
                    .unwrap_err()
                    .code,
                "photo_body"
            );
        }
    }

    #[test]
    fn the_photo_commands_are_wired_as_the_renderer_calls_them() {
        let source = include_str!("lib.rs");
        let body = |command: &str| {
            let body = source.split(command).nth(1).unwrap();
            body[..body.find("\n}\n").unwrap()].to_owned()
        };
        let save = body("async fn vault_save_photo(");
        // The photo's bytes and its target come from the request as sent.
        assert!(save.contains("photo_request(request.body())"));
        assert!(!save.contains("headers()"));
        assert!(save.contains("run_blocking("));
        assert!(body("async fn vault_view_photo(").contains("run_blocking("));
        assert!(body("async fn vault_is_photo(").contains("run_blocking("));
    }
}

#[cfg(test)]
mod locked_pdf_command_tests {
    use super::*;
    use pdf_unlock::{Outcome, Refusal};
    use std::io::Cursor;

    const PASSPHRASE: &str = "river-azimuth-cobalt-sparrow-934";
    /// The FAKE documents' password (tests/fixtures/locked-pdf/README.md).
    const DOCUMENT_PASSWORD: &str = "FAKE-portal-2026";

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/locked-pdf")
                .join(name),
        )
        .unwrap()
    }

    /// The helper's work, done here: the test binary is not myCarlos, so it
    /// cannot be started as the helper (tests/pdf_helper.rs starts the real one).
    fn in_process(pdf: &[u8], password: &str) -> Outcome {
        match pdf_unlock::unlock(pdf, password) {
            Ok(unlocked) => Outcome::Unlocked(unlocked),
            Err(refusal) => Outcome::Refused(refusal),
        }
    }

    /// A vault with one person and a folder, holding `name` made of `bytes`.
    fn stored(
        temp: &tempfile::TempDir,
        name: &str,
        bytes: Vec<u8>,
    ) -> (VaultStore, Uuid, Uuid, Uuid) {
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSPHRASE, "FAKE Patient", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let folder = store
            .create_folder(profile, None, "FAKE Letters", 2)
            .unwrap();
        let outcome = store
            .import(
                profile,
                vec![folder],
                vec![ImportSource {
                    display_name: name.to_owned(),
                    reader: Box::new(Cursor::new(bytes)),
                }],
                3,
            )
            .unwrap();
        (store, profile, folder, outcome.imported[0])
    }

    fn exported(store: &VaultStore, record: Uuid) -> Vec<u8> {
        let mut bytes = Vec::new();
        store.export(record, &mut bytes).unwrap();
        bytes
    }

    #[test]
    fn the_locked_original_keeps_its_extension_and_says_what_it_is() {
        assert_eq!(
            locked_original_name("FAKE Letter.pdf"),
            "FAKE Letter (locked original).pdf"
        );
        assert_eq!(
            locked_original_name("FAKE SCAN.PDF"),
            "FAKE SCAN (locked original).PDF"
        );
        assert_eq!(
            locked_original_name("FAKE Letter"),
            "FAKE Letter (locked original)"
        );
        assert_eq!(
            locked_original_name("Zdjęcie ąę.pdf"),
            "Zdjęcie ąę (locked original).pdf"
        );
        // A name already as long as a name can be: the words still fit.
        let long = format!("{}.pdf", "ł".repeat(vault::MAX_RECORD_NAME_LEN - 4));
        let original = locked_original_name(&long);
        assert_eq!(original.chars().count(), vault::MAX_RECORD_NAME_LEN);
        assert!(original.ends_with("ł (locked original).pdf"));
    }

    #[test]
    fn a_stored_pdf_is_found_locked_by_its_names_only() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile, _, locked) =
            stored(&temp, "FAKE Letter.pdf", fixture("text-aes256.pdf"));
        assert!(is_locked_pdf(&store, locked).unwrap());
        let open = store
            .import(
                profile,
                vec![],
                vec![ImportSource {
                    display_name: "FAKE Open.pdf".to_owned(),
                    reader: Box::new(Cursor::new(fixture("text-original.pdf"))),
                }],
                4,
            )
            .unwrap()
            .imported[0];
        assert!(!is_locked_pdf(&store, open).unwrap());
        assert!(matches!(
            is_locked_pdf(&store, Uuid::new_v4()),
            Err(VaultError::NotFound)
        ));
    }

    #[test]
    fn unlocking_adds_the_copy_and_keeps_the_original_renamed() {
        let temp = tempfile::tempdir().unwrap();
        let (store, profile, folder, locked) =
            stored(&temp, "FAKE Letter.pdf", fixture("text-aes256.pdf"));
        let unlocked = unlock_pdf(&store, locked, DOCUMENT_PASSWORD, in_process).unwrap();
        assert_eq!(unlocked.original_name, "FAKE Letter (locked original).pdf");
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.records.len(), 2);
        let copy = snapshot
            .records
            .iter()
            .find(|record| record.id == unlocked.record_id)
            .unwrap();
        let original = snapshot
            .records
            .iter()
            .find(|record| record.id == locked)
            .unwrap();
        // The copy takes the name, in the same person's records and folder.
        assert_eq!(copy.display_name, "FAKE Letter.pdf");
        assert_eq!(
            (copy.profile_id, &copy.folder_ids),
            (profile, &vec![folder])
        );
        assert_eq!(original.display_name, "FAKE Letter (locked original).pdf");
        assert_eq!(original.folder_ids, vec![folder]);
        // The original is as it came; the copy opens without a password.
        assert_eq!(exported(&store, locked), fixture("text-aes256.pdf"));
        assert!(!is_locked_pdf(&store, unlocked.record_id).unwrap());
        assert!(matches!(
            pdf_unlock::unlock(&exported(&store, unlocked.record_id), ""),
            Err(Refusal::NotEncrypted)
        ));

        // Unlocking the original again adds nothing, and keeps its name.
        assert!(matches!(
            unlock_pdf(&store, locked, DOCUMENT_PASSWORD, in_process),
            Err(VaultError::PdfAlreadyUnlocked)
        ));
        assert_eq!(store.snapshot().unwrap().records.len(), 2);
    }

    #[test]
    fn a_wrong_password_or_a_failed_helper_changes_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _, _, locked) = stored(&temp, "FAKE Letter.pdf", fixture("text-aes256.pdf"));
        let unchanged = |store: &VaultStore| {
            let snapshot = store.snapshot().unwrap();
            snapshot.records.len() == 1 && snapshot.records[0].display_name == "FAKE Letter.pdf"
        };
        assert!(matches!(
            unlock_pdf(&store, locked, "FAKE-wrong", in_process),
            Err(VaultError::PdfWrongPassword)
        ));
        assert!(unchanged(&store));
        for (outcome, expected) in [
            (Outcome::Refused(Refusal::NotEncrypted), "pdf_not_locked"),
            (Outcome::Refused(Refusal::TooLarge), "pdf_too_large"),
            (Outcome::Refused(Refusal::Damaged), "pdf_unlock_failed"),
            (Outcome::Refused(Refusal::Unsupported), "pdf_unlock_failed"),
            (Outcome::Failed, "pdf_unlock_failed"),
            (Outcome::Unavailable, "pdf_unlock_unavailable"),
        ] {
            let error = unlock_pdf(&store, locked, DOCUMENT_PASSWORD, |_, _| outcome).unwrap_err();
            assert_eq!(PublicError::from(error).code, expected);
            assert!(unchanged(&store));
        }
        assert!(matches!(
            unlock_pdf(&store, Uuid::new_v4(), DOCUMENT_PASSWORD, in_process),
            Err(VaultError::NotFound)
        ));
    }

    #[test]
    fn a_locked_file_in_shared_with_me_is_unlocked_there() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _, _, _) = stored(&temp, "FAKE Other.pdf", fixture("text-original.pdf"));
        let shared = store.shared_profile().unwrap();
        let locked = store
            .import(
                shared,
                vec![],
                vec![ImportSource {
                    display_name: "FAKE Referral.pdf".to_owned(),
                    reader: Box::new(Cursor::new(fixture("text-aes256.pdf"))),
                }],
                4,
            )
            .unwrap()
            .imported[0];
        let unlocked = unlock_pdf(&store, locked, DOCUMENT_PASSWORD, in_process).unwrap();
        let snapshot = store.snapshot().unwrap();
        let copy = snapshot
            .records
            .iter()
            .find(|record| record.id == unlocked.record_id)
            .unwrap();
        assert_eq!(copy.profile_id, shared);
        assert!(copy.folder_ids.is_empty());
    }

    #[test]
    fn a_file_over_the_limit_is_not_read_whole() {
        let mut buffer = LimitedBuffer::new(4);
        assert!(std::io::Write::write_all(&mut buffer, b"%PDF").is_ok());
        assert!(std::io::Write::write_all(&mut buffer, b"-").is_err());
        assert!(buffer.over);
        assert_eq!(&buffer.bytes[..], b"%PDF");
    }

    #[test]
    fn the_unlock_commands_run_off_the_main_thread_and_wipe_the_password() {
        let source = include_str!("lib.rs");
        let body = |name: &str| {
            let start = source.find(name).unwrap();
            &source[start..start + source[start..].find("\n}\n").unwrap()]
        };
        let unlock = body("async fn vault_unlock_pdf(");
        assert!(unlock.contains("run_blocking("));
        assert!(unlock.contains("pdf_unlock::unlock_in_helper"));
        assert!(unlock.contains("Opening::new(store.idle())"));
        assert!(unlock.contains("Zeroizing::new(std::mem::take(&mut request.password))"));
        assert!(body("async fn vault_is_locked_pdf(").contains("run_blocking("));
        assert!(body("impl Drop for UnlockPdfRequest").contains("self.password.zeroize()"));
    }
}

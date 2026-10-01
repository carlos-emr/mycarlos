mod idle;
mod throttle;
mod vault;

use idle::{IdleDeadline, Opening};
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
use tauri::{Manager, State};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tauri_plugin_fs::{FsExt, OpenOptions};
use throttle::{Attempt, AttemptThrottle, Outcome};
use uuid::Uuid;
use vault::{
    ImportSource, RestoreCredential, RestorePreview, RestoreReplaces, VaultError, VaultSnapshot,
    VaultStatus, VaultStore,
};
use zeroize::Zeroize;

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
                message: "That passphrase did not unlock the vault.",
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
                message: "Check the requested information and try again.",
            },
            VaultError::WeakPassphrase => Self {
                code: "weak_passphrase",
                message: "Choose a less predictable passphrase that is not based on common passwords, names, or myCarlos.",
            },
            VaultError::ImportBatchLimit => Self {
                code: "import_batch_limit",
                message: "Choose no more than 100 files in one import.",
            },
            VaultError::NoSpace => Self {
                code: "no_space",
                message: "There is not enough storage to complete this operation.",
            },
            VaultError::Storage => Self {
                code: "storage",
                message: "The storage operation could not be completed. Review the current vault state before retrying.",
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

/// One speed test at a time: each takes a core and 64 MiB for some seconds.
#[derive(Default)]
struct SpeedTest(std::sync::atomic::AtomicBool);

/// Lets the next speed test start when this one ends, however it ends.
struct SpeedTestRunning(Arc<SpeedTest>);

impl SpeedTestRunning {
    fn start(gate: &Arc<SpeedTest>) -> Option<Self> {
        use std::sync::atomic::Ordering;
        (!gate.0.swap(true, Ordering::AcqRel)).then(|| Self(Arc::clone(gate)))
    }
}

impl Drop for SpeedTestRunning {
    fn drop(&mut self) {
        self.0 .0.store(false, std::sync::atomic::Ordering::Release);
    }
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
/// Only with a vault unlocked, where the screen that asks for it is, so that
/// it is not run beside an unlock, which would double the memory the app
/// needs at that moment. It can still meet one: the vault can lock while it
/// runs and be unlocked again, or the passphrase be changed meanwhile. The
/// screen asks testers to do nothing else until it is done.
#[tauri::command]
async fn kdf_benchmark(
    store: State<'_, Arc<VaultStore>>,
    gate: State<'_, Arc<SpeedTest>>,
) -> CommandResult<SpeedTestReport> {
    run_blocking(store.inner(), |store| match store.status()? {
        VaultStatus::Unlocked => Ok(()),
        _ => Err(VaultError::Locked),
    })
    .await?;
    let Some(running) = SpeedTestRunning::start(gate.inner()) else {
        return Err(PublicError {
            code: "busy",
            message: "A speed test is already running. Wait for it to finish.",
            record_id: None,
            note: None,
        });
    };
    let measured = tauri::async_runtime::spawn_blocking(move || {
        // Held by the work itself, so that it ends with it.
        let _running = running;
        vault::benchmark_kdf()
    })
    .await
    .map_err(|_| PublicError {
        code: "speed_test_failed",
        message: "The speed test stopped before it finished. Nothing was changed. Try again.",
        record_id: None,
        note: None,
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
    run_blocking(store.inner(), |store| {
        store.lock();
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
/// typing. Linux has no explicit default and needs device testing. The button that goes ahead comes second, and
/// Cancel, which does what the first does, third.
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
    #[cfg(desktop)]
    {
        if let Ok(local_path) = path.clone().into_path() {
            let file = vault::open_regular_read(&local_path).map_err(import_source_error)?;
            return Ok(ImportSource {
                display_name,
                reader: Box::new(file),
            });
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    let file = app
        .fs()
        .open(path, options)
        .map_err(|_| VaultError::Storage)?;
    Ok(ImportSource {
        display_name,
        reader: Box::new(file),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
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
            app.manage(Arc::new(SpeedTest::default()));
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
            vault_export_pick,
            vault_export_picked,
            vault_delete_record,
            vault_remove_unavailable_records,
            vault_reset
        ])
        .run(tauri::generate_context!())
        .expect("error while running myCarlos");
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    #[test]
    fn one_speed_test_at_a_time_and_the_next_when_it_ends() {
        let gate = Arc::new(SpeedTest::default());
        let first = SpeedTestRunning::start(&gate).unwrap();
        assert!(SpeedTestRunning::start(&gate).is_none());
        drop(first);
        let second = SpeedTestRunning::start(&gate).unwrap();
        // Ended by a task that panicked, as by one that returned.
        let running = std::thread::spawn(move || {
            let _running = second;
            panic!("FAKE the derivation failed");
        })
        .join();
        assert!(running.is_err());
        assert!(SpeedTestRunning::start(&gate).is_some());
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
        // browser. Tauri leaves those keys off unless the window enables them.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap();
        assert!(!windows.is_empty());
        for window in windows {
            assert_eq!(window["zoomHotkeysEnabled"], true);
        }
        // On macOS and Linux Tauri implements those keys in the page, which
        // then needs leave to set its own zoom. Only there, and nothing else:
        // Windows zooms natively, and mobile has no such command.
        let zoom: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/zoom.json")).unwrap();
        assert_eq!(zoom["windows"], serde_json::json!(["main"]));
        assert_eq!(zoom["platforms"], serde_json::json!(["macOS", "linux"]));
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
        assert_eq!(files, ["default.json", "zoom.json"]);
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
            let _ = serde_json::from_slice::<ExportRequest>(&payload);
            let _ = serde_json::from_slice::<DeleteRecordRequest>(&payload);
            let _ = serde_json::from_slice::<RemoveUnavailableRequest>(&payload);
            let _ = serde_json::from_slice::<ResetRequest>(&payload);
        }
    }
}

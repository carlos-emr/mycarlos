mod idle;
mod vault;

use idle::{IdleDeadline, Opening};
use serde::{Deserialize, Serialize};
#[cfg(desktop)]
use std::io;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_fs::{FsExt, OpenOptions};
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
}

type CommandResult<T> = Result<T, PublicError>;

impl PublicError {
    fn partial_export() -> Self {
        Self {
            code: "partial_export",
            message: "The selected destination may contain a partial readable copy. Delete that copy before retrying.",
        }
    }
}

impl PublicError {
    fn removal_not_possible() -> Self {
        Self {
            code: "recovery_mode",
            message: "Nothing was removed. The vault cannot be changed right now; the notice above the documents says why.",
        }
    }
}

impl From<VaultError> for PublicError {
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
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateVaultRequest {
    passphrase: String,
    initial_profile_name: String,
}

#[derive(Deserialize)]
struct RemoveUnavailableRequest {
    confirmed: Vec<Uuid>,
}

#[derive(Deserialize)]
struct PassphraseRequest {
    passphrase: String,
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

#[tauri::command]
async fn vault_status(store: State<'_, Arc<VaultStore>>) -> CommandResult<VaultStatus> {
    run_blocking(store.inner(), VaultStore::status).await
}

#[tauri::command]
async fn vault_create(
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
    mut request: CreateVaultRequest,
) -> CommandResult<VaultSnapshot> {
    let picks = Arc::clone(picks.inner());
    run_blocking(store.inner(), move |store| {
        let result = store
            .create(&request.passphrase, &request.initial_profile_name, now_ms())
            .inspect(|_| picks.clear())
            .and_then(|_| store.snapshot());
        request.passphrase.zeroize();
        result
    })
    .await
}

#[tauri::command]
async fn vault_unlock(
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
    mut request: PassphraseRequest,
) -> CommandResult<VaultSnapshot> {
    let picks = Arc::clone(picks.inner());
    run_blocking(store.inner(), move |store| {
        let result = store
            .unlock(&request.passphrase)
            // A pick can read the session after a lock clears it but pass its
            // unlocked check before the lock lands. Starting a new session here
            // leaves such a pick in the one that ended.
            .inspect(|_| picks.clear())
            .and_then(|_| store.snapshot());
        request.passphrase.zeroize();
        result
    })
    .await
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
    mut request: ChangePassphraseRequest,
) -> CommandResult<()> {
    run_blocking(store.inner(), move |store| {
        let result = store.change_passphrase(&request.current_passphrase, &request.new_passphrase);
        request.current_passphrase.zeroize();
        request.new_passphrase.zeroize();
        result
    })
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
    mut request: PassphraseRequest,
) -> CommandResult<ShownRecoveryKey> {
    run_blocking(store.inner(), move |store| {
        let result = store
            .begin_recovery_key(&request.passphrase)
            .map(ShownRecoveryKey);
        request.passphrase.zeroize();
        result
    })
    .await
}

/// What the native confirmation says before a new recovery key takes the
/// place of the one the vault has.
const REPLACE_RECOVERY_KEY_WARNING: &str = "Your current recovery key will stop working. A kit you saved or printed for it will no longer open this vault. Before you continue, make sure you have written down or saved the new key. If you did not ask to replace your recovery key, choose Cancel.";

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
    let request = Arc::new(request);
    // A mistyped answer is refused before anything is asked.
    let replaces = {
        let request = Arc::clone(&request);
        run_blocking(store.inner(), move |store| {
            store.check_recovery_key(&request.groups())
        })
        .await?
    };
    // Held until the key is stored, so that the automatic lock cannot fall
    // while the dialog is read: it would forget the key being set up, and
    // the patient would press "Replace key" to a vault that had locked.
    let _open = ActivityHold::new(store.idle());
    if replaces {
        let dialog_app = app.clone();
        let confirmed = tauri::async_runtime::spawn_blocking(move || {
            dialog_app
                .dialog()
                .message(REPLACE_RECOVERY_KEY_WARNING)
                .title("Replace your recovery key?")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Replace key".to_owned(),
                    "Cancel".to_owned(),
                ))
                .blocking_show()
        })
        .await
        .map_err(|_| PublicError::from(VaultError::Storage))?;
        if !confirmed {
            return Ok(None);
        }
    }
    run_blocking(store.inner(), move |store| {
        // Checked again with the change: the key being set up, or the
        // vault, may not be what it was before the dialog.
        if store.check_recovery_key(&request.groups())? != replaces {
            return Err(VaultError::Invalid);
        }
        store.confirm_recovery_key(&request.groups(), now_ms())?;
        store.snapshot().map(Some)
    })
    .await
}

/// Saves the kit for the recovery key being set up to a file the patient
/// picks. Returns false if the picker was cancelled.
#[tauri::command]
async fn vault_recovery_kit_save(
    app: tauri::AppHandle,
    store: State<'_, Arc<VaultStore>>,
) -> CommandResult<bool> {
    // Nothing is asked for unless a key is waiting to be confirmed.
    run_blocking(store.inner(), |store| {
        store.recovery_kit(now_ms()).map(drop)
    })
    .await?;
    // Held until the kit is written, so that the automatic lock cannot fall
    // between the picker closing and the write.
    let _open = ActivityHold::new(store.idle());
    let dialog = app.clone();
    let destination = tauri::async_runtime::spawn_blocking(move || {
        dialog
            .dialog()
            .file()
            .set_file_name("myCarlos recovery kit.txt")
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
    mut request: RecoverRequest,
) -> CommandResult<RecoverResponse> {
    let picks = Arc::clone(picks.inner());
    run_blocking(store.inner(), move |store| {
        let result = store
            .recover(&request.recovery_key, &request.new_passphrase)
            // As for unlock: a pick from the session that ended stays there.
            .inspect(|_| picks.clear())
            .and_then(|passphrase_replaced| {
                Ok(RecoverResponse {
                    passphrase_replaced,
                    snapshot: store.snapshot()?,
                })
            });
        request.recovery_key.zeroize();
        request.new_passphrase.zeroize();
        result
    })
    .await
}

/// Asks where to save an encrypted backup. The backup itself is written by
/// `vault_backup_picked`, so that the renderer can treat it as a transfer.
#[tauri::command]
async fn vault_backup_pick(
    app: tauri::AppHandle,
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
) -> CommandResult<Option<Uuid>> {
    let session = picks.session();
    // Nothing is asked for unless there is a writable vault to back up.
    run_blocking(store.inner(), |store| match store.snapshot()?.recovery {
        None => Ok(()),
        Some(_) => Err(VaultError::RecoveryMode),
    })
    .await?;
    let _open = ActivityHold::new(store.idle());
    let destination = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name("myCarlos backup.mycarlosbackup")
            .blocking_save_file()
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
) -> CommandResult<()> {
    let destination = picks
        .backups
        .take(request.pick_id, picks.session())
        .ok_or(VaultError::NotFound)?;
    if let Ok(path) = destination.clone().into_path() {
        return run_blocking(store.inner(), move |store| {
            store.backup_atomic(&path, now_ms())
        })
        .await;
    }
    // Android content providers return a URI rather than a path. A backup
    // holds only ciphertext, so a partial one left by a failure is not
    // readable, only incomplete, and restoring it is refused.
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
        drop(opening);
        store.backup(std::io::BufWriter::new(output), now_ms())
    })
    .await
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
    if let Ok(path) = source.clone().into_path() {
        // As for imports: a regular file, opened without following a link or
        // waiting on a pipe or device.
        return Ok(Box::new(std::io::BufReader::new(vault::open_regular_read(
            &path,
        )?)));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    let file = app
        .fs()
        .open(source, options)
        .map_err(|_| VaultError::Storage)?;
    Ok(Box::new(std::io::BufReader::new(file)))
}

/// Opens the chosen backup with its credential and says what restoring it
/// would replace. The pick stays for `vault_restore`.
#[tauri::command]
async fn vault_restore_inspect(
    app: tauri::AppHandle,
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
    mut request: RestoreRequest,
) -> CommandResult<RestorePreview> {
    let source = picks
        .restores
        .peek_within(request.pick_id, picks.session(), RESTORE_PICK_TTL)
        .ok_or(VaultError::NotFound)?;
    run_blocking(store.inner(), move |store| {
        let result = request.credential().and_then(|credential| {
            store.inspect_backup(open_restore_source(&app, source)?, credential)
        });
        request.zeroize();
        result
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
            "The vault on this device is a different one from the backup's. Restoring permanently erases the vault on this device, and everything in it, and puts the backup ({documents}) in its place. This cannot be undone."
        )),
        RestoreReplaces::SameVault if preview.differs_from_this_device => Some(format!(
            "The vault on this device is not the same as this backup ({documents}). Restoring permanently replaces it: anything in the vault that is not in the backup is lost, and the passphrase and recovery key become the ones the backup was made with. This cannot be undone."
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
        run_blocking(store.inner(), move |store| {
            store.inspect_backup(open_restore_source(&app, source)?, request.credential()?)
        })
        .await?
    };
    if let Some(warning) = restore_warning(&preview) {
        // The renderer must have asked for a replacement too.
        if !request.replace {
            return Err(PublicError::from(VaultError::AlreadyExists));
        }
        let dialog_app = app.clone();
        let confirmed = tauri::async_runtime::spawn_blocking(move || {
            dialog_app
                .dialog()
                .message(warning)
                .title("Replace the vault on this device?")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Replace vault".to_owned(),
                    "Cancel".to_owned(),
                ))
                .blocking_show()
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
        store
            .restore_confirmed(
                open_restore_source(&app, source)?,
                request.credential()?,
                &preview,
            )
            .map(|()| true)
    })
    .await
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

#[tauri::command]
async fn vault_reset(
    app: tauri::AppHandle,
    store: State<'_, Arc<VaultStore>>,
    picks: State<'_, Arc<PendingPicks>>,
    request: ResetRequest,
) -> CommandResult<bool> {
    if request.confirmation != "RESET MYCARLOS VAULT" {
        return Err(PublicError::from(VaultError::Invalid));
    }
    let dialog_app = app.clone();
    let confirmed = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .message("This permanently erases every encrypted document, profile, and folder in this vault. This cannot be undone.")
            .title("Erase the entire myCarlos vault?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Erase vault".to_owned(),
                "Cancel".to_owned(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|_| PublicError::from(VaultError::Storage))?;
    if !confirmed {
        return Ok(false);
    }
    picks.clear();
    run_blocking(store.inner(), VaultStore::reset).await?;
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
            app.manage(Arc::new(PendingPicks::default()));
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
    fn the_restore_confirmation_says_what_would_be_lost() {
        let preview = |replaces, differs| RestorePreview {
            replaces,
            differs_from_this_device: differs,
            document_count: 3,
            fingerprint: [0; 32],
        };
        assert!(restore_warning(&preview(RestoreReplaces::Nothing, false)).is_none());
        let other = restore_warning(&preview(RestoreReplaces::OtherVault, false)).unwrap();
        assert!(other.contains("a different one") && other.contains("3 documents"));
        let changed = restore_warning(&preview(RestoreReplaces::SameVault, true)).unwrap();
        assert!(changed.contains("is not the same as") && changed.contains("passphrase"));
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

import { invoke } from "@tauri-apps/api/core";

export type VaultStatus = "absent" | "locked" | "unlocked";

export interface PatientProfile {
  id: string;
  displayName: string;
  createdAtMs: number;
}

export interface VaultFolder {
  id: string;
  profileId: string;
  parentId: string | null;
  name: string;
  createdAtMs: number;
}

export interface VaultRecord {
  id: string;
  profileId: string;
  folderIds: string[];
  displayName: string;
  sourceLabel: string;
  mediaType: string;
  plaintextSize: number;
  importedAtMs: number;
  /** False when the encrypted file was missing at unlock and cannot be saved. */
  available: boolean;
}

/** Why the vault refuses changes: some encrypted files are missing, a copy of
 * the vault's metadata could not be read, or a write failed. */
export type RecoveryReason = "lostObjects" | "unreadableSlot" | "writeFailed";

export interface VaultSnapshot {
  profiles: PatientProfile[];
  folders: VaultFolder[];
  records: VaultRecord[];
  recovery: RecoveryReason | null;
  /** When the vault's recovery key was set up, if it has one. */
  recoveryKeySetAtMs?: number | null;
  /** Its short label, which its kit shows (not secret), if it has one. */
  recoveryKeyLabel?: string | null;
}

/** One group of the recovery key as the patient typed it back, by position. */
export interface RecoveryKeyGroup {
  index: number;
  value: string;
}

/** A backup saved: the name of the file written, where the platform says it
 * (not an Android document provider), and how many bytes it holds. */
export interface SavedBackup {
  name: string | null;
  bytes: number;
}

/** Today on the patient's own calendar, as `YYYY-MM-DD`. */
export function localDateText(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** What restoring a backup would replace on this device: "unreadable" is a
 * vault that could not be read to tell whether it is the backup's. */
export type RestoreReplaces =
  | "nothing"
  | "sameVault"
  | "otherVault"
  | "unreadable";

export interface RestorePreview {
  replaces: RestoreReplaces;
  /** The vault on this device is the backup's, and its documents,
   * passphrase or recovery key have changed since (or it could not be read
   * to tell). Restoring loses those changes. */
  differsFromThisDevice: boolean;
  /** How many documents the backup holds. */
  documentCount: number;
}

/** What opens a backup: the passphrase it was made with, or its recovery key. */
export type RestoreCredential =
  | { passphrase: string }
  | { recoveryKey: string };

export interface RecoverOutcome {
  /** False when the vault could only open read-only, leaving the passphrase
   * unchanged. */
  passphraseReplaced: boolean;
  snapshot: VaultSnapshot;
}

export interface ImportOutcome {
  imported: string[];
  skippedDuplicates: string[];
}

export interface VaultBridge {
  readonly native: boolean;
  status(): Promise<VaultStatus>;
  create(
    passphrase: string,
    initialProfileName: string,
  ): Promise<VaultSnapshot>;
  unlock(passphrase: string): Promise<VaultSnapshot>;
  lock(): Promise<void>;
  /** Reports user input to the native idle deadline, which cannot see it. */
  touch(): Promise<void>;
  /** Gives the native idle deadline the auto-lock delay (1-15 minutes). */
  setAutoLock(minutes: number): Promise<void>;
  /** The operating system, such as "windows", "macos", "android" or "ios". */
  platform(): Promise<string>;
  snapshot(): Promise<VaultSnapshot>;
  changePassphrase(
    currentPassphrase: string,
    newPassphrase: string,
  ): Promise<void>;
  /** Makes a recovery key, authorized by the current passphrase, and returns
   * it once for the patient to write down. Nothing is stored yet. */
  beginRecoveryKey(passphrase: string): Promise<string>;
  /** Stores the key once groups of it are typed back correctly. Replacing a
   * key the vault already has is confirmed in a native dialog first;
   * resolves to null if the patient cancelled there, with nothing changed. */
  confirmRecoveryKey(groups: RecoveryKeyGroup[]): Promise<VaultSnapshot | null>;
  /** Saves the kit for the key being set up; false if the picker was
   * cancelled. */
  saveRecoveryKit(): Promise<boolean>;
  /** The short label of the key being set up, which its kits show. Not
   * secret. */
  recoveryKeyLabel(): Promise<string>;
  cancelRecoveryKey(): Promise<void>;
  /** Opens a locked vault with its recovery key and a new passphrase. */
  recover(recoveryKey: string, newPassphrase: string): Promise<RecoverOutcome>;
  /** Asks where to save an encrypted backup; null if the picker was
   * cancelled. */
  /** `localDate`: today on the patient's calendar, `YYYY-MM-DD`, for the
   * name suggested. */
  pickBackupDestination(localDate?: string): Promise<string | null>;
  /** Saves the backup, and says what was written. */
  saveBackupToPicked(pickId: string): Promise<SavedBackup>;
  /** Asks which backup to restore, while no vault is open. */
  pickRestoreSource(): Promise<string | null>;
  /** Opens the chosen backup and says what restoring it would replace. */
  inspectRestore(
    pickId: string,
    credential: RestoreCredential,
  ): Promise<RestorePreview>;
  /** Restores it. `replace` says the patient agreed to replacing the vault
   * on this device, which a native dialog then confirms; false if they
   * cancelled there. The vault is left locked. */
  restore(
    pickId: string,
    credential: RestoreCredential,
    replace: boolean,
  ): Promise<boolean>;
  createProfile(displayName: string): Promise<string>;
  createFolder(
    profileId: string,
    parentId: string | null,
    name: string,
  ): Promise<string>;
  updateFolder(
    folderId: string,
    parentId: string | null,
    name: string,
  ): Promise<void>;
  renameRecord(recordId: string, name: string): Promise<void>;
  assignFolders(recordId: string, folderIds: string[]): Promise<void>;
  assignFoldersBatch(recordIds: string[], folderIds: string[]): Promise<void>;
  /** Opens the file picker. Resolves to the id of the chosen files, kept
   * natively, or null when the picker was cancelled. */
  pickImportFiles(
    profileId: string,
    folderIds: string[],
  ): Promise<string | null>;
  importPickedFiles(
    pickId: string,
    profileId: string,
    folderIds: string[],
  ): Promise<ImportOutcome>;
  /** Opens the save picker. Resolves to the id of the chosen destination,
   * kept natively, or null when the picker was cancelled. */
  pickExportDestination(recordId: string): Promise<string | null>;
  exportToPicked(pickId: string, recordId: string): Promise<void>;
  deleteRecord(recordId: string): Promise<void>;
  /** Drops the records in `confirmed`, those shown as damaged, whose
   * encrypted file is still missing, so the vault leaves recovery mode.
   * Refused when the vault's own list differs. Resolves to the ids removed. */
  removeUnavailableRecords(confirmed: string[]): Promise<string[]>;
  reset(confirmation: string): Promise<boolean>;
}

interface PublicError {
  code?: string;
  message?: string;
  /** The document a failure is about, if it is about one. */
  recordId?: string;
  /** A sentence to add after the message, about how the failure came about. */
  note?: string;
}

export function vaultErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const { message, note } = error as PublicError;
    if (typeof message === "string")
      return typeof note === "string" ? `${message} ${note}` : message;
  }
  return "The vault operation could not be completed.";
}

/** A backup refused over one document that no longer reads, named: the
 * native side gives only its id. Any other error is returned as it is. */
export function namedDamage(
  error: unknown,
  vault: Pick<VaultSnapshot, "profiles" | "records">,
): unknown {
  if (!hasErrorCode(error, "damaged_document")) return error;
  const id = (error as PublicError).recordId;
  const record = vault.records.find((candidate) => candidate.id === id);
  if (!record) return error;
  // Two documents can share a name: when it was added, and whose records
  // hold it if there is more than one person's, tell them apart.
  const profile =
    vault.profiles.length > 1
      ? vault.profiles.find((candidate) => candidate.id === record.profileId)
      : undefined;
  const where = `added ${new Date(record.importedAtMs).toLocaleDateString()}${profile ? `, in ${profile.displayName}'s records` : ""}`;
  return {
    code: "damaged_document",
    message: `No backup was saved: the document "${record.displayName}" (${where}) is damaged and can no longer be read, and a backup that holds it would not restore. Nothing was changed. If you have that document elsewhere, delete it here and add it again; if not, deleting it lets you back up everything else.`,
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as PublicError).code === code
  );
}

/** True when the native side reports that the vault is locked, for example by
 * its own idle deadline while this screen was not running. */
export const isLockedError = (error: unknown) => hasErrorCode(error, "locked");

/** True when an operation stopped because a lock was requested while it ran
 * (the vault may still be open if that lock found it no longer due). */
export const isCancelledError = (error: unknown) =>
  hasErrorCode(error, "cancelled");

/** True when typed-back groups of a recovery key, or a recovery key, do not
 * match what was expected. */
export const isRecoveryKeyTypo = (error: unknown) =>
  hasErrorCode(error, "recovery_key_typo");

/** True when a restore was checked but has not yet replaced the vault: the
 * next start puts it in place. */
export const isRestoreUnfinished = (error: unknown) =>
  hasErrorCode(error, "restore_unfinished");

/** True when the native side reports that there is no vault to unlock or erase. */
export const isMissingVaultError = (error: unknown) =>
  hasErrorCode(error, "missing");

function isNativeRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function createVaultBridge(): VaultBridge {
  const native = isNativeRuntime();
  return {
    native,
    status: () => invoke<VaultStatus>("vault_status"),
    create: (passphrase, initialProfileName) =>
      invoke<VaultSnapshot>("vault_create", {
        request: { passphrase, initialProfileName },
      }),
    unlock: (passphrase) =>
      invoke<VaultSnapshot>("vault_unlock", { request: { passphrase } }),
    lock: () => invoke<void>("vault_lock"),
    touch: () => invoke<void>("vault_touch"),
    setAutoLock: (minutes) =>
      invoke<void>("vault_set_auto_lock", { request: { minutes } }),
    platform: () =>
      invoke<{ platform: string }>("runtime_info").then(
        (info) => info.platform,
      ),
    snapshot: () => invoke<VaultSnapshot>("vault_snapshot"),
    changePassphrase: (currentPassphrase, newPassphrase) =>
      invoke<void>("vault_change_passphrase", {
        request: { currentPassphrase, newPassphrase },
      }),
    beginRecoveryKey: (passphrase) =>
      invoke<string>("vault_recovery_key_begin", { request: { passphrase } }),
    confirmRecoveryKey: (groups) =>
      invoke<VaultSnapshot | null>("vault_recovery_key_confirm", {
        request: { groups },
      }),
    saveRecoveryKit: () => invoke<boolean>("vault_recovery_kit_save"),
    recoveryKeyLabel: () => invoke<string>("vault_recovery_key_label"),
    cancelRecoveryKey: () => invoke<void>("vault_recovery_key_cancel"),
    recover: (recoveryKey, newPassphrase) =>
      invoke<RecoverOutcome>("vault_recover", {
        request: { recoveryKey, newPassphrase },
      }),
    pickBackupDestination: (localDate) =>
      invoke<string | null>("vault_backup_pick", { request: { localDate } }),
    saveBackupToPicked: (pickId) =>
      invoke<SavedBackup>("vault_backup_picked", { request: { pickId } }),
    pickRestoreSource: () => invoke<string | null>("vault_restore_pick"),
    inspectRestore: (pickId, credential) =>
      invoke<RestorePreview>("vault_restore_inspect", {
        request: { pickId, ...credential },
      }),
    restore: (pickId, credential, replace) =>
      invoke<boolean>("vault_restore", {
        request: { pickId, ...credential, replace },
      }),
    createProfile: (displayName) =>
      invoke<string>("vault_create_profile", { request: { displayName } }),
    createFolder: (profileId, parentId, name) =>
      invoke<string>("vault_create_folder", {
        request: { profileId, parentId, name },
      }),
    updateFolder: (folderId, parentId, name) =>
      invoke<void>("vault_update_folder", {
        request: { folderId, parentId, name },
      }),
    renameRecord: (recordId, name) =>
      invoke<void>("vault_rename_record", { request: { recordId, name } }),
    assignFolders: (recordId, folderIds) =>
      invoke<void>("vault_assign_folders", {
        request: { recordId, folderIds },
      }),
    assignFoldersBatch: (recordIds, folderIds) =>
      invoke<void>("vault_assign_folders_batch", {
        request: { recordIds, folderIds },
      }),
    pickImportFiles: (profileId, folderIds) =>
      invoke<string | null>("vault_import_pick", {
        request: { profileId, folderIds },
      }),
    importPickedFiles: (pickId, profileId, folderIds) =>
      invoke<ImportOutcome>("vault_import_picked", {
        request: { pickId, profileId, folderIds },
      }),
    pickExportDestination: (recordId) =>
      invoke<string | null>("vault_export_pick", { request: { recordId } }),
    exportToPicked: (pickId, recordId) =>
      invoke<void>("vault_export_picked", { request: { pickId, recordId } }),
    deleteRecord: (recordId) =>
      invoke<void>("vault_delete_record", { request: { recordId } }),
    removeUnavailableRecords: (confirmed) =>
      invoke<string[]>("vault_remove_unavailable_records", {
        request: { confirmed },
      }),
    reset: (confirmation) =>
      invoke<boolean>("vault_reset", { request: { confirmation } }),
  };
}

// The vault limits names and passphrases in UTF-8 bytes. An input's `maxLength`
// counts UTF-16 units, so on its own it lets long non-Latin text through to a
// native rejection that cannot say what was wrong.
export const MAX_PASSPHRASE_BYTES = 1024;
const encoder = new TextEncoder();
export const utf8Length = (value: string) => encoder.encode(value).length;

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
  /** Drops every record whose encrypted file is still missing, so the vault
   * leaves recovery mode. Resolves to the ids removed. */
  removeUnavailableRecords(): Promise<string[]>;
  reset(confirmation: string): Promise<boolean>;
}

interface PublicError {
  code?: string;
  message?: string;
}

export function vaultErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as PublicError).message;
    if (typeof message === "string") return message;
  }
  return "The vault operation could not be completed.";
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

/** True when an operation stopped because the vault locked while it ran. */
export const isCancelledError = (error: unknown) =>
  hasErrorCode(error, "cancelled");

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
    removeUnavailableRecords: () =>
      invoke<string[]>("vault_remove_unavailable_records"),
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

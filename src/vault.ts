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

export interface VaultSnapshot {
  profiles: PatientProfile[];
  folders: VaultFolder[];
  records: VaultRecord[];
  degraded: boolean;
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

/** True when the native side reports that there is no vault to unlock or erase. */
export function isMissingVaultError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as PublicError).code === "missing"
  );
}

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

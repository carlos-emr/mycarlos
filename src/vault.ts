import { invoke } from "@tauri-apps/api/core";
import { getLocale, t, type MessageKey } from "./i18n";

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
  /** Set while the document is hidden (#71): out of every view but Hidden,
   * with its encrypted file kept. Nothing is ever deleted. */
  hidden?: HiddenRecord | null;
}

/** When, and why, a document was hidden (#71). */
export interface HiddenRecord {
  atMs: number;
  /** "damaged": hidden because its encrypted file was missing. */
  reason: "patient" | "damaged";
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
  /** The reserved profile that files shared to myCarlos wait in (#61): shown
   * as the "Shared with me" folder, never as a person. In `profiles` once the
   * first file has arrived. */
  sharedProfileId?: string;
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
  /** Unknown where the size could not be read. */
  bytes: number | null;
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

/** What unlocking a PDF did (#54): the unlocked copy's id, and the name the
 * locked original now has. */
export interface UnlockedPdf {
  recordId: string;
  originalName: string;
}

export interface ImportOutcome {
  imported: string[];
  skippedDuplicates: string[];
}

/** What adding the waiting files to Shared with me did (#61). */
export interface ReceivedAcceptOutcome extends ImportOutcome {
  /** Names of files that are not PDF documents: not added, and forgotten. */
  notPdf: string[];
}

/** What a move out of Shared with me did (#61). */
export interface MoveOutcome {
  moved: string[];
  /** Names of files the person already had, which stay in Shared with me. */
  alreadyThere: string[];
}

/** A file another app shared with myCarlos, waiting for the patient to add or
 * decline it. Where it came from stays native; the page has an id and a name. */
export interface ReceivedFile {
  id: string;
  name: string;
  /** The label the document will carry once added. */
  sourceLabel: string;
}

/** What could not be received since the page last asked. Counts only. */
export interface ReceiveNotice {
  /** Shared items that were not files myCarlos accepts, such as text or links. */
  dropped: number;
  /** Shares refused whole: too many files would have been waiting. */
  refusedShares: number;
}

export interface ReceivedState {
  files: ReceivedFile[];
  notice: ReceiveNotice;
}

/** How long this device took to derive a key from a passphrase. */
export interface SpeedTestReport {
  memoryKib: number;
  iterations: number;
  lanes: number;
  samplesMs: number[];
  medianMs: number;
  maxMs: number;
  /** False for an evaluation build, in which the key derivation is
   * optimized and the rest is not. */
  release: boolean;
  /** An iOS Simulator build: its timings are not a device's. */
  simulator: boolean;
  platform: string;
  architecture: string;
  appVersion: string;
}

/** Which rules a new passphrase meets, as the vault judges it (#69). */
export interface PassphraseRules {
  longEnough: boolean;
  notAName: boolean;
  hardToGuess: boolean;
}

export interface VaultBridge {
  readonly native: boolean;
  status(): Promise<VaultStatus>;
  /** First setup's checklist: refused once a vault exists. */
  passphraseRules(
    passphrase: string,
    initialProfileName: string,
  ): Promise<PassphraseRules>;
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
  /** Times the passphrase key derivation on this device, with a made-up
   * passphrase. Reads no vault and changes nothing. */
  benchmarkKdf(): Promise<SpeedTestReport>;
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
  /** Saves a photo taken with the camera (a JPEG) under `name`, in the
   * folders given or in My records. The vault cleans and checks it first. */
  savePhoto(
    profileId: string,
    folderIds: string[],
    name: string,
    jpeg: Uint8Array,
  ): Promise<ImportOutcome>;
  /** Whether a document's file starts as a JPEG does. Only its first bytes
   * are read; the photo itself stays native. */
  isPhoto(recordId: string): Promise<boolean>;
  /** A document's photo, as a `data:image/jpeg` URL, if its file is a whole
   * JPEG the vault can show; rejected with the code "not_a_photo" otherwise. */
  viewPhoto(recordId: string): Promise<string>;
  /** Hides a document (#71). There is no way to delete one. */
  hideRecord(recordId: string): Promise<void>;
  /** Puts a hidden document back. One hidden as damaged only once its file
   * is back. */
  unhideRecord(recordId: string): Promise<void>;
  /** Hides, as damaged, the records in `confirmed`, those shown as damaged,
   * whose encrypted file is still missing, so the vault leaves recovery
   * mode. Refused when the vault's own list differs. Resolves to the ids
   * hidden. */
  hideUnavailableRecords(confirmed: string[]): Promise<string[]>;
  /** Whether a stored PDF may be locked with a password (#54): a scan of its
   * names only, so the details can offer Unlock. */
  isLockedPdf(recordId: string): Promise<boolean>;
  /** Unlocks a stored PDF with the password the patient typed (#54). The
   * unlocked copy is added beside it with its name; the locked original is
   * kept, renamed. The password is not kept. */
  unlockPdf(recordId: string, password: string): Promise<UnlockedPdf>;
  /** The shared files waiting, and what could not be received since the
   * last call (that part is reported once). Works while locked. */
  listReceived(): Promise<ReceivedState>;
  /** Adds every waiting file to Shared with me; a file that is not a PDF is
   * forgotten and named. If anything else fails, they all keep waiting. */
  acceptReceived(): Promise<ReceivedAcceptOutcome>;
  /** Moves files from Shared with me to a person, into the folders named. */
  moveToPerson(
    recordIds: string[],
    profileId: string,
    folderIds: string[],
  ): Promise<MoveOutcome>;
  /** Page `page` (from 0) of a stored document, about `width` pixels wide,
   * drawn by the separate PDF helper. `password` is the document's own, when
   * it is locked with one; it is not kept. */
  viewPage(
    recordId: string,
    page: number,
    width: number,
    password?: string,
  ): Promise<ViewedPage>;
  /** Stops a page still being drawn: the reader closed. */
  cancelView(): Promise<void>;
  reset(confirmation: string): Promise<boolean>;
}

interface PublicError {
  code?: string;
  message?: string;
  /** The document a failure is about, if it is about one. */
  recordId?: string;
  /** A sentence to add after the message, about how the failure came about. */
  note?: string;
  /** How long to wait before the next try, after several wrong ones. */
  retryAfterMs?: number;
}

/** A box the patient typed in, named in the language in use ("the folder
 * name"), for "Check …, then try again." */
export type BoxKey = Extract<MessageKey, `box.${string}`>;

/** "a, b and c" in the language in use. English has no comma before "and",
 * as before. */
const listed = (items: string[]) => {
  const locale = getLocale();
  return new Intl.ListFormat(locale === "en" ? "en-GB" : locale, {
    type: "conjunction",
  }).format(items);
};

/** Of the boxes named with what was typed in them, those holding a control
 * character: at setup, the one refusal of typed text that the screen does not
 * catch first. None: a refusal is not about what was typed, as far as the
 * screen can tell, and is not blamed on a box. */
export function boxesWithControlCharacters(
  typed: [value: string, box: BoxKey][],
): BoxKey[] | undefined {
  const boxes = typed
    .filter(([value]) => /\p{Cc}/u.test(value))
    .map(([, box]) => box);
  return boxes.length ? boxes : undefined;
}

/** The message for a failed vault operation. `boxes` names, in plain words,
 * what the patient typed for it ("the folder name"): a refusal of what was
 * typed then says which box to check (#69). */
export function vaultErrorMessage(error: unknown, boxes?: BoxKey[]): string {
  if (boxes?.length && hasErrorCode(error, "invalid"))
    return t("error.checkBoxes", {
      boxes: listed(boxes.map((box) => t(box))),
    });
  if (typeof error === "object" && error !== null && "message" in error) {
    const { message, note, retryAfterMs } = error as PublicError;
    if (typeof message === "string") {
      const parts = [message];
      if (typeof note === "string") parts.push(note);
      if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
        const seconds = Math.ceil(retryAfterMs / 1000);
        parts.push(t("error.retryIn", { count: seconds }));
      }
      return parts.join(" ");
    }
  }
  return t("error.fallback");
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
  // As the computer writes dates, whatever language myCarlos uses (Ben,
  // 21 Oct): a Canadian computer writes 2026-01-15, never 1/15/2026.
  const date = new Date(record.importedAtMs).toLocaleDateString();
  const where = profile
    ? t("error.damaged.whereFor", { date, person: profile.displayName })
    : t("error.damaged.where", { date });
  // What may be left where it was being saved still holds.
  const { note } = error as PublicError;
  return {
    code: "damaged_document",
    message: t("error.damaged", { name: record.displayName, where }),
    ...(typeof note === "string" && { note }),
  };
}

/** The note a failure carries about how it came about, if any. */
export function vaultErrorNote(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const { note } = error as PublicError;
  return typeof note === "string" ? note : null;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as PublicError).code === code
  );
}

/** One page of a stored document, drawn by myCarlos's PDF helper: a `data:`
 * URL of its picture, and its text for screen readers and copying. */
export interface ViewedPage {
  pageCount: number;
  width: number;
  height: number;
  image: string;
  text: string;
}

/** True when the native side refused with `code`. */
export function hasVaultErrorCode(error: unknown, code: string): boolean {
  return hasErrorCode(error, code);
}

/** True when the native side reports that the vault is locked, for example by
 * its own idle deadline while this screen was not running. */
export const isLockedError = (error: unknown) => hasErrorCode(error, "locked");

/** True when a password did not open a locked PDF (#54): the patient may try
 * again. */
export const isWrongPdfPassword = (error: unknown) =>
  hasErrorCode(error, "pdf_wrong_password");

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
    passphraseRules: (passphrase, initialProfileName) =>
      invoke<PassphraseRules>("vault_passphrase_rules", {
        request: { passphrase, initialProfileName },
      }),
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
    benchmarkKdf: () => invoke<SpeedTestReport>("kdf_benchmark"),
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
    savePhoto: (profileId, folderIds, name, jpeg) => {
      // One body, as Tauri carries bytes on every platform: the target's
      // length (4 bytes, big-endian), the target as JSON, then the JPEG.
      // Custom headers do not reach the vault on Windows.
      const target = new TextEncoder().encode(
        JSON.stringify({ profileId, folderIds, name }),
      );
      const request = new Uint8Array(4 + target.length + jpeg.length);
      new DataView(request.buffer).setUint32(0, target.length);
      request.set(target, 4);
      request.set(jpeg, 4 + target.length);
      return invoke<ImportOutcome>("vault_save_photo", request).finally(() =>
        request.fill(0),
      );
    },
    isPhoto: (recordId) =>
      invoke<boolean>("vault_is_photo", { request: { recordId } }),
    viewPhoto: (recordId) =>
      invoke<string>("vault_view_photo", { request: { recordId } }),
    isLockedPdf: (recordId) =>
      invoke<boolean>("vault_is_locked_pdf", { request: { recordId } }),
    unlockPdf: (recordId, password) =>
      invoke<UnlockedPdf>("vault_unlock_pdf", {
        request: { recordId, password },
      }),
    listReceived: () => invoke<ReceivedState>("received_list"),
    acceptReceived: () => invoke<ReceivedAcceptOutcome>("received_accept"),
    moveToPerson: (recordIds, profileId, folderIds) =>
      invoke<MoveOutcome>("vault_move_to_person", {
        request: { recordIds, profileId, folderIds },
      }),
    viewPage: (recordId, page, width, password) =>
      invoke<ViewedPage>("vault_view_page", {
        request: { recordId, page, width, password: password ?? null },
      }),
    cancelView: () => invoke<void>("vault_view_cancel"),
    hideRecord: (recordId) =>
      invoke<void>("vault_hide_record", { request: { recordId } }),
    unhideRecord: (recordId) =>
      invoke<void>("vault_unhide_record", { request: { recordId } }),
    hideUnavailableRecords: (confirmed) =>
      invoke<string[]>("vault_hide_unavailable_records", {
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

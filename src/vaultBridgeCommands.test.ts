import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
const convertFileSrc = vi.hoisted(() =>
  vi.fn((token: string, scheme: string) => `${scheme}://localhost/${token}`),
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc,
  Channel: class {
    onmessage: (value: unknown) => void = () => undefined;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import buildScript from "../src-tauri/build.rs?raw";
import { getLocale } from "./i18n";
import {
  NATIVE_READER_ACTIVITY_EVENT,
  bytesToBase64,
  createVaultBridge,
  utf8Length,
  type VaultBridge,
} from "./vault";

// The wire contract between this screen and the native vault: for each bridge method, the command
// it invokes and the arguments it sends. A renamed command or a changed argument shape is a runtime
// error that TypeScript cannot see, so each one is pinned here, and every command the renderer
// invokes anywhere is checked against the commands the native side registers (build.rs).
// FAKE values only.

const locale = () => getLocale();
/** The bridge with every optional method taken as present, as the native one has them. */
const full = () => createVaultBridge() as Required<VaultBridge>;

describe("each bridge method invokes its native command with its arguments", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
  });
  afterEach(() => vi.useRealTimers());

  // [what is called, how, the command, the arguments after it (none when absent)].
  const table: [
    string,
    (b: Required<VaultBridge>) => unknown,
    string,
    unknown?,
  ][] = [
    ["status", (b) => b.status(), "vault_status"],
    [
      "passphraseRules",
      (b) => b.passphraseRules("FAKE phrase", "Sam"),
      "vault_passphrase_rules",
      { request: { passphrase: "FAKE phrase", initialProfileName: "Sam" } },
    ],
    [
      "create",
      (b) => b.create("FAKE phrase", "Sam"),
      "vault_create",
      { request: { passphrase: "FAKE phrase", initialProfileName: "Sam" } },
    ],
    [
      "unlock",
      (b) => b.unlock("FAKE phrase"),
      "vault_unlock",
      { request: { passphrase: "FAKE phrase" } },
    ],
    [
      "unlockNamed",
      (b) => b.unlockNamed("FAKE vault", "FAKE phrase"),
      "vault_unlock_named",
      { request: { name: "FAKE vault", passphrase: "FAKE phrase" } },
    ],
    [
      "addVault",
      (b) => b.addVault("FAKE vault", "FAKE phrase", "FAKE Person"),
      "vault_add_vault",
      {
        locale: locale(),
        request: {
          name: "FAKE vault",
          passphrase: "FAKE phrase",
          initialProfileName: "FAKE Person",
        },
      },
    ],
    [
      "findOtherVaults",
      (b) => b.findOtherVaults("FAKE phrase"),
      "vault_find_other_vaults",
      { request: { passphrase: "FAKE phrase" } },
    ],
    [
      "nameFoundVaults",
      (b) => b.nameFoundVaults([{ id: "slot-1", name: "FAKE vault" }]),
      "vault_name_found_vaults",
      { request: { vaults: [{ id: "slot-1", name: "FAKE vault" }] } },
    ],
    ["lock", (b) => b.lock(), "vault_lock"],
    ["touch", (b) => b.touch(), "vault_touch"],
    [
      "setAutoLock",
      (b) => b.setAutoLock(7),
      "vault_set_auto_lock",
      { request: { minutes: 7 } },
    ],
    ["snapshot", (b) => b.snapshot(), "vault_snapshot"],
    ["history", (b) => b.history(), "vault_history"],
    ["checkDocuments", (b) => b.checkDocuments(), "vault_check_documents"],
    [
      "restartDeviceApproval",
      (b) => b.restartDeviceApproval("link-1"),
      "vault_restart_device_approval",
      { linkId: "link-1" },
    ],
    [
      "forgetRefusedDeliveries",
      (b) => b.forgetRefusedDeliveries("link-1"),
      "vault_forget_refused_deliveries",
      { linkId: "link-1" },
    ],
    [
      "removePortalLink",
      (b) => b.removePortalLink("link-1"),
      "vault_portal_remove_link",
      { linkId: "link-1" },
    ],
    [
      "requestDeviceApproval",
      (b) => b.requestDeviceApproval("link-1"),
      "vault_request_device_approval",
      { linkId: "link-1" },
    ],
    [
      "submitApprovalCode",
      (b) => b.submitApprovalCode("link-1", "123456789"),
      "vault_submit_approval_code",
      { linkId: "link-1", code: "123456789" },
    ],
    [
      "refreshDeviceApproval",
      (b) => b.refreshDeviceApproval("link-1"),
      "vault_refresh_device_approval",
      { linkId: "link-1" },
    ],
    [
      "linkPortal",
      (b) =>
        b.linkPortal({
          address: "https://clinic.example",
          code: "FAKE",
          deviceName: "FAKE phone",
        } as never),
      "vault_portal_link",
      {
        request: {
          address: "https://clinic.example",
          code: "FAKE",
          deviceName: "FAKE phone",
        },
      },
    ],
    [
      "connectPortal",
      (b) => b.connectPortal({ linkId: "link-1" } as never),
      "vault_portal_connect",
      { request: { linkId: "link-1" } },
    ],
    [
      "changePassphrase",
      (b) => b.changePassphrase("FAKE old", "FAKE new"),
      "vault_change_passphrase",
      { request: { currentPassphrase: "FAKE old", newPassphrase: "FAKE new" } },
    ],
    [
      "beginRecoveryKey",
      (b) => b.beginRecoveryKey("FAKE phrase"),
      "vault_recovery_key_begin",
      { request: { passphrase: "FAKE phrase" } },
    ],
    [
      "confirmRecoveryKey",
      (b) => b.confirmRecoveryKey(["ABCD", "EFGH"] as never),
      "vault_recovery_key_confirm",
      { locale: locale(), request: { groups: ["ABCD", "EFGH"] } },
    ],
    [
      "saveRecoveryKit",
      (b) => b.saveRecoveryKit(),
      "vault_recovery_kit_save",
      { locale: locale() },
    ],
    ["benchmarkKdf", (b) => b.benchmarkKdf(), "kdf_benchmark"],
    [
      "recoveryKeyLabel",
      (b) => b.recoveryKeyLabel(),
      "vault_recovery_key_label",
    ],
    [
      "cancelRecoveryKey",
      (b) => b.cancelRecoveryKey(),
      "vault_recovery_key_cancel",
    ],
    [
      "recover",
      (b) => b.recover("FAKE-KEY", "FAKE new"),
      "vault_recover",
      { request: { recoveryKey: "FAKE-KEY", newPassphrase: "FAKE new" } },
    ],
    [
      "pickBackupDestination",
      (b) => b.pickBackupDestination("2026-01-15"),
      "vault_backup_pick",
      { request: { localDate: "2026-01-15" } },
    ],
    [
      "saveBackupToPicked (videos kept by default)",
      (b) => b.saveBackupToPicked("pick-1"),
      "vault_backup_picked",
      { request: { pickId: "pick-1", leaveVideosOut: false } },
    ],
    [
      "saveBackupToPicked (videos left out)",
      (b) => b.saveBackupToPicked("pick-1", true),
      "vault_backup_picked",
      { request: { pickId: "pick-1", leaveVideosOut: true } },
    ],
    ["backupSize", (b) => b.backupSize(), "vault_backup_size"],
    ["leftOutRecords", (b) => b.leftOutRecords(), "vault_left_out_records"],
    [
      "pickRestoreSource",
      (b) => b.pickRestoreSource(),
      "vault_restore_pick",
      { locale: locale() },
    ],
    [
      "inspectRestore",
      (b) => b.inspectRestore("pick-1", { passphrase: "FAKE phrase" } as never),
      "vault_restore_inspect",
      { request: { pickId: "pick-1", passphrase: "FAKE phrase" } },
    ],
    [
      "restore",
      (b) => b.restore("pick-1", { recoveryKey: "FAKE-KEY" } as never, true),
      "vault_restore",
      {
        locale: locale(),
        request: { pickId: "pick-1", recoveryKey: "FAKE-KEY", replace: true },
      },
    ],
    [
      "createProfile (today is the patient's own date)",
      (b) => b.createProfile("Sam"),
      "vault_create_profile",
      { request: { displayName: "Sam", details: {}, today: "2026-01-15" } },
    ],
    [
      "createProfile with details",
      (b) => b.createProfile("Sam", { birthDate: "2000-02-03" } as never),
      "vault_create_profile",
      {
        request: {
          displayName: "Sam",
          details: { birthDate: "2000-02-03" },
          today: "2026-01-15",
        },
      },
    ],
    [
      "renameProfile",
      (b) => b.renameProfile("p-1", "Sam E."),
      "vault_rename_profile",
      { request: { profileId: "p-1", displayName: "Sam E." } },
    ],
    [
      "updateProfileDetails",
      (b) =>
        b.updateProfileDetails("p-1", { birthDate: "2000-02-03" } as never),
      "vault_update_profile_details",
      {
        request: {
          profileId: "p-1",
          details: { birthDate: "2000-02-03" },
          today: "2026-01-15",
        },
      },
    ],
    [
      "sharedIdentity",
      (b) => b.sharedIdentity("rec-1"),
      "vault_shared_identity",
      { recordId: "rec-1" },
    ],
    [
      "createFolder",
      (b) => b.createFolder("p-1", null, "Labs"),
      "vault_create_folder",
      { request: { profileId: "p-1", parentId: null, name: "Labs" } },
    ],
    [
      "updateFolder",
      (b) => b.updateFolder("f-1", "f-0", "Labs 2026"),
      "vault_update_folder",
      { request: { folderId: "f-1", parentId: "f-0", name: "Labs 2026" } },
    ],
    [
      "renameRecord",
      (b) => b.renameRecord("rec-1", "FAKE letter.pdf"),
      "vault_rename_record",
      { request: { recordId: "rec-1", name: "FAKE letter.pdf" } },
    ],
    [
      "assignFolders",
      (b) => b.assignFolders("rec-1", ["f-1", "f-2"]),
      "vault_assign_folders",
      { request: { recordId: "rec-1", folderIds: ["f-1", "f-2"] } },
    ],
    [
      "assignFoldersBatch",
      (b) => b.assignFoldersBatch(["rec-1", "rec-2"], ["f-1"]),
      "vault_assign_folders_batch",
      { request: { recordIds: ["rec-1", "rec-2"], folderIds: ["f-1"] } },
    ],
    [
      "pickImportFiles",
      (b) => b.pickImportFiles("p-1", ["f-1"]),
      "vault_import_pick",
      { locale: locale(), request: { profileId: "p-1", folderIds: ["f-1"] } },
    ],
    [
      "importPickedFiles",
      (b) => b.importPickedFiles("pick-1", "p-1", ["f-1"]),
      "vault_import_picked",
      { request: { pickId: "pick-1", profileId: "p-1", folderIds: ["f-1"] } },
    ],
    [
      "pickImportAny",
      (b) => b.pickImportAny("p-1", ["f-1"]),
      "vault_import_any_pick",
      { locale: locale(), request: { profileId: "p-1", folderIds: ["f-1"] } },
    ],
    [
      "pickImportVideo",
      (b) => b.pickImportVideo("p-1", ["f-1"]),
      "vault_import_video_pick",
      { locale: locale(), request: { profileId: "p-1", folderIds: ["f-1"] } },
    ],
    [
      "importPickedVideo",
      (b) => b.importPickedVideo("pick-1", "p-1", ["f-1"]),
      "vault_import_video_picked",
      { request: { pickId: "pick-1", profileId: "p-1", folderIds: ["f-1"] } },
    ],
    [
      "videoImportProgress",
      (b) => b.videoImportProgress(),
      "vault_video_import_progress",
    ],
    [
      "videoImportCancel",
      (b) => b.videoImportCancel(),
      "vault_video_import_cancel",
    ],
    [
      "pickExportDestination",
      (b) => b.pickExportDestination("rec-1"),
      "vault_export_pick",
      // The patient's own date, for the neutral name the save dialog suggests (the clock is
      // faked to 15 Jan 2026 above).
      { request: { recordId: "rec-1", localDate: "2026-01-15" } },
    ],
    [
      "exportToPicked",
      (b) => b.exportToPicked("pick-1", "rec-1"),
      "vault_export_picked",
      { request: { pickId: "pick-1", recordId: "rec-1" } },
    ],
    [
      "videoStart",
      (b) => b.videoStart("p-1", ["f-1"], "Video"),
      "vault_video_start",
      { request: { profileId: "p-1", folderIds: ["f-1"], name: "Video" } },
    ],
    [
      "videoPause",
      (b) => b.videoPause("rec-1"),
      "vault_video_pause",
      { request: { recordingId: "rec-1" } },
    ],
    [
      "videoResume",
      (b) => b.videoResume("rec-1"),
      "vault_video_resume",
      { request: { recordingId: "rec-1" } },
    ],
    [
      "videoStop",
      (b) => b.videoStop("rec-1"),
      "vault_video_stop",
      { request: { recordingId: "rec-1" } },
    ],
    ["videoSpace", (b) => b.videoSpace(), "vault_video_space"],
    ["videoPending", (b) => b.videoPending(), "vault_video_pending"],
    [
      "videoRecover",
      (b) => b.videoRecover("rec-1", true),
      "vault_video_recover",
      { request: { recordingId: "rec-1", keep: true } },
    ],
    [
      "isVideo",
      (b) => b.isVideo("rec-1"),
      "vault_is_video",
      { request: { recordId: "rec-1" } },
    ],
    [
      "videoClose",
      (b) => b.videoClose("token-1"),
      "vault_video_close",
      { request: { token: "token-1" } },
    ],
    [
      "isPhoto",
      (b) => b.isPhoto("rec-1"),
      "vault_is_photo",
      { request: { recordId: "rec-1" } },
    ],
    [
      "viewPhoto",
      (b) => b.viewPhoto("rec-1"),
      "vault_view_photo",
      { request: { recordId: "rec-1" } },
    ],
    [
      "isLockedPdf",
      (b) => b.isLockedPdf("rec-1"),
      "vault_is_locked_pdf",
      { request: { recordId: "rec-1" } },
    ],
    [
      "unlockPdf",
      (b) => b.unlockPdf("rec-1", "FAKE password"),
      "vault_unlock_pdf",
      { request: { recordId: "rec-1", password: "FAKE password" } },
    ],
    ["listReceived", (b) => b.listReceived(), "received_list"],
    [
      "acceptReceived (the ones named)",
      (b) => b.acceptReceived(["r-1", "r-2"]),
      "received_accept",
      { request: { ids: ["r-1", "r-2"] } },
    ],
    [
      "acceptReceived (all of them)",
      (b) => b.acceptReceived(),
      "received_accept",
    ],
    [
      "discardReceived",
      (b) => b.discardReceived(["r-1"]),
      "received_discard",
      { request: { ids: ["r-1"] } },
    ],
    [
      "moveToPerson",
      (b) => b.moveToPerson(["rec-1"], "p-2", ["f-9"]),
      "vault_move_to_person",
      {
        request: { recordIds: ["rec-1"], profileId: "p-2", folderIds: ["f-9"] },
      },
    ],
    [
      "pageBoxes (the span is spread, the password is null when absent)",
      (b) => b.pageBoxes("rec-1", 2, { start: 3, end: 9 } as never),
      "vault_page_boxes",
      {
        request: {
          recordId: "rec-1",
          page: 2,
          start: 3,
          end: 9,
          password: null,
        },
      },
    ],
    [
      "pageBoxes (with a password)",
      (b) => b.pageBoxes("rec-1", 2, { start: 3, end: 9 } as never, "FAKE pw"),
      "vault_page_boxes",
      {
        request: {
          recordId: "rec-1",
          page: 2,
          start: 3,
          end: 9,
          password: "FAKE pw",
        },
      },
    ],
    ["aiModelStatus", (b) => b.aiModelStatus(), "ai_model_status"],
    ["aiCancel", (b) => b.aiCancel(), "ai_cancel"],
    ["aiModelSpeed", (b) => b.aiModelSpeed(), "ai_model_speed"],
    [
      "aiExplain (without a record)",
      (b) => b.aiExplain("FAKE term", "FAKE context", "en", undefined, "ans-1"),
      "ai_explain",
      {
        answerId: "ans-1",
        request: { term: "FAKE term", context: "FAKE context", lang: "en" },
      },
    ],
    [
      "aiExplain (with a record)",
      (b) => b.aiExplain("FAKE term", "FAKE context", "en", "rec-1", "ans-1"),
      "ai_explain",
      {
        answerId: "ans-1",
        request: {
          term: "FAKE term",
          context: "FAKE context",
          lang: "en",
          recordId: "rec-1",
        },
      },
    ],
    ["trayWaiting", (b) => b.trayWaiting(), "tray_waiting_status"],
    [
      "documentText",
      (b) => b.documentText("rec-1", "read-1"),
      "vault_document_text",
      { request: { recordId: "rec-1", readId: "read-1", password: null } },
    ],
    [
      "documentText (with a password)",
      (b) => b.documentText("rec-1", "read-1", "FAKE pw"),
      "vault_document_text",
      { request: { recordId: "rec-1", readId: "read-1", password: "FAKE pw" } },
    ],
    [
      "cancelDocumentText",
      (b) => b.cancelDocumentText("read-1"),
      "vault_document_text_cancel",
      { request: { readId: "read-1" } },
    ],
    [
      "recordKnownDetails",
      (b) => b.recordKnownDetails("rec-1"),
      "vault_record_known_details",
      { request: { recordId: "rec-1" } },
    ],
    [
      "pickTextExportDestination",
      (b) => b.pickTextExportDestination("rec-1", "t-4"),
      "vault_export_text_pick",
      { request: { recordId: "rec-1", ticket: "t-4" }, locale: locale() },
    ],
    [
      "exportTextToPicked (no kept ranges)",
      (b) => b.exportTextToPicked("pick-1", "rec-1", "t-4", "FAKE text"),
      "vault_export_text_picked",
      {
        request: {
          pickId: "pick-1",
          recordId: "rec-1",
          ticket: "t-4",
          text: "FAKE text",
          kept: [],
        },
        locale: locale(),
      },
    ],
    [
      "exportTextToPicked (kept ranges)",
      (b) =>
        b.exportTextToPicked("pick-1", "rec-1", "t-4", "FAKE text", [
          { start: 1, end: 3 },
        ] as never),
      "vault_export_text_picked",
      {
        request: {
          pickId: "pick-1",
          recordId: "rec-1",
          ticket: "t-4",
          text: "FAKE text",
          kept: [{ start: 1, end: 3 }],
        },
        locale: locale(),
      },
    ],
    [
      "copyTextExport (no kept ranges)",
      (b) => b.copyTextExport("rec-1", "t-4", "FAKE text"),
      "vault_export_text_copy",
      {
        request: {
          recordId: "rec-1",
          ticket: "t-4",
          text: "FAKE text",
          kept: [],
        },
        locale: locale(),
      },
    ],
    [
      "saveAiResult (no sources)",
      (b) => b.saveAiResult("rec-1", "kept-1"),
      "vault_ai_result_save",
      { request: { recordId: "rec-1", keptId: "kept-1" } },
    ],
    [
      "saveAiResult (with sources)",
      (b) => b.saveAiResult("rec-1", "kept-1", [{ page: 1 }] as never),
      "vault_ai_result_save",
      {
        request: {
          recordId: "rec-1",
          keptId: "kept-1",
          sources: [{ page: 1 }],
        },
      },
    ],
    [
      "aiResults",
      (b) => b.aiResults("rec-1"),
      "vault_ai_results",
      { request: { recordId: "rec-1" } },
    ],
    [
      "readAiResult",
      (b) => b.readAiResult("rec-1", "res-1"),
      "vault_ai_result_read",
      { request: { recordId: "rec-1", resultId: "res-1" } },
    ],
    [
      "hideRecord",
      (b) => b.hideRecord("rec-1"),
      "vault_hide_record",
      { request: { recordId: "rec-1" } },
    ],
    [
      "unhideRecord",
      (b) => b.unhideRecord("rec-1"),
      "vault_unhide_record",
      { request: { recordId: "rec-1" } },
    ],
    [
      "hideUnavailableRecords",
      (b) => b.hideUnavailableRecords(["rec-1"]),
      "vault_hide_unavailable_records",
      { request: { confirmed: ["rec-1"], hiddenPeopleDocuments: 0 } },
    ],
    [
      "prepareProfileExport",
      (b) =>
        b.prepareProfileExport({
          profileId: "p-1",
          includeHistory: true,
          passphrase: "FAKE-passphrase",
        }),
      "vault_profile_export_prepare",
      {
        request: {
          profileId: "p-1",
          includeHistory: true,
          passphrase: "FAKE-passphrase",
        },
      },
    ],
    [
      "pickProfileExportDestination",
      (b) => b.pickProfileExportDestination("exp-1", "2026-11-24"),
      "vault_profile_export_pick",
      { request: { exportId: "exp-1", localDate: "2026-11-24" } },
    ],
    [
      "saveProfileExportToPicked",
      (b) => b.saveProfileExportToPicked("pick-1"),
      "vault_profile_export_picked",
      { request: { pickId: "pick-1" } },
    ],
    [
      "pickProfileImportSource",
      (b) => b.pickProfileImportSource(),
      "vault_profile_import_pick",
      undefined,
    ],
    [
      "profileImportKeyKind",
      (b) => b.profileImportKeyKind("pick-1"),
      "vault_profile_import_key_kind",
      { request: { pickId: "pick-1" } },
    ],
    [
      "inspectProfileImport",
      (b) => b.inspectProfileImport({ pickId: "pick-1", key: "FAKE-key" }),
      "vault_profile_import_inspect",
      { request: { pickId: "pick-1", key: "FAKE-key" } },
    ],
    [
      "importProfile",
      (b) =>
        b.importProfile({
          pickId: "pick-1",
          passphrase: "FAKE-passphrase",
          displayName: "FAKE Person",
          allowDuplicate: true,
        }),
      "vault_profile_import",
      {
        request: {
          pickId: "pick-1",
          passphrase: "FAKE-passphrase",
          displayName: "FAKE Person",
          allowDuplicate: true,
        },
      },
    ],
    [
      "hideProfile",
      (b) => b.hideProfile("p-1"),
      "vault_hide_profile",
      { request: { profileId: "p-1" } },
    ],
    [
      "restoreProfile",
      (b) => b.restoreProfile("p-1"),
      "vault_restore_profile",
      { request: { profileId: "p-1" } },
    ],
    [
      "reset",
      (b) => b.reset("erase everything"),
      "vault_reset",
      { locale: locale(), request: { confirmation: "erase everything" } },
    ],
  ];

  it.each(table)("%s", async (_label, run, command, payload) => {
    await run(full());
    const last = invoke.mock.calls.at(-1);
    expect(last).toEqual(
      payload === undefined ? [command] : [command, payload],
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  // Methods with a test of their own below (or in vaultProgressListen.test.ts), because they do more
  // than send one command: a new bridge method that is in neither place fails the next test.
  const testedBelow = new Set([
    "platform",
    "videoAppend",
    "videoOpen",
    "savePhoto",
    "viewPage",
    "cancelView",
    "readAndroidPdf",
    "aiSummarize",
    "onAiAnswerStarted",
    "onVaultLocked",
    "onTrayWaiting",
  ]);

  it("has a row for every bridge method, or names the test that covers it", () => {
    const rowed = new Set(table.map(([label]) => label.split(" ")[0]));
    const methods = Object.entries(createVaultBridge())
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    expect(methods.length).toBeGreaterThan(85);
    const bare = methods.filter(
      (name) => !rowed.has(name) && !testedBelow.has(name),
    );
    expect(bare).toEqual([]);
    // And no row or exception names a method the bridge no longer has.
    const have = new Set(methods);
    expect([...rowed].filter((name) => !have.has(name))).toEqual([]);
    expect([...testedBelow].filter((name) => !have.has(name))).toEqual([]);
  });

  it("reports the platform the native side names", async () => {
    invoke.mockResolvedValue({ platform: "android" });
    await expect(full().platform()).resolves.toBe("android");
    expect(invoke).toHaveBeenLastCalledWith("runtime_info");
  });

  it("opens a video and gives the address the webview shows for it", async () => {
    invoke.mockResolvedValue({ token: "tok-1", totalBytes: 1234 });
    await expect(full().videoOpen("rec-1")).resolves.toEqual({
      token: "tok-1",
      totalBytes: 1234,
      url: "mycarlos-video://localhost/tok-1",
    });
    expect(invoke).toHaveBeenLastCalledWith("vault_video_open", {
      request: { recordId: "rec-1" },
    });
    expect(convertFileSrc).toHaveBeenLastCalledWith("tok-1", "mycarlos-video");
  });

  it("sends a piece of video as base64 text, not as bytes", async () => {
    await full().videoAppend("rec-1", 7, new Uint8Array([1, 2, 3]));
    expect(invoke).toHaveBeenLastCalledWith("vault_video_append", {
      request: { recordingId: "rec-1", sequence: 7, data: "AQID" },
    });
  });

  it("sends a photo as one body: the target's length, the target, then the JPEG, and clears it after", async () => {
    let sent: Uint8Array | undefined;
    let copy: number[] = [];
    invoke.mockImplementation(async (_command: string, body: Uint8Array) => {
      sent = body;
      copy = [...body];
      return { imported: 1 };
    });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    await full().savePhoto("p-1", ["f-1"], "Photo", jpeg);
    expect(invoke.mock.calls[0][0]).toBe("vault_save_photo");
    const view = new DataView(new Uint8Array(copy).buffer);
    const length = view.getUint32(0);
    const target = JSON.parse(
      new TextDecoder().decode(new Uint8Array(copy).subarray(4, 4 + length)),
    );
    expect(target).toEqual({
      profileId: "p-1",
      folderIds: ["f-1"],
      name: "Photo",
    });
    expect(copy.slice(4 + length)).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    // The body that crossed is wiped once the call is over.
    expect([...(sent as Uint8Array)].every((byte) => byte === 0)).toBe(true);
  });

  it("clears the photo body even when the native call fails", async () => {
    let sent: Uint8Array | undefined;
    invoke.mockImplementation(async (_command: string, body: Uint8Array) => {
      sent = body;
      throw { code: "storage" };
    });
    await expect(
      full().savePhoto("p-1", [], "Photo", new Uint8Array([9, 9])),
    ).rejects.toEqual({ code: "storage" });
    expect([...(sent as Uint8Array)].every((byte) => byte === 0)).toBe(true);
  });

  it("is a native bridge only inside the Tauri runtime", () => {
    expect(full().native).toBe(false);
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    try {
      expect(full().native).toBe(true);
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });
});

describe("page views and their cancellation", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it("asks for a page with the width and a null password when there is none", async () => {
    await full().viewPage("rec-1", 3, 640);
    expect(invoke).toHaveBeenLastCalledWith("vault_view_page", {
      request: { recordId: "rec-1", page: 3, width: 640, password: null },
    });
    await full().viewPage("rec-1", 3, 640, "FAKE pw");
    expect(invoke).toHaveBeenLastCalledWith("vault_view_page", {
      request: { recordId: "rec-1", page: 3, width: 640, password: "FAKE pw" },
    });
  });

  it("a cancel is asked once while it is pending, and a page asked for before it is refused", async () => {
    let finish: () => void = () => undefined;
    invoke.mockImplementation((command: string) =>
      command === "vault_view_cancel"
        ? new Promise<void>((resolve) => (finish = resolve))
        : Promise.resolve(undefined),
    );
    const bridge = full();
    const first = bridge.cancelView();
    const second = bridge.cancelView();
    expect(second).toBe(first);
    expect(
      invoke.mock.calls.filter(([c]) => c === "vault_view_cancel"),
    ).toHaveLength(1);
    // A page asked for while the cancel is pending waits for it...
    const page = bridge.viewPage("rec-1", 1, 100);
    // ...and is superseded by a cancel that came after it.
    bridge.cancelView();
    finish();
    await expect(page).rejects.toEqual({ code: "cancelled" });
    expect(invoke.mock.calls.some(([c]) => c === "vault_view_page")).toBe(
      false,
    );
  });

  it("a failed cancel is reported to its caller and does not strand the next page", async () => {
    let call = 0;
    invoke.mockImplementation((command: string) => {
      if (command === "vault_view_cancel" && call++ === 0)
        return Promise.reject({ code: "storage" });
      return Promise.resolve(undefined);
    });
    const bridge = full();
    await expect(bridge.cancelView()).rejects.toEqual({ code: "storage" });
    await expect(bridge.viewPage("rec-1", 1, 100)).resolves.toBeUndefined();
    // Once settled, the next cancel asks again.
    await bridge.cancelView();
    expect(
      invoke.mock.calls.filter(([c]) => c === "vault_view_cancel"),
    ).toHaveLength(2);
  });

  it("locking supersedes a page that was waiting for a cancel", async () => {
    let finish: () => void = () => undefined;
    invoke.mockImplementation((command: string) =>
      command === "vault_view_cancel"
        ? new Promise<void>((resolve) => (finish = resolve))
        : Promise.resolve(undefined),
    );
    const bridge = full();
    void bridge.cancelView();
    const page = bridge.viewPage("rec-1", 1, 100);
    await bridge.lock();
    finish();
    await expect(page).rejects.toEqual({ code: "cancelled" });
  });

  it("reads an Android PDF with an activity channel that wakes the reader's idle clock", async () => {
    const woke = vi.fn();
    window.addEventListener(NATIVE_READER_ACTIVITY_EVENT, woke);
    let channel: { onmessage: (value: unknown) => void } | undefined;
    invoke.mockImplementation(
      async (_command: string, args: { activity: typeof channel }) => {
        channel = args.activity;
        channel?.onmessage(undefined);
      },
    );
    try {
      await full().readAndroidPdf("rec-1", {
        title: "FAKE",
      } as never);
    } finally {
      window.removeEventListener(NATIVE_READER_ACTIVITY_EVENT, woke);
    }
    expect(invoke.mock.calls[0][0]).toBe("vault_read_android_pdf");
    expect(invoke.mock.calls[0][1].request).toEqual({
      recordId: "rec-1",
      labels: { title: "FAKE" },
    });
    expect(woke).toHaveBeenCalledOnce();
    // After the call the channel no longer reaches the page.
    channel?.onmessage(undefined);
    expect(woke).toHaveBeenCalledOnce();
  });

  it("an Android read superseded while a cancel is pending never reaches the native side", async () => {
    let finish: () => void = () => undefined;
    invoke.mockImplementation((command: string) =>
      command === "vault_view_cancel"
        ? new Promise<void>((resolve) => (finish = resolve))
        : Promise.resolve(undefined),
    );
    const bridge = full();
    void bridge.cancelView();
    const read = bridge.readAndroidPdf("rec-1", {} as never);
    void bridge.cancelView();
    finish();
    await expect(read).rejects.toEqual({ code: "cancelled" });
    expect(
      invoke.mock.calls.some(([c]) => c === "vault_read_android_pdf"),
    ).toBe(false);
  });
});

describe("native events the screen listens for", () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
  });

  it.each([
    ["onAiAnswerStarted", "ai-answer-started", { answerId: "a-1", limitMs: 5 }],
    ["onVaultLocked", "vault-locked", { by: "idle" }],
  ] as const)(
    "%s passes on the event's payload and stops listening on request",
    async (method, name, payload) => {
      const unlisten = vi.fn();
      let handler: (event: { payload: unknown }) => void = () => undefined;
      listen.mockImplementation(
        async (_name: string, callback: typeof handler) => {
          handler = callback;
          return unlisten;
        },
      );
      const seen = vi.fn();
      const stop = (full()[method] as (h: (p: unknown) => void) => () => void)(
        seen,
      );
      expect(listen.mock.calls[0][0]).toBe(name);
      await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
      handler({ payload });
      expect(seen).toHaveBeenCalledWith(payload);
      stop();
      await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
    },
  );

  it("onTrayWaiting passes on only a literal true", async () => {
    let handler: (event: { payload: unknown }) => void = () => undefined;
    listen.mockImplementation(
      async (_name: string, callback: typeof handler) => {
        handler = callback;
        return () => undefined;
      },
    );
    const seen = vi.fn();
    full().onTrayWaiting(seen);
    expect(listen.mock.calls[0][0]).toBe("tray-waiting");
    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    handler({ payload: true });
    handler({ payload: "yes" });
    handler({ payload: false });
    expect(seen.mock.calls).toEqual([[true], [false], [false]]);
  });
});

describe("small helpers", () => {
  it("bytesToBase64 builds large pieces in slices and matches the plain encoding", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 5).map((_, index) => index % 251);
    let plain = "";
    for (const byte of bytes) plain += String.fromCharCode(byte);
    expect(bytesToBase64(bytes)).toBe(btoa(plain));
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
  });

  it("utf8Length counts bytes, not UTF-16 units", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("日本")).toBe(6);
    expect(utf8Length("😀")).toBe(4);
  });
});

describe("the commands the renderer invokes are the ones the native side registers", () => {
  // The renderer's source, tests excluded.
  const sources = import.meta.glob(
    ["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./test/**"],
    {
      query: "?raw",
      import: "default",
      eager: true,
    },
  ) as Record<string, string>;
  // `invoke("name"` and `invoke<T>("name"`: the command is written out.
  const literalSite = /\binvoke(?:<[^>(]*>)?\(\s*"([a-z_0-9]+)"/g;
  // `invoke(command, ...)`: the command is a variable, named at the call to its caller.
  const variableSite = /\binvoke(?:<[^>(]*>)?\(\s*([^"\s])/g;
  const used = new Map<string, Set<string>>();
  const variableSites = new Map<string, number>();
  for (const [file, text] of Object.entries(sources)) {
    for (const found of text.matchAll(literalSite)) {
      if (!used.has(found[1])) used.set(found[1], new Set());
      used.get(found[1])!.add(file);
    }
    for (const _ of text.matchAll(variableSite))
      variableSites.set(file, (variableSites.get(file) ?? 0) + 1);
  }
  // The names in build.rs's command list, and only that list (`AppManifest::new().commands(&[...])`):
  // the other quoted strings in the file are not commands.
  const list =
    /AppManifest::new\(\)\s*\.commands\(\s*&\[([\s\S]*?)\]\s*\)/.exec(
      buildScript,
    );
  const registered = new Set(
    [...(list?.[1] ?? "").matchAll(/"([a-z][a-z_0-9]+)"/g)].map(
      (found) => found[1],
    ),
  );
  // The screens that pass the command as a variable. Their callers write the names as strings next
  // to a request of that kind, and those are checked too; a new file with a variable site fails the
  // exact pin below, so it must be added here and have its names checked.
  const VARIABLE_SITES: Record<string, number> = {
    "./native/AiModelSetting.tsx": 3,
    "./native/BackgroundSetting.tsx": 1,
    "./native/NotificationSetting.tsx": 1,
  };

  it("finds the renderer's commands and build.rs's list (a guard against the scan going quiet)", () => {
    expect(list).not.toBeNull();
    expect(used.size).toBeGreaterThan(90);
    expect(registered.size).toBeGreaterThan(100);
    expect(used.has("vault_unlock")).toBe(true);
    expect(registered.has("vault_unlock")).toBe(true);
    // Strings in build.rs that are not commands are not read as registered.
    expect(registered.has("android")).toBe(false);
  });

  it("registers every command the renderer invokes", () => {
    const missing = [...used.entries()]
      .filter(([name]) => !registered.has(name))
      .map(([name, files]) => `${name} (${[...files].join(", ")})`);
    expect(missing).toEqual([]);
  });

  it("knows every place that invokes a command held in a variable, and registers the names it is given", () => {
    expect(Object.fromEntries(variableSites)).toEqual(VARIABLE_SITES);
    // Their callers write the command as a snake_case string; each one must be registered.
    const names = new Set<string>();
    // Quoted snake_case words in those files that are values and not commands (the notice
    // permission "not_yet_asked" in NotificationSetting.tsx).
    const notCommands = new Set(["not_yet_asked"]);
    for (const file of Object.keys(VARIABLE_SITES)) {
      for (const found of sources[file].matchAll(/"([a-z]+(?:_[a-z0-9]+)+)"/g))
        if (!notCommands.has(found[1])) names.add(found[1]);
    }
    const unknown = [...names].filter((name) => !registered.has(name));
    expect(unknown).toEqual([]);
    expect(names.size).toBeGreaterThan(6);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: (path: string, scheme: string) =>
    `${scheme}://localhost/${path}`,
  Channel: class {
    onmessage: (value: unknown) => void = () => undefined;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { setLocaleOverride } from "./i18n";
import { createVaultBridge } from "./vault";

// The page's side of the contract with the native commands: for each bridge method, the command it
// calls and the exact arguments it sends (the names the Rust side registers, camelCase, the
// language where the native dialog needs it, today's date where the vault dates a change). A
// renamed command, a dropped argument or a wrongly named field fails here, not on a phone. FAKE
// values only.

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  listen.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 7, 12));
  setLocaleOverride("fr");
});

afterEach(() => {
  vi.useRealTimers();
  setLocaleOverride(null);
});

type Bridge = Required<ReturnType<typeof createVaultBridge>>;

/** [what it is, how it is called, the command, the arguments it sends (none when omitted)]. */
const CASES: [string, (bridge: Bridge) => unknown, string, unknown?][] = [
  ["checkDocuments", (b) => b.checkDocuments(), "vault_check_documents"],
  [
    "restartDeviceApproval",
    (b) => b.restartDeviceApproval("FAKE-link"),
    "vault_restart_device_approval",
    { linkId: "FAKE-link" },
  ],
  [
    "forgetRefusedDeliveries",
    (b) => b.forgetRefusedDeliveries("FAKE-link"),
    "vault_forget_refused_deliveries",
    { linkId: "FAKE-link" },
  ],
  [
    "requestDeviceApproval",
    (b) => b.requestDeviceApproval("FAKE-link"),
    "vault_request_device_approval",
    { linkId: "FAKE-link" },
  ],
  [
    "submitApprovalCode",
    (b) => b.submitApprovalCode("FAKE-link", "123456"),
    "vault_submit_approval_code",
    { linkId: "FAKE-link", code: "123456" },
  ],
  [
    "refreshDeviceApproval",
    (b) => b.refreshDeviceApproval("FAKE-link"),
    "vault_refresh_device_approval",
    { linkId: "FAKE-link" },
  ],
  [
    "linkPortal",
    (b) =>
      b.linkPortal({
        portalBase: "https://portal.fake.example",
        code: "FAKE",
      } as never),
    "vault_portal_link",
    { request: { portalBase: "https://portal.fake.example", code: "FAKE" } },
  ],
  [
    "connectPortal",
    (b) =>
      b.connectPortal({ portalBase: "https://portal.fake.example" } as never),
    "vault_portal_connect",
    { request: { portalBase: "https://portal.fake.example" } },
  ],
  [
    "changePassphrase",
    (b) => b.changePassphrase("FAKE old", "FAKE new"),
    "vault_change_passphrase",
    { request: { currentPassphrase: "FAKE old", newPassphrase: "FAKE new" } },
  ],
  [
    "beginRecoveryKey",
    (b) => b.beginRecoveryKey("FAKE pass"),
    "vault_recovery_key_begin",
    { request: { passphrase: "FAKE pass" } },
  ],
  [
    "confirmRecoveryKey",
    (b) =>
      b.confirmRecoveryKey([
        { index: 0, value: "AAAA" },
        { index: 1, value: "BBBB" },
      ]),
    "vault_recovery_key_confirm",
    {
      locale: "fr",
      request: {
        groups: [
          { index: 0, value: "AAAA" },
          { index: 1, value: "BBBB" },
        ],
      },
    },
  ],
  [
    "saveRecoveryKit",
    (b) => b.saveRecoveryKit(),
    "vault_recovery_kit_save",
    { locale: "fr" },
  ],
  ["benchmarkKdf", (b) => b.benchmarkKdf(), "kdf_benchmark"],
  ["recoveryKeyLabel", (b) => b.recoveryKeyLabel(), "vault_recovery_key_label"],
  [
    "cancelRecoveryKey",
    (b) => b.cancelRecoveryKey(),
    "vault_recovery_key_cancel",
  ],
  [
    "recover",
    (b) => b.recover("FAKE-KEY", "FAKE new pass"),
    "vault_recover",
    { request: { recoveryKey: "FAKE-KEY", newPassphrase: "FAKE new pass" } },
  ],
  [
    "pickBackupDestination",
    (b) => b.pickBackupDestination("2026-10-07"),
    "vault_backup_pick",
    { request: { localDate: "2026-10-07" } },
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
    "prepareProfileExport",
    (b) =>
      b.prepareProfileExport({
        profileId: "p1",
        includeHistory: true,
        passphrase: "FAKE",
      }),
    "vault_profile_export_prepare",
    { request: { profileId: "p1", includeHistory: true, passphrase: "FAKE" } },
  ],
  [
    "pickProfileExportDestination",
    (b) => b.pickProfileExportDestination("e1", "2026-10-07"),
    "vault_profile_export_pick",
    { request: { exportId: "e1", localDate: "2026-10-07" } },
  ],
  [
    "saveProfileExportToPicked",
    (b) => b.saveProfileExportToPicked("pick-2"),
    "vault_profile_export_picked",
    { request: { pickId: "pick-2" } },
  ],
  [
    "pickProfileImportSource",
    (b) => b.pickProfileImportSource(),
    "vault_profile_import_pick",
  ],
  [
    "profileImportKeyKind",
    (b) => b.profileImportKeyKind("pick-3"),
    "vault_profile_import_key_kind",
    { request: { pickId: "pick-3" } },
  ],
  [
    "inspectProfileImport",
    (b) => b.inspectProfileImport({ pickId: "pick-3", key: "FAKE-KEY" }),
    "vault_profile_import_inspect",
    { request: { pickId: "pick-3", key: "FAKE-KEY" } },
  ],
  [
    "importProfile",
    (b) =>
      b.importProfile({
        pickId: "pick-3",
        key: "FAKE-KEY",
        displayName: "FAKE",
        allowDuplicate: true,
      }),
    "vault_profile_import",
    {
      request: {
        pickId: "pick-3",
        key: "FAKE-KEY",
        displayName: "FAKE",
        allowDuplicate: true,
      },
    },
  ],
  [
    "pickRestoreSource",
    (b) => b.pickRestoreSource(),
    "vault_restore_pick",
    { locale: "fr" },
  ],
  [
    "inspectRestore",
    (b) => b.inspectRestore("pick-4", { passphrase: "FAKE" }),
    "vault_restore_inspect",
    { request: { pickId: "pick-4", passphrase: "FAKE" } },
  ],
  [
    "restore",
    (b) => b.restore("pick-4", { recoveryKey: "FAKE-KEY" }, true),
    "vault_restore",
    {
      locale: "fr",
      request: { pickId: "pick-4", recoveryKey: "FAKE-KEY", replace: true },
    },
  ],
  [
    "createProfile (dated today)",
    (b) => b.createProfile("FAKE Avery", { fullName: "FAKE Avery Person" }),
    "vault_create_profile",
    {
      request: {
        displayName: "FAKE Avery",
        details: { fullName: "FAKE Avery Person" },
        today: "2026-10-07",
      },
    },
  ],
  [
    "createProfile (no details)",
    (b) => b.createProfile("FAKE Avery"),
    "vault_create_profile",
    {
      request: { displayName: "FAKE Avery", details: {}, today: "2026-10-07" },
    },
  ],
  [
    "renameProfile",
    (b) => b.renameProfile("p1", "FAKE Blake"),
    "vault_rename_profile",
    { request: { profileId: "p1", displayName: "FAKE Blake" } },
  ],
  [
    "updateProfileDetails (dated today)",
    (b) => b.updateProfileDetails("p1", { birthDate: "2001-02-03" }),
    "vault_update_profile_details",
    {
      request: {
        profileId: "p1",
        details: { birthDate: "2001-02-03" },
        today: "2026-10-07",
      },
    },
  ],
  [
    "sharedIdentity",
    (b) => b.sharedIdentity("r1"),
    "vault_shared_identity",
    { recordId: "r1" },
  ],
  [
    "createFolder",
    (b) => b.createFolder("p1", null, "FAKE Folder"),
    "vault_create_folder",
    { request: { profileId: "p1", parentId: null, name: "FAKE Folder" } },
  ],
  [
    "updateFolder",
    (b) => b.updateFolder("f1", "f0", "FAKE Renamed"),
    "vault_update_folder",
    { request: { folderId: "f1", parentId: "f0", name: "FAKE Renamed" } },
  ],
  [
    "renameRecord",
    (b) => b.renameRecord("r1", "FAKE.pdf"),
    "vault_rename_record",
    { request: { recordId: "r1", name: "FAKE.pdf" } },
  ],
  [
    "assignFolders",
    (b) => b.assignFolders("r1", ["f1", "f2"]),
    "vault_assign_folders",
    { request: { recordId: "r1", folderIds: ["f1", "f2"] } },
  ],
  [
    "assignFoldersBatch",
    (b) => b.assignFoldersBatch(["r1", "r2"], ["f1"]),
    "vault_assign_folders_batch",
    { request: { recordIds: ["r1", "r2"], folderIds: ["f1"] } },
  ],
  [
    "pickImportFiles (the language for the native picker)",
    (b) => b.pickImportFiles("p1", ["f1"]),
    "vault_import_pick",
    { locale: "fr", request: { profileId: "p1", folderIds: ["f1"] } },
  ],
  [
    "importPickedFiles",
    (b) => b.importPickedFiles("pick-5", "p1", ["f1"]),
    "vault_import_picked",
    { request: { pickId: "pick-5", profileId: "p1", folderIds: ["f1"] } },
  ],
  [
    "pickExportDestination",
    (b) => b.pickExportDestination("r1"),
    "vault_export_pick",
    { request: { recordId: "r1" } },
  ],
  [
    "exportToPicked",
    (b) => b.exportToPicked("pick-6", "r1"),
    "vault_export_picked",
    { request: { pickId: "pick-6", recordId: "r1" } },
  ],
  ["listReceived", (b) => b.listReceived(), "received_list"],
  [
    "acceptReceived (ids chosen)",
    (b) => b.acceptReceived(["a", "b"]),
    "received_accept",
    { request: { ids: ["a", "b"] } },
  ],
  ["acceptReceived (all)", (b) => b.acceptReceived(), "received_accept"],
  [
    "discardReceived",
    (b) => b.discardReceived(["a"]),
    "received_discard",
    { request: { ids: ["a"] } },
  ],
  [
    "moveToPerson",
    (b) => b.moveToPerson(["r1"], "p2", ["f1"]),
    "vault_move_to_person",
    { request: { recordIds: ["r1"], profileId: "p2", folderIds: ["f1"] } },
  ],
  [
    "pageBoxes (no password sends null)",
    (b) => b.pageBoxes("r1", 2, { first: 3, last: 4 } as never),
    "vault_page_boxes",
    { request: { recordId: "r1", page: 2, first: 3, last: 4, password: null } },
  ],
  [
    "aiExplain (the answer is named; a document is named only when given)",
    (b) =>
      b.aiExplain("FAKE term", "FAKE context", "en", undefined, "answer-1"),
    "ai_explain",
    {
      answerId: "answer-1",
      request: { term: "FAKE term", context: "FAKE context", lang: "en" },
    },
  ],
  [
    "aiExplain (with a document)",
    (b) => b.aiExplain("FAKE term", "FAKE context", "en", "r1", "answer-1"),
    "ai_explain",
    {
      answerId: "answer-1",
      request: {
        term: "FAKE term",
        context: "FAKE context",
        lang: "en",
        recordId: "r1",
      },
    },
  ],
  ["aiCancel", (b) => b.aiCancel(), "ai_cancel"],
  ["aiModelSpeed", (b) => b.aiModelSpeed(), "ai_model_speed"],
  ["trayWaiting", (b) => b.trayWaiting(), "tray_waiting_status"],
  [
    "documentText (no password sends null)",
    (b) => b.documentText("r1", "read-1"),
    "vault_document_text",
    { request: { recordId: "r1", readId: "read-1", password: null } },
  ],
  [
    "documentText (with a password)",
    (b) => b.documentText("r1", "read-1", "FAKE pw"),
    "vault_document_text",
    { request: { recordId: "r1", readId: "read-1", password: "FAKE pw" } },
  ],
  [
    "cancelDocumentText",
    (b) => b.cancelDocumentText("read-1"),
    "vault_document_text_cancel",
    { request: { readId: "read-1" } },
  ],
  [
    "recordKnownDetails",
    (b) => b.recordKnownDetails("r1"),
    "vault_record_known_details",
    { request: { recordId: "r1" } },
  ],
  [
    "pickTextExportDestination",
    (b) => b.pickTextExportDestination("r1", "ticket-1"),
    "vault_export_text_pick",
    { request: { recordId: "r1", ticket: "ticket-1" }, locale: "fr" },
  ],
  [
    "exportTextToPicked (nothing kept)",
    (b) => b.exportTextToPicked("pick-7", "r1", "ticket-1", "FAKE text"),
    "vault_export_text_picked",
    {
      request: {
        pickId: "pick-7",
        recordId: "r1",
        ticket: "ticket-1",
        text: "FAKE text",
        kept: [],
      },
      locale: "fr",
    },
  ],
  [
    "copyTextExport (with what was kept)",
    (b) => b.copyTextExport("r1", "ticket-1", "FAKE text", ["k1"] as never),
    "vault_export_text_copy",
    {
      request: {
        recordId: "r1",
        ticket: "ticket-1",
        text: "FAKE text",
        kept: ["k1"],
      },
      locale: "fr",
    },
  ],
  [
    "saveAiResult (no sources)",
    (b) => b.saveAiResult("r1", "kept-1"),
    "vault_ai_result_save",
    { request: { recordId: "r1", keptId: "kept-1" } },
  ],
  [
    "saveAiResult (with the sources)",
    (b) => b.saveAiResult("r1", "kept-1", [{ page: 1 }] as never),
    "vault_ai_result_save",
    { request: { recordId: "r1", keptId: "kept-1", sources: [{ page: 1 }] } },
  ],
  [
    "aiResults",
    (b) => b.aiResults("r1"),
    "vault_ai_results",
    { request: { recordId: "r1" } },
  ],
  [
    "readAiResult",
    (b) => b.readAiResult("r1", "res-1"),
    "vault_ai_result_read",
    { request: { recordId: "r1", resultId: "res-1" } },
  ],
  [
    "hideProfile",
    (b) => b.hideProfile("p1"),
    "vault_hide_profile",
    { request: { profileId: "p1" } },
  ],
  [
    "restoreProfile",
    (b) => b.restoreProfile("p1"),
    "vault_restore_profile",
    { request: { profileId: "p1" } },
  ],
  [
    "hideRecord",
    (b) => b.hideRecord("r1"),
    "vault_hide_record",
    { request: { recordId: "r1" } },
  ],
  [
    "unhideRecord",
    (b) => b.unhideRecord("r1"),
    "vault_unhide_record",
    { request: { recordId: "r1" } },
  ],
  [
    "hideUnavailableRecords (no people's documents by default)",
    (b) => b.hideUnavailableRecords(["r1", "r2"]),
    "vault_hide_unavailable_records",
    { request: { confirmed: ["r1", "r2"], hiddenPeopleDocuments: 0 } },
  ],
  [
    "hideUnavailableRecords (counting a hidden person's)",
    (b) => b.hideUnavailableRecords(["r1"], 3),
    "vault_hide_unavailable_records",
    { request: { confirmed: ["r1"], hiddenPeopleDocuments: 3 } },
  ],
  [
    "reset (the language, and what was typed)",
    (b) => b.reset("FAKE phrase"),
    "vault_reset",
    { locale: "fr", request: { confirmation: "FAKE phrase" } },
  ],
];

describe("the page's calls to the native vault commands", () => {
  it.each(CASES)("%s", async (_, call, command, args) => {
    await call(createVaultBridge() as Bridge);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]).toEqual(
      args === undefined ? [command] : [command, args],
    );
  });

  it("gives back what the native command answered, and what it refused with, untouched", async () => {
    const bridge = createVaultBridge();
    invoke.mockResolvedValueOnce(["a", "b"]);
    await expect(bridge.leftOutRecords()).resolves.toEqual(["a", "b"]);
    const refusal = { code: "locked", message: "FAKE locked" };
    invoke.mockRejectedValueOnce(refusal);
    await expect(bridge.hideRecord("r1")).rejects.toBe(refusal);
  });

  it("is a native bridge only where the native runtime is there", () => {
    expect(createVaultBridge().native).toBe(false);
    Reflect.set(window, "__TAURI_INTERNALS__", {});
    try {
      expect(createVaultBridge().native).toBe(true);
    } finally {
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    }
  });

  it("makes a new name for each AI answer when the caller gives none", async () => {
    const bridge = createVaultBridge();
    await bridge.aiExplain("t", "c", "en");
    await bridge.aiExplain("t", "c", "en");
    const [first, second] = invoke.mock.calls.map((call) => call[1].answerId);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
  });
});

describe("what the native side tells the page by events", () => {
  it.each([
    ["onVaultLocked", "vault-locked", { by: "idle" }, { by: "idle" }],
    [
      "onAiAnswerStarted",
      "ai-answer-started",
      { answerId: "a1", limitMs: 5 },
      { answerId: "a1", limitMs: 5 },
    ],
  ] as const)(
    "%s hands over the payload and stops listening when asked",
    async (method, event, payload, expected) => {
      const unlisten = vi.fn();
      let deliver: (event: { payload: unknown }) => void = () => undefined;
      listen.mockImplementation(
        async (name: string, handler: typeof deliver) => {
          expect(name).toBe(event);
          deliver = handler;
          return unlisten;
        },
      );
      const handler = vi.fn();
      const stop = (
        createVaultBridge() as unknown as Record<
          string,
          (h: unknown) => () => void
        >
      )[method](handler);
      await Promise.resolve();
      deliver({ payload });
      expect(handler).toHaveBeenCalledExactlyOnceWith(expected);
      stop();
      await Promise.resolve();
      await Promise.resolve();
      expect(unlisten).toHaveBeenCalledOnce();
    },
  );

  it("the waiting-notice event hands over a plain true or false, whatever else is sent", async () => {
    let deliver: (event: { payload: unknown }) => void = () => undefined;
    listen.mockImplementation(async (_: string, handler: typeof deliver) => {
      deliver = handler;
      return () => undefined;
    });
    const handler = vi.fn();
    (createVaultBridge() as Bridge).onTrayWaiting(handler);
    await Promise.resolve();
    for (const payload of [true, false, "yes", 1, null, undefined])
      deliver({ payload });
    expect(handler.mock.calls.map((call) => call[0])).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

import { humanText, humanValue, visibleText } from "./test/humanText";
import {
  addMenuItemNow,
  chooseAdd,
  chooseToolbar,
  headMenuItemNow,
  importMenuItem,
  importMenuItemNow,
} from "./test/menus";
import { birthDateGroup, enterBirthDate } from "./test/birthDate";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
  within,
} from "@testing-library/react";
import axe from "axe-core";
import userEvent from "@testing-library/user-event";
import { page, userEvent as realKeys } from "vitest/browser";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  forgetRecoveryOffer,
  recordRecoveryOffer,
} from "./native/recoveryOffer";

const offerIsDue = () => forgetRecoveryOffer();
// The window's own lock button, named by its words "Lock now" (#121). Security
// has a Lock now button too, so look only in the title bar.
const windowLock = (name: string | RegExp = "Lock now") =>
  within(document.querySelector(".titlebar") as HTMLElement).getByRole(
    "button",
    { name: typeof name === "string" ? humanText(name) : name },
  );
import { StrictMode, createElement } from "react";
import type { ComponentProps } from "react";
import VaultApp from "./VaultApp";

// The library is handed the bridge `VaultApp` wraps (`trackedBridge`), and nothing else in a test
// can reach it. This wrapper renders the real library and only remembers that bridge, so a test
// can call a wrapped method bare, from outside `run`, as the hand-over dialogs do.
// `vi.mock` applies to the whole file: every test below, not only the ones that read `shown`, is
// rendered through this extra component layer (it renders the real `VaultLibrary` with the same
// props, so nothing else about them changes).
const shown = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("./native/VaultLibrary", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./native/VaultLibrary")>();
  return {
    ...original,
    VaultLibrary: (props: ComponentProps<typeof original.VaultLibrary>) => {
      shown.bridge = props.bridge;
      return createElement(original.VaultLibrary, props);
    },
  };
});
import type {
  ImportOutcome,
  PortalApprovalCheck,
  PortalLinkSummary,
  PersonDetails,
  ReceivedAcceptOutcome,
  ProfileImportOutcome,
  SavedBackup,
  SavedProfileExport,
  VaultBridge,
  VaultSnapshot,
  ViewedPage,
} from "./vault";
import { ANNOUNCE_DELAY_MS } from "./native/announce";
import type { ModelSummary } from "./ai/types";
import { FAKE_MODEL, fakeDocumentText } from "./test/fakeLocalModel";
import { setLocaleOverride, translate } from "./i18n";

// One fake native runtime: stamp and clone when data is captured, before delivery.
let snapshotSequence = 1;
function captureSnapshot(snapshot: VaultSnapshot): VaultSnapshot {
  return {
    ...structuredClone(snapshot),
    capture: {
      epoch: "00000000-0000-4000-8000-000000000185",
      sequence: ++snapshotSequence,
    },
  };
}

const TRANSFER_HOLD =
  "Vault content is hidden. myCarlos will lock as soon as the transfer finishes.";
const IOS_PAUSE = "Keep myCarlos open: switching apps pauses this transfer.";
const CANCELLED = {
  code: "cancelled",
  message: "The operation stopped because the vault was locked.",
};
const PARTIAL_EXPORT = {
  code: "partial_export",
  message:
    "The selected destination may contain a partial readable copy. Delete that copy before retrying.",
};

const emptySnapshot: VaultSnapshot = {
  capture: { epoch: "00000000-0000-4000-8000-000000000185", sequence: 1 },
  profiles: [{ id: "profile-1", displayName: "Jamie", createdAtMs: 1 }],
  folders: [],
  records: [],
  recovery: null,
};

/** A new setup starts on the comfort screen (#69); Continue leads on to the
 * passphrase. */
async function continuePastComfort() {
  fireEvent.click(
    await screen.findByRole("button", { name: humanText("Continue") }),
  );
}

function nativeBridge(overrides: Partial<VaultBridge> = {}): VaultBridge {
  return {
    native: true,
    status: vi.fn().mockResolvedValue("locked"),
    passphraseRules: vi.fn().mockResolvedValue({
      longEnough: true,
      notAName: true,
      hardToGuess: true,
    }),
    create: vi
      .fn()
      .mockImplementation(async () => captureSnapshot(emptySnapshot)),
    unlock: vi
      .fn()
      .mockImplementation(async () => captureSnapshot(emptySnapshot)),
    lock: vi.fn().mockResolvedValue(undefined),
    touch: vi.fn().mockResolvedValue(undefined),
    setAutoLock: vi.fn().mockResolvedValue(undefined),
    platform: vi.fn().mockResolvedValue("windows"),
    snapshot: vi
      .fn()
      .mockImplementation(async () => captureSnapshot(emptySnapshot)),
    history: vi.fn().mockResolvedValue({
      entries: [],
      laterEntries: [],
      complete: true,
      checkedUntilMs: null,
      checkedFromMs: null,
    }),
    changePassphrase: vi.fn().mockResolvedValue(undefined),
    // Tests that set up a recovery key say so; the others get a vault without
    // one, as when making the key fails after the vault was created.
    beginRecoveryKey: vi
      .fn()
      .mockRejectedValue({ code: "storage", message: "FAKE no key here." }),
    confirmRecoveryKey: vi
      .fn()
      .mockImplementation(async () =>
        captureSnapshot({ ...emptySnapshot, recoveryKeySetAtMs: 5 }),
      ),
    saveRecoveryKit: vi.fn().mockResolvedValue(true),
    benchmarkKdf: vi
      .fn()
      .mockRejectedValue({ code: "busy", message: "FAKE no speed test." }),
    recoveryKeyLabel: vi.fn().mockResolvedValue("7F3A"),
    cancelRecoveryKey: vi.fn().mockResolvedValue(undefined),
    recover: vi.fn().mockImplementation(async () => {
      const result = { passphraseReplaced: true, snapshot: emptySnapshot };
      return { ...result, snapshot: captureSnapshot(result.snapshot) };
    }),
    pickBackupDestination: vi.fn().mockResolvedValue(null),
    saveBackupToPicked: vi.fn().mockResolvedValue(undefined),
    prepareProfileExport: vi.fn(),
    pickProfileExportDestination: vi.fn().mockResolvedValue(null),
    saveProfileExportToPicked: vi.fn(),
    pickProfileImportSource: vi.fn().mockResolvedValue(null),
    profileImportKeyKind: vi.fn(),
    inspectProfileImport: vi.fn(),
    importProfile: vi.fn(),
    pickRestoreSource: vi.fn().mockResolvedValue(null),
    inspectRestore: vi.fn().mockResolvedValue({
      replaces: "nothing",
      differsFromThisDevice: false,
      documentCount: 0,
    }),
    restore: vi.fn().mockResolvedValue(true),
    createProfile: vi.fn().mockResolvedValue("profile-2"),
    renameProfile: vi.fn().mockResolvedValue(undefined),
    createFolder: vi.fn().mockResolvedValue("folder-1"),
    updateFolder: vi.fn().mockResolvedValue(undefined),
    renameRecord: vi.fn().mockResolvedValue(undefined),
    assignFolders: vi.fn().mockResolvedValue(undefined),
    assignFoldersBatch: vi.fn().mockResolvedValue(undefined),
    pickImportFiles: vi.fn().mockResolvedValue("pick-1"),
    importPickedFiles: vi
      .fn()
      .mockResolvedValue({ imported: [], skippedDuplicates: [] }),
    pickExportDestination: vi.fn().mockResolvedValue(null),
    exportToPicked: vi.fn().mockResolvedValue(undefined),
    savePhoto: vi
      .fn()
      .mockResolvedValue({ imported: [], skippedDuplicates: [] }),
    isPhoto: vi.fn().mockResolvedValue(false),
    videoStart: vi.fn().mockResolvedValue({ recordingId: "recording-1" }),
    videoAppend: vi.fn().mockResolvedValue({
      storedBytes: 0,
      fragments: 0,
      hasVideo: null,
      hasAudio: null,
      nextSequence: 1,
      space: "ok",
      freeBytes: null,
    }),
    videoPause: vi.fn().mockResolvedValue(undefined),
    videoResume: vi.fn().mockResolvedValue(undefined),
    videoStop: vi.fn().mockResolvedValue({ recordId: null }),
    leftOutRecords: vi.fn().mockResolvedValue([]),
    backupSize: vi.fn().mockResolvedValue({
      totalBytes: 1000,
      withoutVideosBytes: 1000,
      videoBytes: 0,
      videoCount: 0,
    }),
    videoSpace: vi.fn().mockResolvedValue({
      freeBytes: null,
      level: "unknown",
      canRecord: true,
    }),
    videoPending: vi.fn().mockResolvedValue({ recordings: [], unreadable: 0 }),
    videoRecover: vi.fn().mockResolvedValue({ recordId: null }),
    isVideo: vi.fn().mockResolvedValue(false),
    videoOpen: vi.fn().mockResolvedValue({
      token: "0".repeat(64),
      url: "mycarlos-video://localhost/FAKE",
      totalBytes: 0,
    }),
    videoClose: vi.fn().mockResolvedValue(undefined),
    isLockedPdf: vi.fn().mockResolvedValue(false),
    unlockPdf: vi.fn(),
    viewPhoto: vi
      .fn()
      .mockRejectedValue({ code: "not_a_photo", message: "FAKE not a photo." }),
    hideRecord: vi.fn().mockResolvedValue(undefined),
    unhideRecord: vi.fn().mockResolvedValue(undefined),
    discardReceived: vi.fn().mockResolvedValue(0),
    hideUnavailableRecords: vi.fn().mockResolvedValue([]),
    listReceived: vi.fn().mockResolvedValue({
      files: [],
      notice: { dropped: 0, refusedShares: 0 },
    }),
    acceptReceived: vi.fn().mockResolvedValue({
      imported: [],
      skippedDuplicates: [],
      notPdf: [],
      unreadable: [],
    }),
    moveToPerson: vi.fn().mockResolvedValue({ moved: [], alreadyThere: [] }),
    viewPage: vi
      .fn()
      .mockRejectedValue(new Error("FAKE: no reader in this test")),
    cancelView: vi.fn().mockResolvedValue(undefined),
    aiModelStatus: vi.fn().mockResolvedValue({ state: "notInstalled" }),
    aiSummarize: vi
      .fn()
      .mockRejectedValue(new Error("FAKE: no model in this test")),
    aiExplain: vi
      .fn()
      .mockRejectedValue(new Error("FAKE: no model in this test")),
    aiCancel: vi.fn().mockResolvedValue(undefined),
    documentText: vi.fn().mockRejectedValue(new Error("FAKE no text")),
    cancelDocumentText: vi.fn().mockResolvedValue(undefined),
    recordKnownDetails: vi.fn().mockResolvedValue({
      names: [],
      birthDates: [],
      doctorNames: [],
      clinicNames: [],
    }),
    pickTextExportDestination: vi.fn().mockResolvedValue(null),
    exportTextToPicked: vi.fn().mockResolvedValue({ saved: false, hits: [] }),
    copyTextExport: vi.fn().mockResolvedValue({ approved: null, hits: [] }),
    saveAiResult: vi
      .fn()
      .mockRejectedValue(new Error("FAKE: not in this test")),
    aiResults: vi.fn().mockResolvedValue([]),
    readAiResult: vi
      .fn()
      .mockRejectedValue(new Error("FAKE: not in this test")),
    reset: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

const snapshotWithRecord: VaultSnapshot = {
  ...emptySnapshot,
  records: [
    {
      id: "record-1",
      profileId: "profile-1",
      folderIds: [],
      displayName: "FAKE_Results.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/pdf",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: true,
    },
  ],
};

// Saves FAKE_Results.pdf through its details, for tests on fake timers.
async function startExport() {
  await act(async () => {
    fireEvent.click(screen.getByText(humanText("FAKE_Results.pdf")));
  });
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText("Save a copy to this device"),
      }),
    );
  });
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Save a copy") }),
    );
  });
}

// Messages for a screen or dialog that has just appeared are written after this
// delay, so that its status line reads them out.
async function passAnnounceDelay() {
  if (vi.isFakeTimers())
    await act(async () => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS));
  else
    await act(
      () => new Promise((resolve) => setTimeout(resolve, ANNOUNCE_DELAY_MS)),
    );
}

// What the unlock screen says of a lock: that it happened, and why if it
// happened by itself (#68), with nothing of the records.
const LOCKED_MESSAGE =
  /^(Vault locked\.|Locked after \d+ minutes? without use\.|Locked because myCarlos was minimized or sent to the background\.)$/;

// The unlock screen says only that the vault locked; a transfer's outcome is
// shown after the next unlock, where only the owner sees it.
async function expectOutcomeAfterUnlock(outcome: string) {
  expect(screen.getByText(humanText(LOCKED_MESSAGE))).toBeVisible();
  expect(
    screen.queryByText(humanText(outcome), { exact: false }),
  ).not.toBeInTheDocument();
  await act(async () => {
    fireEvent.change(screen.getByLabelText(humanText("Passphrase")), {
      target: { value: "river-azimuth-cobalt-sparrow-934" },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: humanText("Unlock") }));
  });
  await passAnnounceDelay();
  expect(
    screen.getByText(humanText(`Vault unlocked. ${outcome}`)),
  ).toBeVisible();
}

// Unlocks and checks that nothing was kept for this unlock to report.
async function expectNothingKeptAfterUnlock() {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(humanText("Passphrase")), {
      target: { value: "river-azimuth-cobalt-sparrow-934" },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: humanText("Unlock") }));
  });
  expect(
    await screen.findByText(humanText(/^Vault unlocked/)),
  ).toHaveHumanTextContent(/^Vault unlocked\.$/);
}

// Starts an import, backgrounds the app so the lock is held for it, and
// finishes the import, which lets the held lock proceed.
async function holdLockForImport(bridge: VaultBridge, finish: () => void) {
  const user = userEvent.setup();
  await user.click(await importMenuItem());
  await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  onTestFinished(() => visibility.mockRestore());
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();
  visibility.mockReturnValue("visible");
  await act(async () => finish());
  return user;
}

// On desktop and iOS, tauri-plugin-dialog replaces window.confirm with an async
// function. Its promise is always truthy, so a synchronous `if (!confirm(...))`
// guard never stops a destructive action. The app must not rely on it.
function tauriConfirmShim() {
  const shim = vi
    .spyOn(window, "confirm")
    .mockImplementation((() =>
      Promise.reject(new Error("not allowed"))) as never);
  // Restored even when the test fails, so later tests get the real confirm.
  onTestFinished(() => shim.mockRestore());
  return shim;
}

// Testing Library's drag convenience helpers clone DataTransfer and lose native
// file items. Dispatch a real browser DragEvent to preserve its payload.
function fireDragEvent(
  type: string,
  target: Element | Window,
  init: DragEventInit,
): boolean {
  return fireEvent(
    target,
    new DragEvent(type, { bubbles: true, cancelable: true, ...init }),
  );
}

function dragTransfer(): DataTransfer {
  return new DataTransfer();
}

function renameBridge() {
  let snapshot: VaultSnapshot = {
    ...emptySnapshot,
    folders: [
      {
        id: "parent",
        profileId: "profile-1",
        parentId: null,
        name: "FAKE Parent",
        createdAtMs: 1,
      },
      {
        id: "child",
        profileId: "profile-1",
        parentId: "parent",
        name: "FAKE Old folder",
        createdAtMs: 2,
      },
    ],
    records: [
      {
        id: "record",
        profileId: "profile-1",
        folderIds: ["parent"],
        displayName: "FAKE Old.pdf",
        sourceLabel: "Manual import — unverified",
        mediaType: "application/octet-stream",
        plaintextSize: 2048,
        importedAtMs: 1,
        available: true,
      },
    ],
  };
  return nativeBridge({
    status: vi.fn().mockResolvedValue("unlocked"),
    snapshot: vi.fn().mockImplementation(async () => captureSnapshot(snapshot)),
    updateFolder: vi.fn().mockImplementation(async (id, parentId, name) => {
      snapshot = {
        ...snapshot,
        folders: snapshot.folders.map((folder) =>
          folder.id === id ? { ...folder, parentId, name } : folder,
        ),
      };
    }),
    renameRecord: vi.fn().mockImplementation(async (id, displayName) => {
      snapshot = {
        ...snapshot,
        records: snapshot.records.map((record) =>
          record.id === id ? { ...record, displayName } : record,
        ),
      };
    }),
  });
}

describe("the first person's details at setup (#234)", () => {
  it("says when the details typed at setup could not be saved, and the vault is still ready", async () => {
    const user = userEvent.setup();
    const updateProfileDetails = vi
      .fn()
      .mockRejectedValue({ code: "storage", message: "FAKE: not saved" });
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("absent"),
      updateProfileDetails,
    });
    render(<VaultApp bridge={bridge} />);
    await continuePastComfort();
    await user.type(
      await screen.findByLabelText(
        humanText("Whose records will you keep here?"),
      ),
      "FAKE Patient",
    );
    await user.type(
      screen.getByLabelText(humanText("Full name, as on clinic documents")),
      "FAKE Patient Example",
    );
    enterBirthDate(birthDateGroup(), "1980-04-12");
    await user.type(
      screen.getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.type(
      screen.getByLabelText(humanText("Confirm passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Create vault") }),
    );
    expect(
      await screen.findByText(
        humanText(
          "The vault is ready, but the full name and date of birth weren't saved. Add them in Edit details.",
        ),
      ),
    ).toBeVisible();
    expect(updateProfileDetails).toHaveBeenCalledOnce();
    expect(bridge.create).toHaveBeenCalledOnce();
  });
});

describe("durable vault UI", () => {
  it.each(["status", "snapshot"])(
    "locks native state and shows unlock when the current startup %s fails",
    async (stage) => {
      const failure = {
        code: "storage",
        message: "FAKE current startup failed",
      };
      const bridge = nativeBridge({
        status:
          stage === "status"
            ? vi.fn().mockRejectedValue(failure)
            : vi.fn().mockResolvedValue("unlocked"),
        snapshot: vi.fn().mockRejectedValue(failure),
      });
      render(<VaultApp bridge={bridge} />);
      expect(
        await screen.findByLabelText(humanText("Passphrase")),
      ).toBeVisible();
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(
        screen.getByText(humanText("FAKE current startup failed")),
      ).toBeVisible();
      expect(bridge.snapshot).toHaveBeenCalledTimes(
        stage === "snapshot" ? 1 : 0,
      );
      expect(
        screen.queryByRole("heading", { name: humanText("My records") }),
      ).toBeNull();
    },
  );

  it("does not lock a new unlock when an abandoned startup check fails", async () => {
    let refuseEarlier!: (error: unknown) => void;
    const earlier = new Promise<"locked">((_, reject) => {
      refuseEarlier = reject;
    });
    const failure = { code: "storage", message: "FAKE earlier startup failed" };
    const bridge = nativeBridge({
      status: vi.fn().mockReturnValueOnce(earlier).mockResolvedValue("locked"),
      unlock: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
    });
    try {
      // The application itself uses StrictMode. Its abandoned first effect
      // must not issue a native lock owned by the later, successful startup.
      render(
        <StrictMode>
          <VaultApp bridge={bridge} />
        </StrictMode>,
      );
      const passphrase = await screen.findByLabelText(humanText("Passphrase"));
      expect(bridge.status).toHaveBeenCalledTimes(2);
      fireEvent.change(passphrase, {
        target: { value: "river-azimuth-cobalt-sparrow-934" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: humanText("Unlock") }),
      );
      expect(
        await screen.findByText(humanText("FAKE_Results.pdf")),
      ).toBeVisible();
      expect(bridge.unlock).toHaveBeenCalledOnce();
      expect(bridge.lock).not.toHaveBeenCalled();

      await act(async () => refuseEarlier(failure));
      expect(bridge.lock).not.toHaveBeenCalled();
      expect(screen.getByText(humanText("FAKE_Results.pdf"))).toBeVisible();
      expect(
        screen.queryByText(humanText("FAKE earlier startup failed")),
      ).not.toBeInTheDocument();
    } finally {
      await act(async () => refuseEarlier(failure));
    }
  });

  it.each(["verified", "pending"])(
    "conceals %s audit history while a manual native lock is still pending",
    async (kind) => {
      let finishLock!: () => void;
      let finishHistory!: (view: unknown) => void;
      const rows = [
        {
          seq: 0,
          atMs: 1,
          app: "FAKE",
          event: "created",
          name: "FAKE pending lock secret",
          oldName: null,
          from: null,
          fromTotal: null,
          to: null,
          toTotal: null,
          how: null,
          place: null,
          previousSession: null,
        },
      ];
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        history:
          kind === "verified"
            ? vi.fn().mockResolvedValue({
                entries: rows,
                complete: true,
                checkedUntilMs: null,
                checkedFromMs: null,
                laterEntries: [],
              })
            : vi.fn().mockImplementation(
                () =>
                  new Promise((resolve) => {
                    finishHistory = resolve;
                  }),
              ),
        lock: vi.fn().mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              finishLock = resolve;
            }),
        ),
      });
      render(<VaultApp bridge={bridge} />);
      await screen.findByRole("heading", { name: "My records" });
      fireEvent.click(screen.getByRole("button", { name: "Security" }));
      fireEvent.click(screen.getByRole("button", { name: "Audit history" }));
      await screen.findByText(
        kind === "verified"
          ? "FAKE pending lock secret"
          : "Checking and reading the complete history…",
      );
      fireEvent.click(windowLock());
      expect(
        screen.getByText(
          "Vault content is hidden while myCarlos finishes locking…",
        ),
      ).toBeVisible();
      expect(
        screen.queryByRole("navigation", { name: "Record library" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Passphrase")).not.toBeInTheDocument();
      expect(screen.getByText("Locking", { exact: true })).toBeVisible();
      if (kind === "pending")
        await act(async () =>
          finishHistory({
            entries: rows,
            complete: true,
            checkedUntilMs: null,
            checkedFromMs: null,
            laterEntries: [],
          }),
        );
      expect(document.body).not.toHaveTextContent("FAKE pending lock secret");
      await act(async () => finishLock());
      expect(await screen.findByLabelText("Passphrase")).toBeVisible();
    },
  );

  it("conceals and confirms a native-cancelled audit history without a frontend lock request", async () => {
    let failLock!: (cause: unknown) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      history: vi.fn().mockRejectedValue(CANCELLED),
      lock: vi
        .fn()
        .mockResolvedValue(undefined)
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              failLock = reject;
            }),
        ),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: "My records" });
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    fireEvent.click(screen.getByRole("button", { name: "Audit history" }));
    await vi.waitFor(() => expect(bridge.lock).toHaveBeenCalledOnce());
    expect(
      screen.getByText(
        "Vault content is hidden while myCarlos finishes locking…",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("navigation", { name: "Record library" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Passphrase")).not.toBeInTheDocument();
    expect(screen.getByText("Locking", { exact: true })).toBeVisible();
    await act(async () =>
      failLock({
        code: "storage",
        message: "FAKE synthetic confirmation failed",
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "the vault is still open",
    );
    expect(screen.queryByLabelText("Passphrase")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try locking again" }));
    expect(await screen.findByLabelText("Passphrase")).toBeVisible();
    expect(bridge.lock).toHaveBeenCalledTimes(2);
  });
  it.each(["success", "locked", "cancelled"])(
    "discards a pending audit history %s after lock and a new unlock",
    async (outcome) => {
      let finish!: (view: import("./vault").AuditHistoryView) => void;
      let fail!: (cause: unknown) => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        history: vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise((resolve, reject) => {
                finish = resolve;
                fail = reject;
              }),
          )
          .mockResolvedValue({
            entries: [],
            complete: true,
            checkedUntilMs: null,
            checkedFromMs: null,
            laterEntries: [],
          }),
      });
      render(<VaultApp bridge={bridge} />);
      await screen.findByRole("heading", { name: "My records" });
      fireEvent.click(screen.getByRole("button", { name: "Security" }));
      fireEvent.click(screen.getByRole("button", { name: "Audit history" }));
      await screen.findByText("Checking and reading the complete history…");
      fireEvent.click(windowLock());
      await screen.findByLabelText("Passphrase");
      expect(
        screen.queryByRole("heading", { name: "Audit history" }),
      ).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Passphrase"), {
          target: { value: "river-azimuth-cobalt-sparrow-934" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
      });
      await screen.findByRole("heading", { name: "My records" });
      fireEvent.click(screen.getByRole("button", { name: "Security" }));
      fireEvent.click(screen.getByRole("button", { name: "Audit history" }));
      await screen.findByText("There are no history events.");
      await act(async () => {
        if (outcome !== "success") fail({ code: outcome });
        else
          finish({
            entries: [
              {
                seq: 0,
                atMs: 1,
                app: "FAKE",
                event: "created",
                name: "FAKE old session secret",
                oldName: null,
                from: null,
                fromTotal: null,
                to: null,
                toTotal: null,
                how: null,
                place: null,
                previousSession: null,
              },
            ],
            complete: true,
            checkedUntilMs: null,
            checkedFromMs: null,
            laterEntries: [],
          });
      });
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(
        screen.queryByText("FAKE old session secret"),
      ).not.toBeInTheDocument();
      expect(screen.getByText("There are no history events.")).toBeVisible();
    },
  );

  it("removes verified audit history plaintext from the document when the vault locks", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      history: vi.fn().mockResolvedValue({
        entries: [
          {
            seq: 0,
            atMs: 1,
            app: "FAKE",
            event: "created",
            name: "FAKE verified session secret",
            oldName: null,
            from: null,
            fromTotal: null,
            to: null,
            toTotal: null,
            how: null,
            place: null,
            previousSession: null,
          },
        ],
        complete: true,
        checkedUntilMs: null,
        checkedFromMs: null,
        laterEntries: [],
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: "My records" });
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    fireEvent.click(screen.getByRole("button", { name: "Audit history" }));
    await screen.findByText("FAKE verified session secret");
    fireEvent.click(windowLock());
    await screen.findByLabelText("Passphrase");
    expect(document.body).not.toHaveTextContent("FAKE verified session secret");
  });
  beforeEach(() => {
    window.localStorage.clear();
    // Most tests here are not about the recovery key offer, which opens
    // over the library when a vault without a key is unlocked: for them it
    // was made earlier today. Those that are start with `offerIsDue()`.
    forgetRecoveryOffer();
    recordRecoveryOffer(Date.now());
  });

  it("says a vault stays on the device it was created on", async () => {
    // A patient who signs in on a second computer sees this screen there. It
    // must not read as though their vault was lost.
    render(
      <VaultApp
        bridge={nativeBridge({ status: vi.fn().mockResolvedValue("absent") })}
      />,
    );
    await continuePastComfort();
    await screen.findByRole("heading", {
      name: humanText("Set up myCarlos on this device"),
    });
    expect(
      screen.getByText(humanText(/stays on this device/)),
    ).toHaveHumanTextContent(/another device/);
  });

  it("starts a new setup on the comfort screen, and only a new one (#69)", async () => {
    const user = userEvent.setup();
    window.localStorage.removeItem("mycarlos.autoLockMinutes.v1");
    onTestFinished(() =>
      window.localStorage.removeItem("mycarlos.autoLockMinutes.v1"),
    );
    render(
      <VaultApp
        bridge={nativeBridge({ status: vi.fn().mockResolvedValue("absent") })}
      />,
    );
    await screen.findByRole("heading", {
      name: humanText("Make myCarlos comfortable for you"),
    });
    // A choice applies at once, and is kept as Settings keeps it.
    const delay = screen.getByRole("group", {
      name: humanText("Automatic lock delay"),
    });
    for (let press = 0; press < 2; press++)
      await user.click(
        within(delay).getByRole("button", { name: humanText("Longer delay") }),
      );
    expect(within(delay).getByText(humanText("7 minutes"))).toBeVisible();
    expect(window.localStorage.getItem("mycarlos.autoLockMinutes.v1")).toBe(
      "7",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Continue") }),
    );
    await screen.findByRole("heading", {
      name: humanText("Set up myCarlos on this device"),
    });
    // The focus goes on to the first box, not nowhere; the choice was
    // said where it was made, not again here.
    expect(
      screen.getByLabelText(humanText("Whose records will you keep here?")),
    ).toHaveFocus();
    expect(
      screen.queryByText(humanText(/Automatic locking set/)),
    ).not.toBeInTheDocument();
    cleanup();

    // A vault that exists never shows it.
    render(<VaultApp bridge={nativeBridge()} />);
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    expect(
      screen.queryByRole("heading", {
        name: humanText("Make myCarlos comfortable for you"),
      }),
    ).not.toBeInTheDocument();
  });

  it("creates the vault only when passphrases match", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("absent"),
    });
    render(<VaultApp bridge={bridge} />);

    await continuePastComfort();
    await screen.findByRole("heading", {
      name: humanText("Set up myCarlos on this device"),
    });
    fireEvent.change(
      screen.getByLabelText(humanText("Whose records will you keep here?")),
      {
        target: { value: "Jamie" },
      },
    );
    const passwords = screen.getAllByLabelText(humanText(/passphrase/i));
    fireEvent.change(passwords[0], {
      target: { value: "river-azimuth-cobalt-sparrow-934" },
    });
    fireEvent.change(passwords[1], { target: { value: "different" } });
    expect(
      screen.getByRole("button", { name: humanText("Create vault") }),
    ).toBeDisabled();
    fireEvent.change(passwords[1], {
      target: { value: "river-azimuth-cobalt-sparrow-934" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Create vault") }),
    );

    await screen.findByRole("heading", { name: humanText("My records") });
    expect(bridge.create).toHaveBeenCalledWith(
      "river-azimuth-cobalt-sparrow-934",
      "Jamie",
    );
  });

  it("starts again on the comfort screen after setting the vault aside from the unlock screen (#69)", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("absent"),
    });
    render(<VaultApp bridge={bridge} />);
    await continuePastComfort();
    fireEvent.change(
      await screen.findByLabelText(
        humanText("Whose records will you keep here?"),
      ),
      { target: { value: "Jamie" } },
    );
    for (const field of screen.getAllByLabelText(humanText(/passphrase/i)))
      fireEvent.change(field, {
        target: { value: "river-azimuth-cobalt-sparrow-934" },
      });
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Create vault") }),
    );
    await screen.findByRole("heading", { name: humanText("My records") });
    await user.click(
      screen.getByRole("button", { name: humanText(/Lock now/) }),
    );
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await user.click(screen.getByText(humanText("Forgot your passphrase?")));
    await user.type(
      screen.getByLabelText(humanText("Type RESET MYCARLOS VAULT")),
      "RESET MYCARLOS VAULT",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Set vault aside") }),
    );
    expect(
      await screen.findByRole("heading", {
        name: humanText("Make myCarlos comfortable for you"),
      }),
    ).toBeVisible();
  });

  it("says when a new passphrase exceeds the vault's byte limit instead of sending it", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("absent"),
    });
    render(<VaultApp bridge={bridge} />);
    await continuePastComfort();
    const create = await screen.findByRole("button", {
      name: humanText("Create vault"),
    });
    // 600 characters need 1800 UTF-8 bytes, over the vault's 1024-byte limit.
    const long = "字".repeat(600);
    for (const field of screen.getAllByLabelText(humanText(/passphrase/i))) {
      fireEvent.change(field, { target: { value: long } });
    }

    expect(screen.getByRole("alert")).toHaveHumanTextContent("too long");
    expect(create).toBeDisabled();
    expect(bridge.create).not.toHaveBeenCalled();
  });

  it("offers to create a vault when unlocking finds that none exists", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      // A failed startup check shows the unlock screen without knowing the state.
      status: vi.fn().mockRejectedValue({
        code: "in_use",
        message: "This vault is open in another myCarlos window.",
      }),
      unlock: vi.fn().mockRejectedValue({
        code: "missing",
        message: "No vault exists on this device.",
      }),
    });
    render(<VaultApp bridge={bridge} />);

    await user.type(
      await screen.findByLabelText(humanText("Passphrase")),
      "a long synthetic passphrase",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));

    await continuePastComfort();
    expect(
      await screen.findByRole("heading", {
        name: humanText("Set up myCarlos on this device"),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(humanText("No vault exists on this device.")),
    ).toBeInTheDocument();
  });

  it("unlocks and imports through the native bridge", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      importPickedFiles: vi.fn().mockResolvedValue({
        imported: ["record-1"],
        skippedDuplicates: ["copy.pdf"],
      }),
      snapshot: vi.fn().mockImplementation(async () =>
        captureSnapshot({
          ...emptySnapshot,
          records: [
            {
              id: "record-1",
              profileId: "profile-1",
              folderIds: [],
              displayName: "report.pdf",
              sourceLabel: "Manual import — unverified",
              mediaType: "application/octet-stream",
              plaintextSize: 2048,
              importedAtMs: 1,
              available: true,
            },
          ],
        }),
      ),
    });
    render(<VaultApp bridge={bridge} />);

    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await user.type(
      screen.getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    await user.click(await importMenuItem());

    expect(await screen.findByText(humanText("report.pdf"))).toBeVisible();
    expect(
      screen.getByText(
        humanText("1 document encrypted and added. 1 duplicate skipped."),
      ),
    ).toBeVisible();
    expect(bridge.setAutoLock).toHaveBeenCalledWith(5);
    expect(bridge.pickImportFiles).toHaveBeenCalledWith("profile-1", []);
    expect(bridge.importPickedFiles).toHaveBeenCalledWith(
      "pick-1",
      "profile-1",
      [],
    );
  });

  // A vault whose waiting files go into Shared with me when accepted, and
  // leave it when moved (#61).
  function sharedVault(
    people: string[],
    waiting: string[],
    overrides: Partial<VaultBridge> = {},
  ) {
    const SHARED = "shared-profile";
    const vault: VaultSnapshot = {
      capture: { epoch: "00000000-0000-4000-8000-000000000185", sequence: 1 },
      profiles: people.map((displayName, index) => ({
        id: `profile-${index + 1}`,
        displayName,
        createdAtMs: 1,
      })),
      folders: [],
      records: [],
      recovery: null,
      sharedProfileId: SHARED,
    };
    let queue = waiting.map((name, index) => ({
      id: `shared-${index + 1}`,
      name,
      sourceLabel: "Manual import — unverified",
    }));
    const bridge = nativeBridge({
      unlock: vi.fn(async () => captureSnapshot(vault)),
      snapshot: vi.fn(async () => captureSnapshot(vault)),
      listReceived: vi.fn(async () => ({
        files: structuredClone(queue),
        notice: { dropped: 0, refusedShares: 0 },
      })),
      acceptReceived: vi.fn(async (ids?: string[]) => {
        // Exactly the files named, or every waiting one (the real command's two forms).
        const taken = ids
          ? queue.filter((file) => ids.includes(file.id))
          : queue;
        const added = taken.filter((file) => file.name.endsWith(".pdf"));
        const notPdf = taken
          .filter((file) => !file.name.endsWith(".pdf"))
          .map((file) => file.name);
        if (added.length && !vault.profiles.some((p) => p.id === SHARED))
          vault.profiles.push({
            id: SHARED,
            displayName: "Shared with me",
            createdAtMs: 2,
          });
        for (const file of added)
          vault.records.push({
            id: `record-${file.id}`,
            profileId: SHARED,
            folderIds: [],
            displayName: file.name,
            sourceLabel: file.sourceLabel,
            mediaType: "application/octet-stream",
            plaintextSize: 2048,
            importedAtMs: 3,
            available: true,
          });
        queue = queue.filter((file) => !taken.includes(file));
        return {
          imported: added.map((file) => `record-${file.id}`),
          skippedDuplicates: [],
          notPdf,
          unreadable: [],
        };
      }),
      moveToPerson: vi.fn(
        async (ids: string[], profileId: string, folderIds: string[]) => {
          for (const record of vault.records)
            if (ids.includes(record.id)) {
              record.profileId = profileId;
              record.folderIds = folderIds;
            }
          return { moved: ids, alreadyThere: [] };
        },
      ),
      ...overrides,
    });
    const arrive = (name: string) =>
      queue.push({
        id: `shared-${queue.length + 9}`,
        name,
        sourceLabel: "Manual import — unverified",
      });
    return { bridge, vault, arrive };
  }

  // Diagnostic regressions use NativeVault's actual refresh/received handlers,
  // not a replacement VaultLibrary run/refresh harness. Only the native bridge
  // replies are controlled; these FAKE records do not establish JPEG integrity.
  function photoRefreshVault() {
    const result = sharedVault(["FAKE Patient"], [], {
      status: vi.fn().mockResolvedValue("unlocked"),
      isPhoto: vi.fn(async (id: string) => id === "FAKE-photo"),
    });
    result.vault.records.push(
      {
        id: "FAKE-photo",
        profileId: "profile-1",
        folderIds: [],
        displayName: "FAKE_Camera.jpg",
        sourceLabel: "Manual import — unverified",
        mediaType: "application/octet-stream",
        plaintextSize: 2048,
        importedAtMs: 1,
        available: true,
      },
      {
        id: "FAKE-pdf",
        profileId: "profile-1",
        folderIds: [],
        displayName: "FAKE_Report.pdf",
        sourceLabel: "Manual import — unverified",
        mediaType: "application/pdf",
        plaintextSize: 2048,
        importedAtMs: 2,
        available: true,
      },
    );
    vi.mocked(result.bridge.hideRecord).mockImplementation(async (id) => {
      result.vault.records = result.vault.records.map((record) =>
        record.id === id
          ? { ...record, hidden: { atMs: 10, reason: "patient" as const } }
          : record,
      );
    });
    return result;
  }

  it("keeps a hidden camera photo when an older same-session shared refresh arrives", async () => {
    const user = userEvent.setup();
    const { bridge, vault, arrive } = photoRefreshVault();
    let holdNext = false;
    let releaseOld: (() => void) | undefined;
    const snapshot = vi.mocked(bridge.snapshot).mockImplementation(() => {
      const captured = captureSnapshot(vault);
      if (holdNext) {
        holdNext = false;
        return new Promise<VaultSnapshot>((resolve) => {
          releaseOld = () => resolve(captured);
        });
      }
      return Promise.resolve(captured);
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByText(humanText("FAKE_Camera.jpg"));
    expect(snapshot).toHaveBeenCalledTimes(1);

    // Received intake is outside run/busy and is a reachable second source of
    // snapshots. Empty focus/visibility notifications alone cannot do this.
    holdNext = true;
    arrive("FAKE_Incoming.pdf");
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(releaseOld).toBeTypeOf("function"));
    expect(bridge.acceptReceived).toHaveBeenCalledOnce();
    expect(
      vault.records.find((record) => record.id === "FAKE-photo")?.hidden,
    ).toBeUndefined();

    await user.click(screen.getByText(humanText("FAKE_Camera.jpg")));
    await user.click(screen.getByRole("button", { name: humanText("Hide") }));
    await screen.findByText(
      humanText(
        "FAKE_Camera.jpg was hidden. It stays in the vault under Hidden.",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Security" }));
    await user.click(
      screen.getByRole("button", { name: humanText(/^Hidden/) }),
    );
    expect(
      screen.getByRole("button", {
        name: humanText("Restore FAKE_Camera.jpg"),
      }),
    ).toBeVisible();
    await act(async () => releaseOld!());
    expect(
      vault.records.find((record) => record.id === "FAKE-photo")?.hidden
        ?.reason,
    ).toBe("patient");
    expect
      .soft(
        screen.queryByRole("button", {
          name: humanText("Restore FAKE_Camera.jpg"),
        }),
        "A late background refresh must not remove the hidden photo",
      )
      .toBeVisible();

    // Continue after the invariant failure to verify the user's later action:
    // a fresh PDF-hide snapshot reveals the already-committed hidden photo.
    await user.click(
      within(
        screen.getByRole("navigation", { name: humanText("Record library") }),
      ).getByRole("button", { name: humanText(/^My records/) }),
    );
    await user.click(screen.getByText(humanText("FAKE_Report.pdf")));
    await user.click(screen.getByRole("button", { name: humanText("Hide") }));
    await screen.findByText(
      humanText(
        "FAKE_Report.pdf was hidden. It stays in the vault under Hidden.",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Security" }));
    await user.click(
      screen.getByRole("button", { name: humanText(/^Hidden/) }),
    );
    expect(
      screen.getByRole("button", {
        name: humanText("Restore FAKE_Camera.jpg"),
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: humanText("Restore FAKE_Report.pdf"),
      }),
    ).toBeVisible();
    expect(bridge.hideRecord).toHaveBeenCalledTimes(2);
    expect(snapshot).toHaveBeenCalledTimes(4);
  });

  it("still applies an earlier successful refresh when a later refresh fails", async () => {
    const user = userEvent.setup();
    const { bridge, vault, arrive } = photoRefreshVault();
    let holdNext = false;
    let rejectNext = false;
    let releaseOld: (() => void) | undefined;
    vi.mocked(bridge.snapshot).mockImplementation(() => {
      if (rejectNext) {
        rejectNext = false;
        return Promise.reject({
          code: "storage",
          message: "FAKE interrupted snapshot response.",
        });
      }
      const captured = captureSnapshot(vault);
      if (holdNext) {
        holdNext = false;
        return new Promise<VaultSnapshot>((resolve) => {
          releaseOld = () => resolve(captured);
        });
      }
      return Promise.resolve(captured);
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByText(humanText("FAKE_Camera.jpg"));
    holdNext = true;
    arrive("FAKE_Incoming.pdf");
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(releaseOld).toBeTypeOf("function"));
    await user.click(screen.getByText(humanText("FAKE_Camera.jpg")));
    rejectNext = true;
    await user.click(screen.getByRole("button", { name: humanText("Hide") }));
    await waitFor(() =>
      expect(screen.getByRole("status")).not.toBeEmptyDOMElement(),
    );
    expect(screen.getByRole("status")).not.toHaveHumanTextContent("was hidden");
    expect(
      vault.records.find((record) => record.id === "FAKE-photo")?.hidden
        ?.reason,
    ).toBe("patient");
    await act(async () => releaseOld!());
    await user.click(
      within(
        screen.getByRole("navigation", { name: humanText("Record library") }),
      ).getByRole("button", { name: humanText(/^Shared with me/) }),
    );
    expect(
      await screen.findByText(humanText("FAKE_Incoming.pdf")),
    ).toBeVisible();
    expect(bridge.acceptReceived).toHaveBeenCalledOnce();
  });

  async function unlockWith(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await user.type(
      screen.getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
  }

  it.each(["same session", "after another unlock"] as const)(
    "counts shared intake only for the session whose refresh completed: %s",
    async (when) => {
      const user = userEvent.setup();
      const { bridge, vault, arrive } = sharedVault(["FAKE Patient"], [], {
        status: vi.fn().mockResolvedValue("unlocked"),
      });
      let holdNext = false;
      let finish: (() => void) | undefined;
      vi.mocked(bridge.snapshot).mockImplementation(() => {
        const captured = captureSnapshot(vault);
        if (!holdNext) return Promise.resolve(captured);
        holdNext = false;
        return new Promise<VaultSnapshot>((resolve) => {
          finish = () => resolve(captured);
        });
      });
      const complete = async () => {
        const reply = finish;
        finish = undefined;
        if (reply) await act(async () => reply());
      };
      onTestFinished(complete);
      render(<VaultApp bridge={bridge} />);
      await screen.findByRole("heading", { name: humanText("My records") });
      holdNext = true;
      arrive("FAKE_Before_lock.pdf");
      await act(async () => window.dispatchEvent(new Event("focus")));
      await waitFor(() => expect(finish).toBeTypeOf("function"));
      expect(bridge.acceptReceived).toHaveBeenCalledOnce();
      expect(vault.records).toHaveLength(1);

      if (when === "after another unlock") {
        let state: DocumentVisibilityState = "visible";
        const visibility = vi
          .spyOn(document, "visibilityState", "get")
          .mockImplementation(() => state);
        try {
          await act(async () => {
            state = "hidden";
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await screen.findByRole("heading", {
            name: humanText("Unlock your vault"),
          });
          await act(async () => {
            state = "visible";
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await user.type(
            screen.getByLabelText(humanText("Passphrase")),
            "river-azimuth-cobalt-sparrow-934",
          );
          await user.click(
            screen.getByRole("button", { name: humanText("Unlock") }),
          );
          await screen.findByRole("heading", { name: humanText("My records") });
          expect(
            screen.getByRole("button", { name: humanText("Shared with me") }),
          ).toBeVisible();
        } finally {
          visibility.mockRestore();
        }
      }

      await complete();
      const shared = screen.getByRole("button", {
        name: humanText(
          when === "same session" ? "Shared with me, 1 new" : "Shared with me",
        ),
      });
      await user.click(shared);
      expect(screen.getByText(humanText("FAKE_Before_lock.pdf"))).toBeVisible();
      expect(bridge.acceptReceived).toHaveBeenCalledOnce();
      expect(bridge.lock).toHaveBeenCalledTimes(
        when === "same session" ? 0 : 1,
      );
      expect(bridge.unlock).toHaveBeenCalledTimes(
        when === "same session" ? 0 : 1,
      );
    },
  );

  it("keeps shared files waiting while locked, puts them in Shared with me at unlock, and moves one to the person (#61)", async () => {
    const user = userEvent.setup();
    const { bridge } = sharedVault(
      ["Jamie"],
      ["FAKE_Bloodwork.pdf", "FAKE_Xray.pdf"],
    );
    render(<VaultApp bridge={bridge} />);

    // Whoever is looking on has not unlocked: a count, no names.
    expect(
      await screen.findByText(
        humanText(
          "2 shared files are waiting. Unlock and myCarlos asks first before adding them to Shared with me. If myCarlos closes first, they are not kept: share them again.",
        ),
      ),
    ).toBeVisible();
    expect(screen.queryByText(humanText("FAKE_Bloodwork.pdf"))).toBeNull();
    expect(bridge.acceptReceived).not.toHaveBeenCalled();

    await unlockWith(user);
    // Said once, politely; the folder says how many are new.
    expect(
      await screen.findByText(
        humanText("2 shared files were added to Shared with me."),
      ),
    ).toHaveAttribute("aria-live", "polite");
    expect(bridge.acceptReceived).toHaveBeenCalledOnce();
    const folder = screen.getByRole("button", {
      name: humanText("Shared with me, 2 new"),
    });
    // With one person it sits beside My records, at the top level and in no
    // one's records (Ben, 21 Oct); above the people, under Add document.
    const mine = within(
      screen.getByRole("navigation", { name: humanText("Record library") }),
    ).getByRole("button", { name: humanText(/^My records/) });
    expect(
      mine.compareDocumentPosition(folder) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    expect(folder.style.paddingLeft).toBe("");

    await user.click(folder);
    expect(
      await screen.findByRole("heading", { name: humanText("Shared with me") }),
    ).toBeVisible();
    expect(
      screen.getByText(
        humanText(/Move them into your folders whenever you like\./),
      ),
    ).toBeVisible();
    // Seen: no longer new.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: humanText("Shared with me") }),
      ).toBeVisible(),
    );
    // Nothing is made in it: the Add document menu is closed, and choosing from it leaves Shared
    // for the person's own folders first (see the sidebar tests).
    expect(
      screen.getByRole("button", { name: humanText("Add document") }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(humanText("New folder"))).toBeNull();

    await user.click(
      screen.getByRole("button", {
        name: humanText("Details for FAKE_Bloodwork.pdf"),
      }),
    );
    const details = screen.getByRole("dialog", {
      name: humanText("FAKE_Bloodwork.pdf"),
    });
    const moveTo = within(details).getByRole("combobox", {
      name: humanText("Move to"),
    });
    expect(
      within(moveTo)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Shared with me", "My records"]);
    await user.selectOptions(moveTo, "My records");
    // Choosing only picks where it goes; Move moves it (#91).
    expect(bridge.moveToPerson).not.toHaveBeenCalled();
    await user.click(
      within(details).getByRole("button", { name: humanText("Move") }),
    );
    expect(bridge.moveToPerson).toHaveBeenCalledWith(
      ["record-shared-1"],
      "profile-1",
      [],
    );
    expect(
      await screen.findByText(
        humanText("FAKE_Bloodwork.pdf moved to My records."),
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        screen.queryByRole("article", {
          name: humanText("FAKE_Bloodwork.pdf document"),
        }),
      ).toBeNull(),
    );
    expect(
      screen.getByRole("article", {
        name: humanText("FAKE_Xray.pdf document"),
      }),
    ).toBeVisible();
  });

  it.each([false, true])(
    "keeps Shared hidden documents restorable without mixing a person's Hidden list (phone: %s)",
    async (phone) => {
      if (phone) {
        await page.viewport(390, 844);
        onTestFinished(() => page.viewport(1100, 760));
      }
      const user = userEvent.setup();
      const { bridge, vault } = sharedVault(
        ["Jamie", "Morgan"],
        ["FAKE_Shared.pdf"],
      );
      vault.records.push({
        id: "hidden-jamie",
        profileId: "profile-1",
        folderIds: [],
        displayName: "FAKE_Jamie_hidden.pdf",
        sourceLabel: "Manual import — unverified",
        mediaType: "application/octet-stream",
        plaintextSize: 200,
        importedAtMs: 1,
        available: true,
        hidden: { atMs: 2, reason: "patient" },
      });
      vault.records.push({
        id: "active-morgan",
        profileId: "profile-2",
        folderIds: [],
        displayName: "FAKE_Morgan.pdf",
        sourceLabel: "Manual import — unverified",
        mediaType: "application/octet-stream",
        plaintextSize: 200,
        importedAtMs: 1,
        available: true,
      });
      vi.mocked(bridge.hideRecord).mockImplementation(async (id) => {
        vault.records.find((record) => record.id === id)!.hidden = {
          atMs: 3,
          reason: "patient",
        };
      });
      vi.mocked(bridge.unhideRecord).mockImplementation(async (id) => {
        vault.records.find((record) => record.id === id)!.hidden = null;
      });
      render(<VaultApp bridge={bridge} />);
      await unlockWith(user);
      expect(
        screen.queryByText(humanText("FAKE_Jamie_hidden.pdf")),
      ).not.toBeInTheDocument();
      const nav = () =>
        screen.getByRole("navigation", { name: humanText("Record library") });
      await user.click(
        within(nav()).getByRole("button", {
          name: humanText(/^Shared with me/),
        }),
      );
      await user.click(
        await screen.findByRole("button", {
          name: humanText("Details for FAKE_Shared.pdf"),
        }),
      );
      const details = screen.getByRole("dialog", {
        name: humanText("FAKE_Shared.pdf"),
      });
      await user.click(
        within(details).getByRole("button", { name: humanText("Hide") }),
      );
      await waitFor(() =>
        expect(bridge.hideRecord).toHaveBeenCalledWith("record-shared-1"),
      );
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(
        screen.queryByText(humanText("FAKE_Shared.pdf")),
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Security" }));
      await user.click(
        screen.getByRole("button", { name: humanText(/^Hidden/) }),
      );
      const row = await screen.findByRole("article", {
        name: humanText("FAKE_Shared.pdf, hidden"),
      });
      expect(
        within(row).getByText(humanText("Shared with me")),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("complementary", { hidden: true }),
      ).toHaveHumanTextContent("1 document · 0 folders");
      // Returning through Security and reopening Hidden retains Shared as its source.
      await user.click(screen.getByRole("button", { name: "Security" }));
      await user.click(
        screen.getByRole("button", { name: humanText(/^Hidden/) }),
      );
      const reopenedRow = screen.getByRole("article", {
        name: humanText("FAKE_Shared.pdf, hidden"),
      });
      expect(reopenedRow).toBeVisible();
      expect(
        within(reopenedRow).getByText(humanText("Shared with me")),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("complementary", { hidden: true }),
      ).toHaveHumanTextContent("1 document · 0 folders");
      expect(
        screen.queryByText(humanText("FAKE_Jamie_hidden.pdf")),
      ).not.toBeInTheDocument();
      await user.click(
        within(reopenedRow).getByRole("button", {
          name: humanText("Restore FAKE_Shared.pdf"),
        }),
      );
      await waitFor(() =>
        expect(bridge.unhideRecord).toHaveBeenCalledWith("record-shared-1"),
      );
      if (phone) {
        await user.click(
          within(
            screen.getByRole("navigation", { name: humanText("Section") }),
          ).getByRole("button", { name: humanText(/^Records/) }),
        );
      }
      await user.click(
        within(nav()).getByRole("button", {
          name: humanText(/^Shared with me/),
        }),
      );
      expect(
        await screen.findByRole("article", {
          name: humanText("FAKE_Shared.pdf document"),
        }),
      ).toBeVisible();
      await user.click(
        within(nav()).getByRole("button", { name: humanText(/^Jamie/) }),
      );
      await user.click(screen.getByRole("button", { name: "Security" }));
      await user.click(
        screen.getByRole("button", { name: humanText(/^Hidden/) }),
      );
      expect(
        await screen.findByRole("article", {
          name: humanText("FAKE_Jamie_hidden.pdf, hidden"),
        }),
      ).toBeVisible();
      expect(
        screen.queryByText(humanText("FAKE_Shared.pdf")),
      ).not.toBeInTheDocument();
    },
  );

  /** Files named by a program started with their path (Open with, a second launch): the patient is
   * asked before anything is stored (#133). */
  function openedWithVault(names: string[], shared: string[] = []) {
    const made = sharedVault(["Jamie"], [...names, ...shared]);
    const waiting = new Set(names);
    const list = vi.mocked(made.bridge.listReceived).getMockImplementation()!;
    let forgotten: string[] = [];
    vi.mocked(made.bridge.listReceived).mockImplementation(async () => {
      const listed = await list();
      return {
        ...listed,
        files: listed.files
          .filter((file) => !forgotten.includes(file.id))
          .map((file) => ({ ...file, needsConfirm: waiting.has(file.name) })),
      };
    });
    vi.mocked(made.bridge.discardReceived).mockImplementation(async (ids) => {
      forgotten = [...forgotten, ...ids];
      return ids.length;
    });
    return made;
  }

  it("asks before adding a file Open with named, stores nothing until Import, and adds exactly that file (#133)", async () => {
    const user = userEvent.setup();
    const { bridge, vault } = openedWithVault(["FAKE_Opened.pdf"]);
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await unlockWith(user);
    const dialog = await screen.findByRole("alertdialog", {
      name: humanText("Import FAKE_Opened.pdf into Shared with me?"),
    });
    // Nothing was stored while the question is open.
    expect(bridge.acceptReceived).not.toHaveBeenCalled();
    expect(vault.records).toEqual([]);
    await user.click(
      within(dialog).getByRole("button", { name: humanText("Import") }),
    );
    await waitFor(() => expect(bridge.acceptReceived).toHaveBeenCalledOnce());
    expect(bridge.acceptReceived).toHaveBeenCalledWith(["shared-1"]);
    expect(bridge.discardReceived).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        humanText("A shared file was added to Shared with me."),
      ),
    ).toBeVisible();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("a file that arrives while the question is open waits for its own question, and never changes the one on screen (#133)", async () => {
    const user = userEvent.setup();
    const { bridge } = openedWithVault(["FAKE_A.pdf", "FAKE_B.pdf"]);
    let arrived = false;
    const listed = vi.mocked(bridge.listReceived).getMockImplementation()!;
    vi.mocked(bridge.listReceived).mockImplementation(async () => {
      const all = await listed();
      return {
        ...all,
        files: all.files.filter(
          (file) => arrived || file.name === "FAKE_A.pdf",
        ),
      };
    });
    render(<VaultApp bridge={bridge} />);
    await unlockWith(user);
    const dialog = await screen.findByRole("alertdialog", {
      name: humanText("Import FAKE_A.pdf into Shared with me?"),
    });
    // B arrives now: the question under the cursor stays about A alone.
    arrived = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () =>
      window.dispatchEvent(new Event("mycarlos-received-changed")),
    );
    expect(
      screen.getByRole("alertdialog", {
        name: humanText("Import FAKE_A.pdf into Shared with me?"),
      }),
    ).toBe(dialog);
    expect(screen.queryByText(humanText("FAKE_B.pdf"))).not.toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: humanText("Import") }),
    );
    // Only A was confirmed; B is asked about on its own afterwards.
    await waitFor(() =>
      expect(bridge.acceptReceived).toHaveBeenCalledWith(["shared-1"]),
    );
    expect(bridge.acceptReceived).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("alertdialog", {
        name: humanText("Import FAKE_B.pdf into Shared with me?"),
      }),
    ).toBeVisible();
    expect(bridge.acceptReceived).toHaveBeenCalledTimes(1);
  });

  it("Cancel forgets the opened files and stores nothing, and the question does not come back (#133)", async () => {
    const user = userEvent.setup();
    const { bridge, vault } = openedWithVault(["FAKE_One.pdf", "FAKE_Two.pdf"]);
    render(<VaultApp bridge={bridge} />);
    await unlockWith(user);
    const dialog = await screen.findByRole("alertdialog", {
      name: humanText("Import 2 documents into Shared with me?"),
    });
    // Several files: one dialog that lists them.
    expect(within(dialog).getByText(humanText("FAKE_One.pdf"))).toBeVisible();
    expect(within(dialog).getByText(humanText("FAKE_Two.pdf"))).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", { name: humanText("Cancel") }),
    );
    await waitFor(() =>
      expect(bridge.discardReceived).toHaveBeenCalledWith([
        "shared-1",
        "shared-2",
      ]),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // Asked again (a focus, a new arrival): nothing is waiting, so nothing is asked or added.
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(bridge.acceptReceived).not.toHaveBeenCalled();
    expect(vault.records).toEqual([]);
  });

  it("keeps opened files waiting while locked, with only a count and no question, and asks after the unlock (#133)", async () => {
    const user = userEvent.setup();
    const { bridge } = openedWithVault(["FAKE_Opened.pdf"]);
    render(<VaultApp bridge={bridge} />);
    // Locked, as before: a count, no names, no question, nothing added.
    expect(
      await screen.findByText(
        humanText(
          "One shared file is waiting. Unlock and myCarlos asks first before adding it to Shared with me. If myCarlos closes first, it is not kept: share it again.",
        ),
      ),
    ).toBeVisible();
    expect(screen.queryByText(humanText("FAKE_Opened.pdf"))).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(bridge.acceptReceived).not.toHaveBeenCalled();
    await unlockWith(user);
    await screen.findByRole("alertdialog", {
      name: humanText("Import FAKE_Opened.pdf into Shared with me?"),
    });
    expect(bridge.acceptReceived).not.toHaveBeenCalled();
  });

  it("still adds a file shared from another app as it arrives, while asking only about the opened one (#133)", async () => {
    const user = userEvent.setup();
    const { bridge } = openedWithVault(
      ["FAKE_Opened.pdf"],
      ["FAKE_Shared.pdf"],
    );
    render(<VaultApp bridge={bridge} />);
    await unlockWith(user);
    await screen.findByRole("alertdialog", {
      name: humanText("Import FAKE_Opened.pdf into Shared with me?"),
    });
    // Only the shared file was taken, by its id; the opened one waits for the answer.
    await waitFor(() => expect(bridge.acceptReceived).toHaveBeenCalledOnce());
    expect(bridge.acceptReceived).toHaveBeenCalledWith(["shared-2"]);
  });

  it("with several people, keeps Shared with me outside everyone's records and moves the selected to one person (#61)", async () => {
    const user = userEvent.setup();
    const { bridge } = sharedVault(["Jamie", "Morgan"], ["FAKE_Xray.pdf"]);
    render(<VaultApp bridge={bridge} />);
    await unlockWith(user);
    const folder = await screen.findByRole("button", {
      name: humanText("Shared with me, 1 new"),
    });
    // Each person is a top-level entry, and Shared with me is one beside
    // them, before both and inside neither (Ben, 21 Oct).
    const sidebar = folder.closest("aside")!;
    const library = within(sidebar).getByRole("navigation", {
      name: humanText("Record library"),
    });
    const people = ["Jamie", "Morgan"].map((name) =>
      within(library).getByRole("button", {
        name: humanText(new RegExp(`^${name}`)),
      }),
    );
    for (const person of people)
      expect(
        person.compareDocumentPosition(folder) &
          Node.DOCUMENT_POSITION_PRECEDING,
      ).toBeTruthy();
    expect(folder.style.paddingLeft).toBe("");
    expect(
      screen.queryByRole("group", { name: humanText("Patient") }),
    ).toBeNull();

    await user.click(folder);
    expect(
      await screen.findByText(
        humanText(
          /They are in no one's records until you move each one to the person it is for\./,
        ),
      ),
    ).toBeVisible();
    // While it is open, no person is chosen.
    for (const person of people)
      expect(person).not.toHaveAttribute("aria-current");
    expect(
      within(sidebar).queryByText(humanText("Jamie"), {
        selector: ".brand small",
      }),
    ).toBeNull();
    // No person's path or picker above it.
    expect(
      within(screen.getByRole("main")).queryByRole("group", {
        name: humanText("Patient"),
      }),
    ).toBeNull();
    expect(
      within(screen.getByRole("main")).queryByRole("button", {
        name: humanText("My records"),
      }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: humanText("Select FAKE_Xray.pdf") }),
    );
    const moveSelected = screen.getByRole("combobox", {
      name: humanText("Move selected to"),
    });
    expect(
      within(moveSelected)
        .getAllByRole("group")
        .map((group) => group.getAttribute("label")),
    ).toEqual(["Jamie", "Morgan"]);
    await user.selectOptions(
      moveSelected,
      within(moveSelected).getByRole("option", {
        name: humanText("Morgan's records"),
      }),
    );
    await user.click(screen.getByRole("button", { name: humanText("Move") }));
    expect(bridge.moveToPerson).toHaveBeenCalledWith(
      ["record-shared-1"],
      "profile-2",
      [],
    );
    expect(
      await screen.findByText(
        humanText("FAKE_Xray.pdf moved to Morgan's records."),
      ),
    ).toBeVisible();
  });

  it("with several people, lists the open person's folders, and counts the whole vault while Shared with me is open (#61)", async () => {
    const user = userEvent.setup();
    const { bridge, vault } = sharedVault(
      ["Jamie", "Morgan"],
      ["FAKE_Xray.pdf"],
    );
    vault.folders.push({
      id: "folder-1",
      profileId: "profile-1",
      parentId: null,
      name: "FAKE Labs",
      createdAtMs: 1,
    });
    vault.records.push({
      id: "record-morgan",
      profileId: "profile-2",
      folderIds: [],
      displayName: "FAKE_Letter.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/pdf",
      plaintextSize: 2048,
      importedAtMs: 2,
      available: true,
    });
    render(<VaultApp bridge={bridge} />);
    await unlockWith(user);
    const shared = await screen.findByRole("button", {
      name: humanText("Shared with me, 1 new"),
    });
    const sidebar = shared.closest("aside")!;
    const library = within(sidebar).getByRole("navigation", {
      name: humanText("Record library"),
    });
    const footer = () => sidebar.querySelector(".storage small");
    const names = () =>
      Array.from(library.querySelectorAll(".native-nav-name")).map(
        (name) => name.textContent,
      );
    // Shared with me, the people, then Jamie's folders (the open person's); the footer counts Jamie's.
    expect(names()).toEqual(["Shared with me", "Jamie", "Morgan", "FAKE Labs"]);
    expect(footer()).toHaveHumanTextContent("0 documents · 1 folder");

    await user.click(shared);
    await screen.findByRole("heading", { name: humanText("Shared with me") });
    // The folders stay; the footer counts the whole vault, as it is no one's.
    expect(names()).toEqual(["Shared with me", "Jamie", "Morgan", "FAKE Labs"]);
    expect(footer()).toHaveHumanTextContent("2 documents · 1 folder");

    await user.click(
      within(library).getByRole("button", { name: humanText(/^Morgan/) }),
    );
    expect(footer()).toHaveHumanTextContent("1 document · 0 folders");
  });

  it("with several people, opens a person's records when one is chosen from Shared with me (#61)", async () => {
    const user = userEvent.setup();
    const { bridge } = sharedVault(["Jamie", "Morgan"], ["FAKE_Xray.pdf"]);
    render(<VaultApp bridge={bridge} />);
    await unlockWith(user);
    await user.click(
      await screen.findByRole("button", {
        name: humanText("Shared with me, 1 new"),
      }),
    );
    await screen.findByRole("heading", { name: humanText("Shared with me") });
    const library = screen.getByRole("navigation", {
      name: humanText("Record library"),
    });
    await user.click(
      within(library).getByRole("button", { name: humanText(/^Morgan/) }),
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: humanText("Morgan"),
      }),
    ).toBeVisible();
    expect(
      within(library).getByRole("button", { name: humanText(/^Morgan/) }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("moves filed and shared documents to another person's folder, while folders stay with their person", async () => {
    const user = userEvent.setup();
    const { bridge, vault } = sharedVault(
      ["Jamie", "Morgan"],
      ["FAKE_Scan.pdf"],
    );
    vault.folders.push({
      id: "folder-2",
      profileId: "profile-2",
      parentId: null,
      name: "FAKE School forms",
      createdAtMs: 1,
    });
    vault.folders.push({
      id: "folder-1",
      profileId: "profile-1",
      parentId: null,
      name: "FAKE Jamie folder",
      createdAtMs: 1,
    });
    vault.records.push({
      id: "record-jamie",
      profileId: "profile-1",
      folderIds: [],
      displayName: "FAKE_Jamie.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/pdf",
      plaintextSize: 2048,
      importedAtMs: 2,
      available: true,
    });
    render(<VaultApp bridge={bridge} />);
    await unlockWith(user);
    const library = () =>
      screen.getByRole("navigation", { name: humanText("Record library") });
    // A filed document can move to another person through the same drop path.
    const jamiesFile = await screen.findByRole("article", {
      name: humanText("FAKE_Jamie.pdf document"),
    });
    const kept = dragTransfer();
    fireDragEvent("dragstart", jamiesFile, { dataTransfer: kept });
    const morgan = within(library()).getByRole("button", {
      name: humanText(/^Morgan/),
    });
    fireDragEvent("dragover", morgan, { dataTransfer: kept });
    fireDragEvent("drop", morgan, { dataTransfer: kept });
    await waitFor(() =>
      expect(bridge.moveToPerson).toHaveBeenCalledWith(
        ["record-jamie"],
        "profile-2",
        [],
      ),
    );
    expect(
      vault.records.find((record) => record.id === "record-jamie")?.profileId,
    ).toBe("profile-2");
    expect(bridge.assignFoldersBatch).not.toHaveBeenCalled();
    // A folder still belongs to its original person.
    fireEvent.click(
      within(library()).getByRole("button", { name: humanText(/^Jamie/) }),
    );
    const folderDrag = dragTransfer();
    fireDragEvent(
      "dragstart",
      within(library()).getByRole("button", {
        name: humanText(/^FAKE Jamie folder/),
      }),
      { dataTransfer: folderDrag },
    );
    fireDragEvent("dragover", morgan, { dataTransfer: folderDrag });
    fireDragEvent("drop", morgan, { dataTransfer: folderDrag });
    expect(
      await screen.findByText(
        humanText(
          "Folders stay with their person. Move individual documents to another person instead.",
        ),
      ),
    ).toBeVisible();
    expect(bridge.moveToPerson).toHaveBeenCalledTimes(1);
    expect(bridge.updateFolder).not.toHaveBeenCalled();
    // Only the chosen person's folders are listed in the sidebar, so a document from Shared with me
    // cannot be dropped on another person's folder: it goes to the person (see the Shared test
    // above) and is filed from there, or from its details with Move to.
  });

  it.each([null, "folder-2"])(
    "moves a filed document from its details to another person, folder %s, only after Move",
    async (folderId) => {
      const user = userEvent.setup();
      const { bridge, vault } = sharedVault(["Jamie", "Morgan"], []);
      vault.folders.push({
        id: "folder-2",
        profileId: "profile-2",
        parentId: null,
        name: "FAKE Results",
        createdAtMs: 1,
      });
      vault.records.push({
        id: "filed",
        profileId: "profile-1",
        folderIds: [],
        displayName: "FAKE Filed.pdf",
        sourceLabel: "Manual import — unverified",
        mediaType: "application/octet-stream",
        plaintextSize: 2048,
        importedAtMs: 2,
        available: true,
      });
      render(<VaultApp bridge={bridge} />);
      await unlockWith(user);
      await user.click(
        await screen.findByRole("button", {
          name: humanText("Details for FAKE Filed.pdf"),
        }),
      );
      const details = screen.getByRole("dialog", {
        name: humanText("FAKE Filed.pdf"),
      });
      const destination = within(details).getByRole("combobox", {
        name: humanText("Move to"),
      });
      const move = within(details).getByRole("button", {
        name: humanText("Move"),
      });
      expect(destination).toHaveValue("profile-1|");
      expect(move).toBeDisabled();
      expect(
        within(destination).queryByRole("option", {
          name: humanText("Shared with me"),
        }),
      ).not.toBeInTheDocument();
      await user.selectOptions(destination, `profile-2|${folderId ?? ""}`);
      expect(bridge.moveToPerson).not.toHaveBeenCalled();
      await user.click(move);
      await waitFor(() =>
        expect(bridge.moveToPerson).toHaveBeenCalledExactlyOnceWith(
          ["filed"],
          "profile-2",
          folderId ? [folderId] : [],
        ),
      );
      expect(bridge.assignFolders).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(vault.records[0].profileId).toBe("profile-2");
      await user.click(
        within(
          screen.getByRole("navigation", { name: humanText("Record library") }),
        ).getByRole("button", { name: humanText(/^Morgan/) }),
      );
      if (folderId)
        await user.click(
          screen.getByRole("button", {
            name: humanText("FAKE Results, open folder"),
          }),
        );
      expect(
        await screen.findByRole("article", {
          name: humanText("FAKE Filed.pdf document"),
        }),
      ).toBeVisible();
    },
  );

  it.each([
    ["person", "profile-1", "My records"],
    ["shared", "shared-profile", "Shared with me"],
  ])(
    "shows the %s root location in document details with several people",
    async (scope, profileId, location) => {
      const user = userEvent.setup();
      const { bridge, vault } = sharedVault(["Jamie", "Morgan"], [], {
        status: vi.fn().mockResolvedValue("unlocked"),
      });
      vault.profiles.push({
        id: "shared-profile",
        displayName: "Shared with me",
        createdAtMs: 2,
      });
      vault.records.push({
        id: "root-record",
        profileId,
        folderIds: [],
        displayName: "FAKE_Root_Record.pdf",
        sourceLabel: "Manual import — unverified",
        mediaType: "application/pdf",
        plaintextSize: 2048,
        importedAtMs: 2,
        available: true,
      });
      render(<VaultApp bridge={bridge} />);
      if (scope === "shared") {
        await user.click(
          await screen.findByRole("button", {
            name: humanText(/^Shared with me/),
          }),
        );
      }
      await user.click(
        await screen.findByRole("button", {
          name: humanText("Details for FAKE_Root_Record.pdf"),
        }),
      );
      const details = screen.getByRole("dialog", {
        name: humanText("FAKE_Root_Record.pdf"),
      });
      const folder = within(details).getByText(humanText("Folder"), {
        selector: "dt",
      }).parentElement!;
      expect(within(folder).getByRole("definition")).toHaveHumanTextContent(
        location,
      );
      expect(
        within(details).getByRole("combobox", { name: humanText("Move to") }),
      ).toHaveValue(scope === "shared" ? "" : `${profileId}|`);
      expect(bridge.assignFolders).not.toHaveBeenCalled();
      expect(bridge.moveToPerson).not.toHaveBeenCalled();
    },
  );

  it("keeps same-person detail moves on the folder assignment path with several people", async () => {
    const user = userEvent.setup();
    const { bridge, vault } = sharedVault(["Jamie", "Morgan"], []);
    vault.folders.push({
      id: "folder-1",
      profileId: "profile-1",
      parentId: null,
      name: "FAKE Results",
      createdAtMs: 1,
    });
    vault.records.push({
      id: "filed",
      profileId: "profile-1",
      folderIds: [],
      displayName: "FAKE Filed.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/octet-stream",
      plaintextSize: 2048,
      importedAtMs: 2,
      available: true,
    });
    vi.mocked(bridge.assignFolders).mockImplementation(async (_id, folders) => {
      vault.records[0].folderIds = folders;
    });
    render(<VaultApp bridge={bridge} />);
    await unlockWith(user);
    await user.click(
      await screen.findByRole("button", {
        name: humanText("Details for FAKE Filed.pdf"),
      }),
    );
    const details = screen.getByRole("dialog", {
      name: humanText("FAKE Filed.pdf"),
    });
    const destination = within(details).getByRole("combobox", {
      name: humanText("Move to"),
    });
    await user.selectOptions(destination, "profile-1|folder-1");
    await user.click(
      within(details).getByRole("button", { name: humanText("Move") }),
    );
    await waitFor(() =>
      expect(bridge.assignFolders).toHaveBeenCalledExactlyOnceWith("filed", [
        "folder-1",
      ]),
    );
    expect(bridge.moveToPerson).not.toHaveBeenCalled();
    expect(details).toBeVisible();
    await waitFor(() => expect(destination).toHaveFocus());
    expect(destination).toHaveValue("profile-1|folder-1");
    expect(
      within(details).getByRole("button", { name: humanText("Move") }),
    ).toBeDisabled();
  });

  it("keeps a filed duplicate in its original person and reports that source", async () => {
    const user = userEvent.setup();
    const { bridge, vault } = sharedVault(["Jamie", "Morgan"], [], {
      moveToPerson: vi
        .fn()
        .mockResolvedValue({ moved: [], alreadyThere: ["FAKE Filed.pdf"] }),
    });
    vault.records.push({
      id: "filed",
      profileId: "profile-1",
      folderIds: [],
      displayName: "FAKE Filed.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/octet-stream",
      plaintextSize: 2048,
      importedAtMs: 2,
      available: true,
    });
    render(<VaultApp bridge={bridge} />);
    await unlockWith(user);
    await user.click(
      await screen.findByRole("button", {
        name: humanText("Details for FAKE Filed.pdf"),
      }),
    );
    const details = screen.getByRole("dialog", {
      name: humanText("FAKE Filed.pdf"),
    });
    await user.selectOptions(
      within(details).getByRole("combobox", { name: humanText("Move to") }),
      "profile-2|",
    );
    await user.click(
      within(details).getByRole("button", { name: humanText("Move") }),
    );
    expect(
      await within(details).findByText(
        humanText(
          "FAKE Filed.pdf was already in Morgan's records, so it stayed in Jamie's records.",
        ),
      ),
    ).toBeVisible();
    expect(vault.records[0].profileId).toBe("profile-1");
    expect(details).toBeVisible();
  });

  it("moves nothing when a drag in Shared with me is let go over the list, and moves to the folder it is dropped on (#61)", async () => {
    const user = userEvent.setup();
    const { bridge, vault } = sharedVault(["Jamie"], ["FAKE_Scan.pdf"]);
    vault.folders.push({
      id: "folder-1",
      profileId: "profile-1",
      parentId: null,
      name: "FAKE Labs",
      createdAtMs: 1,
    });
    render(<VaultApp bridge={bridge} />);
    await unlockWith(user);
    await user.click(
      await screen.findByRole("button", {
        name: humanText("Shared with me, 1 new"),
      }),
    );
    const file = await screen.findByRole("article", {
      name: humanText("FAKE_Scan.pdf document"),
    });
    // Let go where it started: abandoned, as anywhere else.
    const abandoned = dragTransfer();
    fireDragEvent("dragstart", file, { dataTransfer: abandoned });
    fireDragEvent("dragover", screen.getByRole("main"), {
      dataTransfer: abandoned,
    });
    fireDragEvent("drop", screen.getByRole("main"), {
      dataTransfer: abandoned,
    });
    fireDragEvent("dragend", file, { dataTransfer: abandoned });
    await act(async () => undefined);
    expect(bridge.moveToPerson).not.toHaveBeenCalled();
    expect(file).toBeVisible();

    // Dropped on the person's folder in the sidebar: it goes there.
    const moved = dragTransfer();
    fireDragEvent("dragstart", file, { dataTransfer: moved });
    const labs = within(
      screen.getByRole("navigation", { name: humanText("Record library") }),
    ).getByRole("button", { name: humanText(/FAKE Labs/) });
    fireDragEvent("dragover", labs, { dataTransfer: moved });
    fireDragEvent("drop", labs, { dataTransfer: moved });
    await waitFor(() =>
      expect(bridge.moveToPerson).toHaveBeenCalledWith(
        ["record-shared-1"],
        "profile-1",
        ["folder-1"],
      ),
    );
    expect(
      await screen.findByText(
        humanText("FAKE_Scan.pdf moved to My records, folder FAKE Labs."),
      ),
    ).toBeVisible();
  });

  it.each([false, true])(
    "imports a second share received before the first intake reply: %s",
    async (anotherShare) => {
      const user = userEvent.setup();
      const { bridge, vault, arrive } = sharedVault(
        ["FAKE Patient"],
        ["FAKE_First.pdf"],
        { status: vi.fn().mockResolvedValue("unlocked") },
      );
      const accept = vi.mocked(bridge.acceptReceived).getMockImplementation()!;
      const list = vi.mocked(bridge.listReceived).getMockImplementation()!;
      let finish: (() => void) | undefined;
      let listedSecond = false;
      vi.mocked(bridge.acceptReceived)
        .mockImplementationOnce(async () => {
          const committed = await accept();
          return new Promise<ReceivedAcceptOutcome>((resolve) => {
            finish = () => resolve(committed);
          });
        })
        .mockImplementation(accept);
      vi.mocked(bridge.listReceived).mockImplementation(async () => {
        const state = await list();
        if (state.files.some((file) => file.name === "FAKE_Second.pdf"))
          listedSecond = true;
        return state;
      });
      const complete = async () => {
        const reply = finish;
        finish = undefined;
        if (reply) await act(async () => reply());
      };
      onTestFinished(complete);
      render(<VaultApp bridge={bridge} />);
      await waitFor(() => expect(finish).toBeTypeOf("function"));
      expect(vault.records).toHaveLength(1);
      expect(bridge.acceptReceived).toHaveBeenCalledOnce();
      if (anotherShare) {
        arrive("FAKE_Second.pdf");
        await act(async () => window.dispatchEvent(new Event("focus")));
        await waitFor(() => expect(listedSecond).toBe(true));
        // The native first import is committed; only its reply is pending.
        // Its busy flag must serialize the two imports, then hand off the ask.
        expect(bridge.acceptReceived).toHaveBeenCalledOnce();
        expect(vault.records).toHaveLength(1);
      }
      await complete();
      await user.click(
        await screen.findByRole("button", {
          name: humanText(`Shared with me, ${anotherShare ? 2 : 1} new`),
        }),
      );
      expect(screen.getByText(humanText("FAKE_First.pdf"))).toBeVisible();
      if (anotherShare)
        expect(screen.getByText(humanText("FAKE_Second.pdf"))).toBeVisible();
      expect(bridge.acceptReceived).toHaveBeenCalledTimes(anotherShare ? 2 : 1);
      expect(bridge.lock).not.toHaveBeenCalled();
    },
  );

  it("waits for the next focus after a current intake storage refusal", async () => {
    const user = userEvent.setup();
    const { bridge, vault } = sharedVault(
      ["FAKE Patient"],
      ["FAKE_Waiting.pdf"],
      {
        status: vi.fn().mockResolvedValue("unlocked"),
      },
    );
    const accept = vi.mocked(bridge.acceptReceived).getMockImplementation()!;
    let rejectOld: ((error: unknown) => void) | undefined;
    vi.mocked(bridge.acceptReceived)
      .mockImplementationOnce(
        () =>
          new Promise<ReceivedAcceptOutcome>((_resolve, reject) => {
            rejectOld = reject;
          }),
      )
      .mockImplementation(accept);
    const refuse = async () => {
      const reject = rejectOld;
      rejectOld = undefined;
      if (reject) await act(async () => reject({ code: "storage" }));
    };
    onTestFinished(refuse);
    render(<VaultApp bridge={bridge} />);
    await waitFor(() => expect(bridge.acceptReceived).toHaveBeenCalledOnce());
    await refuse();
    expect(bridge.acceptReceived).toHaveBeenCalledOnce();
    expect(vault.records).toHaveLength(0);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await user.click(
      await screen.findByRole("button", {
        name: humanText("Shared with me, 1 new"),
      }),
    );
    expect(screen.getByText(humanText("FAKE_Waiting.pdf"))).toBeVisible();
    expect(bridge.acceptReceived).toHaveBeenCalledTimes(2);
    expect(bridge.lock).not.toHaveBeenCalled();
  });

  it.each(["same session", "after another unlock", "while locked"] as const)(
    "rechecks restored shared intake: %s",
    async (when) => {
      const user = userEvent.setup();
      const { bridge } = sharedVault(["FAKE Patient"], ["FAKE_Restored.pdf"], {
        status: vi.fn().mockResolvedValue("unlocked"),
      });
      const accept = vi.mocked(bridge.acceptReceived).getMockImplementation()!;
      const list = vi.mocked(bridge.listReceived).getMockImplementation()!;
      const unlock = vi.mocked(bridge.unlock).getMockImplementation()!;
      let taken = false;
      let unlockedAgain = false;
      let listedAfterUnlock = false;
      let listedRestored = false;
      let rejectOld: ((error: unknown) => void) | undefined;
      vi.mocked(bridge.acceptReceived)
        .mockImplementationOnce(() => {
          taken = true;
          return new Promise<ReceivedAcceptOutcome>((_resolve, reject) => {
            rejectOld = reject;
          });
        })
        .mockImplementation(accept);
      vi.mocked(bridge.listReceived).mockImplementation(async () => {
        const state = await list();
        if (unlockedAgain) listedAfterUnlock = true;
        if (!taken && vi.mocked(bridge.acceptReceived).mock.calls.length === 1)
          listedRestored = true;
        // Native received_accept takes files out of the waiting list, then
        // restores them before returning a failed attempt (received.rs).
        return taken ? { ...state, files: [] } : state;
      });
      vi.mocked(bridge.unlock).mockImplementation(async (passphrase) => {
        unlockedAgain = true;
        return unlock(passphrase);
      });
      const refuse = async () => {
        const reject = rejectOld;
        rejectOld = undefined;
        if (!reject) return;
        taken = false;
        await act(async () =>
          reject({ code: when === "same session" ? "storage" : "locked" }),
        );
      };
      onTestFinished(refuse);
      render(<VaultApp bridge={bridge} />);
      await waitFor(() => expect(bridge.acceptReceived).toHaveBeenCalledOnce());
      const unlockAgain = async () => {
        await user.type(
          screen.getByLabelText(humanText("Passphrase")),
          "river-azimuth-cobalt-sparrow-934",
        );
        await user.click(
          screen.getByRole("button", { name: humanText("Unlock") }),
        );
        await screen.findByRole("heading", { name: humanText("My records") });
      };

      if (when !== "same session") {
        let state: DocumentVisibilityState = "visible";
        const visibility = vi
          .spyOn(document, "visibilityState", "get")
          .mockImplementation(() => state);
        try {
          await act(async () => {
            state = "hidden";
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await screen.findByRole("heading", {
            name: humanText("Unlock your vault"),
          });
          await act(async () => {
            state = "visible";
            document.dispatchEvent(new Event("visibilitychange"));
          });
          if (when === "after another unlock") {
            await unlockAgain();
            await waitFor(() => expect(listedAfterUnlock).toBe(true));
          }
          expect(bridge.acceptReceived).toHaveBeenCalledOnce();
        } finally {
          visibility.mockRestore();
        }
      }

      await refuse();
      if (when === "same session") {
        // A current refusal waits for the next ask, without an automatic loop.
        expect(bridge.acceptReceived).toHaveBeenCalledOnce();
        expect(listedRestored).toBe(false);
        await act(async () => window.dispatchEvent(new Event("focus")));
      } else if (when === "while locked") {
        await waitFor(() => expect(listedRestored).toBe(true));
        expect(
          await screen.findByText(
            humanText(
              "One shared file is waiting. Unlock and myCarlos asks first before adding it to Shared with me. If myCarlos closes first, it is not kept: share it again.",
            ),
          ),
        ).toBeVisible();
        expect(document.body).not.toHaveTextContent("FAKE_Restored.pdf");
        expect(bridge.acceptReceived).toHaveBeenCalledOnce();
        await unlockAgain();
      }
      await user.click(
        await screen.findByRole("button", {
          name: humanText("Shared with me, 1 new"),
        }),
      );
      expect(screen.getByText(humanText("FAKE_Restored.pdf"))).toBeVisible();
      expect(bridge.acceptReceived).toHaveBeenCalledTimes(2);
      expect(bridge.lock).toHaveBeenCalledTimes(
        when === "same session" ? 0 : 1,
      );
      expect(bridge.unlock).toHaveBeenCalledTimes(
        when === "same session" ? 0 : 1,
      );
    },
  );

  it("lets no person be called Shared with me (#61)", async () => {
    const user = userEvent.setup();
    const { bridge } = sharedVault(["Jamie"], [], {
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText("Security") }),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Add profile") }),
    );
    const dialog = screen.getByRole("dialog", {
      name: humanText("Add profile"),
    });
    await user.type(
      within(dialog).getByLabelText(humanText("New profile name")),
      " shared WITH me ",
    );
    expect(within(dialog).getByRole("alert")).toHaveHumanTextContent(
      "Shared with me is where shared files go. Choose another name.",
    );
    expect(
      within(dialog).getByRole("button", { name: humanText("Add profile") }),
    ).toBeDisabled();
    expect(bridge.createProfile).not.toHaveBeenCalled();
  });

  it("discards a shared-file refusal name that arrives after Lock", async () => {
    const user = userEvent.setup();
    const privateName = "FAKE_Private_Patient_Result.jpg";
    const { bridge } = sharedVault(["Jamie"], [privateName], {
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    const accept = vi.mocked(bridge.acceptReceived).getMockImplementation()!;
    let releaseIntake!: () => void;
    const intake = new Promise<void>((resolve) => {
      releaseIntake = resolve;
    });
    vi.mocked(bridge.acceptReceived).mockImplementationOnce(async () => {
      await intake;
      return accept();
    });
    try {
      render(<VaultApp bridge={bridge} />);
      await screen.findByRole("heading", { name: humanText("My records") });
      await waitFor(() => expect(bridge.acceptReceived).toHaveBeenCalledOnce());
      expect(document.body).not.toHaveTextContent(privateName);

      // Intake runs in the background: Lock remains available while the
      // native reply containing this document name is still in flight.
      await user.click(windowLock());
      expect(
        await screen.findByLabelText(humanText("Passphrase")),
      ).toBeVisible();
      await act(async () => {
        releaseIntake();
        await intake;
      });
      expect(document.body).not.toHaveTextContent(privateName);
      expect(screen.getByLabelText(humanText("Passphrase"))).toBeVisible();
      expect(
        within(
          screen.getByLabelText(humanText("Passphrase")).closest("form")!,
        ).getByRole("status"),
      ).toHaveHumanTextContent("Vault locked.");

      await unlockWith(user);
      await screen.findByRole("heading", { name: humanText("My records") });
      await passAnnounceDelay();
      expect(document.body).not.toHaveTextContent(privateName);
      expect(screen.getByText(humanText(/^Vault unlocked\.$/))).toBeVisible();
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(bridge.unlock).toHaveBeenCalledOnce();
      expect(bridge.acceptReceived).toHaveBeenCalledOnce();
    } finally {
      await act(async () => {
        releaseIntake();
        await intake;
      });
    }
  });

  it("adds a file shared while the vault is open, and names one that is not a PDF (#61)", async () => {
    const user = userEvent.setup();
    const { bridge, arrive } = sharedVault(["Jamie"], ["FAKE_Letter.pdf"]);
    render(<VaultApp bridge={bridge} />);
    await unlockWith(user);
    await screen.findByRole("button", {
      name: humanText("Shared with me, 1 new"),
    });

    // A share arrives, and the window comes back to the front.
    arrive("FAKE_Photo.jpg");
    arrive("FAKE_Scan.pdf");
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(
      await screen.findByText(
        humanText(
          "FAKE_Photo.jpg is not a PDF document, so myCarlos did not add it. For now only PDF documents can be shared to myCarlos.",
        ),
      ),
    ).toBeVisible();
    expect(
      await screen.findByRole("button", {
        name: humanText("Shared with me, 2 new"),
      }),
    ).toBeVisible();
    expect(bridge.acceptReceived).toHaveBeenCalledTimes(2);
  });

  it("names a shared file that could no longer be opened and still adds the others (#61)", async () => {
    const user = userEvent.setup();
    const { bridge, arrive } = sharedVault(["Jamie"], ["FAKE_Letter.pdf"]);
    // Native forgets a file that was moved or deleted while the vault was locked, and names it.
    const accept = vi.mocked(bridge.acceptReceived);
    const normal = accept.getMockImplementation()!;
    accept.mockImplementation(async () => ({
      ...(await normal()),
      unreadable: ["FAKE_Gone.pdf"],
    }));
    render(<VaultApp bridge={bridge} />);
    await unlockWith(user);
    await screen.findByRole("button", {
      name: humanText("Shared with me, 1 new"),
    });
    arrive("FAKE_Scan.pdf");
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(
      await screen.findByText(
        humanText(
          "FAKE_Gone.pdf could not be opened or read, so myCarlos did not add it. Share it again if you still need it.",
        ),
      ),
    ).toBeVisible();
    expect(
      await screen.findByRole("button", {
        name: humanText("Shared with me, 2 new"),
      }),
    ).toBeVisible();
  });

  it("says when the waiting files could not be added for a reason of the vault's, and stays quiet for a lock (#61)", async () => {
    const user = userEvent.setup();
    const { bridge, arrive } = sharedVault(["Jamie"], ["FAKE_Letter.pdf"]);
    const normal = vi.mocked(bridge.acceptReceived).getMockImplementation()!;
    let failure: unknown = null;
    vi.mocked(bridge.acceptReceived).mockImplementation(async () => {
      if (failure) throw failure;
      return normal();
    });
    render(<VaultApp bridge={bridge} />);
    await unlockWith(user);
    await screen.findByRole("button", {
      name: humanText("Shared with me, 1 new"),
    });
    const focus = () =>
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
    // A lock is the vault closing: nothing is said.
    failure = { code: "locked", message: "FAKE locked" };
    arrive("FAKE_Scan.pdf");
    focus();
    await waitFor(() =>
      expect(vi.mocked(bridge.acceptReceived)).toHaveBeenCalledTimes(2),
    );
    expect(screen.queryByText("FAKE locked")).not.toBeInTheDocument();
    // Anything else keeps the files waiting and is said, not swallowed.
    failure = { code: "FAKE_unknown", message: "FAKE disk trouble" };
    focus();
    expect(await screen.findByText("FAKE disk trouble")).toBeVisible();
    // The files kept waiting: the next ask adds them.
    failure = null;
    focus();
    expect(
      await screen.findByRole("button", {
        name: humanText("Shared with me, 2 new"),
      }),
    ).toBeVisible();
  });

  function receiveGate<T>() {
    let resolve: (value: T) => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  const notifyArrival = () =>
    act(() => {
      window.dispatchEvent(new Event("mycarlos-received-changed"));
    });

  it("shows only the count for a second launch received while locked (#53)", async () => {
    const { bridge, arrive } = sharedVault(["Jamie"], []);
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: "Unlock your vault" });
    arrive("FAKE_Private_A.pdf");
    arrive("FAKE_Private_B.pdf");
    notifyArrival();
    expect(
      await screen.findByText(humanText(/2 shared files are waiting/)),
    ).toBeVisible();
    expect(screen.queryByText(/FAKE_Private/)).toBeNull();
    expect(bridge.acceptReceived).not.toHaveBeenCalled();
  });

  it("imports an arrival without any focus change (#53)", async () => {
    const { bridge, arrive } = sharedVault(["Jamie"], [], {
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: "My records" });
    arrive("FAKE_Already_focused.pdf");
    notifyArrival();
    await screen.findByRole("button", {
      name: humanText("Shared with me, 1 new"),
    });
    expect(bridge.acceptReceived).toHaveBeenCalledOnce();
    await userEvent.setup().click(
      screen.getByRole("button", {
        name: humanText("Shared with me, 1 new"),
      }),
    );
    expect(
      await screen.findByRole("button", { name: "FAKE_Already_focused.pdf" }),
    ).toBeVisible();
    // Shown as its status, then its source (#135): Unverified, Manual import.
    expect(screen.getAllByText(humanText("Unverified")).length).toBeGreaterThan(
      0,
    );
    expect(
      screen.getAllByText(humanText("Manual import")).length,
    ).toBeGreaterThan(0);
  });

  it("coalesces notifications and drains arrivals received during acceptance (#53)", async () => {
    const { bridge, arrive, vault } = sharedVault(["Jamie"], [], {
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: "My records" });
    const gate = receiveGate<void>();
    const accept = vi.mocked(bridge.acceptReceived).getMockImplementation()!;
    vi.mocked(bridge.acceptReceived).mockImplementationOnce(async () => {
      const outcome = await accept();
      await gate.promise;
      return outcome;
    });
    arrive("FAKE_First.pdf");
    notifyArrival();
    await waitFor(() => expect(bridge.acceptReceived).toHaveBeenCalledOnce());
    arrive("FAKE_Second.pdf");
    notifyArrival();
    notifyArrival();
    notifyArrival();
    expect(bridge.acceptReceived).toHaveBeenCalledOnce();
    await act(async () => gate.resolve());
    await screen.findByRole("button", {
      name: humanText("Shared with me, 2 new"),
    });
    expect(bridge.acceptReceived).toHaveBeenCalledTimes(2);
    expect(vault.records.map((record) => record.displayName)).toEqual([
      "FAKE_First.pdf",
      "FAKE_Second.pdf",
    ]);
  });

  it("keeps a failed share waiting without retrying until another notification (#53)", async () => {
    const { bridge, arrive } = sharedVault(["Jamie"], [], {
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: "My records" });
    await act(async () => undefined);
    vi.mocked(bridge.acceptReceived).mockRejectedValueOnce({ code: "storage" });
    arrive("FAKE_Retry.pdf");
    notifyArrival();
    await waitFor(() => expect(bridge.acceptReceived).toHaveBeenCalledOnce());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(bridge.acceptReceived).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", {
        name: humanText(/Shared with me, 1 new/),
      }),
    ).toBeNull();
    notifyArrival();
    await screen.findByRole("button", {
      name: humanText("Shared with me, 1 new"),
    });
    expect(bridge.acceptReceived).toHaveBeenCalledTimes(2);
  });

  it("defers hidden arrivals and never imports them while locked (#53)", async () => {
    const { bridge, arrive } = sharedVault(["Jamie"], []);
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: "Unlock your vault" });
    await act(async () => undefined);
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    onTestFinished(() => visibility.mockRestore());
    const calls = vi.mocked(bridge.listReceived).mock.calls.length;
    arrive("FAKE_Hidden.pdf");
    notifyArrival();
    expect(bridge.listReceived).toHaveBeenCalledTimes(calls);
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(
      await screen.findByText(humanText(/One shared file is waiting/)),
    ).toBeVisible();
    expect(screen.queryByText("FAKE_Hidden.pdf")).toBeNull();
    expect(bridge.acceptReceived).not.toHaveBeenCalled();
  });

  it("removes arrival listeners on unmount and ignores a late list (#53)", async () => {
    const { bridge } = sharedVault(["Jamie"], []);
    const view = render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: "Unlock your vault" });
    const gate =
      receiveGate<Awaited<ReturnType<VaultBridge["listReceived"]>>>();
    vi.mocked(bridge.listReceived).mockImplementationOnce(() => gate.promise);
    const calls = vi.mocked(bridge.listReceived).mock.calls.length;
    notifyArrival();
    await waitFor(() =>
      expect(bridge.listReceived).toHaveBeenCalledTimes(calls + 1),
    );
    view.unmount();
    notifyArrival();
    await act(async () =>
      gate.resolve({
        files: [
          {
            id: "late",
            name: "FAKE_Late.pdf",
            sourceLabel: "Manual import — unverified",
          },
        ],
        notice: { dropped: 0, refusedShares: 0 },
      }),
    );
    expect(bridge.listReceived).toHaveBeenCalledTimes(calls + 1);
    expect(bridge.acceptReceived).not.toHaveBeenCalled();
    expect(screen.queryByText("FAKE_Late.pdf")).toBeNull();
  });

  it("ignores a received snapshot from a replaced bridge (#53)", async () => {
    const first = sharedVault(["FAKE Old Person"], [], {
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    const view = render(<VaultApp bridge={first.bridge} />);
    await screen.findByRole("heading", { name: "My records" });
    const gate = receiveGate<VaultSnapshot>();
    vi.mocked(first.bridge.snapshot).mockImplementationOnce(() => gate.promise);
    first.arrive("FAKE_Old_bridge.pdf");
    notifyArrival();
    await waitFor(() =>
      expect(first.bridge.acceptReceived).toHaveBeenCalledOnce(),
    );
    await waitFor(() => expect(first.bridge.snapshot).toHaveBeenCalledTimes(2));
    const second = sharedVault(["FAKE New Person"], [], {
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    view.rerender(<VaultApp bridge={second.bridge} />);
    await waitFor(() => expect(second.bridge.snapshot).toHaveBeenCalled());
    await act(async () => gate.resolve(structuredClone(first.vault)));
    expect(
      screen.queryByRole("button", {
        name: humanText(/Shared with me, 1 new/),
      }),
    ).toBeNull();
    expect(screen.queryByText("FAKE_Old_bridge.pdf")).toBeNull();
    // The new bridge's one person is shown by their initials in the sidebar.
    expect(document.querySelector('[data-initials="FN"]')).not.toBeNull();
  });

  it("does not restore an old share notice or new badge after locking during refresh (#53)", async () => {
    const user = userEvent.setup();
    const shared = sharedVault(["Jamie"], [], {
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    render(<VaultApp bridge={shared.bridge} />);
    await screen.findByRole("heading", { name: "My records" });
    const gate = receiveGate<VaultSnapshot>();
    vi.mocked(shared.bridge.snapshot).mockImplementationOnce(
      () => gate.promise,
    );
    shared.arrive("FAKE_Finished_before_lock.pdf");
    notifyArrival();
    await waitFor(() =>
      expect(shared.bridge.snapshot).toHaveBeenCalledTimes(2),
    );
    await user.click(screen.getByRole("button", { name: /Lock now/ }));
    await screen.findByRole("heading", { name: "Unlock your vault" });
    await act(async () => gate.resolve(structuredClone(shared.vault)));
    expect(screen.queryByText("FAKE_Finished_before_lock.pdf")).toBeNull();
    await unlockWith(user);
    await screen.findByRole("button", { name: "Shared with me" });
    expect(
      screen.queryByRole("button", {
        name: humanText("Shared with me, 1 new"),
      }),
    ).toBeNull();
  });

  it.each(["accept", "snapshot", "snapshot failure"])(
    "holds a late shared %s outcome through a failed concealed lock until authorized unlock (#53)",
    async (delayed) => {
      const user = userEvent.setup();
      const shared = sharedVault(["Jamie"], [], {
        status: vi.fn().mockResolvedValue("unlocked"),
        lock: vi
          .fn()
          .mockRejectedValueOnce({ code: "storage" })
          .mockResolvedValue(undefined),
      });
      shared.vault.recoveryKeySetAtMs = 1;
      render(<VaultApp bridge={shared.bridge} />);
      await screen.findByRole("heading", { name: "My records" });
      const acceptGate = receiveGate<ReceivedAcceptOutcome>();
      const snapshotGate = receiveGate<VaultSnapshot>();
      let finished!: ReceivedAcceptOutcome;
      const accept = vi
        .mocked(shared.bridge.acceptReceived)
        .getMockImplementation()!;
      vi.mocked(shared.bridge.acceptReceived).mockImplementationOnce(
        async () => {
          finished = {
            ...(await accept()),
            skippedDuplicates: ["FAKE_Existing_duplicate.pdf"],
          };
          return delayed === "accept" ? acceptGate.promise : finished;
        },
      );
      if (delayed !== "accept")
        vi.mocked(shared.bridge.snapshot).mockImplementationOnce(
          () => snapshotGate.promise,
        );
      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("visible");
      onTestFinished(() => visibility.mockRestore());
      shared.arrive("FAKE_Saved.pdf");
      shared.arrive("FAKE_Private_result.jpg");
      notifyArrival();
      await waitFor(() =>
        expect(shared.bridge.acceptReceived).toHaveBeenCalledOnce(),
      );
      if (delayed !== "accept")
        await waitFor(() =>
          expect(shared.bridge.snapshot).toHaveBeenCalledTimes(2),
        );
      visibility.mockReturnValue("hidden");
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(await screen.findByRole("alert")).toHaveHumanTextContent(
        "Its content is hidden",
      );
      visibility.mockReturnValue("visible");
      await act(async () => {
        if (delayed === "accept") acceptGate.resolve(finished);
        else if (delayed === "snapshot failure")
          snapshotGate.reject({ code: "locked" });
        else snapshotGate.resolve(structuredClone(shared.vault));
      });
      const alert = screen.getByRole("alert");
      expect(alert).not.toHaveTextContent("FAKE_Private_result.jpg");
      expect(alert).not.toHaveTextContent("FAKE_Existing_duplicate.pdf");
      expect(
        screen.queryByText("A shared file was added to Shared with me."),
      ).toBeNull();
      expect(
        screen.queryByRole("button", {
          name: humanText(/Shared with me, 1 new/),
        }),
      ).toBeNull();
      expect(shared.bridge.acceptReceived).toHaveBeenCalledOnce();
      act(() =>
        fireEvent.click(
          screen.getByRole("button", { name: "Try locking again" }),
        ),
      );
      await screen.findByRole("heading", { name: "Unlock your vault" });
      expect(screen.queryByText(/FAKE_Private_result/)).toBeNull();
      await unlockWith(user);
      const result = await screen.findByText(
        humanText(/FAKE_Private_result.jpg is not a PDF document/),
      );
      expect(result).toHaveHumanTextContent(
        "FAKE_Existing_duplicate.pdf was already in Shared with me.",
      );
      expect(result).toHaveHumanTextContent(
        "A shared file was added to Shared with me.",
      );
      expect(
        screen.getAllByText(
          humanText(/FAKE_Private_result.jpg is not a PDF document/),
        ),
      ).toHaveLength(1);
      expect(shared.bridge.acceptReceived).toHaveBeenCalledOnce();
      expect(shared.vault.records.map((record) => record.displayName)).toEqual([
        "FAKE_Saved.pdf",
      ]);
      expect(
        screen.queryByRole("button", {
          name: humanText("Shared with me, 1 new"),
        }),
      ).toBeNull();
    },
  );

  it("does not carry a concealed share outcome into a replacement bridge (#53)", async () => {
    const user = userEvent.setup();
    const shared = sharedVault(["FAKE Old"], [], {
      status: vi.fn().mockResolvedValue("unlocked"),
      lock: vi.fn().mockRejectedValue({ code: "storage" }),
    });
    shared.vault.recoveryKeySetAtMs = 1;
    const view = render(<VaultApp bridge={shared.bridge} />);
    await screen.findByRole("heading", { name: "My records" });
    const gate = receiveGate<ReceivedAcceptOutcome>();
    const accept = vi
      .mocked(shared.bridge.acceptReceived)
      .getMockImplementation()!;
    let finished!: ReceivedAcceptOutcome;
    vi.mocked(shared.bridge.acceptReceived).mockImplementationOnce(async () => {
      finished = await accept();
      return gate.promise;
    });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    onTestFinished(() => visibility.mockRestore());
    shared.arrive("FAKE_Old_private.jpg");
    notifyArrival();
    await waitFor(() =>
      expect(shared.bridge.acceptReceived).toHaveBeenCalledOnce(),
    );
    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await screen.findByRole("alert");
    await act(async () => gate.resolve(finished));
    visibility.mockReturnValue("visible");
    const next = sharedVault(["FAKE New"], []);
    next.vault.recoveryKeySetAtMs = 1;
    view.rerender(<VaultApp bridge={next.bridge} />);
    await screen.findByRole("heading", { name: "Unlock your vault" });
    await unlockWith(user);
    await screen.findByRole("heading", { name: "My records" });
    await passAnnounceDelay();
    expect(screen.queryByText(/FAKE_Old_private/)).toBeNull();
    expect(next.bridge.acceptReceived).not.toHaveBeenCalled();
  });

  it("shows in Shared with me why nothing can be moved while changes are paused (#61)", async () => {
    const user = userEvent.setup();
    const { bridge, vault } = sharedVault(["Jamie"], [], {
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    vault.profiles.push({
      id: "shared-profile",
      displayName: "Shared with me",
      createdAtMs: 2,
    });
    vault.records.push({
      id: "record-1",
      profileId: "shared-profile",
      folderIds: [],
      displayName: "FAKE_Scan.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/octet-stream",
      plaintextSize: 2048,
      importedAtMs: 3,
      available: true,
    });
    vault.recovery = "writeFailed";
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText("Shared with me") }),
    );
    expect(
      await screen.findByText(humanText("Changes are paused.")),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: humanText("Details for FAKE_Scan.pdf"),
      }),
    );
    expect(
      within(
        screen.getByRole("dialog", { name: humanText("FAKE_Scan.pdf") }),
      ).getByRole("combobox", { name: humanText("Move to") }),
    ).toBeDisabled();
  });

  it("keeps photos in the photo viewer rather than offering the PDF reader", async () => {
    const user = userEvent.setup();
    const record = {
      id: "photo-1",
      profileId: "profile-1",
      folderIds: [],
      displayName: "FAKE_Photo.jpg",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/octet-stream",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: true,
    };
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () =>
          captureSnapshot({ ...emptySnapshot, records: [record] }),
        ),
      isPhoto: vi.fn().mockResolvedValue(true),
      viewPhoto: vi.fn().mockResolvedValue("data:image/jpeg;base64,FAKE"),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(await screen.findByText(humanText("FAKE_Photo.jpg")));
    const view = await screen.findByRole("button", {
      name: humanText("View photo"),
    });
    expect(
      screen.queryByRole("button", { name: humanText("Read") }),
    ).toBeNull();
    await user.click(view);
    expect(bridge.viewPhoto).toHaveBeenCalledWith("photo-1");
    expect(bridge.viewPage).not.toHaveBeenCalled();
  });

  it("reads a stored document inside myCarlos, then goes back to the library", async () => {
    const user = userEvent.setup();
    const record = {
      id: "record-1",
      profileId: "profile-1",
      folderIds: [],
      displayName: "FAKE_Letter.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/octet-stream",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: true,
    };
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () =>
          captureSnapshot({ ...emptySnapshot, records: [record] }),
        ),
      viewPage: vi.fn().mockResolvedValue({
        pageCount: 1,
        width: 800,
        height: 1035,
        image:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        text: "FAKE letter text",
      }),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(await screen.findByText(humanText("FAKE_Letter.pdf")));
    await user.click(screen.getByRole("button", { name: humanText("Read") }));
    const reader = await screen.findByRole("dialog", {
      name: humanText("FAKE_Letter.pdf"),
    });
    expect(
      await within(reader).findByRole("img", {
        name: humanText("Page 1 of 1. The page's text follows."),
      }),
    ).toBeVisible();
    expect(bridge.viewPage).toHaveBeenCalledWith(
      "record-1",
      0,
      expect.any(Number),
      undefined,
    );
    await user.click(
      within(reader).getByRole("button", { name: humanText("Back") }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("heading", { name: humanText("My records") }),
    ).toBeVisible();
  });

  it.each(["locked", "pdf_locked", "late-locked"] as const)(
    "distinguishes a native vault lock from a document password: %s",
    async (code) => {
      const user = userEvent.setup();
      let rejectPage: ((error: unknown) => void) | undefined;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        snapshot: vi
          .fn()
          .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
        unlock: vi
          .fn()
          .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
        viewPage: vi.fn(
          () =>
            new Promise<ViewedPage>((_resolve, reject) => {
              rejectPage = reject;
            }),
        ),
      });
      const refuse = async (failure: unknown) => {
        const reject = rejectPage;
        rejectPage = undefined;
        if (reject) await act(async () => reject(failure));
      };
      onTestFinished(async () => {
        await refuse({ code: "locked" });
      });
      render(<VaultApp bridge={bridge} />);
      await user.click(await screen.findByText(humanText("FAKE_Results.pdf")));
      await user.click(screen.getByRole("button", { name: humanText("Read") }));
      await waitFor(() =>
        expect(bridge.viewPage).toHaveBeenCalledExactlyOnceWith(
          "record-1",
          0,
          expect.any(Number),
          undefined,
        ),
      );
      if (code !== "late-locked")
        await refuse({ code, message: "FAKE page refused." });
      if (code === "late-locked") {
        let state: DocumentVisibilityState = "visible";
        const visibility = vi
          .spyOn(document, "visibilityState", "get")
          .mockImplementation(() => state);
        try {
          await act(async () => {
            state = "hidden";
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await screen.findByRole("heading", {
            name: humanText("Unlock your vault"),
          });
          await act(async () => {
            state = "visible";
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await user.type(
            screen.getByLabelText(humanText("Passphrase")),
            "river-azimuth-cobalt-sparrow-934",
          );
          await user.click(
            screen.getByRole("button", { name: humanText("Unlock") }),
          );
          await screen.findByRole("button", {
            name: humanText("FAKE_Results.pdf"),
          });
          await refuse({ code: "locked" });
          expect(bridge.lock).toHaveBeenCalledOnce();
          expect(bridge.unlock).toHaveBeenCalledOnce();
          expect(
            screen.getByRole("button", {
              name: humanText("FAKE_Results.pdf"),
            }),
          ).toBeVisible();
          expect(screen.queryByRole("dialog")).toBeNull();
        } finally {
          visibility.mockRestore();
        }
      } else if (code === "locked") {
        expect(
          await screen.findByRole("heading", {
            name: humanText("Unlock your vault"),
          }),
        ).toBeVisible();
        expect(bridge.lock).toHaveBeenCalledOnce();
        expect(document.body).not.toHaveTextContent("FAKE_Results.pdf");
      } else {
        const reader = screen.getByRole("dialog", {
          name: humanText("FAKE_Results.pdf"),
        });
        expect(
          await within(reader).findByLabelText(humanText("Document password")),
        ).toBeVisible();
        expect(bridge.lock).not.toHaveBeenCalled();
        expect(
          screen.queryByRole("heading", {
            name: humanText("Unlock your vault"),
          }),
        ).toBeNull();
      }
    },
  );

  it("closes the reader, and stops its page, when the vault locks", async () => {
    const user = userEvent.setup();
    const record = {
      id: "record-1",
      profileId: "profile-1",
      folderIds: [],
      displayName: "FAKE_Letter.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/pdf",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: true,
    };
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () =>
          captureSnapshot({ ...emptySnapshot, records: [record] }),
        ),
      // Still drawing when the lock comes.
      viewPage: vi.fn(() => new Promise<ViewedPage>(() => undefined)),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(await screen.findByText(humanText("FAKE_Letter.pdf")));
    await user.click(screen.getByRole("button", { name: humanText("Read") }));
    expect(
      await screen.findByRole("dialog", { name: humanText("FAKE_Letter.pdf") }),
    ).toBeVisible();
    await user.click(windowLock());
    expect(
      await screen.findByRole("heading", {
        name: humanText("Unlock your vault"),
      }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bridge.cancelView).toHaveBeenCalled();
  });

  it("keeps the bulk selection and destination after a refused move, then retries once", async () => {
    const user = userEvent.setup();
    let vault: VaultSnapshot = {
      ...snapshotWithRecord,
      folders: [
        {
          id: "letters",
          profileId: "profile-1",
          parentId: null,
          name: "FAKE Letters",
          createdAtMs: 2,
        },
      ],
      records: [
        snapshotWithRecord.records[0],
        {
          ...snapshotWithRecord.records[0],
          id: "record-2",
          displayName: "FAKE_Letter.pdf",
        },
      ],
    };
    const assignFoldersBatch = vi
      .fn<VaultBridge["assignFoldersBatch"]>()
      .mockRejectedValueOnce({
        code: "busy",
        message: "FAKE move was refused.",
      })
      .mockImplementationOnce(async (ids, folderIds) => {
        // Only the successful fake native mutation changes the returned snapshot.
        vault = {
          ...vault,
          records: vault.records.map((record) =>
            ids.includes(record.id) ? { ...record, folderIds } : record,
          ),
        };
      });
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn(async () => captureSnapshot(vault)),
      assignFoldersBatch,
    });
    render(<VaultApp bridge={bridge} />);
    for (const name of ["FAKE_Results.pdf", "FAKE_Letter.pdf"]) {
      await user.click(
        await screen.findByRole("button", {
          name: humanText(`Select ${name}`),
        }),
      );
    }
    await user.selectOptions(
      screen.getByLabelText(humanText("Move selected to")),
      "letters",
    );
    await user.click(screen.getByRole("button", { name: humanText("Move") }));
    expect(await screen.findByText("FAKE move was refused.")).toBeVisible();
    expect(assignFoldersBatch).toHaveBeenCalledOnce();
    expect(assignFoldersBatch).toHaveBeenLastCalledWith(
      ["record-1", "record-2"],
      ["letters"],
    );
    expect(screen.getByText(humanText("2 selected"))).toBeVisible();
    expect(screen.getByLabelText(humanText("Move selected to"))).toHaveValue(
      "letters",
    );
    for (const name of ["FAKE_Results.pdf", "FAKE_Letter.pdf"]) {
      expect(
        screen.getByRole("button", { name: humanText(`Select ${name}`) }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(
        vault.records.find((record) => record.displayName === name)?.folderIds,
      ).toEqual([]);
    }
    const retry = screen.getByRole("button", { name: humanText("Move") });
    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);
    await waitFor(() =>
      expect(
        screen.queryByLabelText(humanText("Move selected to")),
      ).not.toBeInTheDocument(),
    );
    expect(assignFoldersBatch.mock.calls).toEqual([
      [["record-1", "record-2"], ["letters"]],
      [["record-1", "record-2"], ["letters"]],
    ]);
    expect(
      screen.queryByText("FAKE move was refused."),
    ).not.toBeInTheDocument();
    for (const name of ["FAKE_Results.pdf", "FAKE_Letter.pdf"]) {
      expect(
        screen.queryByRole("article", { name: humanText(`${name} document`) }),
      ).not.toBeInTheDocument();
    }
    await user.click(
      screen.getByRole("button", {
        name: humanText("FAKE Letters, open folder"),
      }),
    );
    for (const name of ["FAKE_Results.pdf", "FAKE_Letter.pdf"]) {
      expect(
        screen.getByRole("article", { name: humanText(`${name} document`) }),
      ).toBeVisible();
    }
    expect(bridge.lock).not.toHaveBeenCalled();
  });

  it("presents durable records as a navigable filing cabinet", async () => {
    const user = userEvent.setup();
    const filingSnapshot: VaultSnapshot = {
      capture: { epoch: "00000000-0000-4000-8000-000000000185", sequence: 1 },
      profiles: [
        { id: "profile-1", displayName: "FAKE Avery Patient", createdAtMs: 1 },
      ],
      folders: [
        {
          id: "folder-1",
          profileId: "profile-1",
          parentId: null,
          name: "FAKE Test Results",
          createdAtMs: 2,
        },
        {
          id: "folder-2",
          profileId: "profile-1",
          parentId: null,
          name: "FAKE Letters",
          createdAtMs: 2,
        },
        {
          id: "folder-3",
          profileId: "profile-1",
          parentId: "folder-2",
          name: "FAKE 2025 Letters",
          createdAtMs: 2,
        },
      ],
      records: [
        {
          id: "record-root",
          profileId: "profile-1",
          folderIds: [],
          displayName: "FAKE_Root_Letter.pdf",
          sourceLabel: "Manual import — unverified",
          mediaType: "application/octet-stream",
          plaintextSize: 1024,
          importedAtMs: 3,
          available: true,
        },
        {
          id: "record-folder",
          profileId: "profile-1",
          folderIds: ["folder-1"],
          displayName: "FAKE_Bloodwork.pdf",
          sourceLabel: "Manual import — unverified",
          mediaType: "application/octet-stream",
          plaintextSize: 2048,
          importedAtMs: 4,
          available: true,
        },
      ],
      recovery: null,
    };
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(filingSnapshot)),
    });
    render(<VaultApp bridge={bridge} />);

    expect(
      await screen.findByRole("heading", { name: humanText("My records") }),
    ).toBeVisible();
    expect(screen.getByText(humanText("FAKE_Root_Letter.pdf"))).toBeVisible();
    expect(
      screen.queryByText(humanText("FAKE_Bloodwork.pdf")),
    ).not.toBeInTheDocument();

    const recordTransfer = dragTransfer();
    fireDragEvent(
      "dragstart",
      screen.getByRole("article", {
        name: humanText("FAKE_Root_Letter.pdf document"),
      }),
      { dataTransfer: recordTransfer },
    );
    const visibleFolder = screen.getByRole("article", {
      name: humanText("FAKE Test Results folder"),
    });
    const folderNavigation = screen.getByRole("navigation", {
      name: humanText("Record library"),
    });
    const sidebarFolder = within(folderNavigation).getByRole("button", {
      name: humanText(/FAKE Test Results/),
    });
    fireDragEvent("dragover", visibleFolder, { dataTransfer: recordTransfer });
    expect(visibleFolder).toHaveClass("native-drop-target");
    expect(sidebarFolder).not.toHaveClass("native-drop-target");
    fireDragEvent("drop", visibleFolder, { dataTransfer: recordTransfer });
    await waitFor(() =>
      expect(bridge.assignFoldersBatch).toHaveBeenCalledWith(
        ["record-root"],
        ["folder-1"],
      ),
    );

    const nestedTransfer = dragTransfer();
    fireDragEvent(
      "dragstart",
      screen.getByRole("article", {
        name: humanText("FAKE_Root_Letter.pdf document"),
      }),
      { dataTransfer: nestedTransfer },
    );
    const nestedSidebarFolder = within(folderNavigation).getByRole("button", {
      name: humanText(/FAKE 2025 Letters/),
    });
    fireDragEvent("dragover", nestedSidebarFolder, {
      dataTransfer: nestedTransfer,
    });
    fireDragEvent("drop", nestedSidebarFolder, {
      dataTransfer: nestedTransfer,
    });
    await waitFor(() =>
      expect(bridge.assignFoldersBatch).toHaveBeenCalledWith(
        ["record-root"],
        ["folder-3"],
      ),
    );

    const folderTransfer = dragTransfer();
    fireDragEvent(
      "dragstart",
      screen.getByRole("article", {
        name: humanText("FAKE Test Results folder"),
      }),
      { dataTransfer: folderTransfer },
    );
    fireDragEvent(
      "dragover",
      screen.getByRole("article", { name: humanText("FAKE Letters folder") }),
      { dataTransfer: folderTransfer },
    );
    fireDragEvent(
      "drop",
      screen.getByRole("article", { name: humanText("FAKE Letters folder") }),
      { dataTransfer: folderTransfer },
    );
    await waitFor(() =>
      expect(bridge.updateFolder).toHaveBeenCalledWith(
        "folder-1",
        "folder-2",
        "FAKE Test Results",
      ),
    );

    await user.click(
      screen.getByRole("button", {
        name: humanText("FAKE Test Results, open folder"),
      }),
    );
    expect(
      screen.getByRole("heading", { name: humanText("FAKE Test Results") }),
    ).toBeVisible();
    expect(screen.getByText(humanText("FAKE_Bloodwork.pdf"))).toBeVisible();

    const rootTransfer = dragTransfer();
    fireDragEvent(
      "dragstart",
      screen.getByRole("article", {
        name: humanText("FAKE_Bloodwork.pdf document"),
      }),
      { dataTransfer: rootTransfer },
    );
    const rootDropTarget = within(folderNavigation).getByRole("button", {
      name: humanText(/My records/),
    });
    fireDragEvent("dragover", rootDropTarget, { dataTransfer: rootTransfer });
    fireDragEvent("drop", rootDropTarget, { dataTransfer: rootTransfer });
    await waitFor(() =>
      expect(bridge.assignFoldersBatch).toHaveBeenCalledWith(
        ["record-folder"],
        [],
      ),
    );

    // The drag above made the same call, so only a call from here counts.
    vi.mocked(bridge.assignFoldersBatch).mockClear();
    await user.click(
      screen.getByRole("button", {
        name: humanText("Select FAKE_Bloodwork.pdf"),
      }),
    );
    await user.selectOptions(
      screen.getByLabelText(humanText("Move selected to")),
      "",
    );
    await user.click(screen.getByRole("button", { name: humanText("Move") }));
    await waitFor(() =>
      expect(bridge.assignFoldersBatch).toHaveBeenCalledWith(
        ["record-folder"],
        [],
      ),
    );

    await user.click(screen.getByText(humanText("FAKE_Bloodwork.pdf")));
    const shim = tauriConfirmShim();
    await user.click(
      screen.getByRole("button", {
        name: humanText("Save a copy to this device"),
      }),
    );
    const warning = screen.getByRole("alertdialog", {
      name: humanText("Save a readable copy?"),
    });
    expect(warning).toHaveHumanTextContent("cannot erase that copy");
    expect(
      screen.getByRole("button", { name: humanText("Cancel") }),
    ).toHaveFocus();
    await user.click(screen.getByRole("button", { name: humanText("Cancel") }));
    expect(bridge.pickExportDestination).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: humanText("FAKE_Bloodwork.pdf") }),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", {
        name: humanText("Save a copy to this device"),
      }),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Save a copy") }),
    );
    await waitFor(() =>
      expect(bridge.pickExportDestination).toHaveBeenCalledWith(
        "record-folder",
      ),
    );
    expect(shim).not.toHaveBeenCalled();
  });

  it.each(["list", "grid"])(
    "renames a nested folder in %s view without moving it",
    async (view) => {
      const user = userEvent.setup();
      const bridge = renameBridge();
      render(<VaultApp bridge={bridge} />);
      await user.click(
        await screen.findByRole("button", {
          name: humanText("FAKE Parent, open folder"),
        }),
      );
      if (view === "grid") await chooseToolbar(user, "View", "Grid");
      await user.click(
        screen.getByRole("button", {
          name: humanText("Rename folder FAKE Old folder"),
        }),
      );
      const dialog = screen.getByRole("dialog", {
        name: humanText("Rename folder"),
      });
      const input = within(dialog).getByLabelText(humanText("Folder name"));
      expect(input).toHaveFocus();
      await user.clear(input);
      await user.type(input, "   ");
      expect(
        within(dialog).getByRole("button", { name: humanText("Save name") }),
      ).toBeDisabled();
      await user.clear(input);
      await user.type(input, " FAKE Results ");
      await user.keyboard("{Enter}");
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(bridge.updateFolder).toHaveBeenCalledWith(
        "child",
        "parent",
        "FAKE Results",
      );
      expect(
        screen.getByRole("article", { name: humanText("FAKE Results folder") }),
      ).toBeVisible();
      expect(
        screen.getByRole("heading", { name: humanText("FAKE Parent") }),
      ).toBeVisible();
      expect(
        screen.queryByText(humanText("FAKE Old folder")),
      ).not.toBeInTheDocument();
    },
  );

  it("moves a document from its details only when Move is pressed", async () => {
    const user = userEvent.setup();
    const bridge = renameBridge();
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", {
        name: humanText("FAKE Parent, open folder"),
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: humanText("Details for FAKE Old.pdf"),
      }),
    );
    const details = screen.getByRole("dialog", {
      name: humanText("FAKE Old.pdf"),
    });
    const destination = within(details).getByRole("combobox", {
      name: humanText("Move to"),
    });
    const move = within(details).getByRole("button", {
      name: humanText("Move"),
    });
    expect(destination).toHaveValue("parent");
    expect(move).toBeDisabled();
    // Real arrow keys: Chromium changes a closed list's value on each press,
    // which used to move the document at once, once per press (#67).
    destination.focus();
    await realKeys.keyboard("{ArrowDown}{ArrowDown}");
    expect(destination).toHaveValue("child");
    expect(bridge.assignFolders).not.toHaveBeenCalled();
    expect(move).toBeEnabled();
    // Pressed from the keyboard: Move is disabled while it runs and after,
    // so focus goes back to "Move to", inside the dialog, not to the page.
    move.focus();
    await realKeys.keyboard("{Enter}");
    await waitFor(() =>
      expect(bridge.assignFolders).toHaveBeenCalledExactlyOnceWith("record", [
        "child",
      ]),
    );
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("dialog", { name: humanText("FAKE Old.pdf") }),
        ).getByRole("combobox", { name: humanText("Move to") }),
      ).toHaveFocus(),
    );
  });

  it("renames a document from its details, keeps failed input for retry, and supports cancellation", async () => {
    const user = userEvent.setup();
    const bridge = renameBridge();
    vi.mocked(bridge.renameRecord).mockRejectedValueOnce({
      message: "There is not enough storage to complete this operation.",
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", {
        name: humanText("FAKE Parent, open folder"),
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: humanText("Details for FAKE Old.pdf"),
      }),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Rename document") }),
    );
    await user.clear(screen.getByLabelText(humanText("File name")));
    await user.type(
      screen.getByLabelText(humanText("File name")),
      "FAKE Cancelled",
    );
    await user.click(screen.getByRole("button", { name: humanText("Cancel") }));
    expect(bridge.renameRecord).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: humanText("FAKE Old.pdf") }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: humanText("Rename document") }),
    );
    await user.clear(screen.getByLabelText(humanText("File name")));
    // The field holds the name before ".pdf", which the rename keeps.
    await user.type(
      screen.getByLabelText(humanText("File name")),
      "FAKE Results",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Save name") }),
    );
    expect(await screen.findByRole("alert")).toHaveHumanTextContent(
      "not enough storage",
    );
    expect(screen.getByLabelText(humanText("File name"))).toHaveValue(
      "FAKE Results",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Save name") }),
    );
    expect(
      await screen.findByRole("dialog", {
        name: humanText("FAKE Results.pdf"),
      }),
    ).toBeVisible();
    expect(bridge.renameRecord).toHaveBeenCalledWith(
      "record",
      "FAKE Results.pdf",
    );
    expect(bridge.assignFolders).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: humanText("Close document details") }),
    );
    expect(
      screen.getByRole("article", {
        name: humanText("FAKE Results.pdf document"),
      }),
    ).toBeVisible();
  });

  it("gives a rename's result to a status line already back on screen", async () => {
    const user = userEvent.setup();
    const bridge = renameBridge();
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", {
        name: humanText("FAKE Parent, open folder"),
      }),
    );

    // The document's details are replaced while it is renamed. Their status
    // line comes back empty, and the result is written into it after.
    await user.click(
      screen.getByRole("button", {
        name: humanText("Details for FAKE Old.pdf"),
      }),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Rename document") }),
    );
    await user.clear(screen.getByLabelText(humanText("File name")));
    await user.type(
      screen.getByLabelText(humanText("File name")),
      "FAKE Results",
    );
    // Fake timers from here, so that nothing is written before it is checked.
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: humanText("Save name") }),
        );
      });
      const details = screen.getByRole("dialog", {
        name: humanText("FAKE Results.pdf"),
      });
      const detailsStatus = within(details).getByRole("status");
      expect(detailsStatus).toBeEmptyDOMElement();
      await passAnnounceDelay();
      expect(detailsStatus).toHaveHumanTextContent(
        "Document renamed to FAKE Results.pdf.",
      );

      // The rename dialog makes the page inert. Its status line is written
      // to once the dialog has closed.
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: humanText("Close document details"),
          }),
        );
      });
      const pageStatus = screen.getByRole("status");
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: humanText("Rename folder FAKE Old folder"),
          }),
        );
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText(humanText("Folder name")), {
          target: { value: "FAKE Lab results" },
        });
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: humanText("Save name") }),
        );
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(pageStatus).toBeEmptyDOMElement();
      await passAnnounceDelay();
      expect(pageStatus).toHaveHumanTextContent(
        "Folder renamed to FAKE Lab results.",
      );

      // A result is not written into another document's details opened
      // before it was due.
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: humanText("Rename folder FAKE Lab results"),
          }),
        );
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText(humanText("Folder name")), {
          target: { value: "FAKE Old folder" },
        });
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: humanText("Save name") }),
        );
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: humanText("Details for FAKE Results.pdf"),
          }),
        );
      });
      await passAnnounceDelay();
      const otherDetails = screen.getByRole("dialog", {
        name: humanText("FAKE Results.pdf"),
      });
      expect(within(otherDetails).getByRole("status")).toBeEmptyDOMElement();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a rename's result while a confirmation opened at once is on screen", async () => {
    const user = userEvent.setup();
    const bridge = renameBridge();
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", {
        name: humanText("FAKE Parent, open folder"),
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: humanText("Details for FAKE Old.pdf"),
      }),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Rename document") }),
    );
    await user.clear(screen.getByLabelText(humanText("File name")));
    await user.type(
      screen.getByLabelText(humanText("File name")),
      "FAKE Results",
    );
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: humanText("Save name") }),
        );
      });
      // The confirmation replaces the details before the result is due.
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: humanText("Save a copy to this device"),
          }),
        );
      });
      await passAnnounceDelay();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: humanText("Cancel") }),
        );
      });
      const details = screen.getByRole("dialog", {
        name: humanText("FAKE Results.pdf"),
      });
      const status = within(details).getByRole("status");
      expect(status).toBeEmptyDOMElement();
      await passAnnounceDelay();
      expect(status).toHaveHumanTextContent(
        "Document renamed to FAKE Results.pdf.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  const RECOVERY_KEY = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345";

  it.each(["Escape", "button", "lock failure"])(
    "leaves first recovery setup safely using %s",
    async (how) => {
      const user = userEvent.setup();
      const lock = vi.fn().mockResolvedValue(undefined);
      if (how === "lock failure")
        lock.mockRejectedValueOnce({ code: "storage" });
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("absent"),
        beginRecoveryKey: vi.fn().mockResolvedValue(RECOVERY_KEY),
        lock,
      });
      render(<VaultApp bridge={bridge} />);
      await continuePastComfort();
      await user.type(
        await screen.findByLabelText(
          humanText("Whose records will you keep here?"),
        ),
        "FAKE Patient",
      );
      await user.type(
        screen.getByLabelText(humanText("Passphrase")),
        "river-azimuth-cobalt-sparrow-934",
      );
      await user.type(
        screen.getByLabelText(humanText("Confirm passphrase")),
        "river-azimuth-cobalt-sparrow-934",
      );
      const create = screen.getByRole("button", {
        name: humanText("Create vault"),
      });
      await user.click(create);
      const dialog = await screen.findByRole("dialog", {
        name: humanText("Your recovery key"),
      });
      expect((await axe.run(dialog)).violations).toEqual([]);
      if (how === "Escape") await user.keyboard("{Escape}");
      else
        await user.click(
          within(dialog).getByRole("button", {
            name: humanText("Lock vault and finish later"),
          }),
        );
      // Leaving the first setup is confirmed before the key is discarded.
      const confirm = await screen.findByRole("alertdialog", {
        name: humanText("Discard this recovery key?"),
      });
      expect((await axe.run(dialog)).violations).toEqual([]);
      expect(bridge.cancelRecoveryKey).not.toHaveBeenCalled();
      await user.click(
        within(confirm).getByRole("button", {
          name: humanText("Discard key and lock"),
        }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.queryByText(humanText("ABCD"))).toBeNull();
      expect(bridge.cancelRecoveryKey).toHaveBeenCalledOnce();
      expect(bridge.confirmRecoveryKey).not.toHaveBeenCalled();
      if (how === "lock failure") {
        expect(await screen.findByRole("alert")).toHaveHumanTextContent(
          "could not lock the vault",
        );
        await user.click(
          screen.getByRole("button", { name: humanText("Try locking again") }),
        );
      }
      await screen.findByRole("heading", {
        name: humanText("Unlock your vault"),
      });
      await user.type(
        screen.getByLabelText(humanText("Passphrase")),
        "river-azimuth-cobalt-sparrow-934",
      );
      await user.click(
        screen.getByRole("button", { name: humanText("Unlock") }),
      );
      expect(
        await screen.findByText(
          humanText(
            /Recovery key setup ended.*that key does not open the vault/,
          ),
        ),
      ).toBeVisible();
    },
  );

  it("says that details typed at setup were not saved once the recovery key dialog is done", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("absent"),
      beginRecoveryKey: vi.fn().mockResolvedValue(RECOVERY_KEY),
      updateProfileDetails: vi
        .fn()
        .mockRejectedValue({ code: "storage", message: "FAKE: not saved" }),
      snapshot: vi
        .fn()
        .mockImplementation(async () =>
          captureSnapshot({ ...emptySnapshot, recoveryKeySetAtMs: 5 }),
        ),
    });
    render(<VaultApp bridge={bridge} />);
    await continuePastComfort();
    await user.type(
      await screen.findByLabelText(
        humanText("Whose records will you keep here?"),
      ),
      "FAKE Patient",
    );
    await user.type(
      screen.getByLabelText(humanText("Full name, as on clinic documents")),
      "FAKE Patient Example",
    );
    enterBirthDate(birthDateGroup(), "1980-04-12");
    await user.type(
      screen.getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.type(
      screen.getByLabelText(humanText("Confirm passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Create vault") }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: humanText("Your recovery key"),
    });
    expect(bridge.updateProfileDetails).toHaveBeenCalledOnce();
    // Nothing is written under the dialog, where it would not be read out.
    expect(
      screen.queryByText(humanText(/weren't saved/)),
    ).not.toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", {
        name: humanText("Next: check your recovery key"),
      }),
    );
    await user.type(
      within(dialog).getByLabelText(humanText("Your recovery key")),
      RECOVERY_KEY,
    );
    await user.click(
      within(dialog).getByRole("button", { name: humanText("Check and save") }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    // The dialog's result says both: the key is saved, the details are not.
    expect(
      await screen.findByText(
        humanText(
          "Recovery key saved. Keep your kit somewhere safe. The vault is ready, but the full name and date of birth weren't saved. Add them in Edit details.",
        ),
      ),
    ).toBeVisible();
  });

  it("returns focus to the Security recovery setup button after Escape", async () => {
    const user = userEvent.setup();
    render(
      <VaultApp
        bridge={nativeBridge({ status: vi.fn().mockResolvedValue("unlocked") })}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: humanText(/Security/) }),
    );
    const opener = screen.getByRole("button", {
      name: humanText("Set up recovery key"),
    });
    await user.click(opener);
    expect(
      screen.getByRole("heading", { name: humanText("Set up a recovery key") }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("sets up a recovery key before anything else in a new vault", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("absent"),
      beginRecoveryKey: vi.fn().mockResolvedValue(RECOVERY_KEY),
      snapshot: vi
        .fn()
        .mockImplementation(async () =>
          captureSnapshot({ ...emptySnapshot, recoveryKeySetAtMs: 5 }),
        ),
    });
    render(<VaultApp bridge={bridge} />);
    await continuePastComfort();
    await user.type(
      await screen.findByLabelText(
        humanText("Whose records will you keep here?"),
      ),
      "FAKE Test Patient",
    );
    await user.type(
      screen.getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.type(
      screen.getByLabelText(humanText("Confirm passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Create vault") }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: humanText("Your recovery key"),
    });
    // The passphrase just typed authorizes the key.
    expect(bridge.beginRecoveryKey).toHaveBeenCalledWith(
      "river-azimuth-cobalt-sparrow-934",
    );
    // Leaving the first setup offers a lock, not entry to the library.
    expect(
      within(dialog).getByRole("button", {
        name: humanText("Lock vault and finish later"),
      }),
    ).toBeEnabled();
    expect(
      within(dialog).queryByRole("button", { name: humanText("Cancel") }),
    ).not.toBeInTheDocument();

    await user.click(
      within(dialog).getByRole("button", {
        name: humanText("Next: check your recovery key"),
      }),
    );
    await user.type(
      within(dialog).getByLabelText(humanText("Your recovery key")),
      RECOVERY_KEY,
    );
    await user.click(
      within(dialog).getByRole("button", { name: humanText("Check and save") }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(bridge.confirmRecoveryKey).toHaveBeenCalledOnce();
    expect(
      await screen.findByText(
        humanText("Recovery key saved. Keep your kit somewhere safe."),
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: humanText("Set up recovery key") }),
    ).not.toBeInTheDocument();
    // The button that led here is gone: focus is on the page, not on nothing.
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: humanText("My records") }),
      ).toHaveFocus(),
    );
  });

  it("says that a key shown in a setup that was cancelled does not work", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      beginRecoveryKey: vi.fn().mockResolvedValue(RECOVERY_KEY),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", {
        name: humanText("Set up recovery key"),
      }),
    );
    const dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(
      within(dialog).getByRole("button", { name: humanText("Continue") }),
    );
    await screen.findByRole("dialog", { name: humanText("Your recovery key") });
    await user.keyboard("{Escape}");
    expect(
      await screen.findByText(
        humanText(
          /setup was not finished\. The key you were shown does not open the vault\. Destroy/,
        ),
      ),
    ).toBeVisible();
  });

  it("clears a recovery form left unattended", async () => {
    vi.useFakeTimers();
    try {
      await act(async () => {
        render(<VaultApp bridge={nativeBridge()} />);
      });
      await act(async () => {
        fireEvent.click(screen.getByText(humanText("Forgot your passphrase?")));
      });
      const key = screen.getByLabelText(humanText("Recovery key"));
      await act(async () => {
        fireEvent.change(key, { target: { value: RECOVERY_KEY } });
        fireEvent.click(
          screen.getByRole("button", { name: humanText("Show recovery key") }),
        );
      });
      expect(key).toHaveAttribute("type", "text");
      await act(async () => {
        vi.advanceTimersByTime(5 * 60 * 1000);
      });
      expect(key).toHaveValue("");
      expect(key).toHaveAttribute("type", "password");
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers a recovery key when a vault without one is unlocked, and shows no key unasked", async () => {
    offerIsDue();
    const user = userEvent.setup();
    const bridge = nativeBridge({
      beginRecoveryKey: vi.fn().mockResolvedValue(RECOVERY_KEY),
    });
    render(<VaultApp bridge={bridge} />);
    await user.type(
      await screen.findByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    const dialog = await screen.findByRole("dialog", {
      name: humanText("Set up a recovery key"),
    });
    // It says why it is there, to a screen reader too.
    expect(dialog).toHaveHumanAccessibleDescription(
      /Your vault is open\. It has no recovery key yet.*Type your passphrase again to make your recovery key.*only when nobody else can see your screen/s,
    );
    // A press meant for Unlock that lands outside the dialog leaves it open.
    await user.pointer({
      keys: "[MouseLeft]",
      target: document.querySelector(".dialog-backdrop")!,
    });
    expect(dialog).toBeInTheDocument();
    // No key was made, and none is on screen.
    expect(bridge.beginRecoveryKey).not.toHaveBeenCalled();
    expect(
      screen.queryByText(humanText(RECOVERY_KEY.split("-")[0])),
    ).toBeNull();

    await user.click(
      within(dialog).getByRole("button", { name: humanText("Set up later") }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Nothing was shown, so there is nothing to warn about.
    expect(await screen.findByText(humanText("Vault unlocked."))).toBeVisible();
    expect(screen.queryByText(humanText(/setup was not finished/))).toBeNull();
    // The library still offers it.
    expect(
      screen.getByRole("button", { name: humanText("Set up recovery key") }),
    ).toBeVisible();
  });

  it("says how a key setup ended before it offers another", async () => {
    offerIsDue();
    // A first key's setup that a lock ended after the key was shown.
    window.localStorage.setItem(
      "mycarlos.unfinishedRecoveryKey.v1",
      JSON.stringify({ setAtMs: null }),
    );
    const user = userEvent.setup();
    render(<VaultApp bridge={nativeBridge()} />);
    await user.type(
      await screen.findByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    expect(
      await screen.findByText(
        humanText(
          /Recovery key setup ended when the vault locked or myCarlos closed, so the vault still has no recovery key\. If you saved or wrote down the key it showed, destroy it/,
        ),
      ),
    ).toBeVisible();
    // The offer waits: a dialog would hide what was just said. It is not
    // counted, so the next unlock makes it.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      window.localStorage.getItem("mycarlos.recoveryOfferHour.v1"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: humanText("Set up recovery key") }),
    ).toBeVisible();
  });

  it("offers a recovery key at unlock once a day, and the notice the rest of the time", async () => {
    offerIsDue();
    const user = userEvent.setup();
    render(<VaultApp bridge={nativeBridge()} />);
    const unlock = async () => {
      await user.type(
        await screen.findByLabelText(humanText("Passphrase")),
        "river-azimuth-cobalt-sparrow-934",
      );
      await user.click(
        screen.getByRole("button", { name: humanText("Unlock") }),
      );
      await screen.findByRole("heading", { name: humanText("My records") });
    };
    const lock = () =>
      user.click(screen.getByRole("button", { name: humanText(/Lock now/) }));

    await unlock();
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: humanText("Set up later"),
      }),
    );
    await lock();

    // Again the same day: the library opens, with its notice and no dialog.
    await unlock();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: humanText("Set up recovery key") }),
    ).toBeVisible();
    await lock();

    // A day later it is offered again.
    const hour = Number(
      window.localStorage.getItem("mycarlos.recoveryOfferHour.v1"),
    );
    forgetRecoveryOffer();
    window.localStorage.setItem(
      "mycarlos.recoveryOfferHour.v1",
      String(hour - 25),
    );
    await unlock();
    expect(
      await screen.findByRole("dialog", {
        name: humanText("Set up a recovery key"),
      }),
    ).toBeVisible();
  });

  it("sets up the key offered at unlock once the patient asks for it", async () => {
    offerIsDue();
    const user = userEvent.setup();
    const bridge = nativeBridge({
      beginRecoveryKey: vi.fn().mockResolvedValue(RECOVERY_KEY),
    });
    render(<VaultApp bridge={bridge} />);
    await user.type(
      await screen.findByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    const offer = await screen.findByRole("dialog", {
      name: humanText("Set up a recovery key"),
    });
    await user.type(
      within(offer).getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(
      within(offer).getByRole("button", { name: humanText("Continue") }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: humanText("Your recovery key"),
    });
    expect(bridge.beginRecoveryKey).toHaveBeenCalledExactlyOnceWith(
      "river-azimuth-cobalt-sparrow-934",
    );
    // Leaving now is leaving a key that was shown.
    await user.click(
      within(dialog).getByRole("button", { name: humanText("Set up later") }),
    );
    expect(
      await screen.findByText(
        humanText(/setup was not finished\. The key you were shown/),
      ),
    ).toBeVisible();
  });

  it.each([
    ["has a recovery key", { recoveryKeySetAtMs: 5 }],
    ["opened read-only", { recovery: "writeFailed" as const }],
  ])("opens no setup at unlock when the vault %s", async (_, state) => {
    offerIsDue();
    const user = userEvent.setup();
    const bridge = nativeBridge({
      unlock: vi
        .fn()
        .mockImplementation(async () =>
          captureSnapshot({ ...emptySnapshot, ...state }),
        ),
      snapshot: vi
        .fn()
        .mockImplementation(async () =>
          captureSnapshot({ ...emptySnapshot, ...state }),
        ),
    });
    render(<VaultApp bridge={bridge} />);
    await user.type(
      await screen.findByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    expect(
      await screen.findByRole("heading", { name: humanText("My records") }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a vault that locked before its key was made as locked", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("absent"),
      beginRecoveryKey: vi.fn().mockRejectedValue({
        code: "locked",
        message: "Unlock the vault to continue.",
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await continuePastComfort();
    await screen.findByRole("heading", {
      name: humanText("Set up myCarlos on this device"),
    });
    fireEvent.change(
      screen.getByLabelText(humanText("Whose records will you keep here?")),
      {
        target: { value: "Jamie" },
      },
    );
    for (const field of screen.getAllByLabelText(humanText(/passphrase/i))) {
      fireEvent.change(field, {
        target: { value: "river-azimuth-cobalt-sparrow-934" },
      });
    }
    await user.click(
      screen.getByRole("button", { name: humanText("Create vault") }),
    );
    expect(
      await screen.findByRole("heading", {
        name: humanText("Unlock your vault"),
      }),
    ).toBeVisible();
    expect(
      screen.getByText(
        humanText(/locked before its recovery key could be made/),
      ),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers a recovery key to a vault that has none", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", {
        name: humanText("Set up recovery key"),
      }),
    );
    const dialog = screen.getByRole("dialog", {
      name: humanText("Set up a recovery key"),
    });
    expect(within(dialog).getByRole("heading")).toHaveFocus();
    await user.click(
      within(dialog).getByRole("button", { name: humanText("Cancel") }),
    );
    expect(bridge.cancelRecoveryKey).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("tells the native save to leave the videos out only when the box is ticked", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      pickBackupDestination: vi.fn().mockResolvedValue("pick-3"),
      backupSize: vi.fn().mockResolvedValue({
        totalBytes: 5000,
        withoutVideosBytes: 1000,
        videoBytes: 4000,
        videoCount: 2,
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText(/Security/) }),
    );
    const save = () =>
      screen.getByRole("button", { name: humanText("Save encrypted backup…") });
    const box = await screen.findByRole("checkbox", {
      name: humanText(/Leave videos out/i),
    });
    // Left as it is, the backup holds everything: the native save is told so.
    await user.click(save());
    await waitFor(() =>
      expect(bridge.saveBackupToPicked).toHaveBeenLastCalledWith(
        "pick-3",
        false,
      ),
    );
    // Ticked, it is told to leave them out (this was dropped on the way before).
    await user.click(box);
    await user.click(save());
    await waitFor(() =>
      expect(bridge.saveBackupToPicked).toHaveBeenLastCalledWith(
        "pick-3",
        true,
      ),
    );
    expect(bridge.saveBackupToPicked).toHaveBeenCalledTimes(2);
  });

  it("saves an encrypted backup from Security as a transfer", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      pickBackupDestination: vi.fn().mockResolvedValue("pick-7"),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText(/Security/) }),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Save encrypted backup…") }),
    );
    expect(bridge.saveBackupToPicked).toHaveBeenCalledWith("pick-7", false);
    expect(
      await screen.findByText(
        humanText(
          "Encrypted backup saved. Keep it somewhere other than this device.",
        ),
      ),
    ).toBeVisible();
  });

  /** An unlocked vault, a hand-over dialog taken as far as the bridge call that writes or adds
   * (`which`: a person's records saved to a file, or a person added from one): that call stays
   * pending until `finish` or `fail`. A lock takes 50 ms; the page can be hidden. With
   * `withBackup` an encrypted backup (which runs through `run`) is also pending, started from
   * the Security page beneath the dialog. */
  async function handOverSavePending(
    which: "export" | "import" = "export",
    { withBackup = false }: { withBackup?: boolean } = {},
  ) {
    const user = userEvent.setup();
    let finishSave: (value: never) => void = () => {};
    let failSave: (error: unknown) => void = () => {};
    let finishBackup: (value: never) => void = () => {};
    const summaryOfOne = () => ({
      documents: 1,
      hidden: 0,
      folders: 0,
      aiAnswers: 0,
      withClinicEvidence: 0,
      leftOutDamaged: 0,
      evidenceLeftOut: 0,
      historyEntries: 0,
      plaintextBytes: 100,
    });
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      prepareProfileExport: vi.fn().mockResolvedValue({
        exportId: "export-1",
        generatedKey: "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345",
        summary: summaryOfOne(),
      }),
      pickProfileExportDestination: vi.fn().mockResolvedValue("pick-4"),
      saveProfileExportToPicked: vi.fn(
        () =>
          new Promise<SavedProfileExport>((resolve, reject) => {
            finishSave = resolve;
            failSave = reject;
          }),
      ),
      pickProfileImportSource: vi.fn().mockResolvedValue("pick-5"),
      profileImportKeyKind: vi.fn().mockResolvedValue("passphrase"),
      inspectProfileImport: vi.fn().mockResolvedValue({
        exportedAtMs: 1_700_000_000_000,
        displayName: "FAKE Robin",
        fullName: null,
        birthDate: null,
        documents: 1,
        hidden: 0,
        folders: 0,
        aiAnswers: 0,
        withClinicEvidence: 0,
        historyEntries: 0,
        plaintextBytes: 100,
        alreadyHere: null,
      }),
      importProfile: vi.fn(
        () =>
          new Promise<ProfileImportOutcome>((resolve, reject) => {
            finishSave = resolve;
            failSave = reject;
          }),
      ),
      pickBackupDestination: vi.fn().mockResolvedValue("pick-7"),
      saveBackupToPicked: vi.fn(
        () =>
          new Promise<SavedBackup>((resolve) => {
            finishBackup = resolve;
          }),
      ),
      lock: vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ),
    });
    let visibilityState: DocumentVisibilityState = "visible";
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibilityState);
    onTestFinished(() => visibility.mockRestore());
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText(/Security/) }),
    );
    if (which === "export") {
      await user.click(
        screen.getByRole("button", { name: humanText("Hand records over…") }),
      );
      const dialog = await screen.findByRole("dialog");
      await user.click(
        within(dialog).getByRole("button", { name: humanText("Continue") }),
      );
      await user.click(
        await within(dialog).findByRole("checkbox", {
          name: humanText(/I have written the key down/),
        }),
      );
      await user.click(
        within(dialog).getByRole("button", { name: humanText("Continue") }),
      );
      await user.click(
        within(dialog).getByRole("button", {
          name: humanText("Choose where to save…"),
        }),
      );
      await waitFor(() =>
        expect(bridge.saveProfileExportToPicked).toHaveBeenCalledWith("pick-4"),
      );
    } else {
      await user.click(
        screen.getByRole("button", {
          name: humanText("Add a person from a file…"),
        }),
      );
      const dialog = await screen.findByRole("dialog");
      await user.click(
        within(dialog).getByRole("button", {
          name: humanText("Choose the file…"),
        }),
      );
      await user.type(
        await within(dialog).findByLabelText(humanText(/^Passphrase/)),
        "FAKE passphrase of the file",
      );
      await user.click(
        within(dialog).getByRole("button", {
          name: humanText("Open the file"),
        }),
      );
      await user.click(
        await within(dialog).findByRole("button", {
          name: humanText("Add this person"),
        }),
      );
      await waitFor(() => expect(bridge.importProfile).toHaveBeenCalledOnce());
    }
    if (withBackup) {
      // Not reachable with a pointer under the dialog, and not offered while busy: this pins the
      // arithmetic of two operations running at once.
      fireEvent.click(
        screen.getByRole("button", {
          name: humanText("Save encrypted backup…"),
          hidden: true,
        }),
      );
      await waitFor(() =>
        expect(bridge.saveBackupToPicked).toHaveBeenCalledWith("pick-7"),
      );
    }
    const setVisibility = (state: DocumentVisibilityState) =>
      act(async () => {
        visibilityState = state;
        document.dispatchEvent(new Event("visibilitychange"));
      });
    const finish = () =>
      act(async () =>
        which === "export"
          ? finishSave({
              name: "FAKE.mycarloshandover",
              bytes: 10,
              summary: summaryOfOne(),
            } as SavedProfileExport as never)
          : finishSave({
              status: "alreadyHere",
              profileId: null,
              documents: 0,
              folders: 0,
              hidden: 0,
              aiAnswers: 0,
              aiAnswersDropped: 0,
              evidenceKept: 0,
              evidenceDropped: 0,
              historyEntries: 0,
            } as ProfileImportOutcome as never),
      );
    const fail = () =>
      act(async () => failSave({ code: "export_failed", message: "FAKE" }));
    const finishTheBackup = () =>
      act(async () =>
        finishBackup({ name: "FAKE.mycarlosbackup", bytes: 10 } as never),
      );
    return { bridge, setVisibility, finish, fail, finishTheBackup };
  }

  it.each(["export", "import"] as const)(
    "holds a lock while a hand-over %s is under way, then locks when it is done",
    async (which) => {
      const { bridge, setVisibility, finish } =
        await handOverSavePending(which);
      await setVisibility("hidden");
      // Locking now would cancel the write: content is hidden and the lock is owed.
      expect(bridge.lock).not.toHaveBeenCalled();
      expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();
      // Coming back does not show the library again: the lock is still owed.
      await setVisibility("visible");
      expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();
      await finish();
      await waitFor(() => expect(bridge.lock).toHaveBeenCalledOnce());
      expect(
        await screen.findByRole("heading", {
          name: humanText("Unlock your vault"),
        }),
      ).toBeVisible();
    },
  );

  it.each(["export", "import"] as const)(
    "a hand-over %s that fails frees the hold too: a page hidden afterwards locks, and one hidden meanwhile locks when it fails",
    async (which) => {
      const first = await handOverSavePending(which);
      await first.fail();
      await first.setVisibility("hidden");
      await waitFor(() => expect(first.bridge.lock).toHaveBeenCalledOnce());
      cleanup();
      const second = await handOverSavePending(which);
      await second.setVisibility("hidden");
      expect(second.bridge.lock).not.toHaveBeenCalled();
      await second.fail();
      await waitFor(() => expect(second.bridge.lock).toHaveBeenCalledOnce());
    },
  );

  it("owes the lock until the last of two operations is over, a backup and a hand-over together", async () => {
    const { bridge, setVisibility, finish, finishTheBackup } =
      await handOverSavePending("export", { withBackup: true });
    await setVisibility("hidden");
    expect(bridge.lock).not.toHaveBeenCalled();
    // The hand-over is over first: the backup is still being written.
    await finish();
    expect(bridge.lock).not.toHaveBeenCalled();
    await finishTheBackup();
    await waitFor(() => expect(bridge.lock).toHaveBeenCalledOnce());
  });

  it("locks a page hidden after an encrypted backup was written (the same shape through run)", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      pickBackupDestination: vi.fn().mockResolvedValue("pick-7"),
      lock: vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ),
    });
    let visibilityState: DocumentVisibilityState = "visible";
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibilityState);
    onTestFinished(() => visibility.mockRestore());
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText(/Security/) }),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Save encrypted backup…") }),
    );
    expect(bridge.saveBackupToPicked).toHaveBeenCalledWith("pick-7");
    await screen.findByText(humanText(/Encrypted backup saved/));
    await act(async () => {
      visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(bridge.lock).toHaveBeenCalledOnce());
  });

  it.each(["export", "import"] as const)(
    "locks a page hidden after the hand-over %s is done: it is over, nothing is owed",
    async (which) => {
      const { bridge, setVisibility, finish } =
        await handOverSavePending(which);
      await finish();
      await setVisibility("hidden");
      await waitFor(() => expect(bridge.lock).toHaveBeenCalledOnce());
    },
  );

  /** Every bridge method that runs a transfer, as `VaultApp` wraps it, with a bare call (not
   * inside `run`, the way a dialog that talks to the bridge itself calls it). A new transfer
   * added to the wrapper must be added here: the hold is only freed, and a lock owed only taken,
   * if the wrapper itself brackets the transfer. */
  const bareTransfers: [string, (bridge: VaultBridge) => Promise<unknown>][] = [
    ["saveBackupToPicked", (b) => b.saveBackupToPicked("pick-1")],
    ["saveProfileExportToPicked", (b) => b.saveProfileExportToPicked("pick-1")],
    [
      "importProfile",
      (b) => b.importProfile({ pickId: "pick-1", secret: "FAKE" } as never),
    ],
    [
      "importPickedFiles",
      (b) => b.importPickedFiles("pick-1", "profile-1", []),
    ],
    ["exportToPicked", (b) => b.exportToPicked("pick-1", "record-1")],
    [
      "exportTextToPicked",
      (b) =>
        b.exportTextToPicked("pick-1", "record-1", "ticket", "FAKE text", []),
    ],
  ];

  // The bridge methods that open a picker or write to a picked place, today. A new one has to be
  // added here, which is the moment to wrap it in `trackedBridge`.
  const EXPECTED_PICKED_NAMES = [
    "exportTextToPicked",
    "exportToPicked",
    "importPickedFiles",
    "pickBackupDestination",
    "pickExportDestination",
    "pickImportFiles",
    "pickProfileExportDestination",
    "pickProfileImportSource",
    "pickRestoreSource",
    "pickTextExportDestination",
    "saveBackupToPicked",
    "saveProfileExportToPicked",
  ];

  async function bareTransferPending(method: string) {
    let finish: (value: never) => void = () => {};
    let fail: (error: unknown) => void = () => {};
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      [method]: vi.fn(
        () =>
          new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
      ),
      lock: vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ),
    } as Partial<VaultBridge>);
    let visibilityState: DocumentVisibilityState = "visible";
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibilityState);
    onTestFinished(() => visibility.mockRestore());
    shown.bridge = null;
    render(<VaultApp bridge={bridge} />);
    await waitFor(() => expect(shown.bridge).not.toBeNull());
    const setVisibility = (state: DocumentVisibilityState) =>
      act(async () => {
        visibilityState = state;
        document.dispatchEvent(new Event("visibilitychange"));
      });
    return {
      bridge,
      tracked: shown.bridge as VaultBridge,
      setVisibility,
      finish: () => act(async () => finish(undefined as never)),
      fail: () =>
        act(async () => fail({ code: "export_failed", message: "FAKE" })),
    };
  }

  it.each(bareTransfers)(
    "a bare %s holds a lock that is owed while it runs and locks when it is done",
    async (method, call) => {
      const { bridge, tracked, setVisibility, finish } =
        await bareTransferPending(method);
      let settled = false;
      void call(tracked).then(() => (settled = true));
      await waitFor(() =>
        expect(bridge[method as keyof VaultBridge]).toHaveBeenCalled(),
      );
      await setVisibility("hidden");
      // Locking now would cut the transfer off: the lock is owed, not taken.
      expect(bridge.lock).not.toHaveBeenCalled();
      await finish();
      await waitFor(() => expect(settled).toBe(true));
      await waitFor(() => expect(bridge.lock).toHaveBeenCalledOnce());
    },
  );

  it.each(bareTransfers)(
    "a bare %s that fails frees the hold: a page hidden afterwards locks",
    async (method, call) => {
      const { bridge, tracked, setVisibility, fail } =
        await bareTransferPending(method);
      const failed = call(tracked).then(
        () => false,
        () => true,
      );
      await waitFor(() =>
        expect(bridge[method as keyof VaultBridge]).toHaveBeenCalled(),
      );
      await fail();
      expect(await failed).toBe(true);
      await setVisibility("hidden");
      await waitFor(() => expect(bridge.lock).toHaveBeenCalledOnce());
    },
  );

  it("does not lock under the picker an anonymized text's save opened: a page hidden while it is open is held, and locks when it closes", async () => {
    const { bridge, tracked, setVisibility, finish } =
      await bareTransferPending("pickTextExportDestination");
    let settled = false;
    void tracked
      .pickTextExportDestination("record-1", "ticket")
      .then(() => (settled = true));
    await waitFor(() =>
      expect(bridge.pickTextExportDestination).toHaveBeenCalledWith(
        "record-1",
        "ticket",
      ),
    );
    // On a phone the system's chooser sends the app to the background.
    await setVisibility("hidden");
    expect(bridge.lock).not.toHaveBeenCalled();
    // The chooser closes while the page is still hidden: only then is the vault locked.
    await finish();
    await waitFor(() => expect(settled).toBe(true));
    await waitFor(() => expect(bridge.lock).toHaveBeenCalledOnce());
  });

  it("passes the text export's arguments through unchanged, and keeps the text and its ranges for the native re-check", async () => {
    const { bridge, tracked } = await bareTransferPending("exportTextToPicked");
    const kept = [{ start: 1, end: 4 }];
    void tracked.exportTextToPicked(
      "pick-9",
      "record-9",
      "ticket-9",
      "FAKE text 9",
      kept as never,
    );
    await waitFor(() =>
      expect(bridge.exportTextToPicked).toHaveBeenCalledWith(
        "pick-9",
        "record-9",
        "ticket-9",
        "FAKE text 9",
        kept,
      ),
    );
  });

  it("wraps every picker and every call that writes to a picked place: none is passed through raw", async () => {
    const { bridge, tracked } = await bareTransferPending(
      "pickTextExportDestination",
    );
    // By identity against the raw bridge the app was given: a method re-spread from it unchanged
    // (as the text export's were) is the same function.
    const names = Object.keys(bridge).filter((name) =>
      /^pick|Picked/.test(name),
    );
    const raw = names.filter(
      (name) =>
        (tracked as unknown as Record<string, unknown>)[name] ===
        (bridge as unknown as Record<string, unknown>)[name],
    );
    expect(raw).toEqual([]);
    // The check looks at something: these are the ones that exist today.
    expect(names.sort()).toEqual(EXPECTED_PICKED_NAMES);
  });

  it("leaves copying an anonymized text to the clipboard bare: it is instant, so a page hidden while it runs locks at once", async () => {
    const { bridge, tracked, setVisibility, finish } =
      await bareTransferPending("copyTextExport");
    void tracked.copyTextExport("record-1", "ticket", "FAKE text", []);
    await waitFor(() => expect(bridge.copyTextExport).toHaveBeenCalled());
    await setVisibility("hidden");
    await waitFor(() => expect(bridge.lock).toHaveBeenCalledOnce());
    await finish();
  });

  it("names the damaged document that stopped a backup", async () => {
    const user = userEvent.setup();
    const recordId = snapshotWithRecord.records[0].id;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
      pickBackupDestination: vi.fn().mockResolvedValue("pick-7"),
      saveBackupToPicked: vi.fn().mockRejectedValue({
        code: "damaged_document",
        message: "A document in the vault is damaged.",
        recordId,
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText(/Security/) }),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Save encrypted backup…") }),
    );
    expect(
      await screen.findByText(
        humanText(
          /^No backup was saved: the document "FAKE_Results\.pdf" \(added [^)]+\) is damaged and can no longer be read/,
        ),
      ),
    ).toBeVisible();
  });

  it("restores a backup on a device with no vault, and leaves it locked", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("absent"),
      pickRestoreSource: vi.fn().mockResolvedValue("pick-3"),
      inspectRestore: vi.fn().mockResolvedValue({
        replaces: "nothing",
        differsFromThisDevice: false,
        documentCount: 4,
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await continuePastComfort();
    await user.click(
      await screen.findByText(humanText("Restore from a backup")),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Choose backup file…") }),
    );
    await user.type(
      await screen.findByLabelText(humanText("Backup passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Check backup") }),
    );
    await user.click(
      await screen.findByRole("button", { name: humanText("Restore backup") }),
    );
    expect(bridge.restore).toHaveBeenCalledWith(
      "pick-3",
      { passphrase: "river-azimuth-cobalt-sparrow-934" },
      false,
    );
    expect(
      await screen.findByRole("heading", {
        name: humanText("Unlock your vault"),
      }),
    ).toBeVisible();
    // The screen opens on it, so the field that takes focus says it.
    expect(
      screen.getByLabelText(humanText("Passphrase")),
    ).toHaveHumanAccessibleDescription(
      /^0 character passphrase Backup restored\./,
    );
  });

  it("restores over a locked vault, and leaves focus in the Passphrase field", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      pickRestoreSource: vi.fn().mockResolvedValue("pick-4"),
      inspectRestore: vi.fn().mockResolvedValue({
        replaces: "sameVault",
        differsFromThisDevice: false,
        documentCount: 4,
      }),
    });
    // A key setup the last lock ended, in the vault being replaced.
    const unfinished = "mycarlos.unfinishedRecoveryKey.v1";
    window.localStorage.setItem(unfinished, JSON.stringify({ setAtMs: 5 }));
    // And steps for the replaced vault's older backups.
    const guide = "mycarlos.oldBackupsGuide.v1";
    window.localStorage.setItem(guide, JSON.stringify({ step: "save" }));
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByText(humanText("Restore from a backup")),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Choose backup file…") }),
    );
    await user.type(
      await screen.findByLabelText(humanText("Backup passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Check backup") }),
    );
    await user.click(
      await screen.findByRole("button", { name: humanText("Restore backup") }),
    );
    expect(
      await screen.findByText(humanText(/^Backup restored\./)),
    ).toBeVisible();
    // The button that was pressed is gone with the form.
    expect(screen.getByLabelText(humanText("Passphrase"))).toHaveFocus();
    // Its outcome would be told of the restored vault, wrongly.
    expect(window.localStorage.getItem(unfinished)).toBeNull();
    expect(window.localStorage.getItem(guide)).toBeNull();
  });

  it("forgets a key setup's outcome when a restore will finish at the next start", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      pickRestoreSource: vi.fn().mockResolvedValue("pick-4"),
      inspectRestore: vi.fn().mockResolvedValue({
        replaces: "sameVault",
        differsFromThisDevice: false,
        documentCount: 4,
      }),
      restore: vi.fn().mockRejectedValue({
        code: "restore_unfinished",
        message: "The backup was checked, but restoring it has not finished.",
      }),
    });
    const unfinished = "mycarlos.unfinishedRecoveryKey.v1";
    window.localStorage.setItem(unfinished, JSON.stringify({ setAtMs: 5 }));
    // And steps for the replaced vault's older backups.
    const guide = "mycarlos.oldBackupsGuide.v1";
    window.localStorage.setItem(guide, JSON.stringify({ step: "save" }));
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByText(humanText("Restore from a backup")),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Choose backup file…") }),
    );
    await user.type(
      await screen.findByLabelText(humanText("Backup passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Check backup") }),
    );
    await user.click(
      await screen.findByRole("button", { name: humanText("Restore backup") }),
    );
    expect(
      await screen.findByText(humanText(/restoring it has not finished/)),
    ).toBeVisible();
    // The vault it was told of is the one the next start replaces.
    expect(window.localStorage.getItem(unfinished)).toBeNull();
    expect(window.localStorage.getItem(guide)).toBeNull();
  });

  // Opens recovery key setup from Security, as far as the key step, in a
  // vault whose recovery key was set up at `setAtMs`. The app can then be
  // hidden, which locks it, and unlocked again.
  async function showKeyInSetup(
    setAtMs: number | null,
    overrides: Partial<VaultBridge> = {},
    exposed = true,
  ) {
    const user = userEvent.setup();
    const vault = { ...emptySnapshot, recoveryKeySetAtMs: setAtMs };
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockImplementation(async () => captureSnapshot(vault)),
      unlock: vi.fn().mockImplementation(async () => captureSnapshot(vault)),
      beginRecoveryKey: vi.fn().mockResolvedValue(RECOVERY_KEY),
      ...overrides,
    });
    let visibilityState: DocumentVisibilityState = "visible";
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibilityState);
    onTestFinished(() => visibility.mockRestore());
    const view = render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText("Security") }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: humanText(
          setAtMs ? "Replace recovery key" : "Set up recovery key",
        ),
      }),
    );
    const dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    // Replacing asks why: whether the old kit may have been lost or seen.
    if (setAtMs)
      await user.click(
        within(dialog).getByLabelText(
          humanText(
            exposed
              ? "Its kit or note may have been lost, or seen by someone else"
              : "I just want a new key: its kit is safe",
          ),
        ),
      );
    await user.click(
      within(dialog).getByRole("button", { name: humanText("Continue") }),
    );
    expect(
      await screen.findByRole("dialog", {
        name: humanText("Your recovery key"),
      }),
    ).toHaveHumanTextContent("leaving or locking cancels this key");
    const setVisibility = (state: DocumentVisibilityState) =>
      act(async () => {
        visibilityState = state;
        document.dispatchEvent(new Event("visibilitychange"));
      });
    const hide = async () => {
      await setVisibility("hidden");
      await setVisibility("visible");
    };
    const unlock = async () => {
      await user.type(
        await screen.findByLabelText(humanText("Passphrase")),
        "river-azimuth-cobalt-sparrow-934",
      );
      await user.click(
        screen.getByRole("button", { name: humanText("Unlock") }),
      );
    };
    const typeKeyBack = async () => {
      const keyStep = screen.getByRole("dialog", {
        name: humanText("Your recovery key"),
      });
      await user.click(
        within(keyStep).getByRole("button", {
          name: humanText("Next: check your recovery key"),
        }),
      );
      await user.type(
        within(keyStep).getByLabelText(humanText("Your recovery key")),
        RECOVERY_KEY,
      );
      await user.click(
        within(keyStep).getByRole("button", {
          name: humanText("Check and save"),
        }),
      );
    };
    return { user, bridge, view, hide, setVisibility, unlock, typeKeyBack };
  }

  it("conceals a recovery key when its current label request reports a locked vault", async () => {
    let finishLabel!: (label: string) => void;
    let failLabel!: (error: unknown) => void;
    const pendingLabel = new Promise<string>((resolve, reject) => {
      finishLabel = resolve;
      failLabel = reject;
    });
    const { bridge } = await showKeyInSetup(5, {
      recoveryKeyLabel: vi.fn().mockReturnValue(pendingLabel),
    });
    try {
      expect(bridge.recoveryKeyLabel).toHaveBeenCalledOnce();
      expect(bridge.lock).not.toHaveBeenCalled();
      await act(async () => failLabel({ code: "locked" }));
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(
        await screen.findByLabelText(humanText("Passphrase")),
      ).toBeVisible();
      expect(
        screen.queryByRole("dialog", { name: humanText("Your recovery key") }),
      ).toBeNull();
      expect(document.querySelector(".recovery-key-groups")).toBeNull();
    } finally {
      await act(async () => finishLabel("FAKE"));
    }
  });

  it("conceals the current recovery key before acknowledging a native locked label", async () => {
    let failLabel!: (failure: unknown) => void;
    const pendingLabel = new Promise<string>((_resolve, reject) => {
      failLabel = reject;
    });
    let finishLock!: () => void;
    let acknowledged = false;
    const locking = new Promise<void>((resolve) => {
      finishLock = () => {
        acknowledged = true;
        resolve();
      };
    });
    try {
      const { bridge } = await showKeyInSetup(5, {
        recoveryKeyLabel: vi.fn().mockReturnValue(pendingLabel),
        lock: vi.fn().mockReturnValue(locking),
      });
      const groups = document.querySelector(".recovery-key-groups");
      expect(groups).toBeVisible();
      expect(bridge.lock).not.toHaveBeenCalled();
      expect(document.visibilityState).toBe("visible");

      // Native already reports Locked. This read, not hiding/focusing the app,
      // must conceal current content while the follow-up lock IPC still waits.
      await act(async () => failLabel({ code: "locked" }));
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(acknowledged).toBe(false);
      expect(document.visibilityState).toBe("visible");
      expect(groups).not.toBeVisible();
      expect(document.querySelector(".recovery-key-groups")).toBeNull();
      expect(
        screen.queryByRole("dialog", { name: humanText("Your recovery key") }),
      ).toBeNull();
      expect(
        screen.getByText(
          humanText("Vault content is hidden while myCarlos finishes locking…"),
        ),
      ).toBeVisible();
      expect(screen.queryByLabelText(humanText("Passphrase"))).toBeNull();

      await act(async () => finishLock());
      expect(
        await screen.findByLabelText(humanText("Passphrase")),
      ).toBeVisible();
      expect(document.querySelector(".recovery-key-groups")).toBeNull();
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(bridge.confirmRecoveryKey).not.toHaveBeenCalled();
    } finally {
      await act(async () => finishLock());
    }
  });

  it("does not relock a new session when an earlier label request reports locked", async () => {
    let finishLabel!: (label: string) => void;
    let failLabel!: (error: unknown) => void;
    const pendingLabel = new Promise<string>((resolve, reject) => {
      finishLabel = resolve;
      failLabel = reject;
    });
    const { bridge, hide, unlock } = await showKeyInSetup(5, {
      recoveryKeyLabel: vi.fn().mockReturnValue(pendingLabel),
    });
    try {
      await hide();
      await unlock();
      expect(
        await screen.findByRole("heading", { name: humanText("My records") }),
      ).toBeVisible();
      expect(bridge.lock).toHaveBeenCalledOnce();
      await act(async () => failLabel({ code: "locked" }));
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("heading", { name: humanText("My records") }),
      ).toBeVisible();
    } finally {
      await act(async () => finishLabel("FAKE"));
    }
  });

  it("does not relock a new session when an earlier recovery setup reports locked", async () => {
    let finishBegin!: (key: string) => void;
    let failBegin!: (error: unknown) => void;
    const pendingBegin = new Promise<string>((resolve, reject) => {
      finishBegin = resolve;
      failBegin = reject;
    });
    const vault = { ...emptySnapshot, recoveryKeySetAtMs: 5 };
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockImplementation(async () => captureSnapshot(vault)),
      unlock: vi.fn().mockImplementation(async () => captureSnapshot(vault)),
      beginRecoveryKey: vi.fn().mockReturnValue(pendingBegin),
    });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    onTestFinished(() => visibility.mockRestore());
    const user = userEvent.setup();
    render(<VaultApp bridge={bridge} />);
    try {
      await user.click(
        await screen.findByRole("button", { name: humanText("Security") }),
      );
      await user.click(
        screen.getByRole("button", { name: humanText("Replace recovery key") }),
      );
      const dialog = screen.getByRole("dialog");
      await user.type(
        within(dialog).getByLabelText(humanText("Passphrase")),
        "river-azimuth-cobalt-sparrow-934",
      );
      await user.click(
        within(dialog).getByLabelText(
          humanText("I just want a new key: its kit is safe"),
        ),
      );
      await user.click(
        within(dialog).getByRole("button", { name: humanText("Continue") }),
      );
      expect(bridge.beginRecoveryKey).toHaveBeenCalledOnce();
      visibility.mockReturnValue("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await screen.findByLabelText(humanText("Passphrase"));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(bridge.lock).toHaveBeenCalledOnce();
      visibility.mockReturnValue("visible");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await user.type(
        screen.getByLabelText(humanText("Passphrase")),
        "river-azimuth-cobalt-sparrow-934",
      );
      await user.click(
        screen.getByRole("button", { name: humanText("Unlock") }),
      );
      expect(
        await screen.findByRole("heading", { name: humanText("My records") }),
      ).toBeVisible();
      // The old IPC result belongs to the setup that ended at the first lock.
      await act(async () => failBegin({ code: "locked" }));
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("heading", { name: humanText("My records") }),
      ).toBeVisible();
    } finally {
      await act(async () => finishBegin(RECOVERY_KEY));
    }
  });

  it("conceals a printed recovery key before a hidden app's native lock finishes", async () => {
    let finishLock!: () => void;
    const locking = new Promise<void>((resolve) => {
      finishLock = resolve;
    });
    onTestFinished(() => finishLock());
    // No afterprint arrives: the app can be hidden before printing finishes.
    // This checks the webview DOM, not the operating system's print buffers.
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    onTestFinished(() => print.mockRestore());
    const { user, bridge, view, setVisibility } = await showKeyInSetup(5, {
      lock: vi.fn().mockReturnValue(locking),
    });
    const printButton = screen.getByRole("button", {
      name: humanText("Print recovery kit"),
    });
    await waitFor(() => expect(printButton).toBeEnabled());
    await user.click(printButton);
    expect(print).toHaveBeenCalledOnce();
    // This secret-bearing portal lives outside the library's own subtree.
    expect(
      document.querySelector("body > .recovery-kit-print"),
    ).toHaveTextContent(RECOVERY_KEY);
    expect(document.body).toHaveClass("printing-recovery-kit");

    await setVisibility("hidden");
    expect(bridge.lock).toHaveBeenCalledOnce();
    expect(
      screen.getByText(
        humanText("Vault content is hidden while myCarlos finishes locking…"),
      ),
    ).toBeVisible();
    expect(screen.queryByLabelText(humanText("Passphrase"))).toBeNull();
    const expectKeyAbsent = () => {
      expect(document.querySelector(".recovery-kit-print")).toBeNull();
      expect(document.querySelector(".recovery-key-groups")).toBeNull();
      expect(document.body).not.toHaveTextContent(RECOVERY_KEY);
      expect(document.body).not.toHaveClass("printing-recovery-kit");
      expect(
        screen.queryByRole("dialog", { name: humanText("Your recovery key") }),
      ).toBeNull();
    };
    expectKeyAbsent();
    // A late completion cannot restore the key while acknowledgement waits.
    await act(async () => {
      window.dispatchEvent(new Event("afterprint"));
    });
    expectKeyAbsent();

    await act(async () => finishLock());
    await setVisibility("visible");
    expect(await screen.findByLabelText(humanText("Passphrase"))).toBeVisible();
    expectKeyAbsent();
    expect(print).toHaveBeenCalledOnce();
    expect(bridge.lock).toHaveBeenCalledOnce();
    expect(bridge.confirmRecoveryKey).not.toHaveBeenCalled();
    expect(bridge.saveRecoveryKit).not.toHaveBeenCalled();
    await act(async () => view.unmount());
  });

  it.each([
    [
      "first",
      null,
      /^Vault unlocked\. Recovery key setup ended when the vault locked or myCarlos closed, so the vault still has no recovery key\. If you saved or wrote down the key it showed, destroy it/,
    ],
    [
      "replacement",
      5,
      /^Vault unlocked\. Your recovery key was not replaced: setup ended when the vault locked or myCarlos closed, and your earlier key still works\./,
    ],
  ])(
    "says after the next unlock that a lock ended a %s key's setup",
    async (_, setAtMs, said) => {
      const { hide, unlock } = await showKeyInSetup(setAtMs);
      // The app is hidden, which locks it, with the key on screen.
      await hide();
      await unlock();
      expect(await screen.findByText(humanText(said))).toBeVisible();
    },
  );

  it.each(["equal", "foreign epoch"] as const)(
    "ignores a refresh with an %s capture stamp",
    async (kind) => {
      const user = userEvent.setup();
      const current = captureSnapshot(snapshotWithRecord);
      const rejected: VaultSnapshot = {
        ...structuredClone(current),
        capture:
          kind === "equal"
            ? current.capture
            : {
                epoch: "00000000-0000-4000-8000-000000000186",
                sequence: Number.MAX_SAFE_INTEGER,
              },
        records: [{ ...current.records[0], displayName: "FAKE_Rejected.pdf" }],
      };
      const snapshot = vi
        .fn()
        .mockImplementationOnce(async () => current)
        .mockImplementationOnce(async () => rejected);
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        // A duplicate result still refreshes, without simulating a new file write.
        importPickedFiles: vi.fn().mockResolvedValue({
          imported: [],
          skippedDuplicates: ["FAKE existing.pdf"],
        }),
        snapshot,
      });
      render(<VaultApp bridge={bridge} />);
      expect(
        await screen.findByText(humanText("FAKE_Results.pdf")),
      ).toBeVisible();
      const choose = await importMenuItem();
      await user.click(choose);
      await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(choose).toBeEnabled());
      expect(screen.getByText(humanText("FAKE_Results.pdf"))).toBeVisible();
      expect(
        screen.queryByText(humanText("FAKE_Rejected.pdf")),
      ).not.toBeInTheDocument();
      expect(bridge.importPickedFiles).toHaveBeenCalledOnce();
      expect(bridge.lock).not.toHaveBeenCalled();
    },
  );

  it("anchors a newly unlocked native epoch before applying its later captures", async () => {
    const user = userEvent.setup();
    const current = captureSnapshot({
      ...snapshotWithRecord,
      recoveryKeySetAtMs: 5,
    });
    const reopened: VaultSnapshot = {
      ...structuredClone(current),
      capture: { epoch: "00000000-0000-4000-8000-000000000186", sequence: 1 },
      records: [{ ...current.records[0], displayName: "FAKE_NewRuntime.pdf" }],
    };
    const newer: VaultSnapshot = {
      ...reopened,
      capture: { ...reopened.capture, sequence: 2 },
      records: [
        { ...reopened.records[0], displayName: "FAKE_LaterRuntime.pdf" },
      ],
    };
    const snapshot = vi
      .fn()
      .mockImplementationOnce(async () => current)
      .mockImplementationOnce(async () => newer);
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      importPickedFiles: vi.fn().mockResolvedValue({
        imported: [],
        skippedDuplicates: ["FAKE existing.pdf"],
      }),
      snapshot,
      unlock: vi.fn(async () => reopened),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByText(humanText("FAKE_Results.pdf"));
    await user.click(windowLock());
    await user.type(
      await screen.findByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    expect(
      await screen.findByText(humanText("FAKE_NewRuntime.pdf")),
    ).toBeVisible();
    const choose = await importMenuItem();
    await user.click(choose);
    expect(
      await screen.findByText(humanText("FAKE_LaterRuntime.pdf")),
    ).toBeVisible();
    expect(
      screen.queryByText(humanText("FAKE_NewRuntime.pdf")),
    ).not.toBeInTheDocument();
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(bridge.lock).toHaveBeenCalledOnce();
  });

  it("keeps newer shared intake after a delayed recovery confirmation snapshot", async () => {
    const {
      bridge: receivedBridge,
      vault,
      arrive,
    } = sharedVault(["FAKE Patient"], []);
    vault.recoveryKeySetAtMs = 5;
    let finish: (() => void) | undefined;
    const { user, bridge, typeKeyBack } = await showKeyInSetup(5, {
      snapshot: receivedBridge.snapshot,
      listReceived: receivedBridge.listReceived,
      acceptReceived: receivedBridge.acceptReceived,
      confirmRecoveryKey: vi.fn(() => {
        // The command returns the snapshot captured when it stored the key.
        // Only delivery of that captured reply is held here.
        vault.recoveryKeySetAtMs = 9;
        const stored = captureSnapshot(vault);
        return new Promise<VaultSnapshot>((resolve) => {
          finish = () => resolve(stored);
        });
      }),
    });
    try {
      await typeKeyBack();
      expect(bridge.confirmRecoveryKey).toHaveBeenCalledOnce();
      expect(finish).toBeTypeOf("function");
      arrive("FAKE_After_key.pdf");
      await act(async () => window.dispatchEvent(new Event("focus")));
      await waitFor(() => expect(bridge.snapshot).toHaveBeenCalledTimes(2));
      expect(bridge.acceptReceived).toHaveBeenCalledOnce();
      expect(vault.records).toHaveLength(1);
      // Intake announces only after its snapshot refresh has completed.
      expect(
        await screen.findByText(
          humanText("A shared file was added to Shared with me."),
        ),
      ).toBeInTheDocument();

      await act(async () => finish!());
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(
        await screen.findByText(humanText(/^Recovery key replaced\./)),
      ).toBeVisible();
      expect(bridge.snapshot).toHaveBeenCalledTimes(2);
      await user.click(
        within(
          screen.getByRole("navigation", { name: humanText("Record library") }),
        ).getByRole("button", { name: humanText(/^Shared with me/) }),
      );
      expect(screen.getByText(humanText("FAKE_After_key.pdf"))).toBeVisible();
      expect(bridge.lock).not.toHaveBeenCalled();
    } finally {
      await act(async () => finish?.());
    }
  });

  it.each(["before", "after"] as const)(
    "applies a recovery key captured after a query made while confirmation was pending (query reply %s key reply)",
    async (order) => {
      const {
        bridge: receivedBridge,
        vault,
        arrive,
      } = sharedVault(["FAKE Patient"], []);
      vault.recoveryKeySetAtMs = 5;
      vault.recoveryKeyLabel = "OLD1";
      let commit: (() => void) | undefined;
      let deliverQuery: (() => void) | undefined;
      let commits = 0;
      let keySnapshot: VaultSnapshot | undefined;
      const reads: VaultSnapshot[] = [];
      const snapshot = vi.fn(() => {
        const captured = captureSnapshot(vault);
        reads.push(captured);
        if (order === "after" && reads.length === 2) {
          return new Promise<VaultSnapshot>((resolve) => {
            deliverQuery = () => resolve(captured);
          });
        }
        return Promise.resolve(captured);
      });
      const { user, bridge, typeKeyBack } = await showKeyInSetup(5, {
        snapshot,
        listReceived: receivedBridge.listReceived,
        acceptReceived: receivedBridge.acceptReceived,
        confirmRecoveryKey: vi.fn(
          () =>
            new Promise<VaultSnapshot>((resolve) => {
              commit = () => {
                if (commits) return;
                commits += 1;
                vault.recoveryKeySetAtMs = 9;
                vault.recoveryKeyLabel = "NEW2";
                keySnapshot = captureSnapshot(vault);
                resolve(keySnapshot);
              };
            }),
        ),
      });
      try {
        await typeKeyBack();
        expect(bridge.confirmRecoveryKey).toHaveBeenCalledOnce();
        arrive("FAKE_Before_commit.pdf");
        await act(async () => window.dispatchEvent(new Event("focus")));
        await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
        expect(bridge.acceptReceived).toHaveBeenCalledOnce();
        expect(vault.records).toHaveLength(1);
        expect(reads[1].recoveryKeyLabel).toBe("OLD1");
        if (order === "before") {
          expect(
            await screen.findByText(
              humanText("A shared file was added to Shared with me."),
            ),
          ).toBeInTheDocument();
        } else {
          expect(deliverQuery).toBeTypeOf("function");
        }
        expect(vault.recoveryKeyLabel).toBe("OLD1");
        await act(async () => commit!());
        expect(reads[1].capture.epoch).toBe(keySnapshot!.capture.epoch);
        expect(reads[1].capture.sequence).toBeLessThan(
          keySnapshot!.capture.sequence,
        );
        expect(
          await screen.findByText(humanText(/^Recovery key replaced\./)),
        ).toBeVisible();
        await user.click(
          screen.getByRole("button", { name: humanText("Security") }),
        );
        expect(screen.getByText("NEW2")).toBeVisible();
        if (order === "after") {
          await act(async () => deliverQuery!());
          expect(
            await screen.findByText(
              humanText("A shared file was added to Shared with me."),
            ),
          ).toBeInTheDocument();
          expect(screen.getByText("NEW2")).toBeVisible();
        }
        expect(screen.queryByText("OLD1")).not.toBeInTheDocument();
        await user.click(
          within(
            screen.getByRole("navigation", {
              name: humanText("Record library"),
            }),
          ).getByRole("button", { name: humanText(/^Shared with me/) }),
        );
        expect(
          screen.getByText(humanText("FAKE_Before_commit.pdf")),
        ).toBeVisible();
        expect(snapshot).toHaveBeenCalledTimes(2);
        expect(bridge.confirmRecoveryKey).toHaveBeenCalledOnce();
        expect(commits).toBe(1);
        expect(bridge.lock).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          deliverQuery?.();
          commit?.();
        });
      }
    },
  );

  it("never says a key stored as the vault locked was lost", async () => {
    // Hiding the app while the native confirmation may be open does not lock
    // it; the lock comes as the confirmation ends, and its reply and the
    // key's can fall either way. The next unlock must not say to destroy
    // the one kit that works.
    let answer: (snapshot: VaultSnapshot) => void = () => undefined;
    const { bridge, setVisibility, unlock, typeKeyBack } = await showKeyInSetup(
      5,
      {
        confirmRecoveryKey: vi.fn(
          () =>
            new Promise<VaultSnapshot>((resolve) => {
              answer = resolve;
            }),
        ),
      },
    );
    await typeKeyBack();
    expect(bridge.confirmRecoveryKey).toHaveBeenCalledOnce();
    await setVisibility("hidden");
    expect(bridge.lock).not.toHaveBeenCalled();
    const saved = captureSnapshot({ ...emptySnapshot, recoveryKeySetAtMs: 9 });
    await act(async () => answer(saved));
    await waitFor(() => expect(bridge.lock).toHaveBeenCalled());
    await setVisibility("visible");
    vi.mocked(bridge.unlock).mockImplementation(async () =>
      captureSnapshot(saved),
    );
    await unlock();
    expect(
      await screen.findByText(humanText(/^Vault unlocked\./)),
    ).toBeVisible();
    expect(screen.queryByText(humanText(/was not replaced/))).toBeNull();
    expect(screen.queryByText(humanText(/destroy it/))).toBeNull();
  });

  it.each([
    ["saved", true],
    ["cancelled", false],
  ])(
    "says nothing after the next unlock about a setup %s before the lock",
    async (_, saved) => {
      const after = { ...emptySnapshot, recoveryKeySetAtMs: saved ? 9 : 5 };
      const { user, bridge, hide, unlock, typeKeyBack } = await showKeyInSetup(
        5,
        {
          confirmRecoveryKey: vi
            .fn()
            .mockImplementation(async () => captureSnapshot(after)),
        },
      );
      if (saved) await typeKeyBack();
      else
        await user.click(
          within(
            screen.getByRole("dialog", {
              name: humanText("Your recovery key"),
            }),
          ).getByRole("button", { name: humanText("Cancel") }),
        );
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      // A replaced key says what to do with backups the old key opens.
      if (saved)
        expect(
          await screen.findByText(
            humanText(
              /^Recovery key replaced\. The old one no longer opens this vault\. Your old kit could still open backups saved before now\. In Security, save a new backup, then delete the older ones: Security shows the steps\.$/,
            ),
          ),
        ).toBeVisible();
      vi.mocked(bridge.unlock).mockImplementation(async () =>
        captureSnapshot(after),
      );
      await hide();
      await unlock();
      expect(
        await screen.findByText(humanText("Vault unlocked.")),
      ).toBeVisible();
    },
  );

  it("says to keep old backups when a replaced key leaves the vault read-only", async () => {
    // The key was stored, but the vault could not finish writing it, and so
    // cannot save a backup: deleting the old ones would leave none.
    const stored = {
      ...emptySnapshot,
      recoveryKeySetAtMs: 9,
      recovery: "writeFailed" as const,
    };
    const { typeKeyBack } = await showKeyInSetup(5, {
      confirmRecoveryKey: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(stored)),
    });
    await typeKeyBack();
    expect(
      await screen.findByText(
        humanText(/^Recovery key replaced\. .*keep them for now/),
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(humanText(/Security shows the steps/)),
    ).toBeNull();
  });

  it("tells a routine replacement to keep the old kit safe, not to delete backups", async () => {
    const after = { ...emptySnapshot, recoveryKeySetAtMs: 9 };
    const { user, typeKeyBack } = await showKeyInSetup(
      5,
      {
        confirmRecoveryKey: vi
          .fn()
          .mockImplementation(async () => captureSnapshot(after)),
      },
      false,
    );
    await typeKeyBack();
    const told = await screen.findByText(humanText(/^Recovery key replaced\./));
    expect(told).toHaveHumanTextContent(
      "Keep the old key's kit safe. If you destroy it",
    );
    expect(told).not.toHaveHumanTextContent(/delete/i);
    await user.click(
      screen.getByRole("button", { name: humanText(/Security/) }),
    );
    expect(screen.queryByText(humanText("Your older backups"))).toBeNull();
  });

  it("walks a replacement for an exposed kit through a new backup, then the old ones", async () => {
    const after = {
      ...emptySnapshot,
      recoveryKeySetAtMs: 9,
      recoveryKeyLabel: "7F3A",
    };
    const written = "myCarlos backup 2026-09-30 7F3A.mycarlosbackup";
    const { user, bridge, typeKeyBack } = await showKeyInSetup(5, {
      confirmRecoveryKey: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(after)),
      pickBackupDestination: vi.fn().mockResolvedValue("pick-9"),
      saveBackupToPicked: vi
        .fn()
        .mockResolvedValue({ name: written, bytes: 4096 }),
    });
    await typeKeyBack();
    await screen.findByText(humanText(/^Recovery key replaced\./));
    await user.click(
      screen.getByRole("button", { name: humanText(/Security/) }),
    );
    const guide = screen.getByRole("region", {
      name: humanText("Your older backups"),
    });
    // A new backup first: deleting never leaves none.
    const steps = within(guide).getAllByRole("listitem");
    expect(steps[0]).toHaveHumanTextContent("Save a new backup now");
    expect(steps[1]).toHaveHumanTextContent("Then delete the older backups");

    await user.click(
      screen.getByRole("button", { name: humanText("Save encrypted backup…") }),
    );
    expect(bridge.saveBackupToPicked).toHaveBeenCalledWith("pick-9", false);
    // Named by the patient's own date.
    const today = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    expect(bridge.pickBackupDestination).toHaveBeenCalledWith(
      `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
    );
    expect(
      await screen.findByText(
        humanText(
          "Encrypted backup saved. This is your new backup: keep it, or a copy of it, somewhere other than this device. Security now shows which older ones to delete.",
        ),
      ),
    ).toBeVisible();
    // The file the native side wrote is the one to keep: whatever it is
    // named, every other backup goes.
    const next = within(
      screen.getByRole("region", { name: humanText("Your older backups") }),
    ).getAllByRole("listitem");
    expect(next[0]).toHaveHumanTextContent(
      // The test platform is Windows, whose Explorer counts in 1024s.
      `Your new backup is “${written}” (4 KB, ${(4096).toLocaleString()} bytes). Keep it, or a copy of it, somewhere other than this device`,
    );
    expect(next[1]).toHaveHumanTextContent(
      "other than the new one and its copies",
    );
    expect(next[2]).toHaveHumanTextContent("that file is now your new backup");

    await user.click(
      screen.getByRole("button", {
        name: humanText("Done with older backups"),
      }),
    );
    expect(screen.queryByText(humanText("Your older backups"))).toBeNull();
    expect(
      window.localStorage.getItem("mycarlos.oldBackupsGuide.v1"),
    ).toBeNull();
  });

  it("keeps the step to save a new backup when saving one failed", async () => {
    window.localStorage.setItem(
      "mycarlos.oldBackupsGuide.v1",
      JSON.stringify({ step: "save" }),
    );
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      pickBackupDestination: vi.fn().mockResolvedValue("pick-3"),
      saveBackupToPicked: vi.fn().mockRejectedValue({
        code: "no_space",
        message:
          "There is not enough space where you chose to save it. No backup was saved. Keep your older backups.",
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText(/Security/) }),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Save encrypted backup…") }),
    );
    expect(
      await screen.findByText(humanText(/Keep your older backups\./)),
    ).toBeVisible();
    // No new backup, so nothing may be deleted yet.
    const guide = screen.getByRole("region", {
      name: humanText("Your older backups"),
    });
    expect(within(guide).getAllByRole("listitem")[0]).toHaveHumanTextContent(
      "Save a new backup now",
    );
    expect(window.localStorage.getItem("mycarlos.oldBackupsGuide.v1")).toBe(
      JSON.stringify({ step: "save" }),
    );
  });

  it("asks for a new backup again when a save over the one to keep failed", async () => {
    // Android names no file, so the patient may have saved over the one to
    // keep, which a failure after opening it leaves empty.
    window.localStorage.setItem(
      "mycarlos.oldBackupsGuide.v1",
      JSON.stringify({ step: "delete", keep: null, savedAtMs: 1 }),
    );
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      pickBackupDestination: vi.fn().mockResolvedValue("pick-3"),
      saveBackupToPicked: vi.fn().mockRejectedValue({
        code: "storage",
        message: "The backup could not be saved there. No backup was saved.",
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText(/Security/) }),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Save encrypted backup…") }),
    );
    await screen.findByText(humanText(/No backup was saved/));
    expect(
      within(
        screen.getByRole("region", { name: humanText("Your older backups") }),
      ).getAllByRole("listitem")[0],
    ).toHaveHumanTextContent("Save a new backup now");
  });

  it("asks for a new backup again, and says once what was left, when Lock now cuts a save off", async () => {
    // Android names no file, so this save may be over the one to keep; the
    // lock then empties it.
    window.localStorage.setItem(
      "mycarlos.oldBackupsGuide.v1",
      JSON.stringify({ step: "delete", keep: null, savedAtMs: 1, bytes: 10 }),
    );
    const note =
      "The file where you chose to save may be empty or incomplete; if you chose to save over an older backup, it was emptied. Delete that one, not your other backups.";
    let failSave!: (error: unknown) => void;
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      pickBackupDestination: vi.fn().mockResolvedValue("pick-5"),
      saveBackupToPicked: vi.fn(
        () =>
          new Promise<SavedBackup>((_, reject) => {
            failSave = reject;
          }),
      ),
      lock: vi.fn(async () => {
        failSave({ ...CANCELLED, note });
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText(/Security/) }),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Save encrypted backup…") }),
    );
    await waitFor(() => expect(bridge.saveBackupToPicked).toHaveBeenCalled());
    await user.click(windowLock());
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await expectOutcomeAfterUnlock(
      `The backup stopped because the vault locked. No backup was saved. Keep your older backups. ${note}`,
    );
    expect(
      screen.getAllByText(humanText(new RegExp("it was emptied"))),
    ).toHaveLength(1);
    await user.click(
      screen.getByRole("button", { name: humanText(/Security/) }),
    );
    expect(
      within(
        screen.getByRole("region", { name: humanText("Your older backups") }),
      ).getAllByRole("listitem")[0],
    ).toHaveHumanTextContent("Save a new backup now");
  });

  it("keeps the backup saved last when another is saved while the steps are open", async () => {
    window.localStorage.setItem(
      "mycarlos.oldBackupsGuide.v1",
      JSON.stringify({
        step: "delete",
        keep: "first.mycarlosbackup",
        savedAtMs: 1,
      }),
    );
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      pickBackupDestination: vi.fn().mockResolvedValue("pick-4"),
      saveBackupToPicked: vi
        .fn()
        .mockResolvedValue({ name: "second.mycarlosbackup", bytes: 10 }),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText(/Security/) }),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Save encrypted backup…") }),
    );
    expect(
      await screen.findByText(
        humanText(/Your new backup is “second\.mycarlosbackup”/),
      ),
    ).toBeVisible();
  });

  it("shows the steps for old backups after an unlock reports an exposed key replaced", async () => {
    window.localStorage.setItem(
      "mycarlos.unfinishedRecoveryKey.v1",
      JSON.stringify({ setAtMs: 5, exposed: true }),
    );
    const user = userEvent.setup();
    const vault = { ...emptySnapshot, recoveryKeySetAtMs: 9 };
    render(
      <VaultApp
        bridge={nativeBridge({
          unlock: vi
            .fn()
            .mockImplementation(async () => captureSnapshot(vault)),
          snapshot: vi
            .fn()
            .mockImplementation(async () => captureSnapshot(vault)),
        })}
      />,
    );
    await user.type(
      await screen.findByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    expect(
      await screen.findByText(humanText(/Security shows the steps\./)),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: humanText(/Security/) }),
    );
    expect(
      screen.getByRole("region", { name: humanText("Your older backups") }),
    ).toBeVisible();
  });

  it("says so after unlocking when myCarlos closed with a key on screen", async () => {
    const { view } = await showKeyInSetup(5);
    // Closed, not locked: the next start finds the vault locked.
    view.unmount();
    const user = userEvent.setup();
    const vault = { ...emptySnapshot, recoveryKeySetAtMs: 5 };
    render(
      <VaultApp
        bridge={nativeBridge({
          unlock: vi
            .fn()
            .mockImplementation(async () => captureSnapshot(vault)),
        })}
      />,
    );
    await user.type(
      await screen.findByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    expect(
      await screen.findByText(humanText(/Your recovery key was not replaced/)),
    ).toBeVisible();
  });

  it("says to keep old backups when a key stored as it locked opens read-only", async () => {
    // A replacement stored just as the vault locked, which then opens
    // read-only: it cannot save a backup, so the old ones must stay.
    window.localStorage.setItem(
      "mycarlos.unfinishedRecoveryKey.v1",
      JSON.stringify({ setAtMs: 5, exposed: true }),
    );
    const user = userEvent.setup();
    const vault = {
      ...emptySnapshot,
      recoveryKeySetAtMs: 9,
      recovery: "writeFailed" as const,
    };
    render(
      <VaultApp
        bridge={nativeBridge({
          unlock: vi
            .fn()
            .mockImplementation(async () => captureSnapshot(vault)),
        })}
      />,
    );
    await user.type(
      await screen.findByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    expect(
      await screen.findByText(
        humanText(/was saved just before the vault locked.*keep them for now/),
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(humanText(/Security shows the steps/)),
    ).toBeNull();
  });

  it("says plainly why the next try must wait, after several wrong ones", async () => {
    const user = userEvent.setup();
    render(
      <VaultApp
        bridge={nativeBridge({
          unlock: vi.fn().mockRejectedValue({
            code: "too_many_attempts",
            message:
              "There have been several wrong tries in a row. To slow down anyone guessing, myCarlos waits a little before the next one: what you typed was not checked.",
            retryAfterMs: 30_000,
          }),
        })}
      />,
    );
    await user.type(
      await screen.findByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    expect(
      await screen.findByText(
        humanText(
          /To slow down anyone guessing, myCarlos waits a little before the next one: what you typed was not checked\. Try again in 30 seconds\./,
        ),
      ),
    ).toBeVisible();
  });

  it("opens a locked vault with its recovery key and a new passphrase", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge();
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByText(humanText("Forgot your passphrase?")),
    );
    await user.type(
      screen.getByLabelText(humanText("Recovery key")),
      RECOVERY_KEY,
    );
    await user.type(
      screen.getByLabelText(humanText("New passphrase")),
      "lantern-orbit-willow-cascade-572",
    );
    await user.type(
      screen.getByLabelText(humanText("Confirm new passphrase")),
      "lantern-orbit-willow-cascade-572",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Open with recovery key") }),
    );
    expect(bridge.recover).toHaveBeenCalledWith(
      RECOVERY_KEY,
      "lantern-orbit-willow-cascade-572",
    );
    expect(
      await screen.findByRole("heading", { name: humanText("My records") }),
    ).toBeVisible();
    expect(
      await screen.findByText(
        humanText(/^Vault opened with your recovery key\./),
      ),
    ).toBeVisible();
  });

  const HELD_OUTCOME = "1 document encrypted and added.";

  // Backgrounds the app during an import, so that the vault locks when the
  // import ends and its outcome is held for the next unlock. Fake timers.
  async function lockWithHeldOutcome(bridge: VaultBridge) {
    let finishImport!: (value: ImportOutcome) => void;
    vi.mocked(bridge.importPickedFiles).mockImplementationOnce(
      () =>
        new Promise<ImportOutcome>((resolve) => {
          finishImport = resolve;
        }),
    );
    let visibilityState: DocumentVisibilityState = "visible";
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibilityState);
    onTestFinished(() => visibility.mockRestore());
    await act(async () => {
      render(<VaultApp bridge={bridge} />);
    });
    const importItem = importMenuItemNow();
    await act(async () => {
      fireEvent.click(importItem);
    });
    await act(async () => {
      visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () =>
      finishImport({ imported: ["FAKE.pdf"], skippedDuplicates: [] }),
    );
    await act(async () => {
      visibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(
      screen.getByText(
        humanText(
          "Locked because myCarlos was minimized or sent to the background.",
        ),
      ),
    ).toBeVisible();
  }

  async function unlockWithoutWaiting() {
    await act(async () => {
      fireEvent.change(screen.getByLabelText(humanText("Passphrase")), {
        target: { value: "river-azimuth-cobalt-sparrow-934" },
      });
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: humanText("Unlock") }),
      );
    });
    expect(
      screen.getByRole("heading", { name: humanText("My records") }),
    ).toBeVisible();
  }

  it("keeps a held transfer outcome when the vault locks before it was shown", async () => {
    vi.useFakeTimers();
    try {
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
      });
      await lockWithHeldOutcome(bridge);
      await unlockWithoutWaiting();
      // Locked again inside the delay: only "Vault locked." is on the unlock
      // screen, now and once the delay has passed.
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: humanText(/Lock now/) }),
        );
      });
      await passAnnounceDelay();
      expect(
        screen.queryByText(humanText(/Vault unlocked/)),
      ).not.toBeInTheDocument();
      // The outcome was kept for the next unlock.
      await expectOutcomeAfterUnlock(HELD_OUTCOME);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a held transfer outcome when a message arrives while a lock is under way", async () => {
    vi.useFakeTimers();
    try {
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
      });
      await lockWithHeldOutcome(bridge);
      await unlockWithoutWaiting();
      let finishLock!: () => void;
      vi.mocked(bridge.lock).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishLock = resolve;
          }),
      );
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: humanText(/Lock now/) }),
        );
      });
      // Written to the library's line, which the lock is about to replace.
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(["%PDF-1.7"], "FAKE dropped.pdf", { type: "application/pdf" }),
      );
      await act(async () => {
        fireDragEvent("drop", window, { dataTransfer: transfer });
      });
      expect(
        screen.queryByText(humanText(HELD_OUTCOME), { exact: false }),
      ).not.toBeInTheDocument();
      await act(async () => finishLock());
      await passAnnounceDelay();
      await expectOutcomeAfterUnlock(HELD_OUTCOME);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a held transfer outcome at unlock, not the recovery key setup", async () => {
    vi.useFakeTimers();
    try {
      offerIsDue();
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        beginRecoveryKey: vi.fn().mockResolvedValue(RECOVERY_KEY),
      });
      await lockWithHeldOutcome(bridge);
      await expectOutcomeAfterUnlock(HELD_OUTCOME);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for an operation started at once before giving the unlock result", async () => {
    vi.useFakeTimers();
    try {
      let choose!: (pick: string | null) => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
      });
      await lockWithHeldOutcome(bridge);
      vi.mocked(bridge.pickImportFiles).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            choose = resolve;
          }),
      );
      await unlockWithoutWaiting();
      // A picker opened at once, before the result was written.
      const importItem = importMenuItemNow();
      await act(async () => {
        fireEvent.click(importItem);
      });
      await passAnnounceDelay();
      // Nothing is written behind the picker.
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      await act(async () => choose(null));
      await passAnnounceDelay();
      expect(screen.getByRole("status")).toHaveHumanTextContent(
        `No files selected. Nothing changed. ${HELD_OUTCOME}`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds a held transfer outcome to a message that arrives before it was shown", async () => {
    vi.useFakeTimers();
    try {
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        pickImportFiles: vi
          .fn()
          .mockResolvedValueOnce("pick-1")
          .mockResolvedValue(null),
      });
      await lockWithHeldOutcome(bridge);
      await unlockWithoutWaiting();
      // An operation started at once reports first.
      const importItem = importMenuItemNow();
      await act(async () => {
        fireEvent.click(importItem);
      });
      await passAnnounceDelay();
      expect(screen.getByRole("status")).toHaveHumanTextContent(
        `No files selected. Nothing changed. ${HELD_OUTCOME}`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["unlocking", "locked", /^Vault unlocked\.$/],
    ["creating", "absent", /^Encrypted vault created\./],
  ] as const)(
    "gives the result of %s to the library's status line once it is on screen",
    async (_, initial, message) => {
      vi.useFakeTimers();
      try {
        const bridge = nativeBridge({
          status: vi.fn().mockResolvedValue(initial),
        });
        await act(async () => {
          render(<VaultApp bridge={bridge} />);
        });
        if (initial === "absent")
          await act(async () => {
            fireEvent.click(
              screen.getByRole("button", { name: humanText("Continue") }),
            );
          });
        await act(async () => {
          if (initial === "absent")
            fireEvent.change(
              screen.getByLabelText(
                humanText("Whose records will you keep here?"),
              ),
              {
                target: { value: "FAKE Test Patient" },
              },
            );
          for (const field of screen.getAllByLabelText(
            humanText(/passphrase/i),
          ))
            fireEvent.change(field, {
              target: { value: "river-azimuth-cobalt-sparrow-934" },
            });
        });
        await act(async () => {
          fireEvent.click(
            screen.getByRole("button", {
              name: humanText(initial === "absent" ? "Create vault" : "Unlock"),
            }),
          );
        });
        expect(
          screen.getByRole("heading", { name: humanText("My records") }),
        ).toBeVisible();
        const status = screen.getByRole("status");
        expect(status).toBeEmptyDOMElement();
        await passAnnounceDelay();
        expect(status).toHaveHumanTextContent(message);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("starts the selection again when a search could hide selected documents", async () => {
    const user = userEvent.setup();
    const record = (id: string, displayName: string) => ({
      id,
      profileId: "profile-1",
      folderIds: [],
      displayName,
      sourceLabel: "Manual import — unverified",
      mediaType: "application/pdf",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: true,
    });
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockImplementation(async () =>
        captureSnapshot({
          ...emptySnapshot,
          records: [
            record("a", "FAKE_Alpha.pdf"),
            record("b", "FAKE_Beta.pdf"),
          ],
        }),
      ),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(
      await screen.findByRole("button", {
        name: humanText("Select FAKE_Alpha.pdf"),
      }),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Select FAKE_Beta.pdf") }),
    );
    expect(screen.getByText(humanText("2 selected"))).toBeVisible();

    await user.type(
      screen.getByPlaceholderText(humanText("Search everything in My records")),
      "Alpha",
    );
    expect(
      screen.queryByText(humanText("FAKE_Beta.pdf")),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(humanText(/selected$/))).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: humanText("Move") }),
    ).not.toBeInTheDocument();
  });

  it("refuses a document name longer than the vault's byte limit before saving it", async () => {
    const user = userEvent.setup();
    const record = {
      id: "record-1",
      profileId: "profile-1",
      folderIds: [],
      displayName: "FAKE_Long.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/pdf",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: true,
    };
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () =>
          captureSnapshot({ ...emptySnapshot, records: [record] }),
        ),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(await screen.findByText(humanText("FAKE_Long.pdf")));
    await user.click(
      screen.getByRole("button", { name: humanText("Rename document") }),
    );
    // 100 characters fit the input's 240-unit limit but need 300 UTF-8 bytes.
    fireEvent.change(screen.getByLabelText(humanText("File name")), {
      target: { value: "字".repeat(100) },
    });

    expect(screen.getByRole("alert")).toHaveHumanTextContent("too long");
    expect(
      screen.getByRole("button", { name: humanText("Save name") }),
    ).toBeDisabled();
    expect(bridge.renameRecord).not.toHaveBeenCalled();

    // The kept ".pdf" counts too: 79 characters are 237 bytes, 241 with it.
    fireEvent.change(screen.getByLabelText(humanText("File name")), {
      target: { value: "字".repeat(79) },
    });
    expect(screen.getByRole("alert")).toHaveHumanTextContent("too long");
    expect(
      screen.getByRole("button", { name: humanText("Save name") }),
    ).toBeDisabled();

    // Exactly the limit: 78 characters and "ab" are 236 bytes, 240 with it.
    fireEvent.change(screen.getByLabelText(humanText("File name")), {
      target: { value: `${"字".repeat(78)}ab` },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: humanText("Save name") }),
    ).toBeEnabled();
  });

  it("allows Escape to cancel folder renaming and disables renaming in recovery mode", async () => {
    const user = userEvent.setup();
    const bridge = renameBridge();
    const { unmount } = render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", {
        name: humanText("Rename folder FAKE Parent"),
      }),
    );
    const results = await axe.run(screen.getByRole("dialog"));
    expect(results.violations).toEqual([]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: humanText("Rename folder FAKE Parent"),
      }),
    ).toHaveFocus();
    expect(bridge.updateFolder).not.toHaveBeenCalled();
    unmount();

    const snapshot = await bridge.snapshot();
    vi.mocked(bridge.snapshot).mockImplementation(async () =>
      captureSnapshot({
        ...snapshot,
        recovery: "writeFailed",
      }),
    );
    render(<VaultApp bridge={bridge} />);
    expect(
      await screen.findByRole("button", {
        name: humanText("Rename folder FAKE Parent"),
      }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", {
        name: humanText("FAKE Parent, open folder"),
      }),
    );
    expect(headMenuItemNow("Rename folder")).toBeDisabled();
    await user.click(
      screen.getByRole("button", {
        name: humanText("Details for FAKE Old.pdf"),
      }),
    );
    expect(
      screen.getByRole("button", { name: humanText("Rename document") }),
    ).toBeDisabled();
  });

  it.each(["locked", "unlocked"] as const)(
    "prevents external drop navigation while %s without importing or moving records",
    async (status) => {
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue(status),
      });
      const { unmount } = render(<VaultApp bridge={bridge} />);
      const heading = await screen.findByRole("heading", {
        name: humanText(
          status === "locked" ? "Unlock your vault" : "My records",
        ),
      });
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(["%PDF-1.7"], "FAKE dropped.pdf", { type: "application/pdf" }),
      );
      transfer.dropEffect = "copy";
      expect(
        fireDragEvent("dragover", heading, { dataTransfer: transfer }),
      ).toBe(false);
      expect(transfer.dropEffect).toBe("none");
      expect(fireDragEvent("drop", heading, { dataTransfer: transfer })).toBe(
        false,
      );
      expect(
        await screen.findByText(
          humanText(
            /To import PDFs, unlock your vault and use “Add document › Import a file”/,
          ),
        ),
      ).toBeVisible();
      const urlTransfer = new DataTransfer();
      urlTransfer.setData("text/uri-list", "https://example.invalid/");
      expect(
        fireDragEvent("drop", heading, { dataTransfer: urlTransfer }),
      ).toBe(false);
      expect(bridge.pickImportFiles).not.toHaveBeenCalled();
      expect(bridge.assignFoldersBatch).not.toHaveBeenCalled();
      expect(bridge.updateFolder).not.toHaveBeenCalled();
      unmount();
      expect(fireDragEvent("drop", window, { dataTransfer: transfer })).toBe(
        true,
      );
    },
  );

  it("hides a backgrounded app during an import and locks once the import finishes", async () => {
    const user = userEvent.setup();
    let finishImport!: (value: ImportOutcome) => void;
    const importPickedFiles = vi.fn(
      () =>
        new Promise<ImportOutcome>((resolve) => {
          finishImport = resolve;
        }),
    );
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      importPickedFiles,
      // A real lock answers after the import's own result has come back.
      lock: vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ),
    });
    let visibilityState: DocumentVisibilityState = "visible";
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibilityState);
    try {
      render(<VaultApp bridge={bridge} />);

      await user.click(await importMenuItem());
      await waitFor(() => expect(importPickedFiles).toHaveBeenCalled());
      await act(async () => {
        visibilityState = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // Locking now would cancel the import, so content is hidden instead.
      expect(bridge.lock).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("heading", { name: humanText("My records") }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveHumanTextContent(TRANSFER_HOLD);

      await act(async () => {
        visibilityState = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // Coming back does not show the library again: the lock is still owed.
      expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();

      await act(async () =>
        finishImport({ imported: ["FAKE.pdf"], skippedDuplicates: [] }),
      );
      expect(
        await screen.findByRole("heading", {
          name: humanText("Unlock your vault"),
        }),
      ).toBeVisible();
      expect(bridge.lock).toHaveBeenCalledOnce();
      // Whoever unlocks next learns how the import went.
      await expectOutcomeAfterUnlock("1 document encrypted and added.");

      // The held lock is spent: a transfer in the next session does not lock.
      await user.click(await importMenuItem());
      await act(async () =>
        finishImport({ imported: [], skippedDuplicates: [] }),
      );
      expect(
        screen.getByRole("heading", { name: humanText("My records") }),
      ).toBeVisible();
      expect(bridge.lock).toHaveBeenCalledOnce();

      // The outcome was shown once; later unlocks do not repeat it.
      await user.click(
        screen.getByRole("button", { name: humanText(/Lock now/) }),
      );
      await user.type(
        await screen.findByLabelText(humanText("Passphrase")),
        "river-azimuth-cobalt-sparrow-934",
      );
      await user.click(
        screen.getByRole("button", { name: humanText("Unlock") }),
      );
      expect(
        await screen.findByText(humanText("Vault unlocked.")),
      ).toBeVisible();
    } finally {
      visibility.mockRestore();
    }
  });

  it("does not show an earlier transfer's outcome after a later one is cancelled", async () => {
    const user = userEvent.setup();
    let cancelImport!: (error: unknown) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      importPickedFiles: vi
        .fn()
        .mockResolvedValueOnce({
          imported: ["FAKE.pdf"],
          skippedDuplicates: [],
        })
        .mockImplementationOnce(
          () =>
            new Promise<ImportOutcome>((_, reject) => {
              cancelImport = reject;
            }),
        ),
      // Locking cancels the transfer under way.
      lock: vi.fn(async () => cancelImport(CANCELLED)),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(await importMenuItem());
    expect(
      await screen.findByText(humanText("1 document encrypted and added.")),
    ).toBeVisible();
    await user.click(await importMenuItem());
    await waitFor(() =>
      expect(bridge.importPickedFiles).toHaveBeenCalledTimes(2),
    );
    await user.click(
      screen.getByRole("button", { name: humanText(/Lock now/) }),
    );
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await user.type(
      screen.getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    expect(await screen.findByText(humanText("Vault unlocked."))).toBeVisible();
  });

  it("forgets a transfer's outcome when the vault is erased", async () => {
    const user = userEvent.setup();
    let finishImport!: (value: ImportOutcome) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      importPickedFiles: vi.fn(
        () =>
          new Promise<ImportOutcome>((resolve) => {
            finishImport = resolve;
          }),
      ),
    });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    try {
      render(<VaultApp bridge={bridge} />);
      await user.click(await importMenuItem());
      await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
      visibility.mockReturnValue("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      visibility.mockReturnValue("visible");
      await act(async () =>
        finishImport({ imported: ["FAKE.pdf"], skippedDuplicates: [] }),
      );
      await screen.findByRole("heading", {
        name: humanText("Unlock your vault"),
      });

      await user.click(screen.getByText(humanText("Forgot your passphrase?")));
      await user.type(
        screen.getByLabelText(humanText("Type RESET MYCARLOS VAULT")),
        "RESET MYCARLOS VAULT",
      );
      await user.click(
        screen.getByRole("button", { name: humanText("Set vault aside") }),
      );
      await continuePastComfort();
      await user.type(
        await screen.findByLabelText(
          humanText("Whose records will you keep here?"),
        ),
        "FAKE Tester",
      );
      await user.type(
        screen.getByLabelText(humanText("Passphrase")),
        "river-azimuth-cobalt-sparrow-934",
      );
      await user.type(
        screen.getByLabelText(humanText("Confirm passphrase")),
        "river-azimuth-cobalt-sparrow-934",
      );
      await user.click(
        screen.getByRole("button", { name: humanText("Create vault") }),
      );
      await user.click(
        await screen.findByRole("button", { name: humanText(/Lock now/) }),
      );
      await user.type(
        await screen.findByLabelText(humanText("Passphrase")),
        "river-azimuth-cobalt-sparrow-934",
      );
      await user.click(
        screen.getByRole("button", { name: humanText("Unlock") }),
      );
      expect(
        await screen.findByText(humanText("Vault unlocked.")),
      ).toBeVisible();
    } finally {
      visibility.mockRestore();
    }
  });

  it("locks at once when backgrounded with no transfer running", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    try {
      render(<VaultApp bridge={bridge} />);
      expect(
        await screen.findByRole("heading", {
          name: humanText("Unlock your vault"),
        }),
      ).toBeVisible();
      expect(bridge.lock).toHaveBeenCalledOnce();
      // Not a change to the status line, which is not read out: the field
      // that takes focus says it.
      expect(
        screen.getByLabelText(humanText("Passphrase")),
      ).toHaveHumanAccessibleDescription(
        "0 character passphrase Locked because myCarlos was minimized or sent to the background.",
      );
    } finally {
      visibility.mockRestore();
    }
  });

  // ---- Privacy across screens: how the pieces fit together, not single files ----

  /** Every place a name can be read or heard from: text, and the attributes a screen reader or a
   * tooltip uses. A field's typed value is not included (the patient typed that). */
  function placesThatSay(name: string): Element[] {
    return Array.from(document.querySelectorAll("*")).filter((element) => {
      const own = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("");
      const attributes = [
        "aria-label",
        "title",
        "alt",
        "placeholder",
        "aria-description",
        "aria-valuetext",
      ].map((attribute) => element.getAttribute(attribute) ?? "");
      return [own, ...attributes].some((text) => text.includes(name));
    });
  }

  const hiddenCasey = {
    id: "profile-9",
    displayName: "FAKE Casey Hiddenname",
    hiddenAtMs: 1_700_000_000_000,
    documents: 3,
  };
  const withHiddenCasey = (): VaultSnapshot => ({
    ...snapshotWithRecord,
    hiddenProfiles: [hiddenCasey],
  });

  it("names a hidden person only inside Hidden people: not the library, its search, a dialog, or the lock screen", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(withHiddenCasey())),
      hideProfile: vi.fn().mockResolvedValue(undefined),
      restoreProfile: vi.fn().mockResolvedValue([]),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: humanText("My records") });
    const name = "Hiddenname";
    expect(placesThatSay(name)).toEqual([]);
    // Searching for the name finds no one, and the page still does not say it.
    const search = screen.getByRole("searchbox");
    await user.type(search, name);
    expect(placesThatSay(name).filter((e) => e !== search)).toEqual([]);
    await user.clear(search);
    // Security shows it, and only in the Hidden people panel (and what its buttons say).
    await user.click(
      screen.getByRole("button", { name: humanText(/Security/) }),
    );
    const panel = document.querySelector(".native-hidden-people");
    expect(panel).not.toBeNull();
    const found = placesThatSay(name);
    expect(found.length).toBeGreaterThan(0);
    for (const element of found) expect(panel!.contains(element)).toBe(true);
    // The hand-over dialog lists the people the library shows, not the hidden one.
    await user.click(
      screen.getByRole("button", { name: humanText("Hand records over…") }),
    );
    await screen.findByRole("dialog");
    for (const element of placesThatSay(name))
      expect(panel!.contains(element)).toBe(true);
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: humanText("Cancel"),
      }),
    );
    // Locked: the name is nowhere.
    await user.click(windowLock());
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    expect(placesThatSay(name)).toEqual([]);
  });

  it("after a person is hidden, nothing of theirs (name, documents, the notice) is on the library, in its search, or on the lock screen", async () => {
    const user = userEvent.setup();
    let hidden = false;
    const casey = {
      id: "profile-9",
      displayName: "FAKE Casey Hiddenname",
      createdAtMs: 2,
    };
    const letter = {
      id: "record-9",
      profileId: "profile-9",
      folderIds: [],
      displayName: "FAKE_Letter_for_Hiddenname.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/pdf",
      plaintextSize: 2048,
      importedAtMs: 2,
      available: true,
    };
    const current = (): VaultSnapshot =>
      hidden
        ? {
            ...snapshotWithRecord,
            hiddenProfiles: [{ ...hiddenCasey, documents: 1 }],
          }
        : {
            ...snapshotWithRecord,
            profiles: [...snapshotWithRecord.profiles, casey],
            records: [...snapshotWithRecord.records, letter],
          };
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(current())),
      hideProfile: vi.fn().mockImplementation(async () => {
        hidden = true;
      }),
      restoreProfile: vi.fn().mockResolvedValue([]),
      updateProfileDetails: vi.fn().mockResolvedValue(undefined),
    });
    render(<VaultApp bridge={bridge} />);
    // With two people the library's heading is the person's name.
    await screen.findByRole("heading", { name: humanText("Jamie") });
    await user.click(
      screen.getByRole("button", { name: humanText(/Security/) }),
    );
    await user.click(
      screen.getByRole("button", {
        name: humanText("Hide FAKE Casey Hiddenname"),
      }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: humanText("Hide FAKE Casey Hiddenname"),
      }),
    );
    await waitFor(() =>
      expect(bridge.hideProfile).toHaveBeenCalledWith("profile-9"),
    );
    const panel = await waitFor(() => {
      const found = document.querySelector(".native-hidden-people");
      expect(found).not.toBeNull();
      return found!;
    });
    // Outside the Hidden people panel the person and their document are not said anywhere.
    // Outside the panel only the polite line that tells a screen reader it was hidden says it
    // (the confirmation of what the patient just did).
    const notice = (element: Element) =>
      element.getAttribute("aria-live") === "polite" &&
      /is now hidden/.test(element.textContent ?? "");
    const outside = () =>
      placesThatSay("Hiddenname").filter(
        (element) => !panel.contains(element) && !notice(element),
      );
    expect(outside()).toEqual([]);
    // Back in the library, and searching for them.
    await user.click(
      screen.getByRole("button", { name: humanText(/^My records/) }),
    );
    await screen.findByRole("heading", { name: humanText("My records") });
    const search = screen.getByRole("searchbox");
    await user.type(search, "Hiddenname");
    // Only the confirmation is left (measured: it stays on the library page, see below).
    const left = placesThatSay("Hiddenname").filter((e) => e !== search);
    expect(left.every(notice)).toBe(true);
    // Locked: nothing of it is left, not even the line that told a screen reader it was hidden.
    await user.click(windowLock());
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    expect(placesThatSay("Hiddenname")).toEqual([]);
    expect(document.body.textContent).not.toContain("Hiddenname");
  });

  /** Every bridge method, in exactly one of two lists (a `Record` over all the keys, so adding a
   * method to `VaultBridge` stops the build until it is placed):
   * - `write`: changes the vault, sends or saves something for a clinic, or is refused by native
   *   in recovery mode. In read-only recovery none may be reached from any control. That last
   *   group is the backup (`backup_parts` returns `RecoveryMode`, vault.rs, pinned by the test
   *   `a_read_only_vault_is_not_backed_up`: a backup of a degraded manifest could omit records
   *   silently, and the old-backups guide tells the patient to delete older ones after a new
   *   one) and a person's hand-over, export and import (`exportable_profile` and the import
   *   both return `RecoveryMode`). The UI matches: those buttons are disabled.
   * - `allowed`: reads, pickers, computing, and the deliberate exceptions: a single document's
   *   export and an anonymized text's save (native: "the export still runs: it may be the only
   *   way to get a document out", `export_atomic`), erasing the vault and restoring a backup
   *   (how a damaged vault is started over; both are reached from the locked and set-up
   *   screens, not the library), the device's own auto-lock setting, and `recover` (the locked
   *   screen). */
  const BRIDGE_CLASS: Record<keyof VaultBridge, "write" | "allowed"> = {
    native: "allowed",
    status: "allowed",
    passphraseRules: "allowed",
    create: "write",
    unlock: "allowed",
    lock: "allowed",
    touch: "allowed",
    setAutoLock: "allowed",
    platform: "allowed",
    snapshot: "allowed",
    history: "allowed",
    linkPortal: "write",
    connectPortal: "write",
    // Removes a link that has delivered nothing: a change to the vault (main's #476 added it).
    removePortalLink: "write",
    checkDocuments: "write",
    requestDeviceApproval: "write",
    submitApprovalCode: "write",
    restartDeviceApproval: "write",
    forgetRefusedDeliveries: "write",
    refreshDeviceApproval: "write",
    changePassphrase: "write",
    beginRecoveryKey: "write",
    confirmRecoveryKey: "write",
    saveRecoveryKit: "allowed",
    benchmarkKdf: "allowed",
    recoveryKeyLabel: "allowed",
    cancelRecoveryKey: "allowed",
    recover: "allowed",
    pickBackupDestination: "write",
    saveBackupToPicked: "write",
    backupSize: "allowed",
    leftOutRecords: "allowed",
    prepareProfileExport: "write",
    pickProfileExportDestination: "write",
    saveProfileExportToPicked: "write",
    pickProfileImportSource: "allowed",
    profileImportKeyKind: "allowed",
    inspectProfileImport: "allowed",
    importProfile: "write",
    pickRestoreSource: "allowed",
    inspectRestore: "allowed",
    restore: "allowed",
    createProfile: "write",
    renameProfile: "write",
    updateProfileDetails: "write",
    sharedIdentity: "allowed",
    createFolder: "write",
    updateFolder: "write",
    renameRecord: "write",
    assignFolders: "write",
    assignFoldersBatch: "write",
    pickImportFiles: "allowed",
    importPickedFiles: "write",
    pickExportDestination: "allowed",
    exportToPicked: "allowed",
    savePhoto: "write",
    videoStart: "write",
    videoAppend: "write",
    videoPause: "write",
    videoResume: "write",
    videoStop: "write",
    videoSpace: "allowed",
    videoPending: "allowed",
    videoRecover: "write",
    isVideo: "allowed",
    videoOpen: "allowed",
    videoClose: "allowed",
    isPhoto: "allowed",
    viewPhoto: "allowed",
    hideProfile: "write",
    restoreProfile: "write",
    hideRecord: "write",
    unhideRecord: "write",
    hideUnavailableRecords: "write",
    isLockedPdf: "allowed",
    unlockPdf: "allowed",
    listReceived: "allowed",
    acceptReceived: "write",
    discardReceived: "write",
    moveToPerson: "write",
    viewPage: "allowed",
    cancelView: "allowed",
    readAndroidPdf: "allowed",
    pageBoxes: "allowed",
    aiModelStatus: "allowed",
    aiSummarize: "allowed",
    aiExplain: "allowed",
    aiCancel: "allowed",
    aiModelSpeed: "allowed",
    onAiAnswerStarted: "allowed",
    onVaultLocked: "allowed",
    trayWaiting: "allowed",
    onTrayWaiting: "allowed",
    documentText: "allowed",
    cancelDocumentText: "allowed",
    recordKnownDetails: "allowed",
    pickTextExportDestination: "allowed",
    exportTextToPicked: "allowed",
    copyTextExport: "allowed",
    saveAiResult: "write",
    aiResults: "allowed",
    readAiResult: "allowed",
    reset: "allowed",
  };
  const BRIDGE_WRITES = (
    Object.keys(BRIDGE_CLASS) as (keyof VaultBridge)[]
  ).filter((name) => BRIDGE_CLASS[name] === "write");

  it("offers a hidden person in no menu, dialog or picker the library opens: not the Add menu, the head menu, a document's details, or the move choices", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockImplementation(async () =>
        captureSnapshot({
          ...withHiddenCasey(),
          profiles: [
            ...snapshotWithRecord.profiles,
            { id: "profile-2", displayName: "FAKE Robin", createdAtMs: 2 },
          ],
        }),
      ),
      hideProfile: vi.fn().mockResolvedValue(undefined),
      restoreProfile: vi.fn().mockResolvedValue([]),
      updateProfileDetails: vi.fn().mockResolvedValue(undefined),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: humanText("Jamie") });
    const name = "Hiddenname";
    // The values of the choices count too: an option's text is what a picker lists.
    const optionsSaying = () =>
      Array.from(document.querySelectorAll("option")).filter((option) =>
        (option.textContent ?? "").includes(name),
      );
    const clean = (where: string) => {
      expect(placesThatSay(name), where).toEqual([]);
      expect(optionsSaying(), `${where} (options)`).toEqual([]);
    };
    clean("the library");
    // Every button that opens a menu or a dialog, one at a time, and closes it again. The openers
    // are named here: one that is dropped or renamed fails this test, and a click that brings no
    // popup is not counted as having been looked at.
    const isolates = /[\u2066-\u2069]/g;
    const labelOf = (button: HTMLElement) =>
      (button.getAttribute("aria-label") ?? button.textContent ?? "")
        .replace(isolates, "")
        .trim();
    const openers = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button[aria-haspopup]"),
    );
    expect(openers.map(labelOf).sort()).toEqual([
      // The sidebar's and the header's Add control (the overhaul renders it twice; one of them is
      // not on screen in this window's layout).
      "Add document▾",
      "Add document▾",
      "More for Jamie",
      "Sort by: Newest first",
      "View: List",
    ]);
    const popups =
      "[role=menu],[role=dialog],[role=alertdialog],[role=listbox]";
    // The popups that can be seen now (a closed one may stay in the page, hidden).
    const shown = () =>
      Array.from(document.querySelectorAll<HTMLElement>(popups)).filter(
        (popup) => popup.checkVisibility(),
      );
    // Only an opener the patient can see can be pressed: the one the layout hides is named above
    // and left out, and the ones that remain are exactly these four.
    const onScreen = openers.filter((opener) => opener.checkVisibility());
    expect(onScreen.map(labelOf).sort()).toEqual([
      "Add document▾",
      "More for Jamie",
      "Sort by: Newest first",
      "View: List",
    ]);
    for (const opener of onScreen) {
      const label = labelOf(opener);
      expect(opener.isConnected, `${label} is still on screen`).toBe(true);
      expect(opener, `${label} can be pressed`).toBeEnabled();
      await user.click(opener);
      // A popup really opened (an opener that does nothing would pass every check below).
      expect(opener.getAttribute("aria-expanded"), `${label} opened`).toBe(
        "true",
      );
      await waitFor(() =>
        expect(shown().length, `${label} brought a popup`).toBeGreaterThan(0),
      );
      clean(`after pressing ${label}`);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(shown()).toEqual([]));
    }
    // The head menu's own items open dialogs: each one's dialog is looked at too.
    const lookAtHeadMenuItem = async (item: RegExp) => {
      await user.click(
        screen.getByRole("button", { name: humanText(/^More for /) }),
      );
      const entry = await screen.findByRole("menuitem", {
        name: humanText(item),
      });
      const label = labelOf(entry);
      await user.click(entry);
      await waitFor(() =>
        expect(shown().length, `${label} brought a dialog`).toBeGreaterThan(0),
      );
      // The dialog itself, not the screen behind it: Edit details leads to Security, whose Hidden
      // people list names the hidden person on purpose (another test pins that).
      for (const dialog of shown().filter((popup) =>
        popup.matches("[role=dialog],[role=alertdialog]"),
      )) {
        expect(
          placesThatSay(name).filter((place) => dialog.contains(place)),
          `the dialog of ${label}`,
        ).toEqual([]);
        expect(
          Array.from(dialog.querySelectorAll("option")).filter((option) =>
            (option.textContent ?? "").includes(name),
          ),
          `the dialog of ${label} (options)`,
        ).toEqual([]);
      }
      await user.keyboard("{Escape}");
      await waitFor(() => expect(shown()).toEqual([]));
    };
    // Edit details goes last (at the end of this test): it leaves the library for Security.
    for (const item of [/^Rename /, /^Hide /]) await lookAtHeadMenuItem(item);
    // A document's details, and the person choices that a selection brings.
    await user.click(screen.getByText(humanText("FAKE_Results.pdf")));
    await screen.findByRole("dialog");
    clean("a document's details");
    await user.keyboard("{Escape}");
    const ticks = screen.queryAllByRole("button", {
      name: humanText(/^Select /),
    });
    // The loop below must have something to look at.
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect(tick.isConnected).toBe(true);
      await user.click(tick);
      clean("a selection");
    }
    // Edit details leads to Security: its dialog is looked at last, since the library is left.
    await lookAtHeadMenuItem(/^Edit details$/);
  });

  it("lets no control write while the vault is read-only: every enabled button in the library, a document's details and Security", async () => {
    const user = userEvent.setup();
    // A clinic is linked and its approval is waiting (as in the clinic tests), and a document
    // waits in Shared with me, so that the controls for both are on the screen.
    const readOnly: VaultSnapshot = {
      ...snapshotWithRecord,
      recovery: "writeFailed",
      recoveryKeySetAtMs: 5,
      portalLinkingEnabled: true,
      portalLinks: [
        {
          id: "fake-clinic-link",
          portalBase: "https://portal.example.test/patient",
          deviceName: "myCarlos FAKE device",
          profileId: null,
          clinicName: "FAKE First Clinic",
          fingerprints: [],
          incomplete: false,
          deviceKeyId: "FAKE_FIRST_DEVICE",
          deviceFingerprint: "11".repeat(32),
          approvalRequested: true,
          clinicApproved: false,
        },
      ],
      profiles: [
        ...snapshotWithRecord.profiles,
        { id: "profile-2", displayName: "FAKE Robin", createdAtMs: 2 },
        { id: "shared-1", displayName: "Shared with me", createdAtMs: 3 },
      ],
      sharedProfileId: "shared-1",
      records: [
        ...snapshotWithRecord.records,
        {
          ...snapshotWithRecord.records[0],
          id: "record-shared",
          profileId: "shared-1",
          displayName: "FAKE_Shared_Letter.pdf",
        },
      ],
      hiddenProfiles: [hiddenCasey],
    };
    // Every method a control could reach is present: the interface hides the control of a
    // method that is missing, which would make this test pass for the wrong reason.
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(readOnly)),
      hideProfile: vi.fn().mockResolvedValue(undefined),
      restoreProfile: vi.fn().mockResolvedValue([]),
      updateProfileDetails: vi.fn().mockResolvedValue(undefined),
      linkPortal: vi.fn().mockResolvedValue(undefined),
      connectPortal: vi.fn().mockResolvedValue(undefined),
      checkDocuments: vi
        .fn()
        .mockResolvedValue({ added: 0, refused: 0, receiptsPending: 0 }),
      requestDeviceApproval: vi.fn().mockResolvedValue(undefined),
      submitApprovalCode: vi.fn().mockResolvedValue(undefined),
      restartDeviceApproval: vi.fn().mockResolvedValue(undefined),
    });
    render(<VaultApp bridge={bridge} />);
    // With two people the library's heading is the person's name.
    await screen.findByRole("heading", { name: humanText("Jamie") });
    const calledWrites = () =>
      BRIDGE_WRITES.filter((name) => {
        const method = bridge[name] as unknown;
        return vi.isMockFunction(method) && method.mock.calls.length > 0;
      });
    // The classification covers every method the test bridge has, and no other.
    expect(
      Object.keys(bridge).filter((name) => !(name in BRIDGE_CLASS)),
    ).toEqual([]);
    // Not pressed, by their whole names: they close, move between pages and people, or erase the
    // vault (which stays possible, see BRIDGE_CLASS). Nothing else is skipped, and the set that
    // was skipped is asserted at the end, so a real write cannot hide in a substring.
    const NAVIGATION =
      /^(lock now|cancel|close|back|not now|done|skip|dismiss|my records|records|security|preferences|ai helper|shared with me|hidden|jamie\d.*|fake robin\d.*|shared with me\d.*|erase.*)$/i;
    const skipped = new Set<string>();
    const isNavigation = (name: string) => {
      const navigation = NAVIGATION.test(name);
      if (navigation) skipped.add(name);
      return navigation;
    };
    const nameOf = (element: Element) =>
      visibleText(
        element.getAttribute("aria-label") ?? element.textContent ?? "",
      ).trim();
    // Disclosures (a <summary>, such as "Show device details") hide controls until opened.
    const expandDisclosures = async () => {
      for (const summary of Array.from(document.querySelectorAll("summary")))
        if (!summary.closest("details")?.open) await user.click(summary);
    };
    const dialogsOpen = () => [
      ...screen.queryAllByRole("dialog"),
      ...screen.queryAllByRole("alertdialog"),
    ];
    const enabled = (element: Element) =>
      !(element as HTMLButtonElement).disabled &&
      element.getAttribute("aria-disabled") !== "true";
    const pressable = (scope?: HTMLElement) => {
      const where = scope ? within(scope) : screen;
      return [
        ...where.queryAllByRole("button"),
        ...where.queryAllByRole("menuitem"),
      ];
    };
    // Dialogs a press opened beyond the `keep` already open: their buttons are pressed too (a
    // confirmation is where a write would start), then they are closed.
    const closeWhatOpened = async (keep: number) => {
      for (let i = 0; i < 4 && dialogsOpen().length > keep; i += 1) {
        const dialog = dialogsOpen()[dialogsOpen().length - 1];
        for (const button of within(dialog).queryAllByRole("button")) {
          const name = nameOf(button);
          if (enabled(button) && name && !isNavigation(name)) {
            pressed.push(`(in a dialog) ${name}`);
            await user.click(button);
          }
        }
        await user.keyboard("{Escape}");
      }
    };
    const pressed: string[] = [];
    /** Presses every enabled button once, by its name, in `scope` (default: the page), and then
     * again for the buttons that pressing revealed (a selection reveals Move, for one). */
    const sweep = async (scope?: () => HTMLElement | null) => {
      const keep = dialogsOpen().length;
      const done = new Set<string>();
      for (let pass = 0; pass < 3; pass += 1) {
        const names = Array.from(
          new Set(
            pressable(scope?.() ?? undefined)
              .filter(enabled)
              .map(nameOf)
              .filter((name) => name && !done.has(name) && !isNavigation(name)),
          ),
        );
        if (!names.length) break;
        for (const name of names) {
          // A press can close the dialog being swept (as Back does): nothing is left in it.
          if (scope && !scope()) return;
          const target = pressable(scope?.() ?? undefined).find(
            (element) => enabled(element) && nameOf(element) === name,
          );
          if (!target) continue;
          done.add(name);
          pressed.push(name);
          await user.click(target);
          await closeWhatOpened(keep);
        }
      }
    };
    // The library.
    await sweep();
    // A document's details dialog, left open while its own buttons are pressed.
    await user.click(screen.getByText(humanText("FAKE_Results.pdf")));
    await screen.findByRole("dialog");
    const pressedBefore = pressed.length;
    await sweep(() => screen.queryByRole("dialog"));
    // (Pressing some of them closes the dialog, as Back does; the rest are still pressed.)
    expect(pressed.length).toBeGreaterThan(pressedBefore);
    if (screen.queryByRole("dialog")) await user.keyboard("{Escape}");
    // Shared with me: where a received document is accepted, discarded or moved to a person.
    await user.click(
      screen.getByRole("button", { name: humanText(/^Shared with me/) }),
    );
    await screen.findByText(humanText("FAKE_Shared_Letter.pdf"));
    await expandDisclosures();
    await sweep();
    const sharedLetter = screen.queryByText(
      humanText("FAKE_Shared_Letter.pdf"),
    );
    if (sharedLetter) {
      await user.click(sharedLetter);
      if (await screen.findByRole("dialog").catch(() => null)) {
        await sweep(() => screen.queryByRole("dialog"));
        if (screen.queryByRole("dialog")) await user.keyboard("{Escape}");
      }
    }
    // Security, which holds the clinic cards and the people.
    await user.click(
      screen.getByRole("button", { name: humanText(/Security/) }),
    );
    await expandDisclosures();
    // The clinic's controls are on the screen (not hidden for want of a bridge method) and are
    // refused by being disabled, not by being absent.
    for (const name of [
      "Retry saved approval request",
      "Link another clinic",
    ] as const) {
      const control = screen.getByRole("button", { name: humanText(name) });
      expect(control, name).toBeDisabled();
    }
    await sweep();
    // The sweep really pressed things (it is not vacuously quiet).
    expect(pressed.length).toBeGreaterThan(5);
    expect(calledWrites()).toEqual([]);
    // What was not pressed is the page and person navigation and the window's lock button, and
    // nothing else (a substring match used to skip, by accident, anything with "back" or "lock").
    expect(Array.from(skipped).sort()).toEqual([
      "AI helper",
      "FAKE Robin00 documents",
      "Jamie11 document",
      "Lock now",
      "Preferences",
      "Security",
      "Shared with me",
    ]);
  });

  // ---- After a lock and an unlock: nothing from before the lock is left ----

  it("shows nothing from before a lock after the unlock: no search text, selection, open dialog or notice", async () => {
    const user = userEvent.setup();
    const records = [
      {
        id: "record-a",
        profileId: "profile-1",
        folderIds: [],
        displayName: "FAKE_Report_A.pdf",
        sourceLabel: "Manual import — unverified",
        mediaType: "application/pdf",
        plaintextSize: 2048,
        importedAtMs: 1,
        available: true,
      },
      {
        id: "record-b",
        profileId: "profile-1",
        folderIds: [],
        displayName: "FAKE_Report_B.pdf",
        sourceLabel: "Manual import — unverified",
        mediaType: "application/pdf",
        plaintextSize: 2048,
        importedAtMs: 2,
        available: true,
      },
    ];
    let hiddenA = false;
    const current = () =>
      captureSnapshot({
        ...emptySnapshot,
        records: records
          .filter((record) => !(hiddenA && record.id === "record-a"))
          .map((record) => ({ ...record })),
      });
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockImplementation(async () => current()),
      unlock: vi.fn().mockImplementation(async () => current()),
      hideRecord: vi.fn().mockImplementation(async () => {
        hiddenA = true;
      }),
    });
    render(<VaultApp bridge={bridge} />);
    // A notice: hiding a document says so.
    await user.click(await screen.findByText(humanText("FAKE_Report_A.pdf")));
    await user.click(screen.getByRole("button", { name: humanText("Hide") }));
    await screen.findByText(humanText(/FAKE_Report_A\.pdf was hidden/));
    // Search text, a selection, and an open dialog (a document's details).
    const search = screen.getByRole("searchbox");
    await user.type(search, "Report_B");
    await user.click(
      screen.getByRole("button", { name: humanText(/^Select FAKE_Report_B/) }),
    );
    await user.click(screen.getByText(humanText("FAKE_Report_B.pdf")));
    await screen.findByRole("dialog");
    // The window's own lock button is under the dialog for a pointer: press it directly.
    fireEvent.click(windowLock());
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    // Nothing of the library is on the lock screen.
    expect(document.body.textContent).not.toContain("FAKE_Report");
    expect(document.body.textContent).not.toContain("was hidden");
    await user.type(
      screen.getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    await screen.findByRole("heading", { name: humanText("My records") });
    // After the unlock: a fresh library.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(document.body.textContent).not.toContain("was hidden");
    expect(
      screen.getByRole("button", { name: humanText(/^Select FAKE_Report_B/) }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText(humanText("FAKE_Report_A.pdf"))).toBeNull();
  });

  it("does not keep a clinic's code typed before a lock: the box is empty after the unlock, and the code was sent nowhere", async () => {
    const user = userEvent.setup();
    const asked = {
      id: "fake-clinic-link",
      portalBase: "https://portal.example.test/patient",
      deviceName: "myCarlos FAKE device",
      profileId: null,
      clinicName: "FAKE First Clinic",
      fingerprints: [],
      incomplete: false,
      deviceKeyId: "FAKE_FIRST_DEVICE",
      deviceFingerprint: "11".repeat(32),
      approvalRequested: true,
      clinicApproved: false,
      approvalStatus: "challenge_ready",
      approvalByCode: true,
    };
    const snapshotWithClinic = () =>
      captureSnapshot({
        ...snapshotWithRecord,
        recoveryKeySetAtMs: 5,
        portalLinkingEnabled: true,
        portalLinks: [asked],
      } as VaultSnapshot);
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockImplementation(async () => snapshotWithClinic()),
      unlock: vi.fn().mockImplementation(async () => snapshotWithClinic()),
      linkPortal: vi.fn(),
      connectPortal: vi.fn(),
      checkDocuments: vi
        .fn()
        .mockResolvedValue({ added: 0, refused: 0, receiptsPending: 0 }),
      requestDeviceApproval: vi.fn().mockResolvedValue(undefined),
      restartDeviceApproval: vi.fn().mockResolvedValue(undefined),
      submitApprovalCode: vi.fn().mockResolvedValue(undefined),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText(/Security/) }),
    );
    const codeBox = () =>
      screen.getByRole("textbox", {
        name: humanText("Code from your clinic's email"),
      });
    await user.type(codeBox(), "482193645");
    expect(codeBox()).toHaveValue("482193645");
    fireEvent.click(windowLock());
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    expect(document.body.textContent).not.toContain("482193645");
    expect(document.body.textContent).not.toContain("FAKE First Clinic");
    await user.type(
      screen.getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    await user.click(
      await screen.findByRole("button", { name: humanText(/Security/) }),
    );
    expect(codeBox()).toHaveValue("");
    // The typed digits were never sent, and nothing of them is on the page.
    expect(bridge.submitApprovalCode).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("482193645");
  });

  // ---- After Erase and set-up: nothing of the old vault shows ----

  it("shows nothing of the old vault after it is set aside and a new one is made: no names, document, clinic, notice or search", async () => {
    const user = userEvent.setup();
    const oldSnapshot = (): VaultSnapshot =>
      captureSnapshot({
        ...snapshotWithRecord,
        profiles: [
          {
            id: "profile-1",
            displayName: "FAKE Oldname Person",
            createdAtMs: 1,
          },
        ],
        hiddenProfiles: [
          {
            id: "profile-9",
            displayName: "FAKE Oldname Hidden",
            hiddenAtMs: 1_700_000_000_000,
            documents: 1,
          },
        ],
        records: [
          {
            ...snapshotWithRecord.records[0],
            displayName: "FAKE_Oldname_Letter.pdf",
          },
        ],
        recoveryKeySetAtMs: 5,
        portalLinkingEnabled: true,
        portalLinks: [
          {
            id: "fake-clinic-link",
            portalBase: "https://portal.example.test/patient",
            deviceName: "myCarlos FAKE device",
            profileId: null,
            clinicName: "FAKE Oldname Clinic",
            fingerprints: [],
            incomplete: false,
            deviceKeyId: "FAKE_FIRST_DEVICE",
            deviceFingerprint: "11".repeat(32),
            approvalRequested: true,
            clinicApproved: false,
          },
        ],
      } as VaultSnapshot);
    const newSnapshot = (): VaultSnapshot =>
      captureSnapshot({
        ...emptySnapshot,
        profiles: [
          { id: "profile-new", displayName: "FAKE Newname", createdAtMs: 9 },
        ],
        records: [],
      });
    let erased = false;
    const bridge = nativeBridge({
      status: vi
        .fn()
        .mockImplementation(async () => (erased ? "absent" : "unlocked")),
      snapshot: vi
        .fn()
        .mockImplementation(async () =>
          erased ? newSnapshot() : oldSnapshot(),
        ),
      unlock: vi.fn().mockImplementation(async () => oldSnapshot()),
      create: vi.fn().mockImplementation(async () => newSnapshot()),
      hideRecord: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn().mockImplementation(async () => {
        erased = true;
        return true;
      }),
      checkDocuments: vi
        .fn()
        .mockResolvedValue({ added: 0, refused: 0, receiptsPending: 0 }),
      requestDeviceApproval: vi.fn().mockResolvedValue(undefined),
    });
    render(<VaultApp bridge={bridge} />);
    // Old-vault state on the screen: a search, and a notice (hiding the document says so).
    await user.type(await screen.findByRole("searchbox"), "Oldname");
    await user.click(screen.getByText(humanText("FAKE_Oldname_Letter.pdf")));
    await user.click(screen.getByRole("button", { name: humanText("Hide") }));
    await screen.findByText(humanText(/FAKE_Oldname_Letter\.pdf was hidden/));
    // Lock, then set the vault aside from the lock screen.
    fireEvent.click(windowLock());
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await user.click(screen.getByText(humanText("Forgot your passphrase?")));
    await user.type(
      screen.getByLabelText(humanText("Type RESET MYCARLOS VAULT")),
      "RESET MYCARLOS VAULT",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Set vault aside") }),
    );
    await continuePastComfort();
    expect(document.body.textContent).not.toContain("Oldname");
    await user.type(
      await screen.findByLabelText(
        humanText("Whose records will you keep here?"),
      ),
      "FAKE Newname",
    );
    await user.type(
      screen.getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.type(
      screen.getByLabelText(humanText("Confirm passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Create vault") }),
    );
    // The new vault's library.
    await screen.findByRole("heading", { name: humanText("My records") });
    expect(document.body.textContent).not.toContain("Oldname");
    expect(screen.getByRole("searchbox")).toHaveValue("");
    // Its Security page: no clinic card, and no hidden people.
    await user.click(
      screen.getByRole("button", { name: humanText(/Security/) }),
    );
    expect(document.body.textContent).not.toContain("Oldname");
    expect(
      screen.queryByRole("heading", { name: "FAKE Oldname Clinic" }),
    ).toBeNull();
    expect(document.querySelector(".native-hidden-people")).toBeNull();
  });

  // Every `mycarlos.*` key the app writes to the webview's storage, in one of two kinds. A new key
  // has to be placed here (the first test below reads the sources and fails until it is), which
  // is the moment to decide whether erasing a vault must forget it.
  /** About one vault, and told or used at its next unlock: erasing the vault must remove it. */
  const VAULT_NOTES: Record<string, string> = {
    "mycarlos.unfinishedRecoveryKey.v1": JSON.stringify({ setAtMs: 5 }),
    "mycarlos.oldBackupsGuide.v1": JSON.stringify({ step: "save" }),
    "mycarlos.unfinishedHandover.v1": "1",
  };
  /** About this device, naming no vault or patient (the recovery offer's hour says so itself):
   * kept when a vault is erased, as the same person keeps the same device. */
  const DEVICE_SETTINGS: Record<string, string> = {
    "mycarlos.aiLabelShort.v1": "{}",
    "mycarlos.appearance.v1": "dark",
    "mycarlos.autoLockMinutes.v1": "10",
    "mycarlos.cameraExplained.v1": "1",
    "mycarlos.language.v1": "fr",
    "mycarlos.recoveryOfferHour.v1": "480000",
    "mycarlos.videoQuality.v1": "high",
    "mycarlos.zoom.v1": "1.25",
  };

  // What these guards cover: the webview's localStorage keys named `mycarlos.*` in the sources.
  // Not covered: sessionStorage, IndexedDB and cookies (the first test pins that no source uses
  // them), and anything the native side keeps (its settings and the vault itself).
  const appSources = () => {
    const sources = import.meta.glob("/src/**/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    return Object.entries(sources).filter(
      ([path]) => !/\.test\.|\/test\//.test(path),
    );
  };

  it("pins the sources that use webview storage: only localStorage, in these files", () => {
    const users = appSources()
      .filter(([, text]) =>
        /localStorage|sessionStorage|indexedDB|document\.cookie/.test(text),
      )
      .map(([path]) => path)
      .sort();
    expect(users).toEqual([
      "/src/aiLabelPreference.ts",
      "/src/appearance.ts", // keeps `window.localStorage` in a local `storage` alias
      "/src/i18n/core.ts",
      "/src/native/autoLock.ts",
      "/src/native/oldBackups.ts",
      "/src/native/photo.ts",
      "/src/native/recoveryOffer.ts",
      "/src/native/unfinishedHandover.ts",
      "/src/native/unfinishedRecoveryKey.ts",
      "/src/native/video.ts",
      "/src/native/zoom.ts",
    ]);
    for (const [path, text] of appSources())
      expect(
        /sessionStorage|indexedDB|document\.cookie/.test(text),
        `${path} uses a store these guards do not cover`,
      ).toBe(false);
  });

  it("lists every mycarlos.* localStorage key the sources write, and each is a vault note or a device setting", () => {
    const found = new Set<string>();
    for (const [path, text] of appSources()) {
      // Any string that starts with the app's prefix: dashes and underscores included.
      for (const match of text.matchAll(/["'`](mycarlos\.[^"'`]*)["'`]/g)) {
        // A key built at run time cannot be listed, so none may be (`${…}` or a concatenation).
        expect(match[1], `${path}: a key built at run time`).not.toMatch(
          /\$\{|\.$/,
        );
        found.add(match[1]);
      }
      expect(text, `${path}: a key built by concatenation`).not.toMatch(
        /["'`]mycarlos\.[^"'`]*["'`]\s*\+|\+\s*["'`]mycarlos\./,
      );
    }
    expect(Array.from(found).sort()).toEqual(
      [...Object.keys(VAULT_NOTES), ...Object.keys(DEVICE_SETTINGS)].sort(),
    );
  });

  it("no caller gives the unfinished-handover note a scope: erase clears the one key, so a scope must not appear unnoticed", () => {
    // `unfinishedHandover.ts` can keep one note per vault slot (#357). Erase clears the unscoped
    // key only, because clearing by prefix would wipe another vault's note. When a caller starts
    // passing a scope, this test fails: erase must then clear the erased vault's own scope.
    const topLevelArguments = (call: string) =>
      call
        .replace(/\([^()]*\)/g, "()")
        .split(",")
        .map((argument) => argument.trim())
        .filter(Boolean);
    let calls = 0;
    for (const [path, text] of appSources()) {
      if (path === "/src/native/unfinishedHandover.ts") continue;
      for (const match of text.matchAll(
        /(rememberUnfinishedHandover|takeUnfinishedHandover)\(((?:[^()]|\([^()]*\))*)\)/g,
      )) {
        calls += 1;
        const given = topLevelArguments(match[2]).length;
        expect(
          given,
          `${path}: ${match[1]}(${match[2].trim()}) passes a scope`,
        ).toBe(match[1] === "rememberUnfinishedHandover" ? 1 : 0);
      }
    }
    // The scan finds the calls it is about (VaultApp's two, today).
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("erasing a vault removes every note about it from the device, and keeps the device's settings", async () => {
    const user = userEvent.setup();
    let erased = false;
    const bridge = nativeBridge({
      status: vi
        .fn()
        .mockImplementation(async () => (erased ? "absent" : "locked")),
      reset: vi.fn().mockImplementation(async () => {
        erased = true;
        return true;
      }),
    });
    for (const [key, value] of Object.entries({
      ...VAULT_NOTES,
      ...DEVICE_SETTINGS,
    }))
      window.localStorage.setItem(key, value);
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await user.click(screen.getByText(humanText("Forgot your passphrase?")));
    await user.type(
      screen.getByLabelText(humanText("Type RESET MYCARLOS VAULT")),
      "RESET MYCARLOS VAULT",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Set vault aside") }),
    );
    await continuePastComfort();
    const left = (keys: string[]) =>
      keys.filter((key) => window.localStorage.getItem(key) !== null);
    expect(left(Object.keys(VAULT_NOTES))).toEqual([]);
    expect(left(Object.keys(DEVICE_SETTINGS)).sort()).toEqual(
      Object.keys(DEVICE_SETTINGS).sort(),
    );
  });

  it("CONTROL tells the vault that locked with a handover key on screen, at its next unlock", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("locked"),
    });
    window.localStorage.setItem("mycarlos.unfinishedHandover.v1", "1");
    render(<VaultApp bridge={bridge} />);
    await user.type(
      await screen.findByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    await screen.findByRole("heading", { name: humanText("My records") });
    expect(
      await screen.findByText(humanText(/A handover was not finished/)),
    ).toBeVisible();
  });

  it("does not tell the new vault, at its first unlock, that a handover of the erased vault was not finished", async () => {
    const user = userEvent.setup();
    let erased = false;
    const bridge = nativeBridge({
      status: vi
        .fn()
        .mockImplementation(async () => (erased ? "absent" : "locked")),
      reset: vi.fn().mockImplementation(async () => {
        erased = true;
        return true;
      }),
    });
    // The old vault had a handover key on screen when it locked.
    window.localStorage.setItem("mycarlos.unfinishedHandover.v1", "1");
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await user.click(screen.getByText(humanText("Forgot your passphrase?")));
    await user.type(
      screen.getByLabelText(humanText("Type RESET MYCARLOS VAULT")),
      "RESET MYCARLOS VAULT",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Set vault aside") }),
    );
    await continuePastComfort();
    await user.type(
      await screen.findByLabelText(
        humanText("Whose records will you keep here?"),
      ),
      "FAKE Newname",
    );
    await user.type(
      screen.getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.type(
      screen.getByLabelText(humanText("Confirm passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Create vault") }),
    );
    await user.click(
      await screen.findByRole("button", { name: humanText(/Lock now/) }),
    );
    await user.type(
      await screen.findByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    // On the lock screen the new vault says only that it locked.
    expect(document.body.textContent).not.toContain(
      "A handover was not finished",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    await screen.findByRole("heading", { name: humanText("My records") });
    // The message is said a moment after the unlock (see the control above): wait for it.
    await new Promise((resolve) => setTimeout(resolve, ANNOUNCE_DELAY_MS * 3));
    expect(document.body.textContent).not.toContain(
      "A handover was not finished",
    );
    // And the note is gone from the device, not waiting for a later unlock.
    expect(
      window.localStorage.getItem("mycarlos.unfinishedHandover.v1"),
    ).toBeNull();
  });

  it("hides a document at once, never deletes it, and restores it from Hidden (#71)", async () => {
    const user = userEvent.setup();
    const record = {
      id: "record-1",
      profileId: "profile-1",
      folderIds: [],
      displayName: "FAKE_Report.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/octet-stream",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: true,
    };
    const hideRecord = vi.fn().mockResolvedValue(undefined);
    const unhideRecord = vi.fn().mockResolvedValue(undefined);
    const hidden = {
      ...record,
      hidden: { atMs: 5, reason: "patient" as const },
    };
    const snapshot = vi
      .fn()
      .mockImplementationOnce(async () =>
        captureSnapshot({ ...emptySnapshot, records: [record] }),
      )
      .mockImplementationOnce(async () =>
        captureSnapshot({ ...emptySnapshot, records: [hidden] }),
      )
      .mockImplementation(async () =>
        captureSnapshot({ ...emptySnapshot, records: [record] }),
      );
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot,
      hideRecord,
      unhideRecord,
    });
    const shim = tauriConfirmShim();
    render(<VaultApp bridge={bridge} />);

    // Hiding is undone from Hidden, so it asks nothing first (#71).
    await user.click(await screen.findByText(humanText("FAKE_Report.pdf")));
    await user.click(screen.getByRole("button", { name: humanText("Hide") }));
    await waitFor(() => expect(hideRecord).toHaveBeenCalledWith("record-1"));
    expect(
      await screen.findByText(
        humanText(
          "FAKE_Report.pdf was hidden. It stays in the vault under Hidden.",
        ),
      ),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByText(humanText("FAKE_Report.pdf")),
    ).not.toBeInTheDocument();

    // Under Hidden, with its size, and back with Restore.
    await user.click(screen.getByRole("button", { name: "Security" }));
    await user.click(
      screen.getByRole("button", { name: humanText(/^Hidden/) }),
    );
    expect(
      screen.getByRole("heading", { name: humanText("Hidden") }),
    ).toBeVisible();
    expect(screen.getByText(humanText("1 document · 2 KB"))).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: humanText("Restore FAKE_Report.pdf"),
      }),
    );
    await waitFor(() => expect(unhideRecord).toHaveBeenCalledWith("record-1"));
    expect(
      await screen.findByText(
        humanText("FAKE_Report.pdf was restored to where it was."),
      ),
    ).toBeVisible();
    expect(shim).not.toHaveBeenCalled();
  });

  it("ignores window blur and locks after 5 minutes of inactivity", async () => {
    vi.useFakeTimers();
    try {
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
      });
      // Await the initial session load inside the timer-controlled act scope.
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });
      expect(
        screen.getByRole("heading", { name: humanText("My records") }),
      ).toBeVisible();

      window.dispatchEvent(new Event("blur"));
      await act(async () => undefined);
      expect(bridge.lock).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
      expect(bridge.lock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a drag released where it started as no move", async () => {
    const record = {
      id: "record-1",
      profileId: "profile-1",
      folderIds: [],
      displayName: "FAKE_Stay.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/pdf",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: true,
    };
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () =>
          captureSnapshot({ ...emptySnapshot, records: [record] }),
        ),
    });
    render(<VaultApp bridge={bridge} />);
    const document = await screen.findByRole("article", {
      name: humanText("FAKE_Stay.pdf document"),
    });
    const pane = screen.getByRole("main");

    const transfer = dragTransfer();
    fireDragEvent("dragstart", document, { dataTransfer: transfer });
    fireDragEvent("dragover", pane, { dataTransfer: transfer });
    fireDragEvent("drop", pane, { dataTransfer: transfer });
    await act(async () => undefined);

    expect(bridge.assignFoldersBatch).not.toHaveBeenCalled();
    expect(screen.queryByText(humanText(/moved to/))).not.toBeInTheDocument();
  });

  it("does not lock under a picker it opened, but locks once the picker closes if still hidden", async () => {
    // On Android the system picker is a separate activity, so the page is
    // hidden for as long as it is open.
    const user = userEvent.setup();
    let finishPick!: (pickId: string | null) => void;
    const pickImportFiles = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          finishPick = resolve;
        }),
    );
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      pickImportFiles,
    });
    let visibilityState: DocumentVisibilityState = "visible";
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibilityState);
    try {
      render(<VaultApp bridge={bridge} />);
      await user.click(await importMenuItem());
      await waitFor(() => expect(pickImportFiles).toHaveBeenCalled());

      await act(async () => {
        visibilityState = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(bridge.lock).not.toHaveBeenCalled();
      expect(
        screen.getByRole("heading", { name: humanText("My records") }),
      ).toBeVisible();

      // The picker returns while the app is still hidden: the user left with
      // it open, so this is a backgrounding after all.
      await act(async () => finishPick("pick-1"));
      await waitFor(() => expect(bridge.lock).toHaveBeenCalledOnce());
      expect(
        await screen.findByRole("heading", {
          name: humanText("Unlock your vault"),
        }),
      ).toBeVisible();
    } finally {
      visibility.mockRestore();
    }
  });

  it.each([
    ["android", false],
    ["ios", false],
    ["windows", true],
  ])(
    "on %s, a page hidden while the camera is asked for locks at once: %s (D97)",
    async (platform, locksAtOnce) => {
      // Android hides the app under its camera permission question, as under
      // a picker; a computer's question does not hide it, so there a hidden
      // page is a real backgrounding.
      const user = userEvent.setup();
      let answer!: (stream: MediaStream) => void;
      const getUserMedia = vi
        .spyOn(navigator.mediaDevices, "getUserMedia")
        .mockImplementation(
          () =>
            new Promise<MediaStream>((resolve) => {
              answer = resolve;
            }),
        );
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        platform: vi.fn().mockResolvedValue(platform),
      });
      let visibilityState: DocumentVisibilityState = "visible";
      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockImplementation(() => visibilityState);
      try {
        window.localStorage.removeItem("mycarlos.cameraExplained.v1");
        render(<VaultApp bridge={bridge} />);
        await chooseAdd(user, "Take a photo");
        await user.click(
          screen.getByRole("button", { name: humanText("Use the camera") }),
        );
        await waitFor(() => expect(getUserMedia).toHaveBeenCalled());

        await act(async () => {
          visibilityState = "hidden";
          document.dispatchEvent(new Event("visibilitychange"));
        });
        if (locksAtOnce) {
          await waitFor(() => expect(bridge.lock).toHaveBeenCalledOnce());
          return;
        }
        expect(bridge.lock).not.toHaveBeenCalled();
        expect(
          screen.getByRole("dialog", { name: humanText("Take a photo") }),
        ).toBeVisible();

        // Answered while the app is still hidden: the patient left, so it
        // locks after all, and the camera that came is stopped.
        const canvas = document.createElement("canvas");
        const stream = canvas.captureStream(1);
        await act(async () => answer(stream));
        await waitFor(() => expect(bridge.lock).toHaveBeenCalledOnce());
        await waitFor(() =>
          expect(
            stream.getTracks().every((track) => track.readyState === "ended"),
          ).toBe(true),
        );
      } finally {
        visibility.mockRestore();
        getUserMedia.mockRestore();
        window.localStorage.removeItem("mycarlos.cameraExplained.v1");
      }
    },
  );

  it("imports the chosen files when the page is visible again after the picker", async () => {
    const user = userEvent.setup();
    let finishPick!: (pickId: string | null) => void;
    const pickImportFiles = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          finishPick = resolve;
        }),
    );
    const importPickedFiles = vi
      .fn()
      .mockResolvedValue({ imported: ["record-1"], skippedDuplicates: [] });
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      pickImportFiles,
      importPickedFiles,
    });
    let visibilityState: DocumentVisibilityState = "visible";
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibilityState);
    try {
      render(<VaultApp bridge={bridge} />);
      await user.click(await importMenuItem());
      await waitFor(() => expect(pickImportFiles).toHaveBeenCalled());
      await act(async () => {
        visibilityState = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => {
        visibilityState = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => finishPick("pick-1"));

      await waitFor(() =>
        expect(importPickedFiles).toHaveBeenCalledWith(
          "pick-1",
          "profile-1",
          [],
        ),
      );
      expect(bridge.lock).not.toHaveBeenCalled();
      expect(
        await screen.findByText(humanText("1 document encrypted and added.")),
      ).toBeVisible();
    } finally {
      visibility.mockRestore();
    }
  });

  it("does not count time in a picker as inactivity", async () => {
    vi.useFakeTimers();
    try {
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        pickImportFiles: vi.fn(() => new Promise<never>(() => undefined)),
      });
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });
      const importItem = importMenuItemNow();
      await act(async () => {
        fireEvent.click(importItem);
      });
      await act(async () => vi.advanceTimersByTime(6 * 60 * 1000));
      expect(bridge.lock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("locks once a picker has been left open past the grace period", async () => {
    vi.useFakeTimers();
    try {
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        pickExportDestination: vi.fn(() => new Promise<never>(() => undefined)),
        pickImportFiles: vi.fn(() => new Promise<never>(() => undefined)),
      });
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });
      const importItem = importMenuItemNow();
      await act(async () => {
        fireEvent.click(importItem);
      });
      // A walked-away desktop dialog: the grace period, then the delay.
      await act(async () => vi.advanceTimersByTime(15 * 60 * 1000));
      expect(bridge.lock).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000 + 10_000));
      expect(bridge.lock).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart the deadline for a picker left open past the grace period", async () => {
    vi.useFakeTimers();
    try {
      let finishPick!: (pickId: string | null) => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        pickImportFiles: vi.fn(
          () =>
            new Promise<string | null>((resolve) => {
              finishPick = resolve;
            }),
        ),
      });
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });
      const importItem = importMenuItemNow();
      await act(async () => {
        fireEvent.click(importItem);
      });
      // Suspended under Android's picker, then away from it for an hour.
      vi.setSystemTime(Date.now() + 60 * 60 * 1000);
      await act(async () => finishPick(null));
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(bridge.lock).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the inactivity deadline when a picker closes before the recheck", async () => {
    vi.useFakeTimers();
    try {
      let finishPick!: (pickId: string | null) => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        pickImportFiles: vi.fn(
          () =>
            new Promise<string | null>((resolve) => {
              finishPick = resolve;
            }),
        ),
      });
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });
      const importItem = importMenuItemNow();
      await act(async () => {
        fireEvent.click(importItem);
      });
      // Timers do not run while the page is suspended under Android's picker
      // activity, so no recheck sees the picker open.
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      await act(async () => finishPick(null));
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(bridge.lock).not.toHaveBeenCalled();
      expect(
        screen.getByRole("heading", { name: humanText("My records") }),
      ).toBeVisible();

      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
      expect(bridge.lock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("while an AI answer is written (D19)", () => {
    const summary: ModelSummary = {
      sentences: [{ text: "FAKE: a short summary.", quote: "FAKE results" }],
      model: FAKE_MODEL,
      lastPage: 0,
      lastPageCut: false,
      keptId: "FAKE-kept-1",
    };
    // Opens FAKE_Results.pdf in the reader and asks for its summary, on fake
    // timers. The answer waits until the test settles it; `started` is what
    // native says once the model is asked it.
    async function askForSummary(synchronousLimit?: number) {
      let settle!: {
        resolve: (written: ModelSummary) => void;
        reject: (failure: unknown) => void;
      };
      // Every answer asked, oldest first.
      const settles: (typeof settle)[] = [];
      let started: (answer: {
        answerId: string;
        limitMs: number;
      }) => void = () => undefined;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        snapshot: vi
          .fn()
          .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
        viewPage: vi.fn().mockResolvedValue({
          pageCount: 1,
          width: 800,
          height: 1035,
          image:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          text: "FAKE results text",
        }),
        documentText: vi.fn(async () =>
          fakeDocumentText(["FAKE results text"]),
        ),
        aiModelStatus: vi
          .fn()
          .mockResolvedValue({ state: "installed", model: FAKE_MODEL }),
        aiSummarize: vi.fn((_pages, _lang, _keep, answerId) => {
          if (synchronousLimit !== undefined)
            started({ answerId: answerId!, limitMs: synchronousLimit });
          return new Promise<ModelSummary>((resolve, reject) => {
            settle = { resolve, reject };
            settles.push(settle);
          });
        }),
        onAiAnswerStarted: vi.fn(
          (
            handler: (answer: { answerId: string; limitMs: number }) => void,
          ) => {
            started = handler;
            return () => undefined;
          },
        ),
      });
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });
      await act(async () => {
        fireEvent.click(screen.getByText(humanText("FAKE_Results.pdf")));
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: humanText("Read") }),
        );
      });
      const reader = screen.getByRole("dialog", {
        name: humanText("FAKE_Results.pdf"),
      });
      await act(async () => {
        fireEvent.click(
          within(reader).getByRole("button", { name: humanText("Summary") }),
        );
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: humanText("Continue") }),
        );
      });
      // The kept answers looked up, then the text read, then the model asked.
      for (let flush = 0; flush < 10; flush += 1) {
        if (vi.mocked(bridge.aiSummarize).mock.calls.length) break;
        await act(async () => undefined);
      }
      expect(bridge.aiSummarize).toHaveBeenCalledOnce();
      return {
        bridge,
        settle: () => settle,
        settles,
        started: (limitMs: number, index = settles.length - 1) =>
          act(async () => {
            const answerId = vi.mocked(bridge.aiSummarize).mock.calls[index][3];
            expect(answerId).toMatch(/^[0-9a-f-]{36}$/);
            started({ answerId: answerId!, limitMs });
          }),
      };
    }

    it("ownership: the token exists before a synchronous started event", async () => {
      vi.useFakeTimers();
      try {
        const { bridge } = await askForSummary(5 * 60 * 1000);
        await act(async () => vi.advanceTimersByTime(10 * 60 * 1000 + 10_000));
        expect(bridge.lock).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("ownership: a failed manual lock keeps the current answer's session", async () => {
      vi.useFakeTimers();
      try {
        const { bridge, started } = await askForSummary();
        await started(5 * 60 * 1000);
        vi.mocked(bridge.lock).mockRejectedValueOnce({ code: "storage" });
        await act(async () => fireEvent.click(windowLock()));
        await act(async () => vi.advanceTimersByTime(6 * 60 * 1000));
        expect(bridge.lock).toHaveBeenCalledOnce();
        await act(async () => vi.advanceTimersByTime(4 * 60 * 1000 + 10_000));
        expect(bridge.lock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    for (const ending of ["pending", "resolve", "reject"] as const) {
      it(`ownership: an old answer ${ending} cannot postpone the next session`, async () => {
        vi.useFakeTimers();
        try {
          const { bridge, settles } = await askForSummary();
          await act(async () => fireEvent.click(windowLock()));
          expect(bridge.lock).toHaveBeenCalledOnce();
          vi.mocked(bridge.unlock).mockImplementation(async () =>
            captureSnapshot(snapshotWithRecord),
          );
          await act(async () => {
            fireEvent.change(screen.getByLabelText(humanText("Passphrase")), {
              target: { value: "river-azimuth-cobalt-sparrow-934" },
            });
            fireEvent.click(
              screen.getByRole("button", { name: humanText("Unlock") }),
            );
          });
          expect(
            screen.getByRole("heading", { name: humanText("My records") }),
          ).toBeVisible();
          await act(async () => vi.advanceTimersByTime(4 * 60 * 1000));
          if (ending !== "pending")
            await act(async () => {
              if (ending === "resolve") settles[0].resolve(summary);
              else settles[0].reject({ code: "aiCancelled" });
            });
          await act(async () => vi.advanceTimersByTime(60_000 + 10_000));
          expect(bridge.lock).toHaveBeenCalledTimes(2);
        } finally {
          vi.useRealTimers();
        }
      });
    }

    it("ownership: a superseded answer's late start and end cannot extend the current answer", async () => {
      vi.useFakeTimers();
      try {
        const { bridge, settles, started } = await askForSummary();
        const summaryButton = () =>
          within(
            screen.getByRole("dialog", { name: humanText("FAKE_Results.pdf") }),
          ).getByRole("button", { name: humanText("Summary") });
        await act(async () => fireEvent.click(summaryButton()));
        await act(async () => fireEvent.click(summaryButton()));
        for (
          let flush = 0;
          flush < 10 && vi.mocked(bridge.aiSummarize).mock.calls.length < 2;
          flush += 1
        )
          await act(async () => undefined);
        expect(bridge.aiSummarize).toHaveBeenCalledTimes(2);
        await started(5 * 60 * 1000);
        await act(async () => vi.advanceTimersByTime(4 * 60 * 1000));
        await started(20 * 60 * 1000, 0);
        await act(async () => settles[0].reject({ code: "aiCancelled" }));
        await act(async () => vi.advanceTimersByTime(6 * 60 * 1000 + 10_000));
        expect(bridge.lock).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("ownership: old delivery cannot retain work after the current answer ends", async () => {
      vi.useFakeTimers();
      try {
        const { bridge, settles } = await askForSummary();
        const button = () =>
          within(
            screen.getByRole("dialog", { name: humanText("FAKE_Results.pdf") }),
          ).getByRole("button", { name: humanText("Summary") });
        await act(async () => fireEvent.click(button()));
        await act(async () => fireEvent.click(button()));
        for (let i = 0; i < 10 && settles.length < 2; i += 1)
          await act(async () => undefined);
        expect(settles).toHaveLength(2);
        await act(async () => vi.advanceTimersByTime(60_000));
        await act(async () => settles[1].resolve(summary));
        await act(async () => vi.advanceTimersByTime(5 * 60 * 1000 + 10_000));
        expect(bridge.lock).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("ownership: old started and settled deliveries cannot extend an answer in a new session", async () => {
      vi.useFakeTimers();
      try {
        const { bridge, settles, started } = await askForSummary();
        await act(async () => fireEvent.click(windowLock()));
        vi.mocked(bridge.unlock).mockImplementation(async () =>
          captureSnapshot(snapshotWithRecord),
        );
        await act(async () => {
          fireEvent.change(screen.getByLabelText(humanText("Passphrase")), {
            target: { value: "river-azimuth-cobalt-sparrow-934" },
          });
          fireEvent.click(
            screen.getByRole("button", { name: humanText("Unlock") }),
          );
        });
        await act(async () =>
          fireEvent.click(screen.getByText(humanText("FAKE_Results.pdf"))),
        );
        await act(async () =>
          fireEvent.click(
            screen.getByRole("button", { name: humanText("Read") }),
          ),
        );
        const reader = screen.getByRole("dialog", {
          name: humanText("FAKE_Results.pdf"),
        });
        await act(async () =>
          fireEvent.click(
            within(reader).getByRole("button", { name: humanText("Summary") }),
          ),
        );
        const go = screen.queryByRole("button", {
          name: humanText("Continue"),
        });
        if (go) await act(async () => fireEvent.click(go));
        for (let i = 0; i < 10 && settles.length < 2; i += 1)
          await act(async () => undefined);
        expect(settles).toHaveLength(2);
        await started(5 * 60 * 1000);
        await act(async () => vi.advanceTimersByTime(4 * 60 * 1000));
        await started(20 * 60 * 1000, 0);
        await act(async () => settles[0].reject({ code: "aiCancelled" }));
        await act(async () => vi.advanceTimersByTime(6 * 60 * 1000 + 10_000));
        expect(bridge.lock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not lock until the answer's own limit and the delay have passed", async () => {
      vi.useFakeTimers();
      try {
        const { bridge, started } = await askForSummary();
        // Unheld, the five-minute delay would have locked by now.
        await act(async () => vi.advanceTimersByTime(6 * 60 * 1000));
        expect(bridge.lock).not.toHaveBeenCalled();
        // Asked at 6 minutes with a limit of 7: held until 13, then the delay.
        await started(7 * 60 * 1000);
        await act(async () => vi.advanceTimersByTime(11 * 60 * 1000 + 30_000));
        expect(bridge.lock).not.toHaveBeenCalled();
        await act(async () => vi.advanceTimersByTime(60_000));
        expect(bridge.lock).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("waits at most 20 minutes for an answer not yet asked, as while the helper starts", async () => {
      vi.useFakeTimers();
      try {
        const { bridge } = await askForSummary();
        await act(async () => vi.advanceTimersByTime(20 * 60 * 1000));
        expect(bridge.lock).not.toHaveBeenCalled();
        await act(async () => vi.advanceTimersByTime(5 * 60 * 1000 + 10_000));
        expect(bridge.lock).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("counts a limit said to be longer than 20 minutes as 20", async () => {
      vi.useFakeTimers();
      try {
        const { bridge, started } = await askForSummary();
        await act(async () => vi.advanceTimersByTime(60_000));
        // Said at 1 minute: held until 21, then the delay.
        await started(60 * 60 * 1000);
        await act(async () => vi.advanceTimersByTime(20 * 60 * 1000));
        expect(bridge.lock).not.toHaveBeenCalled();
        await act(async () => vi.advanceTimersByTime(5 * 60 * 1000 + 10_000));
        expect(bridge.lock).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps a newer answer's hold when an older answer's word comes late", async () => {
      vi.useFakeTimers();
      try {
        const { bridge, settles, started } = await askForSummary();
        // The panel closed and opened again: a newer summary is asked while
        // the older one is still ending.
        const summaryButton = () =>
          within(
            screen.getByRole("dialog", { name: humanText("FAKE_Results.pdf") }),
          ).getByRole("button", { name: humanText("Summary") });
        await act(async () => fireEvent.click(summaryButton()));
        await act(async () => fireEvent.click(summaryButton()));
        for (let flush = 0; flush < 10; flush += 1) {
          if (vi.mocked(bridge.aiSummarize).mock.calls.length > 1) break;
          await act(async () => undefined);
        }
        expect(bridge.aiSummarize).toHaveBeenCalledTimes(2);
        // The older answer's limit of 5 minutes arrives now: it must not cut
        // the newer one's hold short, which would lock at about 10 minutes.
        await started(5 * 60 * 1000, 0);
        await act(async () => vi.advanceTimersByTime(10 * 60 * 1000 + 30_000));
        expect(bridge.lock).not.toHaveBeenCalled();
        // Once the older one has ended, the newer one's own limit counts.
        await act(async () => settles[0].reject({ code: "aiCancelled" }));
        await started(7 * 60 * 1000);
        await act(async () => vi.advanceTimersByTime(11 * 60 * 1000 + 30_000));
        expect(bridge.lock).not.toHaveBeenCalled();
        await act(async () => vi.advanceTimersByTime(60_000));
        expect(bridge.lock).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(["an answer", "a failure", "a cancel"])(
      "restarts the delay from the end, then holds no more, when it ends with %s",
      async (ending) => {
        vi.useFakeTimers();
        try {
          const { bridge, settle, started } = await askForSummary();
          await started(15 * 60 * 1000);
          await act(async () => vi.advanceTimersByTime(10 * 60 * 1000));
          await act(async () => {
            if (ending === "an answer") settle().resolve(summary);
            else if (ending === "a failure")
              settle().reject(new Error("FAKE failure"));
            else settle().reject({ code: "aiCancelled" });
          });
          // Still held (until 15 minutes), it would not lock before 20.
          await act(async () => vi.advanceTimersByTime(4 * 60 * 1000 + 30_000));
          expect(bridge.lock).not.toHaveBeenCalled();
          await act(async () => vi.advanceTimersByTime(60_000));
          expect(bridge.lock).toHaveBeenCalledOnce();
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it("still locks at once on Lock now, and stops the answer", async () => {
      vi.useFakeTimers();
      try {
        const { bridge, started } = await askForSummary();
        await started(15 * 60 * 1000);
        await act(async () => {
          fireEvent.click(windowLock());
        });
        expect(bridge.lock).toHaveBeenCalledOnce();
        expect(bridge.aiCancel).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("hides content at the deadline during an export and locks once it finishes", async () => {
    vi.useFakeTimers();
    try {
      let failExport!: (error: unknown) => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        snapshot: vi
          .fn()
          .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
        pickExportDestination: vi.fn().mockResolvedValue("pick-1"),
        exportToPicked: vi.fn(
          () =>
            new Promise<void>((_, reject) => {
              failExport = reject;
            }),
        ),
      });
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });
      await startExport();
      expect(bridge.exportToPicked).toHaveBeenCalledOnce();

      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
      expect(bridge.lock).not.toHaveBeenCalled();
      expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();
      expect(
        screen.queryByRole("heading", { name: humanText("My records") }),
      ).not.toBeInTheDocument();
      // Rechecks keep waiting rather than locking under the transfer.
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(bridge.lock).not.toHaveBeenCalled();

      // A failed transfer settles it too.
      await act(async () => failExport(new Error("disk full")));
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("heading", { name: humanText("Unlock your vault") }),
      ).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a cut-off backup warning private until unlock after a manual lock failure", async () => {
    const user = userEvent.setup();
    const note = "Delete that one, not your other backups.";
    let failTransfer!: (error: unknown) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      importPickedFiles: vi.fn(
        () =>
          new Promise<ImportOutcome>((_, reject) => {
            failTransfer = reject;
          }),
      ),
      lock: vi
        .fn()
        .mockResolvedValue(undefined)
        .mockImplementationOnce(async () => {
          failTransfer({
            code: "locked",
            message: "Unlock the vault to continue.",
            note,
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw {
            code: "storage",
            message: "The storage operation could not be completed.",
          };
        }),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(await importMenuItem());
    await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
    await user.click(
      screen.getByRole("button", { name: humanText(/Lock now/) }),
    );
    // Lock intent conceals immediately, including when native confirmation
    // fails. The actionable copy warning is preserved for the next unlock.
    expect(await screen.findByRole("alert")).toHaveHumanTextContent(
      "the vault is still open",
    );
    expect(document.body).not.toHaveTextContent(note);
    expect(
      screen.queryByRole("heading", { name: "My records" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try locking again" }));
    await screen.findByLabelText("Passphrase");
    await expectOutcomeAfterUnlock(
      `The backup stopped because the vault locked. No backup was saved. Keep your older backups. ${note}`,
    );
    expect(bridge.lock).toHaveBeenCalledTimes(2);
  });

  it("keeps what was held hidden when a lock fails on the hidden screen", async () => {
    const user = userEvent.setup();
    const note = "Delete that one, not your other backups.";
    let failTransfer!: (error: unknown) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      importPickedFiles: vi.fn(
        () =>
          new Promise<ImportOutcome>((_, reject) => {
            failTransfer = reject;
          }),
      ),
      lock: vi.fn(async () => {
        failTransfer({ ...CANCELLED, note });
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw {
          code: "storage",
          message: "The storage operation could not be completed.",
        };
      }),
    });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    try {
      render(<VaultApp bridge={bridge} />);
      await user.click(await importMenuItem());
      await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
      visibility.mockReturnValue("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      visibility.mockReturnValue("visible");
      await user.click(
        screen.getByRole("button", {
          name: humanText("Lock now and cancel the transfer"),
        }),
      );
      expect(await screen.findByRole("alert")).toBeVisible();
      // An onlooker may see this screen: nothing held is shown on it.
      expect(screen.queryByText(humanText(new RegExp(note)))).toBeNull();
    } finally {
      visibility.mockRestore();
    }
  });

  it("holds a lock for a transfer past an earlier manual failure, and reports a failure after it", async () => {
    const user = userEvent.setup();
    let finishImport!: (value: ImportOutcome) => void;
    const storageError = {
      code: "storage",
      message: "The storage operation could not be completed.",
    };
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      lock: vi
        .fn()
        .mockRejectedValue(storageError)
        .mockRejectedValueOnce(storageError)
        .mockResolvedValueOnce(undefined),
      importPickedFiles: vi.fn(
        () =>
          new Promise<ImportOutcome>((resolve) => {
            finishImport = resolve;
          }),
      ),
    });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    try {
      render(<VaultApp bridge={bridge} />);
      await user.click(
        await screen.findByRole("button", { name: humanText(/Lock now/) }),
      );
      await waitFor(() => expect(bridge.lock).toHaveBeenCalledOnce());
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "the vault is still open",
      );
      await user.click(
        screen.getByRole("button", { name: "Try locking again" }),
      );
      await screen.findByLabelText("Passphrase");
      await user.type(
        screen.getByLabelText("Passphrase"),
        "river-azimuth-cobalt-sparrow-934",
      );
      await user.click(screen.getByRole("button", { name: "Unlock" }));
      await screen.findByRole("heading", { name: "My records" });
      await user.click(await importMenuItem());
      await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
      visibility.mockReturnValue("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // The earlier manual failure is not this lock's.
      expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      await act(async () =>
        finishImport({ imported: [], skippedDuplicates: [] }),
      );
      expect(bridge.lock).toHaveBeenCalledTimes(3);
      expect(screen.getByRole("alert")).toHaveHumanTextContent(
        "myCarlos could not lock the vault.",
      );
      expect(
        screen.queryByText(humanText(TRANSFER_HOLD)),
      ).not.toBeInTheDocument();
    } finally {
      visibility.mockRestore();
    }
  });

  it.each([
    ["while the transfer runs", true],
    ["after the transfer, while its operation finishes", false],
  ])(
    "holds a lock that falls due %s until the transfer's outcome is on screen",
    async (_, dueFirst) => {
      vi.useFakeTimers();
      try {
        let finishImport!: (value: ImportOutcome) => void;
        let finishRefresh!: () => void;
        const bridge = nativeBridge({
          status: vi.fn().mockResolvedValue("unlocked"),
          snapshot: vi
            .fn()
            .mockImplementationOnce(async () => captureSnapshot(emptySnapshot))
            .mockImplementationOnce(
              () =>
                new Promise<VaultSnapshot>((resolve) => {
                  const captured = captureSnapshot(emptySnapshot);
                  finishRefresh = () => resolve(captured);
                }),
            ),
          importPickedFiles: vi.fn(
            () =>
              new Promise<ImportOutcome>((resolve) => {
                finishImport = resolve;
              }),
          ),
        });
        await act(async () => {
          render(<VaultApp bridge={bridge} />);
        });
        const importItem = importMenuItemNow();
        await act(async () => {
          fireEvent.click(importItem);
        });
        const finish = () =>
          act(async () =>
            finishImport({ imported: ["FAKE.pdf"], skippedDuplicates: [] }),
          );
        if (dueFirst) {
          await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
          expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();
          // The transfer is done, but its operation is still refreshing the
          // library when the next recheck runs.
          await finish();
          await act(async () => vi.advanceTimersByTime(10_000));
        } else {
          await finish();
          await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
        }
        expect(bridge.lock).not.toHaveBeenCalled();
        expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();

        await act(async () => finishRefresh());
        expect(bridge.lock).toHaveBeenCalledOnce();
        await expectOutcomeAfterUnlock("1 document encrypted and added.");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ["while the transfer runs", true],
    ["after the transfer, while its operation finishes", false],
  ])(
    "holds a lock that falls due %s until the transfer's outcome is on screen",
    async (_, dueFirst) => {
      vi.useFakeTimers();
      try {
        let finishImport!: (value: ImportOutcome) => void;
        let finishRefresh!: () => void;
        const bridge = nativeBridge({
          status: vi.fn().mockResolvedValue("unlocked"),
          snapshot: vi
            .fn()
            .mockImplementationOnce(async () => captureSnapshot(emptySnapshot))
            .mockImplementationOnce(
              () =>
                new Promise<VaultSnapshot>((resolve) => {
                  const captured = captureSnapshot(emptySnapshot);
                  finishRefresh = () => resolve(captured);
                }),
            ),
          importPickedFiles: vi.fn(
            () =>
              new Promise<ImportOutcome>((resolve) => {
                finishImport = resolve;
              }),
          ),
        });
        await act(async () => {
          render(<VaultApp bridge={bridge} />);
        });
        const importItem = importMenuItemNow();
        await act(async () => {
          fireEvent.click(importItem);
        });
        const finish = () =>
          act(async () =>
            finishImport({ imported: ["FAKE.pdf"], skippedDuplicates: [] }),
          );
        if (dueFirst) {
          await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
          expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();
          // The transfer is done, but its operation is still refreshing the
          // library when the next recheck runs.
          await finish();
          await act(async () => vi.advanceTimersByTime(10_000));
        } else {
          await finish();
          await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
        }
        expect(bridge.lock).not.toHaveBeenCalled();
        expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();

        await act(async () => finishRefresh());
        expect(bridge.lock).toHaveBeenCalledOnce();
        await expectOutcomeAfterUnlock("1 document encrypted and added.");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not hold the lock for a transfer whose operation has finished", async () => {
    vi.useFakeTimers();
    try {
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
      });
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });
      const importItem = importMenuItemNow();
      await act(async () => {
        fireEvent.click(importItem);
      });
      expect(bridge.importPickedFiles).toHaveBeenCalledOnce();
      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
      expect(bridge.lock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the lock for as long as the transfer runs", async () => {
    vi.useFakeTimers();
    try {
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        // Opening the chosen file never returns.
        importPickedFiles: vi.fn(() => new Promise<never>(() => undefined)),
      });
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });
      const importItem = importMenuItemNow();
      await act(async () => {
        fireEvent.click(importItem);
      });
      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
      expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();
      // A large transfer on a slow connection is not cut off.
      await act(async () => vi.advanceTimersByTime(3 * 60 * 60 * 1000));
      expect(bridge.lock).not.toHaveBeenCalled();
      expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a transfer's outcome, not a failed lock's error, across a retried lock", async () => {
    vi.useFakeTimers();
    try {
      let finishImport!: (value: ImportOutcome) => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        importPickedFiles: vi.fn(
          () =>
            new Promise<ImportOutcome>((resolve) => {
              finishImport = resolve;
            }),
        ),
        lock: vi
          .fn()
          .mockRejectedValueOnce({
            code: "storage",
            message: "The storage operation could not be completed.",
          })
          .mockResolvedValue(undefined),
      });
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });
      const importItem = importMenuItemNow();
      await act(async () => {
        fireEvent.click(importItem);
      });
      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
      await act(async () =>
        finishImport({ imported: ["FAKE.pdf"], skippedDuplicates: [] }),
      );
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(screen.getByRole("alert")).toHaveHumanTextContent(
        "myCarlos could not lock the vault.",
      );
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(bridge.lock).toHaveBeenCalledTimes(2);
      expect(screen.getByText(humanText(LOCKED_MESSAGE))).toBeVisible();

      // Once a lock succeeds, its error is forgotten: a held transfer in the
      // next session that fails the same way still reports it.
      let failImport!: (error: unknown) => void;
      vi.mocked(bridge.importPickedFiles).mockImplementationOnce(
        () =>
          new Promise<ImportOutcome>((_, reject) => {
            failImport = reject;
          }),
      );
      await act(async () => {
        fireEvent.change(screen.getByLabelText(humanText("Passphrase")), {
          target: { value: "river-azimuth-cobalt-sparrow-934" },
        });
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: humanText("Unlock") }),
        );
      });
      // The import's outcome is kept; the failed lock's error is not.
      await passAnnounceDelay();
      expect(
        screen.getByText(
          humanText("Vault unlocked. 1 document encrypted and added."),
        ),
      ).toBeVisible();
      const secondImportItem = importMenuItemNow();
      await act(async () => {
        fireEvent.click(secondImportItem);
      });
      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
      expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();
      await act(async () =>
        failImport({
          code: "storage",
          message: "The storage operation could not be completed.",
        }),
      );
      expect(bridge.lock).toHaveBeenCalledTimes(3);
      await expectOutcomeAfterUnlock(
        "The storage operation could not be completed.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a transfer that fails the same way as a failed lock attempt before it", async () => {
    const user = userEvent.setup();
    const storageError = {
      code: "storage",
      message: "The storage operation could not be completed.",
    };
    let failImport!: (error: unknown) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      importPickedFiles: vi.fn(
        () =>
          new Promise<ImportOutcome>((_, reject) => {
            failImport = reject;
          }),
      ),
      lock: vi
        .fn()
        .mockRejectedValueOnce(storageError)
        .mockResolvedValue(undefined),
    });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    try {
      render(<VaultApp bridge={bridge} />);
      await user.click(await importMenuItem());
      await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
      visibility.mockReturnValue("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      visibility.mockReturnValue("visible");
      await user.click(
        screen.getByRole("button", {
          name: humanText("Lock now and cancel the transfer"),
        }),
      );
      expect(await screen.findByRole("alert")).toHaveHumanTextContent(
        storageError.message,
      );

      await act(async () => failImport(storageError));
      await screen.findByText(humanText(LOCKED_MESSAGE));
      await expectOutcomeAfterUnlock(storageError.message);
    } finally {
      visibility.mockRestore();
    }
  });

  it("keeps a partial-copy warning that arrives after a failed lock attempt", async () => {
    const user = userEvent.setup();
    let failExport!: (error: unknown) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
      pickExportDestination: vi.fn().mockResolvedValue("pick-1"),
      exportToPicked: vi.fn(
        () =>
          new Promise<void>((_, reject) => {
            failExport = reject;
          }),
      ),
      lock: vi
        .fn()
        .mockRejectedValueOnce({
          code: "storage",
          message: "The storage operation could not be completed.",
        })
        .mockResolvedValue(undefined),
    });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    try {
      render(<VaultApp bridge={bridge} />);
      await user.click(await screen.findByText(humanText("FAKE_Results.pdf")));
      await user.click(
        screen.getByRole("button", {
          name: humanText("Save a copy to this device"),
        }),
      );
      await user.click(
        screen.getByRole("button", { name: humanText("Save a copy") }),
      );
      await waitFor(() => expect(bridge.exportToPicked).toHaveBeenCalled());
      visibility.mockReturnValue("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      visibility.mockReturnValue("visible");
      await user.click(
        screen.getByRole("button", {
          name: humanText("Lock now and cancel the transfer"),
        }),
      );
      expect(await screen.findByRole("alert")).toHaveHumanTextContent(
        "myCarlos could not lock the vault.",
      );

      // The export then fails, and the lock that follows succeeds.
      await act(async () => failExport(PARTIAL_EXPORT));
      await screen.findByText(humanText(LOCKED_MESSAGE));
      await expectOutcomeAfterUnlock(PARTIAL_EXPORT.message);
    } finally {
      visibility.mockRestore();
    }
  });

  it("does not hold a lock for a session that has just locked", async () => {
    let failImport!: (error: unknown) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      importPickedFiles: vi.fn(
        () =>
          new Promise<ImportOutcome>((_, reject) => {
            failImport = reject;
          }),
      ),
    });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    try {
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });
      const importItem = importMenuItemNow();
      await act(async () => {
        fireEvent.click(importItem);
      });
      expect(bridge.importPickedFiles).toHaveBeenCalled();
      // Lock now succeeds, and the app is hidden before the screen updates.
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: humanText(/Lock now/) }),
        );
        await Promise.resolve();
        await Promise.resolve();
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => failImport(CANCELLED));
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(screen.getByText(humanText("Vault locked."))).toBeVisible();
    } finally {
      visibility.mockRestore();
    }
  });

  it("does not hold a lock for a session that has just locked when its recheck runs", async () => {
    vi.useFakeTimers();
    try {
      let failImport!: (error: unknown) => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        importPickedFiles: vi.fn(
          () =>
            new Promise<ImportOutcome>((_, reject) => {
              failImport = reject;
            }),
        ),
      });
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });
      const importItem = importMenuItemNow();
      await act(async () => {
        fireEvent.click(importItem);
      });
      expect(bridge.importPickedFiles).toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000 - 1000));
      expect(bridge.lock).not.toHaveBeenCalled();
      // Lock now succeeds, and the deadline's recheck runs before the screen
      // updates.
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: humanText(/Lock now/) }),
        );
        await Promise.resolve();
        await Promise.resolve();
        vi.advanceTimersByTime(1000);
      });
      await act(async () => failImport(CANCELLED));
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(screen.getByText(humanText("Vault locked."))).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not carry an earlier notice onto the unlock screen when no transfer ends", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    render(<VaultApp bridge={bridge} />);
    await chooseAdd(user, "New folder");
    await user.type(screen.getByLabelText(humanText("Folder name")), "Labs");
    await user.click(screen.getByRole("button", { name: humanText("Create") }));
    expect(
      await screen.findByText(humanText("Labs was created.")),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: humanText(/Lock now/) }),
    );
    expect(
      await screen.findByRole("heading", {
        name: humanText("Unlock your vault"),
      }),
    ).toBeVisible();
    expect(screen.getByText(humanText("Vault locked."))).toBeVisible();
    expect(screen.queryByText(humanText(/Labs/))).not.toBeInTheDocument();
    // Nor is it kept for after the next unlock: no transfer ended.
    await expectNothingKeptAfterUnlock();
  });

  it("locks when a transfer settles in the same tick as the lock falls due", async () => {
    const user = userEvent.setup();
    let finishImport!: (value: ImportOutcome) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      importPickedFiles: vi.fn(
        () =>
          new Promise<ImportOutcome>((resolve) => {
            finishImport = resolve;
          }),
      ),
    });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    try {
      render(<VaultApp bridge={bridge} />);
      await user.click(await importMenuItem());
      await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
      visibility.mockReturnValue("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        finishImport({ imported: [], skippedDuplicates: [] });
      });
      await waitFor(() => expect(bridge.lock).toHaveBeenCalledOnce());
    } finally {
      visibility.mockRestore();
    }
  });

  it("locks at once when the user cancels a transfer holding the lock", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      importPickedFiles: vi.fn(() => new Promise<never>(() => undefined)),
    });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    try {
      render(<VaultApp bridge={bridge} />);
      await user.click(await importMenuItem());
      await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
      visibility.mockReturnValue("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      visibility.mockReturnValue("visible");

      await user.click(
        screen.getByRole("button", {
          name: humanText("Lock now and cancel the transfer"),
        }),
      );
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(
        await screen.findByRole("heading", {
          name: humanText("Unlock your vault"),
        }),
      ).toBeVisible();
    } finally {
      visibility.mockRestore();
    }
  });

  it.each([
    ["a held export is cancelled and the export fails first", true, 0, 50],
    ["a held export is cancelled and the lock finishes first", true, 50, 0],
    // A manual lock, with nothing held: the library is still showing.
    ["Lock now cancels an export that fails first", false, 0, 50],
  ])(
    "keeps the partial-copy warning when %s",
    async (_, held, exportDelay, lockDelay) => {
      const user = userEvent.setup();
      let failExport!: (error: unknown) => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        snapshot: vi
          .fn()
          .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
        pickExportDestination: vi.fn().mockResolvedValue("pick-1"),
        exportToPicked: vi.fn(
          () =>
            new Promise<void>((_, reject) => {
              failExport = reject;
            }),
        ),
        lock: vi.fn(async () => {
          setTimeout(() => failExport(PARTIAL_EXPORT), exportDelay);
          await new Promise((resolve) => setTimeout(resolve, lockDelay));
        }),
      });
      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("visible");
      try {
        render(<VaultApp bridge={bridge} />);
        await user.click(
          await screen.findByText(humanText("FAKE_Results.pdf")),
        );
        await user.click(
          screen.getByRole("button", {
            name: humanText("Save a copy to this device"),
          }),
        );
        await user.click(
          screen.getByRole("button", { name: humanText("Save a copy") }),
        );
        await waitFor(() => expect(bridge.exportToPicked).toHaveBeenCalled());
        if (held) {
          visibility.mockReturnValue("hidden");
          await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
          });
          visibility.mockReturnValue("visible");
        }

        await user.click(
          screen.getByRole("button", {
            name: humanText(
              held ? "Lock now and cancel the transfer" : /Lock now/,
            ),
          }),
        );
        await screen.findByRole("heading", {
          name: humanText("Unlock your vault"),
        });
        await waitFor(() => expect(bridge.exportToPicked).toHaveBeenCalled());
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
        await expectOutcomeAfterUnlock(PARTIAL_EXPORT.message);
      } finally {
        visibility.mockRestore();
      }
    },
  );

  it.each([
    ["a held export is cancelled and the export fails first", true, 0, 50],
    ["a held export is cancelled and the lock finishes first", true, 50, 0],
    // A manual lock, with nothing held: the library is still showing.
    ["Lock now cancels an export that fails first", false, 0, 50],
  ])(
    "keeps the partial-copy warning when %s",
    async (_, held, exportDelay, lockDelay) => {
      const user = userEvent.setup();
      let failExport!: (error: unknown) => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        snapshot: vi
          .fn()
          .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
        pickExportDestination: vi.fn().mockResolvedValue("pick-1"),
        exportToPicked: vi.fn(
          () =>
            new Promise<void>((_, reject) => {
              failExport = reject;
            }),
        ),
        lock: vi.fn(async () => {
          setTimeout(() => failExport(PARTIAL_EXPORT), exportDelay);
          await new Promise((resolve) => setTimeout(resolve, lockDelay));
        }),
      });
      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("visible");
      try {
        render(<VaultApp bridge={bridge} />);
        await user.click(
          await screen.findByText(humanText("FAKE_Results.pdf")),
        );
        await user.click(
          screen.getByRole("button", {
            name: humanText("Save a copy to this device"),
          }),
        );
        await user.click(
          screen.getByRole("button", { name: humanText("Save a copy") }),
        );
        await waitFor(() => expect(bridge.exportToPicked).toHaveBeenCalled());
        if (held) {
          visibility.mockReturnValue("hidden");
          await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
          });
          visibility.mockReturnValue("visible");
        }

        await user.click(
          screen.getByRole("button", {
            name: humanText(
              held ? "Lock now and cancel the transfer" : /Lock now/,
            ),
          }),
        );
        await screen.findByRole("heading", {
          name: humanText("Unlock your vault"),
        });
        await waitFor(() => expect(bridge.exportToPicked).toHaveBeenCalled());
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
        await expectOutcomeAfterUnlock(PARTIAL_EXPORT.message);
      } finally {
        visibility.mockRestore();
      }
    },
  );

  it.each([
    ["the transfer fails first", 0, 50],
    ["the lock finishes first", 50, 0],
  ])(
    "tells after the next unlock what a backup cut off by Lock now left, when %s",
    async (_, failDelay, lockDelay) => {
      const user = userEvent.setup();
      const note = "Delete that one, not your other backups.";
      let failTransfer!: (error: unknown) => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        importPickedFiles: vi.fn(
          () =>
            new Promise<ImportOutcome>((_, reject) => {
              failTransfer = reject;
            }),
        ),
        lock: vi.fn(async () => {
          setTimeout(() => failTransfer({ ...CANCELLED, note }), failDelay);
          await new Promise((resolve) => setTimeout(resolve, lockDelay));
        }),
      });
      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("visible");
      try {
        render(<VaultApp bridge={bridge} />);
        await user.click(await importMenuItem());
        await waitFor(() =>
          expect(bridge.importPickedFiles).toHaveBeenCalled(),
        );
        visibility.mockReturnValue("hidden");
        await act(async () => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
        visibility.mockReturnValue("visible");
        await user.click(
          screen.getByRole("button", {
            name: humanText("Lock now and cancel the transfer"),
          }),
        );
        await screen.findByRole("heading", {
          name: humanText("Unlock your vault"),
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
        await expectOutcomeAfterUnlock(
          `The backup stopped because the vault locked. No backup was saved. Keep your older backups. ${note}`,
        );
      } finally {
        visibility.mockRestore();
      }
    },
  );

  it.each([
    ["the transfer fails first", 0, 50],
    ["the lock finishes first", 50, 0],
  ])(
    "tells after the next unlock what a backup cut off by Lock now left, when %s",
    async (_, failDelay, lockDelay) => {
      const user = userEvent.setup();
      const note = "Delete that one, not your other backups.";
      let failTransfer!: (error: unknown) => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        importPickedFiles: vi.fn(
          () =>
            new Promise<ImportOutcome>((_, reject) => {
              failTransfer = reject;
            }),
        ),
        lock: vi.fn(async () => {
          setTimeout(() => failTransfer({ ...CANCELLED, note }), failDelay);
          await new Promise((resolve) => setTimeout(resolve, lockDelay));
        }),
      });
      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("visible");
      try {
        render(<VaultApp bridge={bridge} />);
        await user.click(await importMenuItem());
        await waitFor(() =>
          expect(bridge.importPickedFiles).toHaveBeenCalled(),
        );
        visibility.mockReturnValue("hidden");
        await act(async () => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
        visibility.mockReturnValue("visible");
        await user.click(
          screen.getByRole("button", {
            name: humanText("Lock now and cancel the transfer"),
          }),
        );
        await screen.findByRole("heading", {
          name: humanText("Unlock your vault"),
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
        await expectOutcomeAfterUnlock(
          `The backup stopped because the vault locked. No backup was saved. Keep your older backups. ${note}`,
        );
      } finally {
        visibility.mockRestore();
      }
    },
  );

  it.each([
    ["the import fails first", 0, 50],
    ["the lock finishes first", 50, 0],
  ])(
    "says only that the vault locked when a held import is cancelled and %s",
    async (_, importDelay, lockDelay) => {
      const user = userEvent.setup();
      let failImport!: (error: unknown) => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        // Its transfer note must not outlive the transfer either.
        platform: vi.fn().mockResolvedValue("ios"),
        importPickedFiles: vi.fn(
          () =>
            new Promise<ImportOutcome>((_, reject) => {
              failImport = reject;
            }),
        ),
        lock: vi.fn(async () => {
          setTimeout(() => failImport(CANCELLED), importDelay);
          await new Promise((resolve) => setTimeout(resolve, lockDelay));
        }),
      });
      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("visible");
      try {
        render(<VaultApp bridge={bridge} />);
        await user.click(await importMenuItem());
        await waitFor(() =>
          expect(bridge.importPickedFiles).toHaveBeenCalled(),
        );
        visibility.mockReturnValue("hidden");
        await act(async () => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
        visibility.mockReturnValue("visible");

        await user.click(
          screen.getByRole("button", {
            name: humanText("Lock now and cancel the transfer"),
          }),
        );
        await screen.findByRole("heading", {
          name: humanText("Unlock your vault"),
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
        expect(screen.getByText(humanText(LOCKED_MESSAGE))).toBeVisible();
        expect(
          screen.queryByText(humanText(/operation stopped/)),
        ).not.toBeInTheDocument();
        // The iOS note is not an outcome, so nothing is kept for the unlock.
        await expectNothingKeptAfterUnlock();
      } finally {
        visibility.mockRestore();
      }
    },
  );

  it.each([
    ["the import fails first", 0, 50],
    ["the lock finishes first", 50, 0],
  ])(
    "says only that the vault locked when a held import is cancelled and %s",
    async (_, importDelay, lockDelay) => {
      const user = userEvent.setup();
      let failImport!: (error: unknown) => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        // Its transfer note must not outlive the transfer either.
        platform: vi.fn().mockResolvedValue("ios"),
        importPickedFiles: vi.fn(
          () =>
            new Promise<ImportOutcome>((_, reject) => {
              failImport = reject;
            }),
        ),
        lock: vi.fn(async () => {
          setTimeout(() => failImport(CANCELLED), importDelay);
          await new Promise((resolve) => setTimeout(resolve, lockDelay));
        }),
      });
      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("visible");
      try {
        render(<VaultApp bridge={bridge} />);
        await user.click(await importMenuItem());
        await waitFor(() =>
          expect(bridge.importPickedFiles).toHaveBeenCalled(),
        );
        visibility.mockReturnValue("hidden");
        await act(async () => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
        visibility.mockReturnValue("visible");

        await user.click(
          screen.getByRole("button", {
            name: humanText("Lock now and cancel the transfer"),
          }),
        );
        await screen.findByRole("heading", {
          name: humanText("Unlock your vault"),
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
        expect(screen.getByText(humanText(LOCKED_MESSAGE))).toBeVisible();
        expect(
          screen.queryByText(humanText(/operation stopped/)),
        ).not.toBeInTheDocument();
        // The iOS note is not an outcome, so nothing is kept for the unlock.
        await expectNothingKeptAfterUnlock();
      } finally {
        visibility.mockRestore();
      }
    },
  );

  it("gives the native deadline the delay and reports activity at most every 10 seconds", async () => {
    vi.useFakeTimers();
    try {
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
      });
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });
      expect(bridge.setAutoLock).toHaveBeenLastCalledWith(5);

      fireEvent.pointerDown(window);
      expect(bridge.touch).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(9_999);
      fireEvent.keyDown(window);
      expect(bridge.touch).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1);
      fireEvent.keyDown(window);
      expect(bridge.touch).toHaveBeenCalledTimes(2);

      fireEvent.click(
        screen.getByRole("button", { name: humanText("Security") }),
      );
      // From 5 minutes down to 1, one press at a time (#67).
      const shorter = within(
        screen.getByRole("group", { name: humanText("Automatic lock delay") }),
      ).getByRole("button", { name: humanText("Shorter delay") });
      for (let press = 0; press < 4; press++)
        await act(async () => {
          fireEvent.click(shorter);
        });
      expect(bridge.setAutoLock).toHaveBeenLastCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the delay again until the native deadline accepts it", async () => {
    vi.useFakeTimers();
    try {
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        setAutoLock: vi
          .fn()
          .mockRejectedValueOnce(new Error("IPC unavailable"))
          .mockResolvedValue(undefined),
      });
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });
      expect(bridge.setAutoLock).toHaveBeenCalledOnce();
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(bridge.setAutoLock).toHaveBeenCalledTimes(2);
      expect(bridge.setAutoLock).toHaveBeenLastCalledWith(5);
      // Once accepted, it is not sent again.
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(bridge.setAutoLock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      "cuts off a transfer on screen",
      false,
      CANCELLED,
      "The transfer did not finish.",
    ],
    [
      "cuts off a transfer while the lock was held for it",
      true,
      CANCELLED,
      "The transfer did not finish.",
    ],
    [
      // An Android backup's document, opened and so emptied: what is left
      // there is still said, after the next unlock.
      "cuts off a transfer that may have left an emptied file",
      false,
      { ...CANCELLED, note: "Delete that one, not your other backups." },
      "The backup stopped because the vault locked. No backup was saved. Keep your older backups. Delete that one, not your other backups.",
    ],
    [
      // A lock that landed while the document was being opened, which
      // empties it: the backup then fails as locked, not cancelled.
      "locked the vault as a transfer opened its file",
      false,
      {
        code: "locked",
        message: "Unlock the vault to continue.",
        note: "Delete that one, not your other backups.",
      },
      "The backup stopped because the vault locked. No backup was saved. Keep your older backups. Delete that one, not your other backups.",
    ],
    [
      "locked the vault before a transfer began",
      false,
      { code: "locked", message: "Unlock the vault to continue." },
      null,
    ],
  ])(
    "shows the unlock screen when the native deadline %s",
    async (_, held, error, outcome) => {
      const user = userEvent.setup();
      let failImport!: (error: unknown) => void;
      let finishLock!: () => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        importPickedFiles: vi.fn(
          () =>
            new Promise<ImportOutcome>((_, reject) => {
              failImport = reject;
            }),
        ),
        lock: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishLock = resolve;
            }),
        ),
      });
      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("visible");
      try {
        render(<VaultApp bridge={bridge} />);
        await user.click(await importMenuItem());
        await waitFor(() =>
          expect(bridge.importPickedFiles).toHaveBeenCalled(),
        );
        if (held) {
          visibility.mockReturnValue("hidden");
          await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
          });
          visibility.mockReturnValue("visible");
          expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();
        }

        await act(async () => failImport(error));
        // Content is hidden while that lock is confirmed.
        expect(
          screen.queryByRole("heading", { name: humanText("My records") }),
        ).not.toBeInTheDocument();
        await act(async () => finishLock());
        expect(
          await screen.findByRole("heading", {
            name: humanText("Unlock your vault"),
          }),
        ).toBeVisible();
        // A cancel is not proof that the vault locked, so it is locked here.
        expect(bridge.lock).toHaveBeenCalledOnce();
        if (outcome) await expectOutcomeAfterUnlock(outcome);
        else expect(screen.getByText(humanText(LOCKED_MESSAGE))).toBeVisible();
      } finally {
        visibility.mockRestore();
      }
    },
  );

  it.each([
    [
      "cuts off a transfer on screen",
      false,
      CANCELLED,
      "The transfer did not finish.",
    ],
    [
      "cuts off a transfer while the lock was held for it",
      true,
      CANCELLED,
      "The transfer did not finish.",
    ],
    [
      // An Android backup's document, opened and so emptied: what is left
      // there is still said, after the next unlock.
      "cuts off a transfer that may have left an emptied file",
      false,
      { ...CANCELLED, note: "Delete that one, not your other backups." },
      "The backup stopped because the vault locked. No backup was saved. Keep your older backups. Delete that one, not your other backups.",
    ],
    [
      // A lock that landed while the document was being opened, which
      // empties it: the backup then fails as locked, not cancelled.
      "locked the vault as a transfer opened its file",
      false,
      {
        code: "locked",
        message: "Unlock the vault to continue.",
        note: "Delete that one, not your other backups.",
      },
      "The backup stopped because the vault locked. No backup was saved. Keep your older backups. Delete that one, not your other backups.",
    ],
    [
      "locked the vault before a transfer began",
      false,
      { code: "locked", message: "Unlock the vault to continue." },
      null,
    ],
  ])(
    "shows the unlock screen when the native deadline %s",
    async (_, held, error, outcome) => {
      const user = userEvent.setup();
      let failImport!: (error: unknown) => void;
      let finishLock!: () => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        importPickedFiles: vi.fn(
          () =>
            new Promise<ImportOutcome>((_, reject) => {
              failImport = reject;
            }),
        ),
        lock: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishLock = resolve;
            }),
        ),
      });
      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("visible");
      try {
        render(<VaultApp bridge={bridge} />);
        await user.click(await importMenuItem());
        await waitFor(() =>
          expect(bridge.importPickedFiles).toHaveBeenCalled(),
        );
        if (held) {
          visibility.mockReturnValue("hidden");
          await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
          });
          visibility.mockReturnValue("visible");
          expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();
        }

        await act(async () => failImport(error));
        // Content is hidden while that lock is confirmed.
        expect(
          screen.queryByRole("heading", { name: humanText("My records") }),
        ).not.toBeInTheDocument();
        await act(async () => finishLock());
        expect(
          await screen.findByRole("heading", {
            name: humanText("Unlock your vault"),
          }),
        ).toBeVisible();
        // A cancel is not proof that the vault locked, so it is locked here.
        expect(bridge.lock).toHaveBeenCalledOnce();
        if (outcome) await expectOutcomeAfterUnlock(outcome);
        else expect(screen.getByText(humanText(LOCKED_MESSAGE))).toBeVisible();
      } finally {
        visibility.mockRestore();
      }
    },
  );

  it.each([
    [
      "cuts off a transfer on screen",
      false,
      CANCELLED,
      "The transfer did not finish.",
    ],
    [
      "cuts off a transfer while the lock was held for it",
      true,
      CANCELLED,
      "The transfer did not finish.",
    ],
    [
      // An Android backup's document, opened and so emptied: what is left
      // there is still said, after the next unlock.
      "cuts off a transfer that may have left an emptied file",
      false,
      { ...CANCELLED, note: "Delete that one, not your other backups." },
      "The backup stopped because the vault locked. No backup was saved. Keep your older backups. Delete that one, not your other backups.",
    ],
    [
      // A lock that landed while the document was being opened, which
      // empties it: the backup then fails as locked, not cancelled.
      "locked the vault as a transfer opened its file",
      false,
      {
        code: "locked",
        message: "Unlock the vault to continue.",
        note: "Delete that one, not your other backups.",
      },
      "The backup stopped because the vault locked. No backup was saved. Keep your older backups. Delete that one, not your other backups.",
    ],
    [
      "locked the vault before a transfer began",
      false,
      { code: "locked", message: "Unlock the vault to continue." },
      null,
    ],
  ])(
    "shows the unlock screen when the native deadline %s",
    async (_, held, error, outcome) => {
      const user = userEvent.setup();
      let failImport!: (error: unknown) => void;
      let finishLock!: () => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        importPickedFiles: vi.fn(
          () =>
            new Promise<ImportOutcome>((_, reject) => {
              failImport = reject;
            }),
        ),
        lock: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishLock = resolve;
            }),
        ),
      });
      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("visible");
      try {
        render(<VaultApp bridge={bridge} />);
        await user.click(await importMenuItem());
        await waitFor(() =>
          expect(bridge.importPickedFiles).toHaveBeenCalled(),
        );
        if (held) {
          visibility.mockReturnValue("hidden");
          await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
          });
          visibility.mockReturnValue("visible");
          expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();
        }

        await act(async () => failImport(error));
        // Content is hidden while that lock is confirmed.
        expect(
          screen.queryByRole("heading", { name: humanText("My records") }),
        ).not.toBeInTheDocument();
        await act(async () => finishLock());
        expect(
          await screen.findByRole("heading", {
            name: humanText("Unlock your vault"),
          }),
        ).toBeVisible();
        // A cancel is not proof that the vault locked, so it is locked here.
        expect(bridge.lock).toHaveBeenCalledOnce();
        if (outcome) await expectOutcomeAfterUnlock(outcome);
        else expect(screen.getByText(humanText(LOCKED_MESSAGE))).toBeVisible();
      } finally {
        visibility.mockRestore();
      }
    },
  );

  it.each([
    [
      "cuts off a transfer on screen",
      false,
      CANCELLED,
      "The transfer did not finish.",
    ],
    [
      "cuts off a transfer while the lock was held for it",
      true,
      CANCELLED,
      "The transfer did not finish.",
    ],
    [
      // An Android backup's document, opened and so emptied: what is left
      // there is still said, after the next unlock.
      "cuts off a transfer that may have left an emptied file",
      false,
      { ...CANCELLED, note: "Delete that one, not your other backups." },
      "The backup stopped because the vault locked. No backup was saved. Keep your older backups. Delete that one, not your other backups.",
    ],
    [
      // A lock that landed while the document was being opened, which
      // empties it: the backup then fails as locked, not cancelled.
      "locked the vault as a transfer opened its file",
      false,
      {
        code: "locked",
        message: "Unlock the vault to continue.",
        note: "Delete that one, not your other backups.",
      },
      "The backup stopped because the vault locked. No backup was saved. Keep your older backups. Delete that one, not your other backups.",
    ],
    [
      "locked the vault before a transfer began",
      false,
      { code: "locked", message: "Unlock the vault to continue." },
      null,
    ],
  ])(
    "shows the unlock screen when the native deadline %s",
    async (_, held, error, outcome) => {
      const user = userEvent.setup();
      let failImport!: (error: unknown) => void;
      let finishLock!: () => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        importPickedFiles: vi.fn(
          () =>
            new Promise<ImportOutcome>((_, reject) => {
              failImport = reject;
            }),
        ),
        lock: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishLock = resolve;
            }),
        ),
      });
      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("visible");
      try {
        render(<VaultApp bridge={bridge} />);
        await user.click(await importMenuItem());
        await waitFor(() =>
          expect(bridge.importPickedFiles).toHaveBeenCalled(),
        );
        if (held) {
          visibility.mockReturnValue("hidden");
          await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
          });
          visibility.mockReturnValue("visible");
          expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();
        }

        await act(async () => failImport(error));
        // Content is hidden while that lock is confirmed.
        expect(
          screen.queryByRole("heading", { name: humanText("My records") }),
        ).not.toBeInTheDocument();
        await act(async () => finishLock());
        expect(
          await screen.findByRole("heading", {
            name: humanText("Unlock your vault"),
          }),
        ).toBeVisible();
        // A cancel is not proof that the vault locked, so it is locked here.
        expect(bridge.lock).toHaveBeenCalledOnce();
        if (outcome) await expectOutcomeAfterUnlock(outcome);
        else expect(screen.getByText(humanText(LOCKED_MESSAGE))).toBeVisible();
      } finally {
        visibility.mockRestore();
      }
    },
  );

  it.each([
    [
      "cuts off a transfer on screen",
      false,
      CANCELLED,
      "The transfer did not finish.",
    ],
    [
      "cuts off a transfer while the lock was held for it",
      true,
      CANCELLED,
      "The transfer did not finish.",
    ],
    [
      // An Android backup's document, opened and so emptied: what is left
      // there is still said, after the next unlock.
      "cuts off a transfer that may have left an emptied file",
      false,
      { ...CANCELLED, note: "Delete that one, not your other backups." },
      "The backup stopped because the vault locked. No backup was saved. Keep your older backups. Delete that one, not your other backups.",
    ],
    [
      // A lock that landed while the document was being opened, which
      // empties it: the backup then fails as locked, not cancelled.
      "locked the vault as a transfer opened its file",
      false,
      {
        code: "locked",
        message: "Unlock the vault to continue.",
        note: "Delete that one, not your other backups.",
      },
      "The backup stopped because the vault locked. No backup was saved. Keep your older backups. Delete that one, not your other backups.",
    ],
    [
      "locked the vault before a transfer began",
      false,
      { code: "locked", message: "Unlock the vault to continue." },
      null,
    ],
  ])(
    "shows the unlock screen when the native deadline %s",
    async (_, held, error, outcome) => {
      const user = userEvent.setup();
      let failImport!: (error: unknown) => void;
      let finishLock!: () => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        importPickedFiles: vi.fn(
          () =>
            new Promise<ImportOutcome>((_, reject) => {
              failImport = reject;
            }),
        ),
        lock: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishLock = resolve;
            }),
        ),
      });
      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("visible");
      try {
        render(<VaultApp bridge={bridge} />);
        await user.click(await importMenuItem());
        await waitFor(() =>
          expect(bridge.importPickedFiles).toHaveBeenCalled(),
        );
        if (held) {
          visibility.mockReturnValue("hidden");
          await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
          });
          visibility.mockReturnValue("visible");
          expect(screen.getByText(humanText(TRANSFER_HOLD))).toBeVisible();
        }

        await act(async () => failImport(error));
        // Content is hidden while that lock is confirmed.
        expect(
          screen.queryByRole("heading", { name: humanText("My records") }),
        ).not.toBeInTheDocument();
        await act(async () => finishLock());
        expect(
          await screen.findByRole("heading", {
            name: humanText("Unlock your vault"),
          }),
        ).toBeVisible();
        // A cancel is not proof that the vault locked, so it is locked here.
        expect(bridge.lock).toHaveBeenCalledOnce();
        if (outcome) await expectOutcomeAfterUnlock(outcome);
        else expect(screen.getByText(humanText(LOCKED_MESSAGE))).toBeVisible();
      } finally {
        visibility.mockRestore();
      }
    },
  );

  it("shows the unlock screen when the vault was locked natively", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      createFolder: vi.fn().mockRejectedValue({
        code: "locked",
        message: "Unlock the vault to continue.",
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await chooseAdd(user, "New folder");
    await user.type(screen.getByLabelText(humanText("Folder name")), "Labs");
    await user.click(screen.getByRole("button", { name: humanText("Create") }));
    expect(
      await screen.findByRole("heading", {
        name: humanText("Unlock your vault"),
      }),
    ).toBeVisible();
    expect(screen.getByText(humanText(LOCKED_MESSAGE))).toBeVisible();
  });

  it.each([
    ["ios", true],
    ["android", false],
    ["windows", false],
  ])(
    "on %s, says whether switching apps pauses a transfer: %s",
    async (platform, shown) => {
      const user = userEvent.setup();
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        platform: vi.fn().mockResolvedValue(platform),
        importPickedFiles: vi.fn(() => new Promise<never>(() => undefined)),
      });
      render(<VaultApp bridge={bridge} />);
      await user.click(await importMenuItem());
      await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
      if (shown) expect(screen.getByText(humanText(IOS_PAUSE))).toBeVisible();
      else
        expect(
          screen.queryByText(humanText(IOS_PAUSE)),
        ).not.toBeInTheDocument();
    },
  );

  it("keeps Lock now available while an operation is running", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      importPickedFiles: vi.fn(() => new Promise<never>(() => undefined)),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(await importMenuItem());
    await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
    // Locking is what cancels streaming I/O, so it must stay reachable.
    expect(
      screen.getByRole("button", { name: humanText(/Lock now/) }),
    ).toBeEnabled();
  });

  it("announces a result inside the open document dialog", async () => {
    const user = userEvent.setup();
    const record = {
      id: "record-1",
      profileId: "profile-1",
      folderIds: [],
      displayName: "FAKE_Copy.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/pdf",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: true,
    };
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () =>
          captureSnapshot({ ...emptySnapshot, records: [record] }),
        ),
      pickExportDestination: vi.fn().mockResolvedValue(null),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(await screen.findByText(humanText("FAKE_Copy.pdf")));
    await user.click(
      screen.getByRole("button", {
        name: humanText("Save a copy to this device"),
      }),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Save a copy") }),
    );

    // The page behind a modal is inert, so its status line is not announced.
    const details = await screen.findByRole("dialog", {
      name: humanText("FAKE_Copy.pdf"),
    });
    await waitFor(() =>
      expect(within(details).getByRole("status")).toHaveHumanTextContent(
        "Save cancelled. Nothing changed.",
      ),
    );
  });

  it.each(["wheel", "pointermove", "keydown"])(
    "treats %s as activity that postpones the inactivity lock",
    async (activity) => {
      vi.useFakeTimers();
      try {
        const bridge = nativeBridge({
          status: vi.fn().mockResolvedValue("unlocked"),
        });
        await act(async () => {
          render(<VaultApp bridge={bridge} />);
        });

        await act(async () => vi.advanceTimersByTime(4 * 60 * 1000));
        window.dispatchEvent(new Event(activity));
        await act(async () => vi.advanceTimersByTime(4 * 60 * 1000));
        expect(bridge.lock).not.toHaveBeenCalled();

        await act(async () => vi.advanceTimersByTime(60 * 1000));
        expect(bridge.lock).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("locks soon after the device wakes when the delay elapsed during sleep", async () => {
    vi.useFakeTimers();
    try {
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
      });
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });

      // Timers do not run while a device sleeps, but the wall clock moves on.
      await act(async () => vi.advanceTimersByTime(60 * 1000));
      vi.setSystemTime(Date.now() + 60 * 60 * 1000);
      expect(bridge.lock).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTime(10 * 1000));
      expect(bridge.lock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides content and keeps retrying when the inactivity lock fails", async () => {
    vi.useFakeTimers();
    try {
      const lock = vi
        .fn()
        .mockRejectedValueOnce({
          code: "storage",
          message: "The storage operation could not be completed.",
        })
        .mockResolvedValue(undefined);
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        lock,
      });
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });

      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
      expect(lock).toHaveBeenCalledOnce();
      expect(screen.getByRole("alert")).toHaveHumanTextContent(
        "the vault is still open",
      );
      expect(screen.getByRole("alert")).toHaveHumanTextContent(
        "myCarlos could not lock the vault. Its content is hidden, but the vault is still open. The storage operation could not be completed.",
      );
      expect(
        screen.queryByRole("heading", { name: humanText("My records") }),
      ).not.toBeInTheDocument();

      await act(async () => vi.advanceTimersByTime(10 * 1000));
      expect(lock).toHaveBeenCalledTimes(2);
      expect(screen.getByText(humanText(LOCKED_MESSAGE))).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a lock that failed while the app was hidden, whatever activity follows", async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    try {
      const lock = vi
        .fn()
        .mockRejectedValueOnce({
          code: "storage",
          message: "The storage operation could not be completed.",
        })
        .mockResolvedValue(undefined);
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        lock,
      });
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });
      expect(lock).toHaveBeenCalledOnce();

      // Movement over the concealed window must not buy the open session
      // another full inactivity delay.
      await act(async () => {
        window.dispatchEvent(new Event("pointermove"));
        vi.advanceTimersByTime(10 * 1000);
      });
      expect(lock).toHaveBeenCalledTimes(2);
      expect(screen.getByText(humanText(LOCKED_MESSAGE))).toBeVisible();
    } finally {
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not repeat an earlier operation's notice inside another document's dialog", async () => {
    const user = userEvent.setup();
    const record = {
      id: "record-1",
      profileId: "profile-1",
      folderIds: [],
      displayName: "FAKE_Other.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/pdf",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: true,
    };
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () =>
          captureSnapshot({ ...emptySnapshot, records: [record] }),
        ),
      pickImportFiles: vi.fn().mockResolvedValue(null),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(await importMenuItem());
    await waitFor(() =>
      expect(screen.getByRole("status")).not.toBeEmptyDOMElement(),
    );
    const earlierNotice = screen.getByRole("status").textContent ?? "";

    await user.click(screen.getByText(humanText("FAKE_Other.pdf")));
    const details = await screen.findByRole("dialog", {
      name: humanText("FAKE_Other.pdf"),
    });
    expect(details).not.toHaveHumanTextContent(earlierNotice);
  });

  it("keeps the failed lock status honest while a concealed automatic retry is pending", async () => {
    vi.useFakeTimers();
    try {
      let finishLock: () => void = () => undefined;
      const lock = vi
        .fn()
        .mockRejectedValueOnce({
          code: "storage",
          message: "The storage operation could not be completed.",
        })
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishLock = resolve;
            }),
        );
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        lock,
      });
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: humanText(/Lock now/) }),
        );
      });
      expect(lock).toHaveBeenCalledOnce();

      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
      expect(lock).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("alert")).toHaveHumanTextContent(
        "the vault is still open",
      );
      expect(screen.queryByLabelText("Passphrase")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "My records" }),
      ).not.toBeInTheDocument();

      await act(async () => finishLock());
      expect(screen.getByText(humanText(LOCKED_MESSAGE))).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a result that arrives after the vault locked", async () => {
    const user = userEvent.setup();
    const record = {
      id: "record-1",
      profileId: "profile-1",
      folderIds: [],
      displayName: "FAKE_Late.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/octet-stream",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: true,
    };
    let deliverSnapshot: () => void = () => undefined;
    const snapshot = vi
      .fn()
      .mockImplementationOnce(async () =>
        captureSnapshot({ ...emptySnapshot, records: [record] }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<VaultSnapshot>((resolve) => {
            const captured = captureSnapshot({
              ...emptySnapshot,
              records: [{ ...record, displayName: "FAKE_Renamed.pdf" }],
            });
            deliverSnapshot = () => resolve(captured);
          }),
      );
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot,
      unlock: vi.fn().mockImplementation(async () =>
        captureSnapshot({
          ...emptySnapshot,
          records: [{ ...record, displayName: "FAKE_Current.pdf" }],
        }),
      ),
      renameRecord: vi.fn().mockResolvedValue(undefined),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(await screen.findByText(humanText("FAKE_Late.pdf")));
    await user.click(
      screen.getByRole("button", { name: humanText("Rename document") }),
    );
    await user.clear(screen.getByLabelText(humanText("File name")));
    await user.type(
      screen.getByLabelText(humanText("File name")),
      "FAKE_Renamed.pdf",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Save name") }),
    );
    await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));

    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      expect(await screen.findByText(humanText(LOCKED_MESSAGE))).toBeVisible();
    } finally {
      visibility.mockRestore();
    }

    // Unlocked again before the earlier session's refresh returns: that result
    // must not replace the new session's library.
    await user.type(
      screen.getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    expect(
      await screen.findByText(humanText("FAKE_Current.pdf")),
    ).toBeVisible();

    await act(async () => deliverSnapshot());
    expect(screen.getByText(humanText("FAKE_Current.pdf"))).toBeVisible();
    expect(
      screen.queryByText(humanText(/FAKE_Renamed/)),
    ).not.toBeInTheDocument();
  });

  it("persists a bounded automatic lock delay", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: humanText("My records") });

    fireEvent.click(
      screen.getByRole("button", { name: humanText("Security") }),
    );
    const delay = screen.getByRole("group", {
      name: humanText("Automatic lock delay"),
    });
    expect(within(delay).getByText(humanText("5 minutes"))).toBeVisible();
    const shorter = within(delay).getByRole("button", {
      name: humanText("Shorter delay"),
    });
    for (let press = 0; press < 4; press++) fireEvent.click(shorter);

    expect(within(delay).getByText(humanText("1 minute"))).toBeVisible();
    expect(window.localStorage.getItem("mycarlos.autoLockMinutes.v1")).toBe(
      "1",
    );
  });

  it("applies a persisted one-minute automatic lock delay", async () => {
    vi.useFakeTimers();
    try {
      window.localStorage.setItem("mycarlos.autoLockMinutes.v1", "1");
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
      });
      // Await the initial session load inside the timer-controlled act scope.
      await act(async () => {
        render(<VaultApp bridge={bridge} />);
      });

      await act(async () => vi.advanceTimersByTime(59 * 1000));
      expect(bridge.lock).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(1000));
      expect(bridge.lock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads a persisted delay but rejects out-of-range stored values", async () => {
    window.localStorage.setItem("mycarlos.autoLockMinutes.v1", "15");
    const first = render(
      <VaultApp
        bridge={nativeBridge({ status: vi.fn().mockResolvedValue("unlocked") })}
      />,
    );
    await screen.findByRole("heading", { name: humanText("My records") });
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Security") }),
    );
    expect(
      within(
        screen.getByRole("group", { name: humanText("Automatic lock delay") }),
      ).getByText(humanText("15 minutes")),
    ).toBeVisible();
    first.unmount();

    window.localStorage.setItem("mycarlos.autoLockMinutes.v1", "999");
    render(
      <VaultApp
        bridge={nativeBridge({ status: vi.fn().mockResolvedValue("unlocked") })}
      />,
    );
    await screen.findByRole("heading", { name: humanText("My records") });
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Security") }),
    );
    expect(
      within(
        screen.getByRole("group", { name: humanText("Automatic lock delay") }),
      ).getByText(humanText("5 minutes")),
    ).toBeVisible();
  });

  it("requires the exact destructive reset phrase", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge();
    // Steps for an erased vault's backups mean nothing for the next one.
    const guide = "mycarlos.oldBackupsGuide.v1";
    window.localStorage.setItem(guide, JSON.stringify({ step: "save" }));
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await user.click(screen.getByText(humanText("Forgot your passphrase?")));
    const erase = screen.getByRole("button", {
      name: humanText("Set vault aside"),
    });
    expect(erase).toBeDisabled();
    await user.type(
      screen.getByLabelText(humanText("Type RESET MYCARLOS VAULT")),
      "RESET MYCARLOS VAULT",
    );
    expect(erase).toBeEnabled();
    await user.click(erase);
    await waitFor(() =>
      expect(bridge.reset).toHaveBeenCalledWith("RESET MYCARLOS VAULT"),
    );
    await waitFor(() => expect(window.localStorage.getItem(guide)).toBeNull());
  });

  it.each([
    ["unchanged", ""],
    ["edited", "FAKE Second folder"],
  ])(
    "keeps the %s folder draft reset scoped to the name that was saved",
    async (draft, expected) => {
      const user = userEvent.setup();
      const vault = structuredClone(emptySnapshot);
      let finishSave!: () => void;
      const saving = new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      const createFolder = vi.fn(
        async (profileId: string, parentId: string | null, name: string) => {
          await saving;
          vault.folders.push({
            id: "folder-first",
            profileId,
            parentId,
            name,
            createdAtMs: 2,
          });
          return "folder-first";
        },
      );
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        snapshot: vi.fn(async () => captureSnapshot(vault)),
        createFolder,
      });
      let view: ReturnType<typeof render> | undefined;
      try {
        view = render(<VaultApp bridge={bridge} />);
        await chooseAdd(user, "New folder");
        const name = screen.getByLabelText(humanText("Folder name"));
        await user.type(name, "FAKE First folder");
        const create = screen.getByRole("button", {
          name: humanText("Create"),
        });
        await user.click(create);
        await waitFor(() =>
          expect(createFolder).toHaveBeenCalledExactlyOnceWith(
            "profile-1",
            null,
            "FAKE First folder",
          ),
        );
        expect(create).toBeDisabled();
        expect(name).toBeEnabled();
        if (draft === "edited") {
          await user.clear(name);
          await user.type(name, expected);
        }
        await act(async () => {
          finishSave();
          await createFolder.mock.results[0].value;
        });
        await screen.findByText(
          humanText(
            translate("en", "interface.notice.folderCreated", {
              name: "FAKE First folder",
            }),
          ),
        );
        // Inspect the next draft without imposing a form-closing policy.
        // If the successful create closed it, reopen it first.
        if (!screen.queryByLabelText(humanText("Folder name"))) {
          await act(async () => {
            await chooseAdd(user, "New folder");
          });
        }
        expect(screen.getByLabelText(humanText("Folder name"))).toHaveValue(
          expected,
        );
        expect(createFolder).toHaveBeenCalledOnce();
      } finally {
        await act(async () => {
          finishSave();
          view?.unmount();
        });
      }
    },
  );

  it("stays in the library when a command there finds no vault", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      createFolder: vi.fn().mockRejectedValue({
        code: "missing",
        message: "No vault exists on this device.",
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await chooseAdd(user, "New folder");
    await user.type(screen.getByLabelText(humanText("Folder name")), "Labs");
    await user.click(screen.getByRole("button", { name: humanText("Create") }));
    expect(
      await screen.findByText(humanText("No vault exists on this device.")),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: humanText("My records") }),
    ).toBeVisible();
  });

  it("says only that the vault locked when a lock beats a command back", async () => {
    const user = userEvent.setup();
    let failCreate!: (error: unknown) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      createFolder: vi.fn(
        () =>
          new Promise<string>((_, reject) => {
            failCreate = reject;
          }),
      ),
    });
    render(<VaultApp bridge={bridge} />);
    await chooseAdd(user, "New folder");
    await user.type(screen.getByLabelText(humanText("Folder name")), "Labs");
    await user.click(screen.getByRole("button", { name: humanText("Create") }));
    await user.click(
      screen.getByRole("button", { name: humanText(/Lock now/) }),
    );
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await act(async () =>
      failCreate({ code: "locked", message: "Unlock the vault to continue." }),
    );
    expect(screen.getByText(humanText("Vault locked."))).toBeVisible();
  });

  it("updates a settled person-details save notice when the language changes", async () => {
    const user = userEvent.setup();
    const vault = structuredClone(emptySnapshot);
    const displayName = "FAKE {Person}";
    const fullName = "FAKE Exact {Clinic} Name";
    vault.profiles[0].displayName = displayName;
    vault.profiles[0].fullName = "FAKE Earlier Name";
    const update = vi.fn(async (_id: string, details: PersonDetails) => {
      Object.assign(vault.profiles[0], details);
    });
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn(async () => captureSnapshot(vault)),
      updateProfileDetails: update,
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText("Security") }),
    );
    await user.click(
      screen.getByRole("button", {
        name: humanText(
          translate("en", "personDetails.editFor", { name: displayName }),
        ),
      }),
    );
    const form = screen.getByRole("form", {
      name: humanText(
        translate("en", "personDetails.for", { name: displayName }),
      ),
    });
    const input = within(form).getByLabelText(
      humanText(translate("en", "personDetails.fullName")),
    );
    await user.clear(input);
    await user.paste(fullName);
    await user.click(
      within(form).getByRole("button", {
        name: humanText(translate("en", "personDetails.save")),
      }),
    );
    const english = translate("en", "personDetails.saved", {
      name: displayName,
    });
    const notice = (await screen.findByText(humanText(english))).closest(
      '[role="status"]',
    )!;
    expect(update).toHaveBeenCalledExactlyOnceWith("profile-1", {
      fullName,
      previousFullNames: ["FAKE Earlier Name"],
    });
    expect(
      screen.queryByRole("form", {
        name: humanText(
          translate("en", "personDetails.for", { name: displayName }),
        ),
      }),
    ).toBeNull();
    const list = screen.getByRole("list", {
      name: humanText(translate("en", "personDetails.list")),
    });
    expect(list).toHaveTextContent(fullName);

    act(() => setLocaleOverride("fr"));
    expect(
      screen.getByRole("button", {
        name: humanText(
          translate("fr", "personDetails.editFor", { name: displayName }),
        ),
      }),
    ).toBeVisible();
    expect(notice).toHaveHumanTextContent(
      translate("fr", "personDetails.saved", { name: displayName }),
    );
    expect(notice).not.toHaveHumanTextContent(english);
    expect(list).toHaveTextContent(fullName);
    act(() => setLocaleOverride("en"));
    expect(notice).toHaveHumanTextContent(english);
    expect(list).toHaveTextContent(fullName);
    expect(update).toHaveBeenCalledOnce();
  });

  it("updates a settled clinic-check result when the language changes without another check", async () => {
    const user = userEvent.setup();
    const deviceCode = "FAKE-DEVICE-CODE";
    const fingerprint = "11".repeat(32);
    const vault: VaultSnapshot = {
      ...structuredClone(emptySnapshot),
      portalLinkingEnabled: true,
      portalLinks: [
        {
          id: "fake-link",
          portalBase: "https://portal.example.test/patient",
          deviceName: "FAKE device",
          profileId: "profile-1",
          clinicName: "FAKE {Clinic}",
          fingerprints: [],
          incomplete: false,
          deviceKeyId: deviceCode,
          deviceFingerprint: fingerprint,
          approvalRequested: true,
          clinicApproved: true,
        },
      ],
    };
    const check = vi
      .fn()
      .mockResolvedValue({ added: 0, refused: 0, receiptsPending: 0 });
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn(async () => captureSnapshot(vault)),
      linkPortal: vi.fn().mockResolvedValue(vault.portalLinks![0]),
      // The clinic panel offers the one composite action (#136).
      connectPortal: vi.fn(),
      checkDocuments: check,
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText(/^Shared with me/) }),
    );
    await user.click(
      screen.getByRole("button", {
        name: humanText(translate("en", "portal.check")),
      }),
    );
    const english = translate("en", "portal.result", { added: 0, refused: 0 });
    const notice = (await screen.findByText(humanText(english))).closest(
      '[role="status"]',
    )!;
    expect(check).toHaveBeenCalledOnce();

    act(() => setLocaleOverride("fr"));
    expect(
      screen.getByRole("button", {
        name: humanText(translate("fr", "portal.check")),
      }),
    ).toBeVisible();
    expect(notice).toHaveHumanTextContent(
      translate("fr", "portal.result", { added: 0, refused: 0 }),
    );
    expect(notice).not.toHaveHumanTextContent(english);
    await user.click(
      screen.getByRole("button", {
        name: humanText(translate("fr", "security.title")),
      }),
    );
    const clinic = screen.getByRole("region", {
      name: humanText(translate("fr", "portal.title")),
    });
    expect(
      within(clinic).queryByRole("button", {
        name: humanText(translate("fr", "portal.check")),
      }),
    ).toBeNull();
    expect(
      within(clinic).getByLabelText(translate("fr", "portal.deviceCode")),
    ).toHaveValue(deviceCode);
    expect(
      within(clinic).getByLabelText(translate("fr", "portal.fingerprint")),
    ).toHaveValue(fingerprint);
    expect(
      within(clinic).getByRole("heading", { name: "FAKE {Clinic}" }),
    ).toBeVisible();
    act(() => setLocaleOverride("en"));
    // Navigation remounts the visible status; check its current node.
    expect(
      screen.getByText(humanText(english)).closest('[role="status"]'),
    ).toHaveHumanTextContent(english);
    expect(check).toHaveBeenCalledOnce();
  });

  it("keeps the Add profile dialog and its fields while a profile is being saved, and opens it empty for the next", async () => {
    // With Add profile in a dialog (#165), nothing can be typed for a next
    // profile while one is saved: the dialog holds the fields until the save
    // ends, and opens empty for the next.
    const user = userEvent.setup();
    const vault = structuredClone(emptySnapshot);
    let finishSave!: () => void;
    const saving = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const createProfile = vi.fn(
      async (name: string, details?: PersonDetails) => {
        await saving;
        vault.profiles.push({
          id: "profile-2",
          displayName: name,
          createdAtMs: 2,
          ...details,
        });
        return "profile-2";
      },
    );
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn(async () => captureSnapshot(vault)),
      createProfile,
      updateProfileDetails: vi.fn().mockResolvedValue(undefined),
    });
    const fullNameLabel = humanText(translate("en", "personDetails.fullName"));
    const openAdd = async () => {
      await user.click(
        screen.getByRole("button", { name: humanText("Add profile") }),
      );
      return screen.getByRole("dialog", { name: humanText("Add profile") });
    };
    try {
      render(<VaultApp bridge={bridge} />);
      await user.click(
        await screen.findByRole("button", { name: humanText("Security") }),
      );
      const dialog = await openAdd();
      const name = within(dialog).getByLabelText(humanText("New profile name"));
      await user.type(name, "FAKE First");
      await user.type(
        within(dialog).getByLabelText(fullNameLabel),
        "FAKE First Person",
      );
      await user.click(
        within(dialog).getByRole("checkbox", {
          name: humanText(translate("en", "personDetails.birthDateUnknown")),
        }),
      );
      const add = within(dialog).getByRole("button", {
        name: humanText("Add profile"),
      });
      await user.click(add);
      await waitFor(() =>
        expect(createProfile).toHaveBeenCalledExactlyOnceWith("FAKE First", {
          fullName: "FAKE First Person",
        }),
      );
      // While it saves: the same dialog, its fields kept and held.
      expect(dialog).toBeInTheDocument();
      expect(add).toBeDisabled();
      expect(name).toBeDisabled();
      expect(name).toHaveValue("FAKE First");

      await act(async () => finishSave());
      await screen.findByText(
        humanText(
          translate("en", "interface.notice.personAdded", {
            name: "FAKE First",
          }),
        ),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      const next = await openAdd();
      expect(
        within(next).getByLabelText(humanText("New profile name")),
      ).toHaveValue("");
      expect(within(next).getByLabelText(fullNameLabel)).toHaveValue("");
      expect(createProfile).toHaveBeenCalledOnce();
    } finally {
      await act(async () => finishSave());
    }
  });

  it("keeps a person's unsaved details while their Edit details dialog is open: Add profile can't start then", async () => {
    // With both in dialogs (#165), adding another profile can't refresh the
    // list under an Edit details draft: the page behind the dialog is inert.
    const user = userEvent.setup();
    const vault = structuredClone(emptySnapshot);
    vault.profiles[0].displayName = "FAKE Existing";
    vault.profiles[0].fullName = "FAKE Original Person";
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn(async () => captureSnapshot(vault)),
      createProfile: vi.fn().mockResolvedValue("profile-2"),
      updateProfileDetails: vi.fn(
        async (id: string, details: PersonDetails) => {
          Object.assign(
            vault.profiles.find((person) => person.id === id)!,
            details,
          );
        },
      ),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText("Security") }),
    );
    const opener = screen.getByRole("button", {
      name: humanText("Add profile"),
    });
    await user.click(
      screen.getByRole("button", {
        name: humanText("Edit details for FAKE Existing"),
      }),
    );
    const existing = screen.getByRole("form", {
      name: humanText("Details for FAKE Existing"),
    });
    const fullName = humanText(translate("en", "personDetails.fullName"));
    await user.clear(within(existing).getByLabelText(fullName));
    await user.type(
      within(existing).getByLabelText(fullName),
      "FAKE Unsaved Person",
    );
    // Add profile is behind the dialog, out of reach.
    expect(opener.closest("[inert]")).not.toBeNull();
    expect(
      screen.queryByRole("dialog", { name: humanText("Add profile") }),
    ).toBeNull();
    expect(within(existing).getByLabelText(fullName)).toHaveValue(
      "FAKE Unsaved Person",
    );
    expect(bridge.createProfile).not.toHaveBeenCalled();
    await user.click(
      within(existing).getByRole("button", {
        name: humanText("Save details"),
      }),
    );
    await screen.findByText(humanText("Details for FAKE Existing saved."));
    expect(bridge.updateProfileDetails).toHaveBeenCalledExactlyOnceWith(
      "profile-1",
      {
        fullName: "FAKE Unsaved Person",
        previousFullNames: ["FAKE Original Person"],
      },
    );
  });

  it("keeps a refused profile name in the form and clears an accepted one", async () => {
    const user = userEvent.setup();
    const createProfile = vi
      .fn()
      .mockRejectedValueOnce({
        code: "invalid",
        message: "Something you typed wasn't accepted. Check it and try again.",
      })
      .mockResolvedValue(undefined);
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      createProfile,
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: humanText("My records") });
    await user.click(
      screen.getByRole("button", { name: humanText("Security") }),
    );

    // Add profile opens a dialog (Ben, 29 Oct).
    await user.click(
      screen.getByRole("button", { name: humanText("Add profile") }),
    );
    const dialog = screen.getByRole("dialog", {
      name: humanText("Add profile"),
    });
    const name = within(dialog).getByLabelText(humanText("New profile name"));
    await user.type(name, "Jamie's parent");
    await user.click(
      within(dialog).getByRole("button", { name: humanText("Add profile") }),
    );
    await waitFor(() => expect(createProfile).toHaveBeenCalledOnce());
    expect(name).toHaveValue("Jamie's parent");
    // The refusal names the box to check (#69), inside the dialog, which
    // stays open: the page behind it is inert.
    expect(
      await within(dialog).findByText(
        humanText("Check the profile name, then try again."),
      ),
    ).toBeVisible();

    await user.click(
      within(dialog).getByRole("button", { name: humanText("Add profile") }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("clears unfinished passphrase fields when leaving Security", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText("Security") }),
    );
    fireEvent.change(screen.getByLabelText(humanText("Current passphrase")), {
      target: { value: "fake-current-secret" },
    });
    fireEvent.change(screen.getByLabelText(humanText("New passphrase")), {
      target: { value: "fake-replacement-secret" },
    });
    fireEvent.change(
      screen.getByLabelText(humanText("Confirm new passphrase")),
      {
        target: { value: "fake-replacement-secret" },
      },
    );
    await user.click(
      within(
        screen.getByRole("navigation", { name: humanText("Record library") }),
      ).getByRole("button", { name: humanText(/My records/) }),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Security") }),
    );
    expect(screen.getByLabelText(humanText("Current passphrase"))).toHaveValue(
      "",
    );
    expect(screen.getByLabelText(humanText("New passphrase"))).toHaveValue("");
    expect(
      screen.getByLabelText(humanText("Confirm new passphrase")),
    ).toHaveValue("");
    expect(bridge.changePassphrase).not.toHaveBeenCalled();
  });

  it("requires matching replacement passphrases", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText("Security") }),
    );

    await user.type(
      screen.getByLabelText(humanText("Current passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.type(
      screen.getByLabelText(humanText("New passphrase")),
      "lantern-orbit-willow-cascade-572",
    );
    await user.type(
      screen.getByLabelText(humanText("Confirm new passphrase")),
      "different replacement",
    );
    expect(
      screen.getByRole("button", { name: humanText("Change passphrase") }),
    ).toBeDisabled();
    await user.clear(
      screen.getByLabelText(humanText("Confirm new passphrase")),
    );
    await user.type(
      screen.getByLabelText(humanText("Confirm new passphrase")),
      "lantern-orbit-willow-cascade-572",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Change passphrase") }),
    );

    await waitFor(() =>
      expect(bridge.changePassphrase).toHaveBeenCalledWith(
        "river-azimuth-cobalt-sparrow-934",
        "lantern-orbit-willow-cascade-572",
      ),
    );
  });

  it("traps modal focus and returns it to the record control", async () => {
    const user = userEvent.setup();
    const record = {
      id: "record-1",
      profileId: "profile-1",
      folderIds: [],
      displayName: "FAKE_Report.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/octet-stream",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: true,
    };
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () =>
          captureSnapshot({ ...emptySnapshot, records: [record] }),
        ),
    });
    render(<VaultApp bridge={bridge} />);
    const opener = await screen.findByRole("button", {
      name: humanText("FAKE_Report.pdf"),
    });
    await user.click(opener);
    const close = screen.getByRole("button", {
      name: humanText("Close document details"),
    });
    expect(close).toHaveFocus();
    // The dialog's text is read with it when it opens; Tab moves only between
    // its controls and wraps inside it.
    expect(
      screen.getByRole("dialog", { name: humanText("FAKE_Report.pdf") }),
    ).toHaveHumanAccessibleDescription(/The file stays encrypted in the vault/);
    await user.tab({ shift: true });
    expect(
      screen.getByRole("button", {
        name: humanText("Save a copy to this device"),
      }),
    ).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it.each([
    ["composition", { isComposing: true }],
    ["composition compatibility", { keyCode: 229 }],
    ["ordinary", {}],
  ] as const)(
    "handles Escape on a rename draft during %s input",
    async (kind, flags) => {
      const user = userEvent.setup();
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        snapshot: vi
          .fn()
          .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
      });
      render(<VaultApp bridge={bridge} />);
      await user.click(
        await screen.findByRole("button", {
          name: humanText("FAKE_Results.pdf"),
        }),
      );
      await user.click(
        screen.getByRole("button", { name: humanText("Rename document") }),
      );
      const rename = () =>
        screen.queryByRole("dialog", { name: humanText("Rename document") });
      const input = within(rename()!).getByLabelText(humanText("File name"));
      await waitFor(() => expect(input).toBeEnabled());
      await user.clear(input);
      await user.type(input, "FAKE Draft");
      if (kind !== "ordinary") fireEvent.compositionStart(input);
      if (kind === "composition compatibility") fireEvent.compositionEnd(input);
      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true,
        ...flags,
      });
      if (kind === "composition") expect(escape.isComposing).toBe(true);
      if (kind === "composition compatibility")
        expect(escape.keyCode).toBe(229);
      fireEvent(input, escape);
      if (kind !== "ordinary") {
        expect(rename()).toBeVisible();
        expect(input).toHaveValue("FAKE Draft");
        expect(escape.defaultPrevented).toBe(false);
        fireEvent.compositionEnd(input);
        await user.keyboard("{Escape}");
      } else expect(escape.defaultPrevented).toBe(true);
      expect(rename()).toBeNull();
      expect(bridge.renameRecord).not.toHaveBeenCalled();
      expect(bridge.lock).not.toHaveBeenCalled();
    },
  );

  it.each(["locked", "storage", "late-locked"] as const)(
    "handles a document rename %s refusal in its own session",
    async (code) => {
      const user = userEvent.setup();
      const vault = {
        ...emptySnapshot,
        records: [
          {
            id: "FAKE-record",
            profileId: "profile-1",
            folderIds: [],
            displayName: "FAKE_Report.pdf",
            sourceLabel: "Manual import — unverified",
            mediaType: "application/octet-stream",
            plaintextSize: 2048,
            importedAtMs: 1,
            available: true,
          },
        ],
      };
      let rejectRename: ((error: unknown) => void) | undefined;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        snapshot: vi
          .fn()
          .mockImplementation(async () => captureSnapshot(vault)),
        unlock: vi.fn().mockImplementation(async () => captureSnapshot(vault)),
        renameRecord: vi.fn(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectRename = reject;
            }),
        ),
      });
      const refuse = async (failure: unknown) => {
        const reject = rejectRename;
        rejectRename = undefined;
        if (reject) await act(async () => reject(failure));
      };
      onTestFinished(async () => {
        await refuse({ code: "locked" });
      });
      render(<VaultApp bridge={bridge} />);
      await user.click(
        await screen.findByRole("button", {
          name: humanText("FAKE_Report.pdf"),
        }),
      );
      await user.click(
        screen.getByRole("button", { name: humanText("Rename document") }),
      );
      await user.clear(screen.getByLabelText(humanText("File name")));
      await user.type(
        screen.getByLabelText(humanText("File name")),
        "FAKE Revised",
      );
      await user.click(
        screen.getByRole("button", { name: humanText("Save name") }),
      );
      expect(bridge.renameRecord).toHaveBeenCalledExactlyOnceWith(
        "FAKE-record",
        "FAKE Revised.pdf",
      );
      if (code !== "late-locked")
        await refuse({ code, message: "FAKE rename refused." });
      if (code === "late-locked") {
        // An external visibility lock can close a dialog while Save is pending.
        let state: DocumentVisibilityState = "visible";
        const visibility = vi
          .spyOn(document, "visibilityState", "get")
          .mockImplementation(() => state);
        try {
          await act(async () => {
            state = "hidden";
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await screen.findByRole("heading", {
            name: humanText("Unlock your vault"),
          });
          await act(async () => {
            state = "visible";
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await user.type(
            screen.getByLabelText(humanText("Passphrase")),
            "river-azimuth-cobalt-sparrow-934",
          );
          await user.click(
            screen.getByRole("button", { name: humanText("Unlock") }),
          );
          await screen.findByRole("button", {
            name: humanText("FAKE_Report.pdf"),
          });
          await refuse({ code: "locked" });
          expect(bridge.lock).toHaveBeenCalledOnce();
          expect(bridge.unlock).toHaveBeenCalledOnce();
          expect(
            screen.getByRole("button", {
              name: humanText("FAKE_Report.pdf"),
            }),
          ).toBeVisible();
          expect(screen.queryByRole("dialog")).toBeNull();
        } finally {
          visibility.mockRestore();
        }
      } else if (code === "locked") {
        expect(
          await screen.findByRole("heading", {
            name: humanText("Unlock your vault"),
          }),
        ).toBeVisible();
        expect(bridge.lock).toHaveBeenCalledOnce();
        expect(document.body).not.toHaveTextContent("FAKE_Report.pdf");
        expect(document.body).not.toHaveTextContent("FAKE Revised");
      } else {
        expect(await screen.findByRole("alert")).toHaveHumanTextContent(
          "FAKE rename refused.",
        );
        expect(screen.getByLabelText(humanText("File name"))).toHaveValue(
          "FAKE Revised",
        );
        expect(bridge.lock).not.toHaveBeenCalled();
      }
    },
  );

  it("returns focus to the record control after renaming from its details", async () => {
    const user = userEvent.setup();
    const record = {
      id: "record-1",
      profileId: "profile-1",
      folderIds: [],
      displayName: "FAKE_Report.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/octet-stream",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: true,
    };
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () =>
          captureSnapshot({ ...emptySnapshot, records: [record] }),
        ),
    });
    render(<VaultApp bridge={bridge} />);
    const opener = await screen.findByRole("button", {
      name: humanText("FAKE_Report.pdf"),
    });
    await user.click(opener);
    await user.click(
      screen.getByRole("button", { name: humanText("Rename document") }),
    );
    await user.click(screen.getByRole("button", { name: humanText("Cancel") }));
    await user.click(
      screen.getByRole("button", { name: humanText("Close document details") }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("reports a failed manual lock instead of leaving it unnoticed", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      lock: vi.fn().mockRejectedValue({
        code: "storage",
        message: "The storage operation could not be completed.",
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText(/Lock now/) }),
    );
    expect(bridge.lock).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(
        humanText(/storage operation could not be completed/i),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try locking again" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("heading", { name: "My records" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Passphrase")).not.toBeInTheDocument();
  });

  it("marks a document whose encrypted file is missing and blocks saving it", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockImplementation(async () =>
        captureSnapshot({
          ...emptySnapshot,
          recovery: "lostObjects",
          records: [
            {
              id: "record-lost",
              profileId: "profile-1",
              folderIds: [],
              displayName: "FAKE_Lost.pdf",
              sourceLabel: "Manual import — unverified",
              mediaType: "application/octet-stream",
              plaintextSize: 2048,
              importedAtMs: 1,
              available: false,
            },
          ],
        }),
      ),
    });
    render(<VaultApp bridge={bridge} />);
    expect(
      await screen.findByText(humanText(/Some encrypted files are missing/)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(humanText(/Damaged: file missing/)),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: humanText("FAKE_Lost.pdf") }),
    );
    expect(
      screen.getByText(humanText("This document is damaged.")),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: humanText("Save a copy to this device"),
      }),
    ).toBeDisabled();
  });

  it("confirms a patient-hidden missing file but not an already damaged-hidden file", async () => {
    const user = userEvent.setup();
    const record = {
      profileId: "profile-1",
      folderIds: [],
      sourceLabel: "Manual import — unverified",
      mediaType: "application/octet-stream",
      plaintextSize: 200,
      importedAtMs: 1,
      available: false,
    };
    const lost: VaultSnapshot = {
      ...emptySnapshot,
      recovery: "lostObjects",
      records: [
        {
          ...record,
          id: "patient-hidden",
          displayName: "FAKE_Hidden_missing.pdf",
          hidden: { atMs: 2, reason: "patient" },
        },
        {
          ...record,
          id: "damaged-hidden",
          displayName: "FAKE_Already_damaged.pdf",
          hidden: { atMs: 1, reason: "damaged" },
        },
      ],
    };
    let shown = lost;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn(async () => captureSnapshot(shown)),
      hideUnavailableRecords: vi.fn(async (ids) => {
        shown = {
          ...lost,
          recovery: null,
          records: lost.records.map((r) =>
            r.id === "patient-hidden"
              ? { ...r, hidden: { atMs: 3, reason: "damaged" as const } }
              : r,
          ),
        };
        return ids;
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByText(humanText(/Some encrypted files are missing/));
    expect(
      screen.queryByText(humanText("FAKE_Hidden_missing.pdf")),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: humanText("Hide damaged documents") }),
    );
    const review = screen.getByRole("alertdialog", {
      name: humanText("Hide 1 damaged document?"),
    });
    expect(
      within(review).getByText(humanText("FAKE_Hidden_missing.pdf")),
    ).toBeVisible();
    expect(
      within(review).queryByText(humanText("FAKE_Already_damaged.pdf")),
    ).not.toBeInTheDocument();
    expect(bridge.hideUnavailableRecords).not.toHaveBeenCalled();
    await user.click(
      within(review).getByRole("button", { name: humanText("Hide") }),
    );
    await waitFor(() =>
      expect(bridge.hideUnavailableRecords).toHaveBeenCalledExactlyOnceWith(
        ["patient-hidden"],
        0,
      ),
    );
    await screen.findByText(
      humanText(
        "1 damaged document hidden. It is listed under Hidden. The vault accepts changes again.",
      ),
    );
    expect(addMenuItemNow("New folder")).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Security" }));
    await user.click(
      screen.getByRole("button", { name: humanText(/^Hidden/) }),
    );
    for (const name of [
      "FAKE_Hidden_missing.pdf",
      "FAKE_Already_damaged.pdf",
    ]) {
      const row = screen.getByRole("article", {
        name: humanText(`${name}, hidden`),
      });
      expect(row).toBeVisible();
      expect(
        within(row).queryByRole("button", {
          name: humanText(`Restore ${name}`),
        }),
      ).not.toBeInTheDocument();
    }
    expect(shown.records).toHaveLength(2);
  });

  it("hides damaged documents from the recovery banner after confirmation", async () => {
    const user = userEvent.setup();
    const lost = {
      id: "record-lost",
      profileId: "profile-1",
      folderIds: [],
      displayName: "FAKE_Lost.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/pdf",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: false,
    };
    const kept = {
      ...lost,
      id: "record-kept",
      displayName: "FAKE_Kept.pdf",
      available: true,
    };
    const hideUnavailableRecords = vi.fn().mockResolvedValue(["record-lost"]);
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementationOnce(async () =>
          captureSnapshot({
            ...emptySnapshot,
            recovery: "lostObjects",
            records: [lost, kept],
          }),
        )
        .mockImplementation(async () =>
          captureSnapshot({
            ...emptySnapshot,
            recovery: null,
            records: [kept],
          }),
        ),
      hideUnavailableRecords,
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(
      await screen.findByRole("button", {
        name: humanText("Hide damaged documents"),
      }),
    );
    const warning = screen.getByRole("alertdialog", {
      name: humanText("Hide 1 damaged document?"),
    });
    expect(warning).toHaveHumanAccessibleDescription(
      /stay listed under Hidden/,
    );
    // Nothing is deleted any more (#71), so nothing says it cannot be undone.
    expect(warning).not.toHaveHumanTextContent(/cannot be undone|permanently/);
    // The files may only be out of reach, which is not the same as gone.
    expect(warning).toHaveHumanTextContent(/drive that is disconnected/);
    expect(warning).toHaveHumanTextContent(/backup/);
    // Nothing is removed without an explicit confirmation: Cancel has focus,
    // and Cancel, Escape and a click outside all leave everything in place.
    expect(
      screen.getByRole("button", { name: humanText("Cancel") }),
    ).toHaveFocus();
    await user.click(screen.getByRole("button", { name: humanText("Cancel") }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    // Enter straight away presses Cancel, which has focus.
    await user.click(
      screen.getByRole("button", { name: humanText("Hide damaged documents") }),
    );
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: humanText("Hide damaged documents") }),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: humanText("Hide damaged documents") }),
    );
    await user.pointer({
      keys: "[MouseLeft]",
      target: screen.getByRole("alertdialog").parentElement!,
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(hideUnavailableRecords).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: humanText("Hide damaged documents") }),
    );
    const remove = screen.getByRole("button", { name: humanText("Hide") });
    // Hiding can be undone, so it is not styled as a danger (#71).
    expect(remove).not.toHaveClass("danger");
    await user.click(remove);
    await waitFor(() => expect(hideUnavailableRecords).toHaveBeenCalledOnce());
    // It names the documents that were shown as damaged.
    expect(hideUnavailableRecords).toHaveBeenCalledWith(["record-lost"], 0);
    expect(
      await screen.findByText(
        humanText(
          "1 damaged document hidden. It is listed under Hidden. The vault accepts changes again.",
        ),
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(humanText(/Changes are paused/)),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(humanText("FAKE_Lost.pdf")),
    ).not.toBeInTheDocument();
    expect(addMenuItemNow("New folder")).toBeEnabled();
  });

  it("does not claim the vault accepts changes when removal left it read-only", async () => {
    const user = userEvent.setup();
    const lost = {
      id: "record-lost",
      profileId: "profile-1",
      folderIds: [],
      displayName: "FAKE_Lost.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/pdf",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: false,
    };
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementationOnce(async () =>
          captureSnapshot({
            ...emptySnapshot,
            recovery: "lostObjects",
            records: [lost],
          }),
        )
        // The removal committed, but its redundant write failed.
        .mockImplementation(async () =>
          captureSnapshot({ ...emptySnapshot, recovery: "writeFailed" }),
        ),
      hideUnavailableRecords: vi.fn().mockResolvedValue(["record-lost"]),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(
      await screen.findByRole("button", {
        name: humanText("Hide damaged documents"),
      }),
    );
    await user.click(screen.getByRole("button", { name: humanText("Hide") }));

    expect(
      await screen.findByText(humanText(/1 damaged document hidden/)),
    ).not.toHaveHumanTextContent(/accepts changes/);
    expect(
      screen.getByText(
        humanText(/myCarlos could not save a change to this device/),
      ),
    ).toBeVisible();
  });

  it("offers no removal when recovery is not about missing files", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockImplementation(async () =>
        captureSnapshot({
          ...emptySnapshot,
          recovery: "unreadableSlot",
        }),
      ),
    });
    render(<VaultApp bridge={bridge} />);
    expect(
      await screen.findByText(humanText(/could not be read/)),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: humanText("Hide damaged documents"),
      }),
    ).not.toBeInTheDocument();
  });

  it("lets a long list of damaged documents be scrolled from the keyboard", async () => {
    const user = userEvent.setup();
    const records = Array.from({ length: 30 }, (_, index) => ({
      id: `record-${index}`,
      profileId: "profile-1",
      folderIds: [],
      displayName: `FAKE_lost_${index}.pdf`,
      sourceLabel: "Manual import — unverified",
      mediaType: "application/pdf",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: false,
    }));
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockImplementation(async () =>
        captureSnapshot({
          ...emptySnapshot,
          recovery: "lostObjects",
          records,
        }),
      ),
    });
    render(<VaultApp bridge={bridge} />);
    const opener = await screen.findByRole("button", {
      name: humanText("Hide damaged documents"),
    });
    await user.click(opener);
    const dialog = screen.getByRole("alertdialog", {
      name: humanText("Hide 30 damaged documents?"),
    });
    const list = within(dialog).getByRole("list", {
      name: humanText("Documents to hide"),
    });
    // It overflows, and a region that scrolls must be reachable by keyboard.
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    const results = await axe.run(dialog, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
    expect(results.violations).toEqual([]);
    expect(
      screen.getByRole("button", { name: humanText("Cancel") }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("shows what the vault reports after a removal was refused", async () => {
    const user = userEvent.setup();
    const record = (id: string, available: boolean) => ({
      id,
      profileId: "profile-1",
      folderIds: [],
      displayName: `FAKE_${id}.pdf`,
      sourceLabel: "Manual import — unverified",
      mediaType: "application/pdf",
      plaintextSize: 2048,
      importedAtMs: 1,
      available,
    });
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementationOnce(async () =>
          captureSnapshot({
            ...emptySnapshot,
            recovery: "lostObjects",
            records: [record("a", false), record("b", true)],
          }),
        )
        // Another file went missing before the removal ran.
        .mockImplementation(async () =>
          captureSnapshot({
            ...emptySnapshot,
            recovery: "lostObjects",
            records: [record("a", false), record("b", false)],
          }),
        ),
      hideUnavailableRecords: vi.fn().mockRejectedValue({
        code: "removal_changed",
        message: "FAKE the vault changed.",
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", {
        name: humanText("Hide damaged documents"),
      }),
    );
    const confirmation = screen.getByRole("alertdialog", {
      name: humanText("Hide 1 damaged document?"),
    });
    expect(confirmation).toBeVisible();
    // It names what would be removed, and nothing else.
    const named = within(confirmation).getByRole("list", {
      name: humanText("Documents to hide"),
    });
    expect(within(named).getAllByRole("listitem")).toHaveLength(1);
    expect(named).toHaveHumanTextContent("FAKE_a.pdf");
    // It can be scrolled with the keyboard, but Cancel has the first focus,
    // and the names are not read out with the dialog.
    expect(named).toHaveAttribute("tabindex", "0");
    expect(
      screen.getByRole("button", { name: humanText("Cancel") }),
    ).toHaveFocus();
    // Tab reaches the list (to scroll it) and the two buttons, and wraps.
    await user.tab({ shift: true });
    expect(named).toHaveFocus();
    await user.tab({ shift: true });
    expect(
      screen.getByRole("button", { name: humanText("Hide") }),
    ).toHaveFocus();
    await user.tab();
    expect(named).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole("button", { name: humanText("Cancel") }),
    ).toHaveFocus();
    expect(confirmation).toHaveHumanAccessibleDescription(
      /Their encrypted files are missing/,
    );
    expect(confirmation).not.toHaveHumanAccessibleDescription(/FAKE_a\.pdf/);
    const asked = vi.mocked(bridge.snapshot).mock.calls.length;
    await user.click(screen.getByRole("button", { name: humanText("Hide") }));
    expect(
      await screen.findByText(humanText("FAKE the vault changed.")),
    ).toBeVisible();
    // The refusal itself made the screen ask the vault again.
    expect(vi.mocked(bridge.snapshot).mock.calls.length).toBeGreaterThan(asked);
    expect(bridge.hideUnavailableRecords).toHaveBeenCalledWith(["a"], 0);
    // The next confirmation counts what is damaged now.
    await user.click(
      screen.getByRole("button", { name: humanText("Hide damaged documents") }),
    );
    expect(
      screen.getByRole("alertdialog", {
        name: humanText("Hide 2 damaged documents?"),
      }),
    ).toBeVisible();
  });

  it("does not call a document missing when files could not be read", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockImplementation(async () =>
        captureSnapshot({
          ...emptySnapshot,
          recovery: "unreadableSlot",
          records: [
            {
              id: "record-1",
              profileId: "profile-1",
              folderIds: [],
              displayName: "FAKE_Unreadable.pdf",
              sourceLabel: "Manual import — unverified",
              mediaType: "application/pdf",
              plaintextSize: 2048,
              importedAtMs: 1,
              available: false,
            },
          ],
        }),
      ),
    });
    render(<VaultApp bridge={bridge} />);
    expect(
      await screen.findByText(humanText(/· File unavailable/)),
    ).toBeVisible();
    expect(
      screen.queryByText(humanText(/Damaged: file missing/)),
    ).not.toBeInTheDocument();
    // The notice says which documents cannot be opened: those so marked.
    expect(
      screen.getByText(humanText(/keeps its files on this device/)),
    ).toHaveHumanTextContent("except any marked “File unavailable”");
    await user.click(screen.getByText(humanText("FAKE_Unreadable.pdf")));
    expect(
      within(screen.getByRole("dialog")).getByRole("alert"),
    ).toHaveHumanTextContent("This document is unavailable.");
  });

  it("renders hostile durable metadata only as text and surfaces recovery mode", async () => {
    const hostileName =
      '<img src="https://attacker.invalid/leak">\u202ereport.pdf';
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockImplementation(async () =>
        captureSnapshot({
          ...emptySnapshot,
          recovery: "writeFailed",
          records: [
            {
              id: "record-hostile",
              profileId: "profile-1",
              folderIds: [],
              displayName: hostileName,
              sourceLabel: "Manual import — unverified",
              mediaType: "application/octet-stream",
              plaintextSize: 42,
              importedAtMs: 1,
              available: true,
            },
          ],
        }),
      ),
    });
    render(<VaultApp bridge={bridge} />);

    expect(await screen.findByText(humanText(hostileName))).toBeVisible();
    expect(
      document.querySelector('img[src="https://attacker.invalid/leak"]'),
    ).toBeNull();
    expect(screen.getByRole("alert")).toHaveHumanTextContent(
      "Changes are paused.",
    );
    expect(
      await screen.findByRole("button", { name: humanText("Add document") }),
    ).toBeDisabled();
  });

  it("has no automatically detectable WCAG A or AA violations in durable states", async () => {
    const axeOptions = {
      runOnly: {
        type: "tag" as const,
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    };
    const locked = render(<VaultApp bridge={nativeBridge()} />);
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    expect((await axe.run(document.body, axeOptions)).violations).toEqual([]);
    locked.unmount();

    render(
      <VaultApp
        bridge={nativeBridge({ status: vi.fn().mockResolvedValue("unlocked") })}
      />,
    );
    await screen.findByRole("heading", { name: humanText("My records") });
    expect((await axe.run(document.body, axeOptions)).violations).toEqual([]);
  });

  it("shows a kept outcome once under strict mode", async () => {
    let finishImport!: (value: ImportOutcome) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      importPickedFiles: vi.fn(
        () =>
          new Promise<ImportOutcome>((resolve) => {
            finishImport = resolve;
          }),
      ),
    });
    // Strict mode runs effects and updates twice; the outcome still shows once.
    render(
      <StrictMode>
        <VaultApp bridge={bridge} />
      </StrictMode>,
    );
    const user = await holdLockForImport(bridge, () =>
      finishImport({ imported: ["FAKE.pdf"], skippedDuplicates: [] }),
    );
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await expectOutcomeAfterUnlock("1 document encrypted and added.");
    await user.click(
      screen.getByRole("button", { name: humanText(/Lock now/) }),
    );
    await screen.findByLabelText(humanText("Passphrase"));
    await expectNothingKeptAfterUnlock();
  });

  // The old vault's outcome must not reach a new one.
  it("does not carry a kept outcome into a vault created after the old one went missing", async () => {
    const guideKey = "mycarlos.oldBackupsGuide.v1";
    const previousBackup = "FAKE previous vault backup.mycarlosbackup";
    window.localStorage.setItem(
      guideKey,
      JSON.stringify({
        step: "delete",
        keep: previousBackup,
        savedAtMs: Date.now(),
        bytes: 4096,
      }),
    );
    let finishImport!: (value: ImportOutcome) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      importPickedFiles: vi.fn(
        () =>
          new Promise<ImportOutcome>((resolve) => {
            finishImport = resolve;
          }),
      ),
    });
    render(<VaultApp bridge={bridge} />);
    fireEvent.click(
      await screen.findByRole("button", { name: humanText("Security") }),
    );
    const previousGuide = screen.getByRole("region", {
      name: humanText("Your older backups"),
    });
    expect(previousGuide).toBeVisible();
    expect(previousGuide).toHaveHumanTextContent(previousBackup);
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: humanText("Record library") }),
      ).getByRole("button", { name: humanText(/^My records/) }),
    );
    const user = await holdLockForImport(bridge, () =>
      finishImport({ imported: ["FAKE.pdf"], skippedDuplicates: [] }),
    );
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    vi.mocked(bridge.unlock).mockRejectedValueOnce({
      code: "missing",
      message: "No vault was found.",
    });
    await user.type(
      screen.getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    await continuePastComfort();
    await user.type(
      await screen.findByLabelText(
        humanText("Whose records will you keep here?"),
      ),
      "FAKE Tester",
    );
    await user.type(
      screen.getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.type(
      screen.getByLabelText(humanText("Confirm passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Create vault") }),
    );
    await user.click(
      await screen.findByRole("button", { name: humanText("Security") }),
    );
    expect(bridge.create).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("region", { name: humanText("Your older backups") }),
    ).not.toBeInTheDocument();
    expect(document.body).not.toHaveHumanTextContent(previousBackup);
    expect(window.localStorage.getItem(guideKey)).toBeNull();
    await user.click(await waitFor(() => windowLock()));
    await screen.findByLabelText(humanText("Passphrase"));
    await expectNothingKeptAfterUnlock();
  });

  it("keeps a transfer's outcome when the first attempt to lock after it fails", async () => {
    let finishImport!: (value: ImportOutcome) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      importPickedFiles: vi.fn(
        () =>
          new Promise<ImportOutcome>((resolve) => {
            finishImport = resolve;
          }),
      ),
    });
    vi.mocked(bridge.lock).mockRejectedValueOnce({
      code: "storage",
      message: "The storage operation could not be completed.",
    });
    render(<VaultApp bridge={bridge} />);
    const user = await holdLockForImport(bridge, () =>
      finishImport({ imported: ["FAKE.pdf"], skippedDuplicates: [] }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: humanText("Try locking again"),
      }),
    );
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await expectOutcomeAfterUnlock("1 document encrypted and added.");
  });

  // A notice from something else during the transfer is not how it went.
  it("does not keep an unrelated notice as the outcome of a transfer a manual lock cancels", async () => {
    const user = userEvent.setup();
    let failExport!: (error: unknown) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
      pickExportDestination: vi.fn().mockResolvedValue("pick-1"),
      exportToPicked: vi.fn(
        () =>
          new Promise<void>((_, reject) => {
            failExport = reject;
          }),
      ),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByText(humanText("FAKE_Results.pdf"));
    await startExport();
    await waitFor(() => expect(bridge.exportToPicked).toHaveBeenCalled());
    const files = new DataTransfer();
    files.items.add(new File(["x"], "FAKE.pdf", { type: "application/pdf" }));
    await act(async () => {
      fireDragEvent("drop", window, { dataTransfer: files });
    });
    await user.click(
      screen.getByRole("button", { name: humanText(/Lock now/) }),
    );
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await act(async () => failExport(CANCELLED));
    await expectNothingKeptAfterUnlock();
  });

  it.each([
    ["", false],
    // Another notice left on screen must not replace the warning.
    [" and something else left a notice", true],
  ])(
    "keeps the partial-copy warning when an export fails in the same tick as Lock now finishes%s",
    async (_, otherNotice) => {
      const user = userEvent.setup();
      let failExport!: (error: unknown) => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        snapshot: vi
          .fn()
          .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
        pickExportDestination: vi.fn().mockResolvedValue("pick-1"),
        exportToPicked: vi.fn(
          () =>
            new Promise<void>((_, reject) => {
              failExport = reject;
            }),
        ),
        // The write pass fails as the lock returns, so the failure reaches
        // `run` before React applies the lock's notice update.
        lock: vi.fn(async () => {
          failExport(PARTIAL_EXPORT);
        }),
      });
      render(<VaultApp bridge={bridge} />);
      await screen.findByText(humanText("FAKE_Results.pdf"));
      await startExport();
      await waitFor(() => expect(bridge.exportToPicked).toHaveBeenCalled());
      if (otherNotice) {
        const files = new DataTransfer();
        files.items.add(
          new File(["x"], "FAKE.pdf", { type: "application/pdf" }),
        );
        await act(async () => {
          fireDragEvent("drop", window, { dataTransfer: files });
        });
      }
      await user.click(
        screen.getByRole("button", { name: humanText(/Lock now/) }),
      );
      await screen.findByRole("heading", {
        name: humanText("Unlock your vault"),
      });
      await expectOutcomeAfterUnlock(PARTIAL_EXPORT.message);
    },
  );

  it("keeps a completed export's result that arrives after Lock now has locked", async () => {
    const user = userEvent.setup();
    let finishExport!: () => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
      pickExportDestination: vi.fn().mockResolvedValue("pick-1"),
      exportToPicked: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishExport = resolve;
          }),
      ),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByText(humanText("FAKE_Results.pdf"));
    await startExport();
    await waitFor(() => expect(bridge.exportToPicked).toHaveBeenCalled());
    await user.click(
      screen.getByRole("button", { name: humanText(/Lock now/) }),
    );
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    // The copy was already written when the cancel arrived.
    await act(async () => finishExport());
    await expectOutcomeAfterUnlock("A readable copy was saved to this device.");
  });

  // A provider export cut off by the native deadline fails as a partial copy,
  // not as cancelled; the screen checks whether the vault locked.
  it("keeps the partial-copy warning when the native deadline locks during a provider export", async () => {
    let failExport!: (error: unknown) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
      pickExportDestination: vi.fn().mockResolvedValue("pick-1"),
      exportToPicked: vi.fn(
        () =>
          new Promise<void>((_, reject) => {
            failExport = reject;
          }),
      ),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByText(humanText("FAKE_Results.pdf"));
    await startExport();
    await waitFor(() => expect(bridge.exportToPicked).toHaveBeenCalled());
    // The native deadline locked the vault (e.g. after a sleep), which cut
    // off the write pass.
    vi.mocked(bridge.status).mockResolvedValue("locked");
    vi.mocked(bridge.snapshot).mockRejectedValue({
      code: "locked",
      message: "The vault is locked.",
    });
    await act(async () => failExport(PARTIAL_EXPORT));
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    vi.mocked(bridge.snapshot).mockImplementation(async () =>
      captureSnapshot(snapshotWithRecord),
    );
    await expectOutcomeAfterUnlock(PARTIAL_EXPORT.message);
  });
});

describe("the app's notices in the language in use (#46)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Not about the recovery key offer: it was made earlier today.
    forgetRecoveryOffer();
    recordRecoveryOffer(Date.now());
  });

  it("says what happened in Polish, with its plural forms", async () => {
    const user = userEvent.setup();
    const pl = (key: Parameters<typeof translate>[1], count?: number) =>
      translate("pl", key, count === undefined ? {} : { count });
    setLocaleOverride("pl");
    onTestFinished(() => {
      setLocaleOverride(null);
      window.localStorage.removeItem("mycarlos.autoLockMinutes.v1");
    });
    window.localStorage.removeItem("mycarlos.autoLockMinutes.v1");
    render(<VaultApp bridge={nativeBridge()} />);
    fireEvent.change(
      await screen.findByLabelText(humanText(pl("passphrase.label"))),
      {
        target: { value: "river-azimuth-cobalt-sparrow-934" },
      },
    );
    await user.click(
      screen.getByRole("button", { name: humanText(pl("unlock.submit")) }),
    );
    expect(
      await screen.findByText(humanText(pl("notice.unlocked"))),
    ).toBeVisible();
    expect(pl("notice.unlocked")).toBe("Sejf odblokowany.");

    // 5 → 6 minutes: Polish says "6 minut" (many).
    await user.click(
      screen.getAllByRole("button", {
        name: humanText(pl("security.title")),
      })[0],
    );
    const delay = screen.getByRole("group", {
      name: humanText(pl("security.autoLock.label")),
    });
    await user.click(
      within(delay).getByRole("button", {
        name: humanText(pl("security.autoLock.longer")),
      }),
    );
    expect(
      await screen.findByText(
        humanText("Automatyczna blokada ustawiona na 6 minut."),
      ),
    ).toBeVisible();
    expect(screen.queryByText(humanText(/Automatic locking set/))).toBeNull();

    await user.click(windowLock(pl("security.lockNow")));
    expect(
      await screen.findByText(humanText(pl("notice.locked"))),
    ).toBeVisible();
    expect(screen.queryByText(humanText("Vault locked."))).toBeNull();
  });

  it("names the import button as the library shows it when a file is dropped while locked", async () => {
    setLocaleOverride("fr");
    onTestFinished(() => setLocaleOverride(null));
    render(<VaultApp bridge={nativeBridge()} />);
    await screen.findByLabelText(
      humanText(translate("fr", "passphrase.label")),
    );
    const files = new DataTransfer();
    files.items.add(new File(["%PDF-1.7"], "FAKE.pdf"));
    fireDragEvent("drop", document.body, { dataTransfer: files });
    expect(
      await screen.findByText(
        humanText(
          // findByText collapses the no-break spaces inside « » to spaces.
          translate("fr", "notice.dropRefused", {
            button: `${translate("fr", "interface.AddMenu.addDocument")} › ${translate("fr", "interface.AddMenu.importFile")}`,
          }).replace(/\s+/g, " "),
        ),
      ),
    ).toBeVisible();
  });
});

describe("the warning before the automatic lock (#68)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // One minute, so the warning comes at 30 seconds.
    window.localStorage.setItem("mycarlos.autoLockMinutes.v1", "1");
  });

  async function openLibrary(
    bridge = nativeBridge({ status: vi.fn().mockResolvedValue("unlocked") }),
  ) {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    await act(async () => {
      render(<VaultApp bridge={bridge} />);
    });
    expect(
      screen.getByRole("heading", { name: humanText("My records") }),
    ).toBeVisible();
    return bridge;
  }
  const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms));
  const warning = () =>
    screen.queryByRole("alertdialog", {
      name: humanText(/^myCarlos will lock in/),
    });

  it("warns 30 seconds before, with Keep open focused, and locks if nobody answers", async () => {
    const bridge = await openLibrary();
    await wait(29_999);
    expect(warning()).not.toBeInTheDocument();
    await wait(1);
    expect(warning()).toHaveHumanAccessibleName(
      "myCarlos will lock in 30 seconds to keep your records private.",
    );
    expect(
      screen.getByRole("button", { name: humanText("Keep open") }),
    ).toHaveFocus();
    // Nothing beneath it can be reached, by Tab or by a screen reader's
    // browse or touch mode, which may not honour aria-modal.
    expect(document.querySelector(".native-vault-page")).toHaveAttribute(
      "inert",
    );
    expect(bridge.lock).not.toHaveBeenCalled();

    await wait(30_000);
    expect(bridge.lock).toHaveBeenCalledOnce();
    // Why, on the unlock screen, and nothing of the records.
    expect(
      screen.getByText(humanText("Locked after 1 minute without use.")),
    ).toBeVisible();
    expect(warning()).not.toBeInTheDocument();
  });

  it("puts the lock off from Keep open, and tells the native deadline at once", async () => {
    const bridge = await openLibrary();
    await wait(30_000);
    const touches = vi.mocked(bridge.touch).mock.calls.length;
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Keep open") }),
    );
    expect(warning()).not.toBeInTheDocument();
    expect(bridge.touch).toHaveBeenCalledTimes(touches + 1);

    // A full delay again from here: warned at 30 seconds, locked at 60.
    await wait(29_999);
    expect(warning()).not.toBeInTheDocument();
    await wait(1);
    expect(warning()).toBeInTheDocument();
    await wait(29_999);
    expect(bridge.lock).not.toHaveBeenCalled();
    await wait(1);
    expect(bridge.lock).toHaveBeenCalledOnce();
  });

  it("leaves Rename beneath it as it was: Escape and Keep open answer only the warning", async () => {
    await openLibrary(renameBridge());
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: humanText("Rename folder FAKE Parent"),
        }),
      );
    });
    const typed = () =>
      within(
        screen.getByRole("dialog", { name: humanText("Rename folder") }),
      ).getByLabelText(humanText("Folder name"));
    fireEvent.change(typed(), { target: { value: "FAKE New name" } });
    expect(typed()).toHaveFocus();

    await wait(30_000);
    expect(warning()).toBeInTheDocument();
    // Rename beneath it is out of reach while the warning is up.
    expect(
      screen
        .getByRole("dialog", { name: humanText("Rename folder"), hidden: true })
        .closest("[inert]"),
    ).not.toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(warning()).not.toBeInTheDocument();
    expect(document.querySelector(".native-vault-page")).not.toHaveAttribute(
      "inert",
    );
    // Rename is still open, with what was typed, and has the focus back.
    expect(typed()).toHaveValue("FAKE New name");
    expect(typed()).toHaveFocus();

    // The Escape was use: the next warning comes a full delay later.
    await wait(30_000);
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Keep open") }),
    );
    expect(warning()).not.toBeInTheDocument();
    expect(typed()).toHaveValue("FAKE New name");
  });

  it("leaves a confirmation beneath it open, and unanswered, on Escape", async () => {
    const bridge = await openLibrary(
      nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        snapshot: vi
          .fn()
          .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByText(humanText("FAKE_Results.pdf")));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: humanText("Save a copy to this device"),
        }),
      );
    });
    // Hiding asks nothing (#71), so Save a copy's confirmation stands in.
    const confirmation = () =>
      screen.queryByRole("alertdialog", {
        name: humanText("Save a readable copy?"),
      });
    expect(confirmation()).toBeInTheDocument();

    await wait(30_000);
    expect(warning()).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(warning()).not.toBeInTheDocument();
    expect(confirmation()).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: humanText("Cancel") }),
    ).toHaveFocus();
    expect(bridge.pickExportDestination).not.toHaveBeenCalled();
  });

  it("counts any key as use, and puts the warning away", async () => {
    const bridge = await openLibrary();
    await wait(30_000);
    expect(warning()).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Shift" });
    expect(warning()).not.toBeInTheDocument();
    await wait(59_999);
    expect(bridge.lock).not.toHaveBeenCalled();
  });

  it("counts the wheel as use when reading, but not the page scrolling itself", async () => {
    const bridge = await openLibrary();
    const page = screen.getByRole("main");
    await wait(25_000);
    // The page scrolls itself (a focus move, content loading): nobody is
    // there for that, so it keeps nothing open.
    fireEvent.scroll(page);
    fireEvent.scroll(window);
    await wait(5_000);
    expect(warning()).toBeInTheDocument();
    // Scrolling by the person comes with the wheel (or touch, or keys).
    fireEvent.wheel(page, { deltaY: 120 });
    expect(warning()).not.toBeInTheDocument();
    await wait(29_999);
    expect(warning()).not.toBeInTheDocument();
    expect(bridge.lock).not.toHaveBeenCalled();
  });

  it("says when it locked because myCarlos was hidden", async () => {
    const bridge = await openLibrary();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    try {
      await act(async () => {
        fireEvent(document, new Event("visibilitychange"));
      });
    } finally {
      visibility.mockRestore();
    }
    expect(bridge.lock).toHaveBeenCalledOnce();
    expect(
      screen.getByText(
        humanText(
          "Locked because myCarlos was minimized or sent to the background.",
        ),
      ),
    ).toBeVisible();
  });
});

describe("clinic connection operations", () => {
  beforeEach(() => {
    window.localStorage.clear();
    forgetRecoveryOffer();
    recordRecoveryOffer(Date.now());
  });
  const connectedLink = {
    id: "fake-clinic-link",
    portalBase: "https://portal.example.test/patient",
    deviceName: "myCarlos FAKE device",
    profileId: null,
    clinicName: "FAKE First Clinic",
    fingerprints: [],
    incomplete: false,
    deviceKeyId: "FAKE_FIRST_DEVICE",
    deviceFingerprint: "11".repeat(32),
    approvalRequested: true,
    clinicApproved: false,
  };
  const clinicSnapshot: VaultSnapshot = {
    ...snapshotWithRecord,
    profiles: [
      { id: "profile-1", displayName: "FAKE First Patient", createdAtMs: 1 },
    ],
    recoveryKeySetAtMs: 5,
    portalLinkingEnabled: true,
    portalLinks: [],
  };
  type ConnectResult = Awaited<
    ReturnType<NonNullable<VaultBridge["connectPortal"]>>
  >;
  function pendingConnection() {
    let finish!: (result: ConnectResult) => void;
    const promise = new Promise<ConnectResult>((resolve) => {
      finish = resolve;
    });
    return { promise, finish };
  }
  async function openConnectForm(code = "01234567-89ABCDEFGH") {
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Security" }));
    await user.type(
      screen.getByLabelText("Portal HTTPS address"),
      "https://portal.example.test/patient",
    );
    await user.type(screen.getByLabelText("Linking code"), code);
    return screen
      .getByRole("button", { name: "Connect and request approval" })
      .closest("form")!;
  }

  it("opens Link another clinic over an inert page, and returns focus to it (#145)", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockResolvedValue({ ...clinicSnapshot, portalLinks: [connectedLink] }),
      connectPortal: vi.fn(),
      linkPortal: vi.fn(),
      checkDocuments: vi.fn(),
      requestDeviceApproval: vi.fn().mockResolvedValue(undefined),
    });
    render(<VaultApp bridge={bridge} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Security" }));
    // A clinic is linked: its card comes first, and the form is not on the page.
    expect(
      screen.getByRole("heading", { name: "FAKE First Clinic" }),
    ).toBeVisible();
    expect(screen.queryByLabelText("Portal HTTPS address")).toBeNull();
    const linkAnother = screen.getByRole("button", {
      name: "Link another clinic",
    });
    await user.click(linkAnother);
    const dialog = screen.getByRole("dialog", { name: "Link another clinic" });
    expect(document.activeElement).toBe(
      within(dialog).getByLabelText("Portal HTTPS address"),
    );
    // The page behind the dialog is inert; the dialog is not.
    expect(document.querySelector(".app-body")).toHaveAttribute("inert");
    expect(dialog.closest("[inert]")).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".app-body")).not.toHaveAttribute("inert");
    expect(document.activeElement).toBe(linkAnother);
    expect(bridge.connectPortal).not.toHaveBeenCalled();
  });

  it("gives focus back to Link another clinic when a link sent from its dialog is refused (#145)", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockResolvedValue({ ...clinicSnapshot, portalLinks: [connectedLink] }),
      connectPortal: vi
        .fn()
        .mockRejectedValue({ code: "portal_link_code_rejected" }),
      linkPortal: vi.fn(),
      checkDocuments: vi.fn(),
      requestDeviceApproval: vi.fn().mockResolvedValue(undefined),
    });
    render(<VaultApp bridge={bridge} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Security" }));
    const linkAnother = screen.getByRole("button", {
      name: "Link another clinic",
    });
    await user.click(linkAnother);
    await user.type(
      screen.getByLabelText("Portal HTTPS address"),
      "https://portal.example.test/patient",
    );
    await user.type(
      screen.getByLabelText("Linking code"),
      "01234567-89ABCDEFGK",
    );
    await user.click(
      screen.getByRole("button", { name: "Connect and request approval" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".app-body")).not.toHaveAttribute("inert");
    expect(
      await screen.findByText(
        "The portal did not accept that code. Make a new linking code in your patient portal.",
      ),
    ).toBeVisible();
    expect(bridge.connectPortal).toHaveBeenCalledOnce();
    await waitFor(() => expect(linkAnother).toBeEnabled());
    await waitFor(() => expect(document.activeElement).toBe(linkAnother));
  });

  it("gives focus to the new clinic after a link sent from the dialog, which then opens empty (#145)", async () => {
    const second = {
      ...connectedLink,
      id: "fake-clinic-link-2",
      clinicName: "FAKE Second Clinic",
      portalBase: "https://second.example.test/patient",
    };
    let current: VaultSnapshot = {
      ...clinicSnapshot,
      portalLinks: [connectedLink],
    };
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(current)),
      connectPortal: vi.fn().mockImplementation(async () => {
        current = { ...current, portalLinks: [connectedLink, second] };
        return { link: second, approvalError: null };
      }),
      linkPortal: vi.fn(),
      checkDocuments: vi.fn(),
      requestDeviceApproval: vi.fn().mockResolvedValue(undefined),
    });
    render(<VaultApp bridge={bridge} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Security" }));
    await user.click(
      screen.getByRole("button", { name: "Link another clinic" }),
    );
    await user.type(
      screen.getByLabelText("Portal HTTPS address"),
      "https://second.example.test/patient",
    );
    await user.type(
      screen.getByLabelText("Linking code"),
      "01234567-89ABCDEFGK",
    );
    await act(async () => {
      fireEvent.submit(
        screen
          .getByRole("button", { name: "Connect and request approval" })
          .closest("form")!,
      );
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    const heading = await screen.findByRole("heading", {
      name: "FAKE Second Clinic",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    // Once the link is finished the button is usable again, and focus stays
    // on the new clinic.
    const linkAnother = screen.getByRole("button", {
      name: "Link another clinic",
    });
    await waitFor(() => expect(linkAnother).toBeEnabled());
    expect(document.activeElement).toBe(heading);
    await user.click(linkAnother);
    expect(screen.getByLabelText("Portal HTTPS address")).toHaveValue("");
  });

  it("keeps local records usable and shares admission across clinic-view remounts", async () => {
    let current = clinicSnapshot;
    const pending = pendingConnection();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(current)),
      connectPortal: vi.fn().mockReturnValue(pending.promise),
      linkPortal: vi.fn(),
      checkDocuments: vi.fn(),
      requestDeviceApproval: vi.fn().mockResolvedValue(undefined),
    });
    render(<VaultApp bridge={bridge} />);
    const form = await openConnectForm();
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(bridge.connectPortal).toHaveBeenCalledOnce());
    await userEvent
      .setup()
      .click(screen.getAllByRole("button", { name: /^My records/ })[0]);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "FAKE_Results.pdf" }));
    expect(
      await screen.findByRole("dialog", { name: "FAKE_Results.pdf" }),
    ).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Close document details" }));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Security" }));
    const connect = screen.getByRole("button", {
      name: "Connect and request approval",
    });
    expect(connect).toBeDisabled();
    expect(screen.getByText("Clinic operation in progress…")).toBeVisible();
    await act(async () => {
      fireEvent.submit(connect.closest("form")!);
    });
    expect(bridge.connectPortal).toHaveBeenCalledOnce();
    expect(bridge.checkDocuments).not.toHaveBeenCalled();
    current = { ...clinicSnapshot, portalLinks: [connectedLink] };
    await act(async () =>
      pending.finish({ link: connectedLink, approvalError: null }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Retry saved approval request" }),
      ).toBeEnabled(),
    );
    expect(screen.getByLabelText("Full device fingerprint")).toHaveValue(
      connectedLink.deviceFingerprint,
    );
    expect(bridge.linkPortal).not.toHaveBeenCalled();
    expect(bridge.requestDeviceApproval).not.toHaveBeenCalled();
  });

  it.each([
    [
      "picker",
      "No files selected. Nothing changed. Device linked. Its approval status is shown in Security, under Connected clinics.",
    ],
    [
      "transfer",
      "1 document encrypted and added. Device linked. Its approval status is shown in Security, under Connected clinics.",
    ],
  ] as const)(
    "adds a clinic result that arrives during an import's %s after the import's own result",
    async (stage, expected) => {
      let current = clinicSnapshot;
      const pending = pendingConnection();
      let pick!: (value: string | null) => void;
      let finishImport!: (value: ImportOutcome) => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        snapshot: vi
          .fn()
          .mockImplementation(async () => captureSnapshot(current)),
        connectPortal: vi.fn().mockReturnValue(pending.promise),
        checkDocuments: vi.fn(),
        requestDeviceApproval: vi.fn(),
        ...(stage === "picker"
          ? {
              pickImportFiles: vi.fn().mockReturnValue(
                new Promise<string | null>((resolve) => {
                  pick = resolve;
                }),
              ),
            }
          : {
              importPickedFiles: vi.fn().mockReturnValue(
                new Promise<ImportOutcome>((resolve) => {
                  finishImport = resolve;
                }),
              ),
            }),
      });
      render(<VaultApp bridge={bridge} />);
      const form = await openConnectForm();
      await act(async () => {
        fireEvent.submit(form);
      });
      await waitFor(() => expect(bridge.connectPortal).toHaveBeenCalledOnce());
      const user = userEvent.setup();
      await user.click(
        screen.getAllByRole("button", { name: /^My records/ })[0],
      );
      await user.click(await importMenuItem());
      await waitFor(() =>
        expect(
          stage === "picker"
            ? bridge.pickImportFiles
            : bridge.importPickedFiles,
        ).toHaveBeenCalled(),
      );
      current = { ...clinicSnapshot, portalLinks: [connectedLink] };
      // The clinic view is gone and the import holds the line: the result
      // waits. The compact control shows the clinic work has ended.
      await act(async () =>
        pending.finish({ link: connectedLink, approvalError: null }),
      );
      await user.click(
        screen.getAllByRole("button", { name: /^Shared with me/ })[0],
      );
      expect(
        await screen.findByRole("button", { name: "Check for new documents" }),
      ).toBeVisible();
      expect(screen.queryByText(/Device linked/)).not.toBeInTheDocument();
      await act(async () =>
        stage === "picker"
          ? pick(null)
          : finishImport({ imported: ["FAKE.pdf"], skippedDuplicates: [] }),
      );
      await waitFor(() =>
        expect(screen.getByText(humanText(expected))).toBeVisible(),
      );
    },
  );

  it("shows a clinic result that waited for a bare transfer once the transfer ends", async () => {
    // A clinic result that arrives while a transfer runs waits (the line belongs to the
    // transfer). A transfer started outside `run` must show it when it ends, as `run` does.
    let current = clinicSnapshot;
    const pending = pendingConnection();
    let finishImport!: (value: ImportOutcome) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(current)),
      connectPortal: vi.fn().mockReturnValue(pending.promise),
      checkDocuments: vi.fn(),
      requestDeviceApproval: vi.fn(),
      importPickedFiles: vi.fn().mockReturnValue(
        new Promise<ImportOutcome>((resolve) => {
          finishImport = resolve;
        }),
      ),
    });
    shown.bridge = null;
    render(<VaultApp bridge={bridge} />);
    const form = await openConnectForm();
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => expect(bridge.connectPortal).toHaveBeenCalledOnce());
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /^My records/ })[0]);
    await waitFor(() => expect(shown.bridge).not.toBeNull());
    // Not through `run`: nothing but `transfer()` itself brackets this call.
    const tracked = shown.bridge as VaultBridge;
    void tracked.importPickedFiles("pick-1", "profile-1", []);
    await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
    current = { ...clinicSnapshot, portalLinks: [connectedLink] };
    await act(async () =>
      pending.finish({ link: connectedLink, approvalError: null }),
    );
    await user.click(
      screen.getAllByRole("button", { name: /^Shared with me/ })[0],
    );
    expect(
      await screen.findByRole("button", { name: "Check for new documents" }),
    ).toBeVisible();
    // The transfer still runs: the clinic result is held, not shown.
    expect(screen.queryByText(/Device linked/)).not.toBeInTheDocument();
    await act(async () =>
      finishImport({ imported: ["FAKE.pdf"], skippedDuplicates: [] }),
    );
    expect(await screen.findByText(/Device linked/)).toBeVisible();
  });

  it.each([
    ["during save", "announce"],
    ["before announcement", "announce"],
    ["during save", "lock"],
    ["before announcement", "lock"],
    ["before announcement", "change document"],
    ["before announcement", "rename"],
    ["before announcement", "change person"],
  ] as const)(
    "settles photo and clinic results arriving %s before %s",
    async (arrival, nextAction) => {
      let current = clinicSnapshot;
      const pending = pendingConnection();
      let finishPhoto!: (outcome: ImportOutcome) => void;
      const streamCanvas = document.createElement("canvas");
      streamCanvas.width = 64;
      streamCanvas.height = 48;
      const paint = () => streamCanvas.getContext("2d")!.fillRect(0, 0, 64, 48);
      paint();
      const stream = streamCanvas.captureStream(15);
      const painter = window.setInterval(paint, 40);
      const camera = vi
        .spyOn(navigator.mediaDevices, "getUserMedia")
        .mockResolvedValue(stream);
      window.localStorage.setItem("mycarlos.cameraExplained.v1", "1");
      onTestFinished(() => {
        vi.useRealTimers();
        camera.mockRestore();
        window.clearInterval(painter);
        stream.getTracks().forEach((track) => track.stop());
        window.localStorage.removeItem("mycarlos.cameraExplained.v1");
      });
      const photo = {
        ...clinicSnapshot.records[0],
        id: "FAKE-photo-notice",
        displayName: "FAKE_Camera.jpg",
        mediaType: "application/octet-stream",
      };
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        platform: vi.fn().mockResolvedValue("windows"),
        snapshot: vi.fn(async () => captureSnapshot(current)),
        unlock: vi.fn(async () => captureSnapshot(current)),
        connectPortal: vi.fn().mockReturnValue(pending.promise),
        checkDocuments: vi
          .fn()
          .mockResolvedValue({ added: 0, refused: 0, receiptsPending: 0 }),
        savePhoto: vi.fn().mockReturnValue(
          new Promise<ImportOutcome>((resolve) => {
            finishPhoto = resolve;
          }),
        ),
        isPhoto: vi.fn(async (id) => id === photo.id),
        renameRecord: vi.fn(async (id, name) => {
          current = {
            ...current,
            records: current.records.map((record) =>
              record.id === id ? { ...record, displayName: name } : record,
            ),
          };
        }),
      });
      render(<VaultApp bridge={bridge} />);
      const form = await openConnectForm();
      await act(async () => fireEvent.submit(form));
      await waitFor(() => expect(bridge.connectPortal).toHaveBeenCalledOnce());
      const user = userEvent.setup();
      await user.click(
        screen.getAllByRole("button", { name: /^My records/ })[0],
      );
      await chooseAdd(user, "Take a photo");
      const shutter = screen.getByRole("button", { name: "Take photo" });
      await waitFor(() => expect(shutter).toBeEnabled());
      fireEvent.click(shutter);
      fireEvent.click(screen.getByRole("button", { name: "Use photo" }));
      await waitFor(() => expect(bridge.savePhoto).toHaveBeenCalledOnce());

      // Control the actual deferred announcement, after camera encoding has
      // finished, without changing the native save or clinic promise order.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const finishClinic = async () => {
        current = { ...current, portalLinks: [connectedLink] };
        if (nextAction === "change person")
          current = {
            ...current,
            profiles: [
              ...current.profiles,
              {
                id: "FAKE-other-person",
                displayName: "FAKE Second Patient",
                createdAtMs: 2,
              },
            ],
          };
        await act(async () =>
          pending.finish({ link: connectedLink, approvalError: null }),
        );
      };
      if (arrival === "during save") await finishClinic();
      current = { ...current, records: [...current.records, photo] };
      await act(async () =>
        finishPhoto({ imported: [photo.id], skippedDuplicates: [] }),
      );
      const details = screen.getByRole("dialog", { name: photo.displayName });
      expect(details).toBeVisible();
      if (arrival === "before announcement") await finishClinic();
      const closeDetails = () =>
        fireEvent.click(
          within(details).getByRole("button", {
            name: "Close document details",
          }),
        );
      if (nextAction === "lock") {
        closeDetails();
        await act(async () =>
          fireEvent.click(
            screen.getAllByRole("button", { name: /Lock now/ })[0],
          ),
        );
        expect(
          screen.getByRole("heading", { name: "Unlock your vault" }),
        ).toBeVisible();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ANNOUNCE_DELAY_MS);
        });
        expect(
          screen.queryByText(/FAKE_Camera.jpg was saved|Device linked/),
        ).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Passphrase", { exact: true }), {
          target: { value: "FAKE photo notice passphrase" },
        });
        await act(async () =>
          fireEvent.submit(
            screen.getByRole("button", { name: "Unlock" }).closest("form")!,
          ),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ANNOUNCE_DELAY_MS);
        });
        expect(
          screen.getByRole("heading", { name: "My records" }),
        ).toBeVisible();
        expect(
          screen.queryByText(/FAKE_Camera.jpg was saved|Device linked/),
        ).not.toBeInTheDocument();
        expect(bridge.savePhoto).toHaveBeenCalledOnce();
        return;
      }
      if (nextAction === "change document") {
        closeDetails();
        await act(async () =>
          fireEvent.click(
            screen.getByRole("button", { name: "FAKE_Results.pdf" }),
          ),
        );
      } else if (nextAction === "change person") {
        closeDetails();
        const otherPerson = () =>
          within(
            screen.getByRole("navigation", { name: "Record library" }),
          ).getByRole("button", { name: /^FAKE Second Patient\b/ });
        await act(async () => fireEvent.click(otherPerson()));
        expect(otherPerson()).toHaveAttribute("aria-current", "page");
      } else if (nextAction === "rename") {
        await act(async () =>
          fireEvent.click(
            within(details).getByRole("button", { name: "Rename document" }),
          ),
        );
        fireEvent.change(screen.getByRole("textbox", { name: "File name" }), {
          target: { value: "FAKE_Renamed" },
        });
        await act(async () =>
          fireEvent.click(screen.getByRole("button", { name: "Save name" })),
        );
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ANNOUNCE_DELAY_MS);
      });
      const clinicNotice =
        "Device linked. Its approval status is shown in Security, under Connected clinics.";
      if (nextAction === "announce")
        expect(within(details).getByRole("status")).toHaveHumanTextContent(
          `FAKE_Camera.jpg was saved in myCarlos. ${clinicNotice}`,
        );
      else if (nextAction === "rename")
        expect(
          within(
            screen.getByRole("dialog", { name: "FAKE_Renamed.jpg" }),
          ).getByRole("status"),
        ).toHaveHumanTextContent(
          `Document renamed to FAKE_Renamed.jpg. ${clinicNotice}`,
        );
      else if (nextAction === "change document")
        expect(
          within(
            screen.getByRole("dialog", { name: "FAKE_Results.pdf" }),
          ).getByRole("status"),
        ).toHaveHumanTextContent(clinicNotice);
      else
        expect(screen.getByText(clinicNotice, { exact: true })).toBeVisible();
      if (nextAction !== "announce")
        expect(
          screen.queryByText(/FAKE_Camera.jpg was saved/),
        ).not.toBeInTheDocument();
      expect(bridge.savePhoto).toHaveBeenCalledOnce();
      expect(bridge.connectPortal).toHaveBeenCalledOnce();
    },
  );

  it("forgets a held clinic result when the vault locks", async () => {
    let current = clinicSnapshot;
    const pending = pendingConnection();
    let pick!: (value: string | null) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(current)),
      unlock: vi.fn().mockImplementation(async () => captureSnapshot(current)),
      connectPortal: vi.fn().mockReturnValue(pending.promise),
      // The unlock checks for documents (#128): nothing new.
      checkDocuments: vi
        .fn()
        .mockResolvedValue({ added: 0, refused: 0, receiptsPending: 0 }),
      requestDeviceApproval: vi.fn(),
      pickImportFiles: vi.fn().mockReturnValue(
        new Promise<string | null>((resolve) => {
          pick = resolve;
        }),
      ),
    });
    render(<VaultApp bridge={bridge} />);
    const form = await openConnectForm();
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => expect(bridge.connectPortal).toHaveBeenCalledOnce());
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /^My records/ })[0]);
    await user.click(await importMenuItem());
    await waitFor(() => expect(bridge.pickImportFiles).toHaveBeenCalled());
    current = { ...clinicSnapshot, portalLinks: [connectedLink] };
    await act(async () =>
      pending.finish({ link: connectedLink, approvalError: null }),
    );
    await user.click(
      screen.getAllByRole("button", { name: /^Shared with me/ })[0],
    );
    expect(
      await screen.findByRole("button", { name: "Check for new documents" }),
    ).toBeVisible();
    await user.click(screen.getAllByRole("button", { name: /Lock now/ })[0]);
    expect(
      await screen.findByRole("heading", { name: "Unlock your vault" }),
    ).toBeVisible();
    // The picker settles in the ended session: nothing reaches the unlock
    // screen.
    await act(async () => pick(null));
    expect(screen.queryByText(/Device linked/)).not.toBeInTheDocument();
    await user.type(
      screen.getByLabelText("Passphrase", { exact: true }),
      "FAKE clinic lock passphrase",
    );
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(
      await screen.findByRole("heading", { name: "My records" }),
    ).toBeVisible();
    expect(screen.queryByText(/Device linked/)).not.toBeInTheDocument();
  });

  it("replaces an earlier clinic error with the next result, and holds an error during a picker", async () => {
    let current = clinicSnapshot;
    const retry = pendingConnection();
    let refuseLater!: (error: unknown) => void;
    const later = new Promise<never>((_, reject) => {
      refuseLater = reject;
    });
    let pick!: (value: string | null) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(current)),
      connectPortal: vi
        .fn()
        .mockRejectedValueOnce({ code: "portal_link_code_rejected" })
        .mockReturnValueOnce(retry.promise)
        .mockReturnValueOnce(later),
      checkDocuments: vi.fn(),
      requestDeviceApproval: vi.fn(),
      pickImportFiles: vi.fn().mockReturnValue(
        new Promise<string | null>((resolve) => {
          pick = resolve;
        }),
      ),
    });
    render(<VaultApp bridge={bridge} />);
    const rejected =
      "The portal did not accept that code. Make a new linking code in your patient portal.";
    const form = await openConnectForm();
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(await screen.findByText(rejected)).toBeVisible();
    // A new attempt clears the line when it starts; its result is alone.
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("Linking code"),
      "01234567-89ABCDEFGJ",
    );
    await act(async () => {
      fireEvent.submit(
        screen
          .getByRole("button", { name: "Connect and request approval" })
          .closest("form")!,
      );
    });
    await waitFor(() => expect(bridge.connectPortal).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(rejected)).not.toBeInTheDocument();
    current = { ...clinicSnapshot, portalLinks: [connectedLink] };
    await act(async () =>
      retry.finish({ link: connectedLink, approvalError: null }),
    );
    expect(
      await screen.findByText(
        "Device linked. Its approval status is shown in Security, under Connected clinics.",
      ),
    ).toBeVisible();
    // The result can render before clinic admission is released. Wait for
    // the next attempt to be usable before typing its code: a clinic is
    // linked now, so it starts from "Link another clinic" (#145).
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Link another clinic" }),
      ).toBeEnabled(),
    );
    // An error that arrives while a picker is open waits for its result.
    // The form opens from "Link another clinic", empty for the next clinic's
    // address.
    await user.click(
      screen.getByRole("button", { name: "Link another clinic" }),
    );
    await user.type(
      screen.getByLabelText("Portal HTTPS address"),
      "https://portal.example.test/patient",
    );
    await user.type(
      screen.getByLabelText("Linking code"),
      "01234567-89ABCDEFGK",
    );
    expect(screen.getByLabelText("Linking code")).toHaveValue(
      "01234567-89ABCDEFGK",
    );
    await act(async () => {
      fireEvent.submit(
        screen
          .getByRole("button", { name: "Connect and request approval" })
          .closest("form")!,
      );
    });
    // The third request must have entered before the picker is opened.
    await waitFor(() => expect(bridge.connectPortal).toHaveBeenCalledTimes(3));
    await user.click(screen.getAllByRole("button", { name: /^My records/ })[0]);
    await user.click(await importMenuItem());
    await waitFor(() => expect(bridge.pickImportFiles).toHaveBeenCalled());
    expect(bridge.connectPortal).toHaveBeenCalledTimes(3);
    await act(async () => refuseLater({ code: "portal_busy" }));
    await user.click(
      screen.getAllByRole("button", { name: /^Shared with me/ })[0],
    );
    expect(
      await screen.findByRole("button", { name: "Check for new documents" }),
    ).toBeVisible();
    expect(
      screen.queryByText(/Another clinic operation is running/),
    ).not.toBeInTheDocument();
    await act(async () => pick(null));
    expect(
      await screen.findByText(
        "No files selected. Nothing changed. Another clinic operation is running. Wait for it to finish, then try again.",
      ),
    ).toBeVisible();
  });

  it("drops old-session completion without unlocking or clearing a new session's clinic work", async () => {
    const first = pendingConnection();
    const second = pendingConnection();
    const secondLink = {
      ...connectedLink,
      id: "fake-clinic-link-2",
      clinicName: "FAKE Second Clinic",
      deviceKeyId: "FAKE_SECOND_DEVICE",
      deviceFingerprint: "22".repeat(32),
    };
    const secondSnapshot: VaultSnapshot = {
      ...clinicSnapshot,
      profiles: [
        { id: "profile-2", displayName: "FAKE Second Patient", createdAtMs: 2 },
      ],
      records: [],
    };
    let current = clinicSnapshot;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(current)),
      unlock: vi.fn().mockResolvedValue(secondSnapshot),
      connectPortal: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
      checkDocuments: vi.fn(),
      requestDeviceApproval: vi.fn(),
    });
    render(<VaultApp bridge={bridge} />);
    const submittedForm = await openConnectForm();
    await act(async () => {
      fireEvent.submit(submittedForm);
    });
    await waitFor(() => expect(bridge.connectPortal).toHaveBeenCalledOnce());
    await userEvent
      .setup()
      .click(screen.getAllByRole("button", { name: /Lock now/ })[0]);
    expect(
      await screen.findByRole("heading", { name: "Unlock your vault" }),
    ).toBeVisible();
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("Passphrase", { exact: true }),
      "FAKE second session passphrase",
    );
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    current = secondSnapshot;
    const nextForm = await openConnectForm("01234567-89ABCDEFGJ");
    await act(async () => {
      fireEvent.submit(nextForm);
    });
    await waitFor(() => expect(bridge.connectPortal).toHaveBeenCalledTimes(2));
    vi.mocked(bridge.snapshot).mockResolvedValueOnce({
      ...clinicSnapshot,
      portalLinks: [connectedLink],
    });
    await act(async () =>
      first.finish({ link: connectedLink, approvalError: null }),
    );
    expect(screen.queryByText("FAKE First Clinic")).not.toBeInTheDocument();
    // Nothing of the old session's result reaches the new session's line.
    expect(screen.queryByText(/Device linked/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect and request approval" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Connecting and requesting clinic approval…"),
    ).toBeVisible();
    current = { ...secondSnapshot, portalLinks: [secondLink] };
    await act(async () =>
      second.finish({ link: secondLink, approvalError: null }),
    );
    expect(await screen.findByText("FAKE Second Clinic")).toBeVisible();
    expect(screen.queryByText("FAKE First Clinic")).not.toBeInTheDocument();
    expect(bridge.requestDeviceApproval).not.toHaveBeenCalled();
  });
});

describe("automatic clinic approval checks in the app (#131)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    forgetRecoveryOffer();
    recordRecoveryOffer(Date.now());
  });
  const pending: PortalLinkSummary = {
    id: "fake-clinic-link",
    portalBase: "https://portal.example.test/patient",
    deviceName: "myCarlos FAKE device",
    profileId: null,
    clinicName: "FAKE First Clinic",
    fingerprints: [],
    incomplete: false,
    deviceKeyId: "FAKE_FIRST_DEVICE",
    deviceFingerprint: "11".repeat(32),
    approvalRequested: true,
    clinicApproved: false,
    approvalStatus: "pending",
  };
  const vaultWith = (link: PortalLinkSummary): VaultSnapshot => ({
    ...snapshotWithRecord,
    profiles: [
      { id: "profile-1", displayName: "FAKE First Patient", createdAtMs: 1 },
    ],
    recoveryKeySetAtMs: 5,
    portalLinkingEnabled: true,
    portalLinks: [link],
  });
  const found = (
    link: PortalLinkSummary,
    extra: Partial<PortalApprovalCheck> = {},
  ): PortalApprovalCheck => ({
    capture: captureSnapshot(vaultWith(link)).capture,
    link,
    expiresInMs: null,
    issue: null,
    ...extra,
  });
  const BUSY = /Another clinic operation is running/;
  function fakeClock() {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
        "performance",
      ],
    });
    onTestFinished(() => {
      vi.useRealTimers();
    });
  }
  const pass = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const click = (element: HTMLElement) =>
    act(async () => {
      fireEvent.click(element);
    });
  async function openClinicView(bridge: VaultBridge) {
    fakeClock();
    await act(async () => {
      render(<VaultApp bridge={bridge} />);
    });
    await pass(100);
    await click(screen.getByRole("button", { name: "Security" }));
  }
  function clinicBridge(overrides: Partial<VaultBridge>) {
    return nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(vaultWith(pending))),
      unlock: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(vaultWith(pending))),
      connectPortal: vi.fn(),
      // An unlock now checks for documents (#128): nothing new.
      checkDocuments: vi
        .fn()
        .mockResolvedValue({ added: 0, refused: 0, receiptsPending: 0 }),
      requestDeviceApproval: vi.fn().mockResolvedValue(undefined),
      restartDeviceApproval: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    });
  }

  it("checks quietly, is never activity, and lets the vault lock when left alone", async () => {
    const bridge = clinicBridge({
      refreshDeviceApproval: vi
        .fn()
        .mockImplementation(async () =>
          found(pending, { expiresInMs: 4 * 60_000 }),
        ),
    });
    await openClinicView(bridge);
    const snapshots = vi.mocked(bridge.snapshot).mock.calls.length;
    const touches = vi.mocked(bridge.touch).mock.calls.length;
    await pass(10_000);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledWith(pending.id);
    expect(
      screen.getByText(
        humanText("Time left for this request: about 4 minutes."),
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Your clinic has the approval request. Waiting for clinic staff to approve this device.",
      ),
    ).toBeVisible();
    // Quiet: nothing says clinic work is running, and nothing is disabled.
    expect(
      screen.queryByText("Clinic operation in progress…"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Link another clinic" }),
    ).toBeEnabled();
    await pass(3 * 60_000);
    expect(
      vi.mocked(bridge.refreshDeviceApproval!).mock.calls.length,
    ).toBeGreaterThanOrEqual(4);
    // Not activity: no whole-vault read (which counts natively), no touch.
    expect(bridge.snapshot).toHaveBeenCalledTimes(snapshots);
    expect(bridge.touch).toHaveBeenCalledTimes(touches);
    expect(bridge.requestDeviceApproval).not.toHaveBeenCalled();
    expect(bridge.restartDeviceApproval).not.toHaveBeenCalled();
    // Left alone, the vault locks on time, and the checks stop with it.
    await pass(2 * 60_000 + 30_000);
    expect(bridge.lock).toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Unlock your vault" }),
    ).toBeVisible();
    const atLock = vi.mocked(bridge.refreshDeviceApproval!).mock.calls.length;
    await pass(10 * 60_000);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledTimes(atLock);
  });

  it("holds the patient's own retry for a check under way instead of refusing it, with records usable", async () => {
    let finishCheck!: (value: PortalApprovalCheck) => void;
    const bridge = clinicBridge({
      refreshDeviceApproval: vi
        .fn()
        .mockReturnValueOnce(
          new Promise<PortalApprovalCheck>((resolve) => {
            finishCheck = resolve;
          }),
        )
        .mockImplementation(async () => found(pending)),
    });
    await openClinicView(bridge);
    await pass(10_000);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledOnce();
    // Local records stay usable while the check waits on the portal.
    await click(screen.getAllByRole("button", { name: /^My records/ })[0]);
    await click(screen.getByRole("button", { name: "FAKE_Results.pdf" }));
    expect(
      screen.getByRole("dialog", { name: "FAKE_Results.pdf" }),
    ).toBeVisible();
    await click(screen.getByRole("button", { name: "Close document details" }));
    await click(screen.getByRole("button", { name: "Security" }));
    await click(
      screen.getByRole("button", { name: "Retry saved approval request" }),
    );
    expect(screen.getByText("Clinic operation in progress…")).toBeVisible();
    expect(bridge.requestDeviceApproval).not.toHaveBeenCalled();
    await act(async () => finishCheck(found(pending)));
    await pass(0);
    expect(bridge.requestDeviceApproval).toHaveBeenCalledOnce();
    expect(screen.queryByText(BUSY)).not.toBeInTheDocument();
    // No check runs beside it, and none overlaps the next one.
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledOnce();
    await pass(10_000);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a save that reached one copy", "result"],
    ["a refusal in recovery mode", "error"],
  ] as const)(
    "shows read-only recovery after %s during a check, and stops checking",
    async (_, how) => {
      let current = vaultWith(pending);
      // The vault is read again after the check's own result is shown, as
      // in the app, where that read takes a moment.
      let releaseRead!: () => void;
      const reread = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const bridge = clinicBridge({
        snapshot: vi.fn().mockImplementation(async () => {
          if (current.recovery) await reread;
          return captureSnapshot(current);
        }),
        refreshDeviceApproval: vi.fn().mockImplementation(async () => {
          current = { ...vaultWith(pending), recovery: "writeFailed" };
          if (how === "error")
            throw {
              code: "recovery_mode",
              message: "FAKE native recovery text.",
            };
          return found(pending, { recovery: true });
        }),
      });
      await openClinicView(bridge);
      expect(
        screen.getByRole("button", { name: "Link another clinic" }),
      ).toBeEnabled();
      // The focused control is disabled once the vault reads read-only:
      // focus goes to the device's heading, not to the page.
      screen
        .getByRole("button", { name: "Retry saved approval request" })
        .focus();
      const snapshots = vi.mocked(bridge.snapshot).mock.calls.length;
      await pass(10_000);
      expect(bridge.refreshDeviceApproval).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("button", { name: "Retry saved approval request" }),
      ).toHaveFocus();
      await act(async () => releaseRead());
      await pass(0);
      // Read again, once: the vault on screen is read-only now.
      expect(bridge.snapshot).toHaveBeenCalledTimes(snapshots + 1);
      expect(
        screen.getByRole("button", { name: "Link another clinic" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Retry saved approval request" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("heading", { name: "FAKE First Clinic", level: 3 }),
      ).toHaveFocus();
      await pass(5 * 60_000);
      expect(bridge.refreshDeviceApproval).toHaveBeenCalledOnce();
    },
  );

  it("keeps a wait asked of the header's document check for the clinic view, until the vault locks", async () => {
    const bridge = clinicBridge({
      // The header's two checks are asked to wait; the next session's own
      // check after unlocking (#128) is not.
      checkDocuments: vi
        .fn()
        .mockResolvedValueOnce({
          added: 0,
          refused: 0,
          receiptsPending: 0,
          issues: [
            {
              linkId: pending.id,
              clinicName: "FAKE First Clinic",
              code: "portal_rate_limited",
            },
          ],
        })
        .mockResolvedValueOnce({
          added: 0,
          refused: 0,
          receiptsPending: 0,
          issues: [
            {
              linkId: pending.id,
              clinicName: "FAKE First Clinic",
              code: "portal_rate_limited",
            },
          ],
        })
        .mockResolvedValue({ added: 0, refused: 0, receiptsPending: 0 }),
      refreshDeviceApproval: vi
        .fn()
        .mockImplementation(async () => found(pending)),
    });
    fakeClock();
    await act(async () => {
      render(<VaultApp bridge={bridge} />);
    });
    await pass(100);
    // Start the manual document check from the reserved Shared view.
    await click(screen.getAllByRole("button", { name: /^Shared with me/ })[0]);
    await click(
      screen.getByRole("button", { name: "Check for new documents" }),
    );
    await pass(0);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    await click(screen.getByRole("button", { name: "Security" }));
    // Not 10 s after the view opens: the portal's wait (60 s, as it gave no
    // time) holds the first check.
    await pass(50_000);
    expect(bridge.refreshDeviceApproval).not.toHaveBeenCalled();
    await pass(10_100);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledOnce();
    // A wait does not outlive the session: after a lock, the first check
    // comes 10 s after the view opens.
    vi.mocked(bridge.checkDocuments!).mockClear();
    await click(screen.getAllByRole("button", { name: /^Shared with me/ })[0]);
    await click(
      screen.getAllByRole("button", { name: "Check for new documents" })[0],
    );
    await pass(0);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    await click(screen.getAllByRole("button", { name: /Lock now/ })[0]);
    await pass(100);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Passphrase", { exact: true }), {
        target: { value: "FAKE wait lock passphrase" },
      });
    });
    await click(screen.getByRole("button", { name: "Unlock" }));
    // The unlock's own check runs first (#128); it is not asked to wait.
    await pass(ANNOUNCE_DELAY_MS);
    expect(bridge.checkDocuments).toHaveBeenCalledTimes(2);
    await click(screen.getByRole("button", { name: "Security" }));
    await pass(10_000);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledTimes(2);
  });

  const arrivalVault = (link: PortalLinkSummary): VaultSnapshot => ({
    ...vaultWith(link),
    sharedProfileId: "FAKE_NATIVE_CAPTURE_OWNER",
    automaticDocumentChecksSupported: true,
  });
  const accepted: PortalLinkSummary = {
    ...pending,
    approvalStatus: "accepted",
    clinicApproved: true,
  };

  it("keeps a newer polled device and unrelated records from an older whole capture", async () => {
    let deliverWhole!: () => void;
    const beforePoll = arrivalVault(pending);
    const withArrival: VaultSnapshot = {
      ...beforePoll,
      records: [
        ...beforePoll.records,
        {
          ...beforePoll.records[0],
          id: "FAKE_PARALLEL_RECORD",
          displayName: "FAKE_Parallel_Arrival.pdf",
        },
      ],
    };
    const bridge = clinicBridge({
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(beforePoll)),
      refreshDeviceApproval: vi
        .fn()
        .mockImplementation(async () => found(accepted)),
    });
    await openClinicView(bridge);
    const beforeRead = vi.mocked(bridge.snapshot).mock.calls.length;
    vi.mocked(bridge.snapshot).mockImplementationOnce(() => {
      const captured = captureSnapshot(withArrival);
      return new Promise<VaultSnapshot>((resolve) => {
        deliverWhole = () => resolve(captured);
      });
    });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(bridge.snapshot).toHaveBeenCalledTimes(beforeRead + 1);
    await pass(10_000);
    expect(
      within(document.getElementById(`portal-link-${pending.id}`)!).getByText(
        "The clinic approved this device.",
      ),
    ).toBeVisible();
    await act(async () => deliverWhole());
    expect(
      within(document.getElementById(`portal-link-${pending.id}`)!).getByText(
        "The clinic approved this device.",
      ),
    ).toBeVisible();
    await click(screen.getAllByRole("button", { name: /^My records/ })[0]);
    expect(
      screen.getByRole("button", { name: "FAKE_Parallel_Arrival.pdf" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "FAKE_Results.pdf" }),
    ).toBeVisible();
  });

  it("keeps a newer whole device capture ahead of an older delivered poll and panel notice", async () => {
    let deliverPoll!: () => void;
    const refused: PortalLinkSummary = {
      ...pending,
      approvalStatus: "refused",
    };
    const bridge = clinicBridge({
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(arrivalVault(pending))),
      refreshDeviceApproval: vi.fn().mockImplementationOnce(() => {
        const captured = found(accepted, { expiresInMs: 240_000 });
        return new Promise<PortalApprovalCheck>((resolve) => {
          deliverPoll = () => resolve(captured);
        });
      }),
    });
    await openClinicView(bridge);
    await pass(10_000);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledOnce();
    vi.mocked(bridge.snapshot).mockImplementation(async () =>
      captureSnapshot(arrivalVault(refused)),
    );
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(
      screen.getByText(
        "The clinic refused this device approval request. Contact your clinic for next steps.",
      ),
    ).toBeVisible();
    await act(async () => deliverPoll());
    expect(
      screen.getByText(
        "The clinic refused this device approval request. Contact your clinic for next steps.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("The clinic approved this device."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Time left for this request/),
    ).not.toBeInTheDocument();
  });

  it("retires a poll countdown when a newer whole capture changes the device", async () => {
    const pickedUp: PortalLinkSummary = {
      ...pending,
      approvalStatus: "challenge_ready",
    };
    const bridge = clinicBridge({
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(arrivalVault(pending))),
      refreshDeviceApproval: vi
        .fn()
        .mockImplementation(async () =>
          found(pending, { expiresInMs: 240_000 }),
        ),
    });
    await openClinicView(bridge);
    await pass(10_000);
    expect(
      screen.getByText(
        humanText("Time left for this request: about 4 minutes."),
      ),
    ).toBeVisible();
    vi.mocked(bridge.snapshot).mockImplementation(async () =>
      captureSnapshot(arrivalVault(pickedUp)),
    );
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(
      screen.getByText(
        "Your clinic's records system has picked up this request. Waiting for clinic staff to approve this device.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(/Time left for this request/),
    ).not.toBeInTheDocument();
  });

  it("refuses a poll capture from another native runtime before device or panel publication", async () => {
    const bridge = clinicBridge({
      refreshDeviceApproval: vi.fn().mockImplementation(async () => {
        const result = found(accepted, { expiresInMs: 240_000 });
        return {
          ...result,
          capture: {
            ...result.capture,
            epoch: "FAKE_DIFFERENT_NATIVE_RUNTIME",
          },
        };
      }),
    });
    await openClinicView(bridge);
    await pass(10_000);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledOnce();
    expect(
      screen.getByText(
        "Approval request saved. Check for updates or send it again.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("The clinic approved this device."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Time left for this request/),
    ).not.toBeInTheDocument();
  });

  it("keeps an ordinary poll timeout retryable without locking the current vault", async () => {
    const bridge = clinicBridge({
      refreshDeviceApproval: vi.fn().mockImplementation(async () =>
        found(pending, {
          issue: {
            code: "portal_link_incomplete",
            message: "FAKE whole-poll network budget expired.",
          },
        }),
      ),
    });
    await openClinicView(bridge);
    await pass(10_000);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledOnce();
    expect(bridge.lock).not.toHaveBeenCalled();
    expect(
      within(document.getElementById(`portal-link-${pending.id}`)!).getByText(
        "myCarlos could not reach the clinic portal, so this request's status is not known yet.",
      ),
    ).toBeVisible();
    await pass(20_000);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledTimes(2);
    expect(bridge.lock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Retry saved approval request" }),
    ).toBeEnabled();
  });

  it("keeps the manual full document check available after automatic approval checks stop", async () => {
    let current = vaultWith(pending);
    const bridge = clinicBridge({
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(current)),
      refreshDeviceApproval: vi
        .fn()
        .mockImplementation(async () => found(pending)),
      checkDocuments: vi.fn().mockImplementation(async () => {
        current = vaultWith(accepted);
        return { added: 0, refused: 0, receiptsPending: 0, issues: [] };
      }),
    });
    await openClinicView(bridge);
    // Actual user input keeps the vault open; polling itself never does.
    // It does not restart the independent fifteen-minute polling window.
    for (let step = 0; step < 3; step += 1) {
      await pass(4 * 60_000);
      await act(async () => fireEvent.keyDown(window, { key: "Shift" }));
    }
    await pass(3 * 60_000 + 1_000);
    expect(bridge.lock).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        humanText(
          "Automatic checks have stopped. To check again, choose Check for new documents.",
        ),
      ),
    ).toBeVisible();
    await click(screen.getAllByRole("button", { name: /^Shared with me/ })[0]);
    const check = screen.getByRole("button", {
      name: "Check for new documents",
    });
    await click(check);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    await click(screen.getByRole("button", { name: "Security" }));
    expect(
      within(document.getElementById(`portal-link-${pending.id}`)!).getByText(
        "The clinic approved this device.",
      ),
    ).toBeVisible();
    expect(bridge.requestDeviceApproval).not.toHaveBeenCalled();
    expect(bridge.restartDeviceApproval).not.toHaveBeenCalled();
  });

  const pickedUp: PortalLinkSummary = {
    ...pending,
    approvalStatus: "challenge_ready",
  };
  const pickupText =
    "Your clinic's records system has picked up this request. Waiting for clinic staff to approve this device.";
  const deviceCard = () =>
    within(document.getElementById(`portal-link-${pending.id}`)!);

  it("drops an old rejected poll after a newer whole pickup capture", async () => {
    let rejectOld!: () => void;
    const oldError = "FAKE old poll failed after its newer whole capture.";
    const bridge = clinicBridge({
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(arrivalVault(pending))),
      refreshDeviceApproval: vi.fn().mockImplementationOnce(
        () =>
          new Promise<PortalApprovalCheck>((_, reject) => {
            rejectOld = () =>
              reject({ code: "FAKE_older_poll", message: oldError });
          }),
      ),
    });
    await openClinicView(bridge);
    await pass(10_000);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledOnce();
    vi.mocked(bridge.snapshot).mockImplementation(async () =>
      captureSnapshot(arrivalVault(pickedUp)),
    );
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(deviceCard().getByText(pickupText)).toBeVisible();
    await act(async () => rejectOld());
    expect(deviceCard().getByText(pickupText)).toBeVisible();
    expect(screen.queryAllByText(oldError)).toHaveLength(0);
    expect(bridge.lock).not.toHaveBeenCalled();
  });

  it("retires a genuine poll failure and its announcement on a subsequent whole capture", async () => {
    const failure = "FAKE current poll failed before the later whole capture.";
    const bridge = clinicBridge({
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(arrivalVault(pending))),
      refreshDeviceApproval: vi
        .fn()
        .mockRejectedValueOnce({
          code: "FAKE_current_poll",
          message: failure,
        })
        .mockImplementation(async () => found(pickedUp)),
    });
    await openClinicView(bridge);
    await pass(10_000);
    expect(deviceCard().getByText(failure)).toBeVisible();
    await pass(20_000);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledOnce();
    vi.mocked(bridge.snapshot).mockImplementation(async () =>
      captureSnapshot(arrivalVault(pickedUp)),
    );
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(deviceCard().getByText(pickupText)).toBeVisible();
    expect(screen.queryAllByText(failure)).toHaveLength(0);
    await pass(1_000);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledTimes(2);
    expect(bridge.lock).not.toHaveBeenCalled();
  });

  it("keeps a current failure when an older whole capture only merges unrelated records", async () => {
    let deliverOldWhole!: () => void;
    let rejectCurrent!: () => void;
    const failure = "FAKE current failure after the newest device capture.";
    const beforePoll = arrivalVault(pending);
    const withRecord: VaultSnapshot = {
      ...beforePoll,
      records: [
        ...beforePoll.records,
        {
          ...beforePoll.records[0],
          id: "FAKE_DURING_FAILURE",
          displayName: "FAKE_Arrived_Before_Poll.pdf",
        },
      ],
    };
    const bridge = clinicBridge({
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(beforePoll)),
      refreshDeviceApproval: vi
        .fn()
        .mockImplementationOnce(async () => found(pickedUp))
        .mockImplementationOnce(
          () =>
            new Promise<PortalApprovalCheck>((_, reject) => {
              rejectCurrent = () =>
                reject({ code: "FAKE_current_poll", message: failure });
            }),
        ),
    });
    await openClinicView(bridge);
    vi.mocked(bridge.snapshot).mockImplementationOnce(() => {
      const captured = captureSnapshot(withRecord);
      return new Promise<VaultSnapshot>((resolve) => {
        deliverOldWhole = () => resolve(captured);
      });
    });
    await act(async () => window.dispatchEvent(new Event("focus")));
    await pass(10_000);
    expect(deviceCard().getByText(pickupText)).toBeVisible();
    await pass(20_000);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledTimes(2);
    // This whole read predates the successful partial device capture, and
    // cannot disown the next poll's genuine error merely by arriving late.
    await act(async () => deliverOldWhole());
    expect(deviceCard().getByText(pickupText)).toBeVisible();
    await act(async () => rejectCurrent());
    expect(deviceCard().getByText(failure)).toBeVisible();
    await click(screen.getAllByRole("button", { name: /^My records/ })[0]);
    expect(
      screen.getByRole("button", { name: "FAKE_Arrived_Before_Poll.pdf" }),
    ).toBeVisible();
  });

  it("keeps a genuine current poll failure when no newer whole capture supersedes it", async () => {
    const failure = "FAKE genuine current poll failure.";
    const bridge = clinicBridge({
      refreshDeviceApproval: vi.fn().mockRejectedValue({
        code: "FAKE_current_poll",
        message: failure,
      }),
    });
    await openClinicView(bridge);
    await pass(10_000);
    expect(deviceCard().getByText(failure)).toBeVisible();
    await pass(30_000);
    expect(deviceCard().getByText(failure)).toBeVisible();
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledOnce();
    expect(bridge.lock).not.toHaveBeenCalled();
  });

  it.each(["locked", "cancelled"])(
    "still locks for a genuine current %s poll rejection",
    async (code) => {
      const bridge = clinicBridge({
        refreshDeviceApproval: vi.fn().mockRejectedValue({
          code,
          message: "FAKE actual native session ended.",
        }),
      });
      await openClinicView(bridge);
      await pass(10_000);
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("heading", { name: "Unlock your vault" }),
      ).toBeVisible();
    },
  );

  it.each(["result", "error"])(
    "keeps immediate read-only recovery and focused-control cleanup for a current poll %s",
    async (how) => {
      let current = vaultWith(pending);
      const bridge = clinicBridge({
        snapshot: vi
          .fn()
          .mockImplementation(async () => captureSnapshot(current)),
        refreshDeviceApproval: vi.fn().mockImplementation(async () => {
          current = { ...vaultWith(pending), recovery: "writeFailed" };
          if (how === "error")
            throw {
              code: "recovery_mode",
              message: "FAKE immediate current recovery.",
            };
          return found(pending, { recovery: true });
        }),
      });
      await openClinicView(bridge);
      screen
        .getByRole("button", { name: "Retry saved approval request" })
        .focus();
      const reads = vi.mocked(bridge.snapshot).mock.calls.length;
      await pass(10_000);
      expect(bridge.snapshot).toHaveBeenCalledTimes(reads + 1);
      expect(
        screen.getByRole("button", { name: "Retry saved approval request" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("heading", { name: "FAKE First Clinic", level: 3 }),
      ).toHaveFocus();
      expect(bridge.lock).not.toHaveBeenCalled();
    },
  );

  it.each(["result", "error"])(
    "rereads genuine recovery from a current poll %s after leaving the clinic view",
    async (how) => {
      let current = vaultWith(pending);
      let finish!: () => void;
      const bridge = clinicBridge({
        snapshot: vi
          .fn()
          .mockImplementation(async () => captureSnapshot(current)),
        refreshDeviceApproval: vi.fn().mockImplementationOnce(
          () =>
            new Promise<PortalApprovalCheck>((resolve, reject) => {
              finish = () => {
                current = { ...vaultWith(pending), recovery: "writeFailed" };
                if (how === "error")
                  reject({
                    code: "recovery_mode",
                    message: "FAKE current recovery after navigation.",
                  });
                else resolve(found(pending, { recovery: true }));
              };
            }),
        ),
      });
      await openClinicView(bridge);
      await pass(10_000);
      expect(bridge.refreshDeviceApproval).toHaveBeenCalledOnce();
      await click(screen.getAllByRole("button", { name: /^My records/ })[0]);
      const reads = vi.mocked(bridge.snapshot).mock.calls.length;
      await act(async () => finish());
      await pass(0);
      expect(bridge.snapshot).toHaveBeenCalledTimes(reads + 1);
      expect(
        screen.getByRole("button", { name: humanText("Add document") }),
      ).toBeDisabled();
      expect(bridge.lock).not.toHaveBeenCalled();
    },
  );

  const ownWaitActions = [
    "connect",
    "request",
    "restart",
    "header check",
    "panel check",
  ] as const;
  type OwnWaitAction = (typeof ownWaitActions)[number];
  async function holdOwnWait(action: OwnWaitAction) {
    let current = vaultWith({ ...pending, approvalCanRestart: true });
    if (action === "connect") current = { ...current, portalLinks: [] };
    let complete!: () => void;
    const rateLimit = {
      code: "portal_rate_limited",
      message: "FAKE portal asked this session to wait.",
      retryAfterMs: 120_000,
    };
    const held = <T,>(value: T, reject = false) =>
      new Promise<T>((resolve, fail) => {
        complete = () => {
          if (action === "connect") current = vaultWith(pending);
          if (reject) fail(rateLimit);
          else resolve(value);
        };
      });
    const bridge = clinicBridge({
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(current)),
      unlock: vi.fn().mockImplementation(async () => {
        // The native result can already be persisted while its IPC reply is
        // still held. The new session has an awaiting device at that portal.
        current = vaultWith(pending);
        return captureSnapshot(current);
      }),
      refreshDeviceApproval: vi
        .fn()
        .mockImplementation(async () => found(pending)),
    });
    vi.mocked(bridge.connectPortal!).mockImplementationOnce(() =>
      held({ link: pending, approvalError: rateLimit }),
    );
    vi.mocked(bridge.requestDeviceApproval!).mockImplementationOnce(() =>
      held(undefined, true),
    );
    vi.mocked(bridge.restartDeviceApproval!).mockImplementationOnce(() =>
      held(undefined, true),
    );
    // Only the action under test holds a check. After the next unlock,
    // an automatic document check must receive the bridge's ordinary reply.
    if (action.endsWith("check")) {
      vi.mocked(bridge.checkDocuments!).mockImplementationOnce(() =>
        held({
          added: 0,
          refused: 0,
          receiptsPending: 0,
          issues: [
            {
              linkId: pending.id,
              clinicName: pending.clinicName!,
              code: "portal_rate_limited",
            },
          ],
        }),
      );
    }
    await openClinicView(bridge);
    if (action === "connect") {
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Portal HTTPS address"), {
          target: { value: pending.portalBase },
        });
        fireEvent.change(screen.getByLabelText("Linking code"), {
          target: { value: "01234567-89ABCDEFGH" },
        });
        fireEvent.submit(
          screen
            .getByRole("button", { name: "Connect and request approval" })
            .closest("form")!,
        );
      });
      expect(bridge.connectPortal).toHaveBeenCalledOnce();
    } else if (action === "request" || action === "restart") {
      await click(
        screen.getByRole("button", {
          name:
            action === "request"
              ? "Retry saved approval request"
              : "Start a new approval request",
        }),
      );
      expect(
        action === "request"
          ? bridge.requestDeviceApproval
          : bridge.restartDeviceApproval,
      ).toHaveBeenCalledOnce();
    } else {
      // Keep both originating-view cases; Shared now owns the one manual control.
      if (action === "header check")
        await click(screen.getAllByRole("button", { name: /^My records/ })[0]);
      await click(
        screen.getAllByRole("button", { name: /^Shared with me/ })[0],
      );
      const check = screen.getByRole("button", {
        name: "Check for new documents",
      });
      await click(check);
      expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    }
    expect(bridge.refreshDeviceApproval).not.toHaveBeenCalled();
    return {
      bridge,
      finish: () => act(async () => complete()),
      waitMs: action.endsWith("check") ? 60_000 : rateLimit.retryAfterMs,
    };
  }

  it.each(ownWaitActions)(
    "keeps a late old %s wait out of the newly unlocked session",
    async (action) => {
      const { bridge, finish } = await holdOwnWait(action);
      await click(screen.getAllByRole("button", { name: /Lock now/ })[0]);
      await pass(100);
      expect(
        screen.getByRole("heading", { name: "Unlock your vault" }),
      ).toBeVisible();
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Passphrase", { exact: true }), {
          target: { value: "FAKE detached wait passphrase" },
        });
      });
      await click(screen.getByRole("button", { name: "Unlock" }));
      await pass(100);
      await click(screen.getByRole("button", { name: "Security" }));
      // Deliver the old result/error only AFTER the new clinic view mounts.
      await finish();
      await pass(0);
      await pass(9_999);
      expect(bridge.refreshDeviceApproval).not.toHaveBeenCalled();
      await pass(1);
      expect(bridge.refreshDeviceApproval).toHaveBeenCalledExactlyOnceWith(
        pending.id,
      );
    },
  );

  it.each(
    ownWaitActions.flatMap((action) =>
      [false, true].map((failedLock) => ({ action, failedLock })),
    ),
  )(
    "keeps the current $action wait for its session (failed lock: $failedLock)",
    async ({ action, failedLock }) => {
      const { bridge, finish, waitMs } = await holdOwnWait(action);
      await finish();
      await pass(0);
      if (failedLock) {
        vi.mocked(bridge.lock).mockRejectedValueOnce({
          code: "storage",
          message: "FAKE lock did not end this session.",
        });
        await click(screen.getAllByRole("button", { name: /Lock now/ })[0]);
        expect(bridge.lock).toHaveBeenCalledOnce();
        // The native session stays open, with its content concealed, until
        // a successful retry ends it and installs a new wait owner.
        expect(screen.getByRole("alert")).toHaveHumanTextContent(
          "the vault is still open",
        );
        expect(
          screen.queryByRole("button", { name: "Security" }),
        ).not.toBeInTheDocument();
        await click(screen.getByRole("button", { name: "Try locking again" }));
        await act(async () => {
          fireEvent.change(
            screen.getByLabelText("Passphrase", { exact: true }),
            {
              target: { value: "FAKE retried lock passphrase" },
            },
          );
        });
        await click(screen.getByRole("button", { name: "Unlock" }));
        await pass(100);
        await click(screen.getByRole("button", { name: "Security" }));
        await pass(10_000);
        expect(bridge.refreshDeviceApproval).toHaveBeenCalledExactlyOnceWith(
          pending.id,
        );
        return;
      }
      await click(screen.getAllByRole("button", { name: /^My records/ })[0]);
      await click(screen.getByRole("button", { name: "Security" }));
      await pass(waitMs - 1);
      expect(bridge.refreshDeviceApproval).not.toHaveBeenCalled();
      await pass(1);
      expect(bridge.refreshDeviceApproval).toHaveBeenCalledExactlyOnceWith(
        pending.id,
      );
    },
  );

  it("does not offer automatic checks when this build cannot check", async () => {
    const bridge = clinicBridge({ refreshDeviceApproval: undefined });
    await openClinicView(bridge);
    await pass(60_000);
    expect(
      screen.getByText(
        "Approval request saved. Check for updates or send it again.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "While this page is open, myCarlos checks for your clinic's answer automatically.",
      ),
    ).not.toBeInTheDocument();
  });

  it("says nothing for a busy refusal, and keeps a check from before a lock out of the next session", async () => {
    let finishOld!: (value: PortalApprovalCheck) => void;
    const bridge = clinicBridge({
      refreshDeviceApproval: vi
        .fn()
        .mockRejectedValueOnce({
          code: "portal_busy",
          message:
            "Another clinic operation is running. Wait for it to finish, then try again.",
        })
        .mockReturnValueOnce(
          new Promise<PortalApprovalCheck>((resolve) => {
            finishOld = resolve;
          }),
        )
        .mockImplementation(async () => found(pending)),
    });
    await openClinicView(bridge);
    await pass(10_000);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledOnce();
    expect(screen.queryByText(BUSY)).not.toBeInTheDocument();
    await pass(20_000);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledTimes(2);
    await click(screen.getAllByRole("button", { name: /Lock now/ })[0]);
    await pass(100);
    expect(
      screen.getByRole("heading", { name: "Unlock your vault" }),
    ).toBeVisible();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Passphrase", { exact: true }), {
        target: { value: "FAKE approval lock passphrase" },
      });
    });
    await click(screen.getByRole("button", { name: "Unlock" }));
    await pass(100);
    await click(screen.getByRole("button", { name: "Security" }));
    // The earlier session's check answers "approved" now: not shown.
    await act(async () =>
      finishOld(
        found({ ...pending, approvalStatus: "accepted", clinicApproved: true }),
      ),
    );
    await pass(0);
    expect(
      screen.queryByText("The clinic approved this device."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Approval request saved. Check for updates or send it again.",
      ),
    ).toBeVisible();
    // This session's own checks begin as for any newly opened view.
    await pass(10_000);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledTimes(3);
  });
});

describe("checks for new clinic documents after unlocking (#128)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    forgetRecoveryOffer();
    recordRecoveryOffer(Date.now());
  });
  const approved: PortalLinkSummary = {
    id: "fake-approved-link",
    portalBase: "https://portal.example.test/patient",
    deviceName: "myCarlos FAKE device",
    profileId: null,
    clinicName: "FAKE First Clinic",
    fingerprints: [],
    incomplete: false,
    deviceKeyId: "FAKE_FIRST_DEVICE",
    deviceFingerprint: "11".repeat(32),
    approvalRequested: true,
    clinicApproved: true,
    approvalStatus: "accepted",
  };
  // Still waiting for the clinic to approve it.
  const waiting: PortalLinkSummary = {
    ...approved,
    id: "fake-waiting-link",
    clinicName: "FAKE Second Clinic",
    deviceKeyId: "FAKE_SECOND_DEVICE",
    deviceFingerprint: "22".repeat(32),
    clinicApproved: false,
    approvalStatus: "pending",
  };
  const vaultWith = (...links: PortalLinkSummary[]): VaultSnapshot => ({
    ...snapshotWithRecord,
    profiles: [
      { id: "profile-1", displayName: "FAKE First Patient", createdAtMs: 1 },
    ],
    recoveryKeySetAtMs: 5,
    portalLinkingEnabled: true,
    portalLinks: links,
  });
  const delivered = {
    id: "record-from-clinic",
    profileId: "profile-1",
    folderIds: [],
    displayName: "FAKE_Clinic_Letter.pdf",
    sourceLabel: "Clinic delivery",
    mediaType: "application/pdf",
    plaintextSize: 4096,
    importedAtMs: 2,
    available: true,
    originalPdfAvailable: true,
    verifiedClinicName: "FAKE First Clinic",
  };
  type Check = Awaited<ReturnType<NonNullable<VaultBridge["checkDocuments"]>>>;
  const found = (extra: Partial<Check> = {}): Check => ({
    added: 0,
    refused: 0,
    receiptsPending: 0,
    issues: [],
    ...extra,
  });
  const issue = (link: PortalLinkSummary, code: string) => ({
    linkId: link.id,
    clinicName: link.clinicName!,
    code,
  });
  const UNLOCKED = "Vault unlocked.";
  const CHECKED = "Checked for new clinic documents after unlocking.";
  const NOT_FINISHED =
    "myCarlos could not finish checking for new clinic documents after unlocking.";
  const RETRY = "To check again, choose Check for new documents.";
  const WORKING = "Clinic operation in progress…";
  const OFFLINE =
    "The portal request could not be completed. Check your connection and device clock, then try again.";
  const BUSY_TEXT = /Another clinic operation is running/;

  function fakeClock() {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
        "performance",
      ],
    });
    onTestFinished(() => {
      vi.useRealTimers();
    });
  }
  const pass = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const click = (element: HTMLElement) =>
    act(async () => {
      fireEvent.click(element);
    });
  function later<T>() {
    let settle!: (value: T) => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    return { promise, settle, fail };
  }
  /** A locked vault with clinic links. `state.current` is the vault as the
   * native side has it, which a check may add a delivery to. */
  function clinicBridge(
    start: VaultSnapshot,
    overrides: Partial<VaultBridge> = {},
  ) {
    const state = { current: start };
    const bridge = nativeBridge({
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(state.current)),
      unlock: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(state.current)),
      connectPortal: vi.fn(),
      checkDocuments: vi.fn().mockResolvedValue(found()),
      requestDeviceApproval: vi.fn(),
      restartDeviceApproval: vi.fn(),
      ...overrides,
    });
    // The clinic's new document is filed by the check.
    const deliver = (result: Check) => async () => {
      state.current = {
        ...state.current,
        records: [...state.current.records, delivered],
      };
      return result;
    };
    return { bridge, state, deliver };
  }
  async function start(bridge: VaultBridge) {
    fakeClock();
    await act(async () => {
      render(<VaultApp bridge={bridge} />);
    });
    await pass(100);
  }
  async function unlock() {
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Passphrase", { exact: true }), {
        target: { value: "FAKE unlock passphrase" },
      });
    });
    await click(screen.getByRole("button", { name: "Unlock" }));
  }
  const openShared = () =>
    click(screen.getAllByRole("button", { name: /^Shared with me/ })[0]);
  const openRecords = () =>
    click(screen.getAllByRole("button", { name: /^My records/ })[0]);
  const lockNow = async () => {
    await click(screen.getAllByRole("button", { name: /Lock now/ })[0]);
    await pass(100);
    expect(
      screen.getByRole("heading", { name: "Unlock your vault" }),
    ).toBeVisible();
  };
  /** The library's polite status line, as it reads. */
  // Fluent isolates placeables; compare what a person reads.
  const said = () => humanValue(screen.getByRole("status").textContent);

  it("checks once after the unlock's own message, and says what arrived without moving focus or opening it", async () => {
    const { bridge, deliver } = clinicBridge(vaultWith(approved));
    vi.mocked(bridge.checkDocuments!).mockImplementation(
      deliver(found({ added: 1 })),
    );
    await start(bridge);
    await unlock();
    // Saved records are on screen at once; the check follows the unlock's
    // own message, in the background.
    expect(screen.getByRole("heading", { name: "My records" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "FAKE_Results.pdf" }),
    ).toBeVisible();
    expect(bridge.checkDocuments).not.toHaveBeenCalled();
    const search = screen.getByPlaceholderText(
      humanText("Search everything in My records"),
    );
    search.focus();
    await pass(ANNOUNCE_DELAY_MS);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    await pass(0);
    expect(said()).toBe(
      `${UNLOCKED} ${CHECKED} New documents saved: 1. Documents that could not be verified: 0.`,
    );
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("FAKE_Clinic_Letter.pdf")).toBeVisible();
    // Not opened, and focus stays where the patient left it.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(search).toHaveFocus();
    await openShared();
    expect(
      screen.getByRole("button", { name: "Check for new documents" }),
    ).toBeEnabled();
    // One check per unlock: none follows by itself, and nothing was sent
    // that asks for approval or links again.
    await pass(60_000);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    expect(bridge.requestDeviceApproval).not.toHaveBeenCalled();
    expect(bridge.restartDeviceApproval).not.toHaveBeenCalled();
    expect(bridge.connectPortal).not.toHaveBeenCalled();
  });

  it("says nothing more when nothing new arrived", async () => {
    const { bridge } = clinicBridge(vaultWith(approved));
    await start(bridge);
    await unlock();
    await pass(ANNOUNCE_DELAY_MS);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    await pass(60_000);
    expect(said()).toBe(UNLOCKED);
    await openShared();
    expect(
      screen.getByRole("button", { name: "Check for new documents" }),
    ).toBeEnabled();
  });

  // The check's one read of the vault at its end touches the native idle
  // deadline, as every vault command does (a backstop that fires after the
  // app's own). The app's own idle lock counts only the patient's input.
  it("does not count as use: left alone after unlocking, the vault locks on time", async () => {
    const { bridge } = clinicBridge(vaultWith(approved));
    await start(bridge);
    await unlock();
    const touches = vi.mocked(bridge.touch).mock.calls.length;
    await pass(ANNOUNCE_DELAY_MS);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    await pass(5 * 60_000 + 1_000);
    expect(bridge.touch).toHaveBeenCalledTimes(touches);
    expect(bridge.lock).toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Unlock your vault" }),
    ).toBeVisible();
  });

  it("keeps saved records usable while the portal is slow, then says the check could not finish and how to try again", async () => {
    const slow = later<Check>();
    const { bridge } = clinicBridge(vaultWith(approved), {
      checkDocuments: vi
        .fn()
        .mockReturnValueOnce(slow.promise)
        .mockResolvedValue(found()),
    });
    await start(bridge);
    await unlock();
    await pass(ANNOUNCE_DELAY_MS);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    // Shown as running on the clinic control, as the patient's own check
    // is; pressing it starts nothing beside the check under way.
    await openShared();
    const control = screen.getByRole("button", { name: WORKING });
    expect(control).toBeDisabled();
    await click(control);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    await openRecords();
    // A saved document opens while the portal has not answered.
    await click(screen.getByRole("button", { name: "FAKE_Results.pdf" }));
    expect(
      screen.getByRole("dialog", { name: "FAKE_Results.pdf" }),
    ).toBeVisible();
    await click(screen.getByRole("button", { name: "Close document details" }));
    await act(async () =>
      slow.settle(
        found({ issues: [issue(approved, "portal_link_incomplete")] }),
      ),
    );
    await pass(0);
    // (Opening the document cleared the unlock's message, as it does.)
    expect(said()).toBe(
      `${NOT_FINISHED} FAKE First Clinic: ${OFFLINE} ${RETRY}`,
    );
    // The retry is the patient's own check, which says what it found, even
    // when that is nothing.
    await openShared();
    await click(
      screen.getByRole("button", { name: "Check for new documents" }),
    );
    await pass(0);
    expect(bridge.checkDocuments).toHaveBeenCalledTimes(2);
    expect(said()).toBe(
      "New documents saved: 0. Documents that could not be verified: 0.",
    );
  });

  // Demo fix (29 Oct, Ben): a vault with devices a reset portal deleted. The
  // library is usable before the check ends; the native check says those
  // devices are removed, and asks no more about them in this run of the app.
  it("keeps the library usable during a check with three gone devices, then says they were removed", async () => {
    const gone = [1, 2, 3].map(
      (n): PortalLinkSummary => ({
        ...approved,
        id: `fake-gone-link-${n}`,
        deviceKeyId: `FAKE_GONE_DEVICE_${n}`,
      }),
    );
    const slow = later<Check>();
    const { bridge } = clinicBridge(vaultWith(...gone, approved), {
      checkDocuments: vi.fn().mockReturnValueOnce(slow.promise),
    });
    await start(bridge);
    await unlock();
    await pass(ANNOUNCE_DELAY_MS);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    // The check control is in Shared with me (main's c9fea1ed).
    await openShared();
    expect(screen.getByRole("button", { name: WORKING })).toBeDisabled();
    await openRecords();
    // A saved document opens while the check runs.
    await click(screen.getByRole("button", { name: "FAKE_Results.pdf" }));
    expect(
      screen.getByRole("dialog", { name: "FAKE_Results.pdf" }),
    ).toBeVisible();
    await click(screen.getByRole("button", { name: "Close document details" }));
    await act(async () =>
      slow.settle(
        found({
          issues: gone.map((link) => issue(link, "portal_device_removed")),
        }),
      ),
    );
    await pass(0);
    // Said as removed (the native check asks no more about them in this run
    // of the app), and the check is over: it can be run again.
    // One line for each of the three gone devices.
    expect(
      said().split("This device was removed from your clinic portal account."),
    ).toHaveLength(4);
    await openShared();
    expect(
      screen.getByRole("button", { name: "Check for new documents" }),
    ).toBeEnabled();
  });

  it.each([
    [
      "a fault on this device",
      { code: "storage", message: "FAKE storage fault." },
      `${NOT_FINISHED} FAKE storage fault. ${RETRY}`,
    ],
    // Nothing can be tried again in read-only recovery.
    [
      "read-only recovery during the check",
      { code: "recovery_mode", message: "FAKE native recovery text." },
      `${NOT_FINISHED} FAKE native recovery text.`,
    ],
  ])(
    "says a check that failed with %s apart from one that found nothing",
    async (_, error, expected) => {
      const { bridge } = clinicBridge(vaultWith(approved), {
        checkDocuments: vi.fn().mockRejectedValue(error),
      });
      await start(bridge);
      await unlock();
      await pass(ANNOUNCE_DELAY_MS);
      await pass(0);
      expect(bridge.checkDocuments).toHaveBeenCalledOnce();
      expect(said()).toBe(`${UNLOCKED} ${expected}`);
    },
  );

  // The portal offers it again at every unlock: no receipt is sent for it.
  it("says plainly that a document could not be verified and to contact the clinic, without a retry that cannot help", async () => {
    const { bridge } = clinicBridge(vaultWith(approved), {
      checkDocuments: vi.fn().mockResolvedValue(found({ refused: 1 })),
    });
    await start(bridge);
    await unlock();
    await pass(ANNOUNCE_DELAY_MS);
    await pass(0);
    expect(said()).toBe(
      `${UNLOCKED} ${CHECKED} 1 clinic document could not be verified, so it was not added. Contact your clinic.`,
    );
    expect(screen.queryByText("FAKE_Clinic_Letter.pdf")).toBeNull();
  });

  // The native document check sends this code for a 403 device_removed,
  // from the document list, a receipt or a status read (see the
  // delivery tests).
  it("names a device the portal removed, without a retry that cannot help", async () => {
    const { bridge } = clinicBridge(vaultWith(approved), {
      checkDocuments: vi
        .fn()
        .mockResolvedValue(
          found({ issues: [issue(approved, "portal_device_removed")] }),
        ),
    });
    await start(bridge);
    await unlock();
    await pass(ANNOUNCE_DELAY_MS);
    await pass(0);
    expect(said()).toBe(
      `${UNLOCKED} ${NOT_FINISHED} FAKE First Clinic: This device was removed from your clinic portal account. To use it again, connect it again with a new linking code from your patient portal.`,
    );
  });

  it("names a device the portal removed even while its approval was still waiting", async () => {
    const { bridge } = clinicBridge(vaultWith(waiting), {
      checkDocuments: vi
        .fn()
        .mockResolvedValue(
          found({ issues: [issue(waiting, "portal_device_removed")] }),
        ),
    });
    await start(bridge);
    await unlock();
    await pass(ANNOUNCE_DELAY_MS);
    await pass(0);
    expect(said()).toBe(
      `${UNLOCKED} ${NOT_FINISHED} FAKE Second Clinic: This device was removed from your clinic portal account. To use it again, connect it again with a new linking code from your patient portal.`,
    );
  });

  it.each([
    ["under way", true],
    ["finished", false],
  ] as [string, boolean][])(
    "checks after other clinic work %s since the unlock, once",
    async (_, slow) => {
      const request = later<void>();
      const { bridge } = clinicBridge(vaultWith(waiting), {
        requestDeviceApproval: slow
          ? vi.fn().mockReturnValue(request.promise)
          : vi.fn().mockResolvedValue(undefined),
      });
      await start(bridge);
      await unlock();
      // The patient's own approval request, before the check would start.
      await click(screen.getByRole("button", { name: "Security" }));
      await click(
        screen.getByRole("button", { name: "Retry saved approval request" }),
      );
      expect(bridge.requestDeviceApproval).toHaveBeenCalledOnce();
      await pass(ANNOUNCE_DELAY_MS);
      if (slow) {
        // Not beside it, and not refused: it follows.
        expect(bridge.checkDocuments).not.toHaveBeenCalled();
        await act(async () => request.settle());
        await pass(0);
      }
      expect(bridge.checkDocuments).toHaveBeenCalledOnce();
      await pass(30_000);
      expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    },
  );

  it("says the check did not run when a portal asked to wait since the unlock, without a retry", async () => {
    const { bridge } = clinicBridge(vaultWith(waiting), {
      requestDeviceApproval: vi.fn().mockRejectedValue({
        code: "portal_rate_limited",
        message: "FAKE native text.",
        retryAfterMs: 120_000,
      }),
    });
    await start(bridge);
    await unlock();
    await click(screen.getByRole("button", { name: "Security" }));
    await click(
      screen.getByRole("button", { name: "Retry saved approval request" }),
    );
    await pass(ANNOUNCE_DELAY_MS);
    await pass(0);
    expect(bridge.checkDocuments).not.toHaveBeenCalled();
    const line = screen.getByText(
      /myCarlos did not check for new clinic documents after unlocking, because the clinic portal asked it to wait\.$/,
    );
    expect(line).toHaveAttribute("role", "status");
    expect(line.textContent).not.toContain(RETRY);
    await pass(60_000);
    expect(bridge.checkDocuments).not.toHaveBeenCalled();
  });

  it("is not held back by a wait on the portal of a request that ended (D132c)", async () => {
    // Another clinic's request ended; restarting it was asked to wait. The
    // check asks only the clinic that approved this device, on its own
    // portal.
    const ended: PortalLinkSummary = {
      ...waiting,
      id: "fake-ended-link",
      portalBase: "https://second-portal.example.test/patient",
      approvalStatus: "expired",
      approvalCanRestart: true,
    };
    const { bridge } = clinicBridge(vaultWith(approved, ended), {
      restartDeviceApproval: vi.fn().mockRejectedValue({
        code: "portal_rate_limited",
        message: "FAKE native text.",
        retryAfterMs: 120_000,
      }),
    });
    await start(bridge);
    await unlock();
    await click(screen.getByRole("button", { name: "Security" }));
    await click(
      screen.getByRole("button", { name: "Start a new approval request" }),
    );
    await pass(ANNOUNCE_DELAY_MS);
    await pass(0);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    expect(
      screen.queryByText(
        /did not check for new clinic documents after unlocking/,
      ),
    ).not.toBeInTheDocument();
  });

  it("says confirmations still owed, and how to finish them, once", async () => {
    const { bridge } = clinicBridge(vaultWith(approved), {
      checkDocuments: vi.fn().mockResolvedValue(
        found({
          receiptsPending: 1,
          issues: [issue(approved, "portal_link_incomplete")],
        }),
      ),
    });
    await start(bridge);
    await unlock();
    await pass(ANNOUNCE_DELAY_MS);
    await pass(0);
    expect(said()).toBe(
      `${UNLOCKED} ${NOT_FINISHED} FAKE First Clinic: ${OFFLINE} Saved documents awaiting pickup confirmation: 1. Check again to finish confirmation. Your saved copies stay in the vault.`,
    );
  });

  it.each([
    [
      "in read-only recovery",
      { ...vaultWith(approved), recovery: "writeFailed" },
      {},
    ],
    [
      "with clinic documents off in this build",
      { ...vaultWith(approved), portalLinkingEnabled: false },
      {},
    ],
    [
      "for an incomplete link",
      vaultWith({
        ...approved,
        incomplete: true,
        clinicApproved: false,
        approvalStatus: null,
      }),
      {},
    ],
    [
      "for a request the clinic refused",
      vaultWith({ ...waiting, approvalStatus: "refused" }),
      {},
    ],
    [
      "for a request that expired",
      vaultWith({ ...waiting, approvalStatus: "expired" }),
      {},
    ],
    [
      "for a request that was cancelled",
      vaultWith({ ...waiting, approvalStatus: "cancelled" }),
      {},
    ],
    [
      "for a device whose approval was never requested",
      vaultWith({
        ...waiting,
        approvalRequested: false,
        approvalStatus: null,
      }),
      {},
    ],
    [
      "without a document check in this build",
      vaultWith(approved),
      { checkDocuments: undefined },
    ],
    [
      "without clinic linking in this build",
      vaultWith(approved),
      { connectPortal: undefined },
    ],
  ] as [string, VaultSnapshot, Partial<VaultBridge>][])(
    "does not check %s",
    async (_, vault, overrides) => {
      const { bridge } = clinicBridge(vault, overrides);
      await start(bridge);
      await unlock();
      await pass(5_000);
      expect(screen.getByRole("heading", { name: "My records" })).toBeVisible();
      if (bridge.checkDocuments)
        expect(bridge.checkDocuments).not.toHaveBeenCalled();
      expect(screen.queryByText(WORKING)).not.toBeInTheDocument();
    },
  );

  it("does not check when myCarlos starts with the vault already open", async () => {
    const { bridge } = clinicBridge(vaultWith(approved), {
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    await start(bridge);
    await pass(5_000);
    expect(screen.getByRole("heading", { name: "My records" })).toBeVisible();
    expect(bridge.checkDocuments).not.toHaveBeenCalled();
  });

  it("runs no second check after the patient's own check since the unlock", async () => {
    const { bridge } = clinicBridge(vaultWith(approved));
    await start(bridge);
    await unlock();
    await openShared();
    await click(
      screen.getByRole("button", { name: "Check for new documents" }),
    );
    await pass(0);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    await pass(5_000);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    expect(said()).toBe(
      "New documents saved: 0. Documents that could not be verified: 0.",
    );
  });

  const BUSY = {
    code: "portal_busy",
    message:
      "Another clinic operation is running. Wait for it to finish, then try again.",
  };

  it("asks once more when other clinic work held the native side, and says nothing of it", async () => {
    const { bridge } = clinicBridge(vaultWith(approved), {
      checkDocuments: vi
        .fn()
        .mockRejectedValueOnce(BUSY)
        .mockResolvedValue(found()),
    });
    await start(bridge);
    await unlock();
    await pass(ANNOUNCE_DELAY_MS);
    await pass(0);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    // Still shown as running while it waits to ask again.
    await openShared();
    expect(screen.getByRole("button", { name: WORKING })).toBeDisabled();
    await pass(1_900);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    await pass(100);
    expect(bridge.checkDocuments).toHaveBeenCalledTimes(2);
    await pass(0);
    expect(said()).toBe(UNLOCKED);
    expect(screen.queryByText(BUSY_TEXT)).toBeNull();
  });

  it("says the check did not run, and how to check, when the native side stays busy", async () => {
    const { bridge } = clinicBridge(vaultWith(approved), {
      checkDocuments: vi.fn().mockRejectedValue(BUSY),
    });
    await start(bridge);
    await unlock();
    await pass(ANNOUNCE_DELAY_MS);
    await pass(2_000);
    await pass(0);
    expect(bridge.checkDocuments).toHaveBeenCalledTimes(2);
    expect(said()).toBe(
      `${UNLOCKED} myCarlos did not check for new clinic documents after unlocking, because another clinic operation was running. ${RETRY}`,
    );
    await openShared();
    expect(
      screen.getByRole("button", { name: "Check for new documents" }),
    ).toBeEnabled();
  });

  it("locks when the vault locked natively during the check, as for any clinic work", async () => {
    const { bridge } = clinicBridge(vaultWith(approved), {
      checkDocuments: vi
        .fn()
        .mockRejectedValue({ code: "locked", message: "FAKE locked." }),
    });
    await start(bridge);
    await unlock();
    await pass(ANNOUNCE_DELAY_MS);
    await pass(100);
    expect(bridge.lock).toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Unlock your vault" }),
    ).toBeVisible();
    expect(screen.queryByText(/clinic documents/)).toBeNull();
  });

  it("keeps what a check a lock ended found out of the unlock screen and the next session, which checks again", async () => {
    const first = later<Check>();
    const { bridge, state } = clinicBridge(vaultWith(approved), {
      checkDocuments: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue(found()),
    });
    await start(bridge);
    await unlock();
    await pass(ANNOUNCE_DELAY_MS);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    await lockNow();
    // It answers after the lock: nothing of it reaches the unlock screen.
    state.current = {
      ...state.current,
      records: [...state.current.records, delivered],
    };
    await act(async () => first.settle(found({ added: 1 })));
    await pass(0);
    expect(screen.getByText(LOCKED_MESSAGE)).toBeVisible();
    expect(
      screen.queryByText(/FAKE_Clinic_Letter|clinic documents/),
    ).toBeNull();
    await unlock();
    await pass(ANNOUNCE_DELAY_MS);
    await pass(0);
    // This unlock checks for itself. The document the ended check filed is
    // in the vault, and was not filed again: nothing new is said.
    expect(bridge.checkDocuments).toHaveBeenCalledTimes(2);
    expect(said()).toBe(UNLOCKED);
    expect(screen.getByText("FAKE_Clinic_Letter.pdf")).toBeVisible();
  });

  it("waits for an ended session's check to return before the next unlock checks", async () => {
    const first = later<Check>();
    const { bridge, deliver } = clinicBridge(vaultWith(approved), {
      checkDocuments: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue(found()),
    });
    await start(bridge);
    await unlock();
    await pass(ANNOUNCE_DELAY_MS);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    await lockNow();
    await unlock();
    await pass(ANNOUNCE_DELAY_MS);
    // The native side still has the ended check: this one waits, shown as
    // running, rather than being refused as busy.
    await pass(5_000);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    await openShared();
    expect(screen.getByRole("button", { name: WORKING })).toBeDisabled();
    await act(async () => first.settle(await deliver(found({ added: 1 }))()));
    await pass(0);
    expect(bridge.checkDocuments).toHaveBeenCalledTimes(2);
    // What the ended check found is not this session's to say.
    expect(said()).toBe(UNLOCKED);
    expect(screen.queryByText(BUSY_TEXT)).toBeNull();
  });

  it("runs one check per unlock, never two at once, over quick locks and unlocks", async () => {
    let running = 0;
    let most = 0;
    const { bridge } = clinicBridge(vaultWith(approved), {
      checkDocuments: vi.fn().mockImplementation(async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        running -= 1;
        return found();
      }),
    });
    await start(bridge);
    await unlock();
    await pass(ANNOUNCE_DELAY_MS);
    expect(bridge.checkDocuments).toHaveBeenCalledTimes(1);
    for (const round of [2, 3]) {
      // Locked and unlocked again before the portal answers.
      await lockNow();
      await unlock();
      await pass(ANNOUNCE_DELAY_MS);
      expect(bridge.checkDocuments).toHaveBeenCalledTimes(round - 1);
      await pass(2_000);
      expect(bridge.checkDocuments).toHaveBeenCalledTimes(round);
    }
    await pass(5_000);
    expect(bridge.checkDocuments).toHaveBeenCalledTimes(3);
    expect(most).toBe(1);
    expect(said()).toBe(UNLOCKED);
  });

  it("checks once the recovery key offer the unlock opened on has closed and its message is on the line, which a fast result follows", async () => {
    forgetRecoveryOffer();
    const { bridge, deliver } = clinicBridge({
      ...vaultWith(approved),
      recoveryKeySetAtMs: null,
    });
    vi.mocked(bridge.checkDocuments!).mockImplementation(
      deliver(found({ added: 1 })),
    );
    await start(bridge);
    await unlock();
    const dialog = screen.getByRole("dialog", {
      name: "Set up a recovery key",
    });
    await pass(5_000);
    expect(bridge.checkDocuments).not.toHaveBeenCalled();
    await click(within(dialog).getByRole("button", { name: "Set up later" }));
    expect(bridge.checkDocuments).not.toHaveBeenCalled();
    // The dialog's own message is written: the check starts then, not on a
    // guess of when that would be.
    await pass(ANNOUNCE_DELAY_MS);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    await pass(0);
    expect(said()).toBe(
      `${UNLOCKED} ${CHECKED} New documents saved: 1. Documents that could not be verified: 0.`,
    );
  });

  it("keeps what an offered key setup left unfinished says first, before a fast result", async () => {
    forgetRecoveryOffer();
    const { bridge, deliver } = clinicBridge(
      { ...vaultWith(approved), recoveryKeySetAtMs: null },
      {
        beginRecoveryKey: vi
          .fn()
          .mockResolvedValue("ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345"),
      },
    );
    vi.mocked(bridge.checkDocuments!).mockImplementation(
      deliver(found({ added: 1 })),
    );
    await start(bridge);
    await unlock();
    const offer = screen.getByRole("dialog", {
      name: "Set up a recovery key",
    });
    await act(async () => {
      fireEvent.change(within(offer).getByLabelText("Passphrase"), {
        target: { value: "FAKE unlock passphrase" },
      });
    });
    await click(within(offer).getByRole("button", { name: "Continue" }));
    const shown = screen.getByRole("dialog", { name: "Your recovery key" });
    await click(within(shown).getByRole("button", { name: "Set up later" }));
    expect(bridge.checkDocuments).not.toHaveBeenCalled();
    await pass(ANNOUNCE_DELAY_MS);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    await pass(0);
    expect(said()).toBe(
      `Recovery key setup was not finished. The key you were shown does not open the vault. Destroy any kit saved or printed just now. ${CHECKED} New documents saved: 1. Documents that could not be verified: 0.`,
    );
  });

  it.each([
    ["writable", true, vaultWith(approved), 1],
    [
      "read-only",
      false,
      { ...vaultWith(approved), recovery: "writeFailed" },
      0,
    ],
  ] as [string, boolean, VaultSnapshot, number][])(
    "after opening with the recovery key, checks only a %s vault",
    async (_, passphraseReplaced, vault, checks) => {
      const { bridge } = clinicBridge(vault, {
        recover: vi
          .fn()
          .mockResolvedValue({ passphraseReplaced, snapshot: vault }),
      });
      await start(bridge);
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Recovery key"), {
          target: { value: "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345" },
        });
        fireEvent.change(screen.getByLabelText("New passphrase"), {
          target: { value: "FAKE lantern orbit willow cascade" },
        });
        fireEvent.change(screen.getByLabelText("Confirm new passphrase"), {
          target: { value: "FAKE lantern orbit willow cascade" },
        });
      });
      await click(
        screen.getByRole("button", { name: "Open with recovery key" }),
      );
      expect(bridge.recover).toHaveBeenCalledOnce();
      await pass(ANNOUNCE_DELAY_MS);
      await pass(5_000);
      expect(bridge.checkDocuments).toHaveBeenCalledTimes(checks);
    },
  );

  it("keeps a wait a portal asks of the check for the clinic view, and does not say to check again", async () => {
    const sameClinic = { ...waiting, portalBase: approved.portalBase };
    const { bridge } = clinicBridge(vaultWith(approved, sameClinic), {
      checkDocuments: vi
        .fn()
        .mockResolvedValue(
          found({ issues: [issue(approved, "portal_rate_limited")] }),
        ),
      refreshDeviceApproval: vi.fn().mockResolvedValue({
        link: sameClinic,
        expiresInMs: null,
        issue: null,
      }),
    });
    await start(bridge);
    await unlock();
    await pass(ANNOUNCE_DELAY_MS);
    await pass(0);
    expect(said()).toBe(
      `${UNLOCKED} ${NOT_FINISHED} FAKE First Clinic: The clinic portal asked myCarlos to wait before trying again.`,
    );
    // The clinic view's own status checks keep that portal's wait (60 s, as
    // a document check gives no time), not its usual 10 s.
    await click(screen.getByRole("button", { name: "Security" }));
    await pass(50_000);
    expect(bridge.refreshDeviceApproval).not.toHaveBeenCalled();
    await pass(10_100);
    expect(bridge.refreshDeviceApproval).toHaveBeenCalledOnce();
  });

  it.each([
    ["beside an approved one", [approved, waiting]],
    ["alone", [waiting]],
  ] as [string, PortalLinkSummary[]][])(
    "stays quiet about a device still waiting for approval, %s",
    async (_, links) => {
      const { bridge } = clinicBridge(vaultWith(...links), {
        checkDocuments: vi
          .fn()
          .mockResolvedValue(
            found({ issues: [issue(waiting, "portal_link_incomplete")] }),
          ),
      });
      await start(bridge);
      await unlock();
      await pass(ANNOUNCE_DELAY_MS);
      await pass(0);
      // Checked, for the status the clinic may have given while myCarlos
      // was closed; the card under Connected clinics says the rest.
      expect(bridge.checkDocuments).toHaveBeenCalledOnce();
      expect(said()).toBe(UNLOCKED);
      expect(bridge.requestDeviceApproval).not.toHaveBeenCalled();
      expect(bridge.restartDeviceApproval).not.toHaveBeenCalled();
    },
  );

  it("receives the first documents at the next unlock for a device the clinic approved while myCarlos was closed", async () => {
    const { bridge, state } = clinicBridge(vaultWith(waiting));
    // The native check reads the request's status first: the clinic
    // approved it meanwhile, so its documents come in the same check.
    vi.mocked(bridge.checkDocuments!).mockImplementation(async () => {
      state.current = {
        ...state.current,
        portalLinks: [
          { ...waiting, clinicApproved: true, approvalStatus: "accepted" },
        ],
        records: [...state.current.records, delivered],
      };
      return found({ added: 1 });
    });
    await start(bridge);
    await unlock();
    await pass(ANNOUNCE_DELAY_MS);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    await pass(0);
    expect(said()).toBe(
      `${UNLOCKED} ${CHECKED} New documents saved: 1. Documents that could not be verified: 0.`,
    );
    expect(screen.getByText("FAKE_Clinic_Letter.pdf")).toBeVisible();
    expect(bridge.requestDeviceApproval).not.toHaveBeenCalled();
    await click(screen.getByRole("button", { name: "Security" }));
    expect(screen.getByText("The clinic approved this device.")).toBeVisible();
  });

  it.each([
    [
      "the library's Check for new documents",
      async () => {
        await openShared();
        return screen.getByRole("button", { name: "Check for new documents" });
      },
      { name: "Shared with me", level: 1 },
    ],
    [
      "Link another clinic",
      async () => {
        await click(screen.getByRole("button", { name: "Security" }));
        // A clinic is linked: the form is behind this button (#145).
        return screen.getByRole("button", { name: "Link another clinic" });
      },
      { name: "Connected clinics", level: 2 },
    ],
    [
      "a device's Copy device code",
      async () => {
        await click(screen.getByRole("button", { name: "Security" }));
        // The device code is behind Show device details.
        await click(screen.getByText("Show device details"));
        return screen.getByRole("button", { name: "Copy device code" });
      },
      { name: "FAKE First Clinic", level: 3 },
    ],
  ] as [string, () => Promise<HTMLElement>, { name: string; level: number }][])(
    "moves focus to the nearest heading when the check disables %s, which had it",
    async (_, control, heading) => {
      const slow = later<Check>();
      const { bridge } = clinicBridge(vaultWith(approved), {
        checkDocuments: vi.fn().mockReturnValue(slow.promise),
      });
      await start(bridge);
      await unlock();
      const focused = await control();
      focused.focus();
      expect(focused).toHaveFocus();
      await pass(ANNOUNCE_DELAY_MS);
      expect(bridge.checkDocuments).toHaveBeenCalledOnce();
      expect(focused).toBeDisabled();
      expect(screen.getByRole("heading", heading)).toHaveFocus();
      await act(async () => slow.settle(found()));
      await pass(0);
      // Back in use, it is not given focus again: nothing moves twice.
      expect(focused).toBeEnabled();
      expect(screen.getByRole("heading", heading)).toHaveFocus();
    },
  );

  it("moves no focus for the patient's own check, or when the focused control stays usable", async () => {
    const own = later<Check>();
    const { bridge } = clinicBridge(vaultWith(approved), {
      checkDocuments: vi
        .fn()
        .mockReturnValueOnce(own.promise)
        .mockResolvedValue(found()),
    });
    await start(bridge);
    await unlock();
    // The patient's own press, just after unlocking: the automatic check
    // does not run beside it, and focus is left as that press leaves it.
    await openShared();
    // Finish navigation's focus recovery before starting the patient's check.
    // Animation frames use the browser's clock, not the announcement's fake one.
    await act(
      () =>
        new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        }),
    );
    const check = screen.getByRole("button", {
      name: "Check for new documents",
    });
    fireEvent.pointerDown(check);
    check.focus();
    expect(check).toHaveFocus();
    await click(check);
    await pass(ANNOUNCE_DELAY_MS);
    expect(bridge.checkDocuments).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("heading", { name: "Shared with me", level: 1 }),
    ).not.toHaveFocus();
    await act(async () => own.settle(found()));
    await pass(0);
    // The next unlock's check, with focus on the search box, which it does
    // not disable.
    await lockNow();
    await unlock();
    const search = screen.getByPlaceholderText(
      humanText("Search everything in My records"),
    );
    search.focus();
    await pass(ANNOUNCE_DELAY_MS);
    expect(bridge.checkDocuments).toHaveBeenCalledTimes(2);
    expect(search).toHaveFocus();
  });

  it.each([
    ["the check after unlocking", false],
    ["the patient's own check", true],
  ] as [string, boolean][])(
    "keeps a wait a portal asked of %s before a lock out of the next session",
    async (_, own) => {
      const stale = later<Check>();
      const { bridge } = clinicBridge(vaultWith(approved), {
        checkDocuments: vi
          .fn()
          .mockReturnValueOnce(stale.promise)
          .mockResolvedValue(found()),
      });
      await start(bridge);
      await unlock();
      if (own) {
        await openShared();
        await click(
          screen.getByRole("button", { name: "Check for new documents" }),
        );
      }
      await pass(ANNOUNCE_DELAY_MS);
      expect(bridge.checkDocuments).toHaveBeenCalledOnce();
      await lockNow();
      // The reply comes after the lock, which cleared the session's waits.
      await act(async () =>
        stale.settle(
          found({ issues: [issue(approved, "portal_rate_limited")] }),
        ),
      );
      await pass(0);
      await unlock();
      await pass(ANNOUNCE_DELAY_MS);
      // Not held back by the ended session's wait.
      expect(bridge.checkDocuments).toHaveBeenCalledTimes(2);
    },
  );
});

describe("Automatic arrival snapshot ownership", () => {
  const supported = {
    ...emptySnapshot,
    sharedProfileId: "FAKE_NATIVE_VAULT_OWNER",
    automaticDocumentChecksSupported: true,
  };
  const withArrival = (name: string): VaultSnapshot => ({
    ...supported,
    records: [{ ...snapshotWithRecord.records[0], displayName: name }],
  });

  it("keeps a newer manual snapshot after an older automatic response arrives", async () => {
    const user = userEvent.setup();
    let finishAutomatic!: () => void;
    const snapshot = vi
      .fn()
      .mockImplementationOnce(async () => captureSnapshot(supported))
      .mockImplementationOnce(() => {
        const captured = captureSnapshot(withArrival("FAKE old automatic.pdf"));
        return new Promise<VaultSnapshot>((resolve) => {
          finishAutomatic = () => resolve(captured);
        });
      })
      .mockImplementationOnce(async () =>
        captureSnapshot(withArrival("FAKE newer manual.pdf")),
      );
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot,
      importPickedFiles: vi.fn().mockResolvedValue({
        imported: [],
        skippedDuplicates: ["FAKE existing.pdf"],
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: humanText("My records") });
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    await user.click(await importMenuItem());
    await screen.findByText(humanText("FAKE newer manual.pdf"));
    await act(async () => finishAutomatic());
    expect(screen.getByText(humanText("FAKE newer manual.pdf"))).toBeVisible();
    expect(screen.queryByText(humanText("FAKE old automatic.pdf"))).toBeNull();
    // Opening, the automatic check, the import's own refresh: nothing else.
    expect(snapshot).toHaveBeenCalledTimes(3);
  });

  it("keeps a newer automatic snapshot after an older manual response arrives", async () => {
    const user = userEvent.setup();
    let finishManual!: () => void;
    const snapshot = vi
      .fn()
      .mockImplementationOnce(async () => captureSnapshot(supported))
      .mockImplementationOnce(() => {
        const captured = captureSnapshot(withArrival("FAKE old manual.pdf"));
        return new Promise<VaultSnapshot>((resolve) => {
          finishManual = () => resolve(captured);
        });
      })
      .mockImplementationOnce(async () =>
        captureSnapshot(withArrival("FAKE newer automatic.pdf")),
      );
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot,
      importPickedFiles: vi.fn().mockResolvedValue({
        imported: [],
        skippedDuplicates: ["FAKE existing.pdf"],
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: humanText("My records") });
    await user.click(await importMenuItem());
    await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    await act(async () => window.dispatchEvent(new Event("focus")));
    await screen.findByText(humanText("FAKE newer automatic.pdf"));
    await act(async () => finishManual());
    expect(
      screen.getByText(humanText("FAKE newer automatic.pdf")),
    ).toBeVisible();
    expect(screen.queryByText(humanText("FAKE old manual.pdf"))).toBeNull();
    // Opening, the import's own refresh, the automatic check: nothing else.
    expect(snapshot).toHaveBeenCalledTimes(3);
  });

  it.each(["equal", "foreign epoch"] as const)(
    "rejects an automatic %s capture without blocking a later valid arrival",
    async (kind) => {
      const opening = captureSnapshot(supported);
      const rejected = {
        ...withArrival("FAKE rejected capture.pdf"),
        capture:
          kind === "equal"
            ? opening.capture
            : {
                epoch: "00000000-0000-4000-8000-000000000186",
                sequence: Number.MAX_SAFE_INTEGER,
              },
      };
      const snapshot = vi
        .fn()
        .mockResolvedValueOnce(opening)
        .mockResolvedValueOnce(rejected)
        .mockImplementationOnce(async () =>
          captureSnapshot(withArrival("FAKE valid capture.pdf")),
        );
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        snapshot,
      });
      render(<VaultApp bridge={bridge} />);
      await screen.findByRole("heading", { name: humanText("My records") });
      await act(async () => window.dispatchEvent(new Event("focus")));
      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(
        screen.queryByText(humanText("FAKE rejected capture.pdf")),
      ).toBeNull();
      await act(async () => window.dispatchEvent(new Event("focus")));
      await screen.findByText(humanText("FAKE valid capture.pdf"));
    },
  );

  it("uses native capture order when automatic requests enter native in reverse order", async () => {
    let finishFirst!: () => void;
    const snapshot = vi
      .fn()
      .mockImplementationOnce(async () => captureSnapshot(supported))
      .mockImplementationOnce(
        () =>
          new Promise<VaultSnapshot>((resolve) => {
            finishFirst = () =>
              resolve(
                captureSnapshot(withArrival("FAKE latest native capture.pdf")),
              );
          }),
      )
      .mockImplementationOnce(async () =>
        captureSnapshot(withArrival("FAKE earlier native capture.pdf")),
      );
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot,
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: humanText("My records") });
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    await act(async () => window.dispatchEvent(new Event("focus")));
    await screen.findByText(humanText("FAKE earlier native capture.pdf"));
    await act(async () => finishFirst());
    expect(
      screen.getByText(humanText("FAKE latest native capture.pdf")),
    ).toBeVisible();
    expect(
      screen.queryByText(humanText("FAKE earlier native capture.pdf")),
    ).toBeNull();
  });
  it("refreshes on focus while preserving the current search input", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn(async () => captureSnapshot(supported)),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: humanText("My records") });
    const search = await screen.findByRole("searchbox");
    fireEvent.change(search, { target: { value: "FAKE" } });
    vi.mocked(bridge.snapshot).mockImplementation(async () =>
      captureSnapshot({
        ...supported,
        records: [
          { ...snapshotWithRecord.records[0], displayName: "FAKE arrived.pdf" },
        ],
      }),
    );
    act(() => window.dispatchEvent(new Event("focus")));
    await screen.findByText(humanText("FAKE arrived.pdf"));
    expect(search).toHaveValue("FAKE");
  });
  it("ignores a response from a different native vault owner", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn(async () => captureSnapshot(supported)),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: humanText("My records") });
    const initial = vi.mocked(bridge.snapshot).mock.calls.length;
    vi.mocked(bridge.snapshot).mockImplementation(async () =>
      captureSnapshot({
        ...supported,
        sharedProfileId: "FAKE_OTHER_OWNER",
        profiles: [
          { ...supported.profiles[0], displayName: "FAKE must not merge" },
        ],
      }),
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(bridge.snapshot).toHaveBeenCalledTimes(initial + 1),
    );
    expect(screen.queryByText(humanText("FAKE must not merge"))).toBeNull();
  });
  it("does not request an automatic snapshot refresh without native build support", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn(async () => captureSnapshot(emptySnapshot)),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: humanText("My records") });
    const initial = vi.mocked(bridge.snapshot).mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(bridge.snapshot).toHaveBeenCalledTimes(initial);
  });
  it("refreshes when Security (where Connected clinics lives) opens and keeps that route until the patient leaves", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn(async () => captureSnapshot(supported)),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: humanText("My records") });
    const initial = vi.mocked(bridge.snapshot).mock.calls.length;
    vi.mocked(bridge.snapshot).mockImplementation(async () =>
      captureSnapshot({
        ...supported,
        records: [
          {
            ...snapshotWithRecord.records[0],
            displayName: "FAKE clinic arrival.pdf",
          },
        ],
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Security") }),
    );
    await waitFor(() =>
      expect(bridge.snapshot).toHaveBeenCalledTimes(initial + 1),
    );
    expect(
      screen.getByRole("heading", { name: humanText("Security") }),
    ).toBeVisible();
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: humanText("Record library") }),
      ).getByRole("button", { name: humanText(/^My records/) }),
    );
    await screen.findByText(humanText("FAKE clinic arrival.pdf"));
  });
  it("rejects a deferred response after re-unlocking the same owner and does not refresh while locked", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn(async () => captureSnapshot(supported)),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: humanText("My records") });
    let finish!: (value: VaultSnapshot) => void;
    vi.mocked(bridge.snapshot).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const before = vi.mocked(bridge.snapshot).mock.calls.length;
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() =>
      expect(bridge.snapshot).toHaveBeenCalledTimes(before + 1),
    );
    fireEvent.click(windowLock());
    await screen.findByLabelText(humanText("Passphrase"));
    act(() => window.dispatchEvent(new Event("focus")));
    await Promise.resolve();
    expect(bridge.snapshot).toHaveBeenCalledTimes(before + 1);
    vi.mocked(bridge.unlock).mockImplementation(async () =>
      captureSnapshot({
        ...supported,
        recoveryKeySetAtMs: 5,
      }),
    );
    await act(async () => {
      fireEvent.change(screen.getByLabelText(humanText("Passphrase")), {
        target: { value: "river-azimuth-cobalt-sparrow-934" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: humanText("Unlock") }),
      );
    });
    await screen.findByRole("heading", { name: humanText("My records") });
    await act(async () => {
      finish(
        captureSnapshot({
          ...supported,
          records: [
            {
              ...snapshotWithRecord.records[0],
              displayName: "FAKE stale arrival.pdf",
            },
          ],
        }),
      );
      await Promise.resolve();
    });
    expect(screen.queryByText(humanText("FAKE stale arrival.pdf"))).toBeNull();
    expect(bridge.snapshot).toHaveBeenCalledTimes(before + 1);
  });
});

describe("a document waiting, as the tray check found it while the vault was locked (#230)", () => {
  const SENTENCE = "A new document is waiting. Unlock myCarlos to see it.";

  it("shows one fixed sentence on the unlock screen, as it is found and as it clears", async () => {
    let say: (waiting: boolean) => void = () => {
      throw new Error("the screen did not listen for the tray check");
    };
    const stop = vi.fn();
    const bridge = nativeBridge({
      trayWaiting: vi.fn().mockResolvedValue(false),
      onTrayWaiting: vi.fn((handler: (waiting: boolean) => void) => {
        say = handler;
        return stop;
      }),
    });
    const { unmount } = render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    expect(screen.queryByText(humanText(SENTENCE))).toBeNull();
    // The tray check found a document: the one sentence, and nothing about it.
    await act(async () => say(true));
    const line = await screen.findByText(humanText(SENTENCE));
    expect(line).toBeVisible();
    expect(line).toHaveAttribute("role", "status");
    // It clears when the tray check says so (the vault was unlocked elsewhere, or reset).
    await act(async () => say(false));
    expect(screen.queryByText(humanText(SENTENCE))).toBeNull();
    unmount();
    expect(stop).toHaveBeenCalled();
  });

  it("shows it from the start when the native side already knows", async () => {
    const bridge = nativeBridge({
      trayWaiting: vi.fn().mockResolvedValue(true),
      onTrayWaiting: vi.fn(() => () => undefined),
    });
    render(<VaultApp bridge={bridge} />);
    expect(await screen.findByText(humanText(SENTENCE))).toBeVisible();
  });

  it("does not show it over an unlocked library", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
      trayWaiting: vi.fn().mockResolvedValue(true),
      onTrayWaiting: vi.fn(() => () => undefined),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByText("FAKE_Results.pdf");
    expect(screen.queryByText(humanText(SENTENCE))).toBeNull();
  });
});

describe("the vault locked natively: closed to the tray, Quit or the native idle lock (#206)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mycarlos.autoLockMinutes.v1", "1");
  });

  // An unlocked library with FAKE_Results.pdf, and the way to say what the
  // native side would emit.
  async function openLibrary(overrides: Partial<VaultBridge> = {}) {
    let say: (locked: { by: "closed" | "idle" }) => void = () => {
      throw new Error("the screen did not listen for the native lock");
    };
    const stop = vi.fn();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
      viewPage: vi.fn().mockResolvedValue({
        pageCount: 1,
        width: 800,
        height: 1035,
        image:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        text: "FAKE results text",
      }),
      documentText: vi.fn(async () => fakeDocumentText(["FAKE results text"])),
      onVaultLocked: vi.fn(
        (handler: (locked: { by: "closed" | "idle" }) => void) => {
          say = handler;
          return stop;
        },
      ),
      ...overrides,
    });
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<VaultApp bridge={bridge} />);
    });
    expect(
      screen.getByRole("heading", { name: humanText("My records") }),
    ).toBeVisible();
    return {
      bridge,
      view,
      stop,
      say: (by: "closed" | "idle") => act(async () => say({ by })),
    };
  }

  it("lets go of the library and the open letter at once when the window is closed to the tray, and says why", async () => {
    const { bridge, say } = await openLibrary();
    await act(async () => {
      fireEvent.click(screen.getByText(humanText("FAKE_Results.pdf")));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: humanText("Read") }));
    });
    expect(
      screen.getByRole("dialog", { name: humanText("FAKE_Results.pdf") }),
    ).toBeVisible();

    // No visibilitychange: a hidden window may never get one.
    await say("closed");

    expect(
      await screen.findByRole("heading", {
        name: humanText("Unlock your vault"),
      }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body).not.toHaveTextContent("FAKE_Results.pdf");
    expect(document.body).not.toHaveTextContent("FAKE results text");
    expect(
      screen.getByText(
        humanText(
          "Locked because myCarlos was minimized or sent to the background.",
        ),
      ),
    ).toBeVisible();
    expect(bridge.lock).toHaveBeenCalledOnce();
  });

  it("says the idle reason when the native idle lock fell due", async () => {
    const { say } = await openLibrary();
    await say("idle");
    expect(
      await screen.findByText(humanText("Locked after 1 minute without use.")),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent("FAKE_Results.pdf");
  });

  it("does nothing on a screen that is already locked, and stops listening when it goes", async () => {
    const { bridge, say, stop, view } = await openLibrary();
    await say("closed");
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    // Told again as the window is shown from the tray: no second lock.
    await say("closed");
    expect(bridge.lock).toHaveBeenCalledOnce();
    view.unmount();
    expect(stop).toHaveBeenCalled();
  });

  it("takes the record, its page text and the summary off the screen before its own lock has even answered", async () => {
    const summary: ModelSummary = {
      sentences: [{ text: "FAKE: a short summary.", quote: "FAKE results" }],
      model: FAKE_MODEL,
      lastPage: 0,
      lastPageCut: false,
      keptId: "FAKE-kept-1",
    };
    const { bridge, say } = await openLibrary({
      aiModelStatus: vi
        .fn()
        .mockResolvedValue({ state: "installed", model: FAKE_MODEL }),
      aiSummarize: vi.fn().mockResolvedValue(summary),
      // The screen's own lock never answers: what leaves the screen must not wait for it.
      lock: vi.fn(() => new Promise<void>(() => undefined)),
    });
    await act(async () => {
      fireEvent.click(screen.getByText(humanText("FAKE_Results.pdf")));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: humanText("Read") }));
    });
    const reader = screen.getByRole("dialog", {
      name: humanText("FAKE_Results.pdf"),
    });
    await act(async () => {
      fireEvent.click(
        within(reader).getByRole("button", { name: humanText("Summary") }),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: humanText("Continue") }),
      );
    });
    expect(
      await screen.findByText(humanText("FAKE: a short summary.")),
    ).toBeVisible();

    await say("closed");

    expect(bridge.lock).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body).not.toHaveTextContent("FAKE_Results.pdf");
    expect(document.body).not.toHaveTextContent("FAKE results text");
    expect(document.body).not.toHaveTextContent("FAKE: a short summary.");
  });

  it("locks the moment an unlock completes, when the window was closed to the tray while it was in flight", async () => {
    let say: (locked: { by: "closed" | "idle" }) => void = () => undefined;
    let finish: (snapshot: VaultSnapshot) => void = () => undefined;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("locked"),
      unlock: vi.fn(
        () =>
          new Promise<VaultSnapshot>((resolve) => {
            finish = resolve;
          }),
      ),
      onVaultLocked: vi.fn(
        (handler: (locked: { by: "closed" | "idle" }) => void) => {
          say = handler;
          return () => undefined;
        },
      ),
    });
    await act(async () => {
      render(<VaultApp bridge={bridge} />);
    });
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText(humanText("Passphrase")),
      "FAKE-passphrase-for-this-test",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    await waitFor(() => expect(bridge.unlock).toHaveBeenCalled());
    // The window is closed to the tray while the unlock is still in flight: the native lock finds
    // an unlocked screen that is not unlocked yet, and says so.
    await act(async () => say({ by: "closed" }));
    await act(async () => finish(captureSnapshot(snapshotWithRecord)));
    // The library never stays: the screen locks as the unlock completes.
    expect(
      await screen.findByRole("heading", {
        name: humanText("Unlock your vault"),
      }),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent("FAKE_Results.pdf");
  });

  it("does not hold the screen open for a transfer: the vault is already locked natively", async () => {
    let say: (locked: { by: "closed" | "idle" }) => void = () => undefined;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
      // An import in flight that never ends by itself.
      importPickedFiles: vi.fn(
        () => new Promise<ImportOutcome>(() => undefined),
      ),
      onVaultLocked: vi.fn(
        (handler: (locked: { by: "closed" | "idle" }) => void) => {
          say = handler;
          return () => undefined;
        },
      ),
    });
    await act(async () => {
      render(<VaultApp bridge={bridge} />);
    });
    const user = userEvent.setup();
    await chooseAdd(user, "Import a file");
    await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());

    await act(async () => say({ by: "closed" }));

    // Not the "finishing the transfer" hold: the content goes at once.
    expect(screen.queryByText(humanText(TRANSFER_HOLD))).toBeNull();
    expect(
      await screen.findByRole("heading", {
        name: humanText("Unlock your vault"),
      }),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent("FAKE_Results.pdf");
    expect(bridge.lock).toHaveBeenCalledOnce();
  });
});

// Gap tests (24 Nov): paths of the app's own wiring that had no test.
describe("what the app does when its calls to the native side fail or are not asked", () => {
  const openVault = (overrides: Partial<VaultBridge> = {}) =>
    nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      ...overrides,
    });

  it("says nothing changed when the erase is not carried out, and stays on the unlock screen", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({ reset: vi.fn().mockResolvedValue(false) });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await user.click(screen.getByText(humanText("Forgot your passphrase?")));
    await user.type(
      screen.getByLabelText(humanText("Type RESET MYCARLOS VAULT")),
      "RESET MYCARLOS VAULT",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Set vault aside") }),
    );
    await waitFor(() =>
      expect(bridge.reset).toHaveBeenCalledWith("RESET MYCARLOS VAULT"),
    );
    expect(
      await screen.findByText(
        humanText("Nothing changed: the vault was not set aside."),
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: humanText("Unlock your vault") }),
    ).toBeVisible();
  });

  it("tells the patient what was not received when native code reports shares it dropped or refused", async () => {
    const bridge = openVault({
      listReceived: vi.fn().mockResolvedValue({
        files: [],
        notice: { dropped: 2, refusedShares: 1 },
      }),
    });
    render(<VaultApp bridge={bridge} />);
    expect(
      await screen.findByText(
        humanText(
          /A share was not received: no more than 100 shared files can wait at once\..*2 shared items were not received: myCarlos accepts PDF files only\./,
        ),
      ),
    ).toBeVisible();
  });

  const waitingForAnswer = (overrides: Partial<VaultBridge> = {}) =>
    openVault({
      listReceived: vi.fn().mockResolvedValue({
        files: [
          {
            id: "shared-1",
            name: "FAKE_Opened.pdf",
            sourceLabel: "Manual import — unverified",
            needsConfirm: true,
          },
        ],
        notice: { dropped: 0, refusedShares: 0 },
      }),
      ...overrides,
    });
  const question = () =>
    screen.findByRole("alertdialog", {
      name: humanText("Import FAKE_Opened.pdf into Shared with me?"),
    });

  it("asks the same question again when native code was not asked, and adds the file when it is", async () => {
    const user = userEvent.setup();
    const bridge = waitingForAnswer();
    render(<VaultApp bridge={bridge} />);
    let dialog = await question();
    // The window is hidden when the answer comes: nothing is asked of native code, and the
    // file is not lost.
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    try {
      await user.click(
        within(dialog).getByRole("button", { name: humanText("Import") }),
      );
      expect(bridge.acceptReceived).not.toHaveBeenCalled();
      dialog = await question();
    } finally {
      visibility.mockRestore();
    }
    await user.click(
      within(dialog).getByRole("button", { name: humanText("Import") }),
    );
    await waitFor(() =>
      expect(bridge.acceptReceived).toHaveBeenCalledWith(["shared-1"]),
    );
    expect(bridge.discardReceived).not.toHaveBeenCalled();
  });

  it("closes the question on Cancel even when native code cannot forget the file", async () => {
    const user = userEvent.setup();
    const bridge = waitingForAnswer({
      discardReceived: vi.fn().mockRejectedValue(new Error("FAKE busy")),
    });
    render(<VaultApp bridge={bridge} />);
    const dialog = await question();
    await user.click(
      within(dialog).getByRole("button", { name: humanText("Cancel") }),
    );
    await waitFor(() =>
      expect(bridge.discardReceived).toHaveBeenCalledWith(["shared-1"]),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(bridge.acceptReceived).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: humanText("My records") }),
    ).toBeVisible();
  });

  it("opens the library when the platform and the tray cannot be read", async () => {
    const bridge = openVault({
      platform: vi.fn().mockRejectedValue(new Error("FAKE no platform")),
      trayWaiting: vi.fn().mockRejectedValue(new Error("FAKE no tray")),
      onTrayWaiting: vi.fn(() => () => undefined),
    });
    render(<VaultApp bridge={bridge} />);
    expect(
      await screen.findByRole("heading", { name: humanText("My records") }),
    ).toBeVisible();
    expect(bridge.platform).toHaveBeenCalled();
    expect(bridge.trayWaiting).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("closes a native session it could not read the state of, even when closing fails, and shows why", async () => {
    const bridge = nativeBridge({
      status: vi
        .fn()
        .mockRejectedValue({ code: "storage", message: "FAKE no state." }),
      lock: vi.fn().mockRejectedValue(new Error("FAKE cannot lock")),
    });
    render(<VaultApp bridge={bridge} />);
    expect(
      await screen.findByRole("heading", {
        name: humanText("Unlock your vault"),
      }),
    ).toBeVisible();
    expect(bridge.lock).toHaveBeenCalledOnce();
    expect(screen.getByText(humanText(/FAKE no state\./))).toBeVisible();
  });

  it("saves the recovery kit through the app's own picker tracking, and says so", async () => {
    const user = userEvent.setup();
    const KEY = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345";
    const bridge = openVault({
      beginRecoveryKey: vi.fn().mockResolvedValue(KEY),
      saveRecoveryKit: vi.fn().mockResolvedValue(true),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText("Security") }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: humanText("Set up recovery key"),
      }),
    );
    const setup = screen.getByRole("dialog");
    await user.type(
      within(setup).getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(
      within(setup).getByRole("button", { name: humanText("Continue") }),
    );
    const key = await screen.findByRole("dialog", {
      name: humanText("Your recovery key"),
    });
    const save = await within(key).findByRole("button", {
      name: humanText("Save recovery kit…"),
    });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(bridge.saveRecoveryKit).toHaveBeenCalledOnce());
    expect(
      await within(key).findByText(
        humanText(
          "Recovery kit saved. The key starts working once you finish the check.",
        ),
      ),
    ).toBeVisible();
  });
});

describe("the automatic lock and the native deadline, when a video plays or the native side does not answer (#359)", () => {
  const VIDEO_NAME = "FAKE Video, 20 Nov 2026, 3.05 PM.mp4";
  const TOKEN = "a".repeat(64);
  beforeEach(() => {
    window.localStorage.clear();
    // One minute, so the warning comes at 30 seconds.
    window.localStorage.setItem("mycarlos.autoLockMinutes.v1", "1");
  });
  const withVideo = (overrides: Partial<VaultBridge> = {}) => {
    const vault: VaultSnapshot = {
      ...emptySnapshot,
      records: [
        {
          id: "video-1",
          profileId: "profile-1",
          folderIds: [],
          displayName: VIDEO_NAME,
          sourceLabel: "Manual import — unverified",
          mediaType: "application/octet-stream",
          plaintextSize: 2048,
          importedAtMs: Date.UTC(2026, 10, 20, 15, 5),
          available: true,
        },
      ],
    };
    return nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn(async () => captureSnapshot(vault)),
      isVideo: vi.fn(async (id: string) => id === "video-1"),
      videoOpen: vi.fn(async () => ({
        token: TOKEN,
        url: `mycarlos-video://localhost/${TOKEN}`,
        totalBytes: 123,
      })),
      videoClose: vi.fn(async () => undefined),
      ...overrides,
    });
  };
  async function open(bridge: VaultBridge) {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    await act(async () => {
      render(<VaultApp bridge={bridge} />);
    });
    return bridge;
  }
  const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms));
  const locked = () =>
    screen.queryByRole("heading", { name: humanText("Unlock your vault") });

  it("does not lock a vault while a video plays, tells the native deadline, and locks after it is paused", async () => {
    const bridge = await open(
      withVideo({
        touch: vi.fn().mockRejectedValue(new Error("FAKE no touch")),
      }),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: humanText(VIDEO_NAME) }),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: humanText("Play video") }),
      );
    });
    await act(async () => undefined);
    const player = screen.getByLabelText(
      humanText(`Video player: ${VIDEO_NAME}`),
    );
    await act(async () => {
      fireEvent(player, new Event("playing"));
    });
    // Well past the delay, and past the warning: playing is not idle time.
    await wait(150_000);
    expect(bridge.lock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("alertdialog", {
        name: humanText(/^myCarlos will lock in/),
      }),
    ).toBeNull();
    // The native deadline is told, sparingly (and its refusal is not a failure here).
    const touches = vi.mocked(bridge.touch).mock.calls.length;
    expect(touches).toBeGreaterThan(0);
    // "Sparingly" is the rule: over these 150 s a call every second would be 150, so the bound
    // only says the app does not tell native code on every tick or every playback event. It is a
    // ceiling on the rate, not the interval's value: raise it if the interval is made shorter on
    // purpose, and keep it far below one call a second.
    expect(touches).toBeLessThan(20);
    // Paused: the hold is let go, and the usual delay runs from here.
    await act(async () => {
      fireEvent(player, new Event("pause"));
    });
    await wait(30_000);
    expect(bridge.lock).not.toHaveBeenCalled();
    await wait(80_000);
    expect(bridge.lock).toHaveBeenCalledOnce();
    expect(locked()).toBeVisible();
  });

  it("goes on when the native deadline cannot be told, from use and from Keep open", async () => {
    const bridge = await open(
      nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        touch: vi.fn().mockRejectedValue(new Error("FAKE no touch")),
      }),
    );
    expect(
      screen.getByRole("heading", { name: humanText("My records") }),
    ).toBeVisible();
    // Use puts the lock off and tells the native deadline, which does not answer.
    await wait(20_000);
    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"));
      window.dispatchEvent(new Event("keydown"));
    });
    expect(bridge.touch).toHaveBeenCalledTimes(1);
    // A full delay again from the use: the warning comes at 30 seconds of idleness.
    await wait(29_000);
    expect(
      screen.queryByRole("alertdialog", {
        name: humanText(/^myCarlos will lock in/),
      }),
    ).toBeNull();
    await wait(1_000);
    const keep = screen.getByRole("button", { name: humanText("Keep open") });
    await act(async () => {
      fireEvent.click(keep);
    });
    expect(bridge.touch).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("alertdialog", {
        name: humanText(/^myCarlos will lock in/),
      }),
    ).toBeNull();
    expect(bridge.lock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: humanText("My records") }),
    ).toBeVisible();
  });
});

// Ben, 24 Nov (Windows): a file picker opened, other sections visited while it was open, and
// the picker closed with nothing chosen. The library then said "Working…" for good, Add did not
// work, and after Lock now the Unlock button was greyed. Cancelling at any point must return to idle,
// and a lock must end whatever the session before it left in flight.
describe("a file picker that is cancelled, fails, or is left behind never keeps the library working", () => {
  const unlockedWith = (pickImportFiles: VaultBridge["pickImportFiles"]) =>
    nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      pickImportFiles,
    });
  // In the overhaul the import is an item of the Add document menu: the menu's button is what is
  // enabled again when a picker has ended, and choosing "Import a file" is what starts one.
  const newButton = () =>
    screen.getByRole("button", { name: humanText("Add document") });
  const picker = () => {
    let settle!: (pickId: string | null) => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise<string | null>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    return { promise, settle, fail };
  };

  it("returns to idle when the picker is cancelled, with the place left as it was", async () => {
    const user = userEvent.setup();
    const pick = picker();
    const bridge = unlockedWith(vi.fn(() => pick.promise));
    render(<VaultApp bridge={bridge} />);
    await chooseAdd(user, "Import a file");
    await waitFor(() => expect(bridge.pickImportFiles).toHaveBeenCalled());
    // In the overhaul the Add document button says "Working…" too, beside the status line: more
    // than one place says it, so the check is that the state is shown, not that it is shown once.
    expect(screen.getAllByText(humanText("Working…")).length).toBeGreaterThan(
      0,
    );
    await act(async () => pick.settle(null));
    expect(
      await screen.findByText(humanText("No files selected. Nothing changed.")),
    ).toBeVisible();
    expect(newButton()).toBeEnabled();
    expect(screen.queryByText(humanText("Working…"))).toBeNull();
    // And Add works again.
    vi.mocked(bridge.pickImportFiles).mockResolvedValueOnce("pick-2");
    await chooseAdd(user, "Import a file");
    await waitFor(() =>
      expect(bridge.pickImportFiles).toHaveBeenCalledTimes(2),
    );
  });

  it("returns to idle when the picker is cancelled after other sections were visited and left", async () => {
    const user = userEvent.setup();
    const pick = picker();
    const bridge = unlockedWith(vi.fn(() => pick.promise));
    render(<VaultApp bridge={bridge} />);
    await chooseAdd(user, "Import a file");
    await waitFor(() => expect(bridge.pickImportFiles).toHaveBeenCalled());
    // The picker may not block the window: sections and settings pages are visited meanwhile.
    for (const section of ["Security", "Preferences", "Shared with me"]) {
      await user.click(screen.getByRole("button", { name: section }));
    }
    await user.click(screen.getByRole("button", { name: /^My records/ }));
    await act(async () => pick.settle(null));
    await waitFor(() => expect(newButton()).toBeEnabled());
    expect(screen.queryByText(humanText("Working…"))).toBeNull();
  });

  it("returns to idle when the picker itself fails", async () => {
    const user = userEvent.setup();
    const pick = picker();
    const bridge = unlockedWith(vi.fn(() => pick.promise));
    render(<VaultApp bridge={bridge} />);
    await chooseAdd(user, "Import a file");
    await waitFor(() => expect(bridge.pickImportFiles).toHaveBeenCalled());
    await act(async () =>
      pick.fail({ code: "storage", message: "FAKE picker failure" }),
    );
    await waitFor(() => expect(newButton()).toBeEnabled());
    expect(screen.queryByText(humanText("Working…"))).toBeNull();
  });

  it("does not leave Unlock greyed when the vault is locked with a picker still unanswered", async () => {
    const user = userEvent.setup();
    const pick = picker();
    const bridge = unlockedWith(vi.fn(() => pick.promise));
    render(<VaultApp bridge={bridge} />);
    await chooseAdd(user, "Import a file");
    await waitFor(() => expect(bridge.pickImportFiles).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Security" }));
    // The picker is never answered; the patient locks the vault.
    await user.click(windowLock());
    expect(
      await screen.findByRole("heading", {
        name: humanText("Unlock your vault"),
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: humanText("Unlock") }),
    ).toBeEnabled();
    // The old answer arriving now (cancelled) changes nothing of the unlock screen.
    await act(async () => pick.settle(null));
    expect(
      screen.getByRole("button", { name: humanText("Unlock") }),
    ).toBeEnabled();
    // And the patient can unlock and add again.
    await user.type(
      screen.getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    await waitFor(() => expect(newButton()).toBeEnabled());
  });

  it("does not let an old operation's end cancel the working state of a new one", async () => {
    const user = userEvent.setup();
    const first = picker();
    const second = picker();
    const pickImportFiles = vi
      .fn<VaultBridge["pickImportFiles"]>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const bridge = unlockedWith(pickImportFiles);
    render(<VaultApp bridge={bridge} />);
    await chooseAdd(user, "Import a file");
    await waitFor(() => expect(pickImportFiles).toHaveBeenCalledTimes(1));
    await user.click(windowLock());
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await user.type(
      screen.getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    await chooseAdd(user, "Import a file");
    await waitFor(() => expect(pickImportFiles).toHaveBeenCalledTimes(2));
    // The first session's picker ends while the new one is still open: the new one is still working.
    await act(async () => first.settle(null));
    expect(screen.getAllByText(humanText("Working…")).length).toBeGreaterThan(
      0,
    );
    await act(async () => second.settle(null));
    await waitFor(() => expect(newButton()).toBeEnabled());
  });

  it("still shows a clinic result in the next session after a lock left a picker unanswered", async () => {
    // The lock leaves the picker's operation behind; it must not keep the next session "busy" for
    // the notices a clinic check queues behind a running library operation.
    const user = userEvent.setup();
    const pick = picker();
    const link = {
      id: "fake-clinic-link",
      portalBase: "https://portal.example.test/patient",
      deviceName: "myCarlos FAKE device",
      profileId: null,
      clinicName: "FAKE First Clinic",
      fingerprints: [],
      incomplete: false,
      deviceKeyId: "FAKE_FIRST_DEVICE",
      deviceFingerprint: "11".repeat(32),
      approvalRequested: true,
      clinicApproved: false,
    };
    const snapshot: VaultSnapshot = {
      ...snapshotWithRecord,
      profiles: [
        { id: "profile-1", displayName: "FAKE First Patient", createdAtMs: 1 },
      ],
      recoveryKeySetAtMs: 5,
      portalLinkingEnabled: true,
      portalLinks: [link],
    };
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockImplementation(async () => captureSnapshot(snapshot)),
      unlock: vi.fn().mockImplementation(async () => captureSnapshot(snapshot)),
      connectPortal: vi.fn(),
      linkPortal: vi.fn(),
      requestDeviceApproval: vi.fn().mockResolvedValue(undefined),
      pickImportFiles: vi.fn(() => pick.promise),
      checkDocuments: vi
        .fn()
        .mockResolvedValue({ added: 1, refused: 0, receiptsPending: 0 }),
    });
    render(<VaultApp bridge={bridge} />);
    await chooseAdd(user, "Import a file");
    await waitFor(() => expect(bridge.pickImportFiles).toHaveBeenCalled());
    await user.click(windowLock());
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await user.type(
      screen.getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    await user.click(
      (await screen.findAllByRole("button", { name: /^Shared with me/ }))[0],
    );
    await screen.findByRole("heading", { name: humanText("Shared with me") });
    const calls = vi.mocked(bridge.checkDocuments!).mock.calls.length;
    await user.click(
      await screen.findByRole("button", { name: "Check for new documents" }),
    );
    await waitFor(() =>
      expect(
        vi.mocked(bridge.checkDocuments!).mock.calls.length,
      ).toBeGreaterThan(calls),
    );
    // The result is written at once, not queued behind the old session's picker.
    expect(
      await screen.findByText(
        humanText(
          "New documents saved: 1. Documents that could not be verified: 0.",
        ),
      ),
    ).toBeVisible();
  });
});

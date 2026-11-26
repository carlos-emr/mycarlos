import { humanText } from "./test/humanText";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetRecoveryOffer,
  recordRecoveryOffer,
} from "./native/recoveryOffer";
import VaultApp from "./VaultApp";
import type { VaultBridge, VaultSnapshot } from "./vault";

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

const emptySnapshot: VaultSnapshot = {
  capture: { epoch: "00000000-0000-4000-8000-000000000185", sequence: 1 },
  profiles: [{ id: "profile-1", displayName: "Jamie", createdAtMs: 1 }],
  folders: [],
  records: [],
  recovery: null,
};

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

const LOCKED_MESSAGE =
  /^(Vault locked\.|Locked after \d+ minutes? without use\.|Locked because myCarlos was minimized or sent to the background\.)$/;

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

beforeEach(() => {
  window.localStorage.clear();
  forgetRecoveryOffer();
  recordRecoveryOffer(Date.now());
});

describe("what arrives after the vault locked", () => {
  // The control for the test below: the outcome IS held for the next unlock in this setup, so
  // that test's "not shown after a reset" is about something that would otherwise be there.
  it("holds a copy's result that arrives after Lock, and says it after the next unlock", async () => {
    const user = userEvent.setup();
    const OUTCOME = "A readable copy was saved to this device.";
    let state: "unlocked" | "locked" = "unlocked";
    let finishExport!: () => void;
    const bridge = nativeBridge({
      status: vi.fn(async () => state),
      lock: vi.fn(async () => {
        state = "locked";
      }),
      unlock: vi.fn(async () => {
        state = "unlocked";
        return captureSnapshot(snapshotWithRecord);
      }),
      snapshot: vi.fn(async () => captureSnapshot(snapshotWithRecord)),
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
    await act(async () => finishExport());
    expect(
      screen.queryByText(humanText(OUTCOME), { exact: false }),
    ).not.toBeInTheDocument();
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
      await screen.findByText(humanText(`Vault unlocked. ${OUTCOME}`)),
    ).toBeVisible();
  });

  it("keeps a copy's result off the lock screen, and drops it when the vault is set aside instead of unlocked", async () => {
    const user = userEvent.setup();
    const OUTCOME = "A readable copy was saved to this device.";
    let state: "unlocked" | "locked" | "absent" = "unlocked";
    let finishExport!: () => void;
    const bridge = nativeBridge({
      status: vi.fn(async () => state),
      lock: vi.fn(async () => {
        state = "locked";
      }),
      reset: vi.fn(async () => {
        state = "absent";
        return true;
      }),
      create: vi.fn(async () => {
        state = "unlocked";
        return captureSnapshot(emptySnapshot);
      }),
      unlock: vi.fn(async () => {
        state = "unlocked";
        return captureSnapshot(emptySnapshot);
      }),
      snapshot: vi.fn(async () => captureSnapshot(snapshotWithRecord)),
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
    // The copy was already written when the lock came: its result arrives on the lock screen.
    await act(async () => finishExport());
    expect(screen.getByText(humanText(LOCKED_MESSAGE))).toBeVisible();
    expect(
      screen.queryByText(humanText(OUTCOME), { exact: false }),
    ).not.toBeInTheDocument();

    // The patient does not unlock: they set the vault aside and make a new one.
    await user.click(screen.getByText(humanText("Forgot your passphrase?")));
    await user.type(
      screen.getByLabelText(humanText("Type RESET MYCARLOS VAULT")),
      "RESET MYCARLOS VAULT",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Set vault aside") }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: humanText("Continue") }),
    );
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
    // The new vault never shows what the old vault's transfer reported...
    expect(
      screen.queryByText(humanText(OUTCOME), { exact: false }),
    ).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(OUTCOME);
    // ...nor at its first unlock, which is where a held outcome would be said (see the control
    // above): lock the new vault and unlock it.
    await user.click(
      screen.getByRole("button", { name: humanText(/Lock now/) }),
    );
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
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
    await screen.findByRole("heading", { name: humanText("My records") });
    expect(document.body).not.toHaveTextContent(OUTCOME);
  });

  it("keeps a clinic link's result off the lock screen, and out of a new vault made after setting the old one aside", async () => {
    const user = userEvent.setup();
    let state: "unlocked" | "locked" | "absent" = "unlocked";
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
    const clinicSnapshot: VaultSnapshot = {
      ...snapshotWithRecord,
      recoveryKeySetAtMs: 5,
      portalLinkingEnabled: true,
      portalLinks: [],
    };
    type Connected = Awaited<
      ReturnType<NonNullable<VaultBridge["connectPortal"]>>
    >;
    let finish!: (result: Connected) => void;
    const pending = new Promise<Connected>((resolve) => {
      finish = resolve;
    });
    const bridge = nativeBridge({
      status: vi.fn(async () => state),
      lock: vi.fn(async () => {
        state = "locked";
      }),
      reset: vi.fn(async () => {
        state = "absent";
        return true;
      }),
      create: vi.fn(async () => {
        state = "unlocked";
        return captureSnapshot(emptySnapshot);
      }),
      snapshot: vi.fn(async () => captureSnapshot(clinicSnapshot)),
      connectPortal: vi.fn().mockReturnValue(pending),
      linkPortal: vi.fn(),
      checkDocuments: vi.fn(),
      requestDeviceApproval: vi.fn().mockResolvedValue(undefined),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(await screen.findByRole("button", { name: "Security" }));
    await user.type(
      screen.getByLabelText("Portal HTTPS address"),
      "https://portal.example.test/patient",
    );
    await user.type(
      screen.getByLabelText("Linking code"),
      "01234567-89ABCDEFGH",
    );
    const form = screen
      .getByRole("button", { name: "Connect and request approval" })
      .closest("form")!;
    await act(async () => fireEvent.submit(form));
    await waitFor(() => expect(bridge.connectPortal).toHaveBeenCalledOnce());
    // Security has a Lock now button too: use the window's own, in the title bar.
    await user.click(
      within(document.querySelector(".titlebar") as HTMLElement).getByRole(
        "button",
        { name: humanText("Lock now") },
      ),
    );
    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    // The portal answers after the lock.
    await act(async () => finish({ link, approvalError: null }));
    expect(screen.getByText(humanText(LOCKED_MESSAGE))).toBeVisible();
    expect(document.body).not.toHaveTextContent(/Device linked/);
    expect(document.body).not.toHaveTextContent("FAKE First Clinic");

    await user.click(screen.getByText(humanText("Forgot your passphrase?")));
    await user.type(
      screen.getByLabelText(humanText("Type RESET MYCARLOS VAULT")),
      "RESET MYCARLOS VAULT",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Set vault aside") }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: humanText("Continue") }),
    );
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
    expect(document.body).not.toHaveTextContent(/Device linked/);
    expect(document.body).not.toHaveTextContent("FAKE First Clinic");
  });
});

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
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  forgetRecoveryOffer,
  recordRecoveryOffer,
} from "./native/recoveryOffer";
import VaultApp from "./VaultApp";
import type {
  ReceivedAcceptOutcome,
  VaultBridge,
  VaultSnapshot,
} from "./vault";

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

// ---- A write pressed twice is written once --------------------------------------------------------
//
// Each action is pressed the ways a person can: a double click, and a second click while the first
// is still pending. The bridge must see one call. FAKE names and ids only.

type Press = (button: HTMLElement) => Promise<void>;

const PRESSES: [string, (user: ReturnType<typeof userEvent.setup>) => Press][] =
  [
    ["a double click", (user) => (button) => user.dblClick(button)],
    [
      "a second click while the first is pending",
      (user) => async (button) => {
        await user.click(button);
        await user.click(button);
      },
    ],
  ];

beforeEach(() => {
  window.localStorage.clear();
  forgetRecoveryOffer();
  recordRecoveryOffer(Date.now());
});

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
      const taken = ids ? queue.filter((file) => ids.includes(file.id)) : queue;
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

/** A promise a test settles by hand. */
function later<T = void>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

describe("a write pressed twice is written once", () => {
  async function openRename(
    user: ReturnType<typeof userEvent.setup>,
    bridge: VaultBridge,
  ) {
    render(<VaultApp bridge={bridge} />);
    await user.click(await screen.findByText(humanText("FAKE_Results.pdf")));
    await user.click(
      screen.getByRole("button", { name: humanText("Rename document") }),
    );
    await user.clear(screen.getByLabelText(humanText("File name")));
    await user.type(
      screen.getByLabelText(humanText("File name")),
      "FAKE Renamed",
    );
    return screen.getByRole("button", { name: humanText("Save name") });
  }
  const renameBridge = () => {
    const pending = later();
    return {
      pending,
      bridge: nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        snapshot: vi
          .fn()
          .mockImplementation(async () => captureSnapshot(snapshotWithRecord)),
        renameRecord: vi.fn().mockReturnValue(pending.promise),
      }),
    };
  };

  it.each(PRESSES)(
    "renames a document once when pressed with %s",
    async (_name, make) => {
      const user = userEvent.setup();
      const { bridge, pending } = renameBridge();
      const save = await openRename(user, bridge);
      await make(user)(save);
      await waitFor(() => expect(bridge.renameRecord).toHaveBeenCalled());
      await act(async () => pending.settle());
      expect(bridge.renameRecord).toHaveBeenCalledTimes(1);
    },
  );

  // KNOWN GAP, not a user path: two clicks delivered in the same tick (a script, an assistive
  // tool replaying a click) reach the handler before React re-renders and disables the button,
  // because `run` is guarded by `busy` state alone. A real second click cannot get in: React
  // flushes a discrete event synchronously, so the button is already disabled (the two cases above
  // pass). The fix, when wanted, is a ref flag in the handler (set when it starts, cleared in the
  // operation's `finally`), not a guard in `run`, which nests with transfers on purpose. Every
  // action has the same gap, so it is recorded once, here. `it.fails` flips this to an error when
  // the gap is closed, so the case is then turned into a plain test.
  it.fails(
    "writes a rename twice for two clicks in one tick (known gap)",
    async () => {
      const user = userEvent.setup();
      const { bridge, pending } = renameBridge();
      const save = await openRename(user, bridge);
      await act(async () => {
        fireEvent.click(save);
        fireEvent.click(save);
      });
      await waitFor(() => expect(bridge.renameRecord).toHaveBeenCalled());
      await act(async () => pending.settle());
      expect(bridge.renameRecord).toHaveBeenCalledTimes(1);
    },
  );

  // Two layers stop a repeat here (so a mutant that removes only one survives): the question
  // closes as the first press is handled, and `acceptSharedRef` answers false while an accept is
  // in flight.
  it.each(PRESSES)(
    "adds an opened file once when Import is pressed with %s",
    async (_name, make) => {
      const user = userEvent.setup();
      const pending = later<ReceivedAcceptOutcome>();
      const { bridge } = openedWithVault(["FAKE_Opened.pdf"]);
      vi.mocked(bridge.acceptReceived).mockReturnValue(pending.promise);
      render(<VaultApp bridge={bridge} />);
      await unlockWith(user);
      const dialog = await screen.findByRole("alertdialog", {
        name: humanText("Import FAKE_Opened.pdf into Shared with me?"),
      });
      await make(user)(
        within(dialog).getByRole("button", { name: humanText("Import") }),
      );
      await waitFor(() => expect(bridge.acceptReceived).toHaveBeenCalled());
      await act(async () =>
        pending.settle({
          imported: [],
          skippedDuplicates: [],
          notPdf: [],
          unreadable: [],
        }),
      );
      expect(bridge.acceptReceived).toHaveBeenCalledTimes(1);
    },
  );

  it.each(PRESSES)(
    "forgets an opened file once when Cancel is pressed with %s",
    async (_name, make) => {
      const user = userEvent.setup();
      const pending = later<number>();
      const { bridge } = openedWithVault(["FAKE_Opened.pdf"]);
      vi.mocked(bridge.discardReceived).mockReturnValue(pending.promise);
      render(<VaultApp bridge={bridge} />);
      await unlockWith(user);
      const dialog = await screen.findByRole("alertdialog", {
        name: humanText("Import FAKE_Opened.pdf into Shared with me?"),
      });
      await make(user)(
        within(dialog).getByRole("button", { name: humanText("Cancel") }),
      );
      await waitFor(() => expect(bridge.discardReceived).toHaveBeenCalled());
      await act(async () => pending.settle(1));
      expect(bridge.discardReceived).toHaveBeenCalledTimes(1);
    },
  );
  it.each(PRESSES)(
    "restores a hidden person once when pressed with %s",
    async (_name, make) => {
      const user = userEvent.setup();
      const pending = later<[]>();
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        snapshot: vi.fn().mockImplementation(async () =>
          captureSnapshot({
            ...emptySnapshot,
            hiddenProfiles: [
              {
                id: "profile-2",
                displayName: "FAKE Morgan",
                hiddenAtMs: 5,
                documents: 2,
              },
            ],
          }),
        ),
        restoreProfile: vi.fn().mockReturnValue(pending.promise),
      });
      render(<VaultApp bridge={bridge} />);
      await user.click(await screen.findByRole("button", { name: "Security" }));
      await make(user)(
        await screen.findByRole("button", {
          name: humanText("Restore FAKE Morgan"),
        }),
      );
      await waitFor(() => expect(bridge.restoreProfile).toHaveBeenCalled());
      await act(async () => pending.settle([]));
      expect(bridge.restoreProfile).toHaveBeenCalledTimes(1);
    },
  );

  it.each(PRESSES)(
    "saves a camera photo once when Use photo is pressed with %s",
    async (_name, make) => {
      const user = userEvent.setup();
      const pending = later<{
        imported: string[];
        skippedDuplicates: string[];
      }>();
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        platform: vi.fn().mockResolvedValue("windows"),
        savePhoto: vi.fn().mockReturnValue(pending.promise),
      });
      // A painted canvas stands in for the camera, and the explanation was already read.
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
        camera.mockRestore();
        window.clearInterval(painter);
        stream.getTracks().forEach((track) => track.stop());
        window.localStorage.removeItem("mycarlos.cameraExplained.v1");
      });
      render(<VaultApp bridge={bridge} />);
      await user.click(
        await screen.findByRole("button", { name: "Take a photo" }),
      );
      const shutter = screen.getByRole("button", { name: "Take photo" });
      await waitFor(() => expect(shutter).toBeEnabled());
      await user.click(shutter);
      await make(user)(screen.getByRole("button", { name: "Use photo" }));
      await waitFor(() => expect(bridge.savePhoto).toHaveBeenCalled());
      await act(async () =>
        pending.settle({ imported: [], skippedDuplicates: [] }),
      );
      expect(bridge.savePhoto).toHaveBeenCalledTimes(1);
    },
  );
  // Two layers stop a repeat here too: the state guard (the form is disabled while it works) and
  // `runPortal`, which makes a repeated press join the job already running. A mutant that removes
  // only one of them survives.
  it.each(PRESSES)(
    "sends the emailed approval code once when Confirm code is pressed with %s",
    async (_name, make) => {
      const user = userEvent.setup();
      const pending = later();
      const awaitingCode = {
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
        approvalStatus: "challenge_ready" as const,
        approvalByCode: true,
      };
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        snapshot: vi.fn().mockImplementation(async () =>
          captureSnapshot({
            ...snapshotWithRecord,
            portalLinkingEnabled: true,
            recoveryKeySetAtMs: 5,
            portalLinks: [awaitingCode],
          }),
        ),
        connectPortal: vi.fn(),
        linkPortal: vi.fn(),
        checkDocuments: vi.fn(),
        requestDeviceApproval: vi.fn().mockResolvedValue(undefined),
        submitApprovalCode: vi.fn().mockReturnValue(pending.promise),
      });
      render(<VaultApp bridge={bridge} />);
      await user.click(await screen.findByRole("button", { name: "Security" }));
      const box = await screen.findByRole("textbox", {
        name: "Code from your clinic's email",
      });
      await user.type(box, "482 193 644");
      await make(user)(screen.getByRole("button", { name: "Confirm code" }));
      await waitFor(() => expect(bridge.submitApprovalCode).toHaveBeenCalled());
      await act(async () => pending.settle());
      expect(bridge.submitApprovalCode).toHaveBeenCalledTimes(1);
    },
  );
});

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import axe from "axe-core";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  forgetRecoveryOffer,
  recordRecoveryOffer,
} from "./native/recoveryOffer";

const offerIsDue = () => forgetRecoveryOffer();
import { StrictMode } from "react";
import VaultApp from "./VaultApp";
import type { ImportOutcome, VaultBridge, VaultSnapshot } from "./vault";
import { ANNOUNCE_DELAY_MS } from "./native/announce";

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
  profiles: [{ id: "profile-1", displayName: "Jamie", createdAtMs: 1 }],
  folders: [],
  records: [],
  recovery: null,
};

function nativeBridge(overrides: Partial<VaultBridge> = {}): VaultBridge {
  return {
    native: true,
    status: vi.fn().mockResolvedValue("locked"),
    create: vi.fn().mockResolvedValue(emptySnapshot),
    unlock: vi.fn().mockResolvedValue(emptySnapshot),
    lock: vi.fn().mockResolvedValue(undefined),
    touch: vi.fn().mockResolvedValue(undefined),
    setAutoLock: vi.fn().mockResolvedValue(undefined),
    platform: vi.fn().mockResolvedValue("windows"),
    snapshot: vi.fn().mockResolvedValue(emptySnapshot),
    changePassphrase: vi.fn().mockResolvedValue(undefined),
    // Tests that set up a recovery key say so; the others get a vault without
    // one, as when making the key fails after the vault was created.
    beginRecoveryKey: vi
      .fn()
      .mockRejectedValue({ code: "storage", message: "FAKE no key here." }),
    confirmRecoveryKey: vi
      .fn()
      .mockResolvedValue({ ...emptySnapshot, recoveryKeySetAtMs: 5 }),
    saveRecoveryKit: vi.fn().mockResolvedValue(true),
    benchmarkKdf: vi
      .fn()
      .mockRejectedValue({ code: "busy", message: "FAKE no speed test." }),
    cancelRecoveryKey: vi.fn().mockResolvedValue(undefined),
    recover: vi
      .fn()
      .mockResolvedValue({ passphraseReplaced: true, snapshot: emptySnapshot }),
    pickBackupDestination: vi.fn().mockResolvedValue(null),
    saveBackupToPicked: vi.fn().mockResolvedValue(undefined),
    pickRestoreSource: vi.fn().mockResolvedValue(null),
    inspectRestore: vi.fn().mockResolvedValue({
      replaces: "nothing",
      differsFromThisDevice: false,
      documentCount: 0,
    }),
    restore: vi.fn().mockResolvedValue(true),
    createProfile: vi.fn().mockResolvedValue("profile-2"),
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
    deleteRecord: vi.fn().mockResolvedValue(undefined),
    removeUnavailableRecords: vi.fn().mockResolvedValue([]),
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
    fireEvent.click(screen.getByText("FAKE_Results.pdf"));
  });
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Save a copy to this computer" }),
    );
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save a copy" }));
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

// The unlock screen says only that the vault locked; a transfer's outcome is
// shown after the next unlock, where only the owner sees it.
async function expectOutcomeAfterUnlock(outcome: string) {
  expect(screen.getByText("Vault locked.")).toBeVisible();
  expect(screen.queryByText(outcome, { exact: false })).not.toBeInTheDocument();
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "river-azimuth-cobalt-sparrow-934" },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
  });
  await passAnnounceDelay();
  expect(screen.getByText(`Vault unlocked. ${outcome}`)).toBeVisible();
}

// Unlocks and checks that nothing was kept for this unlock to report.
async function expectNothingKeptAfterUnlock() {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "river-azimuth-cobalt-sparrow-934" },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
  });
  expect(await screen.findByText(/^Vault unlocked/)).toHaveTextContent(
    /^Vault unlocked\.$/,
  );
}

// Starts an import, backgrounds the app so the lock is held for it, and
// finishes the import, which lets the held lock proceed.
async function holdLockForImport(bridge: VaultBridge, finish: () => void) {
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Choose files to import" }),
  );
  await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  onTestFinished(() => visibility.mockRestore());
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(screen.getByText(TRANSFER_HOLD)).toBeVisible();
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
    snapshot: vi.fn().mockImplementation(async () => snapshot),
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

describe("durable vault UI", () => {
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
    await screen.findByRole("heading", { name: "Create your encrypted vault" });
    expect(screen.getByText(/stays on this device/)).toHaveTextContent(
      /another device/,
    );
  });

  it("creates the vault only when passphrases match", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("absent"),
    });
    render(<VaultApp bridge={bridge} />);

    await screen.findByRole("heading", { name: "Create your encrypted vault" });
    fireEvent.change(screen.getByLabelText("First patient profile"), {
      target: { value: "Jamie" },
    });
    const passwords = screen.getAllByLabelText(/passphrase/i);
    fireEvent.change(passwords[0], {
      target: { value: "river-azimuth-cobalt-sparrow-934" },
    });
    fireEvent.change(passwords[1], { target: { value: "different" } });
    expect(screen.getByRole("button", { name: "Create vault" })).toBeDisabled();
    fireEvent.change(passwords[1], {
      target: { value: "river-azimuth-cobalt-sparrow-934" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create vault" }));

    await screen.findByRole("heading", { name: "My records" });
    expect(bridge.create).toHaveBeenCalledWith(
      "river-azimuth-cobalt-sparrow-934",
      "Jamie",
    );
  });

  it("says when a new passphrase exceeds the vault's byte limit instead of sending it", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("absent"),
    });
    render(<VaultApp bridge={bridge} />);
    const create = await screen.findByRole("button", { name: "Create vault" });
    // 600 characters need 1800 UTF-8 bytes, over the vault's 1024-byte limit.
    const long = "字".repeat(600);
    for (const field of screen.getAllByLabelText(/passphrase/i)) {
      fireEvent.change(field, { target: { value: long } });
    }

    expect(screen.getByRole("alert")).toHaveTextContent("too long");
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
      await screen.findByLabelText("Passphrase"),
      "a long synthetic passphrase",
    );
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    expect(
      await screen.findByRole("heading", {
        name: "Create your encrypted vault",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No vault exists on this device."),
    ).toBeInTheDocument();
  });

  it("unlocks and imports through the native bridge", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      importPickedFiles: vi.fn().mockResolvedValue({
        imported: ["record-1"],
        skippedDuplicates: ["copy.pdf"],
      }),
      snapshot: vi.fn().mockResolvedValue({
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
    });
    render(<VaultApp bridge={bridge} />);

    await screen.findByRole("heading", { name: "Unlock your vault" });
    await user.type(
      screen.getByLabelText("Passphrase"),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await user.click(
      await screen.findByRole("button", { name: "Choose files to import" }),
    );

    expect(await screen.findByText("report.pdf")).toBeVisible();
    expect(
      screen.getByText(
        "1 file(s) encrypted and imported. 1 duplicate(s) skipped.",
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

  it("presents durable records as a navigable filing cabinet", async () => {
    const user = userEvent.setup();
    const filingSnapshot: VaultSnapshot = {
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
      snapshot: vi.fn().mockResolvedValue(filingSnapshot),
    });
    render(<VaultApp bridge={bridge} />);

    expect(
      await screen.findByRole("heading", { name: "My records" }),
    ).toBeVisible();
    expect(screen.getByText("FAKE_Root_Letter.pdf")).toBeVisible();
    expect(screen.queryByText("FAKE_Bloodwork.pdf")).not.toBeInTheDocument();

    const recordTransfer = dragTransfer();
    fireDragEvent(
      "dragstart",
      screen.getByRole("article", { name: "FAKE_Root_Letter.pdf document" }),
      { dataTransfer: recordTransfer },
    );
    const visibleFolder = screen.getByRole("article", {
      name: "FAKE Test Results folder",
    });
    const folderNavigation = screen.getByRole("navigation", {
      name: "Record library",
    });
    const sidebarFolder = within(folderNavigation).getByRole("button", {
      name: /FAKE Test Results/,
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
      screen.getByRole("article", { name: "FAKE_Root_Letter.pdf document" }),
      { dataTransfer: nestedTransfer },
    );
    const nestedSidebarFolder = within(folderNavigation).getByRole("button", {
      name: /FAKE 2025 Letters/,
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
      screen.getByRole("article", { name: "FAKE Test Results folder" }),
      { dataTransfer: folderTransfer },
    );
    fireDragEvent(
      "dragover",
      screen.getByRole("article", { name: "FAKE Letters folder" }),
      { dataTransfer: folderTransfer },
    );
    fireDragEvent(
      "drop",
      screen.getByRole("article", { name: "FAKE Letters folder" }),
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
      screen.getByRole("button", { name: "Open FAKE Test Results" }),
    );
    expect(
      screen.getByRole("heading", { name: "FAKE Test Results" }),
    ).toBeVisible();
    expect(screen.getByText("FAKE_Bloodwork.pdf")).toBeVisible();

    const rootTransfer = dragTransfer();
    fireDragEvent(
      "dragstart",
      screen.getByRole("article", { name: "FAKE_Bloodwork.pdf document" }),
      { dataTransfer: rootTransfer },
    );
    const rootDropTarget = within(folderNavigation).getByRole("button", {
      name: /My records/,
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
      screen.getByRole("button", { name: "Select FAKE_Bloodwork.pdf" }),
    );
    await user.selectOptions(screen.getByLabelText("Move selected to"), "");
    await user.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(bridge.assignFoldersBatch).toHaveBeenCalledWith(
        ["record-folder"],
        [],
      ),
    );

    await user.click(screen.getByText("FAKE_Bloodwork.pdf"));
    const shim = tauriConfirmShim();
    await user.click(
      screen.getByRole("button", { name: "Save a copy to this computer" }),
    );
    const warning = screen.getByRole("alertdialog", {
      name: "Save a readable copy?",
    });
    expect(warning).toHaveTextContent("cannot erase that copy");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(bridge.pickExportDestination).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "FAKE_Bloodwork.pdf" }),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Save a copy to this computer" }),
    );
    await user.click(screen.getByRole("button", { name: "Save a copy" }));
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
        await screen.findByRole("button", { name: "Open FAKE Parent" }),
      );
      if (view === "grid")
        await user.click(screen.getByRole("button", { name: "Grid view" }));
      await user.click(
        screen.getByRole("button", { name: "Rename folder FAKE Old folder" }),
      );
      const dialog = screen.getByRole("dialog", { name: "Rename folder" });
      const input = within(dialog).getByLabelText("Folder name");
      expect(input).toHaveFocus();
      await user.clear(input);
      await user.type(input, "   ");
      expect(
        within(dialog).getByRole("button", { name: "Save name" }),
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
        screen.getByRole("article", { name: "FAKE Results folder" }),
      ).toBeVisible();
      expect(
        screen.getByRole("heading", { name: "FAKE Parent" }),
      ).toBeVisible();
      expect(screen.queryByText("FAKE Old folder")).not.toBeInTheDocument();
    },
  );

  it("renames a document from its details, keeps failed input for retry, and supports cancellation", async () => {
    const user = userEvent.setup();
    const bridge = renameBridge();
    vi.mocked(bridge.renameRecord).mockRejectedValueOnce({
      message: "There is not enough storage to complete this operation.",
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: "Open FAKE Parent" }),
    );
    await user.click(
      screen.getByRole("button", { name: "More options for FAKE Old.pdf" }),
    );
    await user.click(screen.getByRole("button", { name: "Rename document" }));
    await user.clear(screen.getByLabelText("File name"));
    await user.type(screen.getByLabelText("File name"), "FAKE Cancelled");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(bridge.renameRecord).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "FAKE Old.pdf" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Rename document" }));
    await user.clear(screen.getByLabelText("File name"));
    // The field holds the name before ".pdf", which the rename keeps.
    await user.type(screen.getByLabelText("File name"), "FAKE Results");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "not enough storage",
    );
    expect(screen.getByLabelText("File name")).toHaveValue("FAKE Results");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    expect(
      await screen.findByRole("dialog", { name: "FAKE Results.pdf" }),
    ).toBeVisible();
    expect(bridge.renameRecord).toHaveBeenCalledWith(
      "record",
      "FAKE Results.pdf",
    );
    expect(bridge.assignFolders).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Close document details" }),
    );
    expect(
      screen.getByRole("article", { name: "FAKE Results.pdf document" }),
    ).toBeVisible();
  });

  it("gives a rename's result to a status line already back on screen", async () => {
    const user = userEvent.setup();
    const bridge = renameBridge();
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: "Open FAKE Parent" }),
    );

    // The document's details are replaced while it is renamed. Their status
    // line comes back empty, and the result is written into it after.
    await user.click(
      screen.getByRole("button", { name: "More options for FAKE Old.pdf" }),
    );
    await user.click(screen.getByRole("button", { name: "Rename document" }));
    await user.clear(screen.getByLabelText("File name"));
    await user.type(screen.getByLabelText("File name"), "FAKE Results");
    // Fake timers from here, so that nothing is written before it is checked.
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Save name" }));
      });
      const details = screen.getByRole("dialog", { name: "FAKE Results.pdf" });
      const detailsStatus = within(details).getByRole("status");
      expect(detailsStatus).toBeEmptyDOMElement();
      await passAnnounceDelay();
      expect(detailsStatus).toHaveTextContent(
        "Document renamed to FAKE Results.pdf.",
      );

      // The rename dialog makes the page inert. Its status line is written
      // to once the dialog has closed.
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Close document details" }),
        );
      });
      const pageStatus = screen.getByRole("status");
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: "Rename folder FAKE Old folder",
          }),
        );
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Folder name"), {
          target: { value: "FAKE Lab results" },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Save name" }));
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(pageStatus).toBeEmptyDOMElement();
      await passAnnounceDelay();
      expect(pageStatus).toHaveTextContent(
        "Folder renamed to FAKE Lab results.",
      );

      // A result is not written into another document's details opened
      // before it was due.
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: "Rename folder FAKE Lab results",
          }),
        );
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Folder name"), {
          target: { value: "FAKE Old folder" },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Save name" }));
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: "More options for FAKE Results.pdf",
          }),
        );
      });
      await passAnnounceDelay();
      const otherDetails = screen.getByRole("dialog", {
        name: "FAKE Results.pdf",
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
      await screen.findByRole("button", { name: "Open FAKE Parent" }),
    );
    await user.click(
      screen.getByRole("button", { name: "More options for FAKE Old.pdf" }),
    );
    await user.click(screen.getByRole("button", { name: "Rename document" }));
    await user.clear(screen.getByLabelText("File name"));
    await user.type(screen.getByLabelText("File name"), "FAKE Results");
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Save name" }));
      });
      // The confirmation replaces the details before the result is due.
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Save a copy to this computer" }),
        );
      });
      await passAnnounceDelay();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      });
      const details = screen.getByRole("dialog", { name: "FAKE Results.pdf" });
      const status = within(details).getByRole("status");
      expect(status).toBeEmptyDOMElement();
      await passAnnounceDelay();
      expect(status).toHaveTextContent("Document renamed to FAKE Results.pdf.");
    } finally {
      vi.useRealTimers();
    }
  });

  const RECOVERY_KEY = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345";

  it("sets up a recovery key before anything else in a new vault", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("absent"),
      beginRecoveryKey: vi.fn().mockResolvedValue(RECOVERY_KEY),
      snapshot: vi
        .fn()
        .mockResolvedValue({ ...emptySnapshot, recoveryKeySetAtMs: 5 }),
    });
    render(<VaultApp bridge={bridge} />);
    await user.type(
      await screen.findByLabelText("First patient profile"),
      "FAKE Test Patient",
    );
    await user.type(
      screen.getByLabelText("Passphrase"),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.type(
      screen.getByLabelText("Confirm passphrase"),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: "Create vault" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Your recovery key",
    });
    // The passphrase just typed authorizes the key.
    expect(bridge.beginRecoveryKey).toHaveBeenCalledWith(
      "river-azimuth-cobalt-sparrow-934",
    );
    // There is no way out until the key is set up.
    await user.keyboard("{Escape}");
    expect(dialog).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    const groups = RECOVERY_KEY.split("-");
    for (const input of within(dialog).getAllByLabelText(/^Group \d$/)) {
      const position = Number(
        input.closest("label")!.textContent!.match(/Group (\d)/)![1],
      );
      await user.type(input, groups[position - 1]);
    }
    await user.click(
      within(dialog).getByRole("button", { name: "Check and save" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(bridge.confirmRecoveryKey).toHaveBeenCalledOnce();
    expect(
      await screen.findByText(
        "Recovery key saved. Keep your kit somewhere safe.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Set up recovery key" }),
    ).not.toBeInTheDocument();
    // The button that led here is gone: focus is on the page, not on nothing.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "My records" })).toHaveFocus(),
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
      await screen.findByRole("button", { name: "Set up recovery key" }),
    );
    const dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("Passphrase"),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await screen.findByRole("dialog", { name: "Your recovery key" });
    await user.keyboard("{Escape}");
    expect(
      await screen.findByText(
        /setup was not finished\. The key you were shown does not open the vault\. Destroy/,
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
        fireEvent.click(screen.getByText("Forgot your passphrase?"));
      });
      const key = screen.getByLabelText("Recovery key");
      await act(async () => {
        fireEvent.change(key, { target: { value: RECOVERY_KEY } });
        fireEvent.click(
          screen.getByRole("button", { name: "Show recovery key" }),
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
      await screen.findByLabelText("Passphrase"),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Set up a recovery key",
    });
    // It says why it is there, to a screen reader too.
    expect(dialog).toHaveAccessibleDescription(
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
    expect(screen.queryByText(RECOVERY_KEY.split("-")[0])).toBeNull();

    await user.click(
      within(dialog).getByRole("button", { name: "Set up later" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Nothing was shown, so there is nothing to warn about.
    expect(await screen.findByText("Vault unlocked.")).toBeVisible();
    expect(screen.queryByText(/setup was not finished/)).toBeNull();
    // The library still offers it.
    expect(
      screen.getByRole("button", { name: "Set up recovery key" }),
    ).toBeVisible();
  });

  it("offers a recovery key at unlock once a day, and the notice the rest of the time", async () => {
    offerIsDue();
    const user = userEvent.setup();
    render(<VaultApp bridge={nativeBridge()} />);
    const unlock = async () => {
      await user.type(
        await screen.findByLabelText("Passphrase"),
        "river-azimuth-cobalt-sparrow-934",
      );
      await user.click(screen.getByRole("button", { name: "Unlock" }));
      await screen.findByRole("heading", { name: "My records" });
    };
    const lock = () =>
      user.click(screen.getByRole("button", { name: /Lock now/ }));

    await unlock();
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Set up later",
      }),
    );
    await lock();

    // Again the same day: the library opens, with its notice and no dialog.
    await unlock();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Set up recovery key" }),
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
      await screen.findByRole("dialog", { name: "Set up a recovery key" }),
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
      await screen.findByLabelText("Passphrase"),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    const offer = await screen.findByRole("dialog", {
      name: "Set up a recovery key",
    });
    await user.type(
      within(offer).getByLabelText("Passphrase"),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(within(offer).getByRole("button", { name: "Continue" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Your recovery key",
    });
    expect(bridge.beginRecoveryKey).toHaveBeenCalledExactlyOnceWith(
      "river-azimuth-cobalt-sparrow-934",
    );
    // Leaving now is leaving a key that was shown.
    await user.click(
      within(dialog).getByRole("button", { name: "Set up later" }),
    );
    expect(
      await screen.findByText(
        /setup was not finished\. The key you were shown/,
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
      unlock: vi.fn().mockResolvedValue({ ...emptySnapshot, ...state }),
      snapshot: vi.fn().mockResolvedValue({ ...emptySnapshot, ...state }),
    });
    render(<VaultApp bridge={bridge} />);
    await user.type(
      await screen.findByLabelText("Passphrase"),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(
      await screen.findByRole("heading", { name: "My records" }),
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
      await screen.findByRole("button", { name: "Set up recovery key" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Set up a recovery key",
    });
    expect(within(dialog).getByLabelText("Passphrase")).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(bridge.cancelRecoveryKey).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("saves an encrypted backup from Security as a transfer", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      pickBackupDestination: vi.fn().mockResolvedValue("pick-7"),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(await screen.findByRole("button", { name: /Security/ }));
    await user.click(
      screen.getByRole("button", { name: "Save encrypted backup…" }),
    );
    expect(bridge.saveBackupToPicked).toHaveBeenCalledWith("pick-7");
    expect(
      await screen.findByText(
        "Encrypted backup saved. Keep it somewhere other than this device.",
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
    await user.click(await screen.findByText("Restore from a backup"));
    await user.click(
      screen.getByRole("button", { name: "Choose backup file…" }),
    );
    await user.type(
      await screen.findByLabelText("Backup passphrase"),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: "Check backup" }));
    await user.click(
      await screen.findByRole("button", { name: "Restore backup" }),
    );
    expect(bridge.restore).toHaveBeenCalledWith(
      "pick-3",
      { passphrase: "river-azimuth-cobalt-sparrow-934" },
      false,
    );
    expect(
      await screen.findByRole("heading", { name: "Unlock your vault" }),
    ).toBeVisible();
    // The screen opens on it, so the field that takes focus says it.
    expect(screen.getByLabelText("Passphrase")).toHaveAccessibleDescription(
      /^Backup restored\./,
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
    render(<VaultApp bridge={bridge} />);
    await user.click(await screen.findByText("Restore from a backup"));
    await user.click(
      screen.getByRole("button", { name: "Choose backup file…" }),
    );
    await user.type(
      await screen.findByLabelText("Backup passphrase"),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: "Check backup" }));
    await user.click(
      await screen.findByRole("button", { name: "Restore backup" }),
    );
    expect(await screen.findByText(/^Backup restored\./)).toBeVisible();
    // The button that was pressed is gone with the form.
    expect(screen.getByLabelText("Passphrase")).toHaveFocus();
  });

  it("opens a locked vault with its recovery key and a new passphrase", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge();
    render(<VaultApp bridge={bridge} />);
    await user.click(await screen.findByText("Forgot your passphrase?"));
    await user.type(screen.getByLabelText("Recovery key"), RECOVERY_KEY);
    await user.type(
      screen.getByLabelText("New passphrase"),
      "lantern-orbit-willow-cascade-572",
    );
    await user.type(
      screen.getByLabelText("Confirm new passphrase"),
      "lantern-orbit-willow-cascade-572",
    );
    await user.click(
      screen.getByRole("button", { name: "Open with recovery key" }),
    );
    expect(bridge.recover).toHaveBeenCalledWith(
      RECOVERY_KEY,
      "lantern-orbit-willow-cascade-572",
    );
    expect(
      await screen.findByRole("heading", { name: "My records" }),
    ).toBeVisible();
    expect(
      await screen.findByText(/^Vault opened with your recovery key\./),
    ).toBeVisible();
  });

  const HELD_OUTCOME = "1 file(s) encrypted and imported.";

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
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Choose files to import" }),
      );
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
    expect(screen.getByText("Vault locked.")).toBeVisible();
  }

  async function unlockWithoutWaiting() {
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Passphrase"), {
        target: { value: "river-azimuth-cobalt-sparrow-934" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    });
    expect(screen.getByRole("heading", { name: "My records" })).toBeVisible();
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
        fireEvent.click(screen.getByRole("button", { name: /Lock now/ }));
      });
      await passAnnounceDelay();
      expect(screen.queryByText(/Vault unlocked/)).not.toBeInTheDocument();
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
        fireEvent.click(screen.getByRole("button", { name: /Lock now/ }));
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
        screen.queryByText(HELD_OUTCOME, { exact: false }),
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Choose files to import" }),
        );
      });
      await passAnnounceDelay();
      expect(screen.getByRole("status")).toHaveTextContent(
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
        await act(async () => {
          if (initial === "absent")
            fireEvent.change(screen.getByLabelText("First patient profile"), {
              target: { value: "FAKE Test Patient" },
            });
          for (const field of screen.getAllByLabelText(/passphrase/i))
            fireEvent.change(field, {
              target: { value: "river-azimuth-cobalt-sparrow-934" },
            });
        });
        await act(async () => {
          fireEvent.click(
            screen.getByRole("button", {
              name: initial === "absent" ? "Create vault" : "Unlock",
            }),
          );
        });
        expect(
          screen.getByRole("heading", { name: "My records" }),
        ).toBeVisible();
        const status = screen.getByRole("status");
        expect(status).toBeEmptyDOMElement();
        await passAnnounceDelay();
        expect(status).toHaveTextContent(message);
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
      snapshot: vi.fn().mockResolvedValue({
        ...emptySnapshot,
        records: [record("a", "FAKE_Alpha.pdf"), record("b", "FAKE_Beta.pdf")],
      }),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(
      await screen.findByRole("button", { name: "Select FAKE_Alpha.pdf" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Select FAKE_Beta.pdf" }),
    );
    expect(screen.getByText("2 selected")).toBeVisible();

    await user.type(
      screen.getByPlaceholderText("Search this location"),
      "Alpha",
    );
    expect(screen.queryByText("FAKE_Beta.pdf")).not.toBeInTheDocument();
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Move" }),
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
        .mockResolvedValue({ ...emptySnapshot, records: [record] }),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(await screen.findByText("FAKE_Long.pdf"));
    await user.click(screen.getByRole("button", { name: "Rename document" }));
    // 100 characters fit the input's 240-unit limit but need 300 UTF-8 bytes.
    fireEvent.change(screen.getByLabelText("File name"), {
      target: { value: "字".repeat(100) },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("too long");
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    expect(bridge.renameRecord).not.toHaveBeenCalled();

    // The kept ".pdf" counts too: 79 characters are 237 bytes, 241 with it.
    fireEvent.change(screen.getByLabelText("File name"), {
      target: { value: "字".repeat(79) },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("too long");
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();

    // Exactly the limit: 78 characters and "ab" are 236 bytes, 240 with it.
    fireEvent.change(screen.getByLabelText("File name"), {
      target: { value: `${"字".repeat(78)}ab` },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save name" })).toBeEnabled();
  });

  it("allows Escape to cancel folder renaming and disables renaming in recovery mode", async () => {
    const user = userEvent.setup();
    const bridge = renameBridge();
    const { unmount } = render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: "Rename folder FAKE Parent" }),
    );
    const results = await axe.run(screen.getByRole("dialog"));
    expect(results.violations).toEqual([]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Rename folder FAKE Parent" }),
    ).toHaveFocus();
    expect(bridge.updateFolder).not.toHaveBeenCalled();
    unmount();

    const snapshot = await bridge.snapshot();
    vi.mocked(bridge.snapshot).mockResolvedValue({
      ...snapshot,
      recovery: "writeFailed",
    });
    render(<VaultApp bridge={bridge} />);
    expect(
      await screen.findByRole("button", { name: "Rename folder FAKE Parent" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Open FAKE Parent" }));
    expect(
      screen.getByRole("button", { name: "Rename folder" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "More options for FAKE Old.pdf" }),
    );
    expect(
      screen.getByRole("button", { name: "Rename document" }),
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
        name: status === "locked" ? "Unlock your vault" : "My records",
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
          /To import PDFs, unlock your vault and use Choose files to import/,
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

      await user.click(
        await screen.findByRole("button", { name: "Choose files to import" }),
      );
      await waitFor(() => expect(importPickedFiles).toHaveBeenCalled());
      await act(async () => {
        visibilityState = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // Locking now would cancel the import, so content is hidden instead.
      expect(bridge.lock).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("heading", { name: "My records" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(TRANSFER_HOLD);

      await act(async () => {
        visibilityState = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // Coming back does not show the library again: the lock is still owed.
      expect(screen.getByText(TRANSFER_HOLD)).toBeVisible();

      await act(async () =>
        finishImport({ imported: ["FAKE.pdf"], skippedDuplicates: [] }),
      );
      expect(
        await screen.findByRole("heading", { name: "Unlock your vault" }),
      ).toBeVisible();
      expect(bridge.lock).toHaveBeenCalledOnce();
      // Whoever unlocks next learns how the import went.
      await expectOutcomeAfterUnlock("1 file(s) encrypted and imported.");

      // The held lock is spent: a transfer in the next session does not lock.
      await user.click(
        await screen.findByRole("button", { name: "Choose files to import" }),
      );
      await act(async () =>
        finishImport({ imported: [], skippedDuplicates: [] }),
      );
      expect(screen.getByRole("heading", { name: "My records" })).toBeVisible();
      expect(bridge.lock).toHaveBeenCalledOnce();

      // The outcome was shown once; later unlocks do not repeat it.
      await user.click(screen.getByRole("button", { name: /Lock now/ }));
      await user.type(
        await screen.findByLabelText("Passphrase"),
        "river-azimuth-cobalt-sparrow-934",
      );
      await user.click(screen.getByRole("button", { name: "Unlock" }));
      expect(await screen.findByText("Vault unlocked.")).toBeVisible();
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
    await user.click(
      await screen.findByRole("button", { name: "Choose files to import" }),
    );
    expect(
      await screen.findByText("1 file(s) encrypted and imported."),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Choose files to import" }),
    );
    await waitFor(() =>
      expect(bridge.importPickedFiles).toHaveBeenCalledTimes(2),
    );
    await user.click(screen.getByRole("button", { name: /Lock now/ }));
    await screen.findByRole("heading", { name: "Unlock your vault" });
    await user.type(
      screen.getByLabelText("Passphrase"),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("Vault unlocked.")).toBeVisible();
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
      await user.click(
        await screen.findByRole("button", { name: "Choose files to import" }),
      );
      await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
      visibility.mockReturnValue("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      visibility.mockReturnValue("visible");
      await act(async () =>
        finishImport({ imported: ["FAKE.pdf"], skippedDuplicates: [] }),
      );
      await screen.findByRole("heading", { name: "Unlock your vault" });

      await user.click(screen.getByText("Forgot your passphrase?"));
      await user.type(
        screen.getByLabelText("Type RESET MYCARLOS VAULT"),
        "RESET MYCARLOS VAULT",
      );
      await user.click(screen.getByRole("button", { name: "Erase vault" }));
      await user.type(
        await screen.findByLabelText("First patient profile"),
        "FAKE Tester",
      );
      await user.type(
        screen.getByLabelText("Passphrase"),
        "river-azimuth-cobalt-sparrow-934",
      );
      await user.type(
        screen.getByLabelText("Confirm passphrase"),
        "river-azimuth-cobalt-sparrow-934",
      );
      await user.click(screen.getByRole("button", { name: "Create vault" }));
      await user.click(await screen.findByRole("button", { name: /Lock now/ }));
      await user.type(
        await screen.findByLabelText("Passphrase"),
        "river-azimuth-cobalt-sparrow-934",
      );
      await user.click(screen.getByRole("button", { name: "Unlock" }));
      expect(await screen.findByText("Vault unlocked.")).toBeVisible();
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
        await screen.findByRole("heading", { name: "Unlock your vault" }),
      ).toBeVisible();
      expect(bridge.lock).toHaveBeenCalledOnce();
      // Not a change to the status line, which is not read out: the field
      // that takes focus says it.
      expect(screen.getByLabelText("Passphrase")).toHaveAccessibleDescription(
        "Vault locked.",
      );
    } finally {
      visibility.mockRestore();
    }
  });

  it("requires confirmation before permanently deleting a durable record", async () => {
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
    const deleteRecord = vi.fn().mockResolvedValue(undefined);
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({ ...emptySnapshot, records: [record] })
      .mockResolvedValueOnce(emptySnapshot);
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot,
      deleteRecord,
    });
    const shim = tauriConfirmShim();
    render(<VaultApp bridge={bridge} />);

    await user.click(await screen.findByText("FAKE_Report.pdf"));
    await user.click(
      screen.getByRole("button", { name: "Permanently delete" }),
    );
    const warning = screen.getByRole("alertdialog", {
      name: "Permanently delete this document?",
    });
    expect(warning).toHaveTextContent("FAKE_Report.pdf");
    expect(warning).toHaveTextContent("clinic's source medical record");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(deleteRecord).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(deleteRecord).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Permanently delete" }),
    );
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Permanently delete",
      }),
    );
    await waitFor(() => expect(deleteRecord).toHaveBeenCalledWith("record-1"));
    expect(
      await screen.findByText("FAKE_Report.pdf was permanently deleted."),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
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
      expect(screen.getByRole("heading", { name: "My records" })).toBeVisible();

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
        .mockResolvedValue({ ...emptySnapshot, records: [record] }),
    });
    render(<VaultApp bridge={bridge} />);
    const document = await screen.findByRole("article", {
      name: "FAKE_Stay.pdf document",
    });
    const pane = screen.getByRole("main");

    const transfer = dragTransfer();
    fireDragEvent("dragstart", document, { dataTransfer: transfer });
    fireDragEvent("dragover", pane, { dataTransfer: transfer });
    fireDragEvent("drop", pane, { dataTransfer: transfer });
    await act(async () => undefined);

    expect(bridge.assignFoldersBatch).not.toHaveBeenCalled();
    expect(screen.queryByText(/moved to/)).not.toBeInTheDocument();
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
      await user.click(
        await screen.findByRole("button", { name: "Choose files to import" }),
      );
      await waitFor(() => expect(pickImportFiles).toHaveBeenCalled());

      await act(async () => {
        visibilityState = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(bridge.lock).not.toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: "My records" })).toBeVisible();

      // The picker returns while the app is still hidden: the user left with
      // it open, so this is a backgrounding after all.
      await act(async () => finishPick("pick-1"));
      await waitFor(() => expect(bridge.lock).toHaveBeenCalledOnce());
      expect(
        await screen.findByRole("heading", { name: "Unlock your vault" }),
      ).toBeVisible();
    } finally {
      visibility.mockRestore();
    }
  });

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
      await user.click(
        await screen.findByRole("button", { name: "Choose files to import" }),
      );
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
        await screen.findByText("1 file(s) encrypted and imported."),
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Choose files to import" }),
        );
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Choose files to import" }),
        );
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Choose files to import" }),
        );
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Choose files to import" }),
        );
      });
      // Timers do not run while the page is suspended under Android's picker
      // activity, so no recheck sees the picker open.
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      await act(async () => finishPick(null));
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(bridge.lock).not.toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: "My records" })).toBeVisible();

      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
      expect(bridge.lock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides content at the deadline during an export and locks once it finishes", async () => {
    vi.useFakeTimers();
    try {
      let failExport!: (error: unknown) => void;
      const bridge = nativeBridge({
        status: vi.fn().mockResolvedValue("unlocked"),
        snapshot: vi.fn().mockResolvedValue(snapshotWithRecord),
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
      expect(screen.getByText(TRANSFER_HOLD)).toBeVisible();
      expect(
        screen.queryByRole("heading", { name: "My records" }),
      ).not.toBeInTheDocument();
      // Rechecks keep waiting rather than locking under the transfer.
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(bridge.lock).not.toHaveBeenCalled();

      // A failed transfer settles it too.
      await act(async () => failExport(new Error("disk full")));
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("heading", { name: "Unlock your vault" }),
      ).toBeVisible();
    } finally {
      vi.useRealTimers();
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
      lock: vi.fn().mockRejectedValue(storageError),
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
      await user.click(await screen.findByRole("button", { name: /Lock now/ }));
      await waitFor(() => expect(bridge.lock).toHaveBeenCalledOnce());
      await user.click(
        screen.getByRole("button", { name: "Choose files to import" }),
      );
      await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
      visibility.mockReturnValue("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // The earlier manual failure is not this lock's.
      expect(screen.getByText(TRANSFER_HOLD)).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      await act(async () =>
        finishImport({ imported: [], skippedDuplicates: [] }),
      );
      expect(bridge.lock).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "myCarlos could not lock the vault.",
      );
      expect(screen.queryByText(TRANSFER_HOLD)).not.toBeInTheDocument();
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
        let finishRefresh!: (value: VaultSnapshot) => void;
        const bridge = nativeBridge({
          status: vi.fn().mockResolvedValue("unlocked"),
          snapshot: vi
            .fn()
            .mockResolvedValueOnce(emptySnapshot)
            .mockImplementationOnce(
              () =>
                new Promise<VaultSnapshot>((resolve) => {
                  finishRefresh = resolve;
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
        await act(async () => {
          fireEvent.click(
            screen.getByRole("button", { name: "Choose files to import" }),
          );
        });
        const finish = () =>
          act(async () =>
            finishImport({ imported: ["FAKE.pdf"], skippedDuplicates: [] }),
          );
        if (dueFirst) {
          await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
          expect(screen.getByText(TRANSFER_HOLD)).toBeVisible();
          // The transfer is done, but its operation is still refreshing the
          // library when the next recheck runs.
          await finish();
          await act(async () => vi.advanceTimersByTime(10_000));
        } else {
          await finish();
          await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
        }
        expect(bridge.lock).not.toHaveBeenCalled();
        expect(screen.getByText(TRANSFER_HOLD)).toBeVisible();

        await act(async () => finishRefresh(emptySnapshot));
        expect(bridge.lock).toHaveBeenCalledOnce();
        await expectOutcomeAfterUnlock("1 file(s) encrypted and imported.");
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Choose files to import" }),
        );
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Choose files to import" }),
        );
      });
      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
      expect(screen.getByText(TRANSFER_HOLD)).toBeVisible();
      // A large transfer on a slow connection is not cut off.
      await act(async () => vi.advanceTimersByTime(3 * 60 * 60 * 1000));
      expect(bridge.lock).not.toHaveBeenCalled();
      expect(screen.getByText(TRANSFER_HOLD)).toBeVisible();
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Choose files to import" }),
        );
      });
      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
      await act(async () =>
        finishImport({ imported: ["FAKE.pdf"], skippedDuplicates: [] }),
      );
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "myCarlos could not lock the vault.",
      );
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(bridge.lock).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Vault locked.")).toBeVisible();

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
        fireEvent.change(screen.getByLabelText("Passphrase"), {
          target: { value: "river-azimuth-cobalt-sparrow-934" },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
      });
      // The import's outcome is kept; the failed lock's error is not.
      await passAnnounceDelay();
      expect(
        screen.getByText("Vault unlocked. 1 file(s) encrypted and imported."),
      ).toBeVisible();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Choose files to import" }),
        );
      });
      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
      expect(screen.getByText(TRANSFER_HOLD)).toBeVisible();
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
      await user.click(
        await screen.findByRole("button", { name: "Choose files to import" }),
      );
      await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
      visibility.mockReturnValue("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      visibility.mockReturnValue("visible");
      await user.click(
        screen.getByRole("button", {
          name: "Lock now and cancel the transfer",
        }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        storageError.message,
      );

      await act(async () => failImport(storageError));
      await screen.findByText("Vault locked.");
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
      snapshot: vi.fn().mockResolvedValue(snapshotWithRecord),
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
      await user.click(await screen.findByText("FAKE_Results.pdf"));
      await user.click(
        screen.getByRole("button", { name: "Save a copy to this computer" }),
      );
      await user.click(screen.getByRole("button", { name: "Save a copy" }));
      await waitFor(() => expect(bridge.exportToPicked).toHaveBeenCalled());
      visibility.mockReturnValue("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      visibility.mockReturnValue("visible");
      await user.click(
        screen.getByRole("button", {
          name: "Lock now and cancel the transfer",
        }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "myCarlos could not lock the vault.",
      );

      // The export then fails, and the lock that follows succeeds.
      await act(async () => failExport(PARTIAL_EXPORT));
      await screen.findByText("Vault locked.");
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Choose files to import" }),
        );
      });
      expect(bridge.importPickedFiles).toHaveBeenCalled();
      // Lock now succeeds, and the app is hidden before the screen updates.
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Lock now/ }));
        await Promise.resolve();
        await Promise.resolve();
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => failImport(CANCELLED));
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(screen.getByText("Vault locked.")).toBeVisible();
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Choose files to import" }),
        );
      });
      expect(bridge.importPickedFiles).toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000 - 1000));
      expect(bridge.lock).not.toHaveBeenCalled();
      // Lock now succeeds, and the deadline's recheck runs before the screen
      // updates.
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Lock now/ }));
        await Promise.resolve();
        await Promise.resolve();
        vi.advanceTimersByTime(1000);
      });
      await act(async () => failImport(CANCELLED));
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(screen.getByText("Vault locked.")).toBeVisible();
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
    await user.click(await screen.findByRole("button", { name: "New folder" }));
    await user.type(screen.getByLabelText("Folder name"), "Labs");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Labs was created.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Lock now/ }));
    expect(
      await screen.findByRole("heading", { name: "Unlock your vault" }),
    ).toBeVisible();
    expect(screen.getByText("Vault locked.")).toBeVisible();
    expect(screen.queryByText(/Labs/)).not.toBeInTheDocument();
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
      await user.click(
        await screen.findByRole("button", { name: "Choose files to import" }),
      );
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
      await user.click(
        await screen.findByRole("button", { name: "Choose files to import" }),
      );
      await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
      visibility.mockReturnValue("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      visibility.mockReturnValue("visible");

      await user.click(
        screen.getByRole("button", {
          name: "Lock now and cancel the transfer",
        }),
      );
      expect(bridge.lock).toHaveBeenCalledOnce();
      expect(
        await screen.findByRole("heading", { name: "Unlock your vault" }),
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
        snapshot: vi.fn().mockResolvedValue(snapshotWithRecord),
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
        await user.click(await screen.findByText("FAKE_Results.pdf"));
        await user.click(
          screen.getByRole("button", { name: "Save a copy to this computer" }),
        );
        await user.click(screen.getByRole("button", { name: "Save a copy" }));
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
            name: held ? "Lock now and cancel the transfer" : /Lock now/,
          }),
        );
        await screen.findByRole("heading", { name: "Unlock your vault" });
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
        await user.click(
          await screen.findByRole("button", { name: "Choose files to import" }),
        );
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
            name: "Lock now and cancel the transfer",
          }),
        );
        await screen.findByRole("heading", { name: "Unlock your vault" });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
        expect(screen.getByText("Vault locked.")).toBeVisible();
        expect(screen.queryByText(/operation stopped/)).not.toBeInTheDocument();
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

      fireEvent.click(screen.getByRole("button", { name: "Security" }));
      await act(async () => {
        fireEvent.change(
          screen.getByRole("combobox", { name: "Automatic lock delay" }),
          { target: { value: "1" } },
        );
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
        await user.click(
          await screen.findByRole("button", { name: "Choose files to import" }),
        );
        await waitFor(() =>
          expect(bridge.importPickedFiles).toHaveBeenCalled(),
        );
        if (held) {
          visibility.mockReturnValue("hidden");
          await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
          });
          visibility.mockReturnValue("visible");
          expect(screen.getByText(TRANSFER_HOLD)).toBeVisible();
        }

        await act(async () => failImport(error));
        // Content is hidden while that lock is confirmed.
        expect(
          screen.queryByRole("heading", { name: "My records" }),
        ).not.toBeInTheDocument();
        await act(async () => finishLock());
        expect(
          await screen.findByRole("heading", { name: "Unlock your vault" }),
        ).toBeVisible();
        // A cancel is not proof that the vault locked, so it is locked here.
        expect(bridge.lock).toHaveBeenCalledOnce();
        if (outcome) await expectOutcomeAfterUnlock(outcome);
        else expect(screen.getByText("Vault locked.")).toBeVisible();
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
    await user.click(await screen.findByRole("button", { name: "New folder" }));
    await user.type(screen.getByLabelText("Folder name"), "Labs");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(
      await screen.findByRole("heading", { name: "Unlock your vault" }),
    ).toBeVisible();
    expect(screen.getByText("Vault locked.")).toBeVisible();
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
      await user.click(
        await screen.findByRole("button", { name: "Choose files to import" }),
      );
      await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
      if (shown) expect(screen.getByText(IOS_PAUSE)).toBeVisible();
      else expect(screen.queryByText(IOS_PAUSE)).not.toBeInTheDocument();
    },
  );

  it("keeps Lock now available while an operation is running", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      importPickedFiles: vi.fn(() => new Promise<never>(() => undefined)),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(
      await screen.findByRole("button", { name: /Choose files to import/ }),
    );
    await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
    // Locking is what cancels streaming I/O, so it must stay reachable.
    expect(screen.getByRole("button", { name: /Lock now/ })).toBeEnabled();
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
        .mockResolvedValue({ ...emptySnapshot, records: [record] }),
      pickExportDestination: vi.fn().mockResolvedValue(null),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(await screen.findByText("FAKE_Copy.pdf"));
    await user.click(
      screen.getByRole("button", { name: "Save a copy to this computer" }),
    );
    await user.click(screen.getByRole("button", { name: "Save a copy" }));

    // The page behind a modal is inert, so its status line is not announced.
    const details = await screen.findByRole("dialog", {
      name: "FAKE_Copy.pdf",
    });
    await waitFor(() =>
      expect(within(details).getByRole("status")).toHaveTextContent(
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
      expect(screen.getByRole("alert")).toHaveTextContent(
        "the vault is still open",
      );
      expect(
        screen.queryByRole("heading", { name: "My records" }),
      ).not.toBeInTheDocument();

      await act(async () => vi.advanceTimersByTime(10 * 1000));
      expect(lock).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Vault locked.")).toBeVisible();
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
      expect(screen.getByText("Vault locked.")).toBeVisible();
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
        .mockResolvedValue({ ...emptySnapshot, records: [record] }),
      pickImportFiles: vi.fn().mockResolvedValue(null),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(
      await screen.findByRole("button", { name: "Choose files to import" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).not.toBeEmptyDOMElement(),
    );
    const earlierNotice = screen.getByRole("status").textContent ?? "";

    await user.click(screen.getByText("FAKE_Other.pdf"));
    const details = await screen.findByRole("dialog", {
      name: "FAKE_Other.pdf",
    });
    expect(details).not.toHaveTextContent(earlierNotice);
  });

  it("does not show an earlier manual lock failure while a later automatic lock is pending", async () => {
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
        fireEvent.click(screen.getByRole("button", { name: /Lock now/ }));
      });
      expect(lock).toHaveBeenCalledOnce();

      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
      expect(lock).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByText(/finishes locking/)).toBeVisible();

      await act(async () => finishLock());
      expect(screen.getByText("Vault locked.")).toBeVisible();
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
    let deliverSnapshot: (value: VaultSnapshot) => void = () => undefined;
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({ ...emptySnapshot, records: [record] })
      .mockImplementationOnce(
        () =>
          new Promise<VaultSnapshot>((resolve) => {
            deliverSnapshot = resolve;
          }),
      );
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot,
      unlock: vi.fn().mockResolvedValue({
        ...emptySnapshot,
        records: [{ ...record, displayName: "FAKE_Current.pdf" }],
      }),
      renameRecord: vi.fn().mockResolvedValue(undefined),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(await screen.findByText("FAKE_Late.pdf"));
    await user.click(screen.getByRole("button", { name: "Rename document" }));
    await user.clear(screen.getByLabelText("File name"));
    await user.type(screen.getByLabelText("File name"), "FAKE_Renamed.pdf");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));

    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      expect(await screen.findByText("Vault locked.")).toBeVisible();
    } finally {
      visibility.mockRestore();
    }

    // Unlocked again before the earlier session's refresh returns: that result
    // must not replace the new session's library.
    await user.type(
      screen.getByLabelText("Passphrase"),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("FAKE_Current.pdf")).toBeVisible();

    await act(async () =>
      deliverSnapshot({
        ...emptySnapshot,
        records: [{ ...record, displayName: "FAKE_Renamed.pdf" }],
      }),
    );
    expect(screen.getByText("FAKE_Current.pdf")).toBeVisible();
    expect(screen.queryByText(/FAKE_Renamed/)).not.toBeInTheDocument();
  });

  it("persists a bounded automatic lock delay", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: "My records" });

    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    const delay = screen.getByRole("combobox", {
      name: "Automatic lock delay",
    });
    expect(delay).toHaveValue("5");
    fireEvent.change(delay, { target: { value: "1" } });

    expect(delay).toHaveValue("1");
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
    await screen.findByRole("heading", { name: "My records" });
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    expect(
      screen.getByRole("combobox", { name: "Automatic lock delay" }),
    ).toHaveValue("15");
    first.unmount();

    window.localStorage.setItem("mycarlos.autoLockMinutes.v1", "999");
    render(
      <VaultApp
        bridge={nativeBridge({ status: vi.fn().mockResolvedValue("unlocked") })}
      />,
    );
    await screen.findByRole("heading", { name: "My records" });
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    expect(
      screen.getByRole("combobox", { name: "Automatic lock delay" }),
    ).toHaveValue("5");
  });

  it("requires the exact destructive reset phrase", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge();
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: "Unlock your vault" });
    await user.click(screen.getByText("Forgot your passphrase?"));
    const erase = screen.getByRole("button", { name: "Erase vault" });
    expect(erase).toBeDisabled();
    await user.type(
      screen.getByLabelText("Type RESET MYCARLOS VAULT"),
      "RESET MYCARLOS VAULT",
    );
    expect(erase).toBeEnabled();
    await user.click(erase);
    await waitFor(() =>
      expect(bridge.reset).toHaveBeenCalledWith("RESET MYCARLOS VAULT"),
    );
  });

  it("shows the unlock screen when erasing the vault fails, because the session is already closed", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      reset: vi.fn().mockRejectedValue({
        code: "storage",
        message: "The storage operation could not be completed.",
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: "My records" });

    await user.click(screen.getByRole("button", { name: "Security" }));
    await user.click(screen.getByText("Show reset controls"));
    await user.type(
      screen.getByLabelText("Type RESET MYCARLOS VAULT"),
      "RESET MYCARLOS VAULT",
    );
    await user.click(
      screen.getByRole("button", { name: "Erase entire vault" }),
    );
    expect(bridge.reset).toHaveBeenCalledOnce();

    expect(
      await screen.findByRole("heading", { name: "Unlock your vault" }),
    ).toBeVisible();
    expect(
      screen.getByText("The storage operation could not be completed."),
    ).toBeVisible();
  });

  it("offers to create a vault when erasing from the library finds none", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      reset: vi.fn().mockRejectedValue({
        code: "missing",
        message: "No vault exists on this device.",
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: "My records" });
    await user.click(screen.getByRole("button", { name: "Security" }));
    await user.click(screen.getByText("Show reset controls"));
    await user.type(
      screen.getByLabelText("Type RESET MYCARLOS VAULT"),
      "RESET MYCARLOS VAULT",
    );
    await user.click(
      screen.getByRole("button", { name: "Erase entire vault" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Create your encrypted vault",
      }),
    ).toBeVisible();
    expect(screen.getByText("No vault exists on this device.")).toBeVisible();
  });

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
    await user.click(await screen.findByRole("button", { name: "New folder" }));
    await user.type(screen.getByLabelText("Folder name"), "Labs");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(
      await screen.findByText("No vault exists on this device."),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "My records" })).toBeVisible();
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
    await user.click(await screen.findByRole("button", { name: "New folder" }));
    await user.type(screen.getByLabelText("Folder name"), "Labs");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await user.click(screen.getByRole("button", { name: /Lock now/ }));
    await screen.findByRole("heading", { name: "Unlock your vault" });
    await act(async () =>
      failCreate({ code: "locked", message: "Unlock the vault to continue." }),
    );
    expect(screen.getByText("Vault locked.")).toBeVisible();
  });

  it("keeps a refused profile name in the form and clears an accepted one", async () => {
    const user = userEvent.setup();
    const createProfile = vi
      .fn()
      .mockRejectedValueOnce({
        code: "invalid",
        message: "Check the requested information and try again.",
      })
      .mockResolvedValue(undefined);
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      createProfile,
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByRole("heading", { name: "My records" });
    await user.click(screen.getByRole("button", { name: "Security" }));

    const name = screen.getByLabelText("New profile name");
    await user.type(name, "Jamie's parent");
    await user.click(screen.getByRole("button", { name: "Add profile" }));
    await waitFor(() => expect(createProfile).toHaveBeenCalledOnce());
    expect(name).toHaveValue("Jamie's parent");

    await user.click(screen.getByRole("button", { name: "Add profile" }));
    await waitFor(() => expect(name).toHaveValue(""));
  });

  it("clears unfinished passphrase fields when leaving Security", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(await screen.findByRole("button", { name: "Security" }));
    fireEvent.change(screen.getByLabelText("Current passphrase"), {
      target: { value: "fake-current-secret" },
    });
    fireEvent.change(screen.getByLabelText("New passphrase"), {
      target: { value: "fake-replacement-secret" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new passphrase"), {
      target: { value: "fake-replacement-secret" },
    });
    await user.click(
      within(
        screen.getByRole("navigation", { name: "Record library" }),
      ).getByRole("button", { name: /My records/ }),
    );
    await user.click(screen.getByRole("button", { name: "Security" }));
    expect(screen.getByLabelText("Current passphrase")).toHaveValue("");
    expect(screen.getByLabelText("New passphrase")).toHaveValue("");
    expect(screen.getByLabelText("Confirm new passphrase")).toHaveValue("");
    expect(bridge.changePassphrase).not.toHaveBeenCalled();
  });

  it("requires matching replacement passphrases", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(await screen.findByRole("button", { name: "Security" }));

    await user.type(
      screen.getByLabelText("Current passphrase"),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.type(
      screen.getByLabelText("New passphrase"),
      "lantern-orbit-willow-cascade-572",
    );
    await user.type(
      screen.getByLabelText("Confirm new passphrase"),
      "different replacement",
    );
    expect(
      screen.getByRole("button", { name: "Change passphrase" }),
    ).toBeDisabled();
    await user.clear(screen.getByLabelText("Confirm new passphrase"));
    await user.type(
      screen.getByLabelText("Confirm new passphrase"),
      "lantern-orbit-willow-cascade-572",
    );
    await user.click(screen.getByRole("button", { name: "Change passphrase" }));

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
        .mockResolvedValue({ ...emptySnapshot, records: [record] }),
    });
    render(<VaultApp bridge={bridge} />);
    const opener = await screen.findByRole("button", {
      name: "FAKE_Report.pdf",
    });
    await user.click(opener);
    const close = screen.getByRole("button", {
      name: "Close document details",
    });
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(
      screen.getByRole("button", { name: "Save a copy to this computer" }),
    ).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

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
        .mockResolvedValue({ ...emptySnapshot, records: [record] }),
    });
    render(<VaultApp bridge={bridge} />);
    const opener = await screen.findByRole("button", {
      name: "FAKE_Report.pdf",
    });
    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Rename document" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(
      screen.getByRole("button", { name: "Close document details" }),
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
    await user.click(await screen.findByRole("button", { name: /Lock now/ }));
    expect(bridge.lock).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(/storage operation could not be completed/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Lock now/ })).toBeEnabled();
  });

  it("marks a document whose encrypted file is missing and blocks saving it", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockResolvedValue({
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
    });
    render(<VaultApp bridge={bridge} />);
    expect(
      await screen.findByText(/Some encrypted files are missing/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Damaged: file missing/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "FAKE_Lost.pdf" }));
    expect(screen.getByText("This document is damaged.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save a copy to this computer" }),
    ).toBeDisabled();
  });

  it("removes damaged documents from the recovery banner after confirmation", async () => {
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
    const removeUnavailableRecords = vi.fn().mockResolvedValue(["record-lost"]);
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi
        .fn()
        .mockResolvedValueOnce({
          ...emptySnapshot,
          recovery: "lostObjects",
          records: [lost, kept],
        })
        .mockResolvedValue({
          ...emptySnapshot,
          recovery: null,
          records: [kept],
        }),
      removeUnavailableRecords,
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(
      await screen.findByRole("button", { name: "Remove damaged documents" }),
    );
    const warning = screen.getByRole("alertdialog", {
      name: "Permanently remove 1 damaged document?",
    });
    expect(warning).toHaveAccessibleDescription(/permanently/);
    expect(warning).toHaveTextContent(/cannot be undone/);
    // The files may only be out of reach, which is not the same as gone.
    expect(warning).toHaveTextContent(/drive that is disconnected/);
    expect(warning).toHaveTextContent(/backup/);
    // Nothing is removed without an explicit confirmation: Cancel has focus,
    // and Cancel, Escape and a click outside all leave everything in place.
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    // Enter straight away presses Cancel, which has focus.
    await user.click(
      screen.getByRole("button", { name: "Remove damaged documents" }),
    );
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Remove damaged documents" }),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Remove damaged documents" }),
    );
    await user.pointer({
      keys: "[MouseLeft]",
      target: screen.getByRole("alertdialog").parentElement!,
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(removeUnavailableRecords).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Remove damaged documents" }),
    );
    const remove = screen.getByRole("button", { name: "Permanently remove" });
    expect(remove).toHaveClass("danger");
    await user.click(remove);
    await waitFor(() =>
      expect(removeUnavailableRecords).toHaveBeenCalledOnce(),
    );
    // It names the documents that were shown as damaged.
    expect(removeUnavailableRecords).toHaveBeenCalledWith(["record-lost"]);
    expect(
      await screen.findByText(
        "1 damaged document removed. The vault accepts changes again.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(/Read-only recovery mode/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("FAKE_Lost.pdf")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New folder" })).toBeEnabled();
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
        .mockResolvedValueOnce({
          ...emptySnapshot,
          recovery: "lostObjects",
          records: [lost],
        })
        // The removal committed, but its redundant write failed.
        .mockResolvedValue({ ...emptySnapshot, recovery: "writeFailed" }),
      removeUnavailableRecords: vi.fn().mockResolvedValue(["record-lost"]),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(
      await screen.findByRole("button", { name: "Remove damaged documents" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Permanently remove" }),
    );

    expect(
      await screen.findByText(/1 damaged document removed/),
    ).not.toHaveTextContent(/accepts changes/);
    expect(screen.getByText(/A write to the vault failed/)).toBeVisible();
  });

  it("offers no removal when recovery is not about missing files", async () => {
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockResolvedValue({
        ...emptySnapshot,
        recovery: "unreadableSlot",
      }),
    });
    render(<VaultApp bridge={bridge} />);
    expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove damaged documents" }),
    ).not.toBeInTheDocument();
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
        .mockResolvedValueOnce({
          ...emptySnapshot,
          recovery: "lostObjects",
          records: [record("a", false), record("b", true)],
        })
        // Another file went missing before the removal ran.
        .mockResolvedValue({
          ...emptySnapshot,
          recovery: "lostObjects",
          records: [record("a", false), record("b", false)],
        }),
      removeUnavailableRecords: vi.fn().mockRejectedValue({
        code: "removal_changed",
        message: "FAKE the vault changed.",
      }),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: "Remove damaged documents" }),
    );
    const confirmation = screen.getByRole("alertdialog", {
      name: "Permanently remove 1 damaged document?",
    });
    expect(confirmation).toBeVisible();
    // It names what would be removed, and nothing else.
    const named = within(confirmation).getByRole("list", {
      name: "Documents to remove",
    });
    expect(within(named).getAllByRole("listitem")).toHaveLength(1);
    expect(named).toHaveTextContent("FAKE_a.pdf");
    const asked = vi.mocked(bridge.snapshot).mock.calls.length;
    await user.click(
      screen.getByRole("button", { name: "Permanently remove" }),
    );
    expect(await screen.findByText("FAKE the vault changed.")).toBeVisible();
    // The refusal itself made the screen ask the vault again.
    expect(vi.mocked(bridge.snapshot).mock.calls.length).toBeGreaterThan(asked);
    expect(bridge.removeUnavailableRecords).toHaveBeenCalledWith(["a"]);
    // The next confirmation counts what is damaged now.
    await user.click(
      screen.getByRole("button", { name: "Remove damaged documents" }),
    );
    expect(
      screen.getByRole("alertdialog", {
        name: "Permanently remove 2 damaged documents?",
      }),
    ).toBeVisible();
  });

  it("does not call a document missing when files could not be read", async () => {
    const user = userEvent.setup();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockResolvedValue({
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
    });
    render(<VaultApp bridge={bridge} />);
    expect(await screen.findByText(/File unavailable/)).toBeVisible();
    expect(screen.queryByText(/Damaged: file missing/)).not.toBeInTheDocument();
    expect(screen.getByText(/keeps its files on this device/)).toBeVisible();
    await user.click(screen.getByText("FAKE_Unreadable.pdf"));
    expect(
      within(screen.getByRole("dialog")).getByRole("alert"),
    ).toHaveTextContent("This document is unavailable.");
  });

  it("renders hostile durable metadata only as text and surfaces recovery mode", async () => {
    const hostileName =
      '<img src="https://attacker.invalid/leak">\u202ereport.pdf';
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockResolvedValue({
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
    });
    render(<VaultApp bridge={bridge} />);

    expect(await screen.findByText(hostileName)).toBeVisible();
    expect(
      document.querySelector('img[src="https://attacker.invalid/leak"]'),
    ).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Read-only recovery mode",
    );
    expect(
      screen.getByRole("button", { name: "Choose files to import" }),
    ).toBeDisabled();
  });

  it("has no automatically detectable WCAG A or AA violations in durable states", async () => {
    const axeOptions = {
      runOnly: {
        type: "tag" as const,
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      },
    };
    const locked = render(<VaultApp bridge={nativeBridge()} />);
    await screen.findByRole("heading", { name: "Unlock your vault" });
    expect((await axe.run(document.body, axeOptions)).violations).toEqual([]);
    locked.unmount();

    render(
      <VaultApp
        bridge={nativeBridge({ status: vi.fn().mockResolvedValue("unlocked") })}
      />,
    );
    await screen.findByRole("heading", { name: "My records" });
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
    await screen.findByRole("heading", { name: "Unlock your vault" });
    await expectOutcomeAfterUnlock("1 file(s) encrypted and imported.");
    await user.click(screen.getByRole("button", { name: /Lock now/ }));
    await screen.findByLabelText("Passphrase");
    await expectNothingKeptAfterUnlock();
  });

  // The old vault's outcome must not reach a new one.
  it("does not carry a kept outcome into a vault created after the old one went missing", async () => {
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
    const user = await holdLockForImport(bridge, () =>
      finishImport({ imported: ["FAKE.pdf"], skippedDuplicates: [] }),
    );
    await screen.findByRole("heading", { name: "Unlock your vault" });
    vi.mocked(bridge.unlock).mockRejectedValueOnce({
      code: "missing",
      message: "No vault was found.",
    });
    await user.type(
      screen.getByLabelText("Passphrase"),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await user.type(
      await screen.findByLabelText("First patient profile"),
      "FAKE Tester",
    );
    await user.type(
      screen.getByLabelText("Passphrase"),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.type(
      screen.getByLabelText("Confirm passphrase"),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: "Create vault" }));
    await user.click(await screen.findByRole("button", { name: /Lock now/ }));
    await screen.findByLabelText("Passphrase");
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
      await screen.findByRole("button", { name: "Try locking again" }),
    );
    await screen.findByRole("heading", { name: "Unlock your vault" });
    await expectOutcomeAfterUnlock("1 file(s) encrypted and imported.");
  });

  // A notice from something else during the transfer is not how it went.
  it("does not keep an unrelated notice as the outcome of a transfer a manual lock cancels", async () => {
    const user = userEvent.setup();
    let failExport!: (error: unknown) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockResolvedValue(snapshotWithRecord),
      pickExportDestination: vi.fn().mockResolvedValue("pick-1"),
      exportToPicked: vi.fn(
        () =>
          new Promise<void>((_, reject) => {
            failExport = reject;
          }),
      ),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByText("FAKE_Results.pdf");
    await startExport();
    await waitFor(() => expect(bridge.exportToPicked).toHaveBeenCalled());
    const files = new DataTransfer();
    files.items.add(new File(["x"], "FAKE.pdf", { type: "application/pdf" }));
    await act(async () => {
      fireDragEvent("drop", window, { dataTransfer: files });
    });
    await user.click(screen.getByRole("button", { name: /Lock now/ }));
    await screen.findByRole("heading", { name: "Unlock your vault" });
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
        snapshot: vi.fn().mockResolvedValue(snapshotWithRecord),
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
      await screen.findByText("FAKE_Results.pdf");
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
      await user.click(screen.getByRole("button", { name: /Lock now/ }));
      await screen.findByRole("heading", { name: "Unlock your vault" });
      await expectOutcomeAfterUnlock(PARTIAL_EXPORT.message);
    },
  );

  it("keeps a completed export's result that arrives after Lock now has locked", async () => {
    const user = userEvent.setup();
    let finishExport!: () => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockResolvedValue(snapshotWithRecord),
      pickExportDestination: vi.fn().mockResolvedValue("pick-1"),
      exportToPicked: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishExport = resolve;
          }),
      ),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByText("FAKE_Results.pdf");
    await startExport();
    await waitFor(() => expect(bridge.exportToPicked).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: /Lock now/ }));
    await screen.findByRole("heading", { name: "Unlock your vault" });
    // The copy was already written when the cancel arrived.
    await act(async () => finishExport());
    await expectOutcomeAfterUnlock(
      "A readable copy was saved to this computer.",
    );
  });

  // A provider export cut off by the native deadline fails as a partial copy,
  // not as cancelled; the screen checks whether the vault locked.
  it("keeps the partial-copy warning when the native deadline locks during a provider export", async () => {
    let failExport!: (error: unknown) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockResolvedValue(snapshotWithRecord),
      pickExportDestination: vi.fn().mockResolvedValue("pick-1"),
      exportToPicked: vi.fn(
        () =>
          new Promise<void>((_, reject) => {
            failExport = reject;
          }),
      ),
    });
    render(<VaultApp bridge={bridge} />);
    await screen.findByText("FAKE_Results.pdf");
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
    await screen.findByRole("heading", { name: "Unlock your vault" });
    vi.mocked(bridge.snapshot).mockResolvedValue(snapshotWithRecord);
    await expectOutcomeAfterUnlock(PARTIAL_EXPORT.message);
  });
});

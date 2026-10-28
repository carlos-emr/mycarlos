import { humanText } from "./test/humanText";
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
import { StrictMode } from "react";
import VaultApp from "./VaultApp";
import type {
  ImportOutcome,
  SavedBackup,
  VaultBridge,
  VaultSnapshot,
  ViewedPage,
} from "./vault";
import { ANNOUNCE_DELAY_MS } from "./native/announce";
import { setLocaleOverride, translate } from "./i18n";

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
    recoveryKeyLabel: vi.fn().mockResolvedValue("7F3A"),
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
    isLockedPdf: vi.fn().mockResolvedValue(false),
    unlockPdf: vi.fn(),
    viewPhoto: vi
      .fn()
      .mockRejectedValue({ code: "not_a_photo", message: "FAKE not a photo." }),
    hideRecord: vi.fn().mockResolvedValue(undefined),
    unhideRecord: vi.fn().mockResolvedValue(undefined),
    hideUnavailableRecords: vi.fn().mockResolvedValue([]),
    listReceived: vi.fn().mockResolvedValue({
      files: [],
      notice: { dropped: 0, refusedShares: 0 },
    }),
    acceptReceived: vi
      .fn()
      .mockResolvedValue({ imported: [], skippedDuplicates: [], notPdf: [] }),
    moveToPerson: vi.fn().mockResolvedValue({ moved: [], alreadyThere: [] }),
    viewPage: vi
      .fn()
      .mockRejectedValue(new Error("FAKE: no reader in this test")),
    cancelView: vi.fn().mockResolvedValue(undefined),
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
        name: humanText("Save a copy to this computer"),
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
  await user.click(
    await screen.findByRole("button", {
      name: humanText("Choose files to import"),
    }),
  );
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
    await continuePastComfort();
    await screen.findByRole("heading", {
      name: humanText("Set up myCarlos on this computer"),
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
      name: humanText("Set up myCarlos on this computer"),
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
      name: humanText("Set up myCarlos on this computer"),
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
        name: humanText("Set up myCarlos on this computer"),
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

    await screen.findByRole("heading", {
      name: humanText("Unlock your vault"),
    });
    await user.type(
      screen.getByLabelText(humanText("Passphrase")),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    await user.click(
      await screen.findByRole("button", {
        name: humanText("Choose files to import"),
      }),
    );

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
      unlock: vi.fn(async () => structuredClone(vault)),
      snapshot: vi.fn(async () => structuredClone(vault)),
      listReceived: vi.fn(async () => ({
        files: structuredClone(queue),
        notice: { dropped: 0, refusedShares: 0 },
      })),
      acceptReceived: vi.fn(async () => {
        const added = queue.filter((file) => file.name.endsWith(".pdf"));
        const notPdf = queue
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
        queue = [];
        return {
          imported: added.map((file) => `record-${file.id}`),
          skippedDuplicates: [],
          notPdf,
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
      const captured = structuredClone(vault);
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
      const captured = structuredClone(vault);
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
          "2 shared files are waiting. Unlock and they go into Shared with me. If myCarlos closes first, they are not kept: share them again.",
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
    // one's records (Ben, 21 Oct).
    const mine = within(
      screen.getByRole("navigation", { name: humanText("Record library") }),
    ).getByRole("button", { name: humanText(/^My records/) });
    expect(
      mine.compareDocumentPosition(folder) & Node.DOCUMENT_POSITION_FOLLOWING,
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
    // Nothing is made in it.
    for (const name of ["Choose files to import", "New folder"])
      expect(screen.queryByRole("button", { name })).toBeNull();
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
      // Reopening the selected Hidden entry must retain Shared as its source.
      await user.click(
        screen.getByRole("button", { name: humanText(/^Hidden/) }),
      );
      expect(
        screen.getByRole("article", {
          name: humanText("FAKE_Shared.pdf, hidden"),
        }),
      ).toBeVisible();
      expect(
        within(row).getByText(humanText("Shared with me")),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("complementary", { hidden: true }),
      ).toHaveHumanTextContent("1 document · 0 folders");
      expect(
        screen.queryByText(humanText("FAKE_Jamie_hidden.pdf")),
      ).not.toBeInTheDocument();
      await user.click(
        within(row).getByRole("button", {
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

  it("with several people, keeps Shared with me outside everyone's records and moves the selected to one person (#61)", async () => {
    const user = userEvent.setup();
    const { bridge } = sharedVault(["Jamie", "Morgan"], ["FAKE_Xray.pdf"]);
    render(<VaultApp bridge={bridge} />);
    await unlockWith(user);
    const folder = await screen.findByRole("button", {
      name: humanText("Shared with me, 1 new"),
    });
    // Each person is a top-level folder, and Shared with me is one beside
    // them, after both and inside neither (Ben, 21 Oct).
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
          Node.DOCUMENT_POSITION_FOLLOWING,
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

  it("with several people, lists every person's folders, and counts the whole vault while Shared with me is open (#61)", async () => {
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
    // Jamie's folder sits under Jamie; the footer counts Jamie's.
    expect(names()).toEqual(["Jamie", "FAKE Labs", "Morgan", "Shared with me"]);
    expect(footer()).toHaveHumanTextContent("0 documents · 1 folder");

    await user.click(shared);
    await screen.findByRole("heading", { name: humanText("Shared with me") });
    // The tree stays; the footer counts the whole vault, as it is no one's.
    expect(names()).toEqual(["Jamie", "FAKE Labs", "Morgan", "Shared with me"]);
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

    // From Shared with me, dropped on Morgan's folder: it goes to Morgan.
    await user.click(
      within(library()).getByRole("button", {
        name: humanText(/^Shared with me/),
      }),
    );
    const file = await screen.findByRole("article", {
      name: humanText("FAKE_Scan.pdf document"),
    });
    const moved = dragTransfer();
    fireDragEvent("dragstart", file, { dataTransfer: moved });
    const forms = within(library()).getByRole("button", {
      name: humanText(/^FAKE School forms/),
    });
    fireDragEvent("dragover", forms, { dataTransfer: moved });
    fireDragEvent("drop", forms, { dataTransfer: moved });
    await waitFor(() =>
      expect(bridge.moveToPerson).toHaveBeenCalledWith(
        ["record-shared-1"],
        "profile-2",
        ["folder-2"],
      ),
    );
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
          screen.getByRole("button", { name: humanText("Open FAKE Results") }),
        );
      expect(
        await screen.findByRole("article", {
          name: humanText("FAKE Filed.pdf document"),
        }),
      ).toBeVisible();
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

  it("lets no person be called Shared with me (#61)", async () => {
    const user = userEvent.setup();
    const { bridge } = sharedVault(["Jamie"], [], {
      status: vi.fn().mockResolvedValue("unlocked"),
    });
    render(<VaultApp bridge={bridge} />);
    await user.click(
      await screen.findByRole("button", { name: humanText("Security") }),
    );
    await user.type(
      screen.getByLabelText(humanText("New profile name")),
      " shared WITH me ",
    );
    expect(screen.getByRole("alert")).toHaveHumanTextContent(
      "Shared with me is where shared files go. Choose another name.",
    );
    expect(
      screen.getByRole("button", { name: humanText("Add profile") }),
    ).toBeDisabled();
    expect(bridge.createProfile).not.toHaveBeenCalled();
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
        .mockResolvedValue({ ...emptySnapshot, records: [record] }),
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
        .mockResolvedValue({ ...emptySnapshot, records: [record] }),
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
      within(reader).getByRole("button", { name: humanText("Close") }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("heading", { name: humanText("My records") }),
    ).toBeVisible();
  });

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
        .mockResolvedValue({ ...emptySnapshot, records: [record] }),
      // Still drawing when the lock comes.
      viewPage: vi.fn(() => new Promise<ViewedPage>(() => undefined)),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(await screen.findByText(humanText("FAKE_Letter.pdf")));
    await user.click(screen.getByRole("button", { name: humanText("Read") }));
    expect(
      await screen.findByRole("dialog", { name: humanText("FAKE_Letter.pdf") }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: humanText(/Unlocked · Lock now/) }),
    );
    expect(
      await screen.findByRole("heading", {
        name: humanText("Unlock your vault"),
      }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bridge.cancelView).toHaveBeenCalled();
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
      screen.getByRole("button", { name: humanText("Open FAKE Test Results") }),
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
        name: humanText("Save a copy to this computer"),
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
        name: humanText("Save a copy to this computer"),
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
          name: humanText("Open FAKE Parent"),
        }),
      );
      if (view === "grid")
        await user.click(
          screen.getByRole("button", { name: humanText("Grid view") }),
        );
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
        name: humanText("Open FAKE Parent"),
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
        name: humanText("Open FAKE Parent"),
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
        name: humanText("Open FAKE Parent"),
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
        name: humanText("Open FAKE Parent"),
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
            name: humanText("Save a copy to this computer"),
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
        .mockResolvedValue({ ...emptySnapshot, recoveryKeySetAtMs: 5 }),
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
      unlock: vi.fn().mockResolvedValue({ ...emptySnapshot, ...state }),
      snapshot: vi.fn().mockResolvedValue({ ...emptySnapshot, ...state }),
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
      name: humanText("Set up myCarlos on this computer"),
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
    expect(bridge.saveBackupToPicked).toHaveBeenCalledWith("pick-7");
    expect(
      await screen.findByText(
        humanText(
          "Encrypted backup saved. Keep it somewhere other than this device.",
        ),
      ),
    ).toBeVisible();
  });

  it("names the damaged document that stopped a backup", async () => {
    const user = userEvent.setup();
    const recordId = snapshotWithRecord.records[0].id;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockResolvedValue(snapshotWithRecord),
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
      /^0 character password Backup restored\./,
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
      snapshot: vi.fn().mockResolvedValue(vault),
      unlock: vi.fn().mockResolvedValue(vault),
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
    const saved = { ...emptySnapshot, recoveryKeySetAtMs: 9 };
    await act(async () => answer(saved));
    await waitFor(() => expect(bridge.lock).toHaveBeenCalled());
    await setVisibility("visible");
    vi.mocked(bridge.unlock).mockResolvedValue(saved);
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
        { confirmRecoveryKey: vi.fn().mockResolvedValue(after) },
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
      vi.mocked(bridge.unlock).mockResolvedValue(after);
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
      confirmRecoveryKey: vi.fn().mockResolvedValue(stored),
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
      { confirmRecoveryKey: vi.fn().mockResolvedValue(after) },
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
      confirmRecoveryKey: vi.fn().mockResolvedValue(after),
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
    expect(bridge.saveBackupToPicked).toHaveBeenCalledWith("pick-9");
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
    await user.click(
      screen.getByRole("button", { name: humanText(/Unlocked · Lock now/) }),
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
          unlock: vi.fn().mockResolvedValue(vault),
          snapshot: vi.fn().mockResolvedValue(vault),
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
        bridge={nativeBridge({ unlock: vi.fn().mockResolvedValue(vault) })}
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
        bridge={nativeBridge({ unlock: vi.fn().mockResolvedValue(vault) })}
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
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: humanText("Choose files to import"),
        }),
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: humanText("Choose files to import"),
          }),
        );
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: humanText("Choose files to import"),
          }),
        );
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
      snapshot: vi.fn().mockResolvedValue({
        ...emptySnapshot,
        records: [record("a", "FAKE_Alpha.pdf"), record("b", "FAKE_Beta.pdf")],
      }),
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
        .mockResolvedValue({ ...emptySnapshot, records: [record] }),
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
    vi.mocked(bridge.snapshot).mockResolvedValue({
      ...snapshot,
      recovery: "writeFailed",
    });
    render(<VaultApp bridge={bridge} />);
    expect(
      await screen.findByRole("button", {
        name: humanText("Rename folder FAKE Parent"),
      }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: humanText("Open FAKE Parent") }),
    );
    expect(
      screen.getByRole("button", { name: humanText("Rename folder") }),
    ).toBeDisabled();
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
            /To import PDFs, unlock your vault and use Choose files to import/,
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

      await user.click(
        await screen.findByRole("button", {
          name: humanText("Choose files to import"),
        }),
      );
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
      await user.click(
        await screen.findByRole("button", {
          name: humanText("Choose files to import"),
        }),
      );
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
    await user.click(
      await screen.findByRole("button", {
        name: humanText("Choose files to import"),
      }),
    );
    expect(
      await screen.findByText(humanText("1 document encrypted and added.")),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: humanText("Choose files to import") }),
    );
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
      await user.click(
        await screen.findByRole("button", {
          name: humanText("Choose files to import"),
        }),
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
        "0 character password Locked because myCarlos was minimized or sent to the background.",
      );
    } finally {
      visibility.mockRestore();
    }
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
    const hidden = { ...record, hidden: { atMs: 5, reason: "patient" } };
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({ ...emptySnapshot, records: [record] })
      .mockResolvedValueOnce({ ...emptySnapshot, records: [hidden] })
      .mockResolvedValue({ ...emptySnapshot, records: [record] });
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
        .mockResolvedValue({ ...emptySnapshot, records: [record] }),
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
      await user.click(
        await screen.findByRole("button", {
          name: humanText("Choose files to import"),
        }),
      );
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
        await user.click(
          await screen.findByRole("button", {
            name: humanText("Take a photo"),
          }),
        );
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
      await user.click(
        await screen.findByRole("button", {
          name: humanText("Choose files to import"),
        }),
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: humanText("Choose files to import"),
          }),
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
          screen.getByRole("button", {
            name: humanText("Choose files to import"),
          }),
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
          screen.getByRole("button", {
            name: humanText("Choose files to import"),
          }),
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
          screen.getByRole("button", {
            name: humanText("Choose files to import"),
          }),
        );
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

  it("tells at once what a backup cut off by a lock left, when that lock fails", async () => {
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
    await user.click(
      await screen.findByRole("button", {
        name: humanText("Choose files to import"),
      }),
    );
    await waitFor(() => expect(bridge.importPickedFiles).toHaveBeenCalled());
    await user.click(
      screen.getByRole("button", { name: humanText(/Lock now/) }),
    );
    // The vault stays open, and the patient is here: told now, not after
    // some later unlock.
    expect(
      await screen.findByText(
        humanText(
          new RegExp(
            `The backup stopped because the vault locked\\. No backup was saved\\. Keep your older backups\\. ${note.replace(/\./g, "\\.")}`,
          ),
        ),
      ),
    ).toBeVisible();
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
      await user.click(
        await screen.findByRole("button", {
          name: humanText("Choose files to import"),
        }),
      );
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
      await user.click(
        await screen.findByRole("button", { name: humanText(/Lock now/) }),
      );
      await waitFor(() => expect(bridge.lock).toHaveBeenCalledOnce());
      await user.click(
        screen.getByRole("button", {
          name: humanText("Choose files to import"),
        }),
      );
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
      expect(bridge.lock).toHaveBeenCalledTimes(2);
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
            screen.getByRole("button", {
              name: humanText("Choose files to import"),
            }),
          );
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

        await act(async () => finishRefresh(emptySnapshot));
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
            screen.getByRole("button", {
              name: humanText("Choose files to import"),
            }),
          );
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

        await act(async () => finishRefresh(emptySnapshot));
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: humanText("Choose files to import"),
          }),
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
          screen.getByRole("button", {
            name: humanText("Choose files to import"),
          }),
        );
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: humanText("Choose files to import"),
          }),
        );
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: humanText("Choose files to import"),
          }),
        );
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
      await user.click(
        await screen.findByRole("button", {
          name: humanText("Choose files to import"),
        }),
      );
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
      await user.click(await screen.findByText(humanText("FAKE_Results.pdf")));
      await user.click(
        screen.getByRole("button", {
          name: humanText("Save a copy to this computer"),
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: humanText("Choose files to import"),
          }),
        );
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
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: humanText("Choose files to import"),
          }),
        );
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
    await user.click(
      await screen.findByRole("button", { name: humanText("New folder") }),
    );
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
      await user.click(
        await screen.findByRole("button", {
          name: humanText("Choose files to import"),
        }),
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
        await screen.findByRole("button", {
          name: humanText("Choose files to import"),
        }),
      );
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
        await user.click(
          await screen.findByText(humanText("FAKE_Results.pdf")),
        );
        await user.click(
          screen.getByRole("button", {
            name: humanText("Save a copy to this computer"),
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
        await user.click(
          await screen.findByText(humanText("FAKE_Results.pdf")),
        );
        await user.click(
          screen.getByRole("button", {
            name: humanText("Save a copy to this computer"),
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
        await user.click(
          await screen.findByRole("button", {
            name: humanText("Choose files to import"),
          }),
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
        await user.click(
          await screen.findByRole("button", {
            name: humanText("Choose files to import"),
          }),
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
        await user.click(
          await screen.findByRole("button", {
            name: humanText("Choose files to import"),
          }),
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
        await user.click(
          await screen.findByRole("button", {
            name: humanText("Choose files to import"),
          }),
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
        await user.click(
          await screen.findByRole("button", {
            name: humanText("Choose files to import"),
          }),
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
        await user.click(
          await screen.findByRole("button", {
            name: humanText("Choose files to import"),
          }),
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
        await user.click(
          await screen.findByRole("button", {
            name: humanText("Choose files to import"),
          }),
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
        await user.click(
          await screen.findByRole("button", {
            name: humanText("Choose files to import"),
          }),
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
        await user.click(
          await screen.findByRole("button", {
            name: humanText("Choose files to import"),
          }),
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
    await user.click(
      await screen.findByRole("button", { name: humanText("New folder") }),
    );
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
      await user.click(
        await screen.findByRole("button", {
          name: humanText("Choose files to import"),
        }),
      );
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

    await user.click(
      await screen.findByRole("button", {
        name: humanText(/Choose files to import/),
      }),
    );
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
        .mockResolvedValue({ ...emptySnapshot, records: [record] }),
      pickExportDestination: vi.fn().mockResolvedValue(null),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(await screen.findByText(humanText("FAKE_Copy.pdf")));
    await user.click(
      screen.getByRole("button", {
        name: humanText("Save a copy to this computer"),
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
        .mockResolvedValue({ ...emptySnapshot, records: [record] }),
      pickImportFiles: vi.fn().mockResolvedValue(null),
    });
    render(<VaultApp bridge={bridge} />);

    await user.click(
      await screen.findByRole("button", {
        name: humanText("Choose files to import"),
      }),
    );
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
        fireEvent.click(
          screen.getByRole("button", { name: humanText(/Lock now/) }),
        );
      });
      expect(lock).toHaveBeenCalledOnce();

      await act(async () => vi.advanceTimersByTime(5 * 60 * 1000));
      expect(lock).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByText(humanText(/finishes locking/))).toBeVisible();

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

    await act(async () =>
      deliverSnapshot({
        ...emptySnapshot,
        records: [{ ...record, displayName: "FAKE_Renamed.pdf" }],
      }),
    );
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
    await user.click(
      await screen.findByRole("button", { name: humanText("New folder") }),
    );
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
    await user.click(
      await screen.findByRole("button", { name: humanText("New folder") }),
    );
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

    const name = screen.getByLabelText(humanText("New profile name"));
    await user.type(name, "Jamie's parent");
    await user.click(
      screen.getByRole("button", { name: humanText("Add profile") }),
    );
    await waitFor(() => expect(createProfile).toHaveBeenCalledOnce());
    expect(name).toHaveValue("Jamie's parent");
    // The refusal names the box to check (#69).
    expect(
      await screen.findByText(
        humanText("Check the profile name, then try again."),
      ),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: humanText("Add profile") }),
    );
    await waitFor(() => expect(name).toHaveValue(""));
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
        .mockResolvedValue({ ...emptySnapshot, records: [record] }),
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
        name: humanText("Save a copy to this computer"),
      }),
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
      screen.getByRole("button", { name: humanText(/Lock now/) }),
    ).toBeEnabled();
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
        name: humanText("Save a copy to this computer"),
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
      snapshot: vi.fn(async () => structuredClone(shown)),
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
      expect(bridge.hideUnavailableRecords).toHaveBeenCalledExactlyOnceWith([
        "patient-hidden",
      ]),
    );
    await screen.findByText(
      humanText(
        "1 damaged document hidden. It is listed under Hidden. The vault accepts changes again.",
      ),
    );
    expect(
      screen.getByRole("button", { name: humanText("New folder") }),
    ).toBeEnabled();
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
    expect(hideUnavailableRecords).toHaveBeenCalledWith(["record-lost"]);
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
    expect(
      screen.getByRole("button", { name: humanText("New folder") }),
    ).toBeEnabled();
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
        humanText(/myCarlos could not save a change to this computer/),
      ),
    ).toBeVisible();
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
      snapshot: vi.fn().mockResolvedValue({
        ...emptySnapshot,
        recovery: "lostObjects",
        records,
      }),
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
    expect(bridge.hideUnavailableRecords).toHaveBeenCalledWith(["a"]);
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

    expect(await screen.findByText(humanText(hostileName))).toBeVisible();
    expect(
      document.querySelector('img[src="https://attacker.invalid/leak"]'),
    ).toBeNull();
    expect(screen.getByRole("alert")).toHaveHumanTextContent(
      "Changes are paused.",
    );
    expect(
      screen.getByRole("button", { name: humanText("Choose files to import") }),
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
      await screen.findByRole("button", { name: humanText(/Lock now/) }),
    );
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
    vi.mocked(bridge.snapshot).mockResolvedValue(snapshotWithRecord);
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

    await user.click(
      screen.getByRole("button", {
        name: humanText(pl("interface.VaultLibrary.unlockedLockNow")),
      }),
    );
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
          translate("fr", "notice.dropRefused", {
            button: translate("fr", "interface.VaultApp.chooseFilesToImport"),
          }),
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
        snapshot: vi.fn().mockResolvedValue(snapshotWithRecord),
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByText(humanText("FAKE_Results.pdf")));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: humanText("Save a copy to this computer"),
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

  it("keeps local records usable and shares admission across clinic-view remounts", async () => {
    let current = clinicSnapshot;
    const pending = pendingConnection();
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockImplementation(async () => current),
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
      "No files selected. Nothing changed. Device linked. Its approval status is shown in Security, under Clinic documents.",
    ],
    [
      "transfer",
      "1 document encrypted and added. Device linked. Its approval status is shown in Security, under Clinic documents.",
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
        snapshot: vi.fn().mockImplementation(async () => current),
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
      await user.click(
        screen.getByRole("button", { name: "Choose files to import" }),
      );
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

  it("forgets a held clinic result when the vault locks", async () => {
    let current = clinicSnapshot;
    const pending = pendingConnection();
    let pick!: (value: string | null) => void;
    const bridge = nativeBridge({
      status: vi.fn().mockResolvedValue("unlocked"),
      snapshot: vi.fn().mockImplementation(async () => current),
      unlock: vi.fn().mockImplementation(async () => current),
      connectPortal: vi.fn().mockReturnValue(pending.promise),
      checkDocuments: vi.fn(),
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
    await user.click(
      screen.getByRole("button", { name: "Choose files to import" }),
    );
    await waitFor(() => expect(bridge.pickImportFiles).toHaveBeenCalled());
    current = { ...clinicSnapshot, portalLinks: [connectedLink] };
    await act(async () =>
      pending.finish({ link: connectedLink, approvalError: null }),
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
      snapshot: vi.fn().mockImplementation(async () => current),
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
        "Device linked. Its approval status is shown in Security, under Clinic documents.",
      ),
    ).toBeVisible();
    // An error that arrives while a picker is open waits for its result.
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
    await user.click(screen.getAllByRole("button", { name: /^My records/ })[0]);
    await user.click(
      screen.getByRole("button", { name: "Choose files to import" }),
    );
    await waitFor(() => expect(bridge.pickImportFiles).toHaveBeenCalled());
    expect(bridge.connectPortal).toHaveBeenCalledTimes(3);
    await act(async () => refuseLater({ code: "portal_busy" }));
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
      snapshot: vi.fn().mockImplementation(async () => current),
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

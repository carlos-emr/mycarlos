import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveText, setLocaleOverride, translate } from "../i18n";
import type { VaultBridge, VaultSnapshot } from "../vault";
import { humanText, visibleText } from "../test/humanText";
import { headMenuItemNow } from "../test/menus";
import { VaultLibrary } from "./VaultLibrary";

// What the library does when the patient hides or restores a person, moves a folder with the
// keyboard, renames something that changed under them, drops a folder that has gone, picks a
// backup place and chooses nothing, and selects documents. FAKE data only.

afterEach(() => {
  cleanup();
  setLocaleOverride(null);
});

beforeEach(() => setLocaleOverride("en"));

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => visibleText(translate("en", key, params));

let sequence = 1;
const stamped = (snapshot: VaultSnapshot): VaultSnapshot => ({
  ...structuredClone(snapshot),
  capture: {
    epoch: "00000000-0000-4000-8000-000000000185",
    sequence: ++sequence,
  },
});

const folder = (id: string, name: string, parentId: string | null = null) => ({
  id,
  profileId: "profile-1",
  parentId,
  name,
  createdAtMs: 1,
});
const record = (id: string, displayName: string, folderIds: string[] = []) => ({
  id,
  profileId: "profile-1",
  folderIds,
  displayName,
  sourceLabel: "Manual import — unverified",
  mediaType: "application/pdf",
  plaintextSize: 2048,
  importedAtMs: Date.UTC(2026, 9, 8, 12),
  available: true,
});

const base: VaultSnapshot = {
  capture: { epoch: "00000000-0000-4000-8000-000000000185", sequence: 1 },
  profiles: [
    { id: "profile-1", displayName: "FAKE Avery", createdAtMs: 1 },
    { id: "profile-2", displayName: "FAKE Blake", createdAtMs: 2 },
  ],
  folders: [
    folder("letters", "FAKE Letters"),
    folder("letters-2025", "FAKE 2025 Letters", "letters"),
    folder("letters-2025-june", "FAKE June Letters", "letters-2025"),
    folder("results", "FAKE Results"),
  ],
  records: [
    record("r1", "FAKE Blood test.pdf"),
    record("r2", "FAKE Letter.pdf", ["letters"]),
  ],
  recovery: null,
};

function mount(
  snapshot: VaultSnapshot = base,
  bridgeExtras: Record<string, unknown> = {},
  props: { busy?: boolean } = {},
) {
  const bridge = {
    platform: vi.fn().mockResolvedValue("windows"),
    updateFolder: vi.fn().mockResolvedValue(undefined),
    renameProfile: vi.fn().mockResolvedValue(undefined),
    snapshot: vi.fn().mockImplementation(async () => stamped(snapshot)),
    history: vi.fn().mockResolvedValue({
      entries: [],
      laterEntries: [],
      complete: true,
      checkedUntilMs: null,
      checkedFromMs: null,
    }),
    isLockedPdf: vi.fn().mockResolvedValue(false),
    isPhoto: vi.fn().mockResolvedValue(false),
    aiModelStatus: vi.fn().mockResolvedValue({ state: "notInstalled" }),
    aiResults: vi.fn().mockResolvedValue([]),
    hideProfile: vi.fn().mockResolvedValue(undefined),
    restoreProfile: vi.fn().mockResolvedValue([]),
    moveToPerson: vi.fn().mockResolvedValue({ moved: [], skipped: [] }),
    pickBackupDestination: vi.fn().mockResolvedValue(null),
    saveBackupToPicked: vi.fn(),
    backupSize: vi
      .fn()
      .mockResolvedValue({ totalBytes: 1, videoBytes: 0, videoCount: 0 }),
    leftOutRecords: vi.fn().mockResolvedValue([]),
    ...bridgeExtras,
  } as unknown as VaultBridge;
  const setNotice = vi.fn();
  const refresh = vi.fn(async () => snapshot);
  const element = (current: VaultSnapshot, busy: boolean) => (
    <VaultLibrary
      bridge={bridge}
      snapshot={stamped(current)}
      busy={busy}
      portalBusy={false}
      notice=""
      setNotice={setNotice}
      run={async (operation) => operation()}
      refresh={refresh}
      onLock={vi.fn().mockResolvedValue(undefined)}
      autoLockMinutes={5}
      onAutoLockMinutes={vi.fn()}
      sharedNew={0}
      computer
    />
  );
  const view = render(element(snapshot, props.busy ?? false));
  return {
    bridge,
    setNotice,
    refresh,
    again: (next: VaultSnapshot = snapshot, busy = false) =>
      view.rerender(element(next, busy)),
  };
}

const politeLine = () =>
  document.querySelector<HTMLElement>('p.sr-only[aria-live="polite"]')!;
const noticeText = (setNotice: ReturnType<typeof vi.fn>) =>
  visibleText(resolveText(setNotice.mock.calls.at(-1)?.[0]) ?? "");

describe("hiding a person from the head menu", () => {
  it("asks first, hides only on confirmation, reads the library again and tells a screen reader", async () => {
    const { bridge, refresh } = mount();
    fireEvent.click(headMenuItemNow(/^Hide /));
    const ask = await screen.findByRole("alertdialog", {
      name: humanText(en("hiddenPeople.confirm.title", { name: "FAKE Avery" })),
    });
    // Cancel hides nothing.
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(bridge.hideProfile).not.toHaveBeenCalled();
    fireEvent.click(headMenuItemNow(/^Hide /));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: humanText(
          en("hiddenPeople.confirm.hide", { name: "FAKE Avery" }),
        ),
      }),
    );
    await waitFor(() =>
      expect(bridge.hideProfile).toHaveBeenCalledExactlyOnceWith("profile-1"),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() =>
      expect(visibleText(politeLine().textContent ?? "")).toContain(
        en("hiddenPeople.hidden", { name: "FAKE Avery" }),
      ),
    );
  });

  it("a hidden person's documents leave the selection and an open details dialog closes, so none stays chosen or open", async () => {
    const { bridge } = mount();
    const tick = () =>
      screen.getByRole("button", {
        name: humanText(en("library.select", { name: "FAKE Blood test.pdf" })),
      });
    fireEvent.click(tick());
    expect(tick()).toHaveAttribute("aria-pressed", "true");
    // Open that document's details.
    fireEvent.click(
      screen.getByRole("button", { name: /^FAKE Blood test\.pdf/ }),
    );
    const details = await screen.findByRole("dialog", {
      name: /FAKE Blood test\.pdf/,
    });
    expect(details).toBeVisible();
    // The pointer cannot reach the head menu under the dialog, but the state must be cleared
    // whichever way hiding is started (the handover's "hide after" also starts it), so the menu
    // button is pressed directly.
    const more = document.querySelector<HTMLButtonElement>(
      'button[aria-label^="More for"]',
    )!;
    fireEvent.click(more);
    fireEvent.click(
      Array.from(
        document.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
      ).find((item) => /^Hide /.test(item.textContent ?? ""))!,
    );
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: humanText(
          en("hiddenPeople.confirm.hide", { name: "FAKE Avery" }),
        ),
      }),
    );
    await waitFor(() =>
      expect(bridge.hideProfile).toHaveBeenCalledExactlyOnceWith("profile-1"),
    );
    // Nothing of the hidden person stays chosen or open.
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /FAKE Blood test\.pdf/ }),
      ).toBeNull(),
    );
    expect(tick()).toHaveAttribute("aria-pressed", "false");
  });

  it("is not offered for the last person the library shows, and not when the vault cannot hide", () => {
    const only: VaultSnapshot = { ...base, profiles: [base.profiles[0]] };
    mount(only);
    expect(headMenuItemNow(/^Hide /)).toBeDisabled();
    cleanup();
    mount(base, { hideProfile: undefined });
    fireEvent.click(
      screen.getByRole("button", { name: humanText(/^More for /) }),
    );
    expect(
      screen.queryByRole("menuitem", { name: humanText(/^Hide /) }),
    ).toBeNull();
  });
});

describe("restoring a hidden person in Security", () => {
  const hidden: VaultSnapshot = {
    ...base,
    hiddenProfiles: [
      {
        id: "profile-3",
        displayName: "FAKE Casey",
        hiddenAtMs: Date.UTC(2026, 9, 7, 12),
        documents: 2,
      },
    ],
  };
  const restoreButton = () =>
    screen.getByRole("button", {
      name: humanText(en("hiddenPeople.restoreFor", { name: "FAKE Casey" })),
    });

  it("restores them, reads the library again and says so, with no question when nothing arrived meanwhile", async () => {
    const { bridge, refresh } = mount(hidden);
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    fireEvent.click(restoreButton());
    await waitFor(() =>
      expect(bridge.restoreProfile).toHaveBeenCalledExactlyOnceWith(
        "profile-3",
      ),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() =>
      expect(visibleText(politeLine().textContent ?? "")).toContain(
        en("hiddenPeople.restored", { name: "FAKE Casey" }),
      ),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("offers the documents that arrived for them while hidden: Move files them under the person, Leave changes nothing", async () => {
    const arrived = [{ recordId: "r9", displayName: "FAKE Arrived.pdf" }];
    const { bridge } = mount(hidden, {
      restoreProfile: vi.fn().mockResolvedValue(arrived),
    });
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    fireEvent.click(restoreButton());
    const ask = await screen.findByRole("alertdialog", {
      name: humanText(en("hiddenPeople.arrived.title", { name: "FAKE Casey" })),
    });
    expect(within(ask).getByText("FAKE Arrived.pdf")).toBeVisible();
    fireEvent.click(
      within(ask).getByRole("button", {
        name: en("hiddenPeople.arrived.leave"),
      }),
    );
    expect(bridge.moveToPerson).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // Again, this time moving them.
    fireEvent.click(restoreButton());
    const again = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(again).getByRole("button", {
        name: humanText(
          en("hiddenPeople.arrived.move", { name: "FAKE Casey" }),
        ),
      }),
    );
    await waitFor(() =>
      expect(bridge.moveToPerson).toHaveBeenCalledExactlyOnceWith(
        ["r9"],
        "profile-3",
        [],
      ),
    );
  });
});

describe("moving a folder with the keyboard", () => {
  const openHelp = () =>
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Help: this screen") }),
    );
  const chooseFolder = () =>
    screen.getByRole("combobox", {
      name: humanText(en("interface.RecordDetails.folder")),
    });
  const destination = () =>
    screen.getByRole("combobox", {
      name: humanText(en("interface.VaultLibrary.destination")),
    });
  const move = () =>
    screen.getByRole("button", {
      name: humanText(en("interface.VaultLibrary.moveFolder")),
    });
  const optionNames = (select: HTMLElement) =>
    within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);

  it("needs a folder chosen, offers a destination that is not the folder or anything beneath it, and moves it", async () => {
    const { bridge, refresh, setNotice } = mount();
    openHelp();
    expect(move()).toBeDisabled();
    fireEvent.change(chooseFolder(), { target: { value: "letters" } });
    expect(move()).toBeEnabled();
    // Not itself, not its folders: only a folder that is elsewhere, and the top.
    expect(optionNames(destination())).toEqual([
      en("sidebar.myRecords"),
      "FAKE Results",
    ]);
    fireEvent.change(destination(), { target: { value: "results" } });
    fireEvent.click(move());
    await waitFor(() =>
      expect(bridge.updateFolder).toHaveBeenCalledExactlyOnceWith(
        "letters",
        "results",
        "FAKE Letters",
      ),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() =>
      expect(noticeText(setNotice)).toContain(
        en("interface.notice.folderMovedNamed", { name: "FAKE Letters" }),
      ),
    );
  });

  it("to the top of the person's records sends no parent, and choosing another folder forgets the destination", async () => {
    const { bridge } = mount();
    openHelp();
    fireEvent.change(chooseFolder(), { target: { value: "letters-2025" } });
    fireEvent.change(destination(), { target: { value: "results" } });
    fireEvent.change(chooseFolder(), { target: { value: "letters-2025" } });
    expect((destination() as HTMLSelectElement).value).toBe("");
    fireEvent.click(move());
    await waitFor(() =>
      expect(bridge.updateFolder).toHaveBeenCalledExactlyOnceWith(
        "letters-2025",
        null,
        "FAKE 2025 Letters",
      ),
    );
  });

  it("a folder's own children are not offered when moving a middle one", () => {
    mount();
    openHelp();
    fireEvent.change(chooseFolder(), { target: { value: "letters-2025" } });
    const names = optionNames(destination());
    expect(names).toContain("FAKE Letters");
    expect(names).toContain("FAKE Results");
    expect(names).not.toContain("FAKE 2025 Letters");
    expect(names).not.toContain("FAKE June Letters");
  });
});

describe("renaming something that changed while the name was being typed", () => {
  const openRenameOfPerson = () => {
    fireEvent.click(headMenuItemNow("Rename “FAKE Avery”"));
    return screen.getByLabelText("Folder name");
  };

  it("when another operation started meanwhile, the name cannot be changed or saved and nothing is sent", async () => {
    const { bridge, again } = mount();
    const field = openRenameOfPerson();
    fireEvent.change(field, { target: { value: "FAKE Corrected" } });
    again(base, true);
    // The dialog itself is read-only now (the library's own check behind it is never reached).
    expect(screen.getByLabelText("Folder name")).toBeDisabled();
    fireEvent.submit(screen.getByLabelText("Folder name").closest("form")!);
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await Promise.resolve();
    expect(bridge.renameProfile).not.toHaveBeenCalled();
    // When the operation ends the same dialog works again, with what was typed kept.
    again(base, false);
    expect(screen.getByLabelText("Folder name")).toHaveValue("FAKE Corrected");
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(bridge.renameProfile).toHaveBeenCalledExactlyOnceWith(
        "profile-1",
        "FAKE Corrected",
      ),
    );
  });

  it("when the vault became read-only meanwhile, the name cannot be saved and nothing is sent", async () => {
    const { bridge, again } = mount();
    openRenameOfPerson();
    fireEvent.change(screen.getByLabelText("Folder name"), {
      target: { value: "FAKE Corrected" },
    });
    again({ ...base, recovery: "writeFailed" } as VaultSnapshot);
    expect(screen.getByLabelText("Folder name")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await Promise.resolve();
    expect(bridge.renameProfile).not.toHaveBeenCalled();
  });

  it("a folder deleted from under the dialog is said to be gone, and nothing is sent", async () => {
    const { bridge, again } = mount();
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText(en("library.folder.rename", { name: "FAKE Results" })),
      }),
    );
    fireEvent.change(screen.getByLabelText("Folder name"), {
      target: { value: "FAKE Renamed" },
    });
    again({ ...base, folders: base.folders.filter((f) => f.id !== "results") });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    const alert = await screen.findByRole("alert");
    expect(visibleText(alert.textContent ?? "")).toContain(
      en("interface.VaultLibrary.thatFolderIsNoLongerAvailable"),
    );
    expect(bridge.updateFolder).not.toHaveBeenCalled();
  });
});

describe("dropping a folder that has gone", () => {
  it("says it is no longer available and moves nothing", async () => {
    const { bridge, setNotice, again } = mount();
    const row = (name: string) =>
      screen.getByRole("article", {
        name: humanText(en("library.folder.label", { name })),
      });
    const dataTransfer = new DataTransfer();
    fireEvent(
      row("FAKE Results"),
      new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }),
    );
    // The folder is deleted elsewhere while it is being dragged.
    again({ ...base, folders: base.folders.filter((f) => f.id !== "results") });
    const target = row("FAKE Letters");
    fireEvent(
      target,
      new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }),
    );
    fireEvent(
      target,
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
    );
    await waitFor(() =>
      expect(noticeText(setNotice)).toContain(
        en("interface.VaultLibrary.thatFolderIsNoLongerAvailable"),
      ),
    );
    expect(bridge.updateFolder).not.toHaveBeenCalled();
  });
});

describe("saving a backup", () => {
  it("says nothing was changed when no place was chosen, and does not write one", async () => {
    const { bridge, setNotice } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText(en("security.backup.save")),
      }),
    );
    await waitFor(() =>
      expect(bridge.pickBackupDestination).toHaveBeenCalledOnce(),
    );
    expect(bridge.pickBackupDestination).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
    await waitFor(() =>
      expect(noticeText(setNotice)).toContain(
        en("interface.VaultLibrary.noLocationChosenNothingChanged"),
      ),
    );
    expect(bridge.saveBackupToPicked).not.toHaveBeenCalled();
  });
});

describe("choosing documents", () => {
  it("a tick chooses a document and the same tick lets go of it", () => {
    mount();
    const tick = () =>
      screen.getByRole("button", {
        name: humanText(en("library.select", { name: "FAKE Blood test.pdf" })),
      });
    expect(tick()).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(tick());
    expect(tick()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(tick());
    expect(tick()).toHaveAttribute("aria-pressed", "false");
  });
});

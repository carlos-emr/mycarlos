import { humanText, humanValue, visibleText } from "../test/humanText";
import { LOCALES, resolveText, setLocaleOverride, translate } from "../i18n";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortalLinkSummary, VaultBridge, VaultSnapshot } from "../vault";
import { VaultLibrary } from "./VaultLibrary";
import type { ModelStatus } from "../ai/types";
import { FAKE_MODEL, fakeDocumentText } from "../test/fakeLocalModel";

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

const snapshot: VaultSnapshot = {
  capture: { epoch: "00000000-0000-4000-8000-000000000185", sequence: 1 },
  profiles: [{ id: "profile-1", displayName: "FAKE Avery", createdAtMs: 1 }],
  folders: [
    {
      id: "letters",
      profileId: "profile-1",
      parentId: null,
      name: "FAKE Letters",
      createdAtMs: Date.UTC(2026, 0, 15, 12),
    },
    {
      id: "letters-2025",
      profileId: "profile-1",
      parentId: "letters",
      name: "FAKE 2025 Letters",
      createdAtMs: Date.UTC(2026, 0, 15, 12),
    },
    {
      id: "letters-2025-june",
      profileId: "profile-1",
      parentId: "letters-2025",
      name: "FAKE June Letters",
      createdAtMs: Date.UTC(2026, 0, 15, 12),
    },
  ],
  records: [],
  recovery: null,
};

function renderLibrary(
  shown: VaultSnapshot = snapshot,
  sharedNew = 0,
  bridgeExtras: Record<string, unknown> = {},
  computer = true,
  activity: { busy?: boolean; portalBusy?: boolean } = {},
) {
  const bridge = {
    platform: vi.fn().mockResolvedValue("windows"),
    updateFolder: vi.fn().mockResolvedValue(undefined),
    renameProfile: vi.fn().mockResolvedValue(undefined),
    assignFoldersBatch: vi.fn().mockResolvedValue(undefined),
    snapshot: vi.fn().mockImplementation(async () => captureSnapshot(shown)),
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
    aiSummarize: vi
      .fn()
      .mockRejectedValue(new Error("FAKE: no model in this test")),
    aiExplain: vi
      .fn()
      .mockRejectedValue(new Error("FAKE: no model in this test")),
    aiCancel: vi.fn().mockResolvedValue(undefined),
    // The answers kept with a document (#212): none yet.
    aiResults: vi.fn().mockResolvedValue([]),
    readAiResult: vi
      .fn()
      .mockRejectedValue(new Error("FAKE: no kept answer in this test")),
    // Saved by the id the native side kept the answer under (#212).
    saveAiResult: vi.fn(async () => ({
      id: "FAKE-kept-1",
      tool: "summary",
      lang: "en",
      modelName: "FAKE test model",
      modelSha256: "test-only",
      createdAtMs: 1,
      size: 2,
    })),
    ...bridgeExtras,
  } as unknown as VaultBridge;
  const setNotice = vi.fn();
  const onLock = vi.fn().mockResolvedValue(undefined);
  const onAutoLockMinutes = vi.fn();
  const library = (current: VaultSnapshot, newInShared = sharedNew) => (
    <VaultLibrary
      bridge={bridge}
      snapshot={current}
      busy={activity.busy ?? false}
      portalBusy={activity.portalBusy ?? false}
      notice=""
      setNotice={setNotice}
      run={async (operation) => operation()}
      refresh={async () => shown}
      onLock={onLock}
      autoLockMinutes={5}
      onAutoLockMinutes={onAutoLockMinutes}
      sharedNew={newInShared}
      computer={computer}
    />
  );
  const view = render(library(shown));
  return {
    bridge,
    /** Files arrive in Shared with me while the library is open. */
    setSharedNew: (count: number) => view.rerender(library(shown, count)),
    setNotice,
    rerenderSnapshot: (next: VaultSnapshot) => view.rerender(library(next)),
  };
}

function dragFolder(from: Element, to: Element) {
  const dataTransfer = new DataTransfer();
  for (const [type, target] of [
    ["dragstart", from],
    ["dragover", to],
    ["drop", to],
  ] as const)
    fireEvent(
      target,
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }),
    );
}

describe("VaultLibrary folders", () => {
  it("sends a person's top-level name correction to that same profile, not the folder mutator", async () => {
    const { bridge } = renderLibrary();
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Rename “FAKE Avery”") }),
    );
    expect(
      screen.getByRole("dialog", { name: "Rename person's folder" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Folder name")).toHaveValue("FAKE Avery");
    fireEvent.change(screen.getByLabelText("Folder name"), {
      target: { value: "FAKE Corrected" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await vi.waitFor(() =>
      expect(bridge.renameProfile).toHaveBeenCalledExactlyOnceWith(
        "profile-1",
        "FAKE Corrected",
      ),
    );
    expect(bridge.updateFolder).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("heading", { name: "My records" })).toBeVisible();
  });

  it("cancels a person's name correction without any native mutation", () => {
    const { bridge } = renderLibrary();
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Rename “FAKE Avery”") }),
    );
    fireEvent.change(screen.getByLabelText("Folder name"), {
      target: { value: "FAKE Corrected" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(bridge.renameProfile).not.toHaveBeenCalled();
    expect(bridge.updateFolder).not.toHaveBeenCalled();
  });

  it.each(["FAKE 2025 Letters", "FAKE June Letters"])(
    "does not send a drop of a folder onto its subfolder %s to the vault",
    async (destination) => {
      const { bridge, setNotice } = renderLibrary();
      const sidebar = screen.getByRole("navigation", {
        name: humanText("Record library"),
      });
      dragFolder(
        within(sidebar).getByRole("button", {
          name: humanText(/^FAKE Letters/),
        }),
        within(sidebar).getByRole("button", {
          name: humanText(new RegExp(`^${destination}`)),
        }),
      );
      await vi.waitFor(() =>
        expect(
          humanValue(
            setNotice.mock.calls.map(([notice]) => resolveText(notice)),
          ),
        ).toContain("A folder cannot be moved into itself or its subfolders."),
      );
      expect(bridge.updateFolder).not.toHaveBeenCalled();
    },
  );

  it("still moves a subfolder up to its grandparent", async () => {
    const { bridge } = renderLibrary();
    const sidebar = screen.getByRole("navigation", {
      name: humanText("Record library"),
    });
    dragFolder(
      within(sidebar).getByRole("button", {
        name: humanText(/^FAKE June Letters/),
      }),
      within(sidebar).getByRole("button", { name: humanText(/^FAKE Letters/) }),
    );
    await vi.waitFor(() =>
      expect(bridge.updateFolder).toHaveBeenCalledWith(
        "letters-2025-june",
        "letters",
        "FAKE June Letters",
      ),
    );
  });

  it("shows when a folder was added in the Date added column", () => {
    renderLibrary();
    const row = screen.getByRole("article", {
      name: humanText("FAKE Letters folder"),
    });
    expect(row).toHaveHumanTextContent(
      new Date(Date.UTC(2026, 0, 15, 12)).toLocaleDateString(),
    );
    expect(row).not.toHaveHumanTextContent(/\bFolder\b/);
  });
});

const folder = (id: string, name: string, parentId: string | null) => ({
  id,
  profileId: "profile-1",
  parentId,
  name,
  createdAtMs: 1,
});
const record = (id: string, displayName: string, folderIds: string[]) => ({
  id,
  profileId: "profile-1",
  folderIds,
  displayName,
  sourceLabel: "Manual import — unverified",
  mediaType: "application/pdf",
  plaintextSize: 2048,
  importedAtMs: 1,
  available: true,
});

describe("clinic service dates", () => {
  it.each(["", "2024-02-29"])(
    "keeps service date %s in list, grid and details without using Date added",
    (serviceDate) => {
      const dateAdded = Date.UTC(2023, 10, 29, 14);
      const document = {
        ...record("clinic-record", "FAKE Clinic document.pdf", []),
        importedAtMs: dateAdded,
        verifiedClinicName: "FAKE Clinic",
        clinicServiceDate: serviceDate,
      };
      renderLibrary({ ...snapshot, records: [document] });
      const value = serviceDate === "" ? "Date not recorded" : serviceDate;
      expect(
        screen.getByText(humanText(`Service date: ${value}`)),
      ).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
      expect(
        screen.getByText(humanText(`Service date: ${value}`)),
      ).toBeVisible();
      expect(
        screen.getByText(
          `Date added: ${new Date(dateAdded).toLocaleDateString()}`,
        ),
      ).toBeVisible();
      fireEvent.click(screen.getByText(document.displayName));
      const serviceRow = screen.getByText("Service date", {
        exact: true,
      }).parentElement!;
      expect(
        within(serviceRow).getByText(value, { exact: true }),
      ).toBeVisible();
      expect(serviceRow).not.toHaveTextContent(
        new Date(dateAdded).toLocaleDateString(),
      );
    },
  );
  it("does not invent clinic date metadata for a manual import", () => {
    const document = record("manual-record", "FAKE Manual document.pdf", []);
    renderLibrary({ ...snapshot, records: [document] });
    expect(screen.queryByText(/^Service date:/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(document.displayName));
    expect(
      screen.queryByText("Service date", { exact: true }),
    ).not.toBeInTheDocument();
  });
});
const filed: VaultSnapshot = {
  capture: { epoch: "00000000-0000-4000-8000-000000000185", sequence: 1 },
  profiles: snapshot.profiles,
  folders: [
    folder("lab", "FAKE Lab results", null),
    folder("lab-2026", "FAKE 2026", "lab"),
    folder("lab-2026-june", "FAKE June", "lab-2026"),
    folder("letters", "FAKE Letters", null),
    folder("letters-june", "FAKE June", "letters"),
  ],
  records: [
    record("top", "FAKE Blood pressure log.pdf", []),
    record("lab-1", "FAKE Blood test.pdf", ["lab"]),
    record("lab-deep", "FAKE Blood test.pdf", ["lab-2026-june"]),
    record("letters-1", "FAKE Blood test referral.pdf", ["letters"]),
    record("twice", "FAKE Blood count.pdf", ["lab-2026", "letters"]),
  ],
  recovery: null,
};

const search = (label: string, text: string) =>
  fireEvent.change(screen.getByRole("searchbox", { name: humanText(label) }), {
    target: { value: text },
  });
// Each document shown, with the folder path given for it.
const shownDocuments = () =>
  screen
    .queryAllByRole("article", { name: humanText(/ document$/) })
    .map((row) => [
      row.getAttribute("aria-label")?.replace(/ document$/, ""),
      within(row).queryByText(humanText(/^In /))?.textContent
        ? visibleText(
            within(row).getByText(humanText(/^In /)).textContent ?? "",
          )
        : null,
    ]);
const openFolder = (name: RegExp) =>
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: humanText("Record library") }),
    ).getByRole("button", { name: humanText(name) }),
  );

describe("VaultLibrary search", () => {
  const separateScopes: VaultSnapshot = {
    ...filed,
    sharedProfileId: "shared",
    profiles: [
      ...filed.profiles,
      { id: "profile-2", displayName: "FAKE Blake", createdAtMs: 2 },
      { id: "shared", displayName: "Shared with me", createdAtMs: 3 },
    ],
    folders: [
      ...filed.folders,
      {
        ...folder("blake-lab", "FAKE Lab results", null),
        profileId: "profile-2",
      },
    ],
    records: [
      ...filed.records,
      {
        ...record("blake-top", "FAKE Blood log.pdf", []),
        profileId: "profile-2",
      },
      {
        ...record("blake-filed", "FAKE Blood test.pdf", ["blake-lab"]),
        profileId: "profile-2",
      },
      {
        ...record("shared-test", "FAKE Blood shared.pdf", []),
        profileId: "shared",
      },
    ],
  };

  it("searches only the current person's root and names that person's paths", () => {
    renderLibrary(separateScopes);
    search("Search everything in FAKE Avery", "blood");
    expect(humanValue(shownDocuments())).toHaveLength(5);
    expect(
      shownDocuments().every(([, path]) => path?.startsWith("In FAKE Avery")),
    ).toBe(true);
    const sidebar = screen.getByRole("navigation", {
      name: humanText("Record library"),
    });
    fireEvent.click(
      within(sidebar).getByRole("button", { name: humanText(/^FAKE Blake/) }),
    );
    search("Search everything in FAKE Blake", "blood");
    expect(humanValue(shownDocuments())).toEqual([
      ["FAKE Blood log.pdf", "In FAKE Blake"],
      ["FAKE Blood test.pdf", "In FAKE Blake / FAKE Lab results"],
    ]);
    search("Search everything in FAKE Blake", "lab");
    const folders = screen.getAllByRole("article", {
      name: humanText(/ folder$/),
    });
    expect(folders).toHaveLength(1);
    expect(
      within(folders[0]).getByText(humanText("In FAKE Blake")),
    ).toBeVisible();
  });

  it("searches only Shared with me, without person folders or pane drops", () => {
    const { bridge } = renderLibrary(separateScopes);
    // Enter Shared from a deep folder so no person's subtree can carry over.
    openFolder(/^FAKE 2026/);
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: humanText("Record library") }),
      ).getByRole("button", { name: humanText(/^Shared with me/) }),
    );
    const sharedRow = () =>
      screen.getByRole("article", {
        name: humanText("FAKE Blood shared.pdf document"),
      });
    dragFolder(sharedRow(), screen.getByRole("main"));
    search("Search Shared with me", "blood");
    expect(humanValue(shownDocuments())).toEqual([
      ["FAKE Blood shared.pdf", "In Shared with me"],
    ]);
    expect(screen.getByText(humanText("1 document found"))).toBeVisible();
    dragFolder(sharedRow(), screen.getByRole("main"));
    search("Search Shared with me", "lab");
    expect(
      screen.queryAllByRole("article", { name: humanText(/ folder$/) }),
    ).toHaveLength(0);
    expect(humanValue(shownDocuments())).toEqual([]);
    search("Search Shared with me", "");
    expect(humanValue(shownDocuments())).toEqual([
      ["FAKE Blood shared.pdf", null],
    ]);
    expect(bridge.updateFolder).not.toHaveBeenCalled();
    expect(bridge.assignFoldersBatch).not.toHaveBeenCalled();
  });

  it("keeps hidden documents out of recursive search results and their paths", () => {
    renderLibrary({
      ...filed,
      records: filed.records.map((r) =>
        r.id === "lab-deep"
          ? { ...r, hidden: { atMs: 2, reason: "patient" as const } }
          : r,
      ),
    });
    search("Search everything in My records", "blood");
    expect(humanValue(shownDocuments())).toHaveLength(4);
    expect(
      shownDocuments().some(([, path]) => path?.endsWith("FAKE June")),
    ).toBe(false);
    openFolder(/^FAKE Lab results/);
    search("Search this folder and its subfolders", "blood test");
    expect(humanValue(shownDocuments())).toEqual([
      ["FAKE Blood test.pdf", "In My records / FAKE Lab results"],
    ]);
  });

  it("from the top level covers the current person, and says where each result is", () => {
    renderLibrary(filed);
    search("Search everything in My records", "blood");

    expect(humanValue(shownDocuments())).toEqual([
      ["FAKE Blood pressure log.pdf", "In My records"],
      ["FAKE Blood test.pdf", "In My records / FAKE Lab results"],
      [
        "FAKE Blood test.pdf",
        "In My records / FAKE Lab results / FAKE 2026 / FAKE June",
      ],
      ["FAKE Blood test referral.pdf", "In My records / FAKE Letters"],
      [
        "FAKE Blood count.pdf",
        "In My records / FAKE Lab results / FAKE 2026; My records / FAKE Letters",
      ],
    ]);
    expect(
      screen.getByText(humanText("0 folders · 5 documents found")),
    ).toBeVisible();
  });

  it("from a folder covers it and every folder beneath it, and nothing else", () => {
    renderLibrary(filed);
    openFolder(/^FAKE Lab results/);
    search("Search this folder and its subfolders", "blood test");

    // The referral matches too, but is filed in another branch.
    expect(humanValue(shownDocuments())).toEqual([
      ["FAKE Blood test.pdf", "In My records / FAKE Lab results"],
      [
        "FAKE Blood test.pdf",
        "In My records / FAKE Lab results / FAKE 2026 / FAKE June",
      ],
    ]);
    // The path is read out with the document's buttons too.
    const deep = screen.getAllByRole("article", {
      name: humanText("FAKE Blood test.pdf document"),
    })[1];
    for (const name of ["FAKE Blood test.pdf", "Select FAKE Blood test.pdf"])
      expect(
        within(deep).getByRole("button", { name: humanText(name) }),
      ).toHaveHumanAccessibleDescription(
        "In My records / FAKE Lab results / FAKE 2026 / FAKE June",
      );
  });

  it("finds a document two levels below where the search starts", () => {
    renderLibrary(filed);
    openFolder(/^FAKE Lab results/);
    search("Search this folder and its subfolders", "fake blood test.pdf");

    expect(humanValue(shownDocuments())).toContainEqual([
      "FAKE Blood test.pdf",
      "In My records / FAKE Lab results / FAKE 2026 / FAKE June",
    ]);
  });

  it("shows a document filed in two folders once, with both paths", () => {
    renderLibrary(filed);
    openFolder(/^FAKE Lab results/);
    search("Search this folder and its subfolders", "count");

    expect(humanValue(shownDocuments())).toEqual([
      [
        "FAKE Blood count.pdf",
        "In My records / FAKE Lab results / FAKE 2026; My records / FAKE Letters",
      ],
    ]);
  });

  it("finds folders at any depth, each with where it is", () => {
    renderLibrary(filed);
    search("Search everything in My records", "june");

    const rows = screen.getAllByRole("article", {
      name: humanText("FAKE June folder"),
    });
    expect(
      humanValue(
        rows.map((row) => within(row).getByText(humanText(/^In /)).textContent),
      ),
    ).toEqual([
      "In My records / FAKE Lab results / FAKE 2026",
      "In My records / FAKE Letters",
    ]);
    expect(
      within(rows[0]).getByRole("button", {
        name: humanText("Open FAKE June"),
      }),
    ).toHaveHumanAccessibleDescription(
      "1 item In My records / FAKE Lab results / FAKE 2026",
    );

    // From a folder: only the folders beneath it, not the open folder itself.
    openFolder(/^FAKE Letters/);
    search("Search this folder and its subfolders", "fake");
    expect(
      screen
        .getAllByRole("article", { name: humanText(/ folder$/) })
        .map((row) => visibleText(row.getAttribute("aria-label") ?? "")),
    ).toEqual(["FAKE June folder"]);
  });

  it("goes back to the open folder's own items when cleared", () => {
    renderLibrary(filed);
    openFolder(/^FAKE Lab results/);
    search("Search this folder and its subfolders", "blood");
    expect(humanValue(shownDocuments())).toHaveLength(3);

    search("Search this folder and its subfolders", "");
    expect(humanValue(shownDocuments())).toEqual([
      ["FAKE Blood test.pdf", null],
    ]);
    expect(
      screen
        .getAllByRole("article", { name: humanText(/ folder$/) })
        .map((row) => [
          visibleText(row.getAttribute("aria-label") ?? ""),
          within(row).queryByText(humanText(/^In /)),
        ]),
    ).toEqual([["FAKE 2026 folder", null]]);
    expect(
      screen.getByText(humanText("1 folder · 1 document in this location")),
    ).toBeVisible();
  });

  it("moves a result from a subfolder, and starts the selection again when the search changes", async () => {
    const { bridge } = renderLibrary(filed);
    search("Search everything in My records", "blood test.pdf");
    const selectDeep = () =>
      fireEvent.click(
        within(
          screen
            .getAllByRole("article", {
              name: humanText("FAKE Blood test.pdf document"),
            })
            .find((row) => within(row).queryByText(humanText(/FAKE June$/)))!,
        ).getByRole("button", {
          name: humanText("Select FAKE Blood test.pdf"),
        }),
      );
    selectDeep();
    expect(screen.getByText(humanText("1 selected"))).toBeVisible();
    fireEvent.change(screen.getByLabelText(humanText("Move selected to")), {
      target: { value: "letters" },
    });
    fireEvent.click(screen.getByRole("button", { name: humanText("Move") }));
    await vi.waitFor(() =>
      expect(bridge.assignFoldersBatch).toHaveBeenCalledWith(
        ["lab-deep"],
        ["letters"],
      ),
    );

    // Once the search changes, the selection starts again, so a move acts
    // only on documents chosen while in view.
    await vi.waitFor(() =>
      expect(
        screen.queryByText(humanText(/selected$/)),
      ).not.toBeInTheDocument(),
    );
    selectDeep();
    expect(screen.getByText(humanText("1 selected"))).toBeVisible();
    search("Search everything in My records", "");
    expect(screen.queryByText(humanText(/selected$/))).not.toBeInTheDocument();
  });

  it("does not move a result let go of over the results it came from", () => {
    const { bridge } = renderLibrary(filed);
    openFolder(/^FAKE Lab results/);
    search("Search this folder and its subfolders", "june");
    dragFolder(
      screen.getByRole("article", { name: humanText("FAKE June folder") }),
      screen.getByRole("main"),
    );
    search("Search this folder and its subfolders", "blood test");
    dragFolder(
      screen.getAllByRole("article", {
        name: humanText("FAKE Blood test.pdf document"),
      })[1],
      screen.getByRole("main"),
    );
    expect(bridge.updateFolder).not.toHaveBeenCalled();
    expect(bridge.assignFoldersBatch).not.toHaveBeenCalled();
  });
});

describe("VaultLibrary controls for older patients (#67)", () => {
  const withRecord: VaultSnapshot = {
    ...snapshot,
    records: [
      {
        id: "record-1",
        profileId: "profile-1",
        folderIds: [],
        displayName: "FAKE Results.pdf",
        sourceLabel: "Manual import — unverified",
        mediaType: "application/pdf",
        plaintextSize: 2048,
        importedAtMs: Date.UTC(2026, 0, 16, 12),
        available: true,
      },
    ],
  };

  it("puts words on its buttons and sorts the documents with both choices", () => {
    renderLibrary({
      ...withRecord,
      records: [
        withRecord.records[0],
        {
          ...record("blood-pressure", "FAKE Blood pressure log.pdf", []),
          importedAtMs: Date.UTC(2026, 0, 14, 12),
        },
        {
          ...record("manual-document", "FAKE Manual document.pdf", []),
          importedAtMs: Date.UTC(2026, 0, 15, 12),
        },
      ],
    });
    const documentNames = () =>
      humanValue(shownDocuments().map(([name]) => name));
    const details = screen.getByRole("button", {
      name: humanText("Details for FAKE Results.pdf"),
    });
    expect(details).toHaveHumanTextContent(/^Details$/);
    expect(
      screen.getByRole("button", { name: humanText("List view") }),
    ).toHaveHumanTextContent("List");
    expect(
      screen.getByRole("button", { name: humanText("Grid view") }),
    ).toHaveHumanTextContent("Grid");
    // Sort is a row of words, not a dropdown with only an icon, and each
    // choice is its own Tab stop (#121).
    const sort = screen.getByRole("group", { name: humanText("Sort by") });
    const sortChoices = within(sort).getAllByRole("button");
    expect(sortChoices.map((choice) => choice.textContent)).toEqual([
      "Newest first",
      "Name A–Z",
    ]);
    expect(sortChoices.map((choice) => choice.tabIndex)).toEqual([0, 0]);
    expect(sortChoices[0]).toHaveAttribute("aria-pressed", "true");
    expect(documentNames()).toEqual([
      "FAKE Results.pdf",
      "FAKE Manual document.pdf",
      "FAKE Blood pressure log.pdf",
    ]);
    fireEvent.click(sortChoices[1]);
    expect(sortChoices[1]).toHaveAttribute("aria-pressed", "true");
    expect(sortChoices[0]).toHaveAttribute("aria-pressed", "false");
    expect(documentNames()).toEqual([
      "FAKE Blood pressure log.pdf",
      "FAKE Manual document.pdf",
      "FAKE Results.pdf",
    ]);
    fireEvent.click(sortChoices[0]);
    expect(sortChoices[0]).toHaveAttribute("aria-pressed", "true");
    expect(sortChoices[1]).toHaveAttribute("aria-pressed", "false");
    expect(documentNames()).toEqual([
      "FAKE Results.pdf",
      "FAKE Manual document.pdf",
      "FAKE Blood pressure log.pdf",
    ]);
    fireEvent.click(details);
    expect(
      screen.getByRole("button", { name: humanText("Close document details") }),
    ).toHaveHumanTextContent(/^Close$/);
  });
});

describe("VaultLibrary moving and selecting without dragging (#67)", () => {
  const withRecord: VaultSnapshot = {
    ...snapshot,
    records: [
      {
        id: "record-1",
        profileId: "profile-1",
        folderIds: [],
        displayName: "FAKE Results.pdf",
        sourceLabel: "Manual import — unverified",
        mediaType: "application/pdf",
        plaintextSize: 2048,
        importedAtMs: Date.UTC(2026, 0, 16, 12),
        available: true,
      },
    ],
  };

  it("says how to move without dragging", () => {
    renderLibrary(withRecord);
    expect(
      screen.getByText(
        humanText(
          "Hold and drag a document or folder to move it, or open it and choose Move to.",
        ),
      ),
    ).toBeVisible();
  });

  it("selects a document in grid view as in list view, with a 44px target", () => {
    renderLibrary(withRecord);
    const listTick = screen.getByRole("button", {
      name: humanText("Select FAKE Results.pdf"),
    });
    const box = listTick.getBoundingClientRect();
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Grid view") }),
    );
    const gridTick = screen.getByRole("button", {
      name: humanText("Select FAKE Results.pdf"),
    });
    const tile = gridTick.getBoundingClientRect();
    expect(Math.min(tile.width, tile.height)).toBeGreaterThanOrEqual(44);
    fireEvent.click(gridTick);
    expect(gridTick).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(humanText("1 selected"))).toBeVisible();
  });
});

describe("VaultLibrary choices without dropdowns (#67)", () => {
  const twoPatients: VaultSnapshot = {
    ...snapshot,
    profiles: [
      { id: "profile-1", displayName: "FAKE Avery", createdAtMs: 1 },
      { id: "profile-2", displayName: "FAKE Blake", createdAtMs: 2 },
    ],
  };

  it("shows each person as a top-level folder over their own folders, with Shared with me beside them (Ben, 21 Oct)", () => {
    renderLibrary(twoPatients);
    expect(
      screen.queryByRole("group", { name: humanText("Patient") }),
    ).toBeNull();
    const library = screen.getByRole("navigation", {
      name: humanText("Record library"),
    });
    const names = () =>
      Array.from(library.querySelectorAll(".native-nav-name")).map(
        (name) => name.textContent,
      );
    expect(names()).toEqual([
      "FAKE Avery",
      "FAKE Letters",
      "FAKE 2025 Letters",
      "FAKE June Letters",
      "FAKE Blake",
      "Shared with me",
    ]);
    // Shared with me is no one's: at the top level, never indented under a
    // person as their folders are.
    const shared = within(library).getByRole("button", {
      name: humanText(/^Shared with me/),
    });
    const letters = within(library).getByRole("button", {
      name: humanText(/^FAKE Letters/),
    });
    expect(shared.style.paddingLeft).toBe("");
    expect(letters.style.paddingLeft).not.toBe("");
    // Whose folder it is, for a screen reader.
    expect(letters).toHaveHumanAccessibleName("FAKE Letters (FAKE Avery) 0");
    const avery = within(library).getByRole("button", {
      name: humanText(/^FAKE Avery/),
    });
    const blake = within(library).getByRole("button", {
      name: humanText(/^FAKE Blake/),
    });
    expect(avery).toHaveAttribute("aria-current", "page");
    fireEvent.click(blake);
    expect(blake).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { level: 1 })).toHaveHumanTextContent(
      "FAKE Blake",
    );
    // Blake's records hold none of Avery's folders.
    expect(
      screen.queryByRole("article", { name: humanText("FAKE Letters folder") }),
    ).toBeNull();
    // Opening one of Avery's folders from Blake's opens it at once, with
    // the person in the path.
    fireEvent.click(
      within(library).getByRole("button", {
        name: humanText(/^FAKE 2025 Letters/),
      }),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveHumanTextContent(
      "FAKE 2025 Letters",
    );
    expect(
      within(
        document.querySelector(".native-profile-row") as HTMLElement,
      ).getByRole("button", { name: humanText("FAKE Avery") }),
    ).toBeVisible();
    expect(
      document.querySelector(".native-profile-row"),
    ).toHaveHumanTextContent("FAKE Avery›FAKE 2025 Letters");
    cleanup();

    // With one person, their folder is "My records".
    renderLibrary(snapshot);
    expect(
      Array.from(
        screen
          .getByRole("navigation", { name: humanText("Record library") })
          .querySelectorAll(".native-nav-name"),
      ).map((name) => name.textContent),
    ).toEqual([
      "My records",
      "FAKE Letters",
      "FAKE 2025 Letters",
      "FAKE June Letters",
      "Shared with me",
    ]);
  });

  it("forgets the previous person's bulk selection and destination before moving another person's document", async () => {
    const shown: VaultSnapshot = {
      ...twoPatients,
      folders: [
        ...twoPatients.folders,
        {
          ...folder("blake-visits", "FAKE Blake visits", null),
          profileId: "profile-2",
        },
      ],
      records: [
        record("avery-document", "FAKE Avery note.pdf", []),
        {
          ...record("blake-document", "FAKE Blake note.pdf", ["blake-visits"]),
          profileId: "profile-2",
        },
      ],
    };
    const { bridge } = renderLibrary(shown);
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText("Select FAKE Avery note.pdf"),
      }),
    );
    const oldDestination = screen.getByLabelText(humanText("Move selected to"));
    fireEvent.change(oldDestination, { target: { value: "letters" } });
    expect(oldDestination).toHaveValue("letters");
    expect(bridge.assignFoldersBatch).not.toHaveBeenCalled();

    openFolder(/^FAKE Blake visits/);
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: humanText("FAKE Blake visits"),
      }),
    ).toBeVisible();
    expect(screen.queryByLabelText(humanText("Move selected to"))).toBeNull();
    expect(screen.queryByText(humanText("FAKE Avery note.pdf"))).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText("Select FAKE Blake note.pdf"),
      }),
    );
    const destination = screen.getByLabelText(humanText("Move selected to"));
    expect(destination).toHaveValue("");
    expect(
      within(destination).queryByRole("option", {
        name: humanText("FAKE Letters"),
      }),
    ).toBeNull();
    // A select can visually fall back to the first option while retaining a
    // stale folder ID in state. Check the actual move, not just its label.
    fireEvent.click(screen.getByRole("button", { name: humanText("Move") }));
    await vi.waitFor(() =>
      expect(bridge.assignFoldersBatch).toHaveBeenCalledExactlyOnceWith(
        ["blake-document"],
        [],
      ),
    );
  });

  it("shows Shared with me's whole name in the sidebar, with its new count on one line (#61)", () => {
    renderLibrary(snapshot, 2);
    const shared = screen.getByRole("button", {
      name: humanText("Shared with me, 2 new"),
    });
    const name = shared.querySelector(".native-nav-name")!;
    expect(name.textContent).toBe("Shared with me");
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
    const text = document.createRange();
    text.selectNodeContents(within(shared).getByText(humanText("2 new")));
    const lines = new Set(
      [...text.getClientRects()].map((box) => Math.round(box.top)),
    );
    expect(lines.size).toBe(1);
  });

  it("moves only the open person's folders by drag, with the right notice (Ben, 21 Oct)", async () => {
    const withBlakeFolder: VaultSnapshot = {
      ...twoPatients,
      folders: [
        ...twoPatients.folders,
        {
          id: "blake-forms",
          profileId: "profile-2",
          parentId: null,
          name: "FAKE School forms",
          createdAtMs: Date.UTC(2026, 0, 15, 12),
        },
      ],
    };
    const { bridge, setNotice } = renderLibrary(withBlakeFolder);
    const library = screen.getByRole("navigation", {
      name: humanText("Record library"),
    });
    // Avery is open: Blake's folder shows, but does not move by drag.
    const blakes = within(library).getByRole("button", {
      name: humanText(/^FAKE School forms/),
    });
    expect(blakes).not.toHaveAttribute("draggable");
    expect(
      within(library).getByRole("button", {
        name: humanText(/^FAKE June Letters/),
      }),
    ).toHaveAttribute("draggable", "true");
    // Within Avery's own, a folder still moves.
    dragFolder(
      within(library).getByRole("button", {
        name: humanText(/^FAKE June Letters/),
      }),
      within(library).getByRole("button", { name: humanText(/^FAKE Letters/) }),
    );
    await vi.waitFor(() =>
      expect(bridge.updateFolder).toHaveBeenCalledWith(
        "letters-2025-june",
        "letters",
        "FAKE June Letters",
      ),
    );
    await vi.waitFor(() =>
      expect(
        humanValue(setNotice.mock.calls.map(([notice]) => resolveText(notice))),
      ).toContain("FAKE June Letters moved to FAKE Letters."),
    );
  });

  it("shows the sections as a row of tabs on a narrow window, and the top-level folders under the path", async () => {
    await page.viewport(390, 844);
    try {
      renderLibrary(twoPatients, 2);
      expect(
        screen.queryByRole("combobox", { name: humanText("Section") }),
      ).toBeNull();
      const sections = screen.getByRole("navigation", {
        name: humanText("Section"),
      });
      const tabs = within(sections).getAllByRole("button");
      // Records holds the people and Shared with me (Ben, 21 Oct); it says
      // how many shared files are new (#61).
      // On a computer the AI helper's settings are a tab too (#72).
      expect(humanValue(tabs.map((tab) => tab.textContent))).toEqual([
        "Records (2 new)",
        "Security",
        "Preferences",
        "AI helper",
      ]);
      expect(tabs[0]).toHaveAttribute("aria-current", "page");
      // The sidebar is hidden here; the same top-level folders sit under
      // the path, and exactly one list of them is in reach.
      const library = screen.getByRole("navigation", {
        name: humanText("Record library"),
      });
      expect(
        within(library)
          .getAllByRole("button")
          .map((button) => visibleText(button.textContent?.trim() ?? "")),
      ).toEqual(["FAKE Avery", "FAKE Blake", "Shared with me (2 new)"]);
      fireEvent.click(
        within(library).getByRole("button", {
          name: humanText(/^Shared with me/),
        }),
      );
      expect(tabs[0]).toHaveAttribute("aria-current", "page");
      expect(
        within(library).getByRole("button", {
          name: humanText(/^Shared with me/),
        }),
      ).toHaveAttribute("aria-current", "page");
      fireEvent.click(tabs[2]);
      expect(tabs[2]).toHaveAttribute("aria-current", "page");
      expect(tabs[0]).not.toHaveAttribute("aria-current");
      cleanup();

      // With one person: My records and Shared with me.
      renderLibrary(snapshot, 2);
      expect(
        within(
          screen.getByRole("navigation", { name: humanText("Record library") }),
        )
          .getAllByRole("button")
          .map((button) => visibleText(button.textContent?.trim() ?? "")),
      ).toEqual(["My records", "Shared with me (2 new)"]);
    } finally {
      await page.viewport(1100, 760);
    }
  });
});

describe("the reminder to add a person's details (#234)", () => {
  const people: VaultSnapshot = {
    ...snapshot,
    profiles: [
      ...snapshot.profiles,
      { id: "profile-2", displayName: "FAKE Child", createdAtMs: 2 },
    ],
  };
  const withDetails = (shown: VaultSnapshot = people) =>
    renderLibrary(shown, 0, {
      updateProfileDetails: vi.fn().mockResolvedValue(undefined),
    });
  const note = () =>
    screen.queryByRole("note", {
      name: humanText("Full name and date of birth"),
    });

  it("names the open person first, and Not now waits until the vault opens again", () => {
    withDetails();
    expect(note()).toHaveHumanTextContent(
      "Add FAKE Avery's full name and date of birth.",
    );
    fireEvent.click(
      within(note()!).getByRole("button", { name: humanText("Not now") }),
    );
    // The next person without details, then none.
    expect(note()).toHaveHumanTextContent(
      "Add FAKE Child's full name and date of birth.",
    );
    fireEvent.click(
      within(note()!).getByRole("button", { name: humanText("Not now") }),
    );
    expect(note()).toBeNull();
  });

  it("leads to Edit details with that person's form open", async () => {
    withDetails();
    fireEvent.click(
      within(note()!).getByRole("button", { name: humanText("Edit details") }),
    );
    const form = await screen.findByRole("form", {
      name: humanText("Details for FAKE Avery"),
    });
    await vi.waitFor(() =>
      expect(
        within(form).getByLabelText(
          humanText("Full name, as on clinic documents"),
        ),
      ).toHaveFocus(),
    );
  });

  it("opens Edit details once: a later visit to Security does not open it again", async () => {
    withDetails();
    fireEvent.click(
      within(note()!).getByRole("button", { name: humanText("Edit details") }),
    );
    const details = () =>
      screen.queryByRole("form", { name: humanText("Details for FAKE Avery") });
    await vi.waitFor(() => expect(details()).not.toBeNull());
    fireEvent.click(
      within(details()!).getByRole("button", { name: humanText("Cancel") }),
    );
    await vi.waitFor(() => expect(details()).toBeNull());
    // Away to Audit history, and back to Security.
    fireEvent.click(screen.getByRole("button", { name: "Audit history" }));
    await screen.findByText("There are no history events.");
    fireEvent.click(screen.getByRole("button", { name: /Back to Security/i }));
    expect(screen.getByRole("button", { name: "Audit history" })).toBeVisible();
    expect(details()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is not shown once each person has a full name", () => {
    withDetails({
      ...people,
      profiles: people.profiles.map((person) => ({
        ...person,
        fullName: `${person.displayName} Example`,
      })),
    });
    expect(note()).toBeNull();
  });

  it("is not shown where details cannot be edited: recovery mode", () => {
    withDetails({ ...people, recovery: "lostObjects" });
    expect(note()).toBeNull();
  });
});

describe("Settings > AI helper (#72)", () => {
  it("is its own page on a computer, beside Security and Preferences, and Preferences no longer holds it", async () => {
    renderLibrary();
    const sidebar = screen.getByRole("navigation", {
      name: humanText("Record library"),
    });
    fireEvent.click(
      within(sidebar).getByRole("button", { name: humanText("AI helper") }),
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: humanText("AI helper"),
      }),
    ).toBeVisible();
    expect(
      screen.getByText(humanText("How the AI helper works on this computer")),
    ).toBeVisible();
    // The model's row, as Preferences had it: not installed here.
    expect(await screen.findByText(humanText("Not installed"))).toBeVisible();
    fireEvent.click(
      within(sidebar).getByRole("button", { name: humanText("Preferences") }),
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: humanText("Preferences"),
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: humanText(/AI helper/) }),
    ).toBeNull();
  });

  it("is not offered on a phone, where the helper cannot run", () => {
    renderLibrary(snapshot, 0, {}, false);
    expect(
      screen.queryByRole("button", { name: humanText("AI helper") }),
    ).toBeNull();
  });
});

describe("VaultLibrary Check for new documents (Ben, 29 Oct)", () => {
  // A clinic this vault is linked to (FAKE), so the library shows its
  // compact Check for new documents.
  const link: PortalLinkSummary = {
    id: "fake-link",
    portalBase: "https://portal.example.test/patient",
    deviceName: "myCarlos on Windows",
    profileId: null,
    clinicName: "FAKE Clinic",
    fingerprints: [],
    incomplete: false,
    deviceKeyId: "fake-device",
    deviceFingerprint: "11".repeat(32),
    approvalRequested: true,
    clinicApproved: true,
  };
  // The clinic-approval chain (#136 → #142) links with connectPortal; the
  // panel, and its compact Check, are offered only with it.
  const portal = {
    connectPortal: vi.fn(),
    checkDocuments: vi
      .fn()
      .mockResolvedValue({ added: 0, refused: 0, receiptsPending: 0 }),
  };
  const linked: VaultSnapshot = {
    ...snapshot,
    portalLinkingEnabled: true,
    portalLinks: [link],
    sharedProfileId: "shared",
    profiles: [
      ...snapshot.profiles,
      { id: "profile-2", displayName: "FAKE Blake", createdAtMs: 2 },
      { id: "shared", displayName: "Shared with me", createdAtMs: 3 },
    ],
  };
  const box = (element: Element) => element.getBoundingClientRect();

  it("sits to the right of the search box, and under it on a narrow window", async () => {
    renderLibrary(linked, 0, portal);
    openFolder(/^Shared with me/);
    const search = screen.getByRole("searchbox").closest("label")!;
    const check = screen.getByRole("button", {
      name: humanText("Check for new documents"),
    });
    // After the search box in reading and Tab order, in the same row.
    expect(
      search.compareDocumentPosition(check) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(check.parentElement).toBe(search.parentElement);
    try {
      await page.viewport(1100, 760);
      expect(box(check).left).toBeGreaterThanOrEqual(box(search).right);
      expect(box(check).top).toBeLessThan(box(search).bottom);
      // Narrow (a phone, or large text): the box keeps its width and the
      // button goes under it.
      await page.viewport(360, 800);
      expect(box(check).top).toBeGreaterThanOrEqual(box(search).bottom);
    } finally {
      await page.viewport(1100, 760);
    }
  });

  it("leaves the search box the whole row when there is no clinic link", () => {
    renderLibrary({ ...snapshot, portalLinkingEnabled: true }, 0, portal);
    const search = screen.getByRole("searchbox").closest("label")!;
    expect(
      screen.queryByRole("button", {
        name: humanText("Check for new documents"),
      }),
    ).toBeNull();
    expect(box(search).width).toBeCloseTo(box(search.parentElement!).width, 0);
  });
  it("only offers Check in actual Shared with me through folder and settings transitions", () => {
    renderLibrary(linked, 0, portal);
    const absent = () =>
      expect(
        screen.queryByRole("button", {
          name: humanText("Check for new documents"),
        }),
      ).toBeNull();
    absent();
    openFolder(/^FAKE Letters/);
    absent();
    openFolder(/^Shared with me/);
    expect(
      screen.getByRole("button", {
        name: humanText("Check for new documents"),
      }),
    ).toBeEnabled();
    search("Search Shared with me", "FAKE");
    expect(
      screen.getByRole("button", {
        name: humanText("Check for new documents"),
      }),
    ).toBeVisible();
    openFolder(/^FAKE Blake/);
    absent();
    openFolder(/^Shared with me/);
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    absent();
    expect(
      screen.getByRole("heading", { name: "Clinic documents" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Preferences" }));
    absent();
    openFolder(/^Shared with me/);
    expect(
      screen.getByRole("button", {
        name: humanText("Check for new documents"),
      }),
    ).toBeEnabled();
    expect(portal.checkDocuments).not.toHaveBeenCalled();
  });

  it("does not treat an ordinary folder named Shared with me as the reserved view", () => {
    renderLibrary(
      {
        ...linked,
        folders: [
          ...linked.folders,
          {
            id: "decoy",
            profileId: "profile-1",
            parentId: null,
            name: "Shared with me",
            createdAtMs: 4,
          },
        ],
      },
      0,
      portal,
    );
    openFolder(/^Shared with me \(FAKE Avery\)/);
    expect(
      screen.queryByRole("button", {
        name: humanText("Check for new documents"),
      }),
    ).toBeNull();
  });

  it.each(["busy", "portalBusy"] as const)(
    "retains the %s check disable contract inside Shared with me",
    (key) => {
      renderLibrary(linked, 0, portal, true, { [key]: true });
      openFolder(/^Shared with me/);
      const name =
        key === "portalBusy"
          ? "Clinic operation in progress…"
          : "Check for new documents";
      expect(
        screen.getByRole("button", { name: humanText(name) }),
      ).toBeDisabled();
    },
  );

  it("keeps a started check's result announcement after leaving Shared with me", async () => {
    let finish: (value: {
      added: number;
      refused: number;
      receiptsPending: number;
    }) => void = () => undefined;
    const checkDocuments = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { setNotice } = renderLibrary(linked, 0, {
      ...portal,
      checkDocuments,
    });
    openFolder(/^Shared with me/);
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText("Check for new documents"),
      }),
    );
    expect(checkDocuments).toHaveBeenCalledExactlyOnceWith();
    openFolder(/^FAKE Letters/);
    finish({ added: 2, refused: 0, receiptsPending: 0 });
    await waitFor(() => expect(setNotice).toHaveBeenCalled());
    expect(visibleText(resolveText(setNotice.mock.calls.at(-1)![0]))).toContain(
      "New documents saved: 2.",
    );
    expect(
      screen.queryByRole("button", {
        name: humanText("Check for new documents"),
      }),
    ).toBeNull();
  });
});

describe("Audit history keeps Security's Hidden location", () => {
  it.each(["back", "persistent navigation"])(
    "keeps Shared with me after returning by %s",
    async (route) => {
      const shared: VaultSnapshot = {
        ...snapshot,
        sharedProfileId: "shared",
        profiles: [
          ...snapshot.profiles,
          { id: "shared", displayName: "Shared with me", createdAtMs: 2 },
        ],
        records: [
          {
            ...record("person-hidden", "FAKE person secret.pdf", []),
            hidden: { atMs: 2, reason: "patient" },
          },
          {
            ...record("shared-hidden", "FAKE shared secret.pdf", []),
            profileId: "shared",
            hidden: { atMs: 2, reason: "patient" },
          },
        ],
      };
      renderLibrary(shared);
      openFolder(/^Shared with me/);
      fireEvent.click(screen.getByRole("button", { name: "Security" }));
      expect(
        screen.getByRole("button", { name: /^Hidden 1 Shared with me/ }),
      ).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Audit history" }));
      await screen.findByText("There are no history events.");
      fireEvent.click(
        screen.getByRole("button", {
          name: route === "back" ? /Back to Security/i : "Security",
        }),
      );
      const hidden = screen.getByRole("button", {
        name: /^Hidden 1 Shared with me/,
      });
      if (route === "back")
        expect(
          screen.getByRole("button", { name: "Audit history" }),
        ).toHaveFocus();
      fireEvent.click(hidden);
      expect(
        screen.getByRole("article", {
          name: humanText("FAKE shared secret.pdf, hidden"),
        }),
      ).toBeVisible();
      expect(
        screen.queryByText("FAKE person secret.pdf"),
      ).not.toBeInTheDocument();
    },
  );
});

describe("VaultLibrary person dialogs (Ben, 29 Oct)", () => {
  // A status line reads out only text that changes while it is on the page,
  // and a dialog makes the page behind it inert: each result is given once
  // the dialog has closed.
  function watchNotices(setNotice: ReturnType<typeof vi.fn>) {
    const said: { text: string; dialogOpen: boolean }[] = [];
    setNotice.mockImplementation((notice) => {
      const text = humanValue(resolveText(notice));
      if (text)
        said.push({ text, dialogOpen: screen.queryByRole("dialog") !== null });
    });
    return said;
  }

  for (const dismissal of ["Cancel", "Escape"] as const) {
    it(`dismisses Edit details after a read-only recovery transition by ${dismissal}`, async () => {
      const shown: VaultSnapshot = {
        ...snapshot,
        profiles: [
          {
            ...snapshot.profiles[0],
            fullName: "FAKE Avery Example",
            birthDate: "1980-01-02",
          },
        ],
      };
      const updateProfileDetails = vi.fn().mockResolvedValue(undefined);
      const { rerenderSnapshot } = renderLibrary(shown, 0, {
        updateProfileDetails,
      });
      fireEvent.click(screen.getByRole("button", { name: "Security" }));
      const opener = screen.getByRole("button", {
        name: humanText("Edit details for FAKE Avery"),
      });
      opener.focus();
      fireEvent.click(opener);
      const dialog = screen.getByRole("dialog", {
        name: humanText("Edit details"),
      });
      expect(opener.closest("[inert]")).not.toBeNull();
      const line = opener.parentElement!.querySelector("span")!;
      const name = within(dialog).getByLabelText(
        humanText("Full name, as on clinic documents"),
      );
      fireEvent.change(name, { target: { value: "FAKE retained draft" } });
      rerenderSnapshot({ ...shown, recovery: "writeFailed" });
      expect(name).toHaveValue("FAKE retained draft");
      expect(name).toBeDisabled();
      expect(
        within(dialog).getByRole("button", { name: humanText("Save details") }),
      ).toBeDisabled();
      fireEvent.submit(dialog.querySelector("form")!);
      expect(updateProfileDetails).not.toHaveBeenCalled();
      const cancel = within(dialog).getByRole("button", {
        name: humanText("Cancel"),
      });
      expect(cancel).toBeEnabled();
      if (dismissal === "Cancel") fireEvent.click(cancel);
      else fireEvent.keyDown(document.body, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(opener.closest("[inert]")).toBeNull();
      expect(opener).toBeDisabled();
      expect(line).toHaveFocus();
      expect(updateProfileDetails).not.toHaveBeenCalled();
    });
  }

  it("says a person's details were saved once the Edit details dialog has closed", async () => {
    const updateProfileDetails = vi.fn().mockResolvedValue(undefined);
    const { setNotice } = renderLibrary(
      {
        ...snapshot,
        profiles: [
          {
            id: "profile-1",
            displayName: "FAKE Avery",
            createdAtMs: 1,
            fullName: "FAKE-EXAMPLE, Avery",
            birthDate: "1980-01-02",
          },
        ],
      },
      0,
      { updateProfileDetails },
    );
    const said = watchNotices(setNotice as ReturnType<typeof vi.fn>);
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText("Edit details for FAKE Avery"),
      }),
    );
    const dialog = screen.getByRole("dialog", {
      name: humanText("Edit details"),
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: humanText("Save details") }),
    );
    await vi.waitFor(() => expect(updateProfileDetails).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(said).toEqual([
        { text: "Details for FAKE Avery saved.", dialogOpen: false },
      ]),
    );
  });

  it("says a profile was added once the Add profile dialog has closed", async () => {
    const createProfile = vi.fn().mockResolvedValue("profile-2");
    const { setNotice } = renderLibrary(snapshot, 0, { createProfile });
    const said = watchNotices(setNotice as ReturnType<typeof vi.fn>);
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Add profile") }),
    );
    const dialog = screen.getByRole("dialog", {
      name: humanText("Add profile"),
    });
    fireEvent.change(
      within(dialog).getByLabelText(humanText("New profile name")),
      { target: { value: "FAKE Riley" } },
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: humanText("Add profile") }),
    );
    await vi.waitFor(() => expect(createProfile).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(said).toEqual([
        { text: "FAKE Riley was added.", dialogOpen: false },
      ]),
    );
  });
});

describe("VaultLibrary for a screen reader (#121)", () => {
  afterEach(() => setLocaleOverride(null));

  /** Lets the page's next animation frames run: the heading takes the focus
   * in one. */
  const nextFrames = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  const heading = () => screen.getByRole("heading", { level: 1 });

  it("takes the focus to the new place's heading when the reader opens one, by key or by pointer", async () => {
    const user = userEvent.setup();
    // The library opens after a pointer press, so #111's recovery on entry
    // (keyboard users only) leaves the focus alone.
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    renderLibrary();
    const sidebar = screen.getByRole("navigation", {
      name: humanText("Record library"),
    });
    await nextFrames();
    // Not when the library first shows.
    expect(heading()).not.toHaveFocus();
    // From the sidebar, by key: the heading then says where the reader is.
    within(sidebar)
      .getByRole("button", { name: humanText(/^FAKE Letters/) })
      .focus();
    await user.keyboard("{Enter}");
    expect(heading()).toHaveHumanTextContent("FAKE Letters");
    await vi.waitFor(() => expect(heading()).toHaveFocus());
    // From a folder in the page, by pointer: the same (Ben's D128).
    await user.click(
      screen.getByRole("button", {
        name: humanText(
          translate("en", "library.folder.open", { name: "FAKE 2025 Letters" }),
        ),
      }),
    );
    expect(heading()).toHaveHumanTextContent("FAKE 2025 Letters");
    await vi.waitFor(() => expect(heading()).toHaveFocus());
    // From the path, back to the top level.
    within(document.querySelector(".native-profile-row") as HTMLElement)
      .getByRole("button", { name: humanText("My records") })
      .focus();
    await user.keyboard("{Enter}");
    expect(heading()).toHaveHumanTextContent("My records");
    await vi.waitFor(() => expect(heading()).toHaveFocus());
    // Choosing the place already open leaves the focus where it is.
    const myRecords = within(sidebar).getByRole("button", {
      name: humanText(/^My records/),
    });
    myRecords.focus();
    await user.keyboard("{Enter}");
    await nextFrames();
    expect(myRecords).toHaveFocus();
    // Shared with me is a place too.
    await user.click(
      within(sidebar).getByRole("button", {
        name: humanText(/^Shared with me/),
      }),
    );
    expect(heading()).toHaveHumanTextContent("Shared with me");
    await vi.waitFor(() => expect(heading()).toHaveFocus());
  });

  it("describes the heading with the place and what it holds", () => {
    renderLibrary();
    expect(heading()).toHaveHumanAccessibleDescription(
      "In My records: 1 folder, 0 documents.",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText(
          translate("en", "library.folder.open", { name: "FAKE Letters" }),
        ),
      }),
    );
    expect(heading()).toHaveHumanAccessibleDescription(
      "In My records / FAKE Letters: 1 folder, 0 documents.",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText(
          translate("en", "library.folder.open", { name: "FAKE 2025 Letters" }),
        ),
      }),
    );
    expect(heading()).toHaveHumanAccessibleDescription(
      "In My records / FAKE Letters / FAKE 2025 Letters: 1 folder, 0 documents.",
    );
    // While a search is on, the line that counts what was found.
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "FAKE June" },
    });
    expect(heading()).toHaveHumanAccessibleDescription(/found$/);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: humanText("Record library") }),
      ).getByRole("button", { name: humanText(/^Shared with me/) }),
    );
    expect(heading()).toHaveHumanAccessibleDescription(
      "In Shared with me: 0 documents.",
    );
  });

  it("takes the focus to the heading of another person's folder opened from the sidebar, by key or by pointer", async () => {
    const user = userEvent.setup();
    const twoPeople: VaultSnapshot = {
      ...snapshot,
      profiles: [
        { id: "profile-1", displayName: "FAKE Avery", createdAtMs: 1 },
        { id: "profile-2", displayName: "FAKE Blake", createdAtMs: 2 },
      ],
    };
    renderLibrary(twoPeople);
    const sidebar = screen.getByRole("navigation", {
      name: humanText("Record library"),
    });
    const person = (name: string) =>
      within(sidebar).getByRole("button", {
        name: humanText(new RegExp(`^${name}`)),
      });
    // Blake's records first; then one of Avery's folders: the person changes,
    // then the folder opens, and only then does the heading take focus.
    await user.click(person("FAKE Blake"));
    await vi.waitFor(() => expect(heading()).toHaveFocus());
    person("FAKE 2025 Letters").focus();
    await user.keyboard("{Enter}");
    expect(heading()).toHaveHumanTextContent("FAKE 2025 Letters");
    await vi.waitFor(() => expect(heading()).toHaveFocus());
    await user.click(person("FAKE Blake"));
    await vi.waitFor(() =>
      expect(heading()).toHaveHumanTextContent("FAKE Blake"),
    );
    await user.click(person("FAKE June Letters"));
    expect(heading()).toHaveHumanTextContent("FAKE June Letters");
    await vi.waitFor(() => expect(heading()).toHaveFocus());
  });

  it("keeps the page behind Rename from a screen reader until Rename closes", async () => {
    renderLibrary();
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText("Rename folder FAKE Letters"),
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: humanText("Rename folder"),
    });
    // All a screen reader can reach is in the dialog (or holds it, as the
    // window does).
    for (const role of [
      "banner",
      "button",
      "group",
      "heading",
      "main",
      "navigation",
      "note",
      "region",
      "textbox",
    ] as const)
      for (const element of screen.queryAllByRole(role))
        if (!element.contains(dialog))
          expect(dialog, `${role}: ${element.textContent}`).toContainElement(
            element,
          );
    expect(screen.queryByRole("main")).toBeNull();
    expect(
      screen.queryByRole("button", { name: humanText("Lock now") }),
    ).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("button", { name: humanText("Cancel") }),
    );
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("main")).toBeVisible();
    expect(
      screen.getByRole("button", { name: humanText("Lock now") }),
    ).toBeVisible();
    expect(
      screen.getByRole("navigation", { name: humanText("Record library") }),
    ).toBeVisible();
    expect(screen.getByRole("note")).toBeVisible();
  });

  it("holds news for the polite line while Rename is open, and reads it out once Rename closes", async () => {
    const { setSharedNew } = renderLibrary();
    const polite = () =>
      document.querySelector('.native-vault-page > [aria-live="polite"]')!;
    const added = translate("en", "interface.notice.sharedAdded", {
      count: 2,
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText("Rename folder FAKE Letters"),
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: humanText("Rename folder"),
    });
    setSharedNew(2);
    await nextFrames();
    // Not hidden, which would lose it, and unchanged while the dialog is open.
    expect(polite()).not.toHaveAttribute("aria-hidden");
    expect(polite()).toHaveTextContent("");
    fireEvent.click(
      within(dialog).getByRole("button", { name: humanText("Cancel") }),
    );
    // Not as Rename closes, while focus returning is read out, but a moment
    // after.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(polite()).toHaveTextContent("");
    await vi.waitFor(() => expect(polite()).toHaveHumanTextContent(added));
  });

  it.each(LOCALES)(
    "names the window's lock button by the words it shows, and shows the sort label, in %s",
    (locale) => {
      setLocaleOverride(locale);
      renderLibrary();
      const lockNow = translate(locale, "security.lockNow");
      const lock = within(
        document.querySelector(".titlebar") as HTMLElement,
      ).getByRole("button");
      // WCAG 2.5.3: the name is the words on the button, so saying "click"
      // and what it shows works by voice; the state before them is not read.
      expect(lock).toHaveHumanAccessibleName(lockNow);
      expect(lock).toHaveHumanTextContent(
        `${translate(locale, "library.lock.unlocked")} · ${lockNow}`,
      );
      const label = translate(locale, "interface.VaultLibrary.sortBy");
      const sort = screen.getByRole("group", { name: humanText(label) });
      expect(within(sort).getByText(humanText(label))).toBeVisible();
      expect(within(sort).getAllByRole("button")).toHaveLength(2);
    },
  );
});

describe("reading aid button in document details", () => {
  const readingAid = {
    deliveryId: "aid-1",
    language: "en",
    reviewedAtMs: 1_792_450_680_000,
    notice: { version: "carlos-5537-en-1", heading: "FAKE", body: "FAKE" },
    overview: "FAKE overview.",
    points: [],
  };
  const openDetails = (name: string) => {
    fireEvent.click(
      screen.getByRole("button", { name: humanText(`Details for ${name}`) }),
    );
    return screen.getByRole("dialog", { name: humanText(name) });
  };

  it("appears beside Read for a PDF delivery that has an aid", () => {
    renderLibrary({
      ...snapshot,
      records: [{ ...record("with-aid", "FAKE Result.pdf", []), readingAid }],
    });
    const details = openDetails("FAKE Result.pdf");
    expect(
      within(details).getByRole("button", { name: humanText("Read") }),
    ).toBeVisible();
    expect(
      within(details).getByRole("button", {
        name: humanText("Read the reading aid"),
      }),
    ).toBeVisible();
  });

  it("is absent for a PDF without an aid", () => {
    renderLibrary({
      ...snapshot,
      records: [record("no-aid", "FAKE Plain.pdf", [])],
    });
    const details = openDetails("FAKE Plain.pdf");
    expect(
      within(details).getByRole("button", { name: humanText("Read") }),
    ).toBeVisible();
    expect(
      within(details).queryByRole("button", {
        name: humanText("Read the reading aid"),
      }),
    ).toBeNull();
  });

  it("is absent wherever Read is absent, even when an aid is filed", () => {
    renderLibrary({
      ...snapshot,
      records: [
        {
          ...record("not-pdf", "FAKE Notes.txt", []),
          mediaType: "text/plain",
          readingAid,
        },
      ],
    });
    const details = openDetails("FAKE Notes.txt");
    expect(
      within(details).queryByRole("button", { name: humanText("Read") }),
    ).toBeNull();
    expect(
      within(details).queryByRole("button", {
        name: humanText("Read the reading aid"),
      }),
    ).toBeNull();
  });
});

describe("the AI helper's notice before the reader's first Summary", () => {
  // A real 1 x 1 PNG, drawn here, so the reader's page loads. FAKE text.
  const png = () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    return canvas.toDataURL("image/png");
  };
  const pageText = "FAKE letter. Potassium 5.4 mmol/L, a little high.";

  async function openReader(status: ModelStatus) {
    const { bridge } = renderLibrary({
      ...snapshot,
      records: [record("letter", "FAKE Letter.pdf", [])],
    });
    const native = bridge as unknown as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    native.aiModelStatus.mockResolvedValue(status);
    Object.assign(native, {
      viewPage: vi.fn(async () => ({
        pageCount: 1,
        width: 800,
        height: 1035,
        image: png(),
        text: pageText,
      })),
      cancelView: vi.fn().mockResolvedValue(undefined),
      documentText: vi.fn(async () => fakeDocumentText([pageText])),
      cancelDocumentText: vi.fn().mockResolvedValue(undefined),
      aiSummarize: vi.fn(async () => ({
        sentences: [
          {
            text: "FAKE: the potassium is a little high.",
            quote: "Potassium 5.4 mmol/L",
          },
        ],
        model: FAKE_MODEL,
        lastPage: 0,
        lastPageCut: false,
        keptId: "FAKE-kept-1",
      })),
      aiExplain: vi.fn(async () => ({
        text: "FAKE explanation.",
        model: FAKE_MODEL,
        keptId: "FAKE-kept-2",
      })),
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText("Details for FAKE Letter.pdf"),
      }),
    );
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: humanText("FAKE Letter.pdf") }),
      ).getByRole("button", { name: humanText("Read") }),
    );
    const picture = await screen.findByRole("img", {
      name: humanText(/Page 1 of 1/),
    });
    const reader = picture.closest<HTMLElement>('[role="dialog"]');
    if (!reader) throw new Error("the reader is a dialog");
    return { native, reader };
  }
  const notice = () =>
    screen.queryByRole("dialog", { name: humanText("About the AI helper") });

  it("comes first when a model is there, and nothing reaches the model before it closes", async () => {
    const { native, reader } = await openReader({
      state: "installed",
      model: FAKE_MODEL,
    });
    fireEvent.click(
      within(reader).getByRole("button", { name: humanText("Summary") }),
    );
    const shown = await screen.findByRole("dialog", {
      name: humanText("About the AI helper"),
    });
    // The model runs on this computer: the notice says what it does here,
    // and that its answers are kept in the vault (#212).
    expect(shown).toHaveTextContent("here on this device");
    expect(shown).toHaveTextContent("The AI on this device");
    expect(shown).toHaveTextContent("saved in the vault, encrypted");
    // Its effects run after the status answer: wait for the focus to move.
    await waitFor(() =>
      expect(
        within(shown).getByRole("button", { name: humanText("Continue") }),
      ).toHaveFocus(),
    );
    // Nothing is read, and nothing reaches the model, while it is open.
    expect(native.documentText).not.toHaveBeenCalled();
    expect(native.aiSummarize).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", {
        name: humanText("Summary in plain words"),
      }),
    ).toBeNull();

    fireEvent.click(
      within(shown).getByRole("button", { name: humanText("Continue") }),
    );
    expect(notice()).toBeNull();
    expect(
      await screen.findByText(
        humanText("FAKE: the potassium is a little high."),
      ),
    ).toBeVisible();
    expect(native.aiSummarize).toHaveBeenCalledTimes(1);
    // Asked to keep it for this document, with its text read's ticket.
    expect(native.aiSummarize).toHaveBeenCalledWith(
      [{ index: 0, text: pageText }],
      "en",
      { recordId: expect.any(String), ticket: expect.any(String) },
    );
    await waitFor(() =>
      expect(native.saveAiResult).toHaveBeenCalledWith(
        expect.any(String),
        "FAKE-kept-1",
        expect.any(Array),
      ),
    );

    // Once a session: Explain opens at once.
    fireEvent.click(
      within(reader).getByRole("button", { name: humanText("Explain a term") }),
    );
    expect(
      await screen.findByRole("region", { name: humanText("Explain a term") }),
    ).toBeVisible();
    expect(notice()).toBeNull();
  });

  it("comes first for Explain too, before any term is sent", async () => {
    const { native, reader } = await openReader({
      state: "installed",
      model: FAKE_MODEL,
    });
    fireEvent.click(
      within(reader).getByRole("button", { name: humanText("Explain a term") }),
    );
    const shown = await screen.findByRole("dialog", {
      name: humanText("About the AI helper"),
    });
    expect(
      screen.queryByRole("region", { name: humanText("Explain a term") }),
    ).toBeNull();
    fireEvent.click(
      within(shown).getByRole("button", { name: humanText("Continue") }),
    );
    const panel = await screen.findByRole("region", {
      name: humanText("Explain a term"),
    });
    fireEvent.change(within(panel).getByRole("textbox"), {
      target: { value: "potassium" },
    });
    fireEvent.click(
      within(panel).getByRole("button", { name: humanText("Explain") }),
    );
    expect(
      await within(panel).findByText(humanText("FAKE explanation.")),
    ).toBeVisible();
    expect(native.aiExplain).toHaveBeenCalledTimes(1);
  });

  it("still gives the device's text before the first Summary when only the export's was seen", async () => {
    const { native, reader } = await openReader({
      state: "installed",
      model: FAKE_MODEL,
    });
    // Seen from Security while the model's status could not be read: the
    // export's text only.
    fireEvent.click(
      within(reader).getByRole("button", { name: humanText("Close") }),
    );
    native.aiModelStatus.mockRejectedValueOnce(new Error("FAKE: no status"));
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Security") }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: humanText("About the AI helper"),
      }),
    );
    const shareOnly = await screen.findByRole("dialog", {
      name: humanText("About the AI helper"),
    });
    expect(shareOnly).not.toHaveTextContent("The AI on this device");
    fireEvent.click(
      within(shareOnly).getByRole("button", { name: humanText("Close") }),
    );
    expect(notice()).toBeNull();

    // The first Summary still waits for the device's text.
    fireEvent.click(
      // The sidebar's entry carries the count of documents in it.
      screen.getByRole("button", { name: humanText(/^My records/) }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: humanText("Details for FAKE Letter.pdf"),
      }),
    );
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: humanText("FAKE Letter.pdf") }),
      ).getByRole("button", { name: humanText("Read") }),
    );
    const picture = await screen.findByRole("img", {
      name: humanText(/Page 1 of 1/),
    });
    const again = picture.closest<HTMLElement>('[role="dialog"]');
    if (!again) throw new Error("the reader is a dialog");
    fireEvent.click(
      within(again).getByRole("button", { name: humanText("Summary") }),
    );
    const device = await screen.findByRole("dialog", {
      name: humanText("About the AI helper"),
    });
    expect(device).toHaveTextContent("The AI on this device");
    expect(native.aiSummarize).not.toHaveBeenCalled();
  });

  it("reads the reader's text and the preview's under ids of their own, and each closing cancels only its own", async () => {
    const { native, reader } = await openReader({
      state: "installed",
      model: FAKE_MODEL,
    });
    const reading = () => new Promise<never>(() => undefined);
    native.documentText.mockImplementation(reading);
    Object.assign(native, {
      recordKnownDetails: vi.fn().mockResolvedValue({
        names: [],
        birthDates: [],
        doctorNames: [],
        clinicNames: [],
      }),
    });
    fireEvent.click(
      within(reader).getByRole("button", { name: humanText("Summary") }),
    );
    const shown = await screen.findByRole("dialog", {
      name: humanText("About the AI helper"),
    });
    fireEvent.click(
      within(shown).getByRole("button", { name: humanText("Continue") }),
    );
    await waitFor(() => expect(native.documentText).toHaveBeenCalledTimes(1));
    const readerRead = native.documentText.mock.calls[0][1] as string;
    fireEvent.click(
      within(reader).getByRole("button", { name: humanText("Close") }),
    );
    expect(native.cancelDocumentText).toHaveBeenCalledTimes(1);
    expect(native.cancelDocumentText).toHaveBeenLastCalledWith(readerRead);

    // The preview: a read of its own, and its own cancel.
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText("Details for FAKE Letter.pdf"),
      }),
    );
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: humanText("FAKE Letter.pdf") }),
      ).getByRole("button", { name: humanText("Prepare text for an AI…") }),
    );
    const preview = await screen.findByRole("dialog", {
      name: humanText("Text with identifying details removed"),
    });
    await waitFor(() => expect(native.documentText).toHaveBeenCalledTimes(2));
    const previewRead = native.documentText.mock.calls[1][1] as string;
    expect(previewRead).toMatch(/^[0-9a-f-]{36}$/);
    expect(previewRead).not.toBe(readerRead);
    fireEvent.click(
      within(preview).getByRole("button", { name: humanText("Close") }),
    );
    expect(native.cancelDocumentText).toHaveBeenCalledTimes(2);
    expect(native.cancelDocumentText).toHaveBeenLastCalledWith(previewRead);
  });

  it("is not shown with no model: the panel says so, and nothing is read", async () => {
    const { native, reader } = await openReader({ state: "notInstalled" });
    fireEvent.click(
      within(reader).getByRole("button", { name: humanText("Summary") }),
    );
    const panel = await screen.findByRole("region", {
      name: humanText("Summary in plain words"),
    });
    expect(
      await within(panel).findByText(
        humanText("The AI helper isn't on this computer yet"),
      ),
    ).toBeVisible();
    expect(notice()).toBeNull();
    expect(native.documentText).not.toHaveBeenCalled();
    expect(native.aiSummarize).not.toHaveBeenCalled();
  });
});

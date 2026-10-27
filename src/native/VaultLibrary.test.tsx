import { resolveText, formatDate } from "../i18n";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import type { VaultBridge, VaultSnapshot } from "../vault";
import { VaultLibrary } from "./VaultLibrary";

const snapshot: VaultSnapshot = {
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

function renderLibrary(shown: VaultSnapshot = snapshot, sharedNew = 0) {
  const bridge = {
    updateFolder: vi.fn().mockResolvedValue(undefined),
    assignFoldersBatch: vi.fn().mockResolvedValue(undefined),
    snapshot: vi.fn().mockResolvedValue(shown),
    history: vi.fn().mockResolvedValue([]),
    isLockedPdf: vi.fn().mockResolvedValue(false),
  } as unknown as VaultBridge;
  const setNotice = vi.fn();
  render(
    <VaultLibrary
      bridge={bridge}
      snapshot={shown}
      busy={false}
      notice=""
      setNotice={setNotice}
      run={async (operation) => operation()}
      refresh={async () => shown}
      onLock={vi.fn().mockResolvedValue(undefined)}
      autoLockMinutes={5}
      onAutoLockMinutes={vi.fn()}
      sharedNew={sharedNew}
    />,
  );
  return { bridge, setNotice };
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
  it.each(["FAKE 2025 Letters", "FAKE June Letters"])(
    "does not send a drop of a folder onto its subfolder %s to the vault",
    async (destination) => {
      const { bridge, setNotice } = renderLibrary();
      const sidebar = screen.getByRole("navigation", {
        name: "Record library",
      });
      dragFolder(
        within(sidebar).getByRole("button", { name: /^FAKE Letters/ }),
        within(sidebar).getByRole("button", {
          name: new RegExp(`^${destination}`),
        }),
      );
      await vi.waitFor(() =>
        expect(
          setNotice.mock.calls.map(([notice]) => resolveText(notice)),
        ).toContain("A folder cannot be moved into itself or its subfolders."),
      );
      expect(bridge.updateFolder).not.toHaveBeenCalled();
    },
  );

  it("still moves a subfolder up to its grandparent", async () => {
    const { bridge } = renderLibrary();
    const sidebar = screen.getByRole("navigation", { name: "Record library" });
    dragFolder(
      within(sidebar).getByRole("button", { name: /^FAKE June Letters/ }),
      within(sidebar).getByRole("button", { name: /^FAKE Letters/ }),
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
    const row = screen.getByRole("article", { name: "FAKE Letters folder" });
    expect(row).toHaveTextContent(formatDate(Date.UTC(2026, 0, 15, 12)));
    expect(row).not.toHaveTextContent(/\bFolder\b/);
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
const filed: VaultSnapshot = {
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
  fireEvent.change(screen.getByRole("searchbox", { name: label }), {
    target: { value: text },
  });
// Each document shown, with the folder path given for it.
const shownDocuments = () =>
  screen
    .queryAllByRole("article", { name: / document$/ })
    .map((row) => [
      row.getAttribute("aria-label")?.replace(/ document$/, ""),
      within(row).queryByText(/^In /)?.textContent ?? null,
    ]);
const openFolder = (name: RegExp) =>
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Record library" }),
    ).getByRole("button", { name }),
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
    expect(shownDocuments()).toHaveLength(5);
    expect(
      shownDocuments().every(([, path]) => path?.startsWith("In FAKE Avery")),
    ).toBe(true);
    const sidebar = screen.getByRole("navigation", { name: "Record library" });
    fireEvent.click(
      within(sidebar).getByRole("button", { name: /^FAKE Blake/ }),
    );
    search("Search everything in FAKE Blake", "blood");
    expect(shownDocuments()).toEqual([
      ["FAKE Blood log.pdf", "In FAKE Blake"],
      ["FAKE Blood test.pdf", "In FAKE Blake / FAKE Lab results"],
    ]);
    search("Search everything in FAKE Blake", "lab");
    const folders = screen.getAllByRole("article", { name: / folder$/ });
    expect(folders).toHaveLength(1);
    expect(within(folders[0]).getByText("In FAKE Blake")).toBeVisible();
  });

  it("searches only Shared with me, without person folders or pane drops", () => {
    const { bridge } = renderLibrary(separateScopes);
    // Enter Shared from a deep folder so no person's subtree can carry over.
    openFolder(/^FAKE 2026/);
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: "Record library" }),
      ).getByRole("button", { name: /^Shared with me/ }),
    );
    const sharedRow = () =>
      screen.getByRole("article", { name: "FAKE Blood shared.pdf document" });
    dragFolder(sharedRow(), screen.getByRole("main"));
    search("Search Shared with me", "blood");
    expect(shownDocuments()).toEqual([
      ["FAKE Blood shared.pdf", "In Shared with me"],
    ]);
    expect(screen.getByText("1 document found")).toBeVisible();
    dragFolder(sharedRow(), screen.getByRole("main"));
    search("Search Shared with me", "lab");
    expect(screen.queryAllByRole("article", { name: / folder$/ })).toHaveLength(
      0,
    );
    expect(shownDocuments()).toEqual([]);
    search("Search Shared with me", "");
    expect(shownDocuments()).toEqual([["FAKE Blood shared.pdf", null]]);
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
    expect(shownDocuments()).toHaveLength(4);
    expect(
      shownDocuments().some(([, path]) => path?.endsWith("FAKE June")),
    ).toBe(false);
    openFolder(/^FAKE Lab results/);
    search("Search this folder and its subfolders", "blood test");
    expect(shownDocuments()).toEqual([
      ["FAKE Blood test.pdf", "In My records / FAKE Lab results"],
    ]);
  });

  it("from the top level covers the current person, and says where each result is", () => {
    renderLibrary(filed);
    search("Search everything in My records", "blood");

    expect(shownDocuments()).toEqual([
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
    expect(screen.getByText("0 folders · 5 documents found")).toBeVisible();
  });

  it("from a folder covers it and every folder beneath it, and nothing else", () => {
    renderLibrary(filed);
    openFolder(/^FAKE Lab results/);
    search("Search this folder and its subfolders", "blood test");

    // The referral matches too, but is filed in another branch.
    expect(shownDocuments()).toEqual([
      ["FAKE Blood test.pdf", "In My records / FAKE Lab results"],
      [
        "FAKE Blood test.pdf",
        "In My records / FAKE Lab results / FAKE 2026 / FAKE June",
      ],
    ]);
    // The path is read out with the document's buttons too.
    const deep = screen.getAllByRole("article", {
      name: "FAKE Blood test.pdf document",
    })[1];
    for (const name of ["FAKE Blood test.pdf", "Select FAKE Blood test.pdf"])
      expect(
        within(deep).getByRole("button", { name }),
      ).toHaveAccessibleDescription(
        "In My records / FAKE Lab results / FAKE 2026 / FAKE June",
      );
  });

  it("finds a document two levels below where the search starts", () => {
    renderLibrary(filed);
    openFolder(/^FAKE Lab results/);
    search("Search this folder and its subfolders", "fake blood test.pdf");

    expect(shownDocuments()).toContainEqual([
      "FAKE Blood test.pdf",
      "In My records / FAKE Lab results / FAKE 2026 / FAKE June",
    ]);
  });

  it("shows a document filed in two folders once, with both paths", () => {
    renderLibrary(filed);
    openFolder(/^FAKE Lab results/);
    search("Search this folder and its subfolders", "count");

    expect(shownDocuments()).toEqual([
      [
        "FAKE Blood count.pdf",
        "In My records / FAKE Lab results / FAKE 2026; My records / FAKE Letters",
      ],
    ]);
  });

  it("finds folders at any depth, each with where it is", () => {
    renderLibrary(filed);
    search("Search everything in My records", "june");

    const rows = screen.getAllByRole("article", { name: "FAKE June folder" });
    expect(
      rows.map((row) => within(row).getByText(/^In /).textContent),
    ).toEqual([
      "In My records / FAKE Lab results / FAKE 2026",
      "In My records / FAKE Letters",
    ]);
    expect(
      within(rows[0]).getByRole("button", { name: "Open FAKE June" }),
    ).toHaveAccessibleDescription(
      "1 item In My records / FAKE Lab results / FAKE 2026",
    );

    // From a folder: only the folders beneath it, not the open folder itself.
    openFolder(/^FAKE Letters/);
    search("Search this folder and its subfolders", "fake");
    expect(
      screen
        .getAllByRole("article", { name: / folder$/ })
        .map((row) => row.getAttribute("aria-label")),
    ).toEqual(["FAKE June folder"]);
  });

  it("goes back to the open folder's own items when cleared", () => {
    renderLibrary(filed);
    openFolder(/^FAKE Lab results/);
    search("Search this folder and its subfolders", "blood");
    expect(shownDocuments()).toHaveLength(3);

    search("Search this folder and its subfolders", "");
    expect(shownDocuments()).toEqual([["FAKE Blood test.pdf", null]]);
    expect(
      screen
        .getAllByRole("article", { name: / folder$/ })
        .map((row) => [
          row.getAttribute("aria-label"),
          within(row).queryByText(/^In /),
        ]),
    ).toEqual([["FAKE 2026 folder", null]]);
    expect(
      screen.getByText("1 folder · 1 document in this location"),
    ).toBeVisible();
  });

  it("moves a result from a subfolder, and starts the selection again when the search changes", async () => {
    const { bridge } = renderLibrary(filed);
    search("Search everything in My records", "blood test.pdf");
    const selectDeep = () =>
      fireEvent.click(
        within(
          screen
            .getAllByRole("article", { name: "FAKE Blood test.pdf document" })
            .find((row) => within(row).queryByText(/FAKE June$/))!,
        ).getByRole("button", { name: "Select FAKE Blood test.pdf" }),
      );
    selectDeep();
    expect(screen.getByText("1 selected")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Move selected to"), {
      target: { value: "letters" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await vi.waitFor(() =>
      expect(bridge.assignFoldersBatch).toHaveBeenCalledWith(
        ["lab-deep"],
        ["letters"],
      ),
    );

    // Once the search changes, the selection starts again, so a move acts
    // only on documents chosen while in view.
    await vi.waitFor(() =>
      expect(screen.queryByText(/selected$/)).not.toBeInTheDocument(),
    );
    selectDeep();
    expect(screen.getByText("1 selected")).toBeVisible();
    search("Search everything in My records", "");
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  });

  it("does not move a result let go of over the results it came from", () => {
    const { bridge } = renderLibrary(filed);
    openFolder(/^FAKE Lab results/);
    search("Search this folder and its subfolders", "june");
    dragFolder(
      screen.getByRole("article", { name: "FAKE June folder" }),
      screen.getByRole("main"),
    );
    search("Search this folder and its subfolders", "blood test");
    dragFolder(
      screen.getAllByRole("article", {
        name: "FAKE Blood test.pdf document",
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

  it("puts words on its buttons and shows both sort choices", () => {
    renderLibrary(withRecord);
    const details = screen.getByRole("button", {
      name: "Details for FAKE Results.pdf",
    });
    expect(details).toHaveTextContent(/^Details$/);
    expect(screen.getByRole("button", { name: "List view" })).toHaveTextContent(
      "List",
    );
    expect(screen.getByRole("button", { name: "Grid view" })).toHaveTextContent(
      "Grid",
    );
    // Sort is a row of radio buttons, not a dropdown with only an icon.
    const sort = screen.getByRole("group", { name: "Sort by" });
    expect(
      within(sort)
        .getAllByRole("radio")
        .map((choice) => choice.closest("label")?.textContent),
    ).toEqual(["Newest first", "Name A–Z"]);
    expect(
      within(sort).getByRole("radio", { name: "Newest first" }),
    ).toBeChecked();
    fireEvent.click(within(sort).getByRole("radio", { name: "Name A–Z" }));
    expect(within(sort).getByRole("radio", { name: "Name A–Z" })).toBeChecked();
    fireEvent.click(details);
    expect(
      screen.getByRole("button", { name: "Close document details" }),
    ).toHaveTextContent(/^Close$/);
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
        "Hold and drag a document or folder to move it, or open it and choose Move to.",
      ),
    ).toBeVisible();
  });

  it("selects a document in grid view as in list view, with a 44px target", () => {
    renderLibrary(withRecord);
    const listTick = screen.getByRole("button", {
      name: "Select FAKE Results.pdf",
    });
    const box = listTick.getBoundingClientRect();
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    const gridTick = screen.getByRole("button", {
      name: "Select FAKE Results.pdf",
    });
    const tile = gridTick.getBoundingClientRect();
    expect(Math.min(tile.width, tile.height)).toBeGreaterThanOrEqual(44);
    fireEvent.click(gridTick);
    expect(gridTick).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 selected")).toBeVisible();
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
    expect(screen.queryByRole("group", { name: "Patient" })).toBeNull();
    const library = screen.getByRole("navigation", { name: "Record library" });
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
      name: /^Shared with me/,
    });
    const letters = within(library).getByRole("button", {
      name: /^FAKE Letters/,
    });
    expect(shared.style.paddingLeft).toBe("");
    expect(letters.style.paddingLeft).not.toBe("");
    // Whose folder it is, for a screen reader.
    expect(letters).toHaveAccessibleName("FAKE Letters (FAKE Avery) 0");
    const avery = within(library).getByRole("button", { name: /^FAKE Avery/ });
    const blake = within(library).getByRole("button", { name: /^FAKE Blake/ });
    expect(avery).toHaveAttribute("aria-current", "page");
    fireEvent.click(blake);
    expect(blake).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "FAKE Blake",
    );
    // Blake's records hold none of Avery's folders.
    expect(
      screen.queryByRole("article", { name: "FAKE Letters folder" }),
    ).toBeNull();
    // Opening one of Avery's folders from Blake's opens it at once, with
    // the person in the path.
    fireEvent.click(
      within(library).getByRole("button", { name: /^FAKE 2025 Letters/ }),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "FAKE 2025 Letters",
    );
    expect(
      within(
        document.querySelector(".native-profile-row") as HTMLElement,
      ).getByRole("button", { name: "FAKE Avery" }),
    ).toBeVisible();
    expect(document.querySelector(".native-profile-row")).toHaveTextContent(
      "FAKE Avery›FAKE 2025 Letters",
    );
    cleanup();

    // With one person, their folder is "My records".
    renderLibrary(snapshot);
    expect(
      Array.from(
        screen
          .getByRole("navigation", { name: "Record library" })
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

  it("shows Shared with me's whole name in the sidebar, with its new count on one line (#61)", () => {
    renderLibrary(snapshot, 2);
    const shared = screen.getByRole("button", {
      name: "Shared with me, 2 new",
    });
    const name = shared.querySelector(".native-nav-name")!;
    expect(name.textContent).toBe("Shared with me");
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
    const text = document.createRange();
    text.selectNodeContents(within(shared).getByText("2 new"));
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
    const library = screen.getByRole("navigation", { name: "Record library" });
    // Avery is open: Blake's folder shows, but does not move by drag.
    const blakes = within(library).getByRole("button", {
      name: /^FAKE School forms/,
    });
    expect(blakes).not.toHaveAttribute("draggable");
    expect(
      within(library).getByRole("button", { name: /^FAKE June Letters/ }),
    ).toHaveAttribute("draggable", "true");
    // Within Avery's own, a folder still moves.
    dragFolder(
      within(library).getByRole("button", { name: /^FAKE June Letters/ }),
      within(library).getByRole("button", { name: /^FAKE Letters/ }),
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
        setNotice.mock.calls.map(([notice]) => resolveText(notice)),
      ).toContain("FAKE June Letters moved to FAKE Letters."),
    );
  });

  it("shows the sections as a row of tabs on a narrow window, and the top-level folders under the path", async () => {
    await page.viewport(390, 844);
    try {
      renderLibrary(twoPatients, 2);
      expect(screen.queryByRole("combobox", { name: "Section" })).toBeNull();
      const sections = screen.getByRole("navigation", { name: "Section" });
      const tabs = within(sections).getAllByRole("button");
      // Records holds the people and Shared with me (Ben, 21 Oct); it says
      // how many shared files are new (#61).
      expect(tabs.map((tab) => tab.textContent)).toEqual([
        "Records (2 new)",
        "Security",
        "Preferences",
      ]);
      expect(tabs[0]).toHaveAttribute("aria-current", "page");
      // The sidebar is hidden here; the same top-level folders sit under
      // the path, and exactly one list of them is in reach.
      const library = screen.getByRole("navigation", {
        name: "Record library",
      });
      expect(
        within(library)
          .getAllByRole("button")
          .map((button) => button.textContent?.trim()),
      ).toEqual(["FAKE Avery", "FAKE Blake", "Shared with me (2 new)"]);
      fireEvent.click(
        within(library).getByRole("button", { name: /^Shared with me/ }),
      );
      expect(tabs[0]).toHaveAttribute("aria-current", "page");
      expect(
        within(library).getByRole("button", { name: /^Shared with me/ }),
      ).toHaveAttribute("aria-current", "page");
      fireEvent.click(tabs[2]);
      expect(tabs[2]).toHaveAttribute("aria-current", "page");
      expect(tabs[0]).not.toHaveAttribute("aria-current");
      cleanup();

      // With one person: My records and Shared with me.
      renderLibrary(snapshot, 2);
      expect(
        within(screen.getByRole("navigation", { name: "Record library" }))
          .getAllByRole("button")
          .map((button) => button.textContent?.trim()),
      ).toEqual(["My records", "Shared with me (2 new)"]);
    } finally {
      await page.viewport(1100, 760);
    }
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
        screen.getByRole("article", { name: "FAKE shared secret.pdf, hidden" }),
      ).toBeVisible();
      expect(
        screen.queryByText("FAKE person secret.pdf"),
      ).not.toBeInTheDocument();
    },
  );
});

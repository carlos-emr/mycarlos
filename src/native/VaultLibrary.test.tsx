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

function renderLibrary(shown: VaultSnapshot = snapshot) {
  const bridge = {
    updateFolder: vi.fn().mockResolvedValue(undefined),
    assignFoldersBatch: vi.fn().mockResolvedValue(undefined),
    snapshot: vi.fn().mockResolvedValue(shown),
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
        expect(setNotice).toHaveBeenCalledWith(
          "A folder cannot be moved into itself or its subfolders.",
        ),
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
    expect(row).toHaveTextContent(
      new Date(Date.UTC(2026, 0, 15, 12)).toLocaleDateString(),
    );
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
  it("from the top level covers the whole vault, and says where each result is", () => {
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
      "1 items In My records / FAKE Lab results / FAKE 2026",
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
      screen.getByText("1 folders · 1 documents in this location"),
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

  it("offers one button per patient in the sidebar, and none for a single patient", () => {
    renderLibrary(twoPatients);
    expect(screen.queryByRole("combobox", { name: /patient/i })).toBeNull();
    const patients = screen.getByRole("group", { name: "Patient" });
    const avery = within(patients).getByRole("button", { name: "FAKE Avery" });
    const blake = within(patients).getByRole("button", { name: "FAKE Blake" });
    expect(avery).toHaveAttribute("aria-pressed", "true");
    expect(blake).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(blake);
    expect(blake).toHaveAttribute("aria-pressed", "true");
    // Blake's library has none of Avery's folders.
    expect(screen.queryByText("FAKE Letters")).toBeNull();
    cleanup();

    renderLibrary(snapshot);
    expect(screen.queryByRole("group", { name: "Patient" })).toBeNull();
  });

  it("shows the sections as a row of tabs on a narrow window", async () => {
    await page.viewport(390, 844);
    try {
      renderLibrary(twoPatients);
      expect(screen.queryByRole("combobox", { name: "Section" })).toBeNull();
      const sections = screen.getByRole("navigation", { name: "Section" });
      const tabs = within(sections).getAllByRole("button");
      expect(tabs.map((tab) => tab.textContent)).toEqual([
        "My records",
        "Security",
        "Preferences",
      ]);
      expect(tabs[0]).toHaveAttribute("aria-current", "page");
      // The sidebar is hidden here, so the patient buttons sit under the path:
      // exactly one Patient group is in reach.
      expect(screen.getAllByRole("group", { name: "Patient" })).toHaveLength(1);
      fireEvent.click(tabs[1]);
      expect(tabs[1]).toHaveAttribute("aria-current", "page");
      expect(tabs[0]).not.toHaveAttribute("aria-current");
    } finally {
      await page.viewport(1100, 760);
    }
  });
});

import { humanText, humanValue, visibleText } from "../test/humanText";
import { LOCALES, resolveText, setLocaleOverride, translate } from "../i18n";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    platform: vi.fn().mockResolvedValue("windows"),
    updateFolder: vi.fn().mockResolvedValue(undefined),
    renameProfile: vi.fn().mockResolvedValue(undefined),
    assignFoldersBatch: vi.fn().mockResolvedValue(undefined),
    snapshot: vi.fn().mockResolvedValue(shown),
    history: vi.fn().mockResolvedValue({
      entries: [],
      laterEntries: [],
      complete: true,
      checkedUntilMs: null,
      checkedFromMs: null,
    }),
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

  it("puts words on its buttons and shows both sort choices", () => {
    renderLibrary(withRecord);
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
    fireEvent.click(sortChoices[1]);
    expect(sortChoices[1]).toHaveAttribute("aria-pressed", "true");
    expect(sortChoices[0]).toHaveAttribute("aria-pressed", "false");
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
      expect(humanValue(tabs.map((tab) => tab.textContent))).toEqual([
        "Records (2 new)",
        "Security",
        "Preferences",
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

describe("VaultLibrary for a screen reader (#121)", () => {
  afterEach(() => setLocaleOverride(null));

  /** Lets the page's next animation frames run: the heading takes the focus
   * in one. */
  const nextFrames = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  const heading = () => screen.getByRole("heading", { level: 1 });
  // Folder buttons by their message, whose words #149 changes.

  it("takes the focus to the new place's heading when the reader opens one, by key or by pointer", async () => {
    const user = userEvent.setup();
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
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: humanText("Record library") }),
      ).getByRole("button", { name: humanText(/^Shared with me/) }),
    );
    expect(heading()).toHaveHumanAccessibleDescription(
      "In Shared with me: 0 documents.",
    );
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
    // The polite line too: what it says next is not about the dialog.
    expect(
      document.querySelector('.native-vault-page > [aria-live="polite"]'),
    ).toHaveAttribute("aria-hidden", "true");
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
    expect(
      document.querySelector('.native-vault-page > [aria-live="polite"]'),
    ).not.toHaveAttribute("aria-hidden");
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

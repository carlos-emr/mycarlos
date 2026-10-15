import { fireEvent, render, screen, within } from "@testing-library/react";
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

function renderLibrary(vault: VaultSnapshot = snapshot) {
  const bridge = {
    updateFolder: vi.fn().mockResolvedValue(undefined),
    assignFoldersBatch: vi.fn().mockResolvedValue(undefined),
    snapshot: vi.fn().mockResolvedValue(vault),
  } as unknown as VaultBridge;
  const setNotice = vi.fn();
  render(
    <VaultLibrary
      bridge={bridge}
      snapshot={vault}
      busy={false}
      notice=""
      setNotice={setNotice}
      run={async (operation) => operation()}
      refresh={async () => vault}
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

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
      expect(setNotice).toHaveBeenCalledWith(
        "FAKE June Letters moved to FAKE Letters.",
      ),
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
      fireEvent.click(tabs[1]);
      expect(tabs[1]).toHaveAttribute("aria-current", "page");
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

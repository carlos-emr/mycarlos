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

function renderLibrary(shown: VaultSnapshot = snapshot) {
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

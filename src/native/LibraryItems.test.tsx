import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { humanText } from "../test/humanText";
import type { VaultFolder, VaultRecord } from "../vault";
import { LibraryItems } from "./LibraryItems";
import type { DragItem, VaultDragDrop } from "./useVaultDragDrop";

// What the library lays out and what each tile does when it is dragged: the list and the grid
// carry the same drag and drop wiring (moving a document or a folder into a folder). FAKE data only.
const FOLDER: VaultFolder = {
  id: "folder-1",
  profileId: "profile-1",
  parentId: null,
  name: "FAKE Letters",
  createdAtMs: 1,
};
const RECORD: VaultRecord = {
  id: "record-1",
  profileId: "profile-1",
  folderIds: [],
  displayName: "FAKE clinic letter.pdf",
  sourceLabel: "Manual import — unverified",
  mediaType: "application/pdf",
  plaintextSize: 2048,
  importedAtMs: 1,
  available: true,
};

function fakeDrag() {
  return {
    startDrag: vi.fn(),
    dragOver: vi.fn(),
    dropInto: vi.fn(),
    dragEnd: vi.fn(),
    dragClass: vi.fn((base: string) => `${base} native-draggable`),
    dropClass: vi.fn((base: string) => base),
  } satisfies VaultDragDrop;
}

function open(
  view: "list" | "grid",
  overrides: Partial<ComponentProps<typeof LibraryItems>> = {},
) {
  const drag = fakeDrag();
  const handlers = {
    onOpenFolder: vi.fn(),
    onOpenRecord: vi.fn(),
    onRenameFolder: vi.fn(),
    onToggleSelected: vi.fn(),
  };
  const recordItem: DragItem = { kind: "records", ids: [RECORD.id] };
  render(
    <LibraryItems
      view={view}
      folders={[FOLDER]}
      records={[RECORD]}
      selectedIds={[]}
      disabled={false}
      searching={false}
      unavailableLabel="not here"
      drag={drag}
      recordDragItem={() => recordItem}
      folderCount={() => 3}
      {...handlers}
      {...overrides}
    />,
  );
  return { drag, recordItem, ...handlers };
}

describe.each(["list", "grid"] as const)("the library's %s view", (view) => {
  afterEach(cleanup);

  it("drags a folder, offers it as a place to drop, and ends the drag", () => {
    const { drag } = open(view);
    const folder = screen.getByRole("article", {
      name: /FAKE Letters/,
    });

    expect(folder).toHaveAttribute("draggable", "true");
    fireEvent.dragStart(folder);
    expect(drag.startDrag).toHaveBeenCalledOnce();
    expect(drag.startDrag.mock.calls[0][1]).toEqual({
      kind: "folder",
      id: "folder-1",
    });

    fireEvent.dragOver(folder);
    expect(drag.dragOver).toHaveBeenCalledOnce();
    expect(drag.dragOver.mock.calls[0][1]).toBe(`${view}:folder-1`);

    fireEvent.drop(folder);
    expect(drag.dropInto).toHaveBeenCalledOnce();
    expect(drag.dropInto.mock.calls[0][1]).toBe("folder-1");

    fireEvent.dragEnd(folder);
    expect(drag.dragEnd).toHaveBeenCalledOnce();
  });

  it("drags a document as what it stands for, and is not a place to drop", () => {
    const { drag, recordItem } = open(view);
    const document = screen.getByRole("article", {
      name: /FAKE clinic letter/,
    });

    fireEvent.dragStart(document);
    expect(drag.startDrag).toHaveBeenCalledOnce();
    expect(drag.startDrag.mock.calls[0][1]).toBe(recordItem);

    fireEvent.dragOver(document);
    fireEvent.drop(document);
    expect(drag.dragOver).not.toHaveBeenCalled();
    expect(drag.dropInto).not.toHaveBeenCalled();

    fireEvent.dragEnd(document);
    expect(drag.dragEnd).toHaveBeenCalledOnce();
  });

  it("cannot be dragged while the library is busy", () => {
    open(view, { disabled: true });

    for (const item of screen.getAllByRole("article"))
      expect(item).toHaveAttribute("draggable", "false");
  });

  it("opens, renames and selects through the handlers it is given", () => {
    const { onOpenFolder, onRenameFolder, onOpenRecord } = open(view);

    fireEvent.click(
      screen.getByRole("button", {
        name: humanText(/FAKE Letters, open folder/),
      }),
    );
    expect(onOpenFolder).toHaveBeenCalledExactlyOnceWith("folder-1");
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText(/Rename folder FAKE Letters/),
      }),
    );
    expect(onRenameFolder).toHaveBeenCalledExactlyOnceWith(FOLDER);
    fireEvent.click(
      screen.getByRole("button", { name: /^FAKE clinic letter\.pdf/ }),
    );
    expect(onOpenRecord).toHaveBeenCalledWith("record-1");
  });

  it("says where each result is while searching, and what is empty", () => {
    open(view, {
      searching: true,
      folderLocation: () => "FAKE Top",
      recordLocation: () => "FAKE Top / FAKE Letters",
    });

    expect(screen.getAllByText(/FAKE Top/).length).toBeGreaterThanOrEqual(2);
    cleanup();

    open(view, { folders: [], records: [], searching: true });
    expect(screen.queryByRole("article")).toBeNull();
    expect(
      document.querySelector(".empty-state")?.textContent?.length,
    ).toBeGreaterThan(0);
  });

  it("marks a document that is not available", () => {
    open(view, { records: [{ ...RECORD, available: false }] });

    expect(screen.getByText(/not here/)).toBeVisible();
  });
});

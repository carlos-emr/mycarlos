import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride, translate } from "../i18n";
import type { VaultFolder, VaultRecord } from "../vault";
import { humanText, visibleText } from "../test/humanText";
import { LibraryItems } from "./LibraryItems";
import { useVaultDragDrop, type DragItem } from "./useVaultDragDrop";

// The list and the grid of a library place: what each row and tile offers, how it is named for a
// reader, the empty states, and what dragging does. FAKE data only.

afterEach(() => {
  cleanup();
  setLocaleOverride(null);
});

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => visibleText(translate("en", key, params));

const folder = (id: string, name: string): VaultFolder => ({
  id,
  profileId: "p1",
  parentId: null,
  name,
  createdAtMs: Date.UTC(2026, 9, 7, 12),
});
const record = (
  id: string,
  displayName: string,
  extra: Partial<VaultRecord> = {},
): VaultRecord => ({
  id,
  profileId: "p1",
  folderIds: [],
  displayName,
  sourceLabel: "Manual import — unverified",
  mediaType: "application/pdf",
  plaintextSize: 2048,
  importedAtMs: Date.UTC(2026, 9, 8, 12),
  available: true,
  ...extra,
});

type Props = Partial<Parameters<typeof LibraryItems>[0]> & {
  onMove?: (
    item: DragItem,
    folderId: string | null,
    profileId?: string,
  ) => void;
};

/** The items with the library's real drag-and-drop behind them, so a drop is seen as it moves. */
function Items({ onMove = () => undefined, ...props }: Props) {
  const drag = useVaultDragDrop({ disabled: props.disabled ?? false, onMove });
  return (
    <LibraryItems
      view="list"
      folders={[folder("f1", "FAKE Letters"), folder("f2", "FAKE Results")]}
      records={[
        record("r1", "FAKE Blood test.pdf"),
        record("r2", "FAKE Photo.jpg"),
      ]}
      selectedIds={[]}
      disabled={false}
      searching={false}
      unavailableLabel="Missing"
      drag={drag}
      recordDragItem={(id) => ({ kind: "records", ids: [id] })}
      folderCount={(id) => (id === "f1" ? 3 : 0)}
      onOpenFolder={() => undefined}
      onOpenRecord={() => undefined}
      onRenameFolder={() => undefined}
      onToggleSelected={() => undefined}
      {...props}
    />
  );
}

function drag(from: Element, over: Element, drop = true) {
  const dataTransfer = new DataTransfer();
  fireEvent(
    from,
    new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    }),
  );
  fireEvent(
    over,
    new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    }),
  );
  if (drop)
    fireEvent(
      over,
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
    );
}

const folderArticle = (name: string) =>
  screen.getByRole("article", {
    name: humanText(en("library.folder.label", { name })),
  });
const documentArticle = (name: string) =>
  screen.getByRole("article", {
    name: humanText(en("library.document.label", { name })),
  });

describe.each(["list", "grid"] as const)(
  "the %s of a place's items",
  (view) => {
    it("is named by how many items it shows, and lists folders then documents by their own names", () => {
      render(<Items view={view} />);
      const items = document.querySelector(
        view === "list" ? ".native-filelist" : ".native-file-grid",
      )!;
      expect(visibleText(items.getAttribute("aria-label") ?? "")).toBe(
        visibleText(en("library.items", { count: 4 })),
      );
      const articles = within(items as HTMLElement).getAllByRole("article");
      expect(
        articles.map((a) => visibleText(a.getAttribute("aria-label") ?? "")),
      ).toEqual([
        en("library.folder.label", { name: "FAKE Letters" }),
        en("library.folder.label", { name: "FAKE Results" }),
        en("library.document.label", { name: "FAKE Blood test.pdf" }),
        en("library.document.label", { name: "FAKE Photo.jpg" }),
      ]);
    });

    it("opens a folder and renames it, and counts what it holds for a reader", () => {
      const onOpenFolder = vi.fn();
      const onRenameFolder = vi.fn();
      render(
        <Items
          view={view}
          onOpenFolder={onOpenFolder}
          onRenameFolder={onRenameFolder}
        />,
      );
      const open = within(folderArticle("FAKE Letters")).getByRole("button", {
        name: humanText(en("library.folder.open", { name: "FAKE Letters" })),
      });
      // The count is the button's description, not part of its name.
      expect(open).toHaveHumanAccessibleDescription(
        en("library.folder.items", { count: 3 }),
      );
      fireEvent.click(open);
      expect(onOpenFolder).toHaveBeenCalledExactlyOnceWith("f1");
      fireEvent.click(
        within(folderArticle("FAKE Results")).getByRole("button", {
          name: humanText(
            en("library.folder.rename", { name: "FAKE Results" }),
          ),
        }),
      );
      expect(onRenameFolder).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "f2", name: "FAKE Results" }),
      );
    });

    it("opens a document by its name, and selects it with a tick that says whether it is chosen", () => {
      const onOpenRecord = vi.fn();
      const onToggleSelected = vi.fn();
      render(
        <Items
          view={view}
          selectedIds={["r2"]}
          onOpenRecord={onOpenRecord}
          onToggleSelected={onToggleSelected}
        />,
      );
      const first = documentArticle("FAKE Blood test.pdf");
      fireEvent.click(
        // The list's name button is the name; a grid tile's also says when it was added.
        within(first).getByRole("button", { name: /^FAKE Blood test\.pdf/ }),
      );
      expect(onOpenRecord).toHaveBeenCalledExactlyOnceWith("r1");
      const tick = (name: string) =>
        within(documentArticle(name)).getByRole("button", {
          name: humanText(en("library.select", { name })),
        });
      expect(tick("FAKE Blood test.pdf")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(tick("FAKE Photo.jpg")).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(tick("FAKE Blood test.pdf"));
      expect(onToggleSelected).toHaveBeenCalledExactlyOnceWith("r1");
    });

    it("says a document's file is not available, in the words it was given", () => {
      render(
        <Items
          view={view}
          records={[record("r1", "FAKE Gone.pdf", { available: false })]}
          folders={[]}
          unavailableLabel="The file is missing"
        />,
      );
      expect(documentArticle("FAKE Gone.pdf").textContent).toContain(
        "The file is missing",
      );
      cleanup();
      render(
        <Items
          view={view}
          records={[record("r1", "FAKE Here.pdf")]}
          folders={[]}
        />,
      );
      expect(documentArticle("FAKE Here.pdf").textContent).not.toContain(
        "Missing",
      );
    });

    it("while searching, says where each folder and document is, and ties the words to the name", () => {
      render(
        <Items
          view={view}
          folderLocation={(f) => `My records / ${f.name}`}
          recordLocation={(r) => `My records / FAKE Letters / ${r.displayName}`}
        />,
      );
      expect(
        screen.getByText(
          humanText(
            en("interface.inLocation", {
              location: "My records / FAKE Letters",
            }),
          ),
        ),
      ).toBeVisible();
      expect(
        screen.getByText(
          humanText(
            en("interface.inLocation", {
              location: "My records / FAKE Letters / FAKE Blood test.pdf",
            }),
          ),
        ),
      ).toBeVisible();
      // The folder button's description reads its count and then its place.
      const open = within(folderArticle("FAKE Letters")).getByRole("button", {
        name: humanText(en("library.folder.open", { name: "FAKE Letters" })),
      });
      const description = visibleText(
        open.getAttribute("aria-describedby") ?? "",
      );
      expect(description.split(" ")).toHaveLength(2);
    });

    it.each([
      [false, "library.empty.title", "library.empty.help"],
      [true, "library.noMatch.title", "library.noMatch.help"],
    ] as const)(
      "with nothing to show says so (searching: %s)",
      (searching, title, help) => {
        render(
          <Items view={view} folders={[]} records={[]} searching={searching} />,
        );
        expect(screen.getByText(en(title))).toBeVisible();
        expect(screen.getByText(en(help))).toBeVisible();
        expect(screen.queryAllByRole("article")).toHaveLength(0);
      },
    );

    it("does not say it is empty when there is a folder or a document", () => {
      render(
        <Items
          view={view}
          folders={[]}
          records={[record("r1", "FAKE Only.pdf")]}
        />,
      );
      expect(screen.queryByText(en("library.empty.title"))).toBeNull();
    });

    it("drops a document, or a folder, into a folder: the move names what was dragged and where", () => {
      const onMove = vi.fn();
      render(<Items view={view} onMove={onMove} />);
      drag(
        documentArticle("FAKE Blood test.pdf"),
        folderArticle("FAKE Letters"),
      );
      expect(onMove).toHaveBeenLastCalledWith(
        { kind: "records", ids: ["r1"] },
        "f1",
        undefined,
      );
      drag(folderArticle("FAKE Letters"), folderArticle("FAKE Results"));
      expect(onMove).toHaveBeenLastCalledWith(
        { kind: "folder", id: "f1" },
        "f2",
        undefined,
      );
      expect(onMove).toHaveBeenCalledTimes(2);
    });

    it("marks the folder a drag is over, and the dragged item, until the drag ends", () => {
      render(<Items view={view} />);
      const target = folderArticle("FAKE Letters");
      const dragged = documentArticle("FAKE Photo.jpg");
      drag(dragged, target, false);
      expect(target.className).toContain("native-drop-target");
      expect(dragged.className).toContain("native-dragging");
      fireEvent(dragged, new DragEvent("dragend", { bubbles: true }));
      expect(target.className).not.toContain("native-drop-target");
      expect(dragged.className).not.toContain("native-dragging");
    });

    it("cannot be dragged, or dropped on, while the library is busy or read-only", () => {
      const onMove = vi.fn();
      render(<Items view={view} disabled onMove={onMove} />);
      expect(documentArticle("FAKE Blood test.pdf")).toHaveAttribute(
        "draggable",
        "false",
      );
      expect(folderArticle("FAKE Letters")).toHaveAttribute(
        "draggable",
        "false",
      );
      drag(
        documentArticle("FAKE Blood test.pdf"),
        folderArticle("FAKE Letters"),
      );
      expect(onMove).not.toHaveBeenCalled();
      expect(
        within(folderArticle("FAKE Letters")).getByRole("button", {
          name: humanText(
            en("library.folder.rename", { name: "FAKE Letters" }),
          ),
        }),
      ).toBeDisabled();
    });
  },
);

describe("the list only", () => {
  it("shows what a person is suggested beside a document's name, and the clinic's service date", () => {
    render(
      <Items
        view="list"
        folders={[]}
        records={[
          record("r1", "FAKE Letter.pdf", { clinicServiceDate: "2026-02-03" }),
        ]}
        suggestionFor={(r) => <em>{`FAKE suggestion for ${r.id}`}</em>}
      />,
    );
    expect(screen.getByText("FAKE suggestion for r1")).toBeVisible();
    expect(documentArticle("FAKE Letter.pdf").textContent).toContain(
      "2026-02-03",
    );
  });

  it("opens a document from its Details button as well as from its name", () => {
    const onOpenRecord = vi.fn();
    render(<Items view="list" folders={[]} onOpenRecord={onOpenRecord} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText(
          en("library.document.details", { name: "FAKE Photo.jpg" }),
        ),
      }),
    );
    expect(onOpenRecord).toHaveBeenCalledExactlyOnceWith("r2");
  });
});

describe("the grid only", () => {
  it("shows the date a document was added, with its label when the clinic gave a service date", () => {
    render(
      <Items
        view="grid"
        folders={[]}
        records={[
          record("r1", "FAKE Clinic.pdf", { clinicServiceDate: "2026-02-03" }),
          record("r2", "FAKE Own.pdf"),
        ]}
      />,
    );
    expect(documentArticle("FAKE Clinic.pdf").textContent).toContain(
      en("library.column.added"),
    );
    expect(documentArticle("FAKE Own.pdf").textContent).not.toContain(
      en("library.column.added"),
    );
  });
});

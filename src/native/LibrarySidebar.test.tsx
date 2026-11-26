import type { ComponentProps } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { setLocaleOverride } from "../i18n";
import { humanText } from "../test/humanText";
import type { VaultRecord } from "../vault";
import { initialsOf, LibrarySidebar } from "./LibrarySidebar";

const AXE = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
};

function props(): ComponentProps<typeof LibrarySidebar> {
  const folder = (id: string, profileId: string, name: string) => ({
    id,
    profileId,
    parentId: null,
    name,
    createdAtMs: 1,
  });
  return {
    people: [
      { id: "p1", displayName: "FAKE Sam Example", createdAtMs: 1 },
      { id: "p2", displayName: "FAKE Riley Example", createdAtMs: 2 },
    ],
    profileId: "p1",
    section: "records",
    sharedNew: 1,
    onOpenShared: vi.fn(),
    vaultTotals: { documents: 3, folders: 3 },
    currentFolderId: null,
    folders: [
      folder("f1", "p1", "FAKE Lab results"),
      folder("f2", "p1", "FAKE Visits"),
      folder("f3", "p2", "FAKE Riley's papers"),
    ],
    records: [],
    disabled: false,
    drag: {
      startDrag: vi.fn(),
      dragOver: vi.fn(),
      dropInto: vi.fn(),
      dragEnd: vi.fn(),
      dragClass: (base) => base,
      dropClass: (base) => base,
    },
    addItems: [
      { id: "import", label: "Import a file", icon: "plus", onChoose: vi.fn() },
    ],
    addDisabled: false,
    onOpenPerson: vi.fn(),
    onOpenFolder: vi.fn(),
    onOpenSecurity: vi.fn(),
    onOpenPreferences: vi.fn(),
    onOpenAi: vi.fn(),
  };
}

describe("initialsOf", () => {
  it("takes up to two initials, whole letters, for the badge beside a name", () => {
    expect(initialsOf("Sam Example")).toBe("SE");
    expect(initialsOf("  Riley   Quinn   Example ")).toBe("RQ");
    expect(initialsOf("Éloïse Núñez")).toBe("ÉN");
    expect(initialsOf("𠮷田 太郎")).toBe("𠮷太");
    expect(initialsOf("Sam")).toBe("S");
    expect(initialsOf("   ")).toBe("");
  });
});

describe("LibrarySidebar: the decluttered sidebar", () => {
  it("puts Add document first, then Shared with me, People, the open person's folders, and Settings last", () => {
    setLocaleOverride("en");
    const { container } = render(<LibrarySidebar {...props()} />);
    const order = Array.from(
      container.querySelectorAll(
        ".menu-button-trigger, .side-nav > button, .side-nav > .nav-label, .side-settings",
      ),
    ).map((node) =>
      (
        node.querySelector(".native-nav-name")?.textContent ??
        node.textContent ??
        ""
      )
        .replace(/[⁦-⁩]/g, "")
        .trim(),
    );
    expect(order).toEqual([
      "Add document▾",
      "Shared with me",
      "People",
      "FAKE Sam Example",
      "FAKE Riley Example",
      "FAKE Sam Example’s folders",
      "FAKE Lab results",
      "FAKE Visits",
      "Security Preferences AI helper",
    ]);
    // Each person's badge is decoration: the name beside it is what is read.
    expect(container.querySelectorAll(".person-initials")).toHaveLength(2);
    for (const badge of container.querySelectorAll(".person-initials"))
      expect(badge).toHaveAttribute("aria-hidden", "true");
    expect(
      container
        .querySelector(".person-initials")
        ?.getAttribute("data-initials"),
    ).toBe("FS");
  });

  it("lists only the open person's folders, and another person's once that person is open", () => {
    setLocaleOverride("en");
    const p = props();
    const { rerender } = render(<LibrarySidebar {...p} />);
    expect(screen.queryByText("FAKE Riley's papers")).toBeNull();
    rerender(<LibrarySidebar {...p} profileId="p2" />);
    expect(screen.getByText("FAKE Riley's papers")).toBeVisible();
    expect(screen.queryByText("FAKE Lab results")).toBeNull();
    expect(
      screen.getByText(humanText("FAKE Riley Example’s folders")),
    ).toBeVisible();
  });

  it("says just Folders for the only person, and keeps their folders while Shared with me is open", () => {
    setLocaleOverride("en");
    const p = props();
    render(
      <LibrarySidebar
        {...p}
        people={[p.people[0]]}
        section="shared"
        folders={p.folders.filter((folder) => folder.profileId === "p1")}
      />,
    );
    expect(screen.getByText("Folders")).toBeVisible();
    expect(screen.getByText("FAKE Lab results")).toBeVisible();
    expect(
      screen.getByRole("button", { name: humanText(/^Shared with me/) }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("opens the person, the folder, Shared with me and each setting, and marks where the patient is", () => {
    setLocaleOverride("en");
    const p = props();
    render(<LibrarySidebar {...p} currentFolderId="f2" />);
    fireEvent.click(screen.getByRole("button", { name: /FAKE Riley Example/ }));
    expect(p.onOpenPerson).toHaveBeenCalledWith("p2");
    fireEvent.click(screen.getByRole("button", { name: /FAKE Lab results/ }));
    expect(p.onOpenFolder).toHaveBeenCalledWith("p1", "f1");
    expect(screen.getByRole("button", { name: /FAKE Visits/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.click(
      screen.getByRole("button", { name: humanText(/^Shared with me/) }),
    );
    expect(p.onOpenShared).toHaveBeenCalled();
    const settings = screen.getByRole("group", { name: "Settings" });
    fireEvent.click(within(settings).getByRole("button", { name: "Security" }));
    fireEvent.click(
      within(settings).getByRole("button", { name: "Preferences" }),
    );
    fireEvent.click(
      within(settings).getByRole("button", { name: "AI helper" }),
    );
    expect(p.onOpenSecurity).toHaveBeenCalled();
    expect(p.onOpenPreferences).toHaveBeenCalled();
    expect(p.onOpenAi).toHaveBeenCalled();
  });

  it("has no accessibility violations, with the menu closed and open", async () => {
    setLocaleOverride("en");
    render(<LibrarySidebar {...props()} />);
    expect(await axe.run(document.body, AXE)).toHaveProperty("violations", []);
    fireEvent.click(screen.getByRole("button", { name: "Add document" }));
    expect(await axe.run(document.body, AXE)).toHaveProperty("violations", []);
  });
});

// Edge cases of what the sidebar lists, counts and lets be dragged. FAKE names only.
describe("LibrarySidebar: edge cases", () => {
  const folderOf = (id: string, name: string, parentId: string | null) => ({
    id,
    profileId: "p1",
    parentId,
    name,
    createdAtMs: 1,
  });
  const record = (id: string, profileId: string, folderIds: string[]) =>
    ({ id, profileId, folderIds }) as unknown as VaultRecord;
  /** The folder buttons, by the folder's own name, in the order shown. */
  const folderNames = (container: HTMLElement) =>
    Array.from(container.querySelectorAll(".side-nav > button"))
      .filter((button) => button.querySelector(".native-nav-name"))
      .map((button) => button.querySelector(".native-nav-name")!.textContent)
      .filter((name) =>
        /^FAKE (Alpha|Level|Zeta|Orphan|Loop)/.test(name ?? ""),
      );

  it("lists folders in tree order, siblings by name, each once, indents to a limit, and never shows an orphan or a folder its own parent", () => {
    setLocaleOverride("en");
    const chain = Array.from({ length: 11 }, (_, index) =>
      folderOf(
        `c${index}`,
        `FAKE Level ${index}`,
        index === 0 ? null : `c${index - 1}`,
      ),
    );
    const p = props();
    const { container } = render(
      <LibrarySidebar
        {...p}
        folders={[
          folderOf("z", "FAKE Zeta", null),
          folderOf("a", "FAKE Alpha", null),
          // The same folder twice: shown once.
          folderOf("a", "FAKE Alpha", null),
          // A parent that is not in the list, and a folder that is its own parent: not reachable
          // from the top, so not listed (and no loop).
          folderOf("orphan", "FAKE Orphan", "missing"),
          folderOf("loop", "FAKE Loop", "loop"),
          ...chain,
        ]}
      />,
    );
    expect(folderNames(container)).toEqual([
      "FAKE Alpha",
      ...chain.map((folder) => folder.name),
      "FAKE Zeta",
    ]);
    // Each level is indented 14px more, to the eighth level: 10px + 8 x 14px = 122px.
    const padding = (name: string) =>
      (
        Array.from(container.querySelectorAll(".side-nav > button")).find(
          (button) =>
            button.querySelector(".native-nav-name")?.textContent === name,
        ) as HTMLElement
      ).style.paddingLeft;
    expect(padding("FAKE Alpha")).toBe("10px");
    expect(padding("FAKE Level 1")).toBe("24px");
    expect(padding("FAKE Level 8")).toBe("122px");
    expect(padding("FAKE Level 10")).toBe("122px");
  });

  it("lets a folder be dragged only while its own section is open and nothing is running", () => {
    setLocaleOverride("en");
    const draggable = (
      extra: Partial<ComponentProps<typeof LibrarySidebar>>,
    ) => {
      const p = { ...props(), ...extra };
      const { unmount } = render(<LibrarySidebar {...p} />);
      const button = screen.getByRole("button", { name: /FAKE Lab results/ });
      const attribute = button.getAttribute("draggable");
      const notPrevented = fireEvent.dragStart(button);
      const started = p.drag.startDrag as ReturnType<typeof vi.fn>;
      const calls = started.mock.calls.length;
      unmount();
      return { attribute, notPrevented, calls, started };
    };
    const open = draggable({});
    expect(open.attribute).toBe("true");
    expect(open.notPrevented).toBe(true);
    expect(open.calls).toBe(1);
    expect(open.started.mock.calls[0][1]).toEqual({ kind: "folder", id: "f1" });
    for (const extra of [{ disabled: true }, { section: "shared" as const }]) {
      const closed = draggable(extra);
      expect(closed.attribute, JSON.stringify(extra)).toBeNull();
      // The drag is cancelled, and nothing starts.
      expect(closed.notPrevented, JSON.stringify(extra)).toBe(false);
      expect(closed.calls, JSON.stringify(extra)).toBe(0);
    }
  });

  it("counts the open person's documents and folders in the footer, and the whole vault's while Shared with me (or Hidden from it) is open", () => {
    setLocaleOverride("en");
    const p = props();
    const records = [
      record("r1", "p1", []),
      record("r2", "p1", ["f1"]),
      record("r3", "p1", ["f1", "f2"]),
      record("r4", "p2", ["f3"]),
    ];
    // Said with invisible isolation marks around each number: compare without them.
    const plain = (text: string | null) => (text ?? "").replace(/[⁦-⁩]/g, "");
    const storage = () =>
      plain(
        screen.getByText(humanText("Encrypted local vault")).parentElement!
          .textContent,
      );
    const { rerender } = render(<LibrarySidebar {...p} records={records} />);
    // p1 has three documents and two folders; p2's are not counted.
    expect(storage()).toMatch(/3 documents.*2 folders/);
    // The folder rows count what is in them: a document in two folders counts in both.
    expect(
      plain(
        screen
          .getByRole("button", { name: /FAKE Lab results/ })
          .getAttribute("aria-label"),
      ),
    ).toMatch(/2 documents/);
    expect(
      plain(
        screen
          .getByRole("button", { name: /FAKE Visits/ })
          .getAttribute("aria-label"),
      ),
    ).toMatch(/1 document\b/);
    rerender(<LibrarySidebar {...p} records={records} section="shared" />);
    expect(storage()).toMatch(/3 documents.*3 folders/);
    rerender(
      <LibrarySidebar
        {...p}
        records={records}
        section="hidden"
        hiddenFromShared
      />,
    );
    expect(storage()).toMatch(/3 documents.*3 folders/);
    // Hidden, but not from Shared: the person's own.
    rerender(<LibrarySidebar {...p} records={records} section="hidden" />);
    expect(storage()).toMatch(/3 documents.*2 folders/);
  });

  it("shows only Shared with me and Settings when there are no people, and no folders for a person with none", () => {
    setLocaleOverride("en");
    const p = props();
    const { container, rerender } = render(
      <LibrarySidebar {...p} people={[]} folders={[]} records={[]} />,
    );
    expect(container.querySelectorAll(".person-initials")).toHaveLength(0);
    expect(screen.queryByText("People")).toBeVisible();
    expect(container.querySelectorAll(".nav-label")).toHaveLength(1);
    expect(screen.getByRole("group", { name: "Settings" })).toBeVisible();
    // One person with no folders: the label is there, the list under it is empty.
    rerender(
      <LibrarySidebar
        {...p}
        people={[p.people[0]]}
        folders={[]}
        records={[]}
      />,
    );
    expect(screen.getByText("Folders")).toBeVisible();
    expect(
      container.querySelectorAll(".side-nav > button .native-nav-name"),
    ).toHaveLength(2); // Shared with me, and the person
  });

  it("never offers a person who is not in the list, whatever the open person id says, and lists none of their folders", () => {
    setLocaleOverride("en");
    const p = props();
    // A hidden person is not in `people`; their folders may still be in the vault's list, and the
    // open person id may still name them.
    const { container } = render(
      <LibrarySidebar
        {...p}
        people={[p.people[0]]}
        profileId="hidden-person"
        folders={[
          ...p.folders,
          {
            ...folderOf("h1", "FAKE Hidden papers", null),
            profileId: "hidden-person",
          },
        ]}
        records={[record("hr", "hidden-person", ["h1"])]}
      />,
    );
    expect(screen.queryByText("FAKE Hidden papers")).toBeNull();
    // No folder list at all: no person is open, so there is no one whose folders they are.
    expect(screen.queryByText("Folders")).toBeNull();
    expect(container.textContent).not.toMatch(/Hidden papers|hidden-person/);
    // The one person that is listed (shown as "My records", being the only one) is not marked as
    // open.
    expect(
      screen.getByRole("button", { name: /My records/ }),
    ).not.toHaveAttribute("aria-current");
  });

  it("says how many arrived in Shared with me, and says nothing of a count when none did", () => {
    setLocaleOverride("en");
    const p = props();
    const { rerender } = render(<LibrarySidebar {...p} sharedNew={2} />);
    const shared = () =>
      screen.getByRole("button", { name: humanText(/^Shared with me/) });
    expect(
      (shared().getAttribute("aria-label") ?? "").replace(/[⁦-⁩]/g, ""),
    ).toMatch(/Shared with me.*2 new/);
    expect(shared()).toHaveClass("native-shared-new");
    rerender(<LibrarySidebar {...p} sharedNew={0} />);
    expect(shared()).not.toHaveClass("native-shared-new");
    expect(shared()).not.toHaveAttribute("aria-label");
    expect(shared().querySelector(".nav-count")).toBeNull();
  });

  it("passes the Add document state on: disabled, and Working… while something runs", () => {
    setLocaleOverride("en");
    const p = props();
    const { rerender } = render(<LibrarySidebar {...p} addDisabled />);
    expect(screen.getByRole("button", { name: "Add document" })).toBeDisabled();
    rerender(<LibrarySidebar {...p} addWorking />);
    const busy = screen.getByRole("button", { name: "Working…" });
    expect(busy).toBeDisabled();
  });

  it("leaves out the AI helper where the helper cannot run", () => {
    setLocaleOverride("en");
    const p = props();
    render(<LibrarySidebar {...p} onOpenAi={undefined} />);
    const settings = screen.getByRole("group", { name: "Settings" });
    expect(
      within(settings).queryByRole("button", { name: "AI helper" }),
    ).toBeNull();
    expect(within(settings).getAllByRole("button")).toHaveLength(2);
  });
});

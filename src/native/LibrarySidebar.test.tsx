import type { ComponentProps } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { setLocaleOverride } from "../i18n";
import { humanText } from "../test/humanText";
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

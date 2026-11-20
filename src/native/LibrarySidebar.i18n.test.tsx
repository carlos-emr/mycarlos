import type { ComponentProps } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LOCALES, setLocaleOverride } from "../i18n";
import { LibrarySidebar } from "./LibrarySidebar";

function sidebarProps(): ComponentProps<typeof LibrarySidebar> {
  return {
    profileName: "FAKE vault",
    people: [
      { id: "p1", displayName: "FAKE Avery", createdAtMs: 1 },
      { id: "p2", displayName: "FAKE Blake", createdAtMs: 2 },
    ],
    profileId: "p1",
    section: "records",
    sharedNew: 0,
    onOpenShared: vi.fn(),
    vaultTotals: { documents: 0, folders: 1 },
    currentFolderId: "folder-p1",
    folders: [
      {
        id: "folder-p1",
        profileId: "p1",
        parentId: null,
        name: "FAKE Results",
        createdAtMs: 1,
      },
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
    onOpenPerson: vi.fn(),
    onOpenFolder: vi.fn(),
    onOpenSecurity: vi.fn(),
    onOpenPreferences: vi.fn(),
  };
}

describe("localized folder labels on a mounted sidebar", () => {
  it("keeps focus and folder identity while switching languages with literal RTL names", () => {
    setLocaleOverride("en");
    const props = sidebarProps();
    const folderName = "FAKE אבג <b>{$person}</b>";
    const personName = "FAKE نور { $folder }";
    props.folders[0].name = folderName;
    props.people[0].displayName = personName;
    const { container } = render(<LibrarySidebar {...props} />);
    const button = screen.getByRole("button", { current: "page" });
    button.focus();

    // Read the raw label: stripping FSI/PDI here would hide a regression in
    // either name's isolation. These values must stay literal, not Fluent or HTML.
    for (const locale of [...LOCALES, "en"] as const) {
      act(() => setLocaleOverride(locale));
      const folder = `\u2068${folderName}\u2069`;
      const person = `\u2068${personName}\u2069`;
      const expected = locale.startsWith("zh-")
        ? `${folder}（${person}） 0`
        : `${folder} (${person}) 0`;
      expect(button).toHaveAttribute("aria-label", expected);
      expect(button).toHaveAccessibleName(expected);
      expect(screen.getByRole("button", { current: "page" })).toBe(button);
      expect(button).toHaveFocus();
      expect(within(button).getByText(folderName)).toBeVisible();
      expect(container.querySelector("b")).toBeNull();
      expect(document.documentElement.lang).toBe(locale);
    }

    fireEvent.click(button);
    expect(props.onOpenFolder).toHaveBeenCalledExactlyOnceWith(
      "p1",
      "folder-p1",
    );
    expect(props.onOpenPerson).not.toHaveBeenCalled();
  });

  it("removes the owner label for one person and restores current names when another returns", () => {
    setLocaleOverride("zh-TW");
    const props = sidebarProps();
    const { rerender } = render(<LibrarySidebar {...props} />);
    const button = screen.getByRole("button", { current: "page" });
    button.focus();
    expect(button).toHaveAttribute(
      "aria-label",
      "\u2068FAKE Results\u2069（\u2068FAKE Avery\u2069） 0",
    );

    rerender(<LibrarySidebar {...props} people={[props.people[0]]} />);
    expect(button).not.toHaveAttribute("aria-label");
    expect(button).toHaveAccessibleName("FAKE Results 0");
    expect(button).toHaveFocus();

    act(() => setLocaleOverride("pl"));
    rerender(
      <LibrarySidebar
        {...props}
        people={[
          { ...props.people[0], displayName: "FAKE Renamed person" },
          props.people[1],
        ]}
        folders={[{ ...props.folders[0], name: "FAKE Renamed folder" }]}
      />,
    );
    expect(screen.getByRole("button", { current: "page" })).toBe(button);
    expect(button).toHaveAttribute(
      "aria-label",
      "\u2068FAKE Renamed folder\u2069 (\u2068FAKE Renamed person\u2069) 0",
    );
    expect(button).toHaveFocus();
    expect(button).not.toHaveAccessibleName(/FAKE Avery|FAKE Results/);
    fireEvent.click(button);
    expect(props.onOpenFolder).toHaveBeenCalledExactlyOnceWith(
      "p1",
      "folder-p1",
    );
  });
});

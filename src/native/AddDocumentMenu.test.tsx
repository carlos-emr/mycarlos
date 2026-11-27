import { fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import {
  AddDocumentMenu,
  MenuButton,
  type AddMenuItem,
} from "./AddDocumentMenu";
import { setLocaleOverride } from "../i18n";
import { humanText } from "../test/humanText";

const AXE = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
};

function items(): AddMenuItem[] {
  return [
    { id: "import", label: "Import a file", icon: "plus", onChoose: vi.fn() },
    { id: "photo", label: "Take a photo", icon: "camera", onChoose: vi.fn() },
    {
      id: "video",
      label: "Record a video",
      icon: "video",
      disabled: true,
      onChoose: vi.fn(),
    },
    {
      id: "folder",
      label: "New folder",
      icon: "folder-plus",
      onChoose: vi.fn(),
    },
  ];
}
const trigger = () =>
  screen.getByRole("button", { name: humanText("Add document") });
const menuItem = (name: string) =>
  screen.getByRole("menuitem", { name: humanText(name) });

describe("AddDocumentMenu", () => {
  it("is a closed menu button until it is asked", () => {
    render(<AddDocumentMenu items={items()} />);
    expect(trigger()).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens with the first item focused, names its items, and has no accessibility violations", async () => {
    setLocaleOverride("en");
    render(<AddDocumentMenu items={items()} />);
    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: humanText("Add document") });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Import a file",
      "Take a photo",
      "Record a video",
      "New folder",
    ]);
    expect(menuItem("Import a file")).toHaveFocus();
    expect(await axe.run(document.body, AXE)).toHaveProperty("violations", []);
  });

  it("opens from the Down arrow on the button too", () => {
    render(<AddDocumentMenu items={items()} />);
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(screen.getByRole("menu")).toBeVisible();
    expect(menuItem("Import a file")).toHaveFocus();
  });

  it("moves with the arrows, Home and End, wraps, and skips an item that cannot be used", () => {
    render(<AddDocumentMenu items={items()} />);
    fireEvent.click(trigger());
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(menuItem("Take a photo")).toHaveFocus();
    // "Record a video" is disabled: the next one is New folder.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(menuItem("New folder")).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(menuItem("Import a file")).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(menuItem("New folder")).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(menuItem("Import a file")).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(menuItem("New folder")).toHaveFocus();
  });

  it("closes on Escape, giving the focus back to the button, and does not pass the key on", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <AddDocumentMenu items={items()} />
      </div>,
    );
    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(outer).not.toHaveBeenCalled();
  });

  it("closes when the focus leaves by Tab, and on a press outside", () => {
    render(
      <div>
        <AddDocumentMenu items={items()} />
        <button>Elsewhere</button>
      </div>,
    );
    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger());
    fireEvent.mouseDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu")).toBeNull();
    // A press inside it does not close it.
    fireEvent.click(trigger());
    fireEvent.mouseDown(menuItem("Take a photo"));
    expect(screen.getByRole("menu")).toBeVisible();
  });

  it("does what an item says once, closes, and returns the focus to the button first", () => {
    const list = items();
    let focusedWhenChosen: Element | null = null;
    list[1].onChoose = vi.fn(() => {
      focusedWhenChosen = document.activeElement;
    });
    render(<AddDocumentMenu items={list} />);
    fireEvent.click(trigger());
    fireEvent.click(menuItem("Take a photo"));
    expect(list[1].onChoose).toHaveBeenCalledTimes(1);
    // A dialog opened by the item remembers the button as what to return to.
    expect(focusedWhenChosen).toBe(trigger());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(list[0].onChoose).not.toHaveBeenCalled();
  });

  it("offers nothing while it is disabled, and a disabled item does nothing", () => {
    const { rerender } = render(<AddDocumentMenu items={items()} disabled />);
    expect(trigger()).toBeDisabled();
    fireEvent.click(trigger());
    expect(screen.queryByRole("menu")).toBeNull();
    const list = items();
    rerender(<AddDocumentMenu items={list} />);
    fireEvent.click(trigger());
    fireEvent.click(menuItem("Record a video"));
    expect(list[2].onChoose).not.toHaveBeenCalled();
  });

  it("says Working… and cannot be opened while something is running", () => {
    render(<AddDocumentMenu items={items()} working />);
    const busy = screen.getByRole("button", { name: humanText("Working…") });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(screen.queryByRole("menu")).toBeNull();
    // Not "Add document" any more: the words it shows are the words it is named by.
    expect(
      screen.queryByRole("button", { name: humanText("Add document") }),
    ).toBeNull();
  });
});

// The one menu button of the decluttered screens, in the shapes the screens use it in. Edge cases
// of the keyboard and of what the button is named by; FAKE labels only.
describe("MenuButton", () => {
  const choices = (): AddMenuItem[] => [
    { id: "newest", label: "Newest first", checked: true, onChoose: vi.fn() },
    { id: "name", label: "Name A–Z", checked: false, onChoose: vi.fn() },
  ];

  it("is named by its label when it shows no words, by its words when it shows them, and by buttonName when given", () => {
    // Nothing shown: the label is the name.
    const { rerender } = render(
      <MenuButton label="More for FAKE Sam" items={choices()} />,
    );
    expect(
      screen.getByRole("button", { name: "More for FAKE Sam" }),
    ).toBeVisible();
    // A picture only (the icon variant): still the label, not the picture.
    rerender(
      <MenuButton label="More for FAKE Sam" items={choices()} variant="icon">
        <span aria-hidden="true">…</span>
      </MenuButton>,
    );
    expect(
      screen.getByRole("button", { name: "More for FAKE Sam" }),
    ).toBeVisible();
    // Words shown: they name the button.
    rerender(
      <MenuButton label="Sort by" items={choices()}>
        Sort by: Newest first
      </MenuButton>,
    );
    expect(
      screen.getByRole("button", { name: "Sort by: Newest first" }),
    ).toBeVisible();
    // buttonName wins.
    rerender(
      <MenuButton
        label="Sort by"
        buttonName="Sort by: Name A–Z"
        items={choices()}
      >
        Sort by: Name A–Z
      </MenuButton>,
    );
    expect(
      screen.getByRole("button", { name: "Sort by: Name A–Z" }),
    ).toBeVisible();
  });

  it("opens with the first USABLE item focused when the first one is disabled", () => {
    const list = choices();
    list[0].disabled = true;
    render(
      <MenuButton label="Sort by" items={list}>
        Sort
      </MenuButton>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    expect(
      screen.getByRole("menuitemradio", { name: /Name A–Z/ }),
    ).toHaveFocus();
  });

  it("opens with nothing to focus when no item can be used: the keys then move nothing, and Escape still closes it", () => {
    const none = choices().map((item) => ({ ...item, disabled: true }));
    render(
      <MenuButton label="Sort by" items={none}>
        Sort
      </MenuButton>,
    );
    const button = screen.getByRole("button", { name: "Sort" });
    fireEvent.click(button);
    const menu = screen.getByRole("menu");
    expect(menu.contains(document.activeElement)).toBe(false);
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
      fireEvent.keyDown(menu, { key });
      expect(menu.contains(document.activeElement), key).toBe(false);
    }
    expect(screen.getByRole("menu")).toBeVisible();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("leaves an open menu as it is when Down is pressed on its button (it opens a closed one only)", () => {
    render(
      <MenuButton label="Sort by" items={choices()}>
        Sort
      </MenuButton>,
    );
    const button = screen.getByRole("button", { name: "Sort" });
    fireEvent.click(button);
    button.focus();
    // `fireEvent` returns false when the handler called preventDefault: it did not.
    expect(fireEvent.keyDown(button, { key: "ArrowDown" })).toBe(true);
    expect(screen.getByRole("menu")).toBeVisible();
    // A closed one is opened by the same key, and the key is taken.
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(fireEvent.keyDown(button, { key: "ArrowDown" })).toBe(false);
    expect(screen.getByRole("menu")).toBeVisible();
  });

  it("marks the current choice by a tick, offers the choices as radios, and chooses one without touching the other", () => {
    const list = choices();
    render(
      <MenuButton label="Sort by" items={list}>
        Sort
      </MenuButton>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    const [newest, byName] = screen.getAllByRole("menuitemradio");
    expect(newest).toHaveAttribute("aria-checked", "true");
    expect(byName).toHaveAttribute("aria-checked", "false");
    expect(newest.textContent).toContain("✓");
    expect(byName.textContent).not.toContain("✓");
    // The tick is decoration: said by aria-checked, not read as text.
    expect(newest.querySelector(".menu-button-tick")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    fireEvent.click(byName);
    expect(list[1].onChoose).toHaveBeenCalledTimes(1);
    expect(list[0].onChoose).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("draws the variant and the side it was asked for, and opens again at the first item after it was closed", () => {
    const { container } = render(
      <MenuButton
        label="More for FAKE Sam"
        items={choices()}
        variant="icon"
        align="end"
      />,
    );
    expect(container.querySelector(".menu-button-icon")).not.toBeNull();
    const button = screen.getByRole("button", { name: "More for FAKE Sam" });
    fireEvent.click(button);
    expect(container.querySelector(".menu-button-list-end")).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
    expect(screen.getAllByRole("menuitemradio")[1]).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.click(button);
    expect(screen.getAllByRole("menuitemradio")[0]).toHaveFocus();
  });
});

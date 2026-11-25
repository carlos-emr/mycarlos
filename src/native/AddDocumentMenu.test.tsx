import { fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { AddDocumentMenu, type AddMenuItem } from "./AddDocumentMenu";
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
});

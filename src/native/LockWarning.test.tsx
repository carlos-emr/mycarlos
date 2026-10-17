import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockWarning } from "./LockWarning";

describe("LockWarning (#68)", () => {
  afterEach(async () => {
    await page.viewport(1100, 760);
  });

  it("is read out as it opens, with Keep open focused", () => {
    const onKeepOpen = vi.fn();
    render(<LockWarning seconds={30} onKeepOpen={onKeepOpen} />);
    const dialog = screen.getByRole("alertdialog", {
      name: "myCarlos will lock in 30 seconds to keep your records private.",
    });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription(
      "To keep it open, press Keep open, or any key.",
    );
    const keepOpen = screen.getByRole("button", { name: "Keep open" });
    expect(keepOpen).toHaveFocus();
    fireEvent.click(keepOpen);
    expect(onKeepOpen).toHaveBeenCalledOnce();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onKeepOpen).toHaveBeenCalledTimes(2);
  });

  it("has no automatically detectable WCAG A or AA violations", async () => {
    render(<LockWarning seconds={30} onKeepOpen={vi.fn()} />);
    const results = await axe.run(screen.getByRole("alertdialog"), {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
    expect(results.violations).toEqual([]);
  });

  it("says one second as one", () => {
    render(<LockWarning seconds={1} onKeepOpen={vi.fn()} />);
    expect(screen.getByRole("alertdialog")).toHaveAccessibleName(
      "myCarlos will lock in 1 second to keep your records private.",
    );
  });

  it("can be read and answered at 400% text size", async () => {
    // 400% of a 1280 by 1024 window: a quarter as wide and as tall.
    await page.viewport(320, 256);
    render(<LockWarning seconds={30} onKeepOpen={vi.fn()} />);
    const dialog = screen.getByRole("alertdialog");
    const keepOpen = screen.getByRole("button", { name: "Keep open" });
    // Nothing to scroll sideways; what does not fit scrolls down, inside.
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    expect(getComputedStyle(dialog).overflowY).toBe("auto");
    // Focused, so it is scrolled to: whole, and a large target.
    const box = keepOpen.getBoundingClientRect();
    const edge = dialog.getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(edge.top);
    expect(box.bottom).toBeLessThanOrEqual(edge.bottom);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});

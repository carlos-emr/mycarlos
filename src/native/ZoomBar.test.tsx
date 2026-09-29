import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ZoomBar } from "./ZoomBar";
import { startZoom } from "./zoom";

function show(kept?: string, mac = false) {
  if (kept) window.localStorage.setItem("mycarlos.zoom.v1", kept);
  const setZoom = vi.fn().mockResolvedValue(undefined);
  const zoom = startZoom(setZoom, mac);
  onTestFinished(zoom.stop);
  render(<ZoomBar zoom={zoom} mac={mac} />);
  return { setZoom, zoom };
}

describe("ZoomBar", () => {
  beforeEach(() => window.localStorage.clear());

  it("shows the size and the way to change it without a keyboard", async () => {
    const user = userEvent.setup();
    const { setZoom } = show();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Text size 100%");
    // Nothing to go back to, and nothing to explain, at the ordinary size.
    expect(
      screen.queryByRole("button", { name: "Back to normal size" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Larger text" }));
    expect(status).toHaveTextContent("Text size 110%");
    expect(setZoom).toHaveBeenLastCalledWith(1.1);
    expect(screen.getByText(/hold Ctrl and press plus/)).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Back to normal size" }),
    );
    expect(status).toHaveTextContent("Text size 100%");
    expect(setZoom).toHaveBeenLastCalledWith(1);
  });

  it("shows a size that was set with the keys, or kept from last time", () => {
    show("2.5");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Text size 250%");
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "-", ctrlKey: true }),
      );
    });
    expect(status).toHaveTextContent("Text size 200%");
  });

  it("stops at each end, and keeps the focus there", async () => {
    const user = userEvent.setup();
    const { setZoom } = show("3");
    const larger = screen.getByRole("button", { name: "Larger text" });
    await user.click(larger);
    expect(larger).toHaveAttribute("aria-disabled", "true");
    expect(larger).toHaveFocus();
    await user.click(larger);
    expect(setZoom).toHaveBeenLastCalledWith(4);
    expect(
      screen.getByRole("button", { name: "Smaller text" }),
    ).toHaveAttribute("aria-disabled", "false");
  });

  it("puts the focus on Larger text after going back to normal size", async () => {
    const user = userEvent.setup();
    show("1.5");
    await user.click(
      screen.getByRole("button", { name: "Back to normal size" }),
    );
    expect(screen.getByRole("button", { name: "Larger text" })).toHaveFocus();
  });

  it("gives the screens below the room it takes", () => {
    show("2");
    const height =
      document.documentElement.style.getPropertyValue("--zoom-bar-height");
    expect(height).toMatch(/^\d+(\.\d+)?px$/);
    expect(parseFloat(height)).toBeGreaterThan(0);
  });

  it("names the key a Mac has", async () => {
    show("1.5", true);
    expect(screen.getByText(/hold Command and press plus/)).toBeVisible();
  });
});

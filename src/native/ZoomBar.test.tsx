import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { NativeZoom } from "./nativeZoom";
import { NativeZoomBar, ZoomBar } from "./ZoomBar";
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

  it("keeps the focus when Ctrl+0 removes Back to normal size", async () => {
    const user = userEvent.setup();
    show("1.5");
    await user.click(
      screen.getByRole("button", { name: "Back to normal size" }),
    );
    await user.click(screen.getByRole("button", { name: "Larger text" }));
    const back = screen.getByRole("button", { name: "Back to normal size" });
    back.focus();
    await user.keyboard("{Control>}0{/Control}");
    expect(back).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Larger text" })).toHaveFocus();
  });

  it("leaves the focus in an open dialog when its buttons are pressed", async () => {
    show("1.5");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const inside = document.createElement("button");
    inside.textContent = "FAKE dialog button";
    dialog.append(inside);
    document.body.append(dialog);
    onTestFinished(() => dialog.remove());
    inside.focus();
    // As a screen reader presses it: without moving the focus first.
    await act(async () =>
      screen.getByRole("button", { name: "Back to normal size" }).click(),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Text size 100%");
    expect(inside).toHaveFocus();
  });

  it("appears when the zoom is installed after the first render", async () => {
    let install!: (native: NativeZoom | null) => void;
    const installed = new Promise<NativeZoom | null>((resolve) => {
      install = resolve;
    });
    render(<NativeZoomBar initial={null} installed={installed} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    const zoom = startZoom(vi.fn().mockResolvedValue(undefined), false);
    onTestFinished(zoom.stop);
    await act(async () => install({ zoom, mac: false }));
    expect(screen.getByRole("status")).toHaveTextContent("Text size 100%");
  });

  it("shows nothing when there is no zoom to install", async () => {
    render(<NativeZoomBar initial={null} installed={Promise.resolve(null)} />);
    await act(async () => undefined);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
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

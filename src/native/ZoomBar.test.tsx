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

    await user.click(screen.getByRole("button", { name: "Larger" }));
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

  it("stops at each end", () => {
    show("4");
    expect(screen.getByRole("button", { name: "Larger" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Smaller" })).toBeEnabled();
  });

  it("names the key a Mac has", async () => {
    show("1.5", true);
    expect(screen.getByText(/hold Command and press plus/)).toBeVisible();
  });
});

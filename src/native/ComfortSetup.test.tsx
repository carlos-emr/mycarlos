import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ComfortSetup } from "./ComfortSetup";
import { NativeZoomProvider } from "./TextSizeSetting";
import { startZoom } from "./zoom";

function show(native: boolean, autoLockMinutes = 5) {
  const onAutoLockMinutes = vi.fn();
  const onDone = vi.fn();
  const setZoom = vi.fn().mockResolvedValue(undefined);
  const zoom = startZoom(setZoom, false);
  onTestFinished(zoom.stop);
  render(
    <NativeZoomProvider
      initial={native ? { zoom, mac: false } : null}
      installed={Promise.resolve(null)}
    >
      <ComfortSetup
        autoLockMinutes={autoLockMinutes}
        onAutoLockMinutes={onAutoLockMinutes}
        onDone={onDone}
      />
    </NativeZoomProvider>,
  );
  return { onAutoLockMinutes, onDone, setZoom, zoom };
}

describe("ComfortSetup (#69)", () => {
  // Other test files share this storage.
  afterEach(() => window.localStorage.removeItem("mycarlos.zoom.v1"));

  it("offers Text size with a sample, and the lock delay, each applied at once", async () => {
    const user = userEvent.setup();
    const { onAutoLockMinutes, onDone, setZoom } = show(true);
    expect(
      screen.getByRole("heading", {
        name: "Make myCarlos comfortable for you",
      }),
    ).toBeVisible();
    expect(
      screen.getByText(/This is how text looks in myCarlos/),
    ).toBeVisible();
    expect(
      screen.getByText(/You can change these any time in Settings/),
    ).toBeVisible();

    // The same control as Settings: the size changes as it is pressed.
    await user.click(screen.getByRole("button", { name: "Larger text" }));
    expect(setZoom).toHaveBeenLastCalledWith(1.1);

    const delay = screen.getByRole("group", { name: "Automatic lock delay" });
    await user.click(
      within(delay).getByRole("button", { name: "Longer delay" }),
    );
    expect(onAutoLockMinutes).toHaveBeenLastCalledWith(6);

    // Continue keeps what was chosen.
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onDone).toHaveBeenCalledOnce();
    expect(setZoom).toHaveBeenCalledTimes(1);
  });

  it("puts the usual settings back when they are asked for, and goes on", () => {
    const { onAutoLockMinutes, onDone, zoom } = show(true, 9);
    fireEvent.click(screen.getByRole("button", { name: "Larger text" }));
    expect(zoom.level()).toBe(1.1);
    fireEvent.click(
      screen.getByRole("button", { name: "Use the usual settings" }),
    );
    expect(zoom.level()).toBe(1);
    expect(onAutoLockMinutes).toHaveBeenLastCalledWith(5);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("says where text size comes from where myCarlos does not set it", () => {
    const { onDone } = show(false);
    expect(
      screen.queryByRole("button", { name: "Larger text" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/text size follows your device/)).toBeVisible();
    // The lock delay is still offered, and skipping still works.
    expect(
      screen.getByRole("group", { name: "Automatic lock delay" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Use the usual settings" }),
    );
    expect(onDone).toHaveBeenCalledOnce();
  });
});

import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startNativeZoom } from "./nativeZoom";

const ipc = vi.fn<Parameters<typeof mockIPC>[0]>();

// What the first render does when the native side cannot say which platform it is (the case the
// other native zoom tests do not reach). The zoom is simply not offered. FAKE values only.
describe("native zoom when the platform cannot be told", () => {
  beforeEach(() => {
    // Fake timers: the first render's deadline is a timer, and none may be left running.
    vi.useFakeTimers();
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.stubGlobal("__TAURI_EVENT_PLUGIN_INTERNALS__", {});
    window.localStorage.removeItem("mycarlos.zoom.v1");
    ipc.mockReset().mockImplementation((command) => {
      if (command === "runtime_info")
        throw new Error("FAKE runtime_info is not available");
      throw new Error(`Unexpected Tauri command: ${command}`);
    });
    mockWindows("main");
    mockIPC(ipc);
  });
  afterEach(() => {
    clearMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.removeItem("mycarlos.zoom.v1");
  });

  it("offers no zoom, neither at the first render nor later, and does not fail", async () => {
    const { ready, installed } = startNativeZoom();

    await expect(ready).resolves.toBeNull();
    await expect(installed).resolves.toBeNull();
    // Only the platform was asked; nothing was zoomed.
    expect(ipc.mock.calls.map(([command]) => command)).toEqual([
      "runtime_info",
    ]);
  });

  it("leaves no startup deadline running once it has given up", async () => {
    const { ready } = startNativeZoom();
    await ready;

    expect(vi.getTimerCount()).toBe(0);
  });
});

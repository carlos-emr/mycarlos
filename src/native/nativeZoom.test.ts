import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startNativeZoom } from "./nativeZoom";

const runtimeInfo = vi.fn<() => Promise<{ platform: string }>>();
const ipc = vi.fn<Parameters<typeof mockIPC>[0]>();

const setZoom = vi.fn<(level: number) => Promise<void>>();

describe("native zoom startup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.stubGlobal("__TAURI_EVENT_PLUGIN_INTERNALS__", {});
    window.localStorage.clear();
    runtimeInfo.mockReset();
    setZoom.mockReset().mockResolvedValue(undefined);
    ipc.mockReset().mockImplementation((command, args) => {
      if (command === "runtime_info") return runtimeInfo();
      if (command === "plugin:webview|set_webview_zoom") {
        const payload = args as { label: string; value: number };
        if (payload.label !== "main")
          throw new Error("Unexpected webview label");
        return setZoom(payload.value);
      }
      throw new Error(`Unexpected Tauri command: ${command}`);
    });
    mockWindows("main");
    mockIPC(ipc);
  });
  afterEach(() => {
    clearMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // Other test files share this storage.
    window.localStorage.removeItem("mycarlos.zoom.v1");
  });

  it("renders after the deadline if platform detection hangs, and installs the zoom when it answers", async () => {
    let finish!: (value: { platform: string }) => void;
    runtimeInfo.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    window.localStorage.setItem("mycarlos.zoom.v1", "2");
    const { ready, installed } = startNativeZoom();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await ready).toBeNull();
    expect(setZoom).not.toHaveBeenCalled();
    // The platform's own zoom is off: without this there would be none.
    finish({ platform: "windows" });
    const late = await installed;
    try {
      expect(late?.mac).toBe(false);
      expect(setZoom).toHaveBeenCalledWith(2);
      const key = new KeyboardEvent("keydown", {
        key: "+",
        ctrlKey: true,
        cancelable: true,
      });
      window.dispatchEvent(key);
      expect(key.defaultPrevented).toBe(true);
    } finally {
      late?.zoom.stop();
    }
  });

  it("keeps controls when applying the saved size outlasts the same startup deadline", async () => {
    let platform!: (value: { platform: string }) => void;
    let applied!: () => void;
    runtimeInfo.mockReturnValue(
      new Promise((resolve) => {
        platform = resolve;
      }),
    );
    setZoom.mockReturnValue(
      new Promise<void>((resolve) => {
        applied = resolve;
      }),
    );
    window.localStorage.setItem("mycarlos.zoom.v1", "2");
    const { ready } = startNativeZoom();
    await vi.advanceTimersByTimeAsync(1000);
    platform({ platform: "windows" });
    await vi.advanceTimersByTimeAsync(500);
    const native = await ready;
    try {
      expect(native?.zoom.level()).toBe(2);
      expect(setZoom).toHaveBeenCalledWith(2);
      applied();
      await native?.zoom.ready;
      expect(native?.zoom.level()).toBe(2);
    } finally {
      native?.zoom.stop();
    }
  });

  it("holds the first render, within the startup wait, until the kept size is applied", async () => {
    let applied!: () => void;
    runtimeInfo.mockResolvedValue({ platform: "windows" });
    setZoom.mockReturnValue(
      new Promise<void>((resolve) => {
        applied = resolve;
      }),
    );
    window.localStorage.setItem("mycarlos.zoom.v1", "2");
    const { ready } = startNativeZoom();
    let settled = false;
    void ready.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(setZoom).toHaveBeenCalledWith(2);
    expect(settled).toBe(false);
    applied();
    const native = await ready;
    try {
      expect(settled).toBe(true);
      expect(native?.zoom.level()).toBe(2);
    } finally {
      native?.zoom.stop();
    }
  });

  it("clears the deadline when startup finishes and leaves phones alone", async () => {
    runtimeInfo.mockResolvedValue({ platform: "ios" });
    const { ready, installed } = startNativeZoom();
    expect(await ready).toBeNull();
    expect(await installed).toBeNull();
    expect(setZoom).not.toHaveBeenCalled();
    expect(ipc.mock.calls.map(([command]) => command)).toEqual([
      "runtime_info",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

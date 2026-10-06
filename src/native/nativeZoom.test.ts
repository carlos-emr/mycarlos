import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startNativeZoom } from "./nativeZoom";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));

const setZoom = vi.fn<(level: number) => Promise<void>>();

describe("native zoom startup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    window.localStorage.clear();
    vi.mocked(invoke).mockReset();
    setZoom.mockReset().mockResolvedValue(undefined);
    vi.mocked(getCurrentWebview).mockReturnValue({
      setZoom,
    } as unknown as ReturnType<typeof getCurrentWebview>);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders after the deadline if platform detection hangs, and installs the zoom when it answers", async () => {
    let finish!: (value: { platform: string }) => void;
    vi.mocked(invoke).mockReturnValue(
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
    vi.mocked(invoke).mockReturnValue(
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

  it("clears the deadline when startup finishes and leaves phones alone", async () => {
    vi.mocked(invoke).mockResolvedValue({ platform: "ios" });
    const { ready, installed } = startNativeZoom();
    expect(await ready).toBeNull();
    expect(await installed).toBeNull();
    expect(setZoom).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

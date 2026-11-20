import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPEARANCE_STORAGE_KEY, startAppearance } from "../appearance";
import { startNativeAppearance } from "./nativeAppearance";

const runtimeInfo = vi.fn<() => Promise<{ platform: string }>>();
const ipc = vi.fn<Parameters<typeof mockIPC>[0]>();
const setTheme = vi.fn<(theme: "light" | "dark" | null) => Promise<void>>();
const cleanups: (() => void)[] = [];
const tick = () => vi.advanceTimersByTimeAsync(0);

describe("native appearance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.stubGlobal("__TAURI_EVENT_PLUGIN_INTERNALS__", {});
    window.localStorage.removeItem(APPEARANCE_STORAGE_KEY);
    runtimeInfo.mockReset().mockResolvedValue({ platform: "windows" });
    setTheme.mockReset().mockResolvedValue(undefined);
    ipc.mockReset().mockImplementation((command, args) => {
      if (command === "runtime_info") return runtimeInfo();
      if (command === "plugin:window|set_theme") {
        const payload = args as {
          label: string;
          value: "light" | "dark" | null;
        };
        if (payload.label !== "main")
          throw new Error("Unexpected window label");
        return setTheme(payload.value);
      }
      throw new Error(`Unexpected Tauri command: ${command}`);
    });
    // Exercise the installed Window/core implementation through its supported
    // transport mock, rather than requiring ESM exports to be Vitest spies.
    mockWindows("main");
    mockIPC(ipc);
  });
  afterEach(() => {
    cleanups.splice(0).forEach((stop) => stop());
    clearMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.removeItem(APPEARANCE_STORAGE_KEY);
    delete document.documentElement.dataset.theme;
  });

  it.each(["windows", "macos", "linux"])(
    "sets desktop %s to System, Light, Dark and high contrast",
    async (platform) => {
      runtimeInfo.mockResolvedValue({ platform });
      const appearance = startAppearance();
      cleanups.push(startNativeAppearance(appearance));
      await tick();
      expect(setTheme).toHaveBeenLastCalledWith(null);
      appearance.set("light");
      await tick();
      expect(setTheme).toHaveBeenLastCalledWith("light");
      appearance.set("dark");
      await tick();
      expect(setTheme).toHaveBeenLastCalledWith("dark");
      appearance.set("high-contrast");
      await tick();
      expect(setTheme).toHaveBeenLastCalledWith("dark");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["ios", "android"])(
    "sends no native window-theme command on %s",
    async (platform) => {
      runtimeInfo.mockResolvedValue({ platform });
      const appearance = startAppearance();
      cleanups.push(startNativeAppearance(appearance));
      appearance.set("dark");
      await tick();
      expect(setTheme).not.toHaveBeenCalled();
      expect(ipc.mock.calls.map(([command]) => command)).toEqual([
        "runtime_info",
      ]);
      expect(appearance.snapshot().nativeError).toBe("");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does no native work in the browser", () => {
    vi.unstubAllGlobals();
    cleanups.push(startNativeAppearance(startAppearance()));
    expect(ipc).not.toHaveBeenCalled();
  });

  it("keeps the latest choice when platform detection answers after its deadline", async () => {
    let finish!: (value: { platform: string }) => void;
    runtimeInfo.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const appearance = startAppearance();
    cleanups.push(startNativeAppearance(appearance));
    appearance.set("dark");
    await vi.advanceTimersByTimeAsync(3000);
    expect(appearance.snapshot().nativeError).toBe("appearance.error.window");
    expect(document.documentElement.dataset.theme).toBe("dark");
    finish({ platform: "windows" });
    await tick();
    expect(setTheme).toHaveBeenLastCalledWith("dark");
    expect(appearance.snapshot().nativeError).toBe("");
  });

  it("reports a denied command and recovers on another choice", async () => {
    setTheme.mockRejectedValueOnce(new Error("denied"));
    const appearance = startAppearance();
    cleanups.push(startNativeAppearance(appearance));
    await tick();
    expect(appearance.snapshot().nativeError).toBe("appearance.error.window");
    appearance.set("dark");
    await tick();
    expect(appearance.snapshot().nativeError).toBe("");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("repairs a stale completion that arrives after the latest native theme", async () => {
    let finish!: () => void;
    setTheme.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const appearance = startAppearance();
    cleanups.push(startNativeAppearance(appearance));
    await tick();
    appearance.set("dark");
    await tick();
    finish();
    await tick();
    expect(setTheme.mock.calls.map(([theme]) => theme)).toEqual([
      null,
      "dark",
      "dark",
    ]);
  });

  it("times out a hung command while keeping app changes usable", async () => {
    setTheme.mockReturnValueOnce(new Promise(() => {}));
    const appearance = startAppearance();
    cleanups.push(startNativeAppearance(appearance));
    await tick();
    await vi.advanceTimersByTimeAsync(3000);
    expect(appearance.snapshot().nativeError).toBe("appearance.error.window");
    appearance.set("light");
    await tick();
    expect(setTheme).toHaveBeenLastCalledWith("light");
    expect(appearance.snapshot().nativeError).toBe("");
  });

  it("ignores platform detection after cleanup and clears its deadline", async () => {
    let finish!: (value: { platform: string }) => void;
    runtimeInfo.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const stop = startNativeAppearance(startAppearance());
    stop();
    finish({ platform: "windows" });
    await tick();
    expect(setTheme).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

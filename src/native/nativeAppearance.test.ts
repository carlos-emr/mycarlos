import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPEARANCE_STORAGE_KEY, startAppearance } from "../appearance";
import { startNativeAppearance } from "./nativeAppearance";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
const setTheme = vi.fn<(theme: "light" | "dark" | null) => Promise<void>>();
const cleanups: (() => void)[] = [];
const tick = () => vi.advanceTimersByTimeAsync(0);

describe("native appearance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    window.localStorage.removeItem(APPEARANCE_STORAGE_KEY);
    vi.mocked(invoke).mockReset().mockResolvedValue({ platform: "windows" });
    setTheme.mockReset().mockResolvedValue(undefined);
    vi.mocked(getCurrentWindow)
      .mockReset()
      .mockReturnValue({ setTheme } as unknown as ReturnType<
        typeof getCurrentWindow
      >);
  });
  afterEach(() => {
    cleanups.splice(0).forEach((stop) => stop());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.removeItem(APPEARANCE_STORAGE_KEY);
    delete document.documentElement.dataset.theme;
  });

  it.each(["windows", "macos", "linux"])(
    "sets desktop %s to System, Light and Dark",
    async (platform) => {
      vi.mocked(invoke).mockResolvedValue({ platform });
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
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["ios", "android"])(
    "does not call the unsupported window API on %s",
    async (platform) => {
      vi.mocked(invoke).mockResolvedValue({ platform });
      const appearance = startAppearance();
      cleanups.push(startNativeAppearance(appearance));
      appearance.set("dark");
      await tick();
      expect(getCurrentWindow).not.toHaveBeenCalled();
      expect(appearance.snapshot().nativeError).toBe("");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does no native work in the browser", () => {
    vi.unstubAllGlobals();
    cleanups.push(startNativeAppearance(startAppearance()));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps the latest choice when platform detection answers after its deadline", async () => {
    let finish!: (value: { platform: string }) => void;
    vi.mocked(invoke).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const appearance = startAppearance();
    cleanups.push(startNativeAppearance(appearance));
    appearance.set("dark");
    await vi.advanceTimersByTimeAsync(3000);
    expect(appearance.snapshot().nativeError).toContain("could not follow");
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
    expect(appearance.snapshot().nativeError).toContain("could not follow");
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
    expect(appearance.snapshot().nativeError).toContain("could not follow");
    appearance.set("light");
    await tick();
    expect(setTheme).toHaveBeenLastCalledWith("light");
    expect(appearance.snapshot().nativeError).toBe("");
  });

  it("ignores platform detection after cleanup and clears its deadline", async () => {
    let finish!: (value: { platform: string }) => void;
    vi.mocked(invoke).mockReturnValue(
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

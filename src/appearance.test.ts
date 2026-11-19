import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPEARANCE_STORAGE_KEY, startAppearance } from "./appearance";

describe("device appearance", () => {
  let dark: boolean;
  let changes: Set<() => void>;
  const cleanups: (() => void)[] = [];
  beforeEach(() => {
    window.localStorage.removeItem(APPEARANCE_STORAGE_KEY);
    dark = false;
    changes = new Set();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return query.includes("prefers-color-scheme") && dark;
      },
      addEventListener: (_: string, listener: () => void) =>
        changes.add(listener),
      removeEventListener: (_: string, listener: () => void) =>
        changes.delete(listener),
    }));
  });
  afterEach(() => {
    cleanups.splice(0).forEach((stop) => stop());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.removeItem(APPEARANCE_STORAGE_KEY);
    delete document.documentElement.dataset.theme;
  });
  function osDark(value: boolean) {
    dark = value;
    changes.forEach((listener) => listener());
  }

  it.each([null, "", "invalid", "Dark", '{"mode":"dark"}'])(
    "uses System for an absent or invalid stored choice %j",
    (stored) => {
      if (stored !== null)
        window.localStorage.setItem(APPEARANCE_STORAGE_KEY, stored);
      dark = true;
      const appearance = startAppearance();
      expect(appearance.snapshot()).toMatchObject({
        mode: "system",
        theme: "dark",
      });
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    },
  );

  it.each(["light", "dark", "system", "high-contrast"] as const)(
    "remembers and restores %s before rendering",
    (mode) => {
      startAppearance().set(mode);
      const reopened = startAppearance();
      expect(reopened.snapshot().mode).toBe(mode);
      expect(document.documentElement.dataset.theme).toBe(
        mode === "system" ? "light" : mode,
      );
    },
  );

  it("follows live OS changes only while System is chosen", () => {
    const appearance = startAppearance();
    cleanups.push(appearance.subscribe(() => {}));
    osDark(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    appearance.set("light");
    osDark(false);
    osDark(true);
    expect(document.documentElement.dataset.theme).toBe("light");
    appearance.set("dark");
    osDark(false);
    expect(document.documentElement.dataset.theme).toBe("dark");
    appearance.set("high-contrast");
    osDark(true);
    osDark(false);
    expect(document.documentElement.dataset.theme).toBe("high-contrast");
    appearance.set("system");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("shares and cleans up media listeners across subscriptions and a remount", () => {
    const appearance = startAppearance();
    const first = appearance.subscribe(() => {});
    const second = appearance.subscribe(() => {});
    expect(changes.size).toBe(1); // Both queries share the same callback.
    first();
    expect(changes.size).toBe(1);
    second();
    expect(changes.size).toBe(0);
    osDark(true);
    cleanups.push(appearance.subscribe(() => {}));
    expect(appearance.snapshot().theme).toBe("dark");
  });

  it("keeps an in-memory choice and reports a failed storage write", () => {
    const appearance = startAppearance();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    appearance.set("dark");
    expect(appearance.snapshot()).toMatchObject({
      mode: "dark",
      theme: "dark",
    });
    expect(appearance.snapshot().storageError).toBe(
      "appearance.error.notRemembered",
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("renders System with a truthful note if storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const appearance = startAppearance();
    expect(appearance.snapshot().mode).toBe("system");
    expect(appearance.snapshot().storageError).toBe(
      "appearance.error.unreadable",
    );
  });

  it("accepts appearance storage changes but ignores other device preferences", () => {
    const appearance = startAppearance();
    cleanups.push(appearance.subscribe(() => {}));
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: APPEARANCE_STORAGE_KEY,
        newValue: "dark",
        storageArea: window.localStorage,
      }),
    );
    expect(appearance.snapshot().mode).toBe("dark");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "mycarlos.zoom.v1",
        newValue: "light",
        storageArea: window.localStorage,
      }),
    );
    expect(appearance.snapshot().mode).toBe("dark");
  });

  it("updates browser chrome from the rendered canvas", () => {
    const existing = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    const meta =
      existing ?? document.head.appendChild(document.createElement("meta"));
    const original = meta.content;
    meta.name = "theme-color";
    try {
      startAppearance().set("dark");
      expect(meta.content).toBe(
        getComputedStyle(document.documentElement).backgroundColor,
      );
      expect(meta.content).not.toBe("rgb(242, 246, 245)");
    } finally {
      if (existing) meta.content = original;
      else meta.remove();
    }
  });

  describe("the Android status bar strip", () => {
    afterEach(() => {
      delete (window as { MyCarlosSystemBars?: unknown }).MyCarlosSystemBars;
      document.documentElement.style.removeProperty("--canvas-2");
    });

    it("is told the title bar's colour and whether it is dark, at start and on each change", () => {
      const calls: [string, boolean][] = [];
      (
        window as {
          MyCarlosSystemBars?: { set: (c: string, d: boolean) => void };
        }
      ).MyCarlosSystemBars = { set: (c, d) => calls.push([c, d]) };
      document.documentElement.style.setProperty("--canvas-2", "#e7efed");
      const appearance = startAppearance();
      expect(calls.at(-1)).toEqual(["#e7efed", false]);
      // A choice made inside myCarlos: dark and high contrast are dark
      // strips, whatever the phone's own mode is.
      document.documentElement.style.setProperty("--canvas-2", "#21372f");
      appearance.set("dark");
      expect(calls.at(-1)).toEqual(["#21372f", true]);
      document.documentElement.style.setProperty("--canvas-2", "#000");
      appearance.set("high-contrast");
      // "#000" is not "#rrggbb": the page sends nothing it cannot be sure of.
      expect(calls.at(-1)).toEqual(["#21372f", true]);
      document.documentElement.style.setProperty("--canvas-2", "#ffffff");
      appearance.set("light");
      expect(calls.at(-1)).toEqual(["#ffffff", false]);
    });

    it("does nothing where there is no bridge, and survives one that throws", () => {
      document.documentElement.style.setProperty("--canvas-2", "#112233");
      expect(() => startAppearance().set("dark")).not.toThrow();
      (window as { MyCarlosSystemBars?: unknown }).MyCarlosSystemBars = {
        set: () => {
          throw new Error("refused");
        },
      };
      expect(() => startAppearance().set("light")).not.toThrow();
    });
  });
});

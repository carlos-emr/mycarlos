import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  normalizeZoom,
  readZoom,
  startZoom,
  zoomAfter,
  zoomRequestOfKey,
} from "./zoom";

const KEY = "mycarlos.zoom.v1";

function start(mac = false) {
  const setZoom = vi.fn().mockResolvedValue(undefined);
  const stop = startZoom(setZoom, mac);
  onTestFinished(stop);
  return setZoom;
}

const press = (
  key: string,
  modifiers: KeyboardEventInit = { ctrlKey: true },
) => {
  const event = new KeyboardEvent("keydown", {
    key,
    cancelable: true,
    bubbles: true,
    ...modifiers,
  });
  window.dispatchEvent(event);
  return event;
};

describe("zoom", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps a level within its limits and on a step", () => {
    expect(normalizeZoom(1)).toBe(1);
    expect(normalizeZoom("1.4")).toBe(1.4);
    expect(normalizeZoom(1.33)).toBe(1.4);
    expect(normalizeZoom(0.1)).toBe(MIN_ZOOM);
    expect(normalizeZoom(99)).toBe(MAX_ZOOM);
    for (const not of ["", "big", NaN, Infinity, -2, 0, null, undefined, {}])
      expect(normalizeZoom(not), String(not)).toBe(1);
  });

  it("steps without drifting", () => {
    let level = 1;
    for (let step = 0; step < 40; step += 1) level = zoomAfter(level, "in");
    expect(level).toBe(MAX_ZOOM);
    for (let step = 0; step < 40; step += 1) level = zoomAfter(level, "out");
    expect(level).toBe(MIN_ZOOM);
    for (let step = 0; step < 2; step += 1) level = zoomAfter(level, "in");
    expect(level).toBe(1);
    expect(zoomAfter(2.4, "reset")).toBe(1);
  });

  it("takes Ctrl, or Cmd on a Mac, with plus, minus and 0", () => {
    const key = (key: string, modifiers: object, mac = false) =>
      zoomRequestOfKey(
        { key, ctrlKey: false, metaKey: false, altKey: false, ...modifiers },
        mac,
      );
    expect(key("+", { ctrlKey: true })).toBe("in");
    expect(key("=", { ctrlKey: true })).toBe("in");
    expect(key("-", { ctrlKey: true })).toBe("out");
    expect(key("0", { ctrlKey: true })).toBe("reset");
    expect(key("+", { metaKey: true }, true)).toBe("in");
    // Not the other platform's key, not with Alt, not alone, not other keys.
    expect(key("+", { metaKey: true })).toBeNull();
    expect(key("+", { ctrlKey: true }, true)).toBeNull();
    expect(key("+", { ctrlKey: true, altKey: true })).toBeNull();
    expect(key("+", {})).toBeNull();
    expect(key("p", { ctrlKey: true })).toBeNull();
  });

  it("changes nothing at the start when no level was kept", () => {
    const setZoom = start();
    expect(setZoom).not.toHaveBeenCalled();
    expect(readZoom()).toBe(1);
  });

  it("keeps the level for the next start", () => {
    const setZoom = start();
    expect(press("+").defaultPrevented).toBe(true);
    press("+");
    expect(setZoom.mock.calls).toEqual([[1.2], [1.4]]);
    expect(window.localStorage.getItem(KEY)).toBe("1.4");

    // The app is closed and opened again.
    const next = start();
    expect(next.mock.calls).toEqual([[1.4]]);
  });

  it("goes back to the ordinary size, and keeps that", () => {
    window.localStorage.setItem(KEY, "2");
    const setZoom = start();
    press("0");
    expect(setZoom.mock.calls).toEqual([[2], [1]]);
    expect(start()).not.toHaveBeenCalled();
  });

  it("leaves other keys alone", () => {
    const setZoom = start();
    expect(press("p").defaultPrevented).toBe(false);
    expect(press("+", {}).defaultPrevented).toBe(false);
    expect(setZoom).not.toHaveBeenCalled();
  });

  it("zooms with Ctrl and the wheel, and scrolls without it", () => {
    const setZoom = start();
    const wheel = (deltaY: number, ctrlKey: boolean) => {
      const event = new WheelEvent("wheel", {
        deltaY,
        ctrlKey,
        cancelable: true,
        bubbles: true,
      });
      window.dispatchEvent(event);
      return event;
    };
    expect(wheel(-120, true).defaultPrevented).toBe(true);
    expect(wheel(120, true).defaultPrevented).toBe(true);
    expect(wheel(120, false).defaultPrevented).toBe(false);
    expect(setZoom.mock.calls).toEqual([[1.2], [1]]);
  });

  it("stops at its limits", () => {
    window.localStorage.setItem(KEY, String(MAX_ZOOM));
    const setZoom = start();
    press("+");
    expect(setZoom.mock.calls).toEqual([[MAX_ZOOM]]);
  });

  it("ignores a kept level that is not one", () => {
    window.localStorage.setItem(KEY, "enormous");
    expect(start()).not.toHaveBeenCalled();
  });

  it("carries on when the platform refuses, or nothing can be stored", async () => {
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("FAKE storage is unavailable");
      });
    onTestFinished(() => set.mockRestore());
    const setZoom = vi.fn().mockRejectedValue(new Error("FAKE not allowed"));
    onTestFinished(startZoom(setZoom, false));
    press("+");
    press("+");
    await Promise.resolve();
    expect(setZoom.mock.calls).toEqual([[1.2], [1.4]]);
  });

  it("handles nothing once it is stopped", () => {
    const setZoom = vi.fn().mockResolvedValue(undefined);
    startZoom(setZoom, false)();
    expect(press("+").defaultPrevented).toBe(false);
    expect(setZoom).not.toHaveBeenCalled();
  });
});

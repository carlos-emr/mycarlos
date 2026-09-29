import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  ZOOM_LEVELS,
  normalizeZoom,
  readZoom,
  startZoom,
  zoomAfter,
  zoomPercent,
  zoomRequestOfKey,
} from "./zoom";

const KEY = "mycarlos.zoom.v1";
const SMALLEST = ZOOM_LEVELS[0];
const LARGEST = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];

function start(mac = false) {
  const setZoom = vi.fn().mockResolvedValue(undefined);
  const zoom = startZoom(setZoom, mac);
  onTestFinished(zoom.stop);
  return { setZoom, zoom };
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

const wheel = (deltaY: number, ctrlKey = true) => {
  const event = new WheelEvent("wheel", {
    deltaY,
    ctrlKey,
    cancelable: true,
    bubbles: true,
  });
  window.dispatchEvent(event);
  return event;
};

describe("zoom", () => {
  beforeEach(() => window.localStorage.clear());

  it("takes the size there is that is nearest", () => {
    expect(normalizeZoom(1)).toBe(1);
    expect(normalizeZoom("1.25")).toBe(1.25);
    expect(normalizeZoom(1.4)).toBe(1.5);
    expect(normalizeZoom(0.1)).toBe(SMALLEST);
    expect(normalizeZoom(99)).toBe(LARGEST);
    for (const not of ["", "big", NaN, Infinity, -2, 0, null, undefined, {}])
      expect(normalizeZoom(not), String(not)).toBe(1);
  });

  it("never goes below a size that can be read, and has the usual ones", () => {
    expect(SMALLEST).toBe(0.8);
    expect(LARGEST).toBe(4);
    for (const usual of [1, 1.1, 1.25, 1.5, 2])
      expect(ZOOM_LEVELS).toContain(usual);
    expect(zoomPercent(1.25)).toBe("125%");
  });

  it("steps through the sizes and stops at each end", () => {
    let level = 1;
    const seen = [level];
    for (let step = 0; step < 20; step += 1) {
      level = zoomAfter(level, "in");
      seen.push(level);
    }
    expect(seen.slice(0, 5)).toEqual([1, 1.1, 1.25, 1.5, 1.75]);
    expect(level).toBe(LARGEST);
    for (let step = 0; step < 20; step += 1) level = zoomAfter(level, "out");
    expect(level).toBe(SMALLEST);
    expect(zoomAfter(2.5, "reset")).toBe(1);
  });

  it("takes Ctrl, or Cmd on a Mac, with plus, minus and 0", () => {
    const key = (key: string, modifiers: object, mac = false, code = "") =>
      zoomRequestOfKey(
        {
          key,
          code,
          ctrlKey: false,
          metaKey: false,
          altKey: false,
          ...modifiers,
        },
        mac,
      );
    expect(key("+", { ctrlKey: true })).toBe("in");
    expect(key("=", { ctrlKey: true })).toBe("in");
    expect(key("-", { ctrlKey: true })).toBe("out");
    expect(key("0", { ctrlKey: true })).toBe("reset");
    expect(key("+", { metaKey: true }, true)).toBe("in");
    // The 0 key by its place: some layouts give it another sign.
    expect(key("à", { ctrlKey: true }, false, "Digit0")).toBe("reset");
    expect(key("=", { ctrlKey: true }, false, "Digit0")).toBe("reset");
    expect(key("0", { ctrlKey: true }, false, "Numpad0")).toBe("reset");
    // Not the other platform's key, not with Alt, not alone, not other keys.
    expect(key("+", { metaKey: true })).toBeNull();
    expect(key("+", { ctrlKey: true }, true)).toBeNull();
    expect(key("+", { ctrlKey: true, altKey: true })).toBeNull();
    expect(key("+", {})).toBeNull();
    expect(key("p", { ctrlKey: true })).toBeNull();
  });

  it("changes nothing at the start when no size was kept", async () => {
    const { setZoom, zoom } = start();
    await zoom.ready;
    expect(setZoom).not.toHaveBeenCalled();
    expect(readZoom()).toBe(1);
    expect(zoom.level()).toBe(1);
  });

  it("keeps the size for the next start, and goes on from it", async () => {
    const { setZoom } = start();
    expect(press("+").defaultPrevented).toBe(true);
    press("+");
    expect(setZoom.mock.calls).toEqual([[1.1], [1.25]]);
    expect(window.localStorage.getItem(KEY)).toBe("1.25");

    // The app is closed and opened again.
    const next = start();
    await next.zoom.ready;
    expect(next.setZoom.mock.calls).toEqual([[1.25]]);
    expect(next.zoom.level()).toBe(1.25);
    next.zoom.request("in");
    expect(next.setZoom).toHaveBeenLastCalledWith(1.5);
  });

  it("is ready only once the size kept is applied", async () => {
    window.localStorage.setItem(KEY, "2");
    let applied!: () => void;
    const setZoom = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          applied = resolve;
        }),
    );
    const zoom = startZoom(setZoom, false);
    onTestFinished(zoom.stop);
    let ready = false;
    void zoom.ready.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    applied();
    await zoom.ready;
    expect(ready).toBe(true);
  });

  it("tells whoever shows the size of every change", () => {
    const { zoom } = start();
    const listener = vi.fn();
    const end = zoom.subscribe(listener);
    press("+");
    zoom.request("in");
    zoom.request("reset");
    // At the ordinary size already: nothing changes.
    zoom.request("reset");
    expect(listener).toHaveBeenCalledTimes(3);
    end();
    press("+");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("leaves other keys alone", () => {
    const { setZoom } = start();
    expect(press("p").defaultPrevented).toBe(false);
    expect(press("+", {}).defaultPrevented).toBe(false);
    expect(setZoom).not.toHaveBeenCalled();
  });

  it("takes one notch of the wheel for one step, and scrolls without Ctrl", () => {
    const { setZoom } = start();
    expect(wheel(-100).defaultPrevented).toBe(true);
    expect(wheel(100).defaultPrevented).toBe(true);
    expect(wheel(100, false).defaultPrevented).toBe(false);
    expect(setZoom.mock.calls).toEqual([[1.1], [1]]);
  });

  it("does not race to the largest size on a touchpad", () => {
    const { setZoom } = start();
    // A pinch or a two-finger scroll: many small turns.
    for (let turn = 0; turn < 30; turn += 1) wheel(-4);
    expect(setZoom.mock.calls).toEqual([[1.1]]);
    // A turn the other way starts again, and does not undo at once.
    wheel(60);
    wheel(-60);
    wheel(60);
    expect(setZoom.mock.calls).toEqual([[1.1]]);
  });

  it("leaves Ctrl with the wheel to the system on a Mac", () => {
    const { setZoom } = start(true);
    expect(wheel(-100).defaultPrevented).toBe(false);
    expect(setZoom).not.toHaveBeenCalled();
  });

  it("stops at its limits", async () => {
    window.localStorage.setItem(KEY, String(LARGEST));
    const { setZoom, zoom } = start();
    await zoom.ready;
    press("+");
    expect(setZoom.mock.calls).toEqual([[LARGEST]]);
  });

  it("ignores a kept size that is not one", () => {
    window.localStorage.setItem(KEY, "enormous");
    expect(start().setZoom).not.toHaveBeenCalled();
  });

  it("carries on when the platform refuses, or nothing can be stored", async () => {
    window.localStorage.setItem(KEY, "1.5");
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("FAKE storage is unavailable");
      });
    onTestFinished(() => set.mockRestore());
    const setZoom = vi.fn().mockRejectedValue(new Error("FAKE not allowed"));
    const zoom = startZoom(setZoom, false);
    onTestFinished(zoom.stop);
    await zoom.ready;
    press("+");
    press("+");
    await Promise.resolve();
    expect(setZoom.mock.calls).toEqual([[1.5], [1.75], [2]]);
  });

  it("handles nothing once it is stopped", () => {
    const setZoom = vi.fn().mockResolvedValue(undefined);
    startZoom(setZoom, false).stop();
    expect(press("+").defaultPrevented).toBe(false);
    expect(wheel(-100).defaultPrevented).toBe(false);
    expect(setZoom).not.toHaveBeenCalled();
  });
});

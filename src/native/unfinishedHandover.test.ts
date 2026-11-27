import { afterEach, describe, expect, it, vi } from "vitest";
import {
  rememberUnfinishedHandover,
  takeUnfinishedHandover,
} from "./unfinishedHandover";

const KEY = "mycarlos.unfinishedHandover.v1";

describe("a handover whose key was shown and not used (#360)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of [KEY, `${KEY}.slot-a`, `${KEY}.slot-b`])
      window.localStorage.removeItem(key);
  });

  it("is told once at the next unlock and then forgotten", () => {
    expect(takeUnfinishedHandover()).toBe(false);

    rememberUnfinishedHandover(true);
    expect(takeUnfinishedHandover()).toBe(true);
    expect(takeUnfinishedHandover()).toBe(false);
  });

  it("is forgotten when the handover finishes", () => {
    rememberUnfinishedHandover(true);
    rememberUnfinishedHandover(false);

    expect(takeUnfinishedHandover()).toBe(false);
  });

  it("is kept per vault, so one vault's note is never told at another's unlock", () => {
    rememberUnfinishedHandover(true, "slot-a");

    expect(takeUnfinishedHandover("slot-b")).toBe(false);
    expect(takeUnfinishedHandover()).toBe(false);
    expect(takeUnfinishedHandover("slot-a")).toBe(true);
    expect(takeUnfinishedHandover("slot-a")).toBe(false);
  });

  it("holds no key and names no person: only a marker", () => {
    rememberUnfinishedHandover(true, "slot-a");

    expect(window.localStorage.getItem(`${KEY}.slot-a`)).toBe("1");
  });

  it("does not fail, and says nothing, where the webview has no storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("FAKE storage refused", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("FAKE storage refused", "QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("FAKE storage refused", "SecurityError");
    });

    expect(() => rememberUnfinishedHandover(true)).not.toThrow();
    expect(() => rememberUnfinishedHandover(false)).not.toThrow();
    expect(takeUnfinishedHandover()).toBe(false);
  });
});

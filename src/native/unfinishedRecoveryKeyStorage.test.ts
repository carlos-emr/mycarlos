import { afterEach, describe, expect, it, vi } from "vitest";
import {
  rememberUnfinishedRecoveryKey,
  takeUnfinishedRecoveryKey,
} from "./unfinishedRecoveryKey";

const KEY = "mycarlos.unfinishedRecoveryKey.v1";

// The note a key setup that was shown and not ended leaves in webview storage, and what is told at
// the next unlock. FAKE values only; it holds when the key was set, never the key.
describe("the note an unfinished recovery key setup leaves", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.removeItem(KEY);
  });

  it("has nothing to say when no setup was left unfinished", () => {
    expect(takeUnfinishedRecoveryKey()).toBeNull();
  });

  it("is told once, with when the key was set and whether it was exposed, then forgotten", () => {
    rememberUnfinishedRecoveryKey({ setAtMs: 1234, exposed: true });

    expect(takeUnfinishedRecoveryKey()).toEqual({
      setAtMs: 1234,
      exposed: true,
    });
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(takeUnfinishedRecoveryKey()).toBeNull();
  });

  it("keeps a first key's note with no time, and leaves 'exposed' out unless it was true", () => {
    rememberUnfinishedRecoveryKey({ setAtMs: null });
    expect(takeUnfinishedRecoveryKey()).toEqual({ setAtMs: null });

    rememberUnfinishedRecoveryKey({ setAtMs: 5, exposed: false });
    expect(takeUnfinishedRecoveryKey()).toEqual({ setAtMs: 5 });
  });

  it("is forgotten when the setup ends", () => {
    rememberUnfinishedRecoveryKey({ setAtMs: 5 });
    rememberUnfinishedRecoveryKey(null);

    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(takeUnfinishedRecoveryKey()).toBeNull();
  });

  it.each([
    ["text that is not JSON", "{not json"],
    ["JSON that is not an object", "7"],
    ["null", "null"],
    [
      "a time that is neither a number nor null",
      JSON.stringify({ setAtMs: "5" }),
    ],
  ])("treats %s as no note, and forgets it", (_, stored) => {
    window.localStorage.setItem(KEY, stored);

    expect(takeUnfinishedRecoveryKey()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
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

    expect(() => rememberUnfinishedRecoveryKey({ setAtMs: 5 })).not.toThrow();
    expect(() => rememberUnfinishedRecoveryKey(null)).not.toThrow();
    expect(takeUnfinishedRecoveryKey()).toBeNull();
  });
});

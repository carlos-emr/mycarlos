import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LANGUAGE_STORAGE_KEY,
  getLanguagePreference,
  getLocale,
  getLocaleOverride,
  rememberLocale,
  setLocaleOverride,
} from "./core";
import type { Locale } from "./types";

// The device's language choice: what is kept, what is refused, and what a blocked store reports.

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  setLocaleOverride(null);
});

describe("the language chosen on this device", () => {
  it("reports the chosen language, and none once the choice is cleared", () => {
    expect(getLocaleOverride()).toBeNull();
    setLocaleOverride("fr");
    expect(getLocaleOverride()).toBe("fr");
    expect(getLocale()).toBe("fr");
    // The page's own language follows it, for the screen reader's voice.
    expect(document.documentElement.lang).toBe("fr");
    setLocaleOverride(null);
    expect(getLocaleOverride()).toBeNull();
  });

  it("refuses a language that is not shipped, in both ways of choosing, and keeps what was chosen", () => {
    setLocaleOverride("de" as Locale);
    expect(getLocaleOverride()).toBeNull();
    rememberLocale("de" as Locale);
    // Nothing was written to the device either.
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
    expect(getLocaleOverride()).toBeNull();
    rememberLocale("pl");
    rememberLocale("de" as Locale);
    expect(getLocaleOverride()).toBe("pl");
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("pl");
    expect(getLanguagePreference()).toEqual({ choice: "pl", error: "" });
  });

  it("keeps the language for this session and says so when the device will not remember it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("FAKE: storage is blocked");
    });
    rememberLocale("es");
    expect(getLocaleOverride()).toBe("es");
    expect(getLanguagePreference()).toEqual({
      choice: "es",
      error: "language.error.notRemembered",
    });
    // Forgetting the choice is the same store: a blocked removal reports the same limit.
    vi.restoreAllMocks();
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("FAKE: storage is blocked");
    });
    rememberLocale(null);
    expect(getLocaleOverride()).toBeNull();
    expect(getLanguagePreference().error).toBe("language.error.notRemembered");
  });
});

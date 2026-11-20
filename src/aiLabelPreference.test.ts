import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_LABEL_STORAGE_KEY,
  aiLabelIsShort,
  anyShortAiLabel,
  rememberShortAiLabel,
  showFullAiLabelAgain,
  subscribeAiLabel,
} from "./aiLabelPreference";

// Synthetic model hashes only.
const MODEL_A = "a".repeat(64);
const MODEL_B = "b".repeat(64);

afterEach(() => {
  vi.restoreAllMocks();
  showFullAiLabelAgain();
  window.localStorage.removeItem(AI_LABEL_STORAGE_KEY);
});

describe("the AI warning's short tag choice (#351)", () => {
  it("is off until chosen, and then on for that tool and model only", () => {
    expect(aiLabelIsShort("summary", MODEL_A)).toBe(false);
    rememberShortAiLabel("summary", MODEL_A);
    expect(aiLabelIsShort("summary", MODEL_A)).toBe(true);
    // Another model, or the other tool, has no choice made: the full sentence returns.
    expect(aiLabelIsShort("summary", MODEL_B)).toBe(false);
    expect(aiLabelIsShort("explain", MODEL_A)).toBe(false);
  });

  it("is cleared for everything by Settings", () => {
    rememberShortAiLabel("summary", MODEL_A);
    rememberShortAiLabel("explain", MODEL_B);
    expect(anyShortAiLabel()).toBe(true);
    showFullAiLabelAgain();
    expect(anyShortAiLabel()).toBe(false);
    expect(aiLabelIsShort("summary", MODEL_A)).toBe(false);
    expect(window.localStorage.getItem(AI_LABEL_STORAGE_KEY)).toBeNull();
  });

  it("names no vault, patient or document in what it stores", () => {
    rememberShortAiLabel("summary", MODEL_A);
    expect(window.localStorage.getItem(AI_LABEL_STORAGE_KEY)).toBe(
      JSON.stringify([`summary:1:${MODEL_A}`]),
    );
  });

  it("tells a listener about each change", () => {
    const listener = vi.fn();
    const stop = subscribeAiLabel(listener);
    rememberShortAiLabel("summary", MODEL_A);
    showFullAiLabelAgain();
    stop();
    rememberShortAiLabel("summary", MODEL_B);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the choice for the session when the storage is blocked, and shows the full sentence when it cannot be read", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    rememberShortAiLabel("summary", MODEL_A);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(aiLabelIsShort("summary", MODEL_A)).toBe(true);
    // Once the storage works again, a clear clears for real.
    vi.restoreAllMocks();
    showFullAiLabelAgain();
    expect(aiLabelIsShort("summary", MODEL_A)).toBe(false);
  });

  it("ignores a stored value that is not a list of names", () => {
    window.localStorage.setItem(AI_LABEL_STORAGE_KEY, '{"summary":true}');
    expect(aiLabelIsShort("summary", MODEL_A)).toBe(false);
    window.localStorage.setItem(AI_LABEL_STORAGE_KEY, "not json");
    expect(aiLabelIsShort("summary", MODEL_A)).toBe(false);
  });
});

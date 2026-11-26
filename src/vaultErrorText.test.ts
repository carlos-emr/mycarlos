import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UiError, deferredText, setLocaleOverride, t } from "./i18n";
import { vaultErrorMessage, vaultErrorNote } from "./vault";

// What a failed vault operation says, for the two shapes that were not yet exercised: an error the
// screen made itself (plain or deferred text), and the note a refusal carries. FAKE values only.

beforeEach(() => setLocaleOverride("en"));
afterEach(() => setLocaleOverride(null));

describe("an error the screen made itself", () => {
  it("says its plain text as it is", () => {
    expect(vaultErrorMessage(new UiError("FAKE: plain refusal"))).toBe(
      "FAKE: plain refusal",
    );
  });

  it("renders deferred text when it is asked for, in the language then in use", () => {
    let language = "first";
    const error = new UiError(deferredText(() => `FAKE ${language}`));
    language = "second";
    expect(vaultErrorMessage(error)).toBe("FAKE second");
  });
});

describe("the note a failure carries", () => {
  it("is none for something that is not an object, or an object without a note", () => {
    expect(vaultErrorNote("a string")).toBeNull();
    expect(vaultErrorNote(null)).toBeNull();
    expect(vaultErrorNote(undefined)).toBeNull();
    expect(vaultErrorNote(42)).toBeNull();
    expect(vaultErrorNote({})).toBeNull();
    expect(vaultErrorNote({ note: 7 })).toBeNull();
  });

  it("is a plain note as it is", () => {
    expect(vaultErrorNote({ note: "FAKE: a plain note" })).toBe(
      "FAKE: a plain note",
    );
  });

  it("is a known note key in the language in use, ahead of a plain note", () => {
    expect(
      vaultErrorNote({ noteKey: "error.fallback", note: "FAKE: ignored" }),
    ).toBe(t("error.fallback"));
  });

  it("ignores a note key the app does not have", () => {
    expect(vaultErrorNote({ noteKey: "no.such.key", note: "FAKE: kept" })).toBe(
      "FAKE: kept",
    );
    expect(vaultErrorNote({ noteKey: "no.such.key" })).toBeNull();
  });
});

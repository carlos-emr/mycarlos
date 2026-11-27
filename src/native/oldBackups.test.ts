import { afterEach, describe, expect, it, vi } from "vitest";
import { readOldBackupsGuide, rememberOldBackupsGuide } from "./oldBackups";

const KEY = "mycarlos.oldBackupsGuide.v1";

describe("where the steps for older backups are kept", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.removeItem(KEY);
  });

  it("has nothing to say until the patient is on a step", () => {
    expect(readOldBackupsGuide()).toBeNull();
  });

  it("remembers the save step and the delete step with the file kept", () => {
    rememberOldBackupsGuide({ step: "save" });
    expect(readOldBackupsGuide()).toEqual({ step: "save" });

    const guide = {
      step: "delete" as const,
      keep: "FAKE backup.mycarlos",
      savedAtMs: 1234,
      bytes: 2048,
    };
    rememberOldBackupsGuide(guide);
    expect(readOldBackupsGuide()).toEqual(guide);
  });

  it("reads a delete step with no named file or size, and a size that is not a number as none", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ step: "delete", keep: null, savedAtMs: 5 }),
    );
    expect(readOldBackupsGuide()).toEqual({
      step: "delete",
      keep: null,
      savedAtMs: 5,
      bytes: null,
    });

    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        step: "delete",
        keep: "FAKE.mycarlos",
        savedAtMs: 5,
        bytes: "big",
      }),
    );
    expect(readOldBackupsGuide()).toMatchObject({ bytes: null });
  });

  it("forgets the steps when told there are none", () => {
    rememberOldBackupsGuide({ step: "save" });
    rememberOldBackupsGuide(null);

    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(readOldBackupsGuide()).toBeNull();
  });

  it.each([
    ["text that is not JSON", "{not json"],
    ["JSON that is not an object", "7"],
    ["null", "null"],
    ["a step it does not know", JSON.stringify({ step: "archive" })],
    [
      "a delete step with a file name that is neither text nor null",
      JSON.stringify({ step: "delete", keep: 3, savedAtMs: 1 }),
    ],
    [
      "a delete step with no time",
      JSON.stringify({ step: "delete", keep: null }),
    ],
  ])("treats %s as no steps at all", (_, stored) => {
    window.localStorage.setItem(KEY, stored);

    expect(readOldBackupsGuide()).toBeNull();
  });

  it("does not fail where the webview has no storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("FAKE storage refused", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("FAKE storage refused", "QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("FAKE storage refused", "SecurityError");
    });

    expect(readOldBackupsGuide()).toBeNull();
    expect(() => rememberOldBackupsGuide({ step: "save" })).not.toThrow();
    expect(() => rememberOldBackupsGuide(null)).not.toThrow();
  });
});

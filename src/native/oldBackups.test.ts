import { afterEach, describe, expect, it } from "vitest";
import { readOldBackupsGuide, rememberOldBackupsGuide } from "./oldBackups";

// The steps for older backups are kept in webview storage, which an iOS backup takes (#422): the
// saved backup's file name, which can carry a person's name, must never be written there.
const KEY = "mycarlos.oldBackupsGuide.v1";

afterEach(() => window.localStorage.removeItem(KEY));

describe("the steps for older backups", () => {
  it("never write the saved file's name into webview storage, and read back without it", () => {
    rememberOldBackupsGuide({
      step: "delete",
      keep: "FAKE-Jamie-Smith-backup.mcbk",
      savedAtMs: 1_700_000_000_000,
      bytes: 4096,
    });
    const raw = window.localStorage.getItem(KEY)!;
    expect(raw).not.toContain("FAKE-Jamie-Smith");
    expect(readOldBackupsGuide()).toEqual({
      step: "delete",
      keep: null,
      savedAtMs: 1_700_000_000_000,
      bytes: 4096,
    });
  });

  it("drop a name an earlier build stored, from the storage too", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        step: "delete",
        keep: "FAKE-Old-Name.mcbk",
        savedAtMs: 5,
        bytes: null,
      }),
    );
    expect(readOldBackupsGuide()).toEqual({
      step: "delete",
      keep: null,
      savedAtMs: 5,
      bytes: null,
    });
    expect(window.localStorage.getItem(KEY)).not.toContain("FAKE-Old-Name");
  });

  it("keep the save step and clearing as they were", () => {
    rememberOldBackupsGuide({ step: "save" });
    expect(readOldBackupsGuide()).toEqual({ step: "save" });
    rememberOldBackupsGuide(null);
    expect(readOldBackupsGuide()).toBeNull();
  });
});

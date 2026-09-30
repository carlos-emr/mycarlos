import { describe, expect, it } from "vitest";
import { OLD_BACKUPS_ADVICE, OLD_BACKUPS_KEEP } from "./oldBackups";
import { unfinishedRecoveryKeyMessage } from "./unfinishedRecoveryKey";

describe("how an unfinished key setup ended", () => {
  it("says what to do with old backups only when a key was replaced", () => {
    const replaced = unfinishedRecoveryKeyMessage({ setAtMs: 5 }, 9, false);
    expect(replaced).toMatch(/^The recovery key you were shown was saved/);
    expect(replaced).toContain(OLD_BACKUPS_ADVICE);
    // A first key replaced nothing, so no backup needs another key.
    const first = unfinishedRecoveryKeyMessage({ setAtMs: null }, 9, false);
    expect(first).toMatch(/^The recovery key you were shown was saved/);
    expect(first).not.toContain(OLD_BACKUPS_ADVICE);
    // A vault opened read-only cannot save a backup: keep the old ones.
    const readOnly = unfinishedRecoveryKeyMessage({ setAtMs: 5 }, 9, true);
    expect(readOnly).toContain(OLD_BACKUPS_KEEP);
    expect(readOnly).not.toContain(OLD_BACKUPS_ADVICE);
    // Not saved: nothing about backups either.
    expect(
      unfinishedRecoveryKeyMessage({ setAtMs: 5 }, 5, false),
    ).not.toContain(OLD_BACKUPS_ADVICE);
  });
});

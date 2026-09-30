import { describe, expect, it } from "vitest";
import { OLD_BACKUPS_ADVICE } from "./oldBackups";
import { unfinishedRecoveryKeyMessage } from "./unfinishedRecoveryKey";

describe("how an unfinished key setup ended", () => {
  it("says what to do with old backups only when a key was replaced", () => {
    const replaced = unfinishedRecoveryKeyMessage({ setAtMs: 5 }, 9);
    expect(replaced).toMatch(/^The recovery key you were shown was saved/);
    expect(replaced).toContain(OLD_BACKUPS_ADVICE);
    // A first key replaced nothing, so no backup needs another key.
    const first = unfinishedRecoveryKeyMessage({ setAtMs: null }, 9);
    expect(first).toMatch(/^The recovery key you were shown was saved/);
    expect(first).not.toContain(OLD_BACKUPS_ADVICE);
    // Not saved: nothing about backups either.
    expect(unfinishedRecoveryKeyMessage({ setAtMs: 5 }, 5)).not.toContain(
      OLD_BACKUPS_ADVICE,
    );
  });
});

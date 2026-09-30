import { describe, expect, it } from "vitest";
import {
  OLD_BACKUPS_EXPOSED,
  OLD_BACKUPS_KEEP,
  OLD_BACKUPS_ROUTINE,
} from "./oldBackups";
import {
  exposedKeyReplaced,
  unfinishedRecoveryKeyMessage,
} from "./unfinishedRecoveryKey";

describe("how an unfinished key setup ended", () => {
  it("says what to do with old backups by why the key was replaced", () => {
    const exposed = unfinishedRecoveryKeyMessage(
      { setAtMs: 5, exposed: true },
      9,
      false,
    );
    expect(exposed).toMatch(/^The recovery key you were shown was saved/);
    expect(exposed).toContain(OLD_BACKUPS_EXPOSED);
    // A routine replacement: nothing to delete.
    const routine = unfinishedRecoveryKeyMessage({ setAtMs: 5 }, 9, false);
    expect(routine).toContain(OLD_BACKUPS_ROUTINE);
    expect(routine).not.toMatch(/delete/i);
    // A vault opened read-only cannot save a backup: keep the old ones.
    const readOnly = unfinishedRecoveryKeyMessage(
      { setAtMs: 5, exposed: true },
      9,
      true,
    );
    expect(readOnly).toContain(OLD_BACKUPS_KEEP);
    expect(readOnly).not.toContain(OLD_BACKUPS_EXPOSED);
  });

  it("says nothing about backups when no key was replaced", () => {
    // A first key replaced nothing.
    const first = unfinishedRecoveryKeyMessage(
      { setAtMs: null, exposed: true },
      9,
      false,
    );
    expect(first).toMatch(/^The recovery key you were shown was saved/);
    expect(first).not.toMatch(/backup/);
    // Not saved.
    expect(
      unfinishedRecoveryKeyMessage({ setAtMs: 5, exposed: true }, 5, false),
    ).not.toMatch(/backup/);
  });

  it("starts the steps for old backups only for a stored replacement of an exposed key", () => {
    expect(exposedKeyReplaced({ setAtMs: 5, exposed: true }, 9)).toBe(true);
    expect(exposedKeyReplaced({ setAtMs: 5 }, 9)).toBe(false);
    expect(exposedKeyReplaced({ setAtMs: 5, exposed: true }, 5)).toBe(false);
    expect(exposedKeyReplaced({ setAtMs: null, exposed: true }, 9)).toBe(false);
  });
});

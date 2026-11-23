import { describe, expect, it } from "vitest";
import {
  REMIND_AFTER_DAYS,
  REMIND_AFTER_DOCUMENTS,
  SNOOZE_DAYS,
  dueBackupReminder,
  readBackupMemory,
  rememberBackup,
  snoozeBackupReminder,
} from "./backupReminder";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 24);

function fakeStorage(initial?: string): Storage {
  const items = new Map<string, string>(
    initial === undefined ? [] : [["mycarlos.backupReminder.v1", initial]],
  );
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

describe("when the backup reminder is due", () => {
  it("is never due for an empty vault", () => {
    expect(dueBackupReminder(0, {}, NOW)).toBeNull();
  });

  it("is due when documents are there and no backup was made", () => {
    expect(dueBackupReminder(1, {}, NOW)).toEqual({ kind: "never" });
  });

  it("is due once the last backup is 30 days old, not before", () => {
    const saved = NOW - REMIND_AFTER_DAYS * DAY;
    expect(
      dueBackupReminder(5, { savedAtMs: saved + 1, documentsThen: 5 }, NOW),
    ).toBeNull();
    expect(
      dueBackupReminder(5, { savedAtMs: saved, documentsThen: 5 }, NOW),
    ).toEqual({ kind: "old", savedAtMs: saved });
  });

  it("is due after 20 new documents, not 19", () => {
    const memory = { savedAtMs: NOW - DAY, documentsThen: 10 };
    expect(
      dueBackupReminder(10 + REMIND_AFTER_DOCUMENTS - 1, memory, NOW),
    ).toBeNull();
    expect(dueBackupReminder(10 + REMIND_AFTER_DOCUMENTS, memory, NOW)).toEqual(
      { kind: "many", added: REMIND_AFTER_DOCUMENTS },
    );
  });

  it("takes other limits when asked", () => {
    const memory = { savedAtMs: NOW - 8 * DAY, documentsThen: 0 };
    expect(
      dueBackupReminder(3, memory, NOW, { days: 7, documents: 99 }),
    ).toEqual({ kind: "old", savedAtMs: memory.savedAtMs });
    expect(
      dueBackupReminder(3, { ...memory, savedAtMs: NOW }, NOW, {
        days: 99,
        documents: 3,
      }),
    ).toEqual({ kind: "many", added: 3 });
  });

  it("does not call a backup dated in the future old", () => {
    expect(
      dueBackupReminder(2, { savedAtMs: NOW + DAY, documentsThen: 2 }, NOW),
    ).toBeNull();
  });

  it("stays away for the snooze, then comes back", () => {
    const snoozedUntilMs = NOW + SNOOZE_DAYS * DAY;
    expect(dueBackupReminder(2, { snoozedUntilMs }, NOW)).toBeNull();
    expect(
      dueBackupReminder(2, { snoozedUntilMs }, snoozedUntilMs - 1),
    ).toBeNull();
    expect(dueBackupReminder(2, { snoozedUntilMs }, snoozedUntilMs)).toEqual({
      kind: "never",
    });
  });
});

describe("what the device remembers", () => {
  it("remembers a backup per vault, and a snooze for 14 days", () => {
    const storage = fakeStorage();
    rememberBackup("vault-a", 12, NOW, storage);
    expect(readBackupMemory("vault-a", storage)).toEqual({
      savedAtMs: NOW,
      documentsThen: 12,
    });
    expect(readBackupMemory("vault-b", storage)).toEqual({});
    snoozeBackupReminder("vault-a", NOW, storage);
    expect(readBackupMemory("vault-a", storage).snoozedUntilMs).toBe(
      NOW + 14 * DAY,
    );
  });

  it("a new backup ends a snooze", () => {
    const storage = fakeStorage();
    snoozeBackupReminder("v", NOW, storage);
    rememberBackup("v", 3, NOW + DAY, storage);
    expect(readBackupMemory("v", storage)).toEqual({
      savedAtMs: NOW + DAY,
      documentsThen: 3,
    });
  });

  it("reads nothing from damaged or foreign storage, and never throws", () => {
    expect(readBackupMemory("v", fakeStorage("not json"))).toEqual({});
    expect(readBackupMemory("v", fakeStorage("[1,2]"))).toEqual({});
    expect(
      readBackupMemory(
        "v",
        fakeStorage(
          JSON.stringify({ v: { savedAtMs: "soon", documentsThen: -4 } }),
        ),
      ),
    ).toEqual({});
    expect(readBackupMemory("v", null)).toEqual({});
    const failing = {
      ...fakeStorage(),
      setItem: () => {
        throw new Error("full");
      },
    } as Storage;
    expect(() => rememberBackup("v", 1, NOW, failing)).not.toThrow();
  });
});

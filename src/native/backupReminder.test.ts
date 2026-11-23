import { describe, expect, it } from "vitest";
import {
  REMIND_AFTER_DAYS,
  REMIND_AFTER_DOCUMENTS,
  SNOOZE_DAYS,
  dayOf,
  dayStartMs,
  dueBackupReminder,
} from "./backupReminder";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 24, 15);
const TODAY = dayOf(NOW);
const dates = (count: number, at = NOW) =>
  Array.from({ length: count }, () => at);

describe("when the backup reminder is due", () => {
  it("is never due for an empty vault", () => {
    expect(dueBackupReminder([], {}, NOW)).toBeNull();
  });

  it("is due when documents are there and no backup was made", () => {
    expect(dueBackupReminder(dates(1), {}, NOW)).toEqual({ kind: "never" });
  });

  it("a backup that left the videos out does not satisfy it", () => {
    expect(dueBackupReminder(dates(1), { partialDay: TODAY }, NOW)).toEqual({
      kind: "partial",
    });
    // A whole one beside it does.
    expect(
      dueBackupReminder(dates(1), { partialDay: TODAY, savedDay: TODAY }, NOW),
    ).toBeNull();
  });

  it("is due once the last whole backup is 30 days old, not before", () => {
    const old = TODAY - REMIND_AFTER_DAYS;
    expect(
      dueBackupReminder(dates(3, dayStartMs(old)), { savedDay: old + 1 }, NOW),
    ).toBeNull();
    expect(
      dueBackupReminder(dates(3, dayStartMs(old)), { savedDay: old }, NOW),
    ).toEqual({
      kind: "old",
      savedDay: old,
    });
  });

  it("is due after 20 documents added after the backup's day, not 19, and not those of the same day", () => {
    const state = { savedDay: TODAY - 1 };
    const later = (count: number) => dates(count, dayStartMs(TODAY));
    expect(
      dueBackupReminder(later(REMIND_AFTER_DOCUMENTS - 1), state, NOW),
    ).toBeNull();
    expect(
      dueBackupReminder(later(REMIND_AFTER_DOCUMENTS), state, NOW),
    ).toEqual({
      kind: "many",
      added: REMIND_AFTER_DOCUMENTS,
    });
    // Twenty documents the day of the backup itself are not "since".
    expect(
      dueBackupReminder(
        dates(REMIND_AFTER_DOCUMENTS, dayStartMs(TODAY - 1) + 3_600_000),
        state,
        NOW,
      ),
    ).toBeNull();
  });

  it("deleting twenty and adding twenty counts twenty, not zero (dates, not a count)", () => {
    const state = { savedDay: TODAY - 2 };
    const replaced = dates(REMIND_AFTER_DOCUMENTS, dayStartMs(TODAY - 1));
    expect(dueBackupReminder(replaced, state, NOW)).toEqual({
      kind: "many",
      added: REMIND_AFTER_DOCUMENTS,
    });
  });

  it("takes other limits when asked", () => {
    const state = { savedDay: TODAY - 8 };
    expect(
      dueBackupReminder(dates(3, NOW - 9 * DAY), state, NOW, {
        days: 7,
        documents: 99,
      }),
    ).toEqual({
      kind: "old",
      savedDay: TODAY - 8,
    });
  });

  it("does not let a clock set back hide it: a backup day in the future is old", () => {
    expect(dueBackupReminder(dates(2), { savedDay: TODAY + 5 }, NOW)).toEqual({
      kind: "old",
      savedDay: TODAY + 5,
    });
  });

  it("stays away for the snooze, then comes back; a snooze longer than the app sets is over", () => {
    const until = TODAY + SNOOZE_DAYS;
    expect(
      dueBackupReminder(dates(2), { snoozedUntilDay: until }, NOW),
    ).toBeNull();
    expect(
      dueBackupReminder(dates(2), { snoozedUntilDay: TODAY }, NOW),
    ).toEqual({ kind: "never" });
    expect(
      dueBackupReminder(dates(2), { snoozedUntilDay: until + 1 }, NOW),
    ).toEqual({ kind: "never" });
  });
});

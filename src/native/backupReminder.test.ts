import { describe, expect, it } from "vitest";
import {
  NEVER_AFTER_DAYS,
  NEVER_AFTER_DOCUMENTS,
  REMIND_AFTER_DAYS,
  REMIND_AFTER_DOCUMENTS,
  SNOOZE_DAYS,
  dayOf,
  dayStartMs,
  dueBackupReminder as dueIn,
  type BackupReminderState,
} from "./backupReminder";

const DAY = 24 * 60 * 60 * 1000;
/** The existing cases count days in UTC, whatever zone the machine running them is in. */
const dueBackupReminder = (
  documentDates: readonly number[],
  state: BackupReminderState,
  nowMs: number,
  after?: { days: number; documents: number },
) => dueIn(documentDates, state, nowMs, after, 0);
const NOW = Date.UTC(2026, 10, 24, 15);
const TODAY = dayOf(NOW);
const dates = (count: number, at = NOW) =>
  Array.from({ length: count }, () => at);

describe("when the backup reminder is due", () => {
  it("is never due for an empty vault", () => {
    expect(dueBackupReminder([], {}, NOW)).toBeNull();
  });

  it("is due when enough documents are there and no backup was made", () => {
    expect(dueBackupReminder(dates(NEVER_AFTER_DOCUMENTS), {}, NOW)).toEqual({
      kind: "never",
    });
  });

  it("does not greet the very first import with a warning: it waits for 3 documents or 7 days", () => {
    expect(dueBackupReminder(dates(1), {}, NOW)).toBeNull();
    expect(
      dueBackupReminder(dates(NEVER_AFTER_DOCUMENTS - 1), {}, NOW),
    ).toBeNull();
    // Three documents, however recent.
    expect(dueBackupReminder(dates(NEVER_AFTER_DOCUMENTS), {}, NOW)).toEqual({
      kind: "never",
    });
    // One document, but the first was added a week ago, not 6 days ago.
    expect(
      dueBackupReminder(dates(1, NOW - (NEVER_AFTER_DAYS - 1) * DAY), {}, NOW),
    ).toBeNull();
    expect(
      dueBackupReminder(dates(1, NOW - NEVER_AFTER_DAYS * DAY), {}, NOW),
    ).toEqual({ kind: "never" });
    // The age is the FIRST document's, not the newest.
    expect(
      dueBackupReminder([NOW - NEVER_AFTER_DAYS * DAY, NOW], {}, NOW),
    ).toEqual({ kind: "never" });
    // A snooze still quiets it, and a backup that left videos out still gets its own note.
    expect(
      dueBackupReminder(dates(5), { snoozedUntilDay: TODAY + 3 }, NOW),
    ).toBeNull();
    expect(dueBackupReminder(dates(1), { partialDay: TODAY }, NOW)).toEqual({
      kind: "partial",
    });
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
      dueBackupReminder(dates(3), { snoozedUntilDay: until }, NOW),
    ).toBeNull();
    expect(
      dueBackupReminder(dates(3), { snoozedUntilDay: TODAY }, NOW),
    ).toEqual({ kind: "never" });
    expect(
      dueBackupReminder(dates(3), { snoozedUntilDay: until + 1 }, NOW),
    ).toEqual({ kind: "never" });
  });
});

describe("days are the patient's own calendar days, not UTC days", () => {
  // The native side stores the backup and snooze days from the local date the page sends, so the
  // page must count today and the documents' days the same way.
  const TORONTO = 300; // Date.getTimezoneOffset(): minutes west of UTC, winter
  const TOKYO = -540;
  // 21:00 on 24 Nov in Toronto is already 25 Nov in UTC.
  const EVENING_WEST = Date.UTC(2026, 10, 25, 2);
  // 05:00 on 25 Nov in Tokyo is still 24 Nov in UTC.
  const MORNING_EAST = Date.UTC(2026, 10, 24, 20);
  const localDay = (year: number, month: number, day: number) =>
    Date.UTC(year, month, day) / DAY;

  it("counts the local day: the same instant is one day earlier west of UTC and one later east of it", () => {
    expect(dayOf(EVENING_WEST, TORONTO)).toBe(localDay(2026, 10, 24));
    expect(dayOf(EVENING_WEST, 0)).toBe(localDay(2026, 10, 25));
    expect(dayOf(MORNING_EAST, TOKYO)).toBe(localDay(2026, 10, 25));
    expect(dayOf(MORNING_EAST, 0)).toBe(localDay(2026, 10, 24));
    // The device's own zone is the default, as the page uses it.
    expect(dayOf(EVENING_WEST)).toBe(
      dayOf(EVENING_WEST, new Date(EVENING_WEST).getTimezoneOffset()),
    );
  });

  it("west of UTC a snooze set in the evening lasts 14 days, not 13", () => {
    const set = dayOf(EVENING_WEST, TORONTO); // what the native side stores from the local date
    const state = { snoozedUntilDay: set + SNOOZE_DAYS };
    const docs = dates(NEVER_AFTER_DOCUMENTS, EVENING_WEST);
    for (const gone of [0, 1, 13]) {
      expect(
        dueIn(docs, state, EVENING_WEST + gone * DAY, undefined, TORONTO),
        `${gone} days later`,
      ).toBeNull();
    }
    expect(
      dueIn(docs, state, EVENING_WEST + 14 * DAY, undefined, TORONTO),
    ).toEqual({ kind: "never" });
  });

  it("east of UTC a backup made this morning is not dated tomorrow, and so is not 'old'", () => {
    const saved = dayOf(MORNING_EAST, TOKYO); // 25 Nov, though it is still 24 Nov in UTC
    const docs = dates(2, MORNING_EAST);
    expect(
      dueIn(docs, { savedDay: saved }, MORNING_EAST, undefined, TOKYO),
    ).toBeNull();
    // The clock-set-back guard still works in local days: dated tomorrow IS old.
    expect(
      dueIn(docs, { savedDay: saved + 1 }, MORNING_EAST, undefined, TOKYO),
    ).toEqual({ kind: "old", savedDay: saved + 1 });
  });

  it("a document's day is its local day: late on the day of the backup is not 'since'", () => {
    // Backed up at 21:00 Toronto on 24 Nov; twenty more documents at 22:00 the same evening are the
    // same local day, though 25 Nov in UTC. The next morning's are 'since'.
    const state = { savedDay: dayOf(EVENING_WEST, TORONTO) };
    const sameEvening = dates(REMIND_AFTER_DOCUMENTS, EVENING_WEST + 3_600_000);
    expect(
      dueIn(sameEvening, state, EVENING_WEST + 7_200_000, undefined, TORONTO),
    ).toBeNull();
    const nextMorning = dates(
      REMIND_AFTER_DOCUMENTS,
      EVENING_WEST + 12 * 3_600_000,
    );
    expect(
      dueIn(
        nextMorning,
        state,
        EVENING_WEST + 13 * 3_600_000,
        undefined,
        TORONTO,
      ),
    ).toEqual({ kind: "many", added: REMIND_AFTER_DOCUMENTS });
  });

  it("the age of the first document is in local days too", () => {
    // Added 22:00 Toronto on 17 Nov (3:00 UTC the 18th); on 24 Nov at 21:00 Toronto that is 7 local days.
    const first = Date.UTC(2026, 10, 18, 3);
    expect(dueIn([first], {}, EVENING_WEST, undefined, TORONTO)).toEqual({
      kind: "never",
    });
    expect(
      dueIn([first + 3_600_000 * 5], {}, EVENING_WEST, undefined, TORONTO),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  applyProgress,
  estimateMinutes,
  initialProgress,
  tickProgress,
  viewOf,
  type ProgressState,
} from "./summaryProgress";

const at = (state: ProgressState, ms: number) => tickProgress(state, ms);

describe("the time left, as the patient reads it", () => {
  it.each([
    [0, 0],
    [1, 0],
    [60, 0],
    [60.5, 2],
    [61, 2],
    [120, 2],
    [121, 3],
    [240, 4],
    [300, 5],
    [301, 10],
    [600, 10],
    [601, 15],
    [900, 15],
    [901, 20],
    [1200, 20],
    [5000, 20],
  ])('rounds %s s up to %s (0 is "less than a minute")', (seconds, minutes) => {
    expect(estimateMinutes(seconds)).toBe(minutes);
  });

  it("says nothing for a number that is not a time", () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, -0.5])
      expect(estimateMinutes(bad)).toBeNaN();
  });
});

describe("the stages and the bar", () => {
  it("starts before the helper's first word, with no number to show", () => {
    expect(viewOf(initialProgress())).toEqual({
      stage: "before",
      percent: null,
      minutesLeft: null,
      slower: false,
      statusSaysSlower: false,
    });
  });

  it("goes reading, writing, checking, with the bar as done over total", () => {
    let state = initialProgress();
    state = applyProgress(
      state,
      { stage: "reading", done: 512, total: 1148 },
      0,
    );
    expect(viewOf(state)).toMatchObject({ stage: "reading", percent: 45 });
    state = applyProgress(
      state,
      { stage: "reading", done: 1148, total: 1148 },
      1,
    );
    expect(viewOf(state)).toMatchObject({ stage: "reading", percent: 100 });
    state = applyProgress(state, { stage: "writing", done: 3, total: 10 }, 2);
    expect(viewOf(state)).toMatchObject({ stage: "writing", percent: 30 });
    state = applyProgress(state, { stage: "checking", done: 0, total: 0 }, 3);
    expect(viewOf(state)).toMatchObject({ stage: "checking", percent: 100 });
  });

  it("never goes back: a late event of an earlier stage, or a smaller count, changes nothing", () => {
    let state = applyProgress(
      initialProgress(),
      { stage: "writing", done: 4, total: 10 },
      0,
    );
    const same = state;
    state = applyProgress(state, { stage: "reading", done: 1, total: 5 }, 1);
    expect(state).toBe(same);
    state = applyProgress(state, { stage: "writing", done: 2, total: 10 }, 2);
    expect(viewOf(state).percent).toBe(40);
    state = applyProgress(state, { stage: "writing", done: 6, total: 10 }, 3);
    expect(viewOf(state).percent).toBe(60);
  });

  it.each([
    ["done above total", { stage: "reading", done: 9, total: 8 }],
    ["a total of zero", { stage: "reading", done: 0, total: 0 }],
    ["a negative count", { stage: "writing", done: -1, total: 10 }],
    ["a count with a fraction", { stage: "writing", done: 1.5, total: 10 }],
    ["not a number", { stage: "writing", done: Number.NaN, total: 10 }],
    ["an unknown stage", { stage: "thinking", done: 1, total: 2 }],
    ["the screen's own stage", { stage: "before", done: 1, total: 2 }],
  ] as const)("ignores %s", (_name, event) => {
    const state = initialProgress();
    expect(applyProgress(state, event as never, 0)).toBe(state);
  });
});

describe("the estimate", () => {
  const reading = { stage: "reading", done: 512, total: 1148 } as const;

  it("shows the first estimate, rounded up, and only ever a smaller one", () => {
    let state = applyProgress(
      initialProgress(),
      { ...reading, estimateSeconds: 100 },
      0,
    );
    expect(viewOf(state).minutesLeft).toBe(2);
    state = applyProgress(state, { ...reading, estimateSeconds: 400 }, 1000);
    expect(viewOf(state).minutesLeft).toBe(2);
    state = applyProgress(state, { ...reading, estimateSeconds: 30 }, 2000);
    expect(viewOf(state).minutesLeft).toBe(0);
    state = applyProgress(state, { ...reading, estimateSeconds: 600 }, 3000);
    expect(viewOf(state).minutesLeft).toBe(0);
  });

  it("shows no time left until the helper gives one, and ignores one that is not a time", () => {
    let state = applyProgress(initialProgress(), reading, 0);
    expect(viewOf(state).minutesLeft).toBeNull();
    state = applyProgress(state, { ...reading, estimateSeconds: -5 }, 1);
    expect(viewOf(state).minutesLeft).toBeNull();
    state = applyProgress(
      state,
      { ...reading, estimateSeconds: Number.NaN },
      2,
    );
    expect(viewOf(state).minutesLeft).toBeNull();
  });

  it("shows none while the app's own checks run", () => {
    let state = applyProgress(
      initialProgress(),
      { ...reading, estimateSeconds: 100 },
      0,
    );
    state = applyProgress(
      state,
      { stage: "checking", done: 0, total: 0, estimateSeconds: 10 },
      1,
    );
    expect(viewOf(state).minutesLeft).toBeNull();
  });

  it('says "taking longer" once the run passes the time shown, and keeps saying it', () => {
    let state = applyProgress(
      initialProgress(),
      { ...reading, estimateSeconds: 100 },
      1000,
    );
    // Shown: 2 minutes, from 1000 ms.
    expect(at(state, 1000 + 120_000).slower).toBe(false);
    state = at(state, 1000 + 120_001);
    expect(viewOf(state)).toMatchObject({
      slower: true,
      minutesLeft: null,
      statusSaysSlower: true,
    });
    // A later, smaller estimate does not bring the number back.
    state = applyProgress(state, { ...reading, estimateSeconds: 30 }, 200_000);
    expect(viewOf(state)).toMatchObject({ slower: true, minutesLeft: null });
    expect(at(state, 900_000)).toBe(state);
  });

  it('gives "less than a minute" a minute', () => {
    let state = applyProgress(
      initialProgress(),
      { ...reading, estimateSeconds: 20 },
      0,
    );
    expect(at(state, 60_000).slower).toBe(false);
    state = at(state, 60_001);
    expect(state.slower).toBe(true);
  });

  it("starts the allowance again when a smaller number is shown", () => {
    let state = applyProgress(
      initialProgress(),
      { ...reading, estimateSeconds: 290 },
      0,
    );
    // 5 minutes shown at 0; at 4 minutes 2 minutes are shown, from then on.
    state = applyProgress(
      state,
      { stage: "writing", done: 5, total: 10, estimateSeconds: 100 },
      240_000,
    );
    expect(viewOf(state).minutesLeft).toBe(2);
    expect(at(state, 240_000 + 120_000).slower).toBe(false);
    expect(at(state, 240_000 + 120_001).slower).toBe(true);
  });

  it('puts "taking longer" in the status only in the stage it appeared in', () => {
    let state = applyProgress(
      initialProgress(),
      { ...reading, estimateSeconds: 100 },
      0,
    );
    state = at(state, 130_000);
    expect(viewOf(state).statusSaysSlower).toBe(true);
    state = applyProgress(
      state,
      { stage: "writing", done: 1, total: 10 },
      131_000,
    );
    expect(viewOf(state)).toMatchObject({
      slower: true,
      statusSaysSlower: false,
      stage: "writing",
    });
  });
});

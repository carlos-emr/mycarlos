import { describe, expect, it } from "vitest";
import {
  ANSWER_CEILING_MINUTES,
  SHOW_FROM_MINUTES,
  summaryMinutes,
  tokensRead,
  usableSpeed,
  wordsPerSecond,
} from "./speedEstimate";

describe("the time a summary may take (#305)", () => {
  const speed = { promptMilliTps: 10_000, answerMilliTps: 2_500 };

  it("counts the instructions, the pages read and the longest summary, rounded up", () => {
    // 750 + 6,000 tokens at 10 a second is 675 s; 600 at 2.5 a second is 240 s: 915 s, 16 min.
    expect(summaryMinutes(6_000, speed)).toBe(16);
    // Nothing to read still costs the instructions and the answer: 315 s, 6 minutes.
    expect(summaryMinutes(0, speed)).toBe(6);
    expect(summaryMinutes(0, speed)).toBeGreaterThanOrEqual(SHOW_FROM_MINUTES);
  });

  it("names the longest one answer may take, for the reader to say it may not finish", () => {
    expect(ANSWER_CEILING_MINUTES).toBe(20);
    // 6,000 tokens at 2 a second to read is far past it.
    expect(
      summaryMinutes(6_000, { promptMilliTps: 2_000, answerMilliTps: 1_000 }),
    ).toBeGreaterThan(ANSWER_CEILING_MINUTES);
  });

  it("is longer on a slower computer, never shorter", () => {
    const slow = { promptMilliTps: 5_000, answerMilliTps: 1_250 };
    expect(summaryMinutes(3_000, slow)).toBeGreaterThan(
      summaryMinutes(3_000, speed),
    );
  });

  it("reads only what the model would read, never more than its room", () => {
    const page = (text: string) => ({ index: 0, text });
    const document = {
      pages: [page("word ".repeat(10_000))],
      pageCount: 1,
      truncated: false,
    } as never;
    expect(
      tokensRead(document, { contextTokens: 8_192, documentTokens: 500 }),
    ).toBe(500);
    expect(
      tokensRead(document, { contextTokens: 8_192, documentTokens: 100_000 }),
    ).toBeGreaterThan(500);
  });

  it("takes only rates in the range the native side measures", () => {
    expect(usableSpeed(speed)).toEqual(speed);
    for (const bad of [
      null,
      "x",
      {},
      { promptMilliTps: 9, answerMilliTps: 2_500 },
      { promptMilliTps: 10_000, answerMilliTps: 5_000_001 },
      { promptMilliTps: "10000", answerMilliTps: 2_500 },
      { promptMilliTps: Number.NaN, answerMilliTps: 2_500 },
    ])
      expect(usableSpeed(bad)).toBeNull();
  });

  it("says words a second with one decimal", () => {
    expect(wordsPerSecond(10_000, "en")).toBe("7.5");
    expect(wordsPerSecond(2_500, "fr")).toBe("1,9");
  });
});

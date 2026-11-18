import { afterEach, describe, expect, it } from "vitest";
import {
  SLOWDOWN_PER_TOKEN,
  deviceRate,
  expectedMinutes,
  readDeviceRate,
  rememberReadRate,
} from "./readRate";

const KEY = "mycarlos.aiReadRate.v1";
// The 11 Nov 2026 run at 6,999 tokens: 503 s to read the prompt.
const MEASURED = { promptTokens: 7000, promptMs: 503000, answerMs: 40000 };

describe("this computer's reading speed (D250)", () => {
  afterEach(() => window.localStorage.removeItem(KEY));

  it("keeps the speed at the start of a prompt, so a longer read grows by the measured shape", () => {
    const rate = deviceRate(MEASURED)!;
    expect(
      rate.msPerToken * (1 + SLOWDOWN_PER_TOKEN * 7000) * 7000,
    ).toBeCloseTo(503000, 0);
    expect(rate.answerSeconds).toBe(40);
    // The same tokens again take the measured time, and the answer's.
    expect(expectedMinutes(7000, rate)).toBe(Math.ceil(543 / 60));
    // Twice the tokens take more than twice the time.
    const once = expectedMinutes(8000, { ...rate, answerSeconds: 0 })!;
    const twice = expectedMinutes(16000, { ...rate, answerSeconds: 0 })!;
    expect(twice).toBeGreaterThan(2 * once);
  });

  it("says no speed for a timing that shows none, and at least a minute", () => {
    expect(deviceRate({ ...MEASURED, promptTokens: 0 })).toBeNull();
    expect(deviceRate({ ...MEASURED, promptMs: 0 })).toBeNull();
    expect(deviceRate({ ...MEASURED, promptMs: Number.NaN })).toBeNull();
    expect(expectedMinutes(1000, null)).toBeNull();
    expect(expectedMinutes(0, deviceRate(MEASURED))).toBeNull();
    expect(expectedMinutes(10, { msPerToken: 0.01, answerSeconds: 0 })).toBe(1);
  });

  it("keeps one speed per model, rounded, and never a document's length", () => {
    expect(readDeviceRate("FAKE-a")).toBeNull();
    rememberReadRate("FAKE-a", MEASURED);
    rememberReadRate("FAKE-b", { ...MEASURED, promptMs: 1_006_000 });
    rememberReadRate("FAKE-a", { ...MEASURED, answerMs: 20_400 });
    const a = readDeviceRate("FAKE-a")!;
    expect(a.answerSeconds).toBe(20);
    expect(a.msPerToken).toBe(
      Math.round(deviceRate(MEASURED)!.msPerToken * 100) / 100,
    );
    expect(readDeviceRate("FAKE-b")!.msPerToken).toBeCloseTo(
      2 * a.msPerToken,
      1,
    );
    const stored = window.localStorage.getItem(KEY)!;
    expect(stored).not.toContain("7000");
    expect(JSON.parse(stored)).toHaveLength(2);
  });

  it("keeps at most eight models, the oldest going first", () => {
    for (let index = 0; index < 10; index += 1)
      rememberReadRate(`FAKE-${index}`, MEASURED);
    expect(readDeviceRate("FAKE-0")).toBeNull();
    expect(readDeviceRate("FAKE-1")).toBeNull();
    expect(readDeviceRate("FAKE-9")).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toHaveLength(8);
  });

  it("reads nothing from storage it cannot understand", () => {
    window.localStorage.setItem(KEY, "not json");
    expect(readDeviceRate("FAKE-a")).toBeNull();
    window.localStorage.setItem(
      KEY,
      JSON.stringify([["FAKE-a", { msPerToken: -1, answerSeconds: 0 }]]),
    );
    expect(readDeviceRate("FAKE-a")).toBeNull();
    // A new speed replaces what could not be read.
    rememberReadRate("FAKE-a", MEASURED);
    expect(readDeviceRate("FAKE-a")).not.toBeNull();
  });
});

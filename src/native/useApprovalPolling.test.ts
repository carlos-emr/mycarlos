import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_DELAYS_MS,
  DEFAULT_WAIT_MS,
  PortalWaits,
  isRateLimited,
  nextCheckDelay,
  timeLeft,
  waitingNow,
  type LiveApproval,
} from "./useApprovalPolling";

// The pure parts of the approval checks: the waits a portal asked for, the backoff and the time a
// request has left. The polling hook itself is exercised through the clinic view's tests.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("PortalWaits", () => {
  it("has no wait until a portal asks for one, and the default wait when it gives no time", () => {
    const waits = new PortalWaits();
    expect(waits.notBefore("FAKE portal")).toBe(0);
    expect(waiting(waits)).toBe(false);
    waits.wait("FAKE portal");
    expect(waiting(waits)).toBe(true);
    vi.advanceTimersByTime(DEFAULT_WAIT_MS - 1);
    expect(waiting(waits)).toBe(true);
    vi.advanceTimersByTime(2);
    expect(waiting(waits)).toBe(false);
  });

  it("takes the time the portal gave, and ignores a time that is not a positive number", () => {
    const waits = new PortalWaits();
    waits.wait("FAKE portal", 5_000);
    vi.advanceTimersByTime(5_001);
    expect(waiting(waits)).toBe(false);
    for (const ms of [0, -5, null, undefined, Number.NaN]) {
      waits.wait("FAKE portal", ms as number | null | undefined);
      expect(
        waits.notBefore("FAKE portal") - performance.now(),
        String(ms),
      ).toBeCloseTo(DEFAULT_WAIT_MS, -1);
      waits.clear();
    }
  });

  it("never shortens a wait the portal already asked for", () => {
    const waits = new PortalWaits();
    waits.wait("FAKE portal", 30_000);
    const first = waits.notBefore("FAKE portal");
    waits.wait("FAKE portal", 1_000);
    expect(waits.notBefore("FAKE portal")).toBe(first);
    waits.wait("FAKE portal", 90_000);
    expect(waits.notBefore("FAKE portal")).toBeGreaterThan(first);
  });

  it("keeps a wait per portal", () => {
    const waits = new PortalWaits();
    waits.wait("FAKE one", 10_000);
    expect(waits.waiting("FAKE one")).toBe(true);
    expect(waits.waiting("FAKE two")).toBe(false);
  });

  it("drops a wait or a removed device asked by a session a lock has ended", () => {
    const waits = new PortalWaits();
    const before = waits.session();
    waits.clear();
    expect(waits.session()).toBe(before + 1);
    waits.wait("FAKE portal", 10_000, before);
    waits.deviceRemoved("FAKE link", before);
    expect(waiting(waits)).toBe(false);
    expect(waits.isRemoved("FAKE link")).toBe(false);
    // The current session's own are kept.
    waits.wait("FAKE portal", 10_000, waits.session());
    waits.deviceRemoved("FAKE link", waits.session());
    expect(waiting(waits)).toBe(true);
    expect(waits.isRemoved("FAKE link")).toBe(true);
  });

  it("forgets every wait and every removed device when cleared", () => {
    const waits = new PortalWaits();
    waits.wait("FAKE portal", 10_000);
    waits.deviceRemoved("FAKE link");
    expect(waits.isRemoved("FAKE link")).toBe(true);
    waits.clear();
    expect(waiting(waits)).toBe(false);
    expect(waits.isRemoved("FAKE link")).toBe(false);
    expect(waits.notBefore("FAKE portal")).toBe(0);
  });
});

function waiting(waits: PortalWaits) {
  return waits.waiting("FAKE portal");
}

describe("the check schedule", () => {
  it("backs off by step and stays at the longest delay", () => {
    expect(CHECK_DELAYS_MS.map((_, step) => nextCheckDelay(step))).toEqual([
      ...CHECK_DELAYS_MS,
    ]);
    expect(nextCheckDelay(CHECK_DELAYS_MS.length)).toBe(CHECK_DELAYS_MS.at(-1));
    expect(nextCheckDelay(1_000)).toBe(CHECK_DELAYS_MS.at(-1));
  });

  it("counts a waiting request's time left by the portal's clock, and has none for any other state", () => {
    const waiting: LiveApproval = {
      kind: "waiting",
      expiresInMs: 60_000,
      at: 1_000,
    };
    expect(timeLeft(waiting, 1_000)).toBe(60_000);
    expect(timeLeft(waiting, 21_000)).toBe(40_000);
    expect(timeLeft(waiting, 70_000)).toBe(-9_000);
    expect(
      timeLeft({ kind: "waiting", expiresInMs: null, at: 1_000 }, 5_000),
    ).toBeNull();
    expect(timeLeft({ kind: "missing" }, 5_000)).toBeNull();
    expect(timeLeft(undefined, 5_000)).toBeNull();
  });

  it("says a request it was just given is waiting, with no time known", () => {
    expect(waitingNow()).toEqual({
      kind: "waiting",
      expiresInMs: null,
      at: expect.any(Number),
    });
  });

  it("recognises the portal's rate-limit refusal by its code only", () => {
    expect(
      isRateLimited({ code: "portal_rate_limited", retryAfterMs: 5 }),
    ).toBe(true);
    expect(isRateLimited({ code: "portal_busy" })).toBe(false);
    expect(isRateLimited(new Error("portal_rate_limited"))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
    expect(isRateLimited("portal_rate_limited")).toBe(false);
  });
});

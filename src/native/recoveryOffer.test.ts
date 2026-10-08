import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  forgetRecoveryOffer,
  recordRecoveryOffer,
  recoveryOfferDue,
} from "./recoveryOffer";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 29, 14, 25);

describe("the recovery key offer", () => {
  beforeEach(() => forgetRecoveryOffer());

  it("is due when it was never made", () => {
    expect(recoveryOfferDue(NOW)).toBe(true);
  });

  it("does not come back within a day, and does after one", () => {
    const MINUTE = 60 * 1000;
    // Offered at each end of an hour, which is all that is kept of it.
    for (const offered of [NOW - 25 * MINUTE, NOW, NOW + 34 * MINUTE]) {
      forgetRecoveryOffer();
      recordRecoveryOffer(offered);
      for (const later of [
        0,
        MINUTE,
        HOUR,
        12 * HOUR,
        23 * HOUR,
        23 * HOUR + 59 * MINUTE,
        24 * HOUR - 1,
      ])
        expect(recoveryOfferDue(offered + later), String(later)).toBe(false);
      for (const later of [26 * HOUR, 48 * HOUR, 7 * 24 * HOUR])
        expect(recoveryOfferDue(offered + later), String(later)).toBe(true);
    }
  });

  it("is never due less than a day after the last one, for any minute of the hour", () => {
    for (let minute = 0; minute < 60; minute += 1) {
      const offered = Date.UTC(2026, 8, 29, 14, minute);
      forgetRecoveryOffer();
      recordRecoveryOffer(offered);
      for (let later = 0; later <= 27 * 60; later += 1) {
        const due = recoveryOfferDue(offered + later * 60 * 1000);
        if (later < 24 * 60) expect(due, `${minute} + ${later}`).toBe(false);
        if (later >= 26 * 60) expect(due, `${minute} + ${later}`).toBe(true);
      }
    }
  });

  it("keeps the hour only, and nothing about the vault", () => {
    // Test files share the page's storage (the zoom level is kept there
    // too): what this adds or changes is checked, not everything there.
    const before: Record<string, string> = { ...window.localStorage };
    recordRecoveryOffer(NOW);
    const after: Record<string, string> = { ...window.localStorage };
    expect(Object.keys(after).filter((key) => !(key in before))).toEqual([
      "mycarlos.recoveryOfferHour.v1",
    ]);
    for (const key of Object.keys(before))
      expect(after[key], key).toBe(before[key]);
    expect(window.localStorage.getItem("mycarlos.recoveryOfferHour.v1")).toBe(
      String(Math.floor(NOW / HOUR)),
    );
  });

  it("still counts an offer after the clock was set back a little", () => {
    recordRecoveryOffer(NOW);
    for (const back of [1000, HOUR, 12 * HOUR])
      expect(recoveryOfferDue(NOW - back), String(back)).toBe(false);
    // Far in the future, the clock was wrong when it was kept.
    expect(recoveryOfferDue(NOW - 48 * HOUR)).toBe(true);
  });

  it("is due when the note is not a time", () => {
    for (const stored of ["", "soon", "-5", "1.5"]) {
      forgetRecoveryOffer();
      window.localStorage.setItem("mycarlos.recoveryOfferHour.v1", stored);
      expect(recoveryOfferDue(NOW), stored).toBe(true);
    }
  });

  it("is remembered for this run when nothing can be stored", () => {
    const blocked = () => {
      throw new Error("FAKE storage is unavailable");
    };
    const get = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(blocked);
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(blocked);
    onTestFinished(() => {
      get.mockRestore();
      set.mockRestore();
    });
    expect(recoveryOfferDue(NOW)).toBe(true);
    recordRecoveryOffer(NOW);
    expect(recoveryOfferDue(NOW + HOUR)).toBe(false);
    expect(recoveryOfferDue(NOW + 26 * HOUR)).toBe(true);
  });

  it("goes by this run when an earlier offer is stored and the new one cannot be", () => {
    recordRecoveryOffer(NOW - 72 * HOUR);
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("FAKE storage is full");
      });
    onTestFinished(() => set.mockRestore());
    expect(recoveryOfferDue(NOW)).toBe(true);
    recordRecoveryOffer(NOW);
    expect(recoveryOfferDue(NOW + HOUR)).toBe(false);
  });
});

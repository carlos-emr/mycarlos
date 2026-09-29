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
    recordRecoveryOffer(NOW);
    for (const later of [0, 1, 60 * 1000, HOUR, 12 * HOUR, 23 * HOUR])
      expect(recoveryOfferDue(NOW + later), String(later)).toBe(false);
    for (const later of [24 * HOUR, 25 * HOUR, 7 * 24 * HOUR])
      expect(recoveryOfferDue(NOW + later), String(later)).toBe(true);
  });

  it("keeps the hour only, and nothing about the vault", () => {
    recordRecoveryOffer(NOW);
    expect(Object.keys(window.localStorage)).toEqual([
      "mycarlos.recoveryOfferHour.v1",
    ]);
    expect(window.localStorage.getItem("mycarlos.recoveryOfferHour.v1")).toBe(
      String(Math.floor(NOW / HOUR)),
    );
  });

  it("is due again when the clock was set back, or the note is not a time", () => {
    recordRecoveryOffer(NOW);
    expect(recoveryOfferDue(NOW - 48 * HOUR)).toBe(true);
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
    expect(recoveryOfferDue(NOW + 24 * HOUR)).toBe(true);
  });
});

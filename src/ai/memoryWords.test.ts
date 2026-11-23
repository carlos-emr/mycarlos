import { describe, expect, it } from "vitest";
import { gigabytes, memoryShortfall } from "./memoryWords";

describe("the memory refusal's numbers (#305)", () => {
  it("reads what the native side sent, and nothing else", () => {
    expect(
      memoryShortfall({ memory: { neededBytes: 5, availableBytes: 2 } }),
    ).toEqual({ needed: 5, available: 2 });
    expect(memoryShortfall({ memory: { neededBytes: 5 } })).toEqual({
      needed: 5,
      available: null,
    });
    for (const bad of [
      null,
      "x",
      {},
      { memory: null },
      { memory: { neededBytes: "5" } },
      { memory: { neededBytes: -1 } },
      { memory: { neededBytes: Number.NaN } },
      { memory: { neededBytes: Infinity } },
    ])
      expect(memoryShortfall(bad)).toBeNull();
    // A free amount that is not a number is "could not say", not zero.
    expect(
      memoryShortfall({ memory: { neededBytes: 5, availableBytes: "2" } })
        ?.available,
    ).toBeNull();
  });

  it("rounds the need up and the free amount down, to one decimal", () => {
    expect(gigabytes(3_600_000_001, "up")).toBe("3.7 GB");
    expect(gigabytes(3_600_000_000, "up")).toBe("3.6 GB");
    expect(gigabytes(1_999_999_999, "down")).toBe("1.9 GB");
    expect(gigabytes(2_000_000_000, "down")).toBe("2.0 GB");
    expect(gigabytes(0, "down")).toBe("0.0 GB");
  });
});

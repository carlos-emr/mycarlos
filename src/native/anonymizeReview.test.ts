import { describe, expect, it } from "vitest";
import type { Removed } from "../deidentify/deidentify";
import { removalCounts } from "./anonymizeReview";

// Synthetic placeholders only.
const part = (kind: Removed["kind"], at: number): Removed => ({
  kind,
  original: "FAKE",
  replacement: "[FAKE]",
  start: at,
  end: at + 1,
  sentStart: at,
  sentEnd: at + 6,
});

describe("removalCounts", () => {
  it("counts each kind, in the order each first appears", () => {
    expect(
      removalCounts([
        part("name", 0),
        part("date", 10),
        part("name", 20),
        part("phone", 30),
        part("name", 40),
        part("date", 50),
      ]),
    ).toEqual([
      { kind: "name", count: 3 },
      { kind: "date", count: 2 },
      { kind: "phone", count: 1 },
    ]);
  });

  it("is empty when nothing was removed", () => {
    expect(removalCounts([])).toEqual([]);
  });
});

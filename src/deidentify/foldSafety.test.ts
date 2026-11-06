import { describe, expect, it } from "vitest";
import { FOLD_HAZARDS, foldHazardsIn } from "./deidentify";

// The rules are folded at load, as the matching copy is. A character whose fold changes the
// pattern's meaning would silently change what a rule removes (#252: "[-–—]" folded to the
// range "[--—]", which holds every letter).
describe("the rules mean the same once folded", () => {
  it("has no rule or date form that folding would change", () => {
    expect(FOLD_HAZARDS, FOLD_HAZARDS.join("\n")).toEqual([]);
  });

  it.each([
    ["[ \\t]+[-–—]", 1],
    ["[^–]", 1],
    ["[œ]", 1],
    ["（x）", 2],
  ])("finds a hazard in %j", (source, count) => {
    expect(foldHazardsIn(source)).toHaveLength(count);
  });

  it.each(["(?:-|–|—)", "[(（]", "[ \\t：]", "a\\–b", "[a-z]", "sœur"])(
    "finds none in %j",
    (source) => {
      expect(foldHazardsIn(source)).toEqual([]);
    },
  );
});

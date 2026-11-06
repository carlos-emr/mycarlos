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
    ["[À-ÿ]", 1],
    // Combining accents fold away, so a class of them never matches the folded text.
    ["[\\u0300-\\u036f]", 3],
    ["[a-é]", 1],
    ["\\u00e9t\\u00e9", 2],
    ["\\u{e9}", 1],
    ["\\xe9", 1],
  ])("finds a hazard in %j", (source, count) => {
    expect(foldHazardsIn(source)).toHaveLength(count);
  });

  it.each([
    "(?:-|–|—)",
    "[(（]",
    "[ \\t：]",
    "a\\–b",
    "[a-z]",
    "sœur",
    "\\u0041",
    "[A-Za-z0-9/.-]",
  ])("finds none in %j", (source) => {
    expect(foldHazardsIn(source)).toEqual([]);
  });
});

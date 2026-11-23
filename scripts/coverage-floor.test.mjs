// The frontend coverage floor is a ratchet: it may be raised and never lowered. This test pins the
// lowest values the config may hold; to raise the floor, raise the numbers in
// vitest.coverage.config.ts and the minimums below together (and COVERAGE.md says why). Lowering
// the config without lowering this test fails here, and lowering both shows in review as an
// edit to a file whose only job is to say "not lower".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Main at 0d6b6061 measured 94.50 / 92.28 / 90.94 / 95.95. The first floor is one whole percent
// below those rounded down (a margin for work already in flight); raise it as coverage rises.
const MINIMUM = { statements: 93, branches: 91, functions: 89, lines: 94 };

const config = readFileSync(
  new URL("../vitest.coverage.config.ts", import.meta.url),
  "utf8",
);

function thresholds() {
  const block = /thresholds\s*:\s*\{([^}]*)\}/.exec(config);
  assert.ok(
    block,
    "vitest.coverage.config.ts has no coverage.thresholds block",
  );
  const found = {};
  for (const entry of block[1].matchAll(/(\w+)\s*:\s*([\d.]+)\s*,?/g)) {
    found[entry[1]] = Number(entry[2]);
  }
  return found;
}

test("the coverage thresholds name exactly the four metrics, as numbers", () => {
  assert.deepEqual(
    Object.keys(thresholds()).sort(),
    Object.keys(MINIMUM).sort(),
  );
});

for (const [metric, minimum] of Object.entries(MINIMUM)) {
  test(`the ${metric} floor is not lower than ${minimum} %`, () => {
    const value = thresholds()[metric];
    assert.ok(Number.isFinite(value), `${metric} has no numeric threshold`);
    assert.ok(
      value >= minimum,
      `the ${metric} floor is ${value}, lower than the ratchet ${minimum}: the floor is never lowered`,
    );
    assert.ok(value <= 100, `${metric} cannot be above 100`);
  });
}

test("the floor is not weakened another way", () => {
  assert.doesNotMatch(
    config,
    /autoUpdate/,
    "autoUpdate would let a run rewrite the floor",
  );
  assert.doesNotMatch(
    config,
    /thresholds\s*:\s*\{[^}]*-\d/,
    "a negative threshold means 'allow this many uncovered'",
  );
  assert.match(
    config,
    /enabled\s*:\s*true/,
    "coverage must stay enabled in this config",
  );
  assert.doesNotMatch(
    config,
    /reportOnFailure\s*:\s*true/,
    "keep reportOnFailure off: a failed run is not a measured one",
  );
});

// The frontend coverage floor is a ratchet: it may be raised and never lowered. This test pins the
// lowest values the config may hold; to raise the floor, raise the numbers in
// vitest.coverage.config.ts and the minimums below together (and COVERAGE.md says why). Lowering
// the config without lowering this test fails here, and lowering both shows in review as an
// edit to a file whose only job is to say "not lower".
//
// It also pins what the percentage is measured over (the include and exclude lists) and how the
// script runs, so that a floor cannot be met by measuring less or by overriding a flag.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Ben set the floor to 80 for every metric on 24 Nov 2026 (main at 0d6b6061 measured
// 94.50 / 92.28 / 90.94 / 95.95), leaving headroom for code that is hard to test. Raise it when he
// decides to; it is never lowered below these.
const MINIMUM = { statements: 80, branches: 80, functions: 80, lines: 80 };

// What the percentage covers (COVERAGE.md "What the percentage measures"). Widening an exclusion
// is a visible edit to this list, not a quiet one to the config.
const INCLUDE = ["src/**/*.{ts,tsx}"];
const EXCLUDE = [
  "src/**/*.test.{ts,tsx}",
  "src/test/**",
  "src/**/*.d.ts",
  "src/i18n/locales/fluent/keys.ts",
];

// The script CI runs: exactly this, with no `--coverage.*` override flag after it.
const SCRIPT = "vitest run --config vitest.coverage.config.ts";

/** The text with `//` and block comments removed. A quote is honoured, so the `/**` inside a glob
 * string is not taken for a comment, and a commented-out value cannot be read as the real one. */
export function stripComments(text) {
  let out = "";
  let at = 0;
  while (at < text.length) {
    const c = text[at];
    const next = text[at + 1];
    if (c === '"' || c === "'" || c === "`") {
      let end = at + 1;
      while (end < text.length && text[end] !== c) {
        if (text[end] === "\\") end++;
        end++;
      }
      out += text.slice(at, end + 1);
      at = end + 1;
    } else if (c === "/" && next === "/") {
      while (at < text.length && text[at] !== "\n") at++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", at + 2);
      at = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      at++;
    }
  }
  return out;
}

const source = readFileSync(
  new URL("../vitest.coverage.config.ts", import.meta.url),
  "utf8",
);
const config = stripComments(source);

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

function stringList(name) {
  const block = new RegExp(`\\b${name}\\s*:\\s*\\[([^\\]]*)\\]`).exec(config);
  assert.ok(block, `vitest.coverage.config.ts has no ${name} list`);
  return [...block[1].matchAll(/"([^"]*)"/g)].map((entry) => entry[1]);
}

test("a comment is not read as a value, and a glob is not read as a comment", () => {
  assert.equal(stripComments("a // b\nc"), "a \nc");
  assert.equal(stripComments("a /* b */ c"), "a  c");
  assert.equal(stripComments('"src/**/*.ts" // x'), '"src/**/*.ts" ');
  assert.equal(stripComments("'a\\'//b' // c"), "'a\\'//b' ");
  assert.equal(stripComments("a /* never closed"), "a ");
  assert.deepEqual(
    thresholdsFrom(
      "thresholds: { lines: 94, /* lines: 10, */ // lines: 5,\n }",
    ),
    { lines: 94 },
  );
});

function thresholdsFrom(text) {
  const block = /thresholds\s*:\s*\{([^}]*)\}/.exec(stripComments(text));
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
  assert.doesNotMatch(
    config,
    /\bperFile\s*:\s*false/,
    "keep the floor on the whole report",
  );
});

test("what is measured is the include and exclude lists written here", () => {
  assert.deepEqual(stringList("include"), INCLUDE, "coverage.include changed");
  assert.deepEqual(
    stringList("exclude"),
    EXCLUDE,
    "coverage.exclude changed: widening an exclusion lowers what the floor covers",
  );
});

test("the coverage script runs the config with no override flag", () => {
  const scripts = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).scripts;
  assert.equal(
    scripts["test:coverage:frontend"],
    SCRIPT,
    "a --coverage.* flag (or any change) on the script could switch the floor off",
  );
});

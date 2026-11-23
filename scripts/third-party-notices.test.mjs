import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildNotices,
  standardFiles,
  declaredExpression,
  licenceFiles,
  resolveExpression,
  serialize,
} from "./third-party-notices.mjs";

const component = (name, version, license, extra = {}) => ({
  type: "library",
  name,
  version,
  licenses: [{ license: { id: license } }],
  ...extra,
});

/** A package directory holding the named files (FAKE texts). */
function packageWith(files) {
  const directory = mkdtempSync(path.join(tmpdir(), "notices-"));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(directory, name), text);
  }
  return directory;
}

test("an SPDX expression resolves to the licences that apply", () => {
  assert.deepEqual(resolveExpression("MIT").ids, ["MIT"]);
  assert.deepEqual(resolveExpression("MIT OR Apache-2.0").alternatives, [
    ["MIT"],
    ["Apache-2.0"],
  ]);
  assert.deepEqual(resolveExpression("Apache-2.0 OR MIT").ids, ["Apache-2.0"]);
  assert.deepEqual(resolveExpression("MIT/Apache-2.0").ids, ["MIT"]);
  assert.deepEqual(resolveExpression("Apache-2.0 AND MIT").ids, [
    "Apache-2.0",
    "MIT",
  ]);
  assert.deepEqual(resolveExpression("(MIT OR GPL-2.0) AND ISC").ids, [
    "MIT",
    "ISC",
  ]);
  assert.deepEqual(resolveExpression("Apache-2.0 WITH LLVM-exception").ids, [
    "Apache-2.0 WITH LLVM-exception",
  ]);
  assert.deepEqual(resolveExpression("MIT OR GPL-3.0-only").ids, ["MIT"]);
  assert.deepEqual(resolveExpression("Unicode-3.0+").ids, ["Unicode-3.0"]);
});

test("a licence outside the allow-list is refused and named", () => {
  const unknown = resolveExpression("Made-Up-1.0");
  assert.deepEqual(unknown.ids, []);
  assert.match(unknown.problems[0], /outside the allow-list: Made-Up-1\.0/);
});

test("a GPL-family or AGPL dependency is flagged for a maintainer decision, not failed quietly", () => {
  for (const expression of [
    "GPL-3.0-only",
    "AGPL-3.0-or-later",
    "LGPL-2.1-or-later",
    "MIT AND GPL-2.0",
  ]) {
    const { problems } = resolveExpression(expression);
    assert.match(
      problems[0],
      /needs a maintainer decision \(copyleft\)/,
      expression,
    );
  }
});

test("an unreadable expression is refused", () => {
  assert.match(
    resolveExpression("MIT OR").problems[0],
    /unreadable licence expression/,
  );
  assert.match(
    resolveExpression("(MIT").problems[0],
    /unreadable licence expression/,
  );
  assert.match(
    resolveExpression("AND MIT").problems[0],
    /unreadable licence expression/,
  );
});

test("the declared licence is read from an id, a name or an expression", () => {
  assert.equal(declaredExpression(component("a", "1", "MIT")), "MIT");
  assert.equal(
    declaredExpression({ licenses: [{ expression: "MIT OR Apache-2.0" }] }),
    "MIT OR Apache-2.0",
  );
  assert.equal(
    declaredExpression({ licenses: [{ license: { name: "BSD-3-Clause" } }] }),
    "BSD-3-Clause",
  );
  assert.equal(
    declaredExpression({
      licenses: [{ license: { id: "MIT" } }, { license: { id: "ISC" } }],
    }),
    "MIT AND ISC",
  );
  assert.equal(declaredExpression({}), null);
  assert.equal(declaredExpression({ licenses: [] }), null);
});

test("licence and notice files are found at the top of a package, in name order", () => {
  const directory = packageWith({
    "LICENSE-MIT": "FAKE mit text",
    "LICENSE-APACHE": "FAKE apache text",
    NOTICE: "FAKE notice",
    "README.md": "not a licence",
    "licence.txt": "  ",
    "package.json": "{}",
  });
  mkdirSync(path.join(directory, "LICENSES"));
  assert.deepEqual(
    licenceFiles(directory).map((file) => file.name),
    ["LICENSE-APACHE", "LICENSE-MIT", "NOTICE"],
  );
  assert.deepEqual(licenceFiles(path.join(directory, "missing")), []);
  assert.deepEqual(licenceFiles(null), []);
});

test("components become sorted, de-duplicated entries with one shared copy of each text", () => {
  const shared = packageWith({ LICENSE: "FAKE shared licence text" });
  const other = packageWith({ LICENSE: "FAKE other text" });
  const result = buildNotices({
    inventories: [
      {
        ecosystem: "cargo",
        sbom: {
          components: [
            component("zeta", "1.0.0", "MIT"),
            component("alpha", "2.0.0", "MIT"),
          ],
        },
      },
      {
        ecosystem: "npm",
        sbom: { components: [component("mid", "3.1.0", "ISC")] },
      },
    ],
    directoryOf: (_, c) => (c.name === "mid" ? other : shared),
  });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(
    result.document.components.map(
      (entry) => `${entry.ecosystem}:${entry.name}`,
    ),
    ["cargo:alpha", "npm:mid", "cargo:zeta"],
  );
  assert.equal(Object.keys(result.document.texts).length, 2);
  const alpha = result.document.components[0];
  assert.equal(
    result.document.texts[alpha.texts[0].id],
    "FAKE shared licence text",
  );
  assert.equal(alpha.license, "MIT");
});

test("a dev-only npm package and myCarlos itself are not third-party notices", () => {
  const directory = packageWith({ LICENSE: "FAKE text" });
  const dev = component("vitest", "4.0.0", "MIT", {
    properties: [{ name: "cdx:npm:package:development", value: "true" }],
  });
  const result = buildNotices({
    inventories: [
      {
        ecosystem: "npm",
        sbom: {
          components: [
            dev,
            component("react", "19.0.0", "MIT"),
            component("mycarlos", "1", "AGPL-3.0-or-later"),
          ],
        },
      },
    ],
    directoryOf: () => directory,
    selfNames: ["mycarlos"],
  });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(
    result.document.components.map((entry) => entry.name),
    ["react"],
  );
});

test("a scoped npm package keeps its scope in the name", () => {
  const directory = packageWith({ LICENSE: "FAKE text" });
  const result = buildNotices({
    inventories: [
      {
        ecosystem: "npm",
        sbom: {
          components: [
            component("api", "2.0.0", "MIT", { group: "@tauri-apps" }),
          ],
        },
      },
    ],
    directoryOf: () => directory,
  });
  assert.equal(result.document.components[0].name, "@tauri-apps/api");
});

test("the build fails for a missing licence, an unlisted one and a copyleft one, naming each", () => {
  const directory = packageWith({ LICENSE: "FAKE text" });
  const result = buildNotices({
    inventories: [
      {
        ecosystem: "cargo",
        sbom: {
          components: [
            { type: "library", name: "no-licence", version: "1.0.0" },
            component("odd", "1.0.0", "Made-Up-1.0"),
            component("copyleft", "1.0.0", "GPL-3.0-only"),
            component("fine", "1.0.0", "MIT"),
          ],
        },
      },
    ],
    directoryOf: () => directory,
  });
  assert.equal(result.document, null);
  assert.equal(result.problems.length, 3);
  assert.match(
    result.problems[0],
    /cargo no-licence@1\.0\.0: no licence declared/,
  );
  assert.match(
    result.problems[1],
    /cargo odd@1\.0\.0: licence outside the allow-list/,
  );
  assert.match(
    result.problems[2],
    /cargo copyleft@1\.0\.0: needs a maintainer decision/,
  );
});

test("a licence that requires its text fails without one, and passes with a reviewed override", () => {
  const empty = packageWith({ "README.md": "no licence file" });
  const inventories = [
    {
      ecosystem: "cargo",
      sbom: { components: [component("bare", "1.2.3", "MIT")] },
    },
  ];
  const failed = buildNotices({ inventories, directoryOf: () => empty });
  assert.match(
    failed.problems[0],
    /requires its text, and the package has none/,
  );
  const passed = buildNotices({
    inventories,
    directoryOf: () => empty,
    overrides: {
      "bare@1.2.3": [{ name: "LICENSE", text: "FAKE reviewed text" }],
    },
  });
  assert.deepEqual(passed.problems, []);
  assert.equal(Object.values(passed.document.texts)[0], "FAKE reviewed text");
});

test("a licence that needs no text passes with none", () => {
  const empty = packageWith({});
  const result = buildNotices({
    inventories: [
      {
        ecosystem: "cargo",
        sbom: { components: [component("free", "1.0.0", "CC0-1.0")] },
      },
    ],
    directoryOf: () => empty,
  });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.document.components[0].texts, []);
});

test("bundled components are listed with their given texts, and fail without a required one", () => {
  const ok = buildNotices({
    inventories: [],
    directoryOf: () => null,
    extra: [
      {
        name: "llama.cpp",
        version: "1",
        license: "MIT",
        source: "https://example.invalid/llama",
        texts: [{ name: "LICENSE", text: "FAKE ggml text" }],
      },
    ],
  });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.document.components[0].ecosystem, "bundled");
  assert.equal(
    ok.document.components[0].source,
    "https://example.invalid/llama",
  );
  const failed = buildNotices({
    inventories: [],
    directoryOf: () => null,
    extra: [{ name: "font", version: "1", license: "MIT", texts: [] }],
  });
  assert.match(failed.problems[0], /bundled font@1: licence requires its text/);
});

test("the document's bytes are stable and parse back to the same document", () => {
  const directory = packageWith({ LICENSE: 'FAKE "quoted"\ntext' });
  const inventories = [
    {
      ecosystem: "cargo",
      sbom: {
        components: [
          component("b", "1.0.0", "MIT"),
          component("a", "1.0.0", "MIT"),
        ],
      },
    },
  ];
  const first = buildNotices({
    inventories,
    directoryOf: () => directory,
  }).document;
  const second = buildNotices({
    inventories: [
      {
        ecosystem: "cargo",
        sbom: { components: [...inventories[0].sbom.components].reverse() },
      },
    ],
    directoryOf: () => directory,
  }).document;
  assert.equal(serialize(first), serialize(second));
  assert.deepEqual(JSON.parse(serialize(first)), first);
  assert.deepEqual(first.inputs, {});
  assert.ok(serialize(first).endsWith("}\n"));
});

const standardTexts = {
  MIT: "MIT License\n\nCopyright (c) {holder}\n\nFAKE permission text",
  "Apache-2.0": "FAKE Apache License text",
  "BSD-3-Clause": "BSD\n\nCopyright (c) {holder}\n\nFAKE bsd text",
};

test("a package with no licence file gets the standard text, with its authors as the holder, and says so", () => {
  const empty = packageWith({});
  const result = buildNotices({
    inventories: [
      {
        ecosystem: "cargo",
        sbom: { components: [component("bare", "1.0.0", "MIT")] },
      },
    ],
    directoryOf: () => empty,
    standardTexts,
    originOf: () => ({
      holders: ["Jane Roe <jane@example.invalid>", "The Roe Project"],
      repository: "https://example.invalid/bare",
    }),
  });
  assert.deepEqual(result.problems, []);
  const entry = result.document.components[0];
  assert.equal(entry.standardText, true);
  assert.match(
    entry.texts[0].name,
    /MIT \(standard text; the package ships no licence file\)/,
  );
  assert.equal(
    result.document.texts[entry.texts[0].id],
    "MIT License\n\nCopyright (c) Jane Roe, The Roe Project\n\nFAKE permission text",
  );
});

test("with no authors the holder is the package's repository, and with neither it fails", () => {
  const withRepository = standardFiles({
    alternatives: [["MIT"]],
    standardTexts,
    origin: { holders: [], repository: "https://example.invalid/x" },
    name: "x",
  });
  assert.match(
    withRepository[0].text,
    /Copyright \(c\) The x authors \(https:\/\/example\.invalid\/x\)/,
  );
  assert.deepEqual(
    standardFiles({
      alternatives: [["MIT"]],
      standardTexts,
      origin: { holders: [], repository: null },
      name: "x",
    }),
    [],
  );
  // A licence with no standard text on file cannot be filled in either.
  assert.deepEqual(
    standardFiles({
      alternatives: [["ISC"]],
      standardTexts,
      origin: { holders: ["A"], repository: null },
      name: "x",
    }),
    [],
  );
});

test("of a dual licence the alternative that needs no holder's name is shown", () => {
  const files = standardFiles({
    alternatives: [["MIT"], ["Apache-2.0"]],
    standardTexts,
    origin: { holders: [], repository: null },
    name: "x",
  });
  assert.equal(files.length, 1);
  assert.match(files[0].name, /^Apache-2\.0 \(standard text/);
  assert.equal(files[0].text, "FAKE Apache License text");
});

test("a licence file in the package is used rather than a standard text", () => {
  const directory = packageWith({ "LICENSE-MIT": "FAKE own mit text" });
  const result = buildNotices({
    inventories: [
      {
        ecosystem: "cargo",
        sbom: { components: [component("own", "1.0.0", "MIT")] },
      },
    ],
    directoryOf: () => directory,
    standardTexts,
  });
  assert.equal(result.document.components[0].standardText, undefined);
  assert.equal(Object.values(result.document.texts)[0], "FAKE own mit text");
});

test("a COPYRIGHT file counts as a licence file, and CDLA-Permissive-2.0 is allowed", () => {
  const directory = packageWith({
    "COPYRIGHT-RUST.txt": "FAKE copyright text",
  });
  const result = buildNotices({
    inventories: [
      {
        ecosystem: "cargo",
        sbom: {
          components: [
            component("a", "1", "MIT"),
            component("roots", "1", "CDLA-Permissive-2.0"),
          ],
        },
      },
    ],
    directoryOf: () => directory,
  });
  assert.deepEqual(result.problems, []);
});

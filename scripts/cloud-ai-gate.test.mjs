// The cloud AI build gate (#72), tested in both directions with the real compiler: the gate lives in
// its own file (src-tauri/src/cloud_ai/gate.rs, nothing but the gate and the marker), and this test
// compiles that file by itself under each combination of profile and feature.
//
//   release (debug assertions off, or the build.rs `mycarlos_release_profile` cfg)  + feature  -> must NOT compile
//   evaluation / development (debug assertions on), tests                           + feature  -> must compile
//   either profile without the feature                                                         -> must compile
//   the marker `mycarlos-cloud-ai` is in the object code exactly when the feature is on.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const GATE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src-tauri",
  "src",
  "cloud_ai",
  "gate.rs",
);
const HAS_RUSTC = spawnSync("rustc", ["--version"]).status === 0;

/** Compiles the gate file alone; `flags` are rustc flags, `emit` what to produce. */
function compile(flags, emit = "metadata") {
  return mkdtemp(join(tmpdir(), "cloud-ai-gate-")).then(async (dir) => {
    try {
      const result = spawnSync(
        "rustc",
        [
          "--edition",
          "2021",
          "--crate-type",
          "lib",
          "--crate-name",
          "gate",
          `--emit=${emit}`,
          "--out-dir",
          dir,
          "--check-cfg",
          "cfg(mycarlos_release_profile)",
          "--check-cfg",
          'cfg(feature, values("cloud-ai"))',
          ...flags,
          GATE,
        ],
        { encoding: "utf8" },
      );
      const object =
        result.status === 0 && emit === "obj"
          ? await readFile(join(dir, "gate.o"))
          : null;
      return { ok: result.status === 0, stderr: result.stderr, object };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

const FEATURE = ["--cfg", 'feature="cloud-ai"'];
const DEBUG = ["-C", "debug-assertions=yes"];
const RELEASE = ["-C", "debug-assertions=no"];
const RELEASE_PROFILE = ["--cfg", "mycarlos_release_profile"];
const MESSAGE = /evaluation and development builds only/;

test("the gate file exists and holds the gate and the marker", async () => {
  const text = await readFile(GATE, "utf8");
  assert.match(text, /compile_error!/);
  assert.match(text, /mycarlos-cloud-ai/);
});

for (const [name, flags, expectOk] of [
  ["a release build without the feature compiles", [...RELEASE], true],
  ["a debug build without the feature compiles", [...DEBUG], true],
  [
    "a release build with the feature is refused (debug assertions off)",
    [...RELEASE, ...FEATURE],
    false,
  ],
  [
    "a build with the feature under the release-profile cfg is refused even with debug assertions on",
    [...DEBUG, ...RELEASE_PROFILE, ...FEATURE],
    false,
  ],
  [
    "an evaluation or development build (debug profile) with the feature compiles",
    [...DEBUG, ...FEATURE],
    true,
  ],
  [
    "the tests of a release-flagged build with the feature compile (cfg(test) is exempt)",
    ["--test", ...RELEASE, ...FEATURE],
    true,
  ],
]) {
  test(name, { skip: !HAS_RUSTC && "rustc is not installed" }, async () => {
    const built = await compile(flags);
    assert.equal(built.ok, expectOk, built.stderr);
    if (!expectOk) assert.match(built.stderr, MESSAGE);
  });
}

test(
  "the marker is in the object code exactly when the feature is compiled in",
  {
    skip: !HAS_RUSTC && "rustc is not installed",
  },
  async () => {
    const marker = Buffer.from("mycarlos-cloud-ai");
    const on = await compile([...DEBUG, ...FEATURE], "obj");
    assert.ok(on.ok, on.stderr);
    assert.ok(
      on.object.includes(marker),
      "the marker is missing with the feature on",
    );
    const off = await compile([...DEBUG], "obj");
    assert.ok(off.ok, off.stderr);
    assert.ok(
      !off.object.includes(marker),
      "the marker is present with the feature off",
    );
  },
);

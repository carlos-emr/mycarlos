import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hashFile, hashGeneratorInputs } from "./third-party-notices.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extra = JSON.parse(
  readFileSync(
    path.join(root, "scripts/notices/extra-components.json"),
    "utf8",
  ),
);
const notices = JSON.parse(
  readFileSync(
    path.join(root, "src/native/notices/third-party-notices.json"),
    "utf8",
  ),
);

// The committed notices must come from the lock files as they are now. Whoever changes a
// dependency regenerates them (`npm run notices:generate`, after the SBOMs): this fails until then,
// so a library cannot ship without its notice. `npm run notices:check` is the full comparison
// against the CI's CycloneDX inventories.
test("the committed notices were made from the current lock files", () => {
  assert.equal(
    notices.inputs.packageLock,
    hashFile(path.join(root, "package-lock.json")),
    "package-lock.json changed: run `npm run sbom:frontend` and `npm run notices:generate`",
  );
  assert.equal(
    notices.inputs.cargoLock,
    hashFile(path.join(root, "src-tauri/Cargo.lock")),
    "src-tauri/Cargo.lock changed: regenerate the native SBOM and run `npm run notices:generate`",
  );
});

test("the committed notices were made by the current generator, standard texts and extras", () => {
  assert.equal(
    notices.inputs.generator,
    hashGeneratorInputs(root),
    "scripts/third-party-notices.mjs, generate-third-party-notices.mjs or scripts/notices/** changed: run `npm run notices:generate`",
  );
});

test("the AI runtime's build enables only reviewed llama.cpp features, and lists the vendor code they compile in", () => {
  const manifest = readFileSync(
    path.join(root, "src-tauri/Cargo.toml"),
    "utf8",
  );
  const code = manifest
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"));
  const lines = code.filter((line) => /^\s*llama-cpp(-sys)?-2\s*=/.test(line));
  assert.ok(
    lines.length > 0,
    "llama-cpp-2 is declared in src-tauri/Cargo.toml",
  );
  // Features that pull in more vendored third-party code than the reviewed set: each needs its
  // vendor licences in scripts/notices/extra-components.json, then this list updated.
  const unreviewed =
    /\b(mtmd|llguidance|curl|openmp|dynamic-link|system-ggml)\b/;
  for (const line of code) {
    if (!/llama-cpp(-sys)?-2/.test(line)) continue;
    assert.ok(
      !unreviewed.test(line),
      `${line.trim()}: this feature vendors more third-party code. Add the vendor licences, then update this test`,
    );
  }
  const llama = lines.find((line) => /^\s*llama-cpp-2\s*=/.test(line));
  assert.match(
    llama,
    /default-features\s*=\s*false/,
    "llama-cpp-2's default features include openmp and common: add the vendor licences before enabling them",
  );
  // llama-cpp-sys-2's own default is `common`, which compiles llama.cpp's common library and the
  // code below it. Unless that is switched off, its vendor licences must be listed.
  const sys = lines.find((line) => /^\s*llama-cpp-sys-2\s*=/.test(line));
  if (sys && !/default-features\s*=\s*false/.test(sys)) {
    const listed = new Set(extra.map((component) => component.name));
    for (const name of [
      "nlohmann/json",
      "cpp-httplib",
      "subprocess.h",
      "xxHash",
      "rotate-bits",
    ]) {
      assert.ok(
        listed.has(name),
        `${name} is compiled in by llama-cpp-sys-2's common feature: list it`,
      );
    }
  }
});

test("every component's texts exist, and the bundled AI runtime is listed", () => {
  assert.ok(notices.components.length > 50);
  for (const component of notices.components) {
    assert.ok(component.license, `${component.name} has a licence`);
    for (const file of component.texts) {
      assert.ok(notices.texts[file.id], `${component.name}: text ${file.id}`);
    }
  }
  assert.ok(
    notices.components.some(
      (component) => component.name === "llama.cpp and ggml",
    ),
  );
  assert.ok(notices.components.some((component) => component.name === "react"));
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hashFile } from "./third-party-notices.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

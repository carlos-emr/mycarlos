import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RESOURCES_PATH, wire } from "./wire-ios-push-strings.mjs";
import { keysOf, problems } from "./check-ios-push-bundle.mjs";

const PROJECT = `name: myCarlos
options:
  bundleIdPrefix: ca.carlos
targets:
  myCarlos_iOS:
    type: application
    platform: iOS
    sources:
      - path: Sources
      - path: Assets.xcassets
      - path: assets
        buildPhase: resources
        type: folder
    settings:
      base: {}
`;

test("the strings folder is added to the app target's sources as a resource", () => {
  const out = wire(PROJECT);
  assert.match(
    out,
    new RegExp(
      `      - path: Sources\\n      - path: Assets.xcassets\\n      - path: assets\\n        buildPhase: resources\\n        type: folder\\n    settings:`,
    ),
  );
  assert.ok(
    out.includes(
      `      - path: ${RESOURCES_PATH}\n        buildPhase: resources\n`,
    ),
  );
  assert.equal(out.split(RESOURCES_PATH).length, 2);
});

test("wiring twice changes nothing more", () => {
  const once = wire(PROJECT);
  assert.equal(wire(once), once);
});

test("a project with no sources list is refused, not guessed at", () => {
  assert.throws(
    () => wire("name: x\ntargets:\n  a:\n    type: application\n"),
    /no `sources:`/,
  );
  // A `sources:` outside the targets is not the app's.
  assert.throws(
    () => wire("name: x\nsources:\n  - path: A\ntargets:\n  a: {}\n"),
    /no `sources:`/,
  );
  assert.throws(
    () =>
      wire("targets:\n  a:\n    type: application\nsources:\n  - path: A\n"),
    /no `sources:`/,
  );
});

test("the resources path is where the repository keeps them, from gen/apple", () => {
  const strings = path.resolve(
    import.meta.dirname,
    "../src-tauri/gen/apple",
    RESOURCES_PATH,
  );
  assert.equal(
    strings,
    path.resolve(import.meta.dirname, "../src-tauri/ios-push/Resources"),
  );
  assert.ok(fs.existsSync(path.join(strings, "en.lproj/Localizable.strings")));
});

function fakeApp(drop) {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, "../src-tauri/ios-push/strings.json"),
      "utf8",
    ),
  );
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "fake-app-"));
  for (const lang of new Set(Object.values(manifest.locales))) {
    fs.mkdirSync(path.join(app, `${lang}.lproj`));
    fs.writeFileSync(
      path.join(app, `${lang}.lproj/Localizable.strings`),
      manifest.strings.map((s) => `"${s.key}" = "x";`).join("\n"),
    );
  }
  return { app, manifest, lang: manifest.locales.fr, drop };
}

test("a built app with every language's strings has no problems", () => {
  const { app, manifest } = fakeApp();
  assert.deepEqual(problems(app, manifest), []);
  fs.rmSync(app, { recursive: true });
});

test("a missing language file, and a missing key, are each reported", () => {
  const { app, manifest } = fakeApp();
  fs.rmSync(path.join(app, "fr.lproj"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "pl.lproj/Localizable.strings"),
    '"OTHER" = "x";\n',
  );
  const found = problems(app, manifest);
  assert.deepEqual(found.sort(), [
    "fr.lproj/Localizable.strings is not in the app's root",
    "pl.lproj: key MYCARLOS_DOCUMENT_WAITING is missing",
  ]);
  fs.rmSync(app, { recursive: true });
});

test("keys are read from the text form, escapes and a byte-order mark included", () => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "keys-")),
    "L.strings",
  );
  fs.writeFileSync(file, '\uFEFF/* c */\n"A_B" = "x \\"y\\"";\n  "C" = "z";\n');
  assert.deepEqual(keysOf(file), ["A_B", "C"]);
});

test("the portal's loc-key is a key of the strings manifest", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, "../src-tauri/ios-push/strings.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    manifest.strings.map((s) => s.key),
    ["MYCARLOS_DOCUMENT_WAITING"],
  );
});

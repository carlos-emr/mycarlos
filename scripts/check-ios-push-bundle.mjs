#!/usr/bin/env node
// Checks a BUILT iOS app for the iPhone notice's strings: every language's
// <app>/<lang>.lproj/Localizable.strings exists in the app's root and holds every key of
// src-tauri/ios-push/strings.json. Run it on the simulator build's .app (macOS: Xcode compiles
// the files to binary property lists, read here with `plutil`; plain text is read as it is).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(root, "src-tauri/ios-push/strings.json");

/** The keys a Localizable.strings file defines (text form, or a binary plist through plutil). */
export function keysOf(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 6).toString("latin1") === "bplist") {
    const json = execFileSync("plutil", ["-convert", "json", "-o", "-", file]);
    return Object.keys(JSON.parse(json.toString("utf8")));
  }
  const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  return [...text.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*=/gm)].map((m) => m[1]);
}

/** The problems found in `app`, one sentence each; none means the strings are in the bundle. */
export function problems(app, manifest) {
  const found = [];
  for (const lang of new Set(Object.values(manifest.locales))) {
    const file = path.join(app, `${lang}.lproj`, "Localizable.strings");
    if (!fs.existsSync(file)) {
      found.push(`${lang}.lproj/Localizable.strings is not in the app's root`);
      continue;
    }
    const have = new Set(keysOf(file));
    for (const { key } of manifest.strings)
      if (!have.has(key)) found.push(`${lang}.lproj: key ${key} is missing`);
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = process.argv[2];
  if (!app) {
    console.error("usage: check-ios-push-bundle.mjs <path/to/App.app>");
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const found = problems(app, manifest);
  if (found.length) {
    console.error(`iPhone notice strings are not usable in ${app}:`);
    for (const line of found) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log(`iPhone notice strings: present in ${app} for every language.`);
}

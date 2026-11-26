#!/usr/bin/env node
// Puts the iPhone notice's Localizable.strings files into the app's MAIN bundle.
//
// iOS resolves an APNs `loc-key` against the main bundle of the app (<app>/<lang>.lproj/
// Localizable.strings); a SwiftPM plugin's resource bundle, or Tauri's `assets` folder, is not
// searched, and the phone would show the raw key. `tauri ios init` writes gen/apple/project.yml
// (XcodeGen) and does not know about src-tauri/ios-push/Resources, so this adds that folder as a
// source of the app target with `buildPhase: resources`; XcodeGen groups the `<lang>.lproj`
// folders as localized resources and Xcode copies them to the app's root.
//
// Usage: node scripts/wire-ios-push-strings.mjs [path/to/project.yml]   (run after `tauri ios init`,
// before `tauri ios build`). Idempotent. It fails, rather than guesses, when it cannot find the
// app target's `sources:` list. Whether the result reaches the .app is checked by
// scripts/check-ios-push-bundle.mjs on the built app.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
export const defaultProject = path.join(
  root,
  "src-tauri/gen/apple/project.yml",
);
// project.yml sits in src-tauri/gen/apple, so the resources are two folders up.
export const RESOURCES_PATH = "../../ios-push/Resources";

/** The project.yml text with the strings folder added to the first target's sources. */
export function wire(text) {
  const lines = text.split("\n");
  if (lines.some((l) => l.trim() === `- path: ${RESOURCES_PATH}`)) return text;
  let inTargets = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^targets:\s*$/.test(lines[i])) inTargets = true;
    else if (/^\S/.test(lines[i])) inTargets = false;
    if (!inTargets) continue;
    const sources = /^(\s+)sources:\s*$/.exec(lines[i]);
    if (!sources) continue;
    // The list's own indentation is that of its first item.
    const item = /^(\s*)- /.exec(lines[i + 1] ?? "");
    const pad = item ? item[1] : `${sources[1]}  `;
    lines.splice(
      i + 1,
      0,
      `${pad}- path: ${RESOURCES_PATH}`,
      `${pad}  buildPhase: resources`,
    );
    return lines.join("\n");
  }
  throw new Error(
    "project.yml has no `sources:` list under `targets:`; the iPhone notice strings were not wired",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] ?? defaultProject;
  const before = fs.readFileSync(file, "utf8");
  const after = wire(before);
  if (after !== before) fs.writeFileSync(file, after);
  console.log(
    after === before
      ? `${path.relative(process.cwd(), file)}: already wired`
      : `${path.relative(process.cwd(), file)}: iPhone notice strings wired into the app bundle`,
  );
}

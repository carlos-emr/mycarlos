#!/usr/bin/env node
// Puts the privacy manifest, and the push entitlement, into the Xcode project `tauri ios init`
// generated (#422).
//
//   node scripts/configure-ios-privacy.mjs [--no-generate]
//
// The generated project is XcodeGen's output (`src-tauri/gen/apple/project.yml`), and its app target
// takes everything in the `<name>_iOS` folder as a source, a `.xcprivacy` file as a resource. This
// copies `src-tauri/ios/PrivacyInfo.xcprivacy` there and runs `xcodegen generate` again so the
// project lists it; `--no-generate` only copies (for tests). Whether the manifest then sits at the
// root of the built app is what `check-ios-privacy.mjs --app` verifies: that, not this copy, is the
// proof. Run it once after `tauri ios init`; it is safe to run again.
//
// The push entitlement: remote notices need `aps-environment` in the app's entitlements, and its value
// must match the Apple push service the build's tokens belong to: `development` (sandbox) for a debug
// build, `production` for a release one (TestFlight and the store). This writes one entitlements file
// per configuration beside the generated one (`<name>_iOS.Debug.entitlements` and `.Release.entitlements`,
// the generated file's own entries kept), a spec fragment `project.carlos.yml` that points each
// configuration's `CODE_SIGN_ENTITLEMENTS` at its file, and an `include:` of that fragment in
// `project.yml` (XcodeGen merges an included spec into the including one). Whether the built app
// really carries the right value is what `check-ios-privacy.mjs --app X.app --build debug|release`
// verifies.
import { spawnSync } from "node:child_process";
import { copyFile, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { APS_ENVIRONMENT } from "./check-ios-privacy.mjs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The one `<name>_iOS` folder of the generated project, or an error naming what was found. */
export async function appFolder(appleDirectory) {
  const info = await stat(appleDirectory).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(
      `${appleDirectory} not found: run \`tauri ios init\` first`,
    );
  }
  const found = (await readdir(appleDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("_iOS"))
    .map((entry) => entry.name);
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one *_iOS folder in ${appleDirectory}, found ${found.length}: ${found.join(", ") || "none"}`,
    );
  }
  return join(appleDirectory, found[0]);
}

const EMPTY_ENTITLEMENTS =
  '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict/>\n</plist>\n';

/** `plist` (an entitlements file's text) with `aps-environment` set to `value`, its other entries kept. */
export function withApsEnvironment(plist, value) {
  const entry = `<key>aps-environment</key>\n\t<string>${value}</string>`;
  const present = /<key>aps-environment<\/key>\s*<string>[^<]*<\/string>/;
  if (present.test(plist)) return plist.replace(present, entry);
  if (/<dict\s*\/>/.test(plist)) {
    return plist.replace(/<dict\s*\/>/, `<dict>\n\t${entry}\n</dict>`);
  }
  if (/<dict>/.test(plist)) {
    return plist.replace(/<dict>/, `<dict>\n\t${entry}`);
  }
  throw new Error("the generated entitlements file has no dictionary");
}

/** `project.yml` text with `include: [fragment]`, once, whatever it included before. */
export function withInclude(spec, fragment) {
  if (spec.includes(fragment)) return spec;
  const list = /^include:[ \t]*\n((?:[ \t]+-[^\n]*\n)+)/m.exec(spec);
  if (list) {
    const at = list.index + list[0].length;
    return `${spec.slice(0, at)}  - ${fragment}\n${spec.slice(at)}`;
  }
  if (/^include:/m.test(spec)) {
    throw new Error("project.yml has an include in a form this does not edit");
  }
  return `include:\n  - ${fragment}\n${spec}`;
}

/**
 * One entitlements file per configuration next to the generated one, the fragment that points each
 * configuration at its file, and the include of that fragment in `project.yml`.
 */
async function configurePushEntitlement(apple, folder) {
  const name = basename(folder);
  const generated = join(folder, `${name}.entitlements`);
  const base = await readFile(generated, "utf8").catch(
    () => EMPTY_ENTITLEMENTS,
  );
  for (const [build, label] of [
    ["debug", "Debug"],
    ["release", "Release"],
  ]) {
    await writeFile(
      join(folder, `${name}.${label}.entitlements`),
      withApsEnvironment(base, APS_ENVIRONMENT[build]),
    );
  }
  const fragment = "project.carlos.yml";
  await writeFile(
    join(apple, fragment),
    `# Written by scripts/configure-ios-privacy.mjs: each configuration signs with its own push environment.
targets:
  ${name}:
    settings:
      configs:
        debug:
          CODE_SIGN_ENTITLEMENTS: ${name}/${name}.Debug.entitlements
        release:
          CODE_SIGN_ENTITLEMENTS: ${name}/${name}.Release.entitlements
`,
  );
  const spec = join(apple, "project.yml");
  const text = await readFile(spec, "utf8").catch(() => null);
  if (text === null) {
    throw new Error(`${spec} not found: run \`tauri ios init\` first`);
  }
  await writeFile(spec, withInclude(text, fragment));
}

export async function configureIosPrivacy({
  root = ROOT,
  generate = true,
} = {}) {
  const apple = join(root, "src-tauri/gen/apple");
  const target = join(await appFolder(apple), "PrivacyInfo.xcprivacy");
  await copyFile(join(root, "src-tauri/ios/PrivacyInfo.xcprivacy"), target);
  await configurePushEntitlement(apple, await appFolder(apple));
  if (generate) {
    const result = spawnSync(
      "xcodegen",
      ["generate", "--spec", "project.yml"],
      {
        cwd: apple,
        stdio: "inherit",
      },
    );
    if (result.status !== 0) {
      throw new Error(
        "`xcodegen generate` failed or xcodegen is not installed (macOS only)",
      );
    }
  }
  return target;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const target = await configureIosPrivacy({
      generate: !process.argv.includes("--no-generate"),
    });
    console.log(`Privacy manifest copied to ${target}`);
  } catch (error) {
    console.error(`iOS privacy: ${error.message}`);
    process.exit(1);
  }
}

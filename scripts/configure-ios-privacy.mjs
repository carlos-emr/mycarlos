#!/usr/bin/env node
// Puts the privacy manifest into the Xcode project `tauri ios init` generated (#422).
//
//   node scripts/configure-ios-privacy.mjs [--no-generate]
//
// The generated project is XcodeGen's output (`src-tauri/gen/apple/project.yml`), and its app target
// takes everything in the `<name>_iOS` folder as a source, a `.xcprivacy` file as a resource. This
// copies `src-tauri/ios/PrivacyInfo.xcprivacy` there and runs `xcodegen generate` again so the
// project lists it; `--no-generate` only copies (for tests). Whether the manifest then sits at the
// root of the built app is what `check-ios-privacy.mjs --app` verifies: that, not this copy, is the
// proof. Run it once after `tauri ios init`; it is safe to run again.
import { spawnSync } from "node:child_process";
import { copyFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
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

export async function configureIosPrivacy({
  root = ROOT,
  generate = true,
} = {}) {
  const apple = join(root, "src-tauri/gen/apple");
  const target = join(await appFolder(apple), "PrivacyInfo.xcprivacy");
  await copyFile(join(root, "src-tauri/ios/PrivacyInfo.xcprivacy"), target);
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

#!/usr/bin/env node
// Pins the Android build settings Google Play checks for a release (#422).
//
//   node scripts/check-android-release-settings.mjs                 source files only
//   node scripts/check-android-release-settings.mjs --generated     also the project `tauri android init` wrote
//   node scripts/check-android-release-settings.mjs --ndk <dir>     also that NDK's major version
//
// Why each number:
// - targetSdk 36: new apps and updates must target API 36 (Android 16) from 31 Aug 2026.
//   The Tauri CLI writes it into the generated `app/build.gradle.kts`; this fails the build if a
//   Tauri upgrade ever writes anything lower, instead of finding out at upload.
// - compileSdk 36: the SDK the target is compiled against. Also the plugin library's.
// - minSdk 24 (Android 7.0): the supported floor, set in `tauri.conf.json` `bundle.android`, which is
//   the one place the generated app reads it, and the same as the first-party plugin library and the
//   `aarch64-linux-android24` linker the CI compile check uses. Raising it is a product decision
//   (PRODUCT_DECISIONS.md); change it here, in the plugin and in the workflow together, and this
//   script says which one was missed.
// - NDK r28+: its linker aligns native libraries to 16 KB pages by default (see
//   scripts/check-android-page-alignment.mjs for the check on the built files).
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TARGET_SDK = 36;
export const COMPILE_SDK = 36;
export const MIN_SDK = 24;
export const MIN_NDK_MAJOR = 28;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The number a Gradle Kotlin DSL line `name = 36` (or `name 36`) sets, or null. */
export function gradleNumber(source, name) {
  const found = new RegExp(
    `^\\s*${name}\\s*=?\\s*(\\d+)\\s*(?://.*)?$`,
    "m",
  ).exec(source);
  return found ? Number(found[1]) : null;
}

/** Problems with the Tauri configuration's Android section (empty when it is as pinned). */
export function checkTauriConfig(config) {
  const problems = [];
  const min = config?.bundle?.android?.minSdkVersion;
  if (min !== MIN_SDK) {
    problems.push(
      `tauri.conf.json bundle.android.minSdkVersion is ${min ?? "missing"}; it must be ${MIN_SDK}`,
    );
  }
  return problems;
}

/** Problems with the first-party plugin library's Gradle file. */
export function checkPluginGradle(source, name = "android-pdf") {
  const problems = [];
  const compile = gradleNumber(source, "compileSdk");
  if (compile !== COMPILE_SDK) {
    problems.push(
      `${name} compileSdk is ${compile ?? "missing"}; it must be ${COMPILE_SDK}`,
    );
  }
  const min = gradleNumber(source, "minSdk");
  if (min !== MIN_SDK) {
    problems.push(
      `${name} minSdk is ${min ?? "missing"}; it must be ${MIN_SDK}`,
    );
  }
  return problems;
}

/** Problems with the generated app module (`app/build.gradle.kts` after `tauri android init`). */
export function checkGeneratedApp(source) {
  const problems = [];
  const target = gradleNumber(source, "targetSdk");
  if (target !== TARGET_SDK) {
    problems.push(
      `generated app targetSdk is ${target ?? "missing"}; it must be ${TARGET_SDK}`,
    );
  }
  const compile = gradleNumber(source, "compileSdk");
  if (compile === null || compile < COMPILE_SDK) {
    problems.push(
      `generated app compileSdk is ${compile ?? "missing"}; it must be at least ${COMPILE_SDK}`,
    );
  }
  const min = gradleNumber(source, "minSdk");
  if (min !== MIN_SDK) {
    problems.push(
      `generated app minSdk is ${min ?? "missing"}; it must be ${MIN_SDK}`,
    );
  }
  return problems;
}

/** Problems with an NDK's `source.properties` (the major version of `Pkg.Revision`). */
export function checkNdkProperties(source) {
  const found = /^Pkg\.Revision\s*=\s*(\d+)\./m.exec(source);
  if (!found) return ["the NDK's source.properties has no Pkg.Revision"];
  const major = Number(found[1]);
  return major >= MIN_NDK_MAJOR
    ? []
    : [
        `the NDK is r${major}; it must be r${MIN_NDK_MAJOR} or newer (16 KB page alignment)`,
      ];
}

async function read(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function run(argv, root = ROOT) {
  const problems = [];
  const tauri = await read(join(root, "src-tauri/tauri.conf.json"));
  if (tauri === null) problems.push("src-tauri/tauri.conf.json not found");
  else problems.push(...checkTauriConfig(JSON.parse(tauri)));
  const plugin = await read(
    join(root, "src-tauri/android-pdf/android/build.gradle.kts"),
  );
  if (plugin === null)
    problems.push("the android-pdf plugin's build.gradle.kts not found");
  else problems.push(...checkPluginGradle(plugin));
  if (argv.includes("--generated")) {
    const app = await read(
      join(root, "src-tauri/gen/android/app/build.gradle.kts"),
    );
    if (app === null) {
      problems.push(
        "src-tauri/gen/android/app/build.gradle.kts not found: run `tauri android init` first",
      );
    } else {
      problems.push(...checkGeneratedApp(app));
    }
  }
  const ndk = argv.indexOf("--ndk");
  if (ndk >= 0) {
    const directory = argv[ndk + 1];
    const properties = directory
      ? await read(join(directory, "source.properties"))
      : null;
    if (properties === null)
      problems.push(
        "the NDK's source.properties was not found: pass the NDK folder after --ndk",
      );
    else problems.push(...checkNdkProperties(properties));
  }
  return problems;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const problems = await run(process.argv.slice(2));
  if (problems.length) {
    for (const problem of problems)
      console.error(`Android release settings: ${problem}`);
    process.exit(1);
  }
  console.log(
    `Android release settings are as pinned: targetSdk ${TARGET_SDK}, compileSdk ${COMPILE_SDK}, minSdk ${MIN_SDK}.`,
  );
}

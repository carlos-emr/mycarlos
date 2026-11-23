#!/usr/bin/env node
// The release safety gate (#422): FAILS a store build that carries something a store build must not.
//
//   node scripts/check-release-safety.mjs --source                the repository's build configuration
//   node scripts/check-release-safety.mjs --android app.aab       an APK or AAB (also --android manifest.xml)
//   node scripts/check-release-safety.mjs --ios myCarlos.ipa      an .ipa, or an unpacked .app folder
//   node scripts/check-release-safety.mjs --dist dist             the frontend build (hot-reload and dev hooks)
//   ... --app-id ca.example.app                                   another application / bundle id
//
// Any number of the modes may be given at once; the exit code is 1 if any finds anything, and a thing it
// cannot read is a finding (it fails closed). What it refuses:
//   - the model helper stub (ai-helper-stub), the cloud AI send (cloud-ai) and tauri's devtools feature,
//     in the Cargo defaults, the release build commands, or (by marker) the built native code;
//   - dev or hot-reload hooks and dev server addresses in the frontend build and in native code;
//   - a debug build (android:debuggable, android:testOnly, iOS get-task-allow, a development or ad-hoc
//     provisioning profile, aps-environment development);
//   - cleartext traffic (android:usesCleartextTraffic, a network security config that permits it, iOS App
//     Transport Security's arbitrary loads, local networking or insecure HTTP exceptions);
//   - a wrong applicationId / bundle id (and an android:allowBackup that is not false).
// See docs in the PR for what each check rests on and what needs a first real build to confirm.
import { readFile, readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkAndroidArchive,
  checkAndroidManifest,
  checkBuildCommands,
  checkCargoToml,
  checkFrontendFile,
  checkIosApp,
  checkTauriConfig,
  iosFilesFromIpa,
} from "./release-safety/checks.mjs";
import { decodePlainXml } from "./release-safety/android-xml.mjs";

/** The application id and bundle id of the store build. Changing it is a decision: edit it here and in tauri.conf.json together. */
export const EXPECTED_APP_ID = "ca.carlos.mycarlos";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function maybe(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function plutil(bytes) {
  const converted = spawnSync("plutil", ["-convert", "xml1", "-o", "-", "-"], {
    input: bytes,
    encoding: "utf8",
  });
  return converted.status === 0 ? converted.stdout : null;
}

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

async function checkSource(root, appId) {
  const problems = [];
  const cargo = await maybe(join(root, "src-tauri/Cargo.toml"));
  if (cargo === null) problems.push("src-tauri/Cargo.toml not found");
  else problems.push(...checkCargoToml(cargo));
  const tauri = await maybe(join(root, "src-tauri/tauri.conf.json"));
  if (tauri === null) problems.push("src-tauri/tauri.conf.json not found");
  else problems.push(...checkTauriConfig(tauri, appId));
  // The commands a release is built with: the release script, the package scripts that name it, and
  // any release workflow in the tree.
  const commandFiles = ["scripts/build-android-release.sh", "package.json"];
  const workflows = join(root, ".github/workflows");
  try {
    for (const entry of await readdir(workflows)) {
      if (/release/i.test(entry))
        commandFiles.push(`.github/workflows/${entry}`);
    }
  } catch {
    // No workflows folder: nothing to read.
  }
  for (const name of commandFiles) {
    const text = await maybe(join(root, name));
    if (text === null) continue;
    if (name === "package.json") {
      const scripts = JSON.parse(text).scripts ?? {};
      for (const [script, command] of Object.entries(scripts)) {
        if (/android:release|ios.*release|release/i.test(script))
          problems.push(
            ...checkBuildCommands(command, `package.json script ${script}`),
          );
      }
    } else problems.push(...checkBuildCommands(text, name));
  }
  return problems;
}

/** The addresses the app's own configuration embeds in every build (see `checkBinary`). */
async function embeddedUrls(root) {
  const text = await maybe(join(root, "src-tauri/tauri.conf.json"));
  try {
    const devUrl = JSON.parse(text).build?.devUrl;
    return typeof devUrl === "string" ? [devUrl.replace(/\/$/, "")] : [];
  } catch {
    return [];
  }
}

async function checkAndroid(path, appId, options) {
  const bytes = await readFile(path);
  if (path.endsWith(".xml")) {
    return checkAndroidManifest(
      decodePlainXml(bytes.toString("utf8")),
      appId,
    ).map((problem) => `${path}: ${problem}`);
  }
  return checkAndroidArchive(bytes, path, appId, options);
}

async function checkIos(path, appId, options) {
  const info = await stat(path);
  let map;
  if (info.isDirectory()) {
    map = new Map();
    for (const name of await readdir(path)) {
      const full = join(path, name);
      if ((await stat(full)).isFile()) map.set(name, await readFile(full));
    }
  } else {
    map = iosFilesFromIpa(await readFile(path));
    if (map === null) return [`${path}: no Payload/*.app (not an IPA?)`];
  }
  return checkIosApp(map, path, appId, plutil, options);
}

async function checkDist(directory) {
  const problems = [];
  let count = 0;
  for await (const file of files(directory)) {
    if (!/\.(js|mjs|html|css|map)$/.test(file)) continue;
    count++;
    problems.push(...checkFrontendFile(await readFile(file, "utf8"), file));
  }
  if (count === 0) problems.push(`${directory}: no frontend files found`);
  return problems;
}

export async function run(argv, root = ROOT) {
  const problems = [];
  const option = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const appId = option("--app-id") ?? EXPECTED_APP_ID;
  const options = { allowedUrls: await embeddedUrls(root) };
  let ran = 0;
  const attempt = async (what, work) => {
    ran++;
    try {
      problems.push(...(await work()));
    } catch (error) {
      problems.push(`${what}: cannot be inspected (${error.message})`);
    }
  };
  if (argv.includes("--source"))
    await attempt("--source", () => checkSource(root, appId));
  for (const flag of ["--android", "--ios", "--dist"]) {
    for (
      let at = argv.indexOf(flag);
      at >= 0;
      at = argv.indexOf(flag, at + 1)
    ) {
      const target = argv[at + 1];
      if (!target || target.startsWith("--")) {
        problems.push(`${flag} needs a path`);
        continue;
      }
      if (flag === "--android")
        await attempt(target, () => checkAndroid(target, appId, options));
      if (flag === "--ios")
        await attempt(target, () => checkIos(target, appId, options));
      if (flag === "--dist") await attempt(target, () => checkDist(target));
    }
  }
  if (ran === 0)
    problems.push(
      "nothing to check: pass --source, --android, --ios or --dist",
    );
  return problems;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const problems = await run(process.argv.slice(2));
  if (problems.length) {
    for (const problem of problems) console.error(`Release safety: ${problem}`);
    console.error(
      `Release safety: ${problems.length} finding(s); this build is not safe for a store.`,
    );
    process.exit(1);
  }
  console.log("Release safety: nothing found.");
}

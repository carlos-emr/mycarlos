#!/usr/bin/env node
// Checks the iOS privacy and export-compliance files (#422).
//
//   node scripts/check-ios-privacy.mjs                 the repository's files
//   node scripts/check-ios-privacy.mjs --app X.app --build debug|release
//                                                      also a built app: the manifest sits at the
//                                                      bundle root, is the repository's, and the
//                                                      app's Info.plist carries the export key;
//                                                      the app's own signed entitlements carry
//                                                      the push environment for that build
//                                                      (development for a debug build, production
//                                                      for a release one: TestFlight and the store)
//   ... --entitlements FILE                            read the entitlements from FILE (`codesign -d
//                                                      --entitlements :- X.app`) instead of asking
//                                                      `codesign`, which only exists on macOS
//
// Apple refuses an upload whose code reaches a required-reason API with no declared reason
// (ITMS-91053) and, with no `ITSAppUsesNonExemptEncryption`, asks the export questions again at
// every upload. The built-app check exists because the manifest only counts at the root of the
// app bundle, and a Tauri project file that did not pick it up would otherwise ship without it.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = "src-tauri/ios/PrivacyInfo.xcprivacy";
export const INFO_PLIST_PATH = "src-tauri/Info.ios.plist";

/** The categories the manifest must declare, each with the reasons Apple's list allows for it. */
export const REQUIRED_APIS = {
  NSPrivacyAccessedAPICategoryFileTimestamp: [
    "C617.1",
    "0A2A.1",
    "3B52.1",
    "DDA9.1",
  ],
  NSPrivacyAccessedAPICategoryDiskSpace: [
    "E174.1",
    "85F4.1",
    "7D9E.1",
    "B728.1",
  ],
  NSPrivacyAccessedAPICategorySystemBootTime: ["35F9.1", "8FFB.1", "3D61.1"],
  NSPrivacyAccessedAPICategoryUserDefaults: [
    "CA92.1",
    "1C8F.1",
    "C56D.1",
    "AC6B.1",
  ],
};

/**
 * Reasons the manifest must declare (a subset of the allowed ones above): the app's own files
 * (C617.1) and the files the person picked in the document picker (3B52.1: an import reads the
 * size and dates of a picked file). The disk-space reason 85F4.1 (showing disk space to the person)
 * is not declared because no message shows a free-space figure: the app only says "not enough
 * room" (E174.1, a check before writing). Add 85F4.1 here and in the manifest the day a screen
 * shows such a figure.
 */
export const MINIMUM_REASONS = {
  NSPrivacyAccessedAPICategoryFileTimestamp: ["C617.1", "3B52.1"],
  NSPrivacyAccessedAPICategoryDiskSpace: ["E174.1"],
  NSPrivacyAccessedAPICategorySystemBootTime: ["35F9.1"],
  NSPrivacyAccessedAPICategoryUserDefaults: ["CA92.1"],
};

const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, "");

/** The value following `<key>name</key>` as a raw XML fragment (arrays kept whole, nesting counted), or null. */
function valueOf(text, name) {
  const key = new RegExp(`<key>${name}</key>\\s*`).exec(text);
  if (!key) return null;
  const rest = text.slice(key.index + key[0].length);
  const simple = /^(<true\/>|<false\/>|<array\/>|<string>[^<]*<\/string>)/.exec(
    rest,
  );
  if (simple) return simple[1];
  if (!rest.startsWith("<array>")) return null;
  let depth = 0;
  for (const tag of rest.matchAll(/<array>|<\/array>|<array\/>/g)) {
    if (tag[0] === "<array>") depth++;
    else if (tag[0] === "</array>" && --depth === 0) {
      return rest.slice(0, tag.index + tag[0].length);
    }
  }
  return null;
}

/**
 * What the manifest declares today: ONE type, a device identifier the clinic portal keeps, linked
 * to the user, not used for tracking, for App Functionality (Ben's decision: the portal stays on
 * iPhone and is declared). **This is not a complete account of what the clinic's portal receives**:
 * the device's name (typed by the person), delivery and receipt events, the timing and frequency
 * of checks and the internet address also reach it (PRIVACY_NOTICE_DRAFT.md says so). Whether they
 * are "collected" in Apple's sense, when the data goes only to the clinic's own server, which the
 * publisher does not operate or access, is a decision for Ben and counsel (IOS_RELEASE.md, "What
 * the portal receives beyond the declared type"). Anything added or dropped here must change
 * together with the store answers (mycarlos-store-forms-draft) and IOS_RELEASE.md.
 */
export const COLLECTED_DATA = {
  type: "NSPrivacyCollectedDataTypeDeviceID",
  linked: "<true/>",
  tracking: "<false/>",
  purposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
};

function checkCollectedData(text) {
  const block = valueOf(text, "NSPrivacyCollectedDataTypes");
  if (block === null || block === "<array/>") {
    return [
      "NSPrivacyCollectedDataTypes must declare the device identifier the clinic portal keeps",
    ];
  }
  const entries = [...block.matchAll(/<dict>([\s\S]*?)<\/dict>/g)].map(
    (entry) => entry[1],
  );
  if (entries.length !== 1) {
    return [
      `NSPrivacyCollectedDataTypes must hold exactly one type (${COLLECTED_DATA.type}), found ${entries.length}`,
    ];
  }
  const [entry] = entries;
  const problems = [];
  if (
    valueOf(entry, "NSPrivacyCollectedDataType") !==
    `<string>${COLLECTED_DATA.type}</string>`
  ) {
    problems.push(`the collected data type must be ${COLLECTED_DATA.type}`);
  }
  if (
    valueOf(entry, "NSPrivacyCollectedDataTypeLinked") !== COLLECTED_DATA.linked
  ) {
    problems.push(
      "the collected device identifier is linked to the user: NSPrivacyCollectedDataTypeLinked must be true",
    );
  }
  if (
    valueOf(entry, "NSPrivacyCollectedDataTypeTracking") !==
    COLLECTED_DATA.tracking
  ) {
    problems.push("NSPrivacyCollectedDataTypeTracking must be false");
  }
  const purposes = valueOf(entry, "NSPrivacyCollectedDataTypePurposes") ?? "";
  const listed = [...purposes.matchAll(/<string>([^<]*)<\/string>/g)].map(
    (m) => m[1],
  );
  if (JSON.stringify(listed) !== JSON.stringify(COLLECTED_DATA.purposes)) {
    problems.push(
      `the purposes must be exactly ${COLLECTED_DATA.purposes.join(", ")}`,
    );
  }
  return problems;
}

/** Problems with a PrivacyInfo.xcprivacy text (empty when it is as pinned). */
export function checkManifest(source) {
  const text = stripComments(source);
  const problems = [];
  if (!/<plist\b[^>]*>/.test(text) || !/<dict>/.test(text)) {
    return ["the privacy manifest is not a property list"];
  }
  if (valueOf(text, "NSPrivacyTracking") !== "<false/>") {
    problems.push("NSPrivacyTracking must be false");
  }
  if (valueOf(text, "NSPrivacyTrackingDomains") !== "<array/>") {
    problems.push("NSPrivacyTrackingDomains must be empty");
  }
  problems.push(...checkCollectedData(text));
  const declared = new Map();
  for (const entry of text.matchAll(
    /<key>NSPrivacyAccessedAPIType<\/key>\s*<string>([^<]*)<\/string>\s*<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>([\s\S]*?)<\/array>/g,
  )) {
    declared.set(
      entry[1],
      [...entry[2].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]),
    );
  }
  for (const [category, allowed] of Object.entries(REQUIRED_APIS)) {
    const reasons = declared.get(category);
    if (!reasons || reasons.length === 0) {
      problems.push(`${category} is not declared with a reason`);
    } else {
      for (const needed of MINIMUM_REASONS[category] ?? []) {
        if (!reasons.includes(needed)) {
          problems.push(`${category} must declare the reason ${needed}`);
        }
      }
      for (const reason of reasons) {
        if (!allowed.includes(reason)) {
          problems.push(
            `${category} reason ${reason} is not one Apple lists for it`,
          );
        }
      }
    }
  }
  for (const category of declared.keys()) {
    if (!(category in REQUIRED_APIS)) {
      problems.push(
        `${category} is declared but not pinned here: add it to REQUIRED_APIS with Apple's reasons`,
      );
    }
  }
  return problems;
}

/** Problems with an Info.plist text that must carry the export-compliance key. */
export function checkInfoPlist(source) {
  const text = stripComments(source);
  const value = valueOf(text, "ITSAppUsesNonExemptEncryption");
  if (value === null) return ["ITSAppUsesNonExemptEncryption is missing"];
  if (value !== "<true/>" && value !== "<false/>") {
    return ["ITSAppUsesNonExemptEncryption must be true or false"];
  }
  return [];
}

async function read(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The value after `<key>name</key>` where that key sits directly in the plist's top-level dictionary
 * (an entitlement is a top-level key; the same word nested inside another entitlement's value is not
 * one), as a raw XML fragment, or null when there is no such key.
 */
function topLevelValue(text, name) {
  let depth = 0;
  let wanted = false;
  for (const tag of text.matchAll(
    /<(dict|array)\s*\/>|<(dict|array)>|<\/(dict|array)>|<key>([^<]*)<\/key>|<string>[^<]*<\/string>|<(?:true|false)\s*\/>|<(?:integer|real|date|data)>[^<]*<\/(?:integer|real|date|data)>/g,
  )) {
    if (tag[2]) depth++;
    else if (tag[3]) depth--;
    else if (tag[4] !== undefined) wanted = depth === 1 && tag[4] === name;
    if (tag[4] !== undefined) continue;
    // Whatever follows the key is its value.
    if (wanted && !tag[3]) return tag[0];
    wanted = false;
  }
  return null;
}

/**
 * The push environment each build signs with. Apple has two push services, and a token made by one is
 * refused by the other: a debug (development-signed) build must say `development`, a release build
 * (TestFlight and the store) `production`. `scripts/configure-ios-privacy.mjs` writes the two values
 * into the Xcode project; this is the check on what the built app actually carries.
 */
export const APS_ENVIRONMENT = { debug: "development", release: "production" };

/**
 * Problems with the entitlements text of a built app: `aps-environment` must be present, be one of
 * Apple's two values, and (when `build` is given) be the one for that build. Without it the app
 * cannot register for remote notifications at all.
 */
export function checkEntitlements(source, build) {
  const text = stripComments(source);
  const value = topLevelValue(text, "aps-environment");
  if (value === null) {
    return [
      "the aps-environment entitlement is missing (the app cannot register for push notifications)",
    ];
  }
  const found = /^<string>([^<]*)<\/string>$/.exec(value)?.[1];
  if (found !== "development" && found !== "production") {
    return ["aps-environment must be development or production"];
  }
  if (build === undefined) return [];
  const wanted = APS_ENVIRONMENT[build];
  if (wanted === undefined) {
    return [`--build must be debug or release, not ${build}`];
  }
  return found === wanted
    ? []
    : [
        `aps-environment is ${found}, but a ${build} build must carry ${wanted} (a token from the other Apple service is refused)`,
      ];
}

/** A plist as XML text: a binary plist (what Xcode writes) goes through macOS's `plutil`. */
async function readPlist(path) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    return null;
  }
  if (!bytes.subarray(0, 6).equals(Buffer.from("bplist")))
    return bytes.toString("utf8");
  const converted = spawnSync("plutil", ["-convert", "xml1", "-o", "-", path], {
    encoding: "utf8",
  });
  return converted.status === 0 ? converted.stdout : null;
}

/** The entitlements XML of a built app: from `--entitlements FILE`, else from macOS's `codesign`. */
async function readEntitlements(app, file) {
  if (file !== undefined) return await read(file);
  const shown = spawnSync("codesign", ["-d", "--entitlements", ":-", app], {
    encoding: "utf8",
  });
  return shown.status === 0 && shown.stdout.includes("<plist")
    ? shown.stdout
    : null;
}

/** The value after `flag` in `argv`, `undefined` when the flag is absent. */
const optionOf = (argv, flag) => {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : (argv[at + 1] ?? "");
};

export async function run(argv, root = ROOT) {
  const problems = [];
  const manifest = await read(join(root, MANIFEST_PATH));
  if (manifest === null) problems.push(`${MANIFEST_PATH} not found`);
  else problems.push(...checkManifest(manifest));
  const info = await read(join(root, INFO_PLIST_PATH));
  if (info === null) problems.push(`${INFO_PLIST_PATH} not found`);
  else problems.push(...checkInfoPlist(info));
  const at = argv.indexOf("--app");
  // These two only mean something for a built app: given without one they would check nothing and
  // pass, so a CI step that forgot `--app` is refused instead.
  if (at < 0) {
    for (const flag of ["--build", "--entitlements"]) {
      if (argv.includes(flag)) {
        problems.push(`${flag} is only for a built app: pass --app X.app too`);
      }
    }
  }
  if (at >= 0) {
    const app = argv[at + 1];
    if (!app) {
      problems.push("pass the built .app folder after --app");
    } else {
      const built = await read(join(app, "PrivacyInfo.xcprivacy"));
      if (built === null) {
        problems.push(
          `${app}: PrivacyInfo.xcprivacy is not at the bundle root`,
        );
      } else if (manifest !== null && built !== manifest) {
        problems.push(
          `${app}: PrivacyInfo.xcprivacy differs from ${MANIFEST_PATH}`,
        );
      }
      const build = optionOf(argv, "--build");
      const file = optionOf(argv, "--entitlements");
      if (build === undefined) {
        // Without the kind of build, any value of the two would pass.
        problems.push(
          "pass --build debug or --build release with --app: the push environment depends on it",
        );
      } else if (!(build in APS_ENVIRONMENT)) {
        problems.push(`--build must be debug or release, not ${build}`);
      } else {
        const signed = await readEntitlements(app, file);
        if (signed === null) {
          problems.push(
            `${app}: the signed entitlements cannot be read here (needs macOS codesign, or pass --entitlements FILE)`,
          );
        } else {
          problems.push(
            ...checkEntitlements(signed, build).map(
              (problem) => `${app}: ${problem}`,
            ),
          );
        }
      }
      const builtInfo = await readPlist(join(app, "Info.plist"));
      if (builtInfo === null) {
        problems.push(
          `${app}: Info.plist not found, or binary and not convertible here (needs macOS plutil)`,
        );
      } else {
        problems.push(
          ...checkInfoPlist(builtInfo).map((problem) => `${app}: ${problem}`),
        );
      }
    }
  }
  return problems;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const problems = await run(process.argv.slice(2));
  if (problems.length) {
    for (const problem of problems) console.error(`iOS privacy: ${problem}`);
    process.exit(1);
  }
  console.log("iOS privacy files are as pinned.");
}

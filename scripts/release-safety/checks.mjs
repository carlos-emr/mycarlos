// The checks of the release safety gate. Each takes what it inspects and returns problems as strings
// (empty when it is fine). The gate fails closed: something it cannot read is a problem, not a pass.
import { decodeAnyXml } from "./android-xml.mjs";
import { readZip } from "./zip.mjs";

/** Cargo features that must not be compiled into a store build. */
export const FORBIDDEN_FEATURES = [
  "ai-helper-stub",
  "cloud-ai",
  "cloud_ai",
  "devtools",
];

/**
 * Strings that exist in a built binary only when something a store build must not have is compiled
 * in. A marker is a contract with the code: the model helper's stub names itself "FAKE stub", and
 * the cloud AI send (#72, not built yet) must define a constant `mycarlos-cloud-ai` under its
 * feature so that this list can see it. They are first-build knowledge: confirm each against a real
 * release build, and a marker that turns out to occur in dependencies is replaced here, not ignored.
 */
export const BINARY_MARKERS = [
  {
    name: "the model helper stub (ai-helper-stub)",
    bytes: Buffer.from("FAKE stub"),
  },
  {
    name: "the cloud AI send (cloud-ai)",
    bytes: Buffer.from("mycarlos-cloud-ai"),
  },
];

/** A dev server baked into a build: a localhost, loopback, emulator or private-network URL with a port. */
export const DEV_SERVER_URL =
  /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|10\.0\.2\.2|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d{2,5}/;

/** What a frontend development build or its hot-reload client leaves in the bundle. */
export const DEV_FRONTEND_PATTERNS = [
  ["the Vite client", /@vite\/client/],
  ["hot module replacement (import.meta.hot)", /import\.meta\.hot/],
  ["the React refresh runtime", /@react-refresh|\$RefreshReg\$/],
  ["the Vite ping", /__vite_ping/],
  ["a webpack hot client", /webpack-hot-middleware|webpack\/hot\/dev-server/],
];

const isTrue = (value) => String(value).toLowerCase() === "true";

/** Problems in a list of decoded manifest elements. */
export function checkAndroidManifest(elements, expectedId) {
  const problems = [];
  const manifest = elements.find((element) => element.name === "manifest");
  const application = elements.find(
    (element) => element.name === "application",
  );
  if (!manifest || !application)
    return ["the Android manifest has no manifest or application element"];
  if (manifest.attrs.package !== expectedId) {
    problems.push(
      `applicationId is ${manifest.attrs.package ?? "missing"}; it must be ${expectedId}`,
    );
  }
  if (isTrue(application.attrs.debuggable))
    problems.push("android:debuggable is true (a debug build)");
  if (isTrue(application.attrs.testOnly))
    problems.push("android:testOnly is true (Play refuses it)");
  if (isTrue(application.attrs.usesCleartextTraffic)) {
    problems.push(
      "android:usesCleartextTraffic is true (cleartext traffic is allowed)",
    );
  }
  if (
    !("allowBackup" in application.attrs) ||
    isTrue(application.attrs.allowBackup)
  ) {
    problems.push(
      "android:allowBackup is not false (the vault would go to Android backups)",
    );
  }
  return problems;
}

/** Problems in the XML resources (network security configurations among them) of an Android build. */
export function checkAndroidXmlResources(resources) {
  const problems = [];
  for (const [name, elements] of resources) {
    for (const element of elements) {
      if (isTrue(element.attrs.cleartextTrafficPermitted)) {
        problems.push(`${name}: ${element.name} permits cleartext traffic`);
      }
    }
  }
  return problems;
}

/**
 * Problems in the strings of a native binary or other bytes. `label` names where they were.
 * `allowedUrls`: addresses that are in every build, because the app's own configuration embeds them
 * (tauri.conf.json's `build.devUrl` is compiled into the app whether or not it is used: a debug
 * build on the real CI APK holds exactly `http://localhost:1420`); any OTHER dev address, such as a
 * LAN or emulator one from `tauri android dev`, is a finding.
 */
export function checkBinary(bytes, label, { allowedUrls = [] } = {}) {
  const problems = [];
  for (const marker of BINARY_MARKERS) {
    if (bytes.includes(marker.bytes))
      problems.push(`${label} contains ${marker.name}`);
  }
  const text = bytes.toString("latin1");
  const seen = new Set();
  for (const found of text.matchAll(new RegExp(DEV_SERVER_URL.source, "g"))) {
    if (allowedUrls.includes(found[0]) || seen.has(found[0])) continue;
    seen.add(found[0]);
    problems.push(`${label} contains a dev server address (${found[0]})`);
  }
  // A native library that still has its symbol table or debug sections is a debug build (or an unstripped
  // release): a real debug APK's library has both, a release build is stripped (Cargo `strip = true`).
  if (bytes.length > 4 && bytes.readUInt32BE(0) === 0x7f454c46) {
    for (const section of [".debug_info", ".symtab"]) {
      if (bytes.includes(Buffer.from(section)))
        problems.push(
          `${label} is not stripped (${section} is present: a debug build)`,
        );
    }
  }
  return problems;
}

/** Problems in a whole APK or AAB. */
export function checkAndroidArchive(
  archiveBytes,
  label,
  expectedId,
  options = {},
) {
  const zip = readZip(archiveBytes);
  const problems = [];
  const names = zip.names();
  const manifestName = [
    "AndroidManifest.xml",
    "base/manifest/AndroidManifest.xml",
  ].find((name) => zip.has(name));
  if (!manifestName)
    return [`${label}: no AndroidManifest.xml (not an APK or AAB?)`];
  let manifest;
  try {
    manifest = decodeAnyXml(zip.read(manifestName));
  } catch (error) {
    return [`${label}: the manifest cannot be read (${error.message})`];
  }
  problems.push(
    ...checkAndroidManifest(manifest, expectedId).map(
      (problem) => `${label}: ${problem}`,
    ),
  );
  const resources = new Map();
  for (const name of names) {
    if (/(?:^|\/)res\/xml\/[^/]+\.xml$/.test(name)) {
      try {
        resources.set(`${label}!${name}`, decodeAnyXml(zip.read(name)));
      } catch {
        problems.push(
          `${label}!${name}: cannot be read, so its cleartext setting is unknown`,
        );
      }
    }
  }
  problems.push(...checkAndroidXmlResources(resources));
  let libraries = 0;
  for (const name of names) {
    if (/(?:^|\/)lib\/[^/]+\/[^/]+\.so$/.test(name)) {
      libraries++;
      problems.push(
        ...checkBinary(zip.read(name), `${label}!${name}`, options),
      );
    }
  }
  if (libraries === 0)
    problems.push(
      `${label}: no native library found, so nothing was checked for the stub or dev markers`,
    );
  return problems;
}

// ---- iOS ----

const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, "");

/** The XML text of a property list, whichever form it is in; `convert` turns a binary one into XML. */
export function plistText(bytes, convert) {
  if (bytes.subarray(0, 6).equals(Buffer.from("bplist"))) {
    const text = convert ? convert(bytes) : null;
    if (text === null || text === undefined)
      throw new Error(
        "a binary property list cannot be converted here (needs macOS plutil)",
      );
    return text;
  }
  return bytes.toString("utf8");
}

/** The value after `<key>name</key>` anywhere in an XML plist: "true", "false", a string, or null. */
export function plistValue(text, name) {
  const found = new RegExp(
    `<key>${name}</key>\\s*(<true/>|<false/>|<string>([^<]*)</string>|<dict>|<array>)`,
  ).exec(stripComments(text));
  if (!found) return null;
  if (found[1] === "<true/>") return "true";
  if (found[1] === "<false/>") return "false";
  if (found[2] !== undefined) return found[2];
  return found[1];
}

/** Problems in an iOS Info.plist (XML text). */
export function checkIosInfoPlist(text, expectedId) {
  const problems = [];
  const id = plistValue(text, "CFBundleIdentifier");
  if (id !== expectedId)
    problems.push(`bundle id is ${id ?? "missing"}; it must be ${expectedId}`);
  const body = stripComments(text);
  if (
    /<key>NSAllowsArbitraryLoads(?:InWebContent|ForMedia)?<\/key>\s*<true\/>/.test(
      body,
    )
  ) {
    problems.push(
      "App Transport Security allows arbitrary loads (cleartext traffic is allowed)",
    );
  }
  if (/<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/.test(body)) {
    problems.push(
      "App Transport Security allows local networking (a development setting)",
    );
  }
  if (/<key>NSExceptionAllowsInsecureHTTPLoads<\/key>\s*<true\/>/.test(body)) {
    problems.push(
      "an App Transport Security exception allows insecure HTTP loads",
    );
  }
  return problems;
}

/** Problems in an embedded provisioning profile's XML text (the plist inside its CMS wrapper). */
export function checkProvisioningProfile(raw) {
  const start = raw.indexOf("<?xml");
  const end = raw.lastIndexOf("</plist>");
  if (start < 0 || end < 0)
    return ["the provisioning profile has no readable plist"];
  const text = raw.slice(start, end + "</plist>".length);
  const problems = [];
  if (plistValue(text, "get-task-allow") === "true") {
    problems.push(
      "get-task-allow is true (a development-signed build; a debugger may attach)",
    );
  }
  if (/<key>ProvisionedDevices<\/key>/.test(text)) {
    problems.push(
      "the provisioning profile lists devices (a development or ad-hoc profile, not App Store)",
    );
  }
  if (
    /<key>aps-environment<\/key>\s*<string>development<\/string>/.test(text)
  ) {
    problems.push("aps-environment is development");
  }
  return problems;
}

/**
 * Problems in an iOS app. `files` maps paths inside the app (as `Info.plist`, `embedded.mobileprovision`,
 * and the executable by its `CFBundleExecutable` name) to bytes.
 */
export function checkIosApp(files, label, expectedId, convert, options = {}) {
  const problems = [];
  const info = files.get("Info.plist");
  if (!info) return [`${label}: no Info.plist (not an iOS app?)`];
  let text;
  try {
    text = plistText(info, convert);
  } catch (error) {
    return [`${label}: Info.plist cannot be read (${error.message})`];
  }
  problems.push(
    ...checkIosInfoPlist(text, expectedId).map(
      (problem) => `${label}: ${problem}`,
    ),
  );
  const profile = files.get("embedded.mobileprovision");
  if (profile)
    problems.push(
      ...checkProvisioningProfile(profile.toString("latin1")).map(
        (problem) => `${label}: ${problem}`,
      ),
    );
  else
    problems.push(
      `${label}: no embedded.mobileprovision (an unsigned or simulator build, not a store build)`,
    );
  const executableName = plistValue(text, "CFBundleExecutable");
  const executable = executableName ? files.get(executableName) : null;
  if (!executable)
    problems.push(
      `${label}: the executable ${executableName ?? "(CFBundleExecutable missing)"} was not found, so nothing was checked for the stub or dev markers`,
    );
  else
    problems.push(
      ...checkBinary(executable, `${label}!${executableName}`, options),
    );
  return problems;
}

/** The files of an .ipa's `Payload/<name>.app/`, keyed relative to the app folder. */
export function iosFilesFromIpa(ipaBytes) {
  const zip = readZip(ipaBytes);
  const app = zip
    .names()
    .map((name) => /^Payload\/([^/]+\.app)\//.exec(name))
    .find(Boolean);
  if (!app) return null;
  const prefix = `Payload/${app[1]}/`;
  const files = new Map();
  for (const name of zip.names()) {
    if (name.startsWith(prefix) && !name.endsWith("/")) {
      const relative = name.slice(prefix.length);
      // Only the top level of the app: its plist, profile and executable.
      if (!relative.includes("/")) files.set(relative, zip.read(name));
    }
  }
  return files;
}

// ---- the frontend build ----

/** Problems in one frontend build file's text. */
export function checkFrontendFile(text, label) {
  const problems = [];
  for (const [what, pattern] of DEV_FRONTEND_PATTERNS) {
    if (pattern.test(text)) problems.push(`${label} contains ${what}`);
  }
  const dev = DEV_SERVER_URL.exec(text);
  if (dev) problems.push(`${label} contains a dev server address (${dev[0]})`);
  return problems;
}

// ---- the source and build configuration ----

/** The names in a Cargo.toml feature list `default = [ ... ]`. */
function defaultFeatures(cargoToml) {
  const found = /^\s*default\s*=\s*\[([\s\S]*?)\]/m.exec(
    cargoToml.split(/^\[(?:dependencies|target)/m)[0],
  );
  return found ? [...found[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
}

/** Problems in Cargo.toml for a store build: forbidden default features, and tauri's `devtools` feature. */
export function checkCargoToml(cargoToml) {
  const problems = [];
  for (const feature of defaultFeatures(cargoToml)) {
    if (FORBIDDEN_FEATURES.includes(feature))
      problems.push(`Cargo.toml enables ${feature} by default`);
  }
  for (const line of cargoToml.split("\n")) {
    if (/^\s*tauri\s*=/.test(line) && /"devtools"/.test(line)) {
      problems.push(
        "Cargo.toml enables tauri's devtools feature (a devtools-enabled webview)",
      );
    }
  }
  return problems;
}

/** Problems in a build command or script's text: a forbidden feature passed to cargo or tauri. */
export function checkBuildCommands(text, label) {
  const problems = [];
  for (const use of text.matchAll(/(?:--features|-F)[ =]+["']?([^\s"'\\]+)/g)) {
    for (const feature of use[1].split(",")) {
      if (FORBIDDEN_FEATURES.includes(feature))
        problems.push(`${label} builds with the ${feature} feature`);
    }
  }
  return problems;
}

/** Problems in tauri.conf.json (as text): the identifier. */
export function checkTauriConfig(text, expectedId) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return ["tauri.conf.json is not JSON"];
  }
  const problems = [];
  if (config.identifier !== expectedId) {
    problems.push(
      `tauri.conf.json identifier is ${config.identifier ?? "missing"}; it must be ${expectedId}`,
    );
  }
  if (config.bundle?.android?.debugApplicationIdSuffix) {
    problems.push("tauri.conf.json sets a debugApplicationIdSuffix");
  }
  return problems;
}

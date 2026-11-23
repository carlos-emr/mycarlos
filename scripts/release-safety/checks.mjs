// The checks of the release safety gate. Each takes what it inspects and returns problems as strings
// (empty when it is fine). The gate fails closed: something it cannot read is a problem, not a pass.
import { androidAttr, decodeAnyXml } from "./android-xml.mjs";
import { checkCommandText, FORBIDDEN_FEATURES } from "./cargo.mjs";
import { readZip } from "./zip.mjs";

export {
  checkCargoConfig,
  checkCargoManifest as checkCargoToml,
  checkCommandText as checkBuildCommands,
  FORBIDDEN_FEATURES,
} from "./cargo.mjs";

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

/** A setting that must be absent or literally false: a reference or any other value is unknown, so refused. */
const notFalse = (value) =>
  value !== undefined && String(value).toLowerCase() !== "false";
const say = (value) =>
  String(value).toLowerCase() === "true"
    ? "is true"
    : `is ${value} (not literally false: a resource reference or another value is unknown, so it is refused)`;

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
  for (const [name, why] of [
    ["debuggable", "a debug build"],
    ["testOnly", "Play refuses it"],
    ["usesCleartextTraffic", "cleartext traffic"],
  ]) {
    const value = androidAttr(application, name);
    if (notFalse(value))
      problems.push(`android:${name} ${say(value)} (${why})`);
  }
  const backup = androidAttr(application, "allowBackup");
  if (backup === undefined || String(backup).toLowerCase() !== "false") {
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
      const value = androidAttr(element, "cleartextTrafficPermitted");
      if (notFalse(value)) {
        problems.push(
          `${name}: ${element.name} cleartextTrafficPermitted ${say(value)}`,
        );
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
export function checkBinary(bytes, label, { allowedUrls = [], expectElf = false } = {}) {
  const problems = [];
  for (const marker of BINARY_MARKERS) {
    if (bytes.includes(marker.bytes))
      problems.push(`${label} contains ${marker.name}`);
  }
  const allowed = new Set(allowedUrls.map(originOf));
  const text = bytes.toString("latin1");
  const seen = new Set();
  for (const found of text.matchAll(new RegExp(DEV_SERVER_URL.source, "g"))) {
    if (allowed.has(originOf(found[0])) || seen.has(found[0])) continue;
    seen.add(found[0]);
    problems.push(`${label} contains a dev server address (${found[0]})`);
  }
  const elf = inspectElf(bytes);
  if (elf.problem) problems.push(`${label}: ${elf.problem}`);
  for (const section of elf.sections) {
    problems.push(`${label} is not stripped (${section} is present: a debug build)`);
  }
  if (expectElf && (bytes.length < 4 || bytes.readUInt32BE(0) !== 0x7f454c46)) {
    problems.push(`${label} is not an ELF file, so it cannot be checked for symbols`);
  }
  return problems;
}

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

/**
 * The debug and symbol sections of a little-endian ELF file, read from its section headers (a
 * string constant that happens to say ".symtab" cannot trip this); none for another kind of file
 * or one with no section table (a stripped one often has none worth reading).
 */
export function elfDebugSections(bytes) {
  return inspectElf(bytes).sections;
}

/**
 * What the section headers of an ELF file say: `{ sections, problem }`. `problem` is set when the file
 * is an ELF the gate cannot read (big-endian, a header-only file, a section table past the end, a
 * missing name table): a real stripped library always keeps its section headers, so unreadable is
 * refused, never passed. `problem` is null and `sections` empty for a file that is not an ELF at all.
 */
export function inspectElf(bytes) {
  const none = { sections: [], problem: null };
  if (bytes.length < 4 || bytes.readUInt32BE(0) !== 0x7f454c46) return none;
  const unreadable = (why) => ({ sections: [], problem: `its ELF section headers cannot be read (${why})` });
  if (bytes.length < 64) return unreadable("the header is cut short");
  if (bytes[5] !== 1) return unreadable("not a little-endian ELF");
  const is64 = bytes[4] === 2;
  const shoff = is64 ? Number(bytes.readBigUInt64LE(40)) : bytes.readUInt32LE(32);
  const entry = is64 ? bytes.readUInt16LE(58) : bytes.readUInt16LE(46);
  const count = is64 ? bytes.readUInt16LE(60) : bytes.readUInt16LE(48);
  const names = is64 ? bytes.readUInt16LE(62) : bytes.readUInt16LE(50);
  if (!shoff || !count) return unreadable("there is no section table");
  if (names >= count) return unreadable("the section name table is missing");
  if (entry < (is64 ? 64 : 40) || shoff + count * entry > bytes.length) {
    return unreadable("the section table runs past the end of the file");
  }
  const header = (index) => shoff + index * entry;
  const strOffset = is64
    ? Number(bytes.readBigUInt64LE(header(names) + 24))
    : bytes.readUInt32LE(header(names) + 16);
  if (strOffset >= bytes.length) return unreadable("the section name table is past the end of the file");
  const found = new Set();
  for (let i = 0; i < count; i++) {
    const at = strOffset + bytes.readUInt32LE(header(i));
    if (at >= bytes.length) return unreadable("a section name is past the end of the file");
    const end = bytes.indexOf(0, at);
    const name = bytes.toString("latin1", at, end < 0 ? bytes.length : end);
    if (name === ".symtab" || name.startsWith(".debug_")) found.add(name === ".symtab" ? ".symtab" : ".debug_info");
  }
  return { sections: [...found], problem: null };
}

/** Problems in a whole APK or AAB. */
export function checkAndroidArchive(
  archiveBytes,
  label,
  expectedId,
  options = {},
) {
  const zip = readZip(archiveBytes, options);
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
        ...checkBinary(zip.read(name), `${label}!${name}`, { ...options, expectElf: true }),
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

/** Problems in tauri.conf.json (as text): the identifier, a debug suffix, build features and build commands. */
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
  // `build.features` turns Cargo features on for every build, with no command line to show it.
  const features = config.build?.features;
  if (features !== undefined && !Array.isArray(features))
    problems.push("tauri.conf.json build.features is not a list");
  for (const feature of Array.isArray(features) ? features : []) {
    if (FORBIDDEN_FEATURES.includes(feature))
      problems.push(`tauri.conf.json build.features enables ${feature}`);
  }
  for (const key of ["beforeBuildCommand", "beforeBundleCommand"]) {
    const command = config.build?.[key];
    const text = typeof command === "string" ? command : command?.script;
    if (typeof text === "string")
      problems.push(...checkCommandText(text, `tauri.conf.json build.${key}`));
  }
  return problems;
}

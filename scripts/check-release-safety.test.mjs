import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decodeAnyXml,
  decodeBinaryXml,
  decodePlainXml,
  decodeProtoXml,
} from "./release-safety/android-xml.mjs";
import {
  checkAndroidArchive,
  checkAndroidManifest,
  checkBinary,
  checkBuildCommands,
  checkCargoToml,
  checkFrontendFile,
  checkIosApp,
  checkIosInfoPlist,
  checkProvisioningProfile,
  checkTauriConfig,
  iosFilesFromIpa,
} from "./release-safety/checks.mjs";
import { EXPECTED_APP_ID, run } from "./check-release-safety.mjs";

// ---- builders: made-up (FAKE) artifacts, so the decoders and checks are tested without a real build ----

/** A zip of stored entries. */
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const piece = Buffer.concat([local, nameBytes, data]);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, nameBytes]));
    parts.push(piece);
    offset += piece.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** Binary XML (AXML) for a flat list of elements `[name, { attr: "text" | true | false }]`. */
function axml(elements) {
  const strings = [];
  const index = (text) => {
    let at = strings.indexOf(text);
    if (at < 0) at = strings.push(text) - 1;
    return at;
  };
  const chunks = [];
  for (const [name, attrs] of elements) {
    const nameIndex = index(name);
    const entries = Object.entries(attrs);
    const body = Buffer.alloc(16 + 20 + entries.length * 20);
    body.writeUInt16LE(0x0102, 0);
    body.writeUInt16LE(16, 2);
    body.writeUInt32LE(body.length, 4);
    body.writeUInt32LE(0xffffffff, 12);
    body.writeUInt32LE(0xffffffff, 16);
    body.writeUInt32LE(nameIndex, 20);
    body.writeUInt16LE(0x14, 24);
    body.writeUInt16LE(0x14, 26);
    body.writeUInt16LE(entries.length, 28);
    entries.forEach(([key, value], i) => {
      const at = 36 + i * 20;
      body.writeUInt32LE(0xffffffff, at);
      body.writeUInt32LE(index(key), at + 4);
      body.writeUInt32LE(0xffffffff, at + 8);
      body.writeUInt16LE(8, at + 12);
      if (typeof value === "boolean") {
        body[at + 15] = 0x12;
        body.writeUInt32LE(value ? 0xffffffff : 0, at + 16);
      } else {
        body[at + 15] = 0x03;
        body.writeUInt32LE(index(value), at + 16);
      }
    });
    chunks.push(body);
  }
  const encoded = strings.map((text) => {
    const b = Buffer.alloc(2 + text.length * 2 + 2);
    b.writeUInt16LE(text.length, 0);
    b.write(text, 2, "utf16le");
    return b;
  });
  const offsets = Buffer.alloc(strings.length * 4);
  let at = 0;
  encoded.forEach((b, i) => {
    offsets.writeUInt32LE(at, i * 4);
    at += b.length;
  });
  const data = Buffer.concat(encoded);
  const padded = Buffer.concat([
    data,
    Buffer.alloc((4 - (data.length % 4)) % 4),
  ]);
  const poolHeader = Buffer.alloc(28);
  poolHeader.writeUInt16LE(0x0001, 0);
  poolHeader.writeUInt16LE(28, 2);
  poolHeader.writeUInt32LE(28 + offsets.length + padded.length, 4);
  poolHeader.writeUInt32LE(strings.length, 8);
  poolHeader.writeUInt32LE(28 + offsets.length, 20);
  const pool = Buffer.concat([poolHeader, offsets, padded]);
  const all = Buffer.concat([pool, ...chunks]);
  const header = Buffer.alloc(8);
  header.writeUInt16LE(0x0003, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + all.length, 4);
  return Buffer.concat([header, all]);
}

const varintBytes = (n) => {
  const out = [];
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
};
const field = (number, payload) => {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  return Buffer.concat([
    varintBytes((number << 3) | 2),
    varintBytes(body.length),
    body,
  ]);
};
/** Protobuf XML (an AAB): `[name, attrs, children]`. */
function protoNode([name, attrs, children = []]) {
  const element = Buffer.concat([
    field(3, name),
    ...Object.entries(attrs).map(([key, value]) =>
      field(4, Buffer.concat([field(2, key), field(3, String(value))])),
    ),
    ...children.map((child) => field(5, protoNode(child))),
  ]);
  return field(1, element);
}

const elf = (...extra) =>
  Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.alloc(60),
    ...extra.map((e) => Buffer.from(e)),
  ]);

const GOOD_MANIFEST = [
  ["manifest", { package: EXPECTED_APP_ID }],
  ["application", { allowBackup: false, debuggable: false }],
];
const apk = (manifest = GOOD_MANIFEST, extra = []) =>
  zip([
    ["AndroidManifest.xml", axml(manifest)],
    ["lib/arm64-v8a/libmycarlos.so", elf("release")],
    ...extra,
  ]);

// ---- the decoders ----

test("plain, binary and protobuf manifests decode to the same elements", () => {
  const plain =
    decodePlainXml(`<?xml version="1.0"?><manifest xmlns:android="x" package="${EXPECTED_APP_ID}">
    <!-- <application android:debuggable="true"> --><application android:allowBackup="false" android:debuggable="false"/></manifest>`);
  const binary = decodeBinaryXml(axml(GOOD_MANIFEST));
  const proto = decodeProtoXml(
    protoNode([
      "manifest",
      { package: EXPECTED_APP_ID },
      [["application", { allowBackup: "false", debuggable: "false" }]],
    ]),
  );
  const flat = (elements) =>
    elements
      .map((e) =>
        [e.name, e.attrs.package ?? e.attrs.allowBackup ?? ""].join(":"),
      )
      .join("|");
  assert.equal(flat(plain), `manifest:${EXPECTED_APP_ID}|application:false`);
  assert.equal(flat(binary), flat(plain));
  assert.equal(flat(proto), flat(plain));
  assert.deepEqual(decodeAnyXml(axml(GOOD_MANIFEST)), binary);
  assert.throws(
    () => decodeBinaryXml(Buffer.from("nope nope")),
    /not binary XML/,
  );
  assert.throws(() => decodeProtoXml(Buffer.alloc(0)), /not protobuf XML/);
});

// ---- Android ----

test("a good manifest passes, and each unsafe setting is its own finding", () => {
  const good = decodeBinaryXml(axml(GOOD_MANIFEST));
  assert.deepEqual(checkAndroidManifest(good, EXPECTED_APP_ID), []);
  const bad = (application, pkg = EXPECTED_APP_ID) =>
    checkAndroidManifest(
      decodeBinaryXml(
        axml([
          ["manifest", { package: pkg }],
          ["application", application],
        ]),
      ),
      EXPECTED_APP_ID,
    ).join("|");
  assert.match(
    bad({ allowBackup: false, debuggable: true }),
    /debuggable is true/,
  );
  assert.match(bad({ allowBackup: false, testOnly: true }), /testOnly is true/);
  assert.match(
    bad({ allowBackup: false, usesCleartextTraffic: true }),
    /cleartext traffic is allowed/,
  );
  assert.match(bad({ allowBackup: true }), /allowBackup is not false/);
  assert.match(bad({}), /allowBackup is not false/);
  assert.match(
    bad({ allowBackup: false }, `${EXPECTED_APP_ID}.debug`),
    /applicationId is .*\.debug; it must be/,
  );
  assert.match(
    bad({ allowBackup: false }, "com.example.other"),
    /applicationId is com.example.other/,
  );
  assert.match(
    checkAndroidManifest([], EXPECTED_APP_ID).join(),
    /no manifest or application/,
  );
});

test("an APK is checked end to end, and what cannot be read fails closed", () => {
  assert.deepEqual(checkAndroidArchive(apk(), "good.apk", EXPECTED_APP_ID), []);
  const debug = apk([
    ["manifest", { package: EXPECTED_APP_ID }],
    ["application", { allowBackup: false, debuggable: true }],
  ]);
  assert.match(
    checkAndroidArchive(debug, "d.apk", EXPECTED_APP_ID).join(),
    /debuggable is true/,
  );
  assert.match(
    checkAndroidArchive(
      zip([["x.txt", Buffer.from("x")]]),
      "n.apk",
      EXPECTED_APP_ID,
    ).join(),
    /no AndroidManifest/,
  );
  const noLibraries = zip([["AndroidManifest.xml", axml(GOOD_MANIFEST)]]);
  assert.match(
    checkAndroidArchive(noLibraries, "l.apk", EXPECTED_APP_ID).join(),
    /no native library/,
  );
  const broken = zip([
    [
      "AndroidManifest.xml",
      Buffer.from([0x03, 0x00, 0x08, 0x00, 0x04, 0x00, 0x00, 0x00]),
    ],
    ["lib/arm64-v8a/a.so", elf()],
  ]);
  assert.match(
    checkAndroidArchive(broken, "b.apk", EXPECTED_APP_ID).join(),
    /manifest cannot be read|no manifest or application|unsupported|not binary|damaged/,
  );
});

test("a network security config that permits cleartext is found, in an APK and in an AAB", () => {
  const permissive = apk(GOOD_MANIFEST, [
    [
      "res/xml/network_security_config.xml",
      axml([
        ["network-security-config", {}],
        ["base-config", { cleartextTrafficPermitted: true }],
      ]),
    ],
  ]);
  assert.match(
    checkAndroidArchive(permissive, "p.apk", EXPECTED_APP_ID).join(),
    /base-config permits cleartext traffic/,
  );
  const strict = apk(GOOD_MANIFEST, [
    [
      "res/xml/network_security_config.xml",
      axml([["base-config", { cleartextTrafficPermitted: false }]]),
    ],
  ]);
  assert.deepEqual(checkAndroidArchive(strict, "s.apk", EXPECTED_APP_ID), []);
  const aab = zip([
    [
      "base/manifest/AndroidManifest.xml",
      protoNode([
        "manifest",
        { package: EXPECTED_APP_ID },
        [["application", { allowBackup: "false" }]],
      ]),
    ],
    [
      "base/res/xml/nsc.xml",
      protoNode(["domain-config", { cleartextTrafficPermitted: "true" }]),
    ],
    ["base/lib/arm64-v8a/libmycarlos.so", elf("release")],
  ]);
  assert.match(
    checkAndroidArchive(aab, "x.aab", EXPECTED_APP_ID).join(),
    /domain-config permits cleartext/,
  );
});

test("the stub, the cloud AI send, dev addresses and unstripped libraries are found in native code", () => {
  assert.deepEqual(checkBinary(elf("release build"), "lib.so"), []);
  assert.match(
    checkBinary(elf("... FAKE stub ..."), "lib.so").join(),
    /the model helper stub/,
  );
  assert.match(
    checkBinary(elf("mycarlos-cloud-ai"), "lib.so").join(),
    /the cloud AI send/,
  );
  assert.match(
    checkBinary(elf("http://192.168.1.20:1420/index"), "lib.so").join(),
    /dev server address \(http:\/\/192\.168\.1\.20:1420\)/,
  );
  assert.match(
    checkBinary(elf("http://10.0.2.2:5173"), "lib.so").join(),
    /dev server address/,
  );
  // The configured devUrl is in every build (tauri embeds its config); only other addresses count.
  assert.deepEqual(
    checkBinary(elf("http://localhost:1420/../dist"), "lib.so", {
      allowedUrls: ["http://localhost:1420"],
    }),
    [],
  );
  assert.match(
    checkBinary(elf("http://localhost:1420"), "lib.so").join(),
    /dev server address/,
  );
  assert.match(
    checkBinary(elf(".debug_info"), "lib.so").join(),
    /not stripped/,
  );
  assert.match(checkBinary(elf(".symtab"), "lib.so").join(), /not stripped/);
  // Only an ELF file is judged for symbols.
  assert.deepEqual(
    checkBinary(Buffer.from(".symtab and .debug_info text"), "notes.txt"),
    [],
  );
  const inApk = apk(GOOD_MANIFEST, [
    ["lib/x86_64/libextra.so", elf("FAKE stub")],
  ]);
  assert.match(
    checkAndroidArchive(inApk, "s.apk", EXPECTED_APP_ID).join(),
    /libextra.so contains the model helper stub/,
  );
});

// ---- iOS ----

const INFO = (
  extra = "",
  id = EXPECTED_APP_ID,
) => `<?xml version="1.0"?><plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>mycarlos</string>${extra}</dict></plist>`;
const PROFILE = (
  entitlements = "<key>get-task-allow</key><false/>",
  extra = "",
) =>
  `\u0001\u0002CMS junk<?xml version="1.0"?><plist version="1.0"><dict><key>Entitlements</key><dict>${entitlements}</dict>${extra}</dict></plist>trailing junk`;
const iosFiles = ({
  info = INFO(),
  profile = PROFILE(),
  executable = Buffer.from("release code"),
} = {}) =>
  new Map([
    ["Info.plist", Buffer.from(info)],
    ...(profile === null
      ? []
      : [["embedded.mobileprovision", Buffer.from(profile, "latin1")]]),
    ["mycarlos", executable],
  ]);

test("a good iOS app passes, and each unsafe setting is its own finding", () => {
  assert.deepEqual(checkIosApp(iosFiles(), "good.app", EXPECTED_APP_ID), []);
  const one = (files) => checkIosApp(files, "x.app", EXPECTED_APP_ID).join("|");
  assert.match(
    one(iosFiles({ info: INFO("", "com.example.other") })),
    /bundle id is com.example.other/,
  );
  assert.match(
    one(
      iosFiles({
        info: INFO(
          "<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>",
        ),
      }),
    ),
    /arbitrary loads/,
  );
  assert.match(
    one(
      iosFiles({
        info: INFO(
          "<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>",
        ),
      }),
    ),
    /local networking/,
  );
  assert.match(
    one(
      iosFiles({
        info: INFO(
          "<key>NSExceptionDomains</key><dict><key>x.example</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict></dict>",
        ),
      }),
    ),
    /insecure HTTP loads/,
  );
  assert.match(
    one(iosFiles({ profile: PROFILE("<key>get-task-allow</key><true/>") })),
    /get-task-allow is true/,
  );
  assert.match(
    one(
      iosFiles({
        profile: PROFILE(
          "<key>get-task-allow</key><false/>",
          "<key>ProvisionedDevices</key><array/>",
        ),
      }),
    ),
    /lists devices/,
  );
  assert.match(
    one(
      iosFiles({
        profile: PROFILE(
          "<key>aps-environment</key><string>development</string>",
        ),
      }),
    ),
    /aps-environment is development/,
  );
  assert.match(one(iosFiles({ profile: null })), /no embedded.mobileprovision/);
  assert.match(
    one(iosFiles({ executable: Buffer.from("x FAKE stub x") })),
    /the model helper stub/,
  );
  assert.match(one(new Map()), /no Info.plist/);
  const missingExecutable = iosFiles();
  missingExecutable.delete("mycarlos");
  assert.match(one(missingExecutable), /executable mycarlos was not found/);
});

test("a binary Info.plist is converted when plutil can, and fails closed when it cannot", () => {
  const binary = new Map([
    ["Info.plist", Buffer.concat([Buffer.from("bplist00"), Buffer.alloc(8)])],
  ]);
  assert.match(
    checkIosApp(binary, "b.app", EXPECTED_APP_ID).join(),
    /binary property list cannot be converted/,
  );
  const converted = iosFiles();
  converted.set(
    "Info.plist",
    Buffer.concat([Buffer.from("bplist00"), Buffer.alloc(8)]),
  );
  assert.deepEqual(
    checkIosApp(converted, "b.app", EXPECTED_APP_ID, () => INFO()),
    [],
  );
  assert.deepEqual(checkIosInfoPlist(INFO(), EXPECTED_APP_ID), []);
  assert.match(
    checkProvisioningProfile("no plist here").join(),
    /no readable plist/,
  );
});

test("an IPA is read from its Payload app folder", () => {
  const ipa = zip([
    ["Payload/myCarlos.app/Info.plist", Buffer.from(INFO())],
    [
      "Payload/myCarlos.app/embedded.mobileprovision",
      Buffer.from(PROFILE(), "latin1"),
    ],
    ["Payload/myCarlos.app/mycarlos", Buffer.from("release code")],
    ["Payload/myCarlos.app/Frameworks/x.dylib", Buffer.from("FAKE stub")],
  ]);
  const files = iosFilesFromIpa(ipa);
  assert.deepEqual([...files.keys()].sort(), [
    "Info.plist",
    "embedded.mobileprovision",
    "mycarlos",
  ]);
  assert.deepEqual(checkIosApp(files, "a.ipa", EXPECTED_APP_ID), []);
  assert.equal(iosFilesFromIpa(zip([["README", Buffer.from("x")]])), null);
});

// ---- the frontend build, the source and the command line ----

test("a frontend build with dev or hot-reload hooks is refused", () => {
  assert.deepEqual(checkFrontendFile("console.log('app')", "dist/a.js"), []);
  assert.match(
    checkFrontendFile('import "/@vite/client";', "dist/a.js").join(),
    /the Vite client/,
  );
  assert.match(
    checkFrontendFile("if (import.meta.hot) {}", "dist/a.js").join(),
    /import.meta.hot/,
  );
  assert.match(
    checkFrontendFile("window.$RefreshReg$ = 1", "dist/a.js").join(),
    /React refresh/,
  );
  assert.match(
    checkFrontendFile("fetch('http://localhost:5173/x')", "dist/a.js").join(),
    /dev server address/,
  );
});

test("Cargo defaults, tauri's devtools feature, build commands and the identifier are checked", () => {
  const cargo = (
    defaults,
    tauri = 'tauri = { version = "2", features = ["tray-icon"] }',
  ) =>
    `[features]\ndefault = [${defaults}]\nai-helper-stub = []\n\n[dependencies]\n${tauri}\n`;
  assert.deepEqual(checkCargoToml(cargo("")), []);
  assert.match(
    checkCargoToml(cargo('"ai-helper-stub"')).join(),
    /enables ai-helper-stub by default/,
  );
  assert.match(
    checkCargoToml(cargo('"cloud-ai", "x"')).join(),
    /enables cloud-ai by default/,
  );
  assert.match(
    checkCargoToml(
      cargo("", 'tauri = { version = "2", features = ["devtools"] }'),
    ).join(),
    /devtools feature/,
  );
  assert.deepEqual(
    checkBuildCommands("cargo build --release --features serde", "s"),
    [],
  );
  assert.match(
    checkBuildCommands("cargo build --features ai-helper-stub", "s.sh").join(),
    /s.sh builds with the ai-helper-stub feature/,
  );
  assert.match(
    checkBuildCommands("tauri build -F x,cloud-ai", "s").join(),
    /cloud-ai feature/,
  );
  assert.match(
    checkBuildCommands("cargo build --features=devtools", "s").join(),
    /devtools feature/,
  );
  assert.deepEqual(
    checkTauriConfig(
      JSON.stringify({ identifier: EXPECTED_APP_ID }),
      EXPECTED_APP_ID,
    ),
    [],
  );
  assert.match(
    checkTauriConfig(
      JSON.stringify({ identifier: "x.y" }),
      EXPECTED_APP_ID,
    ).join(),
    /identifier is x.y/,
  );
  assert.match(
    checkTauriConfig(
      JSON.stringify({
        identifier: EXPECTED_APP_ID,
        bundle: { android: { debugApplicationIdSuffix: ".debug" } },
      }),
      EXPECTED_APP_ID,
    ).join(),
    /debugApplicationIdSuffix/,
  );
  assert.match(
    checkTauriConfig("not json", EXPECTED_APP_ID).join(),
    /not JSON/,
  );
});

test("the repository's own configuration passes the source check", async () => {
  assert.deepEqual(await run(["--source"]), []);
});

test("run reads real files: an APK, an IPA, a frontend folder, a manifest and a made-up source tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mycarlos-release-safety-"));
  try {
    const goodApk = join(directory, "good.apk");
    const debugApk = join(directory, "debug.apk");
    await writeFile(goodApk, apk());
    await writeFile(
      debugApk,
      apk([
        ["manifest", { package: EXPECTED_APP_ID }],
        ["application", { allowBackup: false, debuggable: true }],
      ]),
    );
    assert.deepEqual(await run(["--android", goodApk]), []);
    assert.match(
      (await run(["--android", debugApk])).join(),
      /debuggable is true/,
    );
    const manifestXml = join(directory, "AndroidManifest.xml");
    await writeFile(
      manifestXml,
      `<manifest package="${EXPECTED_APP_ID}"><application android:allowBackup="false" android:usesCleartextTraffic="true"/></manifest>`,
    );
    assert.match(
      (await run(["--android", manifestXml])).join(),
      /cleartext traffic is allowed/,
    );
    const ipa = join(directory, "a.ipa");
    await writeFile(
      ipa,
      zip([
        ["Payload/a.app/Info.plist", Buffer.from(INFO())],
        [
          "Payload/a.app/embedded.mobileprovision",
          Buffer.from(PROFILE("<key>get-task-allow</key><true/>"), "latin1"),
        ],
        ["Payload/a.app/mycarlos", Buffer.from("x")],
      ]),
    );
    assert.match((await run(["--ios", ipa])).join(), /get-task-allow is true/);
    const app = join(directory, "myCarlos.app");
    await mkdir(app);
    await writeFile(join(app, "Info.plist"), INFO());
    await writeFile(
      join(app, "embedded.mobileprovision"),
      Buffer.from(PROFILE(), "latin1"),
    );
    await writeFile(join(app, "mycarlos"), "release code");
    assert.deepEqual(await run(["--ios", app]), []);
    const dist = join(directory, "dist");
    await mkdir(dist);
    await writeFile(join(dist, "index.js"), "console.log(1)");
    assert.deepEqual(await run(["--dist", dist]), []);
    await writeFile(join(dist, "dev.js"), 'import "/@vite/client"');
    assert.match((await run(["--dist", dist])).join(), /the Vite client/);
    assert.match(
      (await run(["--dist", join(directory, "empty-missing")])).join(),
      /cannot be inspected/,
    );
    // Another id is a deliberate change, passed in.
    assert.match(
      (
        await run(["--android", goodApk, "--app-id", "ca.example.other"])
      ).join(),
      /applicationId is/,
    );

    const root = join(directory, "tree");
    await mkdir(join(root, "src-tauri"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await writeFile(
      join(root, "src-tauri/Cargo.toml"),
      '[features]\ndefault = ["cloud-ai"]\n[dependencies]\ntauri = { version = "2", features = ["devtools"] }\n',
    );
    await writeFile(
      join(root, "src-tauri/tauri.conf.json"),
      JSON.stringify({ identifier: "other.id" }),
    );
    await writeFile(
      join(root, "scripts/build-android-release.sh"),
      "npm run tauri android build -- --features ai-helper-stub\n",
    );
    await writeFile(
      join(root, ".github/workflows/mycarlos-ios-release.yml"),
      "run: cargo build -F cloud-ai\n",
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          "android:release":
            "bash scripts/build-android-release.sh --features devtools",
        },
      }),
    );
    const found = (await run(["--source"], root)).join("\n");
    for (const expected of [
      /enables cloud-ai by default/,
      /tauri's devtools feature/,
      /identifier is other.id/,
      /build-android-release.sh builds with the ai-helper-stub/,
      /mycarlos-ios-release.yml builds with the cloud-ai/,
      /package.json script android:release builds with the devtools/,
    ]) {
      assert.match(found, expected);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("with nothing to check it fails rather than passes", async () => {
  assert.match((await run([])).join(), /nothing to check/);
  assert.match((await run(["--android"])).join(), /--android needs a path/);
  assert.match(
    (await run(["--android", "/nonexistent/file.apk"])).join(),
    /cannot be inspected/,
  );
});

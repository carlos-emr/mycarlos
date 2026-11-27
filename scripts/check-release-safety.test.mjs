import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  elfDebugSections,
  iosFilesFromIpa,
} from "./release-safety/checks.mjs";
import { checkCargoConfig, parseToml } from "./release-safety/cargo.mjs";
import { readZip } from "./release-safety/zip.mjs";
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
  const ANDROID = "http://schemas.android.com/apk/res/android";
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
    entries.forEach(([rawKey, value], i) => {
      const at = 36 + i * 20;
      const android = rawKey.startsWith("android:");
      const key = android ? rawKey.slice(8) : rawKey;
      body.writeUInt32LE(android ? index(ANDROID) : 0xffffffff, at);
      body.writeUInt32LE(index(key), at + 4);
      body.writeUInt32LE(0xffffffff, at + 8);
      body.writeUInt16LE(8, at + 12);
      if (value && value.reference) {
        body[at + 15] = 0x01;
        body.writeUInt32LE(0x7f010001, at + 16);
      } else if (typeof value === "boolean") {
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
    ...Object.entries(attrs).map(([rawKey, value]) => {
      const android = rawKey.startsWith("android:");
      return field(
        4,
        Buffer.concat([
          ...(android
            ? [field(1, "http://schemas.android.com/apk/res/android")]
            : []),
          field(2, android ? rawKey.slice(8) : rawKey),
          field(3, String(value)),
        ]),
      );
    }),
    ...children.map((child) => field(5, protoNode(child))),
  ]);
  return field(1, element);
}

/** ELF magic and a header with no section table (an ELF the gate cannot read). */
const rawElf = (...extra) =>
  Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]),
    Buffer.alloc(57),
    ...extra.map((e) => Buffer.from(e)),
  ]);

/** A little-endian ELF64 whose section header table names `sections` (after the null one). */
function elfWithSections(sections) {
  const names = Buffer.from(`\0${sections.join("\0")}\0.shstrtab\0`);
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  const count = sections.length + 2;
  const tableAt = 64 + names.length;
  header.writeBigUInt64LE(BigInt(tableAt), 40);
  header.writeUInt16LE(64, 58);
  header.writeUInt16LE(count, 60);
  header.writeUInt16LE(count - 1, 62);
  const table = Buffer.alloc(count * 64);
  let nameAt = 1;
  [...sections, ".shstrtab"].forEach((name, i) => {
    const at = (i + 1) * 64;
    table.writeUInt32LE(nameAt, at);
    if (i === sections.length) table.writeBigUInt64LE(64n, at + 24);
    nameAt += name.length + 1;
  });
  return Buffer.concat([header, names, table]);
}

/** A readable, stripped little-endian ELF64 library, with any extra text after it. */
const elf = (...extra) =>
  Buffer.concat([
    elfWithSections([".text", ".dynsym"]),
    ...extra.map((e) => Buffer.from(e)),
  ]);

const GOOD_MANIFEST = [
  ["manifest", { package: EXPECTED_APP_ID }],
  [
    "application",
    { "android:allowBackup": false, "android:debuggable": false },
  ],
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
    decodePlainXml(`<?xml version="1.0"?><manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${EXPECTED_APP_ID}">
    <!-- <application android:debuggable="true"> --><application android:allowBackup="false" android:debuggable="false"/></manifest>`);
  const binary = decodeBinaryXml(axml(GOOD_MANIFEST));
  const proto = decodeProtoXml(
    protoNode([
      "manifest",
      { package: EXPECTED_APP_ID },
      [
        [
          "application",
          { "android:allowBackup": "false", "android:debuggable": "false" },
        ],
      ],
    ]),
  );
  const flat = (elements) =>
    elements
      .map((e) =>
        [e.name, e.attrs.package ?? e.attrs["android:allowBackup"] ?? ""].join(
          ":",
        ),
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
    bad({ "android:allowBackup": false, "android:debuggable": true }),
    /debuggable is true/,
  );
  assert.match(
    bad({ "android:allowBackup": false, "android:testOnly": true }),
    /testOnly is true/,
  );
  assert.match(
    bad({ "android:allowBackup": false, "android:usesCleartextTraffic": true }),
    /usesCleartextTraffic is true/,
  );
  assert.match(
    bad({ "android:allowBackup": true }),
    /allowBackup is not false/,
  );
  assert.match(bad({}), /allowBackup is not false/);
  assert.match(
    bad({ "android:allowBackup": false }, `${EXPECTED_APP_ID}.debug`),
    /applicationId is .*\.debug; it must be/,
  );
  assert.match(
    bad({ "android:allowBackup": false }, "com.example.other"),
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
    [
      "application",
      { "android:allowBackup": false, "android:debuggable": true },
    ],
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
        ["base-config", { "android:cleartextTrafficPermitted": true }],
      ]),
    ],
  ]);
  assert.match(
    checkAndroidArchive(permissive, "p.apk", EXPECTED_APP_ID).join(),
    /base-config cleartextTrafficPermitted is true/,
  );
  const strict = apk(GOOD_MANIFEST, [
    [
      "res/xml/network_security_config.xml",
      axml([["base-config", { "android:cleartextTrafficPermitted": false }]]),
    ],
  ]);
  assert.deepEqual(checkAndroidArchive(strict, "s.apk", EXPECTED_APP_ID), []);
  const aab = zip([
    [
      "base/manifest/AndroidManifest.xml",
      protoNode([
        "manifest",
        { package: EXPECTED_APP_ID },
        [["application", { "android:allowBackup": "false" }]],
      ]),
    ],
    [
      "base/res/xml/nsc.xml",
      protoNode([
        "domain-config",
        { "android:cleartextTrafficPermitted": "true" },
      ]),
    ],
    ["base/lib/arm64-v8a/libmycarlos.so", elf("release")],
  ]);
  assert.match(
    checkAndroidArchive(aab, "x.aab", EXPECTED_APP_ID).join(),
    /domain-config cleartextTrafficPermitted is true/,
  );
});

const releaseConfig = [
  ["network-security-config", {}],
  ["base-config", { "android:cleartextTrafficPermitted": false }],
  ["trust-anchors", {}],
  ["certificates", { src: "system" }],
];

test("a network security config that trusts the system's authorities only is accepted", () => {
  const good = apk(GOOD_MANIFEST, [
    ["res/xml/network_security_config.xml", axml(releaseConfig)],
  ]);
  assert.deepEqual(checkAndroidArchive(good, "g.apk", EXPECTED_APP_ID), []);
});

test("debug-overrides, user authorities and bundled authorities in a network security config are found", () => {
  const found = (elements) =>
    checkAndroidArchive(
      apk(GOOD_MANIFEST, [
        ["res/xml/network_security_config.xml", axml(elements)],
      ]),
      "b.apk",
      EXPECTED_APP_ID,
    ).join("\n");
  // The debug build's test root.
  assert.match(
    found([
      ...releaseConfig,
      ["debug-overrides", {}],
      ["trust-anchors", {}],
      ["certificates", { src: "system" }],
    ]),
    /debug-overrides is present/,
  );
  // A user-installed authority.
  assert.match(
    found([
      ["network-security-config", {}],
      ["base-config", { "android:cleartextTrafficPermitted": false }],
      ["trust-anchors", {}],
      ["certificates", { src: "user" }],
    ]),
    /certificates src is "user"/,
  );
  // One that is left out of src altogether, and one named by anything but "system".
  assert.match(found([["certificates", {}]]), /certificates src is missing/);
  assert.match(
    found([["certificates", { src: "@raw/ca" }]]),
    /certificates src is "@raw\/ca"/,
  );
  // Inside a domain-config too, wherever it is.
  assert.match(
    found([
      ["domain-config", { "android:cleartextTrafficPermitted": false }],
      ["trust-anchors", {}],
      ["certificates", { src: "user" }],
    ]),
    /certificates src is "user"/,
  );
});

test("the same refusals hold in a bundle (protobuf XML)", () => {
  const aab = zip([
    [
      "base/manifest/AndroidManifest.xml",
      protoNode([
        "manifest",
        { package: EXPECTED_APP_ID },
        [["application", { "android:allowBackup": "false" }]],
      ]),
    ],
    [
      "base/res/xml/mycarlos_network_security_config.xml",
      protoNode([
        "network-security-config",
        {},
        [
          [
            "debug-overrides",
            {},
            [["trust-anchors", {}, [["certificates", { src: "user" }]]]],
          ],
        ],
      ]),
    ],
    ["base/lib/arm64-v8a/libmycarlos.so", elf("release")],
  ]);
  const problems = checkAndroidArchive(aab, "x.aab", EXPECTED_APP_ID).join(
    "\n",
  );
  assert.match(problems, /debug-overrides is present/);
  assert.match(problems, /certificates src is "user"/);
});

test("a certificate file among the resources is found, by name or by its PEM marker", () => {
  const withFile = (name, bytes) =>
    checkAndroidArchive(
      apk(GOOD_MANIFEST, [[name, bytes]]),
      "c.apk",
      EXPECTED_APP_ID,
    ).join("\n");
  assert.match(
    withFile("res/raw/mycarlos_test_ca.der", Buffer.from([0x30, 0x82, 1, 2])),
    /a certificate file is in the resources/,
  );
  assert.match(
    withFile("base/res/raw/ca.pem", Buffer.from("x")),
    /a certificate file is in the resources/,
  );
  assert.match(
    withFile(
      "res/raw/root",
      Buffer.from(
        "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
      ),
    ),
    /a PEM certificate is in the resources/,
  );
  // An ordinary resource is not a certificate.
  assert.equal(withFile("res/raw/sound", Buffer.from("not a certificate")), "");
});

test("a shortened resource path does not hide a network security config", () => {
  // `res/Ab.xml`, `res/xml/..`, `base/res/Zz.xml`: the folder says nothing once paths are shortened.
  for (const name of ["res/Ab.xml", "res/xml/x.xml", "base/res/Zz.xml"]) {
    const found = checkAndroidArchive(
      apk(GOOD_MANIFEST, [
        [
          name,
          axml([
            ["network-security-config", {}],
            ["base-config", { "android:cleartextTrafficPermitted": true }],
            ["debug-overrides", {}],
            ["certificates", { src: "user" }],
          ]),
        ],
      ]),
      "s.apk",
      EXPECTED_APP_ID,
    ).join("\n");
    assert.match(found, /cleartextTrafficPermitted is true/, name);
    assert.match(found, /debug-overrides is present/, name);
    assert.match(found, /certificates src is "user"/, name);
  }
});

test("the test certificates are found anywhere in a build, as DER or as base64", () => {
  const der = Buffer.concat([
    Buffer.from([0x30, 0x82, 1, 0]),
    Buffer.alloc(80, 7),
  ]);
  const options = { forbiddenCertificates: [der] };
  const found = (entries) =>
    checkAndroidArchive(
      apk(GOOD_MANIFEST, entries),
      "t.apk",
      EXPECTED_APP_ID,
      options,
    ).join("\n");
  // As a file under any name, in an asset, and in the middle of other data.
  assert.match(
    found([["res/Qx", der]]),
    /res\/Qx: holds a test certificate \(DER\)/,
  );
  assert.match(
    found([
      [
        "assets/ca-bundle",
        Buffer.concat([Buffer.from("xx"), der, Buffer.from("yy")]),
      ],
    ]),
    /assets\/ca-bundle: holds a test certificate \(DER\)/,
  );
  assert.match(
    found([
      [
        "classes.dex",
        Buffer.concat([
          Buffer.from("dex"),
          Buffer.from(der.toString("base64")),
        ]),
      ],
    ]),
    /classes.dex: holds a test certificate \(base64\)/,
  );
  // In a library too (the apk helper adds its own).
  assert.match(
    found([
      ["lib/arm64-v8a/libother.so", Buffer.concat([elf("release"), der])],
    ]),
    /libother.so: holds a test certificate/,
  );
  // And a build without it is clean.
  assert.equal(found([["assets/readme", Buffer.from("nothing")]]), "");
  // Not asking for the search finds nothing (the bytes are only a problem when they are the test ones).
  assert.deepEqual(
    checkAndroidArchive(
      apk(GOOD_MANIFEST, [["res/Qx", der]]),
      "t.apk",
      EXPECTED_APP_ID,
    ),
    [],
  );
});

test("a compiled XML with a shortened name and no extension is still read, by its header", () => {
  const config = axml([
    ["network-security-config", {}],
    ["base-config", { "android:cleartextTrafficPermitted": true }],
    ["debug-overrides", {}],
    ["certificates", { src: "user" }],
  ]);
  for (const name of ["res/Ab", "res/q/Zz", "res/xml/nsc"]) {
    const found = checkAndroidArchive(
      apk(GOOD_MANIFEST, [[name, config]]),
      "n.apk",
      EXPECTED_APP_ID,
    ).join("\n");
    assert.match(found, /cleartextTrafficPermitted is true/, name);
    assert.match(found, /debug-overrides is present/, name);
  }
  // A resource that is not XML is not read as one (a png, a font, text).
  assert.deepEqual(
    checkAndroidArchive(
      apk(GOOD_MANIFEST, [
        ["res/Ab", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0])],
        ["res/Cd", Buffer.from("plain text")],
      ]),
      "n.apk",
      EXPECTED_APP_ID,
    ),
    [],
  );
});

test("a test certificate pasted as wrapped PEM text is found by a run of its base64", () => {
  const der = Buffer.concat([
    Buffer.from([0x30, 0x82, 1, 0]),
    Buffer.from(Array.from({ length: 200 }, (_, i) => (i * 37 + 11) % 256)),
  ]);
  const base64 = der.toString("base64");
  const wrapped = (width) =>
    `-----BEGIN CERTIFICATE-----\n${base64.match(new RegExp(`.{1,${width}}`, "g")).join("\n")}\n-----END CERTIFICATE-----\n`;
  for (const width of [64, 76]) {
    const found = checkAndroidArchive(
      apk(GOOD_MANIFEST, [["assets/pasted.txt", Buffer.from(wrapped(width))]]),
      "w.apk",
      EXPECTED_APP_ID,
      { forbiddenCertificates: [der] },
    ).join("\n");
    assert.match(found, /assets\/pasted.txt: holds a test certificate/, width);
  }
  // With its first line cut off, the run from the middle still finds it.
  const withoutFirstLine = wrapped(64).split("\n").slice(2).join("\n");
  assert.match(
    checkAndroidArchive(
      apk(GOOD_MANIFEST, [["assets/cut.txt", Buffer.from(withoutFirstLine)]]),
      "w.apk",
      EXPECTED_APP_ID,
      { forbiddenCertificates: [der] },
    ).join("\n"),
    /assets\/cut.txt: holds a test certificate/,
  );
  // Text that is only a different certificate's PEM is not it.
  const other = Buffer.concat([der.subarray(0, 4), Buffer.alloc(200, 9)]);
  assert.deepEqual(
    checkAndroidArchive(
      apk(GOOD_MANIFEST, [
        ["assets/other.txt", Buffer.from(other.toString("base64"))],
      ]),
      "w.apk",
      EXPECTED_APP_ID,
      { forbiddenCertificates: [der] },
    ),
    [],
  );
});

test("the repository's test certificates are searched for in a real run of the gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mycarlos-release-safety-"));
  try {
    const fixture = await readFile(
      new URL(
        "../src-tauri/tests/fixtures/portal-test-pki/ca.der.b64",
        import.meta.url,
      ),
      "utf8",
    );
    const der = Buffer.from(fixture.trim(), "base64");
    const leaky = join(directory, "leaky.apk");
    await writeFile(leaky, apk(GOOD_MANIFEST, [["assets/x", der]]));
    assert.match(
      (await run(["--android", leaky])).join(),
      /holds a test certificate/,
    );
    const clean = join(directory, "clean.apk");
    await writeFile(clean, apk());
    assert.deepEqual(await run(["--android", clean]), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  // Symbols are read from the ELF section headers, not guessed from text in the file.
  assert.match(
    checkBinary(elfWithSections([".text", ".symtab"]), "lib.so").join(),
    /not stripped \(\.symtab/,
  );
  assert.match(
    checkBinary(
      elfWithSections([".debug_info", ".debug_line"]),
      "lib.so",
    ).join(),
    /not stripped \(\.debug_info/,
  );
  assert.deepEqual(
    checkBinary(elfWithSections([".text", ".dynsym"]), "lib.so"),
    [],
  );
  // A string constant that says ".symtab" in a stripped library with section headers is fine.
  assert.deepEqual(
    checkBinary(elf(".symtab and .debug_info as plain text"), "lib.so"),
    [],
  );
  assert.deepEqual(
    checkBinary(Buffer.from(".symtab and .debug_info text"), "notes.txt"),
    [],
  );
  assert.deepEqual(elfDebugSections(Buffer.alloc(10)), []);
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

test("the push environment of a release build is production: development is refused, production is not", () => {
  const withPush = (value, extra = "") =>
    iosFiles({
      profile: PROFILE(
        `<key>get-task-allow</key><false/><key>aps-environment</key><string>${value}</string>${extra}`,
      ),
    });
  // A store build's profile grants the production push service.
  assert.deepEqual(
    checkIosApp(withPush("production"), "store.app", EXPECTED_APP_ID),
    [],
  );
  // A development grant in a release build is its own finding, whatever else the profile holds.
  const findings = checkIosApp(
    withPush("development"),
    "store.app",
    EXPECTED_APP_ID,
  );
  assert.deepEqual(findings, ["store.app: aps-environment is development"]);
  assert.match(
    checkIosApp(
      withPush(
        "development",
        "<key>com.apple.developer.team-identifier</key><string>FAKE</string>",
      ),
      "store.app",
      EXPECTED_APP_ID,
    ).join(),
    /aps-environment is development/,
  );
});

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
        [
          "application",
          { "android:allowBackup": false, "android:debuggable": true },
        ],
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
      /usesCleartextTraffic is true/,
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
      /dependency tauri .* enables the devtools feature/,
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

// ---- the review's false passes (#432), each with the probe that reproduced it ----

const cargoWith = (body) => checkCargoToml(body);

test("the Cargo default features are read from the [features] table wherever it is, and followed through the graph", () => {
  // C.1: [features] after [dependencies] used to pass.
  assert.match(
    cargoWith(
      '[dependencies]\nserde = "1"\n\n[features]\ndefault = ["ai-helper-stub"]\nai-helper-stub = []\n',
    ).join(),
    /enables ai-helper-stub by default/,
  );
  // C.2: through another feature, and through a dependency's feature.
  assert.match(
    cargoWith(
      '[features]\ndefault = ["dev"]\ndev = ["ai-helper-stub"]\nai-helper-stub = []\n',
    ).join(),
    /enables ai-helper-stub by default \(through ai-helper-stub\)|enables ai-helper-stub by default/,
  );
  assert.match(
    cargoWith('[features]\ndefault = ["tauri/devtools"]\n').join(),
    /enables devtools by default \(through tauri\/devtools\)/,
  );
  assert.match(
    cargoWith(
      '[features]\ndefault = ["a"]\na = ["b"]\nb = ["c?/cloud-ai"]\n',
    ).join(),
    /cloud-ai by default/,
  );
  // C.3: the dependency as its own table, and per target.
  assert.match(
    cargoWith(
      '[dependencies.tauri]\nversion = "2"\nfeatures = ["tray-icon", "devtools"]\n',
    ).join(),
    /dependency tauri \(dependencies\) enables the devtools feature/,
  );
  assert.match(
    cargoWith(
      '[target.\'cfg(windows)\'.dependencies]\ntauri = { version = "2", features = ["devtools"] }\n',
    ).join(),
    /dependency tauri \(target\.cfg\(windows\)\.dependencies\) enables the devtools feature/,
  );
  // Not a finding: a dev-dependency, and a feature that is only defined, not on by default.
  assert.deepEqual(
    cargoWith(
      '[features]\ndefault = []\nai-helper-stub = []\n[dev-dependencies]\ntauri = { version = "2", features = ["devtools"] }\n',
    ),
    [],
  );
  assert.match(
    cargoWith("[features\ndefault = []").join(),
    /Cargo.toml cannot be read/,
  );
});

test("the small TOML reader handles the shapes Cargo.toml uses", () => {
  const parsed = parseToml(`# comment
[package]
name = "x" # trailing
[features]
default = [
  "a", # one
  "b",
]
a = []
[dependencies]
serde = "1"
tauri = { version = "2", features = ["x", "y"], default-features = false }
[dependencies.wry]
version = '0.1'
[[bin]]
name = "one"
[[bin]]
name = "two"
[target.'cfg(windows)'.dependencies]
windows = { version = "0.6" }
`);
  assert.deepEqual(parsed.features.default, ["a", "b"]);
  assert.deepEqual(parsed.dependencies.tauri.features, ["x", "y"]);
  assert.equal(parsed.dependencies.wry.version, "0.1");
  assert.deepEqual(
    parsed.bin.map((b) => b.name),
    ["one", "two"],
  );
  assert.equal(
    parsed.target["cfg(windows)"].dependencies.windows.version,
    "0.6",
  );
  assert.throws(() => parseToml("x = [1, 2"), /TOML/);
  assert.throws(() => parseToml('x = "open'), /TOML/);
});

test("build commands are tokenised: every way to turn the stub on is found, and a test or lint is not", () => {
  const found = (text) => checkBuildCommands(text, "c").join("|");
  // C.4
  assert.match(found("cargo build -Fai-helper-stub"), /ai-helper-stub feature/);
  assert.match(
    found('cargo build --features "tray-icon ai-helper-stub"'),
    /ai-helper-stub feature/,
  );
  assert.match(
    found("cargo build --features \\\n  ai-helper-stub"),
    /ai-helper-stub feature/,
  );
  assert.match(
    found("cargo build --features=a,ai-helper-stub"),
    /ai-helper-stub feature/,
  );
  assert.match(
    found("tauri build -- --features tray-icon,cloud-ai"),
    /cloud-ai feature/,
  );
  assert.match(found("cargo build --all-features"), /--all-features/);
  assert.match(found("cargo ndk build -F devtools"), /devtools feature/);
  assert.match(
    found("cargo build --cfg 'feature=\"ai-helper-stub\"'"),
    /with --cfg/,
  );
  // Tests, lints and checks may use the stub (CI does).
  assert.deepEqual(
    found("cargo test --locked --features ai-helper-stub -- --test-threads=1"),
    "",
  );
  assert.deepEqual(
    found(
      "cargo clippy --all-targets --features ai-helper-stub -- -D warnings",
    ),
    "",
  );
  assert.deepEqual(found("cargo check --all-features"), "");
  // A folded YAML step is still one command; the next step is another.
  const yaml =
    "      - run: >-\n          cargo clippy --manifest-path a\n          --features ai-helper-stub\n      - run: cargo build --features ai-helper-stub\n";
  assert.match(found(yaml), /ai-helper-stub feature/);
  assert.equal(found(yaml).split("|").length, 1);
  // The same through a cargo alias.
  assert.match(
    checkCargoConfig(
      '[alias]\nship = "build --release --features cloud-ai"\nok = "test --features ai-helper-stub"\n',
    ).join(),
    /alias ship builds with the cloud-ai/,
  );
  assert.deepEqual(
    checkCargoConfig('[alias]\nok = "test --features ai-helper-stub"\n'),
    [],
  );
});

test("tauri.conf.json build.features and its build commands are read", () => {
  // C.5
  assert.match(
    checkTauriConfig(
      JSON.stringify({
        identifier: EXPECTED_APP_ID,
        build: { features: ["ai-helper-stub"] },
      }),
      EXPECTED_APP_ID,
    ).join(),
    /build.features enables ai-helper-stub/,
  );
  assert.match(
    checkTauriConfig(
      JSON.stringify({
        identifier: EXPECTED_APP_ID,
        build: {
          beforeBuildCommand:
            "npm run build -- && cargo build --features devtools",
        },
      }),
      EXPECTED_APP_ID,
    ).join(),
    /build.beforeBuildCommand builds with the devtools feature/,
  );
  assert.deepEqual(
    checkTauriConfig(
      JSON.stringify({
        identifier: EXPECTED_APP_ID,
        build: { features: [], beforeBuildCommand: "npm run build" },
      }),
      EXPECTED_APP_ID,
    ),
    [],
  );
  assert.match(
    checkTauriConfig(
      JSON.stringify({ identifier: EXPECTED_APP_ID, build: { features: "x" } }),
      EXPECTED_APP_ID,
    ).join(),
    /not a list/,
  );
});

test("every script, workflow and package script is read, whatever it is called, and none is skipped silently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mycarlos-release-sources-"));
  try {
    const empty = await run(["--source"], directory);
    assert.match(empty.join("\n"), /src-tauri\/Cargo.toml not found/);
    assert.match(empty.join("\n"), /package.json not found/);
    assert.match(
      empty.join("\n"),
      /no package scripts, workflows or shell scripts were found|package.json not found/,
    );
    await mkdir(join(directory, "src-tauri"), { recursive: true });
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, ".github/workflows"), { recursive: true });
    await writeFile(
      join(directory, "src-tauri/Cargo.toml"),
      "[features]\ndefault = []\n",
    );
    await writeFile(
      join(directory, "src-tauri/tauri.conf.json"),
      JSON.stringify({ identifier: EXPECTED_APP_ID }),
    );
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        scripts: {
          "build:ios": "tauri ios build -- --features ai-helper-stub",
          "test:rust": "cargo test --features ai-helper-stub",
        },
      }),
    );
    await writeFile(
      join(directory, "scripts/build-ios.sh"),
      "cargo build --all-features\n",
    );
    await writeFile(
      join(directory, ".github/workflows/ios-testflight.yml"),
      "jobs:\n  a:\n    steps:\n      - run: cargo build -F cloud-ai\n",
    );
    const found = (await run(["--source"], directory)).join("\n");
    assert.match(
      found,
      /package.json script build:ios builds with the ai-helper-stub/,
    );
    assert.doesNotMatch(found, /test:rust/);
    assert.match(found, /scripts\/build-ios.sh builds with --all-features/);
    assert.match(found, /ios-testflight.yml builds with the cloud-ai/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a reference, an entity or a tools override cannot hide a debug or cleartext setting", () => {
  const verdict = (elements) =>
    checkAndroidManifest(elements, EXPECTED_APP_ID).join("|");
  const app = (attrs) => [
    ["manifest", { package: EXPECTED_APP_ID }],
    ["application", { "android:allowBackup": "false", ...attrs }],
  ];
  // C.8: a resource reference is unknown, so it is refused (plain XML, binary XML and protobuf XML).
  const plain = decodePlainXml(
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${EXPECTED_APP_ID}"><application android:allowBackup="false" android:debuggable="@bool/is_debug"/></manifest>`,
  );
  assert.match(
    verdict(plain),
    /debuggable is @bool\/is_debug \(not literally false/,
  );
  const binary = decodeBinaryXml(
    axml([
      ["manifest", { package: EXPECTED_APP_ID }],
      [
        "application",
        {
          "android:allowBackup": false,
          "android:debuggable": { reference: true },
        },
      ],
    ]),
  );
  assert.match(verdict(binary), /debuggable is @\d+ \(not literally false/);
  const proto = decodeProtoXml(
    protoNode([
      "manifest",
      { package: EXPECTED_APP_ID },
      [
        [
          "application",
          {
            "android:allowBackup": "false",
            "android:usesCleartextTraffic": "@bool/c",
          },
        ],
      ],
    ]),
  );
  assert.match(verdict(proto), /usesCleartextTraffic is @bool\/c/);
  // An entity spelling of true is decoded, then refused.
  const entity = decodePlainXml(
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${EXPECTED_APP_ID}"><application android:allowBackup="false" android:debuggable="&#116;rue"/></manifest>`,
  );
  assert.match(verdict(entity), /debuggable is true/);
  // tools:debuggable="false" after android:debuggable="true" no longer overwrites it.
  const override = decodePlainXml(
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools" package="${EXPECTED_APP_ID}"><application android:allowBackup="false" android:debuggable="true" tools:debuggable="false"/></manifest>`,
  );
  assert.match(verdict(override), /debuggable is true/);
  // A ">" inside an attribute value keeps the element's attributes.
  const gt = decodePlainXml(
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${EXPECTED_APP_ID}"><application android:label="a > b" android:allowBackup="false" android:debuggable="true"/></manifest>`,
  );
  assert.match(verdict(gt), /debuggable is true/);
  assert.deepEqual(verdict(decodeBinaryXml(axml(app({})))), "");
  assert.match(
    verdict(decodeBinaryXml(axml(app({ "android:testOnly": "1" })))),
    /testOnly is 1 \(not literally false/,
  );
});

test("hostile or damaged input is bounded: no hang, no unbounded inflate, no silent empty names", async () => {
  // B: the plain XML scanner is linear; an unterminated tag with 100,000 spaces ends at once.
  const started = Date.now();
  assert.throws(
    () => decodePlainXml(`<a${" ".repeat(100_000)}`),
    /unterminated XML tag/,
  );
  assert.throws(
    () => decodePlainXml(`<a ${'x="1" '.repeat(10)}`),
    /unterminated XML tag/,
  );
  assert.ok(Date.now() - started < 1000, "no cubic backtracking");
  assert.throws(() => decodePlainXml("<a>".repeat(400_000)), /larger than/);
  assert.throws(() => decodePlainXml("<a b>"), /has no value/);
  assert.throws(() => decodePlainXml("<a b=c>"), /not quoted/);
  // The inflate bound: an entry that inflates past the limit is refused.
  const { deflateRawSync } = await import("node:zlib");
  const packed = deflateRawSync(Buffer.alloc(1 << 20));
  const archive = (() => {
    const name = Buffer.from("big.bin");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt16LE(name.length, 28);
    const central = Buffer.concat([header, name]);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(30 + name.length + packed.length, 16);
    return Buffer.concat([local, name, packed, central, end]);
  })();
  assert.equal(readZip(archive).read("big.bin").length, 1 << 20);
  assert.throws(
    () => readZip(archive, { maxEntryBytes: 1 << 16 }).read("big.bin"),
    /Cannot create a Buffer larger|maxOutputLength|larger than/,
  );
  assert.throws(
    () =>
      readZip(
        Buffer.concat([
          archive.subarray(0, 0),
          Buffer.from(
            "PK\u0003\u0004 not a zip at all and long enough to search through",
          ),
        ]),
      ),
    /not a zip/,
  );
  // A name or string index outside the string pool is an error, not "".
  const good = axml(GOOD_MANIFEST);
  const broken = Buffer.from(good);
  // The first element chunk follows the string pool: point its name at a string that does not exist.
  const poolSize = broken.readUInt32LE(8 + 4);
  broken.writeUInt32LE(0x0000ffff, 8 + poolSize + 16 + 4);
  assert.throws(() => decodeBinaryXml(broken), /outside the string pool/);
  // Protobuf: a truncated field and a runaway varint are errors.
  assert.throws(
    () => decodeProtoXml(Buffer.from([0x0a, 0x7f, 0x01])),
    /past the end/,
  );
  assert.throws(
    () =>
      decodeProtoXml(
        Buffer.from([
          0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80,
          0x01,
        ]),
      ),
    /too long/,
  );
});

test("an ELF whose section table cannot be read, and a native library that is not an ELF, are refused (not passed)", () => {
  const refused = (bytes, options) =>
    checkBinary(bytes, "lib.so", options).join("|");
  assert.match(
    refused(rawElf()),
    /section headers cannot be read \(there is no section table\)/,
  );
  assert.match(
    refused(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])),
    /header is cut short/,
  );
  const bigEndian = Buffer.from(rawElf());
  bigEndian[5] = 2;
  assert.match(refused(bigEndian), /not a little-endian ELF/);
  const hugeOffset = Buffer.from(elf());
  hugeOffset.writeBigUInt64LE(0xffffffffffn, 40);
  assert.match(refused(hugeOffset), /past the end of the file/);
  const hugeCount = Buffer.from(elf());
  hugeCount.writeUInt16LE(0xffff, 60);
  assert.match(refused(hugeCount), /cannot be read/);
  const noNames = Buffer.from(elf());
  noNames.writeUInt16LE(0xfff0, 62);
  assert.match(refused(noNames), /name table is missing/);
  // ELF32 (armv7, i686) is read too.
  const elf32 = Buffer.alloc(52 + 40 * 2 + 16);
  elf32.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  elf32.writeUInt32LE(52 + 16, 32);
  elf32.writeUInt16LE(40, 46);
  elf32.writeUInt16LE(2, 48);
  elf32.writeUInt16LE(1, 50);
  elf32.write("\0.symtab\0", 52);
  elf32.writeUInt32LE(52, 52 + 16 + 40 + 16);
  assert.doesNotMatch(
    refused(elf32),
    /ELF section headers cannot be read \(the header/,
  );
  // A library file in an APK that is not an ELF at all is a finding; another kind of file is not asked to be one.
  assert.match(
    refused(Buffer.from("not an elf"), { expectElf: true }),
    /not an ELF file/,
  );
  assert.deepEqual(checkBinary(Buffer.from("plain notes"), "notes.txt"), []);
  const notElfLibrary = zip([
    ["AndroidManifest.xml", axml(GOOD_MANIFEST)],
    ["lib/arm64-v8a/libfake.so", Buffer.from("this is not an elf")],
  ]);
  assert.match(
    checkAndroidArchive(notElfLibrary, "n.apk", EXPECTED_APP_ID).join(),
    /not an ELF file/,
  );
});

test("features given through the shell cannot be checked and are refused", () => {
  const found = (text) => checkBuildCommands(text, "c").join("|");
  assert.match(found("tauri build --features $FEATURES"), /through the shell/);
  assert.match(
    found('cargo build --features "$(cat features.txt)"'),
    /through the shell/,
  );
  assert.match(found("cargo build -F `cat f`"), /through the shell/);
  assert.match(found("cargo build --features=${EXTRA}"), /through the shell/);
  assert.deepEqual(found("cargo test --features $FEATURES"), "");
  assert.deepEqual(found("cargo build --features serde"), "");
});

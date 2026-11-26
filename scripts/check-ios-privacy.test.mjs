import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  APS_ENVIRONMENT,
  checkEntitlements,
  checkInfoPlist,
  checkManifest,
  INFO_PLIST_PATH,
  MANIFEST_PATH,
  MINIMUM_REASONS,
  REQUIRED_APIS,
  run,
} from "./check-ios-privacy.mjs";

const manifest = () => readFile(MANIFEST_PATH, "utf8");

/** An entitlements plist as `codesign -d --entitlements :-` writes it. */
const entitlements = (environment, extra = "") =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${
    environment === null
      ? ""
      : `<key>aps-environment</key><string>${environment}</string>`
  }${extra}</dict></plist>`;

test("the repository's manifest and Info.ios.plist are as pinned", async () => {
  assert.deepEqual(await run([]), []);
});

test("the manifest declares no tracking and only the device identifier the portal keeps", async () => {
  const text = await manifest();
  assert.deepEqual(checkManifest(text), []);
  assert.match(
    checkManifest(
      text.replace(
        "<key>NSPrivacyTracking</key>\n\t<false/>",
        "<key>NSPrivacyTracking</key>\n\t<true/>",
      ),
    ).join(),
    /NSPrivacyTracking must be false/,
  );
  assert.match(
    checkManifest(
      text.replace(
        "<key>NSPrivacyTrackingDomains</key>\n\t<array/>",
        "<key>NSPrivacyTrackingDomains</key>\n\t<array><string>x.example</string></array>",
      ),
    ).join(),
    /TrackingDomains must be empty/,
  );
  // Dropping, adding or changing the collected type is refused until the pinned answer is changed too.
  const collected =
    /<key>NSPrivacyCollectedDataTypes<\/key>\s*<array>[\s\S]*?<\/array>\s*(?=<key>NSPrivacyAccessedAPITypes)/;
  assert.match(
    checkManifest(
      text.replace(
        collected,
        "<key>NSPrivacyCollectedDataTypes</key>\n\t<array/>\n\t",
      ),
    ).join(),
    /must declare the device identifier/,
  );
  assert.match(
    checkManifest(
      text.replace(
        "NSPrivacyCollectedDataTypeDeviceID",
        "NSPrivacyCollectedDataTypeHealth",
      ),
    ).join(),
    /must be NSPrivacyCollectedDataTypeDeviceID/,
  );
  assert.match(
    checkManifest(
      text.replace(
        "<key>NSPrivacyCollectedDataTypeLinked</key>\n\t\t\t<true/>",
        "<key>NSPrivacyCollectedDataTypeLinked</key>\n\t\t\t<false/>",
      ),
    ).join(),
    /Linked must be true/,
  );
  assert.match(
    checkManifest(
      text.replace(
        "<key>NSPrivacyCollectedDataTypeTracking</key>\n\t\t\t<false/>",
        "<key>NSPrivacyCollectedDataTypeTracking</key>\n\t\t\t<true/>",
      ),
    ).join(),
    /DataTypeTracking must be false/,
  );
  assert.match(
    checkManifest(
      text.replace(
        "NSPrivacyCollectedDataTypePurposeAppFunctionality",
        "NSPrivacyCollectedDataTypePurposeAnalytics",
      ),
    ).join(),
    /purposes must be exactly/,
  );
  const second = text.replace(
    "</array>\n\t<key>NSPrivacyAccessedAPITypes</key>",
    "<dict><key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeEmailAddress</string></dict></array>\n\t<key>NSPrivacyAccessedAPITypes</key>",
  );
  assert.match(checkManifest(second).join(), /exactly one type/);
});

test("every required-reason category needs a reason Apple lists for it", async () => {
  const text = await manifest();
  for (const category of Object.keys(REQUIRED_APIS)) {
    const without = text.replace(
      new RegExp(
        `<dict>\\s*<key>NSPrivacyAccessedAPIType</key>\\s*<string>${category}</string>[\\s\\S]*?</dict>`,
      ),
      "",
    );
    assert.match(
      checkManifest(without).join(),
      new RegExp(`${category} is not declared`),
    );
  }
  assert.match(
    checkManifest(text.replace("C617.1", "ZZZZ.9")).join(),
    /ZZZZ\.9 is not one Apple lists/,
  );
  // The reasons the code needs must all be there: dropping the document-picker reason (an import
  // reads the metadata of a picked file) is refused.
  for (const [category, needed] of Object.entries(MINIMUM_REASONS)) {
    for (const reason of needed) {
      const dropped = text.replace(
        new RegExp(`\\s*<string>${reason.replace(".", "\\.")}</string>`),
        "",
      );
      assert.match(
        checkManifest(dropped).join(),
        new RegExp(
          `${category}.*(must declare the reason ${reason.replace(".", "\\.")}|is not declared)`,
        ),
        `${category} ${reason}`,
      );
    }
  }
  assert.match(text, /3B52\.1/);
  // 85F4.1 (showing disk space to the person) is deliberately not declared: no message shows a
  // free-space figure.
  assert.doesNotMatch(text, /85F4\.1/);
  assert.match(
    checkManifest(
      text.replace(
        "NSPrivacyAccessedAPICategoryDiskSpace",
        "NSPrivacyAccessedAPICategoryActiveKeyboards",
      ),
    ).join(),
    /ActiveKeyboards is declared but not pinned/,
  );
});

test("a comment cannot stand in for a declaration", async () => {
  const text = await manifest();
  const commented = text.replace(
    /<key>NSPrivacyTracking<\/key>\s*<false\/>/,
    "<!-- <key>NSPrivacyTracking</key><false/> -->",
  );
  assert.match(
    checkManifest(commented).join(),
    /NSPrivacyTracking must be false/,
  );
  assert.match(checkManifest("not a plist").join(), /not a property list/);
});

test("the export key must be present and a boolean", async () => {
  assert.deepEqual(checkInfoPlist(await readFile(INFO_PLIST_PATH, "utf8")), []);
  assert.match(checkInfoPlist("<dict></dict>").join(), /missing/);
  assert.match(
    checkInfoPlist(
      "<dict><key>ITSAppUsesNonExemptEncryption</key><string>no</string></dict>",
    ).join(),
    /true or false/,
  );
  assert.match(
    checkInfoPlist(
      "<!-- <key>ITSAppUsesNonExemptEncryption</key><true/> -->",
    ).join(),
    /missing/,
  );
});

test("a built app must carry the repository's manifest at its root and the export key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mycarlos-ios-privacy-"));
  try {
    const app = join(directory, "myCarlos.app");
    await mkdir(app);
    assert.match((await run(["--app", app])).join(), /not at the bundle root/);
    await writeFile(join(app, "PrivacyInfo.xcprivacy"), await manifest());
    await writeFile(
      join(app, "Info.plist"),
      await readFile(INFO_PLIST_PATH, "utf8"),
    );
    // The signed entitlements come from a file here (on a Mac, from `codesign`).
    const signed = join(directory, "signed.plist");
    await writeFile(signed, entitlements("production"));
    const withSigned = [
      "--app",
      app,
      "--build",
      "release",
      "--entitlements",
      signed,
    ];
    assert.deepEqual(await run(withSigned), []);
    await writeFile(
      join(app, "PrivacyInfo.xcprivacy"),
      `${await manifest()}\n`,
    );
    assert.match((await run(withSigned)).join(), /differs from/);
    await writeFile(join(app, "PrivacyInfo.xcprivacy"), await manifest());
    await writeFile(join(app, "Info.plist"), "<dict></dict>");
    assert.match(
      (await run(withSigned)).join(),
      /ITSAppUsesNonExemptEncryption is missing/,
    );
    assert.match((await run(["--app"])).join(), /pass the built .app/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the manifest is copied into the one generated iOS app folder", async () => {
  const { appFolder, configureIosPrivacy } = await import(
    "./configure-ios-privacy.mjs"
  );
  const directory = await mkdtemp(join(tmpdir(), "mycarlos-ios-config-"));
  try {
    await mkdir(join(directory, "src-tauri/ios"), { recursive: true });
    await writeFile(
      join(directory, "src-tauri/ios/PrivacyInfo.xcprivacy"),
      await manifest(),
    );
    await assert.rejects(
      configureIosPrivacy({ root: directory, generate: false }),
      /tauri ios init/,
    );
    const apple = join(directory, "src-tauri/gen/apple");
    await mkdir(join(apple, "mycarlos_iOS"), { recursive: true });
    await mkdir(join(apple, "Sources"));
    await writeFile(join(apple, "project.yml"), "name: mycarlos\n");
    const target = await configureIosPrivacy({
      root: directory,
      generate: false,
    });
    assert.equal(target, join(apple, "mycarlos_iOS/PrivacyInfo.xcprivacy"));
    assert.equal(await readFile(target, "utf8"), await manifest());
    // Again: still the one copy.
    await configureIosPrivacy({ root: directory, generate: false });
    await mkdir(join(apple, "other_iOS"));
    await assert.rejects(
      appFolder(apple),
      /exactly one \*_iOS folder.*found 2/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** The `localStorage` get/set/remove calls in `text` whose key is not a named constant. */
export function unnamedStorageCalls(text) {
  const found = [];
  for (const call of text.matchAll(
    /localStorage\s*\.\s*(?:getItem|setItem|removeItem)\(\s*/g,
  )) {
    const rest = text.slice(call.index + call[0].length);
    if (!/^[A-Za-z_][\w.]*(?:\([^)]*\))?\s*[,)]/.test(rest))
      found.push(`${call[0]}${rest.slice(0, 30)}`);
  }
  return found;
}

test("a localStorage key typed at the call is found, and a named constant is not", () => {
  assert.equal(
    unnamedStorageCalls('window.localStorage.setItem("mycarlos.x.v1", "1")')
      .length,
    1,
  );
  assert.equal(
    unnamedStorageCalls("localStorage.getItem(`mycarlos.${name}`)").length,
    1,
  );
  assert.deepEqual(
    unnamedStorageCalls(
      "window.localStorage.setItem(STORAGE_KEY, v); localStorage.getItem(keyFor(scope))",
    ),
    [],
  );
});

// WKWebView keeps localStorage and IndexedDB under Library/WebKit, which an iOS backup takes: the
// backup exclusion of the app's data folder does not cover it (#422). Nothing about a person or a
// document may live there. This list is the review: a new key makes this test fail until it is read
// and added here with what it holds.
const REVIEWED_WEBVIEW_STORAGE = {
  "mycarlos.language.v1": "the interface language choice",
  "mycarlos.autoLockMinutes.v1": "the idle lock minutes",
  "mycarlos.appearance.v1": "theme and text size choice",
  "mycarlos.aiLabelShort.v1": "a preference for the AI label wording",
  "mycarlos.zoom.v1": "a zoom level",
  "mycarlos.videoQuality.v1": "the video quality choice",
  "mycarlos.cameraExplained.v1": "whether the camera notice was shown",
  "mycarlos.recoveryOfferHour.v1":
    "when the recovery-key offer was last made (a time)",
  "mycarlos.unfinishedRecoveryKey.v1":
    "when a recovery key setup began (times and a flag; no key)",
  "mycarlos.unfinishedHandover.v1":
    'a flag, "1", that a handover key was shown and not used (#360): no key, no person, no name; one per vault',
  "mycarlos.oldBackupsGuide.v1":
    "the step for older backups, a time and a size: NO file name (it can carry a person's name, and this storage is in iOS backups), pinned by src/native/oldBackups.test.ts",
};

test("the webview's own storage keys are the reviewed ones, and nothing else is used", async () => {
  const { execFileSync } = await import("node:child_process");
  const sources = execFileSync(
    "git",
    ["ls-files", "src", ":(exclude)*.test.ts", ":(exclude)*.test.tsx"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith("keys.ts"));
  const found = new Set();
  const unnamed = [];
  for (const file of sources) {
    const text = await readFile(file, "utf8");
    for (const key of text.matchAll(/"(mycarlos\.[A-Za-z]+\.v\d+)"/g))
      found.add(key[1]);
    // Every use of localStorage names its key by a constant (an identifier, such as
    // STORAGE_KEY or keyFor(scope)), never a string typed at the call: a key invented inline
    // would not be in the list above. The one computed key, unfinishedHandover's
    // "<constant>.<scope>", takes the vault slot's id as its suffix, an opaque random id that
    // names no person (see src/native/unfinishedHandover.ts). sessionStorage is not scanned:
    // it is not written to disk and does not outlive the app.
    unnamed.push(
      ...unnamedStorageCalls(text).map((call) => `${file}: ${call}`),
    );
    assert.doesNotMatch(
      text,
      /indexedDB|IDBFactory|caches\.open|document\.cookie/,
      file,
    );
  }
  assert.deepEqual(unnamed, [], "a localStorage key must be a named constant");
  assert.deepEqual(
    [...found].sort(),
    Object.keys(REVIEWED_WEBVIEW_STORAGE).sort(),
  );
});

test("a build carries the push environment of its kind: development for debug, production for release", () => {
  assert.deepEqual(APS_ENVIRONMENT, {
    debug: "development",
    release: "production",
  });
  assert.deepEqual(checkEntitlements(entitlements("development"), "debug"), []);
  assert.deepEqual(
    checkEntitlements(entitlements("production"), "release"),
    [],
  );
  // The two crossed: a release build with the sandbox value (the gate's refusal, seen here first), and a
  // debug build with the production one.
  assert.match(
    checkEntitlements(entitlements("development"), "release").join(),
    /is development, but a release build must carry production/,
  );
  assert.match(
    checkEntitlements(entitlements("production"), "debug").join(),
    /is production, but a debug build must carry development/,
  );
  // Without a build only the value's presence and shape are checked.
  assert.deepEqual(checkEntitlements(entitlements("production")), []);
  assert.deepEqual(checkEntitlements(entitlements("development")), []);
  assert.match(checkEntitlements(entitlements(null)).join(), /missing/);
  assert.match(
    checkEntitlements(entitlements("staging")).join(),
    /development or production/,
  );
  assert.match(
    checkEntitlements(entitlements("production"), "beta").join(),
    /debug or release/,
  );
  // A commented-out key is not the key; other entitlements do not stand in for it.
  assert.match(
    checkEntitlements(
      "<dict><!-- <key>aps-environment</key><string>production</string> --></dict>",
    ).join(),
    /missing/,
  );
  assert.match(
    checkEntitlements(
      entitlements(null, "<key>get-task-allow</key><true/>"),
      "release",
    ).join(),
    /missing/,
  );
});

test("a built app is checked for its push environment against the kind of build", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mycarlos-ios-aps-"));
  try {
    const app = join(directory, "myCarlos.app");
    await mkdir(app);
    await writeFile(join(app, "PrivacyInfo.xcprivacy"), await manifest());
    await writeFile(
      join(app, "Info.plist"),
      await readFile(INFO_PLIST_PATH, "utf8"),
    );
    const signed = join(directory, "signed.plist");
    const check = (environment, build) =>
      writeFile(signed, entitlements(environment)).then(() =>
        run(["--app", app, "--entitlements", signed, ...build]),
      );
    assert.deepEqual(await check("production", ["--build", "release"]), []);
    assert.deepEqual(await check("development", ["--build", "debug"]), []);
    assert.match(
      (await check("development", ["--build", "release"])).join(),
      /a release build must carry production/,
    );
    assert.match(
      (await check("production", ["--build", "debug"])).join(),
      /a debug build must carry development/,
    );
    assert.match(
      (await check(null, ["--build", "release"])).join(),
      /aps-environment entitlement is missing/,
    );
    assert.match(
      (await check("production", ["--build", "nightly"])).join(),
      /--build must be debug or release/,
    );
    // No way to read the signed entitlements (no file, and not macOS): refused, never assumed.
    await rm(signed);
    assert.match(
      (
        await run([
          "--app",
          app,
          "--entitlements",
          signed,
          "--build",
          "release",
        ])
      ).join(),
      /signed entitlements cannot be read/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the entitlement files and the project fragment are written into the generated project", async () => {
  const { configureIosPrivacy, withApsEnvironment } = await import(
    "./configure-ios-privacy.mjs"
  );
  const directory = await mkdtemp(join(tmpdir(), "mycarlos-ios-ent-"));
  try {
    await mkdir(join(directory, "src-tauri/ios"), { recursive: true });
    await writeFile(
      join(directory, "src-tauri/ios/PrivacyInfo.xcprivacy"),
      await manifest(),
    );
    const apple = join(directory, "src-tauri/gen/apple");
    const folder = join(apple, "mycarlos_iOS");
    await mkdir(folder, { recursive: true });
    // As `tauri ios init` writes it: an empty entitlements dictionary, and a project spec.
    const base =
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict/>\n</plist>\n';
    await writeFile(join(folder, "mycarlos_iOS.entitlements"), base);
    const spec =
      "name: mycarlos\ntargets:\n  mycarlos_iOS:\n    type: application\n";
    await writeFile(join(apple, "project.yml"), spec);
    await configureIosPrivacy({ root: directory, generate: false });
    const debug = await readFile(
      join(folder, "mycarlos_iOS.Debug.entitlements"),
      "utf8",
    );
    const release = await readFile(
      join(folder, "mycarlos_iOS.Release.entitlements"),
      "utf8",
    );
    assert.deepEqual(checkEntitlements(debug, "debug"), []);
    assert.deepEqual(checkEntitlements(release, "release"), []);
    assert.match(debug, /<string>development<\/string>/);
    assert.match(release, /<string>production<\/string>/);
    // The generated base file is left as it was, for the next run.
    assert.equal(
      await readFile(join(folder, "mycarlos_iOS.entitlements"), "utf8"),
      base,
    );
    // The fragment names each configuration's file, and the spec includes the fragment once.
    const fragment = await readFile(join(apple, "project.carlos.yml"), "utf8");
    assert.match(fragment, /mycarlos_iOS:/);
    assert.match(
      fragment,
      /debug:\s+CODE_SIGN_ENTITLEMENTS: mycarlos_iOS\/mycarlos_iOS\.Debug\.entitlements/,
    );
    assert.match(
      fragment,
      /release:\s+CODE_SIGN_ENTITLEMENTS: mycarlos_iOS\/mycarlos_iOS\.Release\.entitlements/,
    );
    const included = await readFile(join(apple, "project.yml"), "utf8");
    assert.equal(included.match(/project\.carlos\.yml/g).length, 1);
    assert.ok(included.endsWith(spec) || included.includes(spec));
    // Again: the same files, and still one include.
    await configureIosPrivacy({ root: directory, generate: false });
    assert.equal(
      (await readFile(join(apple, "project.yml"), "utf8")).match(
        /project\.carlos\.yml/g,
      ).length,
      1,
    );
    assert.equal(
      await readFile(join(folder, "mycarlos_iOS.Release.entitlements"), "utf8"),
      release,
    );
    // A spec that already includes another file keeps it and gains ours once.
    await writeFile(
      join(apple, "project.yml"),
      "include:\n  - other.yml\nname: mycarlos\n",
    );
    await configureIosPrivacy({ root: directory, generate: false });
    const merged = await readFile(join(apple, "project.yml"), "utf8");
    assert.match(
      merged,
      /include:\n  - other\.yml\n  - project\.carlos\.yml\n/,
    );
    // Other entitlements already in the base file stay, and a value already there is replaced.
    const other =
      '<plist version="1.0"><dict><key>com.apple.developer.associated-domains</key><array/><key>aps-environment</key><string>production</string></dict></plist>';
    const debugText = withApsEnvironment(other, "development");
    assert.match(debugText, /associated-domains/);
    assert.deepEqual(checkEntitlements(debugText, "debug"), []);
    assert.equal(debugText.match(/aps-environment/g).length, 1);
    assert.match(
      withApsEnvironment("<dict></dict>", "production"),
      /<string>production<\/string>/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the build flags are not silently ignored: they need --app, and --app needs --build", async () => {
  // A CI step that forgot --app must fail, not pass having checked nothing.
  assert.match(
    (await run(["--build", "release"])).join(),
    /--build is only for a built app/,
  );
  assert.match(
    (await run(["--entitlements", "/nonexistent/signed.plist"])).join(),
    /--entitlements is only for a built app/,
  );
  assert.match(
    (await run(["--build", "debug", "--entitlements", "x"])).join(),
    /--build is only for a built app.*--entitlements is only for a built app/,
  );
  // No flag, no problem: the repository's own files.
  assert.deepEqual(await run([]), []);
  const directory = await mkdtemp(join(tmpdir(), "mycarlos-ios-flags-"));
  try {
    const app = join(directory, "myCarlos.app");
    await mkdir(app);
    await writeFile(join(app, "PrivacyInfo.xcprivacy"), await manifest());
    await writeFile(
      join(app, "Info.plist"),
      await readFile(INFO_PLIST_PATH, "utf8"),
    );
    const signed = join(directory, "signed.plist");
    await writeFile(signed, entitlements("production"));
    // A built app with good files but no --build: any push value would pass, so it is refused.
    assert.match(
      (await run(["--app", app, "--entitlements", signed])).join(),
      /pass --build debug or --build release with --app/,
    );
    assert.deepEqual(
      await run(["--app", app, "--build", "release", "--entitlements", signed]),
      [],
    );
    // --build with no value after it is not a build.
    assert.match(
      (await run(["--app", app, "--entitlements", signed, "--build"])).join(),
      /--build must be debug or release, not /,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("aps-environment counts only as a top-level entitlement, not inside another value", () => {
  const nested = (environment) =>
    `<?xml version="1.0"?><plist version="1.0"><dict><key>com.example.nested</key><dict><key>aps-environment</key><string>${environment}</string></dict><key>com.example.list</key><array><dict><key>aps-environment</key><string>${environment}</string></dict></array></dict></plist>`;
  assert.match(
    checkEntitlements(nested("production"), "release").join(),
    /missing/,
  );
  assert.match(checkEntitlements(nested("development")).join(), /missing/);
  // The top-level one is found after nested values, whatever they hold.
  const both = `<plist version="1.0"><dict><key>x</key><dict><key>aps-environment</key><string>development</string></dict><key>aps-environment</key><string>production</string></dict></plist>`;
  assert.deepEqual(checkEntitlements(both, "release"), []);
  assert.match(
    checkEntitlements(both, "debug").join(),
    /is production, but a debug build must carry development/,
  );
  // A key that is not a string value is not an environment.
  assert.match(
    checkEntitlements(
      "<plist><dict><key>aps-environment</key><true/></dict></plist>",
    ).join(),
    /development or production/,
  );
  assert.match(
    checkEntitlements(
      "<plist><dict><key>aps-environment</key><array/></dict></plist>",
    ).join(),
    /development or production/,
  );
  // An empty entitlements dictionary has none.
  assert.match(checkEntitlements("<plist><dict/></plist>").join(), /missing/);
  // The first top-level key decides, however many follow.
  assert.deepEqual(
    checkEntitlements(
      `<plist><dict><key>get-task-allow</key><true/><key>aps-environment</key><string>production</string></dict></plist>`,
      "release",
    ),
    [],
  );
});

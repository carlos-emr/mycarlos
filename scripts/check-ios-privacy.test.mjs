import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkInfoPlist,
  checkManifest,
  INFO_PLIST_PATH,
  MANIFEST_PATH,
  MINIMUM_REASONS,
  REQUIRED_APIS,
  run,
} from "./check-ios-privacy.mjs";

const manifest = () => readFile(MANIFEST_PATH, "utf8");

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
    assert.deepEqual(await run(["--app", app]), []);
    await writeFile(
      join(app, "PrivacyInfo.xcprivacy"),
      `${await manifest()}\n`,
    );
    assert.match((await run(["--app", app])).join(), /differs from/);
    await writeFile(join(app, "PrivacyInfo.xcprivacy"), await manifest());
    await writeFile(join(app, "Info.plist"), "<dict></dict>");
    assert.match(
      (await run(["--app", app])).join(),
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

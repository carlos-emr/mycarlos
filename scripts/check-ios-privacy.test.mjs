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
  REQUIRED_APIS,
  run,
} from "./check-ios-privacy.mjs";

const manifest = () => readFile(MANIFEST_PATH, "utf8");

test("the repository's manifest and Info.ios.plist are as pinned", async () => {
  assert.deepEqual(await run([]), []);
});

test("the manifest declares no tracking and no collected data", async () => {
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
  assert.match(
    checkManifest(
      text.replace(
        "<key>NSPrivacyCollectedDataTypes</key>\n\t<array/>",
        "<key>NSPrivacyCollectedDataTypes</key>\n\t<array><dict/></array>",
      ),
    ).join(),
    /CollectedDataTypes must be empty/,
  );
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

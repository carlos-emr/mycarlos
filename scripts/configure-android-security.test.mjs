import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configureAndroidSecurity,
  declareCamera,
} from "./configure-android-security.mjs";

test("Android backup exclusions are applied exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mycarlos-android-security-"));
  try {
    const manifestPath = join(directory, "AndroidManifest.xml");
    await writeFile(
      manifestPath,
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:allowBackup="true" android:label="myCarlos" /></manifest>',
    );

    await configureAndroidSecurity(manifestPath);
    await configureAndroidSecurity(manifestPath);
    const manifest = await readFile(manifestPath, "utf8");
    assert.equal(
      (manifest.match(/android:allowBackup="false"/g) ?? []).length,
      1,
    );
    assert.equal(
      (manifest.match(/android:fullBackupContent="false"/g) ?? []).length,
      1,
    );
    assert.doesNotMatch(manifest, /android:allowBackup="true"/);

    // Android 12 and later ignore both attributes for device-to-device transfer.
    assert.equal(
      (
        manifest.match(
          /android:dataExtractionRules="@xml\/mycarlos_data_extraction_rules"/g,
        ) ?? []
      ).length,
      1,
    );
    const rules = await readFile(
      join(directory, "res", "xml", "mycarlos_data_extraction_rules.xml"),
      "utf8",
    );
    // Android 12 and later apply only the device_* domains to device-to-device
    // transfer, and the plain ones to cloud backup. Exclude both from both.
    for (const section of ["cloud-backup", "device-transfer"]) {
      const body = rules.split(`<${section}>`)[1].split(`</${section}>`)[0];
      for (const domain of [
        "root",
        "file",
        "database",
        "sharedpref",
        "external",
        "device_root",
        "device_file",
        "device_database",
        "device_sharedpref",
      ]) {
        assert.match(
          body,
          new RegExp(`<exclude domain="${domain}" path="\\." />`),
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the camera is declared once, not required, and the microphone not at all (D97)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mycarlos-android-camera-"));
  try {
    const manifestPath = join(directory, "AndroidManifest.xml");
    await writeFile(
      manifestPath,
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <uses-permission android:name="android.permission.INTERNET" />\n    <application android:label="myCarlos" />\n</manifest>',
    );
    await configureAndroidSecurity(manifestPath);
    await configureAndroidSecurity(manifestPath);
    const manifest = await readFile(manifestPath, "utf8");
    assert.equal(
      (
        manifest.match(
          /<uses-permission android:name="android\.permission\.CAMERA" \/>/g,
        ) ?? []
      ).length,
      1,
    );
    assert.equal(
      (
        manifest.match(
          /<uses-feature android:name="android\.hardware\.camera" android:required="false" \/>/g,
        ) ?? []
      ).length,
      1,
    );
    assert.doesNotMatch(manifest, /RECORD_AUDIO|MODIFY_AUDIO_SETTINGS/);
    // What was there stays.
    assert.match(manifest, /android\.permission\.INTERNET/);
    assert.match(manifest, /<application android:allowBackup="false"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a camera feature marked required is replaced by one that is not", () => {
  const manifest = declareCamera(
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-feature android:name="android.hardware.camera" android:required="true" /><application /></manifest>',
  );
  assert.doesNotMatch(manifest, /android:required="true"/);
  assert.match(
    manifest,
    /<uses-feature android:name="android\.hardware\.camera" android:required="false" \/>/,
  );
  assert.throws(() => declareCamera("<application />"), /manifest element/);
});

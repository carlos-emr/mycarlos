import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureAndroidSecurity } from "./configure-android-security.mjs";

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

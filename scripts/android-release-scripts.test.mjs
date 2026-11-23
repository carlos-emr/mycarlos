import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildNumber,
  MAX_VERSION_CODE,
  versionCode,
} from "./android-version-code.mjs";
import {
  BLOCK,
  configureAndroidSigning,
  missingVariables,
  VARIABLES,
  withSigning,
} from "./configure-android-signing.mjs";

test("the versionCode rises with the version and with the build number", () => {
  assert.equal(versionCode("0.1.0", 0), 100_000);
  assert.equal(versionCode("1.2.3", 7), 10_000_000 + 200_000 + 3_000 + 7);
  assert.equal(versionCode("1.2.3-alpha.1", 7), versionCode("1.2.3", 7));
  const versions = [
    "0.1.0",
    "0.1.1",
    "0.2.0",
    "1.0.0",
    "1.0.1",
    "1.1.0",
    "2.0.0",
  ];
  const codes = versions.map((version) => versionCode(version, 999));
  assert.deepEqual(
    codes,
    [...codes].sort((a, b) => a - b),
  );
  // The last build of one version stays below the first build of the next.
  assert.ok(versionCode("1.0.0", 999) < versionCode("1.0.1", 0));
  assert.ok(versionCode("1.0.99", 999) < versionCode("1.1.0", 0));
  assert.ok(versionCode("99.99.99", 999) < MAX_VERSION_CODE);
});

test("a version or build number outside the scheme is refused, not wrapped", () => {
  assert.throws(() => versionCode("1.2", 0), /major.minor.patch/);
  assert.throws(() => versionCode("100.0.0", 0), /major.minor.patch/);
  assert.throws(() => versionCode("1.100.0", 0), /major.minor.patch/);
  assert.throws(() => versionCode("1.0.0", 1000), /0 to 999/);
  assert.throws(() => versionCode("1.0.0", -1), /0 to 999/);
  assert.throws(() => versionCode("1.0.0", 1.5), /0 to 999/);
  assert.throws(() => versionCode("0.0.0", 0), /from 1 to/);
});

test("the build number comes from a whole number or is 0", () => {
  assert.equal(buildNumber(undefined), 0);
  assert.equal(buildNumber(""), 0);
  assert.equal(buildNumber("12"), 12);
  assert.throws(() => buildNumber("1e3"), /whole number/);
  assert.throws(() => buildNumber("1000"), /whole number/);
  assert.throws(() => buildNumber("-1"), /whole number/);
});

const GRADLE =
  'plugins { id("com.android.application") }\nandroid {\n    compileSdk = 36\n}\n';

test("the signing block is added once and holds no secret", () => {
  const once = withSigning(GRADLE);
  assert.equal(withSigning(once), once);
  assert.equal((once.match(/mycarlosUpload"\)/g) ?? []).length, 2);
  for (const name of VARIABLES)
    assert.ok(BLOCK.includes(`System.getenv("${name}")`));
  assert.ok(!/password\s*=\s*"/i.test(BLOCK));
  assert.throws(() => withSigning("plugins {}"), /no android block/);
});

test("signing refuses missing variables and a missing keystore file, and never writes values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mycarlos-signing-"));
  try {
    const gradle = join(directory, "build.gradle.kts");
    await writeFile(gradle, GRADLE);
    assert.deepEqual(missingVariables({}), VARIABLES);
    await assert.rejects(
      configureAndroidSigning(gradle, {}),
      /set MYCARLOS_UPLOAD_KEYSTORE,/,
    );
    const environment = {
      MYCARLOS_UPLOAD_KEYSTORE: join(directory, "missing.jks"),
      MYCARLOS_UPLOAD_KEYSTORE_PASSWORD: "FAKE-store-secret",
      MYCARLOS_UPLOAD_KEY_ALIAS: "upload",
      MYCARLOS_UPLOAD_KEY_PASSWORD: "FAKE-key-secret",
    };
    await assert.rejects(
      configureAndroidSigning(gradle, environment),
      /existing file/,
    );
    assert.equal(await readFile(gradle, "utf8"), GRADLE);
    await writeFile(
      environment.MYCARLOS_UPLOAD_KEYSTORE,
      "FAKE keystore bytes",
    );
    await configureAndroidSigning(gradle, environment);
    await configureAndroidSigning(gradle, environment);
    const written = await readFile(gradle, "utf8");
    assert.ok(written.includes("mycarlosUpload"));
    assert.ok(!written.includes("FAKE-store-secret"));
    assert.ok(!written.includes("FAKE-key-secret"));
    assert.equal((written.match(/signingConfigs \{/g) ?? []).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

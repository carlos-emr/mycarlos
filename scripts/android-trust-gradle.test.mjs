import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  VERIFIER_COMPONENT,
  verificationMetadata,
} from "./configure-android-security.mjs";

// The Gradle file of the Android trust plugin (src-tauri/android-trust/android) is the one place
// that fetches the verifier's Kotlin half from outside Maven Central. These tests pin the supply
// chain rules in it, because nothing else would notice a loosening.
const gradle = await readFile(
  new URL(
    "../src-tauri/android-trust/android/build.gradle.kts",
    import.meta.url,
  ),
  "utf8",
);
const lock = await readFile(
  new URL("../src-tauri/Cargo.lock", import.meta.url),
  "utf8",
);

test("the extra Maven repository serves only the verifier's group and nothing else", () => {
  assert.match(gradle, /exclusiveContent\s*\{/);
  assert.match(
    gradle,
    /exclusiveContent\s*\{\s*forRepository\s*\{\s*maven\s*\{\s*url = uri\("https:\/\/github\.com\/rustls\/rustls-platform-verifier\/raw\/1aa691352a5e0c215210dfc9a3c2f2078639dc91\/android-release-support\/maven\/"\)/s,
  );
  assert.match(gradle, /filter\s*\{\s*includeGroup\("org\.rustls"\)\s*\}/);
  // No second group may be admitted through that repository.
  assert.equal((gradle.match(/includeGroup/g) ?? []).length, 1);
  assert.doesNotMatch(
    gradle,
    /includeGroupByRegex|includeModule|allowInsecureProtocol/,
  );
  // The app module resolves the dependency, so the repository goes on every project of the build
  // (a repository declared only in this library is not searched for the app: CI's first run).
  assert.match(
    gradle,
    /rootProject\.allprojects\s*\{\s*repositories\s*\{\s*exclusiveContent\s*\{/s,
  );
  // And no repository is declared outside the exclusive block.
  assert.equal((gradle.match(/\bmaven\s*\{/g) ?? []).length, 1);
  assert.equal(
    (gradle.match(/\bmavenCentral\(|\bjcenter\(|\bgoogle\(/g) ?? []).length,
    0,
  );
});

test("the verifier's Kotlin half is pinned to the version in Cargo.lock, not to a number written here", () => {
  assert.match(gradle, /rustls-platform-verifier-android/);
  assert.match(gradle, /File\(projectDir, "\.\.\/\.\.\/Cargo\.lock"\)/);
  assert.match(
    gradle,
    /implementation\("org\.rustls:rustls-platform-verifier:\$verifierVersion"\)/,
  );
  // No literal version of it anywhere in the file.
  assert.doesNotMatch(gradle, /rustls-platform-verifier:\d/);
  // The lock file it reads does list the component, once.
  assert.equal(
    (lock.match(/name = "rustls-platform-verifier-android"/g) ?? []).length,
    1,
  );
});

test("R8 keeps the plugin entry and the verifier's classes by name", async () => {
  const rules = await readFile(
    new URL(
      "../src-tauri/android-trust/android/consumer-rules.pro",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    rules,
    /-keep class ca\.carlos\.mycarlos\.trust\.PortalTrustPlugin/,
  );
  assert.match(
    rules,
    /-keep, includedescriptorclasses class org\.rustls\.platformverifier\.\*\* \{ \*; \}/,
  );
});

test("the plugin passes the application context, never the activity", async () => {
  const kotlin = await readFile(
    new URL(
      "../src-tauri/android-trust/android/src/main/java/ca/carlos/mycarlos/trust/PortalTrustPlugin.kt",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(kotlin, /nativeInit\(activity\.applicationContext\)/);
  assert.doesNotMatch(kotlin, /nativeInit\(activity\)/);
  assert.doesNotMatch(kotlin, /Log\.|println/);
});

test("the archive is named by a commit, never by a branch that can move", () => {
  assert.match(gradle, /raw\/[0-9a-f]{40}\/android-release-support\/maven\//);
  assert.doesNotMatch(gradle, /raw\/(maven-archive|main|master|HEAD)\b/);
});

test("Gradle checks the verifier's bytes: version, files and SHA-256 values travel with Cargo.lock", () => {
  // The version the crate lock asks for is the one whose hashes are written down.
  const at = lock.indexOf('name = "rustls-platform-verifier-android"');
  const version = /version = "([^"]+)"/.exec(lock.slice(at))?.[1];
  assert.equal(VERIFIER_COMPONENT.version, version);
  assert.equal(VERIFIER_COMPONENT.group, "org.rustls");
  assert.deepEqual(Object.keys(VERIFIER_COMPONENT.files).sort(), [
    `rustls-platform-verifier-${version}.aar`,
    `rustls-platform-verifier-${version}.pom`,
  ]);
  for (const sha256 of Object.values(VERIFIER_COMPONENT.files)) {
    assert.match(sha256, /^[0-9a-f]{64}$/);
  }
  const xml = verificationMetadata();
  for (const [file, sha256] of Object.entries(VERIFIER_COMPONENT.files)) {
    assert.ok(xml.includes(`<artifact name="${file}">`), file);
    assert.ok(xml.includes(`<sha256 value="${sha256}"/>`), file);
  }
  // Everything but that one group is trusted as before; that group has no trust of its own.
  assert.match(
    xml,
    /<trust group="\^\(\?!org\\\.rustls\$\)\.\*" regex="true"\/>/,
  );
  assert.match(xml, /<verify-metadata>false<\/verify-metadata>/);
});

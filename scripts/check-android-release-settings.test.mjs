import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkGeneratedApp,
  checkNdkProperties,
  checkPluginGradle,
  checkTauriConfig,
  gradleNumber,
  run,
} from "./check-android-release-settings.mjs";

const APP = `android {
    compileSdk = 36
    namespace = "ca.carlos.mycarlos"
    defaultConfig {
        minSdk = 24
        targetSdk = 36
        versionCode = 1
    }
}`;
const PLUGIN = `android {
    namespace = "ca.carlos.mycarlos.pdf"
    compileSdk = 36
    defaultConfig { 
        minSdk = 24
    }
}`;

test("a Gradle number is read from its own line only", () => {
  assert.equal(gradleNumber(APP, "targetSdk"), 36);
  assert.equal(gradleNumber(APP, "minSdk"), 24);
  assert.equal(gradleNumber("// targetSdk = 99\n", "targetSdk"), null);
  assert.equal(
    gradleNumber("    targetSdk = 36 // Android 16\n", "targetSdk"),
    36,
  );
});

test("the generated app must target API 36, compile against at least 36 and keep minSdk", () => {
  assert.deepEqual(checkGeneratedApp(APP), []);
  assert.match(
    checkGeneratedApp(APP.replace("targetSdk = 36", "targetSdk = 35")).join(),
    /targetSdk is 35/,
  );
  assert.match(
    checkGeneratedApp(APP.replace("compileSdk = 36", "compileSdk = 35")).join(),
    /compileSdk is 35/,
  );
  assert.match(
    checkGeneratedApp(APP.replace("minSdk = 24", "minSdk = 21")).join(),
    /minSdk is 21/,
  );
  assert.match(checkGeneratedApp("android {}").join(), /targetSdk is missing/);
  assert.deepEqual(
    checkGeneratedApp(APP.replace("compileSdk = 36", "compileSdk = 37")),
    [],
  );
});

test("the plugin library follows the same compile and minimum SDK", () => {
  assert.deepEqual(checkPluginGradle(PLUGIN), []);
  assert.match(
    checkPluginGradle(
      PLUGIN.replace("compileSdk = 36", "compileSdk = 34"),
    ).join(),
    /compileSdk is 34/,
  );
  assert.match(
    checkPluginGradle(PLUGIN.replace("minSdk = 24", "minSdk = 26")).join(),
    /minSdk is 26/,
  );
});

test("the Tauri configuration pins the minimum SDK the generated app reads", () => {
  assert.deepEqual(
    checkTauriConfig({ bundle: { android: { minSdkVersion: 24 } } }),
    [],
  );
  assert.match(checkTauriConfig({ bundle: {} }).join(), /missing/);
  assert.match(
    checkTauriConfig({ bundle: { android: { minSdkVersion: 21 } } }).join(),
    /is 21/,
  );
});

test("the NDK must be r28 or newer", () => {
  assert.deepEqual(
    checkNdkProperties(
      "Pkg.Desc = Android NDK\nPkg.Revision = 28.2.13676358\n",
    ),
    [],
  );
  assert.deepEqual(checkNdkProperties("Pkg.Revision = 29.0.1\n"), []);
  assert.match(
    checkNdkProperties("Pkg.Revision = 27.3.13750724\n").join(),
    /r27/,
  );
  assert.match(checkNdkProperties("nothing").join(), /no Pkg.Revision/);
});

test("run reads the repository files, and the generated project and NDK only on request", async () => {
  const root = await mkdtemp(join(tmpdir(), "mycarlos-android-release-"));
  try {
    await mkdir(join(root, "src-tauri/android-pdf/android"), {
      recursive: true,
    });
    await mkdir(join(root, "src-tauri/gen/android/app"), { recursive: true });
    await mkdir(join(root, "ndk"), { recursive: true });
    await writeFile(
      join(root, "src-tauri/tauri.conf.json"),
      JSON.stringify({ bundle: { android: { minSdkVersion: 24 } } }),
    );
    await writeFile(
      join(root, "src-tauri/android-pdf/android/build.gradle.kts"),
      PLUGIN,
    );
    assert.deepEqual(await run([], root), []);
    assert.match(
      (await run(["--generated"], root)).join(),
      /run `tauri android init`/,
    );
    await writeFile(
      join(root, "src-tauri/gen/android/app/build.gradle.kts"),
      APP,
    );
    await writeFile(
      join(root, "ndk/source.properties"),
      "Pkg.Revision = 28.0.1\n",
    );
    assert.deepEqual(
      await run(["--generated", "--ndk", join(root, "ndk")], root),
      [],
    );
    await writeFile(
      join(root, "ndk/source.properties"),
      "Pkg.Revision = 26.1.1\n",
    );
    assert.match((await run(["--ndk", join(root, "ndk")], root)).join(), /r26/);
    assert.match((await run(["--ndk"], root)).join(), /pass the NDK folder/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the repository's own files are as pinned", async () => {
  assert.deepEqual(await run([]), []);
});

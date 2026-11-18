import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configureAndroidSecurity,
  copyLauncherIcons,
  declareCamera,
  keepPageClearOfSystemBars,
} from "./configure-android-security.mjs";

test("Android backup exclusions are applied exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mycarlos-android-security-"));
  try {
    await mkdir(join(directory, "res"));
    const manifestPath = join(directory, "AndroidManifest.xml");
    await writeFile(
      manifestPath,
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:allowBackup="true" android:label="myCarlos" /></manifest>',
    );

    const activityDirectory = join(
      directory,
      "java",
      "ca",
      "carlos",
      "mycarlos",
    );
    await mkdir(activityDirectory, { recursive: true });
    const activityPath = join(activityDirectory, "MainActivity.kt");
    await writeFile(
      activityPath,
      "package ca.carlos.mycarlos\n\nclass MainActivity : TauriActivity()\n",
    );

    await configureAndroidSecurity(manifestPath);
    await configureAndroidSecurity(manifestPath);
    // The page is kept clear of the system bars, once.
    const activity = await readFile(activityPath, "utf8");
    assert.equal(
      (activity.match(/override fun onWebViewCreate/g) ?? []).length,
      1,
    );
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
    await mkdir(join(directory, "res"));
    const manifestPath = join(directory, "AndroidManifest.xml");
    await writeFile(
      manifestPath,
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <uses-permission android:name="android.permission.INTERNET" />\n    <application android:label="myCarlos" />\n</manifest>',
    );
    await mkdir(join(directory, "java", "ca", "carlos", "mycarlos"), {
      recursive: true,
    });
    await writeFile(
      join(directory, "java", "ca", "carlos", "mycarlos", "MainActivity.kt"),
      "package ca.carlos.mycarlos\n\nclass MainActivity : TauriActivity()\n",
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
    // The permission implies autofocus; not required either, once.
    assert.equal(
      (
        manifest.match(
          /<uses-feature android:name="android\.hardware\.camera\.autofocus" android:required="false" \/>/g,
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
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-feature android:name="android.hardware.camera" android:required="true" /><uses-feature android:name="android.hardware.camera.autofocus" /><application /></manifest>',
  );
  assert.doesNotMatch(manifest, /android:required="true"/);
  assert.match(
    manifest,
    /<uses-feature android:name="android\.hardware\.camera" android:required="false" \/>/,
  );
  assert.equal(manifest.match(/camera\.autofocus/g)?.length, 1);
  assert.match(
    manifest,
    /<uses-feature android:name="android\.hardware\.camera\.autofocus" android:required="false" \/>/,
  );
  assert.throws(() => declareCamera("<application />"), /manifest element/);
});

test("the page is kept clear of the status bar, the gesture bar and the keyboard, once", () => {
  const withBody = [
    "package ca.carlos.mycarlos",
    "",
    "import android.os.Bundle",
    "",
    "class MainActivity : TauriActivity() {",
    "  override fun onCreate(savedInstanceState: Bundle?) {",
    "    super.onCreate(savedInstanceState)",
    "  }",
    "}",
    "",
  ].join("\n");
  for (const source of [
    "package ca.carlos.mycarlos\n\nclass MainActivity : TauriActivity()\n",
    withBody,
  ]) {
    const patched = keepPageClearOfSystemBars(source);
    assert.match(patched, /override fun onWebViewCreate\(webView: WebView\)/);
    assert.match(patched, /WindowInsetsCompat\.Type\.systemBars\(\)/);
    assert.match(patched, /WindowInsetsCompat\.Type\.displayCutout\(\)/);
    assert.match(patched, /WindowInsetsCompat\.Type\.ime\(\)/);
    // The padding goes on the content view (the WebView ignores its own
    // padding for page content), not on the WebView.
    assert.match(patched, /findViewById<View>\(android\.R\.id\.content\)/);
    assert.match(patched, /setOnApplyWindowInsetsListener\(content\)/);
    assert.doesNotMatch(patched, /setOnApplyWindowInsetsListener\(webView\)/);
    assert.match(patched, /WindowInsetsCompat\.CONSUMED/);
    // The strip behind the clock takes the header's colours, dark or light.
    assert.match(patched, /0xFF21372F/);
    assert.match(patched, /0xFFE7EFED/);
    assert.match(patched, /isAppearanceLightStatusBars = !darkBackground/);
    // The page can change the strip through one validated method only.
    assert.match(
      patched,
      /addJavascriptInterface\(SystemBarsBridge\(\), "MyCarlosSystemBars"\)/,
    );
    assert.match(patched, /@JavascriptInterface/);
    assert.match(patched, /\^#\[0-9a-fA-F\]\{6\}\$/);
    assert.match(
      patched,
      /runOnUiThread \{ setStripColour\(value, darkBackground\) \}/,
    );
    for (const line of [
      "import android.content.res.Configuration",
      "import android.graphics.Color",
      "import android.graphics.drawable.ColorDrawable",
      "import android.view.View",
      "import android.webkit.JavascriptInterface",
      "import android.webkit.WebView",
      "import androidx.core.view.ViewCompat",
      "import androidx.core.view.WindowCompat",
      "import androidx.core.view.WindowInsetsCompat",
    ]) {
      assert.equal(patched.split(line).length - 1, 1, line);
    }
    // Idempotent, and what was there stays.
    assert.equal(keepPageClearOfSystemBars(patched), patched);
    assert.match(patched, /class MainActivity : TauriActivity\(\)/);
  }
  assert.match(
    keepPageClearOfSystemBars(withBody),
    /override fun onCreate\(savedInstanceState: Bundle\?\)/,
  );
});

test("the override goes inside the class, before anything declared after it", () => {
  const patched = keepPageClearOfSystemBars(
    "package ca.carlos.mycarlos\n\nclass MainActivity : TauriActivity() {\n  val a = 1\n}\n\nprivate fun later() {}\n",
  );
  assert.ok(
    patched.indexOf("onWebViewCreate") < patched.indexOf("private fun later"),
  );
  assert.ok(patched.indexOf("val a = 1") < patched.indexOf("onWebViewCreate"));
  assert.match(
    patched,
    /ViewCompat\.requestApplyInsets\(content\)\n    }\n}\n\nprivate fun later/,
  );
});

test("a MainActivity that already handles the web view is not patched blindly", () => {
  assert.throws(
    () =>
      keepPageClearOfSystemBars(
        "package a\nclass MainActivity : TauriActivity() {\n  override fun onWebViewCreate(webView: android.webkit.WebView) {}\n}\n",
      ),
    /review it before patching/,
  );
  assert.throws(() => keepPageClearOfSystemBars("package a\n"), /not found/);
});

test("the repository's launcher icons are copied into the generated project, again without harm", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mycarlos-android-icons-"));
  try {
    const icons = join(directory, "icons");
    const res = join(directory, "res");
    for (const [folder, file] of [
      ["mipmap-mdpi", "ic_launcher.png"],
      ["mipmap-xxxhdpi", "ic_launcher_foreground.png"],
      ["mipmap-anydpi-v26", "ic_launcher.xml"],
      ["values", "ic_launcher_background.xml"],
    ]) {
      await mkdir(join(icons, folder), { recursive: true });
      await writeFile(join(icons, folder, file), `ours ${file}`);
    }
    await mkdir(join(res, "mipmap-mdpi"), { recursive: true });
    await writeFile(join(res, "mipmap-mdpi", "ic_launcher.png"), "default");
    await writeFile(join(res, "mipmap-mdpi", "ic_launcher.webp"), "default");
    await writeFile(join(res, "mipmap-mdpi", "other.png"), "kept");

    await copyLauncherIcons(res, icons);
    await copyLauncherIcons(res, icons);

    assert.equal(
      await readFile(join(res, "mipmap-mdpi", "ic_launcher.png"), "utf8"),
      "ours ic_launcher.png",
    );
    // A same-named file of another type would be a duplicate resource.
    assert.deepEqual((await readdir(join(res, "mipmap-mdpi"))).sort(), [
      "ic_launcher.png",
      "other.png",
    ]);
    for (const path of [
      "mipmap-xxxhdpi/ic_launcher_foreground.png",
      "mipmap-anydpi-v26/ic_launcher.xml",
      "values/ic_launcher_background.xml",
    ]) {
      assert.match(await readFile(join(res, path), "utf8"), /^ours /);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("copying the icons stops when the generated res folder or the icons are missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mycarlos-android-icons-"));
  try {
    await mkdir(join(directory, "icons", "values"), { recursive: true });
    await mkdir(join(directory, "res"));
    await assert.rejects(
      copyLauncherIcons(
        join(directory, "missing-res"),
        join(directory, "icons"),
      ),
      /generated Android res folder was not found/,
    );
    await assert.rejects(
      copyLauncherIcons(join(directory, "res"), join(directory, "no-icons")),
      /repository Android icons was not found/,
    );
    await assert.rejects(
      copyLauncherIcons(join(directory, "res"), join(directory, "icons")),
      /No mipmap folders/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the strip behind the status bar uses the header's colours from styles.css", async () => {
  const css = await readFile(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  // --canvas-2 in the light theme (:root) and in the dark theme.
  const light = /:root\s*{[^}]*--canvas-2:\s*#([0-9a-fA-F]{6})/.exec(css)?.[1];
  const dark =
    /:root\[data-theme="dark"\]\s*{[^}]*--canvas-2:\s*#([0-9a-fA-F]{6})/.exec(
      css,
    )?.[1];
  assert.ok(light && dark, "--canvas-2 colours not found in styles.css");
  const patched = keepPageClearOfSystemBars(
    "package a\n\nclass MainActivity : TauriActivity()\n",
  );
  assert.ok(patched.includes(`0xFF${light.toUpperCase()}`), "light colour");
  assert.ok(patched.includes(`0xFF${dark.toUpperCase()}`), "dark colour");
});

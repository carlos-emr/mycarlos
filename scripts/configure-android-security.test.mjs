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
  declareMicrophone,
  keepPageClearOfSystemBars,
  setNetworkSecurityConfig,
  writeNetworkSecurityConfig,
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

    await configureAndroidSecurity(manifestPath, undefined, {
      debugDirectory: join(directory, "debug"),
    });
    await configureAndroidSecurity(manifestPath, undefined, {
      debugDirectory: join(directory, "debug"),
    });
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

test("the camera and the microphone are each declared once, neither required (D97, #359)", async () => {
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
    await configureAndroidSecurity(manifestPath, undefined, {
      debugDirectory: join(directory, "debug"),
    });
    await configureAndroidSecurity(manifestPath, undefined, {
      debugDirectory: join(directory, "debug"),
    });
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
    // The microphone (#359): once each, and the feature is not required, so a
    // device without one can still install the app. The test used to assert the
    // opposite while nothing asked for sound; video with sound now does.
    for (const permission of ["RECORD_AUDIO", "MODIFY_AUDIO_SETTINGS"]) {
      assert.equal(
        (
          manifest.match(
            new RegExp(
              `<uses-permission android:name="android\\.permission\\.${permission}" />`,
              "g",
            ),
          ) ?? []
        ).length,
        1,
        permission,
      );
    }
    assert.equal(
      (
        manifest.match(
          /<uses-feature android:name="android\.hardware\.microphone" android:required="false" \/>/g,
        ) ?? []
      ).length,
      1,
    );
    // The permissions are exactly these: an allowlist, so that adding one (sound
    // recording in the background, storage, location, ...) fails here and has to
    // be argued, not slipped in beside the microphone. INTERNET is the one the
    // fixture manifest started with.
    const permissions = [
      ...manifest.matchAll(/<uses-permission android:name="([^"]+)"/g),
    ]
      .map((match) => match[1])
      .sort();
    assert.deepEqual(permissions, [
      "android.permission.CAMERA",
      "android.permission.INTERNET",
      "android.permission.MODIFY_AUDIO_SETTINGS",
      "android.permission.RECORD_AUDIO",
    ]);
    // And only these hardware features, none of them required.
    const features = [
      ...manifest.matchAll(
        /<uses-feature android:name="([^"]+)" android:required="([^"]+)"/g,
      ),
    ].map((match) => `${match[1]}=${match[2]}`);
    assert.deepEqual(features.sort(), [
      "android.hardware.camera.autofocus=false",
      "android.hardware.camera=false",
      "android.hardware.microphone=false",
    ]);
    // What was there stays.
    assert.match(manifest, /android\.permission\.INTERNET/);
    assert.match(manifest, /<application [^>]*android:allowBackup="false"/);
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

test("a microphone feature marked required is replaced by one that is not", () => {
  const manifest = declareMicrophone(
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.RECORD_AUDIO"/><uses-feature android:name="android.hardware.microphone" android:required="true" /><application /></manifest>',
  );
  assert.doesNotMatch(manifest, /android:required="true"/);
  assert.equal(manifest.match(/RECORD_AUDIO/g)?.length, 1);
  assert.equal(manifest.match(/MODIFY_AUDIO_SETTINGS/g)?.length, 1);
  assert.match(
    manifest,
    /<uses-feature android:name="android\.hardware\.microphone" android:required="false" \/>/,
  );
  assert.throws(() => declareMicrophone("<application />"), /manifest element/);
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
    // Page inspection is on only when the app is debuggable (a debug build), never unconditionally.
    assert.match(
      patched,
      /if \(\(applicationInfo\.flags and ApplicationInfo\.FLAG_DEBUGGABLE\) != 0\) \{\s*WebView\.setWebContentsDebuggingEnabled\(true\)\s*\}/,
    );
    assert.equal(
      patched.split("setWebContentsDebuggingEnabled").length - 1,
      1,
      "one call, inside the debuggable check",
    );
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
    // Not private: the WebView calls the method by reflection.
    assert.match(patched, /\n    inner class SystemBarsBridge \{/);
    assert.doesNotMatch(patched, /private inner class/);
    assert.match(patched, /\^#\[0-9a-fA-F\]\{6\}\$/);
    assert.match(
      patched,
      /runOnUiThread \{ setStripColour\(value, darkBackground\) \}/,
    );
    for (const line of [
      "import android.content.pm.ApplicationInfo",
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

test("the manifest names the network security config and turns cleartext off, once", () => {
  const before =
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:usesCleartextTraffic="true" android:networkSecurityConfig="@xml/other" android:label="myCarlos" /></manifest>';
  const once = setNetworkSecurityConfig(before);
  assert.equal(setNetworkSecurityConfig(once), once);
  assert.equal((once.match(/android:networkSecurityConfig=/g) ?? []).length, 1);
  assert.equal((once.match(/android:usesCleartextTraffic=/g) ?? []).length, 1);
  assert.match(
    once,
    /android:networkSecurityConfig="@xml\/mycarlos_network_security_config"/,
  );
  assert.match(once, /android:usesCleartextTraffic="false"/);
  assert.throws(() => setNetworkSecurityConfig("<manifest />"), /application/);
});

test("the manifest replaces the network security config of the platform certificate verifier's manifest, once", () => {
  const tools = 'xmlns:tools="http://schemas.android.com/tools"';
  // No tools namespace and no tools:replace yet: both are added, once, and a second run is a no-op.
  const bare =
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="myCarlos" /></manifest>';
  const once = setNetworkSecurityConfig(bare);
  assert.equal(setNetworkSecurityConfig(once), once);
  assert.equal((once.match(/xmlns:tools=/g) ?? []).length, 1);
  assert.ok(once.includes(tools));
  assert.equal((once.match(/tools:replace=/g) ?? []).length, 1);
  assert.match(
    once,
    /<application[^>]*tools:replace="android:networkSecurityConfig"/,
  );
  // The namespace is on <manifest>, the replace on <application>.
  assert.match(once, /<manifest[^>]*xmlns:tools=/);
  // An existing namespace and an existing list are kept and added to, never doubled.
  const listed = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" ${tools}><application tools:replace="android:label" android:label="myCarlos" /></manifest>`;
  const merged = setNetworkSecurityConfig(listed);
  assert.equal(setNetworkSecurityConfig(merged), merged);
  assert.equal((merged.match(/xmlns:tools=/g) ?? []).length, 1);
  assert.match(
    merged,
    /tools:replace="android:label,android:networkSecurityConfig"/,
  );
  // The values that decide the security are still this app's own, and exactly one each.
  for (const manifest of [once, merged]) {
    assert.equal(
      (
        manifest.match(
          /android:networkSecurityConfig="@xml\/mycarlos_network_security_config"/g,
        ) ?? []
      ).length,
      1,
    );
    assert.equal(
      (manifest.match(/android:usesCleartextTraffic="false"/g) ?? []).length,
      1,
    );
  }
});

test("the release config trusts the system's authorities only; the test root is in the debug source set alone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mycarlos-android-nsc-"));
  try {
    const res = join(directory, "main", "res");
    const debug = join(directory, "debug");
    await writeNetworkSecurityConfig(res, debug);
    // Writing again changes nothing.
    await writeNetworkSecurityConfig(res, debug);

    const release = await readFile(
      join(res, "xml", "mycarlos_network_security_config.xml"),
      "utf8",
    );
    assert.match(release, /<base-config cleartextTrafficPermitted="false">/);
    assert.match(release, /<certificates src="system" \/>/);
    // Nothing else to trust in a release build: no user authorities, no test root, no override.
    assert.doesNotMatch(
      release,
      /src="user"|debug-overrides|@raw|mycarlos_test_ca/,
    );
    assert.equal((release.match(/<certificates /g) ?? []).length, 1);

    const debugConfig = await readFile(
      join(debug, "res", "xml", "mycarlos_network_security_config.xml"),
      "utf8",
    );
    assert.match(
      debugConfig,
      /<base-config cleartextTrafficPermitted="false">/,
    );
    assert.match(debugConfig, /<debug-overrides>/);
    // Exactly one extra authority, the raw test root; never a user-installed one.
    assert.equal(
      (
        debugConfig.match(/<certificates src="@raw\/mycarlos_test_ca" \/>/g) ??
        []
      ).length,
      1,
    );
    assert.doesNotMatch(debugConfig, /src="user"/);

    // The test root is the repository's FAKE CA, as DER, in the debug source set only.
    const raw = await readFile(
      join(debug, "res", "raw", "mycarlos_test_ca.der"),
    );
    const fixture = await readFile(
      new URL(
        "../src-tauri/tests/fixtures/portal-test-pki/ca.der.b64",
        import.meta.url,
      ),
      "utf8",
    );
    assert.deepEqual(raw, Buffer.from(fixture.trim(), "base64"));
    assert.equal(raw[0], 0x30);
    assert.deepEqual(await readdir(join(res)), ["xml"]);
    assert.deepEqual(await readdir(join(res, "xml")), [
      "mycarlos_network_security_config.xml",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing or damaged test root stops the configuration, loudly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mycarlos-android-nsc-"));
  try {
    const res = join(directory, "res");
    const debug = join(directory, "debug");
    await assert.rejects(
      writeNetworkSecurityConfig(res, debug, join(directory, "nowhere")),
      /test root certificate/,
    );
    const pki = join(directory, "pki");
    await mkdir(pki);
    await writeFile(join(pki, "ca.der.b64"), "bm90IGEgY2VydGlmaWNhdGU=");
    await assert.rejects(
      writeNetworkSecurityConfig(res, debug, pki),
      /test root certificate/,
    );
    // Nothing was written for a debug build that could not reach the test portal.
    assert.deepEqual(await readdir(directory), ["pki"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

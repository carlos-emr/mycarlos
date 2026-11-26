import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RULES_NAME = "mycarlos_data_extraction_rules";
const DOMAINS = [
  "root",
  "file",
  "database",
  "sharedpref",
  "external",
  "device_root",
  "device_file",
  "device_database",
  "device_sharedpref",
];
const EXCLUDES = DOMAINS.map(
  (domain) => `    <exclude domain="${domain}" path="." />`,
).join("\n");
// From Android 12, `allowBackup="false"` no longer stops device-to-device
// transfer and `fullBackupContent` is ignored. Only these rules keep the vault
// header, manifests and ciphertext from migrating to another device.
const RULES = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
${EXCLUDES}
  </cloud-backup>
  <device-transfer>
${EXCLUDES}
  </device-transfer>
</data-extraction-rules>
`;

// The camera (D97): the camera dialog asks the page for video, and wry asks
// Android for this permission when it does; undeclared, Android refuses it
// without asking. Not required, so a phone or tablet without a camera can
// still install myCarlos. The camera permission also implies autofocus, so
// that is declared not required too, or Google Play would leave out devices
// whose camera has none. (The microphone is declared below, #359.)
const CAMERA_PERMISSION =
  '<uses-permission android:name="android.permission.CAMERA" />';
const CAMERA_FEATURE =
  '<uses-feature android:name="android.hardware.camera" android:required="false" />';
const AUTOFOCUS_FEATURE =
  '<uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />';

/** The manifest with the camera declared exactly once. */
export function declareCamera(manifest) {
  if (!/<manifest\b[^>]*>/.test(manifest)) {
    throw new Error("Android manifest element not found");
  }
  return manifest
    .replace(
      /\s*<uses-permission\s+android:name="android\.permission\.CAMERA"\s*\/>/g,
      "",
    )
    .replace(
      /\s*<uses-feature\s+android:name="android\.hardware\.camera(\.autofocus)?"[^>]*\/>/g,
      "",
    )
    .replace(
      /<manifest\b[^>]*>/,
      (open) =>
        `${open}\n    ${CAMERA_PERMISSION}\n    ${CAMERA_FEATURE}\n    ${AUTOFOCUS_FEATURE}`,
    );
}

// The microphone (#359): the recording dialog asks the page for video and
// sound together, and wry asks Android for RECORD_AUDIO and
// MODIFY_AUDIO_SETTINGS when it does; an undeclared permission is refused
// without asking. Not required, so a phone or tablet without a microphone can
// still install myCarlos (it then records no video, see the design). The photo
// dialog still asks for video only, and nothing asks for sound until the
// patient chooses Record video.
const RECORD_AUDIO_PERMISSION =
  '<uses-permission android:name="android.permission.RECORD_AUDIO" />';
const MODIFY_AUDIO_PERMISSION =
  '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />';
const MICROPHONE_FEATURE =
  '<uses-feature android:name="android.hardware.microphone" android:required="false" />';

/** The manifest with the microphone declared exactly once. */
export function declareMicrophone(manifest) {
  if (!/<manifest\b[^>]*>/.test(manifest)) {
    throw new Error("Android manifest element not found");
  }
  return manifest
    .replace(
      /\s*<uses-permission\s+android:name="android\.permission\.(RECORD_AUDIO|MODIFY_AUDIO_SETTINGS)"\s*\/>/g,
      "",
    )
    .replace(
      /\s*<uses-feature\s+android:name="android\.hardware\.microphone"[^>]*\/>/g,
      "",
    )
    .replace(
      /<manifest\b[^>]*>/,
      (open) =>
        `${open}\n    ${RECORD_AUDIO_PERMISSION}\n    ${MODIFY_AUDIO_PERMISSION}\n    ${MICROPHONE_FEATURE}`,
    );
}

// Which certificates the app trusts when it connects to a clinic's portal. The release build
// trusts the phone's system certificate authorities and nothing else: no user-installed CA (so
// a root a person or a malware added in Settings cannot stand in for the portal's) and no
// cleartext. The debug build adds ONE more authority, the FAKE test root that the loopback
// portal fixture's certificate is made under, from a resource that exists only in the debug
// source set (`src/debug/res`, merged into debug builds only) and so is not in a release APK or
// AAB at all. `debug-overrides` also only applies to a debuggable app, and the release safety gate
// refuses a build that carries either (scripts/release-safety/checks.mjs).
const NETWORK_CONFIG_NAME = "mycarlos_network_security_config";
const TEST_CA_NAME = "mycarlos_test_ca";
const NETWORK_BASE = `  <base-config cleartextTrafficPermitted="false">
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </base-config>
`;
const NETWORK_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
${NETWORK_BASE}</network-security-config>
`;
const NETWORK_CONFIG_DEBUG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
${NETWORK_BASE}  <debug-overrides>
    <trust-anchors>
      <certificates src="@raw/${TEST_CA_NAME}" />
    </trust-anchors>
  </debug-overrides>
</network-security-config>
`;
const REPOSITORY_TEST_PKI = fileURLToPath(
  new URL("../src-tauri/tests/fixtures/portal-test-pki", import.meta.url),
);

/** The manifest pointing at the network security config, with cleartext traffic off, once. */
export function setNetworkSecurityConfig(manifest) {
  if (!/<application\b/.test(manifest)) {
    throw new Error("Android application element not found");
  }
  return manifest
    .replace(/\s+android:networkSecurityConfig="[^"]*"/g, "")
    .replace(/\s+android:usesCleartextTraffic="[^"]*"/g, "")
    .replace(
      /<application\b/,
      `<application android:networkSecurityConfig="@xml/${NETWORK_CONFIG_NAME}" android:usesCleartextTraffic="false"`,
    );
}

/**
 * Writes the network security config into the generated project's `main` resources, and the
 * debug variant's own copy of it (which trusts the test root) with the test root itself into
 * the debug source set. The debug folder is merged over `main` for debug builds only. Stops,
 * loudly, when the test root is missing, rather than leave a debug build that cannot reach the
 * test portal.
 */
export async function writeNetworkSecurityConfig(
  resDirectory,
  debugDirectory,
  pkiDirectory = REPOSITORY_TEST_PKI,
) {
  const encoded = await readFile(
    join(pkiDirectory, "ca.der.b64"),
    "utf8",
  ).catch(() => null);
  const der = encoded === null ? null : Buffer.from(encoded.trim(), "base64");
  // A certificate is a DER SEQUENCE: 0x30. Anything else is not the file we expect.
  if (!der || der.length < 64 || der[0] !== 0x30) {
    throw new Error(
      `The test root certificate was not found or is not valid: ${join(pkiDirectory, "ca.der.b64")}`,
    );
  }
  const xml = join(resDirectory, "xml");
  await mkdir(xml, { recursive: true });
  await writeFile(
    join(xml, `${NETWORK_CONFIG_NAME}.xml`),
    NETWORK_CONFIG,
    "utf8",
  );
  const debugXml = join(debugDirectory, "res", "xml");
  const debugRaw = join(debugDirectory, "res", "raw");
  await mkdir(debugXml, { recursive: true });
  await mkdir(debugRaw, { recursive: true });
  await writeFile(
    join(debugXml, `${NETWORK_CONFIG_NAME}.xml`),
    NETWORK_CONFIG_DEBUG,
    "utf8",
  );
  await writeFile(join(debugRaw, `${TEST_CA_NAME}.der`), der);
}

// The system bars (phone feedback, 18 Nov 2026). From Android 15 an activity is
// drawn edge to edge, so the status bar (clock, notifications) and the gesture
// bar lie over the top and bottom of the page. The WebView does not report them
// to the page (`env(safe-area-inset-*)` is not reliable in it) and ignores its
// own padding for page content, so the padding goes on the activity's content
// view, which does move the WebView: the page is moved in by the size of the
// bars, of a display cutout and of the keyboard, and the insets are consumed.
// The strip that shows behind the clock is the window background. It starts
// as the header's colour for the phone's night mode (so it does not flash white
// before the page has loaded) and then follows myCarlos's own Appearance
// setting: the page tells the activity through the one-method bridge
// `MyCarlosSystemBars.set(colour, darkBackground)` (src/appearance.ts) whenever
// the setting, the system's dark mode or the theme changes, locked or not (the
// setting is read from the page's own storage, not from the vault). The bridge
// accepts only "#rrggbb". Native only: the desktop apps and the browser tests
// are not touched.
const BARS_MARKER = "mycarlos: keep the page clear of the system bars";
const BARS_IMPORTS = [
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
];
// The header's colours from src/styles.css: --canvas-2 light and dark.
const BARS_METHOD = `    // ${BARS_MARKER}
    private fun setStripColour(colour: Int, darkBackground: Boolean) {
        window.setBackgroundDrawable(ColorDrawable(colour))
        val appearance = WindowCompat.getInsetsController(window, window.decorView)
        appearance.isAppearanceLightStatusBars = !darkBackground
        appearance.isAppearanceLightNavigationBars = !darkBackground
    }

    // What the page may say: a colour as "#rrggbb" and whether it is dark. Nothing else.
    inner class SystemBarsBridge {
        @JavascriptInterface
        fun set(colour: String?, darkBackground: Boolean) {
            if (colour == null || !Regex("^#[0-9a-fA-F]{6}$").matches(colour)) return
            val value = Color.parseColor(colour)
            runOnUiThread { setStripColour(value, darkBackground) }
        }
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        // Page inspection (so a test can drive the page over the DevTools protocol) only in a debug
        // build: the flag is set by the debug variant and by nothing in a release build.
        if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        setStripColour(if (night) 0xFF21372F.toInt() else 0xFFE7EFED.toInt(), night)
        webView.addJavascriptInterface(SystemBarsBridge(), "MyCarlosSystemBars")
        val content = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(content)
    }
`;

/** The generated MainActivity with the page kept clear of the system bars, once. */
export function keepPageClearOfSystemBars(source) {
  if (source.includes(BARS_MARKER)) return source;
  if (/onWebViewCreate/.test(source)) {
    throw new Error(
      "MainActivity already overrides onWebViewCreate; review it before patching",
    );
  }
  const classMatch = /class\s+MainActivity\b[^{\n]*/.exec(source);
  if (!classMatch) throw new Error("MainActivity class not found");
  let patched = source;
  const end = classMatch.index + classMatch[0].length;
  if (patched.slice(end).trimStart().startsWith("{")) {
    // Before the class's own closing brace (found by counting braces), so that
    // anything declared after the class stays where it is.
    let depth = 0;
    let close = -1;
    for (let i = patched.indexOf("{", end); i < patched.length; i++) {
      if (patched[i] === "{") depth++;
      if (patched[i] === "}" && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) throw new Error("MainActivity class body is not closed");
    patched = `${patched.slice(0, close).replace(/\s*$/, "")}\n\n${BARS_METHOD}${patched.slice(close)}`;
  } else {
    patched = `${patched.slice(0, end)} {\n${BARS_METHOD}}${patched.slice(end)}`;
  }
  const missing = BARS_IMPORTS.filter((line) => !patched.includes(line));
  if (missing.length > 0) {
    patched = patched.replace(
      /^(package\s+[\w.]+[^\n]*\n)/m,
      `$1\n${missing.join("\n")}\n`,
    );
  }
  return patched;
}

async function findMainActivity(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findMainActivity(path);
      if (found) return found;
    } else if (entry.name === "MainActivity.kt") {
      return path;
    }
  }
  return null;
}

const REPOSITORY_ANDROID_ICONS = fileURLToPath(
  new URL("../src-tauri/icons/android", import.meta.url),
);

/**
 * Put the repository's launcher icons (`src-tauri/icons/android`, laid out as
 * an Android `res` folder) into the generated project, which `tauri android
 * init` fills with Tauri's default icon. It overwrites the files of the same
 * name, removes a same-named file of another image type next to one it writes
 * (a duplicate resource would stop the build), and is safe to run again. It
 * stops, loudly, when the generated `res` folder or the icons are missing.
 */
export async function copyLauncherIcons(
  resDirectory,
  iconsDirectory = REPOSITORY_ANDROID_ICONS,
) {
  for (const [directory, what] of [
    [resDirectory, "generated Android res folder"],
    [iconsDirectory, "repository Android icons"],
  ]) {
    const info = await stat(directory).catch(() => null);
    if (!info?.isDirectory()) {
      throw new Error(`The ${what} was not found: ${directory}`);
    }
  }
  const folders = (await readdir(iconsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (!folders.some((name) => name.startsWith("mipmap-"))) {
    throw new Error(`No mipmap folders in ${iconsDirectory}`);
  }
  for (const folder of folders) {
    const target = join(resDirectory, folder);
    await mkdir(target, { recursive: true });
    for (const file of await readdir(join(iconsDirectory, folder))) {
      const stem = file.slice(0, file.length - extname(file).length);
      for (const other of await readdir(target)) {
        if (
          other !== file &&
          other.slice(0, other.length - extname(other).length) === stem
        ) {
          await rm(join(target, other));
        }
      }
      await cp(join(iconsDirectory, folder, file), join(target, file));
    }
  }
}

export async function configureAndroidSecurity(
  manifestPath,
  iconsDirectory = REPOSITORY_ANDROID_ICONS,
  {
    // `app/src/debug`, beside the manifest's `app/src/main`.
    debugDirectory = join(dirname(manifestPath), "..", "debug"),
    pkiDirectory = REPOSITORY_TEST_PKI,
  } = {},
) {
  let manifest = await readFile(manifestPath, "utf8");
  if (!/<application\b/.test(manifest)) {
    throw new Error(`Android application element not found in ${manifestPath}`);
  }

  manifest = manifest
    .replace(/\s+android:allowBackup="[^"]*"/g, "")
    .replace(/\s+android:fullBackupContent="[^"]*"/g, "")
    .replace(/\s+android:dataExtractionRules="[^"]*"/g, "")
    .replace(
      /<application\b/,
      `<application android:allowBackup="false" android:fullBackupContent="false" android:dataExtractionRules="@xml/${RULES_NAME}"`,
    );
  manifest = declareCamera(manifest);
  manifest = declareMicrophone(manifest);
  manifest = setNetworkSecurityConfig(manifest);

  const resDirectory = join(dirname(manifestPath), "res");
  await copyLauncherIcons(resDirectory, iconsDirectory);
  const resources = join(resDirectory, "xml");
  await mkdir(resources, { recursive: true });
  await writeFile(join(resources, `${RULES_NAME}.xml`), RULES, "utf8");
  await writeNetworkSecurityConfig(resDirectory, debugDirectory, pkiDirectory);
  await writeFile(manifestPath, manifest, "utf8");

  const activity = await findMainActivity(join(dirname(manifestPath), "java"));
  if (!activity) {
    throw new Error(
      `MainActivity.kt not found under ${dirname(manifestPath)}/java`,
    );
  }
  await writeFile(
    activity,
    keepPageClearOfSystemBars(await readFile(activity, "utf8")),
    "utf8",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await configureAndroidSecurity(
    process.argv[2] ?? "src-tauri/gen/android/app/src/main/AndroidManifest.xml",
  );
}

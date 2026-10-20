import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

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
// still install myCarlos. Nothing asks for the microphone, so it is not
// declared.
const CAMERA_PERMISSION =
  '<uses-permission android:name="android.permission.CAMERA" />';
const CAMERA_FEATURE =
  '<uses-feature android:name="android.hardware.camera" android:required="false" />';

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
      /\s*<uses-feature\s+android:name="android\.hardware\.camera"[^>]*\/>/g,
      "",
    )
    .replace(
      /<manifest\b[^>]*>/,
      (open) => `${open}\n    ${CAMERA_PERMISSION}\n    ${CAMERA_FEATURE}`,
    );
}

export async function configureAndroidSecurity(manifestPath) {
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

  const resources = join(dirname(manifestPath), "res", "xml");
  await mkdir(resources, { recursive: true });
  await writeFile(join(resources, `${RULES_NAME}.xml`), RULES, "utf8");
  await writeFile(manifestPath, manifest, "utf8");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await configureAndroidSecurity(
    process.argv[2] ?? "src-tauri/gen/android/app/src/main/AndroidManifest.xml",
  );
}

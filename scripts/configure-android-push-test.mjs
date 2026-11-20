// Hosted synthetic APK only. Separate Android app id and data. This configuration cannot
// identify a Firebase project and the debug overlay removes its initialization provider.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configureAndroidPush } from "./configure-android-push.mjs";

const app = "src-tauri/gen/android/app";
await configureAndroidPush(app, {
  project_info: { project_number: "123", project_id: "synthetic-only" },
  client: [
    {
      client_info: {
        android_client_info: { package_name: "ca.carlos.mycarlos" },
        mobilesdk_app_id: "synthetic-app",
      },
      api_key: [{ current_key: "synthetic-public-client-value" }],
    },
  ],
});
const gradle = join(app, "build.gradle.kts");
const marker =
  'android.buildTypes.getByName("debug").applicationIdSuffix = ".pushtest"';
const content = await readFile(gradle, "utf8");
if (!content.includes(marker))
  await writeFile(gradle, content + "\n" + marker + "\n");
const debug = join(app, "src/debug");
const kotlin = join(debug, "java/ca/carlos/mycarlos/push");
await mkdir(kotlin, { recursive: true });
await copyFile(
  "src-tauri/android-push/test/NoticePreviewActivity.kt",
  join(kotlin, "NoticePreviewActivity.kt"),
);
const manifest = join(debug, "AndroidManifest.xml");
// Preserve the Tauri debug manifest, including any network/traffic declarations.
const overlay = await readFile(
  "src-tauri/android-push/test/AndroidManifest.xml",
  "utf8",
);
let existing;
try {
  existing = await readFile(manifest, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!existing) await writeFile(manifest, overlay);
else if (!existing.includes("ca.carlos.mycarlos.push.NoticePreviewActivity")) {
  const additions = overlay.match(/<application>([\s\S]*?)<\/application>/)[1];
  let merged = existing;
  if (!merged.includes("xmlns:tools="))
    merged = merged.replace(
      "<manifest",
      '<manifest xmlns:tools="http://schemas.android.com/tools"',
    );
  if (merged.includes("</application>"))
    merged = merged.replace("</application>", additions + "</application>");
  else if (/<application\b[^>]*\/>/.test(merged))
    merged = merged.replace(
      /(<application\b[^>]*?)\/>/,
      "$1>" + additions + "</application>",
    );
  else
    merged = merged.replace(
      "</manifest>",
      "<application>" + additions + "</application></manifest>",
    );
  await writeFile(manifest, merged);
}

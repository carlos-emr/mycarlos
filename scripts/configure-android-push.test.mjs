import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureAndroidPush,
  firebaseResources,
  patchManifest,
  patchGradle,
  patchKotlinCompiler,
} from "./configure-android-push.mjs";
const config = {
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
};
test("configuration rejects wrong app and incomplete client values", () => {
  assert.throws(() => firebaseResources({ ...config, client: [] }));
  assert.throws(() => firebaseResources({ ...config, project_info: {} }));
});
test("manifest is idempotent, disables collection, and refuses unmanaged messaging", () => {
  const manifest =
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:allowBackup="false"></application></manifest>';
  const result = patchManifest(manifest);
  assert.equal(patchManifest(result), result);
  assert.match(result, /android:exported="false"/);
  assert.match(
    result,
    /firebase_messaging_auto_init_enabled" android:value="false"/,
  );
  assert.match(
    result,
    /firebase_analytics_collection_enabled" android:value="false"/,
  );
  assert.match(result, /android:allowBackup="false"/);
  assert.throws(() =>
    patchManifest(
      manifest.replace(
        "</application>",
        "<service>com.google.firebase.MESSAGING_EVENT</service></application>",
      ),
    ),
  );
});
test("generated project receives service/resources/dependency once; invalid config leaves it unchanged", async () => {
  const project = await mkdtemp(join(tmpdir(), "mycarlos-push-"));
  const root = join(project, "app");
  try {
    await mkdir(join(root, "src/main"), { recursive: true });
    await writeFile(
      join(project, "build.gradle.kts"),
      'classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")',
    );
    const manifest =
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application></application></manifest>';
    await writeFile(join(root, "src/main/AndroidManifest.xml"), manifest);
    await writeFile(join(root, "build.gradle.kts"), "plugins {}\n");
    const path = join(root, "firebase.json");
    await writeFile(path, "{}");
    await assert.rejects(configureAndroidPush(root, path));
    assert.equal(
      await readFile(join(root, "src/main/AndroidManifest.xml"), "utf8"),
      manifest,
    );
    await writeFile(path, JSON.stringify(config));
    await configureAndroidPush(root, path);
    const outputs = [
      "../build.gradle.kts",
      "src/main/AndroidManifest.xml",
      "build.gradle.kts",
      "src/main/res/values/mycarlos_firebase.xml",
      "src/main/res/drawable/mycarlos_push.xml",
      ...[
        "PushPlugin.kt",
        "PushState.kt",
        "ReadyMessagingService.kt",
        "ScopedCredentialStore.kt",
      ].map((file) => `src/main/java/ca/carlos/mycarlos/push/${file}`),
    ];
    const once = await Promise.all(
      outputs.map((file) => readFile(join(root, file))),
    );
    await configureAndroidPush(root, path);
    const twice = await Promise.all(
      outputs.map((file) => readFile(join(root, file))),
    );
    for (let index = 0; index < outputs.length; index++)
      assert.deepEqual(
        twice[index],
        once[index],
        `Repeated hook changed ${outputs[index]}`,
      );
    assert.equal(
      (await readFile(join(root, "build.gradle.kts"), "utf8")).match(
        /firebase-messaging:/g,
      ).length,
      1,
    );
    assert.match(
      await readFile(
        join(
          root,
          "src/main/java/ca/carlos/mycarlos/push/ReadyMessagingService.kt",
        ),
        "utf8",
      ),
      /override fun onNewToken/,
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("unmanaged Gradle messaging dependencies fail before touching the project", async () => {
  assert.throws(() =>
    patchGradle(
      'dependencies { implementation("com.google.firebase:firebase-messaging:25.0.0") }',
    ),
  );
  assert.throws(() => patchGradle("implementation(libs.firebase.messaging)"));
  for (const dependency of [
    'implementation(platform("com.google.firebase:firebase-bom:35.1.0"))',
    'implementation(enforcedPlatform("com.google.firebase:firebase-bom:35.1.0"))',
    "implementation(platform(libs.firebase.bom))",
    "implementation(enforcedPlatform(libs.firebaseBom))",
    "implementation(platform(libs.FirebasePlatform))",
  ])
    assert.throws(() => patchGradle(dependency));
  const managed = patchGradle("plugins {}\n");
  assert.equal(patchGradle(managed), managed);
});

test("push compiler matches Firebase Kotlin metadata and refuses unknown compilers", () => {
  const original =
    'classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")';
  const result = patchKotlinCompiler(original);
  assert.match(result, /kotlin-gradle-plugin:2.1.21/);
  assert.equal(patchKotlinCompiler(result), result);
  assert.throws(() => patchKotlinCompiler(original.replace("1.9.25", "2.0.0")));
  assert.throws(() => patchKotlinCompiler(original + original));
});

// The notice's words (#299): one Android string file per language, equal to the Fluent message
// notification-android-newDocument, and the Kotlin reads the resource instead of English text.
const NOTICE_LOCALES = {
  en: "values",
  es: "values-es",
  fr: "values-fr",
  pl: "values-pl",
  "pt-BR": "values-pt-rBR",
  "zh-CN": "values-zh-rCN",
  "zh-TW": "values-zh-rTW",
};
const unescapeXml = (text) =>
  text.replace(/\\'/g, "'").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

test("the notice has its words in every language, equal to the Fluent message", async () => {
  let english;
  for (const [locale, dir] of Object.entries(NOTICE_LOCALES)) {
    const fluent = await readFile(
      `src/i18n/locales/fluent/${locale}.ftl`,
      "utf8",
    );
    const message = fluent.match(/^notification-android-newDocument = (.+)$/m);
    assert.ok(message, `${locale}.ftl has the message`);
    const xml = await readFile(
      `src-tauri/android-push/res/${dir}/mycarlos_push_strings.xml`,
      "utf8",
    );
    const text = xml.match(
      /<string name="mycarlos_push_new_document">([^<]+)<\/string>/,
    );
    assert.ok(text, `${dir} has the string`);
    assert.equal(unescapeXml(text[1]), message[1], `${locale} matches Fluent`);
    if (locale === "en") english = message[1];
    else assert.notEqual(message[1], english, `${locale} is translated`);
  }
});

test("the Kotlin notice reads its text from the string resource", async () => {
  const kotlin = await readFile(
    "src-tauri/android-push/kotlin/ReadyMessagingService.kt",
    "utf8",
  );
  assert.match(kotlin, /R\.string\.mycarlos_push_new_document/);
  assert.doesNotMatch(kotlin, /A new document is available/);
});

test("the generated project receives every language's notice text", async () => {
  const project = await mkdtemp(join(tmpdir(), "mycarlos-push-res-"));
  const root = join(project, "app");
  try {
    await mkdir(join(root, "src/main"), { recursive: true });
    await writeFile(
      join(project, "build.gradle.kts"),
      'classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")',
    );
    await writeFile(
      join(root, "src/main/AndroidManifest.xml"),
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application></application></manifest>',
    );
    await writeFile(join(root, "build.gradle.kts"), "plugins {}\n");
    await configureAndroidPush(root, config);
    for (const dir of Object.values(NOTICE_LOCALES))
      assert.match(
        await readFile(
          join(root, "src/main/res", dir, "mycarlos_push_strings.xml"),
          "utf8",
        ),
        /mycarlos_push_new_document/,
        dir,
      );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

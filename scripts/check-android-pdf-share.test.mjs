import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  configProblems,
  mainActivityFilters,
  manifestProblems,
} from "./check-android-pdf-share.mjs";

const manifest = (
  filters,
) => `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application>
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
      ${filters}
    </activity>
    <activity android:name=".Other"><intent-filter>
      <action android:name="android.intent.action.VIEW" />
      <data android:mimeType="image/png" />
    </intent-filter></activity>
  </application>
</manifest>`;

const send = (action) => `<intent-filter>
  <action android:name="android.intent.action.${action}" />
  <category android:name="android.intent.category.DEFAULT" />
  <data android:mimeType="application/pdf" />
</intent-filter>`;

const right = manifest(send("SEND") + send("SEND_MULTIPLE"));

test("the source file asks for SEND and SEND_MULTIPLE for PDFs and no VIEW", () => {
  const config = JSON.parse(
    readFileSync(
      new URL("../src-tauri/tauri.android.conf.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(configProblems(config), []);
  const shared = JSON.parse(
    readFileSync(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(shared.bundle.fileAssociations, undefined);
  const one = (fields) => ({
    bundle: {
      fileAssociations: [
        {
          ext: ["pdf"],
          mimeType: "application/pdf",
          androidIntentActionFilters: ["send", "sendMultiple"],
          ...fields,
        },
      ],
    },
  });
  assert.match(
    configProblems(
      one({ androidIntentActionFilters: ["send", "sendMultiple", "view"] }),
    )[0],
    /no "view"/,
  );
  assert.match(
    configProblems(one({ androidIntentActionFilters: ["send"] }))[0],
    /sendMultiple/,
  );
  assert.deepEqual(configProblems(one({ mimeType: "image/png" })), [
    "mimeType is not application/pdf",
  ]);
  assert.deepEqual(configProblems({}), [
    "expected one bundle.fileAssociations entry",
  ]);
});

test("a generated manifest is accepted only with the two PDF share filters and no VIEW", () => {
  assert.deepEqual(manifestProblems(right), []);
  // Only MainActivity's filters count for the SEND filters.
  assert.equal(mainActivityFilters(right).length, 3);
  assert.match(manifestProblems(manifest(send("SEND")))[0], /SEND_MULTIPLE/);
  assert.match(manifestProblems(manifest(""))[0], /SEND filter/);
  assert.match(
    manifestProblems(
      manifest(
        send("SEND") +
          send("SEND_MULTIPLE") +
          `<intent-filter><action android:name="android.intent.action.VIEW" />
             <data android:mimeType="application/pdf" /></intent-filter>`,
      ),
    )[0],
    /VIEW/,
  );
  assert.match(
    manifestProblems(
      manifest(
        send("SEND") +
          send("SEND_MULTIPLE") +
          `<intent-filter><action android:name="android.intent.action.VIEW" />
             <data android:scheme="content" /></intent-filter>`,
      ),
    )[0],
    /VIEW/,
  );
  assert.match(
    manifestProblems(
      manifest(
        send("SEND").replace("application/pdf", "text/plain") +
          send("SEND_MULTIPLE"),
      ),
    ).join(" "),
    /SEND filter takes text\/plain/,
  );
  assert.match(
    manifestProblems(
      manifest(
        send("SEND").replace(/<category[^>]*>/, "") + send("SEND_MULTIPLE"),
      ),
    )[0],
    /DEFAULT/,
  );
  assert.deepEqual(manifestProblems("<manifest />"), ["no MainActivity found"]);
});

// What tauri-build 2.6 writes for this configuration, as one filter between its markers: both
// actions together, DEFAULT and BROWSABLE, the MIME type and a path pattern for the extension.
const generated = `<intent-filter>
    <action android:name="android.intent.action.SEND" />
    <action android:name="android.intent.action.SEND_MULTIPLE" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:mimeType="application/pdf" />
    <data android:pathPattern=".*\\\\.pdf" />
</intent-filter>`;

test("the filter tauri-build really writes is accepted", () => {
  const real = manifest(`<!-- tauri-file-associations-block -->${generated}`);
  assert.deepEqual(manifestProblems(real), []);
  // One filter holds both actions: it counts for each.
  assert.equal(mainActivityFilters(real).length, 2);
  // Without the DEFAULT category it would never be offered, and the check says so.
  assert.match(
    manifestProblems(
      manifest(generated.replace(/<category[^>]*DEFAULT[^>]*>/, "")),
    )[0],
    /DEFAULT/,
  );
});

test("VIEW filters for any type that could take a PDF are refused, on the activity or its alias", () => {
  const view = (data) =>
    `<intent-filter><action android:name="android.intent.action.VIEW" />${data}</intent-filter>`;
  for (const data of [
    '<data android:mimeType="application/*" />',
    '<data android:mimeType="*/*" />',
    '<data android:mimeType="application/pdf" />',
    '<data android:scheme="file" />',
  ]) {
    assert.match(
      manifestProblems(manifest(generated + view(data)))[0],
      /VIEW/,
      data,
    );
  }
  // Another type's VIEW filter (a deep link, an image) is not ours to refuse.
  assert.deepEqual(
    manifestProblems(
      manifest(generated + view('<data android:mimeType="image/png" />')),
    ),
    [],
  );
  // The same on an alias of MainActivity, which is MainActivity as far as Android is concerned.
  const aliased = right.replace(
    "</application>",
    `<activity-alias android:name=".Share" android:targetActivity=".MainActivity">${view(
      '<data android:mimeType="*/*" />',
    )}</activity-alias></application>`,
  );
  assert.match(manifestProblems(aliased)[0], /VIEW/);
  // An alias of another activity is as bad: the file-association filters go into every activity.
  assert.match(
    manifestProblems(
      aliased.replace(
        'targetActivity=".MainActivity"',
        'targetActivity=".Other"',
      ),
    )[0],
    /VIEW/,
  );
});

// The real template: the opening tag is followed by a newline and one attribute per line, and
// tauri-utils writes the filters before EVERY `</activity>`.
const template = (filters) => `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="myCarlos">
        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize"
            android:exported="true"
            android:launchMode="singleTask"
            android:label="@string/main_activity_title"
            android:name=".MainActivity"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <!-- AUTO-GENERATED. DO NOT REMOVE. -->
            ${filters}
            <!-- AUTO-GENERATED. DO NOT REMOVE. -->
        </activity>
        <activity
            android:name=".Second"
            android:exported="false">
            ${filters}
        </activity>
    </application>
</manifest>`;

test("the real template's layout, with the filters in every activity, is read", () => {
  assert.deepEqual(manifestProblems(template(generated)), []);
  assert.equal(mainActivityFilters(template(generated)).length, 2);
  // A VIEW filter on the second activity is as bad as on MainActivity.
  const view = `<intent-filter><action android:name="android.intent.action.VIEW" />
    <data android:mimeType="application/pdf" /></intent-filter>`;
  assert.match(manifestProblems(template(generated + view))[0], /VIEW/);
  // `<activity-alias` is not an `<activity`, however the tag is laid out.
  assert.deepEqual(manifestProblems(template("")).length, 2);
});

test("VIEW filters by octet-stream or a .pdf path are refused", () => {
  const view = (data) =>
    `<intent-filter><action android:name="android.intent.action.VIEW" />${data}</intent-filter>`;
  for (const data of [
    '<data android:mimeType="application/octet-stream" />',
    '<data android:pathPattern=".*\\\\.pdf" />',
    '<data android:pathPattern=".*\\\\.PDF" />',
  ]) {
    assert.match(
      manifestProblems(template(generated + view(data)))[0],
      /VIEW/,
      data,
    );
  }
});

test("a SEND filter for another type is refused on any activity, not only MainActivity", () => {
  const text = generated.replace("application/pdf", "text/plain");
  // On the second activity of the real template's layout only.
  const second = template(generated).replace(
    /(android:name="\.Second"[\s\S]*?)<intent-filter>[\s\S]*?<\/intent-filter>/,
    `$1${text}`,
  );
  assert.match(
    manifestProblems(second).join(" "),
    /a SEND filter takes text\/plain/,
  );
  assert.deepEqual(manifestProblems(template(generated)), []);
});

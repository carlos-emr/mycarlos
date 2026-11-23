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
      <data android:mimeType="application/pdf" />
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
  // Only MainActivity's filters count: another activity's VIEW filter is not ours.
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
  // An alias of another activity is not.
  assert.deepEqual(
    manifestProblems(
      aliased.replace(
        'targetActivity=".MainActivity"',
        'targetActivity=".Other"',
      ),
    ),
    [],
  );
});

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

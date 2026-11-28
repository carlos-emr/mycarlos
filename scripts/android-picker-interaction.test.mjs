import assert from "node:assert/strict";
import test from "node:test";
import {
  foregroundPackage,
  launchFromHome,
  tapDownloadsRoot,
} from "./android-picker-interaction.mjs";

const downloads = { pkg: /.*\.documentsui/, text: "Downloads" };
const stale = new Error(
  "androidDevice.tap: androidx.test.uiautomator.StaleObjectException",
);

test("reacquires Downloads when the opening drawer replaces the native node", async () => {
  const tap = test.mock.fn(async () => {});
  tap.mock.mockImplementationOnce(async () => {
    throw stale;
  });
  await tapDownloadsRoot({ tap }, downloads);
  assert.deepEqual(
    tap.mock.calls.map((call) => call.arguments),
    [[downloads], [downloads]],
  );
});

test("lets an unrelated picker error fail the first tap", async () => {
  const missing = new Error("androidDevice.tap: selector not found");
  const tap = test.mock.fn(async () => {
    throw missing;
  });
  await assert.rejects(
    tapDownloadsRoot({ tap }, downloads),
    (e) => e === missing,
  );
  assert.equal(tap.mock.callCount(), 1);
});

test("reports a persistently stale native selector after four attempts", async () => {
  const tap = test.mock.fn(async () => {
    throw stale;
  });
  await assert.rejects(
    tapDownloadsRoot({ tap }, downloads),
    (e) => e === stale,
  );
  assert.equal(tap.mock.callCount(), 4);
});

test("asks the existing Android launcher route to deliver one app event", async () => {
  const shell = test.mock.fn(async () => Buffer.from("Events injected: 1\n"));
  await launchFromHome({ shell });
  assert.deepEqual(shell.mock.calls[0].arguments, [
    "monkey -p ca.carlos.mycarlos -c android.intent.category.LAUNCHER 1",
  ]);
});

test("refuses a launcher command that injected no event", async () => {
  const shell = async () =>
    Buffer.from("** No activities found to run, monkey aborted.");
  await assert.rejects(launchFromHome({ shell }), /No activities found to run/);
});

test("reads the top-resumed activity ahead of a stale resumed activity", () => {
  const previous =
    " mResumedActivity: ActivityRecord{ee u0 ca.carlos.mycarlos/.MainActivity t8}";
  const home =
    " topResumedActivity=ActivityRecord{ab u0 com.android.launcher3/.QuickstepLauncher t7}";
  assert.equal(
    foregroundPackage(Buffer.from(`${previous}\n${home}`)),
    "com.android.launcher3",
  );
  assert.equal(foregroundPackage(previous), "ca.carlos.mycarlos");
  assert.equal(foregroundPackage(`${previous}\ntopResumedActivity=null`), "");
});

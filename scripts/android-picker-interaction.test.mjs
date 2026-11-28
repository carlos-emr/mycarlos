import assert from "node:assert/strict";
import test from "node:test";
import {
  foregroundActivity,
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

const main = "ca.carlos.mycarlos/.MainActivity";

test("uses the resolved app activity with the Home launcher flags and retains the receipt", async () => {
  const output =
    "Warning: Activity not started, its current task has been brought to the front\nStatus: ok\n";
  const shell = test.mock.fn(async () => Buffer.from(output));
  assert.equal(await launchFromHome({ shell }, main), output.trim());
  assert.deepEqual(shell.mock.calls[0].arguments, [
    `am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -f 0x10200000 -n '${main}'`,
  ]);
});

test("reports an unsuccessful Android launch without polling for return", async () => {
  const shell = async () =>
    Buffer.from("Error: Activity class does not exist.\n");
  await assert.rejects(
    launchFromHome({ shell }, main),
    /Activity class does not exist/,
  );
});

test("rejects a foreign activity before contacting Android", async () => {
  const shell = test.mock.fn();
  await assert.rejects(
    launchFromHome({ shell }, "com.android.launcher3/.Launcher"),
  );
  assert.equal(shell.mock.callCount(), 0);
});

test("reads the exact top-resumed activity and task ahead of a stale resumed activity", () => {
  const previous =
    " mResumedActivity: ActivityRecord{ee u0 ca.carlos.mycarlos/.MainActivity t8}";
  const home =
    " topResumedActivity=ActivityRecord{ab u0 com.android.launcher3/.QuickstepLauncher t7}";
  assert.deepEqual(foregroundActivity(Buffer.from(`${previous}\n${home}`)), {
    component: "com.android.launcher3/.QuickstepLauncher",
    packageName: "com.android.launcher3",
    record: "ab",
    task: "7",
  });
  assert.deepEqual(foregroundActivity(previous), {
    component: main,
    packageName: "ca.carlos.mycarlos",
    record: "ee",
    task: "8",
  });
  assert.equal(
    foregroundActivity(`${previous}\ntopResumedActivity=null`),
    null,
  );
});

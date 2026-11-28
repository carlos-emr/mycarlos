import assert from "node:assert/strict";
import test from "node:test";
import { tapDownloadsRoot } from "./android-picker-interaction.mjs";

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

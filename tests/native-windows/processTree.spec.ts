import { expect, test } from "@playwright/test";
import { stopAppTree, TASKKILL_NOT_RUNNING } from "./processTree";

// The teardown of navigation.spec.ts, without an app: runs on any platform.
function failure(code: number) {
  return Object.assign(new Error(`Command failed: taskkill (${code})`), {
    code,
  });
}

test("stops the app's whole process tree by its PID", async () => {
  const calls: [string, string[]][] = [];
  let asked = false;
  await stopAppTree(
    1228,
    async (file, args) => void calls.push([file, args]),
    async () => (asked = true),
  );
  expect(calls).toEqual([["taskkill", ["/PID", "1228", "/T", "/F"]]]);
  // Nothing failed, so there was nothing to check.
  expect(asked).toBe(false);
});

test("accepts a child that ended by itself once the app has exited", async () => {
  await expect(
    stopAppTree(
      1228,
      () => Promise.reject(failure(TASKKILL_NOT_RUNNING)),
      async () => true,
    ),
  ).resolves.toBeUndefined();
});

test("still fails when the app has not exited", async () => {
  await expect(
    stopAppTree(
      1228,
      () => Promise.reject(failure(TASKKILL_NOT_RUNNING)),
      async () => false,
    ),
  ).rejects.toThrow(`taskkill (${TASKKILL_NOT_RUNNING})`);
});

test("still fails on any other taskkill error", async () => {
  // Access denied, a timeout (no exit code) or an unknown PID, even after
  // the app exited.
  for (const error of [
    failure(1),
    failure(255),
    Object.assign(new Error("timed out"), { killed: true }),
  ])
    await expect(
      stopAppTree(
        1228,
        () => Promise.reject(error),
        async () => true,
      ),
    ).rejects.toBe(error);
});

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

// The same teardown with the process table as a second witness: the app's own 'exit' event can be
// missed or late (Windows run 45406404939, where taskkill answered 128 for a child that had gone).
const FAST = { waitMs: 200, pollMs: 5 };

test("accepts a child that ended by itself when the root process is gone, though no exit came", async () => {
  let looks = 0;
  await expect(
    stopAppTree(
      1228,
      () => Promise.reject(failure(TASKKILL_NOT_RUNNING)),
      async () => false,
      { ...FAST, rootGone: async () => ++looks >= 3 },
    ),
  ).resolves.toBeUndefined();
  expect(looks).toBe(3);
});

test("does not wait for the process table when the exit event already answered", async () => {
  let looks = 0;
  const started = Date.now();
  await stopAppTree(
    1228,
    () => Promise.reject(failure(TASKKILL_NOT_RUNNING)),
    async () => true,
    {
      waitMs: 60_000,
      pollMs: 5,
      rootGone: async () => {
        looks++;
        return false;
      },
    },
  );
  expect(Date.now() - started).toBeLessThan(5_000);
  // The poller was told to stop: it does not go on looking after the answer.
  const seen = looks;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(looks).toBe(seen);
});

test("fails with taskkill's exit code and the app's state when nothing shows it gone", async () => {
  await expect(
    stopAppTree(
      1228,
      () => Promise.reject(failure(TASKKILL_NOT_RUNNING)),
      async () => false,
      {
        ...FAST,
        rootGone: async () => false,
        describeApp: () => "exitCode=null, signalCode=null",
      },
    ),
  ).rejects.toThrow(
    /taskkill exit code 128; the app, PID 1228, was not seen to exit: exitCode=null, signalCode=null/,
  );
});

test("a failing check of the process table counts as not gone, not as a crash", async () => {
  await expect(
    stopAppTree(
      1228,
      () => Promise.reject(failure(TASKKILL_NOT_RUNNING)),
      async () => false,
      {
        ...FAST,
        rootGone: () => Promise.reject(new Error("tasklist failed")),
      },
    ),
  ).rejects.toThrow(/was not seen to exit/);
});

// A child that was already leaving when taskkill reached it (Windows run 45962064313): one ERROR
// line per such child, on stderr (and copied into the message by `execFile`). The exit code is
// not recorded in that log; these tests use 1, and the code does not matter to the matching.
const CHILD_NOT_SUPPORTED =
  "ERROR: The process with PID 8784 (child process of PID 2504) could not be terminated.\r\n" +
  "Reason: The operation attempted is not supported.\r\n";

function refusal(stderr: string, shape: "stderr" | "message-only" = "stderr") {
  const message = `Command failed: taskkill /PID 2504 /T /F\n${stderr}`;
  return Object.assign(
    new Error(message),
    shape === "stderr" ? { code: 1, stderr } : { code: 1 },
  );
}

test("accepts a child refused as 'not supported' once the app has exited", async () => {
  for (const shape of ["stderr", "message-only"] as const)
    await expect(
      stopAppTree(
        2504,
        () => Promise.reject(refusal(CHILD_NOT_SUPPORTED, shape)),
        async () => true,
      ),
    ).resolves.toBeUndefined();
});

test("accepts several children refused as 'not supported' when the root process is gone, though no exit came", async () => {
  let looks = 0;
  await expect(
    stopAppTree(
      2504,
      () =>
        Promise.reject(
          refusal(
            CHILD_NOT_SUPPORTED + CHILD_NOT_SUPPORTED.replace("8784", "9120"),
          ),
        ),
      async () => false,
      { ...FAST, rootGone: async () => ++looks >= 2 },
    ),
  ).resolves.toBeUndefined();
  expect(looks).toBe(2);
});

test("fails when a child was refused as 'not supported' but the app has not exited", async () => {
  await expect(
    stopAppTree(
      2504,
      () => Promise.reject(refusal(CHILD_NOT_SUPPORTED)),
      async () => false,
      {
        ...FAST,
        rootGone: async () => false,
        describeApp: () => "exitCode=null, signalCode=null",
      },
    ),
  ).rejects.toThrow(
    /taskkill refused only children that were leaving \(not supported\); the app, PID 2504, was not seen to exit: exitCode=null, signalCode=null/,
  );
});

test("a 'not supported' refusal that is not only for children is thrown as it came, even after the app exited", async () => {
  for (const stderr of [
    // The app's own process (no "child process of"): not a child that was leaving.
    "ERROR: The process with PID 2504 could not be terminated.\r\nReason: The operation attempted is not supported.\r\n",
    // A child refused for another reason, alone or beside a leaving one.
    "ERROR: The process with PID 8784 (child process of PID 2504) could not be terminated.\r\nReason: Access is denied.\r\n",
    CHILD_NOT_SUPPORTED +
      "ERROR: The process with PID 9120 (child process of PID 2504) could not be terminated.\r\nReason: Access is denied.\r\n",
    // Not a taskkill refusal at all.
    "ERROR: Invalid argument/option - '/X'.\r\n",
  ]) {
    const error = refusal(stderr);
    await expect(
      stopAppTree(
        2504,
        () => Promise.reject(error),
        async () => true,
        { ...FAST, rootGone: async () => true },
      ),
    ).rejects.toBe(error);
  }
});

test("another taskkill error is still thrown as it came, whatever the process table says", async () => {
  const error = failure(5);
  await expect(
    stopAppTree(
      1228,
      () => Promise.reject(error),
      async () => true,
      { ...FAST, rootGone: async () => true },
    ),
  ).rejects.toBe(error);
});

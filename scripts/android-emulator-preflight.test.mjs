import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emulatorSerial } from "./android-emulator-preflight.mjs";

const hosted = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };
const serial = "emulator-5554";
const listing = "List of devices attached\n";

function check({
  env = hosted,
  devices = serial + "\tdevice",
  qemu = "1",
  packages = "package:android",
} = {}) {
  return emulatorSerial({
    env,
    beforeInstall: true,
    adb(...args) {
      if (args.join(" ") === "devices") return listing + devices + "\n";
      assert.deepEqual(args.slice(0, 3), ["-s", serial, "shell"]);
      switch (args.slice(3).join(" ")) {
        case "getprop ro.kernel.qemu":
          return qemu;
        case "pm list packages -u":
          return packages;
        default:
          assert.fail("Unexpected ADB command");
      }
    },
  });
}

test("an unconfirmed local or self-hosted account is refused before contacting ADB", () => {
  for (const env of [
    {},
    { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" },
  ]) {
    assert.throws(
      () => emulatorSerial({ env, adb: () => assert.fail("called ADB") }),
      /disposable emulator/,
    );
  }
});

test("both launcher entry points reject an unconfirmed account before creating artifacts or starting Playwright", () => {
  const temp = mkdtempSync(join(tmpdir(), "android-preflight-"));
  const out = join(temp, "out");
  const env = {
    ...process.env,
    GITHUB_ACTIONS: "",
    RUNNER_ENVIRONMENT: "",
    MYCARLOS_DISPOSABLE_ANDROID_EMULATOR: "",
  };
  try {
    const commands = [
      [process.execPath, ["scripts/android-picker-journey.mjs"]],
    ];
    if (process.platform !== "win32")
      commands.push(["bash", ["scripts/android-emulator-smoke.sh", out]]);
    for (const [command, args] of commands) {
      const result = spawnSync(command, args, { encoding: "utf8", env });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /disposable emulator/);
    }
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("only one online emulator matching the selected target is eligible", () => {
  for (const devices of [
    "",
    "phone\tdevice",
    serial + "\toffline",
    serial + "\tdevice\nemulator-5556\tdevice",
  ]) {
    assert.throws(() => check({ devices }), /one online emulator/);
  }
  assert.throws(
    () => check({ env: { ...hosted, ANDROID_SERIAL: "emulator-5556" } }),
    /selected Android target/,
  );
  assert.throws(() => check({ qemu: "0" }), /must be an emulator/);
});

test("install requires a complete package listing without installed or retained myCarlos data", () => {
  for (const packages of [
    "",
    "cmd: service unavailable",
    "package:android\npackage:ca.carlos.mycarlos",
  ]) {
    assert.throws(() => check({ packages }), /fresh emulator/);
  }
  assert.equal(check(), serial);
  assert.equal(
    check({ env: { MYCARLOS_DISPOSABLE_ANDROID_EMULATOR: "1" } }),
    serial,
  );
});

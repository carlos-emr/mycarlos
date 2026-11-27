import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const appPackage = "ca.carlos.mycarlos";

// The shell launcher and the standalone Playwright entry use the same local
// ADB server. Select the sole eligible emulator before any device mutation.
export function emulatorSerial({
  beforeInstall = false,
  env = process.env,
  adb = (...args) =>
    execFileSync("adb", ["-H", "127.0.0.1", "-P", "5037", ...args], {
      encoding: "utf8",
      timeout: 15_000,
    }),
} = {}) {
  const hosted =
    env.GITHUB_ACTIONS === "true" && env.RUNNER_ENVIRONMENT === "github-hosted";
  if (!hosted && env.MYCARLOS_DISPOSABLE_ANDROID_EMULATOR !== "1") {
    throw new Error(
      "Use a GitHub-hosted runner or explicitly confirm a disposable emulator account",
    );
  }
  const lines = adb("devices").trim().split(/\r?\n/);
  const match =
    lines.length === 2 &&
    lines[0] === "List of devices attached" &&
    /^(emulator-\d+)\s+device$/.exec(lines[1]);
  if (!match || (env.ANDROID_SERIAL && env.ANDROID_SERIAL !== match[1])) {
    throw new Error(
      "Expected exactly one online emulator matching the selected Android target",
    );
  }
  const serial = match[1];
  if (adb("-s", serial, "shell", "getprop", "ro.kernel.qemu").trim() !== "1") {
    throw new Error("The selected Android target must be an emulator");
  }
  if (beforeInstall) {
    // -u includes packages uninstalled with their data kept. A fresh install
    // must not reattach to an old vault. A failed or empty listing is no proof.
    const packages = adb("-s", serial, "shell", "pm", "list", "packages", "-u")
      .trim()
      .split(/\r?\n/);
    if (
      !packages.includes("package:android") ||
      packages.includes(`package:${appPackage}`)
    ) {
      throw new Error(
        "A fresh emulator without an installed or retained myCarlos package is required",
      );
    }
  }
  return serial;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(emulatorSerial({ beforeInstall: true }));
}

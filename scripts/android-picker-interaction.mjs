import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { appPackage } from "./android-emulator-preflight.mjs";

const staleObject = "androidx.test.uiautomator.StaleObjectException";

export async function tapDownloadsRoot(device, selector) {
  // DocumentsUI can replace the Downloads node while its roots drawer opens.
  // Each tap resolves the selector again. Leave other failures visible.
  for (let attempt = 1; ; attempt++) {
    try {
      await device.tap(selector);
      return;
    } catch (error) {
      if (
        attempt === 4 ||
        !(error instanceof Error && error.message.includes(staleObject))
      ) {
        throw error;
      }
      await delay(200);
    }
  }
}

export async function launchFromHome(device) {
  // Use the launcher entry point already proven by the initial smoke check.
  const result = await device.shell(
    `monkey -p ${appPackage} -c android.intent.category.LAUNCHER 1`,
  );
  assert.match(result.toString(), /^Events injected: 1\s*$/m);
}

export function foregroundPackage(dump) {
  const output = dump.toString();
  const activity =
    output.match(/^\s*topResumedActivity=(.*)$/m) ??
    output.match(/^\s*mResumedActivity[:=]\s*(.*)$/m);
  return activity?.[1].match(/^ActivityRecord\{.*\bu\d+ ([\w.]+)\//)?.[1] ?? "";
}

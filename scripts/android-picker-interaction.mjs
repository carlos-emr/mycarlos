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

export async function launchFromHome(device, component) {
  assert.match(component, /^[\w.]+\/[\w.$]+$/);
  assert.equal(component.split("/")[0], appPackage);
  // MAIN/LAUNCHER with NEW_TASK and RESET_TASK_IF_NEEDED, like the home icon.
  const result = (
    await device.shell(
      `am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -f 0x10200000 -n '${component}'`,
    )
  ).toString();
  assert.match(result, /^Status: ok\s*$/m);
  return result.trim();
}

export function foregroundActivity(dump) {
  const output = dump.toString();
  const activity =
    output.match(/^\s*topResumedActivity=(.*)$/m) ??
    output.match(/^\s*mResumedActivity[:=]\s*(.*)$/m);
  const match = activity?.[1].match(
    /^ActivityRecord\{([a-f\d]+) u\d+ (([\w.]+)\/[\w.$]+) t(\d+)\b/,
  );
  if (!match) return null;
  const [, record, component, packageName, task] = match;
  return { record, component, packageName, task };
}

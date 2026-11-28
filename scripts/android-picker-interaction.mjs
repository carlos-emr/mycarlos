import { setTimeout as delay } from "node:timers/promises";

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

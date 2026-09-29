import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { startZoom, type Zoom } from "./zoom";

// The platforms whose window the app may zoom. A phone scales text by its
// own settings, and has no such command.
const ZOOMS = new Set(["windows", "macos", "linux"]);

/** The longest the first render waits for the size to be applied. */
const READY_WAIT_MS = 1500;

/** The app's zoom in the native app on a computer, and whether that is a
 * Mac. Nothing in the browser preview, where the browser zooms and keeps its
 * own level, or on a phone. */
export async function startNativeZoom(): Promise<{
  zoom: Zoom;
  mac: boolean;
} | null> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window))
    return null;
  try {
    const { platform } = await invoke<{ platform: string }>("runtime_info");
    if (!ZOOMS.has(platform)) return null;
    const mac = platform === "macos";
    const zoom = startZoom(
      async (level) => getCurrentWebview().setZoom(level),
      mac,
    );
    // The app is shown after the size is applied, so that it does not jump,
    // but never waits long for it.
    await Promise.race([
      zoom.ready,
      new Promise((resolve) => setTimeout(resolve, READY_WAIT_MS)),
    ]);
    return { zoom, mac };
  } catch {
    return null;
  }
}

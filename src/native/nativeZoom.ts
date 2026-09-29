import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { startZoom, type Zoom } from "./zoom";

// The platforms whose window the app may zoom. A phone scales text by its
// own settings, and has no such command.
const ZOOMS = new Set(["windows", "macos", "linux"]);

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
    const zoom = startZoom((level) => getCurrentWebview().setZoom(level), mac);
    await zoom.ready;
    return { zoom, mac };
  } catch {
    return null;
  }
}

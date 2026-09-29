import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { startZoom } from "./zoom";

// The platforms whose window the app may zoom. A phone scales text by its
// own settings, and has no such command.
const ZOOMS = new Set(["windows", "macos", "linux"]);

/** Starts the app's zoom in the native app on a computer. In the browser
 * preview the browser zooms, and keeps its own level. */
export function startNativeZoom(): void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window))
    return;
  void invoke<{ platform: string }>("runtime_info")
    .then(({ platform }) => {
      if (!ZOOMS.has(platform)) return;
      startZoom(
        (level) => getCurrentWebview().setZoom(level),
        platform === "macos",
      );
    })
    .catch(() => undefined);
}

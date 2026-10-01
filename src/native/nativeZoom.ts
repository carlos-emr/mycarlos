import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { startZoom, type Zoom } from "./zoom";

// The platforms whose window the app may zoom. A phone scales text by its
// own settings, and has no such command.
const ZOOMS = new Set(["windows", "macos", "linux"]);

/** The longest the first render waits for the size to be applied. */
const READY_WAIT_MS = 1500;

type NativeZoom = { zoom: Zoom; mac: boolean };

/** The app's zoom in the native app on a computer, and whether that is a
 * Mac. Nothing in the browser preview, where the browser zooms and keeps its
 * own level, or on a phone. */
export async function startNativeZoom(): Promise<NativeZoom | null> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window))
    return null;
  let expired = false;
  let native: NativeZoom | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<NativeZoom | null>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      // If applying the saved size is slow, still show its controls. If
      // platform detection is slow, do not install a controller later.
      resolve(native);
    }, READY_WAIT_MS);
  });
  const setup = async () => {
    try {
      const { platform } = await invoke<{ platform: string }>("runtime_info");
      if (expired || !ZOOMS.has(platform)) return null;
      const mac = platform === "macos";
      const zoom = startZoom(
        async (level) => getCurrentWebview().setZoom(level),
        mac,
      );
      native = { zoom, mac };
      await zoom.ready;
      return native;
    } catch {
      return null;
    }
  };
  try {
    return await Promise.race([setup(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

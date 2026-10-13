import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { startZoom, type Zoom } from "./zoom";

// The platforms whose window the app may zoom. A phone scales text by its
// own settings, and has no such command.
const ZOOMS = new Set(["windows", "macos", "linux"]);

/** The longest the first render waits for the size to be applied. */
const READY_WAIT_MS = 1500;

export type NativeZoom = { zoom: Zoom; mac: boolean };

export interface NativeZoomStart {
  /** What the first render shows: settles once the size kept from last time
   * is applied, or at the latest after a short wait. */
  ready: Promise<NativeZoom | null>;
  /** The zoom once the platform is known, even when that is after the first
   * render: the platform's own zoom is turned off, so without this there
   * would be none. The size then changes after the window is shown. */
  installed: Promise<NativeZoom | null>;
}

const NONE: NativeZoomStart = {
  ready: Promise.resolve(null),
  installed: Promise.resolve(null),
};

/** The app's zoom in the native app on a computer, and whether that is a
 * Mac. Nothing in the browser preview, where the browser zooms and keeps its
 * own level, or on a phone. */
export function startNativeZoom(): NativeZoomStart {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window))
    return NONE;
  let native: NativeZoom | null = null;
  const installed = (async (): Promise<NativeZoom | null> => {
    try {
      const { platform } = await invoke<{ platform: string }>("runtime_info");
      if (!ZOOMS.has(platform)) return null;
      const mac = platform === "macos";
      const zoom = startZoom(
        async (level) => getCurrentWebview().setZoom(level),
        mac,
      );
      native = { zoom, mac };
      return native;
    } catch {
      return null;
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // If applying the saved size is slow, the controls are still shown. If the
  // platform is slow, the first render goes ahead without them, and they
  // come with `installed`.
  const deadline = new Promise<NativeZoom | null>((resolve) => {
    timer = setTimeout(() => resolve(native), READY_WAIT_MS);
  });
  const applied = installed.then(async (zoom) => {
    if (zoom) await zoom.zoom.ready;
    return zoom;
  });
  const ready = Promise.race([applied, deadline]).finally(() =>
    clearTimeout(timer),
  );
  return { ready, installed };
}

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  Appearance,
  AppearanceError,
  AppearanceMode,
} from "../appearance";

const DESKTOPS = new Set(["windows", "macos", "linux"]);
const WAIT_MS = 3000;
const FAILED: AppearanceError = "appearance.error.window";

/** Native chrome is optional: a slow or failed command never holds up the app. */
export function startNativeAppearance(appearance: Appearance): () => void {
  if (!("__TAURI_INTERNALS__" in window)) return () => {};
  let stopped = false;
  let desktop = false;
  let mode = appearance.snapshot().mode;
  let generation = 0;
  let pending = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  function deadline(callback: () => void) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, WAIT_MS);
    timers.add(timer);
    return () => {
      clearTimeout(timer);
      timers.delete(timer);
    };
  }
  function apply() {
    if (stopped || !desktop) return;
    const current = ++generation;
    pending = true;
    const clear = deadline(() => {
      if (!stopped && current === generation) {
        pending = false;
        appearance.setNativeError(FAILED);
      }
    });
    void (async () => {
      try {
        await getCurrentWindow().setTheme(mode === "system" ? null : mode);
        if (stopped) return;
        if (current === generation) {
          pending = false;
          appearance.setNativeError("");
        } else if (!pending) {
          // A timed-out older command can finish after the latest choice.
          // Repair the chrome to that choice instead of accepting stale state.
          apply();
        }
      } catch {
        if (!stopped && current === generation) {
          pending = false;
          appearance.setNativeError(FAILED);
        }
      } finally {
        clear();
      }
    })();
  }
  const unsubscribe = appearance.subscribe(() => {
    const next: AppearanceMode = appearance.snapshot().mode;
    if (mode !== next) {
      mode = next;
      apply();
    }
  });
  const clearPlatform = deadline(() => {
    if (!stopped) appearance.setNativeError(FAILED);
  });
  void invoke<{ platform: string }>("runtime_info").then(
    ({ platform }) => {
      clearPlatform();
      if (stopped) return;
      desktop = DESKTOPS.has(platform);
      appearance.setNativeError("");
      if (desktop) apply();
    },
    () => {
      clearPlatform();
      if (!stopped) appearance.setNativeError(FAILED);
    },
  );
  return () => {
    stopped = true;
    unsubscribe();
    timers.forEach(clearTimeout);
    timers.clear();
  };
}

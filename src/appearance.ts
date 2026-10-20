export type AppearanceMode = "system" | "light" | "dark";
export type AppearanceTheme = "light" | "dark";

export const APPEARANCE_STORAGE_KEY = "mycarlos.appearance.v1";

export interface AppearanceState {
  mode: AppearanceMode;
  theme: AppearanceTheme;
  storageError: string;
  nativeError: string;
}

export interface Appearance {
  snapshot: () => AppearanceState;
  subscribe: (listener: () => void) => () => void;
  set: (mode: AppearanceMode) => void;
  setNativeError: (message: string) => void;
}

export function appearanceMode(value: unknown): AppearanceMode {
  return value === "light" || value === "dark" ? value : "system";
}

/** Device preferences apply to locked screens too, without opening the vault. */
export function startAppearance(): Appearance {
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const forced = window.matchMedia("(forced-colors: active)");
  let mode: AppearanceMode = "system";
  let storageError = "";
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
    mode = appearanceMode(storage.getItem(APPEARANCE_STORAGE_KEY));
  } catch {
    storageError =
      "The saved appearance could not be read. Using System for this session.";
  }
  const theme = (): AppearanceTheme =>
    mode === "system" ? (dark.matches ? "dark" : "light") : mode;
  let state: AppearanceState = {
    mode,
    theme: theme(),
    storageError,
    nativeError: "",
  };
  const listeners = new Set<() => void>();

  function apply() {
    document.documentElement.dataset.theme = state.theme;
    // The computed colour includes the user's forced-colours palette.
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    if (meta)
      meta.content = getComputedStyle(document.documentElement).backgroundColor;
  }
  function publish() {
    state = { ...state, mode, theme: theme(), storageError };
    apply();
    listeners.forEach((listener) => listener());
  }
  function onMediaChange() {
    publish();
  }
  function onStorage(event: StorageEvent) {
    if (
      !storage ||
      event.storageArea !== storage ||
      (event.key !== APPEARANCE_STORAGE_KEY && event.key !== null)
    )
      return;
    mode = appearanceMode(event.newValue);
    storageError = "";
    publish();
  }

  // Called synchronously, before the existing bounded zoom startup wait.
  apply();
  return {
    snapshot: () => state,
    subscribe(listener) {
      if (!listeners.size) {
        dark.addEventListener("change", onMediaChange);
        forced.addEventListener("change", onMediaChange);
        window.addEventListener("storage", onStorage);
        publish();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          dark.removeEventListener("change", onMediaChange);
          forced.removeEventListener("change", onMediaChange);
          window.removeEventListener("storage", onStorage);
        }
      };
    },
    set(next) {
      mode = appearanceMode(next);
      try {
        storage = window.localStorage;
        storage.setItem(APPEARANCE_STORAGE_KEY, mode);
        storageError = "";
      } catch {
        storageError =
          "Appearance changed for this session, but could not be remembered on this device.";
      }
      publish();
    },
    setNativeError(message) {
      if (state.nativeError === message) return;
      state = { ...state, nativeError: message };
      listeners.forEach((listener) => listener());
    },
  };
}

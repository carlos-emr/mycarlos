// The whole interface is zoomed with Ctrl (Cmd on a Mac) and plus, minus or
// 0, or with Ctrl and the mouse wheel, as in a browser. The platform's own
// handling of those keys forgets the level when the app closes, so the app
// handles them itself and keeps the level on this device, beside the
// automatic lock setting. It says nothing about the vault.
//
// A level that is kept must be easy to undo: whenever it is not the ordinary
// one, the app shows it with buttons to change it (ZoomBar).
const ZOOM_STORAGE_KEY = "mycarlos.zoom.v1";

/** The sizes there are, as browsers have them. Below 80% the small print
 * would be too small to read. */
export const ZOOM_LEVELS = [
  0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
] as const;

/** How far the wheel turns for one step: one notch of an ordinary mouse. A
 * touchpad sends many small turns, which add up to a step. */
const WHEEL_STEP = 100;
/** A pause after which turns of the wheel start adding up again. */
const WHEEL_PAUSE_MS = 1000;

/** The size there is that is nearest to `value`; the ordinary one for
 * anything that is not a size. */
export function normalizeZoom(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return ZOOM_LEVELS.reduce((nearest, level) =>
    Math.abs(level - parsed) < Math.abs(nearest - parsed) ? level : nearest,
  );
}

export function readZoom(): number {
  try {
    const stored = window.localStorage.getItem(ZOOM_STORAGE_KEY);
    return stored === null ? 1 : normalizeZoom(stored);
  } catch {
    return 1;
  }
}

function persistZoom(level: number): void {
  try {
    window.localStorage.setItem(ZOOM_STORAGE_KEY, String(level));
  } catch {
    // The level stays as set until the app closes.
  }
}

/** What a key, the wheel or a button asks of the zoom. */
export type ZoomRequest = "in" | "out" | "reset";

export function zoomRequestOfKey(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey">,
  mac: boolean,
): ZoomRequest | null {
  if (event.altKey || !(mac ? event.metaKey : event.ctrlKey)) return null;
  // By the key's place for 0: with Shift, some layouts give it another sign.
  if (event.code === "Digit0" || event.code === "Numpad0" || event.key === "0")
    return "reset";
  if (event.key === "+" || event.key === "=") return "in";
  if (event.key === "-" || event.key === "_") return "out";
  return null;
}

export function zoomAfter(level: number, request: ZoomRequest): number {
  if (request === "reset") return 1;
  const at = ZOOM_LEVELS.indexOf(
    normalizeZoom(level) as (typeof ZOOM_LEVELS)[number],
  );
  const next = at + (request === "in" ? 1 : -1);
  return ZOOM_LEVELS[Math.min(Math.max(next, 0), ZOOM_LEVELS.length - 1)];
}

export const zoomPercent = (level: number) => `${Math.round(level * 100)}%`;

/** The app's zoom: its level, and the ways to change it. */
export interface Zoom {
  level(): number;
  request(request: ZoomRequest): void;
  /** Calls `listener` after every change; returns what ends that. */
  subscribe(listener: () => void): () => void;
  /** Settles once the level kept from last time is applied, or could not
   * be. */
  ready: Promise<void>;
  stop(): void;
}

/**
 * Applies the level kept from last time and handles the zoom keys and wheel
 * from then on. `setZoom` is the platform's; a failure there leaves the
 * interface as it is, at its ordinary size at worst.
 */
export function startZoom(
  setZoom: (level: number) => Promise<void>,
  mac: boolean,
): Zoom {
  let level = readZoom();
  let turned = 0;
  let turnedAt = 0;
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const listener of listeners) listener();
  };
  // One change at a time, in order: each is a command of its own.
  let applying: Promise<void> = Promise.resolve();
  const apply = (next: number) => {
    applying = applying.then(() => setZoom(next)).catch(() => undefined);
    return applying;
  };
  let requested = false;
  const request = (asked: ZoomRequest) => {
    const next = zoomAfter(level, asked);
    if (next === level) return;
    requested = true;
    level = next;
    persistZoom(level);
    void apply(level);
    tell();
  };
  // A size kept from last time that the platform refused is not the size
  // shown: say the ordinary one, unless the patient has asked for another
  // since, which is then the size.
  const ready =
    level === 1
      ? Promise.resolve()
      : setZoom(level).then(
          () => undefined,
          () => {
            if (requested) return;
            level = 1;
            tell();
          },
        );
  applying = ready;

  const onKey = (event: KeyboardEvent) => {
    const asked = zoomRequestOfKey(event, mac);
    if (!asked) return;
    event.preventDefault();
    request(asked);
  };
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey || event.deltaY === 0) return;
    event.preventDefault();
    // A turn the other way, or after a pause, starts again.
    const now = Date.now();
    if (
      Math.sign(turned) !== Math.sign(event.deltaY) ||
      now - turnedAt > WHEEL_PAUSE_MS
    )
      turned = 0;
    turnedAt = now;
    // The page reports the wheel in its own pixels, which shrink as it is
    // zoomed: counted in the screen's, a notch is the same at every size.
    turned += event.deltaY * level;
    if (Math.abs(turned) < WHEEL_STEP) return;
    request(turned < 0 ? "in" : "out");
    turned = 0;
  };
  window.addEventListener("keydown", onKey);
  // On a Mac, Ctrl with the wheel is the system's own screen zoom.
  // Not passive: the wheel must not also scroll the page.
  if (!mac) window.addEventListener("wheel", onWheel, { passive: false });
  return {
    level: () => level,
    request,
    ready,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
      listeners.clear();
    },
  };
}

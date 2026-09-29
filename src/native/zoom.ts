// The whole interface is zoomed with Ctrl (Cmd on a Mac) and plus, minus or
// 0, or with Ctrl and the mouse wheel, as in a browser. The platform's own
// handling of those keys forgets the level when the app closes, so the app
// handles them itself and keeps the level on this device, beside the
// automatic lock setting. It says nothing about the vault.
const ZOOM_STORAGE_KEY = "mycarlos.zoom.v1";

export const ZOOM_STEP = 0.2;
export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 4;

/** A level the app can show: within the limits, and on a step. */
export function normalizeZoom(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  const stepped = Math.round(parsed / ZOOM_STEP) * ZOOM_STEP;
  return Number(Math.min(Math.max(stepped, MIN_ZOOM), MAX_ZOOM).toFixed(1));
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

/** What a key or wheel event asks of the zoom, if anything. */
export type ZoomRequest = "in" | "out" | "reset";

export function zoomRequestOfKey(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
  mac: boolean,
): ZoomRequest | null {
  if (event.altKey || !(mac ? event.metaKey : event.ctrlKey)) return null;
  if (event.key === "+" || event.key === "=") return "in";
  if (event.key === "-" || event.key === "_") return "out";
  if (event.key === "0") return "reset";
  return null;
}

export function zoomAfter(level: number, request: ZoomRequest): number {
  if (request === "reset") return 1;
  return normalizeZoom(level + (request === "in" ? ZOOM_STEP : -ZOOM_STEP));
}

/**
 * Applies the level kept from last time and handles the zoom keys and wheel
 * from then on. `setZoom` is the platform's; a failure there leaves the
 * interface as it is, at its ordinary size at worst.
 *
 * Returns what undoes it.
 */
export function startZoom(
  setZoom: (level: number) => Promise<void>,
  mac: boolean,
): () => void {
  let level = readZoom();
  const apply = (next: number) => {
    if (next === level) return;
    level = next;
    persistZoom(level);
    void setZoom(level).catch(() => undefined);
  };
  if (level !== 1) void setZoom(level).catch(() => undefined);

  const onKey = (event: KeyboardEvent) => {
    const request = zoomRequestOfKey(event, mac);
    if (!request) return;
    event.preventDefault();
    apply(zoomAfter(level, request));
  };
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey || event.deltaY === 0) return;
    event.preventDefault();
    apply(zoomAfter(level, event.deltaY < 0 ? "in" : "out"));
  };
  window.addEventListener("keydown", onKey);
  // Not passive: the wheel must not also scroll the page.
  window.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("wheel", onWheel);
  };
}

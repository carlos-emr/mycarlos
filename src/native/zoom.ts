// The whole interface is zoomed with Ctrl (Cmd on a Mac) and plus, minus or
// 0, or with Ctrl and the mouse wheel, as in a browser. The platform's own
// handling of those keys forgets the level when the app closes, so the app
// handles them itself and keeps the level on this device, beside the
// automatic lock setting. It says nothing about the vault.
//
// A level that is kept must be easy to undo: Settings > Preferences shows it,
// with buttons and a box to change it (TextSizeSetting), and Ctrl+0 (Cmd+0)
// always goes back to the ordinary size.
const ZOOM_STORAGE_KEY = "mycarlos.zoom.v1";

/** The sizes there are, as browsers have them. Below 80% the small print
 * would be too small to read. */
export const ZOOM_LEVELS = [
  0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
] as const;

/** How far the wheel turns for one step: one notch of an ordinary mouse. A
 * touchpad sends many small turns, which add up to a step. */
const WHEEL_STEP = 100;
/** A notch counted back from the page's pixels can fall a little short of a
 * step: Chromium keeps the page's pixels as 32-bit floats (100 / 1.1 comes
 * back as 99.99999…), and some browsers round them. */
const WHEEL_SLACK = 2;
/** Lines in one notch, for a wheel reported in lines. */
const WHEEL_NOTCH_LINES = 3;
/** A pause after which turns of the wheel start adding up again. */
const WHEEL_PAUSE_MS = 1000;
/** How long the platform may take to apply a size. A command that never
 * answers would otherwise hold back every request after it. */
const SET_ZOOM_TIMEOUT_MS = 3000;

/** The size there is that is nearest to `value`; the ordinary one for
 * anything that is not a size, or is outside the sizes there are (a kept
 * value like that is damaged, not a wish for the largest). */
export function normalizeZoom(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < ZOOM_LEVELS[0] ||
    parsed > ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
  )
    return 1;
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
  // Not the keypad's by its place: with Num Lock off, it is Insert (Ctrl with
  // Insert copies). With Num Lock on, it gives "0".
  if (event.code === "Digit0" || event.key === "0") return "reset";
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

/** The smallest and largest sizes, as whole percents. */
export const ZOOM_MIN_PERCENT = Math.round(ZOOM_LEVELS[0] * 100);
export const ZOOM_MAX_PERCENT = Math.round(
  ZOOM_LEVELS[ZOOM_LEVELS.length - 1] * 100,
);

/** What a typed size comes to: a size there is, with a note when it is not
 * exactly the one typed; or why it was refused. */
export type TypedZoom = { level: number; note: string } | { error: string };

/**
 * Reads a size typed as a percent ("125", "125%", " 125 % "). Beyond either
 * end it is the nearest end; between sizes, the nearest size, as the keys
 * and buttons only give those. Anything that is not a number is refused, so
 * that a slip never changes the size.
 */
export function readTypedZoom(typed: string): TypedZoom {
  const text = typed.trim().replace(/\s*%$/, "");
  // Digits, with an optional decimal part; a run of digits too long for a
  // number is Infinity, beyond the largest size like any other.
  const percent = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN;
  if (Number.isNaN(percent))
    return {
      error: `Type a number from ${ZOOM_MIN_PERCENT} to ${ZOOM_MAX_PERCENT}.`,
    };
  if (percent < ZOOM_MIN_PERCENT)
    return {
      level: ZOOM_LEVELS[0],
      note: `The smallest size is ${ZOOM_MIN_PERCENT}%.`,
    };
  if (percent > ZOOM_MAX_PERCENT)
    return {
      level: ZOOM_LEVELS[ZOOM_LEVELS.length - 1],
      note: `The largest size is ${ZOOM_MAX_PERCENT}%.`,
    };
  const level = normalizeZoom(percent / 100);
  return {
    level,
    note:
      Math.round(level * 100) === percent
        ? ""
        : `${text}% is between sizes, so it is ${zoomPercent(level)}.`,
  };
}

/** How far one wheel event turns, counted as the screen does. The page
 * reports the wheel in its own pixels, which shrink as it is zoomed: counted
 * in the screen's, a notch is the same at every size. Lines and pages do not
 * shrink. */
export function wheelTurn(
  event: Pick<WheelEvent, "deltaY" | "deltaMode">,
  level: number,
): number {
  if (event.deltaMode === 1)
    // DOM_DELTA_LINE
    return (event.deltaY / WHEEL_NOTCH_LINES) * WHEEL_STEP;
  if (event.deltaMode === 2)
    // DOM_DELTA_PAGE
    return Math.sign(event.deltaY) * WHEEL_STEP;
  return event.deltaY * level;
}

/** What `within` fails with when the platform has not answered in time. */
const TIMED_OUT = new Error("The platform did not apply the size in time.");

/** `work`, or a failure once `ms` have passed without an answer. */
function within(work: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(TIMED_OUT), ms);
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The app's zoom: its level, and the ways to change it. */
export interface Zoom {
  level(): number;
  request(request: ZoomRequest): void;
  /** Goes to a size there is: the nearest one to `level`, within the ends. */
  set(level: number): void;
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
  // Keep the last level the platform accepted so a rejected reset can be
  // retried. Newer queued requests must not be overwritten by an older failure.
  let confirmed = 1;
  let revision = 0;
  const apply = async (next: number, at: number) => {
    let work: Promise<void>;
    try {
      work = setZoom(next);
    } catch (error) {
      // As a refusal: a throw here must not stop every later request.
      work = Promise.reject(error);
    }
    try {
      await within(work, SET_ZOOM_TIMEOUT_MS);
      confirmed = next;
      persistZoom(next);
    } catch (error) {
      if (revision === at) {
        level = confirmed;
        // A size kept from last time that could not be applied at the start
        // (revision 0) stays kept, to be tried at the next start.
        if (at > 0) persistZoom(confirmed);
        tell();
      }
      // Given up on, the platform may still apply it. Then that is the size
      // shown, so that what Preferences says, and Ctrl+0, match the window.
      if (error === TIMED_OUT)
        work.then(
          () => {
            if (revision !== at) return;
            confirmed = next;
            level = next;
            persistZoom(next);
            tell();
          },
          () => undefined,
        );
    }
  };
  const ready = level === 1 ? Promise.resolve() : apply(level, revision);
  // One change at a time, in order: each is a command of its own.
  let applying = ready;
  const change = (next: number) => {
    if (next === level) return;
    const at = ++revision;
    level = next;
    applying = applying.then(() => apply(next, at));
    tell();
  };
  const request = (asked: ZoomRequest) => change(zoomAfter(level, asked));
  const set = (wanted: number) => {
    // Not a size at all: nothing changes (normalizeZoom would make it 100%).
    if (Number.isNaN(wanted)) return;
    change(
      normalizeZoom(
        Math.min(
          Math.max(wanted, ZOOM_LEVELS[0]),
          ZOOM_LEVELS[ZOOM_LEVELS.length - 1],
        ),
      ),
    );
  };

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
    turned += wheelTurn(event, level);
    if (Math.abs(turned) < WHEEL_STEP - WHEEL_SLACK) return;
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
    set,
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

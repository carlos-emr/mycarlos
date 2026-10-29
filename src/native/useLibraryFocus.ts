import { useCallback, useEffect, useRef, type RefObject } from "react";

const available = (element: Element) =>
  element.isConnected &&
  !element.matches(":disabled") &&
  !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
  element.getClientRects().length > 0 &&
  getComputedStyle(element).visibility === "visible";

// Recovery is for keyboard users. A click or tap in WebKit (macOS, iOS) does
// not focus the button pressed, so after a pointer action focus is on the page
// itself as a matter of course; moving it would also scroll the page. The last
// key or pointer press before an action starts decides, so a dialog opened with
// a pointer and closed with Escape, or a lock warning put off with any key,
// stays a pointer action. A modifier key alone is no keyboard use, nor is a key
// pressed while nothing has focus (scrolling with PageDown, copying with
// Ctrl+C after a click): that leaves a pointer user a pointer user. Watched
// from the start: the unlock key is pressed before the library opens.
const MODIFIERS = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "CapsLock",
  "Fn",
  "FnLock",
  "Hyper",
  "Super",
  "Symbol",
  "SymbolLock",
  "NumLock",
  "ScrollLock",
  "OS",
]);
let keyboardLast = false;
if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (event) => {
      if (
        !MODIFIERS.has(event.key) &&
        event.target !== document.body &&
        event.target !== document.documentElement
      )
        keyboardLast = true;
    },
    true,
  );
  window.addEventListener(
    "pointerdown",
    () => {
      keyboardLast = false;
    },
    true,
  );
}

/** Recover focus lost when a library action disables or removes its trigger,
 * and take it to the heading of a place the reader opens.
 * Dialogs keep their own focus rules. After an action, deliberate focus
 * elsewhere always wins.
 * Returns `recover`, a request to recover after the next change however it
 * started, for a dialog whose opener may be gone when it closes; and
 * `openedPlace`, called with the location a navigation goes to. Once the
 * library shows that location, focus goes to its heading whatever the input,
 * mouse and touch included, so a screen reader says where the reader now is
 * (#121, Ben's D128). Choosing the place already shown changes nothing. */
export function useLibraryFocus(
  root: RefObject<HTMLElement | null>,
  heading: RefObject<HTMLElement | null>,
  blocked: boolean,
  location: string,
) {
  const trigger = useRef<HTMLElement | null>(null);
  const requested = useRef(false);
  const startedByKey = useRef(false);
  const wasBlocked = useRef<boolean | null>(null);
  // The location on screen, and the one a navigation asked to land on.
  const shown = useRef(location);
  const place = useRef<string | null>(null);
  // That place came while the library was busy or covered: by the time it is
  // free, the reader may have moved on.
  const placeLate = useRef(false);
  useEffect(() => {
    shown.current = location;
  }, [location]);
  useEffect(() => {
    const remember = (event?: FocusEvent) => {
      const element = event?.target ?? document.activeElement;
      if (
        element instanceof HTMLElement &&
        root.current?.contains(element) &&
        available(element)
      )
        trigger.current = element;
    };
    remember();
    document.addEventListener("focusin", remember, true);
    return () => document.removeEventListener("focusin", remember, true);
  }, [root]);

  useEffect(() => {
    // The library opening, an action or dialog starting, or a new location:
    // note how it started. The end of an action keeps what its start noted.
    if (!wasBlocked.current) startedByKey.current = keyboardLast;
    wasBlocked.current = blocked;
    if (blocked) {
      if (place.current === location) placeLate.current = true;
      return;
    }
    const byKey = startedByKey.current;
    // Wait for disabled controls and modal cleanup to finish their commit.
    // Superseding navigation, a dialog, a lock or unmount cancels this frame.
    const frame = window.requestAnimationFrame(() => {
      const asked = requested.current;
      requested.current = false;
      // A place opened on the way to another (a person's folder opens after
      // the person) waits for the location it asked for.
      const opened = place.current === location;
      const late = placeLate.current;
      if (opened) {
        place.current = null;
        placeLate.current = false;
      }
      const library = root.current;
      const focused = document.activeElement;
      if (
        !library ||
        !available(library) ||
        !document.hasFocus() ||
        Array.from(
          document.querySelectorAll<HTMLElement>('[aria-modal="true"]'),
        ).some(available)
      )
        return;
      if (opened && !late) {
        // Over the control that opened it too: that one still names the old
        // place, or none.
        const target = heading.current;
        if (target && library.contains(target) && available(target))
          target.focus();
        return;
      }
      // A place reached while the library was busy or covered is like the end
      // of an action: focus the reader has put elsewhere since stays there.
      if (
        !(byKey || asked || opened) ||
        (focused instanceof Element &&
          focused !== document.body &&
          focused !== document.documentElement &&
          available(focused))
      )
        return;
      if (opened) {
        const target = heading.current;
        if (target && library.contains(target) && available(target))
          target.focus();
        return;
      }
      const previous = trigger.current;
      const target =
        previous && library.contains(previous) && available(previous)
          ? previous
          : heading.current;
      if (target && library.contains(target) && available(target))
        target.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [root, heading, blocked, location]);

  const recover = useCallback(() => {
    requested.current = true;
  }, []);
  const openedPlace = useCallback((next: string) => {
    place.current = next === shown.current ? null : next;
    placeLate.current = false;
  }, []);
  return { recover, openedPlace };
}

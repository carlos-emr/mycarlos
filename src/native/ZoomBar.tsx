import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { NativeZoom } from "./nativeZoom";
import { ZOOM_LEVELS, zoomPercent, zoomRequestOfKey, type Zoom } from "./zoom";

/** The zoom bar once the native zoom exists: at the first render, or later
 * if the platform answered after it. */
export function NativeZoomBar({
  initial,
  installed,
}: {
  initial: NativeZoom | null;
  installed: Promise<NativeZoom | null>;
}) {
  const [native, setNative] = useState(initial);
  useEffect(() => {
    if (native) return;
    let current = true;
    void installed.then((late) => {
      if (current && late) setNative(late);
    });
    return () => {
      current = false;
    };
  }, [installed, native]);
  return native ? <ZoomBar zoom={native.zoom} mac={native.mac} /> : null;
}

// Under a dialog, the dialog's backdrop covers this bar. If its buttons are
// pressed all the same (a screen reader can), focus stays in the dialog.
const modalOpen = () => Boolean(document.querySelector('[aria-modal="true"]'));

/**
 * The size of the interface, with buttons to change it. The size is kept
 * between launches, so one set by a slip of the wheel must be easy to see
 * and to undo, without knowing the keys. And the buttons are the only way to
 * zoom without a keyboard: handling the keys in the page turns off the
 * platform's own zoom, pinching included.
 */
export function ZoomBar({ zoom, mac }: { zoom: Zoom; mac: boolean }) {
  const level = useSyncExternalStore(zoom.subscribe, zoom.level);
  const modifier = mac ? "Command" : "Ctrl";
  const smallest = level === ZOOM_LEVELS[0];
  const largest = level === ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  const bar = useRef<HTMLElement | null>(null);
  const larger = useRef<HTMLButtonElement | null>(null);
  const refocus = useRef(false);
  // Whether Ctrl+0 was pressed on "Back to normal size", so that the focus
  // is not left on nothing when the button goes.
  const resetFocused = useRef(false);

  // The screens below fill the window less the bar's height.
  useEffect(() => {
    const element = bar.current;
    if (!element) return;
    const root = document.documentElement;
    const measure = () =>
      root.style.setProperty(
        "--zoom-bar-height",
        `${element.getBoundingClientRect().height}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--zoom-bar-height");
    };
  }, []);

  // "Back to normal size" goes when it is pressed, or when Ctrl+0 is pressed
  // while it has the focus: focus is not left on nothing.
  useEffect(() => {
    const wanted = refocus.current || resetFocused.current;
    refocus.current = false;
    if (!wanted || level !== 1) return;
    resetFocused.current = false;
    const lost =
      !document.activeElement || document.activeElement === document.body;
    if (lost && !modalOpen()) larger.current?.focus();
  }, [level]);

  return (
    <aside ref={bar} className="zoom-bar" aria-label="Text size">
      <p role="status" aria-atomic="true">
        {`Text size ${zoomPercent(level)}`}
      </p>
      {/* Not disabled at either end, which would drop the focus on it. */}
      <button
        className="button"
        type="button"
        aria-disabled={smallest}
        onClick={() => {
          if (!smallest) zoom.request("out");
        }}
      >
        Smaller text
      </button>
      <button
        ref={larger}
        className="button"
        type="button"
        aria-disabled={largest}
        onClick={() => {
          if (!largest) zoom.request("in");
        }}
      >
        Larger text
      </button>
      {level !== 1 && (
        <>
          <button
            className="button"
            type="button"
            onKeyDown={(event) => {
              // Seen before the page-wide handler applies it.
              if (zoomRequestOfKey(event.nativeEvent, mac) === "reset")
                resetFocused.current = true;
            }}
            onClick={() => {
              refocus.current = true;
              zoom.request("reset");
            }}
          >
            Back to normal size
          </button>
          <small>
            Or hold {modifier} and press plus, minus or 0. myCarlos remembers
            the size on this computer.
          </small>
        </>
      )}
    </aside>
  );
}

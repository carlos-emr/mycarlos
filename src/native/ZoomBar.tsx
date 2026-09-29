import { useSyncExternalStore } from "react";
import { ZOOM_LEVELS, zoomPercent, type Zoom } from "./zoom";

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
  return (
    <aside className="zoom-bar" aria-label="Text size">
      <p role="status">Text size {zoomPercent(level)}</p>
      <button
        className="button"
        type="button"
        disabled={level === ZOOM_LEVELS[0]}
        onClick={() => zoom.request("out")}
      >
        Smaller
      </button>
      <button
        className="button"
        type="button"
        disabled={level === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
        onClick={() => zoom.request("in")}
      >
        Larger
      </button>
      {level !== 1 && (
        <>
          <button
            className="button"
            type="button"
            onClick={() => zoom.request("reset")}
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

import { useLayoutEffect, useRef, useState } from "react";
import { useModalFocus } from "../useModalFocus";

// How far the photo can be zoomed, as a multiple of its fitted width. Each
// level is a class in styles.css: the CSP allows no inline styles.
const ZOOM_LEVELS = [1, 1.5, 2, 3, 4] as const;

/** Where the middle of what the frame shows is, as fractions of the whole
 * scrolled area, so that it can be found again at another zoom. */
function viewCentre(frame: HTMLElement) {
  return {
    x: (frame.scrollLeft + frame.clientWidth / 2) / frame.scrollWidth,
    y: (frame.scrollTop + frame.clientHeight / 2) / frame.scrollHeight,
  };
}

/** A photo from the vault, fitted to the window, with Zoom in and Zoom out.
 * `url` is the `data:image/jpeg` URL the vault gave (vault_view_photo).
 * Zooming keeps the middle of the view where it was (Ben, #73), and when
 * zoomed in the photo can be dragged with a mouse or pen to move around; the
 * arrow keys still scroll it, and a finger pans it as any page. */
export function PhotoViewer({
  name,
  url,
  onClose,
}: {
  name: string;
  url: string;
  onClose: () => void;
}) {
  const [level, setLevel] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  // The view's middle before a zoom, put back once the new size is laid out.
  const keepCentre = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  useModalFocus(true, dialogRef, onClose, closeRef);
  const zoom = ZOOM_LEVELS[level];

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const centre = keepCentre.current;
    if (!frame || !centre) return;
    keepCentre.current = null;
    frame.scrollLeft = centre.x * frame.scrollWidth - frame.clientWidth / 2;
    frame.scrollTop = centre.y * frame.scrollHeight - frame.clientHeight / 2;
  }, [level]);

  // A drag ends on release, on cancel, and whenever the browser says no
  // button is held any more or the pointer was let go (a release outside
  // the window), so it can never stick to a pointer that is just moving.
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  const zoomTo = (next: number) => {
    if (frameRef.current) keepCentre.current = viewCentre(frameRef.current);
    setLevel(next);
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="record-dialog photo-viewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="photo-viewer-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <div>
            <span className="eyebrow">Photo</span>
            <h2 id="photo-viewer-title">{name}</h2>
          </div>
        </header>
        {/* It scrolls when zoomed in, so it takes focus, to be scrolled with
            the keyboard; a mouse or pen drags it. */}
        <div
          ref={frameRef}
          className={`photo-viewer-frame zoom-${String(zoom).replace(".", "-")}${zoom > 1 ? " can-drag" : ""}${dragging ? " dragging" : ""}`}
          role="region"
          aria-label="Photo. Zoom in to see details; drag or scroll to move around."
          tabIndex={0}
          onPointerDown={(event) => {
            // A finger pans as on any page; only a mouse or pen drags here.
            if (zoom === 1 || event.pointerType === "touch") return;
            if (event.button !== 0) return;
            const frame = event.currentTarget;
            drag.current = {
              pointer: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              left: frame.scrollLeft,
              top: frame.scrollTop,
            };
            try {
              frame.setPointerCapture(event.pointerId);
            } catch {
              // A pointer the browser no longer tracks: the drag still works
              // while it stays over the photo.
            }
            setDragging(true);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (!start || start.pointer !== event.pointerId) return;
            if ((event.buttons & 1) === 0) {
              endDrag();
              return;
            }
            const frame = event.currentTarget;
            frame.scrollLeft = start.left - (event.clientX - start.x);
            frame.scrollTop = start.top - (event.clientY - start.y);
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointer !== event.pointerId) return;
            endDrag();
          }}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
        >
          <img src={url} alt={`Photo: ${name}`} draggable={false} />
        </div>
        <p className="native-dialog-status" role="status">
          {zoom === 1 ? "Fitted to the window." : `Zoomed to ${zoom * 100}%.`}
        </p>
        <footer className="dialog-actions">
          <button
            className="button"
            type="button"
            disabled={level === 0}
            onClick={() => zoomTo(Math.max(0, level - 1))}
          >
            Zoom out
          </button>
          <button
            className="button"
            type="button"
            disabled={level === ZOOM_LEVELS.length - 1}
            onClick={() => zoomTo(Math.min(ZOOM_LEVELS.length - 1, level + 1))}
          >
            Zoom in
          </button>
          <button
            ref={closeRef}
            className="button primary"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
        </footer>
      </section>
    </div>
  );
}

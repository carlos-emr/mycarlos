import { useRef, useState } from "react";
import { useModalFocus } from "../useModalFocus";

// How far the photo can be zoomed, as a multiple of its fitted width. Each
// level is a class in styles.css: the CSP allows no inline styles.
const ZOOM_LEVELS = [1, 1.5, 2, 3, 4] as const;

/** A photo from the vault, fitted to the window, with Zoom in and Zoom out.
 * `url` is the `data:image/jpeg` URL the vault gave (vault_view_photo). */
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
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(true, dialogRef, onClose, closeRef);
  const zoom = ZOOM_LEVELS[level];
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
            the keyboard. */}
        <div
          className={`photo-viewer-frame zoom-${String(zoom).replace(".", "-")}`}
          role="region"
          aria-label="Photo. Zoom in to see details; scroll to move around."
          tabIndex={0}
        >
          <img src={url} alt={`Photo: ${name}`} />
        </div>
        <p className="native-dialog-status" role="status">
          {zoom === 1 ? "Fitted to the window." : `Zoomed to ${zoom * 100}%.`}
        </p>
        <footer className="dialog-actions">
          <button
            className="button"
            type="button"
            disabled={level === 0}
            onClick={() => setLevel((current) => Math.max(0, current - 1))}
          >
            Zoom out
          </button>
          <button
            className="button"
            type="button"
            disabled={level === ZOOM_LEVELS.length - 1}
            onClick={() =>
              setLevel((current) =>
                Math.min(ZOOM_LEVELS.length - 1, current + 1),
              )
            }
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

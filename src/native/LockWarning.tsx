import { useRef } from "react";
import { useModalFocus } from "../useModalFocus";

/**
 * Said before the automatic lock (#68, WCAG 2.2.1): Keep open has the focus
 * and keeps myCarlos open, and so does any key, click or touch, as use. A
 * screen reader reads it as it opens. Nothing of the records is shown.
 */
export function LockWarning({
  seconds,
  onKeepOpen,
}: {
  seconds: number;
  onKeepOpen: () => void;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const keepOpenRef = useRef<HTMLButtonElement | null>(null);
  // Escape is a key like any other: it keeps myCarlos open.
  useModalFocus(true, dialogRef, onKeepOpen, keepOpenRef);
  return (
    <div className="dialog-backdrop lock-warning-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="record-dialog native-lock-warning"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="lock-warning-title"
        aria-describedby="lock-warning-help"
      >
        <h2 id="lock-warning-title">
          myCarlos will lock in {seconds} second{seconds === 1 ? "" : "s"} to
          keep your records private.
        </h2>
        <p id="lock-warning-help">
          To keep it open, press Keep open, or any key.
        </p>
        <button
          ref={keepOpenRef}
          className="button primary"
          type="button"
          onClick={onKeepOpen}
        >
          Keep open
        </button>
      </section>
    </div>
  );
}

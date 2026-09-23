import { useRef, type ReactNode } from "react";
import { useModalFocus } from "../useModalFocus";

// Destructive and plaintext-exposing actions are confirmed here rather than with
// window.confirm. On desktop and iOS, tauri-plugin-dialog replaces window.confirm
// with an async function whose promise is always truthy, and the renderer is not
// granted the dialog command it calls, so a synchronous guard never stops anything.
export function ConfirmDialog({
  title,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useModalFocus(true, dialogRef, onCancel);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        ref={dialogRef}
        className="record-dialog native-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <h2 id="confirm-title">{title}</h2>
        </header>
        <div id="confirm-message" className="native-confirm-message">
          {children}
        </div>
        {/* Cancel comes first so it takes initial focus: Enter must not confirm. */}
        <footer className="dialog-actions">
          <button className="button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className={danger ? "button danger" : "button primary"}
            type="button"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}

import { useRef, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { useModalFocus } from "../useModalFocus";

// Destructive and plaintext-exposing actions are confirmed here rather than with
// window.confirm. On desktop and iOS, tauri-plugin-dialog replaces window.confirm
// with an async function whose promise is always truthy, and the renderer is not
// granted the dialog command it calls, so a synchronous guard never stops anything.
export function ConfirmDialog({
  title,
  confirmLabel,
  danger = false,
  cancelLabel,
  onConfirm,
  onCancel,
  removeLabel,
  onRemove,
  details,
  children,
}: {
  title: string;
  confirmLabel: string;
  /** What Cancel says, when another word fits the question better. */
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** A third choice that destroys what the question is about (Remove, where Cancel keeps it): shown
   * between Cancel and the confirming button, as a danger button, only when both are given. */
  removeLabel?: string;
  onRemove?: () => void;
  /** Shown above the message and not read with it when the dialog opens,
   * such as a long list the title already counts. */
  details?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  // Cancel takes the first focus even when something before it can take
  // focus too, such as a list that scrolls.
  useModalFocus(true, dialogRef, onCancel, cancelRef);
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
        <div className="native-confirm-message">
          {details}
          <div id="confirm-message" className="native-confirm-text">
            {children}
          </div>
        </div>
        {/* Cancel comes first so it takes initial focus: Enter must not confirm. */}
        <footer className="dialog-actions">
          <button
            ref={cancelRef}
            className="button"
            type="button"
            onClick={onCancel}
          >
            {cancelLabel ?? t("common.cancel")}
          </button>
          {removeLabel && onRemove && (
            <button className="button danger" type="button" onClick={onRemove}>
              {removeLabel}
            </button>
          )}
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

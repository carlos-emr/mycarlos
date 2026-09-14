import { useState, useRef, type FormEvent } from "react";
import { useModalFocus } from "../useModalFocus";
import { vaultErrorMessage } from "../vault";

export type RenameTarget = {
  kind: "folder" | "document";
  id: string;
  name: string;
};

export function RenameDialog({
  target,
  readOnly,
  onSave,
  onClose,
}: {
  target: RenameTarget;
  readOnly: boolean;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(target.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement | null>(null);
  const close = () => {
    if (!saving) onClose();
  };
  useModalFocus(true, dialogRef, close);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || readOnly || !name.trim()) return;
    setSaving(true);
    setError("");
    try {
      await onSave(name.trim());
      onClose();
    } catch (failure) {
      setError(vaultErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={close}>
      <section
        ref={dialogRef}
        className="record-dialog native-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <h2 id="rename-title">Rename {target.kind}</h2>
        </header>
        <form onSubmit={(event) => void save(event)}>
          <div className="native-rename-fields">
            <label htmlFor="rename-name">
              {target.kind === "folder" ? "Folder name" : "File name"}
            </label>
            <input
              id="rename-name"
              required
              maxLength={target.kind === "folder" ? 120 : 240}
              value={name}
              disabled={saving || readOnly}
              aria-describedby="rename-help"
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
            />
            <p id="rename-help">
              {target.kind === "folder"
                ? "The folder and its contents stay in the same location."
                : "This changes the name in myCarlos and suggested export name. Keep the .pdf extension for PDF files."}
            </p>
            {error && <p role="alert">{error}</p>}
          </div>
          <footer className="dialog-actions">
            <button
              className="button"
              type="button"
              disabled={saving}
              onClick={close}
            >
              Cancel
            </button>
            <button
              className="button primary"
              disabled={saving || readOnly || !name.trim()}
            >
              {saving ? "Saving…" : "Save name"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

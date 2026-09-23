import { useState, useRef, type FormEvent } from "react";
import { useModalFocus } from "../useModalFocus";
import { utf8Length, vaultErrorMessage } from "../vault";
import { NAME_INPUT_MAX_LENGTH, nameTooLong } from "./recordPresentation";

// The vault stores document names in at most this many UTF-8 bytes.
const MAX_DOCUMENT_NAME_BYTES = 240;

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
  const tooLong =
    target.kind === "document"
      ? utf8Length(name.trim()) > MAX_DOCUMENT_NAME_BYTES
      : nameTooLong(name);
  // The vault keeps document names usable as file names on every platform, so
  // it refuses these rather than change them. Name them instead of letting the
  // save fail with a generic message.
  const unsafeName =
    target.kind === "document" &&
    (/[<>:"|?*/\\]/.test(name.trim()) || name.trim().endsWith("."));
  const invalid = tooLong || unsafeName || !name.trim();
  const close = () => {
    if (!saving) onClose();
  };
  useModalFocus(true, dialogRef, close);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || readOnly || invalid) return;
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
              maxLength={
                target.kind === "folder"
                  ? NAME_INPUT_MAX_LENGTH
                  : MAX_DOCUMENT_NAME_BYTES
              }
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
            {tooLong && (
              <p role="alert">This name is too long. Shorten it to save.</p>
            )}
            {unsafeName && (
              <p role="alert">
                Document names cannot contain &lt; &gt; : &quot; | ? * / \ or
                end with a dot.
              </p>
            )}
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
              disabled={saving || readOnly || invalid}
            >
              {saving ? "Saving…" : "Save name"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

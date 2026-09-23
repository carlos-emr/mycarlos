import { useState, useRef, type FormEvent } from "react";
import { useModalFocus } from "../useModalFocus";
import { utf8Length, vaultErrorMessage } from "../vault";
import {
  NAME_INPUT_MAX_LENGTH,
  fileExtension,
  nameTooLong,
} from "./recordPresentation";

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
  // A document keeps its extension; only the name before it is edited. The
  // vault judges names trimmed, and an earlier build could store "X.pdf"
  // followed by a no-break space, so the extension is found the same way.
  const extension =
    target.kind === "document" ? fileExtension(target.name.trim()) : "";
  const originalStem = extension
    ? target.name.trim().slice(0, -extension.length)
    : target.name;
  const [name, setName] = useState(originalStem);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement | null>(null);
  // Someone who types the extension out of habit means the same name, so a
  // typed copy of it is dropped rather than doubled, unless the name already
  // ended with it twice, as in "Report.pdf.pdf".
  const endsWithExtension = (value: string) =>
    value.toLowerCase().endsWith(extension.toLowerCase());
  let stem = name.trim();
  if (extension && !endsWithExtension(originalStem) && endsWithExtension(stem))
    stem = stem.slice(0, stem.length - extension.length).trimEnd();
  // An untouched name is saved exactly as it was: trimming only the stem would
  // otherwise change a name such as "Results .pdf" that nobody edited.
  const fullName = name === originalStem ? target.name : stem + extension;
  const tooLong =
    target.kind === "document"
      ? utf8Length(fullName) > MAX_DOCUMENT_NAME_BYTES
      : nameTooLong(name);
  // The vault keeps document names usable as file names on every platform, so
  // it refuses these rather than change them. Name them instead of letting the
  // save fail with a generic message.
  const unsafeName =
    target.kind === "document" &&
    (/[<>:"|?*/\\]/.test(fullName) ||
      // Pasted control characters: the vault refuses or trims them (U+0085).
      /\p{Cc}/u.test(fullName) ||
      // Trimmed, as the vault judges it: an earlier build could store "X."
      // followed by a no-break space.
      fullName.trim().endsWith("."));
  // A name without ".pdf" cannot gain it, just as a PDF cannot lose it: the
  // vault refuses both, and a lock added by mistake could not be undone.
  const gainsExtension =
    target.kind === "document" &&
    !extension &&
    fullName.trim().toLowerCase().endsWith(".pdf");
  const invalid = tooLong || unsafeName || gainsExtension || !stem;
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
      await onSave(fullName);
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
            <div className="native-rename-input">
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
              {/* The help text names the extension for screen readers. */}
              {extension && <span aria-hidden="true">{extension}</span>}
            </div>
            <p id="rename-help">
              {target.kind === "folder"
                ? "The folder and its contents stay in the same location."
                : `This changes the name in myCarlos and the suggested export name.${
                    extension
                      ? ` The ${extension} extension stays the same.`
                      : ""
                  }`}
            </p>
            {extension && name.trim() && !stem && (
              <p role="alert">Enter a name before {extension}.</p>
            )}
            {gainsExtension && (
              <p role="alert">
                This document&apos;s name has no .pdf extension, so it cannot
                end in .pdf.
              </p>
            )}
            {tooLong && (
              <p role="alert">This name is too long. Shorten it to save.</p>
            )}
            {unsafeName && (
              <p role="alert">
                Document names cannot contain &lt; &gt; : &quot; | ? * / \ or
                invisible control characters, or end with a dot.
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

import { useState, useRef, type FormEvent } from "react";
import { useI18n } from "../i18n";
import { useModalFocus } from "../useModalFocus";
import { utf8Length, vaultErrorMessage } from "../vault";
import {
  NAME_INPUT_MAX_LENGTH,
  fileExtension,
  nameTooLong,
} from "./recordPresentation";
import { reservedDeviceName } from "./reservedNames";

// The vault stores document names in at most this many UTF-8 bytes.
const MAX_DOCUMENT_NAME_BYTES = 240;

// JavaScript's trim keeps U+0085 (next line), which the vault's trim removes,
// so typed names are trimmed as the vault will trim them. (It also removes a
// U+FEFF at either end, which the vault would refuse; the name sent is clean.)
// Shown in the refusal as plain text; kept out of the messages, which carry
// no markup characters.
const UNSAFE_CHARACTERS = '< > : " | ? * / \\';

const trimLikeVault = (value: string) =>
  value.replace(/^[\s\u0085]+|[\s\u0085]+$/g, "");

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
  const { t } = useI18n();
  const [name, setName] = useState(originalStem);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Changes on every refusal, so pressing Save again announces it again even
  // when the message is the same.
  const [refusals, setRefusals] = useState(0);
  const dialogRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Someone who types the extension out of habit means the same name, so a
  // typed copy of it is dropped rather than doubled, unless the name was left
  // as it was or already ended with it twice, as in "Report.pdf.pdf".
  const endsWithExtension = (value: string) =>
    value.toLowerCase().endsWith(extension.toLowerCase());
  let stem = trimLikeVault(name);
  if (
    extension &&
    name !== originalStem &&
    !endsWithExtension(originalStem) &&
    endsWithExtension(stem)
  )
    stem = trimLikeVault(stem.slice(0, stem.length - extension.length));
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
      // Pasted control characters inside the name, which the vault refuses,
      // and the zero-width and direction marks it strips (vault.rs
      // `sanitize_basename`), which it then refuses as a changed name.
      /[\p{Cc}\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(
        fullName,
      ) ||
      // Trimmed, as the vault judges it: an earlier build could store "X."
      // followed by a no-break space.
      trimLikeVault(fullName).endsWith("."));
  // A name without ".pdf" cannot gain it, just as a PDF cannot lose it: the
  // vault refuses both, and a lock added by mistake could not be undone.
  const gainsExtension =
    target.kind === "document" &&
    !extension &&
    trimLikeVault(fullName).toLowerCase().endsWith(".pdf");
  // Windows cannot create a file under a device name, so the vault refuses it.
  // Said when saving, not while typing: "Con" is on the way to "Consult".
  const reservedWord =
    target.kind === "document"
      ? reservedDeviceName(trimLikeVault(fullName))
      : undefined;
  const invalid = tooLong || unsafeName || gainsExtension || !stem;
  const close = () => {
    if (!saving) onClose();
  };
  useModalFocus(true, dialogRef, close, inputRef);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || readOnly || invalid) return;
    if (reservedWord) {
      setRefusals((count) => count + 1);
      setError(t("rename.reserved", { word: reservedWord }));
      return;
    }
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
          <h2 id="rename-title">
            {target.kind === "folder"
              ? t("rename.title.folder")
              : t("rename.title.document")}
          </h2>
        </header>
        <form onSubmit={(event) => void save(event)}>
          <div className="native-rename-fields">
            <label htmlFor="rename-name">
              {target.kind === "folder"
                ? t("rename.label.folder")
                : t("rename.label.document")}
            </label>
            <div className="native-rename-input">
              <input
                ref={inputRef}
                id="rename-name"
                required
                maxLength={
                  target.kind === "folder"
                    ? NAME_INPUT_MAX_LENGTH
                    : MAX_DOCUMENT_NAME_BYTES
                }
                value={name}
                disabled={saving || readOnly}
                aria-invalid={error ? true : undefined}
                aria-describedby={
                  error ? "rename-help rename-error" : "rename-help"
                }
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
                ? t("rename.help.folder")
                : extension
                  ? t("rename.help.documentExtension", { extension })
                  : t("rename.help.document")}
            </p>
            {extension && name.trim() && !stem && (
              <p role="alert">{t("rename.stemMissing", { extension })}</p>
            )}
            {gainsExtension && <p role="alert">{t("rename.gainsExtension")}</p>}
            {tooLong && <p role="alert">{t("rename.tooLong")}</p>}
            {unsafeName && (
              <p role="alert">
                {t("rename.unsafe", { characters: UNSAFE_CHARACTERS })}
              </p>
            )}
            {error && (
              <p id="rename-error" role="alert" key={refusals}>
                {error}
              </p>
            )}
          </div>
          <footer className="dialog-actions">
            <button
              className="button"
              type="button"
              disabled={saving}
              onClick={close}
            >
              {t("common.cancel")}
            </button>
            <button
              className="button primary"
              disabled={saving || readOnly || invalid}
            >
              {saving ? t("rename.saving") : t("rename.save")}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

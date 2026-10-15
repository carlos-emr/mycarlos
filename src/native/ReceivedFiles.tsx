import { useEffect, useState } from "react";
import type { ReceivedFile } from "../vault";
import { ConfirmDialog } from "./ConfirmDialog";

/** Files shared from another app, waiting for the patient. Nothing of them is
 * in the vault until "Add" is pressed; they go where the library is open, so
 * the patient chooses the person and folder by opening them. */
export function ReceivedFiles({
  files,
  destination,
  notPdfId,
  disabled,
  onAdd,
  onDecline,
}: {
  files: ReceivedFile[];
  /** Where an add puts them: the person and folder open now. */
  destination: string;
  /** A file an add refused as not a PDF: it is marked and left unticked. */
  notPdfId: string | null;
  disabled: boolean;
  onAdd: (ids: string[]) => void;
  onDecline: (ids: string[]) => void;
}) {
  // Ticked by default, except one already refused as not a PDF. A file that
  // arrives later is ticked too; one that has gone is dropped.
  const [unticked, setUnticked] = useState<string[]>([]);
  useEffect(() => {
    setUnticked((current) => {
      const kept = current.filter((id) => files.some((file) => file.id === id));
      return notPdfId && !kept.includes(notPdfId) ? [...kept, notPdfId] : kept;
    });
  }, [files, notPdfId]);
  const [confirmDecline, setConfirmDecline] = useState(false);
  const ticked = files
    .filter((file) => !unticked.includes(file.id))
    .map((file) => file.id);
  const toggle = (id: string) =>
    setUnticked((current) =>
      current.includes(id)
        ? current.filter((other) => other !== id)
        : [...current, id],
    );
  if (!files.length) return null;
  const count = ticked.length;
  const some = count === 1 ? "1 file" : `${count} files`;
  return (
    <section className="native-received" aria-labelledby="received-title">
      <h2 id="received-title">Shared with myCarlos</h2>
      <p>
        {files.length === 1
          ? "A file shared from another app is waiting."
          : `${files.length} files shared from another app are waiting.`}{" "}
        They are not in your records until you add them.
      </p>
      <ul className="native-received-list">
        {files.map((file) => (
          <li key={file.id}>
            <label>
              <input
                type="checkbox"
                checked={!unticked.includes(file.id)}
                disabled={disabled}
                onChange={() => toggle(file.id)}
              />
              <span className="native-received-name">{file.name}</span>
            </label>
            <span className="column">
              {file.id === notPdfId
                ? "Not a PDF document: decline it"
                : file.sourceLabel}
            </span>
          </li>
        ))}
      </ul>
      <p>
        Adds to {destination}. To add them elsewhere, open that person or folder
        first.
      </p>
      <div className="head-actions">
        <button
          className="button primary"
          type="button"
          disabled={disabled || count === 0}
          onClick={() => onAdd(ticked)}
        >
          Add {some}
        </button>
        <button
          className="button"
          type="button"
          disabled={disabled || count === 0}
          onClick={() => setConfirmDecline(true)}
        >
          Decline {some}
        </button>
      </div>
      {confirmDecline && (
        <ConfirmDialog
          title={`Decline ${some}?`}
          confirmLabel="Decline"
          onCancel={() => setConfirmDecline(false)}
          onConfirm={() => {
            setConfirmDecline(false);
            onDecline(ticked);
          }}
        >
          {count === 1 ? "It is" : "They are"} not added, and myCarlos forgets{" "}
          {count === 1 ? "it" : "them"}. The app that shared{" "}
          {count === 1 ? "it" : "them"} still has {count === 1 ? "it" : "them"}.
        </ConfirmDialog>
      )}
    </section>
  );
}

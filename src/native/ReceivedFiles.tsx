import { useEffect, useState } from "react";
import type { ReceivedFile, ReceivedRefusalReason } from "../vault";
import { ConfirmDialog } from "./ConfirmDialog";

/** Files shared from another app, waiting for the patient. Nothing of them is
 * in the vault until "Add" is pressed; they go where the library is open, so
 * the patient chooses the person and folder by opening them. */
/** What a refused file's row says, in place of the label it would carry. */
const REFUSED: Record<ReceivedRefusalReason, string> = {
  not_pdf: "Not a PDF document",
  pdf_locked: "Locked with a password",
  pdf_unlock_failed: "Locked, and could not be opened",
  pdf_unlock_unavailable: "Locked: cannot be opened on this device yet",
  pdf_too_large: "Locked, and too large to open",
};

export function ReceivedFiles({
  files,
  destination,
  refusals,
  disabled,
  onAdd,
  onDecline,
  onUnlock,
}: {
  files: ReceivedFile[];
  /** Where an add puts them: the person and folder open now. */
  destination: string;
  /** Files an add left out, and why: each is marked and left unticked. */
  refusals: Partial<Record<string, ReceivedRefusalReason>>;
  disabled: boolean;
  onAdd: (ids: string[]) => void;
  onDecline: (ids: string[]) => void;
  /** Asks for the password of a file left out because it is locked. */
  onUnlock: (id: string) => void;
}) {
  // Ticked by default, except files already refused. A file that arrives
  // later is ticked too; one that has gone is dropped.
  const [unticked, setUnticked] = useState<string[]>([]);
  const refusedIds = Object.keys(refusals).join(" ");
  useEffect(() => {
    setUnticked((current) => {
      const kept = current.filter((id) => files.some((file) => file.id === id));
      const refused = refusedIds
        .split(" ")
        .filter((id) => id && !kept.includes(id));
      return [...kept, ...refused];
    });
  }, [files, refusedIds]);
  // The files a confirmation would decline: the ticked ones, or one refused
  // file, from its own button.
  const [confirmDecline, setConfirmDecline] = useState<string[] | null>(null);
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
            {refusals[file.id] ? (
              <span className="column native-received-refused">
                {REFUSED[refusals[file.id]!]}
                {refusals[file.id] === "pdf_locked" && (
                  <button
                    className="button"
                    type="button"
                    aria-label={`Unlock ${file.name}`}
                    disabled={disabled}
                    onClick={() => onUnlock(file.id)}
                  >
                    Unlock
                  </button>
                )}
                <button
                  className="button"
                  type="button"
                  aria-label={`Decline ${file.name}`}
                  disabled={disabled}
                  onClick={() => setConfirmDecline([file.id])}
                >
                  Decline
                </button>
              </span>
            ) : (
              <span className="column">{file.sourceLabel}</span>
            )}
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
          onClick={() => setConfirmDecline(ticked)}
        >
          Decline {some}
        </button>
      </div>
      {confirmDecline && (
        <DeclineConfirmation
          files={files.filter((file) => confirmDecline.includes(file.id))}
          onCancel={() => setConfirmDecline(null)}
          onConfirm={(ids) => {
            setConfirmDecline(null);
            onDecline(ids);
          }}
        />
      )}
    </section>
  );
}

/** Asks before declining, naming each file, so the patient sees exactly
 * which ones myCarlos will forget. */
function DeclineConfirmation({
  files,
  onCancel,
  onConfirm,
}: {
  files: ReceivedFile[];
  onCancel: () => void;
  onConfirm: (ids: string[]) => void;
}) {
  const one = files.length === 1;
  return (
    <ConfirmDialog
      title={
        one ? `Decline ${files[0].name}?` : `Decline ${files.length} files?`
      }
      confirmLabel="Decline"
      onCancel={onCancel}
      onConfirm={() => onConfirm(files.map((file) => file.id))}
      details={
        one ? undefined : (
          <ul className="native-received-declining">
            {files.map((file) => (
              <li key={file.id}>{file.name}</li>
            ))}
          </ul>
        )
      }
    >
      {one ? "It is" : "They are"} not added, and myCarlos forgets{" "}
      {one ? "it" : "them"}. The app that shared {one ? "it" : "them"} still has{" "}
      {one ? "it" : "them"}.
    </ConfirmDialog>
  );
}

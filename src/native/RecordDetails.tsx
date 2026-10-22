import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import { useModalFocus } from "../useModalFocus";
import type { VaultFolder, VaultRecord } from "../vault";
import { formatBytes, recordKind } from "./recordPresentation";
import {
  MoveTargetSelect,
  parseMoveTarget,
  type MoveTarget,
} from "./MoveTargetSelect";

interface RecordDetailsProps {
  record: VaultRecord;
  folders: VaultFolder[];
  busy: boolean;
  readOnly: boolean;
  /** The vault's files could not be read, so an unavailable document may be
   * intact rather than missing. */
  unreadable: boolean;
  /** Result of the last operation. The page behind this modal is inert, so its
   * own status line is neither announced nor reliably visible from here. */
  notice: string;
  onClose: () => void;
  onRename: () => void;
  onMove: (folderId: string | null) => Promise<void>;
  /** For a document in Shared with me (#61): who it can go to, and the move. */
  moveTargets?: MoveTarget[];
  onMoveTo?: (profileId: string, folderId: string | null) => void;
  /** Takes the document out of view (#71); it is never deleted. */
  onHide: () => void;
  onExport: () => void;
  /** Opens the document in myCarlos's reader. */
  onRead?: () => void;
  /** Shows the document as a photo; given only when its file is one. */
  onViewPhoto?: () => void;
  /** The document is a PDF that may be locked with a password (#54). */
  locked?: boolean;
  /** Asks for its password; given only where myCarlos can unlock it. */
  onUnlock?: () => void;
}
export function RecordDetails({
  record,
  folders,
  busy,
  readOnly,
  unreadable,
  notice,
  onClose,
  onRename,
  onMove,
  moveTargets,
  onMoveTo,
  onHide,
  onExport,
  onRead,
  onViewPhoto,
  locked = false,
  onUnlock,
}: RecordDetailsProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  // Choosing in the list only picks a destination; Move moves (#67). In
  // Chromium every arrow key on a closed list changes its value, which moved
  // the document at once.
  const currentFolderId = record.folderIds[0] ?? "";
  // In Shared with me (#61) the list names a person's records or one of their
  // folders, and "" is staying in Shared with me.
  const current = moveTargets ? "" : currentFolderId;
  // A choice made for this document where it is now; a move or another
  // document starts again from where the document is.
  const placement = `${record.id}:${record.profileId}:${currentFolderId}`;
  const [choice, setChoice] = useState({ placement, value: current });
  const destination = choice.placement === placement ? choice.value : current;
  const move = () => {
    refocusMoveTo.current = true;
    if (!moveTargets) return void onMove(destination || null);
    const { profileId, folderId } = parseMoveTarget(destination);
    onMoveTo?.(profileId, folderId);
  };
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(true, dialogRef, onClose, closeRef);
  // Pressing Move disables it while the move runs, and it stays disabled
  // after (the document is where the list says), so focus would fall out of
  // the dialog. It goes back to "Move to" once the move has finished.
  const moveToRef = useRef<HTMLSelectElement | null>(null);
  const refocusMoveTo = useRef(false);
  useEffect(() => {
    if (busy || !refocusMoveTo.current) return;
    refocusMoveTo.current = false;
    moveToRef.current?.focus();
  }, [busy, placement]);
  const kind = recordKind(record.displayName);
  const folderNameById = new Map(
    folders.map((folder) => [folder.id, folder.name]),
  );
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="record-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="native-record-title"
        aria-describedby="native-record-about"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <div>
            <span className="eyebrow">Encrypted document</span>
            <h2 id="native-record-title">{record.displayName}</h2>
          </div>
          <button
            ref={closeRef}
            className="dialog-close native-dialog-close"
            type="button"
            aria-label="Close document details"
            onClick={onClose}
          >
            Close
          </button>
        </header>
        <div
          className="document-preview"
          aria-label="Encrypted document details"
        >
          <span className={`document-icon ${kind.icon}`}>
            <Icon name={kind.icon} />
          </span>
          <div className="preview-paper" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          {record.available ? (
            <p id="native-record-about">
              The file stays encrypted in the vault. Save a copy only when you
              need a readable file outside myCarlos.
            </p>
          ) : (
            <p id="native-record-about" role="alert">
              {unreadable ? (
                <>
                  <strong>This document is unavailable.</strong> Its encrypted
                  file is missing or could not be read, so a copy cannot be
                  saved. See the notice in the library for what to check.
                </>
              ) : (
                <>
                  <strong>This document is damaged.</strong> Its encrypted file
                  is missing from this device, so a copy cannot be saved.
                  Restoring the myCarlos data folder from a backup may recover
                  it.
                </>
              )}
            </p>
          )}
        </div>
        <dl className="record-metadata">
          <div>
            <dt>Kind</dt>
            <dd>{kind.label}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{record.sourceLabel}</dd>
          </div>
          <div>
            <dt>Date added</dt>
            <dd>{new Date(record.importedAtMs).toLocaleString()}</dd>
          </div>
          <div>
            <dt>File</dt>
            <dd>{formatBytes(record.plaintextSize)}</dd>
          </div>
          <div>
            <dt>Folder</dt>
            <dd>
              {record.folderIds
                .map((id) => folderNameById.get(id))
                .filter(Boolean)
                .join(", ") || (moveTargets ? "Shared with me" : "My records")}
            </dd>
          </div>
        </dl>
        {locked && (
          <p className="native-locked-note">
            <Icon name="lock-open" />
            <span>
              {onUnlock
                ? "Locked with a password. Unlock adds a copy that opens without it, and keeps this one."
                : "Locked with a password. myCarlos cannot open it on this device yet."}
            </span>
          </p>
        )}
        <div className="native-record-rename">
          {onUnlock && (
            <button
              className="button"
              type="button"
              disabled={busy || readOnly}
              onClick={onUnlock}
            >
              <Icon name="lock-open" />
              <span>Unlock…</span>
            </button>
          )}
          {onViewPhoto && (
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={onViewPhoto}
            >
              <Icon name="image" />
              <span>View photo</span>
            </button>
          )}
          <button
            className="button"
            type="button"
            disabled={busy || readOnly}
            onClick={onRename}
          >
            Rename document
          </button>
        </div>
        <p className="native-dialog-status" role="status">
          {notice}
        </p>
        <footer className="dialog-actions native-dialog-actions">
          <div className="native-dialog-move">
            <label>
              Move to
              {moveTargets ? (
                <MoveTargetSelect
                  ref={moveToRef}
                  label="Move to"
                  targets={moveTargets}
                  value={destination}
                  current="Shared with me"
                  disabled={busy || readOnly}
                  onChange={(value) => setChoice({ placement, value })}
                />
              ) : (
                <select
                  ref={moveToRef}
                  disabled={busy || readOnly}
                  value={destination}
                  onChange={(event) =>
                    setChoice({ placement, value: event.target.value })
                  }
                >
                  <option value="">My records</option>
                  {folders.map((folder) => (
                    <option value={folder.id} key={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
              )}
            </label>
            <button
              className="button"
              type="button"
              disabled={busy || readOnly || destination === current}
              onClick={move}
            >
              Move
            </button>
          </div>
          <button
            className="button"
            type="button"
            disabled={busy || readOnly}
            onClick={onHide}
          >
            Hide
          </button>
          {onRead && (
            <button
              className="button primary"
              type="button"
              disabled={busy || !record.available}
              onClick={onRead}
            >
              Read
            </button>
          )}
          <button
            className={onRead ? "button" : "button primary"}
            type="button"
            disabled={busy || !record.available}
            onClick={onExport}
          >
            Save a copy to this computer
          </button>
        </footer>
      </section>
    </div>
  );
}

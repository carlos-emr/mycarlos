import { useRef } from "react";
import { Icon } from "../Icon";
import { useModalFocus } from "../useModalFocus";
import type { VaultFolder, VaultRecord } from "../vault";
import { formatBytes, recordKind } from "./recordPresentation";

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
  onDelete: () => void;
  onExport: () => void;
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
  onDelete,
  onExport,
}: RecordDetailsProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(true, dialogRef, onClose, closeRef);
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
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <div>
            <span tabIndex={0} className="eyebrow">
              Encrypted document
            </span>
            <h2 tabIndex={0} id="native-record-title">
              {record.displayName}
            </h2>
          </div>
          <button
            ref={closeRef}
            className="dialog-close"
            type="button"
            aria-label="Close document details"
            onClick={onClose}
          >
            ×
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
            <p tabIndex={0}>
              The file stays encrypted in the vault. Save a copy only when you
              need a readable file outside myCarlos.
            </p>
          ) : (
            <p tabIndex={0} role="alert">
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
            <dt tabIndex={0}>Kind</dt>
            <dd tabIndex={0}>{kind.label}</dd>
          </div>
          <div>
            <dt tabIndex={0}>Source</dt>
            <dd tabIndex={0}>{record.sourceLabel}</dd>
          </div>
          <div>
            <dt tabIndex={0}>Date added</dt>
            <dd tabIndex={0}>
              {new Date(record.importedAtMs).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt tabIndex={0}>File</dt>
            <dd tabIndex={0}>{formatBytes(record.plaintextSize)}</dd>
          </div>
          <div>
            <dt tabIndex={0}>Folder</dt>
            <dd tabIndex={0}>
              {record.folderIds
                .map((id) => folderNameById.get(id))
                .filter(Boolean)
                .join(", ") || "My records"}
            </dd>
          </div>
        </dl>
        <div className="native-record-rename">
          <button
            className="button"
            type="button"
            disabled={busy || readOnly}
            onClick={onRename}
          >
            Rename document
          </button>
        </div>
        <p
          tabIndex={notice ? 0 : -1}
          className="native-dialog-status"
          role="status"
        >
          {notice}
        </p>
        <footer className="dialog-actions native-dialog-actions">
          <label>
            Move to
            <select
              disabled={busy || readOnly}
              value={record.folderIds[0] ?? ""}
              onChange={(event) => void onMove(event.target.value || null)}
            >
              <option value="">My records</option>
              {folders.map((folder) => (
                <option value={folder.id} key={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button danger"
            type="button"
            disabled={busy || readOnly}
            onClick={onDelete}
          >
            Permanently delete
          </button>
          <button
            className="button primary"
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

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
  notice,
  onClose,
  onRename,
  onMove,
  onDelete,
  onExport,
}: RecordDetailsProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useModalFocus(true, dialogRef, onClose);
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
            <span className="eyebrow">Encrypted document</span>
            <h2 id="native-record-title">{record.displayName}</h2>
          </div>
          <button
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
            <p>
              The file stays encrypted in the vault. Save a copy only when you
              need a readable file outside myCarlos.
            </p>
          ) : (
            <p role="alert">
              <strong>This document is damaged.</strong> Its encrypted file is
              missing from this device, so a copy cannot be saved. Restoring the
              vault folder from a backup may recover it.
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
        <p className="native-dialog-status" role="status">
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

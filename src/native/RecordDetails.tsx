import { useI18n, t as translateNow } from "../i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../Icon";
import { useModalFocus } from "../useModalFocus";
import type { VaultFolder, VaultRecord } from "../vault";
import { formatBytes, recordKind, recordSource } from "./recordPresentation";
import {
  MoveTargetSelect,
  moveTargetValue,
  parseMoveTarget,
  type MoveTarget,
} from "./MoveTargetSelect";

interface RecordDetailsProps {
  suggestion?: ReactNode;
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
  /** People and their folders that this document can move to. */
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
  suggestion,
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
  useI18n();
  const dialogRef = useRef<HTMLElement | null>(null);
  // Choosing in the list only picks a destination; Move moves (#67). In
  // Chromium every arrow key on a closed list changes its value, which moved
  // the document at once.
  const currentFolderId = record.folderIds[0] ?? "";
  const inShared =
    moveTargets &&
    !moveTargets.some((target) => target.profileId === record.profileId);
  const current = moveTargets
    ? inShared
      ? ""
      : moveTargetValue(record.profileId, currentFolderId || null)
    : currentFolderId;
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
            <span className="eyebrow">
              {translateNow("interface.RecordDetails.encryptedDocument")}
            </span>
            <h2 id="native-record-title">{record.displayName}</h2>
          </div>
          <button
            ref={closeRef}
            className="dialog-close native-dialog-close"
            type="button"
            aria-label={translateNow(
              "interface.RecordDetails.closeDocumentDetails",
            )}
            onClick={onClose}
          >
            {translateNow("photo.close")}
          </button>
        </header>
        <div
          className="document-preview"
          aria-label={translateNow(
            "interface.RecordDetails.encryptedDocumentDetails",
          )}
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
              {translateNow(
                "interface.RecordDetails.theFileStaysEncryptedInTheVault",
              )}
            </p>
          ) : (
            <p id="native-record-about" role="alert">
              {unreadable ? (
                <>
                  <strong>
                    {translateNow(
                      "interface.RecordDetails.thisDocumentIsUnavailable",
                    )}
                  </strong>{" "}
                  {translateNow(
                    "interface.RecordDetails.itsEncryptedFileIsMissingOrCould",
                  )}
                </>
              ) : (
                <>
                  <strong>
                    {translateNow(
                      "interface.RecordDetails.thisDocumentIsDamaged",
                    )}
                  </strong>{" "}
                  {translateNow(
                    "interface.RecordDetails.itsEncryptedFileIsMissingFromThis",
                  )}
                </>
              )}
            </p>
          )}
        </div>
        <dl className="record-metadata">
          <div>
            <dt>{translateNow("interface.RecordDetails.kind")}</dt>
            <dd>{kind.label}</dd>
          </div>
          <div>
            <dt>{translateNow("library.column.source")}</dt>
            <dd>
              {record.verifiedClinicName
                ? translateNow("portal.sourceVerified", {
                    clinic: record.verifiedClinicName,
                  })
                : recordSource(record)}
            </dd>
          </div>
          <div>
            <dt>{translateNow("library.column.added")}</dt>
            <dd>{new Date(record.importedAtMs).toLocaleString()}</dd>
          </div>
          {record.clinicServiceDate !== undefined && (
            <div>
              <dt>{translateNow("portal.serviceDateLabel")}</dt>
              <dd>
                {record.clinicServiceDate === ""
                  ? translateNow("portal.dateNotRecorded")
                  : record.clinicServiceDate}
              </dd>
            </div>
          )}
          <div>
            <dt>{translateNow("interface.RecordDetails.file")}</dt>
            <dd>{formatBytes(record.plaintextSize)}</dd>
          </div>
          <div>
            <dt>{translateNow("interface.RecordDetails.folder")}</dt>
            <dd>
              {record.folderIds
                .map((id) => folderNameById.get(id))
                .filter(Boolean)
                .join(", ") ||
                (moveTargets
                  ? translateNow("interface.LibrarySidebar.sharedWithMe")
                  : translateNow("sidebar.myRecords"))}
            </dd>
          </div>
        </dl>
        {locked && (
          <p className="native-locked-note">
            <Icon name="lock-open" />
            <span>
              {onUnlock
                ? translateNow(
                    "interface.RecordDetails.lockedWithAPasswordUnlockAddsA",
                  )
                : translateNow(
                    "interface.RecordDetails.lockedWithAPasswordMyCarlosCannotOpen",
                  )}
            </span>
          </p>
        )}
        {suggestion}
        <div className="native-record-rename">
          {onUnlock && (
            <button
              className="button"
              type="button"
              disabled={busy || readOnly}
              onClick={onUnlock}
            >
              <Icon name="lock-open" />
              <span>{translateNow("interface.RecordDetails.unlock")}</span>
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
              <span>{translateNow("interface.RecordDetails.viewPhoto")}</span>
            </button>
          )}
          <button
            className="button"
            type="button"
            disabled={busy || readOnly}
            onClick={onRename}
          >
            {translateNow("rename.title.document")}
          </button>
        </div>
        <p className="native-dialog-status" role="status">
          {notice}
        </p>
        <footer className="dialog-actions native-dialog-actions">
          <div className="native-dialog-move">
            <label>
              {translateNow("interface.RecordDetails.moveTo")}
              {moveTargets ? (
                <MoveTargetSelect
                  ref={moveToRef}
                  label={translateNow("interface.RecordDetails.moveTo")}
                  targets={moveTargets}
                  value={destination}
                  current={
                    inShared
                      ? translateNow("interface.LibrarySidebar.sharedWithMe")
                      : undefined
                  }
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
                  <option value="">{translateNow("sidebar.myRecords")}</option>
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
              {translateNow("interface.RecordDetails.move")}
            </button>
          </div>
          <button
            className="button"
            type="button"
            disabled={busy || readOnly}
            onClick={onHide}
          >
            {translateNow("interface.RecordDetails.hide")}
          </button>
          {onRead && (
            <button
              className="button primary"
              type="button"
              disabled={busy || !record.available}
              onClick={onRead}
            >
              {translateNow("interface.RecordDetails.read")}
            </button>
          )}
          <button
            className={onRead ? "button" : "button primary"}
            type="button"
            disabled={busy || !record.available}
            onClick={onExport}
          >
            {translateNow("interface.RecordDetails.saveACopyToThisComputer")}
          </button>
        </footer>
      </section>
    </div>
  );
}

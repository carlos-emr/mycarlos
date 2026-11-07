import { t as translateNow, useI18n } from "../i18n";
import type { ReactNode } from "react";
import { Icon } from "../Icon";

import type { VaultFolder, VaultRecord } from "../vault";
import { formatBytes, recordKind } from "./recordPresentation";
import { ClinicServiceDate } from "./ClinicServiceDate";
import { RecordSource } from "./RecordSource";
import type { DragItem, VaultDragDrop } from "./useVaultDragDrop";

interface LibraryItemsProps {
  view: "list" | "grid";
  suggestionFor?: (record: VaultRecord) => ReactNode;
  folders: VaultFolder[];
  records: VaultRecord[];
  selectedIds: string[];
  disabled: boolean;
  searching: boolean;
  /** What is said of a document whose file is not available: missing, or
   * only out of reach. */
  unavailableLabel: string;
  drag: VaultDragDrop;
  recordDragItem: (recordId: string) => DragItem;
  folderCount: (folderId: string) => number;
  /** While searching, where each result is (a path from the top), so that
   * two with the same name can be told apart. */
  folderLocation?: (folder: VaultFolder) => string;
  recordLocation?: (record: VaultRecord) => string;
  onOpenFolder: (folderId: string) => void;
  onOpenRecord: (recordId: string) => void;
  onRenameFolder: (folder: VaultFolder) => void;
  onToggleSelected: (recordId: string) => void;
}

function EmptyState({ searching }: { searching: boolean }) {
  useI18n();
  return (
    <div className="empty-state">
      <Icon name="folder" />
      <strong>
        {translateNow(
          searching ? "library.noMatch.title" : "library.empty.title",
        )}
      </strong>
      <span>
        {translateNow(
          searching ? "library.noMatch.help" : "library.empty.help",
        )}
      </span>
    </div>
  );
}

export function LibraryItems({
  view,
  suggestionFor,
  folders,
  records,
  selectedIds,
  disabled,
  searching,
  unavailableLabel,
  drag,
  recordDragItem,
  folderCount,
  folderLocation,
  recordLocation,
  onOpenFolder,
  onOpenRecord,
  onRenameFolder,
  onToggleSelected,
}: LibraryItemsProps) {
  const { startDrag, dragOver, dropInto, dragEnd, dragClass, dropClass } = drag;
  useI18n();
  const shown = translateNow("library.items", {
    count: folders.length + records.length,
  });
  return view === "list" ? (
    <div className="filelist native-filelist" aria-label={shown}>
      {/* Visual column labels only: each row's controls carry their own names. */}
      <div className="file-head" aria-hidden="true">
        <span />
        <span className="sorted">{translateNow("library.column.name")}</span>
        <span className="column">{translateNow("library.column.source")}</span>
        <span className="column">{translateNow("library.column.added")}</span>
        <span />
      </div>
      {folders.map((folder) => (
        <article
          aria-label={translateNow("library.folder.label", {
            name: folder.name,
          })}
          className={dropClass(
            dragClass("file-row", { kind: "folder", id: folder.id }),
            `list:${folder.id}`,
          )}
          key={folder.id}
          draggable={!disabled}
          onDragStart={(event) =>
            startDrag(event, { kind: "folder", id: folder.id })
          }
          onDragEnd={dragEnd}
          onDragOver={(event) => dragOver(event, `list:${folder.id}`)}
          onDrop={(event) => dropInto(event, folder.id)}
        >
          <span />
          <button
            className="file-name native-file-open"
            type="button"
            aria-label={translateNow("library.folder.open", {
              name: folder.name,
            })}
            aria-describedby={
              folderLocation
                ? `folder-items-${folder.id} folder-path-${folder.id}`
                : `folder-items-${folder.id}`
            }
            onClick={() => onOpenFolder(folder.id)}
          >
            <span className="document-icon folder">
              <Icon name="folder" />
            </span>
            <span className="name-copy">
              <strong>{folder.name}</strong>
              <small id={`folder-items-${folder.id}`}>
                {translateNow("library.folder.items", {
                  count: folderCount(folder.id),
                })}
              </small>
              {folderLocation && (
                <small
                  className="native-result-path"
                  id={`folder-path-${folder.id}`}
                >
                  {translateNow("interface.inLocation", {
                    location: folderLocation(folder),
                  })}
                </small>
              )}
            </span>
          </button>
          <span className="column" aria-hidden="true">
            —
          </span>
          <span className="column">
            {new Date(folder.createdAtMs).toLocaleDateString()}
          </span>
          <button
            className="native-rename-button"
            type="button"
            aria-label={translateNow("library.folder.rename", {
              name: folder.name,
            })}
            disabled={disabled}
            onClick={() => onRenameFolder(folder)}
          >
            {translateNow("library.rename")}
          </button>
        </article>
      ))}
      {records.map((record) => {
        const kind = recordKind(record.displayName);
        const item = recordDragItem(record.id);
        return (
          <article
            aria-label={translateNow("library.document.label", {
              name: record.displayName,
            })}
            className={dragClass("file-row", item)}
            key={record.id}
            draggable={!disabled}
            onDragStart={(event) => startDrag(event, item)}
            onDragEnd={dragEnd}
          >
            <SelectRecord
              record={record}
              selected={selectedIds.includes(record.id)}
              onToggle={onToggleSelected}
              describedBy={
                recordLocation ? `record-path-${record.id}` : undefined
              }
            />
            <div className="file-name">
              <span className={`document-icon ${kind.icon}`}>
                <Icon name={kind.icon} />
              </span>
              <span className="name-copy">
                <button
                  className="record-open"
                  type="button"
                  aria-describedby={
                    recordLocation ? `record-path-${record.id}` : undefined
                  }
                  onClick={() => onOpenRecord(record.id)}
                >
                  {record.displayName}
                </button>
                <small>
                  {formatBytes(record.plaintextSize)} · {kind.label}
                  {!record.available && ` · ${unavailableLabel}`}
                </small>
                <ClinicServiceDate value={record.clinicServiceDate} />
                {recordLocation && (
                  <small
                    className="native-result-path"
                    id={`record-path-${record.id}`}
                  >
                    {translateNow("interface.inLocation", {
                      location: recordLocation(record),
                    })}
                  </small>
                )}
              </span>
              {suggestionFor?.(record)}
            </div>
            <RecordSource record={record} className="column" />
            <span className="column">
              {new Date(record.importedAtMs).toLocaleDateString()}
            </span>
            <button
              className="more-button native-details-button"
              type="button"
              aria-label={translateNow("library.document.details", {
                name: record.displayName,
              })}
              onClick={() => onOpenRecord(record.id)}
            >
              {translateNow("library.details")}
            </button>
          </article>
        );
      })}
      {!folders.length && !records.length && (
        <EmptyState searching={searching} />
      )}
    </div>
  ) : (
    <div className="file-grid native-file-grid" aria-label={shown}>
      {folders.map((folder) => (
        <article
          aria-label={translateNow("library.folder.label", {
            name: folder.name,
          })}
          className={dropClass(
            dragClass("file-tile", { kind: "folder", id: folder.id }),
            `grid:${folder.id}`,
          )}
          key={folder.id}
          draggable={!disabled}
          onDragStart={(event) =>
            startDrag(event, { kind: "folder", id: folder.id })
          }
          onDragEnd={dragEnd}
          onDragOver={(event) => dragOver(event, `grid:${folder.id}`)}
          onDrop={(event) => dropInto(event, folder.id)}
        >
          <button
            className="tile-open"
            type="button"
            onClick={() => onOpenFolder(folder.id)}
          >
            <span className="tile-preview folder">
              <Icon name="folder" />
            </span>
            <span className="tile-caption">
              <span>
                <strong>{folder.name}</strong>
                <small>
                  {translateNow("library.folder.items", {
                    count: folderCount(folder.id),
                  })}
                </small>
                {folderLocation && (
                  <small className="native-result-path">
                    {translateNow("interface.inLocation", {
                      location: folderLocation(folder),
                    })}
                  </small>
                )}
              </span>
            </span>
          </button>
          <button
            className="native-rename-button"
            type="button"
            aria-label={translateNow("library.folder.rename", {
              name: folder.name,
            })}
            disabled={disabled}
            onClick={() => onRenameFolder(folder)}
          >
            {translateNow("library.rename")}
          </button>
        </article>
      ))}
      {records.map((record) => {
        const kind = recordKind(record.displayName);
        const item = recordDragItem(record.id);
        return (
          <article
            aria-label={translateNow("library.document.label", {
              name: record.displayName,
            })}
            className={dragClass("file-tile", item)}
            key={record.id}
            draggable={!disabled}
            onDragStart={(event) => startDrag(event, item)}
            onDragEnd={dragEnd}
          >
            {/* Grid view selects the same way as list view (#67). */}
            <SelectRecord
              record={record}
              selected={selectedIds.includes(record.id)}
              onToggle={onToggleSelected}
              className="tile-check"
            />
            <button
              className="tile-open"
              type="button"
              onClick={() => onOpenRecord(record.id)}
            >
              <span className="tile-preview paper-preview">
                <i />
                <i />
                <i />
                <i />
              </span>
              <span className="tile-caption">
                <span className={`document-icon ${kind.icon}`}>
                  <Icon name={kind.icon} />
                </span>
                <span>
                  <strong>{record.displayName}</strong>
                  <small>
                    {record.clinicServiceDate !== undefined &&
                      `${translateNow("library.column.added")}: `}
                    {new Date(record.importedAtMs).toLocaleDateString()}
                    {!record.available && ` · ${unavailableLabel}`}
                  </small>
                  <ClinicServiceDate value={record.clinicServiceDate} />
                  {recordLocation && (
                    <small className="native-result-path">
                      {translateNow("interface.inLocation", {
                        location: recordLocation(record),
                      })}
                    </small>
                  )}
                </span>
              </span>
            </button>
            {/* After the button, so its name stays the document's (#135). */}
            <RecordSource record={record} />
          </article>
        );
      })}
      {!folders.length && !records.length && (
        <EmptyState searching={searching} />
      )}
    </div>
  );
}

/** The select tick: a 44px target around a 24px box (#67). */
function SelectRecord({
  record,
  selected,
  onToggle,
  className = "",
  describedBy,
}: {
  record: VaultRecord;
  selected: boolean;
  onToggle: (recordId: string) => void;
  className?: string;
  /** A search result's "In …" path, read after the name (#57). */
  describedBy?: string;
}) {
  useI18n();
  return (
    <button
      className={`check native-check ${selected ? "checked" : ""} ${className}`.trim()}
      type="button"
      aria-label={translateNow("library.select", { name: record.displayName })}
      aria-describedby={describedBy}
      aria-pressed={selected}
      onClick={() => onToggle(record.id)}
    />
  );
}

import { Icon } from "../Icon";
import type { VaultFolder, VaultRecord } from "../vault";
import { formatBytes, recordKind } from "./recordPresentation";
import type { DragItem, VaultDragDrop } from "./useVaultDragDrop";

interface LibraryItemsProps {
  view: "list" | "grid";
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
  onOpenFolder: (folderId: string) => void;
  onOpenRecord: (recordId: string) => void;
  onRenameFolder: (folder: VaultFolder) => void;
  onToggleSelected: (recordId: string) => void;
}

function EmptyState({ searching }: { searching: boolean }) {
  return (
    <div className="empty-state">
      <Icon name="folder" />
      <strong tabIndex={0}>
        {searching ? "No matching records" : "This location is empty"}
      </strong>
      <span tabIndex={0}>
        {searching
          ? "Try another search."
          : "Add a folder or import a document here."}
      </span>
    </div>
  );
}

export function LibraryItems({
  view,
  folders,
  records,
  selectedIds,
  disabled,
  searching,
  unavailableLabel,
  drag,
  recordDragItem,
  folderCount,
  onOpenFolder,
  onOpenRecord,
  onRenameFolder,
  onToggleSelected,
}: LibraryItemsProps) {
  const { startDrag, dragOver, dropInto, dragEnd, dragClass, dropClass } = drag;
  return view === "list" ? (
    <div
      className="filelist native-filelist"
      aria-label={`${folders.length + records.length} visible library items`}
    >
      <div className="file-head">
        <span />
        <span className="sorted" tabIndex={0}>
          Name
        </span>
        <span className="column" tabIndex={0}>
          Source
        </span>
        <span className="column" tabIndex={0}>
          Date added
        </span>
        <span />
      </div>
      {folders.map((folder) => (
        <article
          aria-label={`${folder.name} folder`}
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
            aria-label={`Open ${folder.name}`}
            aria-description={`${folderCount(folder.id)} items`}
            onClick={() => onOpenFolder(folder.id)}
          >
            <span className="document-icon folder">
              <Icon name="folder" />
            </span>
            <span className="name-copy">
              <strong>{folder.name}</strong>
              <small>{folderCount(folder.id)} items</small>
            </span>
          </button>
          <span className="column" aria-hidden="true">
            —
          </span>
          <span tabIndex={0} className="column">
            {new Date(folder.createdAtMs).toLocaleDateString()}
          </span>
          <button
            className="native-rename-button"
            type="button"
            aria-label={`Rename folder ${folder.name}`}
            disabled={disabled}
            onClick={() => onRenameFolder(folder)}
          >
            Rename
          </button>
        </article>
      ))}
      {records.map((record) => {
        const kind = recordKind(record.displayName);
        const item = recordDragItem(record.id);
        return (
          <article
            aria-label={`${record.displayName} document`}
            className={dragClass("file-row", item)}
            key={record.id}
            draggable={!disabled}
            onDragStart={(event) => startDrag(event, item)}
            onDragEnd={dragEnd}
          >
            <button
              className={`check ${selectedIds.includes(record.id) ? "checked" : ""}`}
              type="button"
              aria-label={`Select ${record.displayName}`}
              aria-pressed={selectedIds.includes(record.id)}
              onClick={() => onToggleSelected(record.id)}
            />
            <div className="file-name">
              <span className={`document-icon ${kind.icon}`}>
                <Icon name={kind.icon} />
              </span>
              <span className="name-copy">
                <button
                  className="record-open"
                  type="button"
                  onClick={() => onOpenRecord(record.id)}
                >
                  {record.displayName}
                </button>
                <small tabIndex={0}>
                  {formatBytes(record.plaintextSize)} · {kind.label}
                  {!record.available && ` · ${unavailableLabel}`}
                </small>
              </span>
            </div>
            <span tabIndex={0} className="column">
              {record.sourceLabel}
            </span>
            <span tabIndex={0} className="column">
              {new Date(record.importedAtMs).toLocaleDateString()}
            </span>
            <button
              className="more-button"
              type="button"
              aria-label={`More options for ${record.displayName}`}
              onClick={() => onOpenRecord(record.id)}
            >
              <Icon name="more" />
            </button>
          </article>
        );
      })}
      {!folders.length && !records.length && (
        <EmptyState searching={searching} />
      )}
    </div>
  ) : (
    <div
      className="file-grid"
      aria-label={`${folders.length + records.length} visible library items`}
    >
      {folders.map((folder) => (
        <article
          aria-label={`${folder.name} folder`}
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
                <small>{folderCount(folder.id)} items</small>
              </span>
            </span>
          </button>
          <button
            className="native-rename-button"
            type="button"
            aria-label={`Rename folder ${folder.name}`}
            disabled={disabled}
            onClick={() => onRenameFolder(folder)}
          >
            Rename
          </button>
        </article>
      ))}
      {records.map((record) => {
        const kind = recordKind(record.displayName);
        const item = recordDragItem(record.id);
        return (
          <article
            aria-label={`${record.displayName} document`}
            className={dragClass("file-tile", item)}
            key={record.id}
            draggable={!disabled}
            onDragStart={(event) => startDrag(event, item)}
            onDragEnd={dragEnd}
          >
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
                    {new Date(record.importedAtMs).toLocaleDateString()}
                    {!record.available && ` · ${unavailableLabel}`}
                  </small>
                </span>
              </span>
            </button>
          </article>
        );
      })}
      {!folders.length && !records.length && (
        <EmptyState searching={searching} />
      )}
    </div>
  );
}

import { useMemo } from "react";
import { Icon } from "../Icon";
import type { VaultFolder, VaultRecord } from "../vault";
import type { VaultDragDrop } from "./useVaultDragDrop";

interface LibrarySidebarProps {
  profileName: string;
  section: "records" | "security";
  currentFolderId: string | null;
  folders: VaultFolder[];
  records: VaultRecord[];
  disabled: boolean;
  drag: VaultDragDrop;
  folderCount: (folderId: string) => number;
  onOpenFolder: (folderId: string | null) => void;
  onOpenSecurity: () => void;
}

export function LibrarySidebar({
  profileName,
  section,
  currentFolderId,
  folders,
  records,
  disabled,
  drag,
  folderCount,
  onOpenFolder,
  onOpenSecurity,
}: LibrarySidebarProps) {
  const { startDrag, dragOver, dropInto, dragEnd, dragClass, dropClass } = drag;
  const sidebarFolders = useMemo(() => {
    const children = new Map<string | null, VaultFolder[]>();
    for (const folder of folders) {
      const siblings = children.get(folder.parentId) ?? [];
      siblings.push(folder);
      children.set(folder.parentId, siblings);
    }
    for (const siblings of children.values())
      siblings.sort((left, right) => left.name.localeCompare(right.name));
    const tree: Array<{ folder: VaultFolder; depth: number }> = [];
    const visited = new Set<string>();
    const visit = (parentId: string | null, depth: number) => {
      for (const folder of children.get(parentId) ?? []) {
        if (visited.has(folder.id)) continue;
        visited.add(folder.id);
        tree.push({ folder, depth });
        visit(folder.id, depth + 1);
      }
    };
    visit(null, 0);
    return tree;
  }, [folders]);
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="activity" />
        </span>
        <span>
          <strong>myCarlos</strong>
          <small>{profileName}</small>
        </span>
      </div>
      <nav className="side-nav" aria-label="Record library">
        <button
          className={dropClass(
            section === "records" && !currentFolderId ? "selected" : "",
            "sidebar:root",
          )}
          type="button"
          onClick={() => onOpenFolder(null)}
          onDragOver={(event) => dragOver(event, "sidebar:root")}
          onDrop={(event) => dropInto(event, null)}
        >
          <Icon name="folder" /> My records{" "}
          <span className="nav-count">
            {records.filter((record) => !record.folderIds.length).length}
          </span>
        </button>
        <span className="nav-label">Folders</span>
        {sidebarFolders.map(({ folder, depth }) => (
          <button
            className={dropClass(
              dragClass(currentFolderId === folder.id ? "selected" : "", {
                kind: "folder",
                id: folder.id,
              }),
              `sidebar:${folder.id}`,
            )}
            style={{ paddingLeft: `${10 + Math.min(depth, 8) * 14}px` }}
            type="button"
            key={folder.id}
            draggable={!disabled}
            onDragStart={(event) =>
              startDrag(event, { kind: "folder", id: folder.id })
            }
            onDragEnd={dragEnd}
            onDragOver={(event) => dragOver(event, `sidebar:${folder.id}`)}
            onDrop={(event) => dropInto(event, folder.id)}
            onClick={() => onOpenFolder(folder.id)}
          >
            <Icon name="folder" />{" "}
            <span className="native-nav-name">{folder.name}</span>
            <span className="nav-count">{folderCount(folder.id)}</span>
          </button>
        ))}
        {!folders.length && (
          <small className="native-sidebar-empty">No folders yet</small>
        )}
        <span className="nav-label">Settings</span>
        <button
          className={section === "security" ? "selected" : ""}
          type="button"
          onClick={onOpenSecurity}
        >
          <Icon name="shield" /> Security
        </button>
      </nav>
      <div className="storage">
        <span>Encrypted local vault</span>
        <div className="storage-meter">
          <span
            style={{
              width: `${Math.min(100, Math.max(8, records.length * 4))}%`,
            }}
          />
        </div>
        <small>
          {records.length} document{records.length === 1 ? "" : "s"} ·{" "}
          {folders.length} folder{folders.length === 1 ? "" : "s"}
        </small>
      </div>
    </aside>
  );
}

import { useMemo, type ReactNode } from "react";
import { Icon } from "../Icon";
import type { VaultFolder, VaultRecord } from "../vault";
import type { VaultDragDrop } from "./useVaultDragDrop";

interface LibrarySidebarProps {
  profileName: string;
  /** The patient buttons, when there is more than one profile. */
  profileChoice?: ReactNode;
  section: "records" | "shared" | "security" | "preferences";
  /** Files added to Shared with me since the vault was unlocked, until it
   * is opened (#61). */
  sharedNew: number;
  /** With one person, Shared with me is a fixed folder inside their records;
   * with several, it is the whole vault's, above the people (Ben, 21 Oct). */
  sharedInside: boolean;
  onOpenShared: () => void;
  /** The whole vault's documents and folders, for the footer while the
   * vault's Shared with me is open. */
  vaultTotals: { documents: number; folders: number };
  currentFolderId: string | null;
  folders: VaultFolder[];
  records: VaultRecord[];
  disabled: boolean;
  drag: VaultDragDrop;
  folderCount: (folderId: string) => number;
  onOpenFolder: (folderId: string | null) => void;
  onOpenSecurity: () => void;
  onOpenPreferences: () => void;
}

export function LibrarySidebar({
  profileName,
  profileChoice,
  section,
  currentFolderId,
  folders,
  records,
  disabled,
  drag,
  folderCount,
  onOpenFolder,
  sharedNew,
  sharedInside,
  onOpenShared,
  vaultTotals,
  onOpenSecurity,
  onOpenPreferences,
}: LibrarySidebarProps) {
  const { startDrag, dragOver, dropInto, dragEnd, dragClass, dropClass } = drag;
  // With several people, the open Shared with me is the vault's: no person
  // is chosen, so no person's records or folders are listed, and the footer
  // counts the whole vault.
  const vaultWide = section === "shared" && !sharedInside;
  const totals = vaultWide
    ? vaultTotals
    : { documents: records.length, folders: folders.length };
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
  const shared = (
    <button
      className={
        [
          section === "shared" ? "selected" : "",
          sharedNew > 0 ? "native-shared-new" : "",
        ]
          .join(" ")
          .trim() || undefined
      }
      type="button"
      // The count is a flex item, so built from text it would be read
      // "Shared with me , 2 new"; say it plainly instead.
      aria-label={
        sharedNew > 0 ? `Shared with me, ${sharedNew} new` : undefined
      }
      onClick={onOpenShared}
    >
      <Icon name="letter" />{" "}
      <span className="native-nav-name">Shared with me</span>
      {sharedNew > 0 && <span className="nav-count">{sharedNew} new</span>}
    </button>
  );
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
      {/* With several people it is above them, so it is not taken for the
          chosen person's. */}
      {!sharedInside && (
        <div className="side-nav native-shared-nav">{shared}</div>
      )}
      {profileChoice}
      <nav className="side-nav" aria-label="Record library">
        {!vaultWide && (
          <>
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
            {sharedInside && shared}
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
            {!folders.length && !sharedInside && (
              <small className="native-sidebar-empty">No folders yet</small>
            )}
          </>
        )}
        <span className="nav-label">Settings</span>
        <button
          className={section === "security" ? "selected" : ""}
          type="button"
          onClick={onOpenSecurity}
        >
          <Icon name="shield" /> Security
        </button>
        <button
          className={section === "preferences" ? "selected" : ""}
          type="button"
          onClick={onOpenPreferences}
        >
          <Icon name="text-size" /> Preferences
        </button>
      </nav>
      <div className="storage">
        <span>Encrypted local vault</span>
        <div className="storage-meter">
          <span
            style={{
              width: `${Math.min(100, Math.max(8, totals.documents * 4))}%`,
            }}
          />
        </div>
        <small>
          {totals.documents} document{totals.documents === 1 ? "" : "s"} ·{" "}
          {totals.folders} folder{totals.folders === 1 ? "" : "s"}
        </small>
      </div>
    </aside>
  );
}

import { Fragment, useMemo } from "react";
import { Icon } from "../Icon";
import type { PatientProfile, VaultFolder, VaultRecord } from "../vault";
import type { VaultDragDrop } from "./useVaultDragDrop";

interface LibrarySidebarProps {
  /** The brand line: the open person's name, or the vault's while Shared
   * with me is open. */
  profileName: string;
  /** The people whose records the vault keeps, each a top-level folder
   * (Ben, 21 Oct). */
  people: PatientProfile[];
  /** The open person, while their records are shown. */
  profileId: string;
  section: "records" | "shared" | "security" | "preferences";
  /** Files added to Shared with me since the vault was unlocked, until it
   * is opened (#61). */
  sharedNew: number;
  onOpenShared: () => void;
  /** The whole vault's documents and folders, for the footer while Shared
   * with me is open: it is no one's. */
  vaultTotals: { documents: number; folders: number };
  currentFolderId: string | null;
  /** Every person's folders. */
  folders: VaultFolder[];
  /** Every person's documents. */
  records: VaultRecord[];
  disabled: boolean;
  drag: VaultDragDrop;
  onOpenPerson: (profileId: string) => void;
  onOpenFolder: (profileId: string, folderId: string) => void;
  onOpenSecurity: () => void;
  onOpenPreferences: () => void;
}

/** A person's folders in tree order, with their depth below the person. */
function folderTree(folders: VaultFolder[]) {
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
}

/** The name a person's top-level folder shows: with one person, "My
 * records", as before; with several, the person's name. */
export const personFolderName = (
  person: PatientProfile,
  people: PatientProfile[],
) => (people.length > 1 ? person.displayName : "My records");

export function LibrarySidebar({
  profileName,
  people,
  profileId,
  section,
  currentFolderId,
  folders,
  records,
  disabled,
  drag,
  onOpenPerson,
  onOpenFolder,
  sharedNew,
  onOpenShared,
  vaultTotals,
  onOpenSecurity,
  onOpenPreferences,
}: LibrarySidebarProps) {
  const { startDrag, dragOver, dropInto, dragEnd, dragClass, dropClass } = drag;
  const trees = useMemo(
    () =>
      new Map(
        people.map((person) => [
          person.id,
          folderTree(
            folders.filter((folder) => folder.profileId === person.id),
          ),
        ]),
      ),
    [folders, people],
  );
  const counts = useMemo(() => {
    const byFolder = new Map<string, number>();
    const loose = new Map<string, number>();
    for (const record of records) {
      if (!record.folderIds.length)
        loose.set(record.profileId, (loose.get(record.profileId) ?? 0) + 1);
      for (const id of record.folderIds)
        byFolder.set(id, (byFolder.get(id) ?? 0) + 1);
    }
    return { byFolder, loose };
  }, [records]);
  // Shared with me is the whole vault's: while it is open the footer counts
  // the whole vault; otherwise it counts the open person's.
  const totals =
    section === "shared"
      ? vaultTotals
      : {
          documents: records.filter((record) => record.profileId === profileId)
            .length,
          folders: folders.filter((folder) => folder.profileId === profileId)
            .length,
        };
  const several = people.length > 1;
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
        {people.map((person) => {
          const open = section === "records" && person.id === profileId;
          const rootZone = `sidebar:person:${person.id}`;
          return (
            <Fragment key={person.id}>
              <button
                className={dropClass(
                  open && !currentFolderId ? "selected" : "",
                  rootZone,
                )}
                type="button"
                aria-current={open && !currentFolderId ? "page" : undefined}
                onClick={() => onOpenPerson(person.id)}
                onDragOver={(event) => dragOver(event, rootZone)}
                onDrop={(event) => dropInto(event, null, person.id)}
              >
                <Icon name="folder" />{" "}
                <span className="native-nav-name">
                  {personFolderName(person, people)}
                </span>
                <span className="nav-count">
                  {counts.loose.get(person.id) ?? 0}
                </span>
              </button>
              {(trees.get(person.id) ?? []).map(({ folder, depth }) => {
                const zone = `sidebar:${folder.id}`;
                const here = open && currentFolderId === folder.id;
                return (
                  <button
                    className={dropClass(
                      dragClass(here ? "selected" : "", {
                        kind: "folder",
                        id: folder.id,
                      }),
                      zone,
                    )}
                    style={{
                      paddingLeft: `${10 + Math.min(depth + 1, 8) * 14}px`,
                    }}
                    type="button"
                    key={folder.id}
                    aria-current={here ? "page" : undefined}
                    // Two people can each have a "Lab results": say whose.
                    aria-label={
                      several
                        ? `${folder.name} (${person.displayName}) ${counts.byFolder.get(folder.id) ?? 0}`
                        : undefined
                    }
                    draggable={!disabled}
                    onDragStart={(event) =>
                      startDrag(event, { kind: "folder", id: folder.id })
                    }
                    onDragEnd={dragEnd}
                    onDragOver={(event) => dragOver(event, zone)}
                    onDrop={(event) => dropInto(event, folder.id, person.id)}
                    onClick={() => onOpenFolder(person.id, folder.id)}
                  >
                    <Icon name="folder" />{" "}
                    <span className="native-nav-name">{folder.name}</span>
                    <span className="nav-count">
                      {counts.byFolder.get(folder.id) ?? 0}
                    </span>
                  </button>
                );
              })}
            </Fragment>
          );
        })}
        {/* Beside the people and inside no one's: what cannot be placed yet.
            It cannot be renamed, moved or deleted. */}
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
          aria-current={section === "shared" ? "page" : undefined}
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

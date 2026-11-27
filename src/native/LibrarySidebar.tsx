import { t as translateNow, useI18n } from "../i18n";
import { useMemo } from "react";
import { Icon } from "../Icon";

import type { PatientProfile, VaultFolder, VaultRecord } from "../vault";
import type { VaultDragDrop } from "./useVaultDragDrop";
import { SpokenCount } from "./SpokenCount";
import { AddDocumentMenu, type AddMenuItem } from "./AddDocumentMenu";

interface LibrarySidebarProps {
  /** The people whose records the vault keeps, each a top-level folder
   * (Ben, 21 Oct). */
  people: PatientProfile[];
  /** The open person, while their records are shown. */
  profileId: string;
  section:
    | "records"
    | "shared"
    | "hidden"
    | "history"
    | "security"
    | "preferences"
    | "ai";
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
  /** Hidden can be opened from Shared with me; keep its whole-vault footer. */
  hiddenFromShared?: boolean;
  /** What the Add document menu offers here, and whether it can be used now. */
  addItems: AddMenuItem[];
  addDisabled: boolean;
  /** Something is running: the Add document button says "Working…". */
  addWorking?: boolean;
  onOpenSecurity: () => void;
  onOpenPreferences: () => void;
  /** The AI helper's settings (#72): given only where the helper can run,
   * on a computer. */
  onOpenAi?: () => void;
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
) =>
  people.length > 1 ? person.displayName : translateNow("sidebar.myRecords");

/** Up to two initials of a name, for the badge beside it (the name itself is always shown too). */
export const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0]!.toLocaleUpperCase())
    .join("");

export function LibrarySidebar({
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
  hiddenFromShared = false,
  addItems,
  addDisabled,
  addWorking = false,
  onOpenSecurity,
  onOpenPreferences,
  onOpenAi,
}: LibrarySidebarProps) {
  useI18n();
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
    section === "shared" || hiddenFromShared
      ? vaultTotals
      : {
          documents: records.filter((record) => record.profileId === profileId)
            .length,
          folders: folders.filter((folder) => folder.profileId === profileId)
            .length,
        };
  const several = people.length > 1;
  // The person whose folders are listed: the one open, or the last one open.
  const folderPerson = people.find((person) => person.id === profileId);
  return (
    <aside className="sidebar">
      <AddDocumentMenu
        items={addItems}
        disabled={addDisabled}
        working={addWorking}
      />
      <nav className="side-nav" aria-label={translateNow("sidebar.label")}>
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
            sharedNew > 0
              ? translateNow("interface.sidebar.sharedNew", {
                  shared: translateNow("interface.LibrarySidebar.sharedWithMe"),
                  new: translateNow("interface.count.new", {
                    count: sharedNew,
                  }),
                })
              : undefined
          }
          onClick={onOpenShared}
        >
          <Icon name="letter" />{" "}
          <span className="native-nav-name">
            {translateNow("interface.LibrarySidebar.sharedWithMe")}
          </span>
          {sharedNew > 0 && (
            <span className="nav-count">
              {translateNow("interface.count.new", { count: sharedNew })}
            </span>
          )}
        </button>
        <span className="nav-label">{translateNow("sidebar.people")}</span>
        {people.map((person) => {
          const open = section === "records" && person.id === profileId;
          const rootZone = `sidebar:person:${person.id}`;
          return (
            <button
              key={person.id}
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
              {/* Drawn by CSS from the attribute: the badge is decoration, so it is neither text a
                  screen reader or a label-in-name check could take for part of the name. */}
              <span
                className="person-initials"
                aria-hidden="true"
                data-initials={initialsOf(person.displayName)}
              />
              <span className="native-nav-name">
                {several
                  ? person.displayName
                  : translateNow("sidebar.myRecords")}
              </span>
              <SpokenCount count={counts.loose.get(person.id) ?? 0} />
            </button>
          );
        })}
        {/* The open person's folders: only theirs (a folder does not go to another person), so
            only these move by drag. Documents dropped from Shared with me go to a person above. */}
        {folderPerson && (
          <>
            <span className="nav-label">
              {several
                ? translateNow("sidebar.foldersOf", {
                    name: folderPerson.displayName,
                  })
                : translateNow("sidebar.folders")}
            </span>
            {(trees.get(folderPerson.id) ?? []).map(({ folder, depth }) => {
              const zone = `sidebar:${folder.id}`;
              const here =
                section === "records" && currentFolderId === folder.id;
              const movable = section === "records" && !disabled;
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
                    paddingLeft: `${10 + Math.min(depth, 8) * 14}px`,
                  }}
                  type="button"
                  key={folder.id}
                  aria-current={here ? "page" : undefined}
                  // Two people can each have a "Lab results": say whose,
                  // with each language's own brackets.
                  aria-label={
                    several
                      ? `${translateNow("sidebar.folderOfPerson", {
                          folder: folder.name,
                          person: folderPerson.displayName,
                        })} ${translateNow("sidebar.documents", { count: counts.byFolder.get(folder.id) ?? 0 })}`
                      : undefined
                  }
                  draggable={movable || undefined}
                  onDragStart={(event) => {
                    if (!movable) return event.preventDefault();
                    startDrag(event, { kind: "folder", id: folder.id });
                  }}
                  onDragEnd={dragEnd}
                  onDragOver={(event) => dragOver(event, zone)}
                  onDrop={(event) =>
                    dropInto(event, folder.id, folderPerson.id)
                  }
                  onClick={() => onOpenFolder(folderPerson.id, folder.id)}
                >
                  <Icon name="folder" />{" "}
                  <span className="native-nav-name">{folder.name}</span>
                  <SpokenCount count={counts.byFolder.get(folder.id) ?? 0} />
                </button>
              );
            })}
          </>
        )}
        <div
          className="side-settings"
          role="group"
          aria-label={translateNow("sidebar.settings")}
        >
          <button
            className={
              section === "security" ||
              section === "hidden" ||
              section === "history"
                ? "selected"
                : ""
            }
            aria-current={
              section === "security" ||
              section === "hidden" ||
              section === "history"
                ? "page"
                : undefined
            }
            type="button"
            onClick={onOpenSecurity}
          >
            <Icon name="shield" /> {translateNow("security.title")}
          </button>
          <button
            className={section === "preferences" ? "selected" : ""}
            type="button"
            aria-current={section === "preferences" ? "page" : undefined}
            onClick={onOpenPreferences}
          >
            <Icon name="settings" /> {translateNow("sidebar.preferences")}
          </button>
          {onOpenAi && (
            <button
              className={section === "ai" ? "selected" : ""}
              type="button"
              onClick={onOpenAi}
            >
              <Icon name="sparkle" /> {translateNow("ai.preferences.title")}
            </button>
          )}
        </div>
      </nav>
      <div className="storage">
        <span>{translateNow("sidebar.storage")}</span>
        <small>
          {translateNow("sidebar.documents", { count: totals.documents })} ·{" "}
          {translateNow("sidebar.folderCount", { count: totals.folders })}
        </small>
      </div>
    </aside>
  );
}

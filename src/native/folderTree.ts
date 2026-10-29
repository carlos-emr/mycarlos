import { t as translateNow } from "../i18n";
import type { VaultFolder, VaultRecord } from "../vault";

/** The ids of a folder and of every folder beneath it. */
export function folderSubtree(
  folders: VaultFolder[],
  rootId: string,
): Set<string> {
  const subtree = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (
        folder.parentId &&
        subtree.has(folder.parentId) &&
        !subtree.has(folder.id)
      ) {
        subtree.add(folder.id);
        grew = true;
      }
    }
  }
  return subtree;
}

/** Where a folder is, from the top: "My records / Letters / 2025", or
 * "My records" for none. A parent that is not known ends the path, and so
 * does one met twice, so a damaged tree cannot loop. The root label can name
 * the current person's records. */
export function folderPath(
  folderById: ReadonlyMap<string, VaultFolder>,
  folderId: string | null,
  rootLabel = translateNow("sidebar.myRecords"),
): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (
    let folder = folderId ? folderById.get(folderId) : undefined;
    folder && !seen.has(folder.id);
    folder = folder.parentId ? folderById.get(folder.parentId) : undefined
  ) {
    seen.add(folder.id);
    names.unshift(folder.name);
  }
  return [rootLabel, ...names].join(" / ");
}

/** Where a document is filed: the path of each of its folders, or
 * "My records" when it is in none, so that two documents with the same name
 * can be told apart. The root label also names Shared with me. */
export function recordPath(
  folderById: ReadonlyMap<string, VaultFolder>,
  record: VaultRecord,
  rootLabel = translateNow("sidebar.myRecords"),
): string {
  const paths = record.folderIds
    .filter((id) => folderById.has(id))
    .map((id) => folderPath(folderById, id, rootLabel))
    .sort((left, right) => left.localeCompare(right));
  return paths.length ? paths.join("; ") : rootLabel;
}

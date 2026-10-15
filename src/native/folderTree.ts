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
 * does one met twice, so a damaged tree cannot loop. */
export function folderPath(
  folderById: ReadonlyMap<string, VaultFolder>,
  folderId: string | null,
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
  return ["My records", ...names].join(" / ");
}

/** Where a document is filed: the path of each of its folders, or
 * "My records" when it is in none, so that two documents with the same name
 * can be told apart. */
export function recordPath(
  folderById: ReadonlyMap<string, VaultFolder>,
  record: VaultRecord,
): string {
  const paths = record.folderIds
    .filter((id) => folderById.has(id))
    .map((id) => folderPath(folderById, id))
    .sort((left, right) => left.localeCompare(right));
  return paths.length ? paths.join("; ") : "My records";
}

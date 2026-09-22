import { LibrarySidebar } from "./LibrarySidebar";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Icon } from "../Icon";
import type {
  VaultBridge,
  VaultFolder,
  VaultRecord,
  VaultSnapshot,
} from "../vault";
import { RenameDialog, type RenameTarget } from "./RenameDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { SecuritySettings } from "./SecuritySettings";
import { RecordDetails } from "./RecordDetails";
import { LibraryItems } from "./LibraryItems";
import { useVaultDragDrop, type DragItem } from "./useVaultDragDrop";

type NativeSection = "records" | "security";
type NativeView = "list" | "grid";
type NativeSort = "newest" | "name";

export function VaultLibrary({
  bridge,
  snapshot,
  busy,
  notice,
  setNotice,
  run,
  refresh,
  onLock,
  autoLockMinutes,
  onAutoLockMinutes,
}: {
  bridge: VaultBridge;
  snapshot: VaultSnapshot;
  busy: boolean;
  notice: string;
  setNotice: (value: string) => void;
  run: (operation: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
  onLock: () => Promise<void>;
  autoLockMinutes: number;
  onAutoLockMinutes: (value: unknown) => void;
}) {
  const [profileId, setProfileId] = useState(snapshot.profiles[0]?.id ?? "");
  const [section, setSection] = useState<NativeSection>("records");
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<NativeView>("list");
  const [sort, setSort] = useState<NativeSort>("newest");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [moveFolderId, setMoveFolderId] = useState("");
  const [activeRecordId, setActiveRecordId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  // Bound to one record so a stale prompt can never apply to a different document.
  const [confirmation, setConfirmation] = useState<{
    action: "delete" | "export";
    recordId: string;
  } | null>(null);
  const [confirmRemoveDamaged, setConfirmRemoveDamaged] = useState(false);
  const [showFolderForm, setShowFolderForm] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderToMoveId, setFolderToMoveId] = useState("");
  const [folderDestinationId, setFolderDestinationId] = useState("");
  const profile =
    snapshot.profiles.find((candidate) => candidate.id === profileId) ??
    snapshot.profiles[0];
  const folders = useMemo(
    () => snapshot.folders.filter((folder) => folder.profileId === profileId),
    [snapshot.folders, profileId],
  );
  const records = useMemo(
    () => snapshot.records.filter((record) => record.profileId === profileId),
    [snapshot.records, profileId],
  );
  const currentFolder =
    folders.find((folder) => folder.id === currentFolderId) ?? null;
  const folderNameById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleFolders = useMemo(
    () =>
      folders
        .filter((folder) => folder.parentId === currentFolderId)
        .filter(
          (folder) =>
            !normalizedQuery ||
            folder.name.toLocaleLowerCase().includes(normalizedQuery),
        )
        .sort((left, right) => left.name.localeCompare(right.name)),
    [currentFolderId, folders, normalizedQuery],
  );
  const visibleRecords = useMemo(() => {
    const matching = records.filter((record) => {
      const inFolder = currentFolderId
        ? record.folderIds.includes(currentFolderId)
        : record.folderIds.length === 0;
      return (
        inFolder &&
        (!normalizedQuery ||
          record.displayName.toLocaleLowerCase().includes(normalizedQuery))
      );
    });
    return matching.sort((left, right) =>
      sort === "name"
        ? left.displayName.localeCompare(right.displayName)
        : right.importedAtMs - left.importedAtMs,
    );
  }, [currentFolderId, normalizedQuery, records, sort]);
  const selectedRecords = records.filter((record) =>
    selectedIds.includes(record.id),
  );
  const activeRecord =
    records.find((record) => record.id === activeRecordId) ?? null;
  const pendingAction =
    activeRecord && confirmation?.recordId === activeRecord.id
      ? confirmation.action
      : null;
  const readOnly = snapshot.recovery !== null;

  useEffect(() => {
    if (profile && profile.id !== profileId) setProfileId(profile.id);
  }, [profile, profileId]);

  useEffect(() => {
    setCurrentFolderId(null);
    setSelectedIds([]);
    setQuery("");
    // Folder ids belong to one profile. A kept id would no longer match any
    // option, so the select would show "My records" while sending the old id.
    setMoveFolderId("");
    setFolderToMoveId("");
    setFolderDestinationId("");
  }, [profileId]);

  useEffect(() => {
    setSelectedIds([]);
    setQuery("");
  }, [currentFolderId]);

  // A search can hide selected documents, and "Move" acts on the whole
  // selection. Start it again so that it never includes a document out of view.
  useEffect(() => {
    setSelectedIds([]);
  }, [query]);

  const renameFolder = (folder: VaultFolder) =>
    setRenameTarget({ kind: "folder", id: folder.id, name: folder.name });
  const saveName = async (name: string) => {
    if (!renameTarget) return;
    // The dialog closes when this resolves, so a refusal has to reject: a
    // silent return would look like a saved name.
    if (busy || readOnly)
      throw new Error(
        readOnly
          ? "The vault is read-only, so the name was not changed."
          : "Another vault operation is still running. Try again when it finishes.",
      );
    if (renameTarget.kind === "folder") {
      const folder = folders.find(
        (candidate) => candidate.id === renameTarget.id,
      );
      if (!folder) throw new Error("That folder is no longer available.");
      await bridge.updateFolder(folder.id, folder.parentId, name);
    } else {
      await bridge.renameRecord(renameTarget.id, name);
    }
    await refresh();
    setNotice(
      `${renameTarget.kind === "folder" ? "Folder" : "Document"} renamed to ${name}.`,
    );
  };

  const importFiles = () =>
    run(async () => {
      const folderIds = currentFolderId ? [currentFolderId] : [];
      const pickId = await bridge.pickImportFiles(profileId, folderIds);
      if (!pickId) {
        setNotice("No files selected. Nothing changed.");
        return;
      }
      const outcome = await bridge.importPickedFiles(
        pickId,
        profileId,
        folderIds,
      );
      if (!outcome.imported.length && !outcome.skippedDuplicates.length) {
        setNotice("No files selected. Nothing changed.");
        return;
      }
      await refresh();
      const skipped = outcome.skippedDuplicates.length
        ? ` ${outcome.skippedDuplicates.length} duplicate(s) skipped.`
        : "";
      setNotice(
        `${outcome.imported.length} file(s) encrypted and imported.${skipped}`,
      );
    });

  const toggleSelected = (id: string) =>
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((candidate) => candidate !== id)
        : [...current, id],
    );

  const moveSelected = () =>
    run(async () => {
      await bridge.assignFoldersBatch(
        selectedRecords.map((record) => record.id),
        moveFolderId ? [moveFolderId] : [],
      );
      await refresh();
      setSelectedIds([]);
      setNotice(
        `${selectedRecords.length} document${selectedRecords.length === 1 ? "" : "s"} moved.`,
      );
    });

  // The whole pane is a drop target for the open folder, so letting go of a drag
  // where it started is the usual way to abandon it. That must not rewrite the
  // manifest, clear the selection, or claim something moved.
  const alreadyIn = (item: DragItem, folderId: string | null) => {
    if (item.kind === "folder")
      return (
        (folders.find((folder) => folder.id === item.id)?.parentId ?? null) ===
        folderId
      );
    return item.ids.every((id) => {
      const current = records.find((record) => record.id === id)?.folderIds;
      return (
        current !== undefined &&
        (folderId
          ? current.length === 1 && current[0] === folderId
          : current.length === 0)
      );
    });
  };

  const moveItem = (item: DragItem, folderId: string | null) => {
    if (alreadyIn(item, folderId)) return;
    void run(async () => {
      if (item.kind === "records") {
        await bridge.assignFoldersBatch(item.ids, folderId ? [folderId] : []);
        setSelectedIds([]);
        setNotice(
          `${item.ids.length} document${item.ids.length === 1 ? "" : "s"} moved to ${folderId ? folderNameById.get(folderId) : "My records"}.`,
        );
      } else {
        const folder = folders.find((candidate) => candidate.id === item.id);
        if (!folder || folder.id === folderId) {
          setNotice("A folder cannot be moved into itself.");
          return;
        }
        await bridge.updateFolder(folder.id, folderId, folder.name);
        setNotice(
          `${folder.name} moved to ${folderId ? folderNameById.get(folderId) : "My records"}.`,
        );
      }
      await refresh();
    });
  };
  const drag = useVaultDragDrop({
    disabled: busy || readOnly,
    onMove: moveItem,
  });
  const { dragOver, dropInto, dropClass } = drag;

  const recordDragItem = (recordId: string): DragItem => ({
    kind: "records",
    ids: selectedIds.includes(recordId)
      ? selectedRecords.map((record) => record.id)
      : [recordId],
  });

  const exportRecord = (record: VaultRecord) => {
    setConfirmation(null);
    void run(async () => {
      const pickId = await bridge.pickExportDestination(record.id);
      if (!pickId) {
        setNotice("Save cancelled. Nothing changed.");
        return;
      }
      await bridge.exportToPicked(pickId, record.id);
      setNotice("A readable copy was saved to this computer.");
    });
  };

  const damagedCount = snapshot.records.filter(
    (record) => !record.available,
  ).length;
  const removeDamaged = () => {
    setConfirmRemoveDamaged(false);
    void run(async () => {
      const removed = await bridge.removeUnavailableRecords();
      setActiveRecordId(null);
      setSelectedIds((current) =>
        current.filter((id) => !removed.includes(id)),
      );
      await refresh();
      setNotice(
        removed.length === 0
          ? "Every file is back on this device. Nothing was removed, and the vault accepts changes again."
          : `${removed.length} damaged document${removed.length === 1 ? "" : "s"} removed. The vault accepts changes again.`,
      );
    });
  };

  const deleteRecord = (record: VaultRecord) => {
    setConfirmation(null);
    void run(async () => {
      await bridge.deleteRecord(record.id);
      setActiveRecordId(null);
      setSelectedIds((current) => current.filter((id) => id !== record.id));
      await refresh();
      setNotice(`${record.displayName} was permanently deleted.`);
    });
  };

  const changePassphrase = (current: string, replacement: string) =>
    run(async () => {
      await bridge.changePassphrase(current, replacement);
      await refresh();
      setNotice("Passphrase changed.");
    });
  const createProfile = async (name: string) => {
    let created = false;
    await run(async () => {
      await bridge.createProfile(name);
      created = true;
      await refresh();
      setNotice(`${name} was added.`);
    });
    return created;
  };
  const resetVault = (confirmation: string) =>
    run(async () => {
      let erased: boolean;
      try {
        erased = await bridge.reset(confirmation);
      } catch (error) {
        // A reset closes the native session before it erases anything, so a
        // failed one leaves the vault locked. Show that instead of a library
        // whose every action would be refused.
        await onLock();
        throw error;
      }
      if (erased) window.location.reload();
      else setNotice("Vault erase cancelled. Nothing changed.");
    });
  const moveRecord = (recordId: string, folderId: string | null) =>
    run(async () => {
      await bridge.assignFolders(recordId, folderId ? [folderId] : []);
      await refresh();
      setNotice("Document moved.");
    });

  const submitFolder = (event: FormEvent) => {
    event.preventDefault();
    const name = folderName;
    void run(async () => {
      await bridge.createFolder(profileId, currentFolderId, name);
      // Cleared only once the folder exists, so a refused name can be corrected.
      setFolderName("");
      await refresh();
      setShowFolderForm(false);
      setNotice(`${name} was created.`);
    });
  };
  const moveFolder = () =>
    run(async () => {
      const folder = folders.find(
        (candidate) => candidate.id === folderToMoveId,
      );
      if (!folder) return;
      await bridge.updateFolder(
        folder.id,
        folderDestinationId || null,
        folder.name,
      );
      await refresh();
      setNotice(`${folder.name} moved.`);
    });

  // A folder cannot move into itself or anything beneath it, so those are not
  // offered as destinations.
  const folderDestinations = useMemo(() => {
    const excluded = new Set([folderToMoveId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const folder of folders) {
        if (
          folder.parentId &&
          excluded.has(folder.parentId) &&
          !excluded.has(folder.id)
        ) {
          excluded.add(folder.id);
          grew = true;
        }
      }
    }
    return folders.filter((folder) => !excluded.has(folder.id));
  }, [folders, folderToMoveId]);

  // Asked once per folder by both the sidebar and the item list, so count in
  // one pass instead of filtering every record for every folder on each render.
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const record of records)
      for (const id of record.folderIds)
        counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  }, [records]);
  const folderCount = (id: string) => folderCounts.get(id) ?? 0;
  const locationTitle = currentFolder?.name ?? "My records";

  return (
    <div className="evaluation-page native-vault-page">
      <div className="evaluation-banner" role="note">
        <strong>Synthetic-data development build</strong>
        <span>
          Files and record details are encrypted and saved on this device
        </span>
      </div>
      <div className="page-wrap">
        <section
          className="app-window"
          aria-label="myCarlos encrypted record library"
        >
          <header
            className="titlebar"
            inert={Boolean(activeRecord || renameTarget)}
          >
            <span className="window-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="window-title">myCarlos</span>
            <button
              className="unlock-pill native-lock-button"
              type="button"
              onClick={() => void onLock()}
            >
              <Icon name="lock-open" /> Unlocked · Lock now
            </button>
          </header>

          <label
            className="mobile-section-picker"
            inert={Boolean(activeRecord || renameTarget)}
          >
            <span>Section</span>
            <select
              aria-label="Section"
              value={section}
              onChange={(event) =>
                setSection(event.target.value as NativeSection)
              }
            >
              <option value="records">My records</option>
              <option value="security">Security</option>
            </select>
          </label>

          <div
            className="app-body"
            inert={Boolean(activeRecord || renameTarget)}
          >
            <LibrarySidebar
              profileName={profile?.displayName ?? "Private vault"}
              section={section}
              currentFolderId={currentFolderId}
              folders={folders}
              records={records}
              disabled={busy || readOnly}
              drag={drag}
              folderCount={folderCount}
              onOpenFolder={(folderId) => {
                setSection("records");
                setCurrentFolderId(folderId);
              }}
              onOpenSecurity={() => setSection("security")}
            />

            {section === "records" && (
              <main
                className={dropClass(
                  "library-main",
                  `pane:${currentFolderId ?? "root"}`,
                )}
                onDragOver={(event) =>
                  dragOver(event, `pane:${currentFolderId ?? "root"}`)
                }
                onDrop={(event) => dropInto(event, currentFolderId)}
              >
                <div className="native-profile-row">
                  <button
                    className={dropClass(
                      "breadcrumb native-breadcrumb",
                      "breadcrumb:root",
                    )}
                    type="button"
                    onDragOver={(event) => dragOver(event, "breadcrumb:root")}
                    onDrop={(event) => dropInto(event, null)}
                    onClick={() => setCurrentFolderId(null)}
                  >
                    My records
                  </button>
                  {currentFolder && (
                    <>
                      <span aria-hidden="true">/</span>
                      <strong>{currentFolder.name}</strong>
                    </>
                  )}
                  <label className="native-profile-select">
                    <span>Patient</span>
                    <select
                      value={profileId}
                      onChange={(event) => setProfileId(event.target.value)}
                    >
                      {snapshot.profiles.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="main-head">
                  <div>
                    <h1>{locationTitle}</h1>
                    <p>
                      {visibleFolders.length} folders · {visibleRecords.length}{" "}
                      documents in this location
                    </p>
                  </div>
                  <div className="head-actions">
                    {currentFolder && (
                      <button
                        className="button"
                        type="button"
                        disabled={busy || readOnly}
                        onClick={() => renameFolder(currentFolder)}
                      >
                        Rename folder
                      </button>
                    )}
                    <button
                      className="button"
                      type="button"
                      disabled={readOnly}
                      onClick={() => setShowFolderForm((current) => !current)}
                    >
                      <Icon name="folder-plus" />
                      <span>New folder</span>
                    </button>
                    <button
                      className="button primary"
                      type="button"
                      disabled={busy || readOnly || !profileId}
                      onClick={() => void importFiles()}
                      aria-label="Choose files to import"
                    >
                      <Icon name="plus" />
                      <span>{busy ? "Working…" : "New"}</span>
                    </button>
                  </div>
                </div>

                {showFolderForm && (
                  <form className="native-inline-form" onSubmit={submitFolder}>
                    <label>
                      Folder name
                      <input
                        autoFocus
                        required
                        maxLength={120}
                        value={folderName}
                        onChange={(event) => setFolderName(event.target.value)}
                      />
                    </label>
                    <button
                      className="button primary"
                      disabled={busy || readOnly}
                    >
                      Create
                    </button>
                    <button
                      className="button"
                      type="button"
                      onClick={() => setShowFolderForm(false)}
                    >
                      Cancel
                    </button>
                  </form>
                )}

                {folders.length > 0 && (
                  <details className="native-folder-move">
                    <summary>Move a folder with the keyboard</summary>
                    <div>
                      <label>
                        Folder
                        <select
                          value={folderToMoveId}
                          onChange={(event) => {
                            setFolderToMoveId(event.target.value);
                            // The destination list excludes the chosen folder.
                            setFolderDestinationId("");
                          }}
                        >
                          <option value="">Choose a folder</option>
                          {folders.map((folder) => (
                            <option value={folder.id} key={folder.id}>
                              {folder.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Destination
                        <select
                          value={folderDestinationId}
                          onChange={(event) =>
                            setFolderDestinationId(event.target.value)
                          }
                        >
                          <option value="">My records</option>
                          {folderDestinations.map((folder) => (
                            <option value={folder.id} key={folder.id}>
                              {folder.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="button"
                        type="button"
                        disabled={busy || readOnly || !folderToMoveId}
                        onClick={() => void moveFolder()}
                      >
                        Move folder
                      </button>
                    </div>
                  </details>
                )}

                {snapshot.recovery === "lostObjects" && (
                  <div className="purpose-note warning" role="alert">
                    <Icon name="info" />
                    <span>
                      <strong>Read-only recovery mode.</strong> Some encrypted
                      files are missing from this device. Documents marked
                      damaged cannot be saved; save copies of the others. To
                      make changes again, restore the vault folder from a
                      backup, or remove the damaged documents.
                    </span>
                    <button
                      className="button danger"
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmRemoveDamaged(true)}
                    >
                      Remove damaged documents
                    </button>
                  </div>
                )}
                {snapshot.recovery === "unreadableSlot" && (
                  <div className="purpose-note warning" role="alert">
                    <Icon name="info" />
                    <span>
                      <strong>Read-only recovery mode.</strong> A copy of the
                      vault's metadata could not be read, and it may be newer
                      than what is shown. Nothing will be changed on disk. Check
                      that no other program holds the vault folder, then lock
                      and unlock again.
                    </span>
                  </div>
                )}
                {snapshot.recovery === "writeFailed" && (
                  <div className="purpose-note warning" role="alert">
                    <Icon name="info" />
                    <span>
                      <strong>Read-only recovery mode.</strong> A write to the
                      vault failed. Free storage or check the disk, then lock
                      and unlock again; the vault repairs itself when it can
                      write.
                    </span>
                  </div>
                )}

                <label className="search">
                  <Icon name="search" />
                  <span className="sr-only">Search this location</span>
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search this location"
                  />
                </label>
                <div className="viewbar">
                  <span className="native-location-chip">
                    {currentFolder ? "Inside folder" : "Top level"}
                  </span>
                  <span className="native-drag-hint">
                    Hold and drag a document or folder to move it
                  </span>
                  <div className="view-controls">
                    <label className="native-sort">
                      <Icon name="sort" />
                      <span className="sr-only">Sort records</span>
                      <select
                        value={sort}
                        onChange={(event) =>
                          setSort(event.target.value as NativeSort)
                        }
                      >
                        <option value="newest">Newest first</option>
                        <option value="name">Name A–Z</option>
                      </select>
                    </label>
                    <span className="segment" aria-label="Choose record view">
                      <button
                        className={view === "list" ? "selected" : ""}
                        type="button"
                        aria-label="List view"
                        aria-pressed={view === "list"}
                        onClick={() => setView("list")}
                      >
                        <Icon name="list" />
                      </button>
                      <button
                        className={view === "grid" ? "selected" : ""}
                        type="button"
                        aria-label="Grid view"
                        aria-pressed={view === "grid"}
                        onClick={() => setView("grid")}
                      >
                        <Icon name="grid" />
                      </button>
                    </span>
                  </div>
                </div>

                {selectedIds.length > 0 && (
                  <div className="bulkbar" role="status">
                    <strong>{selectedIds.length} selected</strong>
                    <span>Move the selected documents.</span>
                    <div className="bulk-actions native-move-actions">
                      <select
                        aria-label="Move selected to"
                        value={moveFolderId}
                        onChange={(event) =>
                          setMoveFolderId(event.target.value)
                        }
                      >
                        <option value="">My records</option>
                        {folders.map((folder) => (
                          <option value={folder.id} key={folder.id}>
                            {folder.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={busy || readOnly}
                        onClick={() => void moveSelected()}
                      >
                        Move
                      </button>
                      <button type="button" onClick={() => setSelectedIds([])}>
                        Clear
                      </button>
                    </div>
                  </div>
                )}
                <p className="status-line" role="status" aria-live="polite">
                  {notice}
                </p>

                <LibraryItems
                  view={view}
                  folders={visibleFolders}
                  records={visibleRecords}
                  selectedIds={selectedIds}
                  disabled={busy || readOnly}
                  searching={Boolean(query)}
                  drag={drag}
                  recordDragItem={recordDragItem}
                  folderCount={folderCount}
                  onOpenFolder={setCurrentFolderId}
                  onOpenRecord={(recordId) => {
                    // The details dialog repeats the notice. One left over from
                    // an earlier operation would read as being about this record.
                    setNotice("");
                    setActiveRecordId(recordId);
                  }}
                  onRenameFolder={renameFolder}
                  onToggleSelected={toggleSelected}
                />
              </main>
            )}

            {section === "security" && (
              <SecuritySettings
                busy={busy}
                readOnly={readOnly}
                notice={notice}
                autoLockMinutes={autoLockMinutes}
                onAutoLockMinutes={onAutoLockMinutes}
                onLock={onLock}
                onChangePassphrase={changePassphrase}
                onCreateProfile={createProfile}
                onReset={resetVault}
              />
            )}
          </div>

          {renameTarget && (
            <RenameDialog
              target={renameTarget}
              readOnly={busy || readOnly}
              onSave={saveName}
              onClose={() => setRenameTarget(null)}
            />
          )}
          {activeRecord && !renameTarget && !pendingAction && (
            <RecordDetails
              record={activeRecord}
              folders={folders}
              busy={busy}
              readOnly={readOnly}
              notice={notice}
              onClose={() => setActiveRecordId(null)}
              onRename={() =>
                setRenameTarget({
                  kind: "document",
                  id: activeRecord.id,
                  name: activeRecord.displayName,
                })
              }
              onMove={(folderId) => moveRecord(activeRecord.id, folderId)}
              onDelete={() =>
                setConfirmation({ action: "delete", recordId: activeRecord.id })
              }
              onExport={() =>
                setConfirmation({ action: "export", recordId: activeRecord.id })
              }
            />
          )}
          {activeRecord && pendingAction === "delete" && (
            <ConfirmDialog
              title="Permanently delete this document?"
              confirmLabel="Permanently delete"
              danger
              onConfirm={() => deleteRecord(activeRecord)}
              onCancel={() => setConfirmation(null)}
            >
              <p>
                <strong>{activeRecord.displayName}</strong> will be permanently
                deleted from this vault. This cannot be undone here.
              </p>
              <p>
                Readable exports and the clinic's source medical record are not
                deleted.
              </p>
            </ConfirmDialog>
          )}
          {confirmRemoveDamaged && (
            <ConfirmDialog
              title={`Remove ${damagedCount} damaged document${damagedCount === 1 ? "" : "s"}?`}
              confirmLabel="Remove"
              danger
              onConfirm={removeDamaged}
              onCancel={() => setConfirmRemoveDamaged(false)}
            >
              <p>
                The encrypted files for these documents are missing from this
                device, so their content is already gone from here. Removing
                them forgets their names and details too. This cannot be undone.
              </p>
              <p>
                If you have a backup of the vault folder, restore it first: any
                file that is back is kept, not removed.
              </p>
            </ConfirmDialog>
          )}
          {activeRecord && pendingAction === "export" && (
            <ConfirmDialog
              title="Save a readable copy?"
              confirmLabel="Save a copy"
              onConfirm={() => exportRecord(activeRecord)}
              onCancel={() => setConfirmation(null)}
            >
              <p>
                Saving creates a readable file outside the encrypted vault.
                myCarlos cannot erase that copy later, and deleting this record
                will not remove it.
              </p>
            </ConfirmDialog>
          )}
        </section>
      </div>
    </div>
  );
}

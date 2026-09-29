import { LibrarySidebar } from "./LibrarySidebar";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Icon } from "../Icon";
import {
  vaultErrorMessage,
  type VaultBridge,
  type VaultFolder,
  type VaultRecord,
  type VaultSnapshot,
} from "../vault";
import { RenameDialog, type RenameTarget } from "./RenameDialog";
import {
  RecoveryKeySetup,
  type OpeningRecoverySetup,
} from "./RecoveryKeySetup";
import { ConfirmDialog } from "./ConfirmDialog";
import { SecuritySettings } from "./SecuritySettings";
import { RecordDetails } from "./RecordDetails";
import { LibraryItems } from "./LibraryItems";
import {
  NAME_INPUT_MAX_LENGTH,
  nameTooLong,
  searchKey,
} from "./recordPresentation";
import { useVaultDragDrop, type DragItem } from "./useVaultDragDrop";
import { ANNOUNCE_DELAY_MS } from "./announce";

type NativeSection = "records" | "security";
type NativeView = "list" | "grid";
type NativeSort = "newest" | "name";

/** The ids of a folder and of every folder beneath it. */
function folderSubtree(folders: VaultFolder[], rootId: string): Set<string> {
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
  openingRecoverySetup = null,
  onOpeningRecoverySetupShown,
  canPrint = false,
}: {
  bridge: VaultBridge;
  snapshot: VaultSnapshot;
  busy: boolean;
  notice: string;
  setNotice: (value: string) => void;
  run: (operation: () => Promise<void>) => Promise<void>;
  /** Reloads the snapshot and resolves to it, so a caller can report the
   * state it produced rather than the state it hoped for. */
  refresh: () => Promise<VaultSnapshot>;
  onLock: () => Promise<void>;
  autoLockMinutes: number;
  onAutoLockMinutes: (value: unknown) => void;
  /** What the library opens on, when it opens on the recovery key setup: a
   * new vault's key, to set up first, or the offer of one at unlock. */
  openingRecoverySetup?: OpeningRecoverySetup | null;
  onOpeningRecoverySetupShown?: () => void;
  /** Whether this platform can print the recovery kit. */
  canPrint?: boolean;
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
  // The result of a dialog's action (a rename, a recovery key), given once the
  // dialog has closed (see the effect below), and the document whose details
  // it was started from, if any.
  const [dialogResult, setDialogResult] = useState<{
    message: string;
    recordId: string | null;
  } | null>(null);
  // Bound to one record so a stale prompt can never apply to a different document.
  const [confirmation, setConfirmation] = useState<{
    action: "delete" | "export";
    recordId: string;
  } | null>(null);
  const [confirmRemoveDamaged, setConfirmRemoveDamaged] = useState(false);
  // Setting up a recovery key. A vault just created starts with its key, which
  // must be set up before the library can be used. A vault unlocked without
  // one is offered a key, which can be left for later: the setup opens on the
  // step that asks, with no key made yet.
  const [recoverySetup, setRecoverySetup] = useState<{
    initialKey?: string;
    required: boolean;
    offered?: boolean;
  } | null>(() =>
    !openingRecoverySetup
      ? null
      : openingRecoverySetup.vault === "created"
        ? { initialKey: openingRecoverySetup.key, required: true }
        : { required: false, offered: true },
  );
  useEffect(() => {
    if (openingRecoverySetup) onOpeningRecoverySetupShown?.();
    // Only the key the library opened with.
  }, []);
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
  const normalizedQuery = searchKey(query.trim());
  const visibleFolders = useMemo(
    () =>
      folders
        .filter((folder) => folder.parentId === currentFolderId)
        .filter(
          (folder) =>
            !normalizedQuery ||
            searchKey(folder.name).includes(normalizedQuery),
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
          searchKey(record.displayName).includes(normalizedQuery))
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

  // A status line reads out only text that changes while it is on the page.
  // The rename dialog makes the page inert, and replaces a document's details,
  // whose status line then comes back with it. Give the result once that line
  // is back and has had time to be seen, or it is shown but never read out.
  // A dialog returns focus to the button that opened it. When that button is
  // gone by then (the banner that offered the setup, the Create screen), focus
  // would be left on nothing: put it on the page's heading.
  const pageHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const focusPageIfLost = () =>
    window.setTimeout(() => {
      const focused = document.activeElement;
      if (!focused || focused === document.body || !focused.isConnected)
        pageHeadingRef.current?.focus();
    }, ANNOUNCE_DELAY_MS);
  const setNoticeRef = useRef(setNotice);
  setNoticeRef.current = setNotice;
  useEffect(() => {
    // Any dialog open, such as a confirmation opened straight away, hides the
    // status line too: wait until it closes.
    // The same goes while an operation runs: its own result comes next, and
    // a result written during a transfer would be taken for that transfer's.
    if (
      !dialogResult ||
      renameTarget ||
      confirmation ||
      confirmRemoveDamaged ||
      recoverySetup ||
      busy
    )
      return;
    // A newer message replaces the result, and another document's details
    // opened meanwhile are not where it belongs.
    if (
      notice ||
      (activeRecordId !== null && activeRecordId !== dialogResult.recordId)
    ) {
      setDialogResult(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setNoticeRef.current(dialogResult.message);
      setDialogResult(null);
    }, ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    activeRecordId,
    busy,
    confirmation,
    confirmRemoveDamaged,
    notice,
    dialogResult,
    recoverySetup,
    renameTarget,
  ]);

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
    // Cleared now, so that the result is a change even when it repeats.
    setNotice("");
    setDialogResult({
      message: `${renameTarget.kind === "folder" ? "Folder" : "Document"} renamed to ${name}.`,
      recordId: activeRecordId,
    });
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
        if (!folder) {
          setNotice("That folder is no longer available.");
          return;
        }
        // The sidebar lists every folder, so a folder can be dropped on one
        // of its own subfolders. The vault refuses that as a cycle.
        if (folderId && folderSubtree(folders, folder.id).has(folderId)) {
          setNotice("A folder cannot be moved into itself or its subfolders.");
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

  const saveBackup = () =>
    run(async () => {
      const pickId = await bridge.pickBackupDestination();
      if (!pickId) {
        setNotice("No location chosen. Nothing changed.");
        return;
      }
      await bridge.saveBackupToPicked(pickId);
      setNotice(
        "Encrypted backup saved. Keep it somewhere other than this device.",
      );
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

  // Every damaged document in the vault, not only those in view: removal
  // takes them all, so the confirmation names them all.
  const damaged = snapshot.records.filter((record) => !record.available);
  const damagedIds = damaged.map((record) => record.id);
  const damagedCount = damagedIds.length;
  const profileName = (id: string) =>
    snapshot.profiles.find((candidate) => candidate.id === id)?.displayName ??
    "";
  const removeDamaged = () => {
    setConfirmRemoveDamaged(false);
    void run(async () => {
      let removed: string[];
      try {
        // The vault removes only what this screen showed as damaged.
        removed = await bridge.removeUnavailableRecords(damagedIds);
      } catch (error) {
        // A refusal can change what the vault reports (more documents
        // damaged, or files that cannot be read): show that, then the reason.
        await refresh().catch(() => undefined);
        throw error;
      }
      setActiveRecordId(null);
      setSelectedIds((current) =>
        current.filter((id) => !removed.includes(id)),
      );
      const next = await refresh();
      const outcome =
        removed.length === 0
          ? "Every file is back on this device. Nothing was removed."
          : `${removed.length} damaged document${removed.length === 1 ? "" : "s"} removed.`;
      // The removal can commit and still leave the vault read-only, when its
      // redundant write fails. The banner then says why; only claim the vault
      // is writable when it is.
      setNotice(
        next.recovery === null
          ? `${outcome} The vault accepts changes again.`
          : outcome,
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
    const excluded = folderSubtree(folders, folderToMoveId);
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
            inert={Boolean(
              activeRecord ||
                renameTarget ||
                confirmRemoveDamaged ||
                recoverySetup,
            )}
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
            inert={Boolean(
              activeRecord ||
                renameTarget ||
                confirmRemoveDamaged ||
                recoverySetup,
            )}
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
            inert={Boolean(
              activeRecord ||
                renameTarget ||
                confirmRemoveDamaged ||
                recoverySetup,
            )}
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
                    <h1 ref={pageHeadingRef} tabIndex={-1}>
                      {locationTitle}
                    </h1>
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
                        maxLength={NAME_INPUT_MAX_LENGTH}
                        value={folderName}
                        onChange={(event) => setFolderName(event.target.value)}
                      />
                    </label>
                    {nameTooLong(folderName) && (
                      <p role="alert">This name is too long. Shorten it.</p>
                    )}
                    <button
                      className="button primary"
                      disabled={
                        busy ||
                        readOnly ||
                        !folderName.trim() ||
                        nameTooLong(folderName)
                      }
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
                      damaged cannot be opened or copied; save copies of the
                      others now. To make changes again, restore the myCarlos
                      data folder from a backup, or remove the damaged
                      documents.
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
                      <strong>Read-only recovery mode.</strong> Some of the
                      vault's files could not be read, and they may be newer or
                      intact, so nothing can be changed for now, including your
                      passphrase and recovery key. Your documents can still be
                      opened and saved as copies. Check that the drive holding
                      the myCarlos data folder is connected, that no other
                      program holds the folder, and that a cloud sync tool keeps
                      its files on this device, then lock and unlock again.
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
                {!readOnly && !snapshot.recoveryKeySetAtMs && (
                  <div className="purpose-note warning">
                    <Icon name="info" />
                    <span>
                      <strong>No recovery key yet.</strong> If you forget your
                      passphrase without one, the only way back in is to erase
                      the vault.
                    </span>
                    <button
                      className="button"
                      type="button"
                      disabled={busy}
                      onClick={() => setRecoverySetup({ required: false })}
                    >
                      Set up recovery key
                    </button>
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
                  unavailableLabel={
                    snapshot.recovery === "unreadableSlot"
                      ? "File unavailable"
                      : "Damaged: file missing"
                  }
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
                recoveryKeySetAtMs={snapshot.recoveryKeySetAtMs ?? null}
                onSaveBackup={saveBackup}
                onSpeedTest={() => bridge.benchmarkKdf()}
                onSetUpRecoveryKey={() => setRecoverySetup({ required: false })}
              />
            )}
          </div>

          {recoverySetup && (
            <RecoveryKeySetup
              bridge={bridge}
              initialKey={recoverySetup.initialKey}
              replacing={Boolean(snapshot.recoveryKeySetAtMs)}
              required={recoverySetup.required}
              offered={recoverySetup.offered}
              canPrint={canPrint}
              onDone={() => {
                const replaced = Boolean(snapshot.recoveryKeySetAtMs);
                const saved = replaced
                  ? "Recovery key replaced. The old one no longer works."
                  : "Recovery key saved. Keep your kit somewhere safe.";
                setRecoverySetup(null);
                setNotice("");
                void refresh().then(
                  () =>
                    setDialogResult({
                      message: saved,
                      recordId: activeRecordId,
                    }),
                  // The key is saved, but this screen still shows the vault
                  // as it was before.
                  (error: unknown) =>
                    setDialogResult({
                      message: `${saved} This screen could not be updated: ${vaultErrorMessage(error)}`,
                      recordId: activeRecordId,
                    }),
                );
                focusPageIfLost();
              }}
              onClose={(keyShown) => {
                const offered = recoverySetup.offered;
                setRecoverySetup(null);
                // An offer that was left before any key was shown: the
                // unlock's own result, which waited for the dialog.
                if (offered && !keyShown)
                  setDialogResult({
                    message: "Vault unlocked.",
                    recordId: activeRecordId,
                  });
                if (keyShown) {
                  setNotice("");
                  setDialogResult({
                    message: snapshot.recoveryKeySetAtMs
                      ? "Recovery key setup was not finished. The key you were shown does not open the vault; your earlier key still does. Destroy any kit saved or printed just now."
                      : "Recovery key setup was not finished. The key you were shown does not open the vault. Destroy any kit saved or printed just now.",
                    recordId: activeRecordId,
                  });
                }
                focusPageIfLost();
              }}
              onLocked={() => void onLock()}
            />
          )}
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
              unreadable={snapshot.recovery === "unreadableSlot"}
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
              title={`Permanently remove ${damagedCount} damaged document${damagedCount === 1 ? "" : "s"}?`}
              confirmLabel="Permanently remove"
              danger
              onConfirm={removeDamaged}
              onCancel={() => setConfirmRemoveDamaged(false)}
            >
              <ul
                className="native-confirm-list"
                aria-label="Documents to remove"
              >
                {damaged.map((record) => (
                  <li key={record.id}>
                    {record.displayName}
                    {snapshot.profiles.length > 1 &&
                      ` (${profileName(record.profileId)})`}
                  </li>
                ))}
              </ul>
              <p>
                Their encrypted files are missing from this device, so their
                content is already gone from here. Removing them also deletes
                their names and details from the vault, permanently. This cannot
                be undone.
              </p>
              <p>
                First check that the files are not just out of reach: if the
                myCarlos data folder is on a drive that is disconnected, or
                another program is using it, fix that, then lock and unlock
                again. If you have a backup of the data folder, restore it
                first: any file that comes back is kept.
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

import { LibrarySidebar, personFolderName } from "./LibrarySidebar";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Icon } from "../Icon";
import { useI18n } from "../i18n";
import {
  isWrongPdfPassword,
  localDateText,
  namedDamage,
  type BoxKey,
  type SavedBackup,
  type VaultBridge,
  type VaultFolder,
  type VaultRecord,
  type VaultSnapshot,
} from "../vault";
import { RenameDialog, type RenameTarget } from "./RenameDialog";
import { HiddenDocuments } from "./HiddenDocuments";
import { UnlockPdfDialog } from "./UnlockPdfDialog";
import {
  RecoveryKeySetup,
  type OpeningRecoverySetup,
} from "./RecoveryKeySetup";
import { ConfirmDialog } from "./ConfirmDialog";
import { PreferencesSettings } from "./PreferencesSettings";
import { SecuritySettings } from "./SecuritySettings";
import { RecordDetails } from "./RecordDetails";
import { DocumentReader } from "./DocumentReader";
import { MoveTargetSelect, parseMoveTarget } from "./MoveTargetSelect";
import { CameraDialog } from "./CameraDialog";
import { PhotoViewer } from "./PhotoViewer";
import { namedAsPdf, photoName } from "./photo";
import { LibraryItems } from "./LibraryItems";
import {
  NAME_INPUT_MAX_LENGTH,
  nameTooLong,
  searchKey,
} from "./recordPresentation";
import { useVaultDragDrop, type DragItem } from "./useVaultDragDrop";
import { folderPath, folderSubtree, recordPath } from "./folderTree";
import { ANNOUNCE_DELAY_MS } from "./announce";
import { useLibraryFocus } from "./useLibraryFocus";
import type { UnfinishedRecoveryKey } from "./unfinishedRecoveryKey";
import {
  OLD_BACKUPS_EXPOSED,
  OLD_BACKUPS_KEEP,
  OLD_BACKUPS_ROUTINE,
  readOldBackupsGuide,
  rememberOldBackupsGuide,
  type OldBackupsGuide,
} from "./oldBackups";

type NativeSection =
  | "records"
  | "shared"
  | "hidden"
  | "security"
  | "preferences";
/** The phone's tabs. Records holds the people and Shared with me, as the
 * sidebar's top-level folders do on a computer (Ben, 21 Oct). */
const PHONE_TABS: ReadonlyArray<[NativeSection, string]> = [
  ["records", "Records"],
  ["hidden", "Hidden"],
  ["security", "Security"],
  ["preferences", "Preferences"],
];

/** The people a vault keeps records for: every profile but Shared with me's
 * (#61). */
const peopleOf = (snapshot: VaultSnapshot) =>
  snapshot.profiles.filter(
    (profile) => profile.id !== snapshot.sharedProfileId,
  );
type NativeView = "list" | "grid";
type NativeSort = "newest" | "name";
const SORT_CHOICES: ReadonlyArray<[NativeSort, string]> = [
  ["newest", "Newest first"],
  ["name", "Name A–Z"],
];

export function VaultLibrary({
  bridge,
  snapshot,
  busy,
  notice,
  setNotice,
  run,
  refresh,
  onLock,
  onRequestLock,
  autoLockMinutes,
  onAutoLockMinutes,
  openingRecoverySetup = null,
  onOpeningRecoverySetupShown,
  onUnfinishedRecoveryKey,
  canPrint = false,
  keyboardHints = true,
  computer = true,
  sizesIn1024s = false,
  covered = false,
  cameraPlatform = null,
  cameraAsking,
  sharedNew = 0,
  onSharedSeen,
}: {
  bridge: VaultBridge;
  snapshot: VaultSnapshot;
  busy: boolean;
  notice: string;
  setNotice: (value: string) => void;
  /** Runs a vault operation; `boxes` names what was typed for it. */
  run: (operation: () => Promise<void>, boxes?: BoxKey[]) => Promise<void>;
  /** Reloads the snapshot and resolves to it, so a caller can report the
   * state it produced rather than the state it hoped for. */
  /** Shows the vault as it is now: `known` if a command just returned it,
   * or as the native side says. */
  refresh: (known?: VaultSnapshot) => Promise<VaultSnapshot>;
  onLock: () => Promise<void>;
  onRequestLock?: () => void;
  autoLockMinutes: number;
  onAutoLockMinutes: (value: unknown) => void;
  /** What the library opens on, when it opens on the recovery key setup: a
   * new vault's key, to set up first, or the offer of one at unlock. */
  openingRecoverySetup?: OpeningRecoverySetup | null;
  onOpeningRecoverySetupShown?: () => void;
  /** Whether a recovery key setup has shown a key and not ended: a lock then
   * ends it, and the patient is told after the next unlock. */
  onUnfinishedRecoveryKey?: (unfinished: UnfinishedRecoveryKey | null) => void;
  /** Whether this platform can print the recovery kit. */
  canPrint?: boolean;
  /** Whether to show keyboard-only instructions (Tab, Escape): false on
   * phones and tablets. */
  keyboardHints?: boolean;
  /** On a computer, not a phone: shared files come by being opened with
   * myCarlos there, not from another app's Share. */
  computer?: boolean;
  /** Whether this platform's file app counts sizes in 1024s (Windows). */
  sizesIn1024s?: boolean;
  /** A dialog of the app's own is over the library (the warning before the
   * automatic lock, #68): the library and any dialog in it are inert. */
  covered?: boolean;
  /** The platform the camera dialog runs on (a computer, or since D97 a
   * phone), or null where photos cannot be taken. */
  cameraPlatform?: string | null;
  /** On a phone: holds the lock on a hidden app while the system asks
   * whether myCarlos may use the camera (see CameraDialog). */
  cameraAsking?: <T>(question: Promise<T>) => Promise<T>;
  /** Files added to Shared with me since the vault was unlocked, until the
   * patient opens it (#61). */
  sharedNew?: number;
  /** The patient opened Shared with me: its new files have been seen. */
  onSharedSeen?: () => void;
}) {
  const { t } = useI18n();
  const [profileId, setProfileId] = useState(
    () => peopleOf(snapshot)[0]?.id ?? "",
  );
  const [section, setSection] = useState<NativeSection>("records");
  // Keep Hidden scoped to the location it was opened from, including Shared.
  const [hiddenProfileId, setHiddenProfileId] = useState<string | null>(null);
  // The steps for older backups after a key whose kit may have been lost or
  // seen was replaced: kept across locks, until the patient says done.
  const [oldBackupsGuide, setOldBackupsGuideState] =
    useState<OldBackupsGuide | null>(readOldBackupsGuide);
  const setOldBackupsGuide = (guide: OldBackupsGuide | null) => {
    rememberOldBackupsGuide(guide);
    setOldBackupsGuideState(guide);
  };
  // Gone once the vault locks: what a reply that comes later would show is
  // then not seen.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Only a change made in the search box requests an announcement. Folder
  // and person changes also clear the query, but must not announce that reset.
  const [searchRequest, setSearchRequest] = useState<{
    query: string;
    location: string;
  } | null>(null);
  const [searchAnnouncement, setSearchAnnouncement] = useState("");
  const announcedSearchRef = useRef(searchRequest);
  const [view, setView] = useState<NativeView>("list");
  const [sort, setSort] = useState<NativeSort>("newest");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [moveFolderId, setMoveFolderId] = useState("");
  // Where the selected documents in Shared with me go: "<person>|<folder>".
  const [sharedTarget, setSharedTarget] = useState("");
  const [activeRecordId, setActiveRecordId] = useState<string | null>(null);
  const activeRecordIdRef = useRef(activeRecordId);
  activeRecordIdRef.current = activeRecordId;
  // The document open in the reader, if any.
  const [readerRecordId, setReaderRecordId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  // The open document, when its file is a photo, and the photo while it is
  // shown: it is fetched for the photo view and dropped when that closes.
  const [photoRecordId, setPhotoRecordId] = useState<string | null>(null);
  const [shownPhoto, setShownPhoto] = useState<{
    recordId: string;
    url: string;
  } | null>(null);
  // The result of a dialog's action (a rename, a recovery key), given once the
  // dialog has closed (see the effect below), and the document whose details
  // it was started from, if any.
  const [dialogResult, setDialogResult] = useState<{
    message: string;
    recordId: string | null;
  } | null>(null);
  // Bound to one record so a stale prompt can never apply to a different document.
  const [confirmation, setConfirmation] = useState<{
    action: "export";
    recordId: string;
  } | null>(null);
  const [confirmHideDamaged, setConfirmHideDamaged] = useState(false);
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
  // Shared with me is a reserved profile, shown as a folder (#61): with one
  // person, inside their records; with several, outside everyone's.
  const people = useMemo(() => peopleOf(snapshot), [snapshot]);
  const sharedProfileId = snapshot.sharedProfileId;
  // Everything the people hold, for the sidebar's tree: not Shared with me's.
  const peopleFolders = useMemo(
    () =>
      snapshot.folders.filter((folder) => folder.profileId !== sharedProfileId),
    [snapshot.folders, sharedProfileId],
  );
  const peopleRecords = useMemo(
    () =>
      snapshot.records.filter(
        (record) => record.profileId !== sharedProfileId && !record.hidden,
      ),
    [snapshot.records, sharedProfileId],
  );
  const inShared = section === "shared";
  const profile =
    people.find((candidate) => candidate.id === profileId) ?? people[0];
  const folders = useMemo(
    () => snapshot.folders.filter((folder) => folder.profileId === profileId),
    [snapshot.folders, profileId],
  );
  // The documents where the patient is: a person's, or Shared with me's.
  const locationProfileId = inShared ? sharedProfileId : profileId;
  const hiddenLocationProfileId =
    section === "hidden" ? (hiddenProfileId ?? profileId) : locationProfileId;
  const openHidden = () => {
    if (section === "hidden") return;
    setHiddenProfileId(locationProfileId ?? profileId);
    setSection("hidden");
  };
  const records = useMemo(
    () =>
      snapshot.records.filter(
        (record) => record.profileId === locationProfileId && !record.hidden,
      ),
    [snapshot.records, locationProfileId],
  );
  const hiddenRecords = useMemo(
    () =>
      snapshot.records.filter(
        (record) =>
          record.profileId === hiddenLocationProfileId && record.hidden,
      ),
    [snapshot.records, hiddenLocationProfileId],
  );
  // Where a document can go: each person's records and folders.
  const moveTargets = useMemo(
    () =>
      people.map((person) => ({
        profileId: person.id,
        name: person.displayName,
        folders: snapshot.folders
          .filter((folder) => folder.profileId === person.id)
          .sort((left, right) => left.name.localeCompare(right.name)),
      })),
    [people, snapshot.folders],
  );
  const currentFolder =
    folders.find((folder) => folder.id === currentFolderId) ?? null;
  const folderById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );
  const folderNameById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders],
  );
  const normalizedQuery = searchKey(query.trim());
  // A search covers the open folder and every folder beneath it; from the top
  // level (null), the whole profile. Without one, only what is directly in
  // the open folder is shown.
  const searchScope = useMemo(
    () =>
      !inShared && normalizedQuery && currentFolderId
        ? folderSubtree(folders, currentFolderId)
        : null,
    [currentFolderId, folders, inShared, normalizedQuery],
  );
  const visibleFolders = useMemo(
    () =>
      (inShared ? [] : folders)
        .filter((folder) =>
          normalizedQuery
            ? folder.id !== currentFolderId &&
              (!searchScope || searchScope.has(folder.id)) &&
              searchKey(folder.name).includes(normalizedQuery)
            : folder.parentId === currentFolderId,
        )
        .sort(
          (left, right) =>
            left.name.localeCompare(right.name) ||
            folderPath(folderById, left.parentId).localeCompare(
              folderPath(folderById, right.parentId),
            ),
        ),
    [
      currentFolderId,
      folderById,
      folders,
      inShared,
      normalizedQuery,
      searchScope,
    ],
  );
  // One entry per document, however many folders it is filed in.
  const visibleRecords = useMemo(() => {
    const matching = records.filter((record) => {
      if (normalizedQuery)
        return (
          (!searchScope ||
            record.folderIds.some((id) => searchScope.has(id))) &&
          searchKey(record.displayName).includes(normalizedQuery)
        );
      return currentFolderId
        ? record.folderIds.includes(currentFolderId)
        : record.folderIds.length === 0;
    });
    return matching.sort((left, right) =>
      sort === "name"
        ? left.displayName.localeCompare(right.displayName)
        : right.importedAtMs - left.importedAtMs,
    );
  }, [currentFolderId, normalizedQuery, records, searchScope, sort]);
  const selectedRecords = records.filter((record) =>
    selectedIds.includes(record.id),
  );
  const activeRecord =
    records.find((record) => record.id === activeRecordId) ?? null;
  const readerRecord =
    records.find((record) => record.id === readerRecordId) ?? null;
  const pendingAction =
    activeRecord && confirmation?.recordId === activeRecord.id
      ? confirmation.action
      : null;
  const readOnly = snapshot.recovery !== null;
  const searchLocation = `${section}:${profileId}:${currentFolderId ?? ""}`;
  const searchBlocked = Boolean(
    covered ||
      busy ||
      activeRecord ||
      readerRecordId ||
      shownPhoto ||
      renameTarget ||
      cameraOpen ||
      confirmHideDamaged ||
      recoverySetup ||
      (section !== "records" && !inShared),
  );
  useEffect(() => {
    // Empty the existing live region while typing so even another search
    // with the same result count produces a fresh, atomic announcement.
    setSearchAnnouncement("");
    if (!searchRequest) return;
    if (
      searchBlocked ||
      searchRequest.location !== searchLocation ||
      searchRequest.query !== query
    ) {
      setSearchRequest(null);
      return;
    }
    // Once clearing has been announced, later imports must not repeat it.
    if (!normalizedQuery && announcedSearchRef.current === searchRequest)
      return;
    const timer = window.setTimeout(() => {
      announcedSearchRef.current = searchRequest;
      setSearchAnnouncement(
        normalizedQuery && !visibleFolders.length && !visibleRecords.length
          ? t("library.noMatch.title")
          : t(
              normalizedQuery
                ? "library.search.results"
                : "library.search.cleared",
              {
                folders: visibleFolders.length,
                documents: visibleRecords.length,
              },
            ),
      );
    }, 500);
    return () => window.clearTimeout(timer);
  }, [
    query,
    normalizedQuery,
    searchRequest,
    searchLocation,
    searchBlocked,
    visibleFolders.length,
    visibleRecords.length,
    t,
  ]);

  useEffect(() => {
    if (profile && profile.id !== profileId) setProfileId(profile.id);
  }, [profile, profileId]);

  // A document whose file is a JPEG can be viewed as a photo. The vault
  // decides from the file's first bytes, whatever its name, so it is asked
  // when the document's details open (it reads only those bytes); a PDF is
  // not asked about. The photo itself is fetched only for the photo view.
  const photoCandidate =
    activeRecord?.available && !namedAsPdf(activeRecord.displayName)
      ? activeRecord.id
      : null;
  useEffect(() => {
    setPhotoRecordId(null);
    setShownPhoto(null);
    if (!photoCandidate) return;
    let current = true;
    bridge.isPhoto(photoCandidate).then(
      (photo) => {
        if (current && photo) setPhotoRecordId(photoCandidate);
      },
      // No longer readable: the details say what they can.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [bridge, photoCandidate]);
  // A PDF that may be locked with a password can be unlocked from its details
  // (#54). The vault scans the file's PDF names only, when the details open.
  const lockedCandidate =
    activeRecord?.available && namedAsPdf(activeRecord.displayName)
      ? activeRecord.id
      : null;
  const [lockedPdfId, setLockedPdfId] = useState<string | null>(null);
  useEffect(() => {
    setLockedPdfId(null);
    if (!lockedCandidate) return;
    let current = true;
    bridge.isLockedPdf(lockedCandidate).then(
      (locked) => {
        if (current && locked) setLockedPdfId(lockedCandidate);
      },
      // No longer readable: the details say what they can.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [bridge, lockedCandidate]);
  // The password dialog stays open after a wrong password, and says so.
  const [unlocking, setUnlocking] = useState<{
    recordId: string;
    name: string;
    wrongTries: number;
  } | null>(null);
  const unlockPdf = (password: string) => {
    if (!unlocking) return;
    const { recordId, name } = unlocking;
    void run(async () => {
      try {
        const unlocked = await bridge.unlockPdf(recordId, password);
        setUnlocking(null);
        await refresh();
        // The details show the copy, which opens without the password.
        setActiveRecordId(unlocked.recordId);
        setNotice(
          `${name} unlocked. The locked original is kept as ${unlocked.originalName}.`,
        );
      } catch (failure) {
        if (isWrongPdfPassword(failure)) {
          setUnlocking(
            (current) =>
              current && { ...current, wrongTries: current.wrongTries + 1 },
          );
          return;
        }
        setUnlocking(null);
        throw failure;
      }
    });
  };
  const viewPhoto = (recordId: string) =>
    run(async () => {
      const url = await bridge.viewPhoto(recordId);
      setShownPhoto({ recordId, url });
    });

  // A folder opened from another person's tree in the sidebar: the person
  // changes first, and this effect then opens that folder, not their top.
  const openingFolderRef = useRef<string | null>(null);
  useEffect(() => {
    setCurrentFolderId(openingFolderRef.current);
    openingFolderRef.current = null;
    setSelectedIds([]);
    setQuery("");
    // Folder ids belong to one profile. A kept id would no longer match any
    // option, so the select would show "My records" while sending the old id.
    setMoveFolderId("");
    setFolderToMoveId("");
    setFolderDestinationId("");
  }, [profileId]);
  /** Opens a person's top-level folder, or one of their folders. */
  const openPerson = (person: string, folderId: string | null = null) => {
    setSection("records");
    if (person === profileId) {
      setCurrentFolderId(folderId);
      return;
    }
    openingFolderRef.current = folderId;
    setProfileId(person);
  };

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
  const libraryRef = useRef<HTMLDivElement | null>(null);
  useLibraryFocus(
    libraryRef,
    pageHeadingRef,
    Boolean(
      busy ||
        covered ||
        activeRecord ||
        readerRecordId ||
        shownPhoto ||
        renameTarget ||
        cameraOpen ||
        confirmation ||
        confirmHideDamaged ||
        recoverySetup,
    ),
    `${section}:${profileId}:${currentFolderId ?? ""}`,
  );
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
      cameraOpen ||
      shownPhoto ||
      confirmation ||
      confirmHideDamaged ||
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
    confirmHideDamaged,
    notice,
    dialogResult,
    recoverySetup,
    renameTarget,
    cameraOpen,
    shownPhoto,
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

  // A shared file an add refused as not a PDF, marked in the list.
  // Said politely when files are added to Shared with me (#61).
  const [sharedAnnouncement, setSharedAnnouncement] = useState("");
  const sharedSeen = useRef(0);
  useEffect(() => {
    const added = sharedNew - sharedSeen.current;
    if (added > 0)
      setSharedAnnouncement(
        added === 1
          ? "A shared file was added to Shared with me."
          : `${added} shared files were added to Shared with me.`,
      );
    sharedSeen.current = sharedNew;
  }, [sharedNew]);
  // Seen as soon as Shared with me is open.
  useEffect(() => {
    if (inShared && sharedNew > 0) onSharedSeen?.();
  }, [inShared, onSharedSeen, sharedNew]);

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

  // Saved into the folder that is open, as an import is. The details of the
  // new document open, so that it can be renamed at once.
  const savePhoto = (jpeg: Uint8Array) =>
    run(async () => {
      const folderIds = currentFolderId ? [currentFolderId] : [];
      const outcome = await bridge.savePhoto(
        profileId,
        folderIds,
        photoName(new Date()),
        jpeg,
      );
      const next = await refresh();
      setCameraOpen(false);
      const saved = next.records.find(
        (record) => record.id === outcome.imported[0],
      );
      if (!saved) {
        setNotice(
          "This photo is already in the vault, so it was not saved again.",
        );
        return;
      }
      setActiveRecordId(saved.id);
      // Cleared now, so that the result is a change even when it repeats.
      setNotice("");
      setDialogResult({
        message: `Photo saved as ${saved.displayName}.`,
        recordId: saved.id,
      });
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

  const moveItem = (
    item: DragItem,
    folderId: string | null,
    toProfileId = profileId,
  ) => {
    if (item.kind === "records" && (inShared || toProfileId !== profileId)) {
      moveToPerson(item.ids, toProfileId, folderId);
      return;
    }
    // Folders stay with their person; documents can move between people.
    if (toProfileId !== profileId) {
      setNotice(
        "Folders stay with their person. Move individual documents to another person instead.",
      );
      return;
    }
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
      // Named by the patient's own date, not the UTC one.
      const pickId = await bridge.pickBackupDestination(
        localDateText(new Date()),
      );
      if (!pickId) {
        setNotice("No location chosen. Nothing changed.");
        return;
      }
      let saved: SavedBackup | undefined;
      try {
        saved = await bridge.saveBackupToPicked(pickId);
      } catch (error) {
        // On Android the steps may name no file, and this save may have been
        // over the one they say to keep, now emptied: a new backup comes
        // first again. (A save to a path leaves nothing when it fails.)
        if (oldBackupsGuide?.step === "delete" && oldBackupsGuide.keep === null)
          setOldBackupsGuide({ step: "save" });
        throw namedDamage(error, snapshot);
      }
      // After a key replacement, the file written last is the one to keep,
      // named, or when the platform gives no name, by when it was saved.
      // Its size tells it from an empty or partial file.
      if (oldBackupsGuide) {
        setOldBackupsGuide({
          step: "delete",
          keep: saved?.name ?? null,
          savedAtMs: Date.now(),
          bytes: saved?.bytes ?? null,
        });
        setNotice(
          "Encrypted backup saved. This is your new backup: keep it, or a copy of it, somewhere other than this device. Security now shows which older ones to delete.",
        );
        return;
      }
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
  const damaged = snapshot.records.filter(
    (record) => !record.available && record.hidden?.reason !== "damaged",
  );
  const damagedIds = damaged.map((record) => record.id);
  const damagedCount = damagedIds.length;
  const profileName = (id: string) =>
    snapshot.profiles.find((candidate) => candidate.id === id)?.displayName ??
    "";
  const hideDamaged = () => {
    setConfirmHideDamaged(false);
    void run(async () => {
      let removed: string[];
      try {
        // The vault removes only what this screen showed as damaged.
        removed = await bridge.hideUnavailableRecords(damagedIds);
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
          ? "Every file is back on this device. Nothing was hidden."
          : `${removed.length} damaged document${removed.length === 1 ? "" : "s"} hidden. ${removed.length === 1 ? "It is" : "They are"} listed under Hidden.`;
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

  // Nothing is ever deleted (#71): a document is hidden, and can be
  // restored from Hidden. Taking it out of view needs no confirmation.
  const hideRecord = (record: VaultRecord) => {
    void run(async () => {
      await bridge.hideRecord(record.id);
      setActiveRecordId(null);
      setSelectedIds((current) => current.filter((id) => id !== record.id));
      await refresh();
      setNotice(
        `${record.displayName} was hidden. It is listed under Hidden, where you can restore it.`,
      );
    });
  };
  const unhideRecord = (record: VaultRecord) => {
    void run(async () => {
      await bridge.unhideRecord(record.id);
      await refresh();
      setNotice(`${record.displayName} was restored to where it was.`);
    });
  };

  const changePassphrase = (current: string, replacement: string) =>
    run(async () => {
      await bridge.changePassphrase(current, replacement);
      await refresh();
      setNotice("Passphrase changed.");
    }, ["box.currentPassphrase", "box.newPassphrase"]);
  const createProfile = async (name: string) => {
    let created = false;
    await run(async () => {
      await bridge.createProfile(name);
      created = true;
      await refresh();
      setNotice(`${name} was added.`);
    }, ["box.profileName"]);
    return created;
  };
  /** Moves documents to another person, into one of their folders or none.
   * One the person already has stays where it is. */
  const moveToPerson = (
    ids: string[],
    toProfileId: string,
    folderId: string | null,
  ) =>
    void run(async () => {
      const names = new Map(
        records.map((record) => [record.id, record.displayName]),
      );
      const outcome = await bridge.moveToPerson(
        ids,
        toProfileId,
        folderId ? [folderId] : [],
      );
      const folder = snapshot.folders.find(
        (candidate) => candidate.id === folderId,
      );
      const theirs =
        people.length > 1
          ? `${profileName(toProfileId)}'s records`
          : "My records";
      const where = folder ? `${theirs}, folder ${folder.name}` : theirs;
      const source = inShared
        ? "Shared with me"
        : `${profileName(profileId)}'s records`;
      if (outcome.moved.includes(activeRecordId ?? "")) setActiveRecordId(null);
      setSelectedIds((current) =>
        current.filter((id) => !outcome.moved.includes(id)),
      );
      await refresh();
      const said = [
        outcome.moved.length === 1
          ? `${names.get(outcome.moved[0]) ?? "The document"} moved to ${where}.`
          : outcome.moved.length > 1
            ? `${outcome.moved.length} documents moved to ${where}.`
            : "",
        ...outcome.alreadyThere.map(
          (name) =>
            `${name} was already in ${theirs}, so it stayed in ${source}.`,
        ),
      ];
      setNotice(said.filter(Boolean).join(" "));
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
    }, ["box.folderName"]);
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
  const rootLocationTitle = inShared
    ? "Shared with me"
    : profile
      ? personFolderName(profile, people)
      : "My records";
  const locationTitle = inShared
    ? rootLocationTitle
    : (currentFolder?.name ?? rootLocationTitle);
  const searchLabel = inShared
    ? "Search Shared with me"
    : currentFolder
      ? "Search this folder and its subfolders"
      : `Search everything in ${rootLocationTitle}`;

  return (
    <div
      ref={libraryRef}
      className="evaluation-page native-vault-page"
      inert={covered}
    >
      {/* Polite, but not a second status line: the library has one. */}
      <p className="sr-only" aria-live="polite">
        {sharedAnnouncement}
      </p>
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
                cameraOpen ||
                confirmHideDamaged ||
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

          {/* On narrow windows, where the sidebar is hidden: a row of
              tabs instead of a dropdown (#67). */}
          <nav
            className="mobile-section-picker native-section-tabs"
            aria-label="Section"
            inert={Boolean(
              activeRecord ||
                renameTarget ||
                cameraOpen ||
                confirmHideDamaged ||
                recoverySetup,
            )}
          >
            {PHONE_TABS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-current={
                  section === value || (value === "records" && inShared)
                    ? "page"
                    : undefined
                }
                onClick={() =>
                  value === "hidden" ? openHidden() : setSection(value)
                }
              >
                {value === "records" && sharedNew
                  ? `${label} (${sharedNew} new)`
                  : label}
              </button>
            ))}
          </nav>

          <div
            className="app-body"
            inert={Boolean(
              activeRecord ||
                renameTarget ||
                cameraOpen ||
                confirmHideDamaged ||
                recoverySetup,
            )}
          >
            <LibrarySidebar
              profileName={
                (!inShared &&
                  !(
                    section === "hidden" &&
                    hiddenLocationProfileId === sharedProfileId
                  ) &&
                  profile?.displayName) ||
                "Private vault"
              }
              people={people}
              profileId={profileId}
              section={section}
              currentFolderId={currentFolderId}
              folders={peopleFolders}
              records={peopleRecords}
              disabled={busy || readOnly}
              drag={drag}
              hiddenCount={hiddenRecords.length}
              hiddenFromShared={
                section === "hidden" &&
                hiddenLocationProfileId === sharedProfileId
              }
              onOpenPerson={openPerson}
              onOpenFolder={(person, folderId) => openPerson(person, folderId)}
              sharedNew={sharedNew}
              vaultTotals={{
                documents: snapshot.records.filter((record) => !record.hidden)
                  .length,
                folders: snapshot.folders.length,
              }}
              onOpenShared={() => {
                setSection("shared");
                setCurrentFolderId(null);
              }}
              onOpenHidden={openHidden}
              onOpenSecurity={() => setSection("security")}
              onOpenPreferences={() => setSection("preferences")}
            />

            {(section === "records" || inShared) && (
              <main
                className={dropClass(
                  "library-main",
                  `pane:${currentFolderId ?? "root"}`,
                )}
                // Shared with me and recursive search results take no pane
                // drops: dropping where a drag began must not move the file.
                onDragOver={
                  inShared || normalizedQuery
                    ? undefined
                    : (event) =>
                        dragOver(event, `pane:${currentFolderId ?? "root"}`)
                }
                onDrop={
                  inShared || normalizedQuery
                    ? undefined
                    : (event) => dropInto(event, currentFolderId)
                }
              >
                <p
                  className="sr-only"
                  aria-live="polite"
                  aria-atomic="true"
                  data-search-status
                >
                  {searchAnnouncement}
                </p>
                <div className="native-profile-row">
                  {/* Shared with me is no one's: no person's path above it. */}
                  {inShared ? (
                    <strong>Shared with me</strong>
                  ) : (
                    <>
                      <button
                        className={dropClass(
                          "breadcrumb native-breadcrumb",
                          "breadcrumb:root",
                        )}
                        type="button"
                        onDragOver={(event) =>
                          dragOver(event, "breadcrumb:root")
                        }
                        onDrop={(event) => dropInto(event, null)}
                        onClick={() => {
                          setSection("records");
                          setCurrentFolderId(null);
                        }}
                      >
                        {profile ? personFolderName(profile, people) : ""}
                      </button>
                      {currentFolder && (
                        <>
                          <span aria-hidden="true">›</span>
                          <strong>{currentFolder.name}</strong>
                        </>
                      )}
                    </>
                  )}
                  {/* On a phone, where the sidebar is hidden: the same
                      top-level folders, the people and Shared with me. */}
                  <nav
                    className="native-top-level-narrow"
                    aria-label="Record library"
                  >
                    {people.map((person) => (
                      <button
                        key={person.id}
                        className="button"
                        type="button"
                        aria-current={
                          !inShared && person.id === profileId
                            ? "page"
                            : undefined
                        }
                        onClick={() => openPerson(person.id)}
                      >
                        <Icon name="folder" />{" "}
                        {personFolderName(person, people)}
                      </button>
                    ))}
                    <button
                      className="button"
                      type="button"
                      aria-current={inShared ? "page" : undefined}
                      onClick={() => {
                        setSection("shared");
                        setCurrentFolderId(null);
                      }}
                    >
                      <Icon name="letter" /> Shared with me
                      {sharedNew > 0 && ` (${sharedNew} new)`}
                    </button>
                  </nav>
                </div>
                <div className="main-head">
                  <div>
                    <h1 ref={pageHeadingRef} tabIndex={-1}>
                      {locationTitle}
                    </h1>
                    <p>
                      {inShared
                        ? `${visibleRecords.length} documents${normalizedQuery ? " found" : ""}`
                        : `${visibleFolders.length} folders · ${visibleRecords.length} documents ${normalizedQuery ? "found" : "in this location"}`}
                    </p>
                  </div>
                  {/* Shared with me is one fixed folder: files arrive in it
                      by themselves, and nothing else is made in it. */}
                  {!inShared && (
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
                      {cameraPlatform && (
                        <button
                          className="button"
                          type="button"
                          disabled={busy || readOnly || !profileId}
                          onClick={() => {
                            // The camera window shows the library's notice for
                            // a save's result: the one before it, such as
                            // "Vault unlocked.", is not about the photo.
                            setNotice("");
                            setCameraOpen(true);
                          }}
                        >
                          <Icon name="camera" />
                          <span>Take a photo</span>
                        </button>
                      )}
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
                  )}
                </div>

                {inShared && (
                  <p className="purpose-note native-shared-intro">
                    <Icon name="info" />
                    <span>
                      {computer
                        ? "Files you open with myCarlos arrive here, encrypted."
                        : "Files you share to myCarlos from another app arrive here, encrypted."}{" "}
                      {people.length > 1
                        ? "They are in no one's records until you move each one to the person it is for."
                        : "Move them into your folders whenever you like."}
                    </span>
                  </p>
                )}

                {showFolderForm && !inShared && (
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

                {folders.length > 0 && !inShared && (
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
                      <strong>Changes are paused.</strong> Some encrypted files
                      are missing from this device. Documents marked damaged
                      cannot be opened or copied; save copies of the others now.
                      To make changes again, restore the myCarlos data folder
                      from a backup, or hide the damaged documents.
                    </span>
                    <button
                      className="button"
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmHideDamaged(true)}
                    >
                      Hide damaged documents
                    </button>
                  </div>
                )}
                {snapshot.recovery === "unreadableSlot" && (
                  <div className="purpose-note warning" role="alert">
                    <Icon name="info" />
                    <span>
                      <strong>Changes are paused.</strong> Some of the vault's
                      files could not be read, and they may be newer or intact,
                      so nothing can be changed for now, including your
                      passphrase and recovery key. Your documents can still be
                      opened and saved as copies, except any marked “File
                      unavailable”. Check that the drive holding the myCarlos
                      data folder is connected, that no other program holds the
                      folder, and that a cloud sync tool keeps its files on this
                      device, then lock and unlock again.
                    </span>
                  </div>
                )}
                {snapshot.recovery === "writeFailed" && (
                  <div className="purpose-note warning" role="alert">
                    <Icon name="info" />
                    <span>
                      <strong>Changes are paused.</strong> myCarlos could not
                      save a change to this computer. Free up storage or check
                      the disk, then lock and unlock again; the vault repairs
                      itself when it can write.
                    </span>
                  </div>
                )}
                {!readOnly && !snapshot.recoveryKeySetAtMs && (
                  <div className="purpose-note warning">
                    <Icon name="info" />
                    <span>
                      <strong>No recovery key yet.</strong> If you forget your
                      passphrase without one, the only way back in is to set the
                      vault aside and start again.
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
                  <span className="sr-only">{searchLabel}</span>
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => {
                      const value = event.target.value;
                      setQuery(value);
                      setSearchRequest(
                        value.trim() || query.trim()
                          ? { query: value, location: searchLocation }
                          : null,
                      );
                    }}
                    placeholder={searchLabel}
                  />
                </label>
                <div className="viewbar">
                  <span className="native-location-chip">
                    {currentFolder ? "Inside folder" : "Top level"}
                  </span>
                  <span className="native-drag-hint">
                    Hold and drag a document or folder to move it, or open it
                    and choose Move to.
                  </span>
                  <div className="view-controls">
                    {/* Both choices in view, with words (#67). */}
                    <fieldset className="native-sort-choice">
                      <legend>Sort by</legend>
                      {SORT_CHOICES.map(([value, label]) => (
                        <label key={value}>
                          <input
                            type="radio"
                            name="native-sort"
                            value={value}
                            checked={sort === value}
                            onChange={() => setSort(value)}
                          />
                          {label}
                        </label>
                      ))}
                    </fieldset>
                    <span
                      className="segment native-view-segment"
                      aria-label="Choose record view"
                    >
                      <button
                        className={view === "list" ? "selected" : ""}
                        type="button"
                        aria-label="List view"
                        aria-pressed={view === "list"}
                        onClick={() => setView("list")}
                      >
                        <Icon name="list" /> List
                      </button>
                      <button
                        className={view === "grid" ? "selected" : ""}
                        type="button"
                        aria-label="Grid view"
                        aria-pressed={view === "grid"}
                        onClick={() => setView("grid")}
                      >
                        <Icon name="grid" /> Grid
                      </button>
                    </span>
                  </div>
                </div>

                {selectedIds.length > 0 && (
                  <div className="bulkbar" role="status">
                    <strong>{selectedIds.length} selected</strong>
                    <span>Move the selected documents.</span>
                    <div className="bulk-actions native-move-actions">
                      {inShared ? (
                        <MoveTargetSelect
                          label="Move selected to"
                          targets={moveTargets}
                          value={sharedTarget || `${profile?.id ?? ""}|`}
                          onChange={setSharedTarget}
                        />
                      ) : (
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
                      )}
                      <button
                        type="button"
                        disabled={busy || readOnly}
                        onClick={() => {
                          if (!inShared) return void moveSelected();
                          const { profileId: to, folderId } = parseMoveTarget(
                            sharedTarget || `${profile?.id ?? ""}|`,
                          );
                          moveToPerson(selectedIds, to, folderId);
                        }}
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
                  folderLocation={
                    normalizedQuery
                      ? (folder) =>
                          folderPath(
                            folderById,
                            folder.parentId,
                            rootLocationTitle,
                          )
                      : undefined
                  }
                  recordLocation={
                    normalizedQuery
                      ? (record) =>
                          recordPath(folderById, record, rootLocationTitle)
                      : undefined
                  }
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

            {section === "hidden" && (
              <HiddenDocuments
                records={hiddenRecords}
                rootName={
                  hiddenLocationProfileId === sharedProfileId
                    ? "Shared with me"
                    : "My records"
                }
                folderNameById={folderNameById}
                busy={busy}
                readOnly={readOnly}
                notice={notice}
                onRestore={unhideRecord}
              />
            )}

            {section === "preferences" && <PreferencesSettings />}

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
                recoveryKeySetAtMs={snapshot.recoveryKeySetAtMs ?? null}
                recoveryKeyLabel={snapshot.recoveryKeyLabel ?? null}
                oldBackupsGuide={oldBackupsGuide}
                sizesIn1024s={sizesIn1024s}
                onOldBackupsGuideDone={() => setOldBackupsGuide(null)}
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
              keyboardHints={keyboardHints}
              onKeyShown={({ exposed }) =>
                onUnfinishedRecoveryKey?.({
                  setAtMs: snapshot.recoveryKeySetAtMs ?? null,
                  ...(exposed && { exposed }),
                })
              }
              onDone={(stored, { exposed }) => {
                const replaced = Boolean(snapshot.recoveryKeySetAtMs);
                // Older backups still open with the old key. Only a kit that
                // may have been lost or seen makes them worth replacing, and
                // a vault that could not finish writing the key cannot save
                // a backup: the old ones are then kept until it can.
                const backups = !exposed
                  ? OLD_BACKUPS_ROUTINE
                  : stored.recovery
                    ? OLD_BACKUPS_KEEP
                    : OLD_BACKUPS_EXPOSED;
                if (replaced && exposed) setOldBackupsGuide({ step: "save" });
                const saved = replaced
                  ? `Recovery key replaced. The old one no longer opens this vault. ${backups}`
                  : "Recovery key saved. Keep your kit somewhere safe.";
                setRecoverySetup(null);
                setNotice("");
                // The setup is finished once the patient is told so. Until
                // then a lock leaves it unfinished, and the next unlock says
                // the key was saved.
                const tell = (message: string) => {
                  if (!mountedRef.current) return;
                  onUnfinishedRecoveryKey?.(null);
                  setDialogResult({ message, recordId: activeRecordId });
                };
                // As the confirmation returned it: so that what this screen
                // shows, and the next setup's record of the key it would
                // replace, is the vault with this key.
                void refresh(stored).then(() => tell(saved));
              }}
              onClose={(keyShown) => {
                onUnfinishedRecoveryKey?.(null);
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
              }}
              onLocked={() => void onLock()}
              onLockAndLeave={onRequestLock ?? (() => void onLock())}
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
          {cameraOpen && cameraPlatform && (
            <CameraDialog
              platform={cameraPlatform}
              whileAsking={cameraAsking}
              notice={notice}
              saving={busy}
              onUse={savePhoto}
              onClose={() => setCameraOpen(false)}
            />
          )}
          {activeRecord && shownPhoto?.recordId === activeRecord.id && (
            <PhotoViewer
              name={activeRecord.displayName}
              url={shownPhoto.url}
              onClose={() => setShownPhoto(null)}
            />
          )}
          {activeRecord && unlocking?.recordId === activeRecord.id && (
            <UnlockPdfDialog
              name={unlocking.name}
              wrongTries={unlocking.wrongTries}
              busy={busy}
              onUnlock={unlockPdf}
              onCancel={() => setUnlocking(null)}
            />
          )}
          {activeRecord &&
            !renameTarget &&
            !pendingAction &&
            !shownPhoto &&
            unlocking?.recordId !== activeRecord.id && (
              <RecordDetails
                record={activeRecord}
                folders={folders}
                moveTargets={
                  inShared || people.length > 1 ? moveTargets : undefined
                }
                onMoveTo={(to, folderId) =>
                  to === activeRecord.profileId
                    ? void moveRecord(activeRecord.id, folderId)
                    : moveToPerson([activeRecord.id], to, folderId)
                }
                busy={busy}
                readOnly={readOnly}
                unreadable={snapshot.recovery === "unreadableSlot"}
                notice={notice}
                onClose={() => setActiveRecordId(null)}
                onRename={() =>
                  void run(async () => {
                    const photo =
                      !namedAsPdf(activeRecord.displayName) &&
                      (await bridge
                        .isPhoto(activeRecord.id)
                        .catch(() => false));
                    if (activeRecordIdRef.current !== activeRecord.id) return;
                    setRenameTarget({
                      kind: "document",
                      id: activeRecord.id,
                      name: activeRecord.displayName,
                      photo,
                    });
                  })
                }
                onMove={(folderId) => moveRecord(activeRecord.id, folderId)}
                onHide={() => hideRecord(activeRecord)}
                onExport={() =>
                  setConfirmation({
                    action: "export",
                    recordId: activeRecord.id,
                  })
                }
                onViewPhoto={
                  photoRecordId === activeRecord.id
                    ? () => void viewPhoto(activeRecord.id)
                    : undefined
                }
                locked={lockedPdfId === activeRecord.id}
                // Desktop only: phones cannot start the PDF helper yet.
                onUnlock={
                  lockedPdfId === activeRecord.id && computer
                    ? () =>
                        setUnlocking({
                          recordId: activeRecord.id,
                          name: activeRecord.displayName,
                          wrongTries: 0,
                        })
                    : undefined
                }
                onRead={
                  namedAsPdf(activeRecord.displayName)
                    ? () => {
                        setReaderRecordId(activeRecord.id);
                        setActiveRecordId(null);
                      }
                    : undefined
                }
              />
            )}
          {readerRecord && (
            <DocumentReader
              record={readerRecord}
              viewPage={(page, width, password) =>
                bridge.viewPage(readerRecord.id, page, width, password)
              }
              cancelView={() => void bridge.cancelView().catch(() => undefined)}
              onClose={() => setReaderRecordId(null)}
            />
          )}
          {confirmHideDamaged && (
            <ConfirmDialog
              title={`Hide ${damagedCount} damaged document${damagedCount === 1 ? "" : "s"}?`}
              confirmLabel="Hide"
              onConfirm={hideDamaged}
              onCancel={() => setConfirmHideDamaged(false)}
              details={
                // It scrolls when it is long, so it takes focus, to be
                // scrolled with the keyboard. It is not read out with the
                // dialog: the title counts the documents.
                <ul
                  className="native-confirm-list"
                  aria-label="Documents to hide"
                  tabIndex={0}
                >
                  {damaged.map((record) => (
                    <li key={record.id}>
                      {record.displayName}
                      {snapshot.profiles.length > 1 &&
                        ` (${profileName(record.profileId)})`}
                    </li>
                  ))}
                </ul>
              }
            >
              <p>
                Their encrypted files are missing from this device. Hiding them
                lets the vault take changes again. They stay listed under
                Hidden, with their names and details, and if a file comes back
                its document can be restored.
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
                myCarlos cannot erase that copy later, and hiding this record
                will not remove it.
              </p>
            </ConfirmDialog>
          )}
        </section>
      </div>
    </div>
  );
}

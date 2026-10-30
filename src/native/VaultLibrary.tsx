import {
  useTextState,
  deferredText,
  useI18n,
  t as translateNow,
  message,
  UiError,
  type UiText,
  type MessageKey,
} from "../i18n";
import type { PersonDetails } from "../vault";
import { PersonSuggestion } from "./PersonSuggestion";
import { usePersonSuggestions } from "./usePersonSuggestions";
import { LibrarySidebar, personFolderName } from "./LibrarySidebar";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Icon } from "../Icon";
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
import { AuditHistory } from "./AuditHistory";
import { UnlockPdfDialog } from "./UnlockPdfDialog";
import {
  RecoveryKeySetup,
  type OpeningRecoverySetup,
} from "./RecoveryKeySetup";
import { ConfirmDialog } from "./ConfirmDialog";
import { PreferencesSettings } from "./PreferencesSettings";
import { PortalDocuments } from "./PortalDocuments";
import { SecuritySettings } from "./SecuritySettings";
import { RecordDetails } from "./RecordDetails";
import { DocumentReader } from "./DocumentReader";
import { IphoneDocumentReader } from "./IphoneDocumentReader";
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
  | "history"
  | "security"
  | "preferences";
/** The phone's tabs. Records holds the people and Shared with me, as the
 * sidebar's top-level folders do on a computer (Ben, 21 Oct). */
const PHONE_TABS: ReadonlyArray<[NativeSection, MessageKey]> = [
  ["records", "interface.VaultLibrary.records"],
  ["security", "security.title"],
  ["preferences", "sidebar.preferences"],
];

/** The people a vault keeps records for: every profile but Shared with me's
 * (#61). */
const peopleOf = (snapshot: VaultSnapshot) =>
  snapshot.profiles.filter(
    (profile) => profile.id !== snapshot.sharedProfileId,
  );
type NativeView = "list" | "grid";
type NativeSort = "newest" | "name";
const SORT_CHOICES: ReadonlyArray<[NativeSort, MessageKey]> = [
  ["newest", "interface.VaultLibrary.newestFirst"],
  ["name", "interface.VaultLibrary.nameAZ"],
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
  iphonePdfReader = false,
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
  setNotice: (value: UiText) => void;
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
  /** iOS alone can present the native, bridge-free WebKit PDF reader. */
  iphonePdfReader?: boolean;
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
  // Keep Security’s Hidden entry scoped to the location it was opened from,
  // including Shared; returning from Hidden must retain that location.
  const [hiddenProfileId, setHiddenProfileId] = useState<string | null>(null);
  const [returnFocusToHidden, setReturnFocusToHidden] = useState(false);
  const [returnFocusToHistory, setReturnFocusToHistory] = useState(false);
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
    message: UiText;
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
    section === "hidden" || section === "security"
      ? (hiddenProfileId ?? profileId)
      : locationProfileId;
  // Conceal immediately while the app confirms the native lock. A cancelled
  // history read can be the first sign that the native idle backstop ran.
  // The parent only claims the vault is locked after native confirmation.
  const lockAndConceal = async () => {
    if (onRequestLock) onRequestLock();
    else await onLock();
  };
  const openSecurity = () => {
    // A persistent navigation button keeps focus when it opens Security.
    setReturnFocusToHidden(false);
    setReturnFocusToHistory(false);
    if (
      section !== "security" &&
      section !== "hidden" &&
      section !== "history"
    ) {
      setHiddenProfileId(locationProfileId ?? profileId);
    }
    setSection("security");
  };
  const backToSecurity = () => {
    // The Back button disappears, so return to the Hidden entry it came from.
    setReturnFocusToHidden(true);
    setReturnFocusToHistory(false);
    setSection("security");
  };
  const backFromHistoryToSecurity = () => {
    setReturnFocusToHidden(false);
    setReturnFocusToHistory(true);
    setSection("security");
  };
  const hiddenScope = people.find(
    (person) => person.id === hiddenLocationProfileId,
  );
  const hiddenScopeName =
    hiddenLocationProfileId === sharedProfileId
      ? translateNow("interface.LibrarySidebar.sharedWithMe")
      : hiddenScope
        ? personFolderName(hiddenScope, people)
        : translateNow("sidebar.myRecords");
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
  const sharedRecords = useMemo(
    () =>
      snapshot.records.filter(
        (r) => r.profileId === sharedProfileId && !r.hidden,
      ),
    [snapshot.records, sharedProfileId],
  );
  const suggestions = usePersonSuggestions(
    bridge,
    sharedRecords,
    people,
    busy ||
      readOnly ||
      !inShared ||
      (view === "grid" && !activeRecordId) ||
      Boolean(readerRecordId),
  );
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
    const { recordId } = unlocking;
    void run(async () => {
      try {
        const unlocked = await bridge.unlockPdf(recordId, password);
        setUnlocking(null);
        await refresh();
        // The details show the copy, which opens without the password.
        setActiveRecordId(unlocked.recordId);
        setNotice(
          deferredText(() =>
            translateNow("interface.notice.pdfUnlocked", {
              name: unlocked.originalName,
            }),
          ),
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
  // Library actions put focus back only after keyboard use. The recovery key
  // setup asks for it however it was closed, as its opener may be gone.
  const focusPageIfLost = useLibraryFocus(
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
      throw new UiError(
        deferredText(() =>
          readOnly
            ? translateNow("interface.VaultLibrary.theVaultIsReadonlySoTheName")
            : translateNow(
                "interface.VaultLibrary.anotherVaultOperationIsStillRunningTry",
              ),
        ),
      );
    if (renameTarget.kind === "profile") {
      await bridge.renameProfile(renameTarget.id, name);
    } else if (renameTarget.kind === "folder") {
      const folder = folders.find(
        (candidate) => candidate.id === renameTarget.id,
      );
      if (!folder)
        throw new UiError(
          deferredText(() =>
            translateNow(
              "interface.VaultLibrary.thatFolderIsNoLongerAvailable",
            ),
          ),
        );
      await bridge.updateFolder(folder.id, folder.parentId, name);
    } else {
      await bridge.renameRecord(renameTarget.id, name);
    }
    if (!mountedRef.current) return;
    await refresh();
    if (!mountedRef.current) return;
    // Cleared now, so that the result is a change even when it repeats.
    setNotice("");
    setDialogResult({
      message:
        renameTarget.kind === "profile"
          ? message("rename.profile.saved", { name })
          : message(
              renameTarget.kind === "folder"
                ? "interface.notice.renamedFolder"
                : "interface.notice.renamedDocument",
              { name },
            ),
      recordId: activeRecordId,
    });
  };

  // A shared file an add refused as not a PDF, marked in the list.
  // Said politely when files are added to Shared with me (#61).
  const [sharedAnnouncement, setSharedAnnouncement] = useTextState();
  const sharedSeen = useRef(0);
  useEffect(() => {
    const added = sharedNew - sharedSeen.current;
    if (added > 0)
      setSharedAnnouncement(
        deferredText(() =>
          translateNow("interface.notice.sharedAdded", { count: added }),
        ),
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
        setNotice(
          deferredText(() =>
            translateNow(
              "interface.VaultLibrary.noFilesSelectedNothingChanged",
            ),
          ),
        );
        return;
      }
      const outcome = await bridge.importPickedFiles(
        pickId,
        profileId,
        folderIds,
      );
      if (!outcome.imported.length && !outcome.skippedDuplicates.length) {
        setNotice(
          deferredText(() =>
            translateNow(
              "interface.VaultLibrary.noFilesSelectedNothingChanged",
            ),
          ),
        );
        return;
      }
      await refresh();
      const skipped = () =>
        outcome.skippedDuplicates.length
          ? translateNow("interface.notice.duplicates", {
              count: outcome.skippedDuplicates.length,
            })
          : "";
      setNotice(
        deferredText(
          () =>
            translateNow("interface.notice.imported", {
              count: outcome.imported.length,
            }) + (skipped() ? " " + skipped() : ""),
        ),
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
          deferredText(() =>
            translateNow("interface.VaultLibrary.thisPhotoIsAlreadyInTheVault"),
          ),
        );
        return;
      }
      setActiveRecordId(saved.id);
      // Cleared now, so that the result is a change even when it repeats.
      setNotice("");
      setDialogResult({
        message: message("interface.notice.photoSaved", {
          name: saved.displayName,
        }),
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
        deferredText(() =>
          translateNow("interface.notice.moved", {
            count: selectedRecords.length,
          }),
        ),
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
        deferredText(() =>
          translateNow(
            "interface.VaultLibrary.foldersStayWithTheirPersonMoveIndividual",
          ),
        ),
      );
      return;
    }
    if (alreadyIn(item, folderId)) return;
    void run(async () => {
      if (item.kind === "records") {
        await bridge.assignFoldersBatch(item.ids, folderId ? [folderId] : []);
        setSelectedIds([]);
        setNotice(
          deferredText(() =>
            translateNow("interface.notice.movedMany", {
              count: item.ids.length,
              where: folderId
                ? (folderNameById.get(folderId) ?? "")
                : translateNow("sidebar.myRecords"),
            }),
          ),
        );
      } else {
        const folder = folders.find((candidate) => candidate.id === item.id);
        if (!folder) {
          setNotice(
            deferredText(() =>
              translateNow(
                "interface.VaultLibrary.thatFolderIsNoLongerAvailable",
              ),
            ),
          );
          return;
        }
        // The sidebar lists every folder, so a folder can be dropped on one
        // of its own subfolders. The vault refuses that as a cycle.
        if (folderId && folderSubtree(folders, folder.id).has(folderId)) {
          setNotice(
            deferredText(() => translateNow("interface.notice.folderCycle")),
          );
          return;
        }
        await bridge.updateFolder(folder.id, folderId, folder.name);
        setNotice(
          deferredText(() =>
            translateNow("interface.notice.movedNamed", {
              name: folder.name,
              where: folderId
                ? (folderNameById.get(folderId) ?? "")
                : translateNow("sidebar.myRecords"),
            }),
          ),
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
        setNotice(
          deferredText(() =>
            translateNow(
              "interface.VaultLibrary.noLocationChosenNothingChanged",
            ),
          ),
        );
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
          deferredText(() =>
            translateNow(
              "interface.VaultLibrary.encryptedBackupSavedThisIsYourNew",
            ),
          ),
        );
        return;
      }
      setNotice(
        deferredText(() =>
          translateNow(
            "interface.VaultLibrary.encryptedBackupSavedKeepItSomewhereOther",
          ),
        ),
      );
    });

  const exportRecord = (record: VaultRecord) => {
    setConfirmation(null);
    void run(async () => {
      const pickId = await bridge.pickExportDestination(record.id);
      if (!pickId) {
        setNotice(
          deferredText(() =>
            translateNow("interface.VaultLibrary.saveCancelledNothingChanged"),
          ),
        );
        return;
      }
      await bridge.exportToPicked(pickId, record.id);
      setNotice(deferredText(() => translateNow("interface.notice.copySaved")));
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
    id === sharedProfileId
      ? translateNow("interface.LibrarySidebar.sharedWithMe")
      : (snapshot.profiles.find((candidate) => candidate.id === id)
          ?.displayName ?? "");
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
      const outcome = () =>
        removed.length === 0
          ? translateNow("interface.VaultLibrary.everyFileIsBackOnThisDevice")
          : translateNow("interface.notice.damagedHidden", {
              count: removed.length,
            });
      // The removal can commit and still leave the vault read-only, when its
      // redundant write fails. The banner then says why; only claim the vault
      // is writable when it is.
      setNotice(
        deferredText(() =>
          next.recovery === null
            ? translateNow("interface.notice.changesResumed", {
                outcome: outcome(),
              })
            : outcome(),
        ),
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
        deferredText(() =>
          translateNow("interface.notice.hidden", { name: record.displayName }),
        ),
      );
    });
  };
  const unhideRecord = (record: VaultRecord) => {
    void run(async () => {
      await bridge.unhideRecord(record.id);
      await refresh();
      setNotice(
        deferredText(() =>
          translateNow("interface.notice.restored", {
            name: record.displayName,
          }),
        ),
      );
    });
  };

  const changePassphrase = (current: string, replacement: string) =>
    run(async () => {
      await bridge.changePassphrase(current, replacement);
      await refresh();
      setNotice(
        deferredText(() =>
          translateNow("interface.VaultLibrary.passphraseChanged"),
        ),
      );
    }, ["box.currentPassphrase", "box.newPassphrase"]);
  const createProfile = async (name: string, details?: PersonDetails) => {
    let created = false;
    await run(async () => {
      await (details
        ? bridge.createProfile(name, details)
        : bridge.createProfile(name));
      created = true;
      await refresh();
      setNotice(
        deferredText(() =>
          translateNow("interface.notice.personAdded", { name }),
        ),
      );
    }, ["box.profileName"]);
    return created;
  };
  const renderSuggestion = (record: VaultRecord) => {
    if (
      record.profileId !== sharedProfileId ||
      readOnly ||
      !record.available ||
      record.hidden
    )
      return null;
    const suggestion = suggestions.suggestionFor(record.id);
    return suggestion ? (
      <PersonSuggestion
        person={suggestion.person}
        matchedBy={suggestion.by}
        documentName={record.displayName}
        busy={busy || readOnly}
        onMove={() => moveToPerson([record.id], suggestion.person.id, null)}
        onDismiss={() => suggestions.dismiss(record.id)}
      />
    ) : null;
  };
  const updateProfileDetails = async (id: string, details: PersonDetails) => {
    let saved = false;
    await run(async () => {
      await bridge.updateProfileDetails!(id, details);
      saved = true;
      await refresh();
      setNotice(
        t("personDetails.saved", {
          name: people.find((p) => p.id === id)?.displayName ?? "",
        }),
      );
    });
    return saved;
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
      if (outcome.moved.includes(activeRecordId ?? "")) setActiveRecordId(null);
      setSelectedIds((current) =>
        current.filter((id) => !outcome.moved.includes(id)),
      );
      await refresh();
      const said = () => {
        const theirs =
          people.length > 1
            ? translateNow("interface.person.records", {
                name: profileName(toProfileId),
              })
            : translateNow("sidebar.myRecords");
        const where = folder
          ? translateNow("interface.notice.whereFolder", {
              person: theirs,
              folder: folder.name,
            })
          : theirs;
        const source = inShared
          ? translateNow("interface.LibrarySidebar.sharedWithMe")
          : translateNow("interface.person.records", {
              name: profileName(profileId),
            });
        return [
          outcome.moved.length === 1
            ? translateNow("interface.notice.movedNamed", {
                name:
                  names.get(outcome.moved[0]) ??
                  translateNow("interface.RecordDetails.encryptedDocument"),
                where,
              })
            : outcome.moved.length > 1
              ? translateNow("interface.notice.movedMany", {
                  count: outcome.moved.length,
                  where,
                })
              : "",
          ...outcome.alreadyThere.map((name) =>
            translateNow("interface.notice.alreadyFiled", {
              name,
              person: theirs,
              source,
            }),
          ),
        ];
      };
      setNotice(deferredText(() => said().filter(Boolean).join(" ")));
    });

  const moveRecord = (recordId: string, folderId: string | null) =>
    run(async () => {
      await bridge.assignFolders(recordId, folderId ? [folderId] : []);
      await refresh();
      setNotice(
        deferredText(() =>
          translateNow("interface.VaultLibrary.documentMoved"),
        ),
      );
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
      setNotice(
        deferredText(() =>
          translateNow("interface.notice.folderCreated", { name }),
        ),
      );
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
      setNotice(
        deferredText(() =>
          translateNow("interface.notice.folderMovedNamed", {
            name: folder.name,
          }),
        ),
      );
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
    ? translateNow("interface.LibrarySidebar.sharedWithMe")
    : profile
      ? personFolderName(profile, people)
      : translateNow("sidebar.myRecords");
  const locationTitle = inShared
    ? rootLocationTitle
    : (currentFolder?.name ?? rootLocationTitle);
  const searchLabel = inShared
    ? translateNow("interface.VaultLibrary.searchSharedWithMe")
    : currentFolder
      ? translateNow("interface.VaultLibrary.searchThisFolderAndItsSubfolders")
      : translateNow("interface.search.all", { location: rootLocationTitle });

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
        <strong>{translateNow("frame.banner.title")}</strong>
        <span>
          {translateNow(
            "interface.VaultLibrary.filesAndRecordDetailsAreEncryptedAnd",
          )}
        </span>
      </div>
      <div className="page-wrap">
        <section
          className="app-window"
          aria-label={translateNow(
            "interface.VaultLibrary.myCarlosEncryptedRecordLibrary",
          )}
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
              onClick={() => void lockAndConceal()}
            >
              <Icon name="lock-open" />
              {translateNow("interface.VaultLibrary.unlockedLockNow")}
            </button>
          </header>

          {/* On narrow windows, where the sidebar is hidden: a row of
              tabs instead of a dropdown (#67). */}
          <nav
            className="mobile-section-picker native-section-tabs"
            aria-label={translateNow("interface.VaultLibrary.section")}
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
                  section === value ||
                  (value === "records" && inShared) ||
                  (value === "security" &&
                    (section === "hidden" || section === "history"))
                    ? "page"
                    : undefined
                }
                onClick={() =>
                  value === "security" ? openSecurity() : setSection(value)
                }
              >
                {value === "records" && sharedNew
                  ? translateNow("interface.tab.withNew", {
                      section: translateNow(label),
                      new: translateNow("interface.count.new", {
                        count: sharedNew,
                      }),
                    })
                  : translateNow(label)}
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
                translateNow("interface.VaultLibrary.privateVault")
              }
              people={people}
              profileId={profileId}
              section={section}
              currentFolderId={currentFolderId}
              folders={peopleFolders}
              records={peopleRecords}
              disabled={busy || readOnly}
              drag={drag}
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
              onOpenSecurity={openSecurity}
              onOpenPreferences={() => setSection("preferences")}
            />

            {(section === "records" || inShared) && (
              <main
                className={dropClass(
                  `library-main${!inShared && profile && !currentFolder ? " native-person-location" : ""}`,
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
                    <strong>
                      {translateNow("interface.LibrarySidebar.sharedWithMe")}
                    </strong>
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
                    aria-label={translateNow("sidebar.label")}
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
                      <Icon name="letter" />
                      {translateNow("interface.LibrarySidebar.sharedWithMe")}
                      {sharedNew > 0 &&
                        " (" +
                          translateNow("interface.count.new", {
                            count: sharedNew,
                          }) +
                          ")"}
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
                        ? normalizedQuery
                          ? translateNow("interface.count.found", {
                              items: translateNow("interface.count.documents", {
                                count: visibleRecords.length,
                              }),
                            })
                          : translateNow("interface.count.documents", {
                              count: visibleRecords.length,
                            })
                        : translateNow(
                            normalizedQuery
                              ? "interface.count.foundInLocation"
                              : "interface.count.inLocation",
                            {
                              folders: translateNow("interface.count.folders", {
                                count: visibleFolders.length,
                              }),
                              documents: translateNow(
                                "interface.count.documents",
                                { count: visibleRecords.length },
                              ),
                            },
                          )}
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
                          {translateNow("rename.title.folder")}
                        </button>
                      )}
                      {!currentFolder && profile && (
                        <button
                          className="button native-person-rename"
                          type="button"
                          disabled={busy || readOnly}
                          onClick={() =>
                            setRenameTarget({
                              kind: "profile",
                              id: profile.id,
                              name: profile.displayName,
                            })
                          }
                        >
                          {t("rename.profile.action", {
                            name: profile.displayName,
                          })}
                        </button>
                      )}
                      <button
                        className="button"
                        type="button"
                        disabled={readOnly}
                        onClick={() => setShowFolderForm((current) => !current)}
                      >
                        <Icon name="folder-plus" />
                        <span>
                          {translateNow("interface.VaultLibrary.newFolder")}
                        </span>
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
                          <span>
                            {translateNow("interface.CameraDialog.takeAPhoto")}
                          </span>
                        </button>
                      )}
                      <button
                        className="button primary"
                        type="button"
                        disabled={busy || readOnly || !profileId}
                        onClick={() => void importFiles()}
                        aria-label={translateNow(
                          "interface.VaultApp.chooseFilesToImport",
                        )}
                      >
                        <Icon name="plus" />
                        <span>
                          {busy
                            ? translateNow("interface.VaultLibrary.working")
                            : translateNow("interface.VaultLibrary.new")}
                        </span>
                      </button>
                    </div>
                  )}
                </div>

                {inShared && (
                  <p className="purpose-note native-shared-intro">
                    <Icon name="info" />
                    <span>
                      {computer
                        ? translateNow(
                            "interface.VaultLibrary.filesYouOpenWithMyCarlosArriveHere",
                          )
                        : translateNow(
                            "interface.VaultLibrary.filesYouShareToMyCarlosFromAnother",
                          )}{" "}
                      {people.length > 1
                        ? translateNow(
                            "interface.VaultLibrary.theyAreInNoOnesRecordsUntil",
                          )
                        : translateNow(
                            "interface.VaultLibrary.moveThemIntoYourFoldersWheneverYou",
                          )}
                    </span>
                  </p>
                )}

                {showFolderForm && !inShared && (
                  <form className="native-inline-form" onSubmit={submitFolder}>
                    <label>
                      {translateNow("rename.label.folder")}
                      <input
                        autoFocus
                        required
                        maxLength={NAME_INPUT_MAX_LENGTH}
                        value={folderName}
                        onChange={(event) => setFolderName(event.target.value)}
                      />
                    </label>
                    {nameTooLong(folderName) && (
                      <p role="alert">
                        {translateNow("create.profile.tooLong")}
                      </p>
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
                      {translateNow("interface.VaultLibrary.create")}
                    </button>
                    <button
                      className="button"
                      type="button"
                      onClick={() => setShowFolderForm(false)}
                    >
                      {translateNow("common.cancel")}
                    </button>
                  </form>
                )}

                {folders.length > 0 && !inShared && (
                  <details className="native-folder-move">
                    <summary>
                      {translateNow(
                        "interface.VaultLibrary.moveAFolderWithTheKeyboard",
                      )}
                    </summary>
                    <div>
                      <label>
                        {translateNow("interface.RecordDetails.folder")}
                        <select
                          value={folderToMoveId}
                          onChange={(event) => {
                            setFolderToMoveId(event.target.value);
                            // The destination list excludes the chosen folder.
                            setFolderDestinationId("");
                          }}
                        >
                          <option value="">
                            {translateNow(
                              "interface.VaultLibrary.chooseAFolder",
                            )}
                          </option>
                          {folders.map((folder) => (
                            <option value={folder.id} key={folder.id}>
                              {folder.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {translateNow("interface.VaultLibrary.destination")}
                        <select
                          value={folderDestinationId}
                          onChange={(event) =>
                            setFolderDestinationId(event.target.value)
                          }
                        >
                          <option value="">
                            {translateNow("sidebar.myRecords")}
                          </option>
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
                        {translateNow("interface.VaultLibrary.moveFolder")}
                      </button>
                    </div>
                  </details>
                )}

                {snapshot.recovery === "lostObjects" && (
                  <div className="purpose-note warning" role="alert">
                    <Icon name="info" />
                    <span>
                      <strong>
                        {translateNow(
                          "interface.VaultLibrary.changesArePaused",
                        )}
                      </strong>{" "}
                      {translateNow(
                        "interface.VaultLibrary.someEncryptedFilesAreMissingFromThis",
                      )}
                    </span>
                    <button
                      className="button"
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmHideDamaged(true)}
                    >
                      {translateNow(
                        "interface.VaultLibrary.hideDamagedDocuments",
                      )}
                    </button>
                  </div>
                )}
                {snapshot.recovery === "unreadableSlot" && (
                  <div className="purpose-note warning" role="alert">
                    <Icon name="info" />
                    <span>
                      <strong>
                        {translateNow(
                          "interface.VaultLibrary.changesArePaused",
                        )}
                      </strong>{" "}
                      {translateNow(
                        "interface.VaultLibrary.someOfTheVaultsFilesCouldNot",
                      )}
                    </span>
                  </div>
                )}
                {snapshot.recovery === "writeFailed" && (
                  <div className="purpose-note warning" role="alert">
                    <Icon name="info" />
                    <span>
                      <strong>
                        {translateNow(
                          "interface.VaultLibrary.changesArePaused",
                        )}
                      </strong>{" "}
                      {translateNow(
                        "interface.VaultLibrary.myCarlosCouldNotSaveAChangeTo",
                      )}
                    </span>
                  </div>
                )}
                {!readOnly && !snapshot.recoveryKeySetAtMs && (
                  <div className="purpose-note warning">
                    <Icon name="info" />
                    <span>
                      <strong>
                        {translateNow(
                          "interface.VaultLibrary.noRecoveryKeyYet",
                        )}
                      </strong>{" "}
                      {translateNow(
                        "interface.VaultLibrary.ifYouForgetYourPassphraseWithoutOne",
                      )}
                    </span>
                    <button
                      className="button"
                      type="button"
                      disabled={busy}
                      onClick={() => setRecoverySetup({ required: false })}
                    >
                      {translateNow("security.recoveryKey.setUp")}
                    </button>
                  </div>
                )}

                <PortalDocuments
                  compact
                  bridge={bridge}
                  snapshot={snapshot}
                  busy={busy}
                  readOnly={readOnly}
                  run={run}
                  refresh={refresh}
                  setNotice={setNotice}
                />
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
                    {currentFolder
                      ? translateNow("interface.VaultLibrary.insideFolder")
                      : translateNow("interface.VaultLibrary.topLevel")}
                  </span>
                  <span className="native-drag-hint">
                    {translateNow(
                      "interface.VaultLibrary.holdAndDragADocumentOrFolder",
                    )}
                  </span>
                  <div className="view-controls">
                    {/* Both choices in view, with words (#67). */}
                    <fieldset className="native-sort-choice">
                      <legend>
                        {translateNow("interface.VaultLibrary.sortBy")}
                      </legend>
                      {SORT_CHOICES.map(([value, label]) => (
                        <label key={value}>
                          <input
                            type="radio"
                            name="native-sort"
                            value={value}
                            checked={sort === value}
                            onChange={() => setSort(value)}
                          />
                          {translateNow(label)}
                        </label>
                      ))}
                    </fieldset>
                    <span
                      className="segment native-view-segment"
                      aria-label={translateNow(
                        "interface.VaultLibrary.chooseRecordView",
                      )}
                    >
                      <button
                        className={view === "list" ? "selected" : ""}
                        type="button"
                        aria-label={translateNow(
                          "interface.VaultLibrary.listView",
                        )}
                        aria-pressed={view === "list"}
                        onClick={() => setView("list")}
                      >
                        <Icon name="list" />
                        {translateNow("interface.VaultLibrary.list")}
                      </button>
                      <button
                        className={view === "grid" ? "selected" : ""}
                        type="button"
                        aria-label={translateNow(
                          "interface.VaultLibrary.gridView",
                        )}
                        aria-pressed={view === "grid"}
                        onClick={() => setView("grid")}
                      >
                        <Icon name="grid" />
                        {translateNow("interface.VaultLibrary.grid")}
                      </button>
                    </span>
                  </div>
                </div>

                {selectedIds.length > 0 && (
                  <div className="bulkbar" role="status">
                    <strong>
                      {translateNow("interface.count.selected", {
                        count: selectedIds.length,
                      })}
                    </strong>
                    <span>
                      {translateNow(
                        "interface.VaultLibrary.moveTheSelectedDocuments",
                      )}
                    </span>
                    <div className="bulk-actions native-move-actions">
                      {inShared ? (
                        <MoveTargetSelect
                          label={translateNow(
                            "interface.VaultLibrary.moveSelectedTo",
                          )}
                          targets={moveTargets}
                          value={sharedTarget || `${profile?.id ?? ""}|`}
                          onChange={setSharedTarget}
                        />
                      ) : (
                        <select
                          aria-label={translateNow(
                            "interface.VaultLibrary.moveSelectedTo",
                          )}
                          value={moveFolderId}
                          onChange={(event) =>
                            setMoveFolderId(event.target.value)
                          }
                        >
                          <option value="">
                            {translateNow("sidebar.myRecords")}
                          </option>
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
                        {translateNow("interface.RecordDetails.move")}
                      </button>
                      <button type="button" onClick={() => setSelectedIds([])}>
                        {translateNow("interface.VaultLibrary.clear")}
                      </button>
                    </div>
                  </div>
                )}
                <p className="status-line" role="status" aria-live="polite">
                  {notice}
                </p>

                <LibraryItems
                  view={view}
                  suggestionFor={renderSuggestion}
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
                      ? translateNow("interface.VaultLibrary.fileUnavailable")
                      : translateNow(
                          "interface.VaultLibrary.damagedFileMissing",
                        )
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
                rootName={hiddenScopeName}
                onBack={backToSecurity}
                focusOnOpen
                folderNameById={folderNameById}
                busy={busy}
                readOnly={readOnly}
                notice={notice}
                onRestore={unhideRecord}
              />
            )}

            {section === "history" && (
              <AuditHistory
                bridge={bridge}
                onBack={backFromHistoryToSecurity}
                onLock={lockAndConceal}
              />
            )}

            {section === "preferences" && <PreferencesSettings />}

            {section === "security" && (
              <SecuritySettings
                clinicDocuments={
                  <PortalDocuments
                    bridge={bridge}
                    snapshot={snapshot}
                    busy={busy}
                    readOnly={readOnly}
                    run={run}
                    refresh={refresh}
                    setNotice={setNotice}
                  />
                }
                busy={busy}
                readOnly={readOnly}
                notice={notice}
                autoLockMinutes={autoLockMinutes}
                onAutoLockMinutes={onAutoLockMinutes}
                onLock={lockAndConceal}
                onChangePassphrase={changePassphrase}
                onCreateProfile={createProfile}
                hiddenCount={hiddenRecords.length}
                focusHiddenEntry={returnFocusToHidden}
                focusAuditEntry={returnFocusToHistory}
                hiddenScopeName={hiddenScopeName}
                onOpenHidden={() => setSection("hidden")}
                onOpenAuditHistory={() => {
                  setReturnFocusToHistory(false);
                  setSection("history");
                }}
                people={people}
                onUpdateProfileDetails={
                  bridge.updateProfileDetails ? updateProfileDetails : undefined
                }
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
                  ? message("interface.recovery.replaced", () => ({
                      backups: translateNow(backups),
                    }))
                  : message(
                      "interface.VaultLibrary.recoveryKeySavedKeepYourKitSomewhere",
                    );
                setRecoverySetup(null);
                setNotice("");
                // The setup is finished once the patient is told so. Until
                // then a lock leaves it unfinished, and the next unlock says
                // the key was saved.
                const tell = (message: UiText) => {
                  if (!mountedRef.current) return;
                  onUnfinishedRecoveryKey?.(null);
                  setDialogResult({ message, recordId: activeRecordId });
                };
                // As the confirmation returned it: so that what this screen
                // shows, and the next setup's record of the key it would
                // replace, is the vault with this key.
                void refresh(stored).then(() => tell(saved));
                focusPageIfLost();
              }}
              onClose={(keyShown) => {
                onUnfinishedRecoveryKey?.(null);
                const offered = recoverySetup.offered;
                setRecoverySetup(null);
                // An offer that was left before any key was shown: the
                // unlock's own result, which waited for the dialog.
                if (offered && !keyShown)
                  setDialogResult({
                    message: deferredText(() =>
                      translateNow("notice.unlocked"),
                    ),
                    recordId: activeRecordId,
                  });
                if (keyShown) {
                  setNotice("");
                  setDialogResult({
                    message: deferredText(() =>
                      snapshot.recoveryKeySetAtMs
                        ? translateNow(
                            "interface.VaultLibrary.recoveryKeySetupWasNotFinishedThe",
                          )
                        : translateNow(
                            "interface.VaultLibrary.recoveryKeySetupWasNotFinishedTheAlternative",
                          ),
                    ),
                    recordId: activeRecordId,
                  });
                }
                focusPageIfLost();
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
                suggestion={renderSuggestion(activeRecord)}
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
          {readerRecord && iphonePdfReader && (
            <IphoneDocumentReader
              record={readerRecord}
              read={(id, closeLabel) => bridge.readNativePdf(id, closeLabel)}
              cancel={() => bridge.cancelView()}
              onClose={() => setReaderRecordId(null)}
            />
          )}
          {readerRecord && !iphonePdfReader && (
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
              title={translateNow("interface.hideDamaged.title", {
                count: damagedCount,
              })}
              confirmLabel={translateNow("interface.RecordDetails.hide")}
              onConfirm={hideDamaged}
              onCancel={() => setConfirmHideDamaged(false)}
              details={
                // It scrolls when it is long, so it takes focus, to be
                // scrolled with the keyboard. It is not read out with the
                // dialog: the title counts the documents.
                <ul
                  className="native-confirm-list"
                  aria-label={translateNow(
                    "interface.VaultLibrary.documentsToHide",
                  )}
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
                {translateNow(
                  "interface.VaultLibrary.theirEncryptedFilesAreMissingFromThis",
                )}
              </p>
              <p>
                {translateNow(
                  "interface.VaultLibrary.firstCheckThatTheFilesAreNot",
                )}
              </p>
            </ConfirmDialog>
          )}
          {activeRecord && pendingAction === "export" && (
            <ConfirmDialog
              title={translateNow("interface.VaultLibrary.saveAReadableCopy")}
              confirmLabel={translateNow("interface.VaultLibrary.saveACopy")}
              onConfirm={() => exportRecord(activeRecord)}
              onCancel={() => setConfirmation(null)}
            >
              <p>
                {translateNow(
                  "interface.VaultLibrary.savingCreatesAReadableFileOutsideThe",
                )}
              </p>
            </ConfirmDialog>
          )}
        </section>
      </div>
    </div>
  );
}

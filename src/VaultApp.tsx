import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import App from "./App";
import {
  boxesWithControlCharacters,
  createVaultBridge,
  hasVaultErrorCode,
  isCancelledError,
  isLockedError,
  isMissingVaultError,
  isRecoveryModeError,
  isRestoreUnfinished,
  vaultErrorMessage,
  vaultErrorNote,
  type ReceivedFile,
  type VaultBridge,
  type VaultSnapshot,
  type VaultStatus,
  type BoxKey,
} from "./vault";
import { receiveNoticeText } from "./native/receivedNotice";
import { VaultAuthFrame, CreateVault, UnlockVault } from "./native/VaultAuth";
import { LockWarning } from "./native/LockWarning";
import { ComfortSetup } from "./native/ComfortSetup";
import { t } from "./i18n";
import { VaultLibrary } from "./native/VaultLibrary";
import type { OpeningRecoverySetup } from "./native/RecoveryKeySetup";
import { recordRecoveryOffer, recoveryOfferDue } from "./native/recoveryOffer";
import { TransferHold } from "./native/transferHold";
import {
  isAwaitingApproval,
  PortalWaits,
  type ApprovalPoll,
  type PollApproval,
} from "./native/useApprovalPolling";
import { ANNOUNCE_DELAY_MS } from "./native/announce";
import {
  checkClinicDocuments,
  unlockCheckFailedText,
  unlockCheckNotRunText,
  unlockCheckText,
  unlockCheckWaitingText,
} from "./native/documentCheck";
import { CAMERA_PLATFORMS, isPhone } from "./native/photo";
import {
  rememberUnfinishedRecoveryKey,
  takeUnfinishedRecoveryKey,
  unfinishedRecoveryKeyMessage,
  exposedKeyReplaced,
} from "./native/unfinishedRecoveryKey";
import { rememberOldBackupsGuide } from "./native/oldBackups";
import {
  normalizeAutoLockMinutes,
  readAutoLockMinutes,
  persistAutoLockMinutes,
} from "./native/autoLock";

export interface VaultAppProps {
  bridge?: VaultBridge;
}
const defaultBridge = createVaultBridge();
// Platforms with a print dialog for the recovery kit.
const DESKTOP_PLATFORMS = new Set(["windows", "macos", "linux"]);

// Timers pause while a device sleeps, so the inactivity deadline is kept as a
// wall-clock time and rechecked at least this often. The same recheck retries a
// lock that failed.
const LOCK_RECHECK_MS = 10_000;
const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "wheel",
  "keydown",
  "touchstart",
  // Not "scroll": the page scrolls itself too (a focus move, content loading),
  // which would keep the vault open with nobody there. Scrolling by the
  // person comes as a wheel, touch, pointer or key event, and counts (#68).
] as const;
// The automatic lock is said this long before it comes, so that it can be put
// off (#68, WCAG 2.2.1).
const LOCK_WARNING_MS = 30_000;
/** Why the vault locked by itself, said on the unlock screen (#68). */
type LockReason = "idle" | "hidden";
// Dispatched on the document when a picker this app opened settles.
const PICKER_SETTLED_EVENT = "mycarlos:picker-settled";
// Time in a picker counts as activity for at most this long, the longest
// auto-lock delay, so a picker left open cannot keep the vault unlocked.
const PICKER_GRACE_MS = 15 * 60 * 1000;
// User input is reported to the native idle deadline at most this often, so the
// last report is less than 10 seconds before the last input. The native
// deadline fires the delay plus 15 seconds after the last report, so at least
// 5 seconds after this screen's own deadline (the native 2-second check only
// adds to that).
const TOUCH_THROTTLE_MS = 10_000;
// The check after unlocking, refused because other clinic work held the
// native side, asks once more this long after that work returned (#128).
const BUSY_RETRY_MS = 2_000;
// The library's import button, named in a notice as the library shows it:
// in English until the library is translated.
const IMPORT_BUTTON = "Choose files to import";

/** Where focus goes when the check after unlocking disables the control
 * that had it (#128): that device's heading in the clinic view, else the
 * clinic view's heading, else the library page's heading. */
function headingFor(control: Element): HTMLElement | null {
  const device = control
    .closest(".portal-link")
    ?.querySelector<HTMLElement>("h3[tabindex]");
  if (device) return device;
  if (control.closest(".portal-documents"))
    return document.getElementById("portal-title");
  return (
    document.querySelector<HTMLElement>("main h1[tabindex]") ??
    document.querySelector<HTMLElement>("h1[tabindex]")
  );
}

export default function VaultApp({ bridge = defaultBridge }: VaultAppProps) {
  if (!bridge.native) return <App />;
  return <NativeVault bridge={bridge} />;
}

function NativeVault({ bridge }: { bridge: VaultBridge }) {
  const [status, setStatus] = useState<VaultStatus | "loading">("loading");
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null);
  const [notice, setNotice] = useState("");
  // Files shared from another app, waiting. Asked for at start, whenever the
  // window comes back to the front (which is how a share arrives), and at
  // unlock. Locked, only their count is shown; open, they go straight into
  // Shared with me (#61, `acceptShared` below).
  const [received, setReceived] = useState<ReceivedFile[]>([]);
  const acceptSharedRef = useRef<() => Promise<void>>(async () => undefined);
  const refreshReceived = useCallback(
    (): Promise<void> =>
      bridge.listReceived().then(
        async ({ files, notice: missed }) => {
          setReceived(files);
          const text = receiveNoticeText(missed);
          if (text) setNotice(text);
          if (files.length) await acceptSharedRef.current();
        },
        // Nothing waiting can be shown; the next ask tries again.
        () => undefined,
      ),
    [bridge],
  );
  // Files added to Shared with me since this unlock, until the patient opens
  // it: shown as "2 new" and said once, politely (#61).
  const [sharedNew, setSharedNew] = useState(0);
  const clearSharedNew = useCallback(() => setSharedNew(0), []);
  useEffect(() => {
    refreshReceived();
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshReceived();
    };
    window.addEventListener("focus", refreshReceived);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refreshReceived);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshReceived]);
  // A message for the library that unlocking or creating the vault is about to
  // show. Its status line reads out only what changes once it is on screen, so
  // the message is written just after (see the effect below).
  const [libraryNotice, setLibraryNotice] = useState<{
    message: string;
    // What was held for this unlock: the result of a transfer that a lock
    // ended, or how a key setup it ended ended. It must reach the patient:
    // it may say a readable copy was left behind, or which key to keep.
    outcome: string | null;
  } | null>(null);
  // The library opens on the recovery key setup: for a vault just created,
  // with its key, before anything else; for a vault unlocked without one, as
  // an offer that can be left for later.
  const [openingRecoverySetup, setOpeningRecoverySetup] =
    useState<OpeningRecoverySetup | null>(null);
  const [busy, setBusy] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);
  const portalJobRef = useRef<{
    session: number;
    promise: Promise<void>;
  } | null>(null);
  // A clinic result that arrives while a library operation runs, shown after
  // that operation's own result rather than in its place.
  const portalNoticeRef = useRef<{ session: number; message: string } | null>(
    null,
  );
  // Per portal, when automatic approval checks may ask it again after it
  // asked to wait (#131): kept across the clinic view's remounts, and
  // forgotten when the session ends.
  const [portalWaits] = useState(() => new PortalWaits());
  // The automatic approval status check under way, if any (#131).
  const portalPollRef = useRef<{
    session: number;
    promise: Promise<ApprovalPoll>;
  } | null>(null);
  // The session in which the latest check for new clinic documents began,
  // the patient's own or the one after unlocking (#128).
  const documentCheckSessionRef = useRef(-1);
  // Clinic work of a session that has ended. Locking cancels its HTTP, but
  // the native side admits one clinic operation at a time until that work
  // has returned: the check after the next unlock waits for it, rather than
  // being refused as busy.
  const endedPortalWorkRef = useRef<Promise<unknown>>(Promise.resolve());
  // The check for new clinic documents owed by the latest unlock (#128),
  // for its session. It waits for the library to give the unlock's own
  // message, and for the recovery key offer that unlock opened on to close.
  const [unlockCheck, setUnlockCheck] = useState<{
    session: number;
    offerOpen: boolean;
  } | null>(null);
  const [concealed, setConcealed] = useState(false);
  const [lockFailed, setLockFailed] = useState(false);
  // An automatic or background lock owed while a transfer runs, or before the
  // operation that ran it has finished, waits for that operation, with content
  // hidden: locking cancels a transfer, and a large one must not be cut off by
  // the user switching apps or reading instead of clicking.
  const [lockHeld, setLockHeld] = useState(false);
  const lockHeldRef = useRef(false);
  // The ref is read by callbacks that run before the next render.
  const holdLock = useCallback((held: boolean) => {
    lockHeldRef.current = held;
    setLockHeld(held);
  }, []);
  // An automatic or background lock waits until every operation started
  // through `run` has finished if one of them ran a transfer, so the transfer
  // has reported its outcome first.
  const [transferHold] = useState(() => new TransferHold());
  // What was last reported since the latest transfer began: its result, or a
  // partial readable copy to delete. Used only when a lock ends that transfer.
  const transferOutcomeRef = useRef<string | null>(null);
  // The outcome of a transfer the vault locked on. It is shown after the next
  // unlock, not on the unlock screen, where anyone at the device could read it.
  const pendingOutcomeRef = useRef<string | null>(null);
  const [autoLockMinutes, setAutoLockMinutes] = useState(readAutoLockMinutes);
  // Read by `lock`, which keeps its identity, for the reason it gives.
  const autoLockMinutesRef = useRef(autoLockMinutes);
  autoLockMinutesRef.current = autoLockMinutes;
  // Why an automatic lock was owed, said once it has happened; null for a
  // lock the patient asked for.
  const lockReasonRef = useRef<LockReason | null>(null);
  // Seconds left when the warning before the automatic lock opened (#68).
  const [lockWarning, setLockWarning] = useState<number | null>(null);
  // Keeps myCarlos open from the warning: set by the automatic lock's effect.
  const keepOpenRef = useRef<() => void>(() => undefined);
  // A new setup starts by making myCarlos comfortable (#69): once per run of
  // the app, before the passphrase. A vault that exists never shows it.
  const [comfortChosen, setComfortChosen] = useState(false);
  const lockingRef = useRef(false);
  // Incremented whenever the vault locks. Work started in an earlier session
  // must not put its decrypted results or document names back on screen.
  const sessionRef = useRef(0);

  useEffect(() => {
    // HTML drag/drop owns in-vault moves. External files still use the native
    // picker; prevent the webview from navigating to a dropped file or URL.
    const preventNavigation = (event: DragEvent) => event.preventDefault();
    const rejectExternalFiles = (event: DragEvent) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes("Files"))
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
      if (event.type === "drop") {
        setNotice(t("notice.dropRefused", { button: IMPORT_BUTTON }));
      }
    };
    window.addEventListener("dragover", preventNavigation);
    window.addEventListener("drop", preventNavigation);
    window.addEventListener("dragover", rejectExternalFiles, true);
    window.addEventListener("drop", rejectExternalFiles, true);
    return () => {
      window.removeEventListener("dragover", preventNavigation);
      window.removeEventListener("drop", preventNavigation);
      window.removeEventListener("dragover", rejectExternalFiles, true);
      window.removeEventListener("drop", rejectExternalFiles, true);
    };
  }, []);

  // Results kept for after the next unlock add up: one never replaces
  // another. `first` puts an older result ahead of what was kept since.
  const holdForUnlock = useCallback((outcome: string, first = false) => {
    const held = pendingOutcomeRef.current;
    pendingOutcomeRef.current = (first ? [outcome, held] : [held, outcome])
      .filter(Boolean)
      .join(" ");
  }, []);

  // Nothing held for the next unlock is about a vault a restore replaces:
  // not a transfer's outcome, nor how a key setup ended.
  const forgetReplacedVault = () => {
    pendingOutcomeRef.current = null;
    rememberUnfinishedRecoveryKey(null);
    rememberOldBackupsGuide(null);
  };

  // Taken as a vault opens: what happened while it was locked, and how a
  // recovery key setup that a lock or closing ended actually ended.
  const takeHeldOutcome = (opened: VaultSnapshot) => {
    const unfinished = takeUnfinishedRecoveryKey();
    // A key whose kit may have been exposed was replaced as the lock fell:
    // Security shows the steps for its older backups, as after a
    // replacement the patient saw finish.
    if (
      unfinished &&
      exposedKeyReplaced(unfinished, opened.recoveryKeySetAtMs ?? null)
    )
      rememberOldBackupsGuide({ step: "save" });
    const outcome = [
      pendingOutcomeRef.current,
      unfinished &&
        unfinishedRecoveryKeyMessage(
          unfinished,
          opened.recoveryKeySetAtMs ?? null,
          Boolean(opened.recovery),
        ),
    ]
      .filter(Boolean)
      .join(" ");
    pendingOutcomeRef.current = null;
    return outcome || null;
  };

  // Read through a ref so that `requestLock` keeps its identity: the automatic
  // lock effect depends on it, and re-running that effect resets its deadline.
  // `lock` reads it too.
  const concealedRef = useRef(concealed);
  concealedRef.current = concealed;

  const lock = useCallback(async () => {
    if (lockingRef.current) return;
    lockingRef.current = true;
    // A transfer this lock ends, or waited for, reports how it went.
    const endsTransfer = lockHeldRef.current || transferHold.active;
    try {
      await bridge.lock();
      sessionRef.current += 1;
      endedPortalWorkRef.current = Promise.allSettled([
        endedPortalWorkRef.current,
        portalJobRef.current?.promise,
        portalPollRef.current?.promise,
      ]);
      portalJobRef.current = null;
      portalPollRef.current = null;
      portalWaits.clear();
      portalNoticeRef.current = null;
      setPortalBusy(false);
      setUnlockCheck(null);
      setSnapshot(null);
      // A key shown but not set up ended with the session.
      setOpeningRecoverySetup(null);
      setConcealed(false);
      setLockFailed(false);
      holdLock(false);
      setStatus("locked");
      if (endsTransfer && transferOutcomeRef.current)
        holdForUnlock(transferOutcomeRef.current);
      // Why, without anything of the records (#68).
      const reason = lockReasonRef.current;
      lockReasonRef.current = null;
      const minutes = autoLockMinutesRef.current;
      setNotice(
        reason === "idle"
          ? t("notice.lockedIdle", { count: minutes })
          : reason === "hidden"
            ? t("notice.lockedHidden")
            : t("notice.locked"),
      );
    } catch (error) {
      // The vault is still unlocked natively. Every caller must learn that,
      // including the concealed screen, which would otherwise claim "Locked".
      setLockFailed(true);
      // What was held for the unlock after this lock is for the patient now,
      // while the vault stays open, unless the content is hidden: there it
      // keeps waiting for an unlock, where only the owner sees it.
      const held = concealedRef.current ? null : pendingOutcomeRef.current;
      if (held) pendingOutcomeRef.current = null;
      setNotice(
        held ? `${vaultErrorMessage(error)} ${held}` : vaultErrorMessage(error),
      );
    } finally {
      lockingRef.current = false;
    }
  }, [bridge, holdForUnlock, holdLock, transferHold]);

  const requestLock = useCallback(
    (concealImmediately = false) => {
      if (concealImmediately) {
        // A failure left by an earlier manual attempt is not this attempt's.
        // Retries from the concealed screen keep theirs, so the alert is not
        // announced again on every recheck.
        if (!concealedRef.current) setLockFailed(false);
        setConcealed(true);
        // At once, for a lock that fails before the screen is drawn again.
        concealedRef.current = true;
      }
      void lock();
    },
    [lock],
  );

  // A lock the patient asked for gives no reason but that.
  const lockAsked = useCallback(() => {
    lockReasonRef.current = null;
    return lock();
  }, [lock]);
  const requestLockAsked = useCallback(() => {
    lockReasonRef.current = null;
    requestLock(true);
  }, [requestLock]);

  // Automatic locks: during a transfer, hide content and lock once the
  // operation it belongs to has finished. The first reason owed is the one
  // given.
  const lockWhenIdle = useCallback(
    (reason: LockReason) => {
      lockReasonRef.current ??= reason;
      setLockWarning(null);
      if (!transferHold.active) {
        requestLock(true);
        return;
      }
      if (!concealedRef.current) setLockFailed(false);
      setConcealed(true);
      concealedRef.current = true;
      holdLock(true);
    },
    [holdLock, requestLock, transferHold],
  );

  const platformRef = useRef("");
  // Also kept as state, for what is rendered from it.
  const [platform, setPlatform] = useState("");
  useEffect(() => {
    let active = true;
    bridge
      .platform()
      .then((platform) => {
        if (active) {
          platformRef.current = platform;
          setPlatform(platform);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [bridge]);

  useEffect(() => {
    let active = true;
    bridge
      .status()
      .then(async (next) => {
        if (next === "unlocked") {
          const current = await bridge.snapshot();
          if (active) setSnapshot(current);
        }
        if (active) setStatus(next);
      })
      .catch((error) => {
        // The unlock screen is about to be shown, so no timer or background
        // lock will cover a native session that is still open. Close it.
        void bridge.lock().catch(() => undefined);
        if (active) {
          setNotice(vaultErrorMessage(error));
          setStatus("locked");
        }
      });
    return () => {
      active = false;
    };
  }, [bridge]);

  // Pickers this app opened and has not yet heard back from. Only the pick
  // phase counts: once the paths are chosen, the transfer that follows holds
  // an owed automatic lock until it finishes, with content hidden.
  // A phone's camera permission question counts too (D97): Android pauses the
  // page under it, as under a picker.
  const pickersOpenRef = useRef(0);
  const pickerOpenedAtRef = useRef(0);
  const track = useCallback(async <T,>(picker: Promise<T>): Promise<T> => {
    if (pickersOpenRef.current === 0) pickerOpenedAtRef.current = Date.now();
    pickersOpenRef.current += 1;
    try {
      return await picker;
    } finally {
      pickersOpenRef.current -= 1;
      // Restart the inactivity deadline: the recheck only sees a picker that
      // is open when it runs, and it cannot run while the page is suspended
      // under Android's picker activity.
      document.dispatchEvent(new Event(PICKER_SETTLED_EVENT));
      // Let the visibility handler decide again now that the picker is gone.
      document.dispatchEvent(new Event("visibilitychange"));
    }
  }, []);
  const trackedBridge = useMemo<VaultBridge>(() => {
    const transfer = async <T,>(start: () => Promise<T>): Promise<T> => {
      // `run` locks once the operation has reported the transfer's outcome.
      transferHold.transferStarted();
      transferOutcomeRef.current = null;
      // iOS suspends an app in the background, and its transfer with it.
      if (platformRef.current === "ios") setNotice(t("notice.iosKeepOpen"));
      return start();
    };
    return {
      ...bridge,
      // A check for new documents in this session, the patient's own or the
      // one after unlocking, stands in for the check after unlocking (#128).
      checkDocuments:
        bridge.checkDocuments &&
        (() => {
          documentCheckSessionRef.current = sessionRef.current;
          return bridge.checkDocuments!();
        }),
      pickImportFiles: (profileId, folderIds) =>
        track(bridge.pickImportFiles(profileId, folderIds)),
      pickExportDestination: (recordId) =>
        track(bridge.pickExportDestination(recordId)),
      saveRecoveryKit: () => track(bridge.saveRecoveryKit()),
      // A native confirmation may be open for as long as a picker.
      confirmRecoveryKey: (groups) => track(bridge.confirmRecoveryKey(groups)),
      pickBackupDestination: (localDate) =>
        track(bridge.pickBackupDestination(localDate)),
      saveBackupToPicked: (pickId) =>
        transfer(() => bridge.saveBackupToPicked(pickId)),
      pickRestoreSource: () => track(bridge.pickRestoreSource()),
      restore: async (pickId, credential, replace) => {
        try {
          return await bridge.restore(pickId, credential, replace);
        } catch (error) {
          // Put in place at the next start: like a restore that finished, it
          // replaces the vault that what is held for the next unlock is about.
          if (isRestoreUnfinished(error)) forgetReplacedVault();
          throw error;
        }
      },
      importPickedFiles: (pickId, profileId, folderIds) =>
        transfer(() => bridge.importPickedFiles(pickId, profileId, folderIds)),
      exportToPicked: (pickId, recordId) =>
        transfer(() => bridge.exportToPicked(pickId, recordId)),
    };
  }, [bridge, track, transferHold]);

  useEffect(() => {
    if (status !== "unlocked") return;
    const delayMs = autoLockMinutes * 60 * 1000;
    // A check that runs after this session has locked, before the cleanup
    // below, must not hold a lock for the next one.
    const session = sessionRef.current;
    let deadline = Date.now() + delayMs;
    let timer = 0;
    // A failed send is retried on every check: until one is accepted, the
    // native deadline keeps its previous delay (the longest, before any).
    let delaySent = false;
    const sendDelay = () => {
      bridge.setAutoLock(autoLockMinutes).then(
        () => {
          delaySent = true;
        },
        () => undefined,
      );
    };
    const inPickerGrace = () =>
      Date.now() - pickerOpenedAtRef.current < PICKER_GRACE_MS;
    const check = () => {
      if (sessionRef.current !== session) return;
      if (!delaySent) sendDelay();
      // Time spent in a picker the app opened is not idle time: the user is
      // choosing files for this vault. The deadline restarts once it closes.
      if (pickersOpenRef.current > 0 && inPickerGrace())
        deadline = Date.now() + delayMs;
      const remaining = deadline - Date.now();
      // Hide content at once: an unattended screen must not stay readable while
      // the lock is pending, or if it fails and has to be retried.
      if (remaining <= 0) lockWhenIdle("idle");
      // Said before it comes, unless content is already hidden (#68).
      else if (remaining <= LOCK_WARNING_MS && !concealedRef.current)
        setLockWarning(
          (shown) => shown ?? Math.max(1, Math.ceil(remaining / 1000)),
        );
      const untilWarning = remaining - LOCK_WARNING_MS;
      timer = window.setTimeout(
        check,
        remaining > 0
          ? Math.min(
              untilWarning > 0 ? untilWarning : remaining,
              LOCK_RECHECK_MS,
            )
          : LOCK_RECHECK_MS,
      );
    };
    let touchedAt = -Infinity;
    const postpone = () => {
      // Once the delay has elapsed the lock is owed; activity cannot cancel it.
      if (Date.now() >= deadline) return;
      deadline = Date.now() + delayMs;
      // Use puts the lock off, and with it its warning.
      setLockWarning(null);
      // The native deadline cannot see input, so it is told, sparingly.
      if (Date.now() - touchedAt >= TOUCH_THROTTLE_MS) {
        touchedAt = Date.now();
        bridge.touch().catch(() => undefined);
      }
    };
    // Unlike `postpone`, this also applies after the delay has elapsed: the
    // time since the picker opened was not idle. A lock already owed, shown by
    // the concealed screen, stays owed. A page still hidden now is locked by
    // the visibility check that follows.
    const onPickerSettled = () => {
      if (!concealedRef.current && inPickerGrace())
        deadline = Date.now() + delayMs;
    };
    // Keep open in the warning: as use, and told to the native deadline at
    // once, whenever it was last told.
    keepOpenRef.current = () => {
      if (Date.now() >= deadline) return;
      deadline = Date.now() + delayMs;
      setLockWarning(null);
      touchedAt = Date.now();
      bridge.touch().catch(() => undefined);
    };
    const onVisibility = () => {
      if (sessionRef.current !== session) return;
      if (document.visibilityState !== "hidden") return;
      // On Android the system picker is a separate activity, so the page is
      // hidden while a picker this app opened is in the foreground. Locking then
      // would drop the session the chosen files are about to be imported into.
      // The picker's settlement re-dispatches this event, so a page still
      // hidden once it closes is treated as backgrounded and locked then.
      if (pickersOpenRef.current > 0) return;
      // The lock is owed from here on, exactly as if the delay had elapsed:
      // activity cannot postpone it, and the recheck retries it if it fails.
      deadline = 0;
      lockWhenIdle("hidden");
    };
    check();
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, postpone, { passive: true });
    }
    document.addEventListener(PICKER_SETTLED_EVENT, onPickerSettled);
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();
    return () => {
      window.clearTimeout(timer);
      keepOpenRef.current = () => undefined;
      setLockWarning(null);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, postpone);
      }
      document.removeEventListener(PICKER_SETTLED_EVENT, onPickerSettled);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [autoLockMinutes, bridge, lockWhenIdle, status]);

  const libraryShown = status === "unlocked" && snapshot !== null && !concealed;
  useEffect(() => {
    if (!libraryNotice) return;
    const { message, outcome } = libraryNotice;
    // Held again for the next unlock, after anything a later lock kept.
    const holdOutcome = () => {
      if (outcome) holdForUnlock(outcome, true);
    };
    // The session ended before the message was written. Nothing of it may
    // reach the unlock screen; a held outcome waits for the next unlock.
    if (status !== "unlocked") {
      if (status === "locked") holdOutcome();
      setLibraryNotice(null);
      return;
    }
    // A newer message, such as the result of an operation started at once,
    // is not overwritten. A held outcome is added to it, or held again while
    // the library is hidden.
    if (notice) {
      // A lock under way replaces whatever is written now.
      if (outcome && libraryShown && !lockingRef.current)
        setNotice(`${notice} ${outcome}`);
      else holdOutcome();
      setLibraryNotice(null);
      return;
    }
    // Nor while an operation runs, for example under a picker: its own
    // result comes next, and the branch above then adds a held outcome to it.
    if (!libraryShown || busy) return;
    const armedIn = sessionRef.current;
    const timer = window.setTimeout(() => {
      // A lock that has landed, or is under way, but is not rendered yet:
      // leave the message for the branches above.
      if (sessionRef.current !== armedIn || lockingRef.current) return;
      setNotice([message, outcome].filter(Boolean).join(" "));
      setLibraryNotice(null);
    }, ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [busy, holdForUnlock, libraryNotice, libraryShown, notice, status]);

  const updateAutoLockMinutes = (value: unknown) => {
    const normalized = normalizeAutoLockMinutes(value);
    setAutoLockMinutes(normalized);
    persistAutoLockMinutes(normalized);
    setNotice(t("notice.autoLockSet", { count: normalized }));
  };

  // Shows a notice, and keeps it as the outcome of a transfer under way.
  const report = (message: string) => {
    transferOutcomeRef.current = message;
    setNotice(message);
  };

  // Clinic work runs beside library operations. While one of them runs, a
  // picker or transfer included, the line belongs to its result: a clinic
  // result waits and is added after it (see `run`), so neither is lost.
  // Clinic work clears the line when it starts, so anything on it when a
  // result arrives was written by other work since, and is kept. Nothing is
  // said for a session that has ended or is locking.
  const addNotice = (message: string) =>
    setNotice((shown) => (shown ? `${shown} ${message}` : message));
  const showPortalNotice = (startedIn: number, message: string) => {
    // A hidden screen after a failed lock shows nothing new; only a lock,
    // which ends this session, can leave it.
    if (
      sessionRef.current !== startedIn ||
      lockingRef.current ||
      concealedRef.current
    )
      return;
    if (transferHold.running) {
      portalNoticeRef.current = message
        ? { session: startedIn, message }
        : null;
      return;
    }
    if (message) addNotice(message);
    else setNotice("");
  };

  /** Runs a vault operation; `boxes` names what the patient typed for it,
   * so that a refusal of it says which box to check. Clinic work clears the
   * line when it starts, except work the patient did not ask for
   * (`"quiet"`), which leaves what the line says. */
  const run = async (
    operation: () => Promise<void>,
    boxes?: BoxKey[],
    clinicOperation: boolean | "quiet" = false,
  ) => {
    const startedIn = sessionRef.current;
    if (!clinicOperation) {
      setBusy(true);
      setNotice("");
      transferHold.operationStarted();
    } else if (clinicOperation !== "quiet") showPortalNotice(startedIn, "");
    try {
      await operation();
    } catch (error) {
      if (clinicOperation) {
        // Clinic HTTP is cancellable and does not hold a readable transfer.
        // A stale reply has nothing to say in a locked or different session.
        if (sessionRef.current !== startedIn || lockingRef.current) return;
        if (isLockedError(error) || isCancelledError(error)) {
          lockReasonRef.current ??= "idle";
          requestLock(true);
        } else showPortalNotice(startedIn, vaultErrorMessage(error));
        return;
      }
      // The unlock screen is also shown when the startup status check fails,
      // and after a failed set-aside. If there is no vault after all, offer to
      // create one: nothing on the unlock screen can succeed, and only a
      // restart would otherwise leave it.
      if (isMissingVaultError(error)) {
        setStatus((current) => (current === "locked" ? "absent" : current));
        setNotice(vaultErrorMessage(error));
        return;
      }
      // Failures that only say the vault locked, or that a lock cut the
      // operation off.
      const lockedOut = isLockedError(error) || isCancelledError(error);
      // A backup a lock cut off where it may have left something to act on
      // (an Android document, emptied as it was opened): told after the
      // next unlock, however the lock came. Only a backup's failure carries
      // such a note.
      const note = lockedOut ? vaultErrorNote(error) : null;
      const cutOff = note ? t("notice.backupCutOff", { note }) : null;
      if (sessionRef.current !== startedIn) {
        // The vault locked while this ran. Report a failure that left
        // something to act on: a transfer's, such as a partial copy, after the
        // next unlock; any other now, as the person who asked for it is here.
        if (!lockedOut) {
          if (transferHold.active)
            holdForUnlock(vaultErrorMessage(error, boxes));
          else setNotice(vaultErrorMessage(error, boxes));
        } else if (cutOff) holdForUnlock(cutOff);
        return;
      }
      // A lock under way cancelled it, and says so itself when it finishes;
      // what a cut-off backup may have left is kept for after the unlock.
      if (lockingRef.current && (cutOff || isCancelledError(error))) {
        if (cutOff) holdForUnlock(cutOff);
        return;
      }
      if (lockedOut && status === "unlocked") {
        // The native idle deadline locked the vault, or tried to, for example
        // while this screen was suspended: a command then fails as locked, and
        // a transfer it cut off as cancelled (a provider export's write pass
        // as a partial copy instead, handled below). Lock here too, which also
        // confirms it.
        // What a cut-off backup left is held for the next unlock, which a
        // failed lock does not lose (it shows it, or waits for a later one).
        if (cutOff) holdForUnlock(cutOff);
        else if (isCancelledError(error))
          report(t("notice.transferUnfinished"));
        lockReasonRef.current ??= "idle";
        requestLock(true);
        return;
      }
      report(vaultErrorMessage(error, boxes));
      // A transfer failure that is neither "locked" nor "cancelled" can still
      // mean the native deadline locked the vault (a provider export's partial
      // copy): confirm, and lock so that the lock keeps it.
      if (transferHold.active && status === "unlocked") {
        const now = await bridge.status().catch(() => null);
        if (now === "locked" && sessionRef.current === startedIn) {
          lockReasonRef.current ??= "idle";
          requestLock(true);
        }
      }
    } finally {
      if (!clinicOperation) {
        setBusy(false);
        const idle = transferHold.operationEnded();
        if (idle && lockHeldRef.current) requestLock(true);
        else if (idle && portalNoticeRef.current) {
          // The operation has reported: add the clinic result kept meanwhile.
          const held = portalNoticeRef.current;
          portalNoticeRef.current = null;
          if (
            held.session === sessionRef.current &&
            !lockingRef.current &&
            !concealedRef.current
          )
            addNotice(held.message);
        }
      }
    }
  };

  // Shared by both clinic controls, and kept across library navigation. The
  // synchronous reservation precedes the callback; repeated clicks join the
  // same work without starting another link or approval request.
  const portalSession = sessionRef.current;
  const runPortal = (
    operation: () => Promise<void>,
    { quiet = false }: { quiet?: boolean } = {},
  ): Promise<void> => {
    const startedIn = portalSession;
    if (sessionRef.current !== startedIn || lockingRef.current)
      return Promise.resolve();
    const active = portalJobRef.current;
    if (active?.session === startedIn) return active.promise;
    const job: { session: number; promise: Promise<void> } = {
      session: startedIn,
      promise: Promise.resolve()
        .then(async () => {
          // An automatic status check under way finishes first: the native
          // side admits one clinic operation at a time, and the patient's own
          // action must not be refused because of a check they did not ask
          // for. A check only reads from the portal (it saves the clinic's
          // answer), and its HTTP has its own time limit.
          const poll = portalPollRef.current;
          if (poll?.session === startedIn) await poll.promise;
          if (sessionRef.current !== startedIn || lockingRef.current) return;
          await run(operation, undefined, quiet ? "quiet" : true);
        })
        .finally(() => {
          if (portalJobRef.current === job) {
            portalJobRef.current = null;
            setPortalBusy(false);
          }
        }),
    };
    portalJobRef.current = job;
    setPortalBusy(true);
    return job.promise;
  };

  // The clinic view's automatic approval status check (#131). It is quiet:
  // no "working" state and no message of its own (the view says what
  // changed). It never waits behind other clinic work, or another check: it
  // is skipped while one runs. The patient's own clinic action waits for a
  // check under way instead (see `runPortal`). It belongs to this session: a
  // reply after a lock, or in another session, is dropped. A check is not
  // activity that keeps the vault open: it does not read the whole vault
  // again (a snapshot counts as activity), but updates the one device it
  // checked in the vault on screen. The one exception is read-only
  // recovery during a check: then the vault is read again, once, so that
  // the whole library shows it.
  const pollApproval: PollApproval = (linkId) => {
    const startedIn = portalSession;
    if (
      !bridge.refreshDeviceApproval ||
      sessionRef.current !== startedIn ||
      lockingRef.current ||
      concealedRef.current ||
      portalJobRef.current ||
      portalPollRef.current
    )
      return Promise.resolve(null);
    const current = () =>
      sessionRef.current === startedIn && !lockingRef.current;
    const promise = bridge.refreshDeviceApproval(linkId).then(
      (result): ApprovalPoll => {
        if (!current()) return null;
        setSnapshot((shown) => {
          const links = shown?.portalLinks;
          const before = links?.find((link) => link.id === result.link.id);
          // Unchanged: the vault on screen stays the same object.
          if (!shown || !links || !before) return shown;
          if (JSON.stringify(before) === JSON.stringify(result.link))
            return shown;
          return {
            ...shown,
            portalLinks: links.map((link) =>
              link.id === result.link.id ? result.link : link,
            ),
          };
        });
        // A save during the check reached only one copy: the vault is now
        // read-only, and everything on screen must show it.
        if (result.recovery) void refresh().catch(() => undefined);
        return { check: result };
      },
      (error): ApprovalPoll => {
        if (!current()) return null;
        // The native idle deadline locked the vault, or a lock cut the check
        // off: lock here too, as for any clinic operation.
        if (isLockedError(error) || isCancelledError(error)) {
          lockReasonRef.current ??= "idle";
          requestLock(true);
          return null;
        }
        if (isRecoveryModeError(error)) void refresh().catch(() => undefined);
        return { error };
      },
    );
    const entry = { session: startedIn, promise };
    portalPollRef.current = entry;
    void promise.finally(() => {
      if (portalPollRef.current === entry) portalPollRef.current = null;
    });
    return promise;
  };

  // These are handed to the library, which unmounts on lock. A call that is
  // still in flight then belongs to a finished session and is ignored.
  const refreshIssuedRef = useRef(0);
  const refreshAppliedRef = useRef(0);
  const session = sessionRef.current;
  const inSession = () => sessionRef.current === session;
  // `known` is the vault as a command that changed it returned it, taken
  // under the same guard as the change: nothing to ask again.
  const refresh = async (known?: VaultSnapshot) => {
    const request = ++refreshIssuedRef.current;
    const next = known ?? (await bridge.snapshot());
    // Received intake can refresh alongside a library action. An older reply
    // must not roll back a later successful result. Compare applied successes,
    // so a later failed request does not discard a usable earlier result.
    if (inSession() && request > refreshAppliedRef.current) {
      refreshAppliedRef.current = request;
      setSnapshot(next);
    }
    return next;
  };
  const setSessionNotice = (message: string) => {
    // Clearing the line is not a result: it must not replace a transfer's
    // outcome, shown or held.
    if (!message) {
      if (inSession()) setNotice("");
      return;
    }
    if (inSession()) report(message);
    // The lock that ended this transfer has landed: keep its result for
    // after the next unlock.
    else if (transferHold.active) holdForUnlock(message);
  };
  const setPortalNotice = (message: string) =>
    showPortalNotice(session, message);

  // One check for new clinic documents after an unlock (#128), in the
  // background, as Check for new documents does it: shared with the clinic
  // controls, which show it as running, and never beside other clinic work.
  // Only in a writable vault with clinic documents on, and with a device the
  // clinic has approved or a request still open: the native check reads each
  // request's status first, so a device approved while myCarlos was closed
  // receives its documents now. It never sends a request. It says something
  // only when documents arrived or the check needs attention. A lock ends
  // it, and what it finds then is not for that session.
  // The control that had focus as the check after unlocking started.
  const startFocusRef = useRef<Element | null>(null);
  const checkAfterUnlock = () => {
    const startedIn = session;
    const links = snapshot?.portalLinks ?? [];
    const approved = new Set(
      links
        .filter((link) => !link.incomplete && link.clinicApproved)
        .map((link) => link.id),
    );
    if (
      // As for the clinic controls, which name its retry.
      !snapshot?.portalLinkingEnabled ||
      !bridge.connectPortal ||
      !bridge.checkDocuments ||
      snapshot.recovery ||
      // No saved request, or one refused or ended, is not a reason to ask.
      (approved.size === 0 && !links.some(isAwaitingApproval)) ||
      // A check for new documents since this unlock, the patient's own,
      // stands in for it.
      documentCheckSessionRef.current === startedIn
    )
      return;
    // Other clinic work under way, such as linking or an approval request:
    // the check follows it, still once.
    const active = portalJobRef.current;
    if (active?.session === startedIn) {
      void active.promise.then(() =>
        setUnlockCheck(
          (due) => due ?? { session: startedIn, offerOpen: false },
        ),
      );
      return;
    }
    // The check asks each clinic that approved this device or has a request
    // open, and no other (Ben, D132c): one of those whose portal asked to
    // wait is not asked before then. Said, as the check did not run; checking
    // again now could not help.
    if (
      links.some(
        (link) =>
          (approved.has(link.id) || isAwaitingApproval(link)) &&
          portalWaits.waiting(link.portalBase),
      )
    ) {
      showPortalNotice(startedIn, unlockCheckWaitingText());
      return;
    }
    const current = () =>
      sessionRef.current === startedIn && !lockingRef.current;
    const check = () =>
      checkClinicDocuments({
        bridge: trackedBridge,
        links,
        waits: portalWaits,
        refresh,
      });
    // An ended session's work returns soon: the lock cancels its HTTP, which
    // has its own time limits too.
    const ended = endedPortalWorkRef.current;
    const focused = document.activeElement;
    const before = portalJobRef.current;
    void runPortal(
      async () => {
        await ended;
        if (!current()) return;
        let message: string;
        try {
          let found: Awaited<ReturnType<typeof check>>;
          try {
            found = await check();
          } catch (error) {
            if (!hasVaultErrorCode(error, "portal_busy")) throw error;
            // Other clinic work holds the native side. Once what this app
            // knows of has returned, and a moment more, it is asked once
            // again.
            await Promise.all([
              endedPortalWorkRef.current,
              new Promise((done) => window.setTimeout(done, BUSY_RETRY_MS)),
            ]);
            if (!current()) return;
            found = await check();
          }
          // A device the clinic approved during the check counts too.
          for (const link of found.vault.portalLinks ?? [])
            if (link.clinicApproved) approved.add(link.id);
          message = unlockCheckText(found.result, (id) => approved.has(id));
        } catch (error) {
          // The vault locked: `run` locks here too, as for all clinic work.
          if (isLockedError(error) || isCancelledError(error)) throw error;
          message = hasVaultErrorCode(error, "portal_busy")
            ? unlockCheckNotRunText()
            : unlockCheckFailedText(error);
        }
        if (message) showPortalNotice(startedIn, message);
      },
      { quiet: true },
    );
    // Started now: a control it is about to disable may have focus.
    if (portalJobRef.current && portalJobRef.current !== before)
      startFocusRef.current = focused === document.body ? null : focused;
  };
  useEffect(() => {
    if (!unlockCheck) return;
    if (unlockCheck.session !== sessionRef.current || status !== "unlocked") {
      setUnlockCheck(null);
      return;
    }
    // Once the library has given the unlock's own message, so that what the
    // check finds comes after it and is read out; never under the recovery
    // key offer, whose status line is hidden.
    if (!libraryShown || libraryNotice || unlockCheck.offerOpen) return;
    setUnlockCheck(null);
    checkAfterUnlock();
    // The check is started from the render that allows it.
  }, [libraryNotice, libraryShown, status, unlockCheck]);
  // If the render that shows the check running disabled the control that
  // had focus, focus would be left on nothing: it goes to that control's
  // heading instead (see `headingFor`). Focus is moved in no other case: not
  // for the patient's own clinic work, and not when the control stays
  // usable.
  useLayoutEffect(() => {
    const control = startFocusRef.current;
    startFocusRef.current = null;
    if (!control || !portalBusy) return;
    const active = document.activeElement;
    if (active !== control && active !== document.body && active !== null)
      return;
    if (control.isConnected && !control.matches(":disabled")) return;
    headingFor(control)?.focus();
  }, [portalBusy]);
  // The library has given the message of the recovery key offer the unlock
  // opened on: the check follows it.
  const offerClosed = () =>
    setUnlockCheck((due) =>
      due?.session === sessionRef.current && due.offerOpen
        ? { session: due.session, offerOpen: false }
        : due,
    );

  // Waiting files go into Shared with me as soon as the vault is open (#61).
  // One that is not a PDF is not added and is named; anything else keeps them
  // all waiting for the next ask.
  const accepting = useRef(false);
  acceptSharedRef.current = async () => {
    if (status !== "unlocked" || accepting.current) return;
    accepting.current = true;
    try {
      const outcome = await bridge.acceptReceived();
      if (!inSession()) return;
      setReceived([]);
      if (outcome.imported.length) {
        await refresh();
        setSharedNew((count) => count + outcome.imported.length);
      }
      const said = [
        ...outcome.notPdf.map(
          (name) =>
            `${name} is not a PDF document, so myCarlos did not add it. For now only PDF documents can be shared to myCarlos.`,
        ),
        ...outcome.skippedDuplicates.map(
          (name) => `${name} was already in Shared with me.`,
        ),
      ];
      if (said.length) setSessionNotice(said.join(" "));
    } catch {
      // They keep waiting: the next ask tries again.
    } finally {
      accepting.current = false;
    }
  };
  useEffect(() => {
    if (status === "unlocked") void refreshReceived();
    else setSharedNew(0);
  }, [refreshReceived, status]);

  // A restored vault is locked: it opens with its own passphrase or key.
  const restored = () => {
    forgetReplacedVault();
    setStatus("locked");
    setNotice(t("notice.restored"));
  };

  if (status === "loading") {
    return (
      <VaultAuthFrame state="Opening">
        <p>Opening myCarlos…</p>
      </VaultAuthFrame>
    );
  }

  if (status === "absent" && !comfortChosen) {
    return (
      <ComfortSetup
        autoLockMinutes={autoLockMinutes}
        onAutoLockMinutes={(minutes) => {
          // Said by the control itself, not as a notice on the next screen.
          const normalized = normalizeAutoLockMinutes(minutes);
          setAutoLockMinutes(normalized);
          persistAutoLockMinutes(normalized);
        }}
        onDone={() => setComfortChosen(true)}
      />
    );
  }

  // A refusal of what was typed at setup names only a box holding text the
  // vault refuses (#69).
  const setupBoxes = (profile: string, passphrase: string) =>
    boxesWithControlCharacters([
      [profile, "box.name"],
      [passphrase, "box.passphrase"],
    ]);

  if (status === "absent") {
    return (
      <CreateVault
        busy={busy}
        notice={notice}
        checkRules={bridge.passphraseRules}
        restoreBridge={trackedBridge}
        onRestored={restored}
        onCreate={(profile, passphrase) =>
          run(
            async () => {
              setSnapshot(await bridge.create(passphrase, profile));
              // Nothing from a vault that is gone.
              pendingOutcomeRef.current = null;
              rememberUnfinishedRecoveryKey(null);
              rememberOldBackupsGuide(null);
              // The passphrase was just typed, so it authorizes the recovery key
              // at once. If that fails, the library offers to set one up.
              const begun = await bridge.beginRecoveryKey(passphrase).then(
                (key) => ({ key, locked: false }),
                (error: unknown) => ({
                  key: null,
                  locked: isLockedError(error),
                }),
              );
              if (begun.locked) {
                // The vault locked meanwhile (its automatic lock): it is shown
                // locked, not open on what the lock ended.
                setSnapshot(null);
                setStatus("locked");
                setNotice(t("notice.createdThenLocked"));
                return;
              }
              const recoveryKey = begun.key;
              setOpeningRecoverySetup(
                recoveryKey ? { vault: "created", key: recoveryKey } : null,
              );
              setConcealed(false);
              setStatus("unlocked");
              // With a key to set up, its dialog says what happened instead.
              if (!recoveryKey)
                setLibraryNotice({
                  message: t("notice.created"),
                  outcome: null,
                });
            },
            setupBoxes(profile, passphrase),
          )
        }
      />
    );
  }

  if (status === "locked" || !snapshot) {
    return (
      <UnlockVault
        busy={busy}
        notice={notice}
        waiting={received.length}
        restoreBridge={trackedBridge}
        onRestored={restored}
        autoLockMinutes={autoLockMinutes}
        onUnlock={(passphrase) =>
          run(async () => {
            const current = await bridge.unlock(passphrase);
            const outcome = takeHeldOutcome(current);
            // A vault without a recovery key is one forgotten passphrase from
            // being set aside for good, so the library opens on the offer of
            // one, at most once a day. No key is made until the patient asks:
            // one shown unasked could be seen by whoever is looking on. Not on
            // a vault that cannot store one, and not over something held for
            // this unlock (a transfer's result, how a key setup ended), which
            // comes first.
            const offer =
              !current.recovery &&
              !current.recoveryKeySetAtMs &&
              !outcome &&
              recoveryOfferDue(Date.now());
            if (offer) recordRecoveryOffer(Date.now());
            setOpeningRecoverySetup(offer ? { vault: "unlocked" } : null);
            setSnapshot(current);
            setConcealed(false);
            setStatus("unlocked");
            setUnlockCheck({
              session: sessionRef.current,
              offerOpen: Boolean(offer),
            });
            // With the offer open, its dialog says that the vault is open,
            // and the library gives the result when the dialog closes: one
            // written under the dialog would not be read out, and would
            // take the place of what the dialog has to say on closing.
            if (offer) return;
            setLibraryNotice({
              message: current.recovery
                ? t("notice.unlockedRecovery")
                : t("notice.unlocked"),
              outcome,
            });
          }, ["box.passphrase"])
        }
        onRecover={(recoveryKey, newPassphrase) =>
          run(async () => {
            const { passphraseReplaced, snapshot: current } =
              await bridge.recover(recoveryKey, newPassphrase);
            // A vault opened with its recovery key has one.
            setOpeningRecoverySetup(null);
            setSnapshot(current);
            setConcealed(false);
            setStatus("unlocked");
            setUnlockCheck({ session: sessionRef.current, offerOpen: false });
            const outcome = takeHeldOutcome(current);
            setLibraryNotice({
              message: passphraseReplaced
                ? t("notice.recovered")
                : t("notice.recoveredReadOnly"),
              outcome,
            });
          }, ["box.recoveryKey", "box.newPassphrase"])
        }
        onReset={(confirmation) =>
          run(async () => {
            if (await bridge.reset(confirmation)) {
              pendingOutcomeRef.current = null;
              rememberUnfinishedRecoveryKey(null);
              rememberOldBackupsGuide(null);
              // Starting again starts with the comfort settings, as a fresh
              // start of the app does.
              setComfortChosen(false);
              setStatus("absent");
              setNotice("");
            } else {
              setNotice(t("notice.eraseCancelled"));
            }
          }, ["box.typedWords"])
        }
      />
    );
  }

  if (concealed) {
    if (lockHeld && !lockFailed)
      return (
        <VaultAuthFrame state="Locking">
          <section className="vault-card" aria-labelledby="hold-title">
            <h1 id="hold-title">Finishing the transfer</h1>
            <p role="status">
              Vault content is hidden. myCarlos will lock as soon as the
              transfer finishes.
            </p>
            <button
              className="button"
              type="button"
              onClick={() => requestLock(true)}
            >
              Lock now and cancel the transfer
            </button>
          </section>
        </VaultAuthFrame>
      );
    return lockFailed ? (
      <VaultAuthFrame state="Not locked">
        <p role="alert">
          myCarlos could not lock the vault. Its content is hidden, but the
          vault is still open. {notice}
        </p>
        <button
          className="button primary"
          type="button"
          onClick={() => requestLock(true)}
        >
          Try locking again
        </button>
      </VaultAuthFrame>
    ) : (
      <VaultAuthFrame state="Locked">
        <p>Vault content is hidden while myCarlos finishes locking…</p>
      </VaultAuthFrame>
    );
  }

  return (
    <>
      <VaultLibrary
        bridge={trackedBridge}
        snapshot={snapshot}
        busy={busy}
        notice={notice}
        setNotice={setSessionNotice}
        run={run}
        portalBusy={portalBusy}
        runPortal={runPortal}
        pollApproval={bridge.refreshDeviceApproval ? pollApproval : undefined}
        approvalWaits={portalWaits}
        setPortalNotice={setPortalNotice}
        refresh={refresh}
        onLock={lockAsked}
        onRequestLock={requestLockAsked}
        autoLockMinutes={autoLockMinutes}
        onAutoLockMinutes={updateAutoLockMinutes}
        openingRecoverySetup={openingRecoverySetup}
        onOpeningRecoverySetupShown={() => setOpeningRecoverySetup(null)}
        onOfferClosed={offerClosed}
        onUnfinishedRecoveryKey={rememberUnfinishedRecoveryKey}
        canPrint={DESKTOP_PLATFORMS.has(platform)}
        keyboardHints={DESKTOP_PLATFORMS.has(platform)}
        computer={DESKTOP_PLATFORMS.has(platform)}
        sizesIn1024s={platform === "windows"}
        cameraPlatform={CAMERA_PLATFORMS.has(platform) ? platform : null}
        cameraAsking={isPhone(platform) ? track : undefined}
        covered={lockWarning !== null}
        sharedNew={sharedNew}
        onSharedSeen={clearSharedNew}
      />
      {lockWarning !== null && (
        <LockWarning
          seconds={lockWarning}
          onKeepOpen={() => keepOpenRef.current()}
        />
      )}
    </>
  );
}

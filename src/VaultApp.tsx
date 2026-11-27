import {
  useTextState,
  deferredText,
  t as translateCurrent,
  useI18n,
  t,
  t as translateNow,
  message,
  type UiText,
  joinText,
} from "./i18n";
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
  NATIVE_READER_ACTIVITY_EVENT,
  isRestoreUnfinished,
  vaultErrorMessage,
  vaultErrorNote,
  type ReceivedFile,
  type SnapshotCapture,
  type PortalLinkSummary,
  type VaultBridge,
  type VaultSnapshot,
  type VaultStatus,
  type BoxKey,
} from "./vault";
import { receiveNoticeText, sharedAddedText } from "./native/receivedNotice";
import { VaultAuthFrame, CreateVault, UnlockVault } from "./native/VaultAuth";
import { LockWarning } from "./native/LockWarning";
import { useAddVideo } from "./native/useAddVideo";
import { ComfortSetup } from "./native/ComfortSetup";

import { ConfirmDialog } from "./native/ConfirmDialog";
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
  rememberUnfinishedHandover,
  takeUnfinishedHandover,
} from "./native/unfinishedHandover";
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
  NATIVE_READER_ACTIVITY_EVENT,
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
// Dispatched on the document when an AI answer this app asked for settles.
const ANSWER_SETTLED_EVENT = "mycarlos:answer-settled";
type AnswerActivity = { id: string; epoch: number; heldUntil: number };
// An AI answer being written counts as activity until it ends (D19), for at
// most its own limit, which native says once the answer is asked
// (`onAiAnswerStarted`). Until then, while the helper may be starting, for
// at most the longest limit (native `ANSWER_LIMIT.ceiling`).
const ANSWER_HOLD_MAX_MS = 20 * 60 * 1000;
// User input is reported to the native idle deadline at most this often, so the
// last report is less than 10 seconds before the last input. The native
// deadline fires the delay plus 15 seconds after the last report, so at least
// 5 seconds after this screen's own deadline (the native 2-second check only
// adds to that).
const TOUCH_THROTTLE_MS = 10_000;
// The check after unlocking, refused because other clinic work held the
// native side, asks once more this long after that work returned (#128).
const BUSY_RETRY_MS = 2_000;

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
  useI18n();
  if (!bridge.native) return <App />;
  return <NativeVault bridge={bridge} />;
}

function NativeVault({ bridge }: { bridge: VaultBridge }) {
  useI18n();
  const [status, setStatusState] = useState<VaultStatus | "loading">("loading");
  const statusRef = useRef(status);
  const answerEpochRef = useRef(0);
  const answerRef = useRef<AnswerActivity | null>(null);
  // Rotate synchronously on successful session transitions, including a lock
  // observed natively. A failed lock leaves the current session intact.
  const setStatus = useCallback(
    (
      next:
        | VaultStatus
        | "loading"
        | ((current: VaultStatus | "loading") => VaultStatus | "loading"),
    ) => {
      const previous = statusRef.current;
      const value = typeof next === "function" ? next(previous) : next;
      if (
        previous !== value &&
        (previous === "unlocked" || value === "unlocked")
      ) {
        answerEpochRef.current += 1;
        answerRef.current = null;
      }
      statusRef.current = value;
      setStatusState(value);
    },
    [],
  );
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null);
  const [notice, setNotice, noticeValue] = useTextState();
  // Locked, show only the waiting count. Unlocked, import into Shared with me.
  // One list at a time; an arrival during a list asks for another pass, even
  // when this window was already focused (#53). An import is not waited for
  // here: `acceptShared` takes one at a time and asks again once it is done, so
  // a pending import never holds back a later list, including a new session's.
  const [received, setReceived] = useState<ReceivedFile[]>([]);
  const acceptSharedRef = useRef<(ids?: string[]) => Promise<boolean | void>>(
    async () => undefined,
  );
  // Files named by a program started with their path (Open with, a second launch) wait here for
  // the patient's answer before anything is stored (#133). Cancel forgets them.
  // Whether the "Import ... into Shared with me?" question is open, set at once (state is not).
  const confirmOpen = useRef(false);
  const [confirmReceived, setConfirmReceived] = useState<ReceivedFile[] | null>(
    null,
  );
  const receiveGeneration = useRef(0);
  const refreshReceivedRef = useRef<() => Promise<void>>(async () => undefined);
  const refreshReceived = useCallback(() => refreshReceivedRef.current(), []);
  // Files added since unlock, until the patient opens Shared with me.
  const [sharedNew, setSharedNew] = useState(0);
  const clearSharedNew = useCallback(() => setSharedNew(0), []);
  useEffect(() => {
    receiveGeneration.current += 1;
    let disposed = false;
    let dirty = false;
    let running: Promise<void> | null = null;
    const request = (): Promise<void> => {
      dirty = true;
      if (disposed || document.visibilityState !== "visible")
        return Promise.resolve();
      if (!running) {
        running = (async () => {
          while (dirty && !disposed && document.visibilityState === "visible") {
            dirty = false;
            try {
              const { files, notice: missed } = await bridge.listReceived();
              if (disposed) return;
              setReceived(files);
              const text = receiveNoticeText(missed);
              if (text)
                setNotice(deferredText(() => receiveNoticeText(missed)));
              const ask = files.filter((file) => file.needsConfirm);
              if (ask.length) {
                // The question in front of the patient is never changed under their cursor: a
                // file that arrives while it is open waits, and is asked about after the answer
                // (the answer asks again).
                // Only in an unlocked session: native code tells a locked page how many files wait
                // and no name, so a question opened from that list would be asked, after the next
                // unlock, with blank names; the unlock lists again and asks then.
                if (!confirmOpen.current && statusRef.current === "unlocked") {
                  confirmOpen.current = true;
                  setConfirmReceived(ask);
                }
                // Anything shared from another app is added as it arrives, as before.
                const shared = files.filter((file) => !file.needsConfirm);
                if (shared.length)
                  void acceptSharedRef.current(shared.map((file) => file.id));
              } else if (files.length) void acceptSharedRef.current();
            } catch {
              // No automatic retry. A later arrival/focus/unlock asks again.
            }
          }
        })().finally(() => {
          running = null;
        });
      }
      return running;
    };
    refreshReceivedRef.current = request;
    const onVisible = () => {
      if (document.visibilityState === "visible") void request();
    };
    window.addEventListener("mycarlos-received-changed", request);
    window.addEventListener("focus", request);
    document.addEventListener("visibilitychange", onVisible);
    void request();
    return () => {
      disposed = true;
      receiveGeneration.current += 1;
      refreshReceivedRef.current = async () => undefined;
      window.removeEventListener("mycarlos-received-changed", request);
      window.removeEventListener("focus", request);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [bridge]);
  // A message for the library that unlocking or creating the vault is about to
  // show. Its status line reads out only what changes once it is on screen, so
  // the message is written just after (see the effect below).
  const [libraryNotice, setLibraryNotice] = useState<{
    message: UiText;
    // What was held for this unlock: the result of a transfer that a lock
    // ended, or how a key setup it ended ended. It must reach the patient:
    // it may say a readable copy was left behind, or which key to keep.
    outcome: UiText | null;
  } | null>(null);
  // The library opens on the recovery key setup: for a vault just created,
  // with its key, before anything else; for a vault unlocked without one, as
  // an offer that can be left for later.
  const [openingRecoverySetup, setOpeningRecoverySetup] =
    useState<OpeningRecoverySetup | null>(null);
  const [busy, setBusy] = useState(false);
  // Library operations in flight, counted by the session they started in. `busy` is only about
  // the session now shown: a lock ends the session, so an operation of the one before (a picker
  // the patient left open, whose answer never came) can neither keep the unlock screen's button
  // greyed nor stand in for work that is not being done now. The operation itself runs on, and
  // its result is still handled where it is (see `run`).
  const runsBySessionRef = useRef(new Map<number, number>());
  const [portalBusy, setPortalBusy] = useState(false);
  const portalJobRef = useRef<{
    session: number;
    promise: Promise<void>;
  } | null>(null);
  // A clinic result that arrives while a library operation runs, shown after
  // that operation's own result rather than in its place.
  const portalNoticeRef = useRef<{ session: number; message: UiText } | null>(
    null,
  );
  const photoNoticeSessionRef = useRef<number | null>(null);
  // Per portal, when automatic approval checks may ask it again after it
  // asked to wait (#131): kept across the clinic view's remounts, and
  // forgotten when the session ends.
  const [portalWaits, setPortalWaits] = useState(() => new PortalWaits());
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
  const endedPortalWorkRef = useRef<Promise<void>>(Promise.resolve());
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
  // Video being recorded or played holds the automatic lock for as long as it
  // runs (#359): how many holds are taken now. A lock ends them all.
  const mediaHoldsRef = useRef(new Set<symbol>());
  const holdMedia = useCallback(() => {
    // Each hold is its own id, so letting go twice, or after a lock ended them
    // all, cannot take away another's.
    const hold = Symbol("media hold");
    mediaHoldsRef.current.add(hold);
    return () => {
      mediaHoldsRef.current.delete(hold);
    };
  }, []);
  // What was last reported since the latest transfer began: its result, or a
  // partial readable copy to delete. Used only when a lock ends that transfer.
  const transferOutcomeRef = useRef<UiText | null>(null);
  // `flushPortalNotice` is made again on every render; the bridge below is not, so it reaches
  // the current one through this ref.
  const flushPortalNoticeRef = useRef<() => void>(() => undefined);
  // The outcome of a transfer the vault locked on. It is shown after the next
  // unlock, not on the unlock screen, where anyone at the device could read it.
  const pendingOutcomeRef = useRef<UiText | null>(null);
  // A late share may finish while a failed lock keeps the window concealed.
  // Retain its explanation/accounting for an authorized unlock of this bridge.
  const pendingSharedOutcomeRef = useRef<{
    generation: number;
    message: UiText;
  } | null>(null);
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
  const refreshBusy = useCallback(
    () => setBusy((runsBySessionRef.current.get(sessionRef.current) ?? 0) > 0),
    [],
  );
  const appliedCaptureRef = useRef<
    (SnapshotCapture & { owner: number }) | null
  >(null);
  // A status poll captures one device, not the rest of the vault. Keep its
  // order separately so an older whole read can still bring new records.
  const approvalCapturesRef = useRef(
    new Map<
      string,
      { owner: number; capture: SnapshotCapture; link: PortalLinkSummary }
    >(),
  );
  const mergeApprovalCaptures = (next: VaultSnapshot, owner: number) => {
    let changed = false;
    const links = next.portalLinks?.map((link) => {
      const partial = approvalCapturesRef.current.get(link.id);
      if (
        partial?.owner === owner &&
        partial.capture.epoch === next.capture.epoch &&
        partial.capture.sequence > next.capture.sequence
      ) {
        changed = true;
        return partial.link;
      }
      return link;
    });
    for (const [id, partial] of approvalCapturesRef.current)
      if (
        partial.owner !== owner ||
        partial.capture.epoch !== next.capture.epoch ||
        partial.capture.sequence <= next.capture.sequence
      )
        approvalCapturesRef.current.delete(id);
    return changed ? { ...next, portalLinks: links } : next;
  };
  const installOpeningSnapshot = (next: VaultSnapshot) => {
    approvalCapturesRef.current.clear();
    appliedCaptureRef.current = {
      ...next.capture,
      owner: sessionRef.current,
    };
    setSnapshot(next);
  };

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
        setNotice(
          deferredText(() =>
            translateCurrent("notice.dropRefused", {
              // The import button, named as the library shows it ("New").
              button: translateCurrent("interface.VaultLibrary.new"),
            }),
          ),
        );
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
  const holdForUnlock = useCallback((outcome: UiText, first = false) => {
    const held = pendingOutcomeRef.current;
    pendingOutcomeRef.current = first
      ? joinText(outcome, held)
      : joinText(held, outcome);
  }, []);

  // Nothing held for the next unlock is about a vault a restore replaces:
  // not a transfer's outcome, nor how a key setup ended.
  const forgetReplacedVault = () => {
    pendingOutcomeRef.current = null;
    pendingSharedOutcomeRef.current = null;
    rememberUnfinishedRecoveryKey(null);
    rememberOldBackupsGuide(null);
    // The unscoped note: no caller passes a scope today (a test pins that). When vaults get
    // their own slots (#357) and the notes are scoped, this must clear the erased vault's own
    // scope, never every scope by prefix: that would wipe another vault's note.
    rememberUnfinishedHandover(false);
  };

  // Taken as a vault opens: what happened while it was locked, and how a
  // recovery key setup that a lock or closing ended actually ended.
  const takeHeldOutcome = (opened: VaultSnapshot) => {
    const shared = pendingSharedOutcomeRef.current;
    pendingSharedOutcomeRef.current = null;
    const unfinished = takeUnfinishedRecoveryKey();
    // A key whose kit may have been exposed was replaced as the lock fell:
    // Security shows the steps for its older backups, as after a
    // replacement the patient saw finish.
    if (
      unfinished &&
      exposedKeyReplaced(unfinished, opened.recoveryKeySetAtMs ?? null)
    )
      rememberOldBackupsGuide({ step: "save" });
    // Whether an unfinished setup has a result is independent of language.
    // Keep an absent result absent; a deferred empty string is still an object.
    const hasUnfinishedOutcome =
      unfinished !== null &&
      unfinishedRecoveryKeyMessage(
        unfinished,
        opened.recoveryKeySetAtMs ?? null,
        Boolean(opened.recovery),
      ) !== null;
    const sharedOutcome =
      shared?.generation === receiveGeneration.current ? shared.message : null;
    const outcome =
      pendingOutcomeRef.current || sharedOutcome || hasUnfinishedOutcome
        ? joinText(
            pendingOutcomeRef.current,
            sharedOutcome,
            hasUnfinishedOutcome && unfinished
              ? deferredText(
                  () =>
                    unfinishedRecoveryKeyMessage(
                      unfinished,
                      opened.recoveryKeySetAtMs ?? null,
                      Boolean(opened.recovery),
                    ) ?? "",
                )
              : null,
          )
        : null;
    pendingOutcomeRef.current = null;
    // A handover whose key was shown when the lock fell: the key opens nothing now.
    if (takeUnfinishedHandover())
      return joinText(
        outcome,
        deferredText(() => t("handover.unfinished")),
      );
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
      // The session shown from here has no operation of its own yet.
      transferHold.moveTo(sessionRef.current);
      refreshBusy();
      endedPortalWorkRef.current = Promise.allSettled([
        endedPortalWorkRef.current,
        portalJobRef.current?.promise,
        portalPollRef.current?.promise,
      ]).then(() => undefined);
      portalJobRef.current = null;
      portalPollRef.current = null;
      setPortalWaits(new PortalWaits());
      portalNoticeRef.current = null;
      photoNoticeSessionRef.current = null;
      setPortalBusy(false);
      setUnlockCheck(null);
      appliedCaptureRef.current = null;
      approvalCapturesRef.current.clear();
      setSnapshot(null);
      // A key shown but not set up ended with the session.
      setOpeningRecoverySetup(null);
      setConcealed(false);
      setLockFailed(false);
      holdLock(false);
      mediaHoldsRef.current.clear();
      setStatus("locked");
      if (endsTransfer && transferOutcomeRef.current)
        holdForUnlock(transferOutcomeRef.current);
      // Why, without anything of the records (#68).
      const reason = lockReasonRef.current;
      lockReasonRef.current = null;
      const minutes = autoLockMinutesRef.current;
      setNotice(
        deferredText(() =>
          reason === "idle"
            ? translateCurrent("notice.lockedIdle", { count: minutes })
            : reason === "hidden"
              ? translateCurrent("notice.lockedHidden")
              : translateCurrent("notice.locked"),
        ),
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
        deferredText(() =>
          held
            ? joinText(
                deferredText(() => vaultErrorMessage(error)),
                held,
              )
            : vaultErrorMessage(error),
        ),
      );
    } finally {
      lockingRef.current = false;
    }
  }, [bridge, holdForUnlock, holdLock, refreshBusy, transferHold]);

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
          if (active) installOpeningSnapshot(current);
        }
        if (active) setStatus(next);
      })
      .catch((error) => {
        if (!active) return;
        // The unlock screen is about to be shown, so no timer or background
        // lock will cover a native session that is still open. Close it.
        void bridge.lock().catch(() => undefined);
        if (active) {
          setNotice(deferredText(() => vaultErrorMessage(error)));
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
  // True only while the settled picker re-dispatches visibilitychange below.
  const pickerSettlingRef = useRef(false);
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
      // The automatic arrival check ignores this app-made event: the import
      // that follows, or the real focus/visibility event, asks native itself.
      pickerSettlingRef.current = true;
      try {
        document.dispatchEvent(new Event("visibilitychange"));
      } finally {
        pickerSettlingRef.current = false;
      }
    }
  }, []);
  // Only the current answer in this unlocked session can hold its deadline.
  // Establish ownership before invoking the bridge: its started event can be
  // delivered synchronously by an implementation of the bridge.
  const answering = useCallback(
    async <T,>(start: (answerId: string) => Promise<T>): Promise<T> => {
      const answer: AnswerActivity = {
        id: crypto.randomUUID(),
        epoch: answerEpochRef.current,
        heldUntil: Date.now() + ANSWER_HOLD_MAX_MS,
      };
      answerRef.current = answer;
      try {
        return await start(answer.id);
      } finally {
        if (
          answerRef.current === answer &&
          answer.epoch === answerEpochRef.current &&
          statusRef.current === "unlocked"
        ) {
          document.dispatchEvent(
            new CustomEvent(ANSWER_SETTLED_EVENT, { detail: answer }),
          );
          if (answerRef.current === answer) answerRef.current = null;
        }
      }
    },
    [],
  );
  useEffect(
    () =>
      bridge.onAiAnswerStarted?.(({ answerId, limitMs }) => {
        const answer = answerRef.current;
        if (
          !answer ||
          answer.id !== answerId ||
          answer.epoch !== answerEpochRef.current ||
          statusRef.current !== "unlocked" ||
          !Number.isFinite(limitMs)
        )
          return;
        answer.heldUntil =
          Date.now() + Math.min(Math.max(limitMs, 0), ANSWER_HOLD_MAX_MS);
      }),
    [bridge],
  );
  // A document is waiting at a clinic, as the tray check found it while the vault was locked
  // (#230). One fixed sentence on the unlock screen; it clears when the vault unlocks.
  const [trayWaiting, setTrayWaiting] = useState(false);
  useEffect(() => {
    let live = true;
    void bridge
      .trayWaiting?.()
      .then((waiting) => live && setTrayWaiting(waiting))
      .catch(() => undefined);
    const stop = bridge.onTrayWaiting?.((waiting) => setTrayWaiting(waiting));
    return () => {
      live = false;
      stop?.();
    };
  }, [bridge]);
  // The vault locked natively without this screen asking: the window was
  // closed to the tray, Quit was chosen, or the native idle lock fell due
  // (#206). The vault is already locked, so the screen lets go of everything
  // it shows at once, as its own lock does, whatever is in flight. It does not
  // wait for a `visibilitychange` that a hidden window may never get.
  const busyRef = useRef(false);
  busyRef.current = busy;
  // A native lock that arrives while an unlock is in flight (the window was closed to the tray
  // meanwhile): the vault is about to open, so the lock is remembered and applied the moment it
  // does. The native side refuses such an unlock too; this covers the screen's own part.
  const pendingNativeLockRef = useRef<"closed" | "idle" | null>(null);
  useEffect(
    () =>
      bridge.onVaultLocked?.(({ by }) => {
        if (statusRef.current !== "unlocked") {
          if (busyRef.current) pendingNativeLockRef.current = by;
          return;
        }
        lockReasonRef.current ??= by === "idle" ? "idle" : "hidden";
        requestLock(true);
      }),
    [bridge, requestLock],
  );
  useEffect(() => {
    const pending = pendingNativeLockRef.current;
    if (status === "unlocked" && pending) {
      pendingNativeLockRef.current = null;
      lockReasonRef.current ??= pending === "idle" ? "idle" : "hidden";
      requestLock(true);
    } else if (status !== "unlocked" && !busy) {
      pendingNativeLockRef.current = null;
    }
  }, [status, busy, requestLock]);
  const trackedBridge = useMemo<VaultBridge>(() => {
    // Every transfer is its own operation, bracketed here as `run` brackets its own, so that no
    // caller has to remember to: a transfer started outside `run` (the hand-over dialogs call the
    // bridge themselves) would otherwise leave the hold at "a transfer ran" for good, and an
    // automatic lock would hide the screen but never lock the vault. Inside `run` the operations
    // nest: the count only reaches zero at the outermost end, so `run` still locks once the
    // operation has reported the transfer's outcome. When the last operation is over the hold is
    // freed, and a lock owed meanwhile now happens.
    const transfer = async <T,>(start: () => Promise<T>): Promise<T> => {
      // Counted in the session it starts in, as `run` counts its own (#476): without it a
      // transfer that a lock outlives would end in the NEW session, take one from that session's
      // count and leave the old session's count at one for good.
      const startedIn = sessionRef.current;
      transferHold.operationStarted(startedIn);
      try {
        transferHold.transferStarted();
        transferOutcomeRef.current = null;
        // iOS suspends an app in the background, and its transfer with it.
        if (platformRef.current === "ios")
          setNotice(deferredText(() => translateCurrent("notice.iosKeepOpen")));
        return await start();
      } finally {
        const idle = transferHold.operationEnded(startedIn);
        if (idle && lockHeldRef.current) requestLock(true);
        else if (idle) flushPortalNoticeRef.current();
      }
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
      pickImportVideo:
        bridge.pickImportVideo &&
        ((profileId, folderIds) =>
          track(bridge.pickImportVideo!(profileId, folderIds))),
      // Adding a video can take minutes: the lock waits for it, as for any transfer.
      importPickedVideo:
        bridge.importPickedVideo &&
        ((pickId, profileId, folderIds) =>
          transfer(() =>
            bridge.importPickedVideo!(pickId, profileId, folderIds),
          )),
      pickExportDestination: (recordId) =>
        track(bridge.pickExportDestination(recordId)),
      // An anonymized text saved to a file is handled as a record's copy is: its picker is
      // tracked (on a phone the system's chooser sends the app to the background, and that must
      // not lock the vault under it), and the write is a transfer the lock waits for. Without
      // these a lock that fell due during either was taken at once.
      pickTextExportDestination: (recordId, ticket) =>
        track(bridge.pickTextExportDestination(recordId, ticket)),
      exportTextToPicked: (pickId, recordId, ticket, text, kept) =>
        transfer(() =>
          bridge.exportTextToPicked(pickId, recordId, ticket, text, kept),
        ),
      // `copyTextExport` is left as it is on purpose: it only puts the text on the clipboard,
      // which is instant, so there is no transfer to hold a lock for.
      saveRecoveryKit: () => track(bridge.saveRecoveryKit()),
      // A native confirmation may be open for as long as a picker.
      confirmRecoveryKey: (groups) => track(bridge.confirmRecoveryKey(groups)),
      pickBackupDestination: (localDate) =>
        track(bridge.pickBackupDestination(localDate)),
      // `leaveVideosOut` must be passed on: dropping it saved every backup whole.
      saveBackupToPicked: (pickId, leaveVideosOut) =>
        transfer(() => bridge.saveBackupToPicked(pickId, leaveVideosOut)),
      // A person's records handed over, or added from a file (#360): pickers are
      // tracked as the backup's are, and writing or adding is a transfer the lock waits for.
      pickProfileExportDestination: (exportId, localDate) =>
        track(bridge.pickProfileExportDestination(exportId, localDate)),
      saveProfileExportToPicked: (pickId) =>
        transfer(() => bridge.saveProfileExportToPicked(pickId)),
      pickProfileImportSource: () => track(bridge.pickProfileImportSource()),
      importProfile: (request) => transfer(() => bridge.importProfile(request)),
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
      // The answer's own id comes from `answering` (it owns the lock hold);
      // progress events are matched to it by the bridge.
      aiSummarize: (pages, lang, keep, _answerId, onProgress) =>
        answering((answerId) =>
          bridge.aiSummarize(pages, lang, keep, answerId, onProgress),
        ),
      aiExplain: (term, context, lang, recordId) =>
        answering((answerId) =>
          bridge.aiExplain(term, context, lang, recordId, answerId),
        ),
    };
  }, [answering, bridge, requestLock, track, transferHold]);
  // Adding a video lives here, above the screens: leaving the library mid-import keeps its progress,
  // its Cancel and its answer, and the library shows the video when it is in.
  const addVideo = useAddVideo({
    bridge: trackedBridge,
    onAdded: () => void refresh(),
  });
  // A lock stops an import natively. What it left (a failure, a stale "added") must not show after
  // the next unlock.
  const resetAddVideo = addVideo.reset;
  useEffect(() => {
    if (status === "locked") resetAddVideo();
  }, [status, resetAddVideo]);

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
    let mediaTouchedAt = -Infinity;
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
    const inAnswerHold = () => {
      const answer = answerRef.current;
      return (
        answer !== null &&
        answer.epoch === answerEpochRef.current &&
        Date.now() < answer.heldUntil
      );
    };
    const check = () => {
      if (sessionRef.current !== session) return;
      if (!delaySent) sendDelay();
      // Time spent in a picker the app opened is not idle time: the user is
      // choosing files for this vault. The deadline restarts once it closes.
      // Nor is the time an AI answer takes to write, up to its limit (D19).
      if ((pickersOpenRef.current > 0 && inPickerGrace()) || inAnswerHold())
        deadline = Date.now() + delayMs;
      // Video that is recording or playing is not idle time: the deadline stays
      // a full delay away, and the native one is told, as for user input.
      if (mediaHoldsRef.current.size > 0) {
        deadline = Date.now() + delayMs;
        if (Date.now() - mediaTouchedAt >= TOUCH_THROTTLE_MS) {
          mediaTouchedAt = Date.now();
          bridge.touch().catch(() => undefined);
        }
      }
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
    // The same for an AI answer that ended within its limit.
    const onAnswerSettled = (event: Event) => {
      const answer = (event as CustomEvent<AnswerActivity>).detail;
      if (
        sessionRef.current === session &&
        answer &&
        answerRef.current === answer &&
        !concealedRef.current &&
        inAnswerHold()
      )
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
    document.addEventListener(ANSWER_SETTLED_EVENT, onAnswerSettled);
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
      document.removeEventListener(ANSWER_SETTLED_EVENT, onAnswerSettled);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [autoLockMinutes, bridge, lockWhenIdle, status]);

  const libraryShown = status === "unlocked" && snapshot !== null && !concealed;
  const libraryShownRef = useRef(libraryShown);
  libraryShownRef.current = libraryShown;
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
        setNotice(deferredText(() => joinText(noticeValue, outcome)));
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
      setNotice(deferredText(() => joinText(message, outcome)));
      setLibraryNotice(null);
    }, ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [busy, holdForUnlock, libraryNotice, libraryShown, notice, status]);

  const updateAutoLockMinutes = (value: unknown) => {
    const normalized = normalizeAutoLockMinutes(value);
    setAutoLockMinutes(normalized);
    persistAutoLockMinutes(normalized);
    setNotice(
      deferredText(() =>
        translateCurrent("notice.autoLockSet", { count: normalized }),
      ),
    );
  };

  // Shows a notice, and keeps it as the outcome of a transfer under way.
  const report = (message: UiText) => {
    transferOutcomeRef.current = message;
    setNotice(deferredText(() => message));
  };

  // Clinic work runs beside library operations. While one of them runs, a
  // picker or transfer included, the line belongs to its result: a clinic
  // result waits and is added after it (see `run`), so neither is lost.
  // Clinic work clears the line when it starts, so anything on it when a
  // result arrives was written by other work since, and is kept. Nothing is
  // said for a session that has ended or is locking.
  // A notice is translated text (UiText), not a plain string: join them as
  // text, or the line would read "[object Object] …".
  const addNotice = (message: UiText) =>
    setNotice((shown) => (shown ? joinText(shown, message) : message));
  const showPortalNotice = (startedIn: number, message: UiText) => {
    // A hidden screen after a failed lock shows nothing new; only a lock,
    // which ends this session, can leave it.
    if (
      sessionRef.current !== startedIn ||
      lockingRef.current ||
      concealedRef.current
    )
      return;
    if (transferHold.running || photoNoticeSessionRef.current === startedIn) {
      portalNoticeRef.current = message
        ? { session: startedIn, message }
        : null;
      return;
    }
    if (message) addNotice(message);
    else setNotice("");
  };
  const flushPortalNotice = () => {
    const held = portalNoticeRef.current;
    if (
      !held ||
      transferHold.running ||
      photoNoticeSessionRef.current === held.session
    )
      return;
    portalNoticeRef.current = null;
    if (
      held.session === sessionRef.current &&
      libraryShownRef.current &&
      !lockingRef.current &&
      !concealedRef.current
    )
      addNotice(held.message);
  };
  flushPortalNoticeRef.current = flushPortalNotice;

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
      runsBySessionRef.current.set(
        startedIn,
        (runsBySessionRef.current.get(startedIn) ?? 0) + 1,
      );
      refreshBusy();
      setNotice("");
      transferHold.operationStarted(startedIn);
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
        setNotice(deferredText(() => vaultErrorMessage(error)));
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
      const cutOff = note
        ? deferredText(() =>
            t("notice.backupCutOff", { note: vaultErrorNote(error) ?? "" }),
          )
        : null;
      if (sessionRef.current !== startedIn) {
        // The vault locked while this ran. Report a failure that left
        // something to act on: a transfer's, such as a partial copy, after the
        // next unlock; any other now, as the person who asked for it is here.
        if (!lockedOut) {
          if (transferHold.active)
            holdForUnlock(deferredText(() => vaultErrorMessage(error, boxes)));
          else setNotice(deferredText(() => vaultErrorMessage(error, boxes)));
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
          report(message("notice.transferUnfinished"));
        lockReasonRef.current ??= "idle";
        requestLock(true);
        return;
      }
      report(deferredText(() => vaultErrorMessage(error, boxes)));
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
        // However it ended (done, cancelled, refused, failed, or cut off by a lock), this
        // operation stops counting, in the session it started in.
        const left = (runsBySessionRef.current.get(startedIn) ?? 1) - 1;
        if (left > 0) runsBySessionRef.current.set(startedIn, left);
        else runsBySessionRef.current.delete(startedIn);
        refreshBusy();
        const idle = transferHold.operationEnded(startedIn);
        if (idle && lockHeldRef.current) requestLock(true);
        else if (idle) flushPortalNotice();
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
    const wholeAtStart = appliedCaptureRef.current;
    const partialAtStart = approvalCapturesRef.current.get(linkId);
    const errorAfterCapture =
      partialAtStart?.owner === startedIn &&
      partialAtStart.capture.epoch === wholeAtStart?.epoch &&
      partialAtStart.capture.sequence > wholeAtStart.sequence
        ? partialAtStart.capture
        : wholeAtStart;
    const ownsRejection = () =>
      current() &&
      appliedCaptureRef.current?.owner === startedIn &&
      appliedCaptureRef.current.epoch === errorAfterCapture?.epoch &&
      appliedCaptureRef.current.sequence <= errorAfterCapture.sequence &&
      approvalCapturesRef.current.get(linkId) === partialAtStart;
    const rereadRecovery = () => {
      // Let the view record the outcome and the focused control first. The
      // reread still runs if the view closed, for this session's library.
      queueMicrotask(() => {
        if (current()) void refresh().catch(() => undefined);
      });
    };
    const promise = bridge.refreshDeviceApproval(linkId).then(
      (result): ApprovalPoll => {
        if (!current()) return null;
        const applied = appliedCaptureRef.current;
        const previous = approvalCapturesRef.current.get(linkId);
        if (
          result.link.id !== linkId ||
          applied?.owner !== startedIn ||
          result.capture?.epoch !== applied.epoch ||
          !(result.capture.sequence > applied.sequence) ||
          (previous?.owner === startedIn &&
            previous.capture.epoch === result.capture.epoch &&
            previous.capture.sequence >= result.capture.sequence)
        )
          return null;
        approvalCapturesRef.current.set(linkId, {
          owner: startedIn,
          capture: result.capture,
          link: result.link,
        });
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
        if (result.recovery) rereadRecovery();
        return {
          check: result,
          // A whole read can arrive between parent publication and the
          // polling hook's continuation. It also owns panel announcements.
          current: () =>
            current() &&
            approvalCapturesRef.current.get(linkId)?.capture === result.capture,
        };
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
        if (isRecoveryModeError(error)) rereadRecovery();
        if (!ownsRejection()) return null;
        return {
          error,
          current: ownsRejection,
          // Rejections have no native partial capture. They follow the
          // newest whole or device capture known when this poll began.
          afterCapture: errorAfterCapture ?? undefined,
        };
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
  const session = sessionRef.current;
  const inSession = () => sessionRef.current === session;
  // `known` is the vault as a command that changed it returned it, taken
  // under the same guard as the change: nothing to ask again.
  const refresh = async (known?: VaultSnapshot) => {
    const next = known ?? (await bridge.snapshot());
    const applied = appliedCaptureRef.current;
    // Native captures are ordered under the session guard, including known
    // results delivered late. Failed requests advance no applied capture.
    if (
      inSession() &&
      applied?.owner === session &&
      next.capture.epoch === applied.epoch &&
      next.capture.sequence > applied.sequence
    ) {
      appliedCaptureRef.current = { ...next.capture, owner: session };
      setSnapshot(mergeApprovalCaptures(next, session));
    }
    // A stale snapshot can still acknowledge a successful native key write.
    return next;
  };
  const refreshMounted = useRef(false);
  const refreshOwner = useRef({ status, snapshot });
  refreshOwner.current = { status, snapshot };
  const refreshAutomaticArrivals = useCallback(async () => {
    const before = refreshOwner.current;
    const owner = before.snapshot?.sharedProfileId;
    if (
      !refreshMounted.current ||
      before.status !== "unlocked" ||
      !owner ||
      !before.snapshot?.automaticDocumentChecksSupported ||
      before.snapshot.recovery ||
      lockingRef.current
    )
      return;
    const startedIn = sessionRef.current;
    try {
      const next = await bridge.snapshot();
      const current = refreshOwner.current;
      const applied = appliedCaptureRef.current;
      if (
        refreshMounted.current &&
        !lockingRef.current &&
        sessionRef.current === startedIn &&
        current.status === "unlocked" &&
        !current.snapshot?.recovery &&
        current.snapshot?.sharedProfileId === owner &&
        next.sharedProfileId === owner &&
        next.recovery === null &&
        applied?.owner === startedIn &&
        next.capture.epoch === applied.epoch &&
        next.capture.sequence > applied.sequence
      ) {
        appliedCaptureRef.current = { ...next.capture, owner: startedIn };
        const merged = mergeApprovalCaptures(next, startedIn);
        setSnapshot((previous) =>
          previous?.sharedProfileId === owner ? merged : previous,
        );
      }
    } catch {
      /* Keep current edits/state; a later explicit open/focus retries. */
    }
  }, [bridge]);
  useEffect(() => {
    refreshMounted.current = true;
    const onFocus = () => {
      void refreshAutomaticArrivals();
    };
    const onVisible = () => {
      if (!pickerSettlingRef.current && document.visibilityState === "visible")
        onFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      refreshMounted.current = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshAutomaticArrivals]);
  const setSessionNotice = (message: UiText) => {
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
  const setPortalNotice = (message: UiText) =>
    showPortalNotice(session, message);
  const onPhotoNoticePending = (pending: boolean) => {
    if (!inSession()) return;
    if (pending) {
      if (libraryShownRef.current) photoNoticeSessionRef.current = session;
    } else if (photoNoticeSessionRef.current === session) {
      photoNoticeSessionRef.current = null;
      flushPortalNotice();
    }
  };

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
      showPortalNotice(
        startedIn,
        deferredText(() => unlockCheckWaitingText()),
      );
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
        // Deferred, so that the notice follows a later change of language,
        // as main's notices do; empty when the check found nothing to say.
        let message: UiText = "";
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
          const result = found.result;
          const counted = (id: string) => approved.has(id);
          if (unlockCheckText(result, counted))
            message = deferredText(() => unlockCheckText(result, counted));
        } catch (error) {
          // The vault locked: `run` locks here too, as for all clinic work.
          if (isLockedError(error) || isCancelledError(error)) throw error;
          const busy = hasVaultErrorCode(error, "portal_busy");
          message = deferredText(() =>
            busy ? unlockCheckNotRunText() : unlockCheckFailedText(error),
          );
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
  const accepting = useRef<number | null>(null);
  acceptSharedRef.current = async (ids?: string[]) => {
    const generation = receiveGeneration.current;
    if (
      status !== "unlocked" ||
      !inSession() ||
      accepting.current === generation ||
      document.visibilityState !== "visible" ||
      concealedRef.current ||
      lockingRef.current
    )
      // Nothing was asked of native code: the caller may ask the patient again.
      return false;
    const current = () =>
      generation === receiveGeneration.current &&
      inSession() &&
      statusRef.current === "unlocked";
    accepting.current = generation;
    let accepted = false;
    try {
      const outcome = await bridge.acceptReceived(ids);
      accepted = true;
      if (!current()) return;
      setReceived([]);
      const said = () => [
        ...outcome.notPdf.map((name) =>
          translateNow("interface.notice.notPdf", { name }),
        ),
        ...outcome.unreadable.map((name) =>
          translateNow("interface.notice.receivedNotOpened", { name }),
        ),
        ...outcome.skippedDuplicates.map((name) =>
          translateNow("interface.notice.alreadyShared", { name }),
        ),
      ];
      const deferIfPrivate = () => {
        if (
          !concealedRef.current &&
          !lockingRef.current &&
          document.visibilityState === "visible"
        )
          return false;
        if (
          outcome.imported.length ||
          outcome.notPdf.length ||
          outcome.unreadable.length ||
          outcome.skippedDuplicates.length
        ) {
          const message = deferredText(() =>
            [sharedAddedText(outcome.imported.length), ...said()]
              .filter(Boolean)
              .join(" "),
          );
          const held = pendingSharedOutcomeRef.current;
          pendingSharedOutcomeRef.current = {
            generation,
            message:
              held?.generation === generation
                ? joinText(held.message, message)
                : message,
          };
        }
        return true;
      };
      if (deferIfPrivate()) return;
      if (outcome.imported.length) {
        // Applied through `refresh`, ordered by the native capture: a library
        // action that refreshed meanwhile has the newer vault, and this reply
        // must not roll it back (a photo hidden meanwhile would reappear).
        let next: VaultSnapshot;
        try {
          next = await bridge.snapshot();
        } catch {
          // Acceptance already finished. A lock may make the snapshot unavailable;
          // keep its completed private outcome rather than lose it with the refresh.
          if (current()) deferIfPrivate();
          return;
        }
        if (!current() || deferIfPrivate()) return;
        await refresh(next);
        if (!current()) return;
        setSharedNew((count) => count + outcome.imported.length);
      }
      if (
        outcome.notPdf.length ||
        outcome.unreadable.length ||
        outcome.skippedDuplicates.length
      )
        setSessionNotice(deferredText(() => said().join(" ")));
    } catch (error) {
      // They keep waiting: the next ask tries again. Said, unless it is the
      // vault locking or the work cancelled: without a word, no space, a
      // paused vault or damage would mean the files never appear.
      if (
        inSession() &&
        !hasVaultErrorCode(error, "locked") &&
        !hasVaultErrorCode(error, "cancelled")
      )
        setSessionNotice(deferredText(() => vaultErrorMessage(error)));
    } finally {
      if (accepting.current === generation) accepting.current = null;
      // A newer unlock may have asked while these files were still taken.
      if (accepted || !inSession()) void refreshReceived();
    }
  };
  useEffect(() => {
    if (status === "unlocked") void refreshReceived();
    else setSharedNew(0);
  }, [refreshReceived, status]);
  // A lock takes the question away: nothing was stored, and the files ask again after an unlock.
  useEffect(() => {
    if (status !== "unlocked") {
      confirmOpen.current = false;
      setConfirmReceived(null);
    }
  }, [status]);

  // A restored vault is locked: it opens with its own passphrase or key.
  const restored = () => {
    forgetReplacedVault();
    setStatus("locked");
    setNotice(deferredText(() => translateCurrent("notice.restored")));
  };

  if (status === "loading") {
    return (
      <VaultAuthFrame state="Opening">
        <p>{t("interface.VaultApp.openingMyCarlos")}</p>
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
        askDetails={Boolean(bridge.updateProfileDetails)}
        onCreate={(profile, passphrase, details) =>
          run(
            async () => {
              const created = await bridge.create(passphrase, profile);
              // The first person's details (#234), in the records Edit details
              // writes, with their history event. If this fails the vault is
              // still made, and the library's reminder asks for them again.
              const first = created.profiles.find(
                (person) => person.id !== created.sharedProfileId,
              );
              // A failure is said (review SHOULD): the patient typed them.
              let detailsFailed = false;
              const withDetails =
                details && first && bridge.updateProfileDetails
                  ? await bridge.updateProfileDetails(first.id, details).then(
                      () => bridge.snapshot().catch(() => created),
                      () => {
                        detailsFailed = true;
                        return created;
                      },
                    )
                  : created;
              installOpeningSnapshot(withDetails);
              // Nothing from a vault that is gone.
              pendingOutcomeRef.current = null;
              pendingSharedOutcomeRef.current = null;
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
                appliedCaptureRef.current = null;
                setSnapshot(null);
                setStatus("locked");
                setNotice(
                  deferredText(() =>
                    translateCurrent("notice.createdThenLocked"),
                  ),
                );
                return;
              }
              const recoveryKey = begun.key;
              setOpeningRecoverySetup(
                recoveryKey
                  ? {
                      vault: "created",
                      key: recoveryKey,
                      detailsNotSaved: detailsFailed,
                    }
                  : null,
              );
              setConcealed(false);
              setStatus("unlocked");
              // With a key to set up, its result says what happened, details
              // not kept included: a notice written under the dialog would
              // not be read out. Without one, the library says it now.
              if (!recoveryKey)
                setLibraryNotice({
                  message: deferredText(() =>
                    detailsFailed
                      ? t("personDetails.notSaved")
                      : t("notice.created"),
                  ),
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
        trayWaiting={trayWaiting && status === "locked"}
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
            installOpeningSnapshot(current);
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
              message: deferredText(() =>
                current.recovery
                  ? t("notice.unlockedRecovery")
                  : t("notice.unlocked"),
              ),
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
            installOpeningSnapshot(current);
            setConcealed(false);
            setStatus("unlocked");
            setUnlockCheck({ session: sessionRef.current, offerOpen: false });
            const outcome = takeHeldOutcome(current);
            setLibraryNotice({
              message: deferredText(() =>
                passphraseReplaced
                  ? t("notice.recovered")
                  : t("notice.recoveredReadOnly"),
              ),
              outcome,
            });
          }, ["box.recoveryKey", "box.newPassphrase"])
        }
        onReset={(confirmation) =>
          run(async () => {
            if (await bridge.reset(confirmation)) {
              // The one path for "this vault is gone", as for a restore over it: it forgets
              // every note held for the vault's next unlock (the unfinished handover too, which
              // this path used to leave to be told at the next vault's unlock).
              forgetReplacedVault();
              // Starting again starts with the comfort settings, as a fresh
              // start of the app does.
              setComfortChosen(false);
              setStatus("absent");
              setNotice("");
            } else {
              setNotice(
                deferredText(() => translateCurrent("notice.eraseCancelled")),
              );
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
            <h1 id="hold-title">
              {t("interface.VaultApp.finishingTheTransfer")}
            </h1>
            <p role="status">
              {t("interface.VaultApp.vaultContentIsHiddenMyCarlosWillLock")}
            </p>
            <button
              className="button"
              type="button"
              onClick={() => requestLock(true)}
            >
              {t("interface.VaultApp.lockNowAndCancelTheTransfer")}
            </button>
          </section>
        </VaultAuthFrame>
      );
    return lockFailed ? (
      <VaultAuthFrame state="Not locked">
        <p role="alert">
          {t("interface.VaultApp.myCarlosCouldNotLockTheVaultIts")} {notice}
        </p>
        <button
          className="button primary"
          type="button"
          onClick={() => requestLock(true)}
        >
          {t("interface.VaultApp.tryLockingAgain")}
        </button>
      </VaultAuthFrame>
    ) : (
      <VaultAuthFrame state="Locking">
        <p>
          {t("interface.VaultApp.vaultContentIsHiddenWhileMyCarlosFinishes")}
        </p>
      </VaultAuthFrame>
    );
  }

  return (
    <>
      {confirmReceived && status === "unlocked" && (
        <ConfirmDialog
          title={
            confirmReceived.length === 1
              ? t("interface.received.confirmTitleOne", {
                  name: confirmReceived[0].name,
                })
              : t("interface.received.confirmTitleMany", {
                  count: confirmReceived.length,
                })
          }
          confirmLabel={t("interface.received.import")}
          // Files kept from while the vault was locked (#49): Not now keeps them for the next
          // unlock, and Remove deletes them. Other files have only Cancel.
          cancelLabel={
            confirmReceived.some((file) => file.sealed)
              ? t("interface.received.notNow")
              : undefined
          }
          removeLabel={
            confirmReceived.some((file) => file.sealed) && bridge.removeReceived
              ? t("interface.received.removeKept", {
                  count: confirmReceived.filter((file) => file.sealed).length,
                })
              : undefined
          }
          onRemove={() => {
            // Delete acts on the kept (sealed) files only: another file in the same question
            // (an "Open with" file) stays waiting and is asked about again.
            const ids = confirmReceived
              .filter((file) => file.sealed)
              .map((file) => file.id);
            confirmOpen.current = false;
            setConfirmReceived(null);
            void bridge
              .removeReceived?.(ids)
              .then(() =>
                setReceived((waiting) =>
                  waiting.filter((file) => !ids.includes(file.id)),
                ),
              )
              .then(() => refreshReceivedRef.current())
              // A delete that was refused (locked) or failed (storage) claims nothing: the list is
              // read again, which drops what native already forgot, and asks again about what
              // still waits (a failed file keeps waiting). No new text: the question coming back is
              // the answer; the listing never rejects.
              .catch(() => refreshReceivedRef.current());
          }}
          details={
            confirmReceived.length > 1 ? (
              <ul>
                {confirmReceived.map((file) => (
                  <li key={file.id}>{file.name}</li>
                ))}
              </ul>
            ) : undefined
          }
          onConfirm={() => {
            const files = confirmReceived;
            const ids = files.map((file) => file.id);
            confirmOpen.current = false;
            setConfirmReceived(null);
            void acceptSharedRef.current(ids).then((ran) => {
              // Not asked of native code (the window was hidden, or an import was under way):
              // the files still wait, so the same question comes back rather than being lost.
              if (ran === false) {
                confirmOpen.current = true;
                setConfirmReceived(files);
              }
            });
          }}
          onCancel={() => {
            const ids = confirmReceived.map((file) => file.id);
            confirmOpen.current = false;
            setConfirmReceived(null);
            void bridge
              .discardReceived(ids)
              .then(() =>
                setReceived((waiting) =>
                  waiting.filter((file) => !ids.includes(file.id)),
                ),
              )
              // A file that arrived while the question was open is asked about now.
              .then(() => refreshReceivedRef.current())
              .catch(() => undefined);
          }}
        >
          <p>
            {t(
              confirmReceived.some((file) => file.sealed)
                ? "interface.received.confirmBodySealed"
                : "interface.received.confirmBody",
            )}
          </p>
        </ConfirmDialog>
      )}
      <VaultLibrary
        bridge={trackedBridge}
        addVideo={addVideo}
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
        onPhotoNoticePending={onPhotoNoticePending}
        refresh={refresh}
        onLock={lockAsked}
        onRequestLock={requestLockAsked}
        autoLockMinutes={autoLockMinutes}
        onAutoLockMinutes={updateAutoLockMinutes}
        openingRecoverySetup={openingRecoverySetup}
        onOpeningRecoverySetupShown={() => setOpeningRecoverySetup(null)}
        onOfferClosed={offerClosed}
        onUnfinishedRecoveryKey={rememberUnfinishedRecoveryKey}
        onUnfinishedHandover={rememberUnfinishedHandover}
        canPrint={DESKTOP_PLATFORMS.has(platform)}
        keyboardHints={DESKTOP_PLATFORMS.has(platform)}
        computer={DESKTOP_PLATFORMS.has(platform)}
        androidPdfReader={platform === "android"}
        sizesIn1024s={platform === "windows"}
        cameraPlatform={CAMERA_PLATFORMS.has(platform) ? platform : null}
        cameraAsking={isPhone(platform) ? track : undefined}
        holdMedia={holdMedia}
        covered={lockWarning !== null}
        sharedNew={sharedNew}
        onSharedSeen={clearSharedNew}
        onSecurityEntry={refreshAutomaticArrivals}
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

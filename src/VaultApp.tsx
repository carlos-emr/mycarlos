import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import App from "./App";
import {
  createVaultBridge,
  isCancelledError,
  isLockedError,
  isMissingVaultError,
  isRestoreUnfinished,
  vaultErrorMessage,
  vaultErrorNote,
  type VaultBridge,
  type VaultSnapshot,
  type VaultStatus,
} from "./vault";
import { VaultAuthFrame, CreateVault, UnlockVault } from "./native/VaultAuth";
import { VaultLibrary } from "./native/VaultLibrary";
import { TransferHold } from "./native/transferHold";
import { ANNOUNCE_DELAY_MS } from "./native/announce";
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
] as const;
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
const IOS_TRANSFER_NOTE =
  "Keep myCarlos open: switching apps pauses this transfer.";

export default function VaultApp({ bridge = defaultBridge }: VaultAppProps) {
  if (!bridge.native) return <App />;
  return <NativeVault bridge={bridge} />;
}

function NativeVault({ bridge }: { bridge: VaultBridge }) {
  const [status, setStatus] = useState<VaultStatus | "loading">("loading");
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null);
  const [notice, setNotice] = useState("");
  // A message for the library that unlocking or creating the vault is about to
  // show. Its status line reads out only what changes once it is on screen, so
  // the message is written just after (see the effect below).
  const [libraryNotice, setLibraryNotice] = useState<{
    message: string;
    // The result of a transfer that a lock ended, held for this unlock. It
    // must reach the patient: it may say a readable copy was left behind.
    outcome: string | null;
  } | null>(null);
  // The recovery key made with a vault just created. The library opens on it,
  // and the patient sets it up before anything else.
  const [newVaultRecoveryKey, setNewVaultRecoveryKey] = useState<string | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
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
        setNotice(
          "To import PDFs, unlock your vault and use Choose files to import. Drag and drop moves documents already in myCarlos.",
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
      setSnapshot(null);
      // A key shown but not set up ended with the session.
      setNewVaultRecoveryKey(null);
      setConcealed(false);
      setLockFailed(false);
      holdLock(false);
      setStatus("locked");
      if (endsTransfer && transferOutcomeRef.current)
        holdForUnlock(transferOutcomeRef.current);
      setNotice("Vault locked.");
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
      }
      void lock();
    },
    [lock],
  );

  // Automatic locks: during a transfer, hide content and lock once the
  // operation it belongs to has finished.
  const lockWhenIdle = useCallback(() => {
    if (!transferHold.active) {
      requestLock(true);
      return;
    }
    if (!concealedRef.current) setLockFailed(false);
    setConcealed(true);
    holdLock(true);
  }, [holdLock, requestLock, transferHold]);

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
  const pickersOpenRef = useRef(0);
  const pickerOpenedAtRef = useRef(0);
  const trackedBridge = useMemo<VaultBridge>(() => {
    const track = async <T,>(picker: Promise<T>): Promise<T> => {
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
    };
    const transfer = async <T,>(start: () => Promise<T>): Promise<T> => {
      // `run` locks once the operation has reported the transfer's outcome.
      transferHold.transferStarted();
      transferOutcomeRef.current = null;
      // iOS suspends an app in the background, and its transfer with it.
      if (platformRef.current === "ios") setNotice(IOS_TRANSFER_NOTE);
      return start();
    };
    return {
      ...bridge,
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
  }, [bridge, transferHold]);

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
      if (remaining <= 0) lockWhenIdle();
      timer = window.setTimeout(
        check,
        remaining > 0 ? Math.min(remaining, LOCK_RECHECK_MS) : LOCK_RECHECK_MS,
      );
    };
    let touchedAt = -Infinity;
    const postpone = () => {
      // Once the delay has elapsed the lock is owed; activity cannot cancel it.
      if (Date.now() >= deadline) return;
      deadline = Date.now() + delayMs;
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
      lockWhenIdle();
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
    setNotice(
      `Automatic locking set to ${normalized} minute${normalized === 1 ? "" : "s"}.`,
    );
  };

  // Shows a notice, and keeps it as the outcome of a transfer under way.
  const report = (message: string) => {
    transferOutcomeRef.current = message;
    setNotice(message);
  };

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setNotice("");
    transferHold.operationStarted();
    const startedIn = sessionRef.current;
    try {
      await operation();
    } catch (error) {
      // The unlock screen is also shown when the startup status check fails,
      // and after a failed erase. If there is no vault after all, offer to
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
      const cutOff = note
        ? `The backup stopped because the vault locked. No backup was saved. Keep your older backups. ${note}`
        : null;
      if (sessionRef.current !== startedIn) {
        // The vault locked while this ran. Report a failure that left
        // something to act on: a transfer's, such as a partial copy, after the
        // next unlock; any other now, as the person who asked for it is here.
        if (!lockedOut) {
          if (transferHold.active) holdForUnlock(vaultErrorMessage(error));
          else setNotice(vaultErrorMessage(error));
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
        if (cutOff) report(cutOff);
        else if (isCancelledError(error))
          report("The transfer did not finish.");
        requestLock(true);
        return;
      }
      report(vaultErrorMessage(error));
      // A transfer failure that is neither "locked" nor "cancelled" can still
      // mean the native deadline locked the vault (a provider export's partial
      // copy): confirm, and lock so that the lock keeps it.
      if (transferHold.active && status === "unlocked") {
        const now = await bridge.status().catch(() => null);
        if (now === "locked" && sessionRef.current === startedIn)
          requestLock(true);
      }
    } finally {
      setBusy(false);
      if (transferHold.operationEnded() && lockHeldRef.current)
        requestLock(true);
    }
  };

  // These are handed to the library, which unmounts on lock. A call that is
  // still in flight then belongs to a finished session and is ignored.
  const session = sessionRef.current;
  const inSession = () => sessionRef.current === session;
  // `known` is the vault as a command that changed it returned it, taken
  // under the same guard as the change: nothing to ask again.
  const refresh = async (known?: VaultSnapshot) => {
    const next = known ?? (await bridge.snapshot());
    if (inSession()) setSnapshot(next);
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

  // A restored vault is locked: it opens with its own passphrase or key.
  const restored = () => {
    forgetReplacedVault();
    setStatus("locked");
    setNotice(
      "Backup restored. Unlock it with the passphrase it was made with, or use its recovery key.",
    );
  };

  if (status === "loading") {
    return (
      <VaultAuthFrame state="Opening">
        <p>Opening myCarlos…</p>
      </VaultAuthFrame>
    );
  }

  if (status === "absent") {
    return (
      <CreateVault
        busy={busy}
        notice={notice}
        restoreBridge={trackedBridge}
        onRestored={restored}
        onCreate={(profile, passphrase) =>
          run(async () => {
            setSnapshot(await bridge.create(passphrase, profile));
            // Nothing from a vault that is gone.
            pendingOutcomeRef.current = null;
            rememberUnfinishedRecoveryKey(null);
            rememberOldBackupsGuide(null);
            // The passphrase was just typed, so it authorizes the recovery key
            // at once. If that fails, the library offers to set one up.
            const begun = await bridge.beginRecoveryKey(passphrase).then(
              (key) => ({ key, locked: false }),
              (error: unknown) => ({ key: null, locked: isLockedError(error) }),
            );
            if (begun.locked) {
              // The vault locked meanwhile (its automatic lock): it is shown
              // locked, not open on what the lock ended.
              setSnapshot(null);
              setStatus("locked");
              setNotice(
                "Your vault was created, then locked before its recovery key could be made. Unlock it to set one up.",
              );
              return;
            }
            const recoveryKey = begun.key;
            setNewVaultRecoveryKey(recoveryKey);
            setConcealed(false);
            setStatus("unlocked");
            // With a key to set up, its dialog says what happened instead.
            if (!recoveryKey)
              setLibraryNotice({
                message:
                  "Encrypted vault created. Set up a recovery key, so that a forgotten passphrase does not mean erasing it.",
                outcome: null,
              });
          })
        }
      />
    );
  }

  if (status === "locked" || !snapshot) {
    return (
      <UnlockVault
        busy={busy}
        notice={notice}
        restoreBridge={trackedBridge}
        onRestored={restored}
        autoLockMinutes={autoLockMinutes}
        onUnlock={(passphrase) =>
          run(async () => {
            const current = await bridge.unlock(passphrase);
            setSnapshot(current);
            setConcealed(false);
            setStatus("unlocked");
            const outcome = takeHeldOutcome(current);
            setLibraryNotice({
              message: current.recovery
                ? "Vault unlocked in read-only recovery mode. See the notice in the library for what to do."
                : "Vault unlocked.",
              outcome,
            });
          })
        }
        onRecover={(recoveryKey, newPassphrase) =>
          run(async () => {
            const { passphraseReplaced, snapshot: current } =
              await bridge.recover(recoveryKey, newPassphrase);
            setSnapshot(current);
            setConcealed(false);
            setStatus("unlocked");
            const outcome = takeHeldOutcome(current);
            setLibraryNotice({
              message: passphraseReplaced
                ? "Vault opened with your recovery key. Use your new passphrase from now on."
                : "Vault opened read-only with your recovery key, and your passphrase is unchanged. See the notice in the library for what to do.",
              outcome,
            });
          })
        }
        onReset={(confirmation) =>
          run(async () => {
            if (await bridge.reset(confirmation)) {
              pendingOutcomeRef.current = null;
              rememberUnfinishedRecoveryKey(null);
              rememberOldBackupsGuide(null);
              setStatus("absent");
              setNotice("");
            } else {
              setNotice("Vault erase cancelled. Nothing changed.");
            }
          })
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
    <VaultLibrary
      bridge={trackedBridge}
      snapshot={snapshot}
      busy={busy}
      notice={notice}
      setNotice={setSessionNotice}
      run={run}
      refresh={refresh}
      onLock={lock}
      autoLockMinutes={autoLockMinutes}
      onAutoLockMinutes={updateAutoLockMinutes}
      newVaultRecoveryKey={newVaultRecoveryKey}
      onNewVaultRecoveryKeyShown={() => setNewVaultRecoveryKey(null)}
      onUnfinishedRecoveryKey={rememberUnfinishedRecoveryKey}
      canPrint={DESKTOP_PLATFORMS.has(platform)}
    />
  );
}

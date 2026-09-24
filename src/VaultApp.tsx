import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import App from "./App";
import {
  createVaultBridge,
  isLockedError,
  isMissingVaultError,
  vaultErrorMessage,
  type VaultBridge,
  type VaultSnapshot,
  type VaultStatus,
} from "./vault";
import { VaultAuthFrame, CreateVault, UnlockVault } from "./native/VaultAuth";
import { VaultLibrary } from "./native/VaultLibrary";
import {
  normalizeAutoLockMinutes,
  readAutoLockMinutes,
  persistAutoLockMinutes,
} from "./native/autoLock";

export interface VaultAppProps {
  bridge?: VaultBridge;
}
const defaultBridge = createVaultBridge();

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
// User input is reported to the native idle deadline at most this often. The
// native deadline fires 15 seconds after the renderer's, so it never races it.
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
  const [busy, setBusy] = useState(false);
  const [concealed, setConcealed] = useState(false);
  const [lockFailed, setLockFailed] = useState(false);
  // An automatic lock owed while a transfer runs waits for it to finish, with
  // content hidden: locking cancels a transfer, and a large one must not be cut
  // off by the user switching apps or reading instead of clicking.
  const [lockHeld, setLockHeld] = useState(false);
  const lockHeldRef = useRef(false);
  lockHeldRef.current = lockHeld;
  const transfersRef = useRef(0);
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

  const lock = useCallback(async () => {
    if (lockingRef.current) return;
    lockingRef.current = true;
    try {
      await bridge.lock();
      sessionRef.current += 1;
      setSnapshot(null);
      setConcealed(false);
      setLockFailed(false);
      setLockHeld(false);
      setStatus("locked");
      setNotice("Vault locked.");
    } catch (error) {
      // The vault is still unlocked natively. Every caller must learn that,
      // including the concealed screen, which would otherwise claim "Locked".
      setLockFailed(true);
      setNotice(vaultErrorMessage(error));
    } finally {
      lockingRef.current = false;
    }
  }, [bridge]);

  // Read through a ref so that `requestLock` keeps its identity: the automatic
  // lock effect depends on it, and re-running that effect resets its deadline.
  const concealedRef = useRef(concealed);
  concealedRef.current = concealed;
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

  // Automatic locks: during a transfer, hide content and lock once it settles.
  const lockWhenIdle = useCallback(() => {
    if (transfersRef.current === 0) {
      requestLock(true);
      return;
    }
    if (!concealedRef.current) setLockFailed(false);
    setConcealed(true);
    setLockHeld(true);
  }, [requestLock]);

  useEffect(() => {
    if (status === "unlocked")
      bridge.setAutoLock(autoLockMinutes).catch(() => undefined);
  }, [autoLockMinutes, bridge, status]);

  const platformRef = useRef("");
  useEffect(() => {
    let active = true;
    bridge
      .platform()
      .then((platform) => {
        if (active) platformRef.current = platform;
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
      transfersRef.current += 1;
      // iOS suspends an app in the background, and its transfer with it.
      if (platformRef.current === "ios") setNotice(IOS_TRANSFER_NOTE);
      try {
        return await start();
      } finally {
        transfersRef.current -= 1;
        if (transfersRef.current === 0 && lockHeldRef.current)
          requestLock(true);
      }
    };
    return {
      ...bridge,
      pickImportFiles: (profileId, folderIds) =>
        track(bridge.pickImportFiles(profileId, folderIds)),
      pickExportDestination: (recordId) =>
        track(bridge.pickExportDestination(recordId)),
      importPickedFiles: (pickId, profileId, folderIds) =>
        transfer(() => bridge.importPickedFiles(pickId, profileId, folderIds)),
      exportToPicked: (pickId, recordId) =>
        transfer(() => bridge.exportToPicked(pickId, recordId)),
    };
  }, [bridge, requestLock]);

  useEffect(() => {
    if (status !== "unlocked") return;
    const delayMs = autoLockMinutes * 60 * 1000;
    let deadline = Date.now() + delayMs;
    let timer = 0;
    const inPickerGrace = () =>
      Date.now() - pickerOpenedAtRef.current < PICKER_GRACE_MS;
    const check = () => {
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

  const updateAutoLockMinutes = (value: unknown) => {
    const normalized = normalizeAutoLockMinutes(value);
    setAutoLockMinutes(normalized);
    persistAutoLockMinutes(normalized);
    setNotice(
      `Automatic locking set to ${normalized} minute${normalized === 1 ? "" : "s"}.`,
    );
  };

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setNotice("");
    try {
      await operation();
    } catch (error) {
      // The native idle deadline locked the vault, for example while this
      // screen was suspended. Show that rather than a failure to retry.
      if (isLockedError(error) && status === "unlocked") {
        sessionRef.current += 1;
        setSnapshot(null);
        setConcealed(false);
        setLockHeld(false);
        setStatus("locked");
        setNotice("Vault locked.");
        return;
      }
      // The unlock screen is also shown when the startup status check fails. If
      // there is no vault after all, offer to create one: nothing on the unlock
      // screen can succeed, and only a restart would otherwise leave it.
      if (isMissingVaultError(error))
        setStatus((current) => (current === "locked" ? "absent" : current));
      setNotice(vaultErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  // These are handed to the library, which unmounts on lock. A call that is
  // still in flight then belongs to a finished session and is ignored.
  const session = sessionRef.current;
  const inSession = () => sessionRef.current === session;
  const refresh = async () => {
    const next = await bridge.snapshot();
    if (inSession()) setSnapshot(next);
    return next;
  };
  const setSessionNotice = (message: string) => {
    if (inSession()) setNotice(message);
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
        onCreate={(profile, passphrase) =>
          run(async () => {
            setSnapshot(await bridge.create(passphrase, profile));
            setConcealed(false);
            setStatus("unlocked");
            setNotice(
              "Encrypted vault created. Keep your passphrase safe; it cannot be recovered.",
            );
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
        autoLockMinutes={autoLockMinutes}
        onUnlock={(passphrase) =>
          run(async () => {
            const current = await bridge.unlock(passphrase);
            setSnapshot(current);
            setConcealed(false);
            setStatus("unlocked");
            setNotice(
              current.recovery
                ? "Vault unlocked in read-only recovery mode. See the notice in the library for what to do."
                : "Vault unlocked.",
            );
          })
        }
        onReset={(confirmation) =>
          run(async () => {
            if (await bridge.reset(confirmation)) {
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
          <p>
            Vault content is hidden. myCarlos will lock as soon as the transfer
            finishes.
          </p>
          <button
            className="button"
            type="button"
            onClick={() => requestLock(true)}
          >
            Lock now and cancel the transfer
          </button>
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
    />
  );
}

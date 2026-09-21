import { useCallback, useEffect, useRef, useState } from "react";
import App from "./App";
import {
  createVaultBridge,
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

  const requestLock = useCallback(
    (concealImmediately = false) => {
      if (concealImmediately) setConcealed(true);
      void lock();
    },
    [lock],
  );

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

  useEffect(() => {
    if (status !== "unlocked") return;
    const delayMs = autoLockMinutes * 60 * 1000;
    let deadline = Date.now() + delayMs;
    let timer = 0;
    const check = () => {
      const remaining = deadline - Date.now();
      // Hide content at once: an unattended screen must not stay readable while
      // the lock is pending, or if it fails and has to be retried.
      if (remaining <= 0) requestLock(true);
      timer = window.setTimeout(
        check,
        remaining > 0 ? Math.min(remaining, LOCK_RECHECK_MS) : LOCK_RECHECK_MS,
      );
    };
    const postpone = () => {
      // Once the delay has elapsed the lock is owed; activity cannot cancel it.
      if (Date.now() < deadline) deadline = Date.now() + delayMs;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") requestLock(true);
    };
    check();
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, postpone, { passive: true });
    }
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "hidden") requestLock(true);
    return () => {
      window.clearTimeout(timer);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, postpone);
      }
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [autoLockMinutes, requestLock, status]);

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
              current.degraded
                ? "Vault unlocked in read-only recovery mode. Export important records and free storage before unlocking again."
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
      bridge={bridge}
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

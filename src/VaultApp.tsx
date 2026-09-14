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
  const [autoLockMinutes, setAutoLockMinutes] = useState(readAutoLockMinutes);
  const lockingRef = useRef(false);

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
      setSnapshot(null);
      setConcealed(false);
      setStatus("locked");
      setNotice("Vault locked.");
    } finally {
      lockingRef.current = false;
    }
  }, [bridge]);

  const requestLock = useCallback(
    (concealImmediately = false) => {
      if (concealImmediately) setConcealed(true);
      void lock().catch((error) => setNotice(vaultErrorMessage(error)));
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
    let timer = window.setTimeout(requestLock, delayMs);
    const restart = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(requestLock, delayMs);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") requestLock(true);
    };
    for (const event of ["pointerdown", "keydown", "touchstart"] as const) {
      window.addEventListener(event, restart, { passive: true });
    }
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "hidden") requestLock(true);
    return () => {
      window.clearTimeout(timer);
      for (const event of ["pointerdown", "keydown", "touchstart"] as const) {
        window.removeEventListener(event, restart);
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

  const refresh = async () => setSnapshot(await bridge.snapshot());

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
    return (
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
      setNotice={setNotice}
      run={run}
      refresh={refresh}
      onLock={lock}
      autoLockMinutes={autoLockMinutes}
      onAutoLockMinutes={updateAutoLockMinutes}
    />
  );
}

// A recovery key setup that has shown a key and not ended. A lock ends it,
// and so does myCarlos closing, and the key it showed then opens nothing; the
// patient may have written it down or saved a kit, so the next unlock says
// how it ended. Kept in webview storage, to outlast myCarlos closing. It holds
// no key: only when the vault's recovery key was set up as the key was shown,
// which tells at unlock whether the key was stored after all (its reply can
// be lost to the lock that ended the setup).
const STORAGE_KEY = "mycarlos.unfinishedRecoveryKey.v1";

export interface UnfinishedRecoveryKey {
  /** When the vault's recovery key was set up, as the key was shown; null
   * for a vault that had none. */
  setAtMs: number | null;
}

export function rememberUnfinishedRecoveryKey(
  unfinished: UnfinishedRecoveryKey | null,
): void {
  try {
    if (unfinished)
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(unfinished));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Without webview storage, the patient is not told after the next
    // unlock; the key step has said that locking cancels the key.
  }
}

/** The setup left unfinished, if any; it is forgotten once taken. */
export function takeUnfinishedRecoveryKey(): UnfinishedRecoveryKey | null {
  let stored: unknown = null;
  try {
    const text = window.localStorage.getItem(STORAGE_KEY);
    window.localStorage.removeItem(STORAGE_KEY);
    stored = text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof stored !== "object" || stored === null) return null;
  const setAtMs = (stored as { setAtMs?: unknown }).setAtMs;
  return setAtMs === null || typeof setAtMs === "number" ? { setAtMs } : null;
}

/** What the patient is told after unlocking about a setup that showed a key,
 * from when the vault's recovery key was set up now; nothing when that
 * cannot be told (a vault with no key now that had one). */
export function unfinishedRecoveryKeyMessage(
  unfinished: UnfinishedRecoveryKey,
  setAtMsNow: number | null,
): string | null {
  if (setAtMsNow === unfinished.setAtMs)
    return unfinished.setAtMs === null
      ? "Recovery key setup ended when the vault locked or myCarlos closed, so the vault still has no recovery key. If you saved or wrote down the key it showed, destroy it: that key does not open the vault."
      : "Your recovery key was not replaced: setup ended when the vault locked or myCarlos closed, and your earlier key still works. If you saved or wrote down the new key it showed, destroy it: that key does not open the vault.";
  if (setAtMsNow === null) return null;
  return `The recovery key you were shown was saved just before the vault locked or myCarlos closed, so it is now your recovery key: keep what you saved or wrote down for it.${unfinished.setAtMs === null ? "" : " Your earlier recovery key no longer works."}`;
}

import { useState, type FormEvent } from "react";
import {
  MAX_PASSPHRASE_BYTES,
  utf8Length,
  vaultErrorMessage,
  type RestoreCredential,
  type RestorePreview,
  type VaultBridge,
} from "../vault";

type Method = "passphrase" | "recoveryKey";

/** What restoring would do to this device, in plain words. */
function consequence(preview: RestorePreview): string {
  switch (preview.replaces) {
    case "nothing":
      return "Restoring puts this vault on this device.";
    case "sameVault":
      return preview.olderThanThisDevice
        ? "This backup is older than the vault on this device. Restoring it replaces the vault with the older copy: anything added or changed since the backup is lost."
        : "Restoring replaces the vault on this device with this backup.";
    case "otherVault":
      return "This device has a different vault. Restoring erases it, permanently, and puts the backup in its place.";
  }
}

/** Restores an encrypted backup while no vault is open: choose the file, open
 * it with its passphrase or recovery key, see what it would replace, and only
 * then restore. */
export function RestoreBackup({
  bridge,
  onRestored,
}: {
  bridge: Pick<VaultBridge, "pickRestoreSource" | "inspectRestore" | "restore">;
  onRestored: () => void;
}) {
  const [pickId, setPickId] = useState<string | null>(null);
  const [method, setMethod] = useState<Method>("passphrase");
  const [secret, setSecret] = useState("");
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const credential = (): RestoreCredential =>
    method === "passphrase" ? { passphrase: secret } : { recoveryKey: secret };
  // Replacing an older copy, or another vault, loses something for good.
  const needsAgreement =
    preview !== null &&
    (preview.replaces === "otherVault" || preview.olderThanThisDevice);

  const choose = async () => {
    setBusy(true);
    setError("");
    setStatus("");
    setPreview(null);
    setAgreed(false);
    try {
      const picked = await bridge.pickRestoreSource();
      setPickId(picked);
      if (picked) setStatus("Backup chosen.");
    } catch (failure) {
      setError(vaultErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const check = async (event: FormEvent) => {
    event.preventDefault();
    if (!pickId || !secret || busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    setAgreed(false);
    try {
      const found = await bridge.inspectRestore(pickId, credential());
      setPreview(found);
      setStatus(
        `The backup holds ${found.documentCount} document${found.documentCount === 1 ? "" : "s"}. ${consequence(found)}`,
      );
    } catch (failure) {
      setPreview(null);
      setError(vaultErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!pickId || !preview || busy || (needsAgreement && !agreed)) return;
    setBusy(true);
    setError("");
    setStatus("Restoring the backup. This can take a while for a large vault…");
    try {
      const restored = await bridge.restore(
        pickId,
        credential(),
        preview.replaces !== "nothing",
      );
      if (!restored) {
        // Cancelled in the native confirmation: the backup is still chosen.
        setStatus("Restore cancelled. Nothing changed.");
        return;
      }
      setSecret("");
      onRestored();
    } catch (failure) {
      setStatus("");
      setError(vaultErrorMessage(failure));
      // A pick is used up by a restore that failed.
      setPickId(null);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="restore-backup" onSubmit={(event) => void check(event)}>
      <p>
        An encrypted backup opens with the passphrase it was made with, or with
        the vault's recovery key.
      </p>
      <button
        className="button"
        type="button"
        disabled={busy}
        onClick={() => void choose()}
      >
        {pickId ? "Choose a different backup…" : "Choose backup file…"}
      </button>
      {pickId && (
        <>
          <fieldset>
            <legend>Open it with</legend>
            <label className="restore-choice">
              <input
                type="radio"
                name="restore-method"
                checked={method === "passphrase"}
                onChange={() => {
                  setMethod("passphrase");
                  setSecret("");
                  setPreview(null);
                }}
              />
              Its passphrase
            </label>
            <label className="restore-choice">
              <input
                type="radio"
                name="restore-method"
                checked={method === "recoveryKey"}
                onChange={() => {
                  setMethod("recoveryKey");
                  setSecret("");
                  setPreview(null);
                }}
              />
              Its recovery key
            </label>
          </fieldset>
          <label>
            {method === "passphrase" ? "Backup passphrase" : "Recovery key"}
            <input
              required
              type={method === "passphrase" ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              value={secret}
              onChange={(event) => {
                setSecret(event.target.value);
                setPreview(null);
              }}
            />
          </label>
          {utf8Length(secret) > MAX_PASSPHRASE_BYTES && (
            <p role="alert">This is too long. Check what you typed.</p>
          )}
          <button
            className="button"
            disabled={
              busy || !secret || utf8Length(secret) > MAX_PASSPHRASE_BYTES
            }
          >
            Check backup
          </button>
        </>
      )}
      <p className="restore-status" role="status">
        {status}
      </p>
      {error && <p role="alert">{error}</p>}
      {preview && (
        <>
          {needsAgreement && (
            <label className="restore-choice">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              {preview.replaces === "otherVault"
                ? "Erase the vault on this device and restore the backup"
                : "Replace the vault on this device with the older backup"}
            </label>
          )}
          <button
            className="button primary"
            type="button"
            disabled={busy || (needsAgreement && !agreed)}
            onClick={() => void restore()}
          >
            Restore backup
          </button>
        </>
      )}
    </form>
  );
}

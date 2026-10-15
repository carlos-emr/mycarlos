import { SecretInput } from "./SecretInput";
import { translate, getLocale, useI18n } from "../i18n";
import type { MessageKey } from "../i18n";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  MAX_PASSPHRASE_BYTES,
  utf8Length,
  vaultErrorMessage,
  type RestoreCredential,
  type RestorePreview,
  type VaultBridge,
} from "../vault";

type Method = "passphrase" | "recoveryKey";

// What is typed here is cleared after this long untouched.
const UNATTENDED_CLEAR_MS = 5 * 60 * 1000;

/** What restoring would do to this device, in plain words. */
function consequence(preview: RestorePreview): string {
  const t = (key: MessageKey) => translate(getLocale(), key);
  switch (preview.replaces) {
    case "nothing":
      return t("restore.consequence.nothing");
    case "sameVault":
      if (!preview.differsFromThisDevice) return t("restore.consequence.same");
      // Which of the two is the later one is not said: the vault may have
      // been restored and changed elsewhere since.
      return t("restore.consequence.differs");
    case "otherVault":
      return t("restore.consequence.otherVault");
    case "unreadable":
      return t("restore.consequence.unreadable");
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
  const { t } = useI18n();
  const [pickId, setPickId] = useState<string | null>(null);
  const [method, setMethod] = useState<Method>("passphrase");
  const [secret, setSecret] = useState("");
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [shown, setShown] = useState(false);
  // State is a render behind: two clicks in one tick must not both restore.
  const working = useRef(false);
  // Nothing locks this screen, so a secret typed here is cleared when the app
  // is hidden.
  useEffect(() => {
    const clearWhenHidden = () => {
      if (document.visibilityState !== "hidden") return;
      setSecret("");
      setShown(false);
      setPreview(null);
      setAgreed(false);
    };
    document.addEventListener("visibilitychange", clearWhenHidden);
    return () =>
      document.removeEventListener("visibilitychange", clearWhenHidden);
  }, []);
  // Nor may it wait on a screen left unattended.
  useEffect(() => {
    if (!secret || busy) return;
    const timer = window.setTimeout(() => {
      setSecret("");
      setShown(false);
      setPreview(null);
      setAgreed(false);
      setStatus("");
    }, UNATTENDED_CLEAR_MS);
    return () => window.clearTimeout(timer);
  }, [secret, busy, agreed, preview]);
  // The form folds back to this button when a restore fails, taking the
  // focused control with it.
  const chooseRef = useRef<HTMLButtonElement | null>(null);
  const focusChoose = useRef(false);
  useEffect(() => {
    // Once it is enabled again.
    if (busy || !focusChoose.current) return;
    focusChoose.current = false;
    chooseRef.current?.focus();
  }, [busy]);
  // A preview belongs to the secret it was checked with.
  const forgetPreview = () => {
    setPreview(null);
    setAgreed(false);
    setStatus("");
    setError("");
  };

  const secretLabel =
    method === "passphrase"
      ? t("restore.passphrase.label")
      : t("recover.key.label");
  const credential = (): RestoreCredential =>
    method === "passphrase" ? { passphrase: secret } : { recoveryKey: secret };
  // Replacing a vault that differs from the backup, another vault, or one
  // that cannot be read loses something for good.
  const needsAgreement =
    preview !== null &&
    (preview.replaces === "otherVault" ||
      preview.replaces === "unreadable" ||
      preview.differsFromThisDevice);

  const choose = async () => {
    setBusy(true);
    setError("");
    setStatus("");
    setPreview(null);
    setAgreed(false);
    try {
      const picked = await bridge.pickRestoreSource();
      setPickId(picked);
      if (picked) setStatus(t("restore.chosen"));
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
    setStatus(t("restore.checking"));
    setAgreed(false);
    try {
      const found = await bridge.inspectRestore(pickId, credential());
      setPreview(found);
      setStatus(
        t("restore.checked", {
          count: found.documentCount,
          consequence: consequence(found),
        }),
      );
    } catch (failure) {
      setPreview(null);
      setStatus("");
      setError(vaultErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!pickId || !preview || busy || (needsAgreement && !agreed)) return;
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    setStatus(t("restore.restoring"));
    try {
      const restored = await bridge.restore(
        pickId,
        credential(),
        preview.replaces !== "nothing",
      );
      if (!restored) {
        // Cancelled in the native confirmation: the backup is still chosen.
        setStatus(t("restore.cancelled"));
        return;
      }
      // Back to the start: the pick is used up, and the unlock screen this
      // may stay on must not offer it again.
      setSecret("");
      setShown(false);
      setPickId(null);
      setPreview(null);
      setAgreed(false);
      setStatus("");
      onRestored();
    } catch (failure) {
      setStatus("");
      setError(vaultErrorMessage(failure));
      // Start again from the file: the pick may be used up.
      setSecret("");
      setShown(false);
      setPickId(null);
      setPreview(null);
      setAgreed(false);
      focusChoose.current = true;
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  return (
    <form className="restore-backup" onSubmit={(event) => void check(event)}>
      <p>{t("restore.intro")}</p>
      <button
        ref={chooseRef}
        className="button"
        type="button"
        disabled={busy}
        onClick={() => void choose()}
      >
        {pickId ? t("restore.chooseOther") : t("restore.choose")}
      </button>
      {pickId && (
        <>
          <fieldset>
            <legend>{t("restore.openWith")}</legend>
            <label className="restore-choice">
              <input
                type="radio"
                name="restore-method"
                checked={method === "passphrase"}
                onChange={() => {
                  setMethod("passphrase");
                  setSecret("");
                  setShown(false);
                  forgetPreview();
                }}
              />
              {t("restore.method.passphrase")}
            </label>
            <label className="restore-choice">
              <input
                type="radio"
                name="restore-method"
                checked={method === "recoveryKey"}
                onChange={() => {
                  setMethod("recoveryKey");
                  setSecret("");
                  setShown(false);
                  forgetPreview();
                }}
              />
              {t("restore.method.recoveryKey")}
            </label>
          </fieldset>
          <label>
            {secretLabel}
            <SecretInput
              aria-label={secretLabel}
              required
              type={shown ? "text" : "password"}
              secretKind={method === "passphrase" ? "password" : "recovery key"}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={secret}
              onChange={(event) => {
                setSecret(event.target.value);
                forgetPreview();
              }}
            />
          </label>
          <button
            className="button"
            type="button"
            aria-pressed={shown}
            onClick={() => setShown((current) => !current)}
          >
            {method === "passphrase"
              ? t("restore.passphrase.show")
              : t("recover.key.show")}
          </button>
          {utf8Length(secret) > MAX_PASSPHRASE_BYTES && (
            <p role="alert">{t("restore.tooLong")}</p>
          )}
          <button
            className="button"
            disabled={
              busy || !secret || utf8Length(secret) > MAX_PASSPHRASE_BYTES
            }
          >
            {t("restore.check")}
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
              {preview.replaces === "otherVault" ||
              preview.replaces === "unreadable"
                ? t("restore.agree.erase")
                : t("restore.agree.replace")}
            </label>
          )}
          <button
            className="button primary"
            type="button"
            disabled={busy || (needsAgreement && !agreed)}
            onClick={() => void restore()}
          >
            {t("restore.submit")}
          </button>
        </>
      )}
    </form>
  );
}

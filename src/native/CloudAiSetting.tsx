import { useEffect, useId, useRef, useState } from "react";
import { message, useI18n, useTextState } from "../i18n";
import type { MessageKey } from "../i18n/locales/fluent/keys";
import {
  cloudAiBuild,
  cloudKeyRefusal,
  type CloudAiBridge,
  type CloudKeyInfo,
} from "../cloudAi";
import { useModalFocus } from "../useModalFocus";
import { ConfirmDialog } from "./ConfirmDialog";

const REFUSAL_TEXT = {
  badShape: "cloudAi.err.badShape",
  adminKey: "cloudAi.err.adminKey",
  duplicate: "cloudAi.err.duplicate",
  tooMany: "cloudAi.err.tooMany",
  badLabel: "cloudAi.err.badLabel",
} as const satisfies Record<string, MessageKey>;

/** Settings > AI helper > Cloud AI (optional) (#72): the patient's own Anthropic key and the
 * switch that turns the send on for this computer. Shown only in a build with the cloud AI flag
 * (`VITE_CLOUD_AI=1`, off by default) and a bridge. The page never holds the key after it is
 * typed: the field is emptied before the bridge is asked, and only the masked entry comes back. */
export function CloudAiSetting({ bridge }: { bridge: CloudAiBridge | null }) {
  const { t, locale } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [keys, setKeys] = useState<CloudKeyInfo[] | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<CloudKeyInfo | null>(null);
  const [error, setError] = useTextState();
  const [testStatus, setTestStatus] = useTextState();
  const [busy, setBusy] = useState(false);
  const active = cloudAiBuild() && bridge !== null;
  useEffect(() => {
    if (!active || !bridge) return;
    let live = true;
    void Promise.all([bridge.enabled(), bridge.listKeys()])
      .then(([on, list]) => {
        if (!live) return;
        setEnabled(on);
        setKeys(list);
      })
      .catch(() => live && setError(message("cloudAi.err.generic")));
    return () => {
      live = false;
    };
  }, [active, bridge, setError]);
  if (!active || !bridge) return null;
  const turn = async (on: boolean) => {
    setBusy(true);
    try {
      await bridge.setEnabled(on);
      setEnabled(on);
    } catch {
      setError(message("cloudAi.err.generic"));
    } finally {
      setBusy(false);
    }
  };
  // The key test is an explicit patient action: one request with this key, no document.
  const testKey = async (key: CloudKeyInfo) => {
    setBusy(true);
    setError("");
    setTestStatus(message("cloudAi.keyTestRunning"));
    try {
      const outcome = await bridge.testKey(key.id);
      setTestStatus(
        message(
          outcome === "accepted"
            ? "cloudAi.keyTestAccepted"
            : outcome === "rejected"
              ? "cloudAi.keyTestRejected"
              : outcome === "busy"
                ? "cloudAi.keyTestBusy"
                : outcome === "unreachable"
                  ? "cloudAi.keyTestUnreachable"
                  : "cloudAi.keyTestUnexpected",
        ),
      );
    } catch {
      setTestStatus("");
      setError(message("cloudAi.err.generic"));
    } finally {
      setBusy(false);
    }
  };
  const date = (ms: number) => new Date(ms).toLocaleDateString(locale);
  return (
    <section className="setting-row" aria-labelledby="cloud-ai-title">
      <div>
        <h2 id="cloud-ai-title">{t("cloudAi.title")}</h2>
        <p className="section-intro">{t("cloudAi.syntheticOnly")}</p>
        <p>{t("cloudAi.notice")}</p>
        <label className="native-checkbox">
          <input
            type="checkbox"
            checked={understood}
            disabled={enabled}
            onChange={(event) => setUnderstood(event.target.checked)}
          />{" "}
          {t("cloudAi.understand")}
        </label>
        <p>
          <span className={`state-pill ${enabled ? "on" : "off"}`}>
            {t(enabled ? "cloudAi.enabledState" : "cloudAi.disabledState")}
          </span>{" "}
          <button
            className="button"
            type="button"
            disabled={busy || (!enabled && !understood)}
            onClick={() => void turn(!enabled)}
          >
            {t(enabled ? "cloudAi.disable" : "cloudAi.enable")}
          </button>
        </p>
        {keys !== null && keys.length === 0 && <p>{t("cloudAi.noKey")}</p>}
        {keys !== null && keys.length > 0 && (
          <ul className="cloud-ai-keys">
            {keys.map((key) => (
              <li key={key.id}>
                <span>
                  {t("cloudAi.keyItem", {
                    label: key.label,
                    last4: key.keyLast4,
                    date: date(key.addedAtMs),
                  })}
                </span>{" "}
                <button
                  className="button"
                  type="button"
                  disabled={busy || !enabled}
                  onClick={() => void testKey(key)}
                >
                  {t("cloudAi.keyTest")}
                </button>{" "}
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={() => setRemoving(key)}
                >
                  {t("cloudAi.remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p>
          <button
            className="button"
            type="button"
            disabled={busy || !enabled || (keys?.length ?? 0) >= 4}
            onClick={() => setAdding(true)}
          >
            {t("cloudAi.addKey")}
          </button>
        </p>
        {testStatus && (
          <p className="native-dialog-status" role="status">
            {testStatus}
          </p>
        )}
        {error && (
          <p className="native-dialog-status" role="alert">
            {error}
          </p>
        )}
      </div>
      {adding && (
        <AddKeyDialog
          onCancel={() => setAdding(false)}
          onAdd={async (label, key) => {
            try {
              const added = await bridge.addKey({
                provider: "anthropic",
                label,
                key,
              });
              setKeys((list) => [...(list ?? []), added]);
              setAdding(false);
              setError("");
              return null;
            } catch (failure) {
              const refusal = cloudKeyRefusal(failure);
              return refusal ? REFUSAL_TEXT[refusal] : "cloudAi.err.generic";
            }
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={t("cloudAi.removeTitle")}
          confirmLabel={t("cloudAi.removeConfirm")}
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const key = removing;
            setRemoving(null);
            setBusy(true);
            void bridge
              .removeKey(key.id)
              .then(() =>
                setKeys((list) => (list ?? []).filter((k) => k.id !== key.id)),
              )
              .catch(() => setError(message("cloudAi.err.generic")))
              .finally(() => setBusy(false));
          }}
        >
          <p>{t("cloudAi.removeBody")}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function AddKeyDialog({
  onAdd,
  onCancel,
}: {
  /** Resolves to a message key when the key is refused, or null when it was stored. */
  onAdd: (label: string, key: string) => Promise<MessageKey | null>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement | null>(null);
  const labelRef = useRef<HTMLInputElement | null>(null);
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [refusal, setRefusal] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const labelId = useId();
  const keyId = useId();
  const helpId = useId();
  useModalFocus(true, dialogRef, onCancel, labelRef);
  const submit = async () => {
    // The secret leaves the field, and this component's state, before anything is awaited.
    const typed = key;
    setKey("");
    setBusy(true);
    const result = await onAdd(label, typed);
    setBusy(false);
    setRefusal(result);
  };
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        ref={dialogRef}
        className="record-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-ai-add-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <h2 id="cloud-ai-add-title">{t("cloudAi.addTitle")}</h2>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor={labelId}>{t("cloudAi.labelField")}</label>
          <input
            id={labelId}
            ref={labelRef}
            type="text"
            maxLength={60}
            autoComplete="off"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <label htmlFor={keyId}>{t("cloudAi.keyField")}</label>
          <input
            id={keyId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={helpId}
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <p id={helpId}>{t("cloudAi.keyHelp")}</p>
          {refusal && (
            <p className="native-dialog-status" role="alert">
              {t(refusal)}
            </p>
          )}
          <footer className="dialog-actions">
            <button className="button" type="button" onClick={onCancel}>
              {t("cloudAi.cancel")}
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={busy || label.trim() === "" || key.trim() === ""}
            >
              {t("cloudAi.add")}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

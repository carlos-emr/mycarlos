import { useEffect, useRef, useState } from "react";
import { message, useI18n, useTextState } from "../i18n";
import {
  cloudAiBuild,
  type CloudAiBridge,
  type CloudKeyInfo,
  type CloudSendPrepared,
} from "../cloudAi";
import { ConfirmDialog } from "./ConfirmDialog";

/** "Send to my AI provider…" in the anonymizer preview (#72): the per-document step. It appears
 * only in a build with the cloud AI flag, when cloud AI is on and a key is saved. Pressing it asks
 * the native side to re-check the text and say the size and cost, then opens a native-style
 * confirmation that names the provider, the key, the model, the size and the cost. Only
 * "Send" sends; Cancel, Escape and a close send nothing. This page never makes the request and
 * never holds the key. */
export function CloudSendStep({
  bridge,
  text,
  disabled,
}: {
  bridge: CloudAiBridge | null;
  /** The preview's text as it would be sent. */
  text: string;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [ready, setReady] = useState<CloudKeyInfo | null>(null);
  const [prepared, setPrepared] = useState<CloudSendPrepared | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [status, setStatus] = useTextState();
  const [busy, setBusy] = useState(false);
  // What is in flight, so an unmount or a cancel drops it.
  const exchange = useRef<string | null>(null);
  const active = cloudAiBuild() && bridge !== null;
  useEffect(() => {
    if (!active || !bridge) return;
    let live = true;
    void Promise.all([bridge.enabled(), bridge.listKeys()])
      .then(([on, keys]) => live && setReady(on ? (keys[0] ?? null) : null))
      .catch(() => live && setReady(null));
    return () => {
      live = false;
    };
  }, [active, bridge]);
  useEffect(
    () => () => {
      if (exchange.current && bridge) void bridge.cancel(exchange.current);
    },
    [bridge],
  );
  if (!active || !bridge || !ready) return null;
  const start = async () => {
    setBusy(true);
    setStatus("");
    try {
      const next = await bridge.prepare({ keyId: ready.id, text });
      exchange.current = next.exchangeId;
      setPrepared(next);
    } catch {
      setStatus(message("cloudAi.sendFailed"));
    } finally {
      setBusy(false);
    }
  };
  const drop = () => {
    const id = exchange.current;
    exchange.current = null;
    setPrepared(null);
    if (id) void bridge.cancel(id);
  };
  const send = async (next: CloudSendPrepared) => {
    setPrepared(null);
    setWorking(next.exchangeId);
    try {
      const result = await bridge.send(next.exchangeId);
      // A cancel while waiting means the answer is not shown.
      if (exchange.current === next.exchangeId) setAnswer(result.text);
    } catch {
      if (exchange.current === next.exchangeId)
        setStatus(message("cloudAi.sendFailed"));
    } finally {
      if (exchange.current === next.exchangeId) exchange.current = null;
      setWorking(null);
    }
  };
  const cancelWaiting = () => {
    drop();
    setWorking(null);
    setStatus(message("cloudAi.cancelled"));
  };
  const money = (usd: number | null) =>
    usd === null
      ? t("cloudAi.costUnknown")
      : t("cloudAi.costEstimate", {
          amount: new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: "USD",
            maximumFractionDigits: usd < 0.1 ? 3 : 2,
          }).format(usd),
        });
  return (
    <>
      <button
        className="button"
        type="button"
        disabled={disabled || busy || working !== null}
        onClick={() => void start()}
      >
        {t("cloudAi.send")}
      </button>
      <p className="cloud-ai-note">{t("cloudAi.previewNote")}</p>
      {working !== null && (
        <p className="native-dialog-status" role="status">
          {t("cloudAi.working")}{" "}
          <button className="button" type="button" onClick={cancelWaiting}>
            {t("cloudAi.cancelSend")}
          </button>
        </p>
      )}
      {status && (
        <p className="native-dialog-status" role="status">
          {status}
        </p>
      )}
      {answer !== null && (
        <section
          className="native-anonymize-paste"
          aria-labelledby="cloud-ai-answer"
        >
          <h3 id="cloud-ai-answer">{t("cloudAi.answerTitle")}</h3>
          <p>{t("cloudAi.answerLabel")}</p>
          {/* Plain text only: an answer is never read as markup. */}
          <pre className="cloud-ai-answer-text">{answer}</pre>
        </section>
      )}
      {prepared && (
        <ConfirmDialog
          title={t("cloudAi.sendTitle")}
          confirmLabel={t("cloudAi.sendConfirm")}
          onCancel={drop}
          onConfirm={() => void send(prepared)}
        >
          <p>
            {t("cloudAi.sendBody", {
              label: ready.label,
              model: prepared.modelLabel,
              characters: prepared.characters.toLocaleString(),
              cost: money(prepared.estimatedCostUsd),
            })}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

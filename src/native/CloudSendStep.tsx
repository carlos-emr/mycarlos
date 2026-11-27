import { useEffect, useRef, useState } from "react";
import { message, useI18n, useTextState } from "../i18n";
import { getLocale } from "../i18n";
import {
  cloudAiBuild,
  cloudErrorCode,
  type CloudAiBridge,
  type CloudKeyInfo,
  type CloudPrepareRequest,
  type CloudSendAnswer,
} from "../cloudAi";

/** "Send to my AI provider…" in the anonymizer preview (#72): the per-document step. It appears
 * only in a build with the cloud AI flag, when cloud AI is on and a key is saved. Pressing it asks
 * the native side to re-check the text, then to send it: the NATIVE confirmation (provider, host, key
 * label, model, document, size and estimated cost, worked out from the vault and the re-checked
 * text, never from this page) is the one and only confirmation; only its "Send" sends, and Cancel,
 * Escape and a closed dialog send nothing. This page asks for none of its own, and never makes the
 * request or holds the key. */
export function CloudSendStep({
  bridge,
  recordId,
  text,
  source,
  labels,
  removed,
  onRefused,
  disabled,
}: {
  bridge: CloudAiBridge | null;
  recordId: string;
  /** The preview's text as it would be sent. */
  text: string;
  /** The document's own text, and what was removed from it, for the restore on the native side. */
  source: string;
  labels: string[];
  removed: CloudPrepareRequest["removed"];
  /** The native re-check refused the text: the ranges that still hold something, for the preview
   * to mark (the same marking a refused Save gives). */
  onRefused?: (hits: { start: number; end: number }[]) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [ready, setReady] = useState<CloudKeyInfo | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [answer, setAnswer] = useState<CloudSendAnswer | null>(null);
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
      const next = await bridge.prepare({
        keyId: ready.id,
        recordId,
        language: getLocale(),
        text,
        source,
        labels,
        removed,
      });
      exchange.current = next.exchangeId;
      // The native side asks the patient (once) before anything leaves.
      void send(next);
    } catch (failure) {
      if (cloudErrorCode(failure) === "recheck") {
        const hits = (failure as { hits?: { start: number; end: number }[] })
          .hits;
        if (hits && hits.length > 0) onRefused?.(hits);
      }
      setStatus(message("cloudAi.sendFailed"));
    } finally {
      setBusy(false);
    }
  };
  const drop = () => {
    const id = exchange.current;
    exchange.current = null;
    if (id) void bridge.cancel(id);
  };
  const send = async (next: { exchangeId: string }) => {
    setWorking(next.exchangeId);
    try {
      const result = await bridge.send(next.exchangeId);
      // A cancel while waiting means the answer is not shown.
      if (exchange.current === next.exchangeId) setAnswer(result);
    } catch (failure) {
      if (exchange.current === next.exchangeId)
        // Cancel or Escape in the native dialog sends nothing and says so, not "failed".
        setStatus(
          message(
            cloudErrorCode(failure) === "declined"
              ? "cloudAi.cancelled"
              : "cloudAi.sendFailed",
          ),
        );
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
          <ul className="cloud-ai-answer-text">
            {answer.sentences.map((sentence, index) => (
              <li key={index}>{sentence.text}</li>
            ))}
          </ul>
          {answer.flagged.length > 0 && (
            <p>
              {t("cloudAi.answerFlagged", { marks: answer.flagged.join(", ") })}
            </p>
          )}
        </section>
      )}
    </>
  );
}

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { hasVaultErrorCode, vaultErrorMessage } from "../vault";
import { message, useI18n, useTextState } from "../i18n";
import type { ModelStatus } from "../ai/types";
import { usableSpeed, wordsPerSecond, type Speed } from "../ai/speedEstimate";

/** Settings > AI helper > "Speed on this computer" (#305): the patient starts one short check of
 * how fast the helper reads and writes here. It runs the helper once on a made-up text (nothing of
 * theirs, nothing sent anywhere), uses the processor hard for about a minute or two, and can be
 * stopped. The result is kept for this model and shown as words a second; the reader uses it for
 * an "about N minutes" before a long summary. Shown only with a model on this computer. */
export function AiSpeedCheck({ status }: { status: ModelStatus }) {
  const { t, locale } = useI18n();
  const installed = status.state === "installed";
  const [speed, setSpeed] = useState<Speed | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useTextState();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // What was measured before, if anything; asked again when the model changes.
  const model = status.state === "installed" ? status.model.sha256 : null;
  useEffect(() => {
    if (!model) {
      setSpeed(null);
      return;
    }
    void invoke<unknown>("ai_model_speed")
      .then((found) => live.current && setSpeed(usableSpeed(found)))
      .catch(() => live.current && setSpeed(null));
  }, [model]);
  if (!installed) return null;
  const start = async () => {
    setWorking(true);
    setNotice("");
    try {
      const measured = usableSpeed(
        await invoke<unknown>("ai_speed_check", {
          answerId: crypto.randomUUID(),
        }),
      );
      if (!live.current) return;
      setSpeed(measured);
      if (!measured) setNotice(message("ai.speed.failed"));
    } catch (failure) {
      if (!live.current) return;
      setNotice(
        hasVaultErrorCode(failure, "aiCancelled")
          ? message("ai.speed.cancelled")
          : vaultErrorMessage(failure),
      );
    } finally {
      if (live.current) setWorking(false);
    }
  };
  return (
    <section className="setting-row" aria-labelledby="ai-speed-title">
      <div>
        <h2 id="ai-speed-title">{t("ai.speed.title")}</h2>
        <p className="section-intro" id="ai-speed-note">
          {t("ai.speed.note")}
        </p>
        <p>
          <button
            className="button"
            type="button"
            disabled={working}
            aria-describedby="ai-speed-note"
            onClick={() => void start()}
          >
            {t("ai.speed.button")}
          </button>{" "}
          {working && (
            <button
              className="button"
              type="button"
              onClick={() =>
                void invoke<void>("ai_cancel").catch(() => undefined)
              }
            >
              {t("ai.speed.cancel")}
            </button>
          )}
        </p>
        {working && (
          <p role="status" className="native-dialog-status">
            {t("ai.speed.working")}
          </p>
        )}
        {!working && speed && (
          <p role="status" className="native-dialog-status">
            {t("ai.speed.result", {
              read: wordsPerSecond(speed.promptMilliTps, locale),
              write: wordsPerSecond(speed.answerMilliTps, locale),
            })}
          </p>
        )}
        {!working && !speed && !notice && <p>{t("ai.speed.none")}</p>}
        {notice && (
          <p role="alert" className="native-dialog-status">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}

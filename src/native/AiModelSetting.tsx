import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { AcceptedModel, ModelAddOutcome, ModelStatus } from "../ai/types";
import { ConfirmDialog } from "./ConfirmDialog";

const MB = 1_000_000;
/** The host an address leads to, for the note beside Download. */
function hostOf(address: string) {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}
const mb = (bytes: number) => Math.round(bytes / MB).toLocaleString();

/** The refusal text for an add that did not end `added` or `cancelled`. */
function refusalKey(outcome: ModelAddOutcome) {
  switch (outcome.outcome) {
    case "notListed":
    case "tooBig":
      return "ai.model.refusedList";
    case "wrongHash":
      return "ai.model.refusedHash";
    case "incomplete":
    case "unreadable":
      return "ai.model.refusedIncomplete";
    case "noDisk":
      return "ai.model.refusedDisk";
    case "busy":
      return "ai.model.refusedBusy";
    case "network":
      return "ai.model.refusedNetwork";
    case "unavailable":
      return "ai.model.refusedUnavailable";
    case "unsupported":
      return unsupportedKey(outcome.reason);
    default:
      return "ai.model.refusedStorage";
  }
}

function unsupportedKey(reason: "ram" | "cpu" | "platform") {
  return reason === "ram"
    ? "ai.model.unsupportedRam"
    : reason === "cpu"
      ? "ai.model.unsupportedCpu"
      : "ai.model.unsupportedPlatform";
}

/** Preferences > AI helper: getting the model onto this computer (#72). The
 * patient gets the file themselves (the address is text, to copy; nothing is
 * opened), adds it here, and may remove it. The page never handles a path:
 * the picker opens inside the native command. */
export function AiModelSetting({
  status,
  onStatus,
}: {
  status: ModelStatus;
  onStatus: (status: ModelStatus) => void;
}) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<AcceptedModel[]>([]);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void invoke<AcceptedModel[]>("ai_model_catalog").then(
      (found) => mounted.current && setCatalog(found),
      () => undefined,
    );
    const stop = listen<{ done: number; total: number }>(
      "ai-model-add-progress",
      (event) => mounted.current && setProgress(event.payload),
    ).catch(() => () => undefined);
    return () => {
      mounted.current = false;
      void stop.then((unlisten) => unlisten());
    };
  }, []);

  const adding = progress !== null;
  const [downloading, setDownloading] = useState(false);
  const run = (command: "ai_model_add_picked" | "ai_model_download") => {
    setRefusal(null);
    setMessage(null);
    setDownloading(command === "ai_model_download");
    // Busy from the click: the picker is open, and a second click is refused.
    setProgress({ done: 0, total: 0 });
    void invoke<ModelAddOutcome>(command)
      .then((result) => {
        if (!mounted.current) return;
        if (result.outcome === "added") {
          onStatus(result.status);
          setMessage("ai.model.added");
        } else if (result.outcome !== "cancelled") {
          setRefusal(refusalKey(result));
        }
      })
      .catch(() => mounted.current && setRefusal("ai.model.refusedStorage"))
      .finally(() => mounted.current && setProgress(null));
  };
  const add = () => run("ai_model_add_picked");
  const download = () => run("ai_model_download");
  const remove = () => {
    setConfirming(false);
    setRefusal(null);
    setMessage(null);
    void invoke<ModelStatus>("ai_model_remove").then(
      (next) => mounted.current && onStatus(next),
      (failure: { code?: string }) =>
        mounted.current &&
        setRefusal(
          failure?.code === "busy"
            ? "ai.model.refusedBusy"
            : "ai.model.refusedStorage",
        ),
    );
  };

  return (
    <div className="native-ai-model">
      {status.state === "unsupported" && (
        <p>{t(unsupportedKey(status.reason))}</p>
      )}
      {status.state === "installed" && (
        <p>{t("ai.model.installed", { name: status.model.name })}</p>
      )}
      {status.state === "damaged" && <p>{t("ai.model.damaged")}</p>}
      {status.state === "notInstalled" &&
        catalog.map((model) => (
          <div key={model.sha256} className="native-ai-model-entry">
            <p>
              {t("ai.model.accepted", {
                name: model.name,
                size: mb(model.sizeBytes),
                licence: model.licence,
              })}
            </p>
            <p>{t("ai.model.where")}</p>
            <p className="native-ai-model-url">
              <code>{model.sourceUrl}</code>{" "}
              <button
                className="button"
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(model.sourceUrl)
                    .then(() => setMessage("ai.model.copied"))
                    .catch(() => undefined);
                }}
              >
                {t("ai.model.copy")}
              </button>
            </p>
            {model === catalog[0] && (
              <p>
                {t("ai.model.downloadNote", {
                  size: mb(model.sizeBytes),
                  host: hostOf(model.sourceUrl),
                })}
              </p>
            )}
            {model.notices.map((notice) => (
              <p key={notice}>{notice}</p>
            ))}
          </div>
        ))}
      <div className="native-ai-model-actions">
        {status.state === "notInstalled" && catalog.length > 0 && (
          <button
            className="button primary"
            type="button"
            disabled={adding}
            onClick={download}
          >
            {t("ai.model.download")}
          </button>
        )}
        {status.state === "notInstalled" && (
          <button
            className="button"
            type="button"
            disabled={adding}
            onClick={add}
          >
            {t("ai.model.add")}
          </button>
        )}
        {(status.state === "installed" || status.state === "damaged") && (
          <button
            className="button"
            type="button"
            onClick={() => setConfirming(true)}
          >
            {t("ai.model.remove")}
          </button>
        )}
        {adding && progress.total > 0 && (
          <button
            className="button"
            type="button"
            onClick={() => void invoke("ai_model_add_cancel")}
          >
            {t("common.cancel")}
          </button>
        )}
      </div>
      <p role="status" className="native-ai-model-status">
        {adding && progress.total > 0
          ? t(downloading ? "ai.model.downloading" : "ai.model.checking", {
              done: mb(progress.done),
              total: mb(progress.total),
            })
          : message
            ? t(message as "ai.model.added")
            : ""}
      </p>
      {refusal && (
        <p role="alert" className="native-ai-model-refusal">
          {t(refusal as "ai.model.refusedStorage")}
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          title={t("ai.model.remove")}
          confirmLabel={t("ai.model.remove")}
          danger
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        >
          {t("ai.model.removeConfirm")}
        </ConfirmDialog>
      )}
    </div>
  );
}

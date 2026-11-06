import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState, type RefObject } from "react";
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
/** A copy running natively (#275), as `ai_model_add_active` gives it:
 * `download` is the default model's download and its check, `check` a picked
 * file's check. */
type ModelAddNow = { kind: "download" | "check"; done: number; total: number };

/** How much of the file is in, as a whole percent (#275). */
export const percentOf = (done: number, total: number) =>
  total > 0 ? Math.min(100, Math.max(0, Math.floor((done / total) * 100))) : 0;

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

/** The bar under the status text while a model file comes in or is checked
 * (#275), from the same byte counts, so a resumed download starts where it
 * stopped. It is not a live region: the status text above says the progress,
 * at its own pace. Cancel sits beside it. */
function ModelProgress({
  done,
  total,
  cancelRef,
}: {
  done: number;
  total: number;
  cancelRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t, locale } = useI18n();
  const percent = percentOf(done, total);
  const percentText = new Intl.NumberFormat(locale, {
    style: "percent",
  }).format(percent / 100);
  return (
    <div className="native-ai-model-progress">
      <div
        className="native-ai-model-bar"
        role="progressbar"
        aria-label={t("ai.model.progressName")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={t("ai.model.progressValue", {
          percent: percentText,
          done: mb(done),
          total: mb(total),
        })}
      >
        <div
          className="native-ai-model-bar-fill"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="native-ai-model-percent" aria-hidden="true">
        {percentText}
      </span>
      <button
        ref={cancelRef}
        className="button"
        type="button"
        onClick={() => void invoke("ai_model_add_cancel")}
      >
        {t("common.cancel")}
      </button>
    </div>
  );
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
  // Keyboard focus stays in the row: the button that started a copy is not
  // disabled (so it never drops the focus); Cancel takes it when it appears;
  // when the copy or a removal ends, focus goes to the control that follows.
  const downloadRef = useRef<HTMLButtonElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const removeRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const starter = useRef<"download" | "add">("add");
  const after = useRef<null | "installed" | "restart" | "removed">(null);
  const cancelFocused = useRef(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  /** Focus is free to move only when it is on nothing, or inside this row. */
  const focusIsFree = () => {
    const active = document.activeElement;
    return (
      active === null ||
      active === document.body ||
      !!rowRef.current?.contains(active)
    );
  };
  useEffect(() => {
    if (!progress || progress.total === 0 || cancelFocused.current) return;
    if (focusIsFree()) {
      cancelFocused.current = true;
      cancelRef.current?.focus();
    }
  }, [progress]);
  useEffect(() => {
    const what = after.current;
    if (!what || adding) return;
    let target: HTMLButtonElement | null = null;
    if (what === "installed" && status.state === "installed")
      target = removeRef.current;
    else if (what === "restart" && status.state === "notInstalled")
      target =
        (starter.current === "download" ? downloadRef : addRef).current ??
        downloadRef.current ??
        addRef.current;
    else if (what === "removed" && status.state === "notInstalled")
      target = downloadRef.current ?? addRef.current;
    if (!target) return;
    after.current = null;
    if (focusIsFree()) target.focus();
  }, [status.state, adding, refusal, catalog]);
  // A copy this row did not start may still run (#275): the patient went to
  // another page while it ran, and came back. `own` is a copy this row
  // started and waits for through its command response.
  const own = useRef(false);
  const endedWhileOwn = useRef<ModelAddOutcome | null>(null);
  // Events and actions supersede an older native snapshot, even when the
  // snapshot was requested before a completion arrived.
  const activityRevision = useRef(0);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const [note, setNote] = useState<
    "ai.model.stillDownloading" | "ai.model.stillChecking" | null
  >(null);
  const attach = (now: ModelAddNow) => {
    setDownloading(now.kind === "download");
    starter.current = now.kind === "download" ? "download" : "add";
    after.current = "restart";
    // Progress heard since is newer than what native said.
    setProgress((current) =>
      current && current.total > 0
        ? current
        : { done: now.done, total: now.total },
    );
  };
  const finish = (result: ModelAddOutcome) => {
    activityRevision.current += 1;
    setNote(null);
    setProgress(null);
    if (result.outcome === "added") {
      after.current = "installed";
      onStatus(result.status);
      setMessage("ai.model.added");
    } else if (result.outcome !== "cancelled") {
      setRefusal(refusalKey(result));
    }
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    let live = true;
    // Subscribe before reading the snapshot: completion can happen while
    // registration or the query is pending. It must never resurrect a bar.
    const stop = listen<ModelAddOutcome>("ai-model-add-ended", (event) => {
      if (!live || !mounted.current) return;
      activityRevision.current += 1;
      if (own.current) endedWhileOwn.current = event.payload;
      else finishRef.current(event.payload);
    });
    void stop
      .then(async () => {
        if (!live || !mounted.current || own.current) return;
        const revision = activityRevision.current;
        const current = () =>
          live &&
          mounted.current &&
          !own.current &&
          revision === activityRevision.current;
        const now = await invoke<ModelAddNow | null>("ai_model_add_active");
        if (!current()) return;
        if (now) attach(now);
        else {
          // A copy could have ended before subscription was ready. Refresh
          // the installed state as well, without starting another download.
          const next = await invoke<ModelStatus>("ai_model_status");
          if (current() && next) onStatusRef.current(next);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
      void stop.then((unlisten) => unlisten()).catch(() => undefined);
    };
    // Once, as the row opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = (command: "ai_model_add_picked" | "ai_model_download") => {
    activityRevision.current += 1;
    endedWhileOwn.current = null;
    setRefusal(null);
    setMessage(null);
    setNote(null);
    setDownloading(command === "ai_model_download");
    starter.current = command === "ai_model_download" ? "download" : "add";
    cancelFocused.current = false;
    after.current = "restart";
    own.current = true;
    // Busy from the click: the picker is open, and a second click is refused.
    setProgress({ done: 0, total: 0 });
    void invoke<ModelAddOutcome>(command)
      .then(async (result) => {
        if (!mounted.current) return;
        own.current = false;
        // Refused because a copy is still running: that copy and its bar,
        // not "the AI helper is working".
        if (result.outcome === "busy") {
          // The other copy may have finished before this refused command
          // returned. Its completion is newer than the refusal.
          if (endedWhileOwn.current) {
            finish(endedWhileOwn.current);
            return;
          }
          const revision = activityRevision.current;
          const now = await invoke<ModelAddNow | null>(
            "ai_model_add_active",
          ).catch(() => null);
          if (!mounted.current) return;
          if (revision !== activityRevision.current) return;
          if (now) {
            attach(now);
            setNote(
              now.kind === "download"
                ? "ai.model.stillDownloading"
                : "ai.model.stillChecking",
            );
            return;
          }
        }
        // An earlier download can finish while this command's picker is
        // open. Cancelling that picker or refusing its file does not undo
        // the model that was installed in the meantime.
        if (
          result.outcome !== "added" &&
          endedWhileOwn.current?.outcome === "added"
        )
          onStatus(endedWhileOwn.current.status);
        finish(result);
      })
      .catch(() => {
        if (!mounted.current) return;
        own.current = false;
        setProgress(null);
        setRefusal("ai.model.refusedStorage");
      });
  };
  const add = () => run("ai_model_add_picked");
  const download = () => run("ai_model_download");
  const remove = () => {
    activityRevision.current += 1;
    setConfirming(false);
    setRefusal(null);
    setMessage(null);
    after.current = "removed";
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
    <div className="native-ai-model" ref={rowRef}>
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
            ref={downloadRef}
            className="button primary"
            type="button"
            aria-disabled={adding}
            onClick={() => !adding && download()}
          >
            {t("ai.model.download")}
          </button>
        )}
        {status.state === "notInstalled" && (
          <button
            ref={addRef}
            className="button"
            type="button"
            aria-disabled={adding}
            onClick={() => !adding && add()}
          >
            {t("ai.model.add")}
          </button>
        )}
        {(status.state === "installed" || status.state === "damaged") && (
          <button
            ref={removeRef}
            className="button"
            type="button"
            onClick={() => setConfirming(true)}
          >
            {t("ai.model.remove")}
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
      {adding && progress.total > 0 && (
        <ModelProgress
          done={progress.done}
          total={progress.total}
          cancelRef={cancelRef}
        />
      )}
      {note && adding && (
        <p role="alert" className="native-ai-model-note">
          {t(note)}
        </p>
      )}
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

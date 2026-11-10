import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useI18n } from "../i18n";
import type { ModelRow, ModelAddOutcome, ModelStatus } from "../ai/types";
import { ConfirmDialog } from "./ConfirmDialog";

const MB = 1_000_000;
// Only a reconciliation signal: a reopened view reads the current native pair.
const MUTATION_SETTLED = "mycarlos-model-mutation-settled";
/** The host an address leads to, for the note beside Download. */
function hostOf(address: string) {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}
const mb = (bytes: number, locale?: string) =>
  Math.round(bytes / MB).toLocaleString(locale);
/** A copy running natively (#275), as `ai_model_add_active` gives it:
 * `download` is a catalog model's download and its check, `check` a picked
 * file's check. */
type CopyProgress = { done: number; total: number; index?: number | null };
type ModelAddNow = CopyProgress & { kind: "download" | "check" };

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

/** The bar and counts below it while a model file comes in or is checked.
 * Resumed downloads keep the same native byte counts. The separate mounted
 * status region announces progress; these visible counts are not a live region. */
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
      {total > 0 && (
        <div
          className="native-ai-model-bar"
          role="progressbar"
          aria-label={t("ai.model.progressName")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={t("ai.model.progressValue", {
            percent: percentText,
            done: mb(done, locale),
            total: mb(total, locale),
          })}
        >
          <div
            className="native-ai-model-bar-fill"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      {total > 0 && (
        <span className="native-ai-model-percent" aria-hidden="true">
          {t("ai.model.progressValue", {
            percent: percentText,
            done: mb(done, locale),
            total: mb(total, locale),
          })}
        </span>
      )}
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

/** Settings > AI helper: native catalog rows and the model used on this device.
 * Files and the remembered choice stay native; the renderer sends catalog indices only. */
export function AiModelSetting({
  status,
  onStatus,
}: {
  status: ModelStatus;
  onStatus: (status: ModelStatus) => void;
}) {
  const { t, locale } = useI18n();
  const mb = (bytes: number) => Math.round(bytes / MB).toLocaleString(locale);
  const id = useId();
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [listError, setListError] = useState(false);
  const [progress, setProgress] = useState<CopyProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [working, setWorking] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ModelRow | null>(null);
  const [note, setNote] = useState<
    "ai.model.stillDownloading" | "ai.model.stillChecking" | null
  >(null);
  // The window may not listen for the app's events (a missing capability):
  // progress then comes from asking the native side instead.
  const [eventsRefused, setEventsRefused] = useState(false);
  const mounted = useRef(true);
  const activityRevision = useRef(0);
  const progressObserved = useRef(false);
  const listRequest = useRef(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const publishedStatus = useRef(status);
  const statusProp = useRef(status);
  if (statusProp.current !== status) {
    statusProp.current = status;
    publishedStatus.current = status;
  }
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = (next) => {
    publishedStatus.current = next;
    onStatus(next);
  };
  const own = useRef(false);
  const mutating = useRef(false);
  const mutationRequest = useRef(0);
  const mutationNotice = useRef(false);
  const endedWhileOwn = useRef<ModelAddOutcome | null>(null);
  const starter = useRef<"download" | "add">("add");
  const targetIndex = useRef<number | null>(null);
  const beforeAdd = useRef<ModelRow[]>([]);
  const after = useRef<null | "installed" | "restart" | "removed">(null);
  const cancelFocused = useRef(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const downloadRefs = useRef(new Map<number, HTMLButtonElement>());
  const removeRefs = useRef(new Map<number, HTMLButtonElement>());
  const radioRefs = useRef(new Map<number, HTMLInputElement>());
  const addRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const adding = progress !== null;
  const busy = adding || working;
  const unsupported = status.state === "unsupported";
  const focusIsFree = () => {
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      active === addRef.current ||
      active === cancelRef.current
    )
      return true;
    const index = progress?.index ?? targetIndex.current;
    const scope =
      index === null || index === undefined
        ? null
        : rowRef.current?.querySelector(`[data-model-index="${index}"]`);
    return !!scope?.contains(active);
  };

  /** Status and rows from a reconciliation are published together. A completion
   * invalidates the read, never the admitted mutation's ownership. */
  const reloadRows = async (reconcile = false, duringMutation = false) => {
    if (mutating.current && !duringMutation) return;
    const request = ++listRequest.current;
    setRefreshing(true);
    const current = () => mounted.current && request === listRequest.current;
    try {
      while (current()) {
        const revision = activityRevision.current;
        try {
          const [next, nextStatus] = await Promise.all([
            invoke<ModelRow[]>("ai_models"),
            reconcile
              ? invoke<ModelStatus>("ai_model_status")
              : Promise.resolve(null),
          ]);
          if (!Array.isArray(next) || (reconcile && !nextStatus))
            throw new Error("Unreadable model list");
          if (!current() || (mutating.current && !duringMutation)) return;
          if (revision !== activityRevision.current) {
            if (reconcile) continue;
            return;
          }
          setRows(next);
          if (
            nextStatus &&
            JSON.stringify(publishedStatus.current) !==
              JSON.stringify(nextStatus)
          )
            onStatusRef.current(nextStatus);
          setLoaded(true);
          setListError(false);
          return;
        } catch {
          if (!current() || (mutating.current && !duringMutation)) return;
          if (reconcile && revision !== activityRevision.current) continue;
          setListError(true);
          return;
        }
      }
    } finally {
      if (current()) setRefreshing(false);
    }
  };
  const reloadRef = useRef(reloadRows);
  reloadRef.current = reloadRows;

  useEffect(() => {
    let live = true;
    mounted.current = true;
    const settled = () => {
      activityRevision.current += 1;
      void reloadRef.current(true);
    };
    window.addEventListener(MUTATION_SETTLED, settled);
    void reloadRef.current();
    const stop = listen<CopyProgress>("ai-model-add-progress", (event) => {
      if (!live || !mounted.current) return;
      if (!progressObserved.current) {
        progressObserved.current = true;
        activityRevision.current += 1;
        if (!own.current) void reloadRef.current(true);
      }
      const index = event.payload.index;
      if (typeof index === "number" && Number.isInteger(index) && index >= 0) {
        setDownloading(true);
        starter.current = "download";
        targetIndex.current = index;
        if (!own.current && !mutating.current) after.current = "restart";
      }
      setProgress((current) => ({
        ...event.payload,
        // Older native builds omit index; an own download still knows its row.
        index: event.payload.index ?? current?.index ?? null,
      }));
    }).catch(() => {
      if (live) setEventsRefused(true);
      return () => undefined;
    });
    return () => {
      live = false;
      mounted.current = false;
      window.removeEventListener(MUTATION_SETTLED, settled);
      void stop.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (
      !progress ||
      (!downloading && progress.total === 0) ||
      cancelFocused.current
    )
      return;
    if (focusIsFree()) {
      cancelFocused.current = true;
      cancelRef.current?.focus();
    }
  }, [progress, downloading]);
  useEffect(() => {
    const what = after.current;
    if (!what || adding || working || refreshing || !loaded || listError)
      return;
    const index = targetIndex.current;
    let target: HTMLElement | null | undefined;
    if (what === "installed") {
      const installed =
        rows.find((row) => row.index === index && row.state === "installed") ??
        rows.find(
          (row) =>
            row.state === "installed" &&
            row.addedByYou &&
            !beforeAdd.current.some(
              (old) => old.index === row.index && old.addedByYou,
            ),
        ) ??
        rows.find(
          (row) =>
            row.state === "installed" &&
            !beforeAdd.current.some(
              (old) => old.index === row.index && old.state === "installed",
            ),
        );
      if (installed) target = removeRefs.current.get(installed.index);
      else if (index === null) target = addRef.current;
    } else if (what === "restart") {
      target =
        starter.current === "download" && index !== null
          ? downloadRefs.current.get(index)
          : addRef.current;
    } else if (what === "removed") {
      target = index === null ? null : downloadRefs.current.get(index);
      target ??=
        radioRefs.current.get(rows.find((row) => row.inUse)?.index ?? -1) ??
        addRef.current;
    }
    if (!target) return;
    after.current = null;
    if (focusIsFree()) target.focus();
  }, [rows, loaded, adding, working, refreshing, refusal, listError]);

  const attach = (now: ModelAddNow) => {
    mutationNotice.current = false;
    setDownloading(now.kind === "download");
    starter.current = now.kind === "download" ? "download" : "add";
    targetIndex.current = now.index ?? null;
    after.current = "restart";
    setProgress((current) =>
      current && current.total > 0
        ? { ...current, index: now.index ?? current.index ?? null }
        : { done: now.done, total: now.total, index: now.index ?? null },
    );
  };
  const finish = (result: ModelAddOutcome, foreign = false) => {
    activityRevision.current += 1;
    progressObserved.current = false;
    setNote(null);
    setProgress(null);
    if (result.outcome === "added" && (!foreign || !mutationNotice.current)) {
      after.current = "installed";
      if (!foreign) onStatusRef.current(result.status);
      setMessage("ai.model.added");
    } else if (
      result.outcome !== "cancelled" &&
      result.outcome !== "added" &&
      (!foreign || !mutationNotice.current)
    ) {
      setRefusal(refusalKey(result));
    }
    void reloadRef.current(foreign);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    let live = true;
    const stop = listen<ModelAddOutcome>("ai-model-add-ended", (event) => {
      if (!live || !mounted.current) return;
      activityRevision.current += 1;
      if (own.current) endedWhileOwn.current = event.payload;
      else if (!mutating.current) finishRef.current(event.payload, true);
      else {
        setProgress(null);
        setNote(null);
      }
    });
    // Reattach to a running copy whether or not the listener could register.
    void stop
      .catch(() => undefined)
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
        else if (current() && now === null) {
          // A completion may have preceded listener registration.
          void reloadRef.current(true);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
      void stop.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, []);

  // Without events, ask about the running copy each second while one runs, so
  // its progress never goes unseen. Its own call still ends it as usual.
  const polling = eventsRefused && progress !== null;
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => {
      void invoke<ModelAddNow | null>("ai_model_add_active")
        .then((now) => {
          if (!mounted.current) return;
          if (now)
            setProgress((current) =>
              current
                ? {
                    done: now.done,
                    total: now.total,
                    index: now.index ?? current.index ?? null,
                  }
                : current,
            );
          else if (!own.current) {
            setProgress(null);
            void reloadRef.current(true);
          }
        })
        .catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [polling]);

  const run = (
    command: "ai_model_add_picked" | "ai_model_download",
    index: number | null,
  ) => {
    if (busy || own.current || mutating.current) return;
    activityRevision.current += 1;
    endedWhileOwn.current = null;
    progressObserved.current = false;
    mutationNotice.current = false;
    setRefusal(null);
    setMessage(null);
    setNote(null);
    setDownloading(command === "ai_model_download");
    starter.current = command === "ai_model_download" ? "download" : "add";
    targetIndex.current = index;
    beforeAdd.current = rowsRef.current;
    cancelFocused.current = false;
    after.current = "restart";
    own.current = true;
    setProgress({ done: 0, total: 0, index });
    const result =
      index === null
        ? invoke<ModelAddOutcome>(command)
        : invoke<ModelAddOutcome>(command, { request: { index } });
    void result
      .then(async (ended) => {
        if (!mounted.current) return;
        own.current = false;
        if (ended.outcome === "busy") {
          if (endedWhileOwn.current) {
            finishRef.current(endedWhileOwn.current);
            return;
          }
          const revision = activityRevision.current;
          const now = await invoke<ModelAddNow | null>(
            "ai_model_add_active",
          ).catch(() => null);
          if (!mounted.current || revision !== activityRevision.current) return;
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
        if (
          ended.outcome !== "added" &&
          endedWhileOwn.current?.outcome === "added"
        )
          onStatusRef.current(endedWhileOwn.current.status);
        finishRef.current(ended);
      })
      .catch(() => {
        if (!mounted.current) return;
        own.current = false;
        setProgress(null);
        setNote(null);
        if (endedWhileOwn.current?.outcome === "added")
          onStatusRef.current(endedWhileOwn.current.status);
        void reloadRef.current();
        setRefusal("ai.model.refusedStorage");
      });
  };

  const mutate = async (
    command: "ai_model_use" | "ai_model_remove",
    index: number,
  ) => {
    if (busy || own.current || mutating.current) return;
    mutating.current = true;
    mutationNotice.current = true;
    const mutation = ++mutationRequest.current;
    activityRevision.current += 1;
    setWorking(true);
    setRefusal(null);
    setMessage(null);
    setConfirming(null);
    after.current = command === "ai_model_remove" ? "removed" : null;
    if (command === "ai_model_remove") targetIndex.current = index;
    try {
      await invoke<ModelStatus>(command, { request: { index } });
      if (!mounted.current || mutation !== mutationRequest.current) return;
      if (command === "ai_model_use") setMessage("ai.models.changed");
    } catch (failure) {
      if (!mounted.current || mutation !== mutationRequest.current) return;
      after.current = null;
      setRefusal(
        (failure as { code?: string })?.code === "busy"
          ? "ai.model.refusedBusy"
          : "ai.model.refusedStorage",
      );
    } finally {
      // The invoking view may have closed. Never publish its returned status:
      // any current view must reconcile authoritative rows and status together.
      window.dispatchEvent(new Event(MUTATION_SETTLED));
      if (mounted.current && mutation === mutationRequest.current) {
        await reloadRef.current(true, true);
        mutating.current = false;
        setWorking(false);
      }
    }
  };
  const progressIndex = progress?.index;
  const copyIndex =
    downloading &&
    progressIndex !== null &&
    progressIndex !== undefined &&
    rows.some((row) => row.index === progressIndex)
      ? progressIndex
      : null;
  const copyPhase = t(
    progress && progress.total > 0 && progress.done >= progress.total
      ? "ai.models.installing"
      : "ai.models.downloading",
  );
  const copyText =
    adding && progress.total > 0
      ? t(downloading ? "ai.model.downloading" : "ai.model.checking", {
          done: mb(progress.done),
          total: mb(progress.total),
        })
      : adding
        ? t(downloading ? "ai.models.starting" : "ai.models.picking")
        : message
          ? t(message as "ai.model.added")
          : "";
  const copyContent = () => (
    <>
      {copyIndex !== null && progress?.total === 0 && (
        <p className="native-ai-model-status">{copyText}</p>
      )}
      {adding && (downloading || progress.total > 0) && (
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
    </>
  );
  return (
    <div className="native-ai-model" ref={rowRef}>
      {unsupported && <p>{t(unsupportedKey(status.reason))}</p>}
      <h3>{t("ai.models.title")}</h3>
      <p id={`${id}-help`}>{t("ai.models.help")}</p>
      {!loaded && !listError && <p>{t("ai.models.loading")}</p>}
      <div
        role={rows.length ? "radiogroup" : undefined}
        aria-label={rows.length ? t("ai.models.group") : undefined}
        aria-describedby={`${id}-help`}
        className="native-ai-model-list"
      >
        {rows.map((row) => {
          const prefix = `${id}-${row.index}`;
          return (
            <section
              key={row.index}
              data-model-index={row.index}
              className="native-ai-model-entry"
              aria-labelledby={`${prefix}-name`}
            >
              <div className="native-ai-model-row-head">
                <label className="native-ai-model-choice">
                  <input
                    type="radio"
                    name={`${id}-model`}
                    checked={row.inUse}
                    disabled={row.state !== "installed" || unsupported}
                    aria-disabled={busy}
                    aria-describedby={`${prefix}-details ${prefix}-state`}
                    onChange={() =>
                      !busy && void mutate("ai_model_use", row.index)
                    }
                    ref={(node) => {
                      if (node) radioRefs.current.set(row.index, node);
                      else radioRefs.current.delete(row.index);
                    }}
                  />
                  <strong id={`${prefix}-name`}>{row.model.name}</strong>
                </label>
                <div className="native-ai-model-actions">
                  {!unsupported && row.state === "notDownloaded" && (
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy}
                      aria-disabled={busy}
                      aria-labelledby={`${prefix}-download ${prefix}-name`}
                      ref={(node) => {
                        if (node) downloadRefs.current.set(row.index, node);
                        else downloadRefs.current.delete(row.index);
                      }}
                      onClick={() => run("ai_model_download", row.index)}
                    >
                      <span id={`${prefix}-download`}>
                        {copyIndex === row.index
                          ? copyPhase
                          : t("ai.models.download")}
                      </span>
                    </button>
                  )}
                  {!unsupported && row.state !== "notDownloaded" && (
                    <button
                      type="button"
                      className="button"
                      aria-disabled={busy}
                      aria-labelledby={`${prefix}-remove ${prefix}-name`}
                      ref={(node) => {
                        if (node) removeRefs.current.set(row.index, node);
                        else removeRefs.current.delete(row.index);
                      }}
                      onClick={() => !busy && setConfirming(row)}
                    >
                      <span id={`${prefix}-remove`}>
                        {t("ai.models.remove")}
                      </span>
                    </button>
                  )}
                </div>
              </div>
              <p id={`${prefix}-details`}>
                {t("ai.model.accepted", {
                  name: row.model.name,
                  size: mb(row.model.sizeBytes),
                  licence: row.model.licence,
                })}
              </p>
              <p id={`${prefix}-state`}>
                {copyIndex === row.index
                  ? copyPhase
                  : row.state === "damaged"
                    ? t("ai.model.damaged")
                    : t(
                        row.state === "installed"
                          ? "ai.models.installed"
                          : "ai.models.notDownloaded",
                      )}
                {row.addedByYou && <> · {t("ai.models.addedByYou")}</>}
                {row.inUse && (
                  <>
                    {" "}
                    · <strong>{t("ai.models.inUse")}</strong>
                  </>
                )}
              </p>
              {!unsupported && row.state === "notDownloaded" && (
                <>
                  <p>{t("ai.model.where")}</p>
                  <p className="native-ai-model-url">
                    <code>{row.model.sourceUrl}</code>{" "}
                    <button
                      className="button"
                      type="button"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(row.model.sourceUrl)
                          .then(() => setMessage("ai.model.copied"))
                          .catch(() => undefined);
                      }}
                    >
                      {t("ai.model.copy")}
                    </button>
                  </p>
                  <p>
                    {t("ai.model.downloadNote", {
                      size: mb(row.model.sizeBytes),
                      host: hostOf(row.model.sourceUrl),
                    })}
                  </p>
                </>
              )}
              {row.model.notices.map((notice) => (
                <p key={notice}>{notice}</p>
              ))}
              {copyIndex === row.index && copyContent()}
            </section>
          );
        })}
      </div>
      {!unsupported && loaded && (
        <button
          ref={addRef}
          className="button"
          type="button"
          aria-disabled={busy}
          onClick={() => run("ai_model_add_picked", null)}
        >
          {t("ai.model.add")}
        </button>
      )}
      {/* Keep the live region mounted as visible progress moves between rows. */}
      <p
        role="status"
        className={copyIndex === null ? "native-ai-model-status" : "sr-only"}
      >
        {copyText}
      </p>
      {copyIndex === null && copyContent()}
      {listError && (
        <div>
          <p role="alert">{t("ai.models.loadFailed")}</p>
          {!unsupported && (
            <button
              className="button"
              type="button"
              onClick={() => void reloadRef.current(true)}
            >
              {t("ai.models.retry")}
            </button>
          )}
        </div>
      )}
      {refusal && (
        <p role="alert" className="native-ai-model-refusal">
          {t(refusal as "ai.model.refusedStorage")}
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          title={`${t("ai.models.remove")} ${confirming.model.name}`}
          confirmLabel={`${t("ai.models.remove")} ${confirming.model.name}`}
          danger
          onConfirm={() => void mutate("ai_model_remove", confirming.index)}
          onCancel={() => setConfirming(null)}
        >
          {t("ai.model.removeConfirm")}
        </ConfirmDialog>
      )}
    </div>
  );
}

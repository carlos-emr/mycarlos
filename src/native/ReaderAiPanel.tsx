import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatDate, getLocale, t as translateNow, useI18n } from "../i18n";
import { explainTerm, summarizeDocument } from "../ai/localModel";
import {
  ModelCancelled,
  ModelNotInstalled,
  type AiTool,
  type DocumentText,
  type ExplainResult,
  type LocalModel,
  type ModelInfo,
  type ModelStatus,
  type SourceSpan,
  type SummaryResult,
} from "../ai/types";

/** What the reader needs to offer the AI helper (#72): the model, the whole
 * document's text, and a way to the Preferences screen. */
export interface ReaderAi {
  model: LocalModel;
  /** The whole document's text, page by page. */
  loadText: () => Promise<DocumentText>;
  /** Stops a text read still going: the panel closed before it ended. */
  cancelText: () => void;
  onOpenPreferences: () => void;
  /** Runs `open` once the patient may use the helper: at once, or after the
   * notice about it, the first time in a session that a model is there. */
  beforeFirstUse?: (open: () => void) => void;
}

const NOT_INSTALLED: ModelStatus = { state: "notInstalled" };
/** The longest term to explain, typed or selected: the native side refuses
 * a longer one (AGREEMENT.md). */
export const TERM_MAX = 200;

/** The AI helper's panel in the reader: a plain-words summary of the
 * document, or the explanation of a term. Until a model is installed it says
 * so and points to Preferences. Every result carries the "Written by AI"
 * label, and the tool, model and date it came from. */
export function ReaderAiPanel({
  ai,
  tool,
  initialTerm,
  contextFor,
  onShowSource,
}: {
  ai: ReaderAi;
  tool: AiTool;
  /** Words selected in the page text when the panel opened, if any. */
  initialTerm: string;
  /** The sentence of the shown page a term is in, or "". */
  contextFor: (term: string) => string;
  onShowSource: (span: SourceSpan) => void;
}) {
  const { t } = useI18n();
  const lang = getLocale();
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  const [noText, setNoText] = useState(false);
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [someUnread, setSomeUnread] = useState(false);
  const [explained, setExplained] = useState<ExplainResult | null>(null);
  const [term, setTerm] = useState(initialTerm);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // The latest model and text loader; a new object alone starts nothing.
  const aiRef = useRef(ai);
  aiRef.current = ai;
  // A text read or an answer still going when the panel closes (the reader
  // closed, or the panel was closed or switched) stops with it: the PDF
  // helper would read, and the model write, for nobody.
  const reading = useRef<symbol | null>(null);
  const writing = useRef<symbol | null>(null);
  useEffect(
    () => () => {
      if (reading.current !== null) {
        reading.current = null;
        aiRef.current.cancelText();
      }
      if (writing.current !== null) {
        writing.current = null;
        aiRef.current.model.cancel();
      }
    },
    [],
  );
  /** Runs `work` as the model's one answer in flight, for the close above. */
  const asModel = <T,>(work: () => Promise<T>): Promise<T> => {
    const run = Symbol("model run");
    writing.current = run;
    return work().finally(() => {
      if (writing.current === run) writing.current = null;
    });
  };
  useEffect(() => {
    let current = true;
    aiRef.current.model.status().then(
      (found) => current && setStatus(found),
      () => current && setStatus(NOT_INSTALLED),
    );
    return () => {
      current = false;
    };
  }, []);

  const installed = status?.state === "installed";
  const stopped = (failure: unknown) => {
    // Stopped because the patient left, or the vault locked: nothing to say.
    if (!live.current || failure instanceof ModelCancelled) return;
    if (failure instanceof ModelNotInstalled) setStatus(NOT_INSTALLED);
    else setFailed(true);
  };

  // A summary starts once the panel opens on an installed model: the patient
  // asked for it by opening the panel. Once per language: React may run this
  // effect twice (StrictMode), and a model takes a while.
  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    if (tool !== "summary" || !installed || startedFor.current === lang) return;
    startedFor.current = lang;
    setWorking(true);
    setFailed(false);
    const read = Symbol("text read");
    reading.current = read;
    aiRef.current
      .loadText()
      .finally(() => {
        if (reading.current === read) reading.current = null;
      })
      .then(async (document) => {
        // Closed while the text was read: no model is asked for it.
        if (!live.current) return;
        if (document.pages.every((page) => !page.text.trim())) {
          setNoText(true);
          return;
        }
        const result = await asModel(() =>
          summarizeDocument(aiRef.current.model, document, lang),
        );
        if (!live.current) return;
        // Pages with no text, cut short or not read at all are never left
        // out silently.
        setSomeUnread(
          document.emptyPages.length +
            document.cutPages.length +
            document.failedPages.length >
            0,
        );
        setSummary(result);
      })
      .catch(stopped)
      .finally(() => live.current && setWorking(false));
    // `stopped` only reads a ref and setters, so it is not a dependency.
  }, [tool, installed, lang]);

  const explain = (event: FormEvent) => {
    event.preventDefault();
    const asked = term.trim();
    if (!asked || working) return;
    setWorking(true);
    setFailed(false);
    asModel(() =>
      explainTerm(aiRef.current.model, asked, contextFor(asked), lang),
    )
      .then((result) => live.current && setExplained(result))
      .catch(stopped)
      .finally(() => live.current && setWorking(false));
  };

  const title = t(tool === "summary" ? "ai.summary.title" : "ai.explain.title");
  return (
    <section
      id="reader-ai-panel"
      className="native-reader-ai"
      aria-labelledby="reader-ai-title"
      aria-busy={status === null || working}
    >
      <h3 id="reader-ai-title">{title}</h3>
      {/* No model to use: not added, failed its check, or not one this
          computer can run. Preferences says which. */}
      {status !== null && !installed && (
        <div className="native-reader-ai-missing">
          <p>
            <strong>{t("ai.notInstalled.title")}</strong>
          </p>
          <p>{t("ai.notInstalled.body")}</p>
          <button
            className="button"
            type="button"
            onClick={ai.onOpenPreferences}
          >
            {t("ai.notInstalled.openPreferences")}
          </button>
        </div>
      )}
      {installed && tool === "explain" && (
        <form className="native-reader-ai-explain" onSubmit={explain}>
          <label htmlFor="reader-ai-term">{t("ai.explain.box")}</label>
          <input
            id="reader-ai-term"
            type="text"
            autoComplete="off"
            value={term}
            maxLength={TERM_MAX}
            aria-describedby="reader-ai-term-hint"
            onChange={(event) => setTerm(event.target.value)}
          />
          <p id="reader-ai-term-hint">{t("ai.explain.hint")}</p>
          <button className="button primary" disabled={!term.trim() || working}>
            {t("ai.explain.submit")}
          </button>
        </form>
      )}
      {/* Read out as it changes: the work, then that the answer came. */}
      <p className={working ? "native-dialog-status" : "sr-only"} role="status">
        {working
          ? t("ai.working")
          : tool === "summary" && summary
            ? t("ai.summary.ready")
            : tool === "explain" && explained
              ? t("ai.explain.ready")
              : ""}
      </p>
      {failed && <p role="alert">{t("ai.failed")}</p>}
      {noText && <p>{t("ai.summary.noText")}</p>}
      {summary && (
        <div className="native-reader-ai-result">
          <p className="ai-label">{t("aiHelper.resultLabel")}</p>
          <ol>
            {summary.sentences.map(({ text, source }, index) => (
              <li key={index}>
                <span id={`reader-ai-sentence-${index}`}>{text}</span>{" "}
                {source ? (
                  <button
                    className="button"
                    type="button"
                    aria-describedby={`reader-ai-sentence-${index}`}
                    onClick={() => onShowSource(source)}
                  >
                    {t("ai.summary.showInDocument")}
                  </button>
                ) : (
                  // Never a guessed place: a sentence whose words were not
                  // found in the document says so (threat model AI-05).
                  <span className="ai-no-source">
                    {t("ai.summary.noSource")}
                  </span>
                )}
              </li>
            ))}
          </ol>
          {someUnread && <p>{t("ai.summary.pagesMissing")}</p>}
          {summary.partial && (
            <p>{t("ai.summary.partial", { last: summary.lastPage })}</p>
          )}
          <ResultMeta
            tool={summary.tool}
            model={summary.model}
            at={summary.createdAt}
          />
        </div>
      )}
      {explained && tool === "explain" && (
        <div className="native-reader-ai-result">
          <p className="ai-label">{t("aiHelper.resultLabel")}</p>
          <p>{explained.text}</p>
          <ResultMeta
            tool={explained.tool}
            model={explained.model}
            at={explained.createdAt}
          />
        </div>
      )}
    </section>
  );
}

function ResultMeta({
  tool,
  model,
  at,
}: {
  tool: AiTool;
  model: ModelInfo;
  at: number;
}) {
  useI18n();
  return (
    <p className="ai-meta">
      {translateNow("ai.result.meta", {
        tool: translateNow(
          tool === "summary" ? "ai.summary.title" : "ai.explain.title",
        ),
        model: model.name,
        date: formatDate(at, { dateStyle: "medium" }, getLocale()),
      })}
    </p>
  );
}

import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatDate, getLocale, t as translateNow, useI18n } from "../i18n";
import { explainTerm, summarizeDocument } from "../ai/localModel";
import {
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
  onOpenPreferences: () => void;
}

const NOT_INSTALLED: ModelStatus = { state: "notInstalled" };

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
  const [pagesRead, setPagesRead] = useState(0);
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
    if (!live.current) return;
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
    aiRef.current
      .loadText()
      .then(async (document) => {
        if (document.pages.every((page) => !page.text.trim())) {
          if (live.current) setNoText(true);
          return;
        }
        const result = await summarizeDocument(
          aiRef.current.model,
          document,
          lang,
        );
        if (!live.current) return;
        setPagesRead(document.pages.length);
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
    explainTerm(aiRef.current.model, asked, contextFor(asked), lang)
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
      {status?.state === "notInstalled" && (
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
            aria-describedby="reader-ai-term-hint"
            onChange={(event) => setTerm(event.target.value)}
          />
          <p id="reader-ai-term-hint">{t("ai.explain.hint")}</p>
          <button className="button primary" disabled={!term.trim() || working}>
            {t("ai.explain.submit")}
          </button>
        </form>
      )}
      <p className={working ? "native-dialog-status" : "sr-only"} role="status">
        {working ? t("ai.working") : ""}
      </p>
      {failed && <p role="alert">{t("ai.failed")}</p>}
      {noText && <p>{t("ai.summary.noText")}</p>}
      {summary && (
        <div className="native-reader-ai-result">
          <p className="ai-label">{t("ai.label")}</p>
          <ol>
            {summary.sentences.map((sentence, index) => (
              <li key={index}>
                <span id={`reader-ai-sentence-${index}`}>{sentence.text}</span>{" "}
                {sentence.source ? (
                  <button
                    className="button"
                    type="button"
                    aria-describedby={`reader-ai-sentence-${index}`}
                    onClick={() => onShowSource(sentence.source!)}
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
            <p>{t("ai.summary.partial", { last: pagesRead })}</p>
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
          <p className="ai-label">{t("ai.label")}</p>
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

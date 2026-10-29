import {
  useTextState,
  deferredText,
  useI18n,
  t as translateNow,
} from "../i18n";
import { recordSource } from "./recordPresentation";
import { ClinicServiceDate } from "./ClinicServiceDate";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useModalFocus } from "../useModalFocus";
import type { AiTool, SourceSpan } from "../ai/types";
import { ReaderAiPanel, type ReaderAi } from "./ReaderAiPanel";
import {
  hasVaultErrorCode,
  vaultErrorMessage,
  type VaultRecord,
  type ViewedPage,
} from "../vault";

/** Zoom steps, as a share of the reader's width: 1 fits the page to it. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;
/** The widest picture the helper draws (pdf_view::MAX_SIDE). */
const MAX_PICTURE_WIDTH = 4096;
/** Pages kept while the reader is open, so that going back is quick: at most
 * this many, and at most this many characters across picture and text data. */
const CACHED_PAGES = 6;
const CACHED_CHARACTERS = 48 * 1024 * 1024;
/** A resize settles before the page is measured again. */
const RESIZE_SETTLE_MS = 150;
/** The most of a selection taken as a term to explain. */
const TERM_MAX = 200;
/** The most of a page's text given to the model around a term. */
const CONTEXT_MAX = 400;

/** The sentence of `text` that `term` is in (case aside), or "". */
export function sentenceAround(text: string, term: string): string {
  const at = text.toLowerCase().indexOf(term.toLowerCase());
  if (!term || at < 0) return "";
  const before = text.slice(0, at);
  const start =
    Math.max(
      before.lastIndexOf(". "),
      before.lastIndexOf("\n"),
      before.lastIndexOf("? "),
      before.lastIndexOf("! "),
    ) + 1;
  const after = text.slice(at + term.length).search(/[.!?](\s|$)|\n/);
  const end = after < 0 ? text.length : at + term.length + after + 1;
  return text.slice(start, end).trim().slice(0, CONTEXT_MAX);
}

/** Retains drawn pages within the reader's count and character budgets. */
export function cacheDrawnPage(
  cache: Map<string, ViewedPage>,
  key: string,
  result: ViewedPage,
) {
  cache.delete(key);
  // A page may still be shown, but never retained above the cache's own bound.
  const charactersIn = (page: ViewedPage) =>
    page.image.length + page.text.length + (page.readableText?.length ?? 0);
  if (charactersIn(result) > CACHED_CHARACTERS) return;
  cache.set(key, result);
  let characters = 0;
  for (const kept of cache.values()) characters += charactersIn(kept);
  for (const [oldest, kept] of cache) {
    if (cache.size <= CACHED_PAGES && characters <= CACHED_CHARACTERS) break;
    if (oldest === key) continue;
    cache.delete(oldest);
    characters -= charactersIn(kept);
  }
}

/** Reads a stored document inside myCarlos, one page at a time. Each page is
 * drawn by the separate PDF helper, as a picture with its text beside it for
 * screen readers and copying: nothing in the document runs here, and nothing
 * is saved. A document locked with its own password asks for it; the
 * password is held only while the reader is open. */
export function DocumentReader({
  record,
  viewPage,
  cancelView,
  onClose,
  ai,
}: {
  record: VaultRecord;
  viewPage: (
    page: number,
    width: number,
    password?: string,
  ) => Promise<ViewedPage>;
  /** Stops a page still being drawn, when the reader closes. */
  cancelView?: () => void;
  onClose: () => void;
  /** The AI helper's actions (#72), where this computer can offer them. */
  ai?: ReaderAi;
}) {
  useI18n();
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(true, dialogRef, onClose, closeRef);
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(0);
  const [shown, setShown] = useState<(ViewedPage & { page: number }) | null>(
    null,
  );
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useTextState();
  // The document's own password, once given: kept while the reader is open,
  // for the pages that follow, and gone with it.
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const [wrongTries, setWrongTries] = useState(0);
  const [typed, setTyped] = useState("");
  // Pages already drawn at a width, so that going back is quick. Memory only.
  const drawn = useRef(new Map<string, ViewedPage>());
  // The latest way to ask for a page; a new function alone asks for nothing.
  const viewPageRef = useRef(viewPage);
  viewPageRef.current = viewPage;
  const cancelViewRef = useRef(cancelView);
  cancelViewRef.current = cancelView;
  // A page still being drawn when the reader closes is stopped.
  useEffect(() => () => cancelViewRef.current?.(), []);
  // The AI helper: which panel is open, the words last selected in the page
  // text (a term to explain), and a summary sentence's place being shown.
  const [aiTool, setAiTool] = useState<AiTool | null>(null);
  const [textOpen, setTextOpen] = useState(false);
  const [highlight, setHighlight] = useState<SourceSpan | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const markRef = useRef<HTMLElement | null>(null);
  const selected = useRef("");
  useEffect(() => {
    if (!ai) return;
    const remember = () => {
      const selection = document.getSelection();
      if (
        selection &&
        !selection.isCollapsed &&
        textRef.current?.contains(selection.anchorNode)
      )
        selected.current = selection.toString().trim().slice(0, TERM_MAX);
    };
    document.addEventListener("selectionchange", remember);
    return () => document.removeEventListener("selectionchange", remember);
  }, [ai]);

  useEffect(() => {
    // The width inside the page area's padding, so that a page fitted to it
    // does not scroll.
    const measure = () => {
      const area = pageRef.current;
      if (!area) return;
      const style = getComputedStyle(area);
      const padding =
        parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      setFitWidth(Math.max(1, Math.floor(area.clientWidth - padding)));
    };
    measure();
    // Measured again once a resize settles, not on each step of it.
    let settle: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(settle);
      settle = window.setTimeout(measure, RESIZE_SETTLE_MS);
    });
    if (pageRef.current) observer.observe(pageRef.current);
    return () => {
      window.clearTimeout(settle);
      observer.disconnect();
    };
  }, []);

  const remember = (key: string, result: ViewedPage) =>
    cacheDrawnPage(drawn.current, key, result);

  const cssWidth = Math.max(1, Math.round(fitWidth * zoom));
  const pictureWidth = Math.min(
    MAX_PICTURE_WIDTH,
    Math.max(1, Math.round(cssWidth * (window.devicePixelRatio || 1))),
  );

  useEffect(() => {
    if (!fitWidth || asking) return;
    const key = `${page}:${pictureWidth}`;
    const known = drawn.current.get(key);
    if (known) {
      remember(key, known);
      setShown({ ...known, page });
      setError("");
      setLoading(false);
      return;
    }
    let current = true;
    setLoading(true);
    setError("");
    viewPageRef.current(page, pictureWidth, password).then(
      (result) => {
        if (!current) return;
        remember(key, result);
        setShown({ ...result, page });
        setPageCount(result.pageCount);
        setLoading(false);
      },
      (failure: unknown) => {
        if (!current) return;
        setLoading(false);
        const wrong = hasVaultErrorCode(failure, "pdf_wrong_password");
        if (wrong || hasVaultErrorCode(failure, "pdf_locked")) {
          if (wrong) setWrongTries((count) => count + 1);
          setAsking(true);
          return;
        }
        setError(deferredText(() => vaultErrorMessage(failure)));
      },
    );
    return () => {
      current = false;
    };
  }, [asking, fitWidth, page, password, pictureWidth]);

  const giveDocumentPassword = (event: FormEvent) => {
    event.preventDefault();
    if (!typed) return;
    setPassword(typed);
    setTyped("");
    setAsking(false);
  };

  const last = pageCount === null ? null : pageCount - 1;
  const where =
    pageCount === null
      ? ""
      : translateNow("interface.reader.where", {
          page: page + 1,
          total: pageCount,
        });
  // The picture shown is the page asked for, not one left from before.
  const current = shown && shown.page === page && !asking && !error;
  const pageText = current ? (shown.readableText ?? shown.text) : "";
  // A summary sentence's place, on the page shown. Offsets are into the page
  // text as read; the text shown here is trimmed, so they move with it.
  const lead = pageText.length - pageText.trimStart().length;
  const shownText = pageText.trim();
  const marked =
    highlight && current && highlight.page === shown.page
      ? {
          start: Math.max(
            0,
            Math.min(shownText.length, highlight.start - lead),
          ),
          end: Math.max(0, Math.min(shownText.length, highlight.end - lead)),
        }
      : null;
  useEffect(() => {
    if (!marked || marked.end <= marked.start) return;
    markRef.current?.scrollIntoView?.({ block: "center" });
    markRef.current?.focus();
  }, [marked?.start, marked?.end, current]);
  const showSource = (span: SourceSpan) => {
    setHighlight(span);
    setTextOpen(true);
    setPage(span.page);
  };
  const toggleAi = (tool: AiTool) =>
    setAiTool((open) => (open === tool ? null : tool));
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="record-dialog native-reader"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reader-title"
        aria-describedby="reader-trust"
      >
        <header className="dialog-head native-reader-head">
          <div>
            <h2 id="reader-title">{record.displayName}</h2>
            <p id="reader-trust">
              {record.verifiedClinicName
                ? translateNow("portal.sourceVerified", {
                    clinic: record.verifiedClinicName,
                  })
                : recordSource(record)}
            </p>
            {record.clinicServiceDate !== undefined && (
              <p>
                <ClinicServiceDate value={record.clinicServiceDate} />
              </p>
            )}
          </div>
          <button
            ref={closeRef}
            className="button"
            type="button"
            onClick={onClose}
          >
            {translateNow("photo.close")}
          </button>
        </header>
        <div className="native-reader-controls">
          <button
            className="button"
            type="button"
            disabled={loading || page === 0}
            onClick={() => {
              setHighlight(null);
              setPage((current) => current - 1);
            }}
          >
            {translateNow("interface.DocumentReader.previousPage")}
          </button>
          <span className="native-reader-where">{where}</span>
          <button
            className="button"
            type="button"
            disabled={loading || last === null || page >= last}
            onClick={() => {
              setHighlight(null);
              setPage((current) => current + 1);
            }}
          >
            {translateNow("interface.DocumentReader.nextPage")}
          </button>
          <span className="native-reader-zoom">
            <button
              className="button"
              type="button"
              disabled={loading || zoom <= ZOOM_MIN}
              onClick={() =>
                setZoom((current) => Math.max(ZOOM_MIN, current / ZOOM_STEP))
              }
            >
              {translateNow("interface.DocumentReader.smaller")}
            </button>
            <span aria-live="polite">
              {translateNow("interface.reader.zoom", {
                percent: Math.round(zoom * 100),
              })}
            </span>
            <button
              className="button"
              type="button"
              disabled={loading || zoom >= ZOOM_MAX}
              onClick={() =>
                setZoom((current) => Math.min(ZOOM_MAX, current * ZOOM_STEP))
              }
            >
              {translateNow("interface.DocumentReader.larger")}
            </button>
            <button
              className="button"
              type="button"
              disabled={loading || zoom === 1}
              onClick={() => setZoom(1)}
            >
              {translateNow("interface.DocumentReader.fitWidth")}
            </button>
          </span>
          {ai && (
            <span className="native-reader-ai-actions">
              <button
                className="button"
                type="button"
                aria-expanded={aiTool === "summary"}
                aria-controls={
                  aiTool === "summary" ? "reader-ai-panel" : undefined
                }
                onClick={() => toggleAi("summary")}
              >
                {translateNow("ai.summary.button")}
              </button>
              <button
                className="button"
                type="button"
                aria-expanded={aiTool === "explain"}
                aria-controls={
                  aiTool === "explain" ? "reader-ai-panel" : undefined
                }
                onClick={() => toggleAi("explain")}
              >
                {translateNow("ai.explain.title")}
              </button>
            </span>
          )}
        </div>
        <p
          className={loading && !asking ? "native-dialog-status" : "sr-only"}
          role="status"
        >
          {loading && !asking
            ? translateNow("interface.reader.opening", { page: page + 1 })
            : current
              ? translateNow("interface.reader.where", {
                  page: shown.page + 1,
                  total: shown.pageCount,
                })
              : ""}
        </p>
        {asking && (
          <form
            className="native-reader-password"
            onSubmit={giveDocumentPassword}
          >
            <p id="reader-password-help">
              {translateNow(
                "interface.DocumentReader.thisDocumentIsLockedWithItsOwn",
              )}
            </p>
            <label htmlFor="reader-password">
              {translateNow("interface.DocumentReader.documentPassword")}
            </label>
            <input
              id="reader-password"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              aria-describedby={
                wrongTries
                  ? "reader-password-help reader-password-error"
                  : "reader-password-help"
              }
              aria-invalid={wrongTries ? true : undefined}
              onChange={(event) => setTyped(event.target.value)}
            />
            {wrongTries > 0 && (
              <p id="reader-password-error" role="alert" key={wrongTries}>
                {translateNow(
                  "interface.DocumentReader.thatPasswordDidNotOpenTheDocument",
                )}
              </p>
            )}
            <button className="button primary" disabled={!typed}>
              {translateNow("interface.DocumentReader.open")}
            </button>
          </form>
        )}
        {error && <p role="alert">{error}</p>}
        {/* Focusable, so that a zoomed page can be moved with the arrow keys
            where the webview does not focus scrolling areas itself. */}
        <div
          className="native-reader-page"
          ref={pageRef}
          tabIndex={0}
          role="region"
          aria-label={translateNow("interface.reader.page", {
            page: current ? shown.page + 1 : page + 1,
          })}
        >
          {current && (
            <img
              src={shown.image}
              alt={translateNow("interface.reader.textFollows", {
                page: shown.page + 1,
                total: shown.pageCount,
              })}
              style={{ width: `${cssWidth}px` }}
            />
          )}
        </div>
        {current && (
          <details
            className="native-reader-text"
            open={textOpen}
            onToggle={(event) => setTextOpen(event.currentTarget.open)}
          >
            <summary>
              {translateNow("interface.DocumentReader.textOnThisPage")}
            </summary>
            <div ref={textRef}>
              {!shownText ? (
                translateNow("interface.DocumentReader.noTextCouldBeReadOnThis")
              ) : marked && marked.end > marked.start ? (
                <>
                  {shownText.slice(0, marked.start)}
                  <mark ref={markRef} tabIndex={-1}>
                    {shownText.slice(marked.start, marked.end)}
                  </mark>
                  {shownText.slice(marked.end)}
                </>
              ) : (
                shownText
              )}
            </div>
          </details>
        )}
        {ai && aiTool && (
          <ReaderAiPanel
            key={aiTool}
            ai={ai}
            tool={aiTool}
            initialTerm={aiTool === "explain" ? selected.current : ""}
            contextFor={(term) => sentenceAround(pageText, term)}
            onShowSource={showSource}
          />
        )}
      </section>
    </div>
  );
}

import {
  useTextState,
  deferredText,
  useI18n,
  t as translateNow,
} from "../i18n";
import { ClinicServiceDate } from "./ClinicServiceDate";
import { RecordSource } from "./RecordSource";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useModalFocus } from "../useModalFocus";
import type { AiTool, SourceSpan } from "../ai/types";
import { ReaderAiPanel, TERM_MAX, type ReaderAi } from "./ReaderAiPanel";
import { ReadingAidView } from "./ReadingAidView";
import {
  hasVaultErrorCode,
  vaultErrorMessage,
  type PageBoxes,
  type VaultRecord,
  type ViewedPage,
} from "../vault";
import { boxesToDraw, boxStyle, centreIn, type Box } from "./pageHighlight";

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
/** The most of a page's text given to the model around a term. */
const CONTEXT_MAX = 400;

/** Lower case, character by character, keeping the length: a character
 * whose lower case is longer (İ) stays as it is, so offsets still hold. */
function foldCase(text: string): string {
  return Array.from(text, (char) => {
    const lower = char.toLowerCase();
    return lower.length === char.length ? lower : char;
  }).join("");
}

/** The sentence of `text` that `term` is in (case aside), or "". */
export function sentenceAround(text: string, term: string): string {
  const at = foldCase(text).indexOf(foldCase(term));
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

/** Let a burst of zoom input settle before sharpening the visible page. */
const ZOOM_SETTLE_MS = 120;

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

/** A page or zoom button. It stays in the Tab order while it cannot be used
 * (aria-disabled, not disabled): Chromium drops the focus of a button that
 * becomes disabled, and the page keys with it. That happens when, say, Last
 * page shows the last page, Larger reaches the largest size, or a page is
 * being drawn. */
function ReaderButton({
  className,
  unavailable,
  keys,
  onPress,
  children,
}: {
  className?: string;
  unavailable: boolean;
  keys?: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={className ? `button ${className}` : "button"}
      type="button"
      aria-disabled={unavailable}
      aria-keyshortcuts={keys}
      onClick={() => {
        if (!unavailable) onPress();
      }}
    >
      {children}
    </button>
  );
}

/** Whether a page area can still scroll the way a page key goes. */
function canScrollToward(area: HTMLElement, key: string) {
  return key === "Home" || key === "PageUp"
    ? area.scrollTop > 0
    : area.scrollTop + area.clientHeight < area.scrollHeight - 1;
}

/** The keys that turn pages (D144), and the page each one goes to. */
const PAGE_KEYS = new Map<string, (page: number, last: number) => number>([
  ["Home", () => 0],
  ["PageUp", (page) => page - 1],
  ["PageDown", (page) => page + 1],
  ["End", (_page, last) => last],
]);

type DocumentReaderProps = {
  record: VaultRecord;
  viewPage: (
    page: number,
    width: number,
    password?: string,
  ) => Promise<ViewedPage>;
  /** Stops a page still being drawn when superseded or when the reader closes. */
  cancelView?: () => void;
  /** Where a quoted span of a page's text is on its picture (#292), exactly
   * or not at all. Without it, Show in document marks the text only. */
  pageBoxes?: (
    page: number,
    span: { start: number; end: number; quoted: string },
    password?: string,
  ) => Promise<PageBoxes>;
  onClose: () => void;
  /** The AI helper's actions (#72), where this computer can offer them. */
  ai?: ReaderAi;
  /** Opens on the clinic's reading aid, under its notice, when the record has one. The original is
   * always one tap away, and the notice comes first every time the aid is shown. */
  startWithAid?: boolean;
};

/** Reads a stored document inside myCarlos, one page at a time. Each page is
 * drawn by the separate PDF helper, as a picture with its text beside it for
 * screen readers and copying: nothing in the document runs here, and nothing
 * is saved. A document locked with its own password asks for it; the
 * password is held only while the reader is open. */
export function DocumentReader(props: DocumentReaderProps) {
  // A document change starts a new reading session, including its password/cache.
  return <ReadingDocument key={props.record.id} {...props} />;
}

function ReadingDocument({
  record,
  viewPage,
  cancelView,
  pageBoxes,
  onClose,
  ai,
  startWithAid = false,
}: DocumentReaderProps) {
  useI18n();
  const aid = record.readingAid;
  const [view, setView] = useState<"aid" | "original">(
    aid && startWithAid ? "aid" : "original",
  );
  const showingAid = view === "aid" && Boolean(aid);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
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
  // A refused attempt remounts the field; keep keyboard retry in that field.
  useEffect(() => {
    if (asking && wrongTries > 0) passwordRef.current?.focus();
  }, [asking, wrongTries]);
  // Pages already drawn at a width, so that going back is quick. Memory only.
  const drawn = useRef(new Map<string, ViewedPage>());
  // The latest way to ask for a page; a new function alone asks for nothing.
  const viewPageRef = useRef(viewPage);
  viewPageRef.current = viewPage;
  const cancelViewRef = useRef(cancelView);
  cancelViewRef.current = cancelView;
  const pendingDraw = useRef<symbol | null>(null);
  // Clear retained pages and stop native work before disposing this reading session.
  useEffect(
    () => () => {
      pendingDraw.current = null;
      drawn.current.clear();
      cancelViewRef.current?.();
    },
    [],
  );
  // The AI helper: which panel is open, the words last selected in the page
  // text (a term to explain), and a summary sentence's place being shown.
  const [aiTool, setAiTool] = useState<AiTool | null>(null);
  const [textOpen, setTextOpen] = useState(false);
  const [highlight, setHighlight] = useState<SourceSpan | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const markRef = useRef<HTMLElement | null>(null);
  // The quote's boxes on the picture (#292), for the highlight they were
  // asked for: `boxes` is empty when the helper could not place every word.
  const [placed, setPlaced] = useState<{
    key: string;
    boxes: Box[];
  } | null>(null);
  const firstBoxRef = useRef<HTMLSpanElement | null>(null);
  const pageBoxesRef = useRef(pageBoxes);
  pageBoxesRef.current = pageBoxes;
  const selected = useRef("");
  const offersAi = Boolean(ai);
  useEffect(() => {
    if (!offersAi) return;
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
  }, [offersAi]);

  useEffect(() => {
    // The page area exists only while the original is shown; measure again when it comes back.
    if (showingAid) return;
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
      // A stale width must not draw a page the moment the original returns.
      setFitWidth(0);
    };
  }, [showingAid]);

  // When the reader scrolls (large text, small window), the page bar stays
  // over its foot. Its height is kept as the reader's scroll padding, so that
  // a control the focus moves to is scrolled clear of the bar, not under it.
  const barRef = useRef<HTMLDivElement | null>(null);
  const hasBar = pageCount !== null && !showingAid;
  useEffect(() => {
    const bar = barRef.current;
    const reader = dialogRef.current;
    if (!bar || !reader) return;
    const pad = () => {
      reader.style.scrollPaddingBottom = `${bar.offsetHeight}px`;
    };
    pad();
    const observer = new ResizeObserver(pad);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      reader.style.scrollPaddingBottom = "";
    };
  }, [hasBar]);

  const remember = (key: string, result: ViewedPage) =>
    cacheDrawnPage(drawn.current, key, result);

  const cssWidth = Math.max(1, Math.round(fitWidth * zoom));
  const pictureWidth = Math.min(
    MAX_PICTURE_WIDTH,
    Math.max(1, Math.round(cssWidth * (window.devicePixelRatio || 1))),
  );

  useEffect(() => {
    if (showingAid || !fitWidth || asking) return;
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
    let request: symbol | undefined;
    setLoading(true);
    setError("");
    const draw = () => {
      request = Symbol();
      pendingDraw.current = request;
      const settled = () => {
        if (pendingDraw.current === request) pendingDraw.current = null;
      };
      viewPageRef.current(page, pictureWidth, password).then(
        (result) => {
          settled();
          if (!current) return;
          remember(key, result);
          setShown({ ...result, page });
          setPageCount(result.pageCount);
          setLoading(false);
        },
        (failure: unknown) => {
          settled();
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
    };
    // Opening/navigating/password attempts start immediately. A visible page
    // scales with the controls while a burst of zooms settles to one new size.
    const timer =
      shown?.page === page
        ? window.setTimeout(draw, ZOOM_SETTLE_MS)
        : undefined;
    if (timer === undefined) draw();
    return () => {
      current = false;
      window.clearTimeout(timer);
      if (request !== undefined && pendingDraw.current === request) {
        pendingDraw.current = null;
        cancelViewRef.current?.();
      }
    };
  }, [asking, fitWidth, page, password, pictureWidth, showingAid]);

  // Focus lands on the new view's start, so a screen reader hears the notice first: when the
  // reader opens straight onto the aid, and after every switch.
  const initialAid = useRef(showingAid);
  const shownBefore = useRef(showingAid);
  useEffect(() => {
    if (initialAid.current && showingAid) {
      document.getElementById("reading-aid-title")?.focus();
      return;
    }
    if (shownBefore.current === showingAid) return;
    shownBefore.current = showingAid;
    if (showingAid) document.getElementById("reading-aid-title")?.focus();
    else pageRef.current?.focus();
  }, [showingAid]);

  // Another page is shown from its top left, with its text from the top,
  // not where the last one was scrolled. Page Up at a page's top shows the
  // page before from its bottom, once drawn, so that reading back goes on
  // where it left off.
  const fromBottom = useRef<number | null>(null);
  useEffect(() => {
    if (pageRef.current) {
      pageRef.current.scrollTop = 0;
      pageRef.current.scrollLeft = 0;
    }
    if (textRef.current) textRef.current.scrollTop = 0;
    if (fromBottom.current !== page) fromBottom.current = null;
  }, [page]);
  const pageDrawn = (drawnPage: number) => {
    if (fromBottom.current !== drawnPage || !pageRef.current) return;
    fromBottom.current = null;
    pageRef.current.scrollTop = pageRef.current.scrollHeight;
  };
  // The text box keeps its height while the next page is drawn. Emptied, it
  // would let a scrolling reader scroll up, and the new text would then come
  // back under the page bar (WebKit has no scroll anchoring to keep the
  // focused box in place).
  const textHeight = useRef(0);
  useLayoutEffect(() => {
    if (current && textRef.current)
      textHeight.current = textRef.current.offsetHeight;
  });
  // A page that fails, or asks for the document's password, takes the page's
  // text box away. If the focus was in it, it goes to the password field or
  // the page area, not to the window, so the keys go on working.
  // A layout effect: the focus moves in the same commit that removes the
  // box, with no frame in between where it is on the window.
  useLayoutEffect(() => {
    if (!(asking || error)) return;
    // In case a removed element is still reported as focused.
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused.isConnected) return;
    if (asking) passwordRef.current?.focus();
    else pageRef.current?.focus({ preventScroll: true });
  }, [asking, error]);

  const giveDocumentPassword = (event: FormEvent) => {
    event.preventDefault();
    if (!typed) return;
    setPassword(typed);
    setTyped("");
    setAsking(false);
    // The form goes away with its focus: the page takes it, so that the
    // page keys go on working.
    pageRef.current?.focus();
  };

  const last = pageCount === null ? null : pageCount - 1;
  // A one-page document shows its count only: no page buttons, no page keys.
  const turnsPages = last !== null && last > 0;
  // A page turn drops a summary sentence's mark and closes the page's text,
  // as Previous and Next did before the bar. A turn made with the keys from
  // inside that text keeps it open, so that reading goes on into the next
  // page's text with the focus where it was.
  const goTo = (target: number, keepText = false) => {
    if (loading || last === null || target < 0 || target > last) return;
    setHighlight(null);
    if (!keepText) setTextOpen(false);
    setPage(target);
  };
  // Home, End, Page Up and Page Down turn pages anywhere in the reader but in
  // a box that takes typing, where Home and End move in what is typed. A key
  // with Ctrl, Alt, Shift or Cmd is left to the system, and so is a key with
  // no page to turn to. On a page taller than its area (zoomed in, say), or
  // in the page's text, the key scrolls first, as it does anywhere else, and
  // turns the page at the top or bottom edge.
  const turnPageWithKeys = (event: KeyboardEvent<HTMLElement>) => {
    const to = PAGE_KEYS.get(event.key);
    // The reading aid has no pages to turn: the keys scroll it.
    if (!to || showingAid || !turnsPages || last === null) return;
    if (event.defaultPrevented) return;
    if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey)
      return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    )
      return;
    const scroller = [pageRef.current, textRef.current].find(
      (box) => box !== null && target instanceof Node && box.contains(target),
    );
    if (scroller && canScrollToward(scroller, event.key)) return;
    const next = to(page, last);
    if (next === page || next < 0 || next > last) return;
    event.preventDefault();
    if (loading) return;
    if (event.key === "PageUp" && scroller === pageRef.current)
      fromBottom.current = next;
    goTo(next, scroller === textRef.current);
  };
  const where =
    pageCount === null
      ? ""
      : translateNow("interface.reader.where", {
          page: page + 1,
          total: pageCount,
        });
  // The picture shown is the page asked for, not one left from before.
  const zoomable = shown && shown.page === page && !asking;
  // A failed sharpening attempt can still return to a cached size.
  const current = zoomable && !error;
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
  // Each "Show in document" brings the words into view and focus, even
  // the same words again: the highlight is a new object each time. Only the
  // text box scrolls to them: the focus stays on the marked words, the
  // version a screen reader reads, and the picture keeps its own scroll.
  useEffect(() => {
    const mark = markRef.current;
    const box = mark?.closest<HTMLElement>(".native-reader-text");
    if (mark && box) centreIn(box, mark);
    mark?.focus({ preventScroll: true });
  }, [highlight, current]);
  // The same words on the page picture (#292), asked of the PDF helper once
  // for each quote shown.
  const placeKey =
    highlight && current && highlight.page === shown.page && !showingAid
      ? `${shown.page}:${highlight.start}:${highlight.end}`
      : null;
  const quoted =
    placeKey && highlight ? pageText.slice(highlight.start, highlight.end) : "";
  const latestKey = useRef<string | null>(null);
  latestKey.current = placeKey;
  useEffect(() => {
    const ask = pageBoxesRef.current;
    if (!placeKey || !ask || !highlight || !quoted.trim()) return;
    if (placed?.key === placeKey) return;
    let settled = false;
    const settle = (boxes: Box[]) => {
      if (settled || latestKey.current !== placeKey) return;
      settled = true;
      setPlaced({ key: placeKey, boxes });
    };
    ask(
      highlight.page,
      { start: highlight.start, end: highlight.end, quoted },
      password,
    ).then(
      (answer) => settle(boxesToDraw(answer)),
      () => settle([]),
    );
    // `placed` is read, not watched: an answer must not ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeKey, quoted, password]);
  const boxes = placed && placed.key === placeKey ? placed.boxes : null;
  // The picture scrolls itself to the first box, on each press as well.
  useEffect(() => {
    const area = pageRef.current;
    const first = firstBoxRef.current;
    if (area && first) centreIn(area, first);
  }, [highlight, boxes]);
  // The page text and its highlight, and the AI helper, belong to the original view only; the
  // clinician-approved aid is never shown beside or acted on by the helper.
  const openAid = () => {
    initialAid.current = false;
    setAiTool(null);
    setHighlight(null);
    setTextOpen(false);
    setView("aid");
  };
  const showSource = (span: SourceSpan) => {
    // A kept answer's place on a page this document does not have is not
    // shown: the page asked for could not be drawn.
    if (pageCount !== null && span.page >= pageCount) return;
    // Back to the original first, so the page turns where the words are.
    setView("original");
    setHighlight({ ...span });
    setTextOpen(true);
    setPage(span.page);
  };
  // Opening a tool may wait for the AI helper's notice; closing never does.
  const toggleAi = (tool: AiTool) => {
    if (aiTool === tool) setAiTool(null);
    else if (ai?.beforeFirstUse) ai.beforeFirstUse(() => setAiTool(tool));
    else setAiTool(tool);
  };
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className={`record-dialog native-reader${
          marked ? " native-reader-highlighting" : ""
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reader-title"
        aria-describedby="reader-trust"
        // A click on the reader's text keeps the focus in it, for the keys.
        tabIndex={-1}
        onKeyDown={turnPageWithKeys}
      >
        <header className="dialog-head native-reader-head">
          <div>
            <h2 id="reader-title">{record.displayName}</h2>
            <p id="reader-trust">
              <RecordSource record={record} />
            </p>
            {record.clinicServiceDate !== undefined && (
              <p>
                <ClinicServiceDate value={record.clinicServiceDate} />
              </p>
            )}
          </div>
          <span className="native-reader-head-actions">
            {aid && !showingAid && (
              <button className="button" type="button" onClick={openAid}>
                {translateNow("readingAid.open")}
              </button>
            )}
            <button
              ref={closeRef}
              className="button"
              type="button"
              onClick={onClose}
            >
              {translateNow("photo.close")}
            </button>
          </span>
        </header>
        {showingAid && aid ? (
          <ReadingAidView
            aid={aid}
            reviewedAtMs={aid.reviewedAtMs}
            onOpenOriginal={() => {
              initialAid.current = false;
              setView("original");
            }}
          />
        ) : (
          <>
            {/* Zoom at the top left, then the AI helper's actions; the page
                buttons are in the bar at the foot (D144). */}
            <div className="native-reader-controls">
              <span className="native-reader-zoom">
                <ReaderButton
                  unavailable={!zoomable || zoom <= ZOOM_MIN}
                  onPress={() =>
                    setZoom((current) =>
                      Math.max(ZOOM_MIN, current / ZOOM_STEP),
                    )
                  }
                >
                  {translateNow("interface.DocumentReader.smaller")}
                </ReaderButton>
                <span aria-live="polite">
                  {translateNow("interface.reader.zoom", {
                    percent: Math.round(zoom * 100),
                  })}
                </span>
                <ReaderButton
                  unavailable={!zoomable || zoom >= ZOOM_MAX}
                  onPress={() =>
                    setZoom((current) =>
                      Math.min(ZOOM_MAX, current * ZOOM_STEP),
                    )
                  }
                >
                  {translateNow("interface.DocumentReader.larger")}
                </ReaderButton>
                <ReaderButton
                  unavailable={!zoomable || zoom === 1}
                  onPress={() => setZoom(1)}
                >
                  {translateNow("interface.DocumentReader.fitWidth")}
                </ReaderButton>
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
              className={
                loading && !asking ? "native-dialog-status" : "sr-only"
              }
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
                  ref={passwordRef}
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
              aria-busy={loading}
              ref={pageRef}
              tabIndex={0}
              role="region"
              aria-label={translateNow("interface.reader.page", {
                page: current ? shown.page + 1 : page + 1,
              })}
            >
              {current && (
                <span className="native-reader-picture">
                  <img
                    src={shown.image}
                    alt={translateNow("interface.reader.textFollows", {
                      page: shown.page + 1,
                      total: shown.pageCount,
                    })}
                    style={{ width: `${cssWidth}px` }}
                    onLoad={() => pageDrawn(shown.page)}
                  />
                  {/* The quoted words on the picture: for seeing only. The
                  marked text below is what a screen reader reads (#292). */}
                  {boxes && boxes.length > 0 && (
                    <span className="native-reader-boxes" aria-hidden="true">
                      {boxes.map((box, index) => (
                        <span
                          key={index}
                          ref={index === 0 ? firstBoxRef : undefined}
                          style={boxStyle(box)}
                        />
                      ))}
                    </span>
                  )}
                </span>
              )}
            </div>
            {/* Said once the boxes are known (#292). A live region of its
            own, beside the reader's status, which says the page. */}
            {pageBoxes && (
              <p className="sr-only" id="reader-marked" aria-live="polite">
                {boxes && highlight
                  ? translateNow(
                      boxes.length > 0
                        ? "interface.reader.markedOnPage"
                        : "interface.reader.markedInText",
                      { page: highlight.page + 1 },
                    )
                  : ""}
              </p>
            )}
            {/* Kept while the next page is drawn (empty and busy), so that a
                page turned with the keys from inside the text keeps the focus
                there, and the box stays open for the next page. */}
            {shown && !asking && !error && (
              <details
                className="native-reader-text"
                open={textOpen}
                onToggle={(event) => setTextOpen(event.currentTarget.open)}
              >
                <summary id="reader-text-title">
                  {translateNow("interface.DocumentReader.textOnThisPage")}
                </summary>
                {/* Focusable and scrolled on its own, so that a click in the
                    text lets the keys scroll it, and the page keys turn the
                    page only at its top or end. */}
                <div
                  ref={textRef}
                  tabIndex={0}
                  role="region"
                  aria-labelledby="reader-text-title"
                  aria-busy={!current}
                  style={
                    current
                      ? undefined
                      : { minHeight: `${textHeight.current}px` }
                  }
                >
                  {!current ? (
                    ""
                  ) : !shownText ? (
                    translateNow(
                      "interface.DocumentReader.noTextCouldBeReadOnThis",
                    )
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
                quoteShown={marked !== null}
              />
            )}
            {/* D144: the page bar, kept in view at the reader's foot, after
                everything it turns. In words, not arrows. On a narrow reader
                the count is on top, then Previous | Next, then First | Last
                (styles.css); the order read out stays this one. */}
            {hasBar && (
              <div
                ref={barRef}
                className={
                  turnsPages
                    ? "native-reader-pages"
                    : "native-reader-pages one-page"
                }
              >
                {turnsPages && (
                  <>
                    <ReaderButton
                      className="native-reader-first"
                      keys="Home"
                      unavailable={loading || page === 0}
                      onPress={() => goTo(0)}
                    >
                      {translateNow("interface.DocumentReader.firstPage")}
                    </ReaderButton>
                    <ReaderButton
                      className="native-reader-previous"
                      keys="PageUp"
                      unavailable={loading || page === 0}
                      onPress={() => goTo(page - 1)}
                    >
                      {translateNow("interface.DocumentReader.previousPage")}
                    </ReaderButton>
                  </>
                )}
                <span className="native-reader-where">{where}</span>
                {turnsPages && (
                  <>
                    <ReaderButton
                      className="native-reader-next"
                      keys="PageDown"
                      unavailable={loading || page >= last}
                      onPress={() => goTo(page + 1)}
                    >
                      {translateNow("interface.DocumentReader.nextPage")}
                    </ReaderButton>
                    <ReaderButton
                      className="native-reader-last"
                      keys="End"
                      unavailable={loading || page >= last}
                      onPress={() => goTo(last)}
                    >
                      {translateNow("interface.DocumentReader.lastPage")}
                    </ReaderButton>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

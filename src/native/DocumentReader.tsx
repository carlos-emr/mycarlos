import {
  useTextState,
  deferredText,
  useI18n,
  t as translateNow,
} from "../i18n";
import { recordSource } from "./recordPresentation";
import { ClinicServiceDate } from "./ClinicServiceDate";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useModalFocus } from "../useModalFocus";
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

  // When the reader scrolls (large text, small window), the page bar stays
  // over its foot. Its height is kept as the reader's scroll padding, so that
  // a control the focus moves to is scrolled clear of the bar, not under it.
  const barRef = useRef<HTMLDivElement | null>(null);
  const hasBar = pageCount !== null;
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

  // Another page is shown from its top left, with its text from the top,
  // not where the last one was scrolled. Page Up at a page's top shows the
  // page before from its bottom, once drawn, so that reading back goes on
  // where it left off.
  const textRef = useRef<HTMLDivElement | null>(null);
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
  // After a wrong password, the form comes back with the focus in it.
  const passwordRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (asking && wrongTries > 0) passwordRef.current?.focus();
  }, [asking, wrongTries]);

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
  const goTo = (target: number) => {
    if (loading || last === null || target < 0 || target > last) return;
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
    if (!to || !turnsPages || last === null || event.defaultPrevented) return;
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
    goTo(next);
  };
  const where =
    pageCount === null
      ? ""
      : translateNow("interface.reader.where", {
          page: page + 1,
          total: pageCount,
        });
  // The picture shown is the page asked for, not one left from before.
  const current = shown && shown.page === page && !asking && !error;
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="record-dialog native-reader"
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
        {/* Zoom at the top left; the page buttons are in the bar at the foot
            (D144). */}
        <div className="native-reader-controls">
          <span className="native-reader-zoom">
            <ReaderButton
              unavailable={loading || zoom <= ZOOM_MIN}
              onPress={() =>
                setZoom((current) => Math.max(ZOOM_MIN, current / ZOOM_STEP))
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
              unavailable={loading || zoom >= ZOOM_MAX}
              onPress={() =>
                setZoom((current) => Math.min(ZOOM_MAX, current * ZOOM_STEP))
              }
            >
              {translateNow("interface.DocumentReader.larger")}
            </ReaderButton>
            <ReaderButton
              unavailable={loading || zoom === 1}
              onPress={() => setZoom(1)}
            >
              {translateNow("interface.DocumentReader.fitWidth")}
            </ReaderButton>
          </span>
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
              onLoad={() => pageDrawn(shown.page)}
            />
          )}
        </div>
        {current && (
          <details className="native-reader-text">
            <summary>
              {translateNow("interface.DocumentReader.textOnThisPage")}
            </summary>
            {/* Focusable and scrolled on its own, so that a click in the
                text lets the keys scroll it, and the page keys turn the
                page only at its end. */}
            <div
              ref={textRef}
              tabIndex={0}
              role="region"
              aria-label={translateNow(
                "interface.DocumentReader.textOnThisPage",
              )}
            >
              {(shown.readableText ?? shown.text).trim() ||
                translateNow(
                  "interface.DocumentReader.noTextCouldBeReadOnThis",
                )}
            </div>
          </details>
        )}
        {/* D144: the page bar, kept in view at the reader's foot. In words,
            not arrows; two by two on a narrow reader (styles.css). */}
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
      </section>
    </div>
  );
}

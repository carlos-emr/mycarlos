/**
 * A stored document's whole text, for the AI helper (#72 part B, threat
 * model AI-10): what native `vault_document_text` returns, and how a span of
 * one page maps to the joined text and back. Shared with the summary and
 * explain tools (part D), which link a sentence to its source span.
 *
 * The text is the reader's `readableText` of each page (line breaks kept),
 * pages joined with a blank line. Computers only: no PDF helper runs on
 * phones. Caps: 50 pages and 1 MiB joined, whole pages, flagged as
 * `truncated`; a page cut at the helper's own limit is in `cutPages`, one
 * the helper refused in `failedPages`, one with no text in `emptyPages`.
 * No page is dropped silently.
 */

export const MAX_TEXT_PAGES = 50;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const PAGE_SEPARATOR = "\n\n";

export interface DocumentPageText {
  /** From 0. */
  index: number;
  text: string;
}

export interface DocumentText {
  /** How many pages the document has, whether or not all were read. */
  pageCount: number;
  /** The pages read, in order. A page that failed has no entry. */
  pages: DocumentPageText[];
  /** Every page's text, joined with `PAGE_SEPARATOR`. */
  joined: string;
  /** Where each entry of `pages` starts in `joined`. */
  pageStarts: number[];
  /** Pages with no text (scans, pictures). */
  emptyPages: number[];
  /** Pages whose text the helper cut at its own limit. */
  cutPages: number[];
  /** Pages the helper refused or could not draw. */
  failedPages: number[];
  /** True when pages past the caps were left out. */
  truncated: boolean;
  /** The native ticket that lets this text be saved once (AI-02). */
  ticket: string;
}

/** A span of one page's text, in UTF-16 code units. */
export interface SourceSpan {
  page: number;
  start: number;
  end: number;
}

/** Joins pages the way native code does, for tests and fakes. */
export function joinPages(pages: DocumentPageText[]): {
  joined: string;
  pageStarts: number[];
} {
  let joined = "";
  const pageStarts: number[] = [];
  pages.forEach((page, position) => {
    if (position > 0) joined += PAGE_SEPARATOR;
    pageStarts.push(joined.length);
    joined += page.text;
  });
  return { joined, pageStarts };
}

/** The page span of a range of the joined text, or null when the range
 * crosses pages or falls in a separator. */
export function toPageSpan(
  text: DocumentText,
  start: number,
  end: number,
): SourceSpan | null {
  if (end < start || start < 0 || end > text.joined.length) return null;
  for (let position = text.pages.length - 1; position >= 0; position -= 1) {
    const pageStart = text.pageStarts[position];
    if (start < pageStart) continue;
    const pageEnd = pageStart + text.pages[position].text.length;
    if (end > pageEnd) return null;
    return {
      page: text.pages[position].index,
      start: start - pageStart,
      end: end - pageStart,
    };
  }
  return null;
}

/** Where a page span stands in the joined text, or null for a page that
 * was not read or a span outside its text. */
export function toJoined(
  text: DocumentText,
  span: SourceSpan,
): [number, number] | null {
  const position = text.pages.findIndex((page) => page.index === span.page);
  if (position < 0) return null;
  const length = text.pages[position].text.length;
  if (span.start < 0 || span.end < span.start || span.end > length) return null;
  const pageStart = text.pageStarts[position];
  return [pageStart + span.start, pageStart + span.end];
}

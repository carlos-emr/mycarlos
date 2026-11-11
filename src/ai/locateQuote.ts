import type { DocumentText, SourceSpan } from "./types";

/**
 * Finds the words a model quoted in the document, so a summary sentence can
 * link to the place it came from.
 *
 * A model copies text loosely: it joins lines, changes the case, swaps curly
 * and straight quotes, or drops the closing full stop. The match therefore
 * compares both texts after collapsing white space, folding case, accents
 * and compatibility forms (NFKD without combining marks), and treating curly
 * quotes as straight ones, while keeping a map back to the page's own
 * offsets. A quote with "..." or "…" in it must match each part, in order, on
 * one page.
 *
 * It is an exact match after that, never a guess: a quote that is not in the
 * document gives `null`, and the sentence then shows without a link. The
 * first match wins.
 *
 * A quote has to be worth finding: each part, after folding and trimming,
 * needs at least 12 characters or at least 3 words (a word is a run of
 * letters or digits, or one Chinese, Japanese or Korean character). A model
 * that cites "mg" or "the" would otherwise get a real-looking link to any
 * page, which is what the check is for (THREAT_MODEL.md AI-05).
 */
export function locateQuote(
  document: DocumentText,
  quote: string,
): SourceSpan | null {
  const parts = quote
    .split(/\.\.\.|…/)
    .map((part) => trimEnds(fold(part).text))
    .filter((part) => part.length > 0);
  if (parts.length === 0 || !parts.every(substantial)) return null;
  for (const page of document.pages) {
    if (!page.text) continue;
    const folded = fold(page.text);
    const span = matchParts(folded, parts);
    if (span) return { page: page.index, start: span.start, end: span.end };
  }
  return null;
}

const MIN_CHARACTERS = 12;
const MIN_WORDS = 3;
const WORD =
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[\p{L}\p{N}]+/gu;

/** Whether a folded, trimmed quote part is long enough to mean one place. */
function substantial(part: string): boolean {
  if (part.length >= MIN_CHARACTERS) return true;
  let words = 0;
  for (const _ of part.matchAll(WORD)) if (++words >= MIN_WORDS) return true;
  return false;
}

interface Folded {
  text: string;
  /** For each UTF-16 unit of `text`, where its source character starts and
   * ends in the original. */
  starts: number[];
  ends: number[];
}

const QUOTES: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "«": '"',
  "»": '"',
  "「": '"',
  "」": '"',
};

function fold(original: string): Folded {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let at = 0;
  for (const char of original) {
    const end = at + char.length;
    let out = /\s/.test(char)
      ? " "
      : (QUOTES[char] ??
        char.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, ""));
    if (out === " " && text.endsWith(" ")) out = "";
    for (let i = 0; i < out.length; i++) {
      starts.push(at);
      ends.push(end);
    }
    text += out;
    at = end;
  }
  return { text, starts, ends };
}

/** Drops white space and the punctuation a model adds or leaves off at the
 * ends of a quote. */
function trimEnds(text: string): string {
  return text.replace(/^[\s"'.,;:]+|[\s"'.,;:]+$/g, "");
}

function matchParts(
  folded: Folded,
  parts: string[],
): { start: number; end: number } | null {
  let from = 0;
  let first = -1;
  let last = -1;
  for (const part of parts) {
    const found = folded.text.indexOf(part, from);
    if (found < 0) return null;
    if (first < 0) first = found;
    last = found + part.length - 1;
    from = found + part.length;
  }
  return { start: folded.starts[first], end: folded.ends[last] };
}

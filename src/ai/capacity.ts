import type { DocumentText } from "../documentText";
import type { ModelCapacity } from "./types";

/**
 * How much of a document a model reads at a time (#301), estimated from the
 * text before the model runs. Only the model's tokenizer knows the exact
 * count, and the helper fits the pages with it: the answer still reports the
 * pages it read (`lastPage`, `lastPageCut`). These numbers are "about".
 *
 * A text is counted by the pieces the Qwen3.5 tokenizer cuts it into before
 * it looks anything up (llama.cpp `LLAMA_VOCAB_PRE_TYPE_QWEN35`, the same
 * expression). A piece never merges with the next, so each is at least one
 * token. Each piece then costs:
 * - a digit, or a run of spaces or line breaks: one estimated token;
 * - signs (".", ", ", "/", " (", "’"): one, or one for every 3 bytes of a
 *   longer run;
 * - a word, with its leading space: one for every so many bytes of its
 *   UTF-8, by its letters (`WORD_BYTES_PER_TOKEN`), never less than one.
 *   Plain letters a to z, 4. A word in capitals ("ALT", "TSH"), 1.75:
 *   abbreviations split into more tokens. A word with any other letter
 *   (French, Spanish, Polish, Portuguese), 2: the model's vocabulary is
 *   mostly English, so those words split too. Chinese, 3: about a token a
 *   character.
 *
 * Checked against real counts (11 Nov 2026):
 * - the evaluation's baseline run, 30 FAKE documents in English, French,
 *   Polish and Portuguese: the prompt tokens the helper reported, less the
 *   320 of the request around the pages;
 * - 128 more texts in all 7 languages (the deidentify fixtures, the app's
 *   own messages, a table of results), counted offline with llama.cpp's
 *   QWEN35 pieces and the model's own vocabulary; that count matched the
 *   run's on all 30 documents.
 *
 * On these 158 seen calibration texts, every estimate is at least 3%
 * above the recorded count: the English run documents about 16% above,
 * French about 25%. These fitted rates can overestimate or underestimate
 * other text. In particular, whitespace-only pieces cost one estimated
 * token regardless of length, which can underestimate long runs of
 * spaces, tabs or line breaks. A warning may therefore be absent before
 * the helper cuts a document, or appear for text that would fit. The
 * helper's exact fit and reported pages remain authoritative. These
 * counts do not establish accuracy for other Chinese documents or for
 * Gemma 4.
 *
 * A page, for the settings' "about so many pages", is 3,000 characters: a
 * full page of single-spaced typed text, read at `BYTES_PER_TOKEN`. The
 * run's English documents took 3.0 to 3.5 bytes a token over all their text
 * (digits and signs included), so the settings' figure errs small, as do
 * most pages, which hold less.
 */
export const BYTES_PER_TOKEN = 3;
export const PAGE_CHARACTERS = 3_000;
/** Bytes of a word's UTF-8 that one token stands for, by its letters (see
 * above). */
export const WORD_BYTES_PER_TOKEN = {
  plain: 4,
  capitals: 1.75,
  accented: 2,
  chinese: 3,
} as const;
/** Bytes of a run of signs that one token stands for. */
const SIGN_BYTES_PER_TOKEN = 3;
/** The first code point counted as Chinese (CJK and the scripts after it). */
const CHINESE_FROM = 0x2e80;

/** The pages' separator in the joined text, as `documentText.ts` and the
 * helper's `fit_pages` join them. */
const SEPARATOR = "\n\n";

const encoder = new TextEncoder();
/** llama.cpp's Qwen3.5 pre-tokenizer expression (llama-vocab.cpp,
 * LLAMA_VOCAB_PRE_TYPE_QWEN35), as is. */
const PRE_TOKEN =
  /(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+|\p{N}| ?[^\s\p{L}\p{M}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
const LETTER = /[\p{L}\p{M}]/u;
const ONE_TOKEN = /^(?:\p{N}|\s+)$/u;

/** The pieces the Qwen3.5 tokenizer cuts `text` into first: never more than
 * its tokens. */
export function preTokenCount(text: string): number {
  return text.match(PRE_TOKEN)?.length ?? 0;
}

/** About how many tokens one piece takes (see above), not rounded. */
function pieceTokens(piece: string): number {
  if (ONE_TOKEN.test(piece)) return 1;
  const bytes = encoder.encode(piece).length;
  let letters = 0;
  let highest = 0;
  let lowercase = false;
  for (const char of piece) {
    if (!LETTER.test(char)) continue;
    letters += 1;
    highest = Math.max(highest, char.codePointAt(0) ?? 0);
    if (char >= "a" && char <= "z") lowercase = true;
  }
  const rate =
    letters === 0
      ? SIGN_BYTES_PER_TOKEN
      : highest >= CHINESE_FROM
        ? WORD_BYTES_PER_TOKEN.chinese
        : highest >= 0x80
          ? WORD_BYTES_PER_TOKEN.accented
          : letters >= 2 && !lowercase
            ? WORD_BYTES_PER_TOKEN.capitals
            : WORD_BYTES_PER_TOKEN.plain;
  return Math.max(1, bytes / rate);
}

/** About how many of the model's tokens `text` takes, rounded up: its
 * pieces, each at what its kind costs (see above). Never fewer than its
 * pieces. */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const piece of text.match(PRE_TOKEN) ?? []) tokens += pieceTokens(piece);
  return Math.ceil(tokens);
}

/** A model's room for a document, as the settings say it: about so many
 * pages and characters, both rounded down (characters to the thousand). */
export function capacityInPages(capacity: ModelCapacity): {
  pages: number;
  characters: number;
} {
  const bytes = Math.max(0, capacity.documentTokens) * BYTES_PER_TOKEN;
  return {
    pages: Math.max(1, Math.floor(bytes / PAGE_CHARACTERS)),
    characters: Math.floor(bytes / 1000) * 1000,
  };
}

/** Whether a document fits, and if not, the pages a summary would read. */
export type FitEstimate =
  | { fits: true }
  | {
      fits: false;
      /** The last page it would read, counted from 1. */
      lastPage: number;
      /** Only the start of the first page would be read. */
      firstPageCut: boolean;
      /** The document's pages, read or not. */
      pageCount: number;
    };

/**
 * Whole pages from the first, in order, while their estimated tokens fit the
 * model's room: as the helper's `fit_pages` does with the exact count, empty
 * pages and the separator between pages included. A document whose later
 * pages the reader could not collect (`truncated`) does not fit either.
 */
export function estimateFit(
  document: DocumentText,
  capacity: ModelCapacity,
): FitEstimate {
  const budget = Math.max(0, capacity.documentTokens);
  const separator = estimateTokens(SEPARATOR);
  let used = 0;
  let fitted = 0;
  for (const [position, page] of document.pages.entries()) {
    const cost = estimateTokens(page.text) + (position > 0 ? separator : 0);
    if (used + cost > budget) break;
    used += cost;
    fitted = position + 1;
  }
  if (fitted === document.pages.length && !document.truncated)
    return { fits: true };
  const first = document.pages[0];
  return {
    fits: false,
    lastPage:
      fitted > 0
        ? document.pages[fitted - 1].index + 1
        : first
          ? first.index + 1
          : 1,
    firstPageCut: fitted === 0,
    pageCount: document.pageCount,
  };
}

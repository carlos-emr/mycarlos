import type { DocumentText } from "../documentText";
import type { ModelCapacity } from "./types";

/**
 * How much of a document a model reads at a time (#301), estimated from the
 * text before the model runs. Only the model's tokenizer knows the exact
 * count, and the helper fits the pages with it: the answer still reports the
 * pages it read (`lastPage`, `lastPageCut`). These numbers are "about".
 *
 * A text's tokens are the larger of two counts:
 * - Its bytes: a token for every 3 bytes of UTF-8 (the cautious rate the
 *   native side already uses for an answer's time limit, `local_runner.rs`
 *   prompt_tokens), and a token for every digit. This errs high for prose:
 *   English letters run nearer 4 to 4.5 bytes a token. Accented letters are
 *   2 bytes in UTF-8, so French, Spanish, Polish and Portuguese cost more, as
 *   in the model; Chinese is 3 bytes a character, about a token each.
 * - Its pre-tokens: the pieces the Qwen3.5 tokenizer cuts a text into before
 *   it looks anything up (llama.cpp `LLAMA_VOCAB_PRE_TYPE_QWEN35`, the same
 *   expression). A piece never merges with the next, so this never counts
 *   more than the model does. It matters for tables of results, where a
 *   space before a number, every digit, and each "-", "." or "/" between
 *   digits and units is a piece of its own. Gemma 4 splits digits too, so
 *   it is a close guide there.
 *
 * So prose is counted high (a question can come for a document that would
 * just fit), and tables are counted at least at their pieces. Not yet
 * checked against real counts per language: the rate is one constant.
 *
 * A page, for the settings' "about so many pages", is 3,000 characters: a
 * full page of single-spaced typed text. Most pages hold less, so that count
 * errs small.
 */
export const BYTES_PER_TOKEN = 3;
export const PAGE_CHARACTERS = 3_000;

/** The pages' separator in the joined text, as `documentText.ts` and the
 * helper's `fit_pages` join them. */
const SEPARATOR = "\n\n";

const encoder = new TextEncoder();
const DIGIT = /\p{Nd}/u;
/** llama.cpp's Qwen3.5 pre-tokenizer expression (llama-vocab.cpp,
 * LLAMA_VOCAB_PRE_TYPE_QWEN35), as is. */
const PRE_TOKEN =
  /(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+|\p{N}| ?[^\s\p{L}\p{M}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

/** The pieces the Qwen3.5 tokenizer cuts `text` into first: never more than
 * its tokens. */
export function preTokenCount(text: string): number {
  return text.match(PRE_TOKEN)?.length ?? 0;
}

/** About how many of the model's tokens `text` takes: the larger of its
 * byte count and its pre-token count (see above). */
export function estimateTokens(text: string): number {
  let digits = 0;
  let otherBytes = 0;
  for (const char of text) {
    if (DIGIT.test(char)) digits += 1;
    else otherBytes += encoder.encode(char).length;
  }
  return Math.max(
    digits + Math.ceil(otherBytes / BYTES_PER_TOKEN),
    preTokenCount(text),
  );
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

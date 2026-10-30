import type {
  DocumentText,
  LocalModel,
  ModelInfo,
  ModelSentence,
  ModelStatus,
} from "../ai/types";

/** For tests only: a model that answers at once with fixed, FAKE text, so the
 * AI helper's screens can be tested before a real model can be installed. */
export interface FakeLocalModel extends LocalModel {
  calls: { tool: "summary" | "explain"; lang: string; input: string }[];
}

export const FAKE_MODEL: ModelInfo = {
  name: "FAKE test model",
  sha256: "test-only",
};

export function fakeLocalModel(
  options: {
    status?: ModelStatus;
    /** The summary to give; by default, one sentence per page with text,
     * quoting that page's first line. */
    sentences?: (document: DocumentText) => ModelSentence[];
    explanation?: string;
  } = {},
): FakeLocalModel {
  const calls: FakeLocalModel["calls"] = [];
  const status = options.status ?? { state: "installed", model: FAKE_MODEL };
  const model = status.state === "installed" ? status.model : FAKE_MODEL;
  return {
    calls,
    status: async () => status,
    summarize: async (document, lang) => {
      calls.push({ tool: "summary", lang, input: document.joined });
      const sentences = options.sentences
        ? options.sentences(document)
        : firstLines(document);
      return { sentences, model };
    },
    explain: async (term, context, lang) => {
      calls.push({ tool: "explain", lang, input: `${term}\n${context}` });
      return {
        text: options.explanation ?? `FAKE explanation of ${term}.`,
        model,
      };
    },
  };
}

function firstLines(document: DocumentText): ModelSentence[] {
  return document.pages
    .filter((page) => page.text.trim())
    .map((page) => {
      const line = page.text.trim().split("\n")[0].trim();
      return { text: `Page ${page.index + 1} begins: ${line}`, quote: line };
    });
}

/** Builds a `DocumentText` the way part B's reader does: pages joined with a
 * blank line, empty pages listed. */
export function fakeDocumentText(
  pages: string[],
  truncated = false,
  unread: { cutPages?: number[]; failedPages?: number[] } = {},
): DocumentText {
  const failed = new Set(unread.failedPages ?? []);
  // As the native command does: a page that failed has no entry.
  const read = pages.flatMap((text, index) =>
    failed.has(index) ? [] : [{ index, text }],
  );
  const pageStarts: number[] = [];
  let joined = "";
  read.forEach((page, position) => {
    if (position > 0) joined += "\n\n";
    pageStarts.push(joined.length);
    joined += page.text;
  });
  return {
    pageCount: pages.length,
    pages: read,
    joined,
    pageStarts,
    emptyPages: read.flatMap((page) => (page.text ? [] : [page.index])),
    cutPages: unread.cutPages ?? [],
    failedPages: unread.failedPages ?? [],
    truncated,
    ticket: "FAKE-ticket",
  };
}

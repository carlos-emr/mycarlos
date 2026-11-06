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
  /** How many times `cancel` was called. */
  cancels: number;
  /** The answers kept for a document's save, as the native side keeps them
   * (#212): one per answer asked with `keepFor`, under its `keptId`. */
  kept: {
    keptId: string;
    recordId: string;
    tool: "summary" | "explain";
    lang: string;
    term?: string;
  }[];
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
    /** The last page read, by its index; by default every page was. */
    lastPage?: (document: DocumentText) => number;
    /** The first page alone was too long, and only its start was read. */
    lastPageCut?: boolean;
  } = {},
): FakeLocalModel {
  const calls: FakeLocalModel["calls"] = [];
  const status = options.status ?? { state: "installed", model: FAKE_MODEL };
  const model = status.state === "installed" ? status.model : FAKE_MODEL;
  const keep = (
    recordId: string | undefined,
    question: Omit<FakeLocalModel["kept"][number], "keptId" | "recordId">,
  ) => {
    if (!recordId) return undefined;
    const keptId = `FAKE-kept-${fake.kept.length + 1}`;
    fake.kept.push({ keptId, recordId, ...question });
    return keptId;
  };
  const fake: FakeLocalModel = {
    calls,
    cancels: 0,
    kept: [],
    status: async () => status,
    summarize: async (document, lang, keepFor) => {
      calls.push({ tool: "summary", lang, input: document.joined });
      const keptId = keep(keepFor, { tool: "summary", lang });
      const sentences = options.sentences
        ? options.sentences(document)
        : firstLines(document);
      return {
        sentences,
        model,
        lastPage: options.lastPage
          ? options.lastPage(document)
          : (document.pages.at(-1)?.index ?? 0),
        lastPageCut: options.lastPageCut ?? false,
        ...(keptId ? { keptId } : {}),
      };
    },
    explain: async (term, context, lang, keepFor) => {
      calls.push({ tool: "explain", lang, input: `${term}\n${context}` });
      const keptId = keep(keepFor, { tool: "explain", lang, term });
      return {
        text: options.explanation ?? `FAKE explanation of ${term}.`,
        model,
        ...(keptId ? { keptId } : {}),
      };
    },
    cancel: () => {
      fake.cancels += 1;
    },
  };
  return fake;
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

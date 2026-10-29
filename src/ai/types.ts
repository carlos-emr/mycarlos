/**
 * The AI helper's shared types (#72, part D): a plain-words summary of a
 * document and the explanation of a term, from a model that runs on this
 * computer. Nothing here touches the network.
 *
 * `DocumentText` and `SourceSpan` copy the shapes part B owns in
 * `src/documentText.ts`. Once that file is on main, import them from there and
 * delete the copies below.
 */

/** A document's text, page by page, as the reader shows it. */
export interface DocumentText {
  pageCount: number;
  /** Each page's text (`readableText ?? text`); "" for a page with none. */
  pages: { index: number; text: string }[];
  /** The pages joined with "\n\n". */
  joined: string;
  /** Where each page starts in `joined`. */
  pageStarts: number[];
  /** Pages with no text, such as scans. */
  emptyPages: number[];
  /** True when only the first pages were read (a page or size cap). */
  truncated: boolean;
}

/** A place in one page's text: UTF-16 offsets, end exclusive. */
export interface SourceSpan {
  page: number;
  start: number;
  end: number;
}

export type AiTool = "summary" | "explain";

/** Which model produced a result: its name and the hash of its file. */
export interface ModelInfo {
  name: string;
  sha256: string;
}

export type ModelStatus =
  | { state: "notInstalled" }
  | { state: "installed"; model: ModelInfo };

/** One summary sentence as the model writes it: the words, and the words of
 * the document it rests on, copied as they are. */
export interface ModelSentence {
  text: string;
  quote: string;
}

/** A summary sentence with its place in the document, or `null` when the
 * quote was not found there. The app never guesses a place. */
export interface SummarySentence extends ModelSentence {
  source: SourceSpan | null;
}

export interface SummaryResult {
  tool: "summary";
  sentences: SummarySentence[];
  model: ModelInfo;
  /** The language the summary is written in (a locale such as "fr"). */
  lang: string;
  /** When it was written, in ms since the epoch. */
  createdAt: number;
  /** True when the document was longer than what was read. */
  partial: boolean;
}

export interface ExplainResult {
  tool: "explain";
  term: string;
  /** The sentence the term was found in, when there is one. */
  context: string;
  text: string;
  model: ModelInfo;
  lang: string;
  createdAt: number;
}

/** What the reader needs from a model. The real one runs natively; until a
 * model can be installed, `notInstalledModel` stands in. */
export interface LocalModel {
  status(): Promise<ModelStatus>;
  summarize(
    document: DocumentText,
    lang: string,
  ): Promise<{ sentences: ModelSentence[]; model: ModelInfo }>;
  explain(
    term: string,
    context: string,
    lang: string,
  ): Promise<{ text: string; model: ModelInfo }>;
}

/** Thrown by a model asked to work while none is installed. */
export class ModelNotInstalled extends Error {
  constructor() {
    super("No AI model is installed on this computer.");
    this.name = "ModelNotInstalled";
  }
}

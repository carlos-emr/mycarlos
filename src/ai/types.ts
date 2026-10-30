/**
 * The AI helper's shared types (#72, part D): a plain-words summary of a
 * document and the explanation of a term, from a model that runs on this
 * computer. Nothing here touches the network.
 *
 * `DocumentText` and `SourceSpan` copy the shapes part B owns in
 * `src/documentText.ts`. Once that file is on main, import them from there and
 * delete the copies below.
 */

export interface DocumentPageText {
  /** From 0. */
  index: number;
  text: string;
}

/** A document's whole text, as native `vault_document_text` returns it
 * (part B, threat model AI-10). */
export interface DocumentText {
  /** How many pages the document has, whether or not all were read. */
  pageCount: number;
  /** The pages read, in order. A page that failed has no entry. */
  pages: DocumentPageText[];
  /** Every page's text, joined with "\n\n". */
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

/** A span of one page's text, in UTF-16 code units, end exclusive. */
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

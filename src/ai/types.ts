/**
 * The AI helper's shared types (#72, part D): a plain-words summary of a
 * document and the explanation of a term, from a model that runs on this
 * computer. Nothing here touches the network.
 *
 * `DocumentText` and `SourceSpan` are part B's, from `src/documentText.ts`,
 * re-exported here for the reader's code.
 */

export type {
  DocumentPageText,
  DocumentText,
  SourceSpan,
} from "../documentText";
import type { DocumentText, SourceSpan } from "../documentText";

export type AiTool = "summary" | "explain";

/** Which model produced a result: its name and the hash of its file. */
export interface ModelInfo {
  name: string;
  sha256: string;
}

export type ModelStatus =
  | { state: "notInstalled" }
  | { state: "installed"; model: ModelInfo }
  /** This computer cannot run the helper: the row says why, with no Add. */
  | { state: "unsupported"; reason: "ram" | "cpu" | "platform" }
  /** The file is there but its size or hash is wrong: the row offers Remove. */
  | { state: "damaged" };

/** One model the app accepts (`ai_model_catalog`). `sourceUrl` is shown as
 * text with a Copy button; the app opens nothing. */
export interface AcceptedModel {
  name: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  licence: string;
  notices: string[];
  sourceUrl: string;
}

/** How `ai_model_add_picked` ended. `added` carries the new status; the
 * others are refusals, except `cancelled`, which is silent. */
export type ModelAddOutcome =
  | { outcome: "added"; status: ModelStatus }
  | { outcome: "cancelled" }
  | {
      outcome:
        | "notListed"
        | "tooBig"
        | "incomplete"
        | "wrongHash"
        | "noDisk"
        | "unreadable"
        | "storage"
        | "busy"
        /** Download only: no connection, or it was lost. */
        | "network"
        /** Download only: the address refused (401/403/404/410). */
        | "unavailable";
    }
  | { outcome: "unsupported"; reason: "ram" | "cpu" | "platform" };

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

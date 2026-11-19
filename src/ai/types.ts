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

/** How much of a document one summary reads (#301), in the model's tokens:
 * the context the helper runs it with, and the room left for the document's
 * text (`capacity.ts` turns it into about so many pages). */
export interface ModelCapacity {
  contextTokens: number;
  documentTokens: number;
}

/** What `ai_model_status` says about the model on this computer. */
export type ModelStatus =
  | { state: "notInstalled" }
  | {
      state: "installed";
      model: ModelInfo;
      /** How much of a document it reads at a time; null or absent when
       * not known, and the reader then starts as before. */
      capacity?: ModelCapacity | null;
    }
  /** The model cannot run here: too little memory in all, a processor
   * without the instructions it needs, or a system it does not run on yet
   * (macOS, for now). */
  | { state: "unsupported"; reason: "ram" | "cpu" | "platform" }
  /** The model's file failed its check: Preferences can remove it. */
  | { state: "damaged" };

/** A summary as the model writes it, and how far into the document it
 * read: whole pages in order, while they fit. */
export interface ModelSummary {
  sentences: ModelSentence[];
  model: ModelInfo;
  /** The last page read, by its index (from 0). */
  lastPage: number;
  /** True when the first page alone was too long, and only its start was
   * read (it is then `lastPage`). */
  lastPageCut: boolean;
  /** The id the native side kept this answer under for the document's save
   * (#212), when the request named the document. */
  keptId?: string;
}

/** A term explained, as the model writes it. */
export interface ModelExplanation {
  text: string;
  model: ModelInfo;
  /** As `ModelSummary.keptId`. */
  keptId?: string;
}

/** One summary sentence as the model writes it: the words, and the words of
 * the document it rests on, copied as they are. */
export interface ModelSentence {
  text: string;
  quote: string;
}

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
  /** How much of a document it reads at a time (#301). Absent from a native
   * side that predates it. */
  capacity?: ModelCapacity;
}

/** One native catalog row, keyed by its stable catalog index (#276A). */
export interface ModelRow {
  index: number;
  model: AcceptedModel;
  state: "notDownloaded" | "installed" | "damaged";
  addedByYou: boolean;
  inUse: boolean;
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

/** A summary sentence with its place in the document, or `null` when the
 * quote was not found there. The app never guesses a place. */
export interface SummarySentence extends ModelSentence {
  source: SourceSpan | null;
}

export interface SummaryResult {
  tool: "summary";
  /** The native keep id (`ModelSummary.keptId`); never on an answer read
   * back from the vault. */
  keptId?: string;
  sentences: SummarySentence[];
  model: ModelInfo;
  /** The language the summary is written in (a locale such as "fr"). */
  lang: string;
  /** When it was written, in ms since the epoch. */
  createdAt: number;
  /** True when the document was longer than what was read. */
  partial: boolean;
  /** The last page read, by its number from 1 (0 when none was). */
  lastPage: number;
  /** True when a page had no text, was cut short or could not be read. */
  pagesMissing: boolean;
}

export interface ExplainResult {
  tool: "explain";
  /** The native keep id (`ModelSummary.keptId`); never on an answer read
   * back from the vault. */
  keptId?: string;
  term: string;
  /** The sentence the term was found in, when there is one. */
  context: string;
  text: string;
  model: ModelInfo;
  lang: string;
  createdAt: number;
}

/** What the reader needs from a model. The real one runs natively
 * (`nativeLocalModel`); `notInstalledModel` refuses everything. */
export interface LocalModel {
  status(): Promise<ModelStatus>;
  /** With `keepFor` (the document's record id), the native side also keeps
   * the answer for that document's save and gives its `keptId`. */
  summarize(
    document: DocumentText,
    lang: string,
    keepFor?: string,
  ): Promise<ModelSummary>;
  explain(
    term: string,
    context: string,
    lang: string,
    keepFor?: string,
  ): Promise<ModelExplanation>;
  /** Stops the answer being written, if one is: the panel closed. */
  cancel(): void;
}

/** Thrown by a model asked to work while none is installed, or while its
 * file fails its check: either way the patient is led to Preferences. */
export class ModelNotInstalled extends Error {
  constructor() {
    super("No AI model is installed on this computer.");
    this.name = "ModelNotInstalled";
  }
}

/** Thrown by a model whose answer was stopped (`cancel`, or the vault
 * locking): nothing is said, as the patient left. */
export class ModelCancelled extends Error {
  constructor() {
    super("The AI model's answer was stopped.");
    this.name = "ModelCancelled";
  }
}

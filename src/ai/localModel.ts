import { hasVaultErrorCode } from "../vault";
import { locateQuote } from "./locateQuote";
import {
  ModelCancelled,
  ModelNotInstalled,
  type DocumentPageText,
  type DocumentText,
  type ExplainResult,
  type LocalModel,
  type ModelExplanation,
  type ModelSentence,
  type ModelStatus,
  type ModelSummary,
  type SummaryResult,
  type SummarySentence,
} from "./types";

/** The model the app has until one can be installed: it says so, and refuses
 * any work. */
export const notInstalledModel: LocalModel = {
  status: async () => ({ state: "notInstalled" }),
  summarize: async () => {
    throw new ModelNotInstalled();
  },
  explain: async () => {
    throw new ModelNotInstalled();
  },
  cancel: () => undefined,
};

/** Whether a model can run on this computer, by its status: one can be
 * added, is added, or was added and needs replacing. Not where the computer
 * is unsupported (too little memory, an older processor, or a system the
 * model does not run on yet), nor when the status is unknown. */
export function modelRunsHere(status: ModelStatus | null | undefined): boolean {
  return (
    status?.state === "installed" ||
    status?.state === "notInstalled" ||
    status?.state === "damaged"
  );
}

/** The native commands the model runs through (#72, the model runtime). */
export interface ModelBridge {
  aiModelStatus(): Promise<ModelStatus>;
  aiSummarize(
    pages: DocumentPageText[],
    lang: string,
    keep?: { recordId: string; ticket: string },
  ): Promise<ModelSummary>;
  aiExplain(
    term: string,
    context: string,
    lang: string,
    recordId?: string,
  ): Promise<ModelExplanation>;
  aiCancel(): Promise<void>;
}

/** The model on this computer, run natively in its own sandboxed helper.
 * A refusal because no model is there, or because its file failed its
 * check, is `ModelNotInstalled` (the panel leads to Preferences); an answer
 * stopped by `cancel` or by the lock is `ModelCancelled`. Any other refusal
 * (memory, busy, a failed run) passes on as it is. */
export function nativeLocalModel(bridge: ModelBridge): LocalModel {
  const refused = (failure: unknown): never => {
    if (
      hasVaultErrorCode(failure, "aiNotInstalled") ||
      hasVaultErrorCode(failure, "aiDamaged")
    )
      throw new ModelNotInstalled();
    if (hasVaultErrorCode(failure, "aiCancelled")) throw new ModelCancelled();
    throw failure;
  };
  return {
    status: () => bridge.aiModelStatus(),
    // The pages as read, unchanged: the model takes whole pages, in order,
    // while they fit, and says which was the last. Kept for a document's
    // save (#212), the native side checks they are the pages that the text
    // read with this ticket gave.
    summarize: (document, lang, keepFor) =>
      bridge
        .aiSummarize(
          document.pages,
          lang,
          keepFor ? { recordId: keepFor, ticket: document.ticket } : undefined,
        )
        .catch(refused),
    explain: (term, context, lang, keepFor) =>
      bridge.aiExplain(term, context, lang, keepFor).catch(refused),
    cancel: () => void bridge.aiCancel().catch(() => undefined),
  };
}

/** Gives each sentence its place in the document, or `null` when its quote
 * is not there. */
export function withSources(
  document: DocumentText,
  sentences: ModelSentence[],
): SummarySentence[] {
  return sentences.map((sentence) => ({
    ...sentence,
    source: locateQuote(document, sentence.quote),
  }));
}

export async function summarizeDocument(
  model: LocalModel,
  document: DocumentText,
  lang: string,
  now: () => number = Date.now,
  keepFor?: string,
): Promise<SummaryResult> {
  const written = await model.summarize(document, lang, keepFor);
  return {
    tool: "summary",
    ...(written.keptId ? { keptId: written.keptId } : {}),
    sentences: withSources(document, written.sentences),
    model: written.model,
    lang,
    createdAt: now(),
    // Shorter than the document: pages left out by the reader's caps, pages
    // the model had no room for, or a first page it read only the start of.
    partial:
      document.truncated ||
      written.lastPage < (document.pages.at(-1)?.index ?? 0) ||
      written.lastPageCut,
    lastPage: document.pages.length ? written.lastPage + 1 : 0,
    // Pages with no text, cut short or not read at all, for the kept
    // summary's notice.
    pagesMissing:
      document.emptyPages.length +
        document.cutPages.length +
        document.failedPages.length >
      0,
  };
}

export async function explainTerm(
  model: LocalModel,
  term: string,
  context: string,
  lang: string,
  now: () => number = Date.now,
  keepFor?: string,
): Promise<ExplainResult> {
  const written = await model.explain(term, context, lang, keepFor);
  return {
    tool: "explain",
    ...(written.keptId ? { keptId: written.keptId } : {}),
    term,
    context,
    text: written.text,
    model: written.model,
    lang,
    createdAt: now(),
  };
}

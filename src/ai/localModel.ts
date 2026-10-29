import { locateQuote } from "./locateQuote";
import {
  ModelNotInstalled,
  type DocumentText,
  type ExplainResult,
  type LocalModel,
  type ModelSentence,
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
};

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
): Promise<SummaryResult> {
  const written = await model.summarize(document, lang);
  return {
    tool: "summary",
    sentences: withSources(document, written.sentences),
    model: written.model,
    lang,
    createdAt: now(),
    partial: document.truncated,
  };
}

export async function explainTerm(
  model: LocalModel,
  term: string,
  context: string,
  lang: string,
  now: () => number = Date.now,
): Promise<ExplainResult> {
  const written = await model.explain(term, context, lang);
  return {
    tool: "explain",
    term,
    context,
    text: written.text,
    model: written.model,
    lang,
    createdAt: now(),
  };
}

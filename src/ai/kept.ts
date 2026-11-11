import type { AiResultInfo } from "../vault";
import type { ExplainResult, SourceSpan, SummaryResult } from "./types";

/**
 * Answers kept with the document (#72 part D step 2): how the reader reads
 * one back and how it asks the vault to keep one. The vault stores the
 * answer's JSON as it is, so a kept answer is checked here before it is
 * shown: a damaged or foreign one is treated as absent, never guessed at.
 */
export interface KeptAnswers {
  /** The document they are kept with: the model is asked to keep each
   * answer for it natively, for `save`. */
  recordId: string;
  list(): Promise<AiResultInfo[]>;
  read(resultId: string): Promise<string>;
  /** Keeps the answer the native side kept under `keptId` (#212). A
   * summary gives each sentence's source place, as the reader found it. */
  save(keptId: string, sources?: (SourceSpan | null)[]): Promise<AiResultInfo>;
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function isModel(value: unknown): value is SummaryResult["model"] {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { sha256?: unknown }).sha256 === "string"
  );
}

/** The kept summary's JSON as a `SummaryResult`, or `null` when it is not
 * one. */
export function parseKeptSummary(text: string): SummaryResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.tool !== "summary" ||
    !Array.isArray(candidate.sentences) ||
    !isModel(candidate.model) ||
    typeof candidate.lang !== "string" ||
    !isNumber(candidate.createdAt) ||
    typeof candidate.partial !== "boolean" ||
    !isNumber(candidate.lastPage) ||
    typeof candidate.pagesMissing !== "boolean"
  )
    return null;
  const sentences: SummaryResult["sentences"] = [];
  for (const sentence of candidate.sentences) {
    if (typeof sentence !== "object" || sentence === null) return null;
    const { text, quote, source } = sentence as Record<string, unknown>;
    if (typeof text !== "string" || typeof quote !== "string") return null;
    if (source === null) {
      sentences.push({ text, quote, source: null });
      continue;
    }
    if (typeof source !== "object") return null;
    const { page, start, end } = source as Record<string, unknown>;
    if (!isNumber(page) || !isNumber(start) || !isNumber(end)) return null;
    // A place that cannot be one (not whole, before the start, or backwards)
    // is no place: the sentence says no source was found, never a guess.
    const place = (value: number) => Number.isInteger(value) && value >= 0;
    const sound = place(page) && place(start) && place(end) && start <= end;
    sentences.push({
      text,
      quote,
      source: sound ? { page, start, end } : null,
    });
  }
  return {
    tool: "summary",
    sentences,
    model: { name: candidate.model.name, sha256: candidate.model.sha256 },
    lang: candidate.lang,
    createdAt: candidate.createdAt,
    partial: candidate.partial,
    lastPage: candidate.lastPage,
    pagesMissing: candidate.pagesMissing,
  };
}

/** What page code adds to an answer it asks the vault to keep: a summary's
 * source places, one per sentence. The words, model, language and flags
 * are the native side's own (#212). */
export function keptSources(
  result: SummaryResult | ExplainResult,
): (SourceSpan | null)[] | undefined {
  return result.tool === "summary"
    ? result.sentences.map((sentence) => sentence.source)
    : undefined;
}

/** The kept answer for a summary in `lang`, if the vault has one. */
export async function keptSummary(
  kept: KeptAnswers,
  lang: string,
): Promise<SummaryResult | null> {
  const found = (await kept.list()).find(
    (info) => info.tool === "summary" && info.lang === lang,
  );
  if (!found) return null;
  return parseKeptSummary(await kept.read(found.id));
}

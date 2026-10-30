import type { AiResultInfo, AiResultInput } from "../vault";
import type { ExplainResult, SummaryResult } from "./types";

/**
 * Answers kept with the document (#72 part D step 2): how the reader reads
 * one back and how it asks the vault to keep one. The vault stores the
 * answer's JSON as it is, so a kept answer is checked here before it is
 * shown: a damaged or foreign one is treated as absent, never guessed at.
 */
export interface KeptAnswers {
  list(): Promise<AiResultInfo[]>;
  read(resultId: string): Promise<string>;
  save(input: AiResultInput, content: string): Promise<AiResultInfo>;
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
    typeof candidate.partial !== "boolean"
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
    sentences.push({ text, quote, source: { page, start, end } });
  }
  return {
    tool: "summary",
    sentences,
    model: { name: candidate.model.name, sha256: candidate.model.sha256 },
    lang: candidate.lang,
    createdAt: candidate.createdAt,
    partial: candidate.partial,
  };
}

/** What the vault is told about an answer it keeps. */
export function keptInput(
  result: SummaryResult | ExplainResult,
): AiResultInput {
  return {
    tool: result.tool,
    lang: result.lang,
    ...(result.tool === "explain" ? { term: result.term } : {}),
    modelName: result.model.name,
    modelSha256: result.model.sha256,
  };
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

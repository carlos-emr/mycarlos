import type { Removed, RemovedKind } from "../deidentify/deidentify";

/**
 * Helpers for the preview of the text prepared for an AI (AnonymizePreview.tsx). They only read
 * a de-identification result; they find nothing new to remove, and they are not part of the
 * rules in src/deidentify.
 */

/** How many details of each kind were taken out, in the order each kind first appears in the
 * document. The input is the automatic result's list plus every removal the patient made, so
 * the counts follow the preview as it changes. */
export function removalCounts(
  removed: readonly Removed[],
): { kind: RemovedKind | "date"; count: number }[] {
  const counts = new Map<RemovedKind | "date", number>();
  for (const part of removed)
    counts.set(part.kind, (counts.get(part.kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => ({ kind, count }));
}

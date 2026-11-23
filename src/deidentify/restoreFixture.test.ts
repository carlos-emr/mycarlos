import { describe, expect, it } from "vitest";
import fixture from "../../src-tauri/tests/fixtures/cloud-restore-cases.json";
import {
  DEFAULT_LABELS,
  DEFAULT_NOTES,
  restoreChecked,
  type Deidentified,
  type RemovedKind,
} from "./deidentify";

// The cases the Rust restore (src-tauri/src/cloud_ai/restore.rs) also runs: one fixture, so the page's
// paste-back and the native one that restores a cloud answer cannot drift apart (#72). FAKE only.

const sentFor = (
  removed: { kind: string; replacement: string; original: string }[],
  source = "",
): Deidentified => {
  const parts = removed.map((part, index) => ({
    kind: part.kind as RemovedKind | "date",
    original: part.original,
    replacement: part.replacement,
    start: index,
    end: index + 1,
    sentStart: index,
    sentEnd: index + 1,
  }));
  return {
    toSend: "",
    onDevice: {
      removed: parts,
      possibleNames: [],
      dayFirst: true,
      labels: DEFAULT_LABELS,
      notes: DEFAULT_NOTES,
      source,
      cleaning: { replacedRuns: 0, droppedCodePoints: 0 },
    },
  } as unknown as Deidentified;
};

describe("the shared restore cases (#72)", () => {
  it("uses the placeholder words the page uses", () => {
    for (const label of fixture.labels)
      expect(Object.values(DEFAULT_LABELS)).toContain(label);
  });

  it.each(fixture.cases.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      const result = restoreChecked(
        entry.answer,
        sentFor(entry.removed, "source" in entry ? entry.source : ""),
      );
      expect(result.text).toBe(entry.text);
      expect(result.flagged).toEqual(entry.flagged);
    },
  );
});

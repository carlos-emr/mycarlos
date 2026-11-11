import { describe, expect, it } from "vitest";
import {
  deidentify,
  removeMore,
  restore,
  type Deidentified,
  type Removed,
} from "./deidentify";

const options = { knownNames: [] };

function removeWord(value: Deidentified, word: string): Deidentified {
  const start = value.toSend.indexOf(word);
  expect(start).toBeGreaterThanOrEqual(0);
  return removeMore(value, start, start + word.length);
}

/** A persisted pre-fix manual removal, without regenerating its marker. */
function legacySnapshot(source: string, word: string): Deidentified {
  const base = deidentify(source, options);
  const start = source.lastIndexOf(word);
  const replacement = "[REMOVED 1]";
  const part: Removed = {
    kind: "manual",
    original: word,
    replacement,
    start,
    end: start + word.length,
    sentStart: start,
    sentEnd: start + replacement.length,
  };
  // Older stored metadata keeps this same shape; no new schema is required.
  return JSON.parse(
    JSON.stringify({
      toSend: source.slice(0, start) + replacement + source.slice(part.end),
      onDevice: { ...base.onDevice, removed: [part] },
    }),
  ) as Deidentified;
}

describe("literal placeholder collisions", () => {
  it("reserves adjacent and repeated literal markers", () => {
    const source =
      "literal [NAME 1][NAME 2] [NAME 1]; Avery Example. Avery Example.";
    const result = deidentify(source, {
      ...options,
      knownNames: ["Avery Example"],
    });
    expect(result.toSend).toBe(
      "literal [NAME 1][NAME 2] [NAME 1]; [NAME 3]. [NAME 3].",
    );
    expect(restore(result.toSend, result)).toBe(source);
    expect(restore("[NAME 1] and [NAME 3] and [NAME 99]", result)).toBe(
      "[NAME 1] and Avery Example and [NAME 99]",
    );
  });

  it("keeps literal REMOVED markers during manual removal", () => {
    const source = "literal [REMOVED 1]; alice and bob.";
    const first = removeWord(deidentify(source, options), "alice");
    expect(first.toSend).toBe("literal [REMOVED 1]; [REMOVED 2] and bob.");
    const second = removeWord(first, "bob");
    expect(second.toSend).toBe(
      "literal [REMOVED 1]; [REMOVED 2] and [REMOVED 3].",
    );
    expect(restore(second.toSend, second)).toBe(source);
    expect(second.onDevice.removed.map((part) => part.replacement)).toEqual([
      "[REMOVED 2]",
      "[REMOVED 3]",
    ]);
  });

  it("restores a redacted literal marker without recursion", () => {
    const source = "literal [REMOVED 1] and tail";
    const first = removeWord(deidentify(source, options), "[REMOVED 1]");
    expect(first.onDevice.removed[0].original).toBe("[REMOVED 1]");
    expect(first.toSend).toBe("literal [REMOVED 2] and tail");
    const second = removeWord(first, "tail");
    expect(restore(second.toSend, second)).toBe(source);
    expect(restore("[REMOVED 2] [REMOVED 3]", second)).toBe("[REMOVED 1] tail");
  });

  it("does not reuse retained manual IDs after an overlapping removal", () => {
    const source = "one two three four";
    let result = deidentify(source, options);
    for (const word of ["one", "two", "three"])
      result = removeWord(result, word);
    const end = result.toSend.indexOf("[REMOVED 2]") + "[REMOVED 2]".length;
    const combined = removeMore(result, 0, end, { over: true });
    expect(combined.toSend).toBe("[REMOVED 4] [REMOVED 3] four");
    const last = removeWord(combined, "four");
    expect(last.toSend).toBe("[REMOVED 4] [REMOVED 3] [REMOVED 5]");
    expect(restore(last.toSend, last)).toBe(source);
  });

  it("reserves localized labels and keeps date settings", () => {
    const source =
      "literal [NOM+ 1] [RETIRÉ? 1]; Avery Example. token. Visit 2026-10-01.";
    const result = deidentify(source, {
      ...options,
      knownNames: ["Avery Example"],
      dayFirst: false,
      labels: { name: "NOM+", manual: "RETIRÉ?" },
    });
    expect(result.toSend).toContain("literal [NOM+ 1] [RETIRÉ? 1]; [NOM+ 2].");
    const more = removeWord(result, "token");
    expect(more.toSend).toContain("[RETIRÉ? 2]");
    const dates = (value: Deidentified) =>
      value.onDevice.removed
        .filter((part) => part.kind === "date")
        .map(({ original, replacement, start, end }) => ({
          original,
          replacement,
          start,
          end,
        }));
    expect(dates(more)).toEqual(dates(result));
    expect(more.onDevice.notes).toEqual(result.onDevice.notes);
    expect(more.onDevice.dayFirst).toBe(false);
    expect(more.onDevice.labels).toEqual(result.onDevice.labels);
    expect(more.onDevice.cleaning).toEqual(result.onDevice.cleaning);
    expect(restore(more.toSend, more)).toBe(source);
  });

  it("restores an unambiguous serialized removal", () => {
    const previous = legacySnapshot("alice", "alice");
    expect(restore(previous.toSend, previous)).toBe("alice");
    expect(restore("Ask [REMOVED 1].", previous)).toBe("Ask alice.");
  });

  it("leaves ambiguous legacy markers unresolved", () => {
    const source = "literal [REMOVED 1]; alice.";
    const previous = legacySnapshot(source, "alice");
    expect(restore(previous.toSend, previous)).toBe(previous.toSend);
    expect(restore("[REMOVED 1]", previous)).toBe("[REMOVED 1]");
    // This does not repair the old ambiguity or claim a restored round trip.
    expect(restore(previous.toSend, previous)).not.toBe(source);
  });

  it("leaves conflicting serialized manual IDs unresolved", () => {
    const source = "one two three four";
    const base = deidentify(source, options);
    // Pre-fix overlap absorbed IDs 1/2, made 4, then reused the retained 3.
    const removed: Removed[] = [
      {
        kind: "manual",
        original: "one two",
        replacement: "[REMOVED 4]",
        start: 0,
        end: 7,
        sentStart: 0,
        sentEnd: 11,
      },
      {
        kind: "manual",
        original: "three",
        replacement: "[REMOVED 3]",
        start: 8,
        end: 13,
        sentStart: 12,
        sentEnd: 23,
      },
      {
        kind: "manual",
        original: "four",
        replacement: "[REMOVED 3]",
        start: 14,
        end: 18,
        sentStart: 24,
        sentEnd: 35,
      },
    ];
    const previous = JSON.parse(
      JSON.stringify({
        toSend: "[REMOVED 4] [REMOVED 3] [REMOVED 3]",
        onDevice: { ...base.onDevice, removed },
      }),
    ) as Deidentified;
    expect(restore(previous.toSend, previous)).toBe(
      "one two [REMOVED 3] [REMOVED 3]",
    );
    expect(restore("[REMOVED 3]", previous)).toBe("[REMOVED 3]");
  });

  it("keeps automatic case variants on their canonical mapping", () => {
    const result = deidentify("Avery Example met AVERY EXAMPLE.", {
      ...options,
      knownNames: ["Avery Example"],
    });
    const names = result.onDevice.removed.filter(
      (part) => part.kind === "name",
    );
    expect(new Set(names.map((part) => part.original)).size).toBeGreaterThan(1);
    expect(new Set(names.map((part) => part.replacement))).toEqual(
      new Set(["[NAME 1]"]),
    );
    expect(restore(result.toSend, result)).toBe(
      "Avery Example met Avery Example.",
    );
  });

  it("reserves overlapping literal markers in custom labels", () => {
    for (const { source, labels, expected } of [
      {
        source: "literal [OUT[NAME 1] 1]; alice.",
        labels: { name: "OUT[NAME 1]", manual: "NAME" },
        expected: "literal [OUT[NAME 1] 1]; [NAME 2].",
      },
      {
        source: "literal [A 1] B 1]; alice.",
        labels: { name: "A", manual: "A 1] B" },
        expected: "literal [A 1] B 1]; [A 1] B 2].",
      },
    ]) {
      const result = deidentify(source, { ...options, labels });
      const more = removeWord(result, "alice");
      expect(more.toSend, source).toBe(expected);
      expect(restore(more.toSend, more), source).toBe(source);
    }
  });
});

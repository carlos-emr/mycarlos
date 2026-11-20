import { describe, expect, it } from "vitest";
import type { Removed } from "../deidentify/deidentify";
import { removalCounts, wordsToCheck } from "./anonymizeReview";

// Synthetic placeholders only.
const part = (kind: Removed["kind"], at: number): Removed => ({
  kind,
  original: "FAKE",
  replacement: "[FAKE]",
  start: at,
  end: at + 1,
  sentStart: at,
  sentEnd: at + 6,
});

describe("removalCounts", () => {
  it("counts each kind, in the order each first appears", () => {
    expect(
      removalCounts([
        part("name", 0),
        part("date", 10),
        part("name", 20),
        part("phone", 30),
        part("name", 40),
        part("date", 50),
      ]),
    ).toEqual([
      { kind: "name", count: 3 },
      { kind: "date", count: 2 },
      { kind: "phone", count: 1 },
    ]);
  });

  it("is empty when nothing was removed", () => {
    expect(removalCounts([])).toEqual([]);
  });
});

describe("wordsToCheck", () => {
  const words = (text: string, removed: Removed[] = []) =>
    wordsToCheck(text, removed).map((found) => found.word);

  it("flags a capitalised word that does not start a sentence", () => {
    expect(words("The patient saw Avery Example at the clinic.")).toEqual([
      "Avery",
      "Example",
    ]);
  });

  it("leaves out the first word of a sentence or a line, and of a list item", () => {
    expect(
      words("Avery came in. Then Blake left.\nCarol stayed.\n- Dana\n2. Erin"),
    ).toEqual(["Blake"]);
  });

  it("still looks at a word after a label or after Dr.", () => {
    expect(words("Referred by: Patel. Seen by Dr. Quinn.")).toEqual([
      "Patel",
      "Quinn",
    ]);
  });

  it("leaves out known medical and eponym words, days and months", () => {
    expect(
      words(
        "She has Parkinson disease, takes Ramipril, and came on Monday in March.",
      ),
    ).toEqual([]);
  });

  it("leaves out upper-case abbreviations and single capitals", () => {
    expect(words("The ECG and DOB were checked by I and the NP.")).toEqual([]);
  });

  it("flags a number of three or more digits, not a short one", () => {
    expect(words("Dose 5 mg, room 214, chart 8675309, age 42.")).toEqual([
      "214",
      "8675309",
    ]);
  });

  it("leaves out placeholders and marked removals", () => {
    const text = "Seen by [DOCTOR 1] for Avery on [DATE 1].";
    const removed: Removed[] = [
      {
        kind: "doctor",
        original: "FAKE",
        replacement: "[DOCTOR 1]",
        start: 0,
        end: 4,
        sentStart: 8,
        sentEnd: 18,
      },
    ];
    expect(words(text, removed)).toEqual(["Avery"]);
    // The placeholder's own letters, inside a removed span, are never offered.
    expect(
      wordsToCheck(text, removed).every(
        (found) => found.end <= 8 || found.start >= 18,
      ),
    ).toBe(true);
  });

  it("leaves out words already offered as possible names", () => {
    const text = "He lives with Avery.";
    expect(wordsToCheck(text, [], [{ sentStart: 14, sentEnd: 19 }])).toEqual(
      [],
    );
  });

  it("gives the offsets the preview removes by", () => {
    const text = "Saw Avery.";
    const [found] = wordsToCheck(text, []);
    expect(text.slice(found.start, found.end)).toBe("Avery");
  });
});

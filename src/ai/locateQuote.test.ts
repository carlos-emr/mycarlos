import { describe, expect, it } from "vitest";
import { fakeDocumentText } from "../test/fakeLocalModel";
import { locateQuote } from "./locateQuote";

// FAKE documents only.
const page0 =
  "SYNTHETIC TEST DOCUMENT - FAKE DATA ONLY\nExam: CT chest with contrast";
const page1 =
  "Findings: A 6 mm nodule in the right upper lobe,\nunchanged since March 3, 2025.\nNo new consolidation. Heart size normal.";
const document = fakeDocumentText([page0, "", page1]);

function quoted(span: ReturnType<typeof locateQuote>) {
  expect(span).not.toBeNull();
  return document.pages[span!.page].text.slice(span!.start, span!.end);
}

describe("locateQuote", () => {
  it("finds an exact quote on its own page, with the page's offsets", () => {
    const span = locateQuote(document, "No new consolidation.");
    expect(span).toEqual({
      page: 2,
      start: page1.indexOf("No new"),
      // The full stop is a model's to keep or drop, so it is not part of the match.
      end: page1.indexOf("No new") + "No new consolidation".length,
    });
  });

  it("matches across a line break, in another case, without the full stop", () => {
    const span = locateQuote(
      document,
      "a 6 MM nodule in the right upper lobe, unchanged since march 3, 2025",
    );
    expect(quoted(span)).toBe(
      "A 6 mm nodule in the right upper lobe,\nunchanged since March 3, 2025",
    );
  });

  it("treats curly and straight quotes alike", () => {
    const doc = fakeDocumentText(["The patient’s heart size is normal."]);
    const span = locateQuote(doc, "patient's heart size");
    expect(span).toEqual({ page: 0, start: 4, end: 24 });
  });

  it("matches each part of a quote with an ellipsis, in order, on one page", () => {
    const span = locateQuote(
      document,
      "Findings: A 6 mm nodule … Heart size normal",
    );
    expect(quoted(span)).toBe(page1.slice(0, page1.indexOf(" normal") + 7));
    expect(locateQuote(document, "Heart size normal ... Findings")).toBeNull();
  });

  it("gives null for words that are not in the document, or too short", () => {
    expect(locateQuote(document, "No evidence of malignancy")).toBeNull();
    expect(locateQuote(document, "CT")).toBeNull();
    expect(locateQuote(document, "  ...  ")).toBeNull();
  });

  it("refuses a quote too short to mean one place: under 12 characters and 3 words", () => {
    // "mm" and "the" are on the page, but a link to them would say nothing.
    expect(locateQuote(document, "mm")).toBeNull();
    expect(locateQuote(document, "the right")).toBeNull();
    expect(locateQuote(document, "6 mm ... the")).toBeNull();
    // Three words, or twelve characters, is enough; so is one part of each.
    expect(locateQuote(document, "a 6 mm")).not.toBeNull();
    expect(locateQuote(document, "consolidation")).not.toBeNull();
    expect(
      locateQuote(document, "Findings: A 6 mm nodule ... Heart size normal"),
    ).not.toBeNull();
  });

  it("keeps the page's own offsets around characters outside the BMP and case changes", () => {
    const text = "\u{1D465} İstanbul clinic: 6 mm nodule";
    const doc = fakeDocumentText([text]);
    const span = locateQuote(doc, "istanbul clinic");
    expect(span).not.toBeNull();
    expect(text.slice(span!.start, span!.end)).toBe("İstanbul clinic");
    const nodule = locateQuote(doc, "6 mm nodule");
    expect(text.slice(nodule!.start, nodule!.end)).toBe("6 mm nodule");
  });

  it("ignores accents a model dropped", () => {
    const doc = fakeDocumentText([
      "Écho cardiaque : fraction d’éjection à 35 %.",
    ]);
    const span = locateQuote(doc, "fraction d'ejection a 35 %");
    expect(doc.pages[0].text.slice(span!.start, span!.end)).toBe(
      "fraction d’éjection à 35 %",
    );
  });

  it("finds Chinese and full-width text", () => {
    const text = "检查：胸部CT。右上肺６毫米结节，与２０２５年相比无变化。";
    const doc = fakeDocumentText([text]);
    const span = locateQuote(doc, "右上肺6毫米结节");
    expect(text.slice(span!.start, span!.end)).toBe("右上肺６毫米结节");
    // Each Chinese character counts as a word: three are enough, two are not.
    expect(locateQuote(doc, "无变化")).not.toBeNull();
    expect(locateQuote(doc, "结节")).toBeNull();
  });

  it("skips pages with no text", () => {
    const doc = fakeDocumentText(["", "Heart size normal."]);
    expect(locateQuote(doc, "Heart size normal")?.page).toBe(1);
  });
});

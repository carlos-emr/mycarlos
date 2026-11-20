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

  // A FAKE letter as a PDF's text layer gives it: ligature characters (U+FB01,
  // U+FB03), a comma at the start of a wrapped line, a micro sign (U+00B5), and
  // the Bloods line before the Diagnosis line. quote_locate.rs (the Rust
  // runner's gate) has the same cases.
  const pdfLetter = fakeDocumentText([
    "Bloods (3 November 2026): hemoglobin 101 g/L, ferritin 5 \u{b5}g/L\n" +
      "Diagnosis\nCeliac disease, con\u{fb01}rmed by biopsy\n" +
      ", with iron de\u{fb01}ciency anemia\n" +
      "Referral to our clinic dietitian, Robin FAKE-Dietwell; " +
      "the dietitian's o\u{fb03}ce\nwill call within 2\nweeks.",
  ]);
  const pdfText = pdfLetter.pages[0].text;
  const pdfQuoted = (quote: string) => {
    const span = locateQuote(pdfLetter, quote);
    expect(span, quote).not.toBeNull();
    return pdfText.slice(span!.start, span!.end);
  };

  it("finds quotes typed with letters where the PDF has ligatures, and the other way", () => {
    expect(pdfQuoted("iron deficiency anemia")).toBe(
      "iron de\u{fb01}ciency anemia",
    );
    expect(pdfQuoted("the dietitian's office will call within 2 weeks")).toBe(
      "the dietitian's o\u{fb03}ce\nwill call within 2\nweeks",
    );
    const plain = fakeDocumentText(["Celiac disease, confirmed by biopsy."]);
    expect(
      locateQuote(plain, "Celiac disease, con\u{fb01}rmed by biopsy"),
    ).not.toBeNull();
  });

  it("treats the micro sign and the Greek mu as one letter, and curly and straight apostrophes alike", () => {
    expect(pdfQuoted("ferritin 5 \u{3bc}g/L")).toBe("ferritin 5 \u{b5}g/L");
    expect(pdfQuoted("the dietitian\u{2019}s office will call")).toBe(
      "the dietitian's o\u{fb03}ce\nwill call",
    );
  });

  it("drops a space before a comma on both sides", () => {
    expect(
      pdfQuoted("Celiac disease, confirmed by biopsy, with iron deficiency"),
    ).toBe(
      "Celiac disease, con\u{fb01}rmed by biopsy\n, with iron de\u{fb01}ciency",
    );
    // A model that copies the stray space is found as well.
    expect(
      pdfQuoted("Celiac disease, confirmed by biopsy , with iron deficiency"),
    ).toContain("biopsy\n, with");
  });

  it("finds a quote of parts joined by dots in order, and not out of order", () => {
    expect(
      locateQuote(
        pdfLetter,
        "hemoglobin 101 g/L, ferritin 5 \u{3bc}g/L ... Celiac disease, confirmed by biopsy",
      ),
    ).not.toBeNull();
    // The Bloods line comes first in this letter.
    expect(
      locateQuote(
        pdfLetter,
        "Celiac disease, confirmed by biopsy ... hemoglobin 101 g/L, ferritin 5 \u{3bc}g/L",
      ),
    ).toBeNull();
  });

  it("finds a quote over two lines only when nothing but white space is between them", () => {
    expect(
      locateQuote(pdfLetter, "Diagnosis Celiac disease, confirmed by biopsy"),
    ).not.toBeNull();
    expect(
      locateQuote(pdfLetter, "Bloods (3 November 2026) Celiac disease"),
    ).toBeNull();
  });

  it("does not find words the letter does not have", () => {
    expect(
      locateQuote(
        pdfLetter,
        "the dietitian's office will phone within 2 weeks",
      ),
    ).toBeNull();
    expect(
      locateQuote(pdfLetter, "Celiac disease, confirmed by colonoscopy"),
    ).toBeNull();
  });

  it("skips pages with no text", () => {
    const doc = fakeDocumentText(["", "Heart size normal."]);
    expect(locateQuote(doc, "Heart size normal")?.page).toBe(1);
  });
});

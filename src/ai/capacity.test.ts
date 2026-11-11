import { describe, expect, it } from "vitest";
import { fakeDocumentText } from "../test/fakeLocalModel";
import {
  BYTES_PER_TOKEN,
  capacityInPages,
  estimateFit,
  estimateTokens,
  preTokenCount,
  WORD_BYTES_PER_TOKEN,
} from "./capacity";
import counted from "./fixtures/qwen35-token-counts.json";

// The helper's room for a catalogue model today (local_model.rs Capacity::HELPER).
const HELPER = { contextTokens: 8192, documentTokens: 6510 };

describe("estimateTokens", () => {
  it("counts plain words at 4 bytes a token, never less than one a word", () => {
    expect(WORD_BYTES_PER_TOKEN.plain).toBe(4);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(4000))).toBe(1000);
    // "The", " patient" (2), " is", " well" (1.25), ".": 6.25, rounded up.
    expect(estimateTokens("The patient is well.")).toBe(7);
  });

  it("counts words in capitals, with accents or in Chinese at more tokens a byte", () => {
    // Capitals at 1.75 bytes: "ALT" (1.71) and " TSH" (2.29).
    expect(estimateTokens("ALT TSH")).toBe(4);
    // é and ł are 2 bytes each in UTF-8, at 2 bytes a token.
    expect(estimateTokens("éé")).toBe(2);
    expect(estimateTokens("łódź")).toBe(4);
    // 血 and 液 are 3 bytes each, at 3 bytes a token: about one a character.
    expect(estimateTokens("血液")).toBe(2);
  });

  it("counts every digit, space run and sign as a token, as the Qwen3.5 tokenizer cuts them", () => {
    expect(estimateTokens("12345")).toBe(5);
    expect(estimateTokens("\n\n")).toBe(1);
    // "Hb", " ", "1", "3", ".", "5", " g", "/L"
    expect(preTokenCount("Hb 13.5 g/L")).toBe(8);
    expect(estimateTokens("Hb 13.5 g/L")).toBe(8);
  });

  it("never counts a text below its pieces, which the model never merges", () => {
    const row = "FAKE Hemoglobin 135 g/L 120-160 2026-11-10\n";
    expect(preTokenCount(row)).toBe(28);
    // "FAKE" in capitals (2.29) and " Hemoglobin" (2.75), then 26 one-token
    // pieces: 31.04.
    expect(estimateTokens(row)).toBe(32);
    for (const text of counted.texts)
      expect(estimateTokens(text.text), text.name).toBeGreaterThanOrEqual(
        preTokenCount(text.text),
      );
  });

  // Real counts (fixtures/qwen35-token-counts.json): five of the evaluation
  // run's FAKE documents, by the prompt tokens the helper reported less the
  // request's 320, and three texts counted offline with llama.cpp's QWEN35
  // pieces and the model's own vocabulary.
  it.each(counted.texts.map((text) => [text.name, text] as const))(
    "counts %s at least as high as the model does, and not far higher",
    (_name, text) => {
      const estimate = estimateTokens(text.text);
      expect(estimate).toBeGreaterThanOrEqual(Math.ceil(text.tokens * 1.03));
      expect(estimate).toBeLessThanOrEqual(Math.ceil(text.tokens * 1.5));
    },
  );
});

describe("capacityInPages", () => {
  it("says the helper's room as about 6 pages and 19,000 characters, rounded down", () => {
    // 6,510 tokens at 3 bytes: 19,530 bytes; pages of 3,000 characters.
    expect(BYTES_PER_TOKEN).toBe(3);
    expect(capacityInPages(HELPER)).toEqual({ pages: 6, characters: 19_000 });
  });

  it("never says fewer than one page", () => {
    expect(
      capacityInPages({ contextTokens: 512, documentTokens: 100 }),
    ).toEqual({ pages: 1, characters: 0 });
  });
});

describe("estimateFit", () => {
  // 1,000 tokens a page; the separator between pages costs one more.
  const page = "a".repeat(4000);

  it("fits a document whose pages all fit, the separators included", () => {
    expect(
      estimateFit(fakeDocumentText([page, page]), {
        contextTokens: 8192,
        documentTokens: 2001,
      }),
    ).toEqual({ fits: true });
  });

  it("reads whole pages from the first while they fit", () => {
    expect(
      estimateFit(fakeDocumentText([page, page, page, page]), {
        contextTokens: 8192,
        documentTokens: 2500,
      }),
    ).toEqual({ fits: false, lastPage: 2, firstPageCut: false, pageCount: 4 });
  });

  it("reads only the start of a first page too long on its own", () => {
    expect(
      estimateFit(fakeDocumentText([page + page, page]), {
        contextTokens: 8192,
        documentTokens: 1500,
      }),
    ).toEqual({ fits: false, lastPage: 1, firstPageCut: true, pageCount: 2 });
  });

  it("counts empty pages (scans) as the separator only, as the helper does", () => {
    expect(
      estimateFit(fakeDocumentText([page, "", "", page]), {
        contextTokens: 8192,
        documentTokens: 2003,
      }),
    ).toEqual({ fits: true });
    expect(
      estimateFit(fakeDocumentText([page, "", "", page]), {
        contextTokens: 8192,
        documentTokens: 2002,
      }),
    ).toEqual({ fits: false, lastPage: 3, firstPageCut: false, pageCount: 4 });
  });

  it("does not fit a document whose later pages the reader could not collect", () => {
    expect(
      estimateFit(fakeDocumentText(["FAKE short page"], true), HELPER),
    ).toEqual({ fits: false, lastPage: 1, firstPageCut: false, pageCount: 1 });
  });

  it("fits a short letter and not a long report with the helper's room", () => {
    const letter = fakeDocumentText(["FAKE letter text. ".repeat(150)]);
    expect(estimateFit(letter, HELPER)).toEqual({ fits: true });
    // A table of results: 40 rows of figures a page, 12 pages.
    const row = "FAKE Hemoglobin 135 g/L 120-160 2026-11-10\n";
    const report = fakeDocumentText(Array(12).fill(row.repeat(40)));
    const fit = estimateFit(report, HELPER);
    expect(fit.fits).toBe(false);
    expect(fit.fits === false && fit.lastPage).toBeLessThan(12);
  });
});

import { describe, expect, it } from "vitest";
import { fakeDocumentText } from "../test/fakeLocalModel";
import {
  BYTES_PER_TOKEN,
  capacityInPages,
  estimateFit,
  estimateTokens,
} from "./capacity";

// The helper's room for a catalogue model today (local_model.rs Capacity::HELPER).
const HELPER = { contextTokens: 8192, documentTokens: 6510 };

describe("estimateTokens", () => {
  it("counts a token for every 3 bytes of text, rounded up", () => {
    expect(BYTES_PER_TOKEN).toBe(3);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("a".repeat(3000))).toBe(1000);
  });

  it("counts accented and Chinese letters by their UTF-8 bytes", () => {
    // é and ł are 2 bytes each, 血 and 液 3 each.
    expect(estimateTokens("éé")).toBe(2);
    expect(estimateTokens("łódź")).toBe(3);
    expect(estimateTokens("血液")).toBe(2);
  });

  it("counts every digit as a token, as both models' tokenizers split numbers", () => {
    expect(estimateTokens("12345")).toBe(5);
    // 3 digits, and "Hb ", "." and " g/L" (8 bytes) at 3 a token.
    expect(estimateTokens("Hb 13.5 g/L")).toBe(3 + 3);
  });
});

describe("capacityInPages", () => {
  it("says the helper's room as about 6 pages and 19,000 characters, rounded down", () => {
    // 6,510 tokens at 3 bytes: 19,530 bytes; pages of 3,000 characters.
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
  const page = "a".repeat(3000);

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

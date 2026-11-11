import { describe, expect, it } from "vitest";
import { fakeDocumentText } from "../test/fakeLocalModel";
import {
  BYTES_PER_TOKEN,
  SUMMARY_PROMPT_TOKENS,
  capacityInPages,
  documentTokens,
  estimateFit,
  estimateTokens,
  planWindow,
  preTokenCount,
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
  });

  it("counts a text at least at the pieces the Qwen3.5 tokenizer cuts it into", () => {
    // llama.cpp's QWEN35 pre-tokenizer: words with their leading space, each
    // digit, a space before a number, and runs of signs, each a piece.
    expect(preTokenCount("The patient is well.")).toBe(5);
    // "Hb", " ", "1", "3", ".", "5", " g", "/L"
    expect(preTokenCount("Hb 13.5 g/L")).toBe(8);
    // Prose: its bytes count higher (20 bytes, 7 tokens), and win.
    expect(estimateTokens("The patient is well.")).toBe(7);
    // Results: the pieces count higher than the bytes (3 digits + 3), and win.
    expect(estimateTokens("Hb 13.5 g/L")).toBe(8);
  });

  it("never counts a table of results below its pieces, which the model never merges", () => {
    // By bytes: 17 digits + 26 other bytes at 3 a token = 26 tokens. By
    // pieces: 28, since the space before each number and each "-" and "/"
    // between figures is a piece of its own.
    const row = "FAKE Hemoglobin 135 g/L 120-160 2026-11-10\n";
    expect(preTokenCount(row)).toBe(28);
    expect(estimateTokens(row)).toBe(28);
    const table = row.repeat(40);
    expect(preTokenCount(table)).toBe(1120);
    expect(estimateTokens(table)).toBeGreaterThanOrEqual(preTokenCount(table));
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

describe("planWindow (D249)", () => {
  // Five FAKE pages of 1,051 tokens: 5,255 and 4 separators.
  const pages = Array.from(
    { length: 5 },
    (_, index) => "FAKE long page text. ".repeat(150) + index,
  );
  const document = fakeDocumentText(pages);
  const size = (contextTokens: number, documentTokens: number) => ({
    contextTokens,
    documentTokens,
  });
  const sizes = [size(8192, 2200), size(12288, 6000), size(16384, 9000)];

  it("counts the pages and their separators as estimateFit does", () => {
    expect(documentTokens(document)).toBe(5 * 1051 + 4);
    expect(documentTokens(fakeDocumentText([]))).toBe(0);
  });

  it("takes the smallest window that holds the document, as memory allows", () => {
    const plan = planWindow(document, { sizes, memoryAllows: 32768 })!;
    expect(plan.window).toEqual(size(12288, 6000));
    expect(plan.fit).toEqual({ fits: true });
    expect(plan.memoryLimited).toBe(false);
    expect(plan.promptTokens).toBe(5259 + SUMMARY_PROMPT_TOKENS);
    // In any order.
    expect(
      planWindow(document, {
        sizes: [...sizes].reverse(),
        memoryAllows: 32768,
      })!.window,
    ).toEqual(size(12288, 6000));
  });

  it("takes the largest when none holds it, and says the pages that fit", () => {
    const plan = planWindow(document, {
      sizes: [size(8192, 2200), size(12288, 3200)],
      memoryAllows: 32768,
    })!;
    expect(plan.window).toEqual(size(12288, 3200));
    expect(plan.fit).toMatchObject({ fits: false, lastPage: 3 });
    expect(plan.memoryLimited).toBe(false);
    expect(plan.promptTokens).toBe(3200 + SUMMARY_PROMPT_TOKENS);
  });

  it("steps down to what free memory allows, and says memory set the limit", () => {
    const plan = planWindow(document, { sizes, memoryAllows: 8192 })!;
    expect(plan.window).toEqual(size(8192, 2200));
    expect(plan.fit).toMatchObject({ fits: false, lastPage: 2 });
    expect(plan.memoryLimited).toBe(true);
    // Memory between two windows: the smaller.
    expect(
      planWindow(document, { sizes, memoryAllows: 16000 })!.window,
    ).toEqual(size(12288, 6000));
  });

  it("plans nothing without a window", () => {
    expect(planWindow(document, { sizes: [], memoryAllows: 32768 })).toBeNull();
  });
});

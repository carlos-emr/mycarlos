import { describe, expect, it, vi } from "vitest";
import { keptSources, keptSummary, parseKeptSummary } from "./kept";
import type { ExplainResult, SummaryResult } from "./types";

const summary: SummaryResult = {
  tool: "summary",
  sentences: [
    {
      text: "FAKE one.",
      quote: "FAKE one",
      source: { page: 0, start: 1, end: 9 },
    },
    { text: "FAKE two.", quote: "nowhere", source: null },
  ],
  model: { name: "FAKE model", sha256: "ab".repeat(32) },
  lang: "fr",
  createdAt: 1700000000000,
  partial: false,
  lastPage: 2,
  pagesMissing: false,
};

describe("answers kept with the document", () => {
  it("reads back a kept summary exactly, and nothing that is not one", () => {
    expect(parseKeptSummary(JSON.stringify(summary))).toEqual(summary);
    expect(parseKeptSummary("not json")).toBeNull();
    expect(parseKeptSummary("null")).toBeNull();
    expect(
      parseKeptSummary(JSON.stringify({ ...summary, tool: "explain" })),
    ).toBeNull();
    expect(
      parseKeptSummary(
        JSON.stringify({
          ...summary,
          sentences: [{ text: 1, quote: "q", source: null }],
        }),
      ),
    ).toBeNull();
    expect(
      parseKeptSummary(
        JSON.stringify({
          ...summary,
          sentences: [
            { text: "t", quote: "q", source: { page: "0", start: 1, end: 2 } },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseKeptSummary(JSON.stringify({ ...summary, model: { name: "x" } })),
    ).toBeNull();
    // A summary kept without the page facts is not shown as complete.
    const { lastPage: _page, ...withoutPages } = summary;
    expect(parseKeptSummary(JSON.stringify(withoutPages))).toBeNull();
  });

  it("reads a parent-valid 64 KiB legacy summary without applying new admission reserves", () => {
    const legacy: SummaryResult = {
      ...summary,
      lang: "en",
      sentences: Array.from({ length: 20 }, () => ({
        text: "\u0001".repeat(300),
        quote: "\u0001".repeat(240),
        source: null,
      })),
    };
    legacy.sentences[19].text = "a".repeat(46) + "\u0001".repeat(254);
    const text = JSON.stringify(legacy);
    // This fixture's JSON is entirely ASCII, including its escaped controls.
    expect(text.length).toBe(65536);
    expect(parseKeptSummary(text)).toEqual(legacy);
  });

  it("keeps a sentence of a kept summary but drops a place that cannot be one", () => {
    const kept = (source: unknown) =>
      JSON.stringify({
        tool: "summary",
        sentences: [{ text: "FAKE sentence.", quote: "FAKE", source }],
        model: { name: "FAKE model", sha256: "ab".repeat(32) },
        lang: "en",
        createdAt: 1,
        partial: false,
        lastPage: 1,
        pagesMissing: false,
      });
    for (const source of [
      { page: -1, start: 0, end: 4 },
      { page: 0.5, start: 0, end: 4 },
      { page: 0, start: 5, end: 4 },
      { page: 0, start: -2, end: 4 },
    ])
      expect(
        parseKeptSummary(kept(source))?.sentences[0],
        JSON.stringify(source),
      ).toEqual({
        text: "FAKE sentence.",
        quote: "FAKE",
        source: null,
      });
    expect(
      parseKeptSummary(kept({ page: 0, start: 0, end: 4 }))?.sentences[0]
        .source,
    ).toEqual({
      page: 0,
      start: 0,
      end: 4,
    });
  });

  it("gives the vault only a summary's source places: the words are the native side's", () => {
    expect(keptSources(summary)).toEqual(
      summary.sentences.map((sentence) => sentence.source),
    );
    const explained: ExplainResult = {
      tool: "explain",
      term: "eGFR",
      context: "FAKE eGFR 85.",
      text: "FAKE: how well the kidneys filter.",
      model: summary.model,
      lang: "en",
      createdAt: 2,
    };
    expect(keptSources(explained)).toBeUndefined();
  });

  it("finds the kept summary in the asked language, or none", async () => {
    const info = (tool: "summary" | "explain", lang: string, id: string) => ({
      id,
      tool,
      lang,
      modelName: "FAKE model",
      modelSha256: "ab".repeat(32),
      createdAtMs: 1,
      size: 10,
    });
    const kept = {
      list: vi
        .fn()
        .mockResolvedValue([
          info("explain", "fr", "e1"),
          info("summary", "fr", "s1"),
        ]),
      read: vi.fn().mockResolvedValue(JSON.stringify(summary)),
      save: vi.fn(),
      recordId: "FAKE-record",
    };
    expect(await keptSummary(kept, "fr")).toEqual(summary);
    expect(kept.read).toHaveBeenCalledWith("s1");
    expect(await keptSummary(kept, "en")).toBeNull();
    kept.read.mockResolvedValueOnce("damaged");
    expect(await keptSummary(kept, "fr")).toBeNull();
  });
});

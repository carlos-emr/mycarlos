import { describe, expect, it, vi } from "vitest";
import { keptInput, keptSummary, parseKeptSummary } from "./kept";
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
  });

  it("tells the vault the tool, language, term and model of an answer", () => {
    expect(keptInput(summary)).toEqual({
      tool: "summary",
      lang: "fr",
      modelName: "FAKE model",
      modelSha256: "ab".repeat(32),
    });
    const explained: ExplainResult = {
      tool: "explain",
      term: "eGFR",
      context: "FAKE eGFR 85.",
      text: "FAKE: how well the kidneys filter.",
      model: summary.model,
      lang: "en",
      createdAt: 2,
    };
    expect(keptInput(explained)).toEqual({
      tool: "explain",
      lang: "en",
      term: "eGFR",
      modelName: "FAKE model",
      modelSha256: "ab".repeat(32),
    });
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
    };
    expect(await keptSummary(kept, "fr")).toEqual(summary);
    expect(kept.read).toHaveBeenCalledWith("s1");
    expect(await keptSummary(kept, "en")).toBeNull();
    kept.read.mockResolvedValueOnce("damaged");
    expect(await keptSummary(kept, "fr")).toBeNull();
  });
});

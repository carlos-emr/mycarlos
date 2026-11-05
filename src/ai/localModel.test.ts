import { describe, expect, it, vi } from "vitest";
import {
  FAKE_MODEL,
  fakeDocumentText,
  fakeLocalModel,
} from "../test/fakeLocalModel";
import {
  explainTerm,
  modelRunsHere,
  nativeLocalModel,
  notInstalledModel,
  summarizeDocument,
  type ModelBridge,
} from "./localModel";
import { ModelCancelled, ModelNotInstalled, type ModelStatus } from "./types";

// FAKE documents only.
const document = fakeDocumentText(
  [
    "SYNTHETIC TEST DOCUMENT - FAKE DATA ONLY\nPotassium 5.4 mmol/L (high).",
    "",
    "Repeat in 2 weeks.",
  ],
  true,
);

describe("notInstalledModel", () => {
  it("says no model is installed and refuses work", async () => {
    await expect(notInstalledModel.status()).resolves.toEqual({
      state: "notInstalled",
    });
    await expect(
      summarizeDocument(notInstalledModel, document, "en"),
    ).rejects.toBeInstanceOf(ModelNotInstalled);
    await expect(
      explainTerm(notInstalledModel, "potassium", "", "en"),
    ).rejects.toBeInstanceOf(ModelNotInstalled);
  });
});

describe("summarizeDocument", () => {
  it("links each sentence whose quote is in the document, and never guesses one", async () => {
    const model = fakeLocalModel({
      sentences: () => [
        {
          text: "Your potassium is a little high.",
          quote: "Potassium 5.4 mmol/L (high)",
        },
        { text: "Repeat the test in two weeks.", quote: "Repeat in 2 weeks." },
        {
          text: "Something the document never says.",
          quote: "No evidence of malignancy",
        },
      ],
    });
    const result = await summarizeDocument(model, document, "fr", () => 1234);
    expect(result).toMatchObject({
      tool: "summary",
      model: FAKE_MODEL,
      lang: "fr",
      createdAt: 1234,
      partial: true,
      // Three pages read (the empty one counts), the last being page 3.
      lastPage: 3,
      pagesMissing: true,
    });
    expect(result.sentences.map((s) => s.source)).toEqual([
      { page: 0, start: 41, end: 68 },
      { page: 2, start: 0, end: 17 },
      null,
    ]);
    expect(model.calls).toEqual([
      { tool: "summary", lang: "fr", input: document.joined },
    ]);
  });

  it("by default the fake quotes each page's first line, which is found", async () => {
    const result = await summarizeDocument(fakeLocalModel(), document, "en");
    expect(result.sentences).toHaveLength(2);
    expect(result.sentences.every((s) => s.source !== null)).toBe(true);
  });
});

describe("explainTerm", () => {
  it("keeps the term, its sentence and the model with the explanation", async () => {
    const model = fakeLocalModel({ explanation: "FAKE: a salt in the blood." });
    await expect(
      explainTerm(
        model,
        "potassium",
        "Potassium 5.4 mmol/L (high).",
        "pl",
        () => 99,
      ),
    ).resolves.toEqual({
      tool: "explain",
      term: "potassium",
      context: "Potassium 5.4 mmol/L (high).",
      text: "FAKE: a salt in the blood.",
      model: FAKE_MODEL,
      lang: "pl",
      createdAt: 99,
    });
  });
});

describe("how much of the document a summary covers", () => {
  // Three pages, all read by the reader; the model says how far it got.
  const whole = fakeDocumentText(["FAKE one.", "FAKE two.", "FAKE three."]);

  it("is all of it when the model read every page", async () => {
    const result = await summarizeDocument(fakeLocalModel(), whole, "en");
    expect(result).toMatchObject({ partial: false, lastPage: 3 });
  });

  it("stops at the last page the model had room for", async () => {
    const model = fakeLocalModel({ lastPage: () => 1 });
    const result = await summarizeDocument(model, whole, "en");
    expect(result).toMatchObject({ partial: true, lastPage: 2 });
  });

  it("is only the start when the first page alone did not fit", async () => {
    const model = fakeLocalModel({ lastPage: () => 0, lastPageCut: true });
    const result = await summarizeDocument(model, whole, "en");
    expect(result).toMatchObject({ partial: true, lastPage: 1 });
  });

  it("is short when the reader's caps left pages out, though the model read all it got", async () => {
    const cut = fakeDocumentText(["FAKE one.", "FAKE two."], true);
    const result = await summarizeDocument(fakeLocalModel(), cut, "en");
    expect(result).toMatchObject({ partial: true, lastPage: 2 });
  });

  it("numbers the last page by its page, not by the count, when a page failed", async () => {
    const failed = fakeDocumentText(
      ["FAKE one.", "FAKE two.", "FAKE three."],
      false,
      {
        failedPages: [1],
      },
    );
    const result = await summarizeDocument(fakeLocalModel(), failed, "en");
    expect(result).toMatchObject({ partial: false, lastPage: 3 });
  });
});

describe("nativeLocalModel", () => {
  const refusal = (code: string) => ({
    code,
    message: "FAKE",
    messageKey: "ai.failed",
  });
  const bridge = (overrides: Partial<ModelBridge> = {}): ModelBridge => ({
    aiModelStatus: vi
      .fn()
      .mockResolvedValue({ state: "installed", model: FAKE_MODEL }),
    aiSummarize: vi.fn().mockResolvedValue({
      sentences: [{ text: "FAKE summary.", quote: "Repeat in 2 weeks." }],
      model: FAKE_MODEL,
      lastPage: 2,
      lastPageCut: false,
    }),
    aiExplain: vi
      .fn()
      .mockResolvedValue({ text: "FAKE explanation.", model: FAKE_MODEL }),
    aiCancel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  it("sends the pages as read and the language, and keeps the model's answer", async () => {
    const native = bridge();
    const result = await summarizeDocument(
      nativeLocalModel(native),
      document,
      "fr",
    );
    expect(native.aiSummarize).toHaveBeenCalledWith(document.pages, "fr");
    expect(result.sentences).toEqual([
      {
        text: "FAKE summary.",
        quote: "Repeat in 2 weeks.",
        source: { page: 2, start: 0, end: 17 },
      },
    ]);
    expect(result).toMatchObject({
      model: FAKE_MODEL,
      lastPage: 3,
      partial: true,
    });
  });

  it("sends a term with its sentence and the language", async () => {
    const native = bridge();
    await expect(
      explainTerm(
        nativeLocalModel(native),
        "potassium",
        "Potassium 5.4.",
        "es",
      ),
    ).resolves.toMatchObject({ text: "FAKE explanation.", model: FAKE_MODEL });
    expect(native.aiExplain).toHaveBeenCalledWith(
      "potassium",
      "Potassium 5.4.",
      "es",
    );
  });

  it.each(["aiNotInstalled", "aiDamaged"])(
    "reads %s as no model, for both tools",
    async (code) => {
      const model = nativeLocalModel(
        bridge({
          aiSummarize: vi.fn().mockRejectedValue(refusal(code)),
          aiExplain: vi.fn().mockRejectedValue(refusal(code)),
        }),
      );
      await expect(
        summarizeDocument(model, document, "en"),
      ).rejects.toBeInstanceOf(ModelNotInstalled);
      await expect(explainTerm(model, "term", "", "en")).rejects.toBeInstanceOf(
        ModelNotInstalled,
      );
    },
  );

  it("reads a stopped answer as cancelled", async () => {
    const model = nativeLocalModel(
      bridge({
        aiSummarize: vi.fn().mockRejectedValue(refusal("aiCancelled")),
      }),
    );
    await expect(
      summarizeDocument(model, document, "en"),
    ).rejects.toBeInstanceOf(ModelCancelled);
  });

  it.each(["aiMemory", "aiBusy", "aiFailed"])(
    "passes %s on as it is",
    async (code) => {
      const failure = refusal(code);
      const model = nativeLocalModel(
        bridge({ aiExplain: vi.fn().mockRejectedValue(failure) }),
      );
      await expect(explainTerm(model, "term", "", "en")).rejects.toBe(failure);
    },
  );

  it("asks the native side to stop, and a failed stop is not thrown", async () => {
    const native = bridge({
      aiCancel: vi.fn().mockRejectedValue(refusal("aiFailed")),
    });
    expect(() => nativeLocalModel(native).cancel()).not.toThrow();
    expect(native.aiCancel).toHaveBeenCalledTimes(1);
  });

  it("reports the native status as it is", async () => {
    const status: ModelStatus = { state: "unsupported", reason: "platform" };
    const native = bridge({ aiModelStatus: vi.fn().mockResolvedValue(status) });
    await expect(nativeLocalModel(native).status()).resolves.toEqual(status);
  });
});

describe("modelRunsHere", () => {
  it.each<[ModelStatus | undefined, boolean]>([
    [{ state: "notInstalled" }, true],
    [{ state: "installed", model: FAKE_MODEL }, true],
    [{ state: "damaged" }, true],
    [{ state: "unsupported", reason: "platform" }, false],
    [{ state: "unsupported", reason: "ram" }, false],
    [{ state: "unsupported", reason: "cpu" }, false],
    [undefined, false],
  ])("%j: %s", (status, runs) => {
    expect(modelRunsHere(status)).toBe(runs);
  });
});

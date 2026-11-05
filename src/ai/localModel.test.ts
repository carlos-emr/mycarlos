import { describe, expect, it } from "vitest";
import {
  FAKE_MODEL,
  fakeDocumentText,
  fakeLocalModel,
} from "../test/fakeLocalModel";
import {
  explainTerm,
  notInstalledModel,
  summarizeDocument,
} from "./localModel";
import { ModelNotInstalled } from "./types";

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

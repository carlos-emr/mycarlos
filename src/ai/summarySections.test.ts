import { describe, expect, it } from "vitest";
import { isInstruction, summarySections } from "./summarySections";

const sentence = (text: string) => ({ text, quote: "" });
const indexes = (sections: ReturnType<typeof summarySections>) =>
  sections.map(({ heading, sentences }) => [
    heading,
    sentences.map(({ index }) => index),
  ]);

describe("the summary under two headings (K3 try-out)", () => {
  it("splits a found-first summary at its first instruction, keeping the order", () => {
    const sections = summarySections(
      [
        sentence("Your potassium was 5.4 mmol/L, a little high."),
        sentence("The kidney tests were normal."),
        sentence("Repeat the potassium test in 2 weeks."),
        // After the split, a fact stays under the second heading.
        sentence("The results do not show any infection."),
      ],
      "en",
    );
    expect(indexes(sections)).toEqual([
      ["ai.summary.saysHeading", [0, 1]],
      ["ai.summary.todoHeading", [2, 3]],
    ]);
  });

  it("has the first heading only when nothing tells the patient to do anything", () => {
    const sections = summarySections(
      [
        sentence("The X-ray of your chest was normal."),
        sentence("Your check-up on 3 May was normal."),
      ],
      "en",
    );
    expect(indexes(sections)).toEqual([["ai.summary.saysHeading", [0, 1]]]);
  });

  it("has the second heading only when the first sentence is an instruction", () => {
    const sections = summarySections(
      [sentence("Take 5 mg of ramipril each morning.")],
      "en",
    );
    expect(indexes(sections)).toEqual([["ai.summary.todoHeading", [0]]]);
    expect(summarySections([], "en")).toEqual([]);
  });

  it("finds an instruction in each language: an obligation, a verb first, or if…, then a verb", () => {
    const instructions: [string, string][] = [
      ["en", "You need to book a blood test before 3 May."],
      ["en", "Take 5 mg of ramipril each morning."],
      ["en", "If the pain gets worse, call 911."],
      ["en", "Do not drive until you are seen again."],
      ["fr", "Vous devez refaire la prise de sang dans 2 semaines."],
      ["fr", "Prenez 5 mg de ramipril chaque matin."],
      ["fr", "Si la douleur augmente, appelez le 911."],
      ["es", "Debe repetir el análisis en 2 semanas."],
      ["es", "Tome 5 mg de ramipril cada mañana."],
      ["pl", "Należy powtórzyć badanie za 2 tygodnie."],
      ["pl", "Zadzwoń do przychodni, jeśli ból się nasili."],
      ["pt-BR", "Você precisa repetir o exame em 2 semanas."],
      ["pt-BR", "Tome 5 mg de ramipril todas as manhãs."],
      ["zh-CN", "请在两周后复查血钾。"],
      ["zh-TW", "請在兩週後複查血鉀。"],
    ];
    for (const [lang, text] of instructions)
      expect(isInstruction(text, lang), `${lang}: ${text}`).toBe(true);
  });

  it("does not take a fact for an instruction, in any language", () => {
    const facts: [string, string][] = [
      ["en", "The results do not show any infection."],
      ["en", "Your check-up on 3 May was normal."],
      ["en", "Follow-up imaging showed no change."],
      ["en", "Dr. FAKE signed the letter on 2 May."],
      ["fr", "Votre potassium était de 5,4 mmol/L."],
      ["es", "El potasio fue de 5,4 mmol/L."],
      ["pl", "Potas wynosił 5,4 mmol/l."],
      ["pt-BR", "O potássio foi de 5,4 mmol/L."],
      // 反应/反應 ("reaction") holds 应/應 but is no "should".
      ["zh-CN", "您对青霉素有过敏反应。"],
      ["zh-TW", "您對青黴素有過敏反應。"],
    ];
    for (const [lang, text] of facts)
      expect(isInstruction(text, lang), `${lang}: ${text}`).toBe(false);
  });

  it("reads a language it has no words for as English", () => {
    expect(isInstruction("Take one tablet daily.", "de")).toBe(true);
    expect(isInstruction("請在兩週後複查。", "zh-Hant")).toBe(true);
  });
});

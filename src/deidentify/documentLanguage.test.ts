import { describe, expect, it } from "vitest";
import { detectDocumentLanguage } from "./documentLanguage";

// SYNTHETIC/FAKE texts only.
const en =
  "The patient came to the clinic with chest pain after walking up the hill. He was seen by the doctor on call, who ordered blood tests and an ECG. The results were normal, and he has gone home with a follow-up visit in two weeks. He should take his medicines as before and come back if the pain returns.";
const fr =
  "Le patient est venu à la clinique pour une douleur thoracique. Il a été vu par le médecin de garde, qui a demandé une prise de sang et un électrocardiogramme. Les résultats sont normaux et le patient est rentré chez lui avec un rendez-vous de suivi dans deux semaines. Il doit prendre ses médicaments comme avant et revenir si la douleur revient.";
const es =
  "El paciente acudió a la clínica por un dolor en el pecho. Fue visto por el médico de guardia, que pidió un análisis de sangre y un electrocardiograma. Los resultados son normales y el paciente volvió a su casa con una cita de control en dos semanas. Debe tomar sus medicamentos como antes y volver si el dolor regresa.";
const pt =
  "O paciente veio à clínica por causa de uma dor no peito. Foi atendido pelo médico de plantão, que pediu um exame de sangue e um eletrocardiograma. Os resultados são normais e o paciente voltou para casa com uma consulta de retorno em duas semanas. Ele deve tomar os seus remédios como antes e voltar se a dor não passar.";
const pl =
  "Pacjentka została przyjęta do szpitala z powodu bólu w klatce piersiowej. Wykonano badania krwi oraz EKG, które nie wykazały zmian. Pacjentka jest w stanie dobrym i została wypisana do domu z zaleceniem kontroli w poradni za dwa tygodnie. Należy kontynuować leczenie i zgłosić się, jeżeli ból powróci do niej po wypisie.";
const zhCN =
  "患者因胸痛来医院就诊。医生进行了血液检查和心电图检查，结果显示正常。患者已出院，两周后复诊。请继续按时服药，如疼痛再次出现请及时就医。";
const zhTW =
  "患者因胸痛來醫院就診。醫生進行了血液檢查和心電圖檢查，結果顯示正常。患者已出院，兩週後複診。請繼續按時服藥，如疼痛再次出現請及時就醫。";

describe("detectDocumentLanguage (#215)", () => {
  it.each([
    ["en", en, "fr"],
    ["fr", fr, "en"],
    ["es", es, "en"],
    ["pt-BR", pt, "es"],
    ["pl", pl, "en"],
    ["zh-CN", zhCN, "zh-TW"],
    ["zh-TW", zhTW, "en"],
  ] as const)(
    "reads a %s document whatever the app's language",
    (want, text, app) => {
      expect(detectDocumentLanguage(text, app)).toEqual({
        locale: want,
        confident: true,
      });
    },
  );

  it("keeps the app's language for a short text or a table of numbers", () => {
    expect(
      detectDocumentLanguage(
        "Na 139 mmol/L K 5.3 H Cr 109 umol/L eGFR 60",
        "fr",
      ),
    ).toEqual({
      locale: "fr",
      confident: false,
    });
    expect(detectDocumentLanguage("Seen today.", "pl")).toEqual({
      locale: "pl",
      confident: false,
    });
    expect(detectDocumentLanguage("", "es")).toEqual({
      locale: "es",
      confident: false,
    });
  });

  it("picks the dominant language of a mixed document", () => {
    const mixed = `${fr} ${fr} Hemoglobin 131 g/L, potassium 4.1 mmol/L, the result is normal.`;
    expect(detectDocumentLanguage(mixed, "en").locale).toBe("fr");
  });

  it("is not sure when two languages are as strong as each other", () => {
    expect(detectDocumentLanguage(`${en} ${fr}`, "pl")).toEqual({
      locale: "pl",
      confident: false,
    });
  });

  it("keeps the app's Chinese, or zh-CN, when the characters fit both scripts", () => {
    const shared = "患者因胸痛就诊。"; // no one-form characters but 诊
    expect(detectDocumentLanguage(shared, "zh-TW")).toEqual({
      locale: "zh-TW",
      confident: false,
    });
    expect(detectDocumentLanguage(shared, "en")).toEqual({
      locale: "zh-CN",
      confident: false,
    });
  });

  it("has no character in both script tables", async () => {
    const source = (await import("./documentLanguage.ts?raw"))
      .default as string;
    const simplified =
      /SIMPLIFIED_ONLY = new Set\(\s*"([^"]+)"/u.exec(source)?.[1] ?? "";
    const traditional =
      /TRADITIONAL_ONLY = new Set\(\s*"([^"]+)"/u.exec(source)?.[1] ?? "";
    expect(simplified.length).toBeGreaterThan(200);
    expect(
      [...simplified].filter((character) => traditional.includes(character)),
    ).toEqual([]);
  });
});

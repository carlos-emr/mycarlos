import { describe, expect, it } from "vitest";
import { deidentify, restore } from "./deidentify";

// Identifier shapes the fresh24 scoring found left in place (Q11 memo, option 1):
// a social insurance number whose groups are joined with points, as French
// documents write it, and record-number labels in both languages. FAKE values.
const out = (text: string) =>
  deidentify(text, { knownNames: [], dateShiftDays: 0 });
const sent = (text: string) => out(text).toSend;

describe("social insurance numbers with pointed groups", () => {
  it("removes a labelled number whose groups are joined with points", () => {
    expect(sent("NAS : 046.454.286.")).toBe("NAS : [SIN 1].");
    expect(sent("SIN: 046.454.286")).toBe("SIN: [SIN 1]");
    expect(sent("Numéro d’assurance sociale : 046.454.286")).toBe(
      "Numéro d’assurance sociale : [SIN 1]",
    );
  });
  it("removes a bare pointed number, but not a decimal, a version or a date", () => {
    expect(sent("Patiente dont le NAS, 046.454.286, figure au dossier.")).toBe(
      "Patiente dont le NAS, [SIN 1], figure au dossier.",
    );
    expect(
      sent("Dose 0.5 mg; pH 7.35; version 1.2.3; TA 120/80; 2026.04.04."),
    ).toBe("Dose 0.5 mg; pH 7.35; version 1.2.3; TA 120/80; 2026.04.04.");
    expect(
      sent("Mixed separators 046.454-286 stay out of the bare rule."),
    ).toBe("Mixed separators 046.454-286 stay out of the bare rule.");
  });
  it("still removes the grouped forms and the linked checksum control", () => {
    const result = out(
      "NAS : 046.454.286; checksum-invalid control: 046.454.287",
    );
    expect(result.toSend).toBe(
      "NAS : [SIN 1]; checksum-invalid control: [SIN 2]",
    );
    expect(restore(result.toSend, result)).toBe(
      "NAS : 046.454.286; checksum-invalid control: 046.454.287",
    );
  });
});

describe("record-number labels", () => {
  const french: [string, string][] = [
    ["Dossier médical no 0077123.", "Dossier médical no [RECORD NUMBER 1]."],
    [
      "Numéro de dossier médical : 0077123.",
      "Numéro de dossier médical : [RECORD NUMBER 1].",
    ],
    ["No de patient : 12345.", "No de patient : [RECORD NUMBER 1]."],
    ["Numéro de patient : 12345.", "Numéro de patient : [RECORD NUMBER 1]."],
    ["ID patient : 12345.", "ID patient : [RECORD NUMBER 1]."],
    ["No d'hôpital : 123456.", "No d'hôpital : [RECORD NUMBER 1]."],
    ["No de requête : R-12345.", "No de requête : [RECORD NUMBER 1]."],
    [
      "Numéro de demande : 2024-001234.",
      "Numéro de demande : [RECORD NUMBER 1].",
    ],
    ["No de laboratoire : L-123456.", "No de laboratoire : [RECORD NUMBER 1]."],
    ["N° d'épisode : 778899.", "N° d'épisode : [RECORD NUMBER 1]."],
    ["Numéro de visite : V2026-0012.", "Numéro de visite : [RECORD NUMBER 1]."],
  ];
  const english: [string, string][] = [
    ["Patient number: 12345.", "Patient number: [RECORD NUMBER 1]."],
    ["Patient #: 12345.", "Patient #: [RECORD NUMBER 1]."],
    ["Pt ID: 12345.", "Pt ID: [RECORD NUMBER 1]."],
    ["HRN: 12345.", "HRN: [RECORD NUMBER 1]."],
    ["Account number: 998877.", "Account number: [RECORD NUMBER 1]."],
    ["Account #: 998877.", "Account #: [RECORD NUMBER 1]."],
    ["Unit number: U123456.", "Unit number: [RECORD NUMBER 1]."],
    ["Client ID: C-12345.", "Client ID: [RECORD NUMBER 1]."],
    ["Order number: 556677.", "Order number: [RECORD NUMBER 1]."],
    ["Report number: RPT-2026-12.", "Report number: [RECORD NUMBER 1]."],
    ["Reference number: REF 12345.", "Reference number: [RECORD NUMBER 1]."],
    ["Ref #: 12345.", "Ref #: [RECORD NUMBER 1]."],
  ];
  it.each(french)(
    "removes the French label's value: %s",
    (source, expected) => {
      expect(sent(source)).toBe(expected);
    },
  );
  it.each(english)(
    "removes the English label's value: %s",
    (source, expected) => {
      expect(sent(source)).toBe(expected);
    },
  );
  it("leaves clinical text with the same words alone", () => {
    for (const text of [
      "Order: CBC, lytes, creatinine.",
      "Unit 3 North, bed 12; 2 units of insulin.",
      "Report reviewed with the patient.",
      "Reference range 3.5 to 5.0 mmol/L.",
      "Patient reports no chest pain. Account for the delay.",
      "Dossier à compléter; demande de consultation en cardiologie.",
      "Épisode de fibrillation auriculaire; visite de suivi dans 3 mois.",
    ])
      expect(sent(text)).toBe(text);
  });
  it("round-trips every removed value", () => {
    for (const [source] of [...french, ...english]) {
      const result = out(source);
      expect(restore(result.toSend, result)).toBe(source);
    }
  });
});

import { describe, expect, it } from "vitest";
import { deidentify, restore } from "./deidentify";

// Synthetic regression examples. These exercise observed failure mechanisms;
// they are not an independent holdout or evidence of general detector recall.
const run = (source: string) =>
  deidentify(source, { knownNames: [], dateShiftDays: -40, dayFirst: true });

describe("identity roles and clinical occurrences", () => {
  it("shifts an unqualified Encounter date through the date layer", () => {
    const source = "Encounter: 2026-05-14\nDose 20 mg once daily.";
    const result = run(source);
    expect(result.toSend).toBe("Encounter: 2026-04-04\nDose 20 mg once daily.");
    expect(result.onDevice.removed.map((part) => part.kind)).toEqual(["date"]);
    expect(restore(result.toSend, result)).toBe(source);
  });

  it("protects explicit record labels and invalid date-shaped IDs", () => {
    const source = [
      "MRN: 2026-05-14",
      "Encounter number: 2026-05-14",
      "Encounter # 2026-05-14",
      "Encounter: 2026-99-14",
    ].join("\n");
    const result = run(source);
    expect(result.onDevice.removed.map((part) => part.kind)).toEqual([
      "recordNumber", "recordNumber", "recordNumber", "recordNumber",
    ]);
    expect(result.toSend).not.toMatch(/2026-/);
    expect(restore(result.toSend, result)).toBe(source);
  });

  it("retains known birth-date protection in an Encounter field", () => {
    const result = deidentify("Encounter: 1992-07-23", {
      knownNames: [], knownBirthDates: ["1992-07-23"], dateShiftDays: -40,
    });
    expect(result.onDevice.removed[0].kind).toBe("dateOfBirth");
    expect(result.toSend).not.toContain("1992-07-23");
  });

  // Automatic aliases restore the group's canonical name in an answer.
  // The clinical occurrence must still remain verbatim.
  it.each([
    [
      "Dr Imani Horner reviewed the note. Horner syndrome: absent. Dr Horner signed.",
      "Horner syndrome: absent.",
      "Dr Imani Horner reviewed the note. Horner syndrome: absent. Dr Imani Horner signed.",
    ],
    [
      "La Dre Imani Horner a signé. Syndrome de Horner : absent. Dre Horner a rappelé.",
      "Syndrome de Horner : absent.",
      "La Dre Imani Horner a signé. Syndrome de Horner : absent. Dre Imani Horner a rappelé.",
    ],
    [
      "Dre Imani Horner a signé. Le syndrome de Claude Bernard-Horner est absent.",
      "Le syndrome de Claude Bernard-Horner est absent.",
      "Dre Imani Horner a signé. Le syndrome de Claude Bernard-Horner est absent.",
    ],
    [
      "Dr Alice Quervain reviewed. Possible de Quervain tenosynovitis on the right.",
      "Possible de Quervain tenosynovitis on the right.",
      "Dr Alice Quervain reviewed. Possible de Quervain tenosynovitis on the right.",
    ],
    [
      "Dre Alice Quervain a signé. Ténosynovite de Quervain possible à droite.",
      "Ténosynovite de Quervain possible à droite.",
      "Dre Alice Quervain a signé. Ténosynovite de Quervain possible à droite.",
    ],
  ])("keeps a clinical occurrence beside the same clinician surname: %s", (source, clinical, canonicalRestored) => {
    const result = run(source);
    expect(result.toSend).toContain(clinical);
    expect(result.toSend).not.toContain("Imani");
    expect(result.toSend).not.toContain("Alice");
    expect(result.toSend).not.toMatch(/Dr(?:e)? Horner/);
    expect(restore(result.toSend, result)).toBe(canonicalRestored);
  });

  it("continues removing an alias in ordinary identity prose", () => {
    const source = "Dr Imani Horner signed. Horner called the patient.";
    const result = run(source);
    expect(result.toSend).not.toContain("Horner");
    expect(restore(result.toSend, result)).toBe(
      "Dr Imani Horner signed. Imani Horner called the patient.",
    );
  });

  it.each([
    "SIN invented checksum-valid: 913704680; checksum-invalid control: 913704681.",
    "NAS inventé à somme valide : 913704680; contrôle à somme invalide : 913704681.",
  ])("protects sensitive labelled values including a linked mistyped control: %s", (source) => {
    const result = run(source);
    expect(result.onDevice.removed.map((part) => part.kind)).toEqual(["sin", "sin"]);
    expect(result.toSend).not.toMatch(/91370468[01]/);
    expect(restore(result.toSend, result)).toBe(source);
  });

  it("keeps unrelated nine-digit measurements outside the sensitive field", () => {
    const source = "NAS inventé à somme valide 926183401; instrument count: 123456789.\nCount 987654321.";
    const result = run(source);
    expect(result.toSend).not.toContain("926183401");
    expect(result.toSend).toContain("instrument count: 123456789");
    expect(result.toSend).toContain("Count 987654321");
  });

  it.each([
    "For Dorian Faye-Mercier, accompanying relative Elise Faye-Mercier attended.",
    "Pour Dorian Faye-Mercier, la proche accompagnante Elise Faye-Mercier est arrivée.",
  ])("removes a relative's entire hyphenated name beside a known surname: %s", (source) => {
    const result = deidentify(source, { knownNames: ["Dorian Faye-Mercier"], dateShiftDays: -40 });
    expect(result.onDevice.removed.some((part) => part.original === "Elise Faye-Mercier")).toBe(true);
    expect(result.toSend).not.toMatch(/Dorian|Elise|Faye|Mercier/);
    expect(restore(result.toSend, result)).toBe(source);
  });

  it("removes a whole surname-first French signature", () => {
    const source = "Correspondance signée par SERRA, Inès après un appel. Dose 50 µg.";
    const result = run(source);
    expect(result.onDevice.removed.some((part) => part.original === "SERRA, Inès")).toBe(true);
    expect(result.toSend).not.toMatch(/SERRA|Inès/);
    expect(result.toSend).toContain("Dose 50 µg");
    expect(restore(result.toSend, result)).toBe(source);
  });

  it.each([
    ["🧪 Patient spoke with Le\u0301onie Viremont and left.", "Le\u0301onie Viremont"],
    ["Keira a rencontré Oisín Marlowe; no weakness.", "Oisín Marlowe"],
    ["Timetable copied to Hugo Eastmere. Iron sucrose 200 mg.", "Hugo Eastmere"],
    ["Registration checked by Jules Northvale with Amira Cresson. Pulse 64 bpm.", "Amira Cresson"],
  ])("covers an explicit relationship without a supplied candidate: %s", (source, name) => {
    const result = run(source);
    const removed = result.onDevice.removed.find((part) => part.original === name);
    expect(removed).toBeDefined();
    expect(source.slice(removed!.start, removed!.end)).toBe(name);
    expect(result.toSend).not.toContain(name);
    expect(restore(result.toSend, result)).toBe(source);
  });

  it("flags a disease in relational prose for review without removing it", () => {
    for (const [source, flagged] of [
      ["Spoke with De Quervain tenosynovitis noted in the referral.", "De Quervain"],
      ["Spoke with De Quervain Tenosynovitis noted in the referral.", "De Quervain Tenosynovitis"],
    ]) {
      const result = run(source);
      expect(result.toSend).toBe(source);
      expect(result.onDevice.possibleNames.map((part) => part.original)).toContain(flagged);
    }
  });
});

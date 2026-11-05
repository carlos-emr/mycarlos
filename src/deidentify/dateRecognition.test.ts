import { describe, expect, it } from "vitest";
import { deidentify, restoreChecked } from "./deidentify";

const send = (text: string, knownNames: string[] = []) =>
  deidentify(text, { knownNames }).toSend;

describe("birth dates are recognized, in every language, so no gap gives the age", () => {
  it.each([
    ["Vu le 2026-05-14. naissance 14/03/1979.", "[DATE OF BIRTH 1]"],
    ["Seen 2026-05-14. b. 1979-03-14.", "[DATE OF BIRTH 1]"],
    ["Seen 2026-05-14. Age 76 (2 January 1950).", "[DATE OF BIRTH 1]"],
    ["Seen 2026-05-14. Data urodzenia: 14.02.1948", "[DATE OF BIRTH 1]"],
    ["Visita 2026-05-14. Fecha de nacimiento: 14/03/1979", "[DATE OF BIRTH 1]"],
    ["Visita 2026-05-14. Data de nascimento: 14/03/1979", "[DATE OF BIRTH 1]"],
    ["Vu le 2026-05-14. Né le : 14/03/1979", "[DATE OF BIRTH 1]"],
    ["2026-05-14 就诊。出生日期：1979年3月14日", "[DATE OF BIRTH 1]"],
  ])("%s", (text, mark) => {
    const out = send(text);
    expect(out).toContain(mark);
    expect(out).not.toMatch(/days? after/);
    expect(out).not.toMatch(/1979|1950|1948/);
  });

  it("reads a date in brackets after the patient's name, or after 'Patient Name'", () => {
    const a = send("Visit 2026-05-14; Avery Example (23/08/1929) stable.", [
      "Avery Example",
    ]);
    expect(a).toContain("[DATE OF BIRTH 1]");
    expect(a).not.toMatch(/days? after/);
    const b = send("Visit 2026-05-14. Patient Avery Example (23/08/1929).");
    expect(b).toContain("[DATE OF BIRTH 1]");
  });

  it("never gives a gap from a date 90 or more years before the latest one", () => {
    const out = send(
      "Born somewhere. 1931-03-14 noted. Seen 2026-05-14 and 2026-06-01.",
    );
    expect(out).not.toMatch(/\d{4,} days after/);
    expect(out).toContain(
      "[DATE 2, 18 days after DATE 1]"
        .replace("DATE 2", "DATE 3")
        .replace("DATE 1", "DATE 2"),
    );
  });

  it("keeps ordinary history gaps", () => {
    const out = send("Surgery 1987-03-14. Seen 2026-05-14.");
    expect(out).toContain("[DATE 1]");
    expect(out).toMatch(/\[DATE 2, \d+ days after DATE 1\]/);
  });
});

describe("a month word inside a date is never a name", () => {
  it.each([
    [["Rose Mai"], "Vu le 14 mai 2026.", "le [DATE 1] "],
    [["Avril Testeau"], "Vu le 3 avril 2026.", "le [DATE 1]"],
  ])("%j", (names, text) => {
    const out = send(text, names);
    expect(out).not.toContain("[NAME");
    expect(out).toMatch(/\[DATE 1\]/);
    expect(out).not.toMatch(/\b2026\b/);
  });

  it("does not restore a month as a name, or one wrong day", () => {
    const d = deidentify(
      "Vu le 9 mars 2026 et le 12 janvier 2026. Janvier Mars est suivi.",
      {
        knownNames: ["Janvier Mars"],
      },
    );
    expect(d.toSend).not.toMatch(/\b2026\b/);
    const back = restoreChecked(d.toSend, d).text;
    expect(back).toContain("9 mars 2026");
    expect(back).toContain("12 janvier 2026");
  });
});

describe("long forms in Spanish, Portuguese, Polish and Chinese are dates", () => {
  it.each([
    "Visto el 14 de mayo de 2026.",
    "Visto em 14 de maio de 2026.",
    "Wizyta 14 maja 2026 r.",
    "Wizyta 25 lutego 2026 r.",
    "Visto el 2 de marzo de 2026.",
    "Visto em 28 de janeiro de 2026.",
    "就诊日期 2026年5月14日。",
  ])("%s", (text) => {
    const out = send(text);
    expect(out).toMatch(/\[DATE 1\]/);
    expect(out).not.toMatch(/2026/);
  });
});

describe("a relative who shares the patient's surname is not the patient", () => {
  it("does not restore a relative's bare surname as the patient's full name", () => {
    const d = deidentify("Pippa Vellin was seen. Her guardian Vellin waited.", {
      knownNames: ["Pippa Vellin"],
    });
    const guardian = d.onDevice.removed.filter((r) => r.original === "Vellin");
    expect(guardian.length).toBeGreaterThan(0);
    const back = restoreChecked(d.toSend, d).text;
    expect(back).toBe("Pippa Vellin was seen. Her guardian Vellin waited.");
  });

  it("keeps a relative with the patient's surname apart from the patient", () => {
    const d = deidentify("Fenvale was seen. His son Leona Fenvale waited.", {
      knownNames: ["Fenvale"],
    });
    expect(restoreChecked(d.toSend, d).text).toBe(
      "Fenvale was seen. His son Leona Fenvale waited.",
    );
  });
});

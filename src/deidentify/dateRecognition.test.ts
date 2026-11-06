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

describe("a page read as one very long line", () => {
  const unit =
    "Seen by Dr. Hollis Example on 2026-03-14; phone 613-555-0142; MRN A0049921. ";
  const fifty = unit.repeat(Math.ceil(50_000 / unit.length)).slice(0, 50_000);

  it("takes about as long as the same text with line breaks, and removes the same", () => {
    const options = { knownNames: ["Tamsin Example"] };
    const withBreaks = fifty.replace(/(\d)\. /g, "$1.\n");
    // A busy computer slows both texts alike, so they are compared with each
    // other, not with a clock: a scan that grows with the line's length makes
    // the one-line page many times slower than the same page with breaks.
    // After a warm-up, the faster of two runs of each, taken in turn.
    let one = deidentify(unit, options);
    let oneLine = Infinity;
    let lines = Infinity;
    let broken = one;
    for (let run = 0; run < 2; run++) {
      let started = performance.now();
      one = deidentify(fifty, options);
      oneLine = Math.min(oneLine, performance.now() - started);
      started = performance.now();
      broken = deidentify(withBreaks, options);
      lines = Math.min(lines, performance.now() - started);
    }
    expect(oneLine).toBeLessThan(3 * lines + 250);
    expect(oneLine).toBeLessThan(10_000);
    const key = (d: ReturnType<typeof deidentify>) =>
      d.onDevice.removed.map((r) => `${r.kind}|${r.original}|${r.replacement}`);
    expect(key(one)).toEqual(key(broken));
    expect(one.toSend.replace(/\s+/g, " ")).toBe(
      broken.toSend.replace(/\s+/g, " "),
    );
  });
});

describe("ordinal first days in Spanish and Portuguese", () => {
  it.each([
    "Visto el 1º de junio de 2026.",
    "Visto em 1° de junho de 2026.",
    "Visto el 1.º de junio de 2026.",
    "Visto el 1ª de junio de 2026.",
  ])("%s", (text) => {
    const out = deidentify(text, { knownNames: [] }).toSend;
    expect(out).toMatch(/\[DATE 1\]/);
    expect(out).not.toMatch(/\b1[º°ªo.]|2026/);
  });
});

describe("birth-date cues for an age under 90, so no gap gives the age (#253)", () => {
  // The 90-and-over net does not cover an 85-year-old: only the cue does.
  it.each([
    "DOB 1941-03-14",
    "D.O.B.: 14/03/1941",
    "Date of Birth (DOB): 1941-03-14",
    "Birth date: 1941-03-14",
    "Birthdate 14 March 1941",
    "Born 14 March 1941",
    "Born on 1941-03-14",
    "b. 1941-03-14",
    "DOB/Age: 1941-03-14 / 85",
    "Date of birth 14-Mar-1941",
    "Date de naissance : 14/03/1941",
    "Né le 14/03/1941",
    "Née le 14 mars 1941",
    "DDN : 14/03/1941",
    "Date naiss. : 14/03/1941",
    "Date de naiss. 14/03/1941",
    "Fecha de nacimiento: 14/03/1941",
    "F. de nac.: 14/03/1941",
    "Fecha de nac. 14/03/1941",
    "Nacida el 14 de marzo de 1941",
    "FN: 14/03/1941",
    "Data de nascimento: 14/03/1941",
    "Nascida em 14/03/1941",
    "Nasc.: 14/03/1941",
    "DN: 14/03/1941",
    "D.N.: 14/03/1941",
    "Data urodzenia: 14.03.1941",
    "ur. 14.03.1941",
    "ur. dnia 14.03.1941",
    "Urodzona 14 marca 1941 r.",
    "data ur. 14.03.1941",
    "Urodzony dnia 14.03.1941",
    "出生日期：1941-03-14",
    "出生：1941年3月14日",
  ])("%s", (cue) => {
    const out = send(`${cue}. Visit 2026-03-12.`);
    expect(out).toMatch(/\[DATE OF BIRTH 1\]/);
    expect(out).not.toMatch(/1941|days after DATE OF BIRTH/);
  });

  it.each([
    "DN 2026-03-12 reviewed.",
    "Visit 2026-03-12; FN negative.",
    "Date de consultation : 12/03/2026.",
  ])("leaves an event date: %s", (text) => {
    expect(send(text)).not.toMatch(/DATE OF BIRTH/);
  });
});

describe("a short birth cue that is also an everyday abbreviation (#259 review)", () => {
  // DN: district nurse, FN: febrile neutropenia, b.: a lettered list or "Plan B.".
  it.each([
    "DN: 2026-03-12 dressing changed. Seen 2026-03-20.",
    "Visits - GP: 2026-03-02, DN: 2026-03-12, OT: 2026-03-19.",
    "FN: 2026-03-12, admitted; reviewed 2026-03-14.",
    "D.N.: 2026-03-12 review. Next 2026-04-02.",
    "DN : 12/03/2026 pansement, revu le 19/03/2026.",
    "a. 2026-03-02 start; b. 2026-03-12 stop.",
    "Plan B. 2026-03-12 switch. Review 2026-04-01.",
  ])("is an event date beside a nearby date: %j", (text) => {
    expect(send(text)).not.toMatch(/DATE OF BIRTH/);
  });

  it.each([
    "DN: 14/03/1941. Consulta 12/03/2026.",
    "FN: 14/03/1941. Visita 12/03/2026.",
    "D.N.: 14/03/1941\nConsulta 12/03/2026.",
    "b. 1941-03-14. Seen 2026-03-12.",
    "DN: 14/03/1941",
  ])("is a birth date a year or more before a visit, or alone: %j", (text) => {
    const out = send(text);
    expect(out).toMatch(/\[DATE OF BIRTH 1\]/);
    expect(out).not.toContain("1941");
  });

  it.each([
    "Né(e) le 14/03/1941. Vu le 12/03/2026.",
    "出生年月日：1941年3月14日。2026年3月12日就诊。",
    "Data urodz.: 14.03.1941. Wizyta 12.03.2026.",
    "Dt nasc: 14/03/1941. Consulta 12/03/2026.",
    "F.N.: 14/03/1941. Visita 12/03/2026.",
    "Birth: 1941-03-14. Seen 2026-03-12.",
  ])("reads more birth labels: %j", (text) => {
    expect(send(text)).toMatch(/\[DATE OF BIRTH 1\]/);
  });
});

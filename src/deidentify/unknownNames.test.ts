import { describe, expect, it } from "vitest";
import { deidentify } from "./deidentify";

const send = (text: string) => deidentify(text, { knownNames: [] }).toSend;
const gone = (text: string, ...names: string[]) => {
  const out = send(text);
  for (const name of names) expect(out).not.toContain(name);
  return out;
};

describe("names the app was not told, found by what stands around them", () => {
  it.each([
    ["Her pharmacist, Jordan Quillfeather, called.", "Quillfeather"],
    ["Night nurse Tamsin Ardleigh checked the chart.", "Ardleigh"],
    ["Triage nurse Pia Nordwick arrived.", "Nordwick"],
    ["Recorded by Jordan Quillfeather on arrival.", "Quillfeather"],
    ["Documented by Marcel Dufresne-Lavoie.", "Dufresne"],
    ["Electronically signed by Quillfeather, Jordan, MD.", "Quillfeather"],
    ["c.c. : Dr Jordan Quillfeather", "Quillfeather"],
    ["Rédigé par Marcel Dufresne-Lavoie.", "Dufresne"],
    ["Notée par Hélène Bastarache.", "Bastarache"],
    ["Technologue Hélène Bastarache a fait l'examen.", "Bastarache"],
    ["La pharmacienne Hélène Bastarache a appelé.", "Bastarache"],
    ["Firmado por Elena Quillfeather.", "Quillfeather"],
    ["Enfermera Elena Quillfeather llamó.", "Quillfeather"],
    ["Assinado por Elena Quillfeather.", "Quillfeather"],
    ["Podpisano przez Katarzyna Nowakowska.", "Nowakowska"],
    ["Sra. Elena Quillfeather vive aquí.", "Quillfeather"],
    ["Pani Katarzyna Nowakowska mieszka tutaj.", "Nowakowska"],
    ["Claimant: Jordan Quillfeather.", "Quillfeather"],
    ["Usager : Marcel Dufresne-Lavoie.", "Dufresne"],
    ["Paciente: Elena Quillfeather.", "Quillfeather"],
  ])("%s", (text, surname) => {
    gone(text, surname);
  });

  it("gives one person one placeholder, and a later mention of the name the same one", () => {
    const out = gone(
      "Night nurse Tamsin Ardleigh checked. Later Ardleigh called again.",
      "Ardleigh",
    );
    expect(out.match(/\[NAME 1\]/g)).toHaveLength(2);
  });
});

describe("eponyms and drug names are never taken for names", () => {
  // [clinical phrase, a doctor with the eponym's name]
  const pairs = [
    ["Guillain-Barré syndrome", "Guillain"],
    ["Horner syndrome", "Horner"],
    ["De Quervain tenosynovitis", "Quervain"],
    ["Bell's palsy", "Bell"],
    ["Wolff-Parkinson-White", "Wolff"],
    ["Guyon's canal", "Guyon"],
    ["Romberg test", "Romberg"],
  ];
  const alone = ["Behçet disease", "Lasix 40 mg"];

  it.each(pairs)("%s stays, with a Dr. %s removed", (term, doctor) => {
    const out = send(`${term} was noted. Seen by Dr. ${doctor} today.`);
    expect(out).toContain(term);
    expect(out).not.toContain(`Dr. ${doctor}`);
  });

  it("keeps every term when all stand in one document with their doctors", () => {
    const out = send(
      `${[...pairs.map(([term]) => term), ...alone].join(". ")}. Seen by Dr. Guyon and Dr. Romberg and Dr. Bell.`,
    );
    for (const term of [...pairs.map(([t]) => t), ...alone])
      expect(out).toContain(term);
    expect(out).toMatch(/Dr\. \[DOCTOR \d\] and Dr\. \[DOCTOR \d\]/);
  });
});

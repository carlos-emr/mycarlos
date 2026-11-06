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

describe("a drug name that is also a first name", () => {
  // Ella, Yasmin, Diane and Allegra are on the drug allow-list.
  const word = (name: string) =>
    new RegExp(`(?<![\\p{L}])${name}(?![\\p{L}])`, "u");

  it.each([
    [
      "Her daughter Ella Sampleton drove her in today. Ella says she is eating well.",
      "Ella",
    ],
    ["Her daughter Ella drove her in today.", "Ella"],
    ["Nurse Yasmin called the pharmacy. Yasmin will call back.", "Yasmin"],
    [
      "Accompanied by her sister, Diane Sampleton. Diane manages the pill box.",
      "Diane",
    ],
    [
      "Spoke with Mrs. Allegra Sampleton on the phone. Allegra agrees.",
      "Allegra",
    ],
    ["Meds: reviewed with daughter Ella.", "Ella"],
    // An ordinary word after the name is not a frequency or a form.
    ["Her daughter Ella once worked as a nurse.", "Ella"],
    ["Her sister Diane drops by every Sunday.", "Diane"],
    ["Nurse Yasmin bid farewell to the family.", "Yasmin"],
    ["Córka Ella po operacji odwiedza matkę.", "Ella"],
    ["Her daughter Ella daily checks her sugars.", "Ella"],
  ])("is a name after a person word: %s", (text, name) => {
    expect(send(text)).not.toMatch(word(name));
  });

  it.each([
    "Started Yasmin, one tablet daily.",
    "Allegra 120 mg once daily for hay fever.",
    "Medications: Allegra, Yasmin, Ella.",
    "Diane-35 one tablet daily for acne.",
    "She took Ella within 72 hours.",
    "Switched from Yasmin to Alesse.",
  ])("stays a drug where it reads as one: %s", (text) => {
    expect(send(text)).toBe(text);
  });

  it("is a person and a drug in the same text, each where it stands", () => {
    const out = send(
      "Her daughter Ella Sampleton came with her. Medications: Allegra 120 mg daily, Ella 1.5 mg once.",
    );
    expect(out).toMatch(/^Her daughter \[NAME 1\] came/);
    expect(out).toContain(
      "Medications: Allegra 120 mg daily, Ella 1.5 mg once.",
    );
    const nurse = send(
      "Nurse Yasmin reviewed the list. Allergic to Yasmin (rash). Discontinued Yasmin in May.",
    );
    expect(nurse).toBe(
      "Nurse [NAME 1] reviewed the list. Allergic to Yasmin (rash). Discontinued Yasmin in May.",
    );
    expect(send("Sister Diane Sampleton attends. Diane-35 was stopped.")).toBe(
      "Sister [NAME 1] attends. Diane-35 was stopped.",
    );
  });
});

describe("record-number shapes and spaced social insurance numbers", () => {
  it.each([
    ["Policy no. GRP-00731-554/02 on file.", "GRP-00731"],
    ["Certificate: 7-2204518 issued.", "2204518"],
    ["Exam #: LL9999-99999 done.", "LL9999"],
    ["Visit: L2026001234 today.", "2026001234"],
    ["Examen n° AB-26-004517 fait.", "004517"],
    ["dossier 1234 5678 ouvert.", "5678"],
    ["Usager n° 2026-LLL-99999.", "99999"],
    ["Prontuário: 1234.567-8.", "1234.567"],
    ["Nr księgi głównej: 2026/99999.", "99999"],
    ["NHC: 12345678.", "12345678"],
    ["NAS: 123  456  789", "456"],
  ])("%s", (text, secret) => {
    expect(send(text)).not.toContain(secret);
  });

  it.each([
    "Visit: 2 weeks from now.",
    "Reference: see page 12.",
    "Dossier complet reçu.",
    "Exam: 3 views taken.",
  ])("leaves ordinary text alone: %s", (text) => {
    expect(send(text)).toBe(text);
  });
});

describe("a date after a record label stays a date; look-alikes stay", () => {
  it.each([
    "Visit 2026-10-12 was routine.",
    "Exam 2026-05-20 showed no change.",
    "Next visit 2026-05-28.",
  ])("%s", (text) => {
    const out = send(text);
    expect(out).toMatch(/\[DATE \d/);
    expect(out).not.toMatch(/RECORD NUMBER/);
  });

  it.each([
    "She takes St. John's wort daily.",
    "Dr. Reddy's tablets were refilled.",
    "Plan B was discussed.",
  ])("%s", (text) => {
    expect(send(text)).toBe(text);
  });
});

describe("relatives as a label, friends, and relatives named together", () => {
  it.each([
    [
      "Mother: Rosalind Sampleton. Rosalind works nights.",
      ["Rosalind", "Sampleton"],
    ],
    ["Father: Corwin Ashdale (613-555-0142)", ["Corwin", "Ashdale"]],
    ["Friend Corwin brought her.", ["Corwin"]],
    ["Her friend, Maribel Ashdale, drove her.", ["Maribel", "Ashdale"]],
    ["Son amie Odette l'accompagne.", ["Odette"]],
    ["Her daughters Maribel and Odette visited.", ["Maribel", "Odette"]],
    [
      "His sons Corwin, Tobiah and Ewan Ashdale help at home.",
      ["Corwin", "Tobiah", "Ewan"],
    ],
    ["Ses filles Maribel et Odette l'aident.", ["Maribel", "Odette"]],
    ["Sus hijos Corwin y Tobiah viven cerca.", ["Corwin", "Tobiah"]],
  ])("%s", (text, names) => {
    gone(text, ...names);
  });

  it.each([
    "Mother: Breast cancer at 52.",
    "Father: Coronary Artery Disease, died at 60.",
    "Mother: Alive and well.",
    "Sister: Type 2 diabetes.",
    "Brother: Healthy.",
    "Father: MI at 58.",
    "Mère : Diabète de type 2.",
    "Her children are well.",
    "Children: two, both healthy.",
    "Friend of the family.",
  ])("leaves a family-history line or an ordinary phrase: %s", (text) => {
    expect(send(text)).toBe(text);
  });
});

describe("look-alikes found in the #228 review", () => {
  it("removes a doctor whose name is a bare eponym, and keeps the eponym", () => {
    expect(send("Referred by: Dr. Holter. Holter monitor booked.")).toBe(
      "Referred by: Dr. [DOCTOR 1]. Holter monitor booked.",
    );
  });

  it.each([
    "Sodium 139 mmol/L. Reference: 135-145 mmol/L.",
    "Reference: 135-145.",
    "Started with a therapist Cognitive Behavioural Therapy weekly.",
    "Nombre : Deux comprimés par jour.",
    "Claim 1250.00 submitted.",
    "Flew Pan Am in 1979 and Pan American later.",
  ])("leaves %s", (text) => {
    expect(send(text).replace(/\[DATE \d+\]/gu, "1979")).toBe(text);
  });

  it("still removes a record number after Reference and Claim", () => {
    const out = send("Reference AB12345. Claim 2026-778812.");
    expect(out).not.toContain("AB12345");
    expect(out).not.toContain("778812");
  });

  it("still removes a name after Nombre and Pan", () => {
    gone("Nombre: María López. Pan Tomasz Nowakowski.", "López", "Nowakowski");
  });
});

describe("the second #228 review", () => {
  it("ends a clinician's name before a place or a team word", () => {
    expect(send("Charge nurse Maria Lopez Unit 4B called.")).toBe(
      "Charge nurse [NAME 1] Unit 4B called.",
    );
  });

  it.each([
    "Mother: Multiple Sclerosis.",
    "Father: Atrial Fibrillation, age 70.",
    "Father: Sudden Death.",
    "Brother: Down Syndrome.",
    "Sister: Colon Carcinoma.",
    "Family history:\nMother: Breast Cancer.\nFather: Heart Attack.",
    "Le physiothérapeute Équipe Mobile passe demain.",
    "Call Kids Help Phone if needed.",
  ])("leaves %j", (text) => {
    expect(send(text)).toBe(text);
  });

  it("removes a drug-name first name followed by a frequency", () => {
    gone("Her daughter Ella twice a week drives her.", "Ella");
  });

  it("removes a relative named after a label and after lower-case kids", () => {
    gone("Mère : Rosalind Sampleton.", "Rosalind", "Sampleton");
    gone("Her kids Maribel and Odette visited.", "Maribel", "Odette");
  });

  it("removes a record number with a long second group whole", () => {
    expect(send("Voir le dossier 1234 567890.")).toBe(
      "Voir le dossier [RECORD NUMBER 1].",
    );
  });
});

describe("a relative after a label, next to a family history", () => {
  it.each([
    [
      "Family history: noncontributory.\nEmergency contact:\nHusband: Jordan Sampleton.",
      ["Jordan", "Sampleton"],
    ],
    [
      "Family history: none.\n\nMother: Rosalind Sampleton (613-555-0142)",
      ["Rosalind"],
    ],
    ["Mother: Rose Baker.", ["Baker"]],
    ["Father: Clement Dufour.", ["Clement", "Dufour"]],
    ["Sister: Avery Furness.", ["Avery", "Furness"]],
  ])("removes the relative: %j", (text, names) => {
    gone(text, ...names);
  });

  it.each([
    "Father: Heart Failure.",
    "Mother: Pulmonary Embolism.",
    "Family history: Mother: Ovarian Cancer.",
    "FHx:\nFather: Prostate Cancer.\nBrother: Type 1 Diabetes.\nSister: Celiac Disease.",
  ])("leaves the family history: %j", (text) => {
    expect(send(text)).toBe(text);
  });
});

describe("a patient named with no cue: a header line or a care verb (#264)", () => {
  // FAKE sentences written apart from the harness's shared sets, and the review's look-alikes.
  it.each([
    "CONSULTATION NOTE — Tobiah Farnsworth\nDOB: 1958-03-14\nSeen today for cough.",
    "Discharge letter: Wren Halloway    MRN 4471829\nAdmitted with pneumonia.",
    "Wound care plan for Idris Calloway\nAge: 81\nDressing every two days.",
    "Physiotherapy summary — HALLOWAY, Wren\nGait improved.",
    "Lettre de sortie — Basile Fenwick\nDate de naissance : 14/03/1941",
    "Plan de soins pour Margaux Vellacourt\nNAM : VELM 4103 1412",
    "Informe de alta — Inés Valcárcel Pruneda\nNHC: 4471829",
    "Plan de cuidados para Lucas Ferrabosco\nFecha de nacimiento: 14/03/1941",
    "Resumo de alta — Tomé Vasconcelos Brito\nCPF: 987.654.321-00",
    "Karta informacyjna — Zuzanna Wierzbicka\nPESEL: 58031412345",
    "Plan opieki dla Bartosz Kowalczyk\nData urodzenia: 14.03.1941",
    "DOB: 1958-03-14\nCONSULTATION NOTE — Tobiah Farnsworth",
    "Paramedics brought Tobiah Farnsworth to the emergency department.",
    "We were asked to see Wren Halloway on the ward.",
    "Les ambulanciers ont amené Basile Fenwick aux urgences.",
    "La ambulancia trajo a Lucas Ferrabosco a urgencias.",
    "A ambulância trouxe Tomé Vasconcelos ao pronto-socorro.",
    "Karetka przywiozła Zuzannę Wierzbicką na SOR.",
  ])(
    "removes the name, with a person field near a header or after a person-taking verb: %j",
    (text) => {
      expect(send(text)).toMatch(/\[NAME 1\]/);
    },
  );

  it.each([
    "Discharge Summary: Congestive Heart Failure",
    "Consultation Note: Cardiology",
    "Referral Letter: Orthopaedic Surgery",
    "Care Plan: Fall Prevention",
    "Assessment: Stable Angina",
    "Plan: Home Care",
    "Review: Annual Physical",
    "Discharge Summary - Emergency Department",
    "Discharge: Home With Support",
    "Progress Note — Night Shift",
    "Nursing Note: Wound Care",
    "Consult Note: Infectious Diseases",
    "Report: Abdominal Ultrasound",
    "Summary: Acute Kidney Injury",
    "Referral: Physiotherapy",
    "Bilan : Hypertension Artérielle",
    "Lettre de sortie : Service de Cardiologie",
    "Plan de soins : Prévention des Chutes",
    "Compte rendu : Coloscopie Totale",
    "Informe de alta: Neumonía Adquirida",
    "Valoración: Riesgo de Caídas",
    "Resumen: Paciente Estable",
    "Resumo de alta: Pneumonia Comunitária",
    "Encaminhamento: Ortopedia",
    "Karta informacyjna: Oddział Chorób Wewnętrznych",
    "Skierowanie: Poradnia Kardiologiczna",
    "Wypis: Zapalenie Płuc",
    "Patient Referred To Cardiology Clinic.",
    "Received Influenza Vaccine today.",
    "She received Tylenol Extra Strength.",
    "Transferred To Intensive Care.",
    "Brought In By Ambulance.",
    "Accompanied By Daughter.",
    "La ambulancia lo trasladó a Urgencias Generales.",
    "Lo trajeron a Consultas Externas.",
    "Recebemos Paciente Estável no setor.",
    "Transferiu Unidade Coronariana hoje.",
    "Przekazano Oddział Kardiologii.",
    "Przyjęto Pacjenta Stabilnego.",
    "Il a reçu Doliprane Codéine.",
    "Adressé Centre Hospitalier Régional.",
    "We saw Improvement Overall.",
    "Care Plan: Diabetes Education",
    "Progress Note — Day Three",
    "Nota de evolución: Paciente Estable",
    "Plan de soins : Prévention des Chutes",
    "Plano de cuidados: Úlcera Venosa",
    "Wypis: Oddział Chirurgii Ogólnej",
    "Brought Home Medications.",
    "Trouxe Exames Anteriores.",
    "Przywiózł Wyniki Badań.",
    "Care Plan: Fall Prevention\nChart reviewed.",
  ])("leaves a title-case subject or a thing: %j", (text) => {
    expect(send(text)).not.toMatch(/\[(NAME|DOCTOR)/);
  });

  // The stated cost: an unknown person's header name with no person field near it, or after a
  // verb that also takes things, stays. A patient known to the app is still removed.
  it.each([
    "Discharge letter: Wren Halloway\nAdmitted with pneumonia.",
    "Nous avons reçu Margaux Vellacourt en consultation.",
  ])("keeps, by the stated trade: %j", (text) => {
    expect(send(text)).not.toMatch(/\[NAME/);
    expect(
      deidentify(text, { knownNames: ["Wren Halloway", "Margaux Vellacourt"] })
        .toSend,
    ).toMatch(/\[NAME 1\]/);
  });
});

describe("a person field must look like a field (#264 review)", () => {
  // Prose near a header's subject is no person evidence: Polish "nie" (not) and "dni" (days),
  // "born in", "edad avanzada", an exam's "CNS:" line with no value.
  it.each([
    "Wypis: Zapalenie Płuc\nPacjent nie gorączkuje od dwóch dni.",
    "Care Plan: Fall Prevention\nBorn in Toronto, she lives alone.",
    "Informe de alta: Neumonía Adquirida\nEdad avanzada, sin fiebre.",
    "Consult Note: Infectious Diseases\nAge-appropriate vaccines given.",
    "Consult Note: Infectious Diseases\nCNS: no focal deficit.",
    "Care Plan: Wound Care\nDN: visit planned for next week.",
  ])("leaves the subject: %j", (text) => {
    expect(send(text)).not.toMatch(/\[(NAME|DOCTOR)/);
  });

  it.each([
    "CONSULTATION NOTE — Tobiah Farnsworth\nAge 81, lives alone.",
    "Discharge letter: Wren Halloway\nSex: F",
    "Informe de alta — Inés Valcárcel Pruneda\nNHC 4471829",
    "Karta informacyjna — Zuzanna Wierzbicka\nur. 14.03.1941",
  ])("removes the name beside a real field: %j", (text) => {
    expect(send(text)).toMatch(/\[NAME 1\]/);
  });
});

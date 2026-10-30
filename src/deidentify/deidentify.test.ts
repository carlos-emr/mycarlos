import { describe, expect, it } from "vitest";
import { deidentify, removeMore, restore, type Removed } from "./deidentify";
import source from "./deidentify.ts?raw";
import cleaningSource from "./textCleaning.ts?raw";
import discharge from "./fixtures/discharge-summary.txt?raw";
import imaging from "./fixtures/imaging-report.txt?raw";
import lab from "./fixtures/lab-report.txt?raw";
import referral from "./fixtures/referral-letter.txt?raw";
import quebec from "./fixtures/quebec-referral.txt?raw";
import hospital from "./fixtures/hospital-header.txt?raw";

// #72. Synthetic documents only: FAKE names, 555-01xx numbers, example.com
// addresses, made-up card and record numbers.
// "Maggie Notreal" is a profile name that is not the legal name in her
// hospital's header (#80 review).
const knownNames = [
  "Avery Example",
  "Jordan Example",
  "Renée Côté",
  "Maggie Notreal",
];
const run = (text: string) =>
  deidentify(text, { knownNames, dateShiftDays: 10 });

/** Every identifying detail in each document, which must not be sent, and
 * clinical text that must be. */
const documents = [
  {
    name: "referral letter",
    text: referral,
    gone: [
      "Maplewood Family Health Team",
      "123 Example Street",
      "Sampletown",
      "K9Z 9Z9",
      "(613) 555-0142",
      "613-555-0143",
      "referrals@example.com",
      "Blake Sample",
      "Dr. Sample",
      "Riverside Cardiology Clinic",
      "45 Fictional Avenue",
      "Testville",
      "X0X 0X0",
      "Avery",
      "1961-04-17",
      "1234-567-890-AB",
      "77 Placeholder Crescent",
      "K9Z 1A1",
      "613-555-0177",
      "Jordan",
      "(613) 555-0188",
      "Casey Placeholder",
      "613-555-0142 ext. 21",
      "Blake.",
    ],
    kept: [
      "65-year-old woman with exertional chest pain",
      "LDL was 3.9 mmol/L",
      "blood pressure 142/88",
      "ramipril 5 mg daily",
    ],
  },
  {
    name: "lab report",
    text: lab,
    gone: [
      "EXAMPLE",
      "Avery",
      "9123 456 789",
      "17-Apr-1961",
      "H00012345",
      "LAB-26-0099812",
      "Morgan Testcase",
      "Fictional Valley Laboratories",
      "1-800-555-0100",
      "results@lab.example.org",
    ],
    kept: [
      "Hemoglobin           132        g/L        120-160",
      "Potassium            5.4        mmol/L     3.5-5.0     H",
      "TSH                  2.1        mU/L       0.32-4.0",
      "Repeat in 2 weeks",
    ],
  },
  {
    name: "imaging report",
    text: imaging,
    gone: [
      "Avery Example",
      "EXAA 6104 1799",
      "0045123",
      "R-778812",
      "Hôpital Fictif de Testville",
      "Robin Fakename",
      "Blake Sample",
      "Riverside Cardiology Clinic",
      "with Robin",
    ],
    kept: ["CT chest with contrast", "A 6 mm nodule in the right upper lobe"],
  },
  {
    name: "discharge summary",
    text: discharge,
    gone: [
      "Sampletown General Hospital",
      "Avery Example",
      "April 17, 1961",
      "V-2026-554433",
      "Jordan Example",
      "613-555-0188",
      "Sam Testperson",
      "sam.testperson@example.net",
      "PO Box 4410",
      "Sampletown",
      "K9Z 9Z9",
      "Casey Placeholder",
      "Maplewood Family Health Team",
      "(613) 555-0142",
      "Taylor Notreal",
      "Sam will",
    ],
    kept: [
      "community-acquired pneumonia",
      "ceftriaxone 1 g IV daily",
      "amoxicillin 1 g PO three times daily for 5 days",
    ],
  },
  {
    name: "Quebec referral, in French",
    text: quebec,
    gone: [
      "Clinique médicale Saint-Laurent",
      "Saint-Laurent",
      "1234, rue Sherbrooke Est",
      "Sherbrooke",
      "app. 5",
      "Montréal",
      "H2X 1A1",
      "514 555-0123",
      "5145550124",
      "Émilie Tremblay",
      "Tremblay",
      "Centre hospitalier de Fictiveville",
      "Fictiveville",
      "88, boul. René-Lévesque Ouest",
      "René-Lévesque",
      "G1R 9Z9",
      "Renée",
      "Côté",
      "1958/03/02",
      "COTR 5803 0299",
      "0077123",
      "Jean de la Cruz",
      "de la Cruz",
      "4185550177",
      "1234 567 890",
      "Pierre d'Amours",
      "d'Amours",
      "Jean l'accompagnera",
    ],
    kept: [
      "douleur thoracique",
      "rythme sinusal",
      "68 ans",
      "médecin de famille",
    ],
  },
  {
    name: "hospital header, surname first and in capitals",
    text: hospital,
    gone: [
      "SAMPLETOWN GENERAL HOSPITAL",
      "NOTREAL",
      "MARGARET",
      "Notreal",
      "Margaret",
      "H00099881",
      "1972-05-09",
      "O'Sample",
      "Sean",
      "MACEXAMPLE",
      "ROWAN",
      "613-555-0131",
      "de la Testa",
      "Maria",
      "Testcase",
      "Quinn",
      "Jules",
      "Placeholder",
      "Indigo",
      "Testperson",
      "Drew",
      "Sampleson",
      "Sasha",
      "Fakename",
    ],
    kept: [
      "DIAGNOSTIC IMAGING REPORT",
      "Nurse Practitioner: ",
      "Pharmacist: ",
      "Social Worker: ",
      "MRN: ",
      "Tel: ",
      "Exam: Ultrasound abdomen",
      "Normal liver echotexture. No gallstones.",
    ],
  },
];

const kinds = (removed: Removed[]) => new Set(removed.map((part) => part.kind));

describe("the name remover (#72)", () => {
  for (const { name, text, gone, kept } of documents)
    it(`takes every listed detail out of the ${name}, and keeps the clinical text`, () => {
      const result = run(text);
      for (const detail of gone)
        expect(result.toSend, detail).not.toContain(detail);
      // Nor any word of a profile name, in any case.
      expect(result.toSend).not.toMatch(
        /avery|jordan|\bexample\b|renée|côté|maggie|notreal/i,
      );
      for (const clinical of kept) expect(result.toSend).toContain(clinical);
    });

  it("finds every kind of detail the ticket lists, across the documents", () => {
    const found = new Set(
      documents.flatMap(({ text }) => [...kinds(run(text).onDevice.removed)]),
    );
    for (const kind of [
      "name",
      "doctor",
      "clinic",
      "healthCard",
      "recordNumber",
      "dateOfBirth",
      "address",
      "postalCode",
      "phone",
      "email",
      "date",
    ])
      expect(found, kind).toContain(kind);
  });

  it("gives one detail one placeholder, and a person's whole name one too", () => {
    const text = run(referral).toSend;
    // "Avery EXAMPLE", "Avery Example" and "Avery's" are the patient.
    expect(text).toContain("Re: [NAME 1]");
    expect(text).toContain("Thank you for seeing Mrs. [NAME 1],");
    expect(text).toContain("[NAME 1]'s husband");
    // Her husband's whole name, across a line break, is one person.
    expect(text).toContain("[NAME 2], can be reached");
    // "Dr. Blake Sample" and "Dr. Sample" are one doctor.
    expect(text).toContain("Dr. [DOCTOR 1]\n");
    expect(text).toContain("Dear Dr. [DOCTOR 1],");
    // The clinic named twice is one clinic.
    expect(text.match(/\[CLINIC 1\]/g)).toHaveLength(2);
  });

  it("removes a date of birth, and shifts every other date by the same days", () => {
    const { toSend: text, onDevice } = run(referral);
    const { removed } = onDevice;
    expect(removed.find((part) => part.kind === "dateOfBirth")?.original).toBe(
      "1961-04-17",
    );
    // Written as they were, ten days later: the seven days between the
    // start of the pain and the ECG stay seven.
    expect(text).toContain("October 12, 2026");
    expect(text).toContain("since September 28, 2026");
    expect(text).toContain("ECG on 2026-10-05");
    const lab10 = run(lab).toSend;
    expect(lab10).toContain("Collected: 2026-10-18 07:40");
    expect(lab10).toContain("(on or after 2026-11-01)");
    const imaging10 = run(imaging).toSend;
    expect(imaging10).toContain("Date: 22 October 2026");
    expect(imaging10).toContain("CT chest, 13 Mar 2025.");
    expect(imaging10).toContain("around Oct. 22, 2027.");
  });

  it("removes a date like 03/04/2026, which could be read two ways, and moves one it can read", () => {
    const shift = (text: string, dayFirst?: boolean) =>
      deidentify(text, { knownNames: [], dateShiftDays: 1, dayFirst }).toSend;
    expect(shift("Seen 03/04/2026.")).toBe("Seen [DATE 1].");
    expect(shift("Seen 03/04/2026.", false)).toBe("Seen [DATE 1].");
    // A day over 12 settles it either way, and the same day and month too.
    expect(shift("Seen 25/12/2026.", false)).toBe("Seen 26/12/2026.");
    expect(shift("Seen 12/25/2026.")).toBe("Seen 12/26/2026.");
    expect(shift("Seen 04/04/2026.")).toBe("Seen 05/04/2026.");
  });

  it("takes out the details root-c2's probe found missed (#72 review)", () => {
    const out = (text: string, names: string[] = []) =>
      deidentify(text, { knownNames: names, dateShiftDays: 40 }).toSend;
    // Accented names, and surnames after a particle.
    expect(out("Patient: Émilie Tremblay")).toBe("Patient: [NAME 1]");
    expect(out("Patient: Jean de la Cruz")).toBe("Patient: [NAME 1]");
    expect(out("Patient: Renée O'Brien-Lévesque")).toBe("Patient: [NAME 1]");
    // A French street address, street type first.
    expect(
      out("Address 1234, rue Sherbrooke Est, Montréal, QC H2X 1A1"),
    ).not.toMatch(/Sherbrooke|1234|Montréal|H2X/);
    // Dates of birth in every common form, and other dates in them shifted.
    for (const dob of [
      "Born 1958/03/02.",
      "DOB: 1958-Mar-02",
      "DOB 02-Mar-1958",
      "Date of birth: March 2, 1958",
      "Date de naissance : 2 mars 1958",
      "Née le 2 mars 1958",
      "DOB: 02/03/58",
    ])
      expect(out(dob), dob).not.toMatch(/1958|\b58\b/);
    expect(out("Seen 2026/10/17.")).toBe("Seen 2026/11/26.");
    expect(out("Seen 2026-Oct-17.")).toBe("Seen 2026-Nov-26.");
    expect(out("Vu le 17 octobre 2026.")).toBe("Vu le 26 novembre 2026.");
    expect(out("Date: 17/10/26.")).toBe("Date: 26/11/26.");
    // Bare ten-digit numbers: a phone, an Ontario card, a BC PHN.
    expect(out("Call 6135550199 or HCN 1234567890")).not.toMatch(/\d{4}/);
    expect(out("Card 1234 567 890 on file")).toBe(
      "Card [HEALTH CARD 1] on file",
    );
    expect(out("PHN 9123456789")).not.toMatch(/\d{4}/);
    // A labelled card number stops at its digits and version code.
    expect(
      out(
        "Health card: 1234567890 AB Seen for follow-up of major depressive disorder",
      ),
    ).toBe(
      "Health card: [HEALTH CARD 1] Seen for follow-up of major depressive disorder",
    );
    // A profile name made of common words is removed as a name, not as words.
    expect(
      out("Major Iris came in. Major depressive disorder. Iris normal.", [
        "Major Iris",
      ]),
    ).toBe("[NAME 1] came in. Major depressive disorder. Iris normal.");
    // A department or a modality is not a clinic.
    expect(out("CT Imaging shows no mass. Diagnostic Imaging reviewed.")).toBe(
      "CT Imaging shows no mass. Diagnostic Imaging reviewed.",
    );
  });

  it("takes the whole name after a label, surname first or in capitals (#80 review)", () => {
    // The profile name is not the legal name, so only the label finds it.
    const out = (text: string, names = ["Maggie Notreal"]) =>
      deidentify(text, { knownNames: names, dateShiftDays: 40 }).toSend;
    for (const [text, sent] of [
      ["Patient: Notreal, Margaret", "Patient: [NAME 1]"],
      ["PATIENT: NOTREAL, MARGARET", "PATIENT: [NAME 1]"],
      ["PATIENT: MARGARET NOTREAL", "PATIENT: [NAME 1]"],
      ["Patient Name: Notreal, Margaret A.", "Patient Name: [NAME 1]."],
      ["Nom : Notreal, Marie-Ève", "Nom : [NAME 1]"],
      ["Pt: Margaret Notreal", "Pt: [NAME 1]"],
      ["Patient - Margaret Notreal", "Patient - [NAME 1]"],
      // The next label on the line is not more of the name.
      [
        "RE: NOTREAL, MARGARET  DOB: 1972-05-09",
        "RE: [NAME 1]  DOB: [DATE OF BIRTH 1]",
      ],
      [
        "Emergency contact: MACEXAMPLE, ROWAN  Tel: 613-555-0131",
        "Emergency contact: [NAME 1]  Tel: [PHONE 1]",
      ],
    ])
      expect(out(text), text).toBe(sent);
    // Someone with no profile name: an apostrophe, a Mac, a particle.
    for (const name of [
      "O'Sample, Sean",
      "MacExample, Rowan",
      "de la Testa, Maria",
    ])
      expect(out(`Patient: ${name}`, [])).toBe("Patient: [NAME 1]");
    // No name follows: a hyphenated word, a subject line, "Not".
    for (const text of [
      "Patient-centred care.",
      "RE: CT CHEST WITH CONTRAST\nChest clear.",
      "Re: Chest pain",
      "Patient - Not Applicable",
      "Patient: Stable overnight.",
      "RE: FOLLOW UP",
    ])
      expect(out(text, [])).toBe(text);
  });

  it("takes out clinicians named with initials, in a signature or by their title (#80 review)", () => {
    const out = (text: string) =>
      deidentify(text, { knownNames: [], dateShiftDays: 40 }).toSend;
    expect(out("Dr. J. Testcase reviewed.")).toBe("Dr. [DOCTOR 1] reviewed.");
    expect(out("cc: Dr. A. Sample; Dr. B. Fakename")).toBe(
      "cc: Dr. [DOCTOR 1]; Dr. [DOCTOR 2]",
    );
    // Surname first: the same doctor as "Dr. Testcase".
    expect(
      out("Electronically signed by Testcase, Quinn, MD. Dr. Testcase called."),
    ).toBe("Electronically signed by [DOCTOR 1], MD. Dr. [DOCTOR 1] called.");
    expect(out("Jane Notreal, MD\nSigned Morgan Testcase, NP")).toBe(
      "[DOCTOR 1], MD\nSigned [DOCTOR 2], NP",
    );
    expect(out("Nurse Practitioner Jane Notreal saw her.")).toBe(
      "Nurse Practitioner [NAME 1] saw her.",
    );
    // A title and a colon, as a label: the whole title, then the name.
    for (const [text, sent] of [
      ["Nurse Practitioner: Quinn Testcase", "Nurse Practitioner: [NAME 1]"],
      ["Nurse: Quinn Testcase", "Nurse: [NAME 1]"],
      ["NP: Quinn Testcase", "NP: [NAME 1]"],
      ["Midwife: Quinn Testcase, RM", "Midwife: [NAME 1], RM"],
      [
        "Infirmière praticienne : Quinn Testcase",
        "Infirmière praticienne : [NAME 1]",
      ],
    ])
      expect(out(text), text).toBe(sent);
    // No one is named here.
    for (const text of [
      "Referred by Emergency.",
      "Pharmacist Notes: none. Social Worker Assessment done.",
      "PLEASE, DO NOT RESUSCITATE.",
    ])
      expect(out(text)).toBe(text);
    // A hospital's header in capitals is a clinic, in English and French.
    expect(
      out(
        "SAMPLETOWN GENERAL HOSPITAL\nCENTRE HOSPITALIER DE FICTIVEVILLE\nDIAGNOSTIC IMAGING",
      ),
    ).toBe("[CLINIC 1]\n[CLINIC 2]\nDIAGNOSTIC IMAGING");
    // A postal code in lower case, without its space.
    expect(out("Mailing k1a0b1 please")).toBe("Mailing [POSTAL CODE 1] please");
  });

  it("removes a name found once wherever else it stands (#72 review)", () => {
    const out = (text: string) =>
      deidentify(text, { knownNames: [], dateShiftDays: 10 }).toSend;
    expect(out("Mrs. Avery Example and Avery")).toBe(
      "Mrs. [NAME 1] and [NAME 1]",
    );
    // A whole name in any case; one word only written as a name.
    expect(
      out(
        "Mrs. Avery Example came in. Later Avery said AVERY, avery example and avery.",
      ),
    ).toBe(
      "Mrs. [NAME 1] came in. Later [NAME 1] said [NAME 1], [NAME 1] and avery.",
    );
    // Before the label, too, and each part of a hyphenated surname.
    expect(
      out("Renée O'Neil-Smith, Patient: Renée O'Neil-Smith. Smith agreed."),
    ).toBe("[NAME 1], Patient: [NAME 1]. [NAME 1] agreed.");
    // A doctor's first name keeps the doctor's placeholder.
    expect(
      out("Dr. Blake Sample saw her. Blake will call; Sample agrees."),
    ).toBe("Dr. [DOCTOR 1] saw her. [DOCTOR 1] will call; [DOCTOR 1] agrees.");
    // A surname particle is not a name, and neither is an ordinary word.
    expect(
      out("Son conjoint, Jean de la Cruz. Jean viendra. La date de la visite."),
    ).toBe("Son conjoint, [NAME 1]. [NAME 1] viendra. La date de la visite.");
    expect(out("Mrs. Rose Major. Major depressive disorder; rose 2 kg.")).toBe(
      "Mrs. [NAME 1]. Major depressive disorder; rose 2 kg.",
    );
    // What follows a label but is no name is not swept through the text.
    for (const text of [
      "Re: Follow-up visit for chest pain. Follow-up in 2 weeks; follow-up booked.",
      "Patient: Seen today for review. Seen again; seen by the nurse.",
    ])
      expect(out(text)).toBe(text);
    expect(out("Contact: Mother Teresa Clinic staff. Her mother called.")).toBe(
      "Contact: [CLINIC 1] staff. Her mother called.",
    );
    expect(out("Dr. Casey Ward saw her. Admitted to the ward on day 3.")).toBe(
      "Dr. [DOCTOR 1] saw her. Admitted to the ward on day 3.",
    );
  });

  it("keeps an everyday word that is also a found name, and flags it for the preview (#72 review)", () => {
    const run10 = (text: string, names: string[] = []) =>
      deidentify(text, { knownNames: names, dateShiftDays: 10 });
    /** The flagged words, checked to stand where the preview would show them. */
    const flagged = (result: ReturnType<typeof run10>) =>
      result.onDevice.possibleNames.map((possible) => {
        expect(result.toSend.slice(possible.sentStart, possible.sentEnd)).toBe(
          possible.original,
        );
        return possible.original;
      });
    const ward = run10("Dr. Ward saw her. Admitted to the ward on day 3.");
    expect(ward.toSend).toBe(
      "Dr. [DOCTOR 1] saw her. Admitted to the ward on day 3.",
    );
    expect(flagged(ward)).toEqual(["ward"]);
    const asthma = run10(
      "Dr. Young saw Mrs. Long. A young adult with long-standing asthma.",
    );
    expect(asthma.toSend).toBe(
      "Dr. [DOCTOR 1] saw Mrs. [NAME 1]. A young adult with long-standing asthma.",
    );
    expect(flagged(asthma)).toEqual(["young", "long"]);
    const price = run10(
      "Dr. Price and Dr. Grant agree. The price of the inhaler is high. We will grant the request.",
    );
    expect(price.toSend).toBe(
      "Dr. [DOCTOR 1] and Dr. [DOCTOR 2] agree. The price of the inhaler is high. We will grant the request.",
    );
    expect(flagged(price)).toEqual(["price", "grant"]);
    // Written as a name, it goes.
    expect(run10("Dr. Grant agrees. Grant will call.").toSend).toBe(
      "Dr. [DOCTOR 1] agrees. [DOCTOR 1] will call.",
    );
    // A profile name's word goes in any case (AI-01): the vault knows it
    // is a name, and the preview shows the removal.
    const profile = run10("Seen with Avery. For example, avery.", [
      "Avery Example",
    ]);
    // "example, avery" reads as the name surname first.
    expect(profile.toSend).toBe("Seen with [NAME 1]. For [NAME 1].");
    expect(flagged(profile)).toEqual([]);
    // One tap removes a flagged word; the others stay flagged, in place.
    const [first] = price.onDevice.possibleNames;
    const removed = removeMore(price, first.sentStart, first.sentEnd);
    expect(removed.toSend).toContain("The [REMOVED 1] of the inhaler");
    expect(flagged(removed)).toEqual(["grant"]);
    // Nothing flagged is sent as a flag: serializing gives only the text.
    expect(JSON.parse(JSON.stringify(price))).toEqual({ toSend: price.toSend });
  });

  it("shifts a two-digit-year date only after a date label (#72 review)", () => {
    const out = (text: string) =>
      deidentify(text, { knownNames: [], dateShiftDays: 40 }).toSend;
    // Bare, "1/2/24" is as likely a ratio or a dose as a date.
    for (const text of [
      "Ratio 1/2/24 today.",
      "Seen 17/10/26.",
      "Titrate 5/10/20 mg.",
    ])
      expect(out(text)).toBe(text);
    expect(out("Date: 17/10/26.")).toBe("Date: 26/11/26.");
    expect(out("Visit date: 17/10/26")).toBe("Visit date: 26/11/26");
    expect(out("Date de la visite : 17/10/26")).toBe(
      "Date de la visite : 26/11/26",
    );
    expect(out("Letter dated 17/10/26.")).toBe("Letter dated 26/11/26.");
    // A four-digit year needs no label; a date of birth is removed either way.
    expect(out("Seen 17/10/2026.")).toBe("Seen 26/11/2026.");
    expect(out("DOB: 02/03/58")).toBe("DOB: [DATE OF BIRTH 1]");
  });

  it("leaves clinical numbers alone", () => {
    const text =
      "BP 120/80, HR 72, Hb 132 g/L, K 5.4 mmol/L, eGFR 61. Ramipril 10 mg, " +
      "1/2 tablet twice daily, 2 x 500 mg. ICD-10 I10. Weight 72.5 kg. " +
      "Next dose in 3-4 days. Ref range 3.5-5.0, 12.5-15.0. Platelets 250 x10^9/L. " +
      "INR 1.1. Glucose 5.6. Lot 4471. Pager 2231.";
    const result = deidentify(text, { knownNames: [], dateShiftDays: 10 });
    expect(result.toSend).toBe(text);
    expect(result.onDevice.removed).toEqual([]);
  });

  it("chooses a shift of 30 to 365 days, always earlier, when none is given", () => {
    for (let round = 0; round < 20; round++) {
      const { dateShiftDays, removed } = deidentify("Seen 2026-10-01.", {
        knownNames: [],
      }).onDevice;
      expect(dateShiftDays).toBeLessThanOrEqual(-30);
      expect(dateShiftDays).toBeGreaterThanOrEqual(-365);
      expect(removed[0].replacement < "2026-10-01").toBe(true);
    }
  });

  it("lets the patient remove more from the preview", () => {
    const result = run(referral);
    const age = result.toSend.indexOf("65-year-old");
    const more = removeMore(result, age, age + "65-year-old".length);
    expect(more.toSend).toContain("Mrs. [NAME 1], a [REMOVED 1] woman");
    expect(more.toSend).not.toContain("65-year-old");
    // Nothing else changed: every other placeholder is where it was.
    expect(more.toSend.replace("[REMOVED 1]", "65-year-old")).toBe(
      result.toSend,
    );
    // Positions stay right for a second removal after the first.
    const ramipril = more.toSend.indexOf("ramipril");
    const again = removeMore(more, ramipril, ramipril + "ramipril".length);
    expect(again.toSend).toContain("She takes [REMOVED 2] 5 mg daily.");
    // A part that is already a placeholder cannot be removed again.
    const placeholder = result.toSend.indexOf("[NAME 1]");
    expect(() => removeMore(result, placeholder, placeholder + 3)).toThrow(
      RangeError,
    );
  });

  it("fills the details back into an answer, on the device", () => {
    const result = run(referral);
    const answer =
      "[NAME 1] should ask [DOCTOR 1] about the ECG on 2026-10-05 " +
      "and bring it to [CLINIC 2].";
    expect(restore(answer, result)).toBe(
      "Avery EXAMPLE should ask Blake Sample about the ECG on 2026-09-25 " +
        "and bring it to Riverside Cardiology Clinic.",
    );
    // A placeholder it did not make is left as it is.
    expect(restore("[NAME 9] and [PHONE 99]", result)).toBe(
      "[NAME 9] and [PHONE 99]",
    );
  });

  it("gives only the text to send when the result is serialized", () => {
    const result = run(referral);
    // A caller that sends the whole object, by mistake, sends no original.
    const serialized = JSON.stringify(result);
    expect(JSON.parse(serialized)).toEqual({ toSend: result.toSend });
    for (const part of result.onDevice.removed)
      if (part.kind !== "date")
        expect(serialized, part.original).not.toContain(part.original);
    expect(Object.keys(result)).toEqual(["toSend"]);
  });

  it("uses no network: plain text in, plain text out", () => {
    for (const file of [source, cleaningSource]) {
      expect(file).not.toMatch(
        /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|@tauri-apps|invoke\(|https?:\/\//,
      );
      // Only the text cleaning and its generated table, next to this file.
      for (const line of file.match(/^import .*$/gm) ?? [])
        expect(line).toMatch(
          /from "\.\/(textCleaning|unicodeCleaningTable)";$/,
        );
    }
  });
});

// ---------------------------------------------------------------- part B

import extractedLetter from "./fixtures/extracted-letter.txt?raw";
import extractedLab from "./fixtures/extracted-lab-report.txt?raw";
import { DEFAULT_LABELS } from "./deidentify";

describe("the name remover, part B (#72, threat model AI-01)", () => {
  const out = (
    text: string,
    options: Partial<Parameters<typeof deidentify>[1]> = {},
  ) => deidentify(text, { knownNames: [], dateShiftDays: -40, ...options });

  /** Every removal stands where it says, in the source and in the text to
   * send. */
  const consistent = (result: ReturnType<typeof deidentify>) => {
    const { removed, possibleNames, source } = result.onDevice;
    for (const part of removed) {
      expect(source.slice(part.start, part.end)).toBe(part.original);
      expect(result.toSend.slice(part.sentStart, part.sentEnd)).toBe(
        part.replacement,
      );
    }
    for (const possible of possibleNames)
      expect(result.toSend.slice(possible.sentStart, possible.sentEnd)).toBe(
        possible.original,
      );
  };

  it("takes every listed detail out of the extracted letter", () => {
    const result = out(extractedLetter, {
      knownNames: ["Łukasz Żółć", "王小明"],
      knownBirthDates: ["1933-02-11"],
      knownClinics: ["Clinique médicale Fictive"],
      knownDoctors: ["Jan Kowalski"],
    });
    consistent(result);
    const text = result.toSend;
    for (const detail of [
      "Clinique médicale Fictive",
      "boul. René-Lévesque",
      "Montréal",
      "H2X 1A1",
      "514-555-0199",
      "514-555-0198",
      "www.clinique-fictive.example.ca",
      "clinique-fictive.example.ca/patients",
      "https://portal.example.org/results?id=4471",
      "Kowalski",
      "Hôpital Fictif de Testville",
      "ŻÓŁĆ",
      "Łukasz",
      "Żółć",
      "1933-02-11",
      "046 454 286",
      "SP-2025-00417",
      "92-year-old",
      "王小明",
      "Ewa",
      "03/04/2025",
      "17/10/25",
      "October 6, 2025",
      "March 2024",
      "Côté-Lévesque",
    ])
      expect(text, detail).not.toContain(detail);
    // The year after "since" moved with its 1 July: forty days earlier
    // keeps the year, so the removal is checked, not the text.
    expect(
      result.onDevice.removed.find((part) => part.original === "2019")?.kind,
    ).toBe("date");
    for (const clinical of [
      "amlodipine 5 mg",
      "138/84",
      "normal ejection fraction",
      "Platelets 250 x10⁹/L",
      "Dose 5 µg daily; results ≥ 10 are flagged.",
    ])
      expect(text, clinical).toContain(clinical);
    const kinds = new Set(result.onDevice.removed.map((part) => part.kind));
    for (const kind of [
      "clinic",
      "doctor",
      "name",
      "address",
      "postalCode",
      "phone",
      "web",
      "sin",
      "recordNumber",
      "dateOfBirth",
      "age",
      "unclearDate",
      "date",
    ])
      expect(kinds, kind).toContain(kind);
  });

  it("takes every listed detail out of the lab report as the reader extracts it", () => {
    const result = out(extractedLab, {
      knownNames: ["Avery Example", "Jordan Example"],
      knownBirthDates: ["1961-04-17"],
    });
    consistent(result);
    const text = result.toSend;
    // The cleaned text has no zero-width characters and keeps the visible
    // marks of the symbol font as U+FFFD.
    expect(result.onDevice.source).not.toMatch(/[​­]/);
    expect(result.onDevice.cleaning).toEqual({
      replacedRuns: 3,
      droppedCodePoints: 3,
    });
    expect(text).toContain("Dose 5 �g; results � 10 are flagged � 2.");
    for (const detail of [
      "EXAMPLE",
      "Avery",
      "Avеry",
      "Jordan",
      "９１２３ ４５６ ７８９",
      "17-Apr-1961",
      "H00012345",
      "SP-26-0099812",
      "Testcase",
      "Morgan",
      "Tuesday, 2026-10-08",
      "Sept 2026",
      "1-800-555-0100",
      "results@lab.example.org",
    ])
      expect(text, detail).not.toContain(detail);
    expect(text).not.toMatch(/avery|example|jordan/i);
    expect(text).toContain(
      "Potassium            5.4        mmol/L     3.5-5.0     H",
    );
    expect(text).toContain("aged 65");
    expect(
      result.onDevice.removed.find((part) => part.original === "2024")?.kind,
    ).toBe("date");
    // The weekday moved with its date, forty days earlier.
    expect(text).toContain("Collected:   Saturday, 2026-08-29 07:40");
  });

  it("removes a known birth date wherever it stands, in any form", () => {
    for (const text of [
      "Born 17 April 1961.",
      "Seen 1961-04-17.",
      "Date 17/04/1961 and 04/17/1961.",
      "On Apr. 17, 1961 she was born.",
    ]) {
      const result = out(text, { knownBirthDates: ["1961-04-17"] });
      expect(result.toSend, text).not.toContain("1961");
      expect(
        result.onDevice.removed.every((part) => part.kind === "dateOfBirth"),
        text,
      ).toBe(true);
    }
    // Another date is only moved.
    expect(
      out("Seen 1961-04-18.", { knownBirthDates: ["1961-04-17"] }).toSend,
    ).toBe("Seen 1961-03-09.");
  });

  it("takes a vault name in either order, surname first, and in any case", () => {
    const names = ["Avery Example"];
    for (const text of [
      "Patient: Example, Avery",
      "EXAMPLE, AVERY was seen",
      "Example Avery was seen",
      "avery example was seen",
      "Seen: AVERY",
    ]) {
      const result = out(text, { knownNames: names });
      expect(result.toSend, text).not.toMatch(/avery|example/i);
      expect(
        result.onDevice.removed.map((part) => part.replacement),
        text,
      ).toEqual(["[NAME 1]"]);
    }
    // Accents and look-alike letters fold: Côté stands as Cote and as Cоté.
    expect(
      out("Seen Renee COTE and Cоté.", { knownNames: ["Renée Côté"] }).toSend,
    ).toBe("Seen [NAME 1] and [NAME 1].");
    // Polish letters fold too.
    expect(
      out("Seen Lukasz Zolc.", { knownNames: ["Łukasz Żółć"] }).toSend,
    ).toBe("Seen [NAME 1].");
    // A Han name of two characters stands alone; a Latin part under three
    // letters, a common word and a relationship word do not.
    expect(
      out("王小明 and 小明 came.", { knownNames: ["王小明"] }).toSend,
    ).toBe("[NAME 1] and [NAME 1] came.");
    expect(
      out("Jo and Mom and the major issue.", {
        knownNames: ["Jo Major", "Mom"],
      }).toSend,
    ).toBe("Jo and Mom and the major issue.");
    // A vault name that is also a disease name is shown as a removal, for
    // the preview to show (false positives are the patient's call).
    const graves = out("Graves disease. Addison's disease.", {
      knownNames: ["Pat Graves", "Sam Addison"],
    });
    expect(graves.toSend).toBe("[NAME 1] disease. [NAME 2]'s disease.");
  });

  it("takes the vault's known clinic and doctor names, in any case", () => {
    const result = out(
      "Sent by maplewood family health team. Seen by Blake Sample; SAMPLE, Blake signed.",
      {
        knownClinics: ["Maplewood Family Health Team"],
        knownDoctors: ["Blake Sample"],
      },
    );
    expect(result.toSend).toBe(
      "Sent by [CLINIC 1]. Seen by [DOCTOR 1]; [DOCTOR 1] signed.",
    );
  });

  it("moves dates back only, with the weekday, and month and year forms", () => {
    const shift = (text: string) => out(text).toSend;
    expect(shift("Seen Monday, October 6, 2025.")).toBe(
      "Seen Wednesday, August 27, 2025.",
    );
    expect(shift("Vu le lundi 6 octobre 2025.")).toBe(
      "Vu le mercredi 27 août 2025.",
    );
    expect(shift("Thu. 2026-01-15")).toBe("Sat. 2025-12-06");
    // A month and a year move with the 15th; a year alone, after a cue,
    // with its 1 July.
    expect(shift("Started in March 2024 and in 2019; born in 2019.")).toBe(
      "Started in February 2024 and in 2019; born in 2019.",
    );
    expect(out("since 2019", { dateShiftDays: -200 }).toSend).toBe(
      "since 2018",
    );
    expect(shift("depuis 2019 et en octobre 2026")).toBe(
      "depuis 2019 et en septembre 2026",
    );
    // No cue, no change: a bare year or a number is not a date.
    expect(shift("Lot 2019, 2019 tablets")).toBe("Lot 2019, 2019 tablets");
    // Every moved date is earlier.
    const { removed } = out(
      "A 2026-10-08, B October 8, 2026, C 8 octobre 2026, D 28/10/2026.",
    ).onDevice;
    expect(removed).toHaveLength(4);
    for (const part of removed) expect(part.kind).toBe("date");
  });

  it("removes an ambiguous numeric date instead of moving it", () => {
    const result = out("Echo of 03/04/2025 and 25/04/2025; Date: 1/2/24.");
    expect(result.toSend).toBe(
      "Echo of [DATE 1] and 16/03/2025; Date: [DATE 2].",
    );
    expect(result.onDevice.removed.map((part) => part.kind)).toEqual([
      "unclearDate",
      "date",
      "unclearDate",
    ]);
    // A date of birth is removed as one whichever way it reads.
    expect(
      out("DOB 03/04/1961", { knownBirthDates: ["1961-03-04"] }).onDevice
        .removed[0].kind,
    ).toBe("dateOfBirth");
  });

  it("takes out web addresses, ages of 90 and over, social insurance and specimen numbers", () => {
    expect(
      out("See www.example.com/info and https://x.example.org/a?b=1.").toSend,
    ).toBe("See [WEB ADDRESS 1] and [WEB ADDRESS 2].");
    expect(
      out(
        "A 92-year-old man, aged 95, 101 yo; une femme âgée de 90 ans; 65-year-old.",
      ).toSend,
    ).toBe("A [AGE 1] man, [AGE 2], [AGE 3]; une femme [AGE 4]; 65-year-old.");
    expect(out("SIN: 046454286, NAS 046 454 286, 046-454-286.").toSend).toBe(
      "SIN: [SIN 1], NAS [SIN 2], [SIN 3].",
    );
    // A phone number is not one.
    expect(out("Call 613-555-0142.").toSend).toBe("Call [PHONE 1].");
    expect(
      out("Specimen #: SP-26-0099812; Sample ID: 44A7; Specimen: urine.")
        .toSend,
    ).toBe(
      "Specimen #: [RECORD NUMBER 1]; Sample ID: [RECORD NUMBER 2]; Specimen: urine.",
    );
  });

  it("writes the placeholders in the app's language, and keeps them for later removals", () => {
    const labels = { ...DEFAULT_LABELS, name: "NOM", manual: "RETIRÉ" };
    const result = out("Patient: Émilie Tremblay; voir plus loin.", { labels });
    expect(result.toSend).toBe("Patient: [NOM 1]; voir plus loin.");
    const at = result.toSend.indexOf("voir");
    const more = removeMore(result, at, at + 4);
    expect(more.toSend).toBe("Patient: [NOM 1]; [RETIRÉ 1] plus loin.");
    expect(more.onDevice.labels).toEqual(labels);
    // `removeMore` keeps how dates were read.
    const monthFirst = out("Seen 03/04/2025 and 05/06/2025.", {
      dayFirst: false,
      knownBirthDates: ["2025-05-06"],
    });
    expect(monthFirst.onDevice.dayFirst).toBe(false);
    const moreStill = removeMore(monthFirst, 0, 4);
    expect(moreStill.onDevice.dayFirst).toBe(false);
    expect(moreStill.toSend).toBe(
      "[REMOVED 1] [DATE 1] and [DATE OF BIRTH 1].",
    );
  });

  it("takes a placeholder or a moved date into a removal when told to (AI-02)", () => {
    const result = out("Seen Avery on 2026-10-08 at the clinic.", {
      knownNames: ["Avery Example"],
    });
    expect(result.toSend).toBe("Seen [NAME 1] on 2026-08-29 at the clinic.");
    // A hit inside the moved date takes the whole date.
    const at = result.toSend.indexOf("08-29");
    const over = removeMore(result, at, at + 2, { over: true });
    expect(over.toSend).toBe("Seen [NAME 1] on [REMOVED 1] at the clinic.");
    expect(() => removeMore(result, at, at + 2)).toThrow(RangeError);
    // A range across a placeholder and text takes both.
    const across = result.toSend.indexOf("[NAME 1] on");
    const both = removeMore(result, across + 3, across + 11, { over: true });
    expect(both.toSend).toBe("Seen [REMOVED 1] 2026-08-29 at the clinic.");
    expect(both.onDevice.removed.map((part) => part.kind)).toEqual([
      "manual",
      "date",
    ]);
  });

  it("finds a detail split by hidden characters or written in full-width digits", () => {
    const result = out(
      "Health card ９１２３ ４５６ ７８９ for Av​ery Ex­ample.",
      {
        knownNames: ["Avery Example"],
      },
    );
    expect(result.toSend).toBe("Health card [HEALTH CARD 1] for [NAME 1].");
    consistent(result);
    expect(result.onDevice.removed[0].original).toBe("９１２３ ４５６ ７８９");
  });
});

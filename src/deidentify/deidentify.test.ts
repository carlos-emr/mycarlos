import { describe, expect, it } from "vitest";
import { deidentify, removeMore, restore, type Removed } from "./deidentify";
import source from "./deidentify.ts?raw";
import discharge from "./fixtures/discharge-summary.txt?raw";
import imaging from "./fixtures/imaging-report.txt?raw";
import lab from "./fixtures/lab-report.txt?raw";
import referral from "./fixtures/referral-letter.txt?raw";
import quebec from "./fixtures/quebec-referral.txt?raw";

// #72. Synthetic documents only: FAKE names, 555-01xx numbers, example.com
// addresses, made-up card and record numbers.
const knownNames = ["Avery Example", "Jordan Example", "Renée Côté"];
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
];

const kinds = (removed: Removed[]) => new Set(removed.map((part) => part.kind));

describe("the name remover (#72)", () => {
  for (const { name, text, gone, kept } of documents)
    it(`takes every listed detail out of the ${name}, and keeps the clinical text`, () => {
      const result = run(text);
      for (const detail of gone)
        expect(result.toSend, detail).not.toContain(detail);
      // Nor any word of a profile name, in any case.
      expect(result.toSend).not.toMatch(/avery|jordan|\bexample\b|renée|côté/i);
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

  it("reads a date like 03/04/2026 day first unless told otherwise", () => {
    const shift = (text: string, dayFirst?: boolean) =>
      deidentify(text, { knownNames: [], dateShiftDays: 1, dayFirst }).toSend;
    expect(shift("Seen 03/04/2026.")).toBe("Seen 04/04/2026.");
    expect(shift("Seen 03/04/2026.", false)).toBe("Seen 03/05/2026.");
    // A day over 12 settles it either way.
    expect(shift("Seen 25/12/2026.", false)).toBe("Seen 26/12/2026.");
    expect(shift("Seen 12/25/2026.")).toBe("Seen 12/26/2026.");
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
    // A profile name's word in lower case is flagged too.
    const profile = run10("Seen with Avery. For example, avery.", [
      "Avery Example",
    ]);
    expect(profile.toSend).toBe("Seen with [NAME 1]. For example, avery.");
    expect(flagged(profile)).toEqual(["example", "avery"]);
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

  it("chooses a shift of 30 to 365 days, earlier or later, when none is given", () => {
    for (let round = 0; round < 20; round++) {
      const { dateShiftDays } = deidentify("Seen 2026-10-01.", {
        knownNames: [],
      }).onDevice;
      expect(Math.abs(dateShiftDays)).toBeGreaterThanOrEqual(30);
      expect(Math.abs(dateShiftDays)).toBeLessThanOrEqual(365);
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
    expect(source).not.toMatch(
      /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|@tauri-apps|invoke\(|https?:\/\//,
    );
    expect(source).not.toMatch(/^import /m);
  });
});

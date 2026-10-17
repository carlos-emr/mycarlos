import { describe, expect, it } from "vitest";
import { deidentify, removeMore, restore, type Removed } from "./deidentify";
import source from "./deidentify.ts?raw";
import discharge from "./fixtures/discharge-summary.txt?raw";
import imaging from "./fixtures/imaging-report.txt?raw";
import lab from "./fixtures/lab-report.txt?raw";
import referral from "./fixtures/referral-letter.txt?raw";

// #72. Synthetic documents only: FAKE names, 555-01xx numbers, example.com
// addresses, made-up card and record numbers.
const knownNames = ["Avery Example", "Jordan Example"];
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
    ],
    kept: [
      "community-acquired pneumonia",
      "ceftriaxone 1 g IV daily",
      "amoxicillin 1 g PO three times daily for 5 days",
    ],
  },
];

const kinds = (removed: Removed[]) => new Set(removed.map((part) => part.kind));

describe("the name remover (#72)", () => {
  for (const { name, text, gone, kept } of documents)
    it(`takes every listed detail out of the ${name}, and keeps the clinical text`, () => {
      const result = run(text);
      for (const detail of gone)
        expect(result.text, detail).not.toContain(detail);
      // Nor any word of the patient's or her husband's name, in any case.
      expect(result.text).not.toMatch(/avery|jordan|\bexample\b/i);
      for (const clinical of kept) expect(result.text).toContain(clinical);
    });

  it("finds every kind of detail the ticket lists, across the documents", () => {
    const found = new Set(
      documents.flatMap(({ text }) => [...kinds(run(text).removed)]),
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
    const { text } = run(referral);
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
    const { text, removed } = run(referral);
    expect(removed.find((part) => part.kind === "dateOfBirth")?.original).toBe(
      "1961-04-17",
    );
    // Written as they were, ten days later: the seven days between the
    // start of the pain and the ECG stay seven.
    expect(text).toContain("October 12, 2026");
    expect(text).toContain("since September 28, 2026");
    expect(text).toContain("ECG on 2026-10-05");
    const lab10 = run(lab).text;
    expect(lab10).toContain("Collected: 2026-10-18 07:40");
    expect(lab10).toContain("(on or after 2026-11-01)");
    const imaging10 = run(imaging).text;
    expect(imaging10).toContain("Date: 22 October 2026");
    expect(imaging10).toContain("CT chest, 13 Mar 2025.");
    expect(imaging10).toContain("around Oct. 22, 2027.");
  });

  it("reads a date like 03/04/2026 day first unless told otherwise", () => {
    const shift = (text: string, dayFirst?: boolean) =>
      deidentify(text, { knownNames: [], dateShiftDays: 1, dayFirst }).text;
    expect(shift("Seen 03/04/2026.")).toBe("Seen 04/04/2026.");
    expect(shift("Seen 03/04/2026.", false)).toBe("Seen 03/05/2026.");
    // A day over 12 settles it either way.
    expect(shift("Seen 25/12/2026.", false)).toBe("Seen 26/12/2026.");
    expect(shift("Seen 12/25/2026.")).toBe("Seen 12/26/2026.");
  });

  it("leaves clinical numbers alone", () => {
    const text =
      "BP 120/80, HR 72, Hb 132 g/L, K 5.4 mmol/L, eGFR 61. Ramipril 10 mg, " +
      "1/2 tablet twice daily, 2 x 500 mg. ICD-10 I10. Weight 72.5 kg. " +
      "Next dose in 3-4 days. Ref range 3.5-5.0.";
    const result = deidentify(text, { knownNames: [], dateShiftDays: 10 });
    expect(result.text).toBe(text);
    expect(result.removed).toEqual([]);
  });

  it("chooses a shift of 30 to 365 days, earlier or later, when none is given", () => {
    for (let round = 0; round < 20; round++) {
      const { dateShiftDays } = deidentify("Seen 2026-10-01.", {
        knownNames: [],
      });
      expect(Math.abs(dateShiftDays)).toBeGreaterThanOrEqual(30);
      expect(Math.abs(dateShiftDays)).toBeLessThanOrEqual(365);
    }
  });

  it("lets the patient remove more from the preview", () => {
    const result = run(referral);
    const age = result.text.indexOf("65-year-old");
    const more = removeMore(result, age, age + "65-year-old".length);
    expect(more.text).toContain("Mrs. [NAME 1], a [REMOVED 1] woman");
    expect(more.text).not.toContain("65-year-old");
    // Nothing else changed: every other placeholder is where it was.
    expect(more.text.replace("[REMOVED 1]", "65-year-old")).toBe(result.text);
    // Positions stay right for a second removal after the first.
    const ramipril = more.text.indexOf("ramipril");
    const again = removeMore(more, ramipril, ramipril + "ramipril".length);
    expect(again.text).toContain("She takes [REMOVED 2] 5 mg daily.");
    // A part that is already a placeholder cannot be removed again.
    const placeholder = result.text.indexOf("[NAME 1]");
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

  it("uses no network: plain text in, plain text out", () => {
    expect(source).not.toMatch(
      /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|@tauri-apps|invoke\(|https?:\/\//,
    );
    expect(source).not.toMatch(/^import /m);
  });
});

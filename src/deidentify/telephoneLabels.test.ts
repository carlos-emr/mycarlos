import { describe, expect, it } from "vitest";
import { deidentify, restore } from "./deidentify";

// Synthetic numbers and names only. These are regression cases, not a holdout.
const run = (source: string) => deidentify(source, { knownNames: [] });

describe("telephone fields beside other fields", () => {
  const labels = ["Phone", "Telephone", "Téléphone", "Tél", "Fax", "FAX"];
  const separators = [" · ", "; ", " | ", ", ", "\t", "\n", "\r\n"];

  it("removes both local values without a colon", () => {
    const source = "Tel 555-0100 · Fax 555-0101";
    const result = run(source);
    expect(result.toSend).toBe("Tel [PHONE 1] · Fax [PHONE 2]");
    expect(restore(result.toSend, result)).toBe(source);
  });

  for (const label of labels) {
    it.each(separators)(
      `removes both values with ${label} after separator %j`,
      (separator) => {
        const source = `Tel 555-0100${separator}${label}: 555-0101`;
        const result = run(source);
        expect(result.toSend).toBe(
          `Tel [PHONE 1]${separator}${label}: [PHONE 2]`,
        );
        expect(result.onDevice.removed.map((part) => part.kind)).toEqual([
          "phone",
          "phone",
        ]);
        expect(restore(result.toSend, result)).toBe(source);
      },
    );

    it.each([" ", ": ", "# ", ". ", ":\n", ":\r\n\t"])(
      `reads ${label} before its value with %j`,
      (separator) => {
        const source = `${label}${separator}555-0100`;
        const result = run(source);
        expect(result.toSend).toBe(`${label}${separator}[PHONE 1]`);
        expect(result.onDevice.removed.map((part) => part.kind)).toEqual([
          "phone",
        ]);
        expect(restore(result.toSend, result)).toBe(source);
      },
    );
  }

  it.each(["5550100", "555 0100", "555.0100", "(613) 555-0100"])(
    "removes the whole value %j, preserving the labels and punctuation",
    (value) => {
      const source = `Fax: ${value}; Phone: ${value}.`;
      const result = run(source);
      expect(result.toSend).toBe("Fax: [PHONE 1]; Phone: [PHONE 1].");
      expect(result.onDevice.removed.map((part) => part.original)).toEqual([
        value,
        value,
      ]);
      expect(restore(result.toSend, result)).toBe(source);
    },
  );

  it("keeps mixed existing labels, international numbers and extensions protected", () => {
    const source =
      "Tel: 613-555-0100 ext. 42 · Fax: 555-0101\n" +
      "Móvil: +34 155 908 117; Tel. kom. 012 330 908; Telefone: (30) 98877-1203";
    const result = run(source);
    expect(result.onDevice.removed.map((part) => part.original)).toEqual([
      "613-555-0100 ext. 42",
      "555-0101",
      "+34 155 908 117",
      "012 330 908",
      "(30) 98877-1203",
    ]);
    expect(result.onDevice.removed.every((part) => part.kind === "phone")).toBe(
      true,
    );
    expect(restore(result.toSend, result)).toBe(source);
  });

  it("preserves record, date and person kinds beside telephone fields", () => {
    const source =
      "MRN: A0049921; Seen: 2026-05-14; Patient: Avery Example; Fax: 555-0100";
    const result = run(source);
    expect(result.onDevice.removed.map((part) => part.kind)).toEqual([
      "recordNumber",
      "date",
      "name",
      "phone",
    ]);
    expect(result.toSend).toBe(
      "MRN: [RECORD NUMBER 1]; Seen: [DATE 1]; Patient: [NAME 1]; Fax: [PHONE 1]",
    );
    expect(restore(result.toSend, result)).toBe(source);
  });

  it.each(labels)("leaves a date after %s to the date layer", (label) => {
    const source = `${label}: 2026-05-14`;
    const result = run(source);
    expect(result.toSend).toBe(`${label}: [DATE 1]`);
    expect(result.onDevice.removed.map((part) => part.kind)).toEqual(["date"]);
    expect(restore(result.toSend, result)).toBe(source);
  });

  it.each([
    "Telephones 555-0100",
    "Microphone: 555-0100",
    "Faxed: 555-0100",
    "Fax: A5550100",
    "Fax: 5550100Z",
    "Fax: 5550100-AB",
    "Fax: 5550100/AB",
    "Fax: 12 mg daily",
    "Fax:\n\n555-0100",
    "Phone: Avery Example",
    "Telephone service was discussed.",
    "Next dose in 3-4 days; reference range 3.5-5.0 mmol/L.",
  ])("does not turn nontelephone text into a phone: %j", (source) => {
    const result = run(source);
    expect(result.toSend).toBe(source);
    expect(result.onDevice.removed).toEqual([]);
  });
});

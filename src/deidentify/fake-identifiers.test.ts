import { describe, expect, it } from "vitest";

// Test data must be clearly fake: an identifier number in this folder's tests
// and fixtures must fail its own check digit, so that it can never be a real
// person's. Only these pass theirs, on purpose. Digits only.
const ALLOWED = new Map([
  ["046454286", "the Government of Canada's published sample SIN"],
  [
    "013704689",
    "a SIN a test needs checksum-valid; first digit 0 is not issued",
  ],
  [
    "026183400",
    "a SIN a test needs checksum-valid; first digit 0 is not issued",
  ],
]);

// This folder's tests and fixtures, as text. This file is left out: it holds
// the checkers' own examples.
const SOURCES = Object.entries({
  ...import.meta.glob<string>("./**/*.test.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob<string>("./fixtures/*", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
}).filter(([path]) => !path.endsWith("/fake-identifiers.test.ts"));

/** Luhn, as a SIN's last digit is. */
function luhnValid(digits: string): boolean {
  let total = 0;
  [...digits].reverse().forEach((char, index) => {
    let digit = Number(char);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    total += digit;
  });
  return total % 10 === 0;
}

/** A Spanish DNI (8 digits) or NIE (X, Y or Z, then 7 digits) and its letter. */
function dniValid(prefix: string, digits: string, letter: string) {
  const number = Number(prefix ? `${"XYZ".indexOf(prefix)}${digits}` : digits);
  return "TRWAGMYFPDXBNJZSQVHLCKE"[number % 23] === letter;
}

/** A Brazilian CPF's two check digits (11 digits). */
function cpfValid(digits: string): boolean {
  if (new Set(digits).size === 1) return false;
  const n = [...digits].map(Number);
  for (const k of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < k; i++) sum += n[i] * (k + 1 - i);
    if (((sum * 10) % 11) % 10 !== n[k]) return false;
  }
  return true;
}

/** A Polish PESEL's check digit (11 digits). */
function peselValid(digits: string): boolean {
  const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  const sum = weights.reduce((total, w, i) => total + w * Number(digits[i]), 0);
  return (10 - (sum % 10)) % 10 === Number(digits[10]);
}

// Only lines that name the identifier are read, so that a phone number or a
// count written in threes is never taken for one.
const SIN_LABEL = /\b(?:SIN|NAS)\b|[Ss]ocial [Ii]nsurance|assurance sociale/;
const SIN = /(?<![\d.-])(\d{3})([ .-]?)(\d{3})\2(\d{3})(?!\d)(?!-\d)/g;
const DNI_LABEL = /\b(?:DNI|NIE|NIF)\b/;
const DNI = /(?<![A-Za-z0-9])([XYZ]?)(\d{7,8})-?([A-Z])(?![A-Za-z0-9])/g;
const CPF = /(?<!\d)(\d{3})\.(\d{3})\.(\d{3})-(\d{2})(?!\d)/g;
const ELEVEN = /(?<!\d)(\d{11})(?!\d)/g;

/** Every identifier in `text` that passes its check digit and is not allowed. */
function realLookingIdentifiers(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    if (SIN_LABEL.test(line))
      for (const m of line.matchAll(SIN)) {
        const digits = m[1] + m[3] + m[4];
        if (luhnValid(digits) && !ALLOWED.has(digits))
          found.push(`SIN ${m[0]}`);
      }
    if (DNI_LABEL.test(line))
      for (const m of line.matchAll(DNI)) {
        const [, prefix, digits, letter] = m;
        const shaped = prefix ? digits.length === 7 : digits.length === 8;
        if (shaped && dniValid(prefix, digits, letter))
          found.push(`DNI/NIE ${m[0]}`);
      }
    for (const m of line.matchAll(CPF))
      if (cpfValid(m.slice(1, 5).join(""))) found.push(`CPF ${m[0]}`);
    if (line.includes("CPF"))
      for (const m of line.matchAll(ELEVEN))
        if (cpfValid(m[1])) found.push(`CPF ${m[1]}`);
    if (line.includes("PESEL"))
      for (const m of line.matchAll(ELEVEN))
        if (peselValid(m[1])) found.push(`PESEL ${m[1]}`);
  }
  return found;
}

describe("test data is clearly fake: no identifier that passes its check digit", () => {
  it("reads this folder's tests and fixtures", () => {
    const paths = SOURCES.map(([path]) => path);
    expect(paths).toContain("./deidentify.test.ts");
    expect(paths).toContain("./otherLanguages.test.ts");
    expect(paths).toContain("./fixtures/quebec-referral.txt");
  });

  it("finds none outside the named allow-list", () => {
    const found = SOURCES.flatMap(([path, text]) =>
      realLookingIdentifiers(text).map((what) => `${path}: ${what}`),
    );
    expect(found).toEqual([]);
  });

  it("would catch each kind, and lets the allowed ones and unlabelled numbers be", () => {
    // Non-personal values that pass their check digit: number 0 or 1, or an
    // impossible date.
    expect(realLookingIdentifiers("NAS : 000 000 018")).toEqual([
      "SIN 000 000 018",
    ]);
    expect(realLookingIdentifiers("DNI 00000000T")).toEqual([
      "DNI/NIE 00000000T",
    ]);
    expect(realLookingIdentifiers("CPF 000.000.001-91")).toEqual([
      "CPF 000.000.001-91",
    ]);
    expect(realLookingIdentifiers("PESEL 00000000000")).toEqual([
      "PESEL 00000000000",
    ]);
    // Their check digit changed: fake.
    expect(
      realLookingIdentifiers(
        "NAS 000 000 019, DNI 00000000A, CPF 000.000.001-92, PESEL 00000000001",
      ),
    ).toEqual([]);
    // Allowed, and the same digits without a label.
    expect(realLookingIdentifiers("SIN: 046 454 286; 013704689")).toEqual([]);
    expect(realLookingIdentifiers("Móvil: 000 000 018")).toEqual([]);
  });
});

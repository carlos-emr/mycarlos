import { describe, expect, it } from "vitest";
import { deidentify } from "./deidentify";

// A social insurance number written the French way, with the spaces and the space before the colon
// that French typing uses (including the no-break spaces): found and replaced (#214). The numbers
// are FAKE and invalid on purpose.

describe("a French-spaced social insurance number is found", () => {
  it.each([
    "NAS : 123 456 789.",
    "NAS\u00a0: 123\u00a0456\u00a0789.",
    "NAS : 123\u202f456\u202f789.",
    "N.A.S. 123 456 789.",
    "Numéro d'assurance sociale : 123 456 789.",
    "Numéro d’assurance sociale 123-456-789.",
    "NAS 123456789.",
    "NSS 123 456 789",
    "NAS (123 456 789)",
    "Numéro d'assurance sociale (NAS) : 123 456 789",
    "Mon NAS est le 123 456 789.",
  ])("%s", (text) => {
    const out = deidentify(text, { knownNames: [] }).toSend;
    expect(out).toContain("[SIN 1]");
    expect(out).not.toMatch(/123/);
  });
});

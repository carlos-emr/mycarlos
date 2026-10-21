import type { PatientProfile } from "../vault";

/** A patient name found on a document, and the birth date beside it if it
 * has one (prototype: the real text comes from the PDF helper, #63/#85). */
export interface FoundName {
  name: string;
  /** As written on the document, `YYYY-MM-DD`. */
  birthDate?: string;
}

/** A name's words, compared without case, accents or punctuation, in any
 * order: "SMITH, Mary" and "Mary Smith" are the same name. A middle name or
 * initial on one side and not the other is a different name. */
export function nameWords(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .sort()
    .join(" ");
}

export const sameName = (left: string, right: string) => {
  const words = nameWords(left);
  return words !== "" && words === nameWords(right);
};

/** The one person in the vault the found name matches, or null when none or
 * several do: a suggestion is only ever made for exactly one. People in the
 * vault have no birth date (VAULT_FORMAT), so only the name is compared. */
export function personFor(
  people: PatientProfile[],
  found: FoundName,
): PatientProfile | null {
  const matches = people.filter((person) =>
    sameName(person.displayName, found.name),
  );
  return matches.length === 1 ? matches[0] : null;
}

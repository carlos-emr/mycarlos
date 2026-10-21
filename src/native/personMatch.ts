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

/** What told the person apart, for the words of the suggestion. */
export type MatchedBy = "birthDate" | "birthDateAndName" | "name";

/** The name a person is known by on documents: their full name if the
 * patient gave one, else the name shown in the vault. */
const documentName = (person: PatientProfile) =>
  person.fullName?.trim() || person.displayName;

const only = (people: PatientProfile[], by: MatchedBy) =>
  people.length === 1 ? { person: people[0], by } : null;

/** The one person in the vault the found name and birth date match, or null
 * when none or several do: a suggestion is only ever made for exactly one
 * (Ben, 21 Oct). The birth date comes first, and the name tells twins apart.
 * A person whose birth date is known and differs is never a match. Without a
 * birth date on either side, the name alone must match one person. */
export function personFor(
  people: PatientProfile[],
  found: FoundName,
): { person: PatientProfile; by: MatchedBy } | null {
  const possible = people.filter(
    (person) =>
      !person.birthDate ||
      !found.birthDate ||
      person.birthDate === found.birthDate,
  );
  const named = (candidates: PatientProfile[]) =>
    candidates.filter((person) => sameName(documentName(person), found.name));
  if (found.birthDate) {
    const born = possible.filter(
      (person) => person.birthDate === found.birthDate,
    );
    if (born.length === 1) return only(born, "birthDate");
    if (born.length > 1) return only(named(born), "birthDateAndName");
  }
  return only(named(possible), "name");
}

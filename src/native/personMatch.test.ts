import { describe, expect, it } from "vitest";
import { nameWords, personFor, sameName } from "./personMatch";

const person = (
  id: string,
  displayName: string,
  details: { fullName?: string; birthDate?: string } = {},
) => ({ id, displayName, createdAtMs: 1, ...details });

describe("matching a name found on a document to a person (prototype)", () => {
  it("reads a name the same whatever its case, accents, commas or order", () => {
    expect(nameWords("SMITH, Mary")).toBe("mary smith");
    expect(sameName("Mary Smith", "SMITH, Mary")).toBe(true);
    expect(sameName("Zoë Łukasiewicz", "LUKASIEWICZ, ZOE")).toBe(false);
    expect(sameName("Zoë Côté", "COTE, Zoe")).toBe(true);
    // A middle initial on one side is another name, as is a missing one.
    expect(sameName("Mary A. Smith", "Mary Smith")).toBe(false);
    expect(sameName("", "")).toBe(false);
  });

  it("suggests the one person the name matches, and nobody when none or two do", () => {
    const people = [person("p1", "FAKE Jamie Example"), person("p2", "Mom")];
    expect(personFor(people, { name: "EXAMPLE, FAKE JAMIE" })).toEqual({
      person: people[0],
      by: "name",
    });
    expect(personFor(people, { name: "FAKE Mary Example" })).toBeNull();
    const twins = [...people, person("p3", "Jamie FAKE Example")];
    expect(personFor(twins, { name: "FAKE Jamie Example" })).toBeNull();
    // Without a birth date on the person, one on the document changes nothing.
    expect(
      personFor(people, { name: "FAKE Jamie Example", birthDate: "1990-01-02" })
        ?.person.id,
    ).toBe("p1");
  });

  it("goes by the birth date first, and by the name only to tell twins apart (Ben, 21 Oct)", () => {
    const mom = person("p1", "Mom", {
      fullName: "FAKE Mary Smith",
      birthDate: "1958-03-12",
    });
    const jamie = person("p2", "Jamie", { birthDate: "2012-06-02" });
    const riley = person("p3", "Riley", {
      fullName: "FAKE Riley Example",
      birthDate: "2012-06-02",
    });
    const people = [mom, jamie, riley];
    // One person born that day: them, whatever the name says.
    expect(
      personFor(people, { name: "SMITH, M.", birthDate: "1958-03-12" }),
    ).toEqual({ person: mom, by: "birthDate" });
    // Twins: the name (the full name, else the shown name) picks one.
    expect(
      personFor(people, {
        name: "EXAMPLE, FAKE RILEY",
        birthDate: "2012-06-02",
      }),
    ).toEqual({ person: riley, by: "birthDateAndName" });
    expect(
      personFor(people, { name: "JAMIE", birthDate: "2012-06-02" }),
    ).toEqual({ person: jamie, by: "birthDateAndName" });
    expect(
      personFor(people, { name: "FAKE Someone Else", birthDate: "2012-06-02" }),
    ).toBeNull();
    // A known birth date that differs rules a person out, even by name.
    expect(
      personFor(people, { name: "FAKE Mary Smith", birthDate: "1958-03-13" }),
    ).toBeNull();
    // No birth date on the document: the full name must match one person.
    expect(personFor(people, { name: "Mary SMITH, FAKE" })).toEqual({
      person: mom,
      by: "name",
    });
    // No one has the document's birth date: a person with no birth date of
    // their own can still match by name (one whose date differs cannot).
    const noDates = [person("p4", "FAKE Alex Example"), mom];
    expect(
      personFor(noDates, {
        name: "FAKE Alex Example",
        birthDate: "1999-09-09",
      }),
    ).toEqual({ person: noDates[0], by: "name" });
  });
});

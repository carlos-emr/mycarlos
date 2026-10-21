import { describe, expect, it } from "vitest";
import { nameWords, personFor, sameName } from "./personMatch";

const person = (id: string, displayName: string) => ({
  id,
  displayName,
  createdAtMs: 1,
});

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
    expect(personFor(people, { name: "EXAMPLE, FAKE JAMIE" })?.id).toBe("p1");
    expect(personFor(people, { name: "FAKE Mary Example" })).toBeNull();
    const twins = [...people, person("p3", "Jamie FAKE Example")];
    expect(personFor(twins, { name: "FAKE Jamie Example" })).toBeNull();
    // People have no birth date yet, so one on the document changes nothing.
    expect(
      personFor(people, { name: "FAKE Jamie Example", birthDate: "1990-01-02" })
        ?.id,
    ).toBe("p1");
  });
});

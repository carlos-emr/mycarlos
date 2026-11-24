import { describe, expect, it } from "vitest";
import type { ClinicPatient } from "../vault";
import { filesOnItsOwn } from "./FileUnder";

const clinic = (changes: Partial<ClinicPatient> = {}): ClinicPatient => ({
  name: "FAKE Patient",
  birthDate: "1980-05-20",
  ...changes,
});

describe("whether the next documents file themselves under a person", () => {
  it("does, when the link is tied to no one and no one else matches", () => {
    expect(filesOnItsOwn("p1", clinic())).toBe(true);
    expect(filesOnItsOwn("p1", clinic({ linkPerson: "p1" }))).toBe(true);
    expect(filesOnItsOwn("p1", clinic({ matchingPeople: ["p1"] }))).toBe(true);
  });

  it("does not, when the link is tied to a hidden person", () => {
    expect(filesOnItsOwn("p1", clinic({ linkedToHidden: true }))).toBe(false);
    // Whatever else the clinic says: a hidden person's link files under no one listed.
    expect(
      filesOnItsOwn(
        "p1",
        clinic({
          linkedToHidden: true,
          linkPerson: "p1",
          matchingPeople: ["p1"],
        }),
      ),
    ).toBe(false);
  });

  it("does not, when the link is tied to someone else, or two people match", () => {
    expect(filesOnItsOwn("p1", clinic({ linkPerson: "p2" }))).toBe(false);
    expect(filesOnItsOwn("p1", clinic({ matchingPeople: ["p1", "p2"] }))).toBe(
      false,
    );
  });
});

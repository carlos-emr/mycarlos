import { describe, expect, it } from "vitest";
import {
  dateText,
  changeLink,
  filedNotice,
  forgetLink,
  linkFor,
  linksFor,
  rememberLink,
  type ClinicDelivery,
} from "./clinicLinks";

const delivery = (overrides: Partial<ClinicDelivery> = {}): ClinicDelivery => ({
  id: "d1",
  clinicId: "clinic-1",
  clinicName: "FAKE Lakeside Clinic",
  provider: "FAKE Dr. Lee",
  patientName: "FAKE Mary Smith",
  patientBirthDate: "1958-03-12",
  title: "FAKE Blood work",
  kind: "Lab result",
  serviceDate: "2026-10-14",
  ...overrides,
});

describe("clinic links (prototype)", () => {
  it("remembers a clinic's patient under a person, once, and finds it again", () => {
    let links = rememberLink([], delivery(), "mom");
    links = rememberLink(links, delivery({ id: "d2" }), "mom");
    expect(links).toHaveLength(1);
    // The chart's name in another case or order is the same patient.
    expect(
      linkFor(links, delivery({ id: "d3", patientName: "SMITH, FAKE MARY" }))
        ?.profileId,
    ).toBe("mom");
    // Another birth date, or another clinic, is someone else.
    expect(linkFor(links, delivery({ patientBirthDate: "1960-01-01" }))).toBe(
      undefined,
    );
    expect(linkFor(links, delivery({ clinicId: "clinic-2" }))).toBe(undefined);
  });

  it("changes a link's person, forgets it, and skips one whose person is gone", () => {
    const links = rememberLink([], delivery(), "mom");
    const changed = changeLink(links, links[0], "jamie");
    expect(changed[0].profileId).toBe("jamie");
    expect(forgetLink(changed, changed[0])).toEqual([]);
    expect(linksFor(changed, ["mom"])).toEqual([]);
    expect(linksFor(changed, ["jamie"])).toEqual(changed);
  });

  it("writes the birth date and the filed notice plainly", () => {
    expect(dateText("1958-03-12")).toBe("12 Mar 1958");
    expect(dateText("not a date")).toBe("not a date");
    expect(
      filedNotice([{ clinicName: "FAKE Lakeside Clinic", personName: "Mom" }]),
    ).toBe("1 document from FAKE Lakeside Clinic was filed under Mom.");
    expect(
      filedNotice([
        { clinicName: "FAKE Lakeside Clinic", personName: "Mom" },
        { clinicName: "FAKE Lakeside Clinic", personName: "Mom" },
        { clinicName: "FAKE Hill Lab", personName: "Jamie" },
      ]),
    ).toBe(
      "2 documents from FAKE Lakeside Clinic were filed under Mom. 1 document from FAKE Hill Lab was filed under Jamie.",
    );
  });
});

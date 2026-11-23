import { describe, expect, it } from "vitest";
import {
  deidentify,
  keepAllAsMedicalTerm,
  keepAsMedicalTerm,
  keptEponymRanges,
  removeMore,
  restoreChecked,
} from "./deidentify";

// A lone word of a known name inside an eponym phrase is removed as before but marked, so the
// preview can offer "Keep as a medical term" (#214). FAKE names only.

const run = (text: string, names: string[]) =>
  deidentify(text, { knownNames: names });

describe("an eponym candidate is marked, never decided", () => {
  it("removes the word as before and marks the phrase", () => {
    const r = run("Marion Graves has Graves disease.", ["Marion Graves"]);
    expect(r.toSend).toBe("[NAME 1] has [NAME 1] disease.");
    const marked = r.onDevice.removed.filter((p) => p.eponym);
    expect(marked.map((p) => p.eponym)).toEqual(["Graves disease"]);
    expect(marked[0].original).toBe("Graves");
  });

  it("never marks a full name, a word after a title, or a surname-first name", () => {
    const r = run("Mrs. Graves; Marion Graves; Graves, Marion.", [
      "Marion Graves",
    ]);
    expect(r.onDevice.removed.some((p) => p.eponym)).toBe(false);
  });

  it("marks nothing for a word that is in no eponym phrase", () => {
    const r = run("Graves Street, Marion Graves.", ["Marion Graves"]);
    expect(r.onDevice.removed.some((p) => p.eponym)).toBe(false);
  });
});

describe("keeping a candidate", () => {
  const text = "Peter Bell: Bell's palsy. Bell's palsy again.";
  const once = "Peter Bell: Bell's palsy.";
  it("puts back just that occurrence, and paste-back still restores exactly", () => {
    const r = run(text, ["Peter Bell"]);
    const first = r.onDevice.removed.filter((p) => p.eponym)[0];
    const kept = keepAsMedicalTerm(r, first.sentStart, first.sentEnd);
    expect(kept.toSend).toBe("[NAME 1]: Bell's palsy. [NAME 1]'s palsy again.");
    // One phrase kept and nothing else removed restores exactly.
    const one = run(once, ["Peter Bell"]);
    const part = one.onDevice.removed.filter((p) => p.eponym)[0];
    const keptOne = keepAsMedicalTerm(one, part.sentStart, part.sentEnd);
    expect(keptOne.toSend).toBe("[NAME 1]: Bell's palsy.");
    expect(restoreChecked(keptOne.toSend, keptOne).text).toBe(once);
  });

  it("keeps all of one phrase", () => {
    const r = run(text, ["Peter Bell"]);
    const kept = keepAllAsMedicalTerm(r, "Bell's palsy");
    expect(kept.toSend).toBe("[NAME 1]: Bell's palsy. Bell's palsy again.");
    expect(restoreChecked(kept.toSend, kept).text).toBe(text);
  });

  it("refuses a part that is not a candidate", () => {
    const r = run(text, ["Peter Bell"]);
    const name = r.onDevice.removed[0];
    expect(() => keepAsMedicalTerm(r, name.sentStart, name.sentEnd)).toThrow(
      RangeError,
    );
  });
});

describe("a possessive of the patient's surname is a person, not a term (#366)", () => {
  it.each([
    ["Graves' son drove her.", "Marion Graves"],
    ["Bell's wife called.", "Peter Bell"],
    ["Bell’s wife called.", "Peter Bell"],
  ])("does not offer %j", (text, name) => {
    const r = run(`${name}. ${text}`, [name]);
    expect(r.onDevice.removed.some((p) => p.eponym)).toBe(false);
  });

  it("still offers a possessive inside a phrase that names the condition", () => {
    const r = run("Peter Bell: Bell's palsy.", ["Peter Bell"]);
    expect(
      r.onDevice.removed.filter((p) => p.eponym).map((p) => p.eponym),
    ).toEqual(["Bell's palsy"]);
  });

  it("reads a title at the end of the previous line as a title", () => {
    const r = run("Seen by Mrs.\nGraves for Graves disease.", [
      "Marion Graves",
    ]);
    // "Mrs." ends the line: the "Graves" after it is a person, the one in the phrase is offered.
    expect(
      r.onDevice.removed.filter((p) => p.eponym).map((p) => p.eponym),
    ).toEqual(["Graves disease"]);
  });
});

describe("the kept terms are named to the native re-check (#366)", () => {
  it("gives the range of each kept phrase in the text to send, and none before a keep", () => {
    const r = run("Peter Bell: Bell's palsy.", ["Peter Bell"]);
    expect(keptEponymRanges(r)).toEqual([]);
    const part = r.onDevice.removed.filter((p) => p.eponym)[0];
    const kept = keepAsMedicalTerm(r, part.sentStart, part.sentEnd);
    expect(kept.toSend).toBe("[NAME 1]: Bell's palsy.");
    const [range] = keptEponymRanges(kept);
    expect(kept.toSend.slice(range.start, range.end)).toBe("Bell's palsy");
    expect(keptEponymRanges(kept)).toHaveLength(1);
  });

  it("keeps naming a kept phrase after more is removed", () => {
    const r = run("Peter Bell: Bell's palsy. Call Dana Reed.", ["Peter Bell"]);
    const part = r.onDevice.removed.filter((p) => p.eponym)[0];
    const kept = keepAsMedicalTerm(r, part.sentStart, part.sentEnd);
    const at = kept.toSend.indexOf("Dana Reed");
    const more = removeMore(kept, at, at + "Dana Reed".length);
    expect(more.toSend).toContain("Bell's palsy");
    expect(more.toSend).not.toContain("Dana Reed");
    const [range] = keptEponymRanges(more);
    expect(more.toSend.slice(range.start, range.end)).toBe("Bell's palsy");
  });

  it("names the right places when the text holds a letter whose fold is longer (ß, ﬁ)", () => {
    const r = run("Straße ﬁle: Peter Bell: Bell's palsy.", ["Peter Bell"]);
    const part = r.onDevice.removed.filter((p) => p.eponym)[0];
    const kept = keepAsMedicalTerm(r, part.sentStart, part.sentEnd);
    const [range] = keptEponymRanges(kept);
    expect(kept.toSend.slice(range.start, range.end)).toBe("Bell's palsy");
  });

  it("does not offer a name made of several words on its own", () => {
    const r = run("Anne De Quervain saw De Quervain.", ["Anne De Quervain"]);
    expect(r.onDevice.removed.some((p) => p.eponym)).toBe(false);
  });
});

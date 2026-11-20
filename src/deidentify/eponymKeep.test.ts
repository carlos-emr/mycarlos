import { describe, expect, it } from "vitest";
import {
  deidentify,
  keepAllAsMedicalTerm,
  keepAsMedicalTerm,
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

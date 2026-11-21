import { describe, expect, it } from "vitest";
import { deidentify, restoreChecked } from "./deidentify";

// Dates written without a year ("Jan 28", "14 février", "2月14日"): never given a year, never given
// a gap, and numbered in month-and-day order after the dated ones (#213). FAKE text only.

const send = (text: string, knownNames: string[] = []) =>
  deidentify(text, { knownNames }).toSend;

describe("yearless dates are numbered in calendar order, whichever the text names first", () => {
  it.each([
    [
      "English month first",
      "Seen 2026-01-10. Review Feb 14, earlier Jan 28.",
      "Review [DATE 3], earlier [DATE 2].",
    ],
    [
      "English day first",
      "Seen 2026-01-10. Review 14 Feb, earlier 28 Jan.",
      "Review [DATE 3], earlier [DATE 2].",
    ],
    [
      "French",
      "Vu le 2026-01-10. Contrôle le 14 février, avant le 28 janvier.",
      "Contrôle le [DATE 3], avant le [DATE 2].",
    ],
    [
      "Spanish",
      "Visita 2026-01-10. Control el 14 de febrero, antes el 28 de enero.",
      "Control el [DATE 3], antes el [DATE 2].",
    ],
    [
      "Chinese",
      "2026-01-10 就诊。复查 2月14日，此前 1月28日。",
      "复查 [DATE 3]，此前 [DATE 2]。",
    ],
  ])("%s", (_name, text, tail) => {
    const out = send(text);
    expect(out).toContain(tail);
    // No year is invented and no gap is counted for them.
    expect(out).not.toMatch(/\[DATE [23], /);
    expect(out).not.toMatch(/20\d\d|19\d\d/);
  });

  it("keeps the dated ones in calendar order and first, with their gaps", () => {
    const out = send(
      "Labs 2026-03-02. Review Feb 14. Seen 2026-01-10. Earlier Jan 28.",
    );
    expect(out).toContain("Labs [DATE 2, 51 days after DATE 1].");
    expect(out).toContain("Seen [DATE 1].");
    expect(out).toContain("Review [DATE 4].");
    expect(out).toContain("Earlier [DATE 3].");
  });

  it("gives the same yearless date the same number, and restores what was written", () => {
    const result = deidentify("Seen 2026-01-10. Review Feb 14; again Feb 14.", {
      knownNames: [],
    });
    expect(result.toSend).toBe(
      "Seen [DATE 1]. Review [DATE 2]; again [DATE 2].",
    );
    expect(restoreChecked("Come back after [DATE 2].", result).text).toBe(
      "Come back after Feb 14.",
    );
  });

  it("numbers yearless dates alone in calendar order, with no dated one", () => {
    expect(send("Call back Mar 3 or, failing that, Jan 9.")).toBe(
      "Call back [DATE 2] or, failing that, [DATE 1].",
    );
  });

  it("does not take a month word that is not a date for one", () => {
    const out = send(
      "Seen 2026-01-10. March was long; may I ask? Jan said no.",
    );
    expect(out).toContain("March was long; may I ask?");
    expect(out).toContain("Jan said no.");
  });

  it("keeps the text order when yearless dates run across the new year (Dec to Jan)", () => {
    // "Review Jan 4" after "Seen Dec 28" is probably the next year: not numbered below it.
    const out = send("Seen Dec 28. Review Jan 4. Later Feb 2.");
    expect(out).toBe("Seen [DATE 1]. Review [DATE 2]. Later [DATE 3].");
    // The French, Spanish and Chinese forms follow the same rule.
    expect(send("Vu le 28 décembre. Contrôle le 4 janvier.")).toBe(
      "Vu le [DATE 1]. Contrôle le [DATE 2].",
    );
    expect(send("Visto el 28 de diciembre. Control el 4 de enero.")).toBe(
      "Visto el [DATE 1]. Control el [DATE 2].",
    );
    expect(send("12月28日就诊，1月4日复查。")).toBe(
      "[DATE 1]就诊，[DATE 2]复查。",
    );
  });

  it("still numbers in calendar order when the dates do not cross the new year", () => {
    expect(send("Review Mar 3. Seen Jan 10. Then Jun 1.")).toBe(
      "Review [DATE 2]. Seen [DATE 1]. Then [DATE 3].",
    );
    // Two dates a few months apart, later in the text but earlier in the year, are not a new year.
    expect(send("Seen May 2. Review Feb 20.")).toBe(
      "Seen [DATE 2]. Review [DATE 1].",
    );
  });
});

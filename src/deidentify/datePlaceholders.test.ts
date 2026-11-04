import { describe, expect, it } from "vitest";
import {
  DEFAULT_LABELS,
  DEFAULT_NOTES,
  deidentify,
  parsePlaceholder,
  removeMore,
  restore,
  restoreChecked,
} from "./deidentify";
import discharge from "./fixtures/discharge-summary.txt?raw";
import extractedLab from "./fixtures/extracted-lab-report.txt?raw";
import extractedLetter from "./fixtures/extracted-letter.txt?raw";
import hospital from "./fixtures/hospital-header.txt?raw";
import imaging from "./fixtures/imaging-report.txt?raw";
import lab from "./fixtures/lab-report.txt?raw";
import quebec from "./fixtures/quebec-referral.txt?raw";
import referral from "./fixtures/referral-letter.txt?raw";

// Dates and ages in the exported text (#72): no date is sent, so no real or
// shifted date can reach an outside AI. Synthetic text only.
const send = (text: string, options = {}) =>
  deidentify(text, { knownNames: [], ...options });

describe("dates become placeholders in calendar order", () => {
  it("sends no real date from any fixture", () => {
    const names = [
      "Avery Example",
      "Jordan Example",
      "Renée Côté",
      "Maggie Notreal",
    ];
    // Whole dates in the forms the remover reads, numeric or with a month word.
    const stillADate =
      /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{4}\b|\b\d{1,2}(?:er)?[ -](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|janv|févr|avr|juil|août|déc)[a-zé]*\.?[ ,-]*\d{4}\b/i;
    for (const [name, text] of Object.entries({
      referral,
      lab,
      imaging,
      discharge,
      quebec,
      hospital,
      extractedLab,
      extractedLetter,
    })) {
      const result = deidentify(text, { knownNames: names });
      expect(result.toSend, name).not.toMatch(stillADate);
      for (const part of result.onDevice.removed)
        if (part.kind === "date" || part.kind === "unclearDate")
          expect(result.toSend, `${name}: ${part.original}`).not.toContain(
            part.original,
          );
    }
  });

  it("numbers dates by the calendar, not by where they stand, with the gap from the earliest", () => {
    const out = send(
      "Review 2026-10-15. Seen 2026-10-01. Pain since 2026-09-24. Seen again 2026-10-01.",
    ).toSend;
    expect(out).toBe(
      "Review [DATE 3, 21 days after DATE 1]. Seen [DATE 2, 7 days after DATE 1]. " +
        "Pain since [DATE 1]. Seen again [DATE 2, 7 days after DATE 1].",
    );
  });

  it("gives the same real date the same placeholder in any spelling", () => {
    const out = send(
      "A 2026-10-08, B October 8, 2026, C 8 octobre 2026, D 2026/10/08, E Thu. 2026-10-08.",
    ).toSend;
    expect(out).toBe(
      "A [DATE 1], B [DATE 1], C [DATE 1], D [DATE 1], E [DATE 1].",
    );
  });

  it.each([
    ["2026-01-31", "2026-02-01", 1],
    ["2025-12-31", "2026-01-01", 1],
    ["2026-02-28", "2026-03-01", 1],
    ["2024-02-28", "2024-03-01", 2],
    ["2024-02-29", "2024-03-01", 1],
    ["2024-01-01", "2025-01-01", 366],
    ["2025-01-01", "2026-01-01", 365],
    ["2026-03-07", "2026-03-30", 23],
  ])("counts %s to %s as %i days", (first, second, days) => {
    const out = send(`From ${first} to ${second}.`).toSend;
    const noun = days === 1 ? "day" : "days";
    expect(out).toBe(
      `From [DATE 1] to [DATE 2, ${days} ${noun} after DATE 1].`,
    );
  });

  it("keeps the time of day beside the placeholder and drops the weekday with the date", () => {
    expect(
      send("Collected: Saturday, 2026-08-29 07:40, reported 2026-08-30 15:12")
        .toSend,
    ).toBe(
      "Collected: [DATE 1] 07:40, reported [DATE 2, 1 day after DATE 1] 15:12",
    );
  });

  it("gives a numeric date that could be read two ways, and a month or year alone, a plain placeholder", () => {
    const out = send(
      "Seen 2026-10-08. Echo 03/04/2026 and again 03/04/2026. In March 2024 and in 2019.",
    ).toSend;
    expect(out).toBe(
      "Seen [DATE 1]. Echo [DATE 2] and again [DATE 2]. In [DATE 3] and in [DATE 4].",
    );
  });

  it("removes a date of birth as before", () => {
    const result = send("DOB: 1961-04-17. Seen 2026-10-08.", {
      knownBirthDates: ["1961-04-17"],
    });
    expect(result.toSend).toBe("DOB: [DATE OF BIRTH 1]. Seen [DATE 1].");
  });

  it("skips a number a literal marker in the text already uses", () => {
    const out = send(
      "Literal [DATE 1] stays. Seen 2026-10-08 and 2026-10-10.",
    ).toSend;
    expect(out).toBe(
      "Literal [DATE 1] stays. Seen [DATE 2] and [DATE 3, 2 days after DATE 2].",
    );
  });

  it("writes the words and the note in the app's language", () => {
    const labels = { ...DEFAULT_LABELS, unclearDate: "DATE", age: "ÂGE" };
    const notes = {
      daysAfter: (days: number, label: string, number: number) =>
        `${days} ${days === 1 ? "jour" : "jours"} après ${label} ${number}`,
      ageOver90: "90 et plus",
    };
    const result = send(
      "Vu le 2026-10-08 puis le 2026-10-22. Patiente âgée de 93 ans.",
      {
        labels,
        notes,
      },
    );
    expect(result.toSend).toBe(
      "Vu le [DATE 1] puis le [DATE 2, 14 jours après DATE 1]. Patiente [ÂGE 1, 90 et plus].",
    );
    expect(restore(result.toSend, result)).toBe(
      "Vu le 2026-10-08 puis le 2026-10-22. Patiente âgée de 93 ans.",
    );
  });

  it("keeps date placeholders as decided when the patient removes more", () => {
    const first = send("Seen 2026-10-08 by Ward. Pain since 2026-09-24.");
    const at = first.toSend.indexOf("Ward");
    const more = removeMore(first, at, at + 4);
    expect(more.toSend).toBe(
      "Seen [DATE 2, 14 days after DATE 1] by [REMOVED 1]. Pain since [DATE 1].",
    );
    expect(restore(more.toSend, more)).toBe(
      "Seen 2026-10-08 by Ward. Pain since 2026-09-24.",
    );
  });
});

describe("ages of 90 and over", () => {
  it("numbers each distinct age with the 90+ note, and leaves a younger age alone", () => {
    const result = send(
      "A 92-year-old man, aged 95, 101 yo; une femme âgée de 90 ans; 65-year-old; again 92 years old.",
    );
    expect(result.toSend).toBe(
      "A [AGE 1, 90+] man, [AGE 2, 90+], [AGE 3, 90+]; une femme [AGE 4, 90+]; 65-year-old; again [AGE 1, 90+].",
    );
  });

  it("puts two different ages back as their own values", () => {
    const source = "Her father is 92 years old and her aunt is 97 years old.";
    const result = send(source);
    expect(result.toSend).toBe(
      "Her father is [AGE 1, 90+] and her aunt is [AGE 2, 90+].",
    );
    expect(restore(result.toSend, result)).toBe(source);
  });

  it("flags an age whose note was changed", () => {
    const result = send("A 92-year-old man.");
    const checked = restoreChecked("[AGE 1, 89+] and [AGE 1]", result);
    expect(checked.flagged).toEqual(["[AGE 1, 89+]", "[AGE 1]"]);
    expect(checked.text).toBe("[AGE 1, 89+] and [AGE 1]");
  });
});

describe("restoring an answer", () => {
  const source =
    "Seen 2026-10-08 by Dr. Ward for chest pain since 2026-09-24. Review 03/04/2026. A 92-year-old woman. Call 613-555-0142.";

  it("puts every placeholder back exactly, dates, ages and numbers included", () => {
    const result = send(source);
    expect(restore(result.toSend, result)).toBe(source);
    const checked = restoreChecked(result.toSend, result);
    expect(checked.flagged).toEqual([]);
    expect(checked.parts.some((part) => part.kind === "flagged")).toBe(false);
  });

  it("flags placeholder-shaped text that is not this export's, and never guesses", () => {
    const result = send(source);
    for (const answer of [
      "[DATE 9]",
      "[NAME 4]",
      "[date 1]",
      "[DATE 2]",
      "[DATE 2, 13 days after DATE 1]",
      "[DATE 2, 14 days after DATE 1 ]",
      "[DATE 2, 14 days after DATE 1, extra]",
      "[Smith 2020]",
      "[AGE 1, 89+]",
    ]) {
      const checked = restoreChecked(`Note ${answer} end`, result);
      expect(checked.text, answer).toBe(`Note ${answer} end`);
      expect(checked.flagged, answer).toEqual([answer]);
    }
  });

  it("restores the right ones around a flagged one", () => {
    const result = send(source);
    const checked = restoreChecked(
      "On [DATE 2, 14 days after DATE 1], [DATE 7] and [DATE 1].",
      result,
    );
    expect(checked.text).toBe("On 2026-10-08, [DATE 7] and 2026-09-24.");
    expect(checked.parts.map((part) => part.kind)).toEqual([
      "plain",
      "restored",
      "plain",
      "flagged",
      "plain",
      "restored",
      "plain",
    ]);
  });

  it("leaves text that only looks like brackets alone", () => {
    const result = send(source);
    for (const answer of ["[1]", "a [b] c", "[ 1]", "[,1]", "[DATE]", "[]"]) {
      const checked = restoreChecked(answer, result);
      expect(checked.text).toBe(answer);
      expect(checked.flagged).toEqual([]);
    }
  });
});

describe("one grammar for every placeholder", () => {
  it("reads the word, the number and the note", () => {
    expect(parsePlaceholder("[NAME 1]")).toEqual({ label: "NAME", number: 1 });
    expect(parsePlaceholder("[HEALTH CARD 12]")).toEqual({
      label: "HEALTH CARD",
      number: 12,
    });
    expect(parsePlaceholder("[DATE 2, 14 days after DATE 1]")).toEqual({
      label: "DATE",
      number: 2,
      note: "14 days after DATE 1",
    });
    expect(parsePlaceholder("[AGE 1, 90+]")).toEqual({
      label: "AGE",
      number: 1,
      note: "90+",
    });
    expect(parsePlaceholder("[日期 2, 日期 1 之后 14 天]")).toEqual({
      label: "日期",
      number: 2,
      note: "日期 1 之后 14 天",
    });
    for (const text of [
      "NAME 1",
      "[NAME]",
      "[NAME 1",
      "[1 2]",
      "[NAME 1] x",
      "[NAME 1][NAME 2]",
    ])
      expect(parsePlaceholder(text), text).toBeNull();
  });

  it("has English defaults for the notes", () => {
    expect(DEFAULT_NOTES.daysAfter(1, "DATE", 1)).toBe("1 day after DATE 1");
    expect(DEFAULT_NOTES.daysAfter(14, "DATE", 1)).toBe("14 days after DATE 1");
    expect(DEFAULT_NOTES.ageOver90).toBe("90+");
  });
});

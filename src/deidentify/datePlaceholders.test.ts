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

describe("more ways a date is written", () => {
  it("replaces the date in an ISO timestamp and keeps the time", () => {
    expect(send("Seen 2026-10-08T07:40 and 2026-10-09T08:00:00Z.").toSend).toBe(
      "Seen [DATE 1]T07:40 and [DATE 2, 1 day after DATE 1]T08:00:00Z.",
    );
  });

  it("reads ordinals, with or without a comma, and the same day is one number", () => {
    expect(
      send(
        "October 8th, 2026; Oct 1st 2026; 8th October 2026; 8th of October 2026; 1er mars 2026.",
      ).toSend,
    ).toBe(
      "[DATE 3, 221 days after DATE 1]; [DATE 2, 214 days after DATE 1]; [DATE 3, 221 days after DATE 1]; [DATE 3, 221 days after DATE 1]; [DATE 1].",
    );
  });

  it("reads numeric dates with hyphens, compact and dotted forms, and a lab timestamp", () => {
    expect(send("25-12-2026 and 08-10-2026.").toSend).toBe(
      "[DATE 1] and [DATE 2].",
    );
    expect(send("20261008 and 2026.10.08.").toSend).toBe(
      "[DATE 1] and [DATE 1].",
    );
    expect(send("Reported 20261009074500.").toSend).toBe(
      "Reported [DATE 1]074500.",
    );
    // Eight digits that are not a calendar day stay.
    expect(send("Order 12345678 and 20261399.").toSend).toBe(
      "Order 12345678 and 20261399.",
    );
  });

  it("gives a day and a month with no year a plain mark, the same for any spelling", () => {
    expect(
      send("Seen Oct 8 and 8 October, le 8 octobre; 8th Oct; Oct 9.").toSend,
    ).toBe("Seen [DATE 1] and [DATE 1], le [DATE 1]; [DATE 1]; [DATE 2].");
    // The lower-case word "may" is not a month.
    expect(send("Take may 5 mg. Seen May 5.").toSend).toBe(
      "Take may 5 mg. Seen [DATE 1].",
    );
  });

  it("reads the hyphen look-alikes PDFs write, and keeps the original character in a restore", () => {
    for (const hyphen of ["\u2010", "\u2011", "\u2012", "\u2013", "\u2212"]) {
      const source = `Seen 2026${hyphen}10${hyphen}08.`;
      const result = send(source);
      expect(result.toSend, hyphen).toBe("Seen [DATE 1].");
      expect(restore(result.toSend, result)).toBe(source);
    }
  });

  it("replaces both ends of a range of days", () => {
    expect(send("From 8 to 12 October 2026.").toSend).toBe(
      "From [DATE 1] to [DATE 2, 4 days after DATE 1].",
    );
    expect(send("Admitted 8\u201312 Oct 2026.").toSend).toBe(
      "Admitted [DATE 1]\u2013[DATE 2, 4 days after DATE 1].",
    );
    expect(send("Oct 8-12, 2026 and 8th-12th October 2026.").toSend).toBe(
      "[DATE 1]-[DATE 2, 4 days after DATE 1] and [DATE 1]-[DATE 2, 4 days after DATE 1].",
    );
    expect(send("Vu du 8 au 12 octobre 2026.").toSend).toBe(
      "Vu du [DATE 1] au [DATE 2, 4 days after DATE 1].",
    );
    const source = "Oct 8-12, 2026";
    const result = send(source);
    expect(restore(result.toSend, result)).toBe(source);
    // A day that is not in that month is no range.
    expect(send("From 30 to 31 April 2026.").toSend).not.toContain("[DATE 2");
  });

  it("takes a weekday after a date with it, and reads the years 0000 to 0099 as they are", () => {
    expect(send("2026-10-08 (Thursday) and 2026-10-09 Friday.").toSend).toBe(
      "[DATE 1] and [DATE 2, 1 day after DATE 1].",
    );
    expect(send("0050-01-01 then 0050-01-02.").toSend).toBe(
      "[DATE 1] then [DATE 2, 1 day after DATE 1].",
    );
  });

  it("round-trips every one of these forms exactly", () => {
    const source =
      "A 2026-10-08T07:40, B October 9th, 2026, C 10-11-2026, D 20261012, E Oct 13, F le 14 octobre, G 15\u201316 Oct 2026, H 2026-10-17 (Thursday).";
    const result = send(source);
    expect(result.toSend).not.toMatch(/\b20\d\d\b/);
    expect(restore(result.toSend, result)).toBe(source);
  });
});

describe("near misses of a placeholder in an answer", () => {
  const result = send(
    "Seen 2026-10-08 and 2026-10-22 by Dr. Ward. A 92-year-old.",
  );

  it("flags a mark written loosely, in brackets or not, and never restores it", () => {
    for (const answer of [
      "[DATE2]",
      "[DATE 2,14 days after DATE 1]",
      "(DATE 1)",
      "[date 1]",
      "[ DATE 2 , 14 days after DATE 1 ]",
      "Mentions DATE 1 here",
      "On DATE 2.",
      "AGE 1",
      "and DOCTOR 1 said",
    ]) {
      const checked = restoreChecked(answer, result);
      expect(checked.text, answer).toBe(answer);
      expect(checked.flagged.length, answer).toBeGreaterThan(0);
    }
  });

  it("does not flag ordinary words, and still restores the exact marks beside a near miss", () => {
    for (const answer of [
      "date 1 in lower case",
      "age 1",
      "the DATES 1",
      "a date of 5 mg",
    ]) {
      expect(restoreChecked(answer, result).flagged, answer).toEqual([]);
    }
    const checked = restoreChecked(
      "Seen [DATE 1], later DATE 2 and [DATE 2, 14 days after DATE 1].",
      result,
    );
    expect(checked.text).toBe("Seen 2026-10-08, later DATE 2 and 2026-10-22.");
    expect(checked.flagged).toEqual(["DATE 2"]);
  });
});

describe("ages of 90 and over", () => {
  it("reads an age after a label and the y/o form", () => {
    expect(send("Age: 93; 90 y/o; Âge : 97; age 65; Package 90.").toSend).toBe(
      "[AGE 1, 90+]; [AGE 2, 90+]; [AGE 3, 90+]; age 65; Package 90.",
    );
  });

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

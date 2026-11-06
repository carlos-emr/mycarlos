import { describe, expect, it } from "vitest";
import { LOCALES, translatePlain, type Locale, type MessageKey } from "../i18n";
import {
  deidentify,
  removeMore,
  restoreChecked,
  type PlaceholderLabels,
  type PlaceholderVocabulary,
  type RemovedKind,
} from "./deidentify";

// #215: placeholders in the document's language, paste-back in any of the
// app's languages. FAKE names and dates only.

const KINDS: RemovedKind[] = [
  "name",
  "doctor",
  "clinic",
  "healthCard",
  "recordNumber",
  "sin",
  "dateOfBirth",
  "age",
  "address",
  "postalCode",
  "phone",
  "email",
  "web",
  "unclearDate",
  "manual",
];

/** The words the preview uses, from the real catalogues. */
function words(locale: Locale): PlaceholderVocabulary {
  const labels = {} as PlaceholderLabels;
  for (const kind of KINDS)
    labels[kind] = translatePlain(
      locale,
      `interface.AnonymizePreview.placeholder.${kind}` as MessageKey,
    );
  return {
    labels,
    notes: {
      daysAfter: (days, label, number) =>
        translatePlain(locale, "interface.AnonymizePreview.note.daysAfter", {
          days,
          label,
          number,
        }),
      ageOver90: translatePlain(
        locale,
        "interface.AnonymizePreview.note.ageOver90",
      ),
    },
  };
}

/** The remover with one language's words, and the others alongside. */
function inLanguage(
  text: string,
  locale: Locale,
  knownNames = ["Avery Example"],
) {
  return deidentify(text, {
    knownNames,
    ...words(locale),
    otherLanguages: LOCALES.filter((other) => other !== locale).map(words),
  });
}

const restored = (answer: string, result: ReturnType<typeof deidentify>) =>
  restoreChecked(answer, result);

const twoDates = "Patient Avery Example. Seen 2026-03-01, again 2026-03-15.";

describe("placeholders in the document's language (#215)", () => {
  it("writes the document's language's words and notes", () => {
    const result = inLanguage(twoDates, "fr");
    expect(result.toSend).toBe(
      "Patient [NOM 1]. Seen [DATE 1], again [DATE 2, 14 jours après DATE 1].",
    );
  });

  it("puts back the export's own marks, as before", () => {
    const result = inLanguage(twoDates, "fr");
    const back = restored(
      "[NOM 1]: [DATE 1], [DATE 2, 14 jours après DATE 1].",
      result,
    );
    expect(back.text).toBe("Avery Example: 2026-03-01, 2026-03-15.");
    expect(back.flagged).toEqual([]);
  });

  it("puts back a mark the AI translated to another app language", () => {
    const result = inLanguage(twoDates, "fr");
    const back = restored(
      "[NAME 1] was seen on [DATE 2, 14 days after DATE 1] and [FECHA 1].",
      result,
    );
    expect(back.text).toBe(
      "Avery Example was seen on 2026-03-15 and 2026-03-01.",
    );
    expect(back.flagged).toEqual([]);
    // And the other way: an English export, read in French.
    const english = inLanguage(twoDates, "en");
    expect(restored("[NOM 1]", english).text).toBe("Avery Example");
  });

  it("flags a translated mark whose note was changed or left out", () => {
    const result = inLanguage(twoDates, "fr");
    const back = restored(
      "[DATE 2, 15 jours après DATE 1]; [DATE 2]; [DATE 2, 15 days after DATE 1]",
      result,
    );
    expect(back.flagged).toEqual([
      "[DATE 2, 15 jours après DATE 1]",
      "[DATE 2]",
      "[DATE 2, 15 days after DATE 1]",
    ]);
    expect(back.text).not.toMatch(/2026/);
  });

  it("reads Polish plurals and Chinese word order", () => {
    const text = "Wizyta 2026-03-01. Kontrola 2026-03-06.";
    const polish = inLanguage(text, "pl", []);
    expect(polish.toSend).toBe(
      "Wizyta [DATA 1]. Kontrola [DATA 2, 5 dni po DATA 1].",
    );
    const back = restored(
      "[DATA 2, 5 dni po DATA 1] / [DATE 2, 5 days after DATE 1] / [日期 2, 日期 1 之后 5 天]",
      polish,
    );
    expect(back.text).toBe("2026-03-06 / 2026-03-06 / 2026-03-06");
    expect(back.flagged).toEqual([]);
  });

  it("puts back a simplified Chinese mark written in traditional Chinese", () => {
    const result = inLanguage("Seen by Dr. Blake Sample.", "zh-CN", []);
    expect(result.toSend).toBe("Seen by Dr. [医生 1].");
    expect(restored("[醫生 1]", result).text).toBe("Blake Sample");
  });

  it("reads a long gap whose number a language groups", () => {
    // 1,234 days apart: English groups it "1,234", French "1 234".
    const result = inLanguage("Seen 2020-01-01, again 2023-05-19.", "en", []);
    expect(result.toSend).toBe(
      "Seen [DATE 1], again [DATE 2, 1,234 days after DATE 1].",
    );
    const french = words("fr").notes.daysAfter(1234, "DATE", 1);
    expect(restored(`[DATE 2, ${french}]`, result).text).toBe("2023-05-19");
  });

  it("puts back an age and a removal made by hand in any language", () => {
    const result = inLanguage("Avery Example, aged 93, lives alone.", "es");
    expect(result.toSend).toBe("[NOMBRE 1], [EDAD 1, 90+], lives alone.");
    const more = removeMore(
      result,
      result.toSend.indexOf("lives"),
      result.toSend.length - 1,
    );
    expect(more.toSend).toBe("[NOMBRE 1], [EDAD 1, 90+], [ELIMINADO 1].");
    const back = restored(
      "[AGE 1, 90+]; [ÂGE 1, 90+]; [REMOVED 1]; [RETIRÉ 1]",
      more,
    );
    expect(back.text).toBe("aged 93; aged 93; lives alone; lives alone");
    expect(back.flagged).toEqual([]);
  });

  it("never takes a number another language's word for it already shows in the text", () => {
    const result = inLanguage("Avery Example wrote [NOM 1] on the form.", "en");
    expect(result.toSend).toBe("[NAME 2] wrote [NOM 1] on the form.");
    const back = restored("[NAME 2], [NOM 2], [NOM 1], [NAME 1]", result);
    expect(back.text).toBe("Avery Example, Avery Example, [NOM 1], [NAME 1]");
    expect(back.flagged).toEqual(["[NOM 1]", "[NAME 1]"]);
  });

  it("leaves a mark unresolved when one language's wording of it is in the text", () => {
    // A result made before the numbering skipped other languages' words.
    const result = deidentify("Avery Example wrote [NOM 1] on the form.", {
      knownNames: ["Avery Example"],
    });
    expect(result.toSend).toBe("[NAME 1] wrote [NOM 1] on the form.");
    const later = {
      toSend: result.toSend,
      onDevice: { ...result.onDevice, otherLanguages: [words("fr")] },
    };
    const back = restored("[NAME 1] and [NOM 1]", later);
    expect(back.text).toBe("[NAME 1] and [NOM 1]");
    expect(back.flagged).toEqual(["[NAME 1]", "[NOM 1]"]);
  });

  it("flags near misses in every language", () => {
    const result = inLanguage(twoDates, "fr");
    const back = restored("[nom 1], NAME 1, (NOMBRE 1), DATA 1", result);
    expect(back.flagged).toEqual(["[nom 1]", "NAME 1", "(NOMBRE 1)", "DATA 1"]);
    expect(back.text).not.toMatch(/Avery/);
  });

  it("reads a word that is another kind's in another language only in the export's own words", () => {
    // A test-only language whose word for a name is English's word for a doctor.
    const odd: PlaceholderVocabulary = {
      labels: { ...words("en").labels, name: "DOCTOR", doctor: "ARZT" },
      notes: words("en").notes,
    };
    const result = deidentify("Avery Example saw Dr. Blake Sample.", {
      knownNames: ["Avery Example"],
      otherLanguages: [odd],
    });
    expect(result.toSend).toBe("[NAME 1] saw Dr. [DOCTOR 1].");
    const back = restored("[DOCTOR 1]; [ARZT 1]", result);
    expect(back.text).toBe("Blake Sample; Blake Sample");
    expect(back.flagged).toEqual([]);
  });

  it("is as before without other languages", () => {
    const result = deidentify(twoDates, { knownNames: ["Avery Example"] });
    const back = restored("[NAME 1] [NOM 1]", result);
    expect(back.text).toBe("Avery Example [NOM 1]");
    expect(back.flagged).toEqual(["[NOM 1]"]);
  });
});

describe("the seven catalogues' placeholder words (#215)", () => {
  it("never use one word for two kinds", () => {
    const kindsOf = new Map<string, Set<RemovedKind>>();
    for (const locale of LOCALES)
      for (const [kind, word] of Object.entries(words(locale).labels))
        kindsOf.set(
          word,
          (kindsOf.get(word) ?? new Set()).add(kind as RemovedKind),
        );
    const shared = [...kindsOf].filter(([, kinds]) => kinds.size > 1);
    expect(shared).toEqual([]);
  });

  it.each([1, 2, 5, 21, 22])(
    "write a %i-day gap that every language reads back",
    (days) => {
      const later = new Date(Date.UTC(2026, 2, 1 + days))
        .toISOString()
        .slice(0, 10);
      for (const locale of LOCALES) {
        const result = inLanguage(
          `Seen 2026-03-01, again ${later}.`,
          locale,
          [],
        );
        for (const other of LOCALES) {
          const theirs = words(other);
          const mark = `[${theirs.labels.unclearDate} 2, ${theirs.notes.daysAfter(days, theirs.labels.unclearDate, 1)}]`;
          const back = restored(mark, result);
          expect([locale, other, back.text]).toEqual([locale, other, later]);
        }
      }
    },
  );
});

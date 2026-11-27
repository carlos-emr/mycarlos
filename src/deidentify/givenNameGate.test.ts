import { describe, expect, it } from "vitest";
import { deidentify } from "./deidentify";
import { isKnownGivenName, isLikelyHanName } from "./gazetteer";
import givenNamesEn from "./gazetteers/given-names-en.json";
import givenNamesFr from "./gazetteers/given-names-fr.json";
import givenNamesPl from "./gazetteers/given-names-pl.json";
import surnamesZh from "./gazetteers/surnames-zh.json";
import pins from "../../scripts/given-names-sources.json";
import exceptions from "../../scripts/given-names-exceptions.json";

const send = (text: string) => deidentify(text, { knownNames: [] }).toSend;

describe("a header's subject after 'for' is a person when it starts with a known given name", () => {
  it("takes the patient in 'Home-care plan for Avery Example'", () => {
    const out = send("Home-care plan for Avery Example");
    expect(out).not.toContain("Avery");
    expect(out).not.toContain("Example");
    expect(out).toContain("Home-care plan for ");
  });

  it("takes a name that is also an ordinary word: 'for Rose Smith'", () => {
    // Rose, May and Faith are kept in the lists on purpose: a missed name is the worse mistake.
    for (const text of [
      "Home-care plan for Rose Smith",
      "Care plan for May Sample",
      "Discharge summary for Faith Example",
    ]) {
      const out = send(text);
      expect(out, text).not.toMatch(/Rose|May|Faith|Smith|Sample|Example/u);
    }
  });

  it.each([
    ["Plan de soins pour Camille Tremblay", "Tremblay"],
    [
      "Plan de soins pour Margaux Vellacourt\nNAM : VELM 4163 1412",
      "Vellacourt",
    ],
    ["Plan opieki dla Zofia Testowa", "Testowa"],
    ["Plan de soins pour Jean-Philippe Example", "Example"],
    // Accents do not matter: the list is matched in the folded copy.
    ["Résumé pour Hélène Bastarache", "Bastarache"],
  ])("in the other languages: %s", (text, surname) => {
    expect(send(text)).not.toContain(surname);
  });

  it.each([
    "Care Plan: Fall Prevention",
    "Home-care plan for Fall Prevention",
    "Care plan for Pain Management",
    "Discharge summary for Wound Care",
    "Plan for Home Care",
    "Referral letter for Palliative Care",
    "Assessment for Mobility Aids",
    "Plan de soins pour Prévention Des Chutes",
    "Plan opieki dla Opieka Paliatywna",
  ])("leaves a topic alone: %s", (text) => {
    expect(send(text)).toBe(text);
  });

  it("still keeps 'SURNAME, Given' in a header, as before", () => {
    const out = send("Physiotherapy summary — HALLOWAY, Wren");
    expect(out).not.toContain("HALLOWAY");
  });
});

describe("a Chinese header's subject after 'for' is a person when it looks like a surname and a given name", () => {
  it.each([
    ["居家护理计划 为张伟", "张伟"],
    ["居家护理计划 为李小明", "李小明"],
    ["居家護理計劃 為陳大文", "陳大文"],
    ["出院小结 for 王芳", "王芳"],
    ["居家护理计划 为欧阳明", "欧阳明"],
  ])("%s", (text, name) => {
    expect(send(text)).not.toContain(name);
  });

  it.each([
    "居家护理计划 为社区",
    "出院计划 对于糖尿病",
    "跌倒预防",
    // Topics that begin with a character that is also a surname (高 白 黄 康 家 居 常 成 ...).
    "居家护理计划 为高血压",
    "居家护理计划 为高血脂",
    "居家护理计划 为白内障",
    "居家护理计划 为黄疸",
    "居家护理计划 为白血病",
    "居家护理计划 为康复",
    "居家护理计划 为成人",
    "居家护理计划 为常规检查",
    "居家护理计划 为家庭护理",
    "居家护理计划 为居家患者",
    "居家護理計劃 為高血壓",
    "居家護理計劃 為白內障",
    "居家護理計劃 為黃疸",
  ])("leaves a topic alone: %s", (text) => {
    expect(send(text)).toBe(text);
  });
});

describe("the given-name and surname lists", () => {
  it("knows given names of each language, with or without accents, and hyphenated ones", () => {
    for (const name of [
      "Avery",
      "Rose",
      "Faith",
      "Camille",
      "Zofia",
      "Hélène",
      "Helene",
      "Jean-Philippe",
    ])
      expect(isKnownGivenName(name), name).toBe(true);
  });

  it("does not know a topic, a surname or a document word", () => {
    for (const word of [
      "Fall",
      "Pain",
      "Example",
      "Quillfeather",
      "Plan",
      "Home",
      "Care",
    ])
      expect(isKnownGivenName(word), word).toBe(false);
  });

  it("reads a Han name as a known surname of one or two characters and a given name of one or two", () => {
    for (const name of ["张伟", "陳大文", "欧阳明", "王小明", "欧阳小明"])
      expect(isLikelyHanName(name), name).toBe(true);
    // A lone character, a run too long for a name, no known surname, and care topics.
    for (const text of [
      "李",
      "张伟明明",
      "社区",
      "糖尿病",
      "",
      "plan",
      "高血压",
      "康复",
      "居家护理",
    ])
      expect(isLikelyHanName(text), text).toBe(false);
  });

  it.each([
    ["en", givenNamesEn],
    ["fr", givenNamesFr],
    ["pl", givenNamesPl],
    ["zh", surnamesZh],
  ] as const)(
    "the %s file is a licensed, pinned, sorted and unique list",
    (_lang, file) => {
      expect(file.synthetic).toBe(false);
      expect(file.sources.length).toBeGreaterThan(0);
      for (const source of file.sources) {
        expect(source.url).toBeTruthy();
        expect(source.licence).toBeTruthy();
        expect(source.sha256).toMatch(/^[0-9a-f]{64}$/u);
      }
      expect(file.count).toBe(file.names.length);
      expect(new Set(file.names).size).toBe(file.names.length);
      expect([...file.names].sort()).toEqual(file.names);
      // A size guard: a list cannot silently grow past what a header gate needs.
      expect(file.names.length).toBeLessThan(15_000);
    },
  );

  it("ties each data file to the pins in scripts/given-names-sources.json (a hand edit of either side fails)", () => {
    const pinned = new Map(
      Object.values(pins.sources).map((source) => [source.url, source]),
    );
    for (const file of [givenNamesEn, givenNamesFr, givenNamesPl, surnamesZh])
      for (const source of file.sources) {
        const pin = pinned.get(source.url);
        // The Hundred Family Surnames is a file of this repository, not a download.
        if (source.url === "scripts/hundred-family-surnames.txt") continue;
        expect(pin, source.url).toBeDefined();
        expect(source.sha256, source.url).toBe(pin?.sha256);
        expect(source.licence, source.url).toBe(pin?.licence);
      }
  });

  it("keeps the hand exceptions out of the lists, each with its reason", () => {
    const lists = {
      en: givenNamesEn,
      fr: givenNamesFr,
      pl: givenNamesPl,
    } as const;
    for (const [lang, file] of Object.entries(lists)) {
      const hand = exceptions[lang as keyof typeof lists];
      for (const [name, reason] of Object.entries(hand)) {
        expect(file.names, `${lang}: ${name}`).not.toContain(name);
        expect(reason.length, `${lang}: ${name}`).toBeGreaterThan(10);
      }
    }
    // Care words held as rare names (a review found them in the English and French lists).
    for (const word of ["female", "male", "infant", "walker", "baby", "ward"])
      expect(givenNamesEn.names).not.toContain(word);
    expect(givenNamesFr.names).not.toContain("elder");
  });

  it.each([
    "Screening for Female Patients",
    "Screening for Male Patients",
    "Care plan for Infant Feeding",
    "Assessment for Walker Use",
    "Plan for Baby Care",
    "Plan for Ward Round",
  ])("leaves a care topic alone that a name list once held: %s", (text) => {
    expect(send(text)).toBe(text);
  });

  it("takes 'de' like 'for', only before a known given name", () => {
    expect(send("Résumé de Jean Example")).not.toContain("Example");
    expect(send("Résumé de Santé Mentale")).toBe("Résumé de Santé Mentale");
  });

  it("holds lower-case single-word names for the Latin lists, and the hand exceptions are out", () => {
    for (const file of [givenNamesEn, givenNamesFr, givenNamesPl])
      for (const name of file.names)
        expect(name).toMatch(/^[\p{L}][\p{L}'’-]*[\p{L}]$/u);
    // An ordinary Polish word that does real harm as a gate (scripts/given-names-exceptions.json).
    expect(givenNamesPl.names).not.toContain("inna");
    // Names that are also common words stay.
    expect(givenNamesEn.names).toEqual(
      expect.arrayContaining(["rose", "may", "faith"]),
    );
  });
});

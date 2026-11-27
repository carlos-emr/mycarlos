import { describe, expect, it } from "vitest";
import { deidentify } from "./deidentify";
import { isKnownGivenName, isLikelyHanName } from "./gazetteer";
import givenNamesEn from "./gazetteers/given-names-en.json";
import givenNamesFr from "./gazetteers/given-names-fr.json";
import givenNamesPl from "./gazetteers/given-names-pl.json";
import givenNamesEs from "./gazetteers/given-names-es.json";
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

  it("replaces the name with a placeholder and keeps the header's words", () => {
    const out = send(
      "Plan de soins pour Margaux Vellacourt\nNAM : VELM 4163 1412",
    );
    expect(out).toMatch(/^Plan de soins pour \[NAME[^\]]*\]\n/u);
    expect(out).not.toContain("Margaux");
    expect(out).not.toContain("Vellacourt");
    const english = send("Home-care plan for Avery Example");
    expect(english).toMatch(/^Home-care plan for \[NAME[^\]]*\]$/u);
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

describe("a Spanish header's subject after 'para' is a person when it starts with a known given name", () => {
  it.each([
    ["Plan de cuidados para Rosa Ejemplo", "Ejemplo"],
    ["Informe para Pilar Ejemplo", "Ejemplo"],
    ["Resumen de alta para Dolores Ejemplo", "Ejemplo"],
    ["Informe para Consuelo Ejemplo", "Ejemplo"],
    ["Plan de cuidados para Amparo Ejemplo", "Ejemplo"],
    ["Informe para Rocío Ejemplo", "Ejemplo"],
    ["Informe de alta para Jesús Ejemplo", "Ejemplo"],
    ["Plan de cuidados sobre María Ejemplo", "Ejemplo"],
  ])("%s", (text, surname) => {
    const out = send(text);
    expect(out).not.toContain(surname);
    expect(out).toMatch(/\[NAME[^\]]*\]$/u);
  });

  it.each([
    "Plan de cuidados para Prevención De Caídas",
    "Plan de cuidados para Salud Mental",
    "Resumen para Vida Diaria",
    "Plan de cuidados para Cuidados Paliativos",
    "Resumen de alta para Insuficiencia Cardiaca",
  ])("leaves a topic alone: %s", (text) => {
    expect(send(text)).toBe(text);
  });

  it("takes Dolores, Esperanza and the other name-words as names where a name stands, and leaves the lower-case care phrase alone", () => {
    for (const text of [
      "Informe para Dolores García",
      "Plan de cuidados para Esperanza Ejemplo",
      "Informe para Consuelo García",
      "Informe para Soledad García",
      "Informe para Remedios García",
      "Informe para Socorro García",
      "Informe para Angustias García",
    ])
      expect(send(text), text).toMatch(/\[NAME[^\]]*\]$/u);
    // A care phrase written in lower case is no name: the header rule needs capitalised words.
    for (const text of [
      "Plan para dolores lumbares",
      "Informe para remedios caseros",
      "Plan de cuidados para soledad no deseada",
      "Plan para esperanza de vida",
    ])
      expect(send(text), text).toBe(text);
  });

  it("states the cost: a title-case topic that starts with such a word is read as a name", () => {
    // "Dolores" is a name before it is a plural noun: a title-case "Dolores Lumbares" after "para"
    // is redacted (over-redaction, never a missed name).
    expect(send("Plan para Dolores Lumbares")).toMatch(/\[NAME[^\]]*\]$/u);
  });

  it("keeps Spanish name-words in the list and the care words out", () => {
    for (const name of [
      "rosa",
      "pilar",
      "dolores",
      "consuelo",
      "amparo",
      "rocio",
      "luz",
      "paz",
    ])
      expect(isKnownGivenName(name), name).toBe(true);
    for (const word of ["salud", "vida"])
      expect(isKnownGivenName(word), word).toBe(false);
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
    ["es", givenNamesEs],
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
    for (const file of [
      givenNamesEn,
      givenNamesFr,
      givenNamesPl,
      givenNamesEs,
      surnamesZh,
    ])
      for (const source of file.sources) {
        const pin = pinned.get(source.url);
        // The Hundred Family Surnames is a file of this repository, not a download.
        if (source.url === "scripts/hundred-family-surnames.txt") continue;
        expect(pin, source.url).toBeDefined();
        expect(source.sha256, source.url).toBe(pin?.sha256);
        expect(source.licence, source.url).toBe(pin?.licence);
      }
  });

  it('keeps the hand exceptions out: the "all" group from every list, a language group from its own list only', () => {
    const lists = {
      en: givenNamesEn,
      fr: givenNamesFr,
      pl: givenNamesPl,
      es: givenNamesEs,
    } as const;
    const groups = Object.entries(exceptions).filter(
      ([group]) => !group.startsWith("_"),
    ) as [string, Record<string, string>][];
    expect(groups.map(([group]) => group).sort()).toEqual(["all", "es", "pl"]);
    let total = 0;
    for (const [group, words] of groups)
      for (const [name, reason] of Object.entries(words)) {
        total += 1;
        expect(reason.length, `${group}: ${name}`).toBeGreaterThan(10);
        const from =
          group === "all"
            ? Object.values(lists)
            : [lists[group as keyof typeof lists]];
        for (const file of from)
          expect(file.names, `${group}: ${name} in ${file.name}`).not.toContain(
            name,
          );
      }
    expect(total).toBeGreaterThan(15);
    // A word that does harm in any language is out of every list, so the gate does not know it.
    for (const name of Object.keys(exceptions.all))
      expect(isKnownGivenName(name), name).toBe(false);
  });

  it("keeps a real given name in the lists of the languages where it is one", () => {
    // Asma and Line are given names in French, English and Spanish data; Inna and Santa too. A
    // language's own exception (the Polish word "inna", the Spanish "santa") drops it from that
    // list only. A missed name is the worse mistake.
    for (const name of ["asma", "line", "inna", "santa", "santo", "mama"])
      expect(isKnownGivenName(name), name).toBe(true);
    expect(givenNamesPl.names).not.toContain("inna");
    expect(givenNamesFr.names).toContain("inna");
    expect(givenNamesEs.names).not.toContain("santa");
    expect(givenNamesFr.names).toContain("santa");
  });

  it.each([
    ["Care plan for Asma Khan", "Khan"],
    ["Plan de soins pour Asma Benali", "Benali"],
    ["Plan de soins pour Line Tremblay", "Tremblay"],
    ["Plan de soins pour Inna Petrova", "Petrova"],
    ["Plan de cuidados para Asma Ejemplo", "Ejemplo"],
  ])("still catches the real name: %s", (text, surname) => {
    expect(send(text)).not.toContain(surname);
  });

  it("leaves a lower-case care phrase alone, and states the cost for a title-case one", () => {
    for (const text of [
      "Plan para asma bronquial",
      "Care plan for asma control",
      "Plan de soins pour line care",
    ])
      expect(send(text), text).toBe(text);
    // Title case reads as a name where the word is a given name somewhere: over-redaction, never a
    // missed name.
    for (const text of [
      "Informe para Asma Infantil",
      "Informe para Santa Casa",
    ])
      expect(send(text), text).toMatch(/\[NAME[^\]]*\]$/u);
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
    for (const file of [givenNamesEn, givenNamesFr, givenNamesPl, givenNamesEs])
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

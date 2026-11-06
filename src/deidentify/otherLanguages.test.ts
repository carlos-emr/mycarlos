import { describe, expect, it } from "vitest";
import { deidentify } from "./deidentify";

// FAKE sentences in Spanish, Polish and Brazilian Portuguese, written apart from the
// harness's set L so these tests check the rules, not that set.
const send = (text: string) => deidentify(text, { knownNames: [] }).toSend;
const gone = (text: string, ...parts: string[]) => {
  const out = send(text);
  for (const part of parts) expect(out).not.toContain(part);
  return out;
};

describe("phones in es/pl/pt", () => {
  it.each([
    ["Llamar al +34 655 908 117 por la tarde.", "655"],
    ["Kontakt: +48 512 330 908.", "512"],
    ["Ligar para (31) 98877-1203 amanhã.", "98877"],
    ["Móvil: 655 908 117", "655"],
    ["Tel. kom. 512 330 908", "512"],
  ])("%s", (text, part) => {
    expect(gone(text, part)).toMatch(/\[PHONE 1\]/);
  });
});

describe("national identity numbers and health cards", () => {
  it.each([
    ["Paciente con DNI 87654321X acude a consulta.", "87654321X"],
    ["NIE: Y7654321T", "7654321"],
    ["Numer PESEL 90010154321 w dokumentacji.", "90010154321"],
    ["CPF: 987.654.321-00", "987.654.321"],
    ["Seu CPF é 987.654.321-00.", "987.654.321"],
    ["Tarjeta sanitaria: MRGA870512345011", "MRGA870512345011"],
    ["Cartão Nacional de Saúde 700 5009 1234 5678", "5009"],
  ])("%s", (text, part) => {
    gone(text, part);
  });
});

describe("record and licence numbers after es/pl/pt labels", () => {
  it.each([
    ["Póliza n.º SEG-55120987 vigente.", "55120987"],
    ["Polisa nr PZU-55120987 ważna.", "55120987"],
    ["Apólice nº AP-55120987 ativa.", "55120987"],
    ["Pedido nº EX-2026-118823 enviado.", "118823"],
    ["Número de historia clínica HC 5512098.", "5512098"],
    ["Numer historii choroby HCH 5512098.", "5512098"],
    ["Colegiada n.º 08/556677.", "556677"],
    ["Numer prawa wykonywania zawodu 7654321.", "7654321"],
  ])("%s", (text, part) => {
    gone(text, part);
  });

  it("leaves a lower-case word before the digits", () => {
    expect(send("Pedido de exame em 2026.")).not.toMatch(/RECORD NUMBER/);
  });
});

describe("clinicians, patients and relatives in es/pl/pt", () => {
  it.each([
    ["Valorada por la Dra. Inés Ficticia Peral.", "Ficticia"],
    ["Badał lek. med. Michał Przykładny.", "Przykładny"],
    ["Wypisała dr Ewa Testowska.", "Testowska"],
    ["Atendida pela Doutora Beatriz Teste Lobo.", "Lobo"],
    ["Atentamente,\nDra. Inés Ficticia Peral", "Peral"],
    ["Z poważaniem,\nEwa Testowska", "Testowska"],
    ["Atenciosamente,\nBeatriz Teste Lobo", "Lobo"],
    ["Le remito a Julián Ficticio Barrios por disnea.", "Barrios"],
    ["Encaminho Joana Teste Prado para avaliação.", "Prado"],
    ["Kieruję pana Marka Przykładnego na konsultację.", "Przykładnego"],
    ["Julián Ficticio Barrios, DNI 87654321X, acude solo.", "Barrios"],
    ["Przyjechała z córką, Zofią Testowską.", "Testowską"],
    ["Opiekuje się nią syn, Adam Przykładny.", "Przykładny"],
  ])("%s", (text, part) => {
    gone(text, part);
  });
});

describe("clinics and towns in es/pl/pt", () => {
  it.each([
    ["Kontrola w Poradni Kardiologicznej Testowo.", "Testowo"],
    ["Leczony w Szpitalu Powiatowym w Przykładowie.", "Przykładowie"],
    ["Szpital Specjalistyczny nr 4 w Testowie", "Testowie"],
    ["Laboratorio Análisis Ficticios del Sur", "Ficticios"],
    ["Laboratório Teste Análises Clínicas", "Teste"],
    ["Vive en un pueblo de Villaficticia (Cuenca).", "Villaficticia"],
    ["Mora em Pedra Teste (Minas Gerais) há anos.", "Pedra Teste"],
  ])("%s", (text, part) => {
    gone(text, part);
  });

  it.each([
    "Revisión en Cardiología (Externa) el martes.",
    "Retorno na Clínica (Primeira consulta).",
    "Atención Primaria (AP) informada.",
    "Ingresado en Medicina Interna (Planta) desde ayer.",
    "Seguimento na Cardiologia (Externa).",
    "Dawka 5 mg (pilne) podana.",
    "Metformina 850 mg dos veces al día; HbA1c 7,2 %.",
  ])("leaves %s", (text) => {
    expect(send(text)).toBe(text);
  });
});

describe("look-alikes found in the #252 review", () => {
  it.each([
    "CNS EXAM NORMAL.",
    "CNS: NO FOCAL DEFICIT.",
    "Plaquetas 150.000.000/L.",
    "Leukocyty 150 000 000/l.",
    "Płytki 150 000 000 x 10/l.",
  ])("leaves %s", (text) => {
    expect(send(text)).toBe(text);
  });

  it.each(["Patient ABC reviewed.", "Paciente ABC revisado.", "Client OKAFOR"])(
    "leaves capitals after a label with no colon or dash whole: %s",
    (text) => {
      expect(send(text)).not.toMatch(/[A-Z]\[NAME/);
    },
  );

  it("still removes a name after a label and a dash", () => {
    expect(send("Patient – Avery Sampleton")).toBe("Patient – [NAME 1]");
  });

  it("keeps an identity label and removes its number", () => {
    expect(send("Paciente CPF 987.654.321-00, acompanhada.")).toBe(
      "Paciente CPF [SIN 1], acompanhada.",
    );
  });

  it("still removes a health card of digits after CNS", () => {
    expect(send("CNS 700 5009 1234 5678")).toBe("CNS [HEALTH CARD 1]");
  });
});

describe("a header laid out in columns, with no colon (#252 review)", () => {
  it.each([
    ["PATIENT AVERY SAMPLETON", "PATIENT [NAME 1]"],
    ["PATIENT  SAMPLETON, AVERY", "PATIENT  [NAME 1]"],
    ["Patient\tSampleton, Avery", "Patient\t[NAME 1]"],
    [
      "Patient    Avery Sampleton    MRN 12345678",
      "Patient    [NAME 1]    MRN [RECORD NUMBER 1]",
    ],
    ["PACIENTE  PRUEBA SANZ, LUCÍA", "PACIENTE  [NAME 1]"],
    ["PACJENT\tTESTOWY, TOMASZ", "PACJENT\t[NAME 1]"],
    ["CLIENT JORDAN QUILLFEATHER", "CLIENT [NAME 1]"],
    ["NOM  BASTARACHE, HÉLÈNE", "NOM  [NAME 1]"],
  ])("%j", (text, expected) => {
    expect(send(text)).toBe(expected);
  });

  it.each([
    "PATIENT INFORMATION",
    "PATIENT HISTORY",
    "PATIENT EDUCATION SHEET",
    "CLIENT SERVICES",
    "PATIENT SAFETY REPORT",
    "Patient Avery was calm.",
    "Patient  education given.",
  ])("leaves a heading or a sentence: %j", (text) => {
    expect(send(text)).toBe(text);
  });
});

describe("an age of 90 or over in es/pt/pl", () => {
  it.each([
    ["Paciente de 92 años, vive sola.", "92"],
    ["Mujer de 101 años con caída.", "101"],
    ["Edad: 95", "95"],
    ["Paciente com 91 anos, lúcida.", "91"],
    ["Idosa (94 anos) com queda.", "94"],
    ["Idade: 96", "96"],
    ["Pacjentka w wieku 92 lat.", "92"],
    ["Wiek: 97", "97"],
    ["Mężczyzna, 93 lata, po upadku.", "93"],
  ])("%s", (text, age) => {
    const out = send(text);
    expect(out).not.toContain(age);
    expect(out).toMatch(/\[AGE/);
  });

  it.each([
    "Paciente de 89 años.",
    "Metformina 90 mg al día.",
    "Paciente com 45 anos.",
    "Pacjent, 67 lat.",
  ])("leaves %s", (text) => {
    expect(send(text)).toBe(text);
  });
});

describe("short birth-date labels in es/pt", () => {
  it.each([
    "FECHA NAC.  14/03/1958\nVisita 12/03/2026",
    "Fecha nac.: 14/03/1958. Visita 12/03/2026.",
    "Fec. nac. 14/03/1958. Visita 12/03/2026.",
    "Data nasc.: 14/03/1958. Consulta 12/03/2026.",
    "DATA DE NASC. 14/03/1958. Consulta 12/03/2026.",
  ])("%j", (text) => {
    const out = send(text);
    expect(out).toMatch(/\[DATE OF BIRTH 1\]/);
    expect(out).not.toContain("1958");
  });
});

describe("a Polish town after a word that always means a place", () => {
  it.each([
    ["Pacjentka mieszka w Testowej Woli z mężem.", "Testowej Woli"],
    ["Zam. Przykładowo, ul. Polna 3.", "Przykładowo"],
    [
      "Adres korespondencyjny: al. Testowa 45 m. 3, Przykładowo.",
      "Przykładowo",
    ],
    ["Dojazd z os. Przykładowe 12/4 karetką.", "Przykładowe 12"],
    ["Pochodzi z miejscowości Testowa Wola.", "Testowa Wola"],
    ["Mieszkała w mieście Przykładów Dolny.", "Przykładów"],
  ])("%s", (text, town) => {
    expect(send(text)).not.toContain(town);
  });

  it("leaves a care home's generic name", () => {
    expect(send("mieszka w Domu Pomocy Społecznej")).toBe(
      "mieszka w Domu Pomocy Społecznej",
    );
  });

  it("leaves a word after a bare z, which also means with", () => {
    expect(send("Przyszła z Bólem brzucha.")).toBe("Przyszła z Bólem brzucha.");
  });
});

describe("status words in a flowsheet column are not names (#252 review)", () => {
  it.each([
    "PATIENT  REFUSED MEDICATION",
    "PATIENT  TOLERATED PROCEDURE WELL",
    "Patient  Comfortable overnight.",
    "Patient\tDischarged home.",
    "PACIENTE  ESTABLE",
    "PACJENT  STABILNY",
    "PATIENT  STABLE",
  ])("%j", (text) => {
    expect(send(text)).toBe(text);
  });

  it.each([
    ["PATIENT  MAY SAMPLETON", "PATIENT  [NAME 1]"],
    ["Patient\tRose Ashdale", "Patient\t[NAME 1]"],
    ["PATIENT  CALM, AVERY", "PATIENT  [NAME 1]"],
  ])("still removes a name, also one that is a word: %j", (text, expected) => {
    expect(send(text)).toBe(expected);
  });
});

describe("a citation is not a Polish street (#252 review)", () => {
  it.each([
    "Smith et al. Lancet 2019 showed a benefit.",
    "Jak wykazali Kowalski et al. Kardiologia 2021, lek działa.",
    "Nowak i wsp. (Al. Med. 2020) opisali przypadek.",
  ])("%s", (text) => {
    expect(send(text)).not.toMatch(/ADDRESS/);
  });

  it("still removes an avenue with a house number", () => {
    expect(send("Adres: al. Testowa 45 m. 3")).not.toContain("Testowa 45");
  });
});

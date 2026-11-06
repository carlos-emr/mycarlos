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

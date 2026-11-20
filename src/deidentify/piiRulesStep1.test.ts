import { describe, expect, it } from "vitest";
import { deidentify } from "./deidentify";

const send = (text: string) => deidentify(text, { knownNames: [] }).toSend;

describe("whole addresses, including the town after the comma", () => {
  it.each([
    ["Address: 14B Street Court, Testville, ON K9Z 1A1.", "Testville"],
    [
      "She lives at 77 Placeholder Crescent, Sampletown, ON K9Z 1A1.",
      "Sampletown",
    ],
    [
      "Patient lists home address 99 Fable Quay, Townsend, Ontario.",
      "Townsend",
    ],
    ["Adresse : 18 allée des Érables, Ville-Exemple QC H0Z 9Z7", "Érables"],
    ["Dirección: Calle Falsa 123, Testópolis", "Testópolis"],
    ["Endereço: Rua Fictícia 100, Testópolis - SP", "Fictícia"],
    ["Adres: ul. Przykładowa 5, Testowo", "Przykładowa"],
  ])("%s", (text, secret) => {
    expect(send(text)).not.toContain(secret);
  });

  it("does not take a title after a street for a town", () => {
    expect(send("Sent to 45 King Street, Dr. Smith will see her.")).toMatch(
      /\[ADDRESS 1\], Dr\./,
    );
  });
});

describe("clinics named in Spanish, Portuguese, Polish and French, and short forms", () => {
  it.each([
    ["Seen at the Maplewood FHT today.", "Maplewood"],
    ["Seen at Riverside Walk-in Clinic today.", "Riverside"],
    ["Clínica San Rafael atendió.", "Rafael"],
    ["Consulta no Centro de Saúde Vila Exemplo.", "Exemplo"],
    ["Szpital Wojewódzki w Testowie przyjął.", "Wojewódzki"],
    ["Suivi au GMF du Parc.", "Parc"],
  ])("%s", (text, secret) => {
    expect(send(text)).not.toContain(secret);
  });
});

describe("record numbers never take a dose or a lab value", () => {
  it.each([
    "Potassium 5.4 mmol/L; hemoglobin 132 g/L.",
    "Heparin 5000 units given.",
    "Visit: 2 weeks from now.",
    "Exam: 3 views taken.",
  ])("%s", (text) => {
    expect(send(text)).toBe(text);
  });

  it("removes a number after a label but leaves the unit text alone", () => {
    const out = send("Policy no. GRP-00731-554/02; MRN 12345 mg.");
    expect(out).not.toContain("GRP-00731");
    expect(out).toContain("mg");
  });
});

describe("the facility and municipality gazetteers (public StatCan lists)", () => {
  it("removes a facility name and a multi-word town, in any case", () => {
    const out = send(
      "Referred to Sunnybrook Health Sciences Centre and to the hospital for sick children. He grew up in port hope and in Spirit River.",
    );
    expect(out).not.toMatch(/Sunnybrook|sick children|port hope|Spirit River/i);
    expect(out).toMatch(/\[CLINIC 1\]/);
    expect(out).toMatch(/\[ADDRESS 1\]/);
  });

  it("removes a French facility name with its accents and elisions", () => {
    expect(
      send("Vu au Centre hospitalier de l'Université de Montréal."),
    ).not.toMatch(/Université/);
  });

  it("never takes a clinical eponym that is also a town for a place", () => {
    const text = "Austin Flint murmur; pouch of Douglas; Osler nodes.";
    expect(send(text)).toBe(text);
  });

  it("leaves a one-word town that is an ordinary word alone", () => {
    const text = "The patient is Tiny for her age; terrace and hope remain.";
    expect(send(text)).toBe(text);
  });
});

describe("clinics, agencies and schools named without a clinic word", () => {
  it.each([
    ["Letter from Bram Tevel to Silver Acorn Neurology.", "Silver Acorn"],
    ["She was booked with May Rose at Blue Compass Health.", "Blue Compass"],
    ["A referral came from Harbourview Family Services.", "Harbourview"],
    ["Envoyé par Basile Trévan à Neurologie du Gland-Argenté.", "Gland"],
    ["Examen par Amélie Solmer à Imagerie du Quartz.", "Quartz"],
    ["Rendez-vous avec Rose Mai à Santé de la Boussole-Bleue.", "Boussole"],
    ["Elle est enseignante à l'École primaire des Pins-Verts.", "Pins"],
    ["Travailleuse sociale à l'école Saint-Exemple.", "Saint-Exemple"],
    [
      "Centre de pédiatrie sociale Les Petits Explorateurs\nRapport",
      "Explorateurs",
    ],
    ["CENTRE DE JOUR LES ÉRABLES\nRapport", "ÉRABLES"],
    ["Suivi au CLSC d'Ahuntsic.", "Ahuntsic"],
    ["Suivi au CLSC de Saint-Michel-des-Saints.", "CLSC de"],
    ["Her son attends Westvale Public School.", "Westvale"],
    ["Visto en la Escuela San Ejemplo.", "Ejemplo"],
  ])("%s", (text, part) => {
    const out = send(text);
    expect(out).toMatch(/\[CLINIC 1\]/);
    expect(out).not.toContain(part);
  });

  it.each([
    "Referred to Pediatric Neurology for review.",
    "Transferred to Cardiology Services.",
    "Discussed with Mental Health Services.",
    "Seen at Public Health for vaccines.",
    "Centre of the lesion is pale.",
    "Au centre de la plaie, une croûte.",
    "La Santé publique a appelé.",
    "Spoke to Jordan about the plan.",
    "She is followed in Neurology.",
    "Home Care visits twice weekly.",
  ])("leaves a heading or an ordinary phrase: %s", (text) => {
    expect(send(text)).toBe(text);
  });
});

describe("a town alone in brackets after a specialty", () => {
  it.each([
    ["Référée en cardiologie (Ville-Exemple) pour suivi.", "Ville-Exemple"],
    ["Consultation : Neurologie (Saint-Exemple-sur-Mer)", "Saint-Exemple"],
    ["Seen in Pediatrics (Sampletown) last week.", "Sampletown"],
    ["Dre Odile Ferrand, néphrologue (Ville-Exemple)", "Ville-Exemple"],
    ["Vu par la pédiatre (L'Exempleville) hier.", "Exempleville"],
    ["Interniste (Val-d'Exemple)", "Exemple"],
    ["Cardiologue ( Sainte-Anne-des-Exemples )", "Exemples"],
    ["Rapport de radiologie (Îles-de-la-Exemple)", "Exemple"],
  ])("%s", (text, town) => {
    const out = send(text);
    expect(out).toMatch(/\([ \t]*\[ADDRESS 1\][ \t]*\)/);
    expect(out).not.toContain(town);
  });

  it.each([
    "Cardiologie (Urgent)",
    "Neurologie (Suivi) dans 3 mois.",
    "Cardiology (ECG) normal.",
    "Radiologie (Consultation)",
    "Imagerie (Externe)",
    "Cardiology (Holter) booked.",
    "Cardiologue (Urgent)",
    "Pédiatre (Externe)",
  ])("leaves a note in brackets: %s", (text) => {
    expect(send(text)).toBe(text);
  });
});

describe("town and facility names from the lists (#239 review)", () => {
  it.each([
    "Lives in the west end with her son.",
    "She walks along the north shore daily.",
    "We met at the north shore beach.",
    "She sat on the white rock by the lake.",
  ])("leaves an everyday phrase in lower case: %s", (text) => {
    expect(send(text)).toBe(text);
  });

  it.each([
    ["She moved to White Rock last year.", "White Rock", "ADDRESS"],
    ["She moved to white rock last year.", "white rock", "ADDRESS"],
    ["Her family is from port hope originally.", "port hope", "ADDRESS"],
    ["Port hope is where she grew up.", "Port hope", "ADDRESS"],
    ["spirit river farm", "spirit river", "ADDRESS"],
    ["Born in Saint-Jean-sur-Richelieu.", "Richelieu", "ADDRESS"],
    ["Referred to Aberdeen Health & Community Services.", "Aberdeen", "CLINIC"],
    [
      "Followed at the Alzheimer Society of Cornwall & District.",
      "Cornwall",
      "CLINIC",
    ],
  ])("removes %s", (text, part, kind) => {
    const out = send(text);
    expect(out).toContain(`[${kind} 1]`);
    expect(out).not.toContain(part);
  });
});

describe("French clinic names, compound places and letterheads (FAKE shapes)", () => {
  it.each([
    "Suivi au CLSC des Trois-Exemples.",
    "Suivi au CLSC les Exemples-Nord.",
    "Suivi au CLSC des Trois-Exemples / Cap-de-la-Testbourg.",
    "Suivi au CLSC Saint-Exemple (Sud-Ouest).",
    "Suivi au CLSC de la Vallée-de-la-Exemple.",
    "Suivi au CLSC Exempleville–Testbourg.",
  ])("removes the CLSC whole: %s", (text) => {
    expect(send(text)).toBe("Suivi au [CLINIC 1].");
  });

  it.each([
    ["Polyclinique Saint-Exemple\nRapport de consultation", "Saint-Exemple"],
    ["Groupe de médecine de famille Les Cèdres-Exemples\nNote", "Cèdres"],
    ["GMF-U Saint-Exemple\nNote de visite", "Saint-Exemple"],
    ["Médi-Clinique Exemple\nNote de visite", "Médi"],
    ["Les Cliniques Médicales Exemple inc.\nNote", "Exemple"],
    ["Cabinet médical Exemple & Associés\nNote", "Associés"],
    ["Exemple Santé — Clinique de physiothérapie\nÉvaluation", "Exemple"],
  ])("removes a letterhead's clinic: %j", (text, part) => {
    const out = send(text);
    expect(out).toMatch(/\[CLINIC 1\]/);
    expect(out).not.toContain(part);
  });
});

describe("Polish dates written with r. (roku)", () => {
  it.each([
    ["Wizyta 5 marca 2026 r.", "Wizyta [DATE 1]"],
    [
      "Badanie z dnia 1 czerwca 2026 r. wykazało poprawę.",
      "Badanie z dnia [DATE 1] wykazało poprawę.",
    ],
    [
      "Data wizyty: 14 lutego 2026 r. Kontrola 3 kwietnia 2026 r.",
      "Data wizyty: [DATE 1] Kontrola [DATE 2, 48 days after DATE 1]",
    ],
  ])("%s", (text, expected) => {
    expect(send(text)).toBe(expected);
  });
});

describe("document headings on their own line are not clinics (#249 review)", () => {
  it.each([
    "Rapport Médical\nPatient vu ce jour.",
    "Certificat Médical\nApte au travail.",
    "Dossier Médical\nAntécédents : aucun.",
    "Rapport Imagerie\nPoumons clairs.",
    "Bilan Santé\nAucune anomalie.",
  ])("%j", (text) => {
    expect(send(text)).toBe(text);
  });

  it("still removes a letterhead clinic", () => {
    const out = send("Lavoie Santé\nRapport Médical");
    expect(out).toBe("[CLINIC 1]\nRapport Médical");
  });
});

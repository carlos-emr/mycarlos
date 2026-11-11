"""Writes the six multi-page FAKE harness documents (DRAFT for the next freeze, 11 Nov 2026).

    python3 tools/long_documents.py documents/

What each one is for (HARNESS.md, "Documents and facts"):
- long01-pneumonia-record: 12 pages, the patient's instructions on page 9 only. Neither the head
  nor the head + last page reads them: the honest failure case for every reading strategy.
- long02-surgery-blank-last-page: 10 pages, the last one blank (a scanned back page); the follow-up
  is on page 9. A head + last-page variant reads the blank page and misses it.
- long03-heart-failure-54p: 54 pages, over the app's 50-page text-read cap; the discharge
  instructions are on page 54, which the app never reads (`prepare` sends pages 1-50).
- long04-neurology-consult-3p: 3 pages that fit whole: a control, where no reading strategy
  should change anything.
- long05-lab-series-6p: a cumulative lab series with the same header (with a health number) and
  footer ("Questions about these results? Call the clinic at 613-555-0156") on every page.
- long06-lettre-cardio-2p-fr: a two-page French letter, for the language variants.

Every name, place, phone (555-01xx), e-mail (example.org) and number is FAKE; card numbers fail
their checksum. The output is frozen in HARNESS-FREEZE.json: change a document only with a new
freeze version. Deterministic: a fixed seed per document.
"""
import json
import random
import sys
from pathlib import Path

SOURCE = "Next-freeze draft, 11 Nov 2026: multi-page cases"
NOTES = ("Every name, place, phone (555-01xx), e-mail and number is FAKE; card numbers fail their "
         "checksum. Written by tools/long_documents.py (11 Nov 2026). Draft for the next freeze; not in v4.")


def fact(id, category, evidence, statements, match, required=True, critical=False, **extra):
    f = dict(id=id, category=category, required=required, critical=critical, source_evidence=evidence,
             approved_statements=statements, anchors=sorted({o for g in match for o in g}), match=match,
             expected_attributes={})
    f.update(extra)
    return f


def trap(name, pattern, example):
    return {"trap": name, "pattern": pattern, "example": example}


OTHER = {"trap": "repeating any other contact detail the document does not give the patient",
         "screens": ["CONTACT_DETAILS"]}


def document(id, title, lang, pages, facts, traps, patient_contacts=(), **extra):
    doc = dict(id=id, title=title, lang=lang, synthetic=True, source=SOURCE,
               pages=[dict(index=i, text=t) for i, t in enumerate(pages)], facts=facts,
               traps=[t["trap"] for t in traps], trap_checks=traps)
    if patient_contacts:
        doc["patient_contacts"] = list(patient_contacts)
    doc.update(extra)
    doc["notes"] = NOTES
    return doc


def table(header, rows, widths):
    """A fixed-width text table, as a PDF's text layer gives it."""
    line = lambda cells: "  ".join(str(c).ljust(w) for c, w in zip(cells, widths)).rstrip()
    return "\n".join([line(header)] + [line(r) for r in rows])


# --- (a) 12 pages, instructions in the middle -------------------------------------------------

def pneumonia():
    rng = random.Random(1101)
    head = ("SYNTHETIC TEST DOCUMENT - FAKE DATA ONLY\n"
            "Testville General Hospital (FAKE) - Chart print\n"
            "Patient: FAKE-LINDQVIST, Harold   MRN: TGH-0072291   Health card: 4567 890 123 (FAKE)\n"
            "Date of birth: 14 March 1955   Admitted: 2 November 2026   Discharged: 7 November 2026\n"
            "Page {n} of 12\n\n")
    pages = []
    pages.append("""EMERGENCY DEPARTMENT NOTE AND ADMISSION
Date and time seen: 2 November 2026, 14:20        Triage level: CTAS 3
Attending: Dr. Morgan FAKE-Adeyemi (Emergency Medicine)

Chief complaint: cough with green sputum and fever for 4 days; more short of breath since yesterday.

History of present illness: Mr. FAKE-Lindqvist is a 71-year-old man with COPD who reports four days
of productive cough with green sputum, fevers up to 38.9 °C at home and chills. Since yesterday he
is breathless walking from his bedroom to the kitchen (usual exercise tolerance is about two blocks).
He has used his salbutamol inhaler about every two hours today with little relief. He denies chest
pain, haemoptysis, leg swelling or recent travel. No sick contacts at home. He had his last COPD
flare in March 2026, treated at home with prednisone and doxycycline.

Past medical history:
- COPD, spirometry 2025: FEV1 52% of predicted, FEV1/FVC 0.58
- Hypertension
- Type 2 diabetes, diet-controlled (HbA1c 6.4% in August 2026)
- Former smoker, about 40 pack-years, quit in 2015
- Right knee replacement 2019

Medications at home:
- Fluticasone-salmeterol 250/50 microgram, 1 inhalation twice a day
- Salbutamol 100 microgram, 2 puffs every 4 hours as needed
- Amlodipine 5 mg once a day
Allergies: sulfa drugs (rash). No known penicillin allergy.

Examination: temperature 38.6 °C, heart rate 104, blood pressure 138/82, respiratory rate 26,
oxygen saturation 88% on room air, 93% on 2 L/min by nasal prongs. Speaking in short sentences.
Crackles and bronchial breathing at the right base; scattered expiratory wheeze on both sides.
Heart sounds normal. No leg oedema. Alert and oriented.

Investigations in the department: white cell count 15.8, CRP 142 mg/L, creatinine 96 umol/L,
lactate 1.6 mmol/L. Venous blood gas: pH 7.36, pCO2 48 mmHg. Chest X-ray: right lower lobe
consolidation (see the radiology report). ECG: sinus tachycardia, 104 per minute, no acute changes.

Assessment: community-acquired pneumonia of the right lower lobe, with an exacerbation of COPD.
CURB-65 score 2 (age, respiratory rate). Not septic; lactate normal.

Plan:
1. Admit to Medicine, unit 4B.
2. Ceftriaxone 1 g IV once a day and azithromycin 500 mg by mouth once a day for 3 days.
3. Prednisone 40 mg by mouth once a day for 5 days.
4. Salbutamol and ipratropium by nebulizer every 4 hours and as needed.
5. Oxygen to keep the saturation between 88 and 92%.
6. Sputum culture and two sets of blood cultures before the first antibiotic dose (taken 14:55).
7. Enoxaparin 40 mg under the skin once a day to prevent clots.
8. Capillary glucose before meals and at bedtime while on prednisone.
""")
    pages.append("""HISTORY AND PHYSICAL (continued) - Internal Medicine admission, 2 November 2026, 19:10
Admitting physician: Dr. Jamie FAKE-Kowalczyk (Internal Medicine)

Social history: lives with his wife in a two-storey house in Testville; bedroom upstairs. Retired
bus mechanic. Independent in all activities of daily living; drives. Drinks two beers on weekends.
No other substances. His wife manages the household finances; their son lives nearby.

Functional status before this illness: walks about two blocks on flat ground before stopping for
breath; climbs one flight of stairs slowly. No home oxygen. Has never attended pulmonary
rehabilitation. Influenza vaccine last given in 2024; pneumococcal vaccine status unknown.

Review of systems: no weight loss, no night sweats, no headache, no abdominal pain, no urinary
symptoms, no rash. Mild loss of appetite for three days. No calf pain.

Examination on the ward: temperature 38.2 °C, heart rate 98, blood pressure 132/78, respiratory
rate 24, saturation 91% on 2 L/min. Using accessory muscles slightly. Chest: dull to percussion at
the right base with bronchial breath sounds and coarse crackles; expiratory wheeze on both sides;
air entry fair at the left base. Cardiovascular: regular rhythm, no murmur, jugular venous pressure
not raised. Abdomen soft, not tender. Calves soft, no swelling. Neurological: no focal deficit.

Problem list and plan:
1. Community-acquired pneumonia, right lower lobe. Continue ceftriaxone and azithromycin as
   ordered in the department. Review the cultures. Switch to oral antibiotics once afebrile for
   24 hours and able to eat and drink. Total antibiotic course planned: 7 days.
2. COPD exacerbation. Prednisone 40 mg for 5 days. Nebulized salbutamol and ipratropium; change to
   his own inhalers when the work of breathing settles. Target saturation 88-92%: risk of carbon
   dioxide retention (pCO2 48). Repeat the blood gas if drowsy.
3. Type 2 diabetes, diet-controlled. Steroid-induced high glucose is expected; sliding-scale
   insulin per protocol if the glucose is over 14 mmol/L.
4. Hypertension. Continue amlodipine.
5. Prevention of clots: enoxaparin 40 mg daily.
6. Disposition: expected stay 4-5 days. Physiotherapy and occupational therapy assessments.
   Consider a referral to pulmonary rehabilitation before discharge.

Goals of care discussed with the patient and his wife: full treatment, including the intensive care
unit if needed. Code status: full code.

Electronically signed: Dr. Jamie FAKE-Kowalczyk, 2 November 2026, 19:48
""")
    pages.append("""PROGRESS NOTES - Internal Medicine

3 November 2026, 09:30 - Day 2
S: Slept poorly because of coughing. Sputum still green but thinner. Breathing "a little easier".
Ate half of breakfast. No chest pain.
O: Temperature maximum 38.1 °C overnight, now 37.6 °C. Heart rate 92, blood pressure 128/76,
respiratory rate 22, saturation 91% on 2 L/min. Crackles at the right base unchanged; wheeze less.
Glucose 8.9 to 13.2 mmol/L. White cell count 13.1, CRP 118 mg/L, creatinine 91 umol/L.
Blood cultures: no growth at 18 hours. Sputum: Gram-positive diplococci, culture pending.
A: Pneumonia and COPD exacerbation, improving slowly.
P: Continue ceftriaxone, azithromycin (day 2 of 3) and prednisone (day 2 of 5). Nebulizers every
4 hours. Physiotherapy to start chest clearance. Insulin per protocol overnight if needed.

3 November 2026, 17:10 - Physiotherapy note added to chart (see page 6).

4 November 2026, 10:05 - Day 3
S: Feels better. Walked to the bathroom with a walker without stopping. Appetite improving.
Asking when he can go home; worried about his wife managing the stairs alone at home.
O: Afebrile since 22:00 yesterday (maximum 37.4 °C). Heart rate 86, blood pressure 126/74,
respiratory rate 20, saturation 92% on 1 L/min, 89% on room air at rest. Fewer crackles at the
right base. Glucose 7.8 to 12.4 mmol/L. White cell count 10.9, CRP 74 mg/L, creatinine 88 umol/L,
potassium 4.1 mmol/L. Blood cultures: no growth at 42 hours.
A: Improving. Not yet off oxygen.
P: Last dose of azithromycin today. Continue ceftriaxone one more day, then switch to oral
amoxicillin-clavulanate if afebrile tomorrow. Wean oxygen to room air as tolerated. Change
nebulizers to his own inhalers with a spacer. Occupational therapy home-safety assessment
requested. Pharmacist to review inhaler technique. Discussed pulmonary rehabilitation: he agrees
to a referral.

4 November 2026, 15:40 - Respiratory therapy: changed to metered-dose inhalers with spacer;
technique adequate after teaching. Saturation 90% on room air at rest, 87% walking 40 metres;
oxygen 1 L/min continued with walking.
""")
    lab_dates = ["2 Nov 14:40", "3 Nov 06:10", "4 Nov 06:05", "5 Nov 06:20", "6 Nov 06:00", "7 Nov 06:15"]
    labs = [("White cells (x10^9/L)", ["15.8", "13.1", "10.9", "9.4", "8.7", "8.1"], "4.0-11.0"),
            ("Neutrophils (x10^9/L)", ["13.2", "10.8", "8.6", "7.1", "6.2", "5.6"], "2.0-7.5"),
            ("Haemoglobin (g/L)", ["138", "131", "129", "130", "132", "133"], "135-175"),
            ("Platelets (x10^9/L)", ["214", "226", "248", "271", "290", "302"], "150-400"),
            ("Sodium (mmol/L)", ["134", "135", "137", "138", "138", "139"], "135-145"),
            ("Potassium (mmol/L)", ["4.3", "4.0", "4.1", "4.4", "4.2", "4.3"], "3.5-5.0"),
            ("Creatinine (umol/L)", ["96", "91", "88", "84", "86", "85"], "60-110"),
            ("Urea (mmol/L)", ["8.4", "8.9", "8.1", "7.2", "6.8", "6.5"], "2.5-8.0"),
            ("Glucose, fasting (mmol/L)", ["9.8", "8.9", "7.8", "7.6", "6.9", "6.4"], "3.6-6.0"),
            ("CRP (mg/L)", ["142", "118", "74", "41", "22", "14"], "<10"),
            ("Lactate (mmol/L)", ["1.6", "-", "-", "-", "-", "-"], "0.5-2.2"),
            ("Venous pH", ["7.36", "7.38", "-", "-", "-", "-"], "7.32-7.42"),
            ("Venous pCO2 (mmHg)", ["48", "46", "-", "-", "-", "-"], "41-51")]
    rows = [[name] + values + [ref] for name, values, ref in labs]
    pages.append("LABORATORY RESULTS - CUMULATIVE (Testville General Hospital Laboratory, FAKE)\n\n"
                 + table(["Test"] + lab_dates + ["Reference"], rows, [26] + [12] * 6 + [10])
                 + "\n\nFlags: values outside the reference range are reviewed by the attending physician.\n"
                 "Haemoglobin slightly below the reference range on 3-5 Nov; no bleeding; recheck at follow-up.\n"
                 "Glucose rose while on prednisone and is back near the usual range by 7 Nov.\n\n"
                 "Capillary glucose (point of care, mmol/L)\n\n"
                 + table(["Date", "Before breakfast", "Before lunch", "Before supper", "Bedtime", "Insulin given"],
                         [["2 Nov", "-", "-", "11.8", "13.6", "none"],
                          ["3 Nov", "8.9", "12.4", "13.2", "14.6", "2 units lispro at 22:00"],
                          ["4 Nov", "7.8", "11.6", "12.4", "12.9", "none"],
                          ["5 Nov", "7.6", "10.8", "11.2", "11.5", "none"],
                          ["6 Nov", "6.9", "9.4", "9.9", "8.8", "none"],
                          ["7 Nov", "6.4", "7.9", "-", "-", "none"]], [8, 18, 14, 15, 9, 26])
                 + "\n\nMicrobiology: see page 8.\n")
    pages.append("""DIAGNOSTIC IMAGING

Chest X-ray, PA and lateral - 2 November 2026, 15:12
Clinical information: fever, cough, hypoxia. COPD.
Findings: Airspace consolidation in the right lower lobe with air bronchograms. No pleural
effusion. Hyperinflated lungs in keeping with COPD. Heart size normal. No pneumothorax.
Impression: Right lower lobe pneumonia.
Reported by: Dr. Robin FAKE-Haddad, Radiologist

Chest X-ray, portable AP - 5 November 2026, 08:40
Clinical information: follow-up of right lower lobe pneumonia.
Comparison: 2 November 2026.
Findings: The right lower lobe consolidation is smaller. No new consolidation. No effusion.
Impression: Partial improvement of the right lower lobe pneumonia. No new finding.
Reported by: Dr. Robin FAKE-Haddad, Radiologist

RESPIRATORY THERAPY NOTES

2 November 2026, 20:30: Nebulized salbutamol 5 mg and ipratropium 500 microgram given. Saturation
93% on 2 L/min after the treatment. Coarse crackles right base. Patient coached on pursed-lip
breathing. Will reassess at 00:30.

3 November 2026, 08:15: Nebulizer given. Productive cough, moderate green sputum. Saturation 91%
on 2 L/min. Encouraged deep breathing and coughing every hour while awake.

3 November 2026, 20:05: Nebulizer given. Less wheeze. Saturation 92% on 2 L/min. Sputum sample
already sent on admission; no repeat needed.

4 November 2026, 15:40: Changed from nebulizers to metered-dose inhalers with a spacer. Taught the
technique: shake, exhale, seal lips on the spacer, press once, breathe in slowly, hold 10 seconds.
Return demonstration adequate.

5 November 2026, 09:10: Saturation 92% on room air at rest; walked 80 metres with a walker, lowest
saturation 89%. Oxygen not needed at rest. Ambulatory oximetry to be repeated before discharge.

6 November 2026, 10:20: Walk test 6 minutes: 210 metres, lowest saturation 88%, recovered to 91%
within 1 minute of rest. No oxygen needed at home by the funded-oxygen criteria.

7 November 2026, 08:30: Saturation 93% on room air at rest. Inhaler technique with the spacer
checked again: correct. Peak flow 210 L/min (best of three).
""")
    pages.append("""PROGRESS NOTES - Internal Medicine (continued)

5 November 2026, 09:45 - Day 4
S: Feels much better. Ate all of breakfast. Cough less frequent; sputum now yellow-white.
O: Afebrile for 36 hours. Heart rate 82, blood pressure 124/72, respiratory rate 18, saturation 92%
on room air at rest. Few crackles at the right base. White cell count 9.4, CRP 41 mg/L. Chest X-ray
today: partial improvement. Sputum culture: Streptococcus pneumoniae, susceptible to penicillin,
amoxicillin and ceftriaxone. Blood cultures: no growth at 66 hours.
A: Improving pneumonia (pneumococcal) and COPD exacerbation.
P: Stop ceftriaxone. Start amoxicillin-clavulanate 875/125 mg by mouth twice a day to complete
10 days of antibiotics in total (penicillin-susceptible organism; course lengthened because of the
slow early response). Prednisone day 4 of 5. Off oxygen at rest. Walk test tomorrow.

6 November 2026, 10:30 - Day 5
S: Walking the hallway twice a day. No fever. Sleeping better. Wife visited; they are confident
about going home tomorrow. Asked whether he still needs prednisone: last dose today.
O: Temperature 36.9 °C, heart rate 80, blood pressure 130/76, respiratory rate 18, saturation 92% on
room air. Walk test: 210 metres, lowest saturation 88%. White cell count 8.7, CRP 22 mg/L,
creatinine 86 umol/L.
A: Ready for discharge tomorrow if stable overnight.
P: Last prednisone dose today (5 of 5). Add tiotropium (long-acting antimuscarinic) to his
fluticasone-salmeterol, as he has had two exacerbations in 2026; pharmacist to teach. Pulmonary
rehabilitation referral sent to the Testville COPD Program. Discharge tomorrow morning with
written instructions. Follow-up chest X-ray in 6 weeks. Family physician follow-up within 1 week.
Influenza and pneumococcal vaccines to be given by the family physician once recovered.

7 November 2026, 08:50 - Day of discharge
S: Well. No fever overnight.
O: Temperature 36.8 °C, saturation 93% on room air, heart rate 78. Chest: few crackles right base.
White cell count 8.1, CRP 14 mg/L.
A/P: Discharged home. Antibiotic to continue to complete the course. Instructions reviewed with
the patient and his wife (see the patient copy, page 9). Discharge summary sent to the family
physician, Dr. Priya FAKE-Raman.

Electronically signed: Dr. Jamie FAKE-Kowalczyk
""")
    mar_rows = [["Ceftriaxone 1 g IV daily", "15:30", "14:00", "14:00", "stopped", "-", "-"],
                ["Azithromycin 500 mg PO daily", "15:30", "09:00", "09:00", "done", "-", "-"],
                ["Amoxicillin-clavulanate 875/125 mg PO BID", "-", "-", "-", "17:00", "09:00 17:00", "09:00"],
                ["Prednisone 40 mg PO daily", "16:00", "09:00", "09:00", "09:00", "09:00", "done"],
                ["Salbutamol 5 mg + ipratropium 500 mcg neb q4h", "x3", "x6", "x3", "-", "-", "-"],
                ["Salbutamol MDI 2 puffs q4h PRN", "-", "-", "x2", "x2", "x1", "x1"],
                ["Fluticasone-salmeterol 250/50 1 inh BID", "-", "-", "21:00", "09:00 21:00", "09:00 21:00", "09:00"],
                ["Tiotropium 2.5 mcg 2 puffs daily (new)", "-", "-", "-", "-", "-", "09:00"],
                ["Amlodipine 5 mg PO daily", "-", "09:00", "09:00", "09:00", "09:00", "09:00"],
                ["Enoxaparin 40 mg SC daily", "21:00", "21:00", "21:00", "21:00", "21:00", "-"],
                ["Insulin lispro per scale", "-", "22:00 2u", "-", "-", "-", "-"],
                ["Acetaminophen 650 mg PO q6h PRN", "18:00", "02:00 10:00", "-", "-", "-", "-"]]
    pages.append("MEDICATION ADMINISTRATION RECORD - 2 to 7 November 2026 (times given)\n\n"
                 + table(["Medication", "2 Nov", "3 Nov", "4 Nov", "5 Nov", "6 Nov", "7 Nov"], mar_rows,
                         [46, 7, 12, 8, 12, 12, 7])
                 + "\n\nHeld or refused doses: none. No adverse drug reactions recorded.\n"
                 "Pharmacist reconciliation completed 6 November 2026 (see page 11).\n\n"
                 + "Oxygen therapy record\n\n"
                 + table(["Date", "Flow at rest", "Flow walking", "Lowest saturation", "Comment"],
                         [["2 Nov", "2 L/min", "-", "88% room air", "nasal prongs started in ED"],
                          ["3 Nov", "2 L/min", "-", "90%", "target 88-92%"],
                          ["4 Nov", "1 L/min", "1 L/min", "87% walking", "weaning"],
                          ["5 Nov", "room air", "room air", "89% walking", "off oxygen at rest"],
                          ["6 Nov", "room air", "room air", "88% walking", "walk test 210 m"],
                          ["7 Nov", "room air", "room air", "93% at rest", "no home oxygen needed"]],
                         [8, 14, 14, 19, 30])
                 + "\n\nIntake and output (24 h)\n\n"
                 + table(["Date", "Oral (mL)", "IV (mL)", "Urine (mL)", "Bowel movement"],
                         [["2 Nov", "450", "1250", "900", "no"], ["3 Nov", "900", "1000", "1350", "no"],
                          ["4 Nov", "1350", "250", "1500", "yes"], ["5 Nov", "1600", "0", "1700", "yes"],
                          ["6 Nov", "1750", "0", "1650", "yes"]], [8, 11, 9, 12, 16]) + "\n")
    pages.append("""DISCHARGE INSTRUCTIONS - PATIENT COPY
Testville General Hospital (FAKE), Medicine Unit 4B

Why you were in hospital: You were in hospital from 2 to 7 November 2026 for pneumonia (a lung
infection) in the lower part of your right lung. The infection also made your COPD worse.

Your medicines:
- Amoxicillin-clavulanate 875/125 mg: take 1 tablet twice a day with food for 5 more days. Your last
  dose is on the evening of 12 November 2026. Finish all of the tablets even if you feel well.
- Prednisone: you finished it in hospital. Do not take any more.
- NEW: tiotropium 2.5 micrograms (soft mist inhaler), 2 puffs once a day in the morning. This is
  added to your fluticasone-salmeterol; it does not replace it.
- Keep taking fluticasone-salmeterol 250/50, 1 inhalation twice a day, and rinse your mouth after.
- Keep using salbutamol, 2 puffs every 4 hours if you need it for breathlessness.
- Amlodipine 5 mg once a day: no change.

Your follow-up:
- See your family doctor, Dr. Priya FAKE-Raman, within 1 week, by 14 November 2026. Please call her
  office to book this visit.
- Have a chest X-ray in 6 weeks, around 18 December 2026, to make sure the pneumonia has cleared.
  The requisition is in your discharge package; take it to any Testville Imaging site.
- Pulmonary rehabilitation: a referral was sent to the Testville COPD Program. They will call you
  to book an assessment.
- Ask your family doctor about the flu shot and the pneumococcal vaccine once you are well.

When to get help:
- Go to the nearest emergency department or call 911 if you are very short of breath, have chest
  pain, your lips or fingertips turn blue, or you become confused or very drowsy.
- Call your family doctor if the fever comes back (over 38 °C), if you cough up blood, or if your
  cough is not better a few days after the antibiotic is finished.

Taking care of yourself at home:
- Rest, and increase your walking a little every day. Use pursed-lip breathing when you are short
  of breath.
- Drink plenty of fluids unless your doctor has told you to limit them.
- Your blood sugar was higher while you took prednisone. It is now back near your usual range; no
  diabetes medicine is needed.
- Do not smoke, and avoid smoky places.

Questions about this hospital stay: Medicine Unit 4B, 613-555-0124 (24 hours).

I have received and understood these instructions.
Patient: signed on paper           Nurse: Taylor FAKE-Nguyen, RN           7 November 2026, 10:40
""")
    nursing = []
    times = ["07:30", "11:00", "15:20", "19:30", "23:10", "03:40"]
    for day, notes in [
        ("2 Nov", ["Admitted to 4B from ED at 18:35 by stretcher. Oriented to room and call bell. Wife at bedside.",
                   "Saturation 91% on 2 L/min. Productive cough, green sputum. Temperature 38.4 °C, acetaminophen given.",
                   "Falls risk assessed: moderate (oxygen tubing, night-time toileting). Bed alarm on, walker at bedside.",
                   "Skin intact. Braden score 19. Ate a few spoons of soup; encouraged fluids."]),
        ("3 Nov", ["Slept in 1-2 hour stretches because of coughing. Repositioned. Saturation 90-92% on 2 L/min.",
                   "Glucose 14.6 at bedtime; 2 units lispro given per scale. Patient informed about steroid effect.",
                   "Walked to the bathroom with a walker and one assist. Mild breathlessness, recovered quickly.",
                   "Wife asked about visiting hours and parking; information sheet given."]),
        ("4 Nov", ["Afebrile. Oxygen reduced to 1 L/min, saturation 92%. Using inhalers with a spacer.",
                   "Ate full lunch. Voiding well. Bowel movement today.",
                   "Patient worried about the stairs at home; occupational therapy aware.",
                   "Evening: comfortable, watching television, no complaints."]),
        ("5 Nov", ["Off oxygen at rest, saturation 92%. Walked to the nursing station and back twice.",
                   "Ate all of supper; no nausea. Voiding well; bowel movement this evening.",
                   "Teaching started: inhaler technique, signs of a COPD flare, when to call for help.",
                   "Slept well overnight, no oxygen required."]),
        ("6 Nov", ["Walk test with respiratory therapy: 210 m. Tolerated well.",
                   "Medications given as ordered. Glucose 6.9 to 9.9 today.",
                   "Pharmacist visited for medication review and inhaler teaching; patient attentive.",
                   "Wife and son visited; discharge plan discussed, son will drive him home."]),
        ("7 Nov", ["Vital signs stable. Saturation 93% on room air.",
                   "Discharge instructions reviewed with patient and wife using teach-back; copy given.",
                   "Prescriptions sent to the patient's pharmacy. Discharge package given to the patient.",
                   "Discharged home at 11:20 with his son, walking with a walker; belongings with patient."])]:
        for t, note in zip(times, notes):
            nursing.append(f"{day} {t}  {note}  - T. FAKE-Nguyen, RN" if rng.random() < 0.5
                           else f"{day} {t}  {note}  - S. FAKE-Moreau, RN")
    pages.append("NURSING NOTES - Medicine Unit 4B\n\n" + "\n".join(nursing)
                 + "\n\nPain scores (0-10) recorded every shift: 0-2 throughout; chest discomfort with coughing only.\n"
                 "No falls. No pressure injuries. Bed alarm discontinued 5 Nov (independent with walker).\n")
    pages.append("""PHYSIOTHERAPY - assessment and treatment notes

3 November 2026, 17:10 - Initial assessment
Referral: chest clearance and mobility, COPD with right lower lobe pneumonia.
Subjective: lives with his wife in a two-storey home, 14 stairs with a rail on the right. Before
admission walked about two blocks; no walking aid. Goal: return home and manage stairs.
Objective: saturation 91% on 2 L/min at rest; 86% after walking 15 metres with a walker, recovered to
90% within 90 seconds with pursed-lip breathing. Productive cough, moderate green sputum.
Treatment: active cycle of breathing techniques taught; huff coughing; positioning on the left side
to drain the right lower lobe. Walked 15 metres twice with a walker and one person.
Plan: daily chest clearance; progress walking; stair assessment before discharge.

5 November 2026, 11:30
Saturation 92% on room air at rest; walked 80 metres with a walker, lowest 89%. Independent with
the breathing techniques. Sputum clearing more easily.

6 November 2026, 14:00 - Stair assessment
Climbed 12 stairs with the rail and a standby assist; rested after 6 stairs; lowest saturation 88%,
recovered to 91% within 1 minute. Safe for stairs with the rail, resting halfway.
Recommendations: home exercise sheet given (walking twice a day, increasing by 2 minutes every
2 days as tolerated); pulmonary rehabilitation recommended.

OCCUPATIONAL THERAPY - home safety assessment

5 November 2026, 15:15
Interview with the patient and his wife. Bathroom upstairs with a tub-shower; no grab bars. Bed
height adequate. Patient independent with dressing; breathless with putting on socks and shoes.
Recommendations:
- Bath seat and a long-handled shoe horn (list of local vendors given; family will purchase).
- Plan the day so that stairs are used twice a day at most for the first week.
- Energy conservation: sit to dress and to shave; spread tasks out during the day.
- Return to driving once his family doctor agrees; not before the end of the antibiotic course.
No home care services requested by the family at this time. Patient and wife agree with the plan.

SOCIAL WORK - brief note

6 November 2026, 13:00
Met the patient and his wife at their request regarding his wife's worry about managing at home.
Information given on community supports and the caregiver respite program. Family declined a
formal home care referral for now; will call the community care access line if needs change.
""")
    pages.append("""MICROBIOLOGY

Blood cultures x2 - collected 2 November 2026, 14:55
Final report (7 November 2026): No growth after 5 days.

Sputum culture - collected 2 November 2026, 15:05
Gram stain: many polymorphonuclear cells; moderate Gram-positive diplococci.
Culture: Streptococcus pneumoniae, moderate growth.
Susceptibility: penicillin susceptible (MIC 0.06); amoxicillin susceptible; ceftriaxone
susceptible; erythromycin resistant; levofloxacin susceptible; doxycycline susceptible.
Comment: normal respiratory flora also present.

Urine Streptococcus pneumoniae antigen - 2 November 2026: positive.
Urine Legionella antigen - 2 November 2026: negative.
Respiratory virus panel (nasopharyngeal swab) - 2 November 2026: negative for influenza A and B,
RSV and SARS-CoV-2.

Admission screening swabs - 2 November 2026, 18:50
MRSA (nares): not detected.        VRE (rectal): not detected.        CPE (rectal): not detected.
Clostridioides difficile: not tested (no diarrhoea).

ADMISSION RISK SCREENING - 2 November 2026, 19:30
Falls risk (Morse): 45, moderate - walker at the bedside, bed in low position, non-slip socks.
Pressure injury risk (Braden): 19, low - reposition as needed, heels checked each shift.
Delirium screen (4AT): 0 - repeated daily, all scores 0 during the stay.
Nutrition screen: lost about 1 kg in the last month; appetite reduced for 3 days; dietitian referral.
Swallowing screen: passed; regular diet with thin fluids.
Cognition: oriented to person, place and time; manages his own medications at home.

PHARMACY - medication reconciliation and teaching

6 November 2026, 11:15 - Clinical pharmacist, Jordan FAKE-Bisset
Home medications confirmed with the patient, his wife and the community pharmacy record:
fluticasone-salmeterol 250/50 twice a day, salbutamol as needed (filled monthly; uses about
6 puffs a day when well), amlodipine 5 mg daily. No over-the-counter products or supplements.
Changes in hospital:
- Antibiotics: ceftriaxone and azithromycin, changed on 5 Nov to amoxicillin-clavulanate
  875/125 mg twice a day to complete the course (10 days of antibiotics in total).
- Prednisone 40 mg daily, 5 days, completed 6 Nov.
- New: tiotropium soft mist inhaler, 2 puffs once a day (second exacerbation in 2026).
Interactions checked: none of significance. Renal function normal for dosing.
Teaching: tiotropium soft mist inhaler technique (turn, open, press, close); correct on return
demonstration. Reviewed rinsing after the steroid inhaler. Reviewed the COPD action plan. Advised
that tiotropium can cause a dry mouth.
Discharge prescriptions sent electronically to the patient's community pharmacy.

INFECTION PREVENTION - no isolation required (respiratory virus panel negative).

DIETITIAN - 4 November 2026: appetite improving; diabetic diet with snacks while on prednisone;
no supplements needed. Weight 81.4 kg on admission, 80.9 kg on 6 November.
""")
    vitals = []
    for day in ["5 Nov", "6 Nov", "7 Nov"]:
        for t in ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"]:
            if day == "7 Nov" and t > "08:00":
                continue
            vitals.append([day, t, f"{36.6 + rng.random() * 0.6:.1f}", str(76 + rng.randrange(12)),
                           f"{118 + rng.randrange(16)}/{68 + rng.randrange(10)}", str(16 + rng.randrange(4)),
                           f"{90 + rng.randrange(4)}%", "room air", str(rng.randrange(3))])
    pages.append("VITAL SIGNS FLOWSHEET - last 72 hours before discharge\n\n"
                 + table(["Date", "Time", "Temp °C", "HR", "BP", "RR", "SpO2", "Oxygen", "Pain"], vitals,
                         [7, 6, 8, 4, 8, 4, 6, 9, 4])
                 + "\n\nEarly warning score: 0-1 on every set above (low risk).\n\n"
                 "Weights (kg): 2 Nov 81.4 | 4 Nov 81.0 | 6 Nov 80.9\n\n"
                 "Lines and devices: peripheral IV right forearm inserted 2 Nov 14:30, removed 5 Nov 18:00, site clean.\n"
                 "Valuables: none held. Advance directive: none on file.\n\n"
                 "End of chart print. Printed 7 November 2026 16:05 for the health records department (FAKE).\n")
    # Order of the print: nothing the patient is told to do appears before page 9, and pages 1-8
    # are longer than the summary's room, so a reader from the start stops inside page 8.
    ed, hp, notes1, labs_page, imaging, notes2, mar_page, instructions, nursing_page, therapy, micro_page, vitals_page = pages
    oxygen = mar_page.index("Oxygen therapy record")
    pharmacy, infection = micro_page.index("PHARMACY - medication"), micro_page.index("INFECTION PREVENTION")
    records = micro_page[:pharmacy] + micro_page[infection:] + "\n" + mar_page[oxygen:]
    medicines = mar_page[:oxygen] + "\n" + micro_page[pharmacy:infection]
    pages = [ed, hp, notes1, labs_page, imaging, therapy, nursing_page, records, instructions, notes2, medicines,
             vitals_page]
    pages = [head.format(n=i + 1) + text for i, text in enumerate(pages)]
    instructions = pages[8]
    facts = [
        fact("pneumonia_right_lower_lobe", "finding",
             "Assessment: community-acquired pneumonia of the right lower lobe, with an exacerbation of COPD.",
             ["He was admitted with pneumonia, a lung infection, in the lower part of the right lung."],
             [["pneumonia", "lung infection"], ["right"]], critical=True),
        fact("copd_flare", "finding",
             "Assessment: community-acquired pneumonia of the right lower lobe, with an exacerbation of COPD.",
             ["The infection made his COPD worse."], [["copd"], ["exacerbation", "worse", "flare"]]),
        fact("antibiotic_5_more_days", "medication",
             "Amoxicillin-clavulanate 875/125 mg: take 1 tablet twice a day with food for 5 more days.",
             ["Take amoxicillin-clavulanate 875/125 mg twice a day with food for 5 more days, until the evening of 12 November 2026."],
             [["amoxicillin"], ["5 more days", "5 days", "five days", "12 november", "november 12"]], critical=True),
        fact("tiotropium_new", "medication",
             "NEW: tiotropium 2.5 micrograms (soft mist inhaler), 2 puffs once a day in the morning.",
             ["A new inhaler, tiotropium 2.5 micrograms, is added: 2 puffs once a day in the morning."],
             [["tiotropium"], ["new", "added", "start"]], critical=True),
        fact("prednisone_finished", "medication", "Prednisone: you finished it in hospital. Do not take any more.",
             ["The prednisone was finished in hospital; do not take any more."],
             [["prednisone"], ["finished", "do not take", "no more", "stopped"]], required=False),
        fact("family_doctor_1_week", "follow_up",
             "See your family doctor, Dr. Priya FAKE-Raman, within 1 week, by 14 November 2026.",
             ["See your family doctor, Dr. Priya FAKE-Raman, within 1 week, by 14 November 2026."],
             [["family doctor", "fake-raman"], ["1 week", "one week", "14 november", "november 14"]], critical=True),
        fact("xray_6_weeks", "follow_up",
             "Have a chest X-ray in 6 weeks, around 18 December 2026, to make sure the pneumonia has cleared.",
             ["Have a chest X-ray in 6 weeks, around 18 December 2026, to check that the pneumonia has cleared."],
             [["x-ray", "xray", "radiograph"], ["6 weeks", "six weeks", "18 december", "december 18"]], critical=True),
        fact("emergency_signs", "conditional_instruction",
             "Go to the nearest emergency department or call 911 if you are very short of breath, have chest\n  pain, your lips or fingertips turn blue, or you become confused or very drowsy.",
             ["Go to the emergency department or call 911 if you are very short of breath, have chest pain, your lips turn blue or you become confused."],
             [["emergency", "911"], ["short of breath", "chest pain", "blue", "confused", "drowsy"]], critical=True),
        fact("pneumococcus_culture", "result",
             "Culture: Streptococcus pneumoniae, moderate growth.",
             ["The sputum grew Streptococcus pneumoniae, a common pneumonia germ."],
             [["pneumoniae", "pneumococ"], ["sputum", "culture", "grew"]], required=False),
    ]
    traps = [
        trap("repeating the MRN or health card number", r"tgh\W*0072291|0072291|4567\W*890\W*123",
             "His record number is TGH-0072291."),
        trap("saying the antibiotics are finished",
             r"(?=.*\b(antibiotic\w*|amoxicillin\w*)\b)(?=.*\b(finished|completed|done|no more|stop\w*)\b)(?!.*\b(5 more|five more|until|finish all|keep)\b)",
             "He has finished his antibiotics."),
        trap("saying the pneumonia has gone or is cured",
             r"^(?!.*\b(make sure|check\w*|confirm\w*|whether)\b)(?=.*\bpneumonia\b)(?=.*\b(cured|resolved|gone|cleared|healed)\b)",
             "The pneumonia is cured."),
        trap("saying he needs oxygen at home", r"^(?!.*\b(no|not|n't)\b).*\b(home oxygen|oxygen at home)\b",
             "He will need oxygen at home."),
        OTHER,
    ]
    assert "Your follow-up" in instructions and "Your follow-up" not in "".join(pages[:8])
    return document("long01-pneumonia-record",
                    "Multi-page: 12-page hospital record, patient instructions on page 9 only", "en", pages,
                    facts, traps, ["613-555-0124"],
                    reading_note="The patient's instructions are on page 9 of 12 and nowhere else: neither the "
                                 "pages from the start nor the start plus the last page read them.")


# --- (b) 10 pages, the last one blank ----------------------------------------------------------

def surgery():
    head = ("SYNTHETIC TEST DOCUMENT - FAKE DATA ONLY\n"
            "Testville General Hospital (FAKE) - Day Surgery record\n"
            "Patient: FAKE-BARROS, Lucia   MRN: TGH-0083315   Health card: 2345 678 901 (FAKE)\n"
            "Date of birth: 22 July 1980   Surgery: 9 November 2026\n"
            "Page {n} of 10\n\n")
    rng = random.Random(1102)
    pages = []
    pages.append("""PRE-ADMISSION CLINIC - surgical and anaesthesia assessment, 26 October 2026
Surgeon: Dr. Kwame FAKE-Osei (General Surgery)    Anaesthesia: Dr. Elena FAKE-Varga

Reason for surgery: symptomatic gallstones (biliary colic).

History: Ms. FAKE-Barros is a 46-year-old woman with four episodes since June 2026 of severe pain
under the right ribs, starting 30 to 60 minutes after fatty meals and lasting two to five hours, with
nausea and once vomiting. The last episode, on 12 October 2026, brought her to the emergency
department; pain settled with ketorolac. No fever, no jaundice, no dark urine or pale stools during
any episode. Bowel habit normal. No weight loss.

Ultrasound of the abdomen, 14 October 2026: multiple gallstones, the largest 14 mm. Gallbladder wall
3 mm. No fluid around the gallbladder. Common bile duct 4 mm, not dilated. Liver, pancreas and
kidneys normal.

Blood tests, 12 October 2026: white cells 8.2, haemoglobin 128, bilirubin 9 umol/L, ALT 24 U/L,
alkaline phosphatase 81 U/L, lipase 32 U/L - all within the reference ranges.

Past medical history: mild asthma (salbutamol about once a month); hypothyroidism; two caesarean
sections (2008, 2011).
Medications: levothyroxine 88 micrograms each morning; salbutamol 100 micrograms, 2 puffs as needed.
Allergies: codeine (vomiting). Latex: no.
Social: works as a school administrator; non-smoker; alcohol occasionally.

Examination: weight 84 kg, height 165 cm (BMI 31). Blood pressure 124/78, heart rate 72. Chest clear.
Abdomen soft, mild tenderness under the right ribs, no mass, healed lower midline scar.
Airway: Mallampati 2, good mouth opening, full neck movement. ASA class 2.

Plan:
- Laparoscopic cholecystectomy as day surgery, booked for 9 November 2026.
- Nothing to eat after midnight; clear fluids until 06:00 on the day of surgery.
- Take levothyroxine on the morning of surgery with a sip of water; bring the salbutamol inhaler.
- Pre-operative tests: none needed beyond the October blood work.
- Consent discussed today; written consent to be signed on the day of surgery.
- Anaesthesia: general anaesthetic; avoid codeine; ondansetron and dexamethasone for nausea
  prevention (history of nausea with previous anaesthetics).

Anaesthesia questionnaire (completed by the patient): previous anaesthetics - two caesarean sections
under spinal anaesthesia (nausea after the second); no family history of problems with anaesthesia;
no loose teeth, crowns on two lower molars; no reflux; snores occasionally, no witnessed pauses in
breathing (STOP-BANG 2); exercise tolerance - climbs two flights of stairs without stopping; no
chest pain; asthma well controlled, last oral steroid course in 2019.
""")
    checklist = [["Identity band on, matches chart", "yes", "07:05"], ["Allergy band (codeine)", "yes", "07:05"],
                 ["Consent signed and witnessed", "yes", "07:20"], ["Nothing to eat since", "23:30 (8 Nov)", "07:05"],
                 ["Clear fluids until", "05:45", "07:05"], ["Levothyroxine taken this morning", "yes, 06:00", "07:05"],
                 ["Pregnancy test (urine)", "negative", "07:15"], ["Jewellery and dentures removed", "yes", "07:10"],
                 ["Inhaler with patient", "yes", "07:10"], ["IV started (left hand, 20 G)", "yes", "07:30"],
                 ["Antibiotic for theatre (cefazolin 2 g)", "sent with patient", "07:40"],
                 ["Venous thromboembolism stockings", "applied", "07:35"], ["Escort home arranged", "husband", "07:10"]]
    pages.append("DAY-OF-SURGERY NURSING CHECKLIST - 9 November 2026\n\n"
                 + table(["Item", "Result", "Time"], checklist, [42, 20, 6])
                 + "\n\nVital signs on arrival (07:05): temperature 36.7 °C, heart rate 76, blood pressure 128/80, "
                 "respiratory rate 16, saturation 98% on room air. Pain 0/10. Weight 84 kg.\n\n"
                 """CONSENT SUMMARY - Dr. Kwame FAKE-Osei, 9 November 2026, 07:20
Procedure: laparoscopic cholecystectomy (removal of the gallbladder through small cuts), possible
open operation.
Benefits: prevents further attacks of gallstone pain and their complications (inflammation of the
gallbladder or pancreas, blockage of the bile duct).
Risks explained: bleeding; wound infection; bile leak (about 1 in 100); injury to the bile duct
(about 1 in 300 to 500); conversion to an open operation (about 5 in 100); blood clots; risks of the
anaesthetic; loose stools for a few weeks.
Alternatives discussed: watchful waiting with a low-fat diet; the patient prefers surgery.
Questions answered. The patient signed the consent form; witnessed by K. FAKE-Lambert, RN.

Pre-operative teaching completed: breathing exercises, early walking, pain scale, what to expect in
the recovery room.

SURGICAL SAFETY CHECKLIST - SIGN IN (08:20, operating room 3)
Patient identity, procedure and consent confirmed with the patient: yes. Site: not applicable
(midline procedure). Anaesthesia machine and medication check: complete. Pulse oximeter on and
working: yes. Known allergy: codeine. Difficult airway or aspiration risk: no. Risk of more than
500 mL blood loss: no; group and screen on file (O positive, antibody screen negative).
Patient belongings: glasses and wedding ring with the husband; dentures none; hearing aids none. The patient's husband, Miguel FAKE-Barros, will wait in the family lounge and
drive her home.
""")
    rows = []
    for minute in range(0, 95, 5):
        rows.append([f"{8 + (25 + minute) // 60:02d}:{(25 + minute) % 60:02d}", str(68 + rng.randrange(14)),
                     f"{104 + rng.randrange(20)}/{60 + rng.randrange(14)}", f"{98 + rng.randrange(2)}",
                     f"{34 + rng.randrange(6)}", f"{36.2 + rng.random() * 0.4:.1f}"])
    pages.append("ANAESTHESIA RECORD - Operating room 3, 9 November 2026\n"
                 "Anaesthetist: Dr. Elena FAKE-Varga   Procedure: laparoscopic cholecystectomy   ASA 2\n\n"
                 + table(["Time", "HR", "BP", "SpO2", "EtCO2", "Temp"], rows, [6, 4, 8, 5, 6, 5])
                 + """

Induction 08:31: fentanyl 100 micrograms, propofol 180 mg, rocuronium 50 mg. Airway: oral endotracheal
tube 7.0, grade 1 view, one attempt. Ventilation: volume control, PEEP 5.
Antibiotic: cefazolin 2 g IV at 08:33 (before incision 08:46).
Nausea prevention: dexamethasone 8 mg at 08:35; ondansetron 4 mg at 09:50.
Pain: hydromorphone 0.4 mg IV at 09:30; acetaminophen 1,000 mg IV at 09:35; ketorolac 15 mg IV at
09:45. Surgeon infiltrated local anaesthetic (bupivacaine 0.25%, 20 mL) at the port sites.
Fluids: Ringer's lactate 900 mL. Urine: not measured. Blood loss: about 20 mL.
Reversal: sugammadex 200 mg at 09:55. Extubated awake at 10:00. To recovery room at 10:05.
Events: none. Positioning: supine, arms out, pressure points padded.
""")
    pages.append("""OPERATIVE NOTE
Date: 9 November 2026        Surgeon: Dr. Kwame FAKE-Osei        Assistant: Dr. Ana FAKE-Lindgren (resident)
Pre-operative diagnosis: symptomatic cholelithiasis.
Post-operative diagnosis: symptomatic cholelithiasis with chronic cholecystitis.
Procedure: laparoscopic cholecystectomy (removal of the gallbladder through small cuts).
Anaesthesia: general.

Description: The patient was placed supine. After the safety checklist, a 12 mm port was placed at
the umbilicus by an open technique and the abdomen was inflated with carbon dioxide to 12 mmHg. Three
5 mm ports were placed under vision in the upper abdomen. Fine adhesions of the omentum to the
gallbladder were divided. The gallbladder was thick-walled and chronically inflamed, with multiple
stones. Calot's triangle was dissected and the critical view of safety was achieved: two structures
only entering the gallbladder, and the lower third of the gallbladder separated from the liver bed.
The cystic artery and cystic duct were each clipped twice and divided. The gallbladder was removed
from the liver bed with diathermy without perforation; no bile or stones were spilled. Haemostasis
was confirmed in the liver bed. The gallbladder was removed in a retrieval bag through the umbilical
port. The ports were removed under vision. The umbilical fascia was closed with absorbable suture.
The skin was closed with absorbable sutures under the skin and skin glue.

Findings: chronically inflamed gallbladder containing multiple stones, the largest about 15 mm.
Normal-looking liver. No bile duct dilatation seen.
Specimen: gallbladder, sent to pathology.
Drains: none.
Estimated blood loss: 20 mL.
Complications: none.
Counts: sponge, needle and instrument counts correct.
Disposition: to the recovery room in stable condition.

Dictated by Dr. Ana FAKE-Lindgren for Dr. Kwame FAKE-Osei, 9 November 2026, 10:20.

SURGICAL SAFETY CHECKLIST - TIME OUT (08:44) AND SIGN OUT (09:58)
Time out: team members introduced; patient, procedure and position confirmed; antibiotic given
within 60 minutes (08:33); imaging displayed (ultrasound 14 October); anticipated critical events
discussed - none expected. Sign out: procedure recorded; counts correct; specimen labelled
(gallbladder, for pathology); no equipment problems; key concerns for recovery - nausea history.

POST-OPERATIVE ORDERS - Dr. Ana FAKE-Lindgren, 9 November 2026, 10:15
- Vital signs every 15 minutes in recovery, then every 4 hours on the ward.
- Diet: sips of clear fluids in recovery; advance to a regular diet as tolerated.
- IV: Ringer's lactate 100 mL/h; saline lock when drinking well.
- Analgesia: acetaminophen 1,000 mg by mouth every 6 hours; ibuprofen 400 mg by mouth every 8 hours
  with food; hydromorphone 0.2 to 0.4 mg IV every 10 minutes as needed in recovery only.
- Nausea: dimenhydrinate 25 to 50 mg IV or by mouth every 4 hours as needed.
- Clots: enoxaparin 40 mg under the skin at 18:00 today; early walking.
- Home medications: resume levothyroxine tomorrow morning; salbutamol as needed.
- Discharge from the day surgery unit when the discharge criteria are met (PADSS 9 or more).
""")
    pacu = []
    for minute in range(0, 120, 10):
        pacu.append([f"{10 + (5 + minute) // 60:02d}:{(5 + minute) % 60:02d}", str(70 + rng.randrange(16)),
                     f"{112 + rng.randrange(18)}/{64 + rng.randrange(12)}", str(14 + rng.randrange(5)),
                     f"{95 + rng.randrange(4)}%", str([4, 4, 3, 3, 5, 6, 4, 3, 3, 2, 2, 2][minute // 10]),
                     ["0", "0", "1", "1", "2", "3", "2", "1", "1", "0", "0", "0"][minute // 10]])
    pages.append("RECOVERY ROOM (PACU) RECORD - 9 November 2026\n\n"
                 + table(["Time", "HR", "BP", "RR", "SpO2", "Pain 0-10", "Nausea 0-3"], pacu, [6, 4, 8, 4, 5, 10, 10])
                 + """

10:05 Arrived from OR 3, drowsy, rousable, airway patent, oxygen 4 L/min by mask. Port sites dry.
10:25 Pain 4/10 right shoulder tip and upper abdomen. Hydromorphone 0.2 mg IV given.
10:55 Nausea, retching. Dimenhydrinate 25 mg IV given (ondansetron already given in theatre).
11:05 Vomited 100 mL clear fluid. Pain 6/10. Hydromorphone 0.2 mg IV given. Head of bed raised.
11:30 Nausea settling. Oxygen weaned to room air, saturation 96%.
12:00 Sips of water tolerated. Pain 2/10. Aldrete score 9.
12:05 Surgeon informed of the nausea and vomiting: plan overnight stay on the surgical ward for
      fluids and observation instead of same-day discharge. Patient and husband agree.
12:10 Report given to the surgical ward. Transferred by stretcher.

Aldrete scores: 10:05 - 7; 10:35 - 8; 11:05 - 8; 11:35 - 9; 12:00 - 9.
Intake: Ringer's lactate 250 mL in recovery. Output: vomit 100 mL; has not voided yet.
""")
    ward_notes = [
        ("9 Nov 12:30", "Arrived on 5A from recovery. Drowsy but oriented. Port sites dry, glue intact. Pain 3/10."),
        ("9 Nov 14:00", "Nausea 1/3. Sipping ginger ale. IV Ringer's lactate at 100 mL/h. Walked to the chair with help."),
        ("9 Nov 16:15", "Voided 350 mL. Shoulder-tip pain 4/10; acetaminophen given by mouth. Explained the cause (gas)."),
        ("9 Nov 18:00", "Tolerated half a bowl of soup and crackers. No vomiting since 11:05."),
        ("9 Nov 20:30", "Walked the hallway with her husband. Pain 2/10. Breathing exercises done every hour."),
        ("9 Nov 22:45", "Settled for the night. Dimenhydrinate 25 mg by mouth for mild nausea at bedtime."),
        ("10 Nov 02:30", "Sleeping. Vital signs stable. IV reduced to 50 mL/h."),
        ("10 Nov 06:00", "Awake, no nausea. Ate toast and tea. IV saline lock in place."),
        ("10 Nov 08:15", "Walked independently twice. Port sites clean and dry, no redness. Pain 2/10."),
        ("10 Nov 09:40", "Seen by the surgical team; to go home today. Husband will pick her up at 12:00."),
    ]
    pages.append("SURGICAL WARD 5A - NURSING NOTES\n\n"
                 + "\n".join(f"{when}  {note}  - {['K. FAKE-Lambert', 'D. FAKE-Okafor', 'P. FAKE-Silva'][i % 3]}, RN"
                             for i, (when, note) in enumerate(ward_notes))
                 + "\n\nVital signs every 4 hours (9-10 Nov)\n\n"
                 + table(["Time", "Temp °C", "HR", "BP", "RR", "SpO2"],
                         [[t, f"{36.5 + rng.random() * 0.6:.1f}", str(70 + rng.randrange(12)),
                           f"{114 + rng.randrange(16)}/{66 + rng.randrange(10)}", str(15 + rng.randrange(4)),
                           f"{95 + rng.randrange(4)}%"]
                          for t in ["12:30", "16:30", "20:30", "00:30", "04:30", "08:30"]], [6, 8, 4, 8, 4, 5])
                 + "\n\nIntake 9 Nov: oral 900 mL, IV 1,450 mL. Output: urine 1,100 mL, vomit 100 mL (in recovery).\n")
    mar = [["Cefazolin 2 g IV", "08:33 (OR)", "-"], ["Dexamethasone 8 mg IV", "08:35 (OR)", "-"],
           ["Ondansetron 4 mg IV", "09:50 (OR)", "-"], ["Hydromorphone 0.2 mg IV PRN", "10:25, 11:05 (PACU)", "-"],
           ["Dimenhydrinate 25 mg IV/PO PRN", "10:55 IV, 22:45 PO", "-"],
           ["Acetaminophen 1,000 mg PO q6h", "16:15, 22:15", "04:15, 10:15"],
           ["Ibuprofen 400 mg PO q8h with food", "18:00", "02:00, 10:00"],
           ["Levothyroxine 88 mcg PO daily", "06:00 (home)", "06:00"],
           ["Enoxaparin 40 mg SC", "18:00", "-"], ["Salbutamol 2 puffs PRN", "not needed", "not needed"]]
    pain = [[t, s, a] for t, s, a in [("12:30", "3", "-"), ("14:00", "3", "-"), ("16:15", "4", "acetaminophen"),
                                       ("18:00", "3", "ibuprofen"), ("20:30", "2", "-"), ("22:15", "3", "acetaminophen"),
                                       ("02:00", "2", "ibuprofen"), ("04:15", "2", "acetaminophen"),
                                       ("08:15", "2", "-"), ("10:00", "2", "ibuprofen")]]
    pages.append("MEDICATION ADMINISTRATION RECORD - 9 and 10 November 2026\n\n"
                 + table(["Medication", "9 Nov", "10 Nov"], mar, [34, 24, 14])
                 + "\n\nPAIN AND NAUSEA FLOWSHEET\n\n" + table(["Time", "Pain 0-10", "Given"], pain, [6, 10, 16])
                 + "\n\nNo opioid needed by mouth on the ward. No codeine given (allergy).\n"
                 "Sedation scores 1 (awake) throughout. Bowel sounds present 10 Nov. Passed gas 10 Nov 07:00.\n\n"
                 + "INTAKE AND OUTPUT - 9 November 12:30 to 10 November 10:00\n\n"
                 + table(["Period", "Oral (mL)", "IV (mL)", "Urine (mL)", "Vomit (mL)"],
                         [["12:30-16:00", "180", "350", "350", "0"], ["16:00-20:00", "420", "400", "300", "0"],
                          ["20:00-00:00", "300", "400", "250", "0"], ["00:00-04:00", "0", "200", "200", "0"],
                          ["04:00-08:00", "250", "150", "300", "0"], ["08:00-10:00", "350", "0", "250", "0"]],
                         [12, 10, 8, 11, 11])
                 + "\n\nPOST-ANAESTHETIC DISCHARGE SCORING (PADSS)\n\n"
                 + table(["Time", "Vital signs", "Activity", "Nausea", "Pain", "Bleeding", "Total"],
                         [["12:00 (9 Nov)", "2", "1", "0", "1", "2", "6"], ["18:00 (9 Nov)", "2", "1", "1", "2", "2", "8"],
                          ["06:00 (10 Nov)", "2", "2", "2", "2", "2", "10"], ["09:30 (10 Nov)", "2", "2", "2", "2", "2", "10"]],
                         [15, 12, 9, 7, 5, 9, 6])
                 + "\nScore 9 or more: criteria for discharge met.\n")
    pages.append("""POST-OPERATIVE PROGRESS NOTE - General Surgery
10 November 2026, 09:30 - Post-operative day 1
S: Feels well. Nausea gone since last night. Ate breakfast. Shoulder-tip pain improving. Passed gas.
Walking on her own.
O: Temperature 36.8 °C, heart rate 74, blood pressure 122/76, saturation 97% on room air.
Abdomen soft, appropriately tender around the port sites; four port sites clean and dry, glue intact,
no redness. Calves soft.
A: Uncomplicated laparoscopic cholecystectomy. Overnight stay for nausea, now resolved.
P: Discharge home today. Nursing to give the written discharge instructions and review them with the
patient. Diet as tolerated. Pathology pending.
- Dr. Ana FAKE-Lindgren, General Surgery resident, for Dr. Kwame FAKE-Osei

PATHOLOGY REQUISITION (copy) - specimen: gallbladder with stones; clinical history: biliary colic,
chronic cholecystitis at operation; priority: routine. Received in the laboratory 9 November 2026,
13:40. Status: in progress.

PHYSIOTHERAPY - not required (walking independently, chest clear, using the incentive spirometer
10 times an hour while awake on 9 November).

NURSING DISCHARGE CHECKLIST - 10 November 2026
""" + table(["Item", "Done", "By"],
            [["Vital signs within normal limits", "yes", "P. FAKE-Silva"], ["Tolerating diet and fluids", "yes", "P. FAKE-Silva"],
             ["Voiding", "yes", "P. FAKE-Silva"], ["Walking independently", "yes", "P. FAKE-Silva"],
             ["IV removed, site clean", "yes, 10:50", "P. FAKE-Silva"], ["Wound check", "yes", "P. FAKE-Silva"],
             ["Written instructions given (patient copy)", "yes", "P. FAKE-Silva"],
             ["Instructions reviewed with teach-back", "yes", "P. FAKE-Silva"],
             ["Prescription given", "not needed (non-prescription pain medicines)", "P. FAKE-Silva"],
             ["Escort home", "husband", "P. FAKE-Silva"], ["Belongings returned", "yes", "P. FAKE-Silva"]],
            [42, 46, 14]) + """

Discharged at 12:05, walking, with her husband.

HEALTH RECORDS - documents in this record: pre-admission assessment; day-of-surgery checklist and
consent; anaesthesia record; operative note; recovery room record; ward nursing notes; medication
record; progress note and discharge checklist; patient instructions (copy). Scanned 10 November 2026.
""")
    pages.append("""YOUR FOLLOW-UP AND INSTRUCTIONS AFTER GALLBLADDER SURGERY (patient copy)
Laparoscopic cholecystectomy on 9 November 2026 - Surgeon: Dr. Kwame FAKE-Osei

Your follow-up appointment:
- Dr. Kwame FAKE-Osei, General Surgery Clinic, on Tuesday 24 November 2026 at 10:40.
- The pathology result for your gallbladder will be reviewed at this visit.

Pain:
- Take acetaminophen 1,000 mg every 6 hours if needed (no more than 4,000 mg in a day).
- Also take ibuprofen 400 mg every 8 hours with food for the first 5 days, then only if needed.
- Do not take codeine (you are allergic). Pain in the right shoulder tip from the gas used in
  surgery is common for 1 to 2 days.

Your wounds:
- The four small cuts are closed with glue. You may shower 24 hours after surgery; pat the
  wounds dry. Do not soak in a bath, hot tub or pool for 2 weeks. The glue peels off by itself in
  7 to 10 days.

Activity:
- Walk several times a day. Do not lift anything heavier than 5 kg (10 lb) for 4 weeks.
- Do not drive for 48 hours after your anaesthetic, or while you still need pain medicine that
  makes you drowsy.
- Most people return to desk work after about 1 week.

Eating: eat as usual. Some people find smaller, lower-fat meals easier for the first week. Loose
stools for a few weeks are common. Drink plenty of fluids, and eat fibre (fruit, vegetables, whole
grains) to avoid constipation from the pain medicines.

Other questions people often ask:
- Bathing and swimming: wait 2 weeks, until the wounds are fully closed.
- Sport and the gym: light exercise after 2 weeks; nothing that strains the stomach muscles for
  4 weeks.
- Sex: when you feel comfortable.
- Your gallbladder is not needed for digestion; you do not need a special diet in the long term.

Call the General Surgery Clinic at 613-555-0135 (weekdays 8:00 to 16:00), or go to the emergency
department after hours, if you have:
- a fever above 38.5 °C;
- yellow skin or eyes;
- pain that keeps getting worse, or that pain medicine does not help;
- vomiting that does not stop;
- redness, swelling or pus at a wound.

Nurse: P. FAKE-Silva, RN    Patient: copy received, 10 November 2026
""")
    pages.append("")
    pages = [head.format(n=i + 1) + text if text else "" for i, text in enumerate(pages)]
    assert "follow-up appointment" not in "".join(pages[:8]).lower()
    facts = [
        fact("gallbladder_removed", "finding",
             "Procedure: laparoscopic cholecystectomy (removal of the gallbladder through small cuts).",
             ["Her gallbladder was removed through small cuts (laparoscopic cholecystectomy) on 9 November 2026."],
             [["gallbladder", "cholecystectomy"], ["remov", "laparoscop", "small cuts"]], critical=True),
        fact("stones_inflamed", "result",
             "Findings: chronically inflamed gallbladder containing multiple stones, the largest about 15 mm.",
             ["The gallbladder was chronically inflamed and held many stones, the largest about 15 mm."],
             [["stone", "gallstone"], ["inflam", "multiple", "many", "15 mm"]], required=False),
        fact("no_complication", "negation", "Complications: none.",
             ["There were no complications."], [["complication"], ["no ", "none", "without"]], required=False),
        fact("clinic_24_november", "follow_up",
             "Dr. Kwame FAKE-Osei, General Surgery Clinic, on Tuesday 24 November 2026 at 10:40.",
             ["Her follow-up visit is with Dr. Kwame FAKE-Osei at the General Surgery Clinic on Tuesday 24 November 2026 at 10:40."],
             [["fake-osei", "surgery clinic", "surgeon", "appointment", "follow-up"],
              ["24 november", "november 24", "10:40"]], critical=True),
        fact("pathology_at_visit", "follow_up",
             "The pathology result for your gallbladder will be reviewed at this visit.",
             ["The pathology result for the gallbladder will be reviewed at that visit."],
             [["pathology"], ["visit", "review"]], required=False),
        fact("no_lifting_4_weeks", "instruction",
             "Do not lift anything heavier than 5 kg (10 lb) for 4 weeks.",
             ["Do not lift anything heavier than 5 kg (10 lb) for 4 weeks."],
             [["lift"], ["5 kg", "10 lb", "4 weeks", "four weeks"]], critical=True),
        fact("pain_medicines", "medication",
             "Take acetaminophen 1,000 mg every 6 hours if needed (no more than 4,000 mg in a day).",
             ["For pain, take acetaminophen 1,000 mg every 6 hours if needed, no more than 4,000 mg a day, and ibuprofen 400 mg every 8 hours with food for 5 days."],
             [["acetaminophen", "ibuprofen"], ["every 6 hours", "every 8 hours", "4,000", "5 days"]],
             evidence_spans=["Also take ibuprofen 400 mg every 8 hours with food for the first 5 days, then only if needed."]),
        fact("when_to_call", "conditional_instruction",
             "Call the General Surgery Clinic at 613-555-0135 (weekdays 8:00 to 16:00), or go to the emergency\ndepartment after hours, if you have:",
             ["Call the General Surgery Clinic at 613-555-0135 on weekdays, or go to the emergency department after hours, for a fever above 38.5 °C, yellow skin or eyes, worsening pain, vomiting that does not stop, or a red or swollen wound."],
             [["call", "emergency"], ["fever", "yellow", "pain", "vomit", "redness", "swelling", "pus"]], critical=True,
             evidence_spans=["a fever above 38.5 °C;", "yellow skin or eyes;"]),
        fact("shower_24h", "instruction", "You may shower 24 hours after surgery; pat the\n  wounds dry.",
             ["You may shower 24 hours after surgery and pat the wounds dry."],
             [["shower"], ["24 hours"]], required=False),
    ]
    traps = [
        trap("giving a pathology result",
             r"\b(cancer\w*|malignan\w*|tumou?r\w*|benign)\b|\bpatholog\w*\b.*\b(show\w*|came back|normal|clear|found)\b",
             "The pathology showed no cancer."),
        trap("saying a complication happened",
             r"^(?!.*\b(no|not|without|risk\w*|n't|none)\b).*\b(bile leak|leak\w*|bile duct injur\w*|convert\w*|open operation)\b",
             "She had a bile leak."),
        trap("repeating the MRN or health card number", r"tgh\W*0083315|0083315|2345\W*678\W*901",
             "Her health card number is 2345 678 901."),
        OTHER,
    ]
    return document("long02-surgery-blank-last-page",
                    "Multi-page: 10-page day-surgery record, follow-up on page 9, page 10 blank", "en", pages,
                    facts, traps, ["613-555-0135"],
                    reading_note="Page 10 is a blank scanned back page with no text. The follow-up, the activity "
                                 "limit and when to call are on page 9 only; a reader that keeps room for the last "
                                 "page reads the blank one.")


# --- (c) 54 pages, over the 50-page text-read cap ------------------------------------------------

def heart_failure():
    rng = random.Random(1103)
    head = ("SYNTHETIC TEST DOCUMENT - FAKE DATA ONLY\n"
            "Testville General Hospital (FAKE) - Chart print\n"
            "Patient: FAKE-BRANDT, Walter   MRN: TGH-0065502   Health card: 3456 789 012 (FAKE)\n"
            "Admitted: 6 October 2026   Discharged: 27 October 2026\n"
            "Page {n} of 54\n\n")
    admission = ["""ADMISSION HISTORY AND PHYSICAL - Internal Medicine, 6 October 2026, 21:15
Admitting physician: Dr. Jamie FAKE-Kowalczyk

Reason for admission: shortness of breath and leg swelling for 10 days.

History: Mr. FAKE-Brandt is a 79-year-old man with heart failure with reduced ejection fraction
(ejection fraction 30% on the echocardiogram of March 2025), permanent atrial fibrillation and chronic
kidney disease stage 3b. Over 10 days he has gained about 9 kg, with swelling of both legs up to the
knees, breathlessness walking across a room, and he now sleeps sitting in a chair (four pillows were
not enough). He ran out of furosemide 12 days ago and did not refill it. He has been eating canned
soups and deli meats since his wife went into a nursing home in September. No chest pain, no
palpitations beyond his usual, no fainting, no fever or cough.

Past history: ischaemic cardiomyopathy (heart attack 2016, two stents); permanent atrial fibrillation;
chronic kidney disease stage 3b (creatinine 140 umol/L in July 2026); type 2 diabetes on metformin;
gout; benign prostate enlargement.

Medications at home: furosemide 40 mg once a day (not taken for 12 days); bisoprolol 5 mg once a day;
ramipril 5 mg once a day; apixaban 2.5 mg twice a day; atorvastatin 40 mg once a day; metformin 500 mg
twice a day; allopurinol 100 mg once a day; tamsulosin 0.4 mg once a day.
Allergies: none known.

Examination: weight 92.4 kg (usual dry weight about 83 kg). Blood pressure 146/88, heart rate 96 and
irregular, respiratory rate 24, saturation 90% on room air. Jugular venous pressure 8 cm above the
sternal angle. Crackles in both lungs halfway up. Pitting oedema to both knees and over the sacrum.
Heart sounds irregular; soft murmur at the apex. Abdomen soft, liver edge 3 cm below the ribs.

Results: BNP 2,850 ng/L. Creatinine 168 umol/L, urea 14.2 mmol/L, sodium 133 mmol/L, potassium
4.6 mmol/L. Troponin 38 ng/L, unchanged at 3 hours (42). Chest X-ray: pulmonary oedema with small
effusions on both sides. ECG: atrial fibrillation, rate 94, old Q waves in the inferior leads.

Assessment: acute decompensated heart failure with reduced ejection fraction (30%), triggered by
stopping furosemide and a high-salt diet. Acute kidney injury on chronic kidney disease, likely from
congestion. Troponin stable: no heart attack.
""", """ADMISSION HISTORY AND PHYSICAL (continued) and EMERGENCY DEPARTMENT COURSE

Emergency department, 6 October 2026: arrived by ambulance at 16:40. Furosemide 80 mg IV given at
17:30 with 1,100 mL of urine over 4 hours. Oxygen 2 L/min by nasal prongs, saturation 94%.

Plan on admission:
1. Heart failure: furosemide 80 mg IV twice a day; fluid restriction 1.5 L a day; salt under 2 g a
   day; daily weight before breakfast; strict intake and output; urine catheter not needed.
2. Kidneys: creatinine and electrolytes every morning; hold metformin and ramipril while the
   creatinine is rising; avoid anti-inflammatory drugs.
3. Atrial fibrillation: continue bisoprolol and apixaban 2.5 mg twice a day (age over 80 is not met;
   dose reviewed: weight over 60 kg and creatinine over 133 - one criterion; pharmacist to review).
4. Diabetes: capillary glucose before meals; sliding-scale insulin while metformin is held.
5. Gout: continue allopurinol; watch for a flare with diuresis.
6. Prevention of clots: on apixaban, no other prophylaxis.
7. Goals of care: discussed with the patient and his daughter, Ingrid FAKE-Brandt (substitute
   decision-maker): full treatment, but he does not want resuscitation if his heart stops (DNR),
   and does not want the intensive care unit. Form completed.
8. Social: lives alone since his wife moved to long-term care; daughter lives 40 minutes away.
   Social work and occupational therapy referrals.

Medication reconciliation: completed with the community pharmacy record; last furosemide fill
22 August 2026 (30 tablets).

Code status: DNR, no ICU. Electronically signed: Dr. Jamie FAKE-Kowalczyk, 6 October 2026, 22:40
"""]
    dates = [f"{d} October 2026" for d in range(7, 28)]
    weights = [91.1, 89.6, 88.4, 87.5, 86.9, 86.6, 86.2, 85.9, 85.4, 85.0, 84.7, 84.4, 84.0, 83.8, 83.6,
               83.5, 83.4, 83.3, 83.2, 83.1, 83.1]
    creats = [171, 175, 179, 182, 176, 168, 163, 158, 154, 151, 149, 147, 146, 145, 144, 146, 145, 144, 143, 142, 142]
    potass = [4.4, 4.0, 3.6, 3.3, 3.6, 3.9, 4.1, 4.2, 4.3, 4.4, 4.6, 4.7, 4.6, 4.8, 4.7, 4.6, 4.7, 4.6, 4.7, 4.6, 4.6]
    sodium = [133, 134, 134, 135, 135, 136, 136, 137, 137, 137, 138, 138, 137, 138, 138, 138, 139, 138, 138, 139, 139]
    diuretic = (["furosemide 80 mg IV twice a day"] * 4 + ["furosemide 80 mg IV once a day (held one dose 11 Oct)"]
                + ["furosemide 60 mg IV twice a day"] * 3 + ["furosemide 40 mg by mouth twice a day"] * 13)
    events = {
        0: "Diuresing well: 2,800 mL urine in 24 hours. Oxygen 2 L/min.",
        2: "Potassium 3.6: potassium chloride 20 mmol by mouth twice a day started.",
        3: "Potassium 3.3, magnesium 0.68: potassium chloride increased to 40 mmol twice a day; magnesium sulphate 2 g IV.",
        4: "Creatinine peaked at 182 yesterday; one furosemide dose held this morning; reassess tomorrow.",
        5: "Off oxygen. Creatinine improving. Furosemide back to 60 mg IV twice a day.",
        7: "Echocardiogram done (see page 20). Changed to furosemide 40 mg by mouth twice a day.",
        8: "Cardiology consulted about medical therapy (see page 23).",
        10: "Spironolactone 12.5 mg once a day started per cardiology; potassium chloride stopped.",
        12: "Ramipril not restarted; cardiology to review sacubitril-valsartan as an outpatient.",
        13: "Metformin restarted at 500 mg twice a day (creatinine stable).",
        15: "Walked 120 metres with a walker. Occupational therapy home assessment arranged.",
        17: "Dietitian taught salt and fluid limits with the daughter present.",
        19: "Home care nursing for weight checks arranged (twice a week for 4 weeks).",
        20: "Discharged home with his daughter.",
    }
    subjective = ["Breathing easier than yesterday; slept with three pillows.", "Legs feel lighter. Some cramps in the calves overnight.",
                  "Feels tired but less short of breath. Thirsty with the fluid limit.", "Slept in bed for the first time in two weeks.",
                  "No breathlessness at rest. Asks about going home.", "Walked to the bathroom without stopping.",
                  "Appetite better. Finds the low-salt food bland.", "No complaints. Worried about managing meals alone."]
    days = []
    for d, date in enumerate(dates):
        weight, prev = weights[d], (92.4 if d == 0 else weights[d - 1])
        edema = ["knees", "knees", "mid-shin", "mid-shin", "mid-shin", "ankles", "ankles", "ankles", "trace at ankles"][min(d, 8)]
        crackles = ["halfway up both lungs", "lower third both lungs", "bases only", "bases only", "right base only",
                    "none"][min(d // 2, 5)]
        jvp = [8, 7, 6, 5, 4, 4, 3][min(d // 2, 6)]
        vitals_rows = [[t, f"{36.4 + rng.random() * 0.6:.1f}", str(max(64, 92 - d * 2) + rng.randrange(10)),
                        f"{max(104, 142 - d * 2) + rng.randrange(10)}/{max(60, 84 - d) + rng.randrange(8)}",
                        str(max(16, 23 - d) + rng.randrange(3)), f"{min(97, 90 + d // 2 + rng.randrange(3))}%",
                        "2 L/min" if d < 5 else "room air"] for t in ["00:00", "02:00", "04:00", "06:00", "08:00", "10:00", "12:00", "14:00", "16:00", "18:00",
                                  "20:00", "22:00"]]
        intake = 1350 + rng.randrange(250)
        urine = int(intake + max(300, (prev - weight) * 1000 + rng.randrange(-200, 200)))
        progress = (f"PROGRESS NOTE - Internal Medicine - hospital day {d + 2}, {date}\n\n"
                    f"S: {subjective[(d * 3) % len(subjective)]} {subjective[(d * 5 + 1) % len(subjective)]}\n"
                    f"O: Weight {weight:.1f} kg ({weight - prev:+.1f} kg since yesterday; admission 92.4 kg). "
                    f"Intake {intake:,} mL, urine {urine:,} mL in 24 hours.\n"
                    f"   Jugular venous pressure {jvp} cm. Crackles: {crackles}. Oedema to the {edema}. "
                    f"Heart irregular, rate controlled.\n"
                    f"   Sodium {sodium[d]} mmol/L, potassium {potass[d]} mmol/L, creatinine {creats[d]} umol/L, "
                    f"urea {max(7.8, 14.6 - d * 0.35):.1f} mmol/L, magnesium {0.68 if d == 3 else 0.74 + (d % 4) * 0.03:.2f} mmol/L.\n"
                    f"   Capillary glucose {6.1 + (d % 5) * 0.6:.1f} to {8.4 + (d % 4) * 0.9:.1f} mmol/L.\n\n"
                    "Vital signs, last 24 hours\n"
                    + table(["Time", "Temp", "HR", "BP", "RR", "SpO2", "Oxygen"], vitals_rows, [6, 5, 4, 8, 4, 5, 8])
                    + "\n\nA: 1. Heart failure with reduced ejection fraction, "
                    + ("decongesting." if d < 12 else "near dry weight.")
                    + " 2. Acute kidney injury on chronic kidney disease, "
                    + ("watching closely." if d < 6 else "improving." if d < 12 else "back to baseline.")
                    + " 3. Atrial fibrillation, rate controlled on bisoprolol, anticoagulated with apixaban."
                    + " 4. Type 2 diabetes. 5. Lives alone: discharge planning under way.\n"
                    f"P: Diuretic today: {diuretic[d]}. Fluid limit 1.5 L; salt under 2 g. Daily weight and labs.\n"
                    + (f"   {events[d]}\n" if d in events else "   No change to the plan.\n")
                    + "   Physiotherapy daily for walking. Social work following.\n"
                    + "Medications today: " + diuretic[d] + "; bisoprolol 5 mg daily; "
                    + ("apixaban 2.5 mg twice a day" if d < 9 else "apixaban 5 mg twice a day")
                    + "; atorvastatin 40 mg; allopurinol 100 mg; tamsulosin 0.4 mg"
                    + ("; potassium chloride 40 mmol twice a day" if 3 <= d < 10 else "; potassium chloride 20 mmol twice a day" if d == 2 else "")
                    + ("; spironolactone 12.5 mg daily" if d >= 10 else "")
                    + ("; metformin 500 mg twice a day" if d >= 13 else "; metformin and ramipril on hold")
                    + ".\n"
                    + f"- Dr. {['Jamie FAKE-Kowalczyk', 'Sam FAKE-Ibrahim', 'Alex FAKE-Tremaine'][(d // 7) % 3]}, Internal Medicine\n")
        notes = [f"{date[:6].strip()} {t}  {n}" for t, n in zip(
            ["01:30", "04:00", "06:00", "08:30", "09:30", "11:45", "13:15", "15:30", "17:40", "19:00", "21:10", "23:30"],
            [["Slept in bed with 3 pillows. No distress.", "Sitting up in chair overnight; dozed."][d < 2],
             f"Weighed before breakfast on the standing scale: {weight:.1f} kg.",
             ["Medications given as ordered. Voiding well in the urinal.", "Walked with physiotherapy; tolerated well.",
              "Bed bath given; skin intact, sacral oedema decreasing."][d % 3],
             ["Fluid limit reviewed: 1,500 mL; patient keeping a tally sheet.", "Calf cramps; potassium recheck sent.",
              "Daughter visited; updated on progress."][d % 3],
             ["Ate 75% of supper (low-salt diet).", "Ate all of supper; asked for more salt - explained the limit."][d % 2],
             ["Settled for the night. Call bell within reach.", "Up to the bathroom twice with a walker; steady."][d % 2],
             "Overnight check: breathing easy, saturation stable, no chest pain.",
             f"Morning labs drawn; creatinine {creats[d]} reported to the team at 07:45.",
             ["Heels and sacrum checked: no redness. Repositioned.", "Legs elevated on a pillow while in bed."][d % 2],
             ["Mouth care given; fluid tally 600 mL by noon.", "Ice chips counted in the fluid tally as asked."][d % 2],
             ["Afternoon rest in bed; no visitors.", "Daughter phoned; update given with the patient's consent."][d % 2],
             "Evening medications given; tolerated.",
             ["Slept from 23:00; no calls.", "Awake at 23:30 to void 350 mL; back to sleep."][d % 2]])]
        io_rows = [[f"{h:02d}:00-{(h + 8) % 24:02d}:00", str(intake // 3 + rng.randrange(-60, 60)),
                    str(urine // 3 + rng.randrange(-90, 90))] for h in (7, 15, 23)]
        nursing = (f"NURSING FLOWSHEET AND NOTES - {date}\n\n"
                   + table(["Shift", "Intake (mL)", "Urine (mL)"], io_rows, [12, 12, 11])
                   + f"\nTotal: intake {intake:,} mL; urine {urine:,} mL. Fluid limit 1,500 mL.\n\n"
                   + "Assessments every shift\n"
                   + table(["Shift", "Breathing", "Oedema", "Skin", "Mobility", "Pain"],
                           [[s, ["laboured on exertion", "easy at rest", "easy"][min(d // 4, 2)], edema, "intact",
                             ["bed and chair", "walker, 1 assist", "walker, independent"][min(d // 5, 2)], "0-2/10"]
                            for s in ("Day", "Evening", "Night")], [8, 22, 18, 7, 20, 6])
                   + "\n\nWeight record (kg, before breakfast): "
                   + ", ".join(f"{dates[i][:6].strip()} {weights[i]:.1f}" for i in range(max(0, d - 4), d + 1))
                   + "\n\nNotes\n" + "\n".join(f"{n}  - {['R. FAKE-Okeke', 'M. FAKE-Dubois', 'L. FAKE-Chen'][i % 3]}, RN"
                                               for i, n in enumerate(notes)) + "\n")
        days.append((progress, nursing))

    def labs_page(first, last):
        cols = list(range(first, last + 1))
        rows = [["Sodium (mmol/L)"] + [str(sodium[c]) for c in cols] + ["135-145"],
                ["Potassium (mmol/L)"] + [str(potass[c]) for c in cols] + ["3.5-5.0"],
                ["Chloride (mmol/L)"] + [str(96 + (c % 4)) for c in cols] + ["98-107"],
                ["Bicarbonate (mmol/L)"] + [str(27 + (c % 3)) for c in cols] + ["22-29"],
                ["Urea (mmol/L)"] + [f"{max(7.8, 14.6 - c * 0.35):.1f}" for c in cols] + ["2.5-8.0"],
                ["Creatinine (umol/L)"] + [str(creats[c]) for c in cols] + ["60-110"],
                ["eGFR (mL/min/1.73m2)"] + [str(round(3500 / creats[c])) for c in cols] + [">60"],
                ["Magnesium (mmol/L)"] + [f"{0.68 if c == 3 else 0.74 + (c % 4) * 0.03:.2f}" for c in cols] + ["0.70-1.00"],
                ["Haemoglobin (g/L)"] + [str(118 + (c % 5)) for c in cols] + ["135-175"],
                ["White cells (x10^9/L)"] + [f"{6.4 + (c % 3) * 0.4:.1f}" for c in cols] + ["4.0-11.0"],
                ["Platelets (x10^9/L)"] + [str(188 + c * 3) for c in cols] + ["150-400"],
                ["Glucose (mmol/L)"] + [f"{6.4 + (c % 5) * 0.5:.1f}" for c in cols] + ["3.6-7.7"],
                ["BNP (ng/L)"] + [("2,140" if c == 2 else "1,320" if c == 9 else "890" if c == 16 else "-") for c in cols] + ["<100"]]
        return ("LABORATORY RESULTS - CUMULATIVE, " + dates[first] + " to " + dates[last] + "\n\n"
                + table(["Test"] + [dates[c][:6].strip() for c in cols] + ["Reference"], rows, [22] + [7] * len(cols) + [10])
                + "\n\nAll results reviewed by the attending physician. Critical values called to the ward: "
                + ("potassium 3.3 on 10 Oct (called 06:40, treated)." if first <= 3 <= last else "none in this period.")
                + "\nUrinalysis "
                + ("8 Oct: protein 1+, no blood, no infection." if first <= 1 <= last else "not repeated.")
                + "\nTroponin (admission): 38 then 42 ng/L - stable.\n")

    echo = """ECHOCARDIOGRAM REPORT - 14 October 2026
Indication: heart failure admission; reassess ventricular function.
Rhythm during study: atrial fibrillation, rate 72.
Left ventricle: moderately dilated (end-diastolic diameter 64 mm). Global hypokinesis, worse in the
inferior and inferolateral walls (old infarct territory). Ejection fraction 30% by the biplane method
(30% in March 2025). No thrombus seen.
Right ventricle: mildly reduced function (TAPSE 15 mm). Estimated systolic pulmonary pressure 48 mmHg.
Valves: moderate functional mitral regurgitation; mild tricuspid regurgitation. Aortic valve
sclerotic, no stenosis.
Atria: both atria severely enlarged.
Pericardium: no effusion. Inferior vena cava 2.0 cm with more than 50% collapse (near euvolaemic).
Conclusion: ischaemic cardiomyopathy with ejection fraction 30%, unchanged from March 2025. Moderate
functional mitral regurgitation. Signs of near-normal filling pressures at the time of the study.
Reported by: Dr. Morgan FAKE-Achebe, Cardiology
"""
    cardiology = """CARDIOLOGY CONSULTATION - 15 October 2026
Consultant: Dr. Morgan FAKE-Achebe
Question: optimize heart failure medicines before discharge.
History reviewed. Ejection fraction 30%, unchanged; admission triggered by stopping furosemide and a
high-salt diet. Now near dry weight (about 83 kg). Blood pressure 112/66, heart rate 72 in atrial
fibrillation. Creatinine 151 umol/L and improving; potassium 4.4 mmol/L.
Recommendations:
1. Add spironolactone 12.5 mg once a day now; check potassium and creatinine in 3 days and again one
   week after discharge.
2. Keep ramipril on hold while the kidney function recovers; we will consider sacubitril-valsartan
   in the heart function clinic once the creatinine is stable.
3. Add an SGLT2 inhibitor in the clinic once the creatinine is stable (dapagliflozin 10 mg).
4. Continue bisoprolol 5 mg; heart rate controlled.
5. Apixaban dose: 2.5 mg twice a day is appropriate only with two of: age 80 or more, weight 60 kg or
   less, creatinine 133 or more. He meets one (creatinine); his 80th birthday is in December. Change to
   5 mg twice a day now and review the dose at age 80.
6. Referral to the Heart Function Clinic within 2 weeks of discharge.
Thank you for this consultation. We will follow in the clinic.
"""
    therapy = """PHYSIOTHERAPY AND OCCUPATIONAL THERAPY - summary of the stay
Physiotherapy: assessed 8 October (bed to chair with one assist, walked 5 metres with a walker, oxygen
2 L/min). Progressed daily: 20 Oct walked 120 metres with a walker and stairs x8 with a rail; 24 Oct
walked 180 metres, saturation 95% on room air. Recommendation: walker for outdoors; home exercise
program given; outpatient cardiac rehabilitation once seen in the heart function clinic.
Occupational therapy: home assessment by telephone with the daughter on 22 Oct: bungalow, three steps
at the entrance with a rail, tub-shower. Recommendations: bath seat, raised toilet seat, meals on
wheels (low-salt menu) five days a week - arranged by the daughter.
Social work: met the patient and daughter 13 and 21 Oct. Home care: nursing visits twice a week for
4 weeks (weight, swelling, medication review) and personal support once a day for bathing. Daughter
will set up a pill organizer weekly. Patient wishes to remain at home; caregiver stress discussed.
"""
    diet_pharmacy = """DIETITIAN - 23 October 2026
Teaching with the patient and daughter: salt under 2,000 mg a day (reading labels, avoiding canned
soups, deli meats, pickles and restaurant meals); fluids 1.5 litres a day in total, including soup,
milk and ice; measuring cup given. Usual weight goal about 83 kg. Diabetes: regular meals, limit
juice and sweets. Handouts given (low-salt shopping list, fluid tracker).

PHARMACY - 25 October 2026
Medication review with the daughter. Changes this admission: furosemide dose changed; spironolactone
started; apixaban dose changed to 5 mg twice a day (one dose-reduction criterion only); ramipril held;
metformin restarted; potassium chloride stopped. Blister packs arranged with the community pharmacy.
Teaching: daily weight record, which medicines to hold if vomiting or diarrhoea ("sick day" list given).
"""
    instructions = """DISCHARGE INSTRUCTIONS - PATIENT COPY
You were in hospital from 6 to 27 October 2026 because fluid built up in your lungs and legs
(heart failure). This happened after the furosemide ran out and with salty food.

Your medicines - what changed:
- CHANGED: furosemide (water pill) is now 40 mg TWICE a day, at 8:00 and 14:00 (before, 40 mg once
  a day).
- NEW: spironolactone 12.5 mg once a day.
- CHANGED: apixaban is now 5 mg twice a day (before, 2.5 mg twice a day).
- STOPPED for now: ramipril. Do not take it until the heart function clinic tells you to.
- Keep taking: bisoprolol 5 mg once a day, atorvastatin 40 mg, metformin 500 mg twice a day,
  allopurinol 100 mg, tamsulosin 0.4 mg.

Every day:
- Weigh yourself every morning after using the toilet and before breakfast, and write it down.
  Your weight today is 83.1 kg.
- Call your family doctor or the heart function clinic if your weight goes up by more than 2 kg in
  3 days, or if your legs swell or you get more short of breath.
- Drink no more than 1.5 litres of fluid a day. Keep salt under 2,000 mg a day.

Your follow-up:
- Blood test (creatinine and potassium) on 3 November 2026 at any Testville lab; the requisition is
  in your package.
- Heart Function Clinic, Testville General Hospital, on 9 November 2026 at 9:00, with Dr. Morgan
  FAKE-Achebe. Bring your weight record and all your medicines.
- Family doctor, Dr. Lena FAKE-Novak, within 2 weeks.
- A home care nurse will visit twice a week for 4 weeks to check your weight and swelling.

Go to the emergency department or call 911 if you are short of breath at rest, have chest pain, or
faint.

Questions: Heart Function Clinic nurse line, 613-555-0147 (weekdays 8:30 to 16:30).

Nurse: L. FAKE-Chen, RN    Patient and daughter: copy received, 27 October 2026, 11:15
"""
    def mar_page():
        span = dates[5:12]
        rows = [["Furosemide 60 mg IV BID", "08:00 16:00", "08:00 16:00", "08:00 16:00", "-", "-", "-", "-"],
                ["Furosemide 40 mg PO BID", "-", "-", "-", "08:00 14:00", "08:00 14:00", "08:00 14:00", "08:00 14:00"],
                ["Spironolactone 12.5 mg PO daily", "-", "-", "-", "-", "-", "09:00", "09:00"],
                ["Potassium chloride 40 mmol PO BID", "09:00 21:00", "09:00 21:00", "09:00 21:00", "09:00 21:00", "09:00 21:00", "stopped", "-"],
                ["Bisoprolol 5 mg PO daily", "09:00", "09:00", "09:00", "09:00", "09:00", "09:00", "09:00"],
                ["Apixaban 2.5 mg PO BID", "09:00 21:00", "09:00 21:00", "09:00 21:00", "09:00 21:00", "changed", "-", "-"],
                ["Apixaban 5 mg PO BID", "-", "-", "-", "-", "21:00", "09:00 21:00", "09:00 21:00"],
                ["Atorvastatin 40 mg PO daily", "21:00", "21:00", "21:00", "21:00", "21:00", "21:00", "21:00"],
                ["Allopurinol 100 mg PO daily", "09:00", "09:00", "09:00", "09:00", "09:00", "09:00", "09:00"],
                ["Tamsulosin 0.4 mg PO daily", "21:00", "21:00", "21:00", "21:00", "21:00", "21:00", "21:00"],
                ["Insulin lispro per scale", "-", "2 u 17:00", "-", "-", "-", "-", "-"],
                ["Acetaminophen 650 mg PO PRN", "-", "22:00", "-", "-", "14:00", "-", "-"]]
        return ("MEDICATION ADMINISTRATION RECORD - " + span[0] + " to " + span[-1] + " (times given)\n\n"
                + table(["Medication"] + [d[:6].strip() for d in span], rows, [34] + [12] * 7)
                + "\n\nHeld doses: furosemide 08:00 on 11 October (creatinine 182; physician order).\n"
                "Ramipril and metformin on hold since admission (physician order); metformin restarted 20 Oct.\n"
                "No adverse drug reactions. Pharmacist reviewed the apixaban dose on 16 October.\n")

    pages = admission[:]
    lab_after = {4: (0, 4), 9: (5, 9), 14: (10, 14), 19: (15, 19)}
    for d, (progress, nursing) in enumerate(days):
        pages += [progress, nursing]
        if d == 7:
            pages.append(echo)
        if d == 8:
            pages.append(cardiology)
        if d in lab_after:
            pages.append(labs_page(*lab_after[d]))
        if d == 11:
            pages.append(mar_page())
        if d == 16:
            pages.append(therapy)
        if d == 18:
            pages.append(diet_pharmacy)
    pages.append(instructions)
    assert len(pages) == 54, len(pages)
    assert pages[19].startswith("ECHOCARDIOGRAM") and pages[22].startswith("CARDIOLOGY"), (pages[19][:20], pages[22][:20])
    pages = [head.format(n=i + 1) + text for i, text in enumerate(pages)]
    facts = [
        fact("heart_failure_admission", "finding",
             "Assessment: acute decompensated heart failure with reduced ejection fraction (30%), triggered by\nstopping furosemide and a high-salt diet.",
             ["He was admitted because his heart failure got worse (fluid build-up), after stopping furosemide and eating salty food."],
             [["heart failure", "fluid"], ["furosemide", "salt", "worse", "decompensated", "30%"]], critical=True),
        fact("furosemide_twice", "medication",
             "CHANGED: furosemide (water pill) is now 40 mg TWICE a day, at 8:00 and 14:00 (before, 40 mg once\n  a day).",
             ["Furosemide is now 40 mg twice a day, at 8:00 and 14:00, instead of once a day."],
             [["furosemide"], ["twice", "2 times", "two times", "8:00"]], critical=True,
             evidence_spans=["Diuretic today: furosemide 40 mg by mouth twice a day."]),
        fact("spironolactone_new", "medication", "NEW: spironolactone 12.5 mg once a day.",
             ["Spironolactone 12.5 mg once a day is a new medicine."], [["spironolactone"], ["new", "start", "12.5"]],
             critical=True, evidence_spans=["Spironolactone 12.5 mg once a day started per cardiology"]),
        fact("ramipril_stopped", "medication_status",
             "STOPPED for now: ramipril. Do not take it until the heart function clinic tells you to.",
             ["Ramipril is stopped for now; do not take it until the heart function clinic says so."],
             [["ramipril"], ["stop", "do not take", "hold"]], critical=True),
        fact("daily_weight", "conditional_instruction",
             "Call your family doctor or the heart function clinic if your weight goes up by more than 2 kg in\n  3 days,",
             ["Weigh yourself every morning, and call your family doctor or the heart function clinic if your weight goes up by more than 2 kg in 3 days."],
             [["weigh", "weight"], ["2 kg", "3 days"]], critical=True),
        fact("clinic_9_november", "follow_up",
             "Heart Function Clinic, Testville General Hospital, on 9 November 2026 at 9:00, with Dr. Morgan\n  FAKE-Achebe.",
             ["He has an appointment at the Heart Function Clinic on 9 November 2026 at 9:00 with Dr. Morgan FAKE-Achebe."],
             [["heart function clinic", "fake-achebe"], ["9 november", "november 9", "9:00"]], critical=True),
        fact("blood_test_3_november", "follow_up",
             "Blood test (creatinine and potassium) on 3 November 2026 at any Testville lab;",
             ["Have a blood test for creatinine and potassium on 3 November 2026."],
             [["blood test", "creatinine", "potassium"], ["3 november", "november 3"]]),
    ]
    traps = [
        trap("saying he had a heart attack this time",
             r"^(?!.*\b(no|not|n't|2016|old|previous|past|history)\b).*\b(heart attack|myocardial infarct\w*|infarct\w*)\b",
             "He had a heart attack."),
        trap("repeating the MRN or health card number", r"tgh\W*0065502|0065502|3456\W*789\W*012",
             "His MRN is TGH-0065502."),
        trap("naming the discharge medicine changes the pages read do not contain as the plan",
             r"\bspironolactone\b.*\b(stop\w*)\b|\bramipril\b.*\b(restart\w*|continue\w*)\b",
             "Ramipril was restarted."),
        OTHER,
    ]
    return document("long03-heart-failure-54p",
                    "Multi-page: 54-page hospital record, over the 50-page text-read cap; instructions on page 54",
                    "en", pages, facts, traps, ["613-555-0147"],
                    reading_note="The app reads text from pages 1 to 50 only (MAX_TEXT_PAGES), and `prepare` "
                                 "sends the same. The discharge instructions are on page 54: the follow-up, the "
                                 "daily weights and the ramipril stop can be carried by no variant; the new "
                                 "furosemide and spironolactone doses also appear in the ward notes (evidence "
                                 "spans). The summary should say that it covers only part of the document.")


# --- (d) 3 pages that fit whole: the control --------------------------------------------------

def neurology():
    head = ("SYNTHETIC TEST DOCUMENT - FAKE DATA ONLY\n"
            "Testville Neurology Associates (FAKE) - 40 Sample Avenue, Suite 210, Testville ON Z9Z 9Z4\n"
            "Tel 613-555-0160 · Fax 613-555-0161\n"
            "Re: FAKE-ARSENAULT, Chloe   DOB: 3 May 1991   Health card: 5678 901 234 (FAKE)   Page {n} of 3\n\n")
    pages = ["""4 November 2026

Dr. Lena FAKE-Novak
Maplewood Test Family Health Team (FAKE)

Dear Dr. FAKE-Novak,

Thank you for asking me to see Ms. Chloe FAKE-Arsenault, a 35-year-old graphic designer, about
headaches that have become more frequent over the last year. I saw her today with her partner.

History of the headaches: She has had headaches since her teens, usually on one side of the head,
throbbing, with nausea and a dislike of light and noise, lasting most of a day. There is no visual
aura, no weakness and no numbness with them. Until 2025 they came two or three times a month. Since
early 2026 she has a headache on about 18 days a month; on about 8 of those days the headache is
severe and makes her leave work or lie down in a dark room. The milder headaches are a dull pressure
across the forehead and the back of the neck.

Medicines for the headaches: she takes ibuprofen 400 to 600 mg on about 15 days a month, and
rizatriptan 10 mg on about 6 days a month, which works within an hour for the severe attacks. She
has tried acetaminophen, which does little. She has never taken a preventive medicine.

Triggers: poor sleep, skipped meals, the days before her period, and long days at the screen. She
drinks three to four coffees a day, more on deadline days. Alcohol rarely; red wine is a trigger.

Other history: anxiety, treated with counselling in 2022; no regular medicines apart from an oral
contraceptive (levonorgestrel-ethinyl estradiol), which she has taken for 10 years. No history of
high blood pressure, stroke or clots. No head injury. She does not smoke.

Family history: her mother and her maternal aunt have migraine. No family history of aneurysm.

Sleep and work: she sleeps about 6 hours on work nights and catches up at weekends; she works long
days at a screen and often skips lunch on deadline days. She has a sit-stand desk but rarely uses it.

Impact: she has missed 9 days of work in the last three months. Her MIDAS score today is 32
(severe disability). Sleep is broken on headache nights. Mood is "frustrated but not depressed";
PHQ-9 score 6.

Red flags reviewed: no sudden "worst ever" headache, no headache waking her from sleep that is new,
no fever, no weight loss, no change with coughing or straining, no new neurological symptoms, no
change in the character of the headaches apart from frequency.
""", """Examination: blood pressure 118/74, heart rate 68, body mass index 23. General examination
normal. Neurological examination: alert and fluent. Visual fields full to confrontation; fundi show
sharp optic discs on both sides with spontaneous venous pulsations. Pupils equal and reactive. Eye
movements full, no nystagmus. Face symmetrical, sensation normal. Hearing normal to finger rub. Tongue
and palate midline. Power 5/5 in all four limbs; tone normal; reflexes 2+ and symmetrical; plantar
responses flexor. Sensation to light touch, pinprick, vibration and position normal. Coordination
normal on finger-nose and heel-shin testing. Gait normal, including heel, toe and tandem walking.
Romberg negative. Neck: tender trapezius muscles on both sides; full range of movement.

Investigations: a CT scan of the head done in the emergency department in March 2025, during a
severe attack, was normal. Blood work from your office in September 2026: complete blood count,
ferritin, TSH, electrolytes and creatinine all normal. No further imaging is needed: the history is
typical and the examination is normal.

Headache diary: she brought a diary for October 2026: 19 headache days; 8 severe; ibuprofen on 15
days, rizatriptan on 6 days; painkillers of any kind on 17 days.

Discussion with the patient: I explained that her headaches are migraine, that they have become
chronic (15 or more headache days a month for more than 3 months, with migraine features on at least
8 days), and that using painkillers on many days a month can itself keep the headaches going
(medication-overuse headache). We discussed that cutting down the painkillers usually makes the
headaches less frequent after 2 to 8 weeks, although the first two weeks can be harder. We
discussed the options for prevention (amitriptyline, propranolol, topiramate, candesartan, and
injections such as onabotulinumtoxinA or CGRP antibodies if tablets fail). Propranolol was less
suitable because she runs and finds her energy low already; topiramate she would like to avoid
because of its effect on word-finding in her work. She chose amitriptyline, which may also help her
sleep and neck tension.

Oral contraceptive: she has migraine without aura, so the combined pill is not contraindicated on
that basis. She should tell you if she ever develops aura (visual or sensory symptoms before the
headache), as the combined pill would then need to be reconsidered.

Lifestyle: regular sleep and meals, gradual reduction of caffeine to two coffees a day, regular
exercise (she runs twice a week), screen breaks. A physiotherapy referral for the neck could help.
""", """Impression:
1. Chronic migraine without aura.
2. Medication-overuse headache (ibuprofen and rizatriptan on 17 days in October).
3. Neck muscle tension.

Plan, agreed with the patient:
1. Start amitriptyline 10 mg at bedtime. If tolerated, increase by 10 mg every 2 weeks up to 30 mg
   at bedtime. Common side effects explained: dry mouth, morning drowsiness, constipation. Take it 2
   to 3 hours before bed if mornings are groggy.
2. Limit painkillers: use ibuprofen or rizatriptan on no more than 2 days a week (no more than 10
   days a month in total). Rizatriptan stays for the severe attacks.
3. Keep a headache diary every day (the paper diary or a phone app) and bring it to the next visit.
4. Reduce coffee gradually to two cups a day over the next month.
5. Physiotherapy for the neck: referral sent to Testville Physiotherapy (FAKE).
6. No MRI or other scan is needed.
7. Follow-up in the neurology clinic in 3 months; our office will call her with the date. If the
   headaches are not better by then, we will discuss the next preventive step.

When to seek help urgently: go to the emergency department for a sudden, very severe headache
("worst ever", reaching full strength within a minute), a headache with weakness, numbness, trouble
speaking or confusion, a headache with fever and a stiff neck, or a headache after a head injury.

Information given to the patient: a migraine information sheet; a paper headache diary for three
months; the "painkiller days" counting card; links to the Migraine Society (FAKE) self-management
course. We discussed that amitriptyline is a preventive medicine: it is taken every night, not only
on headache days, and its benefit builds up over 4 to 8 weeks. She should not stop it suddenly
without talking to you or to us. It should not be combined with other medicines that affect
serotonin without checking with a pharmacist. If she plans a pregnancy, she should talk to you
first, as the preventive plan would change.

Please renew her rizatriptan prescription (10 mg, 6 tablets a month) and continue to follow her
blood pressure. I have given Ms. FAKE-Arsenault a copy of this letter.

Yours sincerely,

Dr. Riley FAKE-Mendes, MD, FRCPC (Neurology) (FAKE)

cc: Ms. Chloe FAKE-Arsenault
"""]
    pages = [head.format(n=i + 1) + text for i, text in enumerate(pages)]
    facts = [
        fact("chronic_migraine", "finding", "1. Chronic migraine without aura.",
             ["The headaches are chronic migraine without aura."], [["migraine"], ["chronic", "without aura"]],
             critical=True),
        fact("medication_overuse", "finding",
             "2. Medication-overuse headache (ibuprofen and rizatriptan on 17 days in October).",
             ["Taking painkillers on many days is also keeping the headaches going (medication-overuse headache)."],
             [["overuse", "painkiller", "ibuprofen"], ["overuse", "keep", "17 days", "too often"]], critical=True),
        fact("amitriptyline_start", "medication",
             "1. Start amitriptyline 10 mg at bedtime. If tolerated, increase by 10 mg every 2 weeks up to 30 mg\n   at bedtime.",
             ["Start amitriptyline 10 mg at bedtime and, if it is tolerated, increase by 10 mg every 2 weeks up to 30 mg."],
             [["amitriptyline"], ["10 mg", "start", "bedtime"]], critical=True),
        fact("limit_painkillers", "instruction",
             "2. Limit painkillers: use ibuprofen or rizatriptan on no more than 2 days a week (no more than 10\n   days a month in total).",
             ["Use ibuprofen or rizatriptan on no more than 2 days a week, no more than 10 days a month in total."],
             [["ibuprofen", "rizatriptan", "painkiller"], ["2 days a week", "10 days", "two days"]], critical=True),
        fact("headache_diary", "instruction",
             "3. Keep a headache diary every day (the paper diary or a phone app) and bring it to the next visit.",
             ["Keep a headache diary every day and bring it to the next visit."],
             [["diary"], ["every day", "daily", "bring"]], required=False),
        fact("no_scan", "negation", "6. No MRI or other scan is needed.",
             ["No MRI or other scan is needed."], [["mri", "scan"], ["no ", "not needed", "isn't needed"]]),
        fact("follow_up_3_months", "follow_up",
             "7. Follow-up in the neurology clinic in 3 months; our office will call her with the date.",
             ["Her follow-up in the neurology clinic is in 3 months; the office will call her with the date."],
             [["follow-up", "neurology clinic", "visit", "see"], ["3 months", "three months"]], critical=True),
        fact("urgent_signs", "conditional_instruction",
             "When to seek help urgently: go to the emergency department for a sudden, very severe headache",
             ["Go to the emergency department for a sudden, very severe headache, or a headache with weakness, numbness, trouble speaking, confusion, fever with a stiff neck, or after a head injury."],
             [["emergency"], ["sudden", "severe", "weakness", "numbness", "speaking", "stiff neck", "fever"]],
             critical=True),
    ]
    traps = [
        trap("saying a brain scan is planned or needed", r"^(?!.*\b(no|not|n't|without|unnecessary|2025)\b).*\b(mri|scan|imaging)\b",
             "She needs an MRI of the brain."),
        trap("adding a dangerous diagnosis", r"\b(tumou?r\w*|stroke|aneurysm\w*|bleed\w*|haemorrhag\w*|hemorrhag\w*)\b",
             "The headaches may be caused by a tumour."),
        trap("telling her to stop the contraceptive pill",
             r"\b(stop\w*|switch\w*|change)\b.*\b(pill|contracepti\w*)\b|\b(pill|contracepti\w*)\b.*\b(stop\w*)\b",
             "She should stop the contraceptive pill."),
        OTHER,
    ]
    return document("long04-neurology-consult-3p", "Multi-page: 3-page neurology consult that fits whole (control)",
                    "en", pages, facts, traps,
                    reading_note="All three pages fit in the summary's room: no reading strategy should change "
                                 "what is read.")


# --- (e) a lab series with the same header and footer on every page ------------------------------

def lab_series():
    head = ("SYNTHETIC TEST DOCUMENT - FAKE DATA ONLY\n"
            "Fictional Valley Laboratories (FAKE) - Cumulative report\n"
            "Patient: EXAMPLE, Robin   PHN: 9876 543 210 (FAKE)   DOB: 11-Feb-1968   Sex: M\n"
            "Ordering provider: Dr. Casey FAKE-Okoro, Maplewood Test Family Health Team (FAKE)\n"
            "Report printed: 2026-10-30 16:20\n\n")
    foot = ("\n\nQuestions about these results? Call the clinic at 613-555-0156 (Maplewood Test Family Health Team).\n"
            "Fictional Valley Laboratories (FAKE) - accredited - Page {n} of 6\n")
    dates = ["2025-11-04", "2026-02-10", "2026-06-02", "2026-10-27"]

    def section(title, rows, comment=""):
        return (title + "\n\n" + table(["Test"] + dates + ["Units", "Reference"], rows, [24, 11, 11, 11, 11, 12, 12])
                + ("\n\n" + comment if comment else ""))

    pages = [
        section("HAEMATOLOGY", [
            ["Haemoglobin", "148", "146", "147", "145", "g/L", "135-175"],
            ["Red cells", "4.92", "4.88", "4.90", "4.85", "x10^12/L", "4.50-6.00"],
            ["Haematocrit", "0.44", "0.44", "0.44", "0.43", "L/L", "0.40-0.52"],
            ["MCV", "89", "90", "90", "89", "fL", "80-100"],
            ["MCH", "30.1", "29.9", "30.0", "29.9", "pg", "27.0-33.0"],
            ["RDW", "13.1", "13.0", "13.2", "13.1", "%", "11.5-14.5"],
            ["White cells", "6.8", "7.2", "6.5", "7.0", "x10^9/L", "4.0-11.0"],
            ["Neutrophils", "4.1", "4.4", "3.9", "4.2", "x10^9/L", "2.0-7.5"],
            ["Lymphocytes", "2.0", "2.1", "1.9", "2.1", "x10^9/L", "1.0-4.0"],
            ["Monocytes", "0.5", "0.5", "0.5", "0.5", "x10^9/L", "0.2-0.8"],
            ["Eosinophils", "0.2", "0.2", "0.2", "0.2", "x10^9/L", "0.0-0.5"],
            ["Basophils", "0.0", "0.0", "0.0", "0.0", "x10^9/L", "0.0-0.1"],
            ["Platelets", "232", "241", "228", "236", "x10^9/L", "150-400"]],
            "Iron studies (2026-10-27): ferritin 142 ug/L (30-400); iron 18 umol/L (10-30); transferrin "
            "saturation 0.29 (0.20-0.50).\nBlood film (2026-10-27): not required; indices normal.\n"
            "Comment: blood counts stable over four collections. No action needed from these results."),
        section("CHEMISTRY - KIDNEYS AND ELECTROLYTES", [
            ["Sodium", "140", "139", "141", "140", "mmol/L", "135-145"],
            ["Potassium", "4.4", "4.5", "4.6", "4.8", "mmol/L", "3.5-5.0"],
            ["Chloride", "103", "102", "104", "103", "mmol/L", "98-107"],
            ["Bicarbonate", "26", "25", "25", "24", "mmol/L", "22-29"],
            ["Urea", "6.1", "6.4", "6.9", "7.4", "mmol/L", "2.5-8.0"],
            ["Creatinine", "102", "108", "114", "121", "umol/L", "60-110"],
            ["eGFR (CKD-EPI 2021)", "73", "68", "64", "58", "mL/min/1.73m2", ">60"],
            ["Calcium", "2.36", "2.38", "2.35", "2.37", "mmol/L", "2.15-2.55"],
            ["Phosphate", "1.05", "1.08", "1.10", "1.12", "mmol/L", "0.80-1.50"],
            ["Uric acid", "388", "402", "396", "410", "umol/L", "200-430"],
            ["Magnesium", "0.84", "0.82", "0.85", "0.83", "mmol/L", "0.70-1.00"],
            ["Osmolality, calculated", "287", "286", "290", "290", "mmol/kg", "275-295"],
            ["Anion gap", "11", "12", "12", "13", "mmol/L", "8-16"],
            ["Total protein", "72", "71", "73", "72", "g/L", "60-80"],
            ["CK", "142", "-", "156", "-", "U/L", "<200"]],
            "Comment: creatinine above the reference range on 2026-10-27; eGFR 58 is lower than in "
            "November 2025 (73). Interpret with the urine albumin result (page 5) and the clinical picture.\n"
            "Specimens: serum, fasting; no haemolysis on any collection."),
        section("CHEMISTRY - LIVER AND LIPIDS", [
            ["ALT", "28", "31", "34", "29", "U/L", "<50"],
            ["AST", "24", "26", "27", "25", "U/L", "<40"],
            ["Alkaline phosphatase", "74", "78", "76", "79", "U/L", "40-129"],
            ["GGT", "32", "35", "38", "34", "U/L", "<60"],
            ["Bilirubin, total", "11", "9", "12", "10", "umol/L", "<21"],
            ["Albumin", "42", "43", "42", "41", "g/L", "35-50"],
            ["Cholesterol, total", "5.6", "-", "5.2", "4.9", "mmol/L", "<5.2"],
            ["Triglycerides", "2.1", "-", "1.9", "1.8", "mmol/L", "<1.7"],
            ["HDL cholesterol", "1.05", "-", "1.08", "1.10", "mmol/L", ">1.00"],
            ["LDL cholesterol (calc.)", "3.6", "-", "3.3", "3.0", "mmol/L", "<3.5"],
            ["Non-HDL cholesterol", "4.6", "-", "4.1", "3.8", "mmol/L", "<4.2"],
            ["Apolipoprotein B", "1.12", "-", "1.04", "0.96", "g/L", "<1.05"],
            ["Lipoprotein(a)", "-", "-", "38", "-", "nmol/L", "<75"],
            ["LDH", "182", "-", "176", "-", "U/L", "<250"],
            ["Lipase", "-", "34", "-", "-", "U/L", "<60"]],
            "Comment: lipid values fasting. LDL cholesterol has fallen from 3.6 to 3.0 mmol/L since "
            "November 2025. Targets depend on the patient's overall cardiovascular risk; see the clinic "
            "comments on page 6."),
        section("CHEMISTRY - GLUCOSE, THYROID AND VITAMINS", [
            ["Glucose, fasting", "5.9", "6.2", "6.4", "6.9", "mmol/L", "3.6-6.0"],
            ["Haemoglobin A1c", "5.9", "6.1", "6.3", "6.6", "%", "<6.0"],
            ["TSH", "1.8", "-", "2.1", "-", "mU/L", "0.32-4.00"],
            ["Vitamin B12", "-", "-", "-", "312", "pmol/L", ">220"],
            ["25-hydroxy vitamin D", "-", "58", "-", "64", "nmol/L", "75-250"],
            ["Ferritin", "-", "-", "-", "142", "ug/L", "30-400"],
            ["Free T4", "-", "-", "14.2", "-", "pmol/L", "9.0-19.0"],
            ["Folate, serum", "-", "-", "-", "24", "nmol/L", ">10"],
            ["PSA, total", "1.1", "-", "-", "1.3", "ug/L", "<4.5"],
            ["Glucose, random (capillary)", "-", "7.4", "-", "-", "mmol/L", "-"]],
            "Comment: HbA1c 6.6% and fasting glucose 6.9 mmol/L (2026-10-27) are at or above the "
            "diagnostic thresholds for diabetes (HbA1c 6.5% or more; fasting glucose 7.0 mmol/L or more). "
            "In a person without symptoms, a second abnormal result on another day is needed to confirm "
            "the diagnosis.\nVitamin D below the optimal range; the clinic will advise.\n"
            "Glucose tolerance test: not performed.\n"
            "Method notes: HbA1c by HPLC, IFCC-traceable (6.6% = 49 mmol/mol); haemoglobin variants not "
            "detected. PSA: immunoassay; results from different assays are not interchangeable."),
        section("URINE", [
            ["Albumin:creatinine ratio", "1.4", "-", "2.8", "4.6", "mg/mmol", "<2.0"],
            ["Urine creatinine", "11.2", "-", "9.8", "10.4", "mmol/L", "-"],
            ["Urine albumin", "16", "-", "27", "48", "mg/L", "-"]],
            "URINALYSIS (dipstick)\n\n"
            + table(["Test"] + dates, [["Colour", "yellow", "yellow", "yellow", "yellow"],
                                       ["Clarity", "clear", "clear", "clear", "clear"],
                                       ["Specific gravity", "1.020", "-", "1.016", "1.018"],
                                       ["pH", "6.0", "-", "5.5", "6.0"],
                                       ["Protein", "negative", "-", "trace", "trace"],
                                       ["Glucose", "negative", "-", "negative", "negative"],
                                       ["Ketones", "negative", "-", "negative", "negative"],
                                       ["Blood", "negative", "-", "negative", "negative"],
                                       ["Leukocytes", "negative", "-", "negative", "negative"],
                                       ["Nitrite", "negative", "-", "negative", "negative"]],
                    [18, 11, 11, 11, 11]) + "\n"
            "Microscopy: not indicated.\n\n"
            "Comment: the albumin:creatinine ratio is raised (4.6 mg/mmol) and has risen over the last "
            "year. A raised ratio should be confirmed on two of three samples over 3 to 6 months.\n"
            "Urine culture: not requested."),
        """CLINIC COMMENTS FOR THE PATIENT - Dr. Casey FAKE-Okoro, 30 October 2026

Dear Robin,

I have looked at your blood and urine tests from 27 October 2026. Here is what they mean and what we
will do next.

1. Blood sugar: your HbA1c is 6.6% and your fasting blood sugar is 6.9 mmol/L. This is the first time
   your HbA1c has been in the diabetes range (6.5% or more). One result is not enough to say that you
   have diabetes. We will repeat the HbA1c and the fasting blood sugar in 3 months, in late January
   2027. In the meantime, the changes we talked about in June (walking 30 minutes most days, fewer
   sweet drinks, smaller portions of bread, rice and pasta) are the best thing you can do.

2. Kidneys: your kidney filtration (eGFR) is 58, lower than last year (73), and there is a small
   amount of protein (albumin) in your urine. This needs a closer look. Please book a visit with me
   within 4 weeks so that we can check your blood pressure, review your medicines and talk about the
   next steps. Please avoid anti-inflammatory painkillers such as ibuprofen or naproxen until then.

3. Cholesterol: your LDL cholesterol is 3.0 mmol/L, lower than last year. We will talk about it at
   the same visit.

   Blood pressure: please bring your home blood pressure readings to the visit (two readings in the
   morning and two in the evening for 7 days before the visit), and your medicine bottles.

4. Vitamin D is a little low (64). You can take vitamin D 1,000 units a day, which you can buy
   without a prescription.

5. Everything else (blood counts, liver tests, thyroid, iron, vitamin B12) is within the normal
   range.

Please call the clinic to book the visit. A requisition for the January tests (HbA1c, fasting
glucose, creatinine, urine albumin) will be ready at the front desk.

Dr. Casey FAKE-Okoro (FAKE)
""",
    ]
    pages = [head + text + foot.format(n=i + 1) for i, text in enumerate(pages)]
    facts = [
        fact("hba1c_diabetes_range", "result",
             "your HbA1c is 6.6% and your fasting blood sugar is 6.9 mmol/L. This is the first time\n   your HbA1c has been in the diabetes range (6.5% or more).",
             ["His HbA1c is 6.6%, in the diabetes range for the first time, but one result is not enough to say he has diabetes."],
             [["hba1c", "a1c", "blood sugar"], ["6.6", "diabetes range", "first time"]], critical=True,
             evidence_spans=["Haemoglobin A1c", "One result is not enough to say that you\n   have diabetes."]),
        fact("repeat_in_3_months", "follow_up",
             "We will repeat the HbA1c and the fasting blood sugar in 3 months, in late January\n   2027.",
             ["The HbA1c and fasting blood sugar will be repeated in 3 months, in late January 2027."],
             [["repeat", "again", "recheck"], ["3 months", "three months", "january"]], critical=True),
        fact("kidney_egfr_lower", "result",
             "your kidney filtration (eGFR) is 58, lower than last year (73), and there is a small\n   amount of protein (albumin) in your urine.",
             ["His kidney filtration (eGFR) is 58, lower than last year's 73, and there is a little protein in the urine."],
             [["egfr", "kidney"], ["58", "lower", "down", "protein", "albumin"]], critical=True),
        fact("book_within_4_weeks", "instruction",
             "Please book a visit with me\n   within 4 weeks so that we can check your blood pressure, review your medicines and talk about the\n   next steps.",
             ["Book a visit with Dr. FAKE-Okoro within 4 weeks to check the blood pressure, review medicines and plan next steps."],
             [["book", "visit", "appointment"], ["4 weeks", "four weeks"]], critical=True),
        fact("avoid_nsaids", "instruction",
             "Please avoid anti-inflammatory painkillers such as ibuprofen or naproxen until then.",
             ["Avoid anti-inflammatory painkillers such as ibuprofen or naproxen until that visit."],
             [["ibuprofen", "naproxen", "anti-inflammator"], ["avoid", "do not", "don't"]], critical=True),
        fact("ldl_lower", "result", "your LDL cholesterol is 3.0 mmol/L, lower than last year.",
             ["His LDL cholesterol is 3.0 mmol/L, lower than last year."], [["ldl", "cholesterol"], ["3.0", "lower"]],
             required=False),
        fact("vitamin_d", "instruction",
             "You can take vitamin D 1,000 units a day, which you can buy\n   without a prescription.",
             ["He can take vitamin D 1,000 units a day, which is sold without a prescription."],
             [["vitamin d"], ["1,000", "1000"]], required=False),
        fact("call_the_clinic", "instruction",
             "Questions about these results? Call the clinic at 613-555-0156 (Maplewood Test Family Health Team).",
             ["For questions about the results, call the clinic at 613-555-0156."],
             [["call", "phone"], ["clinic", "613-555-0156"]], required=False),
    ]
    traps = [
        trap("saying he has diabetes for certain",
             r"^(?!.*\b(range|confirm\w*|repeat\w*|second|again|not enough|may|might|possibl\w*|if|whether|first time)\b).*\b(has|have|diagnosed with)\b.*\bdiabet\w*\b",
             "Robin has diabetes."),
        trap("calling it kidney failure", r"\b(kidney|renal) failure\b|\bdialysis\b", "His kidneys are failing; kidney failure."),
        trap("repeating the PHN", r"9876\W*543\W*210", "His PHN is 9876 543 210."),
        trap("calling the kidney or sugar results normal",
             r"(?=.*\b(egfr|kidney\w*|a1c|hba1c|sugar|glucose)\b)(?=.*\b(normal|fine|ok|okay|healthy)\b)(?!.*\b(everything else|other|lower|range|not)\b)",
             "His kidney results are normal."),
        OTHER,
    ]
    return document("long05-lab-series-6p",
                    "Multi-page: 6-page cumulative lab series, the same header (with a PHN) and footer on every page",
                    "en", pages, facts, traps, ["613-555-0156"],
                    reading_note="Every page repeats the header (name, PHN, provider) and the footer, which tells "
                                 "the patient to call the clinic. The clinic's comments for the patient are on page 6.")


# --- (f) a two-page French letter -----------------------------------------------------------------

def lettre():
    head = ("DOCUMENT D'ESSAI SYNTHÉTIQUE - DONNÉES FICTIVES SEULEMENT\n"
            "Clinique de cardiologie de Fictiveville (FICTIVE)\n"
            "3100, boulevard de l'Exemple, bureau 400, Fictiveville (Québec) Z9Z 9Z3\n"
            "Tél. : 514 555-0170 · Téléc. : 514 555-0171\n"
            "Page {n} de 2\n\n")
    pages = ["""Le 5 novembre 2026

Docteure Sophie FAKE-Bélanger (FICTIVE)
Groupe de médecine de famille du Quartier (FICTIF)

Objet : M. Antoine FAKE-Gauthier (FICTIF) · Date de naissance : 19 août 1957
RAMQ : FAKE 5708 1990 · Dossier no : 0102233

Chère collègue,

Merci de m'avoir adressé M. FAKE-Gauthier, 69 ans, que j'ai vu aujourd'hui pour des palpitations.

Histoire : depuis l'été 2026, il ressent des épisodes de battements cardiaques rapides et
irréguliers, environ deux fois par mois, qui durent de quelques minutes à six heures. Pendant les
épisodes, il se sent essoufflé à l'effort et un peu étourdi, sans perte de connaissance ni douleur
thoracique. Les épisodes cessent d'eux-mêmes. Il n'a pas remarqué de déclencheur précis, sauf peut-
être les soirées où il boit plus de deux verres de vin. Il ne fume pas.

Antécédents : hypertension artérielle depuis 2015 ; dyslipidémie ; apnée du sommeil diagnostiquée en
2024, traitée par CPAP qu'il utilise environ cinq nuits sur sept ; pas de diabète ; pas d'accident
vasculaire cérébral ni d'ischémie transitoire ; pas de saignement important.

Médicaments : amlodipine 10 mg une fois par jour ; rosuvastatine 10 mg une fois par jour ; il prend
parfois de l'ibuprofène pour des douleurs au genou.
Allergies : aucune connue.

Examen : tension artérielle 148/86, pouls 74 régulier au moment de l'examen, saturation 97 %. Poids
94 kg, taille 178 cm. Auscultation cardiaque : bruits réguliers, pas de souffle. Poumons libres.
Pas d'œdème des membres inférieurs. Pas de signe d'insuffisance cardiaque.

Examens :
- ECG de repos aujourd'hui : rythme sinusal à 72 battements par minute, PR 186 ms, QRS 92 ms, pas
  d'onde Q, pas d'anomalie de la repolarisation.
- Holter de 14 jours (du 6 au 20 octobre 2026) : fibrillation auriculaire paroxystique, 3 épisodes,
  le plus long de 5 h 40, fréquence moyenne pendant les épisodes 128 par minute ; pas de pause de plus
  de 2,5 secondes ; pas de tachycardie ventriculaire.
- Échocardiographie du 22 octobre 2026 : ventricule gauche de taille normale, fraction d'éjection
  60 %, légère hypertrophie concentrique, oreillette gauche légèrement dilatée (volume 38 mL/m²),
  valves normales.
- Bilan sanguin du 15 octobre 2026 : TSH 1,9 mUI/L, créatinine 88 µmol/L (DFGe 79), hémoglobine
  146 g/L, potassium 4,3 mmol/L.
""", """Conclusion :
1. Fibrillation auriculaire paroxystique, symptomatique.
2. Risque d'accident vasculaire cérébral : score CHA₂DS₂-VASc de 2 (âge de 65 à 74 ans,
   hypertension). Risque de saignement faible (HAS-BLED 1).
3. Hypertension mal contrôlée aujourd'hui (148/86) ; apnée du sommeil traitée partiellement.

Plan, discuté avec le patient :
1. Commencer l'apixaban 5 mg deux fois par jour, pour réduire le risque d'accident vasculaire
   cérébral. Il ne doit plus prendre d'ibuprofène ni d'autres anti-inflammatoires ; l'acétaminophène
   est permis pour les douleurs au genou.
2. Commencer le métoprolol 25 mg deux fois par jour pour ralentir le cœur pendant les épisodes.
3. Continuer l'amlodipine et la rosuvastatine sans changement.
4. Utiliser la CPAP toutes les nuits ; limiter l'alcool à un verre par jour au plus.
5. Holter de 14 jours à refaire dans 3 mois, vers le début de février 2027, pour voir si les
   épisodes sont moins fréquents.
6. Rendez-vous de suivi en clinique de cardiologie dans 6 mois ; notre secrétariat l'appellera pour
   la date. Si les épisodes restent fréquents malgré le traitement, nous discuterons d'une ablation.

Quand consulter d'urgence : aller à l'urgence ou appeler le 911 en cas de douleur thoracique, de
perte de connaissance, d'essoufflement important, ou de signes d'accident vasculaire cérébral
(visage qui s'affaisse, faiblesse d'un bras, trouble de la parole). Signaler rapidement tout
saignement inhabituel (selles noires, sang dans les urines, saignement de nez qui ne s'arrête pas).

Renseignements remis au patient : une carte d'anticoagulation à garder dans son portefeuille ; un
feuillet sur la fibrillation auriculaire ; la liste des médicaments en vente libre à éviter avec
l'apixaban (ibuprofène, naproxène, acide acétylsalicylique à forte dose, certains produits naturels
comme le ginkgo). Il doit aviser tout dentiste ou chirurgien qu'il prend un anticoagulant avant une
intervention. Il ne doit pas cesser l'apixaban de lui-même ; s'il oublie une dose, il la prend dès
qu'il s'en rend compte le même jour, sans doubler la dose suivante.

Je vous saurais gré de suivre sa tension artérielle dans un mois et d'ajuster l'amlodipine au besoin.
J'ai remis une copie de cette lettre au patient.

Veuillez agréer, chère collègue, mes salutations distinguées.

Dr Mathieu FAKE-Lefebvre (FICTIF), cardiologue

c. c. M. Antoine FAKE-Gauthier
"""]
    pages = [head.format(n=i + 1) + text for i, text in enumerate(pages)]
    facts = [
        fact("fa_paroxystique", "finding", "1. Fibrillation auriculaire paroxystique, symptomatique.",
             ["Il a une fibrillation auriculaire paroxystique : des épisodes de battements irréguliers qui vont et viennent.",
              "He has paroxysmal atrial fibrillation: episodes of irregular heartbeat that come and go."],
             [["fibrillation"], ["paroxysti", "episod", "come and go", "vont et viennent"]], critical=True),
        fact("apixaban_start", "medication",
             "1. Commencer l'apixaban 5 mg deux fois par jour, pour réduire le risque d'accident vasculaire\n   cérébral.",
             ["Il commence l'apixaban 5 mg deux fois par jour pour réduire le risque d'accident vasculaire cérébral.",
              "He starts apixaban 5 mg twice a day to lower the risk of a stroke."],
             [["apixaban"], ["5 mg", "deux fois", "twice"]], critical=True),
        fact("no_ibuprofen", "instruction",
             "Il ne doit plus prendre d'ibuprofène ni d'autres anti-inflammatoires ;",
             ["Il ne doit plus prendre d'ibuprofène ni d'autres anti-inflammatoires.",
              "He must not take ibuprofen or other anti-inflammatory medicines any more."],
             [["ibuprof", "anti-inflammatoire", "anti-inflammatory"], ["ne doit plus", "not", "no longer", "plus"]],
             critical=True),
        fact("metoprolol_start", "medication", "2. Commencer le métoprolol 25 mg deux fois par jour",
             ["Il commence le métoprolol 25 mg deux fois par jour.", "He starts metoprolol 25 mg twice a day."],
             [["metoprolol"], ["25 mg", "deux fois", "twice"]], critical=True),
        fact("holter_3_mois", "follow_up",
             "5. Holter de 14 jours à refaire dans 3 mois, vers le début de février 2027,",
             ["Un Holter de 14 jours sera refait dans 3 mois, vers le début de février 2027.",
              "A 14-day Holter will be repeated in 3 months, around early February 2027."],
             [["holter"], ["3 mois", "trois mois", "3 months", "three months", "fevrier", "february"]]),
        fact("suivi_6_mois", "follow_up",
             "6. Rendez-vous de suivi en clinique de cardiologie dans 6 mois ;",
             ["Il aura un rendez-vous de suivi en cardiologie dans 6 mois.",
              "He will have a follow-up visit at the cardiology clinic in 6 months."],
             [["suivi", "follow-up", "rendez-vous", "cardiolog"], ["6 mois", "six mois", "6 months", "six months"]],
             critical=True),
        fact("urgence", "conditional_instruction",
             "Quand consulter d'urgence : aller à l'urgence ou appeler le 911 en cas de douleur thoracique,",
             ["Aller à l'urgence ou appeler le 911 en cas de douleur à la poitrine, de perte de connaissance, d'essoufflement important ou de signes d'AVC.",
              "Go to the emergency department or call 911 for chest pain, fainting, severe shortness of breath or signs of a stroke."],
             [["urgence", "emergency", "911"], ["thoraci", "poitrine", "chest", "connaissance", "faint", "essouffl", "breath", "avc", "stroke"]],
             critical=True),
    ]
    traps = [
        trap("dire que le cœur est normal ou guéri / saying the heart is normal or cured",
             r"(?=.*\b(coeur|cœur|heart)\b)(?=.*\b(normal\w*|gueri\w*|cured|fine|healthy|en bonne sante)\b)(?!.*\b(taille normale|normal size|fraction)\b)",
             "Son cœur est normal."),
        trap("parler d'un AVC qui a eu lieu / saying he had a stroke",
             r"^(?!.*\b(risque|risk|signes?|signs?|pas|no|not|n'|prevent\w*|reduire|lower|reduce)\b).*\b(avc|accident vasculaire|stroke)\b",
             "Il a fait un AVC."),
        trap("repeating the RAMQ or file number", r"5708\W*1990|0102233", "Son numéro RAMQ est FAKE 5708 1990."),
        OTHER,
    ]
    return document("long06-lettre-cardio-2p-fr", "Multi-page: two-page French cardiology letter", "fr", pages,
                    facts, traps,
                    reading_note="Two pages that fit whole; the conclusion and the plan are on page 2. For the "
                                 "language variants: a French document summarized in another language.")


def write_all(out):
    out = Path(out)
    built = [pneumonia()]
    for module_builder in BUILDERS:
        built.append(module_builder())
    for doc in built:
        (out / f"{doc['id']}.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print("wrote", doc["id"], len(doc["pages"]), "pages")


BUILDERS = [surgery, heart_failure, neurology, lab_series, lettre]

if __name__ == "__main__":
    write_all(sys.argv[1])

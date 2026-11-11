"""Score real-model AI summary runs and compare variants. Offline, stdlib only.

A run is the JSON lines file written by the ignored test `a_real_model_evaluation_run`
(src-tauri/tests/model_engine.rs): a first line naming the build and model, then one line per
document. This tool never runs a model.

A fact counts as found when a sentence matches one of its approved statements, or names it (every
one of its `match` groups, each option matched at a word start) with a quote that lies on one of
its evidence spans in the document. A fact found only by a sentence that a screen flagged is held
until a reviewer marks that sentence correct; one marked wrong, unsupported or vague does not
count. Anything else is left to the hand review sheet. See HARNESS.md for every rule.

  compare.py check                         validate the document set (and its freeze)
  compare.py prepare --out DIR             write the run's input documents (<id>.json)
  compare.py score --run A.jsonl [--run B.jsonl ...] --out DIR [--review FILLED.csv [--review-key KEY.csv]]
                   [--noise A.jsonl --noise A2.jsonl] [--require-gain-for LABEL ...]
  compare.py repeat --run A.jsonl --run B.jsonl   same build, same answers token for token?
  compare.py noise --run A.jsonl --run A2.jsonl   how many facts flip between an A/A pair
  compare.py prefill --sheet review/review.csv --from FILLED.csv [--key KEY.csv] --run A.jsonl ... --out OUT.csv

The first run given to `score` is the baseline the others are compared with.
"""
from __future__ import annotations

import argparse
import csv
import difflib
import functools
import hashlib
import json
import re
import statistics
import struct
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOCUMENTS = HERE / "documents"
FIXTURES = HERE.parent / "fixtures.json"
FREEZE = HERE / "HARNESS-FREEZE.json"
CATEGORIES = {
    "finding", "history", "medication", "result", "question", "instruction", "timing", "follow_up",
    # PR 295's fixture categories
    "allergy", "conditional_instruction", "date_instruction", "experiencer", "measurement_location",
    "measurement_unit", "medication_status", "negation", "qualified_negation", "temporality",
    "treatment_status", "uncertainty",
}
# Facts that tell the patient what to do or when: reported on their own line.
ACTION_CATEGORIES = {"instruction", "timing", "follow_up", "conditional_instruction", "date_instruction"}
WRONG_VERDICTS = {"wrong", "unsupported"}
# A sentence a reviewer did not accept as carrying its fact.
NOT_CREDITED_VERDICTS = WRONG_VERDICTS | {"vague"}
VERDICTS = {"", "correct", "wrong", "unsupported", "vague"}
REVIEW_SAMPLE = 1.0
# The app reads the text of at most this many pages (src-tauri/src/lib.rs MAX_TEXT_PAGES), and the
# helper refuses a request with more (model_runtime.rs MAX_PAGES): `prepare` sends no more either.
TEXT_READ_PAGES = 50
MIN_OVERLAP = 20
# Options of this many characters or fewer, and options with a digit, must be whole words.
SHORT_OPTION = 3
# The decision rule (HARNESS.md): its version and its fixed numbers.
RULE_VERSION = 7
LOCATED_POINTS = 2
# Rule 6 (Ben, 11 Nov): a summary may take up to about 3 minutes: the median per document.
TIME_LIMIT_MS = 180_000
SCREENS = {"SOURCE_NOT_FOUND", "NUMBER_NOT_IN_QUOTE", "NEGATION_MISMATCH", "HEDGE_DROPPED",
           "CERTAINTY_ADDED", "EXPERIENCER", "ACTOR_SHIFT", "ADVICE_OR_JUDGEMENT", "LANGUAGE",
           "QUANTITY_MISMATCH", "TRAP", "CONTACT_DETAILS", "GENERALIZED_SUBJECT", "INSTRUCTION_ADDED",
           "ALTERNATIVE_DROPPED", "COUNT_DROPPED", "ACTION_FROM_HEADER", "HOLD_DROPPED", "FREQUENCY_DROPPED_MARK",
           "ACTION_NOT_IN_QUOTE_MARK"}

# Screens run on folded text (case, accents and spacing folded), so the words below have no accents.
NEGATION = re.compile(
    r"\b(no|not|never|none|without|denies|denied|negative|absent|nie|bez|brak|"
    r"ne|pas|sans|aucun|aucune|jamais|nao|sem|nunca|nenhum|nenhuma|sin|ningun|ninguna|"
    r"ruled out|rules out|rule out|excluded|unremarkable|free of|"
    r"exclu|exclue|ecarte|ecartee|wykluczon\w*|descartad\w*|afastad\w*|failed|fails|unsuccessful)\b|n't")
# A reported question ("the doctor asks if they should…") repeats the document's question, not advice.
REPORTED_QUESTION = re.compile(r"\b(asks?|asked|asking|wonders?|wants to know)\b (if|whether)\b[^.?!]*")
# Words that hedge a statement: dropping them overstates the document (certainty inflation).
HEDGE = re.compile(
    r"\b(suggest\w*(?!\s+(a\s+)?(repeat\w*|recheck\w*|review\w*|follow\w*|you\b|that you))|"
    r"possibl\w*|probabl\w*|likely|unlikely|suspect\w*|consistent with|in keeping with|"
    r"compatible|cannot (be )?(excluded|ruled out|exclude|rule out)|"
    r"(may|could) (indicate|suggest|reflect|represent|mean)|may (have|need|require)|"
    r"(may|could) be (due|caused|a sign|related|from|the cause|consistent|in keeping|linked)|"
    r"might|query|uncertain|questionable|equivocal|"
    r"borderline|presum\w*|evoqu\w*|sugger\w*|peut-etre|prawdopodob\w*|mozliw\w*|"
    r"podejrzen\w*|sugeruj\w*|sugere\w*|sugestiv\w*|provavel\w*|possivel\w*|"
    r"suspeit\w*|compativel|sospech\w*|posible\w*)\b")
# Words that make a statement certain: added to a quote that lacks them, they overstate it.
CERTAINTY = re.compile(
    r"\b(confirmed|confirms|definite|definitely|certainly|proven|proves|definitively|confirme|"
    r"confirmee|confirmad\w*|confirmou|potwierdz\w*)\b")
# Neutral clinical wording that overstates only a quote that hedges ("diagnosed with" for "suggests").
CERTAINTY_IF_HEDGED = re.compile(r"\b(diagnosed with|diagnosis of|established)\b")
# Who a statement is about: a family member on one side only is a different experiencer.
FAMILY = re.compile(
    r"\b(mother|father|mom|dad|sister|brother|siblings?|sons?|daughters?|parents?|aunt|uncle|"
    r"grand(mother|father|parent|son|daughter|child)\w*|cousins?|family history|family member\w*|"
    r"relatives?|mere|pere|soeur|frere|famille|familial\w*|fille|fils|matk\w*|ojc\w*|ojciec|"
    r"siostr\w*|brat|brata|bratu|rodzin\w*|corka|corki|syn|syna|mae|pai|irma|irmao|familia|"
    r"familiar\w*|filh\w*|madre|padre|hermano|hermana|hijo|hija)\b")
# Phrases that name a family-type doctor, not a relative: removed before FAMILY is looked for.
FAMILY_DOCTOR = re.compile(
    r"\bfamily (physician|doctor|practice|practitioner|medicine|gp|health team)\b|"
    r"\bmedecin de famille\b|\blekarz\w* rodzinn\w*\b|\bmedic[oa] de famil\w*\b")
SECOND_PERSON = re.compile(r"\b(you|your|yours|vous|votre|vos|ty|twoj|twoja|pan|pani|voce|seu|sua|usted|su)\b")
ACTORS = re.compile(
    r"\b(dr|doctor|doctors|physician|specialist|cardiolog\w*|clinic|hospital|nurse|radiolog\w*|"
    r"lab|laboratory|medecin|specialiste|clinique|lekarz\w*|specjalist\w*|klinik\w*|medico|"
    r"medica|clinica|endocrinolog\w*)\b")
ADVICE = re.compile(
    r"\b(should|must|recommend\w*|consider\w*|advis\w*|normal|abnormal|good|bad|healthy|worry\w*|"
    r"concern\w*|serious|dangerous|fine|ok|okay|reassur\w*|harmless|benign|nothing to worry|"
    r"devr\w*|devez|recommand\w*|anormal\w*|grave|powinien\w*|"
    r"nalezy|zaleca\w*|normaln\w*|deve|recomend\w*|preocup\w*)\b")
STOPWORDS = {
    "en": {"the", "and", "of", "to", "is", "was", "in", "for", "with", "your", "you", "on", "a"},
    "fr": {"le", "la", "les", "et", "de", "des", "du", "est", "un", "une", "pour", "vous", "avec", "en", "au", "aux",
           "dans", "pas", "ne", "l", "d"},
    "pl": {"i", "w", "na", "z", "jest", "nie", "do", "sie", "oraz", "po", "przez", "pan", "pani"},
    "pt-BR": {"o", "a", "os", "as", "e", "de", "do", "da", "em", "com", "para", "que", "voce"},
    "es": {"el", "la", "los", "las", "y", "de", "del", "en", "con", "para", "que", "usted", "es"},
}
NUMBER = re.compile(r"\d+(?:[.,]\d+)*")
# Contact details a summary sentence should not repeat (rule v7, DRAFT): a phone number, an e-mail address, a
# street address or an identity number (health card, record, visit or requisition number), unless the
# document gives it to the patient to use (the document's `patient_contacts`). Matched with accents
# dropped and case kept: the street patterns need capitals ("2 mm ST depression" is no street).
# Words that name an identity number on their own, and words that do only with a number marker after
# them ("dossier no", "chart #", "accession:"), since "dossier" or "file" alone are everyday words.
ID_WORDS = (r"health ?card(?: number| no\.?)?|health (?:insurance )?number|ohip|ramq|msp|phn|mrn|pesel|cpf|"
            r"carte d'assurance maladie|numero d'assurance maladie|cartao (?:sus|nacional de saude)|"
            r"(?:numero|no|n\u00b0) de dossier|"
            r"(?:medical record|record|chart|requisition|accession|dossier|prontuario|"
            r"numer (?:karty|ubezpieczenia|dokumentacji|pacjenta)) ?(?:number|numero|no\.?|n[o\u00b0]|#|id|:)|"
            r"(?:file|visit|card|hospital|patient|referral) ?(?:number|numero|no\.?|n[o\u00b0]|#|id)")
CONTACT_IDENTITY = re.compile(r"\b(?:" + ID_WORDS + r")(?![\w])[^.;\n\d]{0,25}?"
                              r"(?<![\w-])((?:[a-z]+-?)*[ -]?\d[\d -]{2,}\d)", re.IGNORECASE)
PHONE_WORDS = (r"tel|telec|phone|telephone|call|fax|telefon\w*|joignable|reached|ligue|ligar|llam\w*|"
               r"appel\w*|zadzwon\w*|kontakt\w*|contact\w*")
CONTACT_PHONE = re.compile(
    r"(?<![\w.,/+-])(?:\+?1[ .-]?)?(?:\(\d{3}\) ?|\d{3}[ .-]?)\d{3}[ .-]?\d{4}(?![\w/]|[.,-]\d| ?\d)"
    r"|(?<![\w+])\+\d{1,3}(?:[ .-]?\d{1,4}){3,5}(?![\w]|[.,-]\d)"
    r"|\(\d{2}\) ?\d{4,5}-\d{4}\b"
    r"|\b(?:" + PHONE_WORDS + r")\b[^\d\n]{0,25}?(?<![\d.,/-])\d{3}[ .-]\d{4}(?![\w/]|[.,-]\d| ?\d)",
    re.IGNORECASE)
CONTACT_PHONE_WORD = re.compile(r"\b(?:" + PHONE_WORDS + r")\b", re.IGNORECASE)
CONTACT_PHONE7 = re.compile(r"(?<![\d.,/-])\d{3}[ .-]\d{4}(?![\w/]|[.,-]\d| ?\d)")
CONTACT_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
CONTACT_ADDRESS = re.compile(
    r"(?<![\w.,])\d{1,5}[A-Za-z]?,? (?:[A-Z][\w'.-]* ){0,3}"
    r"(?:(?i:street|avenue|road|boulevard|lane|crescent|highway)\b|St\b(?!\.? John)|(?:Ave|Rd|Blvd|Cres|Hwy)\b)"
    r"|(?<![\w.,])\d{1,5},? (?i:rue|avenue|av\.|boulevard|boul\.?|chemin|rang|montee)(?!\w)"
    r"|\b(?i:ul\.|al\.|os\.|ulica|aleja|osiedle) ?[A-Z][\w-]+(?: [A-Z][\w-]+)? \d{1,4}[a-z]?\b"
    r"|\b(?:Rua|Avenida|Av\.|Travessa|Alameda|Rodovia|Calle) (?:[\w'.,-]+ ){0,5}?\d{1,5}\b"
    r"|\b(?:PO|P\.O\.) Box \d+"
    r"|\b(?!T\d[A-Z] ?\dM)[A-Z]\d[A-Z] ?\d[A-Z]\d\b|\b\d{5}-\d{3}\b")
# A long number on its own: 8 or more digits in one run (not a date such as 20261022), or in groups of
# at least 3 digits that start with 4 (1234 567 890, FAKE 5803 0299). Shorter groups are table values.
CONTACT_LONG_NUMBER = re.compile(r"(?<![\w.,/-])\d{8,}(?![\w/]|[.,-]\d)"
                                 r"|(?<![\w.,/-])\d{4}(?:[ -]\d{3,4}){1,3}(?![\w/]|[.,-]\d)")


# --- Text ---------------------------------------------------------------------------------------

def normalized(text):
    """As PR 295's evaluate.py: NFC, one space, straight apostrophes. Case is kept."""
    return " ".join(unicodedata.normalize("NFC", text).replace("’", "'").split())


def fold(text):
    """For matching names and quotes: case, accents and spacing folded."""
    text = unicodedata.normalize("NFKD", normalized(text).casefold())
    return "".join(c for c in text if not unicodedata.combining(c)).replace("ł", "l")


def numbers(text):
    """The numbers in `text`, with decimal commas as points and thousands commas dropped."""
    found = set()
    for raw in NUMBER.findall(text):
        if re.fullmatch(r"\d{1,3}(,\d{3})+", raw):
            raw = raw.replace(",", "")
        found.add(raw.replace(",", "."))
    return found


@functools.lru_cache(maxsize=None)
def option_pattern(option):
    """How one `match` option is looked for in folded text. Every option starts at a word start,
    so `iron` is not found in "environment". Options of SHORT_OPTION characters or fewer, and
    options with a digit, must end at a word end too (`alt` is not "although", `2` is not "12"
    or "2.5"); longer options are stems (`week` finds "weeks", `prediabet` "prediabetes")."""
    folded = fold(option)
    if any(c.isdigit() for c in folded):
        return re.compile(r"(?<![\w.,])" + re.escape(folded) + r"(?!\w|[.,]\d)")
    end = r"(?!\w)" if len(folded) <= SHORT_OPTION else ""
    return re.compile(r"(?<!\w)" + re.escape(folded) + end)


def names(text, option):
    """Whether folded `text` names `option` (see option_pattern)."""
    return option_pattern(option).search(text) is not None


def quote_overlaps(quote, evidence):
    """Whether a sentence's quote covers a fact's source evidence: one holds the other, or they
    share a run of at least 20 folded characters (all of the shorter one, when it is shorter).
    Used only when the quote cannot be found in the document (see quote_on_evidence)."""
    a, b = fold(quote), fold(evidence)
    if not a or not b:
        return False
    if a in b or b in a:
        return True
    match = difflib.SequenceMatcher(None, a, b, autojunk=False).find_longest_match(0, len(a), 0, len(b))
    return match.size >= min(MIN_OVERLAP, len(a), len(b))


def occurrences(text, piece):
    """Every start of `piece` in `text`."""
    starts, at = [], text.find(piece)
    while piece and at >= 0:
        starts.append(at)
        at = text.find(piece, at + 1)
    return starts


def quote_on_evidence(quote, spans, folded_document):
    """Whether the quote lies on one of the fact's evidence spans in the document: some place of
    the quote and some place of a span overlap by at least 20 folded characters (all of the
    shorter one, when it is shorter). A quote from elsewhere in the document never counts, even
    when it shares words with the evidence (a dose table's "mg daily changed (was"). A quote
    that is not in the document as folded here falls back to quote_overlaps."""
    q = fold(quote)
    if not q:
        return False
    places = occurrences(folded_document, q) if folded_document else []
    if not places:
        return any(quote_overlaps(quote, span) for span in spans)
    for span in spans:
        e = fold(span)
        need = min(MIN_OVERLAP, len(q), len(e))
        for start in occurrences(folded_document, e):
            for place in places:
                if min(place + len(q), start + len(e)) - max(place, start) >= need:
                    return True
    return False


def plain(text):
    """Accents dropped, case kept: for the street patterns, which need capitals."""
    text = unicodedata.normalize("NFKD", normalized(text))
    return "".join(c for c in text if not unicodedata.combining(c)).replace("ł", "l").replace("Ł", "L")


def looks_like_date(digits):
    """An 8-digit run that reads as a date, 19000101 to 20991231."""
    return (len(digits) == 8 and digits[:2] in ("19", "20") and 1 <= int(digits[4:6]) <= 12
            and 1 <= int(digits[6:]) <= 31)


def is_year(digits):
    """A 4-digit year, 1900 to 2099."""
    return len(digits) == 4 and digits[:2] in ("19", "20")


def same_phone(a, b):
    """Two phone keys name the same line: equal, or the same last 7 digits when one has no area code."""
    return a == b or ((len(a) == 7 or len(b) == 7) and a[-7:] == b[-7:])


def contact_details(text):
    """The contact details in `text`, as (kind, key) pairs: kind is phone, email, address or identity;
    the key is what the same detail is recognised by elsewhere (its digits, the folded address or
    e-mail). One stretch of text counts once, under the first kind that claims it."""
    text = plain(text)
    found, taken = [], []

    def claim(kind, key, span):
        if all(span[1] <= start or span[0] >= end for start, end in taken):
            found.append((kind, key))
            taken.append(span)

    for m in CONTACT_IDENTITY.finditer(text):
        digits = re.sub(r"\D", "", m.group(1))
        # A date, or a year after a label ("your health card expires in 2027"), is not the number.
        if not looks_like_date(digits) and not is_year(digits):
            claim("identity", digits, m.span(1))
    for m in CONTACT_EMAIL.finditer(text):
        claim("email", m.group(0).casefold(), m.span())
    for m in CONTACT_PHONE.finditer(text):
        number = re.search(r"\+?[\d(][\d() .-]*\d$", m.group(0)).group(0)
        claim("phone", re.sub(r"\D", "", number)[-10:], (m.end() - len(number), m.end()))
    word = CONTACT_PHONE_WORD.search(text)
    if word:
        # "Call 555-0142 or 555-0143": every bare 7-digit number after a phone word, not only the first.
        for m in CONTACT_PHONE7.finditer(text, word.end()):
            claim("phone", re.sub(r"\D", "", m.group(0)), m.span())
    for m in CONTACT_ADDRESS.finditer(text):
        claim("address", " ".join(fold(m.group(0)).replace(",", " ").split()[:2]), m.span())
    for m in CONTACT_LONG_NUMBER.finditer(text):
        digits = re.sub(r"\D", "", m.group(0))
        groups = re.split(r"[ -]", m.group(0))
        if len(digits) < 8 or looks_like_date(digits) or all(is_year(g) for g in groups):
            continue
        # Two groups only: "1500-7000" is a range and "1200 1500" two values, unless a group starts
        # with 0 as numbers on cards do ("5803 0299"); a labelled number is caught above.
        if len(groups) == 2 and not any(g.startswith("0") for g in groups):
            continue
        claim("identity", digits, m.span())
    return found


def patient_contact_keys(doc):
    """The contact details the document gives the patient to use (its `patient_contacts`), as
    (kind, key): a sentence may repeat these."""
    return {found for entry in (doc or {}).get("patient_contacts", []) for found in contact_details(entry)}


def allowed_contact(kind, key, allowed):
    """Whether a detail is one the document gives the patient (a phone with or without its area code)."""
    if kind == "phone":
        return any(k == "phone" and same_phone(key, other) for k, other in allowed)
    return (kind, key) in allowed


def contact_flag(text, doc=None):
    """The CONTACT_DETAILS flag for a sentence, or None: the kinds it repeats that the document does
    not give the patient to use."""
    allowed = patient_contact_keys(doc)
    kinds = sorted({kind for kind, key in contact_details(text) if not allowed_contact(kind, key, allowed)})
    return "CONTACT_DETAILS:" + ",".join(kinds) if kinds else None


# --- Unsafe-sentence screens (rule 7, DRAFT) ------------------------------------------------------
# Designed on 11 Nov from the sentences round 2 and 2b's reviewer called unsafe (seen, not held out):
# HARNESS.md "Screens for unsafe sentences". Each needs only the sentence, its quote and the document
# text, so each could also run in the app as a summary is written. All run on folded text.
MONTHS = (r"january|february|march|april|may|june|july|august|september|october|november|december|"
          r"janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|"
          r"stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|wrzesnia|pazdziernika|listopada|grudnia|"
          r"janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro")
DATE_WORDS = re.compile(r"\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}(?:st|nd|rd|th)? (?:"
                        + MONTHS + r")\b|\b(?:" + MONTHS + r") \d{1,2}\b")
TIME_WORDS = re.compile(r"\b\d{1,2}[:h]\d{2}\b|\b\d{1,2} ?(?:a\.?m\.?|p\.?m\.?)(?!\w)|\b\d{1,2} h \d{2}\b")
DURATION_WORDS = re.compile(r"\b\d+\s*(?:days?|weeks?|months?|hours?|jours?|semaines?|mois|dni|dzien|tygodni\w*|"
                            r"tydzien|miesi\w*|dias?|semanas?|meses|horas?|heures?|godzin\w*)\b")
UNTIL_WORDS = re.compile(r"\b(?:until|till|through|jusqu\w*|ate|hasta)\b|\bdo \d")
ALL_WORDS = re.compile(r"\b(?:all|every|both|wszystkie|wszystkich|tous|toutes|todos|todas|ambos)\b")
GENERAL_MEDICINES = re.compile(r"\b(?:medicines?|medications?|meds|pills|tablets|drugs|leki|lekow|lekami|"
                               r"medicaments?|medicamentos?|remedios?|medicinas?)\b")
NARROW_MEDICINES = re.compile(
    r"\b(?:antibiotic\w*|antibiotique\w*|antybiotyk\w*|antibiotico\w*|antiviral\w*|inhaler\w*|inhalateur\w*|"
    r"inhalator\w*|insulin\w*|statin\w*|diuretic\w*|water pill|blood thinner\w*|anticoagul\w*|antiplatelet\w*|"
    r"painkiller\w*|steroid\w*|spray|eye drops?|antidepress\w*|vitamin\w*|witamin\w*|vaccin\w*|szczepion\w*)\b"
    r"|\b\w+(?:cillin\w*|cylin\w*|mycin\w*|mycyn\w*|micin\w*|oxacin\w*|oksacyn\w*|cyclin\w*|cyklin\w*|pril|sartan|"
    r"olol|statin\w*|statyn\w*|azole|prazol\w*|gliflozin|glifozyn\w*|gliptin|formin\w*|xaban|ksaban|parin\w*|"
    r"paryn\w*|grel|dipin\w*|dypin\w*|thiazid\w*|tiazyd\w*|semid\w*|sone|zon|olone|lukast|terol|tropium|lamide|"
    r"tidine|oxetine|triptan|tyline|tylina|profen\w*|cetamol|thyroxin\w*|tyroksyn\w*|tiroxin\w*|glycerin\w*|"
    r"methasone|zolid\w*|onate|dronian\w*|azid\w*|olol\w*|aban)\b|\b(?:aspirin|aspiryn\w*|warfarin\w*|"
    r"acetylsalicyl\w*|metformin\w*|apixaban|ticagrelor|clopidogrel|alendronate|gliclazide|vancomycin\w*|"
    r"methotrexate|nitroglycerin\w*|salbutamol|ventolin|allopurinol|tamsulosin|loperamid\w*)\b")
INSTRUCTION_SENTENCE = re.compile(
    r"^(?:please )?(?:tell|call|see|take|stop|avoid|go|keep|use|book|ask|contact|check|make sure|remember|"
    r"do not|don't|never|bring|come|return|weigh|drink|eat|rest|wear|start|continue|follow|write|get|finish|"
    r"report|seek|let|phone|limit|wash|quit)\b|\bif you\b|\byou (?:should|must|need to|have to|will need to|are to)\b"
    # fr
    r"|^(?:appelez|prenez|arretez|cessez|evitez|allez|gardez|faites|refaites|consultez|contactez|ecrivez|venez|"
    r"ne prenez|continuez|commencez|utilisez|signalez|buvez|mangez|pesez|surveillez|reposez|limitez)\b"
    r"|\bsi vous\b|\bvous devez\b|\bil faut\b"
    # pl
    r"|^(?:prosze|nalezy|prosimy|zglos\w*|przyjmuj\w*|pij|unikaj|odstaw|zadzwon\w*|skontaktuj\w*|stosuj)\b"
    r"|\bmusi\b|\bpowin\w*\b|\bnalezy\b|\bjesli\b"
    # pt-BR / es
    r"|^(?:tome|evite|procure|ligue|pare|beba|faca|retorne|mantenha|inicie|continue|llame|acuda|vaya|deje|no tome)\b"
    r"|\bdeve\b|\bdebe\b")
# Real instructions in the quote's own clause (base forms and imperatives; never a status such as
# "continued", "unchanged", "stopped", which is a state the document reports).
QUOTE_INSTRUCTION = re.compile(
    r"\b(?:please|should|must|need to|needs to|call|take|stop|avoid|go|keep|use|book|ask|contact|see|return|repeat|"
    r"continue|start|do not|don't|never|bring|weigh|drink|follow|follow-up|finish|seek|report|tell|limit|wear|rest|"
    r"elevate|raise|apply|wash|quit|arrange|referr\w*|referred|if|when|"
    r"appel\w*|prendre|prenez|arreter|arretez|cesser|cessez|eviter|evitez|refaire|refaites|consulter|consultez|"
    r"contacter|ecrire|ecrivez|doit|devez|faut|si|quand|en cas d\w*|"
    r"prosze|nalezy|przyjmowac|zglos\w*|kontrola|jesli|w razie|odstawic|zaprzesta\w*|unikac|stosowac|"
    r"deve|tome|tomar|evite|evitar|procure|ligue|repetir|iniciar|inicie|manter|mantenha|suspender|retornar|"
    r"retorno|em caso de|caso|debe|llame|acuda|nie wolno|interdit\w*|pas de \w+|evitar|advis\w*|recommend\w*|"
    r"instruct\w*|counsel\w*|encourag\w*|orient\w*|conseill\w*|recommand\w*|zalec\w*|polec\w*|beber|boire|pic)\b"
    r"|\bno (?:\w+ )?\w+ing\b")
DOSING_LINE = re.compile(r"\b\d+(?:[.,]\d+)? ?(?:mg|mcg|ug|g|ml|units?|unites|jednost\w*)\b.*\b(?:daily|a day|twice|"
                         r"once|times|every|by mouth|orally|doustnie|par jour|ao dia|dziennie|co \d+ godzin)\b")
DOSE_WORDS = re.compile(r"\b(?:tablets?|capsules?|puffs?|inhalations?|sprays?|drops?|injections?|patch(?:es)?|"
                        r"comprim\w*|gelul\w*|bouffees?|tabletk\w*|kapsulk\w*|wziew\w*|comprimidos?|capsulas?|"
                        r"gotas?|jatos?)\b")
# A sentence that keeps or stops a medicine is a fair paraphrase of a quote that reports it as
# unchanged, continued or stopped.
KEEP_SENTENCE = re.compile(r"\b(?:keep taking|keep using|continue\w*|as before|as usual|gardez|continuez|"
                           r"nadal|kontynu\w*|mantenha|continue)\b")
UNCHANGED_WORDS = re.compile(r"\b(?:unchanged|no change|not changed|same dose|as before|as usual|continued|"
                             r"keep taking|keep using|continue\w*|bez zmian|kontynu\w*|inchang\w*|sans changement|"
                             r"poursuiv\w*|sem altera\w*|mantid\w*|mesma dose)\b")
LIST_ITEM = re.compile(r"^(?:[-*•·]|\d+[.)])\s*")
CONDITION_CUE = re.compile(r"\b(?:if|when|in case of|si|s'il|quand|lorsque|en cas d\w*|jesli|jezeli|gdy|w razie|"
                           r"w przypadku|em caso de|en caso de|caso)\b")
MAIN_CLAUSE = re.compile(r"(?:,|\s[—–-]\s|\s[—–]|:)\s*(?:then )?(?:call|go|see|contact|seek|phone|"
                         r"tell|stop|come|return|get|appelez|allez|consultez|contactez|cessez|zadzwon\w*|"
                         r"skontaktuj\w*|zglos\w*|pilny|nalezy|ligue|procure|va|llame|acuda|vaya)\b")
ALTERNATIVE_SPLIT = re.compile(r",|;|\b(?:or|ou|lub|albo|o)\b")
SINGLE_DOSE = re.compile(r"\b(?:once|one puff|one spray|one dose|one tablet|a single dose|single dose|a single|"
                         r"une seule fois|une fois|une seule dose|jednorazowo|uma vez|uma unica vez|una vez|una sola vez)\b"
                         r"(?!\s+(?:a|per|par|each|every|daily|weekly|dziennie|tygodniowo|ao|por|al|na)\b)")
COUNT_SAID = re.compile(r"\b(?:once|one|single|a single|une fois|une seule|un seul|jednorazowo|jeden|jedna|raz|"
                        r"uma vez|uma|una vez|una)\b")
FREQUENCY_WORDS = re.compile(
    r"\b(?:once|twice|thrice|three times|four times|\d+ times|une fois|deux fois|trois fois|quatre fois|\d+ fois|"
    r"raz|dwa razy|trzy razy|cztery razy|\d+ razy|uma vez|duas vezes|tres vezes|quatro vezes|\d+ vezes|una vez|"
    r"dos veces|tres veces)\s+(?:a day|daily|per day|a week|weekly|per week|par jour|par semaine|dziennie|"
    r"tygodniowo|w tygodniu|ao dia|por dia|por semana|na semana|al dia|a la semana)\b"
    r"|\bevery \d+ hours\b|\bco \d+ godzin\b|\btoutes les \d+ heures\b|\ba cada \d+ horas\b|\bcada \d+ horas\b"
    r"|\b(?:daily|weekly|dziennie|tygodniowo|quotidien\w*|diariamente|semanal\w*)\b"
    r"|\b(?:each|every) (?:morning|night|evening|day|week)\b|\bat bedtime\b|\bchaque (?:matin|soir|jour)\b"
    r"|\bcodziennie\b|\btodas as manhas\b|\btodos os dias\b")
ACTION_WORDS = re.compile(r"\b(?:see|visit|appointment|come|book|attend|go to|return|follow-up|follow up|"
                          r"rendez-vous|consultez|revoir|wizyt\w*|konsultac\w*|consulta|retorno|seen)\b")
# A quote that is a header or timestamp line: an appointment taken from it is never right.
HEADER_QUOTE = re.compile(r"^(?:report printed|printed|reported|collected|received|dob|date of birth|accession|"
                          r"requisition|signed|dictated|transcribed|ordered|verified|resulted|result date|specimen|"
                          r"imprime\w*|date d'impression|preleve\w*|recu le|date de naissance|data wypisu|"
                          r"data przyjecia|data urodzenia|data wydruku|data pobrania|impresso|coletad\w*|"
                          r"data do exame|data de nascimento)\b")
QUOTE_ACTION = re.compile(r"\b(?:see|seen|visit|appointment|follow|return|come|book|clinic|review|arrive|rendez|revoir|"
                          r"wizyt\w*|kontrol\w*|consult\w*|retorno|retorne|appel\w*|call|repeat|refai\w*|przyjd\w*|"
                          r"arrivez|chegue)\w*")
# Stop and hold words by language (en, fr, es, pl, pt-BR, zh): a quote that holds or stops a medicine,
# a sentence that keeps saying so.
HOLD_WORDS = (r"on hold|held|hold|holding|stopped|stop|stopping|discontinued|discontinue|cease\w*|suspend\w*|"
              r"withh[eo]ld\w*|paused?|do not take|don't take|not to take|no longer|"
              r"arret\w*|cess\w*|interromp\w*|ne pas prendre|ne plus prendre|en pause|"
              r"deten\w*|interrump\w*|dejar de|no tome|no tomar|"
              r"wstrzym\w*|odstaw\w*|zaprzesta\w*|przerw\w*|nie przyjmow\w*|nie stosow\w*|"
              r"suspens\w*|parar|pare|nao tome|nao tomar|deixar de|interromp\w*")
HOLD_QUOTE = re.compile(r"\b(?:" + HOLD_WORDS + r")\b|停用|暂停|停止|停药|勿服|不要服用")
HOLD_SENTENCE = re.compile(r"\b(?:" + HOLD_WORDS + r"|not restart\w*|not resume|quit\w*|nie przyjm\w*|not taking|"
                           r"rzuc\w*|przesta\w*|give up|abandon\w*|largar|dejar)\b"
                           r"|停用|暂停|停止|停药|勿服|不要服用")
END_OF_COURSE = re.compile(r"\b(?:then stop|and stop|then discontinue|puis arret\w*|potem odstaw\w*|depois suspend\w*)\b")
# Letters that belong to one language here: a short sentence (too few stopwords to guess) in another
# language than the summary's still shows them. A capitalized word after the first is a name, skipped.
UNIQUE_LETTERS = {"pl": "łąężśćńź", "pt-BR": "ãõ", "fr": "œùûëïè", "es": "ñ¿¡"}
# A sentence end: . ! ? before a space or the end, not inside a number ("38.5") and not after a title.
SENTENCE_END = re.compile(r"(?<!\bdr)(?<!\bdre)(?<!\bmr)(?<!\bms)(?<!\bmrs)(?<!\bst)(?<!\bno)(?<!\bvs)(?<!\bp\.o)"
                          r"[.!?](?=\s|$)")


def doc_lines(doc):
    """The document's non-empty lines, folded."""
    return [line for line in (fold(raw) for raw in joined_text(doc).split("\n")) if line]


def quote_place(doc, quote):
    """(lines, first line, last line, flat text, start, end) of a quote in the document (folded; a quote
    may run over lines, and may end with punctuation the document does not have there), or None."""
    if not doc or not quote:
        return None
    lines = doc_lines(doc)
    flat, starts = "", []
    for line in lines:
        starts.append(len(flat) + (1 if flat else 0))
        flat = f"{flat} {line}" if flat else line
    for q in (fold(quote), fold(quote).rstrip(" .,;:!?")):
        at = flat.find(q) if q else -1
        if at >= 0:
            first = max(i for i, st in enumerate(starts) if st <= at)
            last = max(i for i, st in enumerate(starts) if st <= at + len(q) - 1)
            return lines, first, last, flat, at, at + len(q)
    return None


def quote_line(doc, quote, before=0):
    """The document line(s) a quote lies on (folded), with `before` lines ahead of them; "" when the
    quote is not in the document."""
    place = quote_place(doc, quote)
    if not place:
        return ""
    lines, first, last = place[:3]
    return " ".join(lines[max(0, first - before):last + 1])


def quote_sentence(doc, quote):
    """The document sentence(s) a quote lies in (folded): the quote widened to the nearest sentence ends
    (not a decimal point, not a title such as "Dr.")."""
    place = quote_place(doc, quote)
    if not place:
        return ""
    flat, start, end = place[3:]
    ends = [m.end() for m in SENTENCE_END.finditer(flat)]
    left = max([e for e in ends if e <= start], default=0)
    right = min([e for e in ends if e >= max(start + 1, end)], default=len(flat))
    return flat[left:right].strip()


def quote_clause(doc, quote):
    """The quote's sentence, kept within the quote's own lines (a list item stays one item)."""
    place = quote_place(doc, quote)
    if not place:
        return ""
    lines, first, last, flat, start, end = place
    line_start = flat.find(lines[first])
    line_end = flat.find(lines[last], line_start) + len(lines[last])
    sentence = quote_sentence(doc, quote)
    s_start = flat.find(sentence, max(0, line_start - len(sentence)))
    left, right = max(line_start, s_start), min(line_end, s_start + len(sentence))
    return flat[left:right] if right > left else lines[first]


def list_heading(doc, quote):
    """For a quote on a list item, the heading line above the list (folded), else ""."""
    place = quote_place(doc, quote)
    if not place:
        return ""
    lines, first = place[0], place[1]
    if not LIST_ITEM.search(lines[first]):
        return ""
    for line in reversed(lines[max(0, first - 12):first]):
        if not LIST_ITEM.search(line):
            return line
    return ""


def content_words(text):
    return {w[:5] for w in re.findall(r"[^\W\d_]{4,}", text)
            if w not in {s for stop in STOPWORDS.values() for s in stop} | {"that", "this", "your", "with", "more"}}


def alternative_dropped(text, around):
    """Whether a condition in the document sentence has alternatives ("if A, B or C") the summary
    sentence leaves out while it names the first."""
    said = content_words(fold(text))
    for cue in CONDITION_CUE.finditer(around):
        condition = around[cue.end():]
        main = MAIN_CLAUSE.search(condition)
        condition = re.split(r"[;:]", condition[:main.start()] if main else condition)[0]
        condition = re.sub(r"\([^)]*\)?", " ", condition)  # examples in brackets are not alternatives
        parts = [content_words(p) for p in ALTERNATIVE_SPLIT.split(condition) if p and content_words(p)]
        if len(parts) >= 2 and parts[0] & said and any(not p & said for p in parts[1:]):
            return True
    return False


def unsafe_flags(text, quote, doc, run_lang):
    """The screens for the unsafe kinds of sentence a reviewer found (rule 7, DRAFT). Flags ending in
    "_MARK" are weaker signals; see HARNESS.md for which a summary could drop and which only mark."""
    ftext, fquote = fold(text), fold(quote)
    flags = []
    clause = quote_clause(doc, quote) or fquote
    if (GENERAL_MEDICINES.search(ftext) and not NARROW_MEDICINES.search(ftext) and not GENERAL_MEDICINES.search(clause)
            and (DATE_WORDS.search(ftext) or DURATION_WORDS.search(ftext) or UNTIL_WORDS.search(ftext)
                 or ALL_WORDS.search(ftext))
            and NARROW_MEDICINES.search(clause)):
        flags.append("GENERALIZED_SUBJECT")
    # The quote's own clause, and the heading above it when it is a list item.
    context = f"{list_heading(doc, quote)} {clause}".strip()
    keeps = KEEP_SENTENCE.search(ftext) and UNCHANGED_WORDS.search(context)
    stops = HOLD_SENTENCE.search(ftext) and HOLD_QUOTE.search(context)
    if (INSTRUCTION_SENTENCE.search(ftext) and fquote and not QUOTE_INSTRUCTION.search(context)
            and not DOSING_LINE.search(context) and not keeps and not stops):
        flags.append("INSTRUCTION_ADDED")
    around = quote_sentence(doc, quote)
    # Word overlap cannot tell a dropped alternative across languages: only within one.
    same_language = (guess_language(around) or (doc or {}).get("lang") or run_lang) == (guess_language(text) or run_lang)
    if around and same_language and alternative_dropped(text, around):
        flags.append("ALTERNATIVE_DROPPED")
    if SINGLE_DOSE.search(fquote) and not COUNT_SAID.search(ftext):
        flags.append("COUNT_DROPPED")
    if (FREQUENCY_WORDS.search(fquote) and not FREQUENCY_WORDS.search(ftext) and not UNCHANGED_WORDS.search(ftext)
            and not SINGLE_DOSE.search(fquote) and "GENERALIZED_SUBJECT" not in flags
            and (DOSING_LINE.search(fquote) or NARROW_MEDICINES.search(fquote) or DOSE_WORDS.search(fquote))):
        flags.append("FREQUENCY_DROPPED_MARK")
    dated_action = ACTION_WORDS.search(ftext) and (DATE_WORDS.search(ftext) or TIME_WORDS.search(ftext))
    if dated_action and fquote:
        if HEADER_QUOTE.search(fquote):
            flags.append("ACTION_FROM_HEADER")
        elif not QUOTE_ACTION.search(fquote):
            flags.append("ACTION_NOT_IN_QUOTE_MARK")
    course_end = END_OF_COURSE.search(fquote) and (UNTIL_WORDS.search(ftext) or DATE_WORDS.search(ftext)
                                                   or DURATION_WORDS.search(ftext))
    # "for 3 months after stopping it" names a time, not a hold.
    holds = [m for m in HOLD_QUOTE.finditer(fquote)
             if not re.search(r"\b(?:after|before|since|apres|avant|po|przed|depois|antes)\s+(?:\w+\s+)?$",
                              fquote[:m.start()])]
    if holds and not HOLD_SENTENCE.search(ftext) and not course_end:
        flags.append("HOLD_DROPPED")
    return flags


def unique_letter_language(text, run_lang):
    """A language other than the summary's whose own letters a sentence's words use (a capitalized
    word after the first is taken as a name and skipped)."""
    words = normalized(text).split()
    words = words[:1] + [w for w in words[1:] if w[:1].islower()]
    letters = set("".join(words).casefold())
    for lang, own in UNIQUE_LETTERS.items():
        if lang != run_lang and letters & set(own):
            return lang
    return None


def guess_language(text):
    """The language whose stopwords the text uses most (two or more), else None. A standalone "à" is
    left out: folded it is the Portuguese stopword "a", and French uses it constantly (rule v5)."""
    kept = [word for word in normalized(text).replace("'", " ").split() if word.casefold().strip(",.;:") != "à"]
    words = fold(" ".join(kept)).split()
    scores = {lang: sum(word in stop for word in words) for lang, stop in STOPWORDS.items()}
    best = max(scores, key=scores.get)
    return best if scores[best] >= 2 else None


# --- Documents ----------------------------------------------------------------------------------

def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def joined_text(doc):
    return "\n".join(p.get("text", "") for p in doc.get("pages") or [])


def evidence_spans(fact):
    """Where the document states the fact: its source evidence, then any other span that states
    it (a table row beside its comment line)."""
    return [fact["source_evidence"]] + list(fact.get("evidence_spans", []))


def fact_groups(fact):
    if fact.get("match"):
        return fact["match"]
    return [fact.get("anchors", [])]


def carries_groups(fact, text):
    folded = fold(text)
    return all(any(names(folded, option) for option in group) for group in fact_groups(fact))


def trap_flags(doc, text):
    """The listed traps a sentence falls into, by their pattern (folded text)."""
    folded = fold(text)
    return [index for index, check in enumerate(doc.get("trap_checks", []))
            if check.get("pattern") and not check.get("pending") and re.search(check["pattern"], folded)]


def check_document(doc, fixture=False):
    """Problems with one document, as text; empty when it is sound. Fixture cases (PR 295, frozen
    by FIXTURE-FREEZE.json) are not held to the harness's own additions."""
    problems = []
    if doc.get("synthetic") is not True:
        problems.append("not marked synthetic")
    pages = doc.get("pages") or []
    if not pages or any(not isinstance(p.get("text"), str) for p in pages):
        problems.append("no pages")
    indexes = [p.get("index") for p in pages]
    if indexes != sorted(set(indexes)):
        problems.append("page indexes must rise")
    joined = normalized(joined_text(doc))
    seen = set()
    for f in doc.get("facts", []):
        where = f"fact {f.get('id')}"
        if f.get("id") in seen:
            problems.append(f"{where}: duplicate id")
        seen.add(f.get("id"))
        if f.get("category") not in CATEGORIES:
            problems.append(f"{where}: unknown category {f.get('category')}")
        if normalized(f.get("source_evidence", "")) not in joined or not f.get("source_evidence"):
            problems.append(f"{where}: source evidence is not in the document")
        for span in f.get("evidence_spans", []):
            if not span or normalized(span) not in joined:
                problems.append(f"{where}: evidence span is not in the document: {span[:40]!r}")
        if not f.get("approved_statements"):
            problems.append(f"{where}: no approved statement")
        if not (f.get("match") or f.get("anchors")):
            problems.append(f"{where}: no match groups or anchors")
        check = f.get("quantity_check")
        if check and re.compile(check["pattern"]).groups != 2:
            problems.append(f"{where}: quantity check must capture value and unit")
        if fixture:
            continue
        for group in fact_groups(f):
            for option in group:
                if len(fold(option)) < 2 and not fold(option).isdigit():
                    problems.append(f"{where}: option {option!r} is a single letter")
        for statement in f.get("approved_statements", []):
            if not carries_groups(f, statement):
                problems.append(f"{where}: its approved statement does not name every group: {statement[:50]!r}")
        if f.get("required", True) and len(fact_groups(f)) < 2 and not f.get("no_qualifier"):
            problems.append(f"{where}: a required fact needs a qualifier group, or a `no_qualifier` reason")
    if fixture:
        return problems
    for f in doc.get("facts", []):
        # A fact whose evidence lies only past the app's text read can be carried by no run: it is
        # kept to show what the cut costs, but it is not a must-have, and it says why.
        pages = fact_pages(doc, f)
        beyond = bool(pages) and min(pages) >= TEXT_READ_PAGES
        if beyond and (f.get("required", True) or not f.get("beyond_text_read")):
            problems.append(f"fact {f.get('id')}: lies past the {TEXT_READ_PAGES}-page text read: "
                            "make it not required, with a beyond_text_read reason")
        if f.get("beyond_text_read") and not beyond:
            problems.append(f"fact {f.get('id')}: beyond_text_read, but a page the app reads holds it")
    for entry in doc.get("patient_contacts", []):
        if not entry or normalized(entry) not in joined:
            problems.append(f"patient contact is not in the document: {entry[:40]!r}")
        elif not contact_details(entry):
            problems.append(f"patient contact names no contact detail: {entry[:40]!r}")
    for f in doc.get("facts", []):
        for statement in f.get("approved_statements", []):
            if contact_flag(statement, doc):
                problems.append(f"fact {f.get('id')}: an approved statement repeats a contact detail: {statement[:50]!r}")
    traps = doc.get("traps", [])
    checks = doc.get("trap_checks", [])
    if [c.get("trap") for c in checks] != list(traps):
        problems.append("trap_checks must list every trap, in order")
    approved = [s for f in doc.get("facts", []) for s in f.get("approved_statements", [])]
    for check in checks:
        where = f"trap {check.get('trap', '')[:40]!r}"
        if check.get("pattern"):
            try:
                pattern = re.compile(check["pattern"])
            except re.error as error:
                problems.append(f"{where}: pattern does not compile: {error}")
                continue
            if not check.get("example") or not pattern.search(fold(check["example"])):
                problems.append(f"{where}: its example does not fall into it")
            for statement in approved:
                if pattern.search(fold(statement)):
                    problems.append(f"{where}: an approved statement falls into it: {statement[:50]!r}")
        elif not check.get("screens") or not set(check["screens"]) <= SCREENS:
            problems.append(f"{where}: needs a pattern, or the screens that check it")
    return problems


def load_documents(documents=DOCUMENTS, fixtures=FIXTURES):
    """The harness documents and PR 295's cases, by id."""
    docs = {}
    for path in sorted(Path(documents).glob("*.json")):
        doc = read_json(path)
        if doc["id"] != path.stem:
            raise ValueError(f"{path.name}: id {doc['id']} differs from the file name")
        docs[doc["id"]] = doc
    if fixtures and Path(fixtures).exists():
        for case in read_json(fixtures)["cases"]:
            if case["case_id"] in docs:
                raise ValueError(f"duplicate id {case['case_id']}")
            docs[case["case_id"]] = dict(
                id=case["case_id"], title=f"PR 295 {case['family']} ({case['split']})",
                lang=case["language"], synthetic=case["synthetic"], source="PR 295 fixtures",
                pages=case["pages"], facts=case["facts"], traps=[], split=case["split"])
    return docs


def pinning_problems(identity, freeze=FREEZE):
    """What differs from HARNESS-FREEZE.json in a scoring identity (`scoring_identity`): the
    scorer, the rule's version, or the documents as scored (PR 295's cases included)."""
    if not Path(freeze).exists():
        return ["no HARNESS-FREEZE.json"]
    frozen = read_json(freeze)
    problems = []
    if frozen.get("scorer_sha256") != identity["scorer"]:
        problems.append("the scorer differs from the freeze")
    if frozen.get("rule_version") != RULE_VERSION:
        problems.append(f"the rule is version {RULE_VERSION}, the freeze says {frozen.get('rule_version')}")
    if frozen.get("scoring_documents_sha256") != identity["documents"]:
        problems.append("the documents as scored differ from the freeze")
    return problems


def freeze_problems(documents=DOCUMENTS, freeze=FREEZE):
    """Harness document files that differ from HARNESS-FREEZE.json, as text."""
    if not Path(freeze).exists():
        return ["no HARNESS-FREEZE.json"]
    frozen = read_json(freeze)["documents"]
    files = {p.stem: hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(documents).glob("*.json")}
    problems = [f"{doc_id}: not in the freeze" for doc_id in sorted(set(files) - set(frozen))]
    problems += [f"{doc_id}: in the freeze but missing" for doc_id in sorted(set(frozen) - set(files))]
    problems += [f"{doc_id}: changed since the freeze" for doc_id in sorted(set(files) & set(frozen))
                 if files[doc_id] != frozen[doc_id]["sha256"]]
    return problems


def pages_hash(pages):
    """The run's own fingerprint of the page text it read (model_engine.rs `pagesSha256`): for each
    page, its index (u32, little-endian), its text's length in bytes (u64) and the text."""
    digest = hashlib.sha256()
    for page in pages:
        text = page["text"].encode("utf-8")
        digest.update(struct.pack("<I", page["index"]))
        digest.update(struct.pack("<Q", len(text)))
        digest.update(text)
    return digest.hexdigest()


def load_pages(folder):
    """The page text a set of runs read: `prepare`'s folder as the runs were given it (`<id>.json`)."""
    return {path.stem: read_json(path)["pages"] for path in sorted(Path(folder).glob("*.json"))}


def as_read(docs, loaded, pages=None):
    """The documents with the page text the runs actually read: each run's `pagesSha256` names it.
    The facts, traps and spans stay the frozen ones; quotes are placed, contexts cut and the
    reviewer's documents written from these pages. A run is never scored against page text it did
    not read, and the runs of one scoring must have read the same text."""
    chosen = {}
    for doc_id, doc in docs.items():
        given = (pages or {}).get(doc_id)
        # What a run was sent: the folder's pages, or the document's first TEXT_READ_PAGES pages.
        sent = given if given is not None else [p for p in doc["pages"] if p["index"] < TEXT_READ_PAGES]
        for label, (_, entries) in loaded.items():
            read = (entries.get(doc_id) or {}).get("pagesSha256")
            if read and read != pages_hash(sent):
                where = "the --pages folder" if given is not None else "the current document"
                raise ValueError(f"run {label} read other page text for {doc_id} than {where}: "
                                 "pass --pages with the folder the runs read")
        # Pages past the text read were never sent; the document's own stay, as they hold facts the
        # reading report names "never sent".
        beyond = [p for p in doc["pages"] if p["index"] >= TEXT_READ_PAGES]
        chosen[doc_id] = dict(doc, pages=(sent + beyond) if given is not None else doc["pages"])
    return chosen


def in_decision(doc):
    """PR 295's holdout cases are reported, never decided on (HARNESS.md)."""
    return doc.get("split") != "holdout"


def prepare(out, docs):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for doc in docs.values():
        (out / f"{doc['id']}.json").write_text(json.dumps(
            dict(id=doc["id"], lang=doc["lang"], pages=[p for p in doc["pages"] if p["index"] < TEXT_READ_PAGES]),
            ensure_ascii=False) + "\n",
            encoding="utf-8")
    return len(docs)


# --- Runs ---------------------------------------------------------------------------------------

def read_run(path):
    """A run's first line and its documents by id (the first answer for an id counts)."""
    lines = [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
    if not lines or lines[0].get("kind") != "run":
        raise ValueError(f"{path}: the first line must name the run")
    entries = {}
    for line in lines[1:]:
        if line.get("kind") == "document":
            entries.setdefault(line["id"], line)
    return lines[0], entries


def run_label(meta, path):
    return meta.get("variant") or Path(path).stem


# --- Scoring ------------------------------------------------------------------------------------

def carriers(fact, sentences, folded_document=None):
    """Every (how, sentence index) that carries `fact`: an approved statement word for word, or a
    sentence that names every group with a quote on one of its evidence spans."""
    approved = {normalized(text) for text in fact.get("approved_statements", [])}
    spans = evidence_spans(fact)
    found = []
    for index, sentence in enumerate(sentences):
        if normalized(sentence["text"]) in approved:
            found.append(("approved", index))
        elif carries_groups(fact, sentence["text"]) and quote_on_evidence(
                sentence.get("quote", ""), spans, folded_document):
            found.append(("matched", index))
    return found


def find_fact(fact, sentences, folded_document=None):
    """(how, sentence index) for the first sentence that carries `fact`, else (None, None)."""
    found = carriers(fact, sentences, folded_document)
    return found[0] if found else (None, None)


def screen(sentence, run_lang, facts, doc=None):
    """Flags for the hand review: never verdicts. A fact carried only by flagged sentences is
    held until the review."""
    text, quote = sentence["text"], sentence.get("quote", "")
    ftext, fquote = fold(text), fold(quote)
    flags = []
    if not sentence.get("located", True):
        flags.append("SOURCE_NOT_FOUND")
    missing = sorted(numbers(text) - numbers(quote))
    if missing:
        flags.append("NUMBER_NOT_IN_QUOTE:" + ",".join(missing))
    if bool(NEGATION.search(ftext)) != bool(NEGATION.search(fquote)):
        flags.append("NEGATION_MISMATCH")
    if HEDGE.search(fquote) and not HEDGE.search(ftext):
        flags.append("HEDGE_DROPPED")
    said = {m.group(0) for m in CERTAINTY.finditer(ftext)}
    if HEDGE.search(fquote):
        said |= {m.group(0) for m in CERTAINTY_IF_HEDGED.finditer(ftext)}
    added = sorted(said - {m.group(0) for m in CERTAINTY.finditer(fquote)}
                   - {m.group(0) for m in CERTAINTY_IF_HEDGED.finditer(fquote)})
    if added:
        flags.append("CERTAINTY_ADDED:" + ",".join(added))
    people = [bool(FAMILY.search(FAMILY_DOCTOR.sub(" ", side))) for side in (ftext, fquote)]
    if people[0] != people[1]:
        flags.append("EXPERIENCER")
    if SECOND_PERSON.search(ftext) and ACTORS.search(fquote) and not ACTORS.search(ftext):
        flags.append("ACTOR_SHIFT")
    stated = REPORTED_QUESTION.sub(" ", ftext)
    added = sorted({word for word in ADVICE.findall(stated) if not re.search(rf"\b{re.escape(word)}\b", fquote)})
    if added:
        flags.append("ADVICE_OR_JUDGEMENT:" + ",".join(added))
    language = guess_language(text)
    if language and language != run_lang and len(text.split()) >= 4:
        flags.append(f"LANGUAGE:{language}")
    elif not language or len(text.split()) < 4:
        # Too few stopwords to tell: letters only one language uses still show it (rule 7, DRAFT).
        lettered = unique_letter_language(text, run_lang)
        if lettered:
            flags.append(f"LANGUAGE:{lettered}")
    flags += unsafe_flags(text, quote, doc, run_lang)
    for fact in facts:
        check = fact.get("quantity_check")
        if not check:
            continue
        for found in re.finditer(check["pattern"], normalized(text), re.IGNORECASE):
            value, unit = found.groups()
            if value.replace(",", ".") != check["value"] or fold(unit) != fold(check["unit"]):
                flags.append(f"QUANTITY_MISMATCH:{fact['id']}")
    contact = contact_flag(text, doc)
    if contact:
        flags.append(contact)
    if doc is not None:
        flags += [f"TRAP:{index}" for index in trap_flags(doc, text)]
    return flags


def sentence_key(doc_id, sentence):
    """What a sentence is, for the review: its document, words and quote. The same sentence written
    by two runs is one sentence, reviewed once."""
    return (doc_id, normalized(sentence.get("text", "")), normalized(sentence.get("quote", "")))


def sentence_id(key):
    """A sentence's opaque, stable id on the review sheet: the same in every run and every scoring."""
    return "S" + hashlib.sha256("\x1f".join(key).encode("utf-8")).hexdigest()[:12]


def sampled(key):
    """The seeded fifth of the other sentences that goes on the sheet, chosen by the sentence itself,
    so a sentence two runs share is sampled in both or in neither."""
    digest = hashlib.sha256(("sample\x1f" + "\x1f".join(key)).encode("utf-8")).hexdigest()
    return int(digest[:8], 16) < REVIEW_SAMPLE * 0x100000000


def credit(found, on_sheet, verdicts, to_check=()):
    """A fact's standing from the sentences that carry it: "credited" when a reviewer marked one of
    them correct, or one is not on the review sheet and has no verdict against it; "held" while
    every carrier is on the sheet without a verdict (a flagged sentence, one carrying a critical
    fact, or one in the sample); "rejected" when the review turned down every one.
    `to_check` (rule v5): sentences that quote the fact's source in words the scorer does not
    recognize. One a reviewer marked correct credits the fact; one without a verdict holds it."""
    standing = "rejected" if found else None
    for _, index in found:
        verdict = verdicts.get(index, "")
        if verdict == "correct" or (index not in on_sheet and verdict not in NOT_CREDITED_VERDICTS):
            return "credited"
        if verdict not in NOT_CREDITED_VERDICTS:
            standing = "held"
    for index in to_check:
        verdict = verdicts.get(index, "")
        if verdict == "correct":
            return "credited"
        if verdict not in NOT_CREDITED_VERDICTS:
            standing = "held"
    return standing


def to_check(fact, sentences, founds, folded_document):
    """Rule v5: for a required fact that no sentence carries, the sentences that carry no fact at all
    but quote this fact's source. They go on the review sheet "to check": a summary in another
    language than the document (or in other words) states the fact without the words the scorer
    looks for, as in "Stop taking ibuprofen." quoting "Arrêter l'ibuprofène."."""
    if not fact.get("required", True) or dict(founds)[fact["id"]]:
        return []
    carrying = {index for _, found in founds for _, index in found}
    spans = evidence_spans(fact)
    return [index for index, sentence in enumerate(sentences) if index not in carrying
            and quote_on_evidence(sentence.get("quote", ""), spans, folded_document)]


def score_document(doc, entry, run_lang, verdicts=None, states=None):
    """One document's scores in one run. `verdicts`: sentence index -> the review's verdict.
    `states`: sentence index -> the facts (their listed wording) a correct several-fact row states;
    for any other fact that sentence counts as vague."""
    verdicts = verdicts or {}
    states = states or {}
    result = dict(id=doc["id"], present=entry is not None, decision=in_decision(doc))
    if entry is None:
        return result
    answer = entry.get("result")
    error = entry.get("error")
    result.update(wall_ms=entry.get("wallMs"), error=error,
                  timed_out=bool(error and re.search(r"time", error, re.IGNORECASE)))
    sentences = answer["sentences"] if answer else []
    folded_document = fold(joined_text(doc))
    flags = [screen(s, run_lang, doc.get("facts", []), doc) for s in sentences]
    keys = [sentence_key(doc["id"], s) for s in sentences]
    founds = [(fact, carriers(fact, sentences, folded_document)) for fact in doc.get("facts", [])]
    critical_carriers = {i for fact, found in founds if fact.get("critical", False) for _, i in found}
    by_id = [(fact["id"], found) for fact, found in founds]
    checks = {fact["id"]: to_check(fact, sentences, by_id, folded_document) for fact, _ in founds}
    checked = {i for indexes in checks.values() for i in indexes}
    on_sheet = {i: ("flagged " if flags[i] else "") + ("critical " if i in critical_carriers else "")
                + ("to-check " if i in checked else "")
                + ("sampled" if sampled(keys[i]) else "") for i in range(len(sentences))}
    on_sheet = {i: why.strip() for i, why in on_sheet.items() if why.strip()}
    facts = []
    for fact, found in founds:
        how, index = found[0] if found else (None, None)
        wording = (fact.get("approved_statements") or [""])[0]
        own = {i: ("vague" if i in states and wording not in states[i] else v) for i, v in verdicts.items()}
        standing = credit(found, on_sheet, own, checks[fact["id"]])
        if standing == "credited" and how is None:
            how, index = "reviewed", next(i for i in checks[fact["id"]] if own.get(i) == "correct")
        facts.append(dict(id=fact["id"], category=fact["category"], required=fact.get("required", True),
                          critical=fact.get("critical", False), found=how if standing == "credited" else None,
                          standing=standing, matched=how, sentence=index,
                          sentences=[i for _, i in found], to_check=checks[fact["id"]]))
    required = [f for f in facts if f["required"]]
    actions = [f for f in required if f["category"] in ACTION_CATEGORIES]
    flagged = [dict(index=i, flags=f) for i, f in enumerate(flags)]
    stats = (answer or {}).get("stats") or {}
    last_index = max(p["index"] for p in doc["pages"])
    result.update(
        sentences=len(sentences),
        located=sum(1 for s in sentences if s.get("located")),
        facts=facts,
        required_found=sum(1 for f in required if f["standing"] == "credited"),
        required_held=sum(1 for f in required if f["standing"] == "held"),
        required_total=len(required),
        action_found=sum(1 for f in actions if f["standing"] == "credited"),
        action_held=sum(1 for f in actions if f["standing"] == "held"),
        action_total=len(actions),
        flags=flagged,
        flag_count=sum(len(f["flags"]) for f in flagged),
        trap_count=sum(1 for f in flagged for flag in f["flags"] if flag.startswith("TRAP:")),
        contact_count=sum(1 for f in flagged for flag in f["flags"] if flag.startswith("CONTACT_DETAILS:")),
        unreviewed_flagged=sum(1 for f in flagged if f["flags"] and verdicts.get(f["index"], "") == ""),
        unreviewed_critical=sum(1 for i in critical_carriers if verdicts.get(i, "") == ""),
        unreviewed=sum(1 for i in on_sheet if verdicts.get(i, "") == ""),
        sheet=[dict(index=i, id=sentence_id(keys[i]), why=why) for i, why in sorted(on_sheet.items())],
        prompt_tokens=stats.get("promptTokens"),
        answer_tokens=stats.get("answerTokens"),
        prompt_ms=stats.get("promptMs"),
        answer_ms=stats.get("answerMs"),
        capped=stats.get("capped"),
        answer_hash=stats.get("answerHash"),
        last_page=(answer or {}).get("lastPage"),
        tail_page=(answer or {}).get("tailPage"),
        # The end was read: the pages ran to the last one, or the last one was read after a gap
        # (a variant that keeps room for it). "cut": the end, or the start of page 1 only.
        cut=bool(answer and (answer.get("lastPageCut") or last_index not in
                              (answer.get("lastPage"), answer.get("tailPage")))),
        gap=bool(answer and answer.get("tailPage") is not None
                 and answer.get("tailPage") != answer.get("lastPage")),
        answer_limit_ms=(answer or {}).get("answerLimitMs"),
    )
    return result


def quote_context(doc, quote, width=300):
    """The document's text around a quote, the quote between ⟦ ⟧, for the reviewer."""
    text = joined_text(doc)
    chars, where, space = [], [], False
    for i, ch in enumerate(text):
        if ch.isspace():
            if not space and chars:
                chars.append(" ")
                where.append(i)
            space = True
        else:
            chars.append(ch.casefold())
            where.append(i)
            space = False
    hay = "".join(chars)
    needle = " ".join(quote.split()).casefold()
    at = hay.find(needle) if needle else -1
    if at < 0:
        return "(this quote is not in the document word for word)"
    start, end = where[at], where[at + len(needle) - 1] + 1
    flat = lambda t: " ".join(t.split())
    return (("…" if start > width else "") + flat(text[max(0, start - width):start]) + " ⟦" + flat(text[start:end])
            + "⟧ " + flat(text[end:end + width]) + ("…" if end + width < len(text) else ""))


SHEET_FIELDS = ["id", "document", "language", "sentence", "quote", "context", "fact_it_may_state", "verdict", "unsafe",
                "note"]
KEY_FIELDS = ["id", "run", "doc", "sentence", "why"]


def review_sheet(runs, docs, all_scores):
    """The blind review sheet: one row per distinct sentence (document, words, quote) on the sheet in
    any run, in the order of its opaque id (a hash: shuffled, and stable across runs and scorings),
    with no run, flag or score on it; and the key: every (run, sentence) each row stands for."""
    rows, key = {}, []
    for (label, entries), scores in zip(runs.items(), all_scores):
        for doc_id, score in scores.items():
            entry = entries.get(doc_id)
            if not entry or not entry.get("result"):
                continue
            sentences = entry["result"]["sentences"]
            facts = {f["id"]: f for f in docs[doc_id].get("facts", [])}
            for item in score.get("sheet", []):
                sentence = sentences[item["index"]]
                key.append(dict(id=item["id"], run=label, doc=doc_id, sentence=item["index"], why=item["why"]))
                carried = [facts[f["id"]]["approved_statements"][0] for f in score["facts"]
                           if item["index"] in f["sentences"] or item["index"] in f.get("to_check", [])]
                if item["id"] in rows:
                    # Another run wrote the same sentence: every fact it may state there is listed too.
                    listed = rows[item["id"]]["fact_it_may_state"].split(" | ") if rows[item["id"]]["fact_it_may_state"] else []
                    rows[item["id"]]["fact_it_may_state"] = " | ".join(listed + [c for c in carried if c not in listed])
                    continue
                rows[item["id"]] = dict(id=item["id"], document=doc_id, language=docs[doc_id].get("lang", ""),
                                        sentence=sentence["text"], quote=sentence.get("quote", ""),
                                        context=quote_context(docs[doc_id], sentence.get("quote", "")),
                                        fact_it_may_state=" | ".join(carried), verdict="", unsafe="", note="")
    return [rows[i] for i in sorted(rows)], key


def read_csv_rows(path):
    with open(path, newline="", encoding="utf-8-sig") as source:
        return list(csv.DictReader(source))


class Verdicts(dict):
    """Verdicts by sentence, and `states`: for a row that lists several facts and was marked correct,
    the listed facts' wordings it states (its note's "states: 1, 3"; absent for "states: all")."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.states = {}
        self.states_all = set()
        self.unsafe = set()


STATES_NOTE = re.compile(r"\bstates?\s*:\s*(all\b|\d+(?:\s*,\s*\d+)*)", re.IGNORECASE)


def listed_facts(row):
    """The facts a sheet row lists, in order (the document's own wording of each)."""
    listed = row.get("fact_it_may_state") or ""
    return [text for text in listed.split(" | ") if text]


def stated_facts(row):
    """For a correct row listing several facts: the wordings its note names ("states: 1, 3"), None for
    "states: all", or False when the note names none (the row is then not yet reviewed)."""
    found = STATES_NOTE.search(row.get("note") or "")
    if not found:
        return False
    if found.group(1).lower() == "all":
        return None
    listed = listed_facts(row)
    places = {int(n) for n in re.findall(r"\d+", found.group(1))}
    if not places or not all(1 <= n <= len(listed) for n in places):
        raise ValueError(f"row {row.get('id') or row.get('row')}: 'states:' names a place the row does not list")
    return frozenset(listed[n - 1] for n in places)


UNSAFE_YES = {"yes", "y", "unsafe", "true", "1", "mild"}


def unsafe_of(row):
    """Whether a sheet row's `unsafe` column marks the sentence unsafe for a patient ("yes"; "mild" counts too)."""
    value = (row.get("unsafe") or "").strip().lower()
    if value and value not in UNSAFE_YES | {"no", "n", "0", "false"}:
        raise ValueError(f"unknown unsafe value {value!r}: use yes or leave it blank")
    return value in UNSAFE_YES


def read_review(path, runs, key_path=None):
    """A filled review sheet as verdicts by sentence (`sentence_key`), so one verdict applies to
    every run that wrote the same sentence. Two sheet forms are read:
    - the blind sheet (`id`/`row`, `document`, `sentence`, `quote`, `verdict`): each row's id must be
      its sentence's own id (`sentence_id`), or, with `key_path`, a row of that key whose every
      (run, document, sentence) is the row's sentence in that run;
    - the older per-run sheet (`run`, `doc`, `sentence` as an index), read through the runs.
    Anything that does not match is refused, and so are two different verdicts for one sentence."""
    def verdict_of(row):
        verdict = (row.get("verdict") or "").strip().lower()
        if verdict not in VERDICTS:
            raise ValueError(f"unknown verdict {verdict!r} in {path}")
        return verdict
    sheet = read_csv_rows(path)
    found = Verdicts()
    def put(skey, verdict, where):
        if not verdict:
            return
        if found.get(skey, verdict) != verdict:
            raise ValueError(f"{path}: two different verdicts for one sentence ({where})")
        found[skey] = verdict
    def sentence_of(run, doc, index):
        entries = runs.get(run)
        entry = entries.get(doc) if entries else None
        sentences = ((entry or {}).get("result") or {}).get("sentences") or []
        if not 0 <= index < len(sentences):
            raise ValueError(f"{path}: no sentence {index} of {doc} in run {run}")
        return sentence_key(doc, sentences[index])
    if sheet and "run" in sheet[0] and "quote" not in sheet[0]:
        for row in sheet:
            skey = sentence_of(row["run"], row["doc"], int(row["sentence"]))
            if unsafe_of(row):
                found.unsafe.add(skey)
            put(skey, verdict_of(row), f"{row['run']} {row['doc']} {row['sentence']}")
        return found
    key = {}
    if key_path:
        for row in read_csv_rows(key_path):
            key.setdefault(row.get("id") or row.get("row"), []).append(row)
    for row in sheet:
        rid = row.get("id") or row.get("row")
        skey = (row["document"], normalized(row.get("sentence", "")), normalized(row.get("quote", "")))
        if key_path:
            if rid not in key:
                raise ValueError(f"{path}: row {rid} is not in the key {key_path}")
            for k in key[rid]:
                if sentence_of(k["run"], k["doc"], int(k["sentence"])) != skey:
                    raise ValueError(f"{path}: row {rid} is not the sentence its key names ({k['run']} {k['doc']})")
        elif rid != sentence_id(skey):
            raise ValueError(f"{path}: row {rid} does not match its sentence; a sheet with other ids needs its key")
        verdict = verdict_of(row)
        if unsafe_of(row):
            # Unsafe for a patient whatever the verdict (rule 6): kept by sentence, like the verdict.
            found.unsafe.add(skey)
        if verdict == "correct" and len(listed_facts(row)) > 1:
            # Several facts listed: credit goes only to those the note names; none named, not reviewed yet.
            stated = stated_facts(row)
            if stated is False:
                continue
            if stated is None:
                found.states_all.add(skey)
            else:
                found.states[skey] = stated
        put(skey, verdict, rid)
    if key_path:
        missing = set(key) - {row.get("id") or row.get("row") for row in sheet}
        if missing:
            raise ValueError(f"{path}: {len(missing)} rows of the key are not on the sheet")
    return found


def prefill(sheet_path, other_path, runs, key_path, out_path):
    """Copies the verdicts of another filled sheet (with its key when its ids are its own) into the
    scorer's blind sheet, by sentence: rows already reviewed come back filled, the rest blank.
    Returns (filled, blank)."""
    verdicts = read_review(other_path, runs, key_path)
    rows = read_csv_rows(sheet_path)
    filled = 0
    for row in rows:
        skey = (row["document"], normalized(row.get("sentence", "")), normalized(row.get("quote", "")))
        if row["id"] != sentence_id(skey):
            raise ValueError(f"{sheet_path}: row {row['id']} does not match its sentence")
        if skey in verdicts.unsafe:
            row["unsafe"] = "yes"
        if verdicts.get(skey):
            row["verdict"] = verdicts[skey]
            filled += 1
            if skey in verdicts.states:
                listed = listed_facts(row)
                places = sorted(listed.index(text) + 1 for text in verdicts.states[skey] if text in listed)
                row["note"] = "states: " + ", ".join(str(n) for n in places) if places else ""
            elif skey in verdicts.states_all:
                row["note"] = "states: all"
    with open(out_path, "w", newline="", encoding="utf-8") as target:
        writer = csv.DictWriter(target, fieldnames=SHEET_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    return filled, len(rows) - filled


# --- Reading report (reporting only: no score or decision reads it) -----------------------------

READING_LABELS = ("read", "partly read", "not read", "never sent")


def pages_read(doc, answer):
    """(read, partly): the page indexes a run's model read whole, and the one it read only in part.
    From the answer's lastPage, lastPageCut and tailPage (a variant that keeps room for the last
    page reads it after a gap)."""
    if not answer or answer.get("lastPage") is None:
        return set(), None
    last, tail = answer["lastPage"], answer.get("tailPage")
    read = {p["index"] for p in doc["pages"] if p["index"] <= last}
    partly = None
    if answer.get("lastPageCut"):
        read.discard(last)
        partly = last
    if tail is not None:
        read.add(tail)
        if partly == tail:
            partly = None
    return read, partly


def fact_pages(doc, fact):
    """The pages that hold the fact's source evidence or any of its spans (folded)."""
    return {p["index"] for span in evidence_spans(fact) for p in doc["pages"] if fold(span) in fold(p["text"])}


def reading_label(pages, read, partly):
    """Whether the model could have seen the fact: "read" (a page holding it was read whole, or the
    evidence is on no single page), "partly read" (only on the page read in part), "not read", or
    "never sent" (only on pages past the app's text-read cap, which no run receives)."""
    if not pages or pages & read:
        return "read"
    if min(pages) >= TEXT_READ_PAGES:
        return "never sent"
    return "partly read" if partly in pages else "not read"


def reading_report(labels, runs, docs, all_scores):
    """Per run, the required facts of the decision documents (and those past the text read,
    `beyond_text_read`) by whether their page was read, and how each group fared: credited, held,
    or lost (for a read page: the model left it out)."""
    report = []
    for label, entries, scores in zip(labels, runs, all_scores):
        groups = {name: dict(facts=0, credited=0, held=0, lost=0) for name in READING_LABELS}
        documents = {}
        for doc_id, doc in docs.items():
            score = scores.get(doc_id, {})
            if not in_decision(doc) or not score.get("present") or score.get("error"):
                continue
            read, partly = pages_read(doc, (entries.get(doc_id) or {}).get("result"))
            by_id = {f["id"]: f for f in doc.get("facts", [])}
            for fact in score["facts"]:
                if not fact["required"] and not by_id[fact["id"]].get("beyond_text_read"):
                    continue
                name = reading_label(fact_pages(doc, by_id[fact["id"]]), read, partly)
                outcome = {"credited": "credited", "held": "held"}.get(fact["standing"], "lost")
                groups[name]["facts"] += 1
                groups[name][outcome] += 1
                if name != "read":
                    documents.setdefault(doc_id, {}).setdefault(name, []).append(f"{fact['id']} ({outcome})")
        read_facts = groups["read"]["facts"]
        report.append(dict(label=label, groups=groups, documents=documents,
                           read_credited_pct=round(100 * groups["read"]["credited"] / read_facts, 1) if read_facts else None))
    return report


def reading_markdown(report):
    lines = ["Reading report (reporting only: the decision does not use it). Required facts of the decision "
             "documents, by whether the run's model read a page that holds them (from lastPage, lastPageCut "
             "and tailPage). Lost on a read page: the model left it out. Lost on a page not read: the model "
             "never saw it.", "",
             "| Run | read: credited / held / left out (of) | credited of read | partly read: credited / held / lost (of) | not read: credited / held / lost (of) | never sent (of) |",
             "|---|---|---|---|---|---|"]
    for run in report:
        g = run["groups"]
        cell = lambda name: f"{g[name]['credited']} / {g[name]['held']} / {g[name]['lost']} ({g[name]['facts']})"
        pct = "" if run["read_credited_pct"] is None else f"{run['read_credited_pct']}%"
        lines.append(f"| {run['label']} | {cell('read')} | {pct} | {cell('partly read')} | {cell('not read')} | "
                     f"{run['groups']['never sent']['facts']} |")
    for run in report:
        if run["documents"]:
            lines += ["", f"{run['label']}: facts on pages not read whole"]
            for doc_id, names in sorted(run["documents"].items()):
                lines.append(f"- {doc_id}: " + "; ".join(f"{name}: {', '.join(items)}" for name, items in names.items()))
    return "\n".join(lines) + "\n"


def summarize_run(scores, wrong, holdout=False):
    """A run's totals over the documents the decision uses (or over the holdout ones)."""
    chosen = {d: s for d, s in scores.items() if s.get("decision", True) != holdout}
    present = [s for s in chosen.values() if s.get("present") and not s.get("error")]
    sentences = sum(s["sentences"] for s in present)
    walls = [s["wall_ms"] for s in present if s.get("wall_ms") is not None]
    return dict(
        documents=len(chosen), answered=len(present),
        failed=sum(1 for s in chosen.values() if s.get("error")),
        timed_out=sum(1 for s in chosen.values() if s.get("timed_out")),
        missing=sum(1 for s in chosen.values() if not s.get("present")),
        required_found=sum(s["required_found"] for s in present),
        required_held=sum(s["required_held"] for s in present),
        required_total=sum(s["required_total"] for s in present),
        action_found=sum(s["action_found"] for s in present),
        action_held=sum(s["action_held"] for s in present),
        action_total=sum(s["action_total"] for s in present),
        located_pct=round(100 * sum(s["located"] for s in present) / sentences, 1) if sentences else None,
        sentences=sentences, flags=sum(s["flag_count"] for s in present),
        traps=sum(s["trap_count"] for s in present),
        contacts=sum(s.get("contact_count", 0) for s in present),
        unreviewed_flagged=sum(s["unreviewed_flagged"] for s in present),
        unreviewed_critical=sum(s["unreviewed_critical"] for s in present),
        unreviewed=sum(s["unreviewed"] for s in present),
        capped=sum(1 for s in present if s.get("capped")), cut=sum(1 for s in present if s.get("cut")),
        gap=sum(1 for s in present if s.get("gap")),
        median_wall_ms=statistics.median(walls) if walls else None,
        reviewed_wrong=wrong,
    )


# What the app asks for beside the model file once it is verified (model_runtime.rs WORKING_BYTES).
WORKING_MIB = 1536


def memory(meta, entries):
    """The helper's memory in a run (Linux runs carry it): after the model loaded, each document's
    own peak, and how far the highest peak went above the model file, against WORKING_MIB."""
    mib = lambda kib: round(kib / 1024)
    model_mib = (meta.get("model") or {}).get("bytes", 0) / 1048576
    load = meta.get("helperMemory") or {}
    peaks = {doc_id: e["helperMemory"] for doc_id, e in entries.items() if (e.get("helperMemory") or {}).get("peakKiB")}
    if not peaks and not load:
        return None
    own = [m["peakKiB"] for m in peaks.values() if m.get("peakSince") == "document"]
    top = max(peaks, key=lambda doc_id: peaks[doc_id]["peakKiB"]) if peaks else None
    highest = max([m["peakKiB"] for m in peaks.values()] + [load.get("peakKiB") or 0])
    available = [m["availableKiB"] for m in list(peaks.values()) + [load] if m.get("availableKiB")]
    return dict(
        model_mib=round(model_mib), load_peak_mib=mib(load["peakKiB"]) if load.get("peakKiB") else None,
        documents=len(peaks), own_peaks=len(own),
        median_peak_mib=mib(statistics.median(own)) if own else None,
        max_peak_mib=mib(peaks[top]["peakKiB"]) if top else None, max_peak_doc=top,
        above_model_mib=round(highest / 1024 - model_mib) if model_mib else None,
        working_mib=WORKING_MIB,
        lowest_available_mib=mib(min(available)) if available else None,
    )


def memory_lines(labels, memories):
    rows = [(label, m) for label, m in zip(labels, memories) if m]
    if not rows:
        return []
    lines = ["", "Helper memory (MiB; per-document peaks are each document's own, reset before it):", "",
             "| Run | model file | after load | median document peak | highest document peak | highest above the model file "
             f"(app allows {WORKING_MIB}) | lowest available |",
             "|---|---|---|---|---|---|---|"]
    for label, m in rows:
        top = f"{m['max_peak_mib']} ({m['max_peak_doc']})" if m["max_peak_doc"] else ""
        own = "" if m["own_peaks"] == m["documents"] else f" ({m['own_peaks']} of {m['documents']} own)"
        lines.append(f"| {label} | {m['model_mib']} | {m['load_peak_mib'] or ''} | {m['median_peak_mib'] or ''}{own} | "
                     f"{top} | {m['above_model_mib'] if m['above_model_mib'] is not None else ''} | "
                     f"{m['lowest_available_mib'] or ''} |")
    return lines


def three_way(best, worst):
    """A check's answer from its best and worst case over held facts: True when even the worst
    holds, False when even the best fails, None (pending the review) between."""
    return True if worst else False if not best else None


def decide(base_scores, base_summary, scores, summary, margin_lost=0, margin_actions=0, require_gain=False,
           own_unsafe=()):
    """The written-down rule (HARNESS.md; version 6 for checks 1 and 5): PASS only if every check
    holds; PENDING while held facts or sentences on the sheet wait for the review. Only documents in
    the decision count (PR 295's holdout cases never do), except that an unsafe sentence counts on
    any document. `own_unsafe`: the variant's sentences a reviewer marked unsafe that the baseline
    did not also write."""
    checks = []
    mine, base = summary["reviewed_wrong"], base_summary["reviewed_wrong"]
    if mine is None or base is None:
        checks.append(("wrong or unsupported not above the baseline's", None))
    else:
        # A sentence both runs wrote counts on both sides. Rows still unreviewed could only add to a count.
        checks.append((f"wrong or unsupported not above the baseline's ({mine} vs {base})",
                       three_way(mine <= base + base_summary["unreviewed"], mine + summary["unreviewed"] <= base)))
    if own_unsafe:
        checks.append((f"no unsafe sentence the baseline does not also write ({len(own_unsafe)})", False))
    else:
        checks.append(("no unsafe sentence the baseline does not also write (0)",
                       None if summary.get("unreviewed_any") else True))
    sure, maybe = [], []
    for doc_id, base in base_scores.items():
        if not base.get("decision", True) or not base.get("present") or base.get("error"):
            continue
        mine = {f["id"]: f["standing"] for f in scores.get(doc_id, {}).get("facts", [])}
        for f in base["facts"]:
            if not f["required"] or f["standing"] not in ("credited", "held"):
                continue
            standing = mine.get(f["id"])
            if standing == "credited":
                continue
            if f["standing"] == "credited" and standing != "held":
                sure.append(f"{doc_id}/{f['id']}")
            else:
                maybe.append(f"{doc_id}/{f['id']}")
    lost = sure + maybe
    checks.append((f"must-haves lost at most {margin_lost} ({len(sure)} lost, {len(maybe)} pending)",
                   three_way(len(sure) <= margin_lost, len(lost) <= margin_lost)))
    best = summary["action_found"] + summary["action_held"]
    worst = summary["action_found"]
    base_best = base_summary["action_found"] + base_summary["action_held"]
    base_worst = base_summary["action_found"]
    if require_gain:
        checks.append((f"patient actions found on more than the baseline + {margin_actions}",
                       three_way(best > base_worst + margin_actions, worst > base_best + margin_actions)))
    else:
        checks.append((f"patient actions not worse than the baseline - {margin_actions}",
                       three_way(best >= base_worst - margin_actions, worst >= base_best - margin_actions)))
    if summary["located_pct"] is None or base_summary["located_pct"] is None:
        checks.append((f"quotes found within {LOCATED_POINTS} points", False))
    else:
        checks.append((f"quotes found within {LOCATED_POINTS} points",
                       summary["located_pct"] >= base_summary["located_pct"] - LOCATED_POINTS))
    # Rule 6 (Ben, 11 Nov): the median time per answered decision document at most 180 s, and no
    # decision document failing (a time-limit failure included) that the baseline answered.
    slower = summary["median_wall_ms"] is None or summary["median_wall_ms"] > TIME_LIMIT_MS
    new_failures = [d for d, s in scores.items() if s.get("decision", True)
                    and s.get("error") and not base_scores.get(d, {}).get("error")]
    checks.append((f"median time per document at most {TIME_LIMIT_MS // 1000} s, no new failure",
                   not slower and not new_failures))
    verdict = "FAIL" if any(ok is False for _, ok in checks) else "PENDING" if any(ok is None for _, ok in checks) else "PASS"
    return dict(verdict=verdict, checks=checks, lost=lost, new_failures=new_failures)


def noise(first, second, docs, pages=None):
    """An A/A pair: how many required (and patient-action) facts are carried in one run and not in
    the other (before any review), on the documents the decision uses. With greedy decoding,
    two runs of one build and threads answer token for token, so a same-build pair measures only
    run-to-run noise (expected 0); a pair with a change meant to make no difference (the A/A'
    pair) measures how far answers move by chance, which sets the margins (HARNESS.md)."""
    loaded = {f"run{i}": read_run(path) for i, path in enumerate((first, second))}
    docs = as_read(docs, loaded, pages)
    runs = []
    for meta, entries in loaded.values():
        runs.append({doc_id: score_document(doc, entries.get(doc_id), meta.get("lang", "en"))
                     for doc_id, doc in docs.items() if in_decision(doc)})
    a, b = runs
    flipped, flipped_actions, compared, same_answers = [], [], 0, 0
    for doc_id in sorted(a):
        if not (a[doc_id].get("present") and b[doc_id].get("present")) or a[doc_id].get("error") or b[doc_id].get("error"):
            continue
        compared += 1
        same_answers += a[doc_id].get("answer_hash") is not None and a[doc_id]["answer_hash"] == b[doc_id].get("answer_hash")
        b_facts = {f["id"]: f for f in b[doc_id]["facts"]}
        for f in a[doc_id]["facts"]:
            other = b_facts.get(f["id"], {})
            if f["required"] and (f["matched"] is not None) != (other.get("matched") is not None):
                flipped.append(f"{doc_id}/{f['id']}")
                if f["category"] in ACTION_CATEGORIES:
                    flipped_actions.append(f"{doc_id}/{f['id']}")
    return dict(documents=compared, same_answers=same_answers, flipped=flipped, flipped_actions=flipped_actions,
                margin_lost=len(flipped), margin_actions=len(flipped_actions))


def scoring_identity(docs, margins):
    """What decides a score, by hash: this file, every document (facts, traps, pages; the PR 295
    cases included), and the rule's fixed numbers. Written into every output."""
    canonical = lambda value: json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8")
    documents = {doc_id: hashlib.sha256(canonical(doc)).hexdigest() for doc_id, doc in sorted(docs.items())}
    thresholds = dict(rule_version=RULE_VERSION, min_overlap=MIN_OVERLAP, short_option=SHORT_OPTION,
                      review_sample=REVIEW_SAMPLE, located_points=LOCATED_POINTS, time_limit_ms=TIME_LIMIT_MS,
                      **margins)
    parts = dict(scorer=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                 documents=hashlib.sha256(canonical(documents)).hexdigest(),
                 thresholds=hashlib.sha256(canonical(thresholds)).hexdigest())
    return dict(id=hashlib.sha256(canonical(parts)).hexdigest(), **parts, thresholds_values=thresholds,
                document_hashes=documents)


def table(labels, docs, all_scores, summaries, decisions, memories=(), holdouts=()):
    head = "| Document | " + " | ".join(labels) + " |"
    lines = [head, "|---|" + "---|" * len(labels)]
    for doc_id in sorted(docs):
        cells = []
        for scores in all_scores:
            s = scores.get(doc_id, {})
            if not s.get("present"):
                cells.append("—")
            elif s.get("error"):
                cells.append("failed" + (" (time)" if s.get("timed_out") else ""))
            else:
                held = f" (+{s['required_held']} held)" if s["required_held"] else ""
                action = f" · act {s['action_found']}/{s['action_total']}" if s["action_total"] else ""
                marks = ((" · capped" if s.get("capped") else "") + (" · cut" if s.get("cut") else "")
                         + (" · gap" if s.get("gap") else "") + (f" · {s['trap_count']} trap" if s["trap_count"] else "")
                         + (f" · {s['contact_count']} contact" if s.get("contact_count") else ""))
                cells.append(f"{s['required_found']}/{s['required_total']}{held}{action} · {s['sentences']} s · "
                             f"{s['located']} q · {s['flag_count']} fl · {(s['wall_ms'] or 0) / 1000:.0f} s{marks}")
        holdout = "" if in_decision(docs[doc_id]) else " (holdout)"
        lines.append(f"| {doc_id}{holdout} | " + " | ".join(cells) + " |")
    lines.append("")
    lines.append("Cells: must-haves credited/total (+ held: carried only by flagged sentences, until the review) · "
                 "patient actions credited/total · sentences · quotes found · flags · seconds"
                 " (capped: stopped at the token cap; cut: the end was not read; gap: the last page read after a gap;"
                 " trap: sentences that fell into a listed trap; contact: sentences that repeat a contact detail"
                 " the document does not give the patient). Holdout documents are never in the decision.")
    lines.append("")
    lines.append("| Run | must-haves | held | actions | quotes found | flags | traps | contacts | median s | capped | cut | gap | failed | reviewed wrong | unsafe | verdict |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for label, summary, decision in zip(labels, summaries, decisions):
        wrong = "not reviewed" if summary["reviewed_wrong"] is None else summary["reviewed_wrong"]
        median = "" if summary["median_wall_ms"] is None else f"{summary['median_wall_ms'] / 1000:.0f}"
        lines.append(f"| {label} | {summary['required_found']}/{summary['required_total']} | {summary['required_held']} | "
                     f"{summary['action_found']}/{summary['action_total']} | {summary['located_pct']}% | "
                     f"{summary['flags']} | {summary['traps']} | {summary['contacts']} | {median} | {summary['capped']} | {summary['cut']} | "
                     f"{summary['gap']} | {summary['failed']} | {wrong} | {summary.get('unsafe', 0)} | "
                     f"{decision['verdict'] if decision else 'baseline'} |")
    if summaries and summaries[0].get("unsafe"):
        lines.append("")
        lines.append(f"The baseline's own unsafe sentences ({summaries[0]['unsafe']}; a variant is not charged for "
                     "writing the same sentence):")
        lines += [f"- {u['document']}: {u['sentence']}" for u in summaries[0]["unsafe_sentences"]]
    if any(h["documents"] for h in holdouts):
        lines.append("")
        lines.append("Holdout (PR 295's holdout families, reported only):")
        for label, h in zip(labels, holdouts):
            lines.append(f"- {label}: must-haves {h['required_found']}/{h['required_total']} (+{h['required_held']} held), "
                         f"actions {h['action_found']}/{h['action_total']}, failed {h['failed']}")
    for label, decision in zip(labels, decisions):
        if decision:
            lines.append("")
            lines.append(f"{label}: " + "; ".join(f"{name}: {'yes' if ok else 'pending' if ok is None else 'NO'}"
                                                   for name, ok in decision["checks"]))
            if decision["lost"]:
                lines.append(f"  lost or pending: {', '.join(decision['lost'])}")
    lines += memory_lines(labels, memories)
    return "\n".join(lines) + "\n"


def score(run_paths, out, docs, review=None, margin_lost=0, margin_actions=0, require_gain=False,
          noise_pair=None, freeze=None, review_key=None, reading=True, pages=None):
    """Scores the runs, the first as the baseline. `require_gain`: True for every variant, or the
    labels of the variants aimed at patient actions. `freeze`: HARNESS-FREEZE.json to hold the
    scorer and documents to; a decision under anything else is never PASS ("UNFROZEN")."""
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    loaded = {}
    for path in run_paths:
        meta, entries = read_run(path)
        label = run_label(meta, path)
        if label in loaded:
            raise ValueError(f"two runs are called {label}")
        loaded[label] = (meta, entries)
    verdicts = read_review(review, {label: entries for label, (_, entries) in loaded.items()}, review_key) \
        if review else None
    measured = noise(*noise_pair, docs, pages) if noise_pair else None
    if measured:
        margin_lost, margin_actions = measured["margin_lost"], measured["margin_actions"]
    gains = lambda label: require_gain is True or (not isinstance(require_gain, bool) and label in require_gain)
    margins = dict(margin_lost=margin_lost, margin_actions=margin_actions,
                   require_gain=require_gain if isinstance(require_gain, bool) else sorted(require_gain))
    identity = scoring_identity(docs, margins)
    unfrozen = pinning_problems(identity, freeze) if freeze is not None else []
    # From here on, the documents carry the page text the runs read (checked by its hash).
    docs = as_read(docs, loaded, pages)
    read_pages = {doc_id: pages_hash(doc["pages"]) for doc_id, doc in docs.items()}
    labels, all_scores, summaries, holdouts, metas, memories = [], [], [], [], [], []
    for label, (meta, entries) in loaded.items():
        labels.append(label)
        metas.append(meta)
        lang = meta.get("lang", "en")
        scores, wrong = {}, (0 if verdicts is not None else None)
        for doc_id, doc in docs.items():
            entry = entries.get(doc_id)
            sentences = ((entry or {}).get("result") or {}).get("sentences") or []
            mine = {i: (verdicts or {}).get(sentence_key(doc_id, s), "") for i, s in enumerate(sentences)}
            mine = {i: v for i, v in mine.items() if v}
            states = {i: verdicts.states[sentence_key(doc_id, s)] for i, s in enumerate(sentences)
                      if verdicts is not None and sentence_key(doc_id, s) in getattr(verdicts, "states", {})}
            scores[doc_id] = score_document(doc, entry, lang, mine, states)
            if verdicts is not None and in_decision(doc):
                wrong += sum(1 for v in mine.values() if v in WRONG_VERDICTS)
        all_scores.append(scores)
        summaries.append(summarize_run(scores, wrong))
        unsafe = sorted({(doc_id, sentence_key(doc_id, s)[1], sentence_key(doc_id, s)[2])
                         for doc_id in docs for s in (((entries.get(doc_id) or {}).get("result") or {}).get("sentences") or [])
                         if verdicts is not None and sentence_key(doc_id, s) in getattr(verdicts, "unsafe", set())})
        summaries[-1]["unsafe"] = len(unsafe)
        summaries[-1]["unsafe_sentences"] = [dict(document=d, sentence=t, quote=q) for d, t, q in unsafe]
        # Any sentence on the sheet, holdout included, still without a verdict (an unsafe mark may come).
        summaries[-1]["unreviewed_any"] = sum(sc.get("unreviewed", 0) for sc in scores.values() if sc.get("present"))
        holdouts.append(summarize_run(scores, None, holdout=True))
        memories.append(memory(meta, entries))
    base_model = metas[0].get("model", {}).get("sha256")
    notes = [f"{label}: another model file" for label, meta in zip(labels, metas)
             if meta.get("model", {}).get("sha256") != base_model]
    base_unsafe = {(u["document"], u["sentence"], u["quote"]) for u in summaries[0]["unsafe_sentences"]}
    decisions = [None] + [decide(all_scores[0], summaries[0], s, m, margin_lost, margin_actions, gains(label),
                                 [u for u in m["unsafe_sentences"]
                                  if (u["document"], u["sentence"], u["quote"]) not in base_unsafe])
                          for label, s, m in zip(labels[1:], all_scores[1:], summaries[1:])]
    for decision in decisions[1:]:
        if unfrozen and decision["verdict"] == "PASS":
            decision["verdict"] = "UNFROZEN"
    notes += [f"NOT FROZEN, no PASS: {problem}" for problem in unfrozen]
    (out / "scores.json").write_text(json.dumps(dict(
        scoring=identity, scored_at=datetime.now(timezone.utc).isoformat(timespec="seconds"), noise=measured,
        frozen=(not unfrozen) if freeze is not None else None, pages_as_read=read_pages,
        runs=[dict(label=l, meta=m, summary=s, holdout=h, decision=d, memory=mem, documents=sc)
              for l, m, s, h, d, mem, sc in zip(labels, metas, summaries, holdouts, decisions, memories, all_scores)],
        notes=notes), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    rows, key = review_sheet({label: entries for label, (_, entries) in loaded.items()}, docs, all_scores)
    (out / "review").mkdir(exist_ok=True)
    # The reviewer's documents: the same page text the contexts and the quote placement used.
    (out / "review" / "docs").mkdir(exist_ok=True)
    for doc_id, doc in docs.items():
        (out / "review" / "docs" / f"{doc_id}.txt").write_text(
            "\n\n".join(p["text"] for p in doc["pages"]) + "\n", encoding="utf-8")
    (out / "key").mkdir(exist_ok=True)
    sheet = out / "review" / "review.csv"
    if sheet.exists():
        # A sheet being filled is never overwritten; the full current one is written beside it.
        notes.append("review/review.csv kept as it was; the current full sheet is review/review-latest.csv")
        sheet = out / "review" / "review-latest.csv"
    with sheet.open("w", newline="", encoding="utf-8") as target:
        writer = csv.DictWriter(target, fieldnames=SHEET_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    with (out / "key" / "review-key.csv").open("w", newline="", encoding="utf-8") as target:
        writer = csv.DictWriter(target, fieldnames=KEY_FIELDS)
        writer.writeheader()
        writer.writerows(key)
    header = (f"Scoring {identity['id'][:16]} (rule v{RULE_VERSION}; scorer {identity['scorer'][:12]}, "
              f"documents {identity['documents'][:12]}, thresholds {identity['thresholds'][:12]}; "
              f"margins: lost {margin_lost}, actions {margin_actions}"
              f"{' from the noise pair' if measured else ''}"
              f"{'; gain required for ' + ', '.join(l for l in labels[1:] if gains(l)) if any(gains(l) for l in labels[1:]) else ''}"
              f"{'; NOT FROZEN' if unfrozen else ''})\n\n")
    (out / "compare.md").write_text(header + table(labels, docs, all_scores, summaries, decisions, memories, holdouts)
                                    + "".join(f"\nNOTE: {n}\n" for n in notes), encoding="utf-8")
    if reading:
        # Reporting only, in files of its own: scores.json, compare.md and the sheet are the same without it.
        report = reading_report(labels, [entries for _, entries in loaded.values()], docs, all_scores)
        (out / "reading.json").write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        (out / "reading.md").write_text(reading_markdown(report), encoding="utf-8")
    return summaries, decisions


def repeat(first, second):
    """Whether two runs of one build and model gave the same answers, token for token, on the
    documents both answered: (same, different, compared, problems)."""
    (meta_a, entries_a), (meta_b, entries_b) = read_run(first), read_run(second)
    problems = [key for key in ("build", "lang", "threads") if meta_a.get(key) != meta_b.get(key)]
    if meta_a.get("model", {}).get("sha256") != meta_b.get("model", {}).get("sha256"):
        problems.append("model")
    same, different = [], []
    for doc_id in sorted(set(entries_a) & set(entries_b)):
        hashes = [((e.get("result") or {}).get("stats") or {}).get("answerHash") for e in (entries_a[doc_id], entries_b[doc_id])]
        (same if hashes[0] is not None and hashes[0] == hashes[1] else different).append(doc_id)
    return same, different, len(same) + len(different), problems


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--documents", default=str(DOCUMENTS))
    parser.add_argument("--fixtures", default=str(FIXTURES))
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check")
    prep = sub.add_parser("prepare")
    prep.add_argument("--out", required=True)
    prep.add_argument("--only", action="append", help="limit to these document ids")
    sc = sub.add_parser("score")
    sc.add_argument("--run", action="append", required=True)
    sc.add_argument("--out", required=True)
    sc.add_argument("--review")
    sc.add_argument("--review-key", help="the key of a blind sheet whose ids are not the scorer's own")
    sc.add_argument("--pages", help="the folder of page text the runs read (prepare's output for them); each "
                                    "run's pagesSha256 must match it")
    sc.add_argument("--noise", action="append", help="an A/A pair (twice): the only way to set margins")
    sc.add_argument("--require-gain-for", action="append", default=[], metavar="LABEL",
                    help="a variant aimed at patient actions: more than the baseline + margin (repeat per run)")
    rep = sub.add_parser("repeat")
    rep.add_argument("--run", action="append", required=True)
    pre = sub.add_parser("prefill", help="copy another sheet's verdicts into the scorer's blind sheet, by sentence")
    pre.add_argument("--sheet", required=True, help="the scorer's review/review.csv (or review-latest.csv)")
    pre.add_argument("--from", dest="other", required=True, help="a filled sheet")
    pre.add_argument("--key", help="that sheet's key, when its ids are its own")
    pre.add_argument("--run", action="append", required=True, help="every run its key names")
    pre.add_argument("--out", required=True)
    noi = sub.add_parser("noise")
    noi.add_argument("--run", action="append", required=True)
    noi.add_argument("--pages", help="the folder of page text the runs read")
    args = parser.parse_args(argv)
    if args.command == "repeat":
        if len(args.run) != 2:
            raise SystemExit("repeat compares exactly two runs")
        same, different, compared, problems = repeat(*args.run)
        print(json.dumps(dict(compared=compared, same=same, different=different, not_comparable=problems)))
        return 0 if compared and not different and not problems else 1
    if args.command == "prefill":
        runs = {}
        for path in args.run:
            meta, entries = read_run(path)
            runs[run_label(meta, path)] = entries
        filled, blank = prefill(args.sheet, args.other, runs, args.key, args.out)
        print(json.dumps(dict(filled=filled, blank=blank, out=args.out)))
        return 0
    docs = load_documents(args.documents, args.fixtures)
    if args.command == "check":
        fixture_ids = {d for d, doc in docs.items() if doc.get("source") == "PR 295 fixtures"}
        problems = {doc_id: check_document(doc, fixture=doc_id in fixture_ids) for doc_id, doc in docs.items()}
        bad = {doc_id: p for doc_id, p in problems.items() if p}
        for doc_id, p in bad.items():
            print(f"{doc_id}: " + "; ".join(p))
        frozen = freeze_problems(args.documents) if Path(args.documents).resolve() == DOCUMENTS else []
        frozen += pinning_problems(scoring_identity(docs, {}))
        for problem in frozen:
            print(f"freeze: {problem}")
        print(f"{len(docs)} documents, {sum(len(d.get('facts', [])) for d in docs.values())} facts, "
              f"{len(bad)} with problems, {len(frozen)} freeze problems")
        return 1 if bad or frozen else 0
    if args.command == "prepare":
        if args.only:
            unknown = set(args.only) - set(docs)
            if unknown:
                raise SystemExit(f"unknown ids: {', '.join(sorted(unknown))}")
            docs = {k: v for k, v in docs.items() if k in args.only}
        print(f"{prepare(args.out, docs)} documents written to {args.out}")
        return 0
    if args.command == "noise":
        if len(args.run) != 2:
            raise SystemExit("noise compares exactly two runs")
        print(json.dumps(noise(*args.run, docs, load_pages(args.pages) if args.pages else None)))
        return 0
    if args.noise and len(args.noise) != 2:
        raise SystemExit("--noise takes exactly two runs")
    unknown = set(args.require_gain_for) - {run_label(read_run(path)[0], path) for path in args.run}
    if unknown:
        raise SystemExit(f"--require-gain-for names no run: {', '.join(sorted(unknown))}")
    summaries, decisions = score(args.run, args.out, docs, args.review, 0, 0, set(args.require_gain_for),
                                 tuple(args.noise) if args.noise else None, freeze=FREEZE,
                                 review_key=args.review_key, pages=load_pages(args.pages) if args.pages else None)
    for summary, decision in zip(summaries, decisions):
        print(json.dumps(dict(summary=summary, verdict=decision["verdict"] if decision else "baseline")))
    return 0


if __name__ == "__main__":
    sys.exit(main())

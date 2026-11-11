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
REVIEW_SAMPLE = 0.2
MIN_OVERLAP = 20
# Options of this many characters or fewer, and options with a digit, must be whole words.
SHORT_OPTION = 3
# The decision rule (HARNESS.md): its version and its fixed numbers.
RULE_VERSION = 5
LOCATED_POINTS = 2
TIME_RATIO = 1.3
SCREENS = {"SOURCE_NOT_FOUND", "NUMBER_NOT_IN_QUOTE", "NEGATION_MISMATCH", "HEDGE_DROPPED",
           "CERTAINTY_ADDED", "EXPERIENCER", "ACTOR_SHIFT", "ADVICE_OR_JUDGEMENT", "LANGUAGE",
           "QUANTITY_MISMATCH", "TRAP"}

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
    "fr": {"le", "la", "les", "et", "de", "des", "du", "est", "un", "une", "pour", "vous", "avec"},
    "pl": {"i", "w", "na", "z", "jest", "nie", "do", "sie", "oraz", "po", "przez", "pan", "pani"},
    "pt-BR": {"o", "a", "os", "as", "e", "de", "do", "da", "em", "com", "para", "que", "voce"},
    "es": {"el", "la", "los", "las", "y", "de", "del", "en", "con", "para", "que", "usted", "es"},
}
NUMBER = re.compile(r"\d+(?:[.,]\d+)*")


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
            if check.get("pattern") and re.search(check["pattern"], folded)]


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


def in_decision(doc):
    """PR 295's holdout cases are reported, never decided on (HARNESS.md)."""
    return doc.get("split") != "holdout"


def prepare(out, docs):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for doc in docs.values():
        (out / f"{doc['id']}.json").write_text(json.dumps(
            dict(id=doc["id"], lang=doc["lang"], pages=doc["pages"]), ensure_ascii=False) + "\n",
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
    for fact in facts:
        check = fact.get("quantity_check")
        if not check:
            continue
        for found in re.finditer(check["pattern"], normalized(text), re.IGNORECASE):
            value, unit = found.groups()
            if value.replace(",", ".") != check["value"] or fold(unit) != fold(check["unit"]):
                flags.append(f"QUANTITY_MISMATCH:{fact['id']}")
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


def score_document(doc, entry, run_lang, verdicts=None):
    """One document's scores in one run. `verdicts`: sentence index -> the review's verdict."""
    verdicts = verdicts or {}
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
        standing = credit(found, on_sheet, verdicts, checks[fact["id"]])
        if standing == "credited" and how is None:
            how, index = "reviewed", next(i for i in checks[fact["id"]] if verdicts.get(i) == "correct")
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


SHEET_FIELDS = ["id", "document", "language", "sentence", "quote", "context", "fact_it_may_state", "verdict", "note"]
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
                                        fact_it_may_state=" | ".join(carried), verdict="", note="")
    return [rows[i] for i in sorted(rows)], key


def read_csv_rows(path):
    with open(path, newline="", encoding="utf-8-sig") as source:
        return list(csv.DictReader(source))


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
    found = {}
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
            put(sentence_of(row["run"], row["doc"], int(row["sentence"])), verdict_of(row),
                f"{row['run']} {row['doc']} {row['sentence']}")
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
        put(skey, verdict_of(row), rid)
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
        if verdicts.get(skey):
            row["verdict"] = verdicts[skey]
            filled += 1
    with open(out_path, "w", newline="", encoding="utf-8") as target:
        writer = csv.DictWriter(target, fieldnames=SHEET_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    return filled, len(rows) - filled


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


def decide(base_scores, base_summary, scores, summary, margin_lost=0, margin_actions=0, require_gain=False):
    """The written-down rule, version 2 (HARNESS.md): PASS only if every check holds; PENDING
    while held facts or flagged sentences wait for the review. Only documents in the decision
    count (PR 295's holdout cases never do)."""
    checks = []
    if summary["reviewed_wrong"] is None:
        checks.append(("no reviewed wrong statement", None))
    elif summary["reviewed_wrong"]:
        checks.append(("no reviewed wrong statement", False))
    else:
        checks.append(("no reviewed wrong statement", None if summary["unreviewed"] else True))
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
    slower = (summary["median_wall_ms"] is None or base_summary["median_wall_ms"] is None
              or summary["median_wall_ms"] > TIME_RATIO * base_summary["median_wall_ms"])
    new_failures = [d for d, s in scores.items() if s.get("decision", True)
                    and s.get("error") and not base_scores.get(d, {}).get("error")]
    checks.append((f"median time within {round((TIME_RATIO - 1) * 100)}%, no new failure",
                   not slower and not new_failures))
    verdict = "FAIL" if any(ok is False for _, ok in checks) else "PENDING" if any(ok is None for _, ok in checks) else "PASS"
    return dict(verdict=verdict, checks=checks, lost=lost, new_failures=new_failures)


def noise(first, second, docs):
    """An A/A pair: how many required (and patient-action) facts are carried in one run and not in
    the other (before any review), on the documents the decision uses. With greedy decoding,
    two runs of one build and threads answer token for token, so a same-build pair measures only
    run-to-run noise (expected 0); a pair with a change meant to make no difference (the A/A'
    pair) measures how far answers move by chance, which sets the margins (HARNESS.md)."""
    runs = []
    for path in (first, second):
        meta, entries = read_run(path)
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
                      review_sample=REVIEW_SAMPLE, located_points=LOCATED_POINTS, time_ratio=TIME_RATIO,
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
                         + (" · gap" if s.get("gap") else "") + (f" · {s['trap_count']} trap" if s["trap_count"] else ""))
                cells.append(f"{s['required_found']}/{s['required_total']}{held}{action} · {s['sentences']} s · "
                             f"{s['located']} q · {s['flag_count']} fl · {(s['wall_ms'] or 0) / 1000:.0f} s{marks}")
        holdout = "" if in_decision(docs[doc_id]) else " (holdout)"
        lines.append(f"| {doc_id}{holdout} | " + " | ".join(cells) + " |")
    lines.append("")
    lines.append("Cells: must-haves credited/total (+ held: carried only by flagged sentences, until the review) · "
                 "patient actions credited/total · sentences · quotes found · flags · seconds"
                 " (capped: stopped at the token cap; cut: the end was not read; gap: the last page read after a gap;"
                 " trap: sentences that fell into a listed trap). Holdout documents are never in the decision.")
    lines.append("")
    lines.append("| Run | must-haves | held | actions | quotes found | flags | traps | median s | capped | cut | gap | failed | reviewed wrong | verdict |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for label, summary, decision in zip(labels, summaries, decisions):
        wrong = "not reviewed" if summary["reviewed_wrong"] is None else summary["reviewed_wrong"]
        median = "" if summary["median_wall_ms"] is None else f"{summary['median_wall_ms'] / 1000:.0f}"
        lines.append(f"| {label} | {summary['required_found']}/{summary['required_total']} | {summary['required_held']} | "
                     f"{summary['action_found']}/{summary['action_total']} | {summary['located_pct']}% | "
                     f"{summary['flags']} | {summary['traps']} | {median} | {summary['capped']} | {summary['cut']} | "
                     f"{summary['gap']} | {summary['failed']} | {wrong} | {decision['verdict'] if decision else 'baseline'} |")
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
          noise_pair=None, freeze=None, review_key=None):
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
    measured = noise(*noise_pair, docs) if noise_pair else None
    if measured:
        margin_lost, margin_actions = measured["margin_lost"], measured["margin_actions"]
    gains = lambda label: require_gain is True or (not isinstance(require_gain, bool) and label in require_gain)
    margins = dict(margin_lost=margin_lost, margin_actions=margin_actions,
                   require_gain=require_gain if isinstance(require_gain, bool) else sorted(require_gain))
    identity = scoring_identity(docs, margins)
    unfrozen = pinning_problems(identity, freeze) if freeze is not None else []
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
            scores[doc_id] = score_document(doc, entry, lang, mine)
            if verdicts is not None and in_decision(doc):
                wrong += sum(1 for v in mine.values() if v in WRONG_VERDICTS)
        all_scores.append(scores)
        summaries.append(summarize_run(scores, wrong))
        holdouts.append(summarize_run(scores, None, holdout=True))
        memories.append(memory(meta, entries))
    base_model = metas[0].get("model", {}).get("sha256")
    notes = [f"{label}: another model file" for label, meta in zip(labels, metas)
             if meta.get("model", {}).get("sha256") != base_model]
    decisions = [None] + [decide(all_scores[0], summaries[0], s, m, margin_lost, margin_actions, gains(label))
                          for label, s, m in zip(labels[1:], all_scores[1:], summaries[1:])]
    for decision in decisions[1:]:
        if unfrozen and decision["verdict"] == "PASS":
            decision["verdict"] = "UNFROZEN"
    notes += [f"NOT FROZEN, no PASS: {problem}" for problem in unfrozen]
    (out / "scores.json").write_text(json.dumps(dict(
        scoring=identity, scored_at=datetime.now(timezone.utc).isoformat(timespec="seconds"), noise=measured,
        frozen=(not unfrozen) if freeze is not None else None,
        runs=[dict(label=l, meta=m, summary=s, holdout=h, decision=d, memory=mem, documents=sc)
              for l, m, s, h, d, mem, sc in zip(labels, metas, summaries, holdouts, decisions, memories, all_scores)],
        notes=notes), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    rows, key = review_sheet({label: entries for label, (_, entries) in loaded.items()}, docs, all_scores)
    (out / "review").mkdir(exist_ok=True)
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
        print(json.dumps(noise(*args.run, docs)))
        return 0
    if args.noise and len(args.noise) != 2:
        raise SystemExit("--noise takes exactly two runs")
    unknown = set(args.require_gain_for) - {run_label(read_run(path)[0], path) for path in args.run}
    if unknown:
        raise SystemExit(f"--require-gain-for names no run: {', '.join(sorted(unknown))}")
    summaries, decisions = score(args.run, args.out, docs, args.review, 0, 0, set(args.require_gain_for),
                                 tuple(args.noise) if args.noise else None, freeze=FREEZE,
                                 review_key=args.review_key)
    for summary, decision in zip(summaries, decisions):
        print(json.dumps(dict(summary=summary, verdict=decision["verdict"] if decision else "baseline")))
    return 0


if __name__ == "__main__":
    sys.exit(main())

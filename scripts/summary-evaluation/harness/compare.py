"""Score real-model AI summary runs and compare variants. Offline, stdlib only.

A run is the JSON lines file written by the ignored test `a_real_model_evaluation_run`
(src-tauri/tests/model_engine.rs): a first line naming the build and model, then one line per
document. This tool never runs a model. Its checks are bounded: a fact counts as found when a
sentence matches an approved statement with located, current source evidence, or a reviewer
explicitly confirms a grounded candidate fact. Topic matches alone never earn credit. The screens for
wrong statements only flag sentences for that review; they never decide on their own.

  compare.py check                         validate the document set
  compare.py prepare --out DIR             write the run's input documents (<id>.json)
  compare.py score --run A.jsonl [--run B.jsonl ...] --out DIR [--review FILLED.csv]
  compare.py repeat --run A.jsonl --run B.jsonl   same build, same answers token for token?

The first run given is the baseline the others are compared with (see HARNESS.md).
"""
from __future__ import annotations

import argparse
import csv
import difflib
import hashlib
import json
import math
import random
import re
import statistics
import struct
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOCUMENTS = HERE / "documents"
FIXTURES = HERE.parent / "fixtures.json"
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
VERDICTS = {"", "correct", "wrong", "unsupported", "vague"}
REVIEW_SAMPLE = 0.2
MIN_OVERLAP = 20

NEGATION = re.compile(
    r"\b(no|not|never|none|without|denies|denied|negative|absent|nie|bez|brak|"
    r"ne|pas|sans|aucun|aucune|jamais|nao|sem|nunca|nenhum|nenhuma|sin|ningun|ninguna)\b|n't")
SECOND_PERSON = re.compile(r"\b(you|your|yours|vous|votre|vos|ty|twoj|twoja|pan|pani|voce|seu|sua|usted|su)\b")
ACTORS = re.compile(
    r"\b(dr|doctor|doctors|physician|specialist|cardiolog\w*|clinic|hospital|nurse|radiolog\w*|"
    r"lab|laboratory|medecin|specialiste|clinique|lekarz\w*|specjalist\w*|klinik\w*|medico|"
    r"medica|clinica|endocrinolog\w*)\b")
ADVICE = re.compile(
    r"\b(should|must|recommend\w*|consider\w*|advis\w*|normal|abnormal|good|bad|healthy|worry\w*|"
    r"concern\w*|serious|dangerous|devr\w*|devez|recommand\w*|anormal\w*|grave|powinien\w*|"
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


def quote_overlaps(quote, evidence):
    """Whether a sentence's quote covers a fact's source evidence: one holds the other, or they
    share a run of at least 20 folded characters (all of the shorter one, when it is shorter)."""
    a, b = fold(quote), fold(evidence)
    if not a or not b:
        return False
    if a in b or b in a:
        return True
    match = difflib.SequenceMatcher(None, a, b, autojunk=False).find_longest_match(0, len(a), 0, len(b))
    return match.size >= min(MIN_OVERLAP, len(a), len(b))


def guess_language(text):
    words = fold(text).replace("'", " ").split()
    scores = {lang: sum(word in stop for word in words) for lang, stop in STOPWORDS.items()}
    best = max(scores, key=scores.get)
    return best if scores[best] >= 2 else None


# --- Documents ----------------------------------------------------------------------------------

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=unique_object)


def check_document(doc):
    """Problems with one document, as text; empty when it is sound."""
    problems = []
    if doc.get("synthetic") is not True:
        problems.append("not marked synthetic")
    pages = doc.get("pages") or []
    if not pages or any(not isinstance(p.get("text"), str) for p in pages):
        problems.append("no pages")
    indexes = [p.get("index") for p in pages]
    if indexes != sorted(set(indexes)):
        problems.append("page indexes must rise")
    joined = normalized("\n".join(p.get("text", "") for p in pages))
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
        if not f.get("approved_statements"):
            problems.append(f"{where}: no approved statement")
        if not (f.get("match") or f.get("anchors")):
            problems.append(f"{where}: no match groups or anchors")
        check = f.get("quantity_check")
        if check and re.compile(check["pattern"]).groups != 2:
            problems.append(f"{where}: quantity check must capture value and unit")
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
    """Read a complete run without silently collapsing duplicate attempts."""
    lines = [json.loads(line, object_pairs_hook=unique_object) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
    if not lines or any(not isinstance(line, dict) for line in lines) or lines[0].get("kind") != "run":
        raise ValueError(f"{path}: the first line must name the run")
    entries = {}
    if sum(line.get("kind") == "run" for line in lines) != 1:
        raise ValueError(f"{path}: expected one run header")
    if sum(line.get("kind") == "end" for line in lines) != 1 or lines[-1].get("kind") != "end":
        raise ValueError(f"{path}: expected one terminal completion record")
    for line in lines[1:]:
        if line.get("kind") == "document":
            if not isinstance(line.get("id"), str) or not line["id"]:
                raise ValueError(f"{path}: invalid document ID")
            if line["id"] in entries:
                raise ValueError(f"{path}: duplicate document {line['id']}")
            entries[line["id"]] = line
        elif line.get("kind") != "end":
            raise ValueError(f"{path}: unknown record kind")
    if "answered" in lines[-1] and lines[-1]["answered"] != len(entries):
        raise ValueError(f"{path}: completion count differs from document records")
    meta = lines[0]
    for key in ("build", "model", "helperMemory"):
        if key in meta and not isinstance(meta[key], dict):
            raise ValueError(f"{path}: {key} must be an object")
    for name, item in [("run", meta), *entries.items()]:
        if "helperMemory" in item and not isinstance(item["helperMemory"], dict):
            raise ValueError(f"{name}: helperMemory must be an object")
        for key in ("peakKiB", "availableKiB"):
            value = item.get("helperMemory", {}).get(key)
            if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or value < 0):
                raise ValueError(f"{name}: helperMemory.{key} must be a nonnegative number")
    size = meta.get("model", {}).get("bytes", 0)
    if type(size) not in (int, float) or not math.isfinite(size) or size < 0:
        raise ValueError(f"{path}: model.bytes must be a nonnegative number")
    return meta, entries


def pages_sha256(pages):
    """The Rust writer's u32 index / u64 UTF-8 byte length / page bytes hash."""
    digest = hashlib.sha256()
    for page in pages:
        text = page["text"].encode("utf-8")
        digest.update(struct.pack("<IQ", page["index"], len(text)))
        digest.update(text)
    return digest.hexdigest()


def validate_sources(entries, docs, meta=None):
    for doc_id, entry in entries.items():
        if doc_id in docs and entry.get("pagesSha256") != pages_sha256(docs[doc_id]["pages"]):
            raise ValueError(f"{doc_id}: pagesSha256 differs from the current input")
        if doc_id in docs and meta is not None and "documents" in meta:
            declared = meta["documents"].get(doc_id) if isinstance(meta["documents"], dict) else None
            expected = dict(pagesSha256=pages_sha256(docs[doc_id]["pages"]), docLang=docs[doc_id]["lang"])
            if declared != expected:
                raise ValueError(f"{doc_id}: run input manifest differs from the current input")


def run_label(meta, path):
    return meta.get("variant") or Path(path).stem


# --- Scoring ------------------------------------------------------------------------------------

def fact_groups(fact):
    if fact.get("match"):
        return fact["match"]
    return [[anchor] for anchor in fact.get("anchors", [])]


def evidence_covers(fact, sentence, pages=None):
    quote = normalized(sentence.get("quote", "")).rstrip(".!?")
    evidence = normalized(fact["source_evidence"]).rstrip(".!?")
    if sentence.get("located") is not True or not quote or not evidence or evidence not in quote:
        return False
    return pages is None or quote in normalized(" ".join(p["text"] for p in pages))


def fact_matches(fact, sentences, pages=None):
    """All grounded associations; a later faithful occurrence can establish the fact."""
    approved = {normalized(text) for text in fact.get("approved_statements", [])}
    matches = []
    for index, sentence in enumerate(sentences):
        if not evidence_covers(fact, sentence, pages):
            continue
        if normalized(sentence["text"]) in approved:
            matches.append(("approved", index))
        elif all(any(fold(option) in fold(sentence["text"]) for option in group)
                 for group in fact_groups(fact)):
            matches.append(("candidate", index))
    return matches


def find_fact(fact, sentences, pages=None):
    matches = fact_matches(fact, sentences, pages)
    return next((match for match in matches if match[0] == "approved"),
                matches[0] if matches else (None, None))


def valid_answer(answer):
    return (isinstance(answer, dict) and isinstance(answer.get("sentences"), list)
            and bool(answer["sentences"])
            and all(isinstance(s, dict) and isinstance(s.get("text"), str) and bool(s["text"].strip())
                    and isinstance(s.get("quote"), str) and type(s.get("located")) is bool
                    for s in answer["sentences"])
            and ("stats" not in answer or isinstance(answer["stats"], dict)))


def screen(sentence, run_lang, facts):
    """Flags for the hand review: never verdicts."""
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
    if SECOND_PERSON.search(ftext) and ACTORS.search(fquote) and not ACTORS.search(ftext):
        flags.append("ACTOR_SHIFT")
    added = sorted({word for word in ADVICE.findall(ftext) if not re.search(rf"\b{re.escape(word)}\b", fquote)})
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
            # PR 295 allows the authored /l versus source /L alias, but not scale-prefix m/M folding.
            unit_key = lambda value: normalized(value).replace("/L", "/l")
            if value.replace(",", ".") != check["value"] or unit_key(unit) != unit_key(check["unit"]):
                flags.append(f"QUANTITY_MISMATCH:{fact['id']}")
    return flags


def score_document(doc, entry, run_lang, reviewed=None):
    """One document's scores in one run."""
    result = dict(id=doc["id"], present=entry is not None)
    if entry is None:
        return result
    answer = entry.get("result")
    raw_error = entry.get("error")
    error = raw_error if isinstance(raw_error, str) and raw_error else "MalformedError" if raw_error is not None else None
    if error:
        answer = None
    if not error and not valid_answer(answer):
        error, answer = "MalformedResult", None
    wall = entry.get("wallMs")
    if type(wall) not in (int, float) or not math.isfinite(wall) or wall < 0:
        error, answer = "MalformedWallTime", None
    result.update(wall_ms=entry.get("wallMs"), error=error,
                  timed_out=bool(error and re.search(r"time", error, re.IGNORECASE)))
    sentences = answer["sentences"] if answer else []
    facts = []
    for fact in doc.get("facts", []):
        matches = fact_matches(fact, sentences, doc["pages"])
        found, chosen, pending = None, None, False
        candidates = []
        for how, index in matches:
            row = (reviewed or {}).get(index, {})
            verdict = row.get("verdict")
            confirmed = row.get("confirmed_facts", "").strip()
            if how == "candidate":
                candidates.append(index)
                pending |= not verdict or (verdict == "correct" and not confirmed)
            if verdict in WRONG_VERDICTS or verdict == "vague":
                continue
            if how == "approved" or (verdict == "correct" and fact["id"] in confirmed.split()):
                found, chosen = ("approved" if how == "approved" else "reviewed"), index
        facts.append(dict(id=fact["id"], category=fact["category"], required=fact.get("required", True),
                          critical=fact.get("critical", False), found=found, sentence=chosen,
                          matches=[index for _, index in matches], candidates=candidates,
                          candidate=candidates[0] if candidates else None, pending=pending))
    required = [f for f in facts if f["required"]]
    actions = [f for f in required if f["category"] in ACTION_CATEGORIES]
    flagged = [dict(index=i, flags=screen(s, run_lang, doc.get("facts", []))) for i, s in enumerate(sentences)]
    for fact in facts:
        for index in fact["candidates"]:
            flagged[index]["flags"].append("FACT_REVIEW:" + fact["id"])
    stats = (answer or {}).get("stats") or {}
    last_index = max(p["index"] for p in doc["pages"])
    result.update(
        sentences=len(sentences),
        located=sum(1 for s in sentences if s.get("located")),
        facts=facts,
        required_found=sum(1 for f in required if f["found"]),
        required_total=len(required),
        action_found=sum(1 for f in actions if f["found"]),
        action_total=len(actions),
        pending_facts=sum(1 for f in facts if f["pending"]),
        pending_actions=sum(1 for f in actions if f["pending"]),
        flags=flagged,
        flag_count=sum(len(f["flags"]) for f in flagged),
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


def review_rows(label, meta, docs, entries, scores, seed_text, required_only=True):
    """Every flagged sentence, and a seeded fifth of the others."""
    rows = []
    for doc_id, score in scores.items():
        entry = entries.get(doc_id)
        if not entry or score.get("error") or not entry.get("result"):
            continue
        rng = random.Random(hashlib.sha256(f"{seed_text}:{doc_id}".encode()).hexdigest())
        selected = {f["index"] for f in score["flags"] if f["flags"] or rng.random() < REVIEW_SAMPLE}
        if not selected and score["flags"]:
            selected.add(rng.randrange(len(score["flags"])))
        for flagged, sentence in zip(score["flags"], entry["result"]["sentences"]):
            if required_only and flagged["index"] not in selected:
                continue
            candidates = [f["id"] for f in score["facts"] if flagged["index"] in f["matches"]]
            rows.append(dict(run=label, doc=doc_id, sentence=flagged["index"], text=sentence["text"],
                             quote=sentence.get("quote", ""), located=sentence.get("located"),
                             flags=" ".join(flagged["flags"]), facts=" ".join(candidates),
                             traps=" | ".join(docs[doc_id].get("traps", [])),
                             confirmed_facts="", verdict="", note=""))
            binding = dict(meta=meta, document=docs[doc_id], row=rows[-1])
            rows[-1]["review_id"] = hashlib.sha256(
                json.dumps(binding, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    return rows


def read_review(path):
    """Read rows without treating file existence, blank verdicts or duplicates as review."""
    verdicts = {}
    with open(path, newline="", encoding="utf-8") as source:
        reader = csv.DictReader(source)
        if reader.fieldnames and len(set(reader.fieldnames)) != len(reader.fieldnames):
            raise ValueError("duplicate review columns")
        for row in reader:
            if None in row:
                raise ValueError("review row has extra columns")
            verdict = (row.get("verdict") or "").strip().lower()
            if verdict not in VERDICTS:
                raise ValueError(f"unknown verdict {verdict!r} in {path}")
            key = (row["run"], row["doc"], int(row["sentence"]))
            if key in verdicts:
                raise ValueError(f"duplicate review row {key}")
            verdicts[key] = dict(row, verdict=verdict)
    return verdicts


def row_key(row):
    return row["run"], row["doc"], int(row["sentence"])


def validate_review(verdicts, current):
    for key, row in verdicts.items():
        if key not in current:
            raise ValueError(f"unknown review row {key}")
        for field in ("review_id", "text", "quote", "located", "flags", "facts", "traps"):
            expected = current[key][field]
            if row.get(field) != ("" if expected is None else str(expected)):
                raise ValueError(f"stale or unbound review row {key}: {field}")
        confirmed = (row.get("confirmed_facts") or "").strip()
        if confirmed and confirmed != "-" and not set(confirmed.split()) <= set(current[key]["facts"].split()):
            raise ValueError(f"unknown confirmed fact in review row {key}")


def export_review(out, rows):
    """Preserve completed work, but never leave a stale sheet as the only current export."""
    identities = [row["review_id"] for row in rows]
    digest = hashlib.sha256(json.dumps(identities).encode()).hexdigest()
    sheet = out / "review.csv"
    if sheet.exists():
        with sheet.open(newline="", encoding="utf-8") as source:
            same = [row.get("review_id") for row in csv.DictReader(source)] == identities
        if same:
            return sheet
        sheet = out / f"review-{digest[:16]}.csv"
    if not sheet.exists():
        with sheet.open("w", newline="", encoding="utf-8") as target:
            fields = ["run", "doc", "sentence", "text", "quote", "located", "flags", "facts", "traps",
                      "review_id", "confirmed_facts", "verdict", "note"]
            writer = csv.DictWriter(target, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)
    else:
        with sheet.open(newline="", encoding="utf-8") as source:
            if [row.get("review_id") for row in csv.DictReader(source)] != identities:
                raise ValueError(f"{sheet}: changed review export; refusing to overwrite")
    return sheet


def summarize_run(scores, wrong):
    present = [s for s in scores.values() if s.get("present") and not s.get("error")]
    sentences = sum(s["sentences"] for s in present)
    walls = [s["wall_ms"] for s in present if s.get("wall_ms") is not None]
    return dict(
        documents=len(scores), answered=len(present),
        failed=sum(1 for s in scores.values() if s.get("error")),
        timed_out=sum(1 for s in scores.values() if s.get("timed_out")),
        missing=sum(1 for s in scores.values() if not s.get("present")),
        required_found=sum(s["required_found"] for s in present),
        required_total=sum(s["required_total"] for s in present),
        action_found=sum(s["action_found"] for s in present),
        action_total=sum(s["action_total"] for s in present),
        pending_facts=sum(s["pending_facts"] for s in present),
        pending_actions=sum(s["pending_actions"] for s in present),
        located_pct=round(100 * sum(s["located"] for s in present) / sentences, 1) if sentences else None,
        sentences=sentences, flags=sum(s["flag_count"] for s in present),
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


def decide(base_scores, base_summary, scores, summary):
    """The written-down rule (HARNESS.md): PASS only if every check holds; PENDING while the
    hand review has not been filled in."""
    checks = []
    if summary["reviewed_wrong"]:
        checks.append(("no reviewed wrong statement", False))
    elif summary["reviewed_wrong"] is None or base_summary["reviewed_wrong"] is None:
        checks.append(("no reviewed wrong statement", None))
    else:
        checks.append(("no reviewed wrong statement", summary["reviewed_wrong"] == 0))
    lost, pending_lost = [], []
    for doc_id, base in base_scores.items():
        if not base.get("present") or base.get("error"):
            continue
        mine = scores.get(doc_id, {})
        kept = {f["id"] for f in mine.get("facts", []) if f["found"]}
        for fact in base["facts"]:
            if fact["required"] and fact["found"] and fact["id"] not in kept:
                pending = any(f["id"] == fact["id"] and f.get("pending") for f in mine.get("facts", []))
                (pending_lost if pending else lost).append(f"{doc_id}/{fact['id']}")
    checks.append((f"no must-have lost ({len(lost)} lost)", False if lost else None if pending_lost else True))
    gains = summary["action_found"] > base_summary["action_found"]
    if summary.get("pending_actions") or base_summary.get("pending_actions"):
        gains = None
    checks.append(("instructions/timing found on more", gains))
    if summary["located_pct"] is None or base_summary["located_pct"] is None:
        checks.append(("quotes found within 2 points", False))
    else:
        checks.append(("quotes found within 2 points", summary["located_pct"] >= base_summary["located_pct"] - 2))
    slower = (summary["median_wall_ms"] is None or base_summary["median_wall_ms"] is None
              or summary["median_wall_ms"] > 1.3 * base_summary["median_wall_ms"])
    new_failures = [d for d, base in base_scores.items() if base.get("present") and not base.get("error")
                    and (not scores.get(d, {}).get("present") or scores.get(d, {}).get("error"))]
    checks.append(("median time within 30%, no new failure", not slower and not new_failures))
    verdict = "FAIL" if any(ok is False for _, ok in checks) else "PENDING" if any(ok is None for _, ok in checks) else "PASS"
    return dict(verdict=verdict, checks=checks, lost=lost, new_failures=new_failures)


def table(labels, docs, all_scores, summaries, decisions, memories=()):
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
                action = f" · act {s['action_found']}/{s['action_total']}" if s["action_total"] else ""
                marks = ((" · capped" if s.get("capped") else "") + (" · cut" if s.get("cut") else "")
                         + (" · gap" if s.get("gap") else ""))
                cells.append(f"{s['required_found']}/{s['required_total']}{action} · {s['sentences']} s · "
                             f"{s['located']} q · {s['flag_count']} fl · {(s['wall_ms'] or 0) / 1000:.0f} s{marks}")
        lines.append(f"| {doc_id} | " + " | ".join(cells) + " |")
    lines.append("")
    lines.append("Cells: must-haves found/total · patient actions found/total · sentences · quotes found · flags · seconds"
                 " (capped: stopped at the token cap; cut: the end was not read; gap: the last page read after a gap).")
    lines.append("")
    lines.append("| Run | must-haves | actions | quotes found | flags | median s | capped | cut | gap | failed | reviewed wrong | verdict |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for label, summary, decision in zip(labels, summaries, decisions):
        wrong = "not reviewed" if summary["reviewed_wrong"] is None else summary["reviewed_wrong"]
        median = "" if summary["median_wall_ms"] is None else f"{summary['median_wall_ms'] / 1000:.0f}"
        lines.append(f"| {label} | {summary['required_found']}/{summary['required_total']} | "
                     f"{summary['action_found']}/{summary['action_total']} | {summary['located_pct']}% | "
                     f"{summary['flags']} | {median} | {summary['capped']} | {summary['cut']} | {summary['gap']} | "
                     f"{summary['failed']} | {wrong} | {decision['verdict'] if decision else 'baseline'} |")
    for label, decision in zip(labels, decisions):
        if decision:
            lines.append("")
            lines.append(f"{label}: " + "; ".join(f"{name}: {'yes' if ok else 'pending' if ok is None else 'NO'}"
                                                   for name, ok in decision["checks"]))
            if decision["lost"]:
                lines.append(f"  lost: {', '.join(decision['lost'])}")
    lines += memory_lines(labels, memories)
    return "\n".join(lines) + "\n"


def score(run_paths, out, docs, review=None):
    out = Path(out)
    verdicts = read_review(review) if review else {}
    labels, all_scores, summaries, metas, sheets, memories, runs = [], [], [], [], [], [], []
    current = {}
    for path in run_paths:
        meta, entries = read_run(path)
        validate_sources(entries, docs, meta)
        label = run_label(meta, path)
        if label in labels:
            raise ValueError(f"two runs are called {label}")
        labels.append(label)
        metas.append(meta)
        runs.append(entries)
        lang = meta.get("lang", "en")
        scores = {doc_id: score_document(doc, entries.get(doc_id), lang) for doc_id, doc in docs.items()}
        seed = meta.get("build", {}).get("fingerprint", "") + label
        sheets += review_rows(label, meta, docs, entries, scores, seed)
        for row in review_rows(label, meta, docs, entries, scores, seed, required_only=False):
            current[row_key(row)] = row
    if runs and set(docs) - runs[0].keys():
        raise ValueError("baseline does not cover the selected document set; declare a shared --only subset")
    validate_review(verdicts, current)
    for label, meta, entries in zip(labels, metas, runs):
        lang = meta.get("lang", "en")
        scores = {doc_id: score_document(doc, entries.get(doc_id), lang,
                  {index: row for (run, doc_name, index), row in verdicts.items()
                   if run == label and doc_name == doc_id}) for doc_id, doc in docs.items()}
        all_scores.append(scores)
        required = {row_key(row) for row in sheets if row["run"] == label}
        filled = {key for key, row in verdicts.items() if row["verdict"] and key[0] == label}
        wrong = sum(row["verdict"] in WRONG_VERDICTS for key, row in verdicts.items() if key[0] == label)
        pending_facts = any(score.get("pending_facts") for score in scores.values())
        reviewed_wrong = wrong if wrong else 0 if review and required <= filled and not pending_facts else None
        summaries.append(summarize_run(scores, reviewed_wrong))
        memories.append(memory(meta, entries))
    base_model = metas[0].get("model", {}).get("sha256")
    notes = [f"{label}: another model file" for label, meta in zip(labels, metas)
             if meta.get("model", {}).get("sha256") != base_model]
    decisions = [None] + [decide(all_scores[0], summaries[0], s, m) for s, m in zip(all_scores[1:], summaries[1:])]
    out.mkdir(parents=True, exist_ok=True)
    sheet = export_review(out, sheets)
    (out / "scores.json").write_text(json.dumps(dict(
        selected_documents=sorted(docs), review_sheet=str(sheet),
        runs=[dict(label=l, meta=m, summary=s, decision=d, memory=mem, documents=sc)
              for l, m, s, d, mem, sc in zip(labels, metas, summaries, decisions, memories, all_scores)],
        notes=notes), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (out / "compare.md").write_text(table(labels, docs, all_scores, summaries, decisions, memories)
                                    + f"\nCurrent review sheet: {sheet.name}\n"
                                    + "".join(f"\nNOTE: {n}\n" for n in notes), encoding="utf-8")
    return summaries, decisions


def repeat(first, second, docs=None, only=None):
    """Whether two runs of one build and model gave the same answers, token for token, on the
    documents both answered: (same, different, compared, problems)."""
    (meta_a, entries_a), (meta_b, entries_b) = read_run(first), read_run(second)
    docs = load_documents() if docs is None else docs
    if only is not None:
        if set(only) - docs.keys():
            raise ValueError("repeat --only names unknown inputs")
        docs = {name: docs[name] for name in only}
        entries_a = {name: entry for name, entry in entries_a.items() if name in docs}
        entries_b = {name: entry for name, entry in entries_b.items() if name in docs}
    for meta, entries in ((meta_a, entries_a), (meta_b, entries_b)):
        if set(entries) - docs.keys():
            raise ValueError("repeat contains document IDs outside the selected input set")
        validate_sources(entries, docs, meta)
    validators = {
        "build": lambda v: isinstance(v, dict) and isinstance(v.get("fingerprint"), str) and bool(v["fingerprint"].strip()),
        "threads": lambda v: type(v) is int and v > 0,
        **{key: lambda v: isinstance(v, str) and bool(v.strip())
           for key in ("lang", "commit", "runnerSha256", "harnessSha256")},
    }
    problems = [key for key, valid in validators.items()
                if not valid(meta_a.get(key)) or not valid(meta_b.get(key)) or meta_a[key] != meta_b[key]]
    for key in ("sha256", "chatFormat"):
        values = [meta.get("model", {}).get(key) for meta in (meta_a, meta_b)]
        if not all(isinstance(v, str) and v.strip() for v in values) or values[0] != values[1]:
            problems.append("model" if key == "sha256" else "model.chatFormat")
    if entries_a.keys() != entries_b.keys():
        problems.append("coverage: first-only=" + ",".join(sorted(entries_a.keys() - entries_b.keys()))
                        + "; second-only=" + ",".join(sorted(entries_b.keys() - entries_a.keys())))
    if entries_a.keys() != docs.keys() or entries_b.keys() != docs.keys():
        problems.append(f"coverage: selected={len(docs)}, first={len(entries_a)}, second={len(entries_b)}")
    same, different = [], []
    for doc_id in sorted(set(entries_a) & set(entries_b)):
        entries = (entries_a[doc_id], entries_b[doc_id])
        answers = [e.get("result") for e in entries]
        valid = all(e.get("error") is None and valid_answer(a) for e, a in zip(entries, answers))
        hashes = [a.get("stats", {}).get("answerHash") for a in answers] if valid else []
        valid = valid and all(type(h) is int and 0 <= h < 2**64 for h in hashes)
        valid = valid and answers[0]["sentences"] == answers[1]["sentences"] and hashes[0] == hashes[1]
        (same if valid else different).append(doc_id)
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
    sc.add_argument("--only", action="append", help="explicit shared document subset")
    rep = sub.add_parser("repeat")
    rep.add_argument("--run", action="append", required=True)
    rep.add_argument("--only", action="append", help="explicit shared repeat subset")
    args = parser.parse_args(argv)
    if args.command == "repeat":
        if len(args.run) != 2:
            raise SystemExit("repeat compares exactly two runs")
        same, different, compared, problems = repeat(*args.run, docs=load_documents(args.documents, args.fixtures),
                                                     only=args.only)
        print(json.dumps(dict(compared=compared, same=same, different=different, not_comparable=problems)))
        return 0 if compared and not different and not problems else 1
    docs = load_documents(args.documents, args.fixtures)
    if getattr(args, "only", None):
        unknown = set(args.only) - set(docs)
        if unknown:
            raise SystemExit(f"unknown ids: {', '.join(sorted(unknown))}")
        docs = {k: v for k, v in docs.items() if k in args.only}
    if args.command == "check":
        problems = {doc_id: check_document(doc) for doc_id, doc in docs.items()}
        bad = {doc_id: p for doc_id, p in problems.items() if p}
        for doc_id, p in bad.items():
            print(f"{doc_id}: " + "; ".join(p))
        print(f"{len(docs)} documents, {sum(len(d.get('facts', [])) for d in docs.values())} facts, "
              f"{len(bad)} with problems")
        return 1 if bad else 0
    if args.command == "prepare":
        print(f"{prepare(args.out, docs)} documents written to {args.out}")
        return 0
    summaries, decisions = score(args.run, args.out, docs, args.review)
    for summary, decision in zip(summaries, decisions):
        print(json.dumps(dict(summary=summary, verdict=decision["verdict"] if decision else "baseline")))
    return 0


if __name__ == "__main__":
    sys.exit(main())

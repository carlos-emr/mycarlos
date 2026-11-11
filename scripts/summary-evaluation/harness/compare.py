"""Score real-model AI summary runs and compare variants. Offline, stdlib only.

A run is the JSON lines file written by the ignored test `a_real_model_evaluation_run`
(src-tauri/tests/model_engine.rs): a first line naming the build and model, then one line per
document. This tool never runs a model. Its checks are bounded: a fact counts as found when a
sentence matches one of its approved statements, or names it (its `match` groups) with a quote
that covers its source evidence; anything else is left to the hand review sheet. The screens for
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
import random
import re
import statistics
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

def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


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

def fact_groups(fact):
    if fact.get("match"):
        return fact["match"]
    return [fact.get("anchors", [])]


def find_fact(fact, sentences):
    """(how, sentence index) for the first sentence that carries `fact`, else (None, None)."""
    approved = {normalized(text) for text in fact.get("approved_statements", [])}
    for index, sentence in enumerate(sentences):
        if normalized(sentence["text"]) in approved:
            return "approved", index
    for index, sentence in enumerate(sentences):
        text = fold(sentence["text"])
        named = all(any(fold(option) in text for option in group) for group in fact_groups(fact))
        if named and quote_overlaps(sentence.get("quote", ""), fact["source_evidence"]):
            return "matched", index
    return None, None


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
            if value.replace(",", ".") != check["value"] or fold(unit) != fold(check["unit"]):
                flags.append(f"QUANTITY_MISMATCH:{fact['id']}")
    return flags


def score_document(doc, entry, run_lang):
    """One document's scores in one run."""
    result = dict(id=doc["id"], present=entry is not None)
    if entry is None:
        return result
    answer = entry.get("result")
    error = entry.get("error")
    result.update(wall_ms=entry.get("wallMs"), error=error,
                  timed_out=bool(error and re.search(r"time", error, re.IGNORECASE)))
    sentences = answer["sentences"] if answer else []
    facts = []
    for fact in doc.get("facts", []):
        how, index = find_fact(fact, sentences)
        facts.append(dict(id=fact["id"], category=fact["category"], required=fact.get("required", True),
                          critical=fact.get("critical", False), found=how, sentence=index))
    required = [f for f in facts if f["required"]]
    actions = [f for f in required if f["category"] in ACTION_CATEGORIES]
    flagged = [dict(index=i, flags=screen(s, run_lang, doc.get("facts", []))) for i, s in enumerate(sentences)]
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


def review_rows(label, meta, docs, entries, scores, seed_text):
    """Every flagged sentence, and a seeded fifth of the others."""
    rows = []
    for doc_id, score in scores.items():
        entry = entries.get(doc_id)
        if not entry or not entry.get("result"):
            continue
        rng = random.Random(hashlib.sha256(f"{seed_text}:{doc_id}".encode()).hexdigest())
        for flagged, sentence in zip(score["flags"], entry["result"]["sentences"]):
            if not flagged["flags"] and rng.random() >= REVIEW_SAMPLE:
                continue
            candidates = [f["id"] for f in score["facts"] if f["sentence"] == flagged["index"]]
            rows.append(dict(run=label, doc=doc_id, sentence=flagged["index"], text=sentence["text"],
                             quote=sentence.get("quote", ""), located=sentence.get("located"),
                             flags=" ".join(flagged["flags"]), facts=" ".join(candidates),
                             traps=" | ".join(docs[doc_id].get("traps", [])), verdict="", note=""))
    return rows


def read_review(path):
    """Filled review sheets: (run, doc, sentence) -> verdict."""
    verdicts = {}
    with open(path, newline="", encoding="utf-8") as source:
        for row in csv.DictReader(source):
            verdict = (row.get("verdict") or "").strip().lower()
            if verdict not in VERDICTS:
                raise ValueError(f"unknown verdict {verdict!r} in {path}")
            verdicts[(row["run"], row["doc"], int(row["sentence"]))] = verdict
    return verdicts


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
    if summary["reviewed_wrong"] is None:
        checks.append(("no reviewed wrong statement", None))
    else:
        checks.append(("no reviewed wrong statement", summary["reviewed_wrong"] == 0))
    lost = []
    for doc_id, base in base_scores.items():
        if not base.get("present") or base.get("error"):
            continue
        mine = scores.get(doc_id, {})
        kept = {f["id"] for f in mine.get("facts", []) if f["found"]}
        lost += [f"{doc_id}/{f['id']}" for f in base["facts"] if f["required"] and f["found"] and f["id"] not in kept]
    checks.append((f"no must-have lost ({len(lost)} lost)", not lost))
    checks.append(("instructions/timing found on more", summary["action_found"] > base_summary["action_found"]))
    if summary["located_pct"] is None or base_summary["located_pct"] is None:
        checks.append(("quotes found within 2 points", False))
    else:
        checks.append(("quotes found within 2 points", summary["located_pct"] >= base_summary["located_pct"] - 2))
    slower = (summary["median_wall_ms"] is None or base_summary["median_wall_ms"] is None
              or summary["median_wall_ms"] > 1.3 * base_summary["median_wall_ms"])
    new_failures = [d for d, s in scores.items() if s.get("error") and not base_scores.get(d, {}).get("error")]
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
    out.mkdir(parents=True, exist_ok=True)
    verdicts = read_review(review) if review else None
    labels, all_scores, summaries, metas, sheets, memories = [], [], [], [], [], []
    for path in run_paths:
        meta, entries = read_run(path)
        label = run_label(meta, path)
        if label in labels:
            raise ValueError(f"two runs are called {label}")
        labels.append(label)
        metas.append(meta)
        lang = meta.get("lang", "en")
        scores = {doc_id: score_document(doc, entries.get(doc_id), lang) for doc_id, doc in docs.items()}
        all_scores.append(scores)
        wrong = None
        if verdicts is not None:
            wrong = sum(1 for (run, _, _), verdict in verdicts.items() if run == label and verdict in WRONG_VERDICTS)
        summaries.append(summarize_run(scores, wrong))
        memories.append(memory(meta, entries))
        seed = meta.get("build", {}).get("fingerprint", "") + label
        sheets += review_rows(label, meta, docs, entries, scores, seed)
    base_model = metas[0].get("model", {}).get("sha256")
    notes = [f"{label}: another model file" for label, meta in zip(labels, metas)
             if meta.get("model", {}).get("sha256") != base_model]
    decisions = [None] + [decide(all_scores[0], summaries[0], s, m) for s, m in zip(all_scores[1:], summaries[1:])]
    (out / "scores.json").write_text(json.dumps(dict(
        runs=[dict(label=l, meta=m, summary=s, decision=d, memory=mem, documents=sc)
              for l, m, s, d, mem, sc in zip(labels, metas, summaries, decisions, memories, all_scores)],
        notes=notes), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    sheet = out / "review.csv"
    if not sheet.exists():
        with sheet.open("w", newline="", encoding="utf-8") as target:
            writer = csv.DictWriter(target, fieldnames=["run", "doc", "sentence", "text", "quote", "located",
                                                        "flags", "facts", "traps", "verdict", "note"])
            writer.writeheader()
            writer.writerows(sheets)
    (out / "compare.md").write_text(table(labels, docs, all_scores, summaries, decisions, memories)
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
    rep = sub.add_parser("repeat")
    rep.add_argument("--run", action="append", required=True)
    args = parser.parse_args(argv)
    if args.command == "repeat":
        if len(args.run) != 2:
            raise SystemExit("repeat compares exactly two runs")
        same, different, compared, problems = repeat(*args.run)
        print(json.dumps(dict(compared=compared, same=same, different=different, not_comparable=problems)))
        return 0 if compared and not different and not problems else 1
    docs = load_documents(args.documents, args.fixtures)
    if args.command == "check":
        problems = {doc_id: check_document(doc) for doc_id, doc in docs.items()}
        bad = {doc_id: p for doc_id, p in problems.items() if p}
        for doc_id, p in bad.items():
            print(f"{doc_id}: " + "; ".join(p))
        print(f"{len(docs)} documents, {sum(len(d.get('facts', [])) for d in docs.values())} facts, "
              f"{len(bad)} with problems")
        return 1 if bad else 0
    if args.command == "prepare":
        if args.only:
            unknown = set(args.only) - set(docs)
            if unknown:
                raise SystemExit(f"unknown ids: {', '.join(sorted(unknown))}")
            docs = {k: v for k, v in docs.items() if k in args.only}
        print(f"{prepare(args.out, docs)} documents written to {args.out}")
        return 0
    summaries, decisions = score(args.run, args.out, docs, args.review)
    for summary, decision in zip(summaries, decisions):
        print(json.dumps(dict(summary=summary, verdict=decision["verdict"] if decision else "baseline")))
    return 0


if __name__ == "__main__":
    sys.exit(main())

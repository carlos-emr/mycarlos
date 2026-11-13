"""Offline, closed-fixture regression checks, never clinical certification.

Approved statements are finite, human-authored examples, not an entailment model.
Unknown paraphrases require human review; they are not automatically hallucinations
or omissions. A present quote alone never verifies an unreviewed statement.
"""
from __future__ import annotations

import argparse
from collections import Counter
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re
import sys
import unicodedata

HERE = Path(__file__).resolve().parent
MAX_INPUT_BYTES = 4 * 1024 * 1024


def normalized(text):
    # Preserve numeric units/superscripts, negation and punctuation. In particular,
    # NFKC would collapse clinical 10⁹/L to 109/L and is intentionally not used.
    # Case is meaningful in units: mg and Mg must never share approval. New
    # capitalization/paraphrase variants stay reviewable instead of broad folding.
    return " ".join(unicodedata.normalize("NFC", text).replace("’", "'").split())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"Duplicate JSON field: {key}")
        value[key] = item
    return value


def read_json(path, with_hash=False):
    with path.open("rb") as source:
        data = source.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        raise ValueError("Input exceeds the bounded evaluation file size")
    value = json.loads(data, object_pairs_hook=unique_object)
    return (value, sha(data)) if with_hash else value


def fixture_cases(path, with_hash=False):
    payload, source_hash = read_json(path, with_hash=True)
    if payload.get("version") != 1 or payload.get("synthetic_only") is not True:
        raise ValueError("Only version-1 synthetic evaluation fixtures are supported")
    cases = payload["cases"]
    ids = set()
    families = {}
    for case in cases:
        if case["case_id"] in ids or case["synthetic"] is not True:
            raise ValueError("Duplicate or non-synthetic fixture")
        ids.add(case["case_id"])
        if case["language"] not in {"en", "fr"}:
            raise ValueError("Only the declared EN/FR scope is supported")
        if sha(case["document_text"].encode()) != case["document_sha256"]:
            raise ValueError("Document changed without a new source binding")
        if "\n".join(p["text"] for p in case["pages"]) != case["document_text"]:
            raise ValueError("Page text and document text disagree")
        families.setdefault(case["family"], set()).add(case["split"])
        statements, facts = {}, set()
        for fact in case["facts"]:
            if fact["id"] in facts or not fact["source_evidence"]:
                raise ValueError("Invalid fact identity/evidence")
            facts.add(fact["id"])
            if fact["source_evidence"] not in case["document_text"]:
                raise ValueError("Gold evidence is absent from source")
            if not fact["approved_statements"] or not fact["anchors"]:
                raise ValueError("A fact requires reviewed statements and diagnostic anchors")
            for text in fact["approved_statements"]:
                key = normalized(text)
                if key in statements and statements[key] != fact["id"]:
                    raise ValueError("Approved statement is ambiguous between facts")
                statements[key] = fact["id"]
            if fact.get("quantity_check"):
                check = fact["quantity_check"]
                if re.compile(check["pattern"]).groups != 2:
                    raise ValueError("Quantity check must capture value and unit")
                Decimal(check["value"])
    if any(len(splits) != 1 for splits in families.values()):
        raise ValueError("Template family leaks across development/holdout")
    return (cases, source_hash) if with_hash else cases


def quote_provenance(quote, pages):
    """Conservative lexical source check, distinct from support of a statement.

    Ellipsis parts must be substantial and occur in order on one page; merely
    finding two unrelated words anywhere in the document does not earn a link.
    """
    parts = [normalized(p).strip() for p in re.split(r"\.\.\.|…", quote)]
    if not parts or any(not p or (len(p) < 12 and len(re.findall(r"\w+", p)) < 3)
                        for p in parts):
        return dict(present=False, reason="empty_or_unsubstantial_quote", page=None, parts=parts)
    for page in pages:
        source = normalized(page["text"])
        cursor = 0
        for part in parts:
            found = source.find(part, cursor)
            if found < 0:
                break
            cursor = found + len(part)
        else:
            return dict(present=True, reason="ordered_source_quote", page=page["index"], parts=parts)
    return dict(present=False, reason="quote_absent_or_out_of_order", page=None, parts=parts)


def diagnostic_quantity(text, facts):
    """Fixture-scoped value+unit pairing, not a general medication parser."""
    signals = []
    for fact in facts:
        check = fact.get("quantity_check")
        if not check:
            continue
        for found in re.finditer(check["pattern"], normalized(text), re.IGNORECASE):
            value, unit = found.groups()
            # The authored fixture uses /l in diagnostics, while its source uses
            # /L. Preserve case in scale prefixes (m/M), unlike that literal alias.
            unit_key = lambda s: normalized(s).replace("/L", "/l")
            if Decimal(value.replace(",", ".")) != Decimal(check["value"]) or unit_key(unit) != unit_key(check["unit"]):
                signals.append(dict(code="QUANTITY_MISMATCH", fact_id=fact["id"],
                    observed_value=value, observed_unit=unit,
                    expected_value=check["value"], expected_unit=check["unit"],
                    scope="Explicit fixture concept/value/unit pairing only"))
    return signals


def evaluate_case(case, prediction, output_format="native"):
    if output_format not in {"native", "legacy"}:
        raise ValueError("Format must be explicitly native or legacy")
    issues, statements, verified, mentioned = [], [], set(), set()
    required = [f for f in case["facts"] if f["required"]]
    lookup = {normalized(text): f for f in case["facts"] for text in f["approved_statements"]}
    sentence_list = prediction.get("sentences") if isinstance(prediction, dict) else None
    valid_shape = (isinstance(prediction, dict) and prediction.get("case_id") == case["case_id"]
        and prediction.get("language") == case["language"]
        and prediction.get("document_sha256") == case["document_sha256"]
        and isinstance(sentence_list, list) and 1 <= len(sentence_list) <= 8)
    if not valid_shape:
        issues.append(dict(code="INVALID_OR_MISSING_OUTPUT",
                           detail="Expected matching case/language/document SHA256 and 1–8 sentences"))
        sentence_list = []
    key = "quote" if output_format == "native" else "source"
    for index, sentence in enumerate(sentence_list):
        if (not isinstance(sentence, dict) or set(sentence) != {"text", key}
            or not all(isinstance(sentence[k], str) and sentence[k].strip()
                       and len(sentence[k]) <= 2000 for k in ["text", key])):
            issues.append(dict(code="INVALID_SENTENCE", sentence=index,
                detail=f"Explicit {output_format} format requires bounded text/{key} only"))
            continue
        text = sentence["text"]
        provenance = quote_provenance(sentence[key], case["pages"])
        fact = lookup.get(normalized(text))
        candidate_facts = [f for f in case["facts"] if any(
            normalized(anchor).lower() in normalized(text).lower() for anchor in f["anchors"])]
        row = dict(index=index, text=text, quote=sentence[key],
            quote_present_in_source=provenance["present"], quote_check=provenance,
            reviewed_statement_match=fact["id"] if fact else None,
            candidate_fact_ids=[f["id"] for f in candidate_facts],
            expected_attributes=[dict(fact_id=f["id"], **f["expected_attributes"]) for f in candidate_facts])
        if not provenance["present"]:
            issues.append(dict(code="SOURCE_QUOTE_NOT_VERIFIED", sentence=index,
                               detail=provenance["reason"]))
        if fact is None:
            # Exact approved text is a narrow lower-bound check. A new paraphrase
            # may be correct, wrong, or invented; only human review can decide.
            issues.append(dict(code="UNREVIEWED_STATEMENT", sentence=index,
                candidate_fact_ids=row["candidate_fact_ids"],
                detail="Not a reviewed fixture statement; human semantic review required"))
            row["human_review_required"] = True
            row["quantity_signals"] = diagnostic_quantity(text, case["facts"])
            issues.extend(dict(signal, sentence=index) for signal in row["quantity_signals"])
            if any(normalized(approved) in normalized(text)
                   for f in case["facts"] for approved in f["approved_statements"]):
                issues.append(dict(code="APPENDED_OR_COMBINED_CONTENT", sentence=index,
                    detail="Reviewed wording plus additional content cannot inherit its approval"))
        else:
            if fact["id"] in mentioned:
                issues.append(dict(code="DUPLICATE_FACT", sentence=index, fact_id=fact["id"]))
            mentioned.add(fact["id"])
            # A quote elsewhere in the document is not the fact's evidence.
            evidence_covered = provenance["present"] and any(
                normalized(fact["source_evidence"]) in part for part in provenance["parts"])
            row["quote_covers_gold_evidence"] = evidence_covered
            if evidence_covered:
                verified.add(fact["id"])
            else:
                issues.append(dict(code="QUOTE_NOT_FACT_EVIDENCE", sentence=index, fact_id=fact["id"],
                    detail="Quote may be present, but does not cover this fact's labelled source evidence"))
        statements.append(row)
    has_unknown = any(i["code"] == "UNREVIEWED_STATEMENT" for i in issues)
    facts = []
    for fact in required:
        status = ("recognized_with_gold_evidence" if fact["id"] in verified else
                  "recognized_without_gold_evidence" if fact["id"] in mentioned else
                  "not_verified_needs_semantic_review" if has_unknown else "omitted_from_recognized_output")
        facts.append(dict(id=fact["id"], category=fact["category"], critical=fact["critical"],
                          status=status, expected_attributes=fact["expected_attributes"]))
        if fact["id"] not in verified:
            code = ("OMITTED_REQUIRED_FACT" if status == "omitted_from_recognized_output"
                    else "REQUIRED_FACT_NOT_VERIFIED")
            issues.append(dict(code=code, fact_id=fact["id"], category=fact["category"],
                               detail=status))
    return dict(case_id=case["case_id"], language=case["language"], family=case["family"],
        split=case["split"], document_sha256=case["document_sha256"],
        status="flags_require_review" if issues else "bounded_checks_clear",
        clinical_validity="not_established", human_clinical_review_required=True,
        required_facts=len(required), recognized_facts_with_gold_evidence=len(verified),
        statements=statements, facts=facts, issues=issues)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, default=HERE / "fixtures.json")
    parser.add_argument("--predictions", type=Path, required=True,
                        help="JSON object with a predictions list, one candidate only")
    parser.add_argument("--format", choices=["native", "legacy"], required=True)
    parser.add_argument("--case", action="append", default=[], help="Declare selected case IDs explicitly")
    parser.add_argument("--output", type=Path, required=True, help="New report file; never overwrites")
    args = parser.parse_args()
    try:
        cases, fixtures_hash = fixture_cases(args.fixtures, with_hash=True)
        selected = set(args.case) if args.case else {c["case_id"] for c in cases}
        if not selected <= {c["case_id"] for c in cases}:
            raise ValueError("Unknown selected case")
        incoming, predictions_hash = read_json(args.predictions, with_hash=True)
        predictions = incoming["predictions"]
        indexed = {}
        for row in predictions:
            if not isinstance(row, dict) or row.get("case_id") not in selected or row["case_id"] in indexed:
                raise ValueError("Unknown, duplicate or unselected prediction case")
            indexed[row["case_id"]] = row
        results = [evaluate_case(c, indexed.get(c["case_id"]), args.format)
                   for c in cases if c["case_id"] in selected]
        report = dict(schema_version=1, scope="Bounded synthetic regression aids; not clinical certification",
            fixtures_sha256=fixtures_hash, predictions_sha256=predictions_hash,
            scorer_sha256=sha(Path(__file__).read_bytes()), output_format=args.format,
            selected_case_ids=sorted(selected), missing_case_ids=sorted(selected - set(indexed)),
            cases=len(results), bilingual_family_clusters=len({r["family"] for r in results}),
            status_counts=dict(Counter(r["status"] for r in results)),
            issue_counts=dict(Counter(i["code"] for r in results for i in r["issues"])),
            clinical_validity="not_established", human_clinical_review_required=True, results=results,
            limits=["Only finite reviewed statements earn automatic fact evidence recognition.",
                "Unknown paraphrases require semantic review; not automatically wrong or omitted.",
                "Quantity pairing is fixture-scoped; quote presence is not entailment.",
                "No detector, medical NLP package, model, network or real patient data is used."])
        with args.output.open("x", encoding="utf8") as output:
            json.dump(report, output, ensure_ascii=False, indent=2)
            output.write("\n")
        print(json.dumps({k: report[k] for k in ["cases", "status_counts", "issue_counts", "clinical_validity"]}))
        return 1 if any(r["issues"] for r in results) else 0
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(f"Evaluation input rejected: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

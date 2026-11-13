"""Invented evidence counterexamples, independent of model or held-out outputs."""
import copy
import csv
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import compare


def page_hash(pages):
    digest = hashlib.sha256()
    for page in pages:
        text = page["text"].encode("utf-8")
        digest.update(struct.pack("<IQ", page["index"], len(text)))
        digest.update(text)
    return digest.hexdigest()


def document(doc_id="invented-cards"):
    texts = ["The card number is 4.", "Keep the blue card.", "Keep the green card."]
    return dict(id=doc_id, lang="en", synthetic=True, title="Invented cards", traps=[],
                pages=[dict(index=0, text="FAKE. " + " ".join(texts))], facts=[
                    dict(id=str(i), category="finding" if i == 0 else "instruction",
                         required=True, source_evidence=text, approved_statements=[text],
                         match=[["number", "4"]] if i == 0 else [[color], ["card"]],
                         expected_attributes={})
                    for i, (text, color) in enumerate(zip(texts, ["", "blue", "green"]))])


def sentence(text, quote):
    return dict(text=text, quote=quote, located=True)


def records(label, doc, better=False):
    sentences = [sentence("The card number is 4.", "The card number is 4.")]
    if better:
        sentences += [sentence("Please keep the blue card.", "Keep the blue card."),
                      sentence("Please keep the green card.", "Keep the green card.")]
    return [dict(kind="run", variant=label, lang="en", threads=3, commit="invented-revision",
                 build=dict(fingerprint="f" * 64), model=dict(sha256="a" * 64, chatFormat="builtin")),
            dict(kind="document", id=doc["id"], pagesSha256=page_hash(doc["pages"]), wallMs=1000,
                 result=dict(sentences=sentences, lastPage=0, lastPageCut=False,
                             stats=dict(answerHash=1))), dict(kind="end", answered=1)]


class IntegrityTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.doc = document()
        self.docs = {self.doc["id"]: self.doc}
        self.base = records("B0", self.doc)
        self.variant = records("V1", self.doc, True)

    def write(self, name, lines):
        path = self.root / name
        path.write_text("".join(json.dumps(line) + "\n" for line in lines))
        return path

    def score(self, review=None, out="out"):
        return compare.score([self.write("base.jsonl", self.base),
                              self.write("variant.jsonl", self.variant)],
                             self.root / out, self.docs, review)

    def sheet(self, mutate=lambda rows: rows):
        self.score(out="blank")
        with (self.root / "blank/review.csv").open() as source:
            reader = csv.DictReader(source)
            fields = reader.fieldnames
            rows = list(reader)
        for row in rows:
            row["verdict"] = "correct"
            row["confirmed_facts"] = row["facts"] or "-"
        rows = mutate(rows)
        path = self.root / "filled.csv"
        with path.open("w", newline="") as target:
            writer = csv.DictWriter(target, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)
        return path

    def test_header_only_review_cannot_pass(self):
        path = self.root / "empty.csv"
        path.write_text("run,doc,sentence,verdict\n")
        self.assertEqual(self.score(path)[1][1]["verdict"], "PENDING")

    def test_generated_unfilled_review_cannot_pass(self):
        self.score(out="blank")
        self.assertEqual(self.score(self.root / "blank/review.csv")[1][1]["verdict"], "PENDING")

    def test_partial_review_stays_pending(self):
        sheet = self.sheet(lambda rows: rows[:-1])
        self.assertEqual(self.score(sheet)[1][1]["verdict"], "PENDING")

    def test_complete_current_review_can_pass(self):
        self.assertEqual(self.score(self.sheet())[1][1]["verdict"], "PASS")

    def test_sentence_correct_alone_does_not_confirm_topical_fact_credit(self):
        sheet = self.sheet(lambda rows: [dict(row, confirmed_facts="") for row in rows])
        summaries, decisions = self.score(sheet)
        self.assertEqual(summaries[1]["action_found"], 0)
        self.assertEqual(decisions[1]["verdict"], "PENDING")

    def test_reviewer_can_explicitly_decline_candidate_facts(self):
        sheet = self.sheet(lambda rows: [dict(row, confirmed_facts="-") for row in rows])
        summaries, decisions = self.score(sheet)
        self.assertEqual(summaries[1]["action_found"], 0)
        self.assertEqual(decisions[1]["verdict"], "FAIL")

    def test_review_cannot_confirm_an_unknown_fact(self):
        sheet = self.sheet(lambda rows: [dict(row, confirmed_facts="unknown-fact") for row in rows])
        with self.assertRaises(ValueError):
            self.score(sheet)

    def test_stale_review_text_is_not_reused(self):
        sheet = self.sheet()
        self.variant[1]["result"]["sentences"][1]["text"] = "Stop keeping the blue card."
        with self.assertRaises(ValueError):
            self.score(sheet)

    def test_duplicate_review_rows_are_not_last_writer_wins(self):
        sheet = self.sheet(lambda rows: rows + [dict(rows[-1], verdict="wrong")])
        with self.assertRaises(ValueError):
            self.score(sheet)

    def test_unknown_review_identity_is_rejected(self):
        sheet = self.sheet(lambda rows: [dict(row, run="another-run") for row in rows])
        with self.assertRaises(ValueError):
            self.score(sheet)

    def test_duplicate_csv_columns_cannot_hide_a_wrong_verdict(self):
        path = self.root / "duplicate.csv"
        path.write_text("run,doc,sentence,verdict,verdict\nV1,invented-cards,1,wrong,correct\n")
        with self.assertRaises(ValueError):
            self.score(path)

    def test_nonrequired_candidate_is_not_silently_marked_reviewed(self):
        self.doc["facts"][1]["required"] = False
        sheet = self.sheet(lambda rows: [dict(row, confirmed_facts="") for row in rows])
        self.assertEqual(self.score(sheet)[1][1]["verdict"], "PENDING")

    def test_changed_export_preserves_completed_sheet_and_writes_a_new_version(self):
        self.score()
        original = self.root / "out/review.csv"
        original.write_bytes(self.sheet().read_bytes())
        before = original.read_bytes()
        self.variant[1]["result"]["sentences"][1]["text"] = "Please preserve the blue card."
        self.score()
        self.assertEqual(original.read_bytes(), before)
        self.assertGreater(len(list((self.root / "out").glob("review*.csv"))), 1)

    def test_unknown_action_is_a_review_candidate_not_verified_credit(self):
        self.variant[1]["result"]["sentences"][1]["text"] = "Stop keeping the blue card."
        score = compare.score_document(self.doc, self.variant[1], "en")
        self.assertEqual(score["action_found"], 0)
        self.assertTrue(any("FACT_REVIEW" in flag for row in score["flags"] for flag in row["flags"]))

    def test_approved_words_need_located_evidence_for_the_fact(self):
        fact = self.doc["facts"][1]
        self.assertEqual(compare.find_fact(fact, [sentence("Keep the blue card.", "The card number is 4.")]),
                         (None, None))
        unlocated = dict(sentence("Keep the blue card.", "Keep the blue card."), located=False)
        self.assertEqual(compare.find_fact(fact, [unlocated]), (None, None))

    def test_short_common_quote_cannot_ground_an_approved_fact(self):
        self.assertEqual(compare.find_fact(self.doc["facts"][1], [sentence("Keep the blue card.", "the")]),
                         (None, None))

    def test_anchors_are_all_required_not_one_any_of_group(self):
        fact = dict(self.doc["facts"][1], match=None, anchors=["blue", "folder"])
        self.assertEqual(compare.find_fact(fact, [sentence("Please keep the blue card.", "Keep the blue card.")]),
                         (None, None))

    def test_direction_frequency_and_unit_variants_do_not_earn_silent_credit(self):
        fact = dict(id="marker", category="instruction", required=True,
                    source_evidence="The marker was lowered to 2.5 mg once daily.",
                    approved_statements=["The marker was lowered to 2.5 mg once daily."],
                    match=[["marker"], ["2.5"]],
                    expected_attributes=dict(status="lowered", frequency="once daily"),
                    quantity_check=dict(pattern=r"marker\D{0,40}(\d+(?:[.,]\d+)?)\s*(mg)", value="2.5", unit="mg"))
        doc = dict(self.doc, facts=[fact], pages=[dict(index=0, text="FAKE. " + fact["source_evidence"])])
        for text in ["The marker was increased to 2.5 mg once daily.",
                     "The marker was lowered to 2.5 mg twice daily.",
                     "The marker was lowered to 2.5 Mg once daily."]:
            with self.subTest(text=text):
                entry = copy.deepcopy(self.variant[1])
                entry["result"]["sentences"] = [sentence(text, fact["source_evidence"])]
                score = compare.score_document(doc, entry, "en")
                self.assertEqual(score["action_found"], 0)
        flags = compare.screen(sentence("Marker 2.5 Mg.", "Marker 2.5 mg."), "en", [fact])
        self.assertIn("QUANTITY_MISMATCH:marker", flags)

    def test_a_missing_baseline_answer_without_facts_is_a_failure(self):
        other = dict(self.doc, id="other", facts=[])
        self.docs["other"] = other
        extra = copy.deepcopy(records("B0", other)[1])
        self.base.insert(-1, extra)
        self.base[-1]["answered"] = 2
        sheet = self.sheet()
        try:
            decisions = self.score(sheet)[1]
        except ValueError:
            return  # A declared coverage rejection is also fail-closed.
        self.assertEqual(decisions[1]["verdict"], "FAIL")
        self.assertIn("other", decisions[1]["new_failures"])

    def test_changed_source_hash_is_not_scored_against_current_facts(self):
        self.variant[1]["pagesSha256"] = hashlib.sha256(b"other invented input").hexdigest()
        with self.assertRaises(ValueError):
            self.score()

    def test_declared_manifest_cannot_contradict_document_evidence(self):
        self.variant[0]["documents"] = {self.doc["id"]: dict(pagesSha256="wrong", docLang="en")}
        with self.assertRaises(ValueError):
            self.score()

    def test_malformed_result_is_a_new_failure(self):
        self.variant[1]["result"] = {"sentences": "not a sentence list"}
        summaries, decisions = self.score()
        self.assertEqual(summaries[1]["failed"], 1)
        self.assertIn(self.doc["id"], decisions[1]["new_failures"])

    def test_location_truthy_strings_are_not_valid_successful_results(self):
        self.variant[1]["result"]["sentences"][0]["located"] = "true"
        self.assertIn(self.doc["id"], self.score()[1][1]["new_failures"])

    def test_litre_denominator_alias_keeps_scale_prefix_case(self):
        fact = dict(id="marker", quantity_check=dict(
            pattern=r"marker\D{0,20}(\d+(?:[.,]\d+)?)\s*(mmol/l)", value="2.5", unit="mmol/L"))
        self.assertNotIn("QUANTITY_MISMATCH:marker",
                         compare.screen(sentence("Marker 2.5 mmol/l.", "Marker 2.5 mmol/L."), "en", [fact]))

    def test_repeat_does_not_hide_equal_partial_coverage(self):
        self.docs["other"] = dict(self.doc, id="other")
        self.assertTrue(compare.repeat(self.write("a", self.base), self.write("b", self.base), self.docs)[3])
        self.assertFalse(compare.repeat(self.write("a", self.base), self.write("b", self.base),
                                        self.docs, only=[self.doc["id"]])[3])

    def test_repeat_checks_sentences_even_when_answer_hash_is_equal(self):
        same, different, count, problems = compare.repeat(self.write("a", self.base),
            self.write("b", self.variant), self.docs)
        self.assertEqual((same, different, count, problems), ([], [self.doc["id"]], 1, []))

    def test_repeat_requires_source_and_chat_configuration_identity(self):
        self.variant[0]["model"]["chatFormat"] = "gemma4"
        self.variant[1]["pagesSha256"] = hashlib.sha256(b"changed invented page").hexdigest()
        with patch.object(compare, "load_documents", return_value=self.docs):
            try:
                problems = compare.repeat(self.write("a", self.base), self.write("b", self.variant))[3]
            except ValueError:
                return
        self.assertTrue(problems)

    def test_repeat_reports_incomplete_coverage_instead_of_only_intersection(self):
        self.variant = copy.deepcopy(self.base)
        extra = copy.deepcopy(self.variant[1])
        extra["id"] = "other"
        self.docs["other"] = dict(self.doc, id="other")
        self.variant.insert(-1, extra)
        self.variant[-1]["answered"] = 2
        with patch.object(compare, "load_documents", return_value=self.docs):
            self.assertTrue(compare.repeat(self.write("a", self.base), self.write("b", self.variant))[3])


if __name__ == "__main__":
    unittest.main()

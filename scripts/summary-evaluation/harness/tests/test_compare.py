"""Tests for compare.py on small FAKE documents and hand-made run files. No model runs."""
import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import compare  # noqa: E402

TEXT = ("FAKE letter. They have lost 4 kg. I have asked them to keep eating gluten for now. "
        "I would be grateful if they could be seen within the next 4 to 6 weeks.")


def fake_doc():
    return dict(id="fake-letter", title="FAKE letter", lang="en", synthetic=True, source="test",
                pages=[dict(index=0, text=TEXT)], traps=["advising a gluten-free diet"], facts=[
        dict(id="weight", category="finding", required=True, critical=False,
             source_evidence="They have lost 4 kg.", approved_statements=["They lost 4 kg."],
             anchors=["4 kg"], match=[["4 kg"]], expected_attributes={}),
        dict(id="gluten", category="instruction", required=True, critical=True,
             source_evidence="I have asked them to keep eating gluten for now.",
             approved_statements=["Keep eating gluten for now."], anchors=["gluten"], match=[["gluten"]],
             expected_attributes={}),
        dict(id="timing", category="timing", required=True, critical=True,
             source_evidence="I would be grateful if they could be seen within the next 4 to 6 weeks.",
             approved_statements=["They should be seen within 4 to 6 weeks."], anchors=["4", "6", "week"],
             match=[["4"], ["6"], ["week"]], expected_attributes={}),
    ])


def sentence(text, quote, located=True):
    return dict(text=text, quote=quote, located=located)


def run_lines(variant, sentences, wall_ms=100_000, error=None, doc_id="fake-letter"):
    meta = dict(kind="run", variant=variant, build=dict(fingerprint="f" * 64), lang="en",
                model=dict(sha256="a" * 64))
    entry = dict(kind="document", id=doc_id, wallMs=wall_ms)
    if error:
        entry["error"] = error
    else:
        entry["result"] = dict(sentences=sentences, lastPage=0, lastPageCut=False, answerLimitMs=400_000,
                               stats=dict(promptTokens=900, answerTokens=300, promptMs=60_000,
                                          answerMs=40_000, capped=False, answerHash=1))
    return [meta, entry, dict(kind="end")]


def write_run(folder, name, lines):
    path = Path(folder) / f"{name}.jsonl"
    path.write_text("".join(json.dumps(line) + "\n" for line in lines), encoding="utf-8")
    return path


BASE = [sentence("You have lost 4 kg.", "They have lost 4 kg.")]
BETTER = BASE + [
    sentence("Keep eating gluten until you are seen.", "I have asked them to keep eating gluten for now."),
    sentence("You should be seen within 4 to 6 weeks.",
             "I would be grateful if they could be seen within the next 4 to 6 weeks."),
]


class TextTest(unittest.TestCase):
    def test_folds_case_accents_and_spaces(self):
        self.assertEqual(compare.fold("  Céliaque   ŁÓDŹ "), "celiaque lodz")

    def test_reads_numbers_with_decimal_and_thousands_commas(self):
        self.assertEqual(compare.numbers("8,1% and 1,180 ng/L and 2.5 mg"), {"8.1", "1180", "2.5"})

    def test_quote_overlaps_its_evidence_but_not_another_sentence(self):
        evidence = "I have asked them to keep eating gluten for now."
        self.assertTrue(compare.quote_overlaps("keep eating gluten for now", evidence))
        self.assertTrue(compare.quote_overlaps("FAKE. " + evidence + " More.", evidence))
        self.assertFalse(compare.quote_overlaps("They have lost 4 kg.", evidence))
        self.assertFalse(compare.quote_overlaps("", evidence))


class FactTest(unittest.TestCase):
    def setUp(self):
        self.facts = {f["id"]: f for f in fake_doc()["facts"]}

    def test_finds_an_approved_statement(self):
        how, index = compare.find_fact(self.facts["weight"], [sentence("They lost 4 kg.", "x")])
        self.assertEqual((how, index), ("approved", 0))

    def test_finds_a_named_fact_whose_quote_covers_its_evidence(self):
        how, index = compare.find_fact(self.facts["timing"], BETTER)
        self.assertEqual((how, index), ("matched", 2))

    def test_does_not_count_a_name_with_a_quote_from_elsewhere(self):
        wrong_quote = [sentence("Keep eating gluten.", "They have lost 4 kg.")]
        self.assertEqual(compare.find_fact(self.facts["gluten"], wrong_quote), (None, None))

    def test_needs_every_match_group(self):
        no_week = [sentence("Seen in 4 to 6.", "I would be grateful if they could be seen within the next 4 to 6 weeks.")]
        self.assertEqual(compare.find_fact(self.facts["timing"], no_week), (None, None))


class ScreenTest(unittest.TestCase):
    def flags(self, text, quote, located=True, lang="en", facts=()):
        return compare.screen(sentence(text, quote, located), lang, list(facts))

    def test_a_faithful_sentence_has_no_flag(self):
        self.assertEqual(self.flags("You have lost 4 kg.", "They have lost 4 kg."), [])

    def test_flags_a_number_its_quote_does_not_have(self):
        self.assertIn("NUMBER_NOT_IN_QUOTE:5", self.flags("You lost 5 kg.", "They have lost 4 kg."))

    def test_flags_a_negation_on_one_side_only(self):
        self.assertIn("NEGATION_MISMATCH", self.flags("You did not lose weight.", "They have lost 4 kg."))

    def test_flags_advice_or_judgement_words_the_quote_does_not_have(self):
        flags = self.flags("This is normal and you should rest.", "Potassium 4.2 mmol/L")
        self.assertIn("ADVICE_OR_JUDGEMENT:normal,should", flags)
        self.assertNotIn("ADVICE_OR_JUDGEMENT:normal",
                         " ".join(self.flags("Potassium is normal.", "Potassium is normal (4.2).")))

    def test_flags_a_doctor_s_action_given_to_the_patient(self):
        self.assertIn("ACTOR_SHIFT", self.flags("You will do the biopsy.", "The specialist will do a biopsy."))

    def test_flags_a_quote_that_was_not_found_and_another_language(self):
        flags = self.flags("Le patient a perdu du poids et de la force.", "They have lost 4 kg.", located=False)
        self.assertIn("SOURCE_NOT_FOUND", flags)
        self.assertIn("LANGUAGE:fr", flags)

    def test_flags_a_quantity_that_differs_from_its_fact(self):
        fact = dict(id="dose", quantity_check=dict(pattern=r"ramipril\D{0,20}(\d+(?:[.,]\d+)?)\s*(mg)",
                                                   value="2.5", unit="mg"))
        self.assertIn("QUANTITY_MISMATCH:dose", self.flags("Ramipril 5 mg daily.", "Ramipril 5 mg daily", facts=[fact]))
        self.assertNotIn("QUANTITY_MISMATCH:dose", self.flags("Ramipril 2,5 mg daily.", "Ramipril 2,5 mg", facts=[fact]))


class DocumentTest(unittest.TestCase):
    def test_a_sound_document_has_no_problem(self):
        self.assertEqual(compare.check_document(fake_doc()), [])

    def test_evidence_must_be_in_the_document(self):
        doc = fake_doc()
        doc["facts"][0]["source_evidence"] = "Not in the letter."
        self.assertIn("fact weight: source evidence is not in the document", compare.check_document(doc))

    def test_the_document_set_in_the_repository_is_sound(self):
        docs = compare.load_documents()
        self.assertGreaterEqual(len(docs), 26)
        for doc_id, doc in docs.items():
            self.assertEqual(compare.check_document(doc), [], doc_id)

    def test_prepare_writes_only_what_the_run_reads(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(compare.prepare(folder, {"fake-letter": fake_doc()}), 1)
            written = json.loads((Path(folder) / "fake-letter.json").read_text(encoding="utf-8"))
        self.assertEqual(set(written), {"id", "lang", "pages"})


class RunTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.docs = {"fake-letter": fake_doc()}

    def test_a_run_must_start_with_its_name_and_keeps_the_first_answer(self):
        lines = run_lines("B0", BASE)
        bad = write_run(self.folder.name, "bad", lines[1:])
        with self.assertRaises(ValueError):
            compare.read_run(bad)
        again = dict(lines[1], wallMs=1)
        meta, entries = compare.read_run(write_run(self.folder.name, "twice", lines + [again]))
        self.assertEqual(entries["fake-letter"]["wallMs"], 100_000)

    def score(self, variant_lines, review_rows=None):
        base = write_run(self.folder.name, "B0", run_lines("B0", BASE))
        variant = write_run(self.folder.name, "E1", variant_lines)
        out = Path(self.folder.name) / "out"
        review = None
        if review_rows is not None:
            review = Path(self.folder.name) / "filled.csv"
            with review.open("w", newline="", encoding="utf-8") as target:
                writer = csv.DictWriter(target, fieldnames=["run", "doc", "sentence", "verdict"])
                writer.writeheader()
                writer.writerows(review_rows)
        return compare.score([base, variant], out, self.docs, review), out

    def test_a_better_variant_waits_for_the_hand_review(self):
        (summaries, decisions), out = self.score(run_lines("E1", BETTER))
        self.assertEqual(summaries[0]["action_found"], 0)
        self.assertEqual(summaries[1]["action_found"], 2)
        self.assertEqual(decisions[1]["verdict"], "PENDING")
        self.assertTrue((out / "compare.md").read_text(encoding="utf-8").startswith("| Document | B0 | E1 |"))
        with (out / "review.csv").open(encoding="utf-8") as sheet:
            rows = list(csv.DictReader(sheet))
        self.assertTrue(all(row["verdict"] == "" for row in rows))

    def test_a_better_variant_passes_once_reviewed_correct(self):
        rows = [dict(run="E1", doc="fake-letter", sentence=i, verdict="correct") for i in range(3)]
        (summaries, decisions), _ = self.score(run_lines("E1", BETTER), rows)
        self.assertEqual(summaries[1]["reviewed_wrong"], 0)
        self.assertEqual(decisions[1]["verdict"], "PASS")

    def test_one_reviewed_wrong_statement_fails_it(self):
        rows = [dict(run="E1", doc="fake-letter", sentence=1, verdict="wrong")]
        (_, decisions), _ = self.score(run_lines("E1", BETTER), rows)
        self.assertEqual(decisions[1]["verdict"], "FAIL")

    def test_losing_a_must_have_the_baseline_had_fails_it(self):
        rows = [dict(run="E1", doc="fake-letter", sentence=0, verdict="correct")]
        (_, decisions), _ = self.score(run_lines("E1", BETTER[1:2]), rows)
        self.assertEqual(decisions[1]["verdict"], "FAIL")
        self.assertEqual(decisions[1]["lost"], ["fake-letter/weight"])

    def test_a_new_failure_or_a_slower_run_fails_it(self):
        rows = []
        (_, decisions), _ = self.score(run_lines("E1", BETTER, wall_ms=200_000), rows)
        self.assertEqual(decisions[1]["verdict"], "FAIL")
        (_, decisions), _ = self.score(run_lines("E1", BETTER, error="TimedOut"), rows)
        self.assertEqual(decisions[1]["verdict"], "FAIL")
        self.assertEqual(decisions[1]["new_failures"], ["fake-letter"])

    def test_a_last_page_read_after_a_gap_is_not_cut_but_marked(self):
        doc = dict(fake_doc(), pages=[dict(index=i, text=TEXT if i == 0 else f"FAKE page {i}.") for i in range(4)])
        entry = run_lines("E4", BASE)[1]
        entry["result"].update(lastPage=1, tailPage=3)
        scored = compare.score_document(doc, entry, "en")
        self.assertEqual((scored["cut"], scored["gap"], scored["tail_page"]), (False, True, 3))
        entry["result"].update(lastPage=1, tailPage=None)
        scored = compare.score_document(doc, entry, "en")
        self.assertEqual((scored["cut"], scored["gap"]), (True, False))

    def test_the_review_sheet_is_never_overwritten(self):
        _, out = self.score(run_lines("E1", BETTER))
        sheet = out / "review.csv"
        sheet.write_text("run,doc,sentence,verdict\nE1,fake-letter,0,correct\n", encoding="utf-8")
        compare.score([out.parent / "B0.jsonl", out.parent / "E1.jsonl"], out, self.docs)
        self.assertIn("correct", sheet.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

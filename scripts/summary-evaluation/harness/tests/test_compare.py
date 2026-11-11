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
                pages=[dict(index=0, text=TEXT)], traps=["advising a gluten-free diet"],
                trap_checks=[dict(trap="advising a gluten-free diet",
                                  pattern=r"^(?!.*(\bnot\b|n't|\bkeep\b)).*\bgluten[- ]free",
                                  example="Start a gluten-free diet.")], facts=[
        dict(id="weight", category="finding", required=True, critical=False,
             source_evidence="They have lost 4 kg.", approved_statements=["They lost 4 kg."],
             anchors=["4 kg"], match=[["4 kg"], ["lost", "lose", "loss"]], expected_attributes={}),
        dict(id="gluten", category="instruction", required=True, critical=True,
             source_evidence="I have asked them to keep eating gluten for now.",
             approved_statements=["Keep eating gluten for now."], anchors=["gluten"],
             match=[["gluten"], ["keep", "continu"]],
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
            fixture = doc.get("source") == "PR 295 fixtures"
            self.assertEqual(compare.check_document(doc, fixture=fixture), [], doc_id)
        self.assertEqual(compare.freeze_problems(), [])

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
        # Both patient actions are critical: held until a reviewer marks a carrying sentence correct.
        self.assertEqual((summaries[1]["action_found"], summaries[1]["action_held"]), (0, 2))
        self.assertEqual(decisions[1]["verdict"], "PENDING")
        self.assertIn("\n| Document | B0 | E1 |", (out / "compare.md").read_text(encoding="utf-8"))
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

    def test_a_repeat_of_the_same_build_matches_token_for_token(self):
        first = write_run(self.folder.name, "B0", run_lines("B0", BASE))
        again = write_run(self.folder.name, "B0R", run_lines("B0R", BASE))
        self.assertEqual(compare.repeat(first, again), (["fake-letter"], [], 1, []))
        changed = run_lines("B0R", BASE)
        changed[1]["result"]["stats"]["answerHash"] = 2
        changed[0]["build"] = dict(fingerprint="0" * 64)
        same, different, compared, problems = compare.repeat(first, write_run(self.folder.name, "B0X", changed))
        self.assertEqual((same, different, problems), ([], ["fake-letter"], ["build"]))

    def test_reports_the_helper_s_memory_per_document_against_the_allowance(self):
        lines = run_lines("B0", BASE)
        lines[0]["model"]["bytes"] = 3 * 1048576 * 1024
        lines[0]["helperMemory"] = dict(peakKiB=3_300_000, availableKiB=9_000_000)
        lines[1]["helperMemory"] = dict(peakKiB=3_700_000, availableKiB=8_000_512, peakSince="document")
        meta, entries = compare.read_run(write_run(self.folder.name, "B0", lines))
        m = compare.memory(meta, entries)
        self.assertEqual((m["model_mib"], m["load_peak_mib"], m["median_peak_mib"], m["max_peak_doc"]),
                         (3072, 3223, 3613, "fake-letter"))
        self.assertEqual((m["above_model_mib"], m["working_mib"], m["lowest_available_mib"]), (541, 1536, 7813))
        compare.score([write_run(self.folder.name, "B0", lines)], Path(self.folder.name) / "out", self.docs)
        self.assertIn("| B0 | 3072 | 3223 | 3613 | 3613 (fake-letter) | 541 | 7813 |",
                      (Path(self.folder.name) / "out" / "compare.md").read_text(encoding="utf-8"))

    def test_a_peak_kept_from_the_helper_s_start_is_not_counted_as_a_document_s_own(self):
        lines = run_lines("B0", BASE)
        lines[1]["helperMemory"] = dict(peakKiB=3_700_000, peakSince="helperStart")
        m = compare.memory(*compare.read_run(write_run(self.folder.name, "B0", lines)))
        self.assertEqual((m["documents"], m["own_peaks"], m["median_peak_mib"]), (1, 0, None))
        self.assertIsNone(compare.memory(*compare.read_run(write_run(self.folder.name, "B1", run_lines("B1", BASE)))))

    def test_the_review_sheet_is_never_overwritten(self):
        _, out = self.score(run_lines("E1", BETTER))
        sheet = out / "review.csv"
        sheet.write_text("run,doc,sentence,verdict\nE1,fake-letter,0,correct\n", encoding="utf-8")
        compare.score([out.parent / "B0.jsonl", out.parent / "E1.jsonl"], out, self.docs)
        self.assertIn("correct", sheet.read_text(encoding="utf-8"))



REPO = compare.load_documents()


def evidence_of(doc_id, fact_id):
    return next(f for f in REPO[doc_id]["facts"] if f["id"] == fact_id)


def score_sentences(doc_id, sentences, verdicts=None):
    entry = dict(kind="document", id=doc_id, wallMs=1, result=dict(
        sentences=sentences, lastPage=max(p["index"] for p in REPO[doc_id]["pages"]), lastPageCut=False))
    scored = compare.score_document(REPO[doc_id], entry, "en", verdicts)
    return {f["id"]: f for f in scored["facts"]}, scored


class CounterExampleTest(unittest.TestCase):
    """The review's own counter-examples, on the repository's FAKE celiac lab report."""

    def test_a_trap_sentence_is_not_credited_and_is_flagged(self):
        fact = evidence_of("demo-celiac-lab", "ttg_high_suggests_celiac")
        wrong = sentence("Celiac disease is confirmed.", fact["source_evidence"])
        facts, scored = score_sentences("demo-celiac-lab", [wrong])
        self.assertIsNone(facts["ttg_high_suggests_celiac"]["standing"])
        flags = scored["flags"][0]["flags"]
        self.assertIn("CERTAINTY_ADDED:confirmed", flags)
        self.assertTrue(any(flag.startswith("TRAP:") for flag in flags))

    def test_the_opposite_of_a_fact_is_not_credited(self):
        fact = evidence_of("demo-celiac-lab", "iron_deficiency_anemia")
        facts, scored = score_sentences("demo-celiac-lab", [sentence("Your iron is fine.", fact["source_evidence"])])
        self.assertIsNone(facts["iron_deficiency_anemia"]["standing"])
        self.assertIn("ADVICE_OR_JUDGEMENT:fine", scored["flags"][0]["flags"])

    def test_a_table_row_quote_earns_the_credit(self):
        row = "25-hydroxy vitamin D\t41\tL\t75–250\tnmol/L"
        facts, scored = score_sentences("demo-celiac-lab", [sentence("Your vitamin D was low.", row)])
        self.assertEqual(scored["flags"][0]["flags"], [])
        self.assertEqual((facts["vitamin_d_low"]["standing"], facts["vitamin_d_low"]["found"]), ("credited", "matched"))

    def test_a_correct_statement_of_the_critical_fact_is_credited_once_reviewed(self):
        fact = evidence_of("demo-celiac-lab", "ttg_high_suggests_celiac")
        right = sentence("The celiac antibody test is 92 U/mL, more than six times the upper limit.",
                         fact["source_evidence"])
        facts, scored = score_sentences("demo-celiac-lab", [right])
        self.assertEqual(scored["flags"][0]["flags"], [])
        self.assertEqual(facts["ttg_high_suggests_celiac"]["standing"], "held")
        facts, _ = score_sentences("demo-celiac-lab", [right], {0: "correct"})
        self.assertEqual(facts["ttg_high_suggests_celiac"]["standing"], "credited")

    def test_an_unhedged_celiac_claim_quoting_the_table_row_is_a_trap(self):
        row = "Tissue transglutaminase IgA\t92\tH\t<15\tU/mL"
        for text in ("Your tTG test is 92, which is high, so there is celiac disease.",
                     "The tTG of 92 shows celiac disease."):
            facts, scored = score_sentences("demo-celiac-lab", [sentence(text, row)])
            self.assertIn("TRAP:1", scored["flags"][0]["flags"], text)
            self.assertNotEqual(facts["ttg_high_suggests_celiac"]["standing"], "credited", text)
        iron = evidence_of("demo-celiac-lab", "iron_deficiency_anemia")
        facts, scored = score_sentences("demo-celiac-lab", [sentence(
            "Your iron stores are very low and celiac disease is the cause.", iron["source_evidence"])])
        self.assertIn("TRAP:1", scored["flags"][0]["flags"])
        self.assertEqual(facts["iron_deficiency_anemia"]["standing"], "held")

    def test_a_named_organ_without_its_qualifier_is_not_the_fact(self):
        facts, _ = score_sentences("demo-celiac-lab", [sentence("Your liver is damaged.", "ALT\t52\tH\t<50\tU/L")])
        self.assertIsNone(facts["alt_high_repeat"]["matched"])

    def test_the_documents_own_wording_is_found(self):
        iron = evidence_of("demo-celiac-lab", "iron_deficiency_anemia")
        facts, _ = score_sentences("demo-celiac-lab", [sentence(
            "You have fewer red blood cells than normal, with little stored iron.", iron["source_evidence"])])
        self.assertEqual(facts["iron_deficiency_anemia"]["matched"], "matched")
        ecg = evidence_of("bakeoff-referral-letter", "ecg_no_acute_changes")
        facts, _ = score_sentences("bakeoff-referral-letter", [sentence("Your ECG showed no new problems.",
                                                                        ecg["source_evidence"])])
        self.assertEqual(facts["ecg_no_acute_changes"]["matched"], "matched")


class MatchingTest(unittest.TestCase):
    def test_options_start_at_a_word_and_short_ones_are_whole_words(self):
        self.assertFalse(compare.names("the environment", "iron"))
        self.assertTrue(compare.names("very low iron stores", "iron"))
        self.assertFalse(compare.names("health and salt", "alt"))
        self.assertFalse(compare.names("although", "alt"))
        self.assertTrue(compare.names("alt/ast are high", "alt"))
        self.assertTrue(compare.names("seen within 6 weeks", "week"))
        self.assertTrue(compare.names("the prediabetes range", "prediabet"))

    def test_numbers_are_whole_numbers(self):
        self.assertTrue(compare.names("in 2 to 3 weeks", "2"))
        self.assertFalse(compare.names("12 weeks", "2"))
        self.assertFalse(compare.names("2.5 mg", "2"))
        self.assertFalse(compare.names("0.2 mg", "2"))
        self.assertTrue(compare.names("lvef 40%", "40"))
        self.assertTrue(compare.names("hba1c 8,1%", "8,1"))

    def test_a_quote_from_another_place_does_not_cover_the_evidence(self):
        doc = REPO["fake02-cardiac-discharge"]
        atorvastatin = evidence_of("fake02-cardiac-discharge", "atorvastatin_80")
        folded = compare.fold(compare.joined_text(doc))
        ramipril_row = "Ramipril  2.5 mg daily  CHANGED (was 5 mg)"
        # The rows share "mg daily changed (was": the old rule credited it, the place-based one does not.
        self.assertTrue(compare.quote_overlaps(ramipril_row, atorvastatin["source_evidence"]))
        self.assertFalse(compare.quote_on_evidence(ramipril_row, compare.evidence_spans(atorvastatin), folded))
        self.assertTrue(compare.quote_on_evidence(atorvastatin["source_evidence"],
                                                  compare.evidence_spans(atorvastatin), folded))


class CreditTest(unittest.TestCase):
    def setUp(self):
        self.doc = fake_doc()
        self.timing = sentence("You should be seen within 4 to 6 weeks.",
                               "I would be grateful if they could be seen within the next 4 to 6 weeks.")

    def standing(self, sentences, verdicts=None):
        entry = run_lines("E1", sentences)[1]
        facts = compare.score_document(self.doc, entry, "en", verdicts)["facts"]
        return {f["id"]: f["standing"] for f in facts}

    def test_a_flagged_sentence_holds_its_fact_until_the_review(self):
        self.assertEqual(self.standing([self.timing])["timing"], "held")
        self.assertEqual(self.standing([self.timing], {0: "correct"})["timing"], "credited")
        for verdict in ("wrong", "unsupported", "vague"):
            self.assertEqual(self.standing([self.timing], {0: verdict})["timing"], "rejected")

    def test_a_critical_fact_waits_for_a_reviewer_even_when_an_unflagged_sentence_carries_it(self):
        plain = sentence("They will be seen within 4 to 6 weeks.",
                         "I would be grateful if they could be seen within the next 4 to 6 weeks.")
        self.assertEqual(self.standing([self.timing, plain])["timing"], "held")
        self.assertEqual(self.standing([self.timing, plain], {1: "correct"})["timing"], "credited")

    def test_an_unflagged_sentence_credits_a_fact_that_is_not_critical(self):
        weight = sentence("You have lost 4 kg.", "They have lost 4 kg.")
        self.assertEqual(self.standing([weight])["weight"], "credited")

    def test_a_review_against_an_unflagged_sentence_takes_its_credit(self):
        weight = sentence("You have lost 4 kg.", "They have lost 4 kg.")
        self.assertEqual(self.standing([weight], {0: "wrong"})["weight"], "rejected")


class NewScreenTest(unittest.TestCase):
    def flags(self, text, quote, doc=None):
        return compare.screen(sentence(text, quote), "en", [], doc)

    def test_flags_a_hedge_the_sentence_dropped(self):
        quote = "a duodenal biopsy is usually needed to confirm it; this strongly suggests celiac disease"
        self.assertIn("HEDGE_DROPPED", self.flags("You have celiac disease.", quote))
        self.assertNotIn("HEDGE_DROPPED", self.flags("This suggests celiac disease.", quote))
        self.assertNotIn("HEDGE_DROPPED", self.flags("The visit is in May.", "Seen in May 2026."))

    def test_flags_certainty_the_quote_does_not_have(self):
        self.assertIn("CERTAINTY_ADDED:confirmed", self.flags("Celiac disease is confirmed.", "tTG IgA 92 U/mL"))
        self.assertEqual(self.flags("A biopsy is needed to confirm it.", "A biopsy is needed to confirm it."), [])
        # "Diagnosed with" overstates only a quote that hedges.
        self.assertEqual(self.flags("You were diagnosed with pneumonia.",
                                    "Admitted with community-acquired pneumonia."), [])
        self.assertIn("CERTAINTY_ADDED:diagnosed with",
                      self.flags("You were diagnosed with pneumonia.", "Findings suggest pneumonia."))

    def test_a_purpose_clause_is_not_a_hedge(self):
        self.assertNotIn("HEDGE_DROPPED", self.flags("You need a biopsy of the small bowel to check for celiac disease.",
                                                     "a duodenal biopsy is usually needed to confirm it."))

    def test_flags_a_statement_about_someone_else(self):
        self.assertIn("EXPERIENCER", self.flags("You have hypothyroidism.", "Mother has hypothyroidism."))
        self.assertNotIn("EXPERIENCER", self.flags("Your mother has hypothyroidism.", "Mother has hypothyroidism."))
        self.assertNotIn("EXPERIENCER", self.flags("See your doctor in 10 days.",
                                                   "Family physician, within 10 days."))

    def test_the_fuller_negation_list(self):
        self.assertIn("NEGATION_MISMATCH", self.flags("Celiac disease is likely.", "Celiac disease was ruled out."))
        self.assertIn("NEGATION_MISMATCH", self.flags("The scan showed a problem.", "The scan was unremarkable."))

    def test_a_listed_trap_is_machine_checked(self):
        doc = fake_doc()
        self.assertIn("TRAP:0", self.flags("Start a gluten-free diet now.", "keep eating gluten", doc))
        self.assertNotIn("TRAP:0", " ".join(self.flags("Do not start a gluten-free diet.", "keep eating gluten", doc)))

    def test_every_trap_needs_a_check_that_its_example_trips_and_no_approved_statement_does(self):
        doc = fake_doc()
        doc["trap_checks"][0]["example"] = "Keep eating gluten."
        self.assertTrue(any("example does not fall into it" in p for p in compare.check_document(doc)))
        doc = fake_doc()
        doc["trap_checks"][0]["pattern"] = r"\bgluten\b"
        doc["trap_checks"][0]["example"] = "gluten"
        self.assertTrue(any("approved statement falls into it" in p for p in compare.check_document(doc)))
        doc = fake_doc()
        del doc["trap_checks"]
        self.assertIn("trap_checks must list every trap, in order", compare.check_document(doc))

    def test_a_critical_fact_needs_a_qualifier_or_a_reason(self):
        doc = fake_doc()
        doc["facts"][1]["match"] = [["gluten"]]
        self.assertTrue(any("needs a qualifier group" in p for p in compare.check_document(doc)))
        doc["facts"][1]["required"] = True
        doc["facts"][1]["no_qualifier"] = "the word carries the fact"
        self.assertEqual(compare.check_document(doc), [])


class DecisionV2Test(RunTest):
    def test_a_speed_variant_passes_when_not_worse(self):
        rows = [dict(run="E1", doc="fake-letter", sentence=0, verdict="correct")]
        (_, decisions), _ = self.score(run_lines("E1", BASE, wall_ms=50_000), rows)
        self.assertEqual(decisions[1]["verdict"], "PASS")

    def test_an_experiment_aimed_at_actions_can_require_a_gain(self):
        base = write_run(self.folder.name, "B0", run_lines("B0", BASE))
        same = write_run(self.folder.name, "E1", run_lines("E1", BASE))
        review = Path(self.folder.name) / "filled.csv"
        review.write_text("run,doc,sentence,verdict\nE1,fake-letter,0,correct\n", encoding="utf-8")
        _, decisions = compare.score([base, same], Path(self.folder.name) / "gain", self.docs, review,
                                     require_gain=True)
        self.assertEqual(decisions[1]["verdict"], "FAIL")

    def test_a_margin_allows_that_many_lost_must_haves(self):
        rows = [dict(run="E1", doc="fake-letter", sentence=0, verdict="correct")]
        base = write_run(self.folder.name, "B0", run_lines("B0", BASE))
        variant = write_run(self.folder.name, "E1", run_lines("E1", BETTER[1:2]))
        review = Path(self.folder.name) / "filled.csv"
        with review.open("w", newline="", encoding="utf-8") as target:
            writer = csv.DictWriter(target, fieldnames=["run", "doc", "sentence", "verdict"])
            writer.writeheader()
            writer.writerows(rows)
        _, decisions = compare.score([base, variant], Path(self.folder.name) / "m", self.docs, review, margin_lost=1)
        self.assertEqual(decisions[1]["verdict"], "PASS")

    def test_a_held_fact_makes_a_lost_must_have_pending_not_failed(self):
        timing_only = [sentence("You should be seen within 4 to 6 weeks.",
                                "I would be grateful if they could be seen within the next 4 to 6 weeks.")]
        base_plain = [sentence("They will be seen within 4 to 6 weeks.",
                               "I would be grateful if they could be seen within the next 4 to 6 weeks.")]
        base = write_run(self.folder.name, "B0", run_lines("B0", base_plain))
        variant = write_run(self.folder.name, "E1", run_lines("E1", timing_only))
        _, decisions = compare.score([base, variant], Path(self.folder.name) / "p", self.docs)
        check = next(ok for name, ok in decisions[1]["checks"] if name.startswith("must-haves lost"))
        self.assertIsNone(check)

    def test_holdout_cases_are_reported_but_not_decided_on(self):
        holdout = dict(fake_doc(), id="hold-letter", split="holdout")
        self.docs["hold-letter"] = holdout
        good = run_lines("B0", BASE)
        base_lines = good[:2] + [dict(good[1], id="hold-letter")] + good[2:]
        variant_lines = run_lines("E1", BASE)
        variant_lines.insert(2, dict(kind="document", id="hold-letter", wallMs=1, error="Failed"))
        base = write_run(self.folder.name, "B0", base_lines)
        variant = write_run(self.folder.name, "E1", variant_lines)
        review = Path(self.folder.name) / "filled.csv"
        review.write_text("run,doc,sentence,verdict\nE1,fake-letter,0,correct\n", encoding="utf-8")
        out = Path(self.folder.name) / "h"
        summaries, decisions = compare.score([base, variant], out, self.docs, review)
        self.assertEqual(decisions[1]["verdict"], "PASS")
        self.assertEqual(summaries[1]["documents"], 1)
        self.assertIn("hold-letter (holdout)", (out / "compare.md").read_text(encoding="utf-8"))

    def test_an_a_a_pair_measures_the_flips_that_set_the_margins(self):
        first = write_run(self.folder.name, "B0", run_lines("B0", BETTER))
        again = write_run(self.folder.name, "B0R", run_lines("B0R", BETTER))
        measured = compare.noise(first, again, self.docs)
        self.assertEqual((measured["margin_lost"], measured["margin_actions"], measured["same_answers"]), (0, 0, 1))
        # Facts carried in one answer and not the other, before any review.
        moved = run_lines("B0X", BETTER[:2])
        moved[1]["result"]["stats"]["answerHash"] = 7
        measured = compare.noise(first, write_run(self.folder.name, "B0X", moved), self.docs)
        self.assertEqual((measured["flipped"], measured["margin_actions"]), (["fake-letter/timing"], 1))
        dropped = run_lines("B0Y", BASE)
        measured = compare.noise(first, write_run(self.folder.name, "B0Y", dropped), self.docs)
        self.assertEqual((measured["flipped"], measured["margin_actions"]),
                         (["fake-letter/gluten", "fake-letter/timing"], 2))

    def test_every_output_names_what_scored_it(self):
        (_, _), out = self.score(run_lines("E1", BETTER))
        scores = json.loads((out / "scores.json").read_text(encoding="utf-8"))
        identity = scores["scoring"]
        self.assertEqual(len(identity["id"]), 64)
        self.assertEqual(identity["thresholds_values"]["rule_version"], compare.RULE_VERSION)
        self.assertTrue((out / "compare.md").read_text(encoding="utf-8").startswith(f"Scoring {identity['id'][:16]}"))
        changed = dict(self.docs)
        changed["fake-letter"] = fake_doc()
        changed["fake-letter"]["facts"][0]["match"] = [["4 kg"], ["lost"]]
        self.assertNotEqual(compare.scoring_identity(changed, {})["documents"],
                            compare.scoring_identity(self.docs, {})["documents"])



class RuleV3Test(RunTest):
    def write_review(self, rows):
        review = Path(self.folder.name) / "filled.csv"
        with review.open("w", newline="", encoding="utf-8") as target:
            writer = csv.DictWriter(target, fieldnames=["run", "doc", "sentence", "verdict"])
            writer.writeheader()
            writer.writerows(rows)
        return review

    def test_the_verdict_waits_while_a_critical_carrier_is_unreviewed(self):
        base = write_run(self.folder.name, "B0", run_lines("B0", BASE))
        gluten = [BETTER[0], BETTER[1]]
        variant = write_run(self.folder.name, "E1", run_lines("E1", gluten))
        review = self.write_review([dict(run="E1", doc="fake-letter", sentence=0, verdict="correct")])
        _, decisions = compare.score([base, variant], Path(self.folder.name) / "w", self.docs, review)
        check = next(ok for name, ok in decisions[1]["checks"] if name == "no reviewed wrong statement")
        self.assertIsNone(check)
        self.assertEqual(decisions[1]["verdict"], "PENDING")

    def test_gain_is_required_only_of_the_variants_named(self):
        base = write_run(self.folder.name, "B0", run_lines("B0", BASE))
        e1 = write_run(self.folder.name, "E1", run_lines("E1", BASE))
        e4 = write_run(self.folder.name, "E4", run_lines("E4", BASE))
        review = self.write_review([dict(run=r, doc="fake-letter", sentence=0, verdict="correct") for r in ("E1", "E4")])
        _, decisions = compare.score([base, e1, e4], Path(self.folder.name) / "g", self.docs, review,
                                     require_gain={"E1"})
        self.assertEqual((decisions[1]["verdict"], decisions[2]["verdict"]), ("FAIL", "PASS"))
        self.assertIn("gain required for E1)", (Path(self.folder.name) / "g" / "compare.md").read_text(encoding="utf-8"))

    def test_margins_come_only_from_a_noise_pair_on_the_command_line(self):
        with self.assertRaises(SystemExit):
            compare.main(["score", "--run", "x.jsonl", "--out", "y", "--margin-lost", "3"])
        base = write_run(self.folder.name, "B0", run_lines("B0", BASE))
        with self.assertRaises(SystemExit):
            compare.main(["score", "--run", str(base), "--out", str(Path(self.folder.name) / "z"),
                          "--require-gain-for", "E9"])


class FrozenTest(unittest.TestCase):
    """The decision is held to HARNESS-FREEZE.json: scorer, rule version and documents."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        row = "25-hydroxy vitamin D\t41\tL\t75–250\tnmol/L"
        lines = lambda variant: [
            dict(kind="run", variant=variant, build=dict(fingerprint="f" * 64), lang="en", model=dict(sha256="a" * 64)),
            dict(kind="document", id="demo-celiac-lab", wallMs=1000, result=dict(
                sentences=[sentence("Your vitamin D was low.", row)], lastPage=0, lastPageCut=False)),
        ]
        self.runs = [write_run(self.folder.name, v, lines(v)) for v in ("B0", "E1")]
        self.review = Path(self.folder.name) / "filled.csv"
        self.review.write_text("run,doc,sentence,verdict\nE1,demo-celiac-lab,0,correct\n", encoding="utf-8")

    def test_the_repository_set_is_frozen_with_its_scorer_and_rule(self):
        frozen = compare.read_json(compare.FREEZE)
        self.assertEqual(frozen["rule_version"], compare.RULE_VERSION)
        self.assertEqual(compare.pinning_problems(compare.scoring_identity(REPO, {})), [])
        _, decisions = compare.score(self.runs, Path(self.folder.name) / "f", REPO, self.review, freeze=compare.FREEZE)
        self.assertEqual(decisions[1]["verdict"], "PASS")

    def test_a_drifted_document_is_never_a_pass(self):
        drifted = json.loads(json.dumps(REPO))
        drifted["demo-celiac-lab"]["facts"][0]["match"][0].append("FAKE-extra")
        problems = compare.pinning_problems(compare.scoring_identity(drifted, {}))
        self.assertEqual(problems, ["the documents as scored differ from the freeze"])
        out = Path(self.folder.name) / "d"
        _, decisions = compare.score(self.runs, out, drifted, self.review, freeze=compare.FREEZE)
        self.assertEqual(decisions[1]["verdict"], "UNFROZEN")
        self.assertIn("NOT FROZEN", (out / "compare.md").read_text(encoding="utf-8"))


class FreezeTest(unittest.TestCase):
    def test_a_changed_document_is_caught(self):
        with tempfile.TemporaryDirectory() as folder:
            for path in compare.DOCUMENTS.glob("*.json"):
                (Path(folder) / path.name).write_bytes(path.read_bytes())
            self.assertEqual(compare.freeze_problems(folder), [])
            first = sorted(Path(folder).glob("*.json"))[0]
            first.write_text(first.read_text(encoding="utf-8").replace("FAKE", "FAKE ", 1), encoding="utf-8")
            self.assertEqual(compare.freeze_problems(folder), [f"{first.stem}: changed since the freeze"])


if __name__ == "__main__":
    unittest.main()

"""Counterexamples to presence-only numeric/citation checks; no model calls."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from evaluate import (MAX_INPUT_BYTES, evaluate_case, fixture_cases, normalized,
                      quote_provenance, read_json)

CASES = fixture_cases(HERE / "fixtures.json")
BY_ID = {case["case_id"]: case for case in CASES}


def prediction(case, variant=0):
    return dict(case_id=case["case_id"], language=case["language"],
        document_sha256=case["document_sha256"],
        sentences=[dict(text=f["approved_statements"][variant], quote=f["source_evidence"])
                   for f in case["facts"]])


def codes(result):
    return {issue["code"] for issue in result["issues"]}


class ClinicalRegressionTests(unittest.TestCase):
    def test_reviewed_baselines_in_both_languages(self):
        for case in CASES:
            for variant in [0, 1]:
                with self.subTest(case=case["case_id"], variant=variant):
                    result = evaluate_case(case, prediction(case, variant))
                    self.assertEqual(result["status"], "bounded_checks_clear")
                    self.assertEqual(result["recognized_facts_with_gold_evidence"], len(case["facts"]))
                    self.assertEqual(result["clinical_validity"], "not_established")
                    self.assertTrue(result["human_clinical_review_required"])

    def test_wrong_medication_dose_cannot_borrow_correct_number_elsewhere(self):
        for lang in ["en", "fr"]:
            case = BY_ID[f"{lang}-medication_plan"]
            row = prediction(case)
            row["sentences"][0]["text"] = row["sentences"][0]["text"].replace("5 mg", "10 mg")
            self.assertIn("10 mg", case["document_text"])  # It belongs to amlodipine.
            result = evaluate_case(case, row)
            self.assertIn("QUANTITY_MISMATCH", codes(result))
            self.assertTrue(result["statements"][0]["quote_present_in_source"])
            self.assertIsNone(result["statements"][0]["reviewed_statement_match"])

    def test_wrong_lab_value_cannot_borrow_another_analyte_value(self):
        for lang in ["en", "fr"]:
            case = BY_ID[f"{lang}-laboratory_units"]
            row = prediction(case)
            row["sentences"][0]["text"] = row["sentences"][0]["text"].replace("5.4", "82").replace("5,4", "82")
            self.assertIn("82", case["document_text"])  # Creatinine, not potassium.
            result = evaluate_case(case, row)
            self.assertIn("QUANTITY_MISMATCH", codes(result))

    def test_units_are_paired_with_their_concept(self):
        for lang in ["en", "fr"]:
            for family, index, old, new in [("medication_plan", 0, "5 mg", "5 g"),
                                           ("laboratory_units", 1, "µmol/L", "mmol/L")]:
                case = BY_ID[f"{lang}-{family}"]
                row = prediction(case)
                row["sentences"][index]["text"] = row["sentences"][index]["text"].replace(old, new)
                with self.subTest(case=case["case_id"], unit=new):
                    self.assertIn("QUANTITY_MISMATCH", codes(evaluate_case(case, row)))

    def test_medication_frequency_and_status_swaps_are_not_accepted(self):
        changes = {
            "en-medication_plan": [(0, "Continue", "Stop"), (0, "once daily", "twice daily"),
                                   (2, "Stop", "Continue")],
            "fr-medication_plan": [(0, "Continuer", "Arrêter"), (0, "une fois", "deux fois"),
                                   (2, "Arrêter", "Continuer")],
            "en-treatment_status": [(0, "it has not been started", "it has been started"),
                                    (2, "were completed", "are planned")],
            "fr-treatment_status": [(0, "n'a pas été commencée", "a été commencée"),
                                    (2, "a été terminée", "est prévue")],
        }
        for key, replacements in changes.items():
            for index, before, after in replacements:
                row = prediction(BY_ID[key])
                self.assertIn(before, row["sentences"][index]["text"])
                row["sentences"][index]["text"] = row["sentences"][index]["text"].replace(before, after)
                with self.subTest(case=key, mutation=after):
                    result = evaluate_case(BY_ID[key], row)
                    self.assertIn("UNREVIEWED_STATEMENT", codes(result))
                    self.assertLess(result["recognized_facts_with_gold_evidence"], len(BY_ID[key]["facts"]))

    def test_negation_and_certainty_swaps_are_not_accepted(self):
        changes = {
            "en-imaging_assertions": [(0, "Pulmonary embolism is seen."),
                                      (2, "Mild inflammation is confirmed.")],
            "fr-imaging_assertions": [(0, "Une embolie pulmonaire est visible."),
                                      (2, "Une inflammation légère est confirmée.")],
            "en-treatment_status": [(3, "There was no fever overnight.")],
            "fr-treatment_status": [(3, "Il n'y a pas eu de fièvre dans la nuit.")],
        }
        for key, replacements in changes.items():
            for index, text in replacements:
                row = prediction(BY_ID[key])
                row["sentences"][index]["text"] = text
                with self.subTest(case=key, text=text):
                    self.assertIn("UNREVIEWED_STATEMENT", codes(evaluate_case(BY_ID[key], row)))

    def test_experiencer_temporality_allergy_swaps_need_review(self):
        changes = {
            "en-family_context": [(0, "The patient has type 2 diabetes."),
                                  (1, "The wrist fracture is an active injury."),
                                  (2, "No penicillin allergy is recorded.")],
            "fr-family_context": [(0, "Le patient a un diabète de type 2."),
                                  (1, "La fracture du poignet est active."),
                                  (2, "Aucune allergie à la pénicilline n'est consignée.")],
        }
        for key, replacements in changes.items():
            for index, text in replacements:
                row = prediction(BY_ID[key])
                row["sentences"][index]["text"] = text
                result = evaluate_case(BY_ID[key], row)
                self.assertIn("UNREVIEWED_STATEMENT", codes(result))
                self.assertTrue(result["statements"][index]["expected_attributes"])

    def test_wrong_dates_and_laterality_do_not_earn_fact_credit(self):
        for lang in ["en", "fr"]:
            case = BY_ID[f"{lang}-imaging_assertions"]
            for index, old, new in [(3, "2027-10-12", "2026-10-12"),
                                    (1, "right" if lang == "en" else "droit",
                                     "left" if lang == "en" else "gauche")]:
                row = prediction(case)
                row["sentences"][index]["text"] = row["sentences"][index]["text"].replace(old, new)
                self.assertIn("UNREVIEWED_STATEMENT", codes(evaluate_case(case, row)))

    def test_omitted_conditional_instruction_is_visible(self):
        for lang in ["en", "fr"]:
            case = BY_ID[f"{lang}-medication_plan"]
            row = prediction(case)
            del row["sentences"][3]
            result = evaluate_case(case, row)
            self.assertIn({"code": "OMITTED_REQUIRED_FACT", "fact_id": "fever_contact",
                           "category": "conditional_instruction", "detail": "omitted_from_recognized_output"},
                          result["issues"])

    def test_quote_present_but_for_another_fact_does_not_verify_claim(self):
        case = BY_ID["en-medication_plan"]
        row = prediction(case)
        row["sentences"][0]["quote"] = case["facts"][1]["source_evidence"]
        result = evaluate_case(case, row)
        self.assertTrue(result["statements"][0]["quote_present_in_source"])
        self.assertFalse(result["statements"][0]["quote_covers_gold_evidence"])
        self.assertIn("QUOTE_NOT_FACT_EVIDENCE", codes(result))

    def test_valid_quote_does_not_validate_appended_unsupported_advice(self):
        case = BY_ID["en-medication_plan"]
        row = prediction(case)
        row["sentences"][0]["text"] += " Start warfarin today."
        result = evaluate_case(case, row)
        self.assertTrue(result["statements"][0]["quote_present_in_source"])
        self.assertIn("APPENDED_OR_COMBINED_CONTENT", codes(result))
        self.assertIn("UNREVIEWED_STATEMENT", codes(result))

    def test_embedded_prompt_instruction_is_not_gold_clinical_evidence(self):
        for lang in ["en", "fr"]:
            case = BY_ID[f"{lang}-embedded_instruction"]
            row = prediction(case)
            row["sentences"].append(dict(
                text="Start warfarin." if lang == "en" else "Commencer la warfarine.",
                quote=case["excluded_instruction"]))
            result = evaluate_case(case, row)
            self.assertTrue(result["statements"][-1]["quote_present_in_source"])
            self.assertIsNone(result["statements"][-1]["reviewed_statement_match"])
            self.assertIn("UNREVIEWED_STATEMENT", codes(result))

    def test_unknown_true_paraphrase_requires_review_not_false_hallucination_label(self):
        case = BY_ID["en-medication_plan"]
        row = prediction(case)
        row["sentences"][0]["text"] = "The existing daily 5 mg dose of ramipril should continue."
        result = evaluate_case(case, row)
        self.assertIn("UNREVIEWED_STATEMENT", codes(result))
        self.assertNotIn("UNSUPPORTED_CLAIM", codes(result))
        self.assertNotIn("OMITTED_REQUIRED_FACT", codes(result))
        self.assertEqual(result["facts"][0]["status"], "not_verified_needs_semantic_review")

    def test_ordered_quotes_and_substantial_quotes(self):
        case = BY_ID["en-medication_plan"]
        reversed_quote = case["facts"][-1]["source_evidence"] + " … " + case["facts"][0]["source_evidence"]
        self.assertFalse(quote_provenance(reversed_quote, case["pages"])["present"])
        self.assertFalse(quote_provenance("5 mg", case["pages"])["present"])
        self.assertFalse(quote_provenance("An invented source quotation.", case["pages"])["present"])

    def test_legacy_format_requires_explicit_selector(self):
        case = BY_ID["fr-medication_plan"]
        row = prediction(case)
        for sentence in row["sentences"]:
            sentence["source"] = sentence.pop("quote")
        self.assertEqual(evaluate_case(case, row, "legacy")["status"], "bounded_checks_clear")
        self.assertIn("INVALID_SENTENCE", codes(evaluate_case(case, row, "native")))

    def test_stale_source_missing_output_and_duplicate_fact(self):
        case = BY_ID["en-medication_plan"]
        row = prediction(case)
        row["document_sha256"] = "0" * 64
        self.assertIn("INVALID_OR_MISSING_OUTPUT", codes(evaluate_case(case, row)))
        self.assertIn("INVALID_OR_MISSING_OUTPUT", codes(evaluate_case(case, None)))
        row = prediction(case)
        row["sentences"].append(deepcopy(row["sentences"][0]))
        self.assertIn("DUPLICATE_FACT", codes(evaluate_case(case, row)))

    def test_clinical_superscripts_are_not_folded_to_plain_digits(self):
        self.assertNotEqual(normalized("10⁹/L"), normalized("109/L"))

    def test_unit_case_cannot_inherit_statement_or_quote_approval(self):
        case = BY_ID["en-medication_plan"]
        row = prediction(case)
        row["sentences"][0]["text"] = row["sentences"][0]["text"].replace("5 mg", "5 Mg")
        result = evaluate_case(case, row)
        self.assertIn("UNREVIEWED_STATEMENT", codes(result))
        self.assertIn("QUANTITY_MISMATCH", codes(result))
        row = prediction(case)
        row["sentences"][0]["quote"] = row["sentences"][0]["quote"].replace("5 mg", "5 Mg")
        self.assertIn("SOURCE_QUOTE_NOT_VERIFIED", codes(evaluate_case(case, row)))

    def test_authoring_reproduces_the_frozen_cases_without_rewriting(self):
        spec = importlib.util.spec_from_file_location("fixture_author", HERE / "author_fixtures.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.CASES, CASES)
        self.assertEqual(sum(len(c["facts"]) for c in CASES), 48)
        self.assertEqual(len({c["family"] for c in CASES}), 6)

    def test_input_size_is_bounded_before_allocating_the_whole_file(self):
        class LargerThanLimit:
            def open(self, mode):
                self.mode = mode
                return self

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, count):
                self.count = count
                return b" " * count

        source = LargerThanLimit()
        with self.assertRaises(ValueError):
            read_json(source)
        self.assertEqual(source.mode, "rb")
        self.assertEqual(source.count, MAX_INPUT_BYTES + 1)

    def test_input_provenance_hash_binds_the_bytes_actually_parsed(self):
        import hashlib
        with tempfile.TemporaryDirectory() as temporary:
            p = Path(temporary) / "input.json"
            raw = b'{"predictions": []}\n'
            p.write_bytes(raw)
            parsed, digest = read_json(p, with_hash=True)
            self.assertEqual(parsed, {"predictions": []})
            self.assertEqual(digest, hashlib.sha256(raw).hexdigest())

    def test_cli_keeps_missing_cases_and_refuses_to_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            incoming = root / "predictions.json"
            report = root / "report.json"
            incoming.write_text(json.dumps({"predictions": []}))
            command = [sys.executable, str(HERE / "evaluate.py"), "--format", "native",
                       "--predictions", str(incoming), "--output", str(report)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stderr)
            saved = json.loads(report.read_text())
            self.assertEqual(saved["cases"], 12)
            self.assertEqual(len(saved["missing_case_ids"]), 12)
            snapshot = report.read_bytes()
            rerun = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(rerun.returncode, 2)
            self.assertEqual(report.read_bytes(), snapshot)


if __name__ == "__main__":
    unittest.main()

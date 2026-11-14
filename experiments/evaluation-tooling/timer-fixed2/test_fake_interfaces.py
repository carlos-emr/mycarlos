"""FAKE-only authored controls for interfaces.py; deliberately UNRUN.

These tests are a source proposal. They must not be treated as evidence, imported,
executed, or used as completion/grade adapters without separate root admission.
"""
import hashlib
import unittest

from interfaces import (
    COMPLETION_SCHEMA,
    COUNTS,
    GUARD_SCHEMA,
    HEAD,
    SCORER_INVOCATION_SCHEMA,
    SCORER_SHA256,
    TREE,
    canonical_bytes,
    canonical_sha256,
    completion_payload,
    documents_manifest,
    neutral_invocation_payload,
    pages_preimage,
    reference,
)


FAKE_HASH = "a" * 64
FAKE_TIME = "FAKE-observed-at"


def fake_document(identifier="FAKE-doc", pages=None, lang="en"):
    return {
        "id": identifier,
        "lang": lang,
        "pages": pages if pages is not None else [{"index": 0, "text": "FAKE page"}],
    }


def literal_rust_page_preimage(document):
    """Independent oracle: literal u32LE/u64LE/text concatenation."""
    result = bytearray()
    for page in document["pages"]:
        encoded = page["text"].encode("utf-8")
        result.extend(page["index"].to_bytes(4, byteorder="little", signed=False))
        result.extend(len(encoded).to_bytes(8, byteorder="little", signed=False))
        result.extend(encoded)
    return bytes(result)


def fake_completion_kwargs():
    stage = "H10"
    label = "M2timer12f874-H10"
    documents = {f"FAKE-doc-{i}": {"docLang": "en", "pagesSha256": FAKE_HASH}
                 for i in range(COUNTS[stage])}
    header = {
        "kind": "run",
        "commit": HEAD,
        "variant": label,
        "lang": "en",
        "threads": 3,
        "documents": documents,
        "runnerSha256": FAKE_HASH,
        "harnessSha256": "b" * 64,
        "model": {"sha256": "c" * 64},
    }
    guard = {
        "schema": GUARD_SCHEMA,
        "candidate_head": HEAD,
        "stage": stage,
        "candidate_label": label,
        "actual_exit_code": 0,
        "cleanup": {"kernel_no_children": True, "cleanup_complete": True,
                    "remaining_live_owned": [], "unreaped_owned": [],
                    "root_children": [{"pid": 999999, "start": "FAKE", "reaped": True,
                                       "pidfd_bound": True, "exit": 0}]},
        "no_unbound_children": True,
    }
    return {
        "stage": stage,
        "label": label,
        "run": reference("/FAKE/run.json", FAKE_HASH),
        "guard_ref": reference("/FAKE/guard.json", "b" * 64),
        "terminal": reference("/FAKE/terminal.json", "c" * 64),
        "guard_terminal": reference("/FAKE/guard-terminal.json", "d" * 64),
        "guard": guard,
        "observed_guard_exit": 0,
        "header": header,
        "runtime_approval": {"FAKE": True},
        "approved_roster": {"FAKE": []},
        "source_inventory": {"FAKE": []},
        "source_exports": {"FAKE": []},
        "coordinator_source_sha256": FAKE_HASH,
        "attempt": "FAKE-attempt-1",
        "observed_at": FAKE_TIME,
    }


def fake_neutral_kwargs():
    return {
        "stage": "H10",
        "label": "M2timer12f874-H10",
        "argv": ["FAKE-scorer", "--run", "/FAKE/baseline.json", "--run", "/FAKE/run.json"],
        "actual_exit_code": 0,
        "scorer_source": {"path": "/FAKE/scorer.py", "sha256": SCORER_SHA256},
        "direct_run": {"path": "/FAKE/run.json", "sha256": FAKE_HASH},
        "baselines": [{"path": "/FAKE/baseline.json", "sha256": "b" * 64}],
        "approved_scoring_runs": [
            {"label": "FAKE-baseline", "run": {"path": "/FAKE/baseline.json", "sha256": "b" * 64}},
            {"label": "M2timer12f874-H10", "run": {"path": "/FAKE/run.json", "sha256": FAKE_HASH}},
        ],
        "scoring_inputs": [{"path": "/FAKE/inputs.json", "sha256": "c" * 64}],
        "thresholds_identity": {"path": "/FAKE/thresholds.json", "sha256": "d" * 64},
        "neutral_sheet": {"FAKE": True},
        "stdout": {"path": "/FAKE/stdout", "sha256": "e" * 64},
        "stderr": {"path": "/FAKE/stderr", "sha256": "f" * 64},
        "observed_at": FAKE_TIME,
    }


class FakePagePreimageControls(unittest.TestCase):
    def test_independent_rust_preimage_matches_ascii_and_sparse_indexes(self):
        document = fake_document(
            pages=[{"index": 0, "text": "FAKE first"}, {"index": 18, "text": "FAKE tail"}]
        )
        expected = literal_rust_page_preimage(document)
        self.assertEqual(pages_preimage(document), expected)
        self.assertEqual(hashlib.sha256(pages_preimage(document)).hexdigest(), hashlib.sha256(expected).hexdigest())

    def test_utf8_length_counts_bytes_and_preserves_exact_unicode(self):
        document = fake_document(
            pages=[{"index": 7, "text": "é🧪e\u0301"}],
        )
        preimage = literal_rust_page_preimage(document)
        self.assertEqual(pages_preimage(document), preimage)
        self.assertEqual(int.from_bytes(preimage[4:12], "little"), len("é🧪e\u0301".encode("utf-8")))
        self.assertIn("é🧪e\u0301".encode("utf-8"), preimage)

    def test_empty_page_text_is_encoded_with_zero_u64_length(self):
        document = fake_document(pages=[{"index": 0, "text": ""}])
        self.assertEqual(pages_preimage(document), (0).to_bytes(4, "little") + (0).to_bytes(8, "little"))

    def test_empty_page_list_is_refused(self):
        with self.assertRaises(ValueError):
            pages_preimage(fake_document(pages=[]))

    def test_duplicate_page_indexes_are_refused(self):
        with self.assertRaises(ValueError):
            pages_preimage(fake_document(pages=[{"index": 2, "text": "FAKE a"}, {"index": 2, "text": "FAKE b"}]))

    def test_out_of_order_page_indexes_are_refused(self):
        with self.assertRaises(ValueError):
            pages_preimage(fake_document(pages=[{"index": 3, "text": "FAKE a"}, {"index": 1, "text": "FAKE b"}]))

    def test_negative_and_u32_overflow_indexes_are_refused(self):
        for index in (-1, 2**32):
            with self.subTest(index=index), self.assertRaises(ValueError):
                pages_preimage(fake_document(pages=[{"index": index, "text": "FAKE"}]))

    def test_boolean_page_index_is_not_an_integer_index(self):
        with self.assertRaises(ValueError):
            pages_preimage(fake_document(pages=[{"index": True, "text": "FAKE"}]))

    def test_manifest_accepts_unicode_document_id_without_normalization(self):
        doc = fake_document(identifier="FAKE-患者-é")
        manifest = documents_manifest([doc])
        self.assertEqual(list(manifest), ["FAKE-患者-é"])
        self.assertEqual(
            manifest["FAKE-患者-é"]["pagesSha256"],
            hashlib.sha256(literal_rust_page_preimage(doc)).hexdigest(),
        )

    def test_manifest_refuses_empty_and_duplicate_document_ids(self):
        with self.assertRaises(ValueError):
            documents_manifest([fake_document(identifier="")])
        with self.assertRaises(ValueError):
            documents_manifest([fake_document(), fake_document()])

    def test_empty_documents_manifest_is_refused(self):
        with self.assertRaises(ValueError):
            documents_manifest([])


class FakeCanonicalAndReferenceControls(unittest.TestCase):
    def test_canonical_bytes_are_sorted_compact_utf8_without_ascii_escaping(self):
        self.assertEqual(canonical_bytes({"z": "FAKE-患者", "a": 1}), '{"a":1,"z":"FAKE-患者"}'.encode("utf-8"))

    def test_canonical_bytes_refuse_nonfinite_json_numbers(self):
        with self.assertRaises(ValueError):
            canonical_bytes({"FAKE": float("nan")})

    def test_canonical_hash_matches_independent_bytes(self):
        value = {"b": "FAKE β", "a": [1, True]}
        expected = hashlib.sha256(b'{"a":[1,true],"b":"FAKE \xce\xb2"}').hexdigest()
        self.assertEqual(canonical_sha256(value), expected)

    def test_reference_requires_absolute_path_and_lowercase_sha256(self):
        with self.assertRaises(ValueError):
            reference("relative/FAKE.json", FAKE_HASH)
        with self.assertRaises(ValueError):
            reference("/FAKE/file.json", "A" * 64)


class FakeCompletionPayloadControls(unittest.TestCase):
    def test_fake_completion_shape_has_no_grant_authority(self):
        payload = completion_payload(**fake_completion_kwargs())
        self.assertEqual(payload["schema"], COMPLETION_SCHEMA)
        self.assertEqual(payload["candidate_head"], HEAD)
        self.assertEqual(payload["candidate_tree"], TREE)
        self.assertTrue(payload["independent_root_verification_required"])
        self.assertTrue(payload["not_a_grade_carry_adapter_or_next_stage_grant"])

    def test_boolean_observed_exit_is_not_integer_zero(self):
        args = fake_completion_kwargs()
        args["observed_guard_exit"] = True
        with self.assertRaises(ValueError):
            completion_payload(**args)

    def test_boolean_guard_exit_is_not_integer_zero(self):
        args = fake_completion_kwargs()
        args["guard"]["actual_exit_code"] = True
        with self.assertRaises(ValueError):
            completion_payload(**args)

    def test_nonzero_test_or_guard_exit_is_refused(self):
        for field, value in (("observed_guard_exit", 1), ("guard_exit", 1)):
            args = fake_completion_kwargs()
            if field == "observed_guard_exit":
                args[field] = value
            else:
                args["guard"]["actual_exit_code"] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                completion_payload(**args)

    def test_incomplete_cleanup_is_refused(self):
        args = fake_completion_kwargs()
        args["guard"]["cleanup"]["kernel_no_children"] = False
        with self.assertRaises(ValueError):
            completion_payload(**args)

    def test_candidate_head_variant_language_threads_and_roster_count_are_exact(self):
        mutations = (
            ("commit", "FAKE-other-head"),
            ("variant", "FAKE-wrong-label"),
            ("lang", "fr"),
            ("threads", 4),
        )
        for field, value in mutations:
            args = fake_completion_kwargs()
            args["header"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                completion_payload(**args)
        args = fake_completion_kwargs()
        args["header"]["documents"].pop(next(iter(args["header"]["documents"])))
        with self.assertRaises(ValueError):
            completion_payload(**args)

    def test_unknown_stage_is_refused(self):
        args = fake_completion_kwargs()
        args["stage"] = "FAKE-unknown"
        with self.assertRaises(ValueError):
            completion_payload(**args)


class FakeNeutralInvocationControls(unittest.TestCase):
    def test_frozen_argparse_also_accepts_equals_before_bare_path(self):
        args = fake_neutral_kwargs()
        args['argv'] = ['FAKE-scorer', '--run=/FAKE/baseline.json', '--run=/FAKE/run.json']
        self.assertEqual(neutral_invocation_payload(**args)['approved_scoring_runs'], args['approved_scoring_runs'])

    def test_frozen_scorer_uses_bare_paths_and_independent_catalog(self):
        args = fake_neutral_kwargs()
        payload = neutral_invocation_payload(**args)
        self.assertEqual(payload['approved_scoring_runs'], args['approved_scoring_runs'])
        args['argv'][-1] = 'M2timer12f874-H10=/FAKE/run.json'
        with self.assertRaises(ValueError):
            neutral_invocation_payload(**args)

    def test_run_order_and_duplicate_catalog_labels_are_refused(self):
        args = fake_neutral_kwargs()
        args['argv'] = ['FAKE-scorer', '--run', '/FAKE/run.json', '--run', '/FAKE/baseline.json']
        with self.assertRaises(ValueError):
            neutral_invocation_payload(**args)
        args = fake_neutral_kwargs()
        args['approved_scoring_runs'][0]['label'] = args['label']
        with self.assertRaises(ValueError):
            neutral_invocation_payload(**args)

    def test_fake_initial_neutral_invocation_shape(self):
        payload = neutral_invocation_payload(**fake_neutral_kwargs())
        self.assertEqual(payload["schema"], SCORER_INVOCATION_SCHEMA)
        self.assertEqual(payload["candidate_head"], HEAD)
        self.assertTrue(payload["root_verification_and_context_export_required"])

    def test_boolean_or_nonzero_scorer_exit_is_refused(self):
        for exit_code in (True, 1):
            args = fake_neutral_kwargs()
            args["actual_exit_code"] = exit_code
            with self.subTest(exit_code=exit_code), self.assertRaises(ValueError):
                neutral_invocation_payload(**args)

    def test_scorer_source_hash_must_match(self):
        args = fake_neutral_kwargs()
        args["scorer_source"]["sha256"] = FAKE_HASH
        with self.assertRaises(ValueError):
            neutral_invocation_payload(**args)

    def test_direct_run_path_must_be_in_actual_argv(self):
        args = fake_neutral_kwargs()
        args["direct_run"]["path"] = "/FAKE/not-in-argv.json"
        with self.assertRaises(ValueError):
            neutral_invocation_payload(**args)

    def test_initial_neutral_invocation_rejects_any_review_preload(self):
        args = fake_neutral_kwargs()
        args["argv"] = [*args["argv"], "--review", "/FAKE/prior-review.json"]
        with self.assertRaises(ValueError):
            neutral_invocation_payload(**args)

    def test_seed_requires_current_review_path_and_provenance(self):
        valid_seed = {"path": "/FAKE/current-review.json", "sha256": FAKE_HASH}
        args = fake_neutral_kwargs()
        args["argv"] = [*args["argv"], "--review", valid_seed["path"]]
        args["seed_current_review"] = valid_seed
        args["seed_provenance"] = {"FAKE": True}
        self.assertEqual(neutral_invocation_payload(**args)["seed_current_review"], valid_seed)
        for review, provenance, argv in (
            (valid_seed, None, ["FAKE-scorer", "--run", "/FAKE/baseline.json", "--run", "/FAKE/run.json", "--review", valid_seed["path"]]),
            (valid_seed, {"FAKE": True}, ["FAKE-scorer", "--run", "/FAKE/baseline.json", "--run", "/FAKE/run.json", "--review", "/FAKE/other.json"]),
            (None, {"FAKE": True}, ["FAKE-scorer", "--run", "/FAKE/baseline.json", "--run", "/FAKE/run.json"]),
        ):
            bad = fake_neutral_kwargs()
            bad["argv"] = argv
            bad["seed_current_review"] = review
            bad["seed_provenance"] = provenance
            with self.subTest(review=review, provenance=provenance), self.assertRaises(ValueError):
                neutral_invocation_payload(**bad)

    def test_duplicate_review_flags_are_not_a_single_current_seed(self):
        current = {"path": "/FAKE/current-review.json", "sha256": FAKE_HASH}
        args = fake_neutral_kwargs()
        args["argv"] = [*args["argv"], "--review", current["path"], "--review", current["path"]]
        args["seed_current_review"] = current
        args["seed_provenance"] = {"FAKE": True}
        with self.assertRaises(ValueError):
            neutral_invocation_payload(**args)

    def test_unknown_stage_is_refused(self):
        args = fake_neutral_kwargs()
        args["stage"] = "FAKE-unknown"
        with self.assertRaises(ValueError):
            neutral_invocation_payload(**args)


if __name__ == "__main__":
    raise SystemExit("FAKE controls are authored but unrun; use only after separate root admission")

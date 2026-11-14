"""Pure source/JSON projection controls, authored UNRUN; no native or model execution."""
from pathlib import Path
from types import SimpleNamespace
import copy
import json
import unittest
import native_guard as guard

SOURCE=Path(__file__).resolve().parents[3]/'src-tauri/src/extraction_acceptance_tests.rs'
PINS=Path(__file__).parent/'source-pins-878d4.json'

def require(value,message):
    if not value:raise ValueError(message)
S=SimpleNamespace(require=require)

class ExtractionProjectionControls(unittest.TestCase):
    def fixture(self):
        pins=json.loads(PINS.read_text())
        original={'schema':1,'source_revision':pins['head'],'source_files':[{'path':n,'sha256':v} for n,v in sorted(pins['source_sha256'].items())],'build_features':['ai-helper-stub','experimental-mtp'],'helper_path':'/FAKE/helper','helper_sha256':'a'*64,'build_receipt_path':'/FAKE/build','build_receipt_sha256':'b'*64}
        return original,pins,SOURCE.read_text()
    def test_actual_compiled_include_bytes_selects_exact12(self):
        names=guard.compiled_extraction_names(SOURCE.read_text(),S)
        self.assertEqual(names,guard.EXTRACTION_SOURCE_NAMES);self.assertEqual(len(names),12)
        self.assertNotIn('src-tauri/src/model_helper.rs',names)
    def test_projection_retains_all20_externally_and_metadata_unchanged(self):
        original,pins,source=self.fixture();before=copy.deepcopy(original)
        projected=guard.extraction_manifest_projection(original,pins,source,S)
        self.assertEqual(original,before);self.assertEqual(len(original['source_files']),20)
        self.assertEqual(len(projected['source_files']),12)
        self.assertEqual({n:v for n,v in projected.items() if n!='source_files'},{n:v for n,v in original.items() if n!='source_files'})
        self.assertEqual({f['path']:f['sha256'] for f in projected['source_files']},{n:pins['source_sha256'][n] for n in guard.EXTRACTION_SOURCE_NAMES})
    def test_include_name_path_mismatch_refused(self):
        source=SOURCE.read_text().replace('include_bytes!("main.rs")','include_bytes!("lib.rs")',1)
        with self.assertRaises(ValueError):guard.compiled_extraction_names(source,S)
    def test_added_removed_or_duplicate_compiled_source_refused(self):
        source=SOURCE.read_text()
        for changed in (source.replace('fn compiled_sources()', 'fn obsolete_sources()',1),source.replace('include_bytes!("main.rs")','not_include!("main.rs")',1),source.replace('fn compiled_sources()', 'fn compiled_sources() fn compiled_sources()',1),source.replace('"src-tauri/src/main.rs"','"src-tauri/src/FOREIGN.rs"',1)):
            with self.assertRaises(ValueError):guard.compiled_extraction_names(changed,S)
    def test_missing_duplicate_or_changed_external_pin_refused(self):
        for mutation in ('missing','duplicate','hash'):
            original,pins,source=self.fixture()
            if mutation=='missing':original['source_files'].pop()
            elif mutation=='duplicate':original['source_files'].append(original['source_files'][0])
            else:original['source_files'][0]['sha256']='0'*64
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):guard.extraction_manifest_projection(original,pins,source,S)
    def test_foreign_source_revision_refused(self):
        original,pins,source=self.fixture();original['source_revision']='FOREIGN'
        with self.assertRaises(ValueError):guard.extraction_manifest_projection(original,pins,source,S)
    def test_mtp_legacy23_plus12_invocations_retained(self):
        self.assertEqual(len(guard.CONTRACT_TESTS)+1,35)
        self.assertNotIn('model_helper::tests::summary_asks_found_first_whole_rules_status_and_the_language_twice',guard.CONTRACT_TESTS)

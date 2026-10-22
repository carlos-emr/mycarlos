#!/usr/bin/env python3
"""The first-party exception must not allow another path/git dependency."""
from pathlib import Path
import copy
import importlib.util
import unittest

SPEC = importlib.util.spec_from_file_location(
    "native_graph", Path(__file__).with_name("check-native-dependency-graph.py"))
GRAPH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GRAPH)


class NativeGraphTests(unittest.TestCase):
    def setUp(self):
        self.metadata = {"resolve": {"root": "app"}, "packages": [
            {"id": "app", "name": "mycarlos", "source": None},
            {"id": "glib", "name": "glib", "source": None,
             "manifest_path": str(GRAPH.ROOT / "src-tauri/vendor/glib/Cargo.toml")},
            {"id": "ios", "name": "tauri-plugin-ios-pdf", "source": None,
             "manifest_path": str(GRAPH.ROOT / "src-tauri/ios-pdf/Cargo.toml")},
            {"id": "tauri", "name": "tauri",
             "source": "registry+https://github.com/rust-lang/crates.io-index"},
        ]}

    def test_reviewed_first_party_path_is_accepted(self):
        GRAPH.validate_metadata(self.metadata)

    def test_another_path_dependency_is_refused(self):
        self.metadata["packages"].append({"id": "extra", "name": "extra", "source": None})
        with self.assertRaises(ValueError):
            GRAPH.validate_metadata(self.metadata)

    def test_first_party_name_cannot_hide_a_git_or_registry_replacement(self):
        for source in ["git+https://example.invalid/plugin", "registry+https://github.com/rust-lang/crates.io-index"]:
            metadata = copy.deepcopy(self.metadata)
            metadata["packages"][2]["source"] = source
            with self.assertRaises(ValueError):
                GRAPH.validate_metadata(metadata)

    def test_first_party_name_cannot_hide_another_local_path(self):
        self.metadata["packages"][2]["manifest_path"] = str(GRAPH.ROOT / "unreviewed/Cargo.toml")
        with self.assertRaises(ValueError):
            GRAPH.validate_metadata(self.metadata)

    def test_tauri_must_remain_upstream(self):
        self.metadata["packages"][3]["source"] = "git+https://example.invalid/tauri"
        with self.assertRaises(ValueError):
            GRAPH.validate_metadata(self.metadata)


if __name__ == "__main__":
    unittest.main()

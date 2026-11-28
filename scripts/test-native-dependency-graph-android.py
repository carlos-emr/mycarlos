#!/usr/bin/env python3
"""The dependency graph check accepts the reviewed first-party Android plugin and nothing else."""
from importlib.machinery import SourceFileLoader
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
check = SourceFileLoader(
    "check_native_dependency_graph", str(ROOT / "scripts/check-native-dependency-graph.py")
).load_module()
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"


def package(name, manifest=None, source=REGISTRY):
    return {
        "name": name,
        "id": f"{name} 1.0.0",
        "source": source,
        "manifest_path": str(manifest or f"/registry/{name}/Cargo.toml"),
    }


def metadata(**changes):
    packages = {
        "mycarlos": package("mycarlos", source=None),
        "tauri": package("tauri"),
        "glib": package("glib", ROOT / "src-tauri/vendor/glib/Cargo.toml", None),
        "wry": package("wry", ROOT / "src-tauri/vendor/wry/Cargo.toml", None),
        "tauri-plugin-single-instance": package(
            "tauri-plugin-single-instance",
            ROOT / "src-tauri/vendor/tauri-plugin-single-instance/Cargo.toml",
            None,
        ),
        "tauri-plugin-android-pdf": package(
            "tauri-plugin-android-pdf", ROOT / "src-tauri/android-pdf/Cargo.toml", None
        ),
        "tauri-plugin-android-trust": package(
            "tauri-plugin-android-trust", ROOT / "src-tauri/android-trust/Cargo.toml", None
        ),
        "tauri-plugin-ios-pdf": package(
            "tauri-plugin-ios-pdf", ROOT / "src-tauri/ios-pdf/Cargo.toml", None
        ),
    }
    packages.update(changes)
    return {
        "resolve": {"root": "mycarlos 1.0.0"},
        "packages": [value for value in packages.values() if value is not None],
    }


class DependencyGraph(unittest.TestCase):
    def test_the_reviewed_first_party_plugin_is_accepted(self):
        check.validate_metadata(metadata())

    def test_the_plugin_from_anywhere_else_is_refused(self):
        wrong = package("tauri-plugin-android-pdf", "/elsewhere/Cargo.toml", None)
        with self.assertRaises(ValueError):
            check.validate_metadata(metadata(**{"tauri-plugin-android-pdf": wrong}))

    def test_the_trust_plugin_from_anywhere_else_or_missing_is_refused(self):
        wrong = package("tauri-plugin-android-trust", "/elsewhere/Cargo.toml", None)
        with self.assertRaises(ValueError):
            check.validate_metadata(metadata(**{"tauri-plugin-android-trust": wrong}))
        with self.assertRaises(ValueError):
            check.validate_metadata(metadata(**{"tauri-plugin-android-trust": None}))

    def test_a_missing_plugin_or_another_path_package_is_refused(self):
        with self.assertRaises(ValueError):
            check.validate_metadata(metadata(**{"tauri-plugin-android-pdf": None}))
        with self.assertRaises(ValueError):
            check.validate_metadata(metadata(other=package("other", "/x/Cargo.toml", None)))


if __name__ == "__main__":
    unittest.main()

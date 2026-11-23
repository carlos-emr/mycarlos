#!/usr/bin/env python3
"""Confirm Cargo selects upstream Tauri, the reviewed local glib, wry and single-instance plugin, and first-party plugin code."""
from pathlib import Path
import json
import os
import subprocess

ROOT = Path(__file__).resolve().parents[1]


# First-party plugin crates whose entire source is reviewed in this repository.
FIRST_PARTY = {"tauri-plugin-android-pdf": "src-tauri/android-pdf/Cargo.toml"}


def validate_metadata(metadata):
    # cargo-audit cannot match advisories for path or git packages, so the only
    # packages allowed outside crates.io are this crate, the reviewed glib, wry and single-instance
    # plugin, and the first-party plugins whose whole source is in this repository.
    registry = "registry+https://github.com/rust-lang/crates.io-index"
    root = metadata["resolve"]["root"]
    outside = sorted(
        p["name"] for p in metadata["packages"]
        if p["source"] != registry and p["id"] != root
    )
    local_manifests = {
        "glib": ROOT / "src-tauri/vendor/glib/Cargo.toml",
        "tauri-plugin-single-instance": ROOT / "src-tauri/vendor/tauri-plugin-single-instance/Cargo.toml",
        "wry": ROOT / "src-tauri/vendor/wry/Cargo.toml",
        **{name: ROOT / path for name, path in FIRST_PARTY.items()},
    }
    if outside != sorted(local_manifests):
        raise ValueError(f"Unexpected packages outside crates.io: {outside}")
    for name in [*local_manifests, "tauri"]:
        packages = [p for p in metadata["packages"] if p["name"] == name]
        if len(packages) != 1:
            raise ValueError(f"Expected exactly one {name} dependency")
        package = packages[0]
        if name in local_manifests:
            expected = local_manifests[name].resolve()
            if package["source"] is not None or Path(package["manifest_path"]).resolve() != expected:
                raise ValueError(f"Cargo is not using the reviewed local {name} source")
        elif package["source"] != registry:
            raise ValueError("Tauri must use the upstream crates.io release for mobile live reload")


def main():
    metadata = json.loads(subprocess.check_output([
        os.environ.get("CARGO", "cargo"), "metadata", "--locked", "--format-version", "1",
        "--manifest-path", str(ROOT / "src-tauri/Cargo.toml"),
    ], text=True))
    validate_metadata(metadata)
    print("All-target graph selects upstream Tauri, the reviewed glib, wry and single-instance patches, and the first-party Android plugin")


if __name__ == "__main__":
    main()

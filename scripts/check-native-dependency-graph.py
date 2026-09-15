#!/usr/bin/env python3
"""Reject the removed HTTP stack and confirm Cargo selects the patched sources."""
from pathlib import Path
import json
import os
import subprocess
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def main():
    lock = tomllib.loads((ROOT / "src-tauri/Cargo.lock").read_text())
    forbidden = {"reqwest", "hyper", "hyper-util"}
    found = forbidden & {p["name"] for p in lock["package"]}
    if found:
        raise ValueError(f"Removed networking dependencies returned: {sorted(found)}")
    metadata = json.loads(subprocess.check_output([
        os.environ.get("CARGO", "cargo"), "metadata", "--locked", "--format-version", "1",
        "--manifest-path", str(ROOT / "src-tauri/Cargo.toml"),
    ], text=True))
    for name in ["glib", "tauri"]:
        packages = [p for p in metadata["packages"] if p["name"] == name]
        expected = ROOT / "src-tauri/vendor" / name / "Cargo.toml"
        if len(packages) != 1 or Path(packages[0]["manifest_path"]).resolve() != expected.resolve():
            raise ValueError(f"Cargo is not using the reviewed local {name} source")
    print("All-target graph excludes reqwest/hyper/hyper-util and selects both reviewed patches")


if __name__ == "__main__":
    main()

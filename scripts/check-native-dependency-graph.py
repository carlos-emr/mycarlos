#!/usr/bin/env python3
"""Confirm Cargo selects upstream Tauri and the reviewed local glib and wry."""
from pathlib import Path
import json
import os
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    metadata = json.loads(subprocess.check_output([
        os.environ.get("CARGO", "cargo"), "metadata", "--locked", "--format-version", "1",
        "--manifest-path", str(ROOT / "src-tauri/Cargo.toml"),
    ], text=True))
    # cargo-audit cannot match advisories for path or git packages, so the only
    # packages allowed outside crates.io are this crate and the reviewed glib and wry.
    registry = "registry+https://github.com/rust-lang/crates.io-index"
    root = metadata["resolve"]["root"]
    outside = sorted(
        p["name"] for p in metadata["packages"]
        if p["source"] != registry and p["id"] != root
    )
    if outside != ["glib", "wry"]:
        raise ValueError(f"Only glib and wry may come from outside crates.io, found: {outside}")
    for name in ["glib", "wry", "tauri"]:
        packages = [p for p in metadata["packages"] if p["name"] == name]
        if len(packages) != 1:
            raise ValueError(f"Expected exactly one {name} dependency")
        package = packages[0]
        if name in ("glib", "wry"):
            expected = ROOT / f"src-tauri/vendor/{name}/Cargo.toml"
            if Path(package["manifest_path"]).resolve() != expected.resolve():
                raise ValueError(f"Cargo is not using the reviewed local {name} source")
        elif package["source"] != registry:
            raise ValueError("Tauri must use the upstream crates.io release for mobile live reload")
    print("All-target graph selects upstream Tauri and the reviewed glib backport and wry patch")


if __name__ == "__main__":
    main()

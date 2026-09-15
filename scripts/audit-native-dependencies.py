#!/usr/bin/env python3
"""Audit upstream identities too: local patches must not hide future advisories."""
from pathlib import Path
import json
import os
import re
import subprocess
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def main():
    entries = json.loads((ROOT / "src-tauri/vendor/upstream.json").read_text())
    lock = (ROOT / "src-tauri/Cargo.lock").read_text()
    packages = tomllib.loads(lock)["package"]
    if len(entries) != 1 or entries[0]["name"] != "glib":
        raise ValueError("The reviewed glib dependency must be present exactly once")
    for entry in entries:
        name, version = entry["name"], entry["version"]
        candidates = [p for p in packages if p["name"] == name]
        if len(candidates) != 1 or candidates[0]["version"] != version or "source" in candidates[0]:
            raise ValueError(f"Expected exactly one patched {name} {version}")
        pattern = rf'(\[\[package\]\]\nname = "{re.escape(name)}"\nversion = "{re.escape(version)}"\n)'
        identity = ('source = "registry+https://github.com/rust-lang/crates.io-index"\n'
                    f'checksum = "{entry["archiveSha256"]}"\n')
        lock, count = re.subn(pattern, lambda match: match[1] + identity, lock)
        if count != 1:
            raise ValueError(f"Could not restore upstream audit identity: {name}")
    # Keep the full report, including glib's known warning. Source reconstruction
    # and optimized regression tests separately establish the two-line backport.
    with tempfile.TemporaryDirectory(prefix="mycarlos-audit-") as directory:
        audit_lock = Path(directory) / "Cargo.lock"
        audit_lock.write_text(lock)
        subprocess.run([os.environ.get("CARGO", "cargo"), "audit", "--file", str(audit_lock)], check=True)


if __name__ == "__main__":
    main()

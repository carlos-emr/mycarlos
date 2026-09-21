#!/usr/bin/env python3
"""Reconstruct each local dependency from its pinned release plus reviewed patch."""
from pathlib import Path
import hashlib
import json
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "src-tauri" / "vendor"


def file_contents(directory):
    result = {}
    for path in directory.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"Symlinks are not allowed in vendored source: {path}")
        if path.is_file():
            result[path.relative_to(directory).as_posix()] = path.read_bytes()
    return result


def verify():
    entries = json.loads((VENDOR / "upstream.json").read_text())
    if len(entries) != 1 or entries[0]["name"] != "glib":
        raise ValueError("The reviewed glib dependency must be present exactly once")
    # Anything else under vendor/ would be unreviewed source that no check covers.
    allowed = {"README.md", "upstream.json"} | {
        item for entry in entries for item in (entry["name"], f"{entry['name']}.patch")
    }
    unexpected = sorted(path.name for path in VENDOR.iterdir() if path.name not in allowed)
    if unexpected:
        raise ValueError(f"Unexpected entries in vendor/: {', '.join(unexpected)}")
    for entry in entries:
        name, version = entry["name"], entry["version"]
        if name != "glib":
            raise ValueError(f"Unexpected local dependency: {name}")
        with tempfile.TemporaryDirectory(prefix="mycarlos-vendor-") as temporary:
            temporary = Path(temporary)
            archive = temporary / "upstream.crate"
            url = f"https://static.crates.io/crates/{name}/{name}-{version}.crate"
            if entry["archiveUrl"] != url:
                raise ValueError("Unexpected upstream archive location")
            with urllib.request.urlopen(url, timeout=60) as response:
                archive.write_bytes(response.read())
            if hashlib.sha256(archive.read_bytes()).hexdigest() != entry["archiveSha256"]:
                raise ValueError(f"Upstream checksum mismatch: {name}")
            with tarfile.open(archive) as source:
                source.extractall(temporary, filter="data")
            expected = temporary / f"{name}-{version}"
            revision = json.loads((expected / ".cargo_vcs_info.json").read_text())["git"]["sha1"]
            if revision != entry["upstreamRevision"]:
                raise ValueError(f"Upstream revision mismatch: {name}")
            # Dependency snapshots do not need their own development lockfiles.
            for excluded in entry["excludedFiles"]:
                if excluded != "Cargo.lock":
                    raise ValueError(f"Unexpected excluded upstream file: {excluded}")
                (expected / excluded).unlink()
            subprocess.run(
                ["git", "apply", "--check", str(VENDOR / f"{name}.patch")],
                cwd=expected, check=True,
            )
            subprocess.run(
                ["git", "apply", str(VENDOR / f"{name}.patch")],
                cwd=expected, check=True,
            )
            original = file_contents(expected)
            actual = file_contents(VENDOR / name)
            changed = sorted(key for key in original.keys() | actual.keys()
                             if original.get(key) != actual.get(key))
            if changed:
                raise ValueError(f"Unreviewed changes in {name}: {', '.join(changed)}")
            print(f"Verified {name} {version}: {len(actual)} files match upstream plus patch")


if __name__ == "__main__":
    verify()

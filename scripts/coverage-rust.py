#!/usr/bin/env python3
"""Opt-in Linux host/default-feature/lib-test coverage; see COVERAGE-RUST.md."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

if sys.version_info < (3, 11):
    sys.exit("coverage-rust requires Python 3.11 or later")
import tomllib


ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "src-tauri/Cargo.toml"


def capture(command):
    return subprocess.check_output(command, cwd=ROOT, text=True, stderr=subprocess.STDOUT,
                                   timeout=30).strip()


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def snapshot():
    # Include untracked, nonignored tooling as well as every tracked input/fixture.
    names = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT
    ).decode().split("\0")
    files = {}
    for name in sorted(set(names) - {""}):
        path = ROOT / name
        if path.is_symlink():
            files[name] = {"symlink": os.readlink(path)}
        elif path.is_file():
            files[name] = {"sha256": digest(path)}
        elif not path.exists():
            files[name] = {"missing": True}
        else:
            raise RuntimeError(f"unsupported source input: {name}")
    return {"head": capture(["git", "rev-parse", "HEAD"]), "files": files}


def prerequisites():
    if sys.platform != "linux":
        raise RuntimeError("this runner currently supports Linux hosts only")
    blocked = [name for name, value in os.environ.items() if value and (
        name in {"RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC", "RUSTC_WRAPPER",
                 "RUSTC_WORKSPACE_WRAPPER", "RUSTC_BOOTSTRAP", "LLVM_PROFILE_FILE"}
        or name.startswith("CARGO_PROFILE_")
        or (name.startswith("CARGO_TARGET_") and name.endswith("_RUSTFLAGS")))]
    if blocked:
        raise RuntimeError("unset inherited coverage/compiler overrides: " + ", ".join(sorted(blocked)))
    pin = tomllib.loads((ROOT / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", pin):
        raise RuntimeError("expected an exact stable Rust version in rust-toolchain.toml")
    version = capture(["rustup", "run", pin, "rustc", "--version", "--verbose"])
    fields = dict(line.split(": ", 1) for line in version.splitlines() if ": " in line)
    host = fields["host"]
    if fields["release"] != pin or "linux" not in host:
        raise RuntimeError("the pinned compiler must match this Linux host")
    sysroot = Path(capture(["rustup", "run", pin, "rustc", "--print", "sysroot"]))
    tool_dir = sysroot / "lib/rustlib" / host / "bin"
    tools = {"cargo": sysroot / "bin/cargo", "rustc": sysroot / "bin/rustc",
             "profdata": tool_dir / "llvm-profdata", "cov": tool_dir / "llvm-cov"}
    versions = {"rustc": version}
    for key in ("profdata", "cov"):
        if not tools[key].is_file():
            raise RuntimeError(f"missing {key}; install: rustup component add --toolchain {pin} llvm-tools-preview")
        versions[key] = capture([str(tools[key]), "--version"])
        match = re.search(r"LLVM version (\d+\.\d+\.\d+)", versions[key])
        if not match or match.group(1) != fields["LLVM version"]:
            raise RuntimeError(f"{key} LLVM version does not match the pinned compiler")
    return pin, host, tools, versions


def allocate():
    parent = ROOT
    for name in ("coverage", "rust"):
        parent = parent / name
        if parent.is_symlink():
            raise RuntimeError(f"refusing symlink output directory: {parent}")
        parent.mkdir(mode=0o700, exist_ok=True)
    if "%" in str(parent):
        raise RuntimeError("output path must not contain LLVM profile expansion character %")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ-")
    result = Path(tempfile.mkdtemp(prefix=stamp, dir=parent))
    for name in ("target", "profiles", "build-profiles", "tmp", "logs", "report"):
        (result / name).mkdir(mode=0o700)
    return result


class Run:
    def __init__(self, directory, timeout, metadata):
        self.directory = directory
        self.deadline = time.monotonic() + timeout
        self.metadata = metadata
        self.save()

    def save(self):
        (self.directory / "run.json").write_text(json.dumps(self.metadata, indent=2) + "\n")

    def command(self, label, command, env, output=None, strict=False):
        stdout = output or self.directory / "logs" / f"{label}.stdout"
        stderr = self.directory / "logs" / f"{label}.stderr"
        record = {"label": label, "argv": [str(item) for item in command],
                  "stdout": str(stdout), "stderr": str(stderr)}
        self.metadata["commands"].append(record)
        self.save()
        print(f"{label}: logs in {self.directory / 'logs'}", flush=True)
        started = time.monotonic()
        process = None
        try:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"coverage budget exhausted before {label}")
            with stdout.open("xb") as out, stderr.open("xb") as err:
                process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=out, stderr=err,
                                           start_new_session=True)
                record["pid"] = process.pid
                record["exit_code"] = process.wait(timeout=remaining)
            # A descendant still running could write profiles after the merge.
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise RuntimeError(f"{label}: descendants remain after command exit")
            if record["exit_code"]:
                raise RuntimeError(f"{label} failed ({record['exit_code']}); see {stderr}")
            if strict and stderr.stat().st_size:
                raise RuntimeError(f"{label} emitted LLVM diagnostics; see {stderr}")
            if label == "test":
                for path in (stdout, stderr):
                    if re.search(rb"LLVM (?:Profile|Coverage) (?:Error|Warning)", path.read_bytes(), re.I):
                        raise RuntimeError(f"LLVM runtime diagnostics in {path}")
            return stdout
        finally:
            if process is not None:
                # Kill only this command's session/process group, including on interruption.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            record["seconds"] = round(time.monotonic() - started, 3)
            self.save()


def file_summaries(document):
    if document.get("type") != "llvm.coverage.json.export" or len(document.get("data", [])) != 1:
        raise RuntimeError("unexpected LLVM JSON export structure")
    files = document["data"][0]["files"]
    paths = [(ROOT / item["filename"]).resolve() for item in files]
    if len(set(paths)) != len(paths):
        raise RuntimeError("duplicate source filenames in LLVM export")
    return dict(zip(paths, files))


def execute(args, pin, host, tools, versions):
    before = snapshot()
    directory = allocate()
    print(f"Run directory: {directory}", flush=True)
    metadata = {"status": "running", "scope": "Linux host/default-feature/library tests; inline tests included",
                "toolchain": pin, "host": host, "versions": versions, "commands": [],
                "jobs": args.jobs, "timeout_seconds": args.timeout_seconds, "source_before": before}
    run = Run(directory, args.timeout_seconds, metadata)
    try:
        env = os.environ.copy()
        env.update({"RUSTUP_TOOLCHAIN": pin, "RUSTC": str(tools["rustc"]),
                    "RUSTC_WRAPPER": "", "RUSTC_WORKSPACE_WRAPPER": "",
                    "CARGO_ENCODED_RUSTFLAGS": "",
                    "CARGO_TARGET_DIR": str(directory / "target"), "CARGO_INCREMENTAL": "0",
                    "CARGO_BUILD_JOBS": str(args.jobs), "TMPDIR": str(directory / "tmp"),
                    "DEBUGINFOD_URLS": "",
                    "LLVM_PROFILE_FILE": str(directory / "build-profiles/%m-%p.profraw")})
        # Extra rustc arguments apply only to the selected project library test target.
        build = run.command("build", [str(tools["cargo"]), "rustc", "--manifest-path", str(MANIFEST),
            "--offline", "--locked", "--lib", "--profile", "test", "--target", host,
            "--jobs", str(args.jobs), "--message-format=json", "--", "-C", "instrument-coverage"], env)
        cargo = tomllib.loads(MANIFEST.read_text())
        lib_source = (MANIFEST.parent / cargo["lib"].get("path", "src/lib.rs")).resolve()
        artifacts = []
        finished = False
        for line in build.read_text().splitlines():
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue  # Build scripts may print non-JSON output.
            if not isinstance(item, dict):
                continue
            if item.get("reason") == "build-finished":
                finished = item.get("success") is True
            if (item.get("reason") == "compiler-artifact"
                and Path(item["manifest_path"]).resolve() == MANIFEST.resolve()
                and item["target"]["name"] == cargo["lib"]["name"]
                and Path(item["target"]["src_path"]).resolve() == lib_source
                and item["profile"].get("test") is True and item.get("executable")):
                artifacts.append(item)
        if not finished or len(artifacts) != 1:
            raise RuntimeError("Cargo did not report exactly one successful project library test executable")
        artifact = artifacts[0]
        binary = Path(artifact["executable"]).resolve()
        if not binary.is_file() or not binary.is_relative_to(directory / "target"):
            raise RuntimeError("Cargo test executable is outside the private target directory")
        metadata.update({"artifact": artifact, "executable_sha256": digest(binary)})
        env["LLVM_PROFILE_FILE"] = str(directory / "profiles/%m-%p.profraw")
        run.command("test", [str(binary), "--test-threads=1"], env)
        profiles = sorted((directory / "profiles").iterdir())
        if not profiles or any(path.is_symlink() or not path.is_file() or
                               path.suffix != ".profraw" or not path.stat().st_size for path in profiles):
            raise RuntimeError("missing, empty or unexpected raw profile files")
        metadata["profiles"] = {path.name: digest(path) for path in profiles}
        test_pid = next(item["pid"] for item in metadata["commands"] if item["label"] == "test")
        if not any(path.name.endswith(f"-{test_pid}.profraw") for path in profiles):
            raise RuntimeError("no raw profile from the main library test process")
        merged = directory / "report/merged.profdata"
        run.command("merge", [str(tools["profdata"]), "merge", "--sparse", "--failure-mode=any",
            f"--num-threads={args.jobs}", "-o", str(merged), *map(str, profiles)], env, strict=True)
        common = [str(binary), f"-instr-profile={merged}"]
        mapped_path = run.command("mapped-sources", [str(tools["cov"]), "export", *common,
            "--summary-only", f"--num-threads={args.jobs}"], env, strict=True)
        mapped = file_summaries(json.loads(mapped_path.read_text()))
        census = sorted((ROOT / "src-tauri/src").rglob("*.rs"))
        if any(path.is_symlink() for path in census):
            raise RuntimeError("symlink Rust sources are not supported")
        selected = sorted(set(census) & set(mapped))
        if not selected:
            raise RuntimeError("LLVM export contains no mapped project Rust source files")
        (directory / "report/source-census.json").write_text(json.dumps({
            "mapped": [str(path.relative_to(ROOT)) for path in selected],
            "unmapped": [str(path.relative_to(ROOT)) for path in census if path not in selected],
        }, indent=2) + "\n")
        sources = ["--sources", *map(str, selected)]
        run.command("report", [str(tools["cov"]), "report", *common,
                    f"--num-threads={args.jobs}", *sources], env,
                    directory / "report/summary.txt", strict=True)
        if not (directory / "report/summary.txt").stat().st_size:
            raise RuntimeError("LLVM produced an empty summary report")
        exported = run.command("json", [str(tools["cov"]), "export", *common, "--skip-functions",
            "--skip-expansions", f"--num-threads={args.jobs}", *sources], env,
            directory / "report/coverage.json", strict=True)
        document = json.loads(exported.read_text())
        if set(file_summaries(document)) != set(selected):
            raise RuntimeError("final JSON source set differs from the retained project source census")
        totals = document["data"][0]["totals"]
        for metric in ("lines", "functions", "regions"):
            value = totals[metric]
            if not 0 <= value["covered"] <= value["count"] or (metric == "lines" and not value["count"]):
                raise RuntimeError(f"invalid {metric} totals")
        run.command("lcov", [str(tools["cov"]), "export", *common, "--format=lcov",
            f"--num-threads={args.jobs}", *sources], env, directory / "report/lcov.info", strict=True)
        lcov = (directory / "report/lcov.info").read_text()
        lcov_sources = {(ROOT / line[3:]).resolve() for line in lcov.splitlines() if line.startswith("SF:")}
        if lcov_sources != set(selected):
            raise RuntimeError("LCOV source set differs from the retained project source census")
        if metadata["profiles"] != {path.name: digest(path) for path in (directory / "profiles").iterdir()}:
            raise RuntimeError("raw profiles changed while reporting")
        metadata["source_after"] = snapshot()
        if before != metadata["source_after"]:
            raise RuntimeError("source inputs changed during coverage; report is not a stable-source measurement")
        metadata.update({"status": "passed", "totals": totals})
        print((directory / "report/summary.txt").read_text(), flush=True)
        print(f"Coverage complete: {directory}", flush=True)
    except BaseException as error:
        metadata.update({"status": "failed", "error": f"{type(error).__name__}: {error}"})
        raise
    finally:
        run.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="check prerequisites only; no build or test")
    parser.add_argument("--jobs", type=int, choices=(1, 2), default=1, help="Cargo/LLVM jobs (default: 1)")
    parser.add_argument("--timeout-seconds", type=int, default=3600, help="total command budget, 60..14400 (default: 3600)")
    args = parser.parse_args()
    if not 60 <= args.timeout_seconds <= 14400:
        parser.error("--timeout-seconds must be between 60 and 14400")
    def interrupted(signum, _frame):
        raise InterruptedError(f"received signal {signum}")
    signal.signal(signal.SIGTERM, interrupted)
    try:
        pin, host, tools, versions = prerequisites()
        if args.check:
            print(json.dumps({"toolchain": pin, "host": host,
                              "tools": {key: str(value) for key, value in tools.items()},
                              "versions": versions}, indent=2))
        else:
            execute(args, pin, host, tools, versions)
    except (Exception, KeyboardInterrupt) as error:
        print(f"coverage-rust: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

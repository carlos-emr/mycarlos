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

    def command(self, label, command, env, output=None, strict=False, cwd=ROOT):
        stdout = output or self.directory / "logs" / f"{label}.stdout"
        stderr = self.directory / "logs" / f"{label}.stderr"
        record = {"label": label, "argv": [str(item) for item in command],
                  "cwd": str(cwd), "stdout": str(stdout), "stderr": str(stderr)}
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
                process = subprocess.Popen(command, cwd=cwd, env=env, stdout=out, stderr=err,
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


FLOOR_FILE = ROOT / "scripts/coverage-rust-floor.json"
FLOOR_METRICS = ("lines", "regions")


def percent(totals, metric):
    """Covered share of an LLVM totals entry, in percent (0.0 for an empty denominator)."""
    value = totals[metric]
    return 100.0 * value["covered"] / value["count"] if value["count"] else 0.0


def read_floor(path):
    """The pinned floors: whole percents for lines and regions, from a small JSON file."""
    document = json.loads(Path(path).read_text())
    if document.get("schemaVersion") != 1:
        raise RuntimeError(f"{path}: unsupported floor file version")
    floors = {}
    for metric in FLOOR_METRICS:
        value = document.get(metric)
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
            raise RuntimeError(f"{path}: {metric} must be a whole percent from 0 to 100")
        floors[metric] = value
    return floors


def check_floors(totals, floors):
    """Problems (empty when none) for every floored metric whose coverage is below its floor."""
    return [f"{metric} coverage {percent(totals, metric):.2f}% is below the floor of {floor}%"
            for metric, floor in floors.items() if percent(totals, metric) < floor]


def ratcheted_floors(totals, current=None):
    """New floors: the measured percent rounded down to a whole percent, never below the current floor."""
    current = current or {}
    return {metric: max(int(percent(totals, metric)), current.get(metric, 0)) for metric in FLOOR_METRICS}


def write_floor(path, floors):
    """Writes the floors, keeping whatever else the file already holds (other keys are not ours to drop)."""
    document = {"schemaVersion": 1}
    if Path(path).exists():
        existing = json.loads(Path(path).read_text())
        if isinstance(existing, dict):
            document.update(existing)
    document.update(floors)
    document["schemaVersion"] = 1
    Path(path).write_text(json.dumps(document, indent=2) + "\n")


def settle_floor(metadata, totals, floors):
    """After a complete run: records the floors and, below one, marks the run `below-floor` and raises."""
    metadata.update({"status": "passed", "totals": totals, "floors": floors})
    problems = check_floors(totals, floors)
    if problems:
        # The run itself is complete and kept; only the gate fails.
        metadata["status"] = "below-floor"
        raise RuntimeError("; ".join(problems))


def record_failure(metadata, error):
    """Notes how a run ended badly. A run already marked `below-floor` keeps that status: it was
    complete, and only the gate failed; the error text is kept either way."""
    if metadata.get("status") != "below-floor":
        metadata["status"] = "failed"
    metadata["error"] = f"{type(error).__name__}: {error}"


def report_totals(path):
    document = json.loads(Path(path).read_text())
    if document.get("type") != "llvm.coverage.json.export" or len(document.get("data", [])) != 1:
        raise RuntimeError("unexpected LLVM JSON export structure")
    return document["data"][0]["totals"]


def requested_floors(args):
    """Floors in force: the floor file's (when named), each overridden by an explicit option."""
    floors = read_floor(args.floor_file) if args.floor_file else {}
    for metric in FLOOR_METRICS:
        explicit = getattr(args, f"fail_under_{metric}")
        if explicit is not None:
            floors[metric] = explicit
    return floors


FEATURE_LIST = re.compile(r"[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*")


def build_command(tools, host, args):
    """The one Cargo command that builds the instrumented library test executable.

    With `--target-dir` the build goes into that (shared) target directory, as `cargo test` and the
    app build use it: no `--target`, so the dependencies are the very ones those commands build and
    nothing is built twice. Without it the run keeps a private directory and an explicit host target.
    """
    command = [str(tools["cargo"]), "rustc", "--manifest-path", str(MANIFEST), "--offline", "--locked",
               "--lib", "--profile", "test"]
    if args.features:
        command += ["--features", args.features]
    if not args.target_dir:
        command += ["--target", host]
    command += ["--jobs", str(args.jobs), "--message-format=json", "--", "-C", "instrument-coverage"]
    return command


def execute(args, pin, host, tools, versions):
    before = snapshot()
    directory = allocate()
    print(f"Run directory: {directory}", flush=True)
    target_dir = Path(args.target_dir).resolve() if args.target_dir else directory / "target"
    scope = "Linux host/library tests; inline tests included"
    metadata = {"status": "running",
                "scope": scope + (f"; features {args.features}" if args.features else "; default features"),
                "target_dir": str(target_dir), "features": args.features or "",
                "toolchain": pin, "host": host, "versions": versions, "commands": [],
                "jobs": args.jobs, "timeout_seconds": args.timeout_seconds, "source_before": before}
    run = Run(directory, args.timeout_seconds, metadata)
    try:
        env = os.environ.copy()
        env.update({"RUSTUP_TOOLCHAIN": pin, "RUSTC": str(tools["rustc"]),
                    "RUSTC_WRAPPER": "", "RUSTC_WORKSPACE_WRAPPER": "",
                    "CARGO_ENCODED_RUSTFLAGS": "",
                    "CARGO_TARGET_DIR": str(target_dir), "CARGO_INCREMENTAL": "0",
                    "CARGO_BUILD_JOBS": str(args.jobs), "TMPDIR": str(directory / "tmp"),
                    "DEBUGINFOD_URLS": "",
                    "LLVM_PROFILE_FILE": str(directory / "build-profiles/%m-%p.profraw")})
        # Extra rustc arguments apply only to the selected project library test target.
        build = run.command("build", build_command(tools, host, args), env)
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
        if not binary.is_file() or not binary.is_relative_to(target_dir):
            raise RuntimeError("Cargo test executable is outside the target directory")
        metadata.update({"artifact": artifact, "executable_sha256": digest(binary)})
        env["LLVM_PROFILE_FILE"] = str(directory / "profiles/%m-%p.profraw")
        # Children that clear their environment use LLVM's relative fallback filename.
        # Keep those profiles inside the same private, validated profile inventory.
        run.command("test", [str(binary), "--test-threads=1"], env, cwd=directory / "profiles")
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
        floors = requested_floors(args)
        print((directory / "report/summary.txt").read_text(), flush=True)
        print("Measured: " + ", ".join(f"{metric} {percent(totals, metric):.2f}%" for metric in FLOOR_METRICS),
              flush=True)
        settle_floor(metadata, totals, floors)
        print(f"Coverage complete: {directory}", flush=True)
    except BaseException as error:
        record_failure(metadata, error)
        raise
    finally:
        run.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="check prerequisites only; no build or test")
    parser.add_argument("--jobs", type=int, choices=(1, 2), default=1, help="Cargo/LLVM jobs (default: 1)")
    parser.add_argument("--timeout-seconds", type=int, default=3600, help="total command budget, 60..14400 (default: 3600)")
    parser.add_argument("--features", metavar="LIST",
                        help="comma-separated Cargo features of the library under test, e.g. ai-helper-stub "
                             "(the features the ordinary test step uses, so this run can replace it)")
    parser.add_argument("--target-dir", metavar="PATH",
                        help="build into this existing Cargo target directory (the one `cargo test` and "
                             "the app build use) instead of a private one, so nothing is built twice; "
                             "it is never cleaned")
    parser.add_argument("--fail-under-lines", type=int, metavar="PERCENT",
                        help="fail when line coverage is below this whole percent")
    parser.add_argument("--fail-under-regions", type=int, metavar="PERCENT",
                        help="fail when region coverage is below this whole percent")
    parser.add_argument("--floor-file", metavar="PATH",
                        help=f"pinned floors for both metrics, e.g. {FLOOR_FILE.relative_to(ROOT)}; "
                             "explicit --fail-under-* options override it")
    parser.add_argument("--check-report", metavar="COVERAGE_JSON",
                        help="check an earlier run's report/coverage.json against the floors; no build or test")
    parser.add_argument("--ratchet-report", metavar="COVERAGE_JSON",
                        help="raise --floor-file to the whole percents of an earlier run's report/coverage.json; "
                             "never lowers a floor")
    args = parser.parse_args()
    if not 60 <= args.timeout_seconds <= 14400:
        parser.error("--timeout-seconds must be between 60 and 14400")
    for metric in FLOOR_METRICS:
        value = getattr(args, f"fail_under_{metric}")
        if value is not None and not 0 <= value <= 100:
            parser.error(f"--fail-under-{metric} must be a whole percent from 0 to 100")
    if args.ratchet_report and not args.floor_file:
        parser.error("--ratchet-report needs --floor-file")
    if args.features and not FEATURE_LIST.fullmatch(args.features):
        parser.error("--features must be comma-separated feature names")
    if args.target_dir and not Path(args.target_dir).is_dir():
        parser.error("--target-dir must be an existing directory")
    def interrupted(signum, _frame):
        raise InterruptedError(f"received signal {signum}")
    signal.signal(signal.SIGTERM, interrupted)
    try:
        if args.check_report or args.ratchet_report:
            # Reports are plain JSON: no toolchain, build or test.
            totals = report_totals(args.check_report or args.ratchet_report)
            if args.check_report:
                print("Measured: " + ", ".join(f"{metric} {percent(totals, metric):.2f}%"
                                               for metric in FLOOR_METRICS))
                floors = requested_floors(args)
                if not floors:
                    # A report checked against nothing would pass whatever it holds.
                    raise RuntimeError("--check-report needs --floor-file or --fail-under-lines/--fail-under-regions")
                problems = check_floors(totals, floors)
                if problems:
                    raise RuntimeError("; ".join(problems))
            else:
                current = read_floor(args.floor_file) if Path(args.floor_file).exists() else {}
                floors = ratcheted_floors(totals, current)
                write_floor(args.floor_file, floors)
                print(f"Floors now: {floors}")
            return 0
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

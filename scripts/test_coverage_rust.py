#!/usr/bin/env python3
"""Tests for the floor gate of scripts/coverage-rust.py (no build, test run or LLVM tools needed).

    python3 -m unittest scripts/test_coverage_rust.py
"""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

if sys.version_info < (3, 11):
    raise unittest.SkipTest("coverage-rust requires Python 3.11 or later")

SCRIPT = Path(__file__).resolve().parent / "coverage-rust.py"
spec = importlib.util.spec_from_file_location("coverage_rust", SCRIPT)
coverage_rust = importlib.util.module_from_spec(spec)
spec.loader.exec_module(coverage_rust)


def totals(lines, regions, functions=(10, 10)):
    """An LLVM `totals` object from (covered, count) pairs."""
    def entry(pair):
        return {"covered": pair[0], "count": pair[1],
                "percent": 100.0 * pair[0] / pair[1] if pair[1] else 0.0}
    return {"lines": entry(lines), "regions": entry(regions), "functions": entry(functions)}


def report(path, **kwargs):
    document = {"type": "llvm.coverage.json.export", "version": "2.0.1",
                "data": [{"files": [], "totals": totals(**kwargs)}]}
    Path(path).write_text(json.dumps(document))


def run_main(*argv):
    """main() with the given command line; returns (exit status, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", ["coverage-rust.py", *argv]), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        status = coverage_rust.main()
    return status, out.getvalue(), err.getvalue()


class FloorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)

    def floor_file(self, lines, regions, version=1):
        path = self.path / "floor.json"
        path.write_text(json.dumps({"schemaVersion": version, "lines": lines, "regions": regions}))
        return path

    def test_percent_is_the_covered_share_and_an_empty_denominator_is_zero(self):
        self.assertEqual(coverage_rust.percent(totals((50, 100), (1, 4)), "lines"), 50.0)
        self.assertEqual(coverage_rust.percent(totals((50, 100), (1, 4)), "regions"), 25.0)
        self.assertEqual(coverage_rust.percent(totals((0, 0), (0, 0)), "lines"), 0.0)

    def test_a_floor_file_must_hold_two_whole_percents(self):
        self.assertEqual(coverage_rust.read_floor(self.floor_file(81, 70)), {"lines": 81, "regions": 70})
        for lines, regions, version in [(101, 70, 1), (-1, 70, 1), (81.5, 70, 1), (True, 70, 1),
                                        ("81", 70, 1), (81, None, 1), (81, 70, 2)]:
            with self.subTest(lines=lines, regions=regions, version=version):
                with self.assertRaises(RuntimeError):
                    coverage_rust.read_floor(self.floor_file(lines, regions, version))

    def test_a_metric_below_its_floor_is_reported_and_one_at_it_is_not(self):
        floors = {"lines": 80, "regions": 70}
        self.assertEqual(coverage_rust.check_floors(totals((80, 100), (70, 100)), floors), [])
        self.assertEqual(coverage_rust.check_floors(totals((81, 100), (71, 100)), floors), [])
        problems = coverage_rust.check_floors(totals((7999, 10000), (7000, 10000)), floors)
        self.assertEqual(len(problems), 1)
        self.assertIn("lines coverage 79.99%", problems[0])
        both = coverage_rust.check_floors(totals((1, 2), (1, 2)), floors)
        self.assertEqual(len(both), 2)
        # With no floors there is nothing to fail.
        self.assertEqual(coverage_rust.check_floors(totals((0, 10), (0, 10)), {}), [])

    def test_the_ratchet_rounds_down_and_never_lowers_a_floor(self):
        measured = totals((8199, 10000), (7050, 10000))
        self.assertEqual(coverage_rust.ratcheted_floors(measured), {"lines": 81, "regions": 70})
        self.assertEqual(coverage_rust.ratcheted_floors(measured, {"lines": 85, "regions": 60}),
                         {"lines": 85, "regions": 70})
        # A measurement at exactly a whole percent is that percent.
        self.assertEqual(coverage_rust.ratcheted_floors(totals((82, 100), (70, 100))),
                         {"lines": 82, "regions": 70})

    def test_a_report_that_is_not_an_llvm_export_is_refused(self):
        bad = self.path / "bad.json"
        bad.write_text(json.dumps({"type": "other", "data": []}))
        with self.assertRaises(RuntimeError):
            coverage_rust.report_totals(bad)

    def test_check_report_fails_below_the_floor_file_and_passes_at_it(self):
        floor = self.floor_file(80, 70)
        below, at = self.path / "below.json", self.path / "at.json"
        report(below, lines=(79, 100), regions=(70, 100))
        report(at, lines=(80, 100), regions=(70, 100))
        status, _, err = run_main("--check-report", str(below), "--floor-file", str(floor))
        self.assertEqual(status, 1)
        self.assertIn("lines coverage 79.00% is below the floor of 80%", err)
        status, out, _ = run_main("--check-report", str(at), "--floor-file", str(floor))
        self.assertEqual(status, 0)
        self.assertIn("Measured: lines 80.00%, regions 70.00%", out)

    def test_an_explicit_option_overrides_the_floor_file(self):
        floor = self.floor_file(80, 70)
        measured = self.path / "measured.json"
        report(measured, lines=(79, 100), regions=(70, 100))
        status, _, _ = run_main("--check-report", str(measured), "--floor-file", str(floor),
                                "--fail-under-lines", "70")
        self.assertEqual(status, 0)
        # With no file, the options alone are the floors.
        status, _, err = run_main("--check-report", str(measured), "--fail-under-regions", "71")
        self.assertEqual(status, 1)
        self.assertIn("regions coverage", err)

    def test_out_of_range_options_are_refused(self):
        measured = self.path / "measured.json"
        report(measured, lines=(1, 1), regions=(1, 1))
        for option in ("--fail-under-lines", "--fail-under-regions"):
            with self.subTest(option=option), self.assertRaises(SystemExit):
                with contextlib.redirect_stderr(io.StringIO()):
                    run_main("--check-report", str(measured), option, "101")

    def test_ratchet_report_writes_the_floor_file_and_never_lowers_it(self):
        floor = self.path / "floor.json"
        first = self.path / "first.json"
        report(first, lines=(8199, 10000), regions=(7050, 10000))
        status, _, _ = run_main("--ratchet-report", str(first), "--floor-file", str(floor))
        self.assertEqual(status, 0)
        self.assertEqual(coverage_rust.read_floor(floor), {"lines": 81, "regions": 70})
        worse = self.path / "worse.json"
        report(worse, lines=(5000, 10000), regions=(9000, 10000))
        run_main("--ratchet-report", str(worse), "--floor-file", str(floor))
        self.assertEqual(coverage_rust.read_floor(floor), {"lines": 81, "regions": 90})

    def test_check_report_with_no_floors_named_is_an_error_not_a_silent_pass(self):
        measured = self.path / "measured.json"
        report(measured, lines=(10, 100), regions=(10, 100))
        status, _, err = run_main("--check-report", str(measured))
        self.assertEqual(status, 1)
        self.assertIn("--check-report needs --floor-file or --fail-under", err)

    def test_a_run_below_its_floor_keeps_that_status_and_its_error_text(self):
        metadata = {"status": "running"}
        with self.assertRaises(RuntimeError) as raised:
            coverage_rust.settle_floor(metadata, totals((70, 100), (90, 100)), {"lines": 80, "regions": 80})
        self.assertEqual(metadata["status"], "below-floor")
        self.assertEqual(metadata["floors"], {"lines": 80, "regions": 80})
        # The handler main() runs for any exception must not turn it into a plain failure.
        coverage_rust.record_failure(metadata, raised.exception)
        self.assertEqual(metadata["status"], "below-floor")
        self.assertIn("lines coverage 70.00% is below the floor of 80%", metadata["error"])
        self.assertTrue(metadata["error"].startswith("RuntimeError: "))

    def test_a_run_at_its_floor_is_passed_and_any_other_error_is_failed(self):
        metadata = {"status": "running"}
        coverage_rust.settle_floor(metadata, totals((80, 100), (80, 100)), {"lines": 80, "regions": 80})
        self.assertEqual(metadata["status"], "passed")
        coverage_rust.record_failure(metadata, OSError("disk full"))
        self.assertEqual(metadata["status"], "failed")
        self.assertEqual(metadata["error"], "OSError: disk full")

    def test_the_ratchet_keeps_the_other_keys_of_the_floor_file(self):
        floor = self.path / "floor.json"
        floor.write_text(json.dumps({"schemaVersion": 1, "lines": 70, "regions": 60, "note": "kept", "extra": {"a": 1}}))
        measured = self.path / "measured.json"
        report(measured, lines=(8100, 10000), regions=(5000, 10000))
        run_main("--ratchet-report", str(measured), "--floor-file", str(floor))
        written = json.loads(floor.read_text())
        self.assertEqual(written["lines"], 81)
        self.assertEqual(written["regions"], 60)  # never lowered
        self.assertEqual(written["note"], "kept")
        self.assertEqual(written["extra"], {"a": 1})

    def test_ratchet_report_needs_a_floor_file(self):
        measured = self.path / "measured.json"
        report(measured, lines=(1, 1), regions=(1, 1))
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            run_main("--ratchet-report", str(measured))


class BuildCommandTests(unittest.TestCase):
    TOOLS = {"cargo": Path("/fake/cargo")}

    def command(self, **options):
        args = mock.Mock(features=None, target_dir=None, jobs=1)
        for name, value in options.items():
            setattr(args, name, value)
        return coverage_rust.build_command(self.TOOLS, "x86_64-unknown-linux-gnu", args)

    def test_a_private_run_names_the_host_target_and_the_default_features(self):
        command = self.command()
        self.assertEqual(command[:2], ["/fake/cargo", "rustc"])
        self.assertIn("--target", command)
        self.assertEqual(command[command.index("--target") + 1], "x86_64-unknown-linux-gnu")
        self.assertNotIn("--features", command)
        self.assertEqual(command[-3:], ["--", "-C", "instrument-coverage"])

    def test_a_shared_target_directory_has_no_explicit_target_so_dependencies_are_shared(self):
        command = self.command(target_dir="/some/target")
        self.assertNotIn("--target", command)

    def test_the_features_are_passed_through_and_only_to_the_library_build(self):
        command = self.command(features="ai-helper-stub")
        self.assertEqual(command[command.index("--features") + 1], "ai-helper-stub")
        # The instrumentation flag stays after `--`, so it reaches only the selected library unit.
        self.assertLess(command.index("--features"), command.index("--"))
        self.assertEqual(command[command.index("--") + 1:], ["-C", "instrument-coverage"])

    def test_features_must_be_names_and_a_shared_target_must_exist(self):
        for bad in ("a b", "a;b", "--x", "a,,b", ",a"):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                run_main("--check", "--features", bad)
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            run_main("--check", "--target-dir", "/no/such/directory/anywhere")


if __name__ == "__main__":
    unittest.main()

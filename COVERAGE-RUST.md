# Rust coverage

`python3 scripts/coverage-rust.py` is an optional Linux coverage run. It compiles and runs the
complete default, nonignored **library test suite** for the pinned compiler's host target, then
merges its recorded profiles with matching LLVM tools. Normal Cargo, frontend and release commands
are unchanged. See [frontend coverage](COVERAGE.md) for the separate TypeScript report.

The build uses `cargo rustc --lib --profile test -- -C instrument-coverage` to instrument only the
project library test crate. Dependencies retain their existing profile settings and are exercised
by the same tests, without coverage counters in dependency code that is outside the report's
denominator. Cargo's special `test` profile builds the selected library with its test harness and
`cfg(test)`; it does not select additional test targets. See the supported
[cargo rustc command](https://doc.rust-lang.org/cargo/commands/cargo-rustc.html).

## Prerequisites and commands

Use Python 3.11 or later, Git, rustup, the exact compiler in `rust-toolchain.toml`, and the Linux
native libraries required by the ordinary Tauri build. Cargo dependencies must already be available
locally: the coverage build uses `--offline --locked`. Install the optional LLVM component for that
compiler (currently 1.98.0):

```bash
rustup component add --toolchain 1.98.0 llvm-tools-preview
python3 scripts/coverage-rust.py --check
python3 scripts/coverage-rust.py
```

`--check` only verifies the compiler, host, inherited compiler overrides, and exact LLVM version
match; it does not compile or test. The runner never installs tools or changes the default toolchain.
Unset inherited `RUSTFLAGS`, encoded Rust flags, compiler wrappers, profile overrides or
`LLVM_PROFILE_FILE` if the prerequisite check identifies them.

The default is one Cargo/LLVM job and one test thread. `--jobs 2` permits two build/merge jobs.
`--timeout-seconds 3600` sets the total subprocess budget; accepted values are 60 through 14400.
A timeout, interruption, test failure, leftover child process, LLVM diagnostic, missing profile or
incomplete report returns a nonzero exit status. On shared hosts, acquire the existing heavy-job
and browser/global leases before invoking the runner, just as for ordinary native tests.

## Outputs and isolation

Each invocation creates a fresh private directory under the already ignored `coverage/rust/`.
The runner accepts no reusable target/output directory and performs no deletion or `cargo clean`.
The normal `src-tauri/target`, shared build caches and earlier reports are not reused or cleaned.
Allow enough disk space for a complete native dependency build and instrumented library test binary.

The run retains:

- `target/`, `profiles/`, `build-profiles/` and `tmp/`: private build and runtime data. Build-time
  profiles are separate and never merged into the test report. `%m-%p.profraw` names distinguish
  instrumented binaries and processes, including self-spawned test helpers. The test binary runs
  with `profiles/` as its working directory: children that clear their environment can write LLVM's
  relative `default_%m_%p.profraw` fallback there. These files enter the same validated profile
  inventory and merge as profiles written through `LLVM_PROFILE_FILE`.
- `logs/`: exact Cargo JSON artifact output, test stdout/stderr and LLVM command diagnostics.
- `report/summary.txt`, `report/coverage.json`, `report/lcov.info` and `report/merged.profdata`:
  the human summary, JSON, LCOV and merged profile.
- `report/source-census.json`: mapped project Rust sources and separately listed unmapped sources.
- `run.json`: completion status, commands, versions, selected Cargo artifact, executable/profile
  hashes, each command's working directory and before/after hashes of tracked and nonignored
  untracked source inputs. A failed run retains its partial outputs for diagnosis; only
  `status: "passed"` denotes a complete run.

The executable is selected from Cargo's machine-readable `compiler-artifact` record for this
library's manifest, target name and source path, with `profile.test` set. It must reside in the fresh
target directory. The runner does not guess a hashed executable filename. Commands run in their
own process groups; interruption and timeout terminate those groups before returning.

## Reading the denominator

The final reports retain only mapped `src-tauri/src/**/*.rs` project files. A preliminary LLVM
summary discovers mappings; explicit source lists then filter all final reports, and their JSON
and LCOV file sets are checked against the retained census. Dependencies, the vendored GLib patch,
Rust's standard library and build scripts do not contribute to the reported project totals.
Mapped code that was never executed remains in the LLVM denominator with zero counts.

This is **Linux host, default-feature, library-test coverage, including inline test code and test
helpers**. Default features currently enable no optional features. The denominator includes
`#[cfg(test)]` code compiled into those library sources; it is not a production-only percentage.
Unmapped files are listed separately rather than represented as invented zero counts. In
particular, `main.rs`, disabled features and code selected only for other platforms may be absent.
Integration tests, doctests, browser/native UI tests and other operating systems are outside this
run. Region coverage is not branch coverage; no full-project claim is made. A floor on the run's line and region totals is described below.

Only profiles actually flushed by the library test process and its children are merged. Sandboxed
children can be denied profile-file writes, and deliberately killed or aborting helpers may never
flush counters. Their missing execution is not proof of untested code or complete helper-process
coverage. Visible LLVM runtime diagnostics fail the run, but subprocesses that capture their own
stderr can conceal such diagnostics. Keep this limitation alongside any quoted percentage.

The implementation follows Rust's [source-based coverage guide](https://doc.rust-lang.org/rustc/instrument-coverage.html),
Cargo's [JSON message contract](https://doc.rust-lang.org/cargo/reference/external-tools.html#json-messages),
and the standard [llvm-profdata](https://llvm.org/docs/CommandGuide/llvm-profdata.html) and
[llvm-cov](https://llvm.org/docs/CommandGuide/llvm-cov.html) commands. The optional `llvm-tools-preview`
component can change with the compiler; the runner requires its LLVM version to match rustc.

## Coverage floor (a ratchet)

`scripts/coverage-rust-floor.json` pins two whole percents, `lines` and `regions`: the totals of the
measured run rounded **down**. First measured at `0d6b6061` (24 Nov 2026): lines 87.75% (62,966 of
71,754), regions 87.84% (111,946 of 127,436), functions 83.07% (5,731 of 6,899), so the floor is 87 and 87;
counting production code only (without the `#[cfg(test)]` lines) the line figure is about 82%. A run fails, after its report is complete and kept (`run.json` says
`status: "below-floor"`), when either total is lower:

```bash
python3 scripts/coverage-rust.py --floor-file scripts/coverage-rust-floor.json --timeout-seconds 7200
python3 scripts/coverage-rust.py --fail-under-lines 80 --fail-under-regions 70   # explicit floors
```

An explicit `--fail-under-lines` / `--fail-under-regions` overrides the same metric from the file.
The percentages are those of the denominator above (Linux host, default features, library tests,
inline test code included): they say how much of that code the tests run, nothing about other
platforms or production-only code.

The floor only goes up. After a run that improved coverage, raise it from the run's own report and
commit the file in the same change as the tests that earned it:

```bash
python3 scripts/coverage-rust.py --ratchet-report coverage/rust/<run>/report/coverage.json \
  --floor-file scripts/coverage-rust-floor.json
```

`--ratchet-report` never lowers a floor, and `--check-report <coverage.json> --floor-file ...` checks
an earlier report without building or testing. Both need no toolchain. `python3 -m unittest
scripts/test_coverage_rust.py` tests the gate. Never lower the file to make a run pass: add tests, or
say in the change why code left the denominator.

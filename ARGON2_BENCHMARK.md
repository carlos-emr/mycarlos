# Argon2id device benchmark record

- **Purpose:** tune copied-vault guessing cost without making patient unlock unusable
- **Current parameters:** Argon2id v1.3, 64 MiB, 3 iterations, 4 lanes, 32-byte output
- **Status:** repeatable harness and an in-app speed test implemented; representative
  physical-device results open

Run the benchmark in release mode on an otherwise idle target:

```sh
cargo test --release --manifest-path src-tauri/Cargo.toml \
  benchmark_argon2id_unlock_work_factor -- --ignored --nocapture --test-threads=1
```

The harness performs five derivations and reports every sample, the median, and the maximum. Run it
with `--release` as above (a plain debug build of the harness is not the evaluation build either),
do not compare virtualized CI timings with physical devices, and do not record the test
passphrase as though it were a patient credential. Simulator/emulator numbers are supplementary
only.

## On the device: the speed test in the app

A test cannot run on a phone, so the app carries the same measurement, on every platform the app
runs on. The Windows, macOS and Android evaluation downloads install on a device. The iOS
download runs only in the Simulator, whose lines say "Simulator"; an iPhone needs a build signed
for it (see `TESTING.md`). An Android emulator's line looks like a phone's, so always name the
device. Write down the source commit from the download's `BUILD.txt` as well.

1. Close other apps, and let the device cool if it is warm. Stay on the Security screen while the
   test runs, and do nothing else in the app: leaving it loses the result.
2. Open myCarlos, unlock any vault (a throwaway one will do), and open **Security**.
3. Under **Speed test, for testers**, choose **Run speed test** and wait for the line below it. It
   takes a few seconds, longer on an older phone.
4. Copy the line into the table below, with the device's make and model, its operating system's
   version, and whether it was warm or on low battery.
5. Run it three times, a minute apart, and record each line.

The line looks like this:

```text
5 runs: 812, 820, 815, 830, 811 ms. Median 815 ms, longest 830 ms. Argon2id, 64 MiB, 3 passes,
4 lanes. android aarch64, myCarlos 0.1.0. Evaluation build.
```

It uses a made-up passphrase and salt, reads no vault and changes nothing. To copy the line on a
phone, press and hold it. The native app prevents overlap with another speed test or
passphrase operation. A competing operation asks you to wait and try again; it is not queued.
Manual and idle locking remain available while the test runs.

**Which build.** The evaluation downloads are debug builds in which the key derivation itself is
compiled at the same optimization level as in a release (see the `dev` profile in
`src-tauri/Cargo.toml`), with checks a release leaves out and without a release's link-time
optimization. Their lines end "Evaluation build." and
may fill the table below, marked as such. A release build should be no slower, for that reason;
how much faster has **not been measured**. The runs on the development container (below) differ
more from one run to the next than from one kind of build to the other, so they cannot tell. To
settle it, time a release build and an evaluation build on the same idle device. A line ending
"Release build." comes from a release build.

**Reading the numbers.** The four lanes are computed one after another, on one thread: the
Argon2 library the app uses does not run them in parallel. A faster phone with more cores does
not shorten the wait by its cores, and figures published for Argon2 run in parallel do not
compare. Every run sets up its own 64 MiB, as an unlock does; the first may still be slower, with
the processor and its caches cold, and is as much a result as the others.

What the speed test does not measure, and still has to be watched by hand: the memory the app
uses at its peak, whether the screen stays responsive during an unlock, and whether the system
ends the app under memory pressure.

## Required measurements

| Platform | Oldest supported physical device/OS | Build and toolchain | Samples (ms) | Median/max | Peak memory | Thermal/battery notes | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Windows | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| macOS | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| Android | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| iOS | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

For every target, also measure cold launch plus unlock, five consecutive unlocks, background/resume,
and the slowest supported device while thermally constrained. Record whether the UI remains
responsive and whether the OS terminates the process under memory pressure.

## Supplementary results (not physical devices)

These do not fill the table above. They say only that the harness runs and what a fast computer
gives.

| Where | Build and toolchain | Samples (ms) | Median/max | Notes |
| --- | --- | --- | --- | --- |
| Development container (Linux under WSL2, virtualized; Intel Core i7-12700H, 6 cores given) | release, rustc 1.98.0 | 156, 143, 155, 161, 154 | 155 / 161 | 2026-09-29, test harness; the machine was running other builds |
| The same | as the evaluation builds (debug, key derivation optimized), rustc 1.98.0 | 209, 183, 162, 172, 180 | 180 / 209 | the same day, the same conditions |
| The same | release, rustc 1.98.0, a second run | 258, 258, 241, 352, 304 | 258 / 352 | the same day; slower than the first release run, which shows how much the machine's other work weighs |

## Decision gate

The application owner and independent security reviewer must approve a versioned parameter set only
after the physical-device table is complete. If parameters change, increment the stored KDF policy
version or add an explicitly supported parameter profile; never reinterpret an existing header's
parameters. Rewrap the random master key after a successful authenticated unlock rather than
rewriting document objects.

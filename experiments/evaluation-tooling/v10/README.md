# V10 bounded-owner clock successor

This experimental source backup is a narrow successor to the adjacent V9
snapshot. V9's fixed Friday calendar cutoff would reject later work even when an
operator supplied a new, finite execution grant. V10 removes that calendar-only
restriction. It does not extend any running grant or supply execution authority.

Relative to V9, `entry.py` and `safety.py` remove the calendar clamps,
`coordinator.py` updates one error message, and `test_owner_window.py` adds 21 pure
mocked controls. Every other Python file, including process observation and
cleanup code, is byte-identical to V9. The original V9 snapshot is preserved.

Each stage still requires a fresh, immutable grant with matching finite UTC and
BOOTTIME deadlines and a live verified owner. Its maximum grant duration is
7,200 seconds; each H10/M8 phase remains capped at 3,000 seconds, including its
10-second cleanup reserve. Bootstrap remains capped at 60 seconds, inherited
parent deadlines may shorten it, and the controller retains its full-phase-fit
admission check and 70-second post-run reserve. Clock rollback cannot extend the
original BOOTTIME cap. Quality, safety, input identity, CPU and ownership checks
are unchanged.

This remains tied to application commit
`6595b3c25beb32c2cbd44892698c3fd66265ad2f` and its V9 runtime constraints. It is
source only and is not a portable or automatically authorized launcher. No grants,
execution receipts, private inputs, clinical outputs, models or credentials are
included. Synthetic grant dictionaries in mock tests use `/FAKE/` paths.

To restore source, first verify `source-manifest.json` has SHA-256
`63e59cb4bc15c19fef00241b34f11fd3b79da84c35737bcd820d852ab4b40ef6`, then verify
its exact 19-file Python inventory and hashes. Copy those files and the manifest
to an isolated directory with independent regular files owned by the intended
runner user, mode `0400`, one link each, and no symlinks or bytecode/native import
files. Git does not preserve `0400`; Python entry requires `-I -B`. Restore does
not replace fresh source/runtime qualification or a newly bound execution grant.

All 161 bounded mocked controls passed: the previous 140 plus 21 weekend-date,
clock-jump, nonfinite/expired deadline, cap, cleanup and partial-window cases.
Real native/process/signal/scheduler primitives were blocked before test imports.
Source and result review closed without findings, and the exact entry package
verifier passed. No new model, native build or live kernel run was performed for
this source change, and no performance or quality improvement is claimed.

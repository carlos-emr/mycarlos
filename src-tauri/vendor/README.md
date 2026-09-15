# Reviewed native dependency patches

This directory contains the complete, pinned glib crates.io source snapshot. Its
license and source revision record are preserved. `upstream.json` records the
original archive checksum; `glib.patch` contains the complete local change.

Run `python3 scripts/verify-native-vendor.py` from the repository root. It downloads
the checksum-pinned archive, applies the patch, and compares every file against
the checked-in source. Unexpected additions, removals, edits, and symlinks fail.
Python 3.11+ and Git are required. This is a provenance check, not an independent
security audit. Review patch and provenance changes together.

## glib 0.18.5

`glib.patch` backports exactly the two-line fix from
[gtk-rs-core PR #1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343), commit
`b5a4071e439bef2b5eea76c3aa25e5ae84839e34` (merged as `05dff0e`), for
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html).
`VariantStrIter::impl_get` now passes a mutable pointer reference to GLib's
out-argument instead of allowing a C function to mutate an immutable reference.

The package retains its upstream version; it does not pretend to be an upstream
fixed release. `security-tests/glib-variant` exercises `next`, `next_back`, `last`,
`nth`, and `nth_back` under release optimization, where the original defect occurs.
The existing GTK/Tauri API and encrypted vault format are unchanged. In the local
control run, this same optimized suite against the unpatched 0.18.5 release
terminated with SIGSEGV; all five tests pass with the backport.

## Tauri uses the upstream release

The previous Tauri patch and source snapshot have been removed to restore mobile
live reload. Tauri 2.11.5 comes directly from crates.io; its mobile development
proxy uses reqwest/hyper/hyper-util again. This is an intentional development
tradeoff, not a false-positive classification of Socket's package warning.
See [the dependency review](../../../DEPENDENCY_REVIEW.md).

## Audit and retirement

`check-native-dependency-graph.py` ensures Cargo selects the glib backport
and upstream Tauri. `audit-native-dependencies.py` audits a temporary lockfile that
restores glib's original registry identity, so future upstream advisories remain
visible. The original glib warning
is still reported; source verification and optimized tests establish this specific
backport. No advisory is ignored and the real lockfile is not rewritten by audit.

The glib source patch adds maintenance work. Prefer a compatible stable upstream
release incorporating the fix, then remove the patch and rerun all platform builds
and tests. Tauri 3 alpha was considered but is not adopted as a production-safety shortcut.

This backport addresses the identified glib defect. It does not approve
patient data, make Linux a supported release, replace device testing, or satisfy
the remaining security/recovery/signing gates in `MVP_STATUS.md`.

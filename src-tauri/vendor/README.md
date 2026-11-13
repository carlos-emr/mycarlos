# Reviewed native dependency patches

This directory contains pinned glib and llama-cpp-2 crates.io source snapshots.
Their license declarations and source revision records are preserved.
`upstream.json` records each original archive checksum and any excluded development
lockfile; the matching `.patch` file contains the complete local change.

Run `python3 scripts/verify-native-vendor.py` from the repository root. It downloads
the checksum-pinned archive, applies the patch, and compares every file against
the checked-in source. Unexpected additions, removals, edits, and symlinks fail.
Python 3.11.4+ and Git are required. This is a provenance check, not an independent
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

## Experimental llama-cpp-2 0.1.160

`llama-cpp-2.patch` adds an optional context-owned CPU worker pool using public
native APIs. The application creates it lazily after answer confinement. The
binding synchronizes work and destroys the context/backend before freeing the
pool and joining its workers. Its sys crate and native library remain upstream
0.1.160. This is an unbuilt, unevaluated experiment; no speed improvement or
cross-platform qualification is claimed. Persistent idle polling may offset the
saved worker setup cost.

The snapshot retains the upstream MIT OR Apache-2.0 license declaration and all
published files except its development `Cargo.lock`, as recorded in
`upstream.json`. The 627,549-byte GGUF file is the unchanged upstream vocabulary
test fixture with zero tensors; it contains no inference model weights or runtime
data. The application lockfile selects this local binding explicitly.

## Audit and retirement

`check-native-dependency-graph.py` ensures Cargo selects the glib backport,
the experimental llama-cpp-2 binding and upstream Tauri.
`audit-native-dependencies.py` audits a temporary lockfile that restores both
patched packages' original registry identities, so future upstream advisories
remain visible. The original glib warning
is still reported; source verification and optimized tests establish this specific
backport. No advisory is ignored and the real lockfile is not rewritten by audit.

Both source patches add maintenance work. Retire the experimental llama-cpp-2
patch if it does not produce a verified benefit, or replace it with an appropriate
upstream API after qualification. For glib, prefer a compatible stable upstream
release incorporating the fix, then remove the patch and rerun all platform builds
and tests. Tauri 3 alpha was considered but is not adopted as a production-safety shortcut.

This backport addresses the identified glib defect. It does not approve
patient data, make Linux a supported release, replace device testing, or satisfy
the remaining security/recovery/signing gates in `MVP_STATUS.md`.

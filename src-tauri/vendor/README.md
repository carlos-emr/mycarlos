# Reviewed native dependency patches

This directory contains complete, pinned crates.io source snapshots for glib and
the Windows single-instance plugin. Their licenses and source revisions are
preserved. `upstream.json` records the original archive checksums; each named
`.patch` contains the complete local change.

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

## tauri-plugin-single-instance 2.4.0 (Windows only)

The exact compatible upstream release is pinned; Tauri remains upstream 2.11.5.
The local patch changes Windows transport, adds pure framing/lifecycle modules,
and documents the Windows teardown contract on the public function.
Linux and macOS plugin sources are retained unmodified and the application only
depends on this crate on Windows. `tauri-plugin-single-instance.patch` is the
complete delta from the checksum-pinned archive, including the codec tests.
The unused upstream development `Cargo.lock` is explicitly excluded in the
provenance record, as allowed by the verifier; the application lock is authoritative.

The upstream Windows receiver used an unbounded C-string read and pipe-separated
arguments. This patch reads only the checked `WM_COPYDATA.cbData` allocation,
requires strict UTF-8 and a new NUL-separated protocol, caps it at 256 KiB, and
rejects legacy frames. Supported arguments retain spaces, Unicode and literal
pipes without splitting. Non-Unicode OS arguments or working directories are
refused before sending; replacement characters are never substituted.

A second launch waits up to ten seconds total for the first IPC window and its
distinct acknowledgement. Reservation/creation/transport failures fail closed;
an existing mutex never falls through to another GUI setup, nor does timeout
count as success. A timeout can still mean the callback ran but its acknowledgement
was lost; the sender does not retry automatically. Older receivers returning `1`
for an unknown protocol cannot falsely acknowledge this handoff. The callback
must only enqueue work, without file/provider I/O or a synchronous UI wait.

Window userdata stays in a Rust-owned `Box` throughout creation and is moved into
managed state on success. `WM_CREATE` clears/checks LastError around the ambiguous
userdata write and rejects creation on failure. Native window callbacks only
borrow the allocation; the Box drops after confirmed `DestroyWindow` success.
Callbacks hold their own app/callback references, and nested callbacks are refused
rather than aliasing an active `FnMut`. Windows public teardown rejects other
threads, retains the HWND/userdata/reservation after failed destruction, and
allows an owner-thread retry. No state lock crosses native destruction callbacks;
nested/repeated teardown cannot close resources twice. Owned mutex handles close
on setup errors and after successful IPC window destruction. These changes require independent native-source review
and real Windows lifecycle tests; pure host tests do not establish OS delivery.

Run the actual codec's host tests with:

```sh
rustc --edition=2021 --test security-tests/windows53-wire.rs -o /tmp/mycarlos-windows53-wire
/tmp/mycarlos-windows53-wire
rustc --edition=2021 --test security-tests/windows53-lifecycle.rs -o /tmp/mycarlos-windows53-lifecycle
/tmp/mycarlos-windows53-lifecycle
```

The Windows application registers the plugin first and keeps one pre-created
receive queue for startup and forwarded arguments. The executable's PDF helper
dispatch precedes Unicode GUI-argument preflight and single-instance setup.
The callback queues work before its acknowledgement and schedules a fixed,
payload-free DOM notification from outside the window procedure. The UI serializes
and coalesces refreshes, including arrivals during an import; failure does not
start an autonomous retry. Locked screens still show only a count. No renderer
permission or CSP change accompanies the notification.

This does not implement installer registrations, Windows 11 Share identity or
mobile sharing. Synthetic browser and host tests are not evidence of Windows OS
delivery or completion of all of #53; actual Windows lifecycle checks remain due.

## Audit and retirement

`check-native-dependency-graph.py` ensures Cargo selects both reviewed patches
and upstream Tauri. `audit-native-dependencies.py` audits a temporary lockfile that
restores both original registry identities, so future upstream advisories remain
visible. The original glib warning
is still reported; source verification and optimized tests establish this specific
backport. No advisory is ignored and the real lockfile is not rewritten by audit.

These source patches add maintenance work. Prefer compatible stable upstream
releases incorporating the fixes, then remove the patches and rerun platform builds
and tests. Tauri 3 alpha was considered but is not adopted as a production-safety shortcut.

This backport addresses the identified glib defect. It does not approve
patient data, make Linux a supported release, replace device testing, or satisfy
the remaining security/recovery/signing gates in `MVP_STATUS.md`.

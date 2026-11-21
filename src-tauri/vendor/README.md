# Reviewed native dependency patches

This directory contains the complete, pinned crates.io source snapshots of glib and
wry. Their licenses and source revision records are preserved. `upstream.json`
records each original archive checksum; `glib.patch` and `wry.patch` contain the
complete local changes.

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

## wry 0.55.1

`wry.patch` changes how Wry's macOS and iOS webview answers a page's camera and
microphone question (#359 PR 7). Upstream's `WKUIDelegate` method
`webView:requestMediaCapturePermissionForOrigin:...` grants every request. The
patch makes it ask one plain function, `media_capture_allowed`, which grants only
video alone or video with sound, from the main frame of `tauri://localhost` (the
app's own bundled page, default port); everything else is `WKPermissionDecision::Deny`,
without a prompt. Linux and Windows already decide this in `src/camera_permission.rs`,
and Android's is its manifest and Wry's Kotlin handler.

The change is three files, all under `src/wkwebview/class/`:

- `media_capture_policy.rs` (new): the decision, in plain Rust, using nothing from
  Wry or Cocoa, so that the app's tests compile and run it on any host
  (`camera_permission.rs` includes the file).
- `mod.rs`: one line registering it.
- `wry_web_view_ui_delegate.rs`: the method above asks it, after
  a compile-time check that its numbers for the capture types are the ones
  objc2-web-kit names (a mismatch stops the build).

Where it applies: WebKit calls this delegate method only on macOS 12 and later and iOS 15 and
later. On macOS 10.13 to 11 and on iOS 14.5 to 14.8 (the app's iOS minimum is 14.5) it is never called,
so WebKit's own default answers and the patch's decision is not applied there. That is the
same as before the patch. The fix for it is to raise those minimums, which is a product decision.

Carrying it to a new Wry: take the new release, apply `wry.patch` (the delegate method is
the only place that can conflict), update `upstream.json` (`version`,
`archiveSha256`, `upstreamRevision`, `archiveUrl`; `[patch.crates-io]` names only the path, so it has no version to change),
run `python3 scripts/verify-native-vendor.py`, and run the camera tests. If the new Wry
has a hook for this decision, drop the patch. Cargo.lock's wry entry has no source or
checksum while it is patched; `audit-native-dependencies.py` restores them for the
advisory audit, so Wry's advisories stay visible.

## Tauri uses the upstream release

The previous Tauri patch and source snapshot have been removed to restore mobile
live reload. Tauri 2.11.5 comes directly from crates.io; its mobile development
proxy uses reqwest/hyper/hyper-util again. This is an intentional development
tradeoff, not a false-positive classification of Socket's package warning.
See [the dependency review](../../../DEPENDENCY_REVIEW.md).

## Audit and retirement

`check-native-dependency-graph.py` ensures Cargo selects the glib backport,
the patched wry and upstream Tauri. `audit-native-dependencies.py` audits a temporary lockfile that
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

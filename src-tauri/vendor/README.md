# Reviewed native dependency patches

These are complete, pinned crates.io source snapshots. Their licenses and source
revision records are preserved. `upstream.json` records the original archive
checksums; the adjacent `.patch` files contain every local code/manifest change.
`tauri/Cargo.lock` is excluded because a dependency's development lockfile is not
used by our build. Keeping it would misleadingly inventory an unused HTTP stack.

Run `python3 scripts/verify-native-vendor.py` from the repository root. It downloads
each checksum-pinned archive, applies the patch, and compares every file against
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

## Tauri 2.11.5

`tauri.patch` removes the mobile development-server HTTP proxy, its reqwest/rustls
dependencies, and their TLS feature flags. The existing bundled-asset protocol is
preserved; desktop development is unchanged. No replacement HTTP client is added.

**Mobile live reload is intentionally unavailable.** `tauri android dev` and
`tauri ios dev` fail at compile time with an explanation. Use
`npm run tauri android build -- --debug --apk --target aarch64 --ci` or
`npm run tauri ios build -- --debug --target aarch64-sim --no-sign --ci`, then
install the resulting evaluation build. These commands enable Tauri's
`custom-protocol` feature to bundle local assets, including in debug builds.
Do not confuse a debug build with Tauri's network-backed `dev` configuration.

The source change removes reqwest, hyper-util, and the associated HTTP stack from
the shared all-target lockfile, including Android/iOS. The Rust dialog/filesystem
plugins and our vault commands remain available.

## Audit and retirement

`check-native-dependency-graph.py` ensures Cargo selects these sources and rejects
reintroduction of reqwest/hyper/hyper-util. `audit-native-dependencies.py` audits a
temporary lockfile that restores the original registry identities of patched
packages, so future upstream advisories remain visible. The original glib warning
is still reported; source verification and optimized tests establish this specific
backport. No advisory is ignored and the real lockfile is not rewritten by audit.

Local source patches add maintenance work. Prefer a compatible stable upstream
release incorporating the glib fix and optional/removable mobile development
networking, then remove the patches and rerun all platform builds and tests.
Tauri 3 alpha was considered but is not adopted as a production-safety shortcut.

These patches address the identified dependency issues. They do not approve
patient data, make Linux a supported release, replace device testing, or satisfy
the remaining security/recovery/signing gates in `MVP_STATUS.md`.

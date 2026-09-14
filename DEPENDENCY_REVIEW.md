# Dependency review — PR #1

The [Socket comment on the initial import](https://github.com/carlos-emr/mycarlos/pull/1#issuecomment-5670042450)
flagged `jsdom@29.0.1`, `data-urls@7.0.0`, and `hyper-util@0.1.20` for possible
obfuscation. These were package-level warnings with confidence 0.90, not a claim
that 90% of the application source was obfuscated or that a package was malicious.

## Removed dependencies

Component tests now run in headless Chromium through Vitest's Playwright
provider, sharing the Playwright version/browser already used by end-to-end
tests. This removes the need for jsdom and its simulated DOM/parsing tree,
including data-urls. All 38 component tests are retained. Tests use the app's CSS,
real drag-transfer objects, and accessibility checks with color contrast enabled.

The JavaScript `@tauri-apps/plugin-dialog` package is also removed. Only the
browser preview referenced it, through an unreachable native branch: the app
entry point selects `VaultApp` for native runtimes. The preview now uses browser
APIs only. Native imports/exports continue to use the Rust dialog and filesystem
plugins, which are actively needed for trusted pickers and mobile file access.

Compared with the preceding lockfile, the npm graph has **27 fewer package
entries (330 → 303)**: 36 removed and 9 added. These counts include optional
platform packages, so an individual machine installs fewer. The additions are
the version-matched `@vitest/browser-playwright@4.1.11` provider and its support
packages. Existing retained package versions are unchanged. The removed packages
are absent from both the lockfile's installed-package entries and a fresh
`npm ci`; Vitest's optional peer declaration for jsdom does not install it.

This resolves our dependency exposure to the two npm packages by removal. It
is not a conclusion that either package was malicious or a false positive, nor
a guarantee about how Socket will display historical alerts. No scanner warning
has been suppressed or marked acceptable.

## Retained dependencies

- Rust encryption, key derivation, password-strength checking, zeroization, and
  atomic file writes remain on their existing libraries. Reimplementing them to
  reduce package count would increase custom security-sensitive code.
- Tauri's native dialog/filesystem plugins remain in use. The renderer has no
  direct filesystem capability.
- `@testing-library/react`, `@testing-library/user-event`, and DOM assertions
  remain useful for existing component tests. Axe and its Playwright integration
  serve component and end-to-end accessibility checks respectively.
- SBOM generators, the formatter, compiler, and build tools retain their specific
  development/CI roles.

### Remaining Socket finding: hyper-util

The full path is **Tauri → reqwest → hyper-util**. In Tauri 2.11.5, reqwest is a
[mobile-target dependency](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/Cargo.toml),
used by its
[mobile development-server proxy](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/protocol/tauri.rs).
`cargo tree --locked --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --invert hyper-util`
reports no path for our Windows target. The shared Cargo.lock still records it
for mobile builds. Removing it from that lockfile by hand or forking Tauri solely
to avoid a warning is not justified by the available evidence.

The published hyper-util crate's SHA-256 matches Cargo.lock. Its `src/lib.rs` and
runtime adapter documentation in `src/rt/tokio.rs` are readable; it records source
revision `b23a13e2b7ee73e15ba008cd9b19dcd2d3861957`. This was a source spot check,
not a full package audit. A checksum establishes consistency with the lockfile,
not safety. The detailed organization alert view was inaccessible, so the finding
remains **unresolved**. Obtain the flagged file/range or detection rationale from
Socket before classifying it or selecting an upstream fix.

## Other audit results

A fresh npm installation reports zero known vulnerabilities. That is a separate
check from obfuscation/malware detection, not a security certification.

The [initial standalone supply-chain run](https://github.com/carlos-emr/mycarlos/actions/runs/34890522374)
passed, but its Rust audit log reports `glib@0.18.5` `RUSTSEC-2024-0429` as an
**unsoundness warning**. A successful job does not mean that finding disappeared.
The Linux support/release restriction in the README remains in place. Native
source, features, and Cargo.lock are unchanged by this dependency cleanup.

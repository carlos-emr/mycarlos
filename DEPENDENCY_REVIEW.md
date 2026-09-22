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
- `unicode-normalization` (0.1.25, the unicode-rs project, pure Rust, already in
  the locked graph through Tauri) is now a direct dependency: passphrases are
  normalized to NFC before key derivation so the same visible passphrase derives
  the same key whichever composition form a keyboard produces. Its only
  dependency, `tinyvec`, was already locked.

## Native remediation

### Mobile live reload restored

At the user's request, mobile live reload is restored using the original upstream
Tauri 2.11.5 release. The local Tauri source snapshot and proxy-removal patch are
removed. Its reqwest/hyper/hyper-util chain and supporting dependencies return to
the lockfile, restoring the original 485-package Rust graph with only glib patched.
Original locked versions are preserved. The npm dependency cleanup remains intact.

The earlier removal saved 20 packages but disabled Android/iOS live reload and
introduced a Tauri fork to maintain. Fast mobile iteration is the chosen tradeoff
for now. The proxy is used in Tauri's mobile development configuration; packaged
apps continue loading bundled assets. This does not assert that the HTTP packages
are malicious, risk-free, or a false positive, and no Socket alert is suppressed.

All **51 Rust files** in the published hyper-util 0.1.20 crate were previously
compared byte-for-byte with recorded upstream revision
`b23a13e2b7ee73e15ba008cd9b19dcd2d3861957`; they match. Socket's detailed organization
alert view was inaccessible, so the precise detection rationale remains unknown.
The warning may return now that the dependency is restored.

The development CSP permits the selected computer's HMR WebSocket on port 1421,
including physical-device connections. The production CSP remains unchanged. A
browser regression checks a hot update without navigation at a non-localhost
address; CI compiles the mobile development proxy on Android and iOS in addition
to building standalone packages. UI updates are distinct from Rust edits, which
require an automatic rebuild and app relaunch.

### Linux glib fix backported

The pinned local glib 0.18.5 source contains exactly the two-line fix from
[gtk-rs-core PR #1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343) for
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html).
The affected iterator now passes an explicitly mutable output pointer. A separate
optimized regression suite covers every affected iterator method; debug-only
testing is insufficient for this optimizer-sensitive defect. The identical suite
against the unpatched published release crashed with SIGSEGV; all five tests pass
with the backport.

A compatible stable upgrade was considered: Tauri 2.11.5 still depends on GTK's
older glib line, while Tauri 3 is an alpha. We chose the narrow backport over
introducing an alpha framework across every platform. Linux remains an evaluation
pending review and device validation; fixing one defect does not approve release.

### Provenance, audit, and maintenance

[Native patch notes](src-tauri/vendor/README.md) contain the exact deltas, pinned
archive checksums/source revisions, development tradeoff, and retirement criteria.
CI reconstructs the complete glib source snapshot from its checksum-verified release
plus patch, then checks that Cargo selects the glib backport and upstream Tauri. Licenses are preserved;
package versions are not changed to impersonate upstream fixed releases.

Local source patches can disappear from registry-only advisory scanning. Our
audit helper restores the glib upstream identity in a temporary audit lockfile,
retaining the original glib warning and future advisories. It does not change the
real lockfile or ignore an advisory. The source verification and optimized tests
are the evidence for this specific backport, independent of scanner status.

The remaining glib patch adds maintenance responsibility. Retire it once a
compatible stable upstream release provides the same fix. Encryption libraries,
our vault implementation, encrypted format, and native file handling are unchanged.

### Remaining advisory warnings

The [native dependency CI run](https://github.com/carlos-emr/mycarlos/actions/runs/34980156900)
on the patched sources passes the existing audit gate, but is not warning-free.
It reports six unmaintained-package warnings (`proc-macro-error` and five `unic-*`
crates), plus the original glib unsoundness warning retained for upstream tracking.
The glib source fix is verified separately as described above. The unmaintained
packages still need an upstream migration or replacement review before release;
a passing default audit does not establish that every dependency is maintained.

### Previous removal validation (historical)

All seven jobs passed in the linked run for code commit `c5f682b`: Windows, macOS,
Linux, Android, iOS simulator, browser tests, and dependency/SBOM checks. Windows
passed 59 native tests and Linux passed 62 (four subprocess helpers are ignored in
the main run and invoked by their parent tests); Linux also passed all five optimized
backport regressions. Windows installation and the GUI subsystem check passed.
This run predates restoration of mobile live reload and is historical evidence.
The restoration triggers fresh checks, including both mobile development builds.
Device testing and release review remain separate gates.

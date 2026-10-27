# Dependency review — PR #1

The [Socket comment on the initial import](https://github.com/carlos-emr/mycarlos/pull/1#issuecomment-5670042450)
flagged `jsdom@29.0.1`, `data-urls@7.0.0`, and `hyper-util@0.1.20` for possible
obfuscation. These were package-level warnings with confidence 0.90, not a claim
that 90% of the application source was obfuscated or that a package was malicious.

## Removed dependencies

Component tests now run in headless Chromium through Vitest's Playwright
provider, sharing the Playwright version/browser already used by end-to-end
tests. This removes the need for jsdom and its simulated DOM/parsing tree,
including data-urls. All existing component tests are retained. Tests use the app's CSS,
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
- `unicode-normalization` (0.1.25, the unicode-rs project, pure Rust) is now a
  direct dependency: passphrases are normalized to NFC before key derivation so
  the same visible passphrase derives the same key whichever composition form a
  keyboard produces. It adds one package to the Rust lockfile (485 → 486); its
  only dependency, `tinyvec`, was already locked.
- `webkit2gtk` (=2.0.2) is now a direct Linux-only dependency, pinned to the version Tauri and Wry
  already use, as `webview2-com` is on Windows: the camera dialog needs WebKitGTK's media-stream
  setting turned on and its permission requests answered (`src-tauri/src/camera_permission.rs`).
  It adds no package to the Rust lockfile.
- RustCrypto `cms` (=0.2.3), `x509-cert` (=0.2.5), `p256` (=0.14.0), `ecdsa` (=0.17.0) and
  `der` (=0.7.10) are direct dependencies, pinned exactly. They are pure Rust and all
  Apache-2.0 OR MIT. They check the signature on PDFs CARLOS signed for a patient
  (`src-tauri/src/signed_pdf.rs`, #55): the CMS SignedData, its certificate and the
  ECDSA P-256 signature, which is what "Verified" rests on. Writing a DER and ECDSA
  parser here instead would add custom security-sensitive code.
  - The CMS/X.509 format stack stays on `der` 0.7, `spki` 0.7 and `const-oid` 0.9.
    P-256 verification moves to `p256` 0.14 / `ecdsa` 0.17 / `elliptic-curve` 0.14,
    whose `crypto-bigint` 0.7.10 satisfies RUSTSEC-2026-0387 (fixed in 0.7.6+).
    The compatible 0.7.6 release is yanked; Cargo selects non-yanked 0.7.10.
  - The previous `p256` 0.13 / `elliptic-curve` 0.13 line requires `crypto-bigint` 0.5,
    so it cannot use the fixed 0.7 line through a lockfile-only update. No patched 0.5
    release is listed by RustSec.
  - `cms` 0.3 is still a pre-release; revisit the CMS/X.509 format stack separately when
    it is stable. That upgrade is not needed to remove the vulnerable EC dependency.
  - They add 22 packages to the Rust lockfile alongside the current PDF dependencies. Two of them, `tls_codec` and
    `tls_codec_derive`, are only locked: they serve `x509-cert`'s optional SCT feature, which
    nothing enables, so they are never built.

## Added for password-protected PDFs (#54)

`lopdf` 0.45.0 (MIT) opens a PDF that a sender locked with a password, so that
an unlocked copy can be stored beside the locked original. It is pinned exactly (`=0.45.0`) because it
parses untrusted input: each update is a reviewed change. Default features are
off, so neither `rayon` threads nor `chrono` come with it.

It runs only in the separate helper process (`src-tauri/src/pdf_unlock.rs`),
never next to the vault keys. Choosing it over `pdf` (whose writing is still
experimental), `qpdf` (a C++ build for each phone platform) and
`pdfium-render` (a native PDFium for each platform) is explained in the #23
design.

The lockfile grows from 486 to 515 packages. They are `lopdf`, `nom`,
`encoding_rs`, `stringprep`, `weezl`, `rangemap`, `simdutf8` and their Unicode
tables, plus newer RustCrypto releases (`aes`, `cbc`, `ecb`, `md-5`, `sha2`,
`digest`, `cipher`, `rand` and their support crates) beside the versions the
vault already uses. The vault's own encryption is unchanged.

Every new package is MIT, Apache-2.0 or BSD-3-Clause (the WHATWG data in
`encoding_rs`), all compatible with AGPL-3.0-or-later. CI's dependency job
(`cargo audit`, the SBOM and the graph check) covers them; the graph check
passes locally.

## Added for the document reader (#48)

`hayro` 0.8.0 draws a page of a PDF as a picture, so that myCarlos can show
stored documents. It is pinned exactly (`=0.8.0`) because it parses untrusted
input, and it runs only in the separate PDF helper (`src-tauri/src/pdf_view.rs`),
as `lopdf` does.

**Where there is unsafe code:**
- `hayro` and `hayro-interpret` forbid unsafe code in their own crates.
- `hayro-syntax`, the PDF parser underneath them, does not.
  - It has an unsafe lifetime extension of its own (`page.rs`).
  - `hayro-interpret` always turns on its `unsafe` feature, so turning off
    `hayro`'s default features cannot avoid it. That feature brings in `flate2`
    with the `zlib-rs` backend, `memchr`, and the SIMD paths of the JBIG2,
    JPEG 2000 and JPEG decoders.
  - `pic-scale`, `moxcms`, `zune-jpeg` and `fearless_simd` use unsafe code
    internally too.
- Turning off `hayro`'s own `simd` feature removes only `pic-scale`'s SIMD
  paths.
- Feature unification also moves the app's whole `flate2` to `zlib-rs`. Before
  this, its only other user, `png` (for the app's own trusted icons), used
  `miniz_oxide`.

This is why the reader parses PDFs only in the helper, never beside the vault
keys. The helper's real sandbox is #63. `image` 0.25 (already present through
`hayro`) writes the page picture as PNG, with only the `png` feature. Before display,
the parent also uses this existing codec to decode and re-encode only RGBA8 page
pixels: at most 4096 pixels per side, 64 MiB of decoded pixel storage and a 64 MiB
decoder allocation limit, checked before decoding. Only the newly encoded picture
is sent to the webview; PDF parsing and the helper's sandbox policy are unchanged.

pdf.js was not chosen. Product decisions forbid rendering an untrusted PDF in
the privileged webview, and running it in a second webview would need CSP and
capability changes. A native PDFium or MuPDF build would add a C or C++ parser
for each platform.

The lockfile grows from 515 to 550 packages: `hayro` and its `hayro-*` parts
(fonts, CMaps, CCITT, JBIG2, JPEG 2000), the Linebender drawing crates
(`vello_cpu`, `vello_common`, `kurbo`, `peniko`, `color`, `fearless_simd`),
font readers (`skrifa`, `read-fonts`, `font-types`), image decoders
(`zune-jpeg`, `moxcms`, `pic-scale`, `pxfm`) and `zlib-rs`.

Every new package is Apache-2.0, MIT, BSD-3-Clause, Zlib or Unlicense, all
compatible with AGPL-3.0-or-later. The graph check passes locally; CI's
`cargo audit` and SBOM jobs cover the rest.

## Added for the PDF helper's sandbox (#63)

Two crates, Linux only, each pinned exactly because the sandbox depends on
what they do: each update is a reviewed change. Both are used only by the
helper's `confine` module (`src-tauri/src/pdf_unlock.rs`), before it reads a
document.

- **`landlock` 0.4.7** (MIT OR Apache-2.0, Rust 1.71). From the Landlock
  project, whose lead also maintains Landlock in the Linux kernel. It builds a
  Landlock ruleset that handles every file and network access right and the
  signal and abstract-socket scopes, with no rule allowing any of them, and
  applies it to the helper. Best-effort: a kernel without Landlock, or with an
  older Landlock, enforces what it has. Its unsafe code is the three Landlock
  system calls and `prctl`. It brings `enumflags2` and `enumflags2_derive`
  0.7.12 (MIT OR Apache-2.0); `libc` and `thiserror` were already locked.
- **`seccompiler` 0.5.0** (Apache-2.0 OR BSD-3-Clause). From rust-vmm, and
  used by Firecracker and Cloud Hypervisor. It compiles the helper's seccomp
  allowlist to a BPF program for x86_64 or aarch64 and installs it. Required:
  without it the helper reads nothing. Its unsafe code is the `prctl` and
  `seccomp` system calls. Its optional `json` feature (`serde`) is off; `libc`
  was already locked.

Hand-written BPF or `libseccomp` were not chosen: the first is easy to get
wrong (argument widths, the architecture check), and the second is a C library
to build and ship. `extrasafe` and `birdcage` wrap the same two kernel features
with more policy than the helper needs.

On Windows the AppContainer uses the `windows` crate already in the tree, with
its `Win32_Security_Isolation` feature turned on. macOS calls `sandbox_init`
from the system library; nothing is added.

The lockfile grows from 550 to 554 packages: `landlock`, `seccompiler`,
`enumflags2` and `enumflags2_derive`. All are MIT, Apache-2.0 or BSD-3-Clause,
compatible with AGPL-3.0-or-later.

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

## Current signed-PDF digest and import analysis (#101)

The pinned RustCrypto versions remain unchanged. CMS signed attributes are decoded as
strict DER `Any`/`SET OF` values, preserving their exact encoded bytes, so the agreed UUID
OID `2.25.132515939282652475535231260060469025505` does not pass through const-oid 0.9's
`u32` arc conversion. OID values must be minimally encoded and terminated; duplicate OIDs,
multiple values and a manifest digest other than one 32-byte OCTET STRING fail closed.
ECDSA verifies the original signed-attribute values under the SET tag; no attribute is
substituted or dropped. The digest is SHA-256 of the exact extracted manifest bytes.

The existing confined PDF helper has a bounded two-stage protocol. A conservative range
preflight supplies no manifest and uses no PDF password. Main authenticates CMS and a
trusted pin before the second stage can parse full PDF structure and decrypt/extract the
matching AF/Data + EmbeddedFiles attachment. Existing lopdf is reused only in that helper.
Input is capped at 100 MiB, output at 128 KiB, the manifest at 16 KiB and decompressed
object streams at 16 MiB; existing helper time/memory/confinement limits still apply.

The import pipeline captures its already authenticated object-verification read within
the same input cap. It preserves the original object and returns optional ephemeral
unverified diagnostics, without raw manifest/name/date-of-birth/key data. No authenticated
clinic links exist in the app yet: production supplies no pins and cannot grant Verified.
FAKE fixture pins are test inputs only. No new network access or vault format is introduced.

The embedded v1 producer contract permits explicit null for clinic/recipient IDs and
unknown descriptive metadata (CARLOS `DocumentManifest` Javadoc, lines 35–54). The Rust
reader accepts those null values but still requires every member; unknown members, missing
members and wrong value types fail closed. Neither an absent clinic claim nor an absent
recipient can become Verified. This changes no outer portal delivery schema or vault format.

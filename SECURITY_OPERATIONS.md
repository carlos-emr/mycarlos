# Security and privacy operations baseline

This baseline applies to the synthetic-data evaluation. It records decisions that can be made
without creating a production service or collecting patient data. It does not authorize a pilot.

## Supported-version boundary

There is no supported patient release today. Windows, macOS, Android and iOS are evaluation targets;
Linux is an unsupported compatibility monitor pending review of the local backport for
GHSA-wrw7-89jp-8q8g and Linux device/release validation. Debug/unsigned artifacts are test evidence only. Minimum OS/WebView versions and a
production end-of-support schedule remain an owner decision and release gate.

## Diagnostics and data egress

- Analytics, crash upload, remote logging and telemetry are disabled.
- The allow-list of fields permitted to leave the device is therefore the empty set.
- There is no automatic support bundle. A future bundle must be generated locally, display every
  field to the patient before export, contain no document/profile/file name/path, key material,
  passphrase-derived value, vault/object ID or free-form log, and require an explicit save action.
- Adding any network, analytics, crash, support or update dependency requires a threat-model and
  `MASVS_MAPPING.md` update before code lands.

## The PDF helper's sandbox

PDFs from senders are parsed only in the PDF helper, a separate process with no vault keys
([THREAT_MODEL](THREAT_MODEL.md) IMP-02). Since #63 it is sandboxed before it reads anything:
seccomp (required) and Landlock (where the kernel has it) on Linux, `sandbox_init` on macOS, and an
AppContainer with no capabilities, inside a job object, on Windows. The code is in one place, the
`confine` module of `src-tauri/src/pdf_unlock.rs`.

- **It fails closed.** Where the sandbox cannot be set up, the helper reads nothing, and the patient
  is told the document cannot be opened (or shown) safely on this system. Nothing is added. Known
  causes: a Linux kernel without seccomp filters, or a processor other than x86_64 or aarch64; on
  Windows, an install folder that AppContainers may not read (see below). A report of these messages
  is a support case, not a reason to weaken the sandbox.
- **Windows install folder.** An AppContainer can only start a program that
  `ALL APPLICATION PACKAGES` (S-1-15-2-1) may read and run. The installer grants read and run on the
  install folder (`src-tauri/windows/hooks.nsh`); nothing private is kept there. Its uninstaller
  deletes the helper's AppContainer profile, `mycarlos.pdfhelper`. A build run from source needs the
  same grant ([WINDOWS.md](WINDOWS.md)).
- **Keeping it working.** The Linux allowlist names the calls the helper makes after it starts. A new
  Rust, glibc, `lopdf` or `hayro` release can make others. The helper then fails (no document, never
  an open sandbox), and the escape and "still works" tests in CI show it. Update the list only with a
  reviewed change that says why the call is needed. `landlock` and `seccompiler` are pinned
  ([DEPENDENCY_REVIEW](DEPENDENCY_REVIEW.md)).
- **macOS.** `sandbox_init` is deprecated by Apple, though still supported. The helper moves to an
  embedded helper with App Sandbox entitlements of its own once myCarlos is signed (#24).

## Vulnerability intake and response

Follow [SECURITY.md](SECURITY.md) for private reporting; never place a suspected patient-data issue
in a public ticket. During the handoff, the existing CARLOS private advisory channel and its
acknowledgement/assessment targets remain the reporting route until dedicated intake is enabled.
A production owner must additionally set remediation and release targets by severity, name an
incident commander and privacy/clinical contacts, and exercise the process before a pilot.

For an evaluation security incident:

1. Stop distributing and running affected artifacts; preserve hashes and build/run identifiers.
2. Do not request vaults, exports, screenshots or logs from a tester. Assume any such artifact may
   contain sensitive data even though only synthetic data is authorized.
3. Open a private advisory with the minimum reproducible technical detail and no record content.
4. Identify affected commit/dependency/platform boundaries and whether signing or build credentials
   could be involved.
5. Patch and test on the oldest affected line, rotate/revoke credentials if applicable, and prepare
   coordinated disclosure. Never move or reuse a released tag.
6. Record containment, eradication, recovery and lessons learned without copying sensitive input.

## Release supply chain

CI produces reproducible CycloneDX inventories for the locked npm and Cargo graphs, rejects high or
critical production npm findings, and runs a pinned Rust advisory scan on pull requests and weekly.
The original draft-only `glib` audit exception was not imported. A pinned source snapshot now
backports the upstream fix; source reconstruction and optimized regression tests verify it. The
audit deliberately retains upstream package identities, so the original warning and future
advisories remain visible. Linux remains an unsupported compatibility monitor pending security,
device, and release review. See [the patch record](src-tauri/vendor/README.md).
GitHub Actions are commit pinned and checkout does not persist credentials. These are inventory
and pull-request controls, not release provenance.

Before a supported release, this repository must protect its release pipeline and bind each
signed platform artifact to its source revision, lockfiles, SBOM, build identity and provenance
attestation. Signing/notarization, hardware-backed key custody, updater/store policy,
reproducible-build comparison and key-loss/revocation drills remain release gates because they
require credentials, infrastructure and named owners that this evaluation does not have.

## Synthetic canary drill

Before each promotion gate, seed unique fake names and byte strings, exercise create/import/lock/
background/export/delete/failure/crash flows, and inspect app storage, platform backups/indexes,
recent files, logs, crash artifacts, swap/app snapshots, clipboard, notifications and generated
support artifacts. Any canary outside the explicitly selected plaintext export destination fails the
gate. Physical-device evidence must record OS/app version, exact build hash, steps and artifact hash.

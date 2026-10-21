# OWASP MASVS v2.1.0 working mapping

This is an engineering traceability map for the synthetic-data evaluation. It is **not** a claim of
MASVS compliance and it does not replace an independent mobile security assessment. The mapping is
pinned to [OWASP MASVS v2.1.0](https://github.com/OWASP/masvs/releases/tag/v2.1.0); it must be
reviewed against the current MASVS and applicable MASTG/MASWE tests before a pilot.

Status means:

- **Implemented**: the current source contains the control and automated evidence exercises it.
- **Partial**: useful controls exist, but required platform or adversarial evidence is still open.
- **Not applicable now**: the local-only evaluation has no such boundary; adding one reopens it.
- **Open**: the evaluation does not implement the control.

| MASVS control | Status | Current evidence | Remaining promotion gate |
| --- | --- | --- | --- |
| STORAGE-1 Secure storage | Partial | `VAULT_FORMAT.md`; encrypted manifests and chunked objects; private-file tests in `src-tauri/src/vault.rs` | Physical backup, restore, second-user, OS-index and platform file-protection inspection |
| STORAGE-2 Prevent data leakage | Partial | No telemetry; renderer receives opaque IDs/sanitized metadata; plaintext-free canary test; explicit export warning; a secret shown as text is kept from spell checking, autocorrection and autocapitalization | Crash/swap/keyboard/app-switcher/screenshot/notification inspection; provider failure cleanup exercise |
| CRYPTO-1 Strong cryptography | Partial | Argon2id, XChaCha20-Poly1305 and HKDF-SHA-256 documented in `VAULT_FORMAT.md`; HMAC-SHA-256 header-integrity tags and keyed duplicate fingerprints in `src-tauri/src/vault.rs`; corruption/boundary/property tests | Independent cryptographic review and physical-device Argon2 measurements |
| CRYPTO-2 Key management | Partial | Random master/object keys, authenticated key wrapping, domain separation, rotation checks and zeroization | Recovery kit, portable backup, device-bound biometric wrapping and crash/memory inspection |
| AUTH-1 Remote authentication/authorization | Open | No account or remote service exists yet. Planned (carlos-portal #41, the shared spec carlos-portal#42): a device linked with a 10-minute, one-use code shown after the patient's MFA sign-in to the portal; every request carries an Ed25519 assertion signed by a per-link key, a fresh pair for each portal link so no two portals see the same key ID; CARLOS keeps each new device pending until it is confirmed outside the portal (THREAT_MODEL DEL-03) | Device-assertion, replay, unlink and confirmation tests against the shared vectors; reopen for production identity, passkeys/MFA, sync or sharing |
| AUTH-2 Local authentication | Partial | Offline passphrase unlock, wrong-passphrase behavior, configurable auto-lock and lifecycle concealment | Native lifecycle/device-account testing and biometric implementation |
| AUTH-3 Additional authentication for sensitive operations | Partial | Whole-vault reset requires typed intent plus a trusted native confirmation | Product/security owner must define passphrase/OS reauthentication timing for deletion, export, passphrase rotation and future sharing |
| NETWORK-1 Secure network traffic | Open | Production CSP has no remote network origin; no network client or telemetry exists yet. The first network use is planned: pickup from the portal the patient links (carlos-portal #41; THREAT_MODEL NET-01 and NET-03; the allow-list in `SECURITY_OPERATIONS.md`) | HTTPS only, TLS 1.2 or later, cleartext refused on every platform; one Rust client limited to the linked portal, with no redirects elsewhere and no network from the webview or the PDF helper; captured-traffic tests on every platform before pickup is switched on |
| NETWORK-2 Endpoint identity pinning | Open | Planned (carlos-portal #41, carlos-portal#42): the clinic's key list is pinned for each link at linking, and every copy is sealed to the link's device key and signed by a pinned clinic key, so content does not rest on TLS alone (THREAT_MODEL NET-02, DEL-01 and DEL-06) | Decide whether to pin the portal's TLS key as well (THREAT_MODEL D-09); test with an interception proxy and a user-installed certificate authority |
| PLATFORM-1 Secure IPC | Partial | No Tauri plugin/core permissions; only bounded app-command allow entries; bounded opaque-ID commands; transactional bulk mutation; native reset confirmation; invalid IPC property tests; a photo sent as one body, a 4-byte length, a target of at most 4 KB as JSON parsed with unknown fields refused, then a JPEG of at most 25 MB, with no custom headers (WebView2 does not pass them on); raw bytes over Tauri's custom protocol, or, when Tauri uses its postMessage channel (as on Android), the same bytes as a JSON array of numbers counted before the app copies anything; Tauri's own parsed copy of that array is neither overwritten nor size-limited by the app (THREAT_MODEL CAM-01); the setup checklist's `vault_passphrase_rules` answers three booleans only, and only while no vault exists (KEY-03, IPC-01) | Platform URI/provider, intent/deep-link and generated-permission abuse testing |
| PLATFORM-2 Secure WebViews | Partial | Bundled UI, restrictive production CSP, prototype freezing, no remote frames/objects, hostile-metadata/off-origin browser regression; native camera-permission handlers on Linux and Windows (video for the app's pages only, every other request refused; THREAT_MODEL CAM-01) | Isolated capability-free hostile-PDF viewer and native navigation/deep-link/network regression suite |
| PLATFORM-3 Secure user interface | Partial | Immediate concealment and cancellable locking, explicit export/screenshot/deletion warnings, modal focus management, keyboard folder moves and automated browser/durable WCAG gates | Native snapshot suppression, screen-recording policy, notification/clipboard/share/print and manual assistive-technology tests |
| CODE-1 Up-to-date platform versions | Open | Commit-pinned actions, pinned Linux runner images and pinned Rust/Node toolchains; the Android NDK, Java 17 and macOS Xcode follow the hosted runner images | Define and enforce minimum supported OS/WebView versions and end-of-support policy |
| CODE-2 Enforced app updates | Open | No updater is enabled in this evaluation | Signed updater, rollback protection, key rotation/revocation and store-release policy |
| CODE-3 Components without known vulnerabilities | Partial | Enforced lockfiles, commit-pinned Actions, dependency review, scheduled npm/Rust advisory gates and CycloneDX SBOM CI | Review the verified `glib` backport; artifact-specific release gate and response ownership (no advisory waiver) |
| CODE-4 Input validation/sanitization | Partial | Bounded headers/manifests/batches, strict semantic validation, path/handle protections, chunk and malformed-input tests; JPEG marker validation and metadata removal before a photo is stored or shown | Hostile PDF parser/viewer corpus, real provider/NTFS race tests and continued regression corpus |
| RESILIENCE-1 Platform integrity validation | Open | None | Risk-based rooted/jailbroken/compromised-device policy and bypass testing |
| RESILIENCE-2 Anti-tampering | Open | Authenticated vault data only; application binary is unsigned | Release signing, notarization/store signing, integrity response and tamper tests |
| RESILIENCE-3 Anti-static-analysis | Open | Release builds strip symbols | Owner/security review must decide proportional obfuscation and secret-extraction requirements |
| RESILIENCE-4 Anti-dynamic-analysis | Open | None | Owner/security review must decide proportional debugging/hooking defenses and test profile |
| PRIVACY-1 Minimize sensitive access | Partial | Local-only design; no analytics; narrow commands/capabilities; ciphertext-at-rest; camera only after the patient's choice, video only, stopped when not needed; photos stored without location or camera metadata | Data-flow/privacy review once identity, CARLOS, sync, support or viewer boundaries exist |
| PRIVACY-2 Prevent user identification | Partial | No remote identifier or tracking exists | Inspect app/OS metadata and define privacy-preserving remote identifiers before integration |
| PRIVACY-3 Transparency | Partial | Synthetic-only warning and plaintext/loss boundaries are shown in-product; Security says what myCarlos keeps (hidden documents, #71); the camera dialog says why the camera is used before it is turned on, as macOS's camera prompt does | Approved privacy notice, app-store disclosures, consent/retention and legal review |
| PRIVACY-4 User control | Partial | Patient can import, organize, export, hide and restore; nothing is deleted (#71), and the patient is told what is kept | Recovery/backup/sync deletion semantics, portable export, account/device deletion and policy approval |

## Review rule

Every change to native commands, capabilities, cryptography, storage, document rendering, recovery,
networking, identity, diagnostics or supported platforms must update this map and the corresponding
threat IDs in `THREAT_MODEL.md`. Only an independent reviewer may turn this working map into an
assessment result.

Every **Partial** or **Open** row blocks promotion. The accountable role is the application owner,
with security-reviewer disposition required for security controls and privacy/release/platform
owner disposition required for their respective controls. Those people are not yet named in this
evaluation repository, so assignment and written acceptance remain open rather than being silently
attributed to a contributor.

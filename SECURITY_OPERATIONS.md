# Security and privacy operations baseline

This baseline applies to the synthetic-data evaluation. It records decisions that can be made
without creating a production service or collecting patient data. It does not authorize a pilot.

## Supported-version boundary

There is no supported patient release today. Windows, macOS, Android and iOS are evaluation targets;
Linux is an unsupported compatibility monitor pending review of the local backport for
GHSA-wrw7-89jp-8q8g and Linux device/release validation. Debug/unsigned artifacts are test evidence only. Minimum OS/WebView versions and a
production end-of-support schedule remain an owner decision and release gate.

## Diagnostics and data egress

- Analytics, crash upload, remote logging and telemetry are disabled; their allow-list of fields
  permitted to leave the device is the empty set.
- The planned network uses are pickup from the portal the patient links (carlos-portal #41) and
  the AI helper's model download (#72, #219, on main). The fields pickup may send are listed
  under [Portal pickup](#portal-pickup-what-may-leave-the-device); the download sends none
  ([AI helper](#ai-helper-72-nothing-about-the-patient-leaves-the-device)); nothing else may leave the device.
- The AI helper (#72) adds one host to the allow-list, for the model file only: its "cloud" way is
  a text file the patient saves, and its model helper has no network.
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
and pull-request controls, not release provenance. The Windows and Linux evaluation builds link
llama.cpp objects restored from a cache that only runs on `main` write (pull requests only read
it), keyed on the runner image, the Rust toolchain and the dependency files; a supported release
must build them afresh.

Before a supported release, this repository must protect its release pipeline and bind each
signed platform artifact to its source revision, lockfiles, SBOM, build identity and provenance
attestation. Signing/notarization, hardware-backed key custody, updater/store policy,
reproducible-build comparison and key-loss/revocation drills remain release gates because they
require credentials, infrastructure and named owners that this evaluation does not have.

## Synthetic canary drill

Before each promotion gate, seed unique fake names and byte strings, exercise create/import/lock/
background/export/delete/failure/crash flows, and inspect app storage, platform backups/indexes,
recent files, logs, crash artifacts, swap/app snapshots, clipboard, notifications and generated
support artifacts, and, once portal pickup exists, captured network traffic. Any canary outside the
explicitly selected plaintext export destination fails the gate. Physical-device evidence must record
OS/app version, exact build hash, steps and artifact hash.

## Portal pickup: what may leave the device

Planned with carlos-portal #41 and not built yet. The field names are the shared spec's
(carlos-portal#42 at c35649b, `docs/architecture/mycarlos-delivery.md`, with the shared vectors
`tests/fixtures/delivery-contract.json`); this list is the allow-list that the
pickup code must meet ([THREAT_MODEL](THREAT_MODEL.md) NET-01 to NET-03 and DEL-01 to DEL-06).
myCarlos may send only these, and only to the `/api/mycarlos/` routes of the HTTPS address of the
portal the patient linked:

- **When linking** (`POST /api/mycarlos/link`): the `link_id` and `code` from the portal's code or
  QR code (a typed code that is not one is refused on the device as `not_a_link_code`, and nothing
  is sent); a `device_name`, shown to the patient under Linked devices; the public halves of this
  link's per-link device keys (`x25519_public_key`, `ed25519_public_key`), a pair made fresh for
  this link, so no two portals see the same key ID, and with the per-link `vault_head_link` below,
  clinics cannot link the same device by anything myCarlos sends (each portal still sees the IP
  address it is reached from; see below); and a link assertion signed by the new key (`aud`, `iss`,
  `kid`, `jti`, `iat`, `exp`, `request_hash`).
- **With every device request:** the `X-MyCarlos-Device-Assertion` header, signed by this link's
  Ed25519 key: `aud`, `iss`, `kid` (this link's `device_key_id`), `recipient_id` (random per
  patient account, never derived from the health card number), `jti`, `iat`, `exp`,
  `request_hash`, and optionally `vault_head_link`.
- **When picking up:** `GET /api/mycarlos/deliveries` (the list, also the check-in) and
  `GET /api/mycarlos/deliveries/{delivery_id}` for each copy.
- **Receipts** (`POST …/{delivery_id}/receipt`): `typ`, `aud`, `delivery_id`, `recipient_id`,
  `device_key_id`, `ciphertext_sha256`, `document_sha256`, `picked_up_at`, `vault_head_link` and
  `jti`,
  signed by this link's Ed25519 key. A receipt is sent only after the document is safely in the
  vault, and a re-sent one is the kept receipt, byte for byte.
- **When refusing a copy:** nothing. A refused copy is not filed and no receipt is sent; it expires
  on the portal, and CARLOS shows "not picked up".

It never sends document content, file names, titles, patient or person names, birth dates, vault
or record IDs, passphrase-derived values, vault keys, private keys, logs, or details of the device
or operating system beyond the OS family in the suggested `device_name`; its user agent names only
myCarlos and its version.

Two of these fields are made with care:
- **`device_name`** (a client MUST in the spec): myCarlos suggests "myCarlos on" and the OS family
  only (Windows, macOS, Linux, Android or iOS), so the patient can recognise the device under
  Linked devices, and the patient can edit it. It never includes the computer's host name, the
  phone's own name, the user account's name or the OS version.
- **`vault_head_link`:** the vault history's anchor (decision L), never the raw head, which is the
  same on every link of a vault. It is `HMAC-SHA256(K_link, head)`, with `K_link` derived by
  HKDF-SHA256 from that link's Ed25519 seed, so two portals never see the same value; myCarlos can
  recompute it for any past head.

The network still sees the device's IP address, the portal's host name, and the times and sizes of
requests. The portal sends a `Date` header, so myCarlos can tell the patient when its clock is far
off.

If a portal or a clinic key may be compromised, follow the incident steps above. The clinic
revokes its key in CARLOS (carlos-emr/carlos#4691), myCarlos refuses packages signed by a key that
was not active in the key list it pinned at linking (it does not yet learn of a later revocation), and patients can remove a device under Account → Linked devices in the portal.

## Tray notices (#230): the waiting key

Planned with carlos-portal#87 and not built yet ([THREAT_MODEL](THREAT_MODEL.md) NET-04). With the
tray (#206), closing the window locks the vault, and the device keys are inside it. A waiting key
lets the locked app ask each linked portal one question: is anything waiting for this device?

**What may leave the device:**

- **Registering** (while unlocked, at link time): `POST /api/mycarlos/availability/waiting-keys`,
  signed with the link's device key as any device request, carrying the waiting key's public half
  and its `key_id`. A key the link already had is replaced.
- **Asking** (locked, in the tray): `POST /api/mycarlos/availability/waiting`, body `key_id` only,
  with the `X-MyCarlos-Waiting-Assertion` header signed by the waiting key: `aud`
  (`carlos-patient-portal-waiting-check`), `iss`, `kid`, `jti`, `iat`, `exp` (60 s or less) and
  `request_hash`. Not more than once every 120 s per key (the portal answers `429` with
  `Retry-After`), with jitter and back-off. The answer is yes or no, the same size either way.
- Nothing else: no vault, record or person id, no document or patient detail, no device detail
  beyond what the link already sent. The network still sees the IP address, the portal's host name
  and the times of the checks.

A yes shows one generic notice, in the last-used language, with no clinic, document, name or count,
once until the next unlock. Clicking it opens the unlock screen; after unlock the normal document
check takes over.

**Revoking and wiping.** A waiting key is revoked at the portal, and wiped on the device (its slot in
`notice-keys.v1`; the OS item too when no key is left):

- when the patient turns tray notices or the tray off, or unlinks the clinic: the device revokes it
  with the link's device key (`DELETE /api/mycarlos/availability/waiting-keys/{key_id}`). If that
  can't be sent, the revocation waits with the vault's other pending revocations (format 9's 64
  places) and is sent after the next unlock;
- when the vault is reset, erased or set aside, or another vault is opened: the device keys may be
  gone, so the waiting key gives itself up (`DELETE /api/mycarlos/availability/waiting`, signed by
  the waiting key);
- when the portal answers `404`: the key was revoked there, the device was removed, or the portal
  refused it for another reason it doesn't give. The device stops asking with that key. Open
  (#230): whether it wipes the key at the first `404`, or only after a few, since a portal whose
  notices are switched off may answer the same way.

**At the portal:** staff revoking the key, or removing the device or the link, stops it at once.
That is the clinic's kill switch for a lost or offline device, whose own revocation cannot land
until it is online and unlocked. A revoked key gets `404`, like any other refusal, so the answer
doesn't say why.

**If a device is lost or its OS account may be compromised:** remove the device in the portal
(Account → Linked devices), or ask the clinic to. Whoever has the device's files and its OS account
can learn which portals the vault is linked to and whether something is waiting at each, until
then; they cannot read, list or pick up anything with the waiting key. Uninstalling on Windows
should remove the Credential Manager item (`myCarlos/notice-keys/v1`); if it is left, delete it in
Credential Manager by hand.

## AI helper (#72): nothing about the patient leaves the device

The anonymized text export (part B) is built on main (#171, computers only), and so are the reader's Summary and Explain behind the notice (#217), the model runtime (#218), the model download (#219) and kept answers (#212) ([THREAT_MODEL](THREAT_MODEL.md) AI-01 to AI-10). Ben decided
on 29 October 2026 that the helper uses no cloud provider, so:

- **What may leave the device: nothing about the patient.** The model runs in a sandboxed helper
  mode with no network (AI-07), and the webview's content policy is unchanged. The AI helper's one
  connection is the model download below, which sends no document, field or identifier.
- **The text source** is one read-only command, `vault_document_text` (AI-10). It works on
  computers only, reuses the sandboxed PDF helper with no new helper message, caps the text at
  50 pages and 1 MiB, lists the pages the helper refuses instead of dropping them, and adds no
  network use.
- **The export is a file save.** After the preview, the patient saves the anonymized text as a plain
  text file through the system's save dialog (AI-01 to AI-03). Where it goes after that (a synced
  folder, a cloud drive, an AI service) is the patient's choice, as for a readable copy, and what
  that service learns or keeps is up to it (AI-09). Native code writes the file's first line
  itself, in the app's language: it tells an AI to treat all of it as the document, not as
  instructions (AI-02, AI-09); when the text was cut, the last line says so (AI-02, AI-10). The history
  records it as `copySaved` with
  `how: "anonymizedText"`: the document, where the file was saved (cut to 256 characters, and then
  with a SHA-256 of the whole) and when; never the text or the removed details.
  Security shows it with a label of its own; an older build shows "Readable copy saved".
- **The model file** holds no patient data. It is kept in a `models` folder beside, not inside, the
  vault folder, so it is not in myCarlos's encrypted backups (it is not yet marked to be left out of
  system backups). That folder is a removal kind of its own (no patient data, so #71's rule that
  nothing is deleted does not apply): a partial `.part` copy is removed at the next start, a file
  that fails its check is marked damaged and offered for removal, and the patient can remove the
  model. It is checked against a list built into the app (SHA-256 and size; part of the signed app
  once releases are signed) when it is added and at every helper start (AI-04).
- **How the model reaches the device (#219, on main):** **Download the default model**, or **Add
  a model file…** for a file the patient already has (THREAT_MODEL D-10, AI-08). The download's
  allow-list entry:

  | Host | Why | What is sent | What the host learns |
  | --- | --- | --- | --- |
  | `huggingface.co`, at the catalogue entry's pinned address (`/<repo>/resolve/<commit>/<file>`) | The model file | An HTTPS GET with no cookies, credentials, referrer or identifier | The computer's IP address, the time, and which public file |
  | Its CDN: `cdn-lfs.huggingface.co`, `cdn-lfs.hf.co`, `*.cdn.hf.co` (today one 302 to `us.aws.cdn.hf.co`) | Where the pinned address redirects | The same | The same |

  Only on a click, after the disk and machine checks; native code only; HTTPS on 443 with TLS 1.2
  or later and the platform's certificate verifier; no automatic redirects (each one is parsed and
  checked against this list, and any other host ends the download); no proxy. The bytes are hashed
  as they arrive and kept only if the size and SHA-256 match the catalogue entry. A change to the
  host, the pinned commit or the CDN list is a change to this table and to AI-08, reviewed before
  it ships.
- **The model list is release material.** It changes only in a release, through the release supply
  chain above. A model or runtime found unsafe is handled as a vulnerability (see
  [Vulnerability intake and response](#vulnerability-intake-and-response)): a release removes its
  entry, and the app then refuses that file. With no updater yet (MASVS CODE-2), that reaches only
  patients who update.
- **Advisories:** the runtime is llama.cpp through `llama-cpp-2` and `llama-cpp-sys-2`, pinned
  =0.1.160 (#218). RustSec does not cover its C/C++ code, so ggml and llama.cpp advisories are
  watched by hand; the vendored revision is recorded in DEPENDENCY_REVIEW.md, and the crates in the
  SBOM.
- **Licences:** each listed model's licence must allow the project to offer it to patients and
  allow this use. It is recorded in `LICENSE_NOTES.md` when the model is picked.
- **Canary drill:** the [synthetic canary drill](#synthetic-canary-drill) also covers the helper.
  Identifying canaries in the vault's profiles and in synthetic documents must never appear in an
  export, a log, or any file the helper leaves.

## Evaluating authenticated linking (#55)

Every build includes the link implementation; no Cargo feature selects it. On
Android its command still refuses before any write or network use, until the
platform verifier is integrated (below). The portal and CARLOS off switches
remain separately required. A browser
mock or a setting in the renderer never supplies production clinic pins.

The typed portal address must be HTTPS with no user information, query or
fragment. Deployments under a path prefix retain that prefix in the signed raw
request path. Requests do not follow redirects, use cookies or persist an HTTP
cache. TLS uses platform certificate validation with a TLS 1.2 minimum; no
invalid-certificate override or document-selected destination is provided. This client makes direct connections and disables proxy discovery and automatic
retries; an error after a one-use request is not retried silently. Android
platform-verifier initialization remains an explicit implementation gate, not
a claim established by desktop source review. Platform trust facilities can
perform their own certificate/revocation lookups; these OS operations require
traffic review alongside the app client.

Link codes and private device keys are absent from errors and diagnostics. Only
the per-link public keys, generic device name, one-use code and signed v1 claims
leave the device while linking. Clinic names and computed key fingerprints are
shown to the patient and recorded in encrypted history; the vault keeps private
seeds, pins and recipient binding encrypted. Do not send a receipt or claim a
portal delivery was filed merely because a link request succeeded.

## Windows send/delete evaluation

Every build includes send/delete; use it only in the isolated synthetic
evaluation. `scripts/test-native-delivery.ps1` provides focused Windows checks
and an optional installer build.

The explicit Check for new documents action uses only the saved HTTPS portal
base. Native code signs fixed mailbox/receipt and first-device approval routes;
no downloaded URL selects a destination. The first mailbox page includes a
per-link history anchor. Native code verifies the HPKE package, clinic signature,
exact signed PDF bytes and embedded clinic/recipient/patient binding, then saves
both PDF objects, metadata, history and a single retained receipt. Only that
saved receipt can reach the portal. Receipt retry survives a lost response,
restart and backup/restore; a new outer nonce never changes the inner receipt.

The initial-device approval intent publishes both public keys and immutable
clinic/recipient/portal binding to the saved portal. Staff must compare the
full fingerprint on the actual device. The client verifies and saves the signed
clinic challenge/acceptance before reporting clinic approval. Later-device
approval, key-catalogue refresh, lost-all-devices recovery, mobile support and
notification scheduling require their own remaining implementation/validation.
Do not enable rollout from Linux component or FAKE-trust interoperability tests.

Approval recovery does not replace an expired saved request automatically.
Native code first reconciles the original ID, verifies any acceptance, and keeps
old IDs/proofs through an explicit restart. A portal's unsigned terminal status
cannot erase the only path back to a previously committed clinic acceptance.
Terminal reasons are a bounded enum displayed as plain guidance, never actor
identifiers or clinical data. A refusal requiring clinic intervention does not
fall back to another first-device approval. A signature that remains valid as
historical evidence does not override current key revocation.

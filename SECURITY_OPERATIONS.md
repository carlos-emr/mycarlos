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
- The only planned network use is pickup from the portal the patient links (carlos-portal #41).
  The fields it may send are listed under [Portal pickup](#portal-pickup-what-may-leave-the-device);
  nothing else may leave the device.
- There is no automatic support bundle. A future bundle must be generated locally, display every
  field to the patient before export, contain no document/profile/file name/path, key material,
  passphrase-derived value, vault/object ID or free-form log, and require an explicit save action.
- Adding any network, analytics, crash, support or update dependency requires a threat-model and
  `MASVS_MAPPING.md` update before code lands.

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
  clinics cannot link the same device; and a link assertion signed by the new key (`aud`, `iss`,
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
revokes its key in CARLOS (carlos-emr/carlos#4691), myCarlos refuses packages signed by a revoked
key, and patients can remove a device under Account → Linked devices in the portal.

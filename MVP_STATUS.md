# myCarlos synthetic MVP status

- **Milestone:** local encrypted filing cabinet using synthetic data
- **Production status:** not approved for PHI, a patient pilot, or distribution
- **Supported evaluation targets:** Windows, macOS, Android, and iOS
- **Deferred target:** Linux

This checklist describes the work currently present on the staging branch. A checked item means the
behavior is implemented and covered at development depth; it does not replace independent security,
privacy, accessibility, or clinical review.

## Implemented

- [x] Shared responsive React/TypeScript interface in a Tauri v2 shell.
- [x] Native PDF picker with paths and bytes kept out of the React renderer.
- [x] PDF-filtered imports bounded to 100 open files per transaction, with constant-memory chunked
      encryption and no arbitrary per-file size cap.
- [x] XChaCha20-Poly1305 encrypted chunked objects and encrypted metadata manifests.
- [x] Argon2id passphrase wrapper, independent object keys, and keyed duplicate detection.
- [x] Approved 15-character passphrase minimum without arbitrary composition rules, plus local
      common-password/pattern/profile-name screening. A production breach corpus and independent
      threshold review remain patient-pilot gates.
- [x] Atomic import with committed/degraded outcomes, redundant header and manifest repair,
      recovery-mode unlock/export, atomic filesystem-path export, restart/unlock, and immediate
      precommit error-path cleanup.
- [x] Multiple patient profiles, nested folders, search, sorting, transactional bulk moves,
      drag-and-drop, keyboard folder movement, and folder/imported-document renaming. Renames
      persist in encrypted metadata without modifying document bytes or folder assignments.
- [x] Manual/background locking with next-I/O-boundary streaming cancellation, immediate background visual
      concealment, and persisted one-to-fifteen-minute inactivity configuration with the approved
      five-minute default.
- [x] Confirmed passphrase change and typed plus trusted-native-confirmation whole-vault reset.
- [x] Exclusive OS ownership across app instances for unlocked sessions and lifecycle operations;
      subprocess coverage verifies rejection and fresh-state handoff after ownership release.
- [x] Interrupted-reset recovery before startup/access/creation, including legacy retired directories,
      abrupt exit after rename/key removal, retryable cleanup failures, and symlink rejection.
- [x] Confirmed individual deletion from the live vault with both manifest slots rewritten without
      the wrapped object key and ciphertext removed between the two durable commits.
- [x] Abrupt-process-termination recovery matrix after object chunk writes, staging, object rename,
      both manifest commits, and each deletion boundary.
- [x] Deterministic `NoSpace` failure injection during object writing and before/after durable
      manifest/deletion boundaries, verifying restart never exposes a half-committed record.
- [x] Corrupt/truncated/swapped object tests, corrupt-one-slot recovery, corrupt-both-slots
      fail-closed behavior, and preservation of ciphertext when metadata recovery is impossible.
- [x] A generated 101 MiB input verifies that reader requests stay bounded to one 1 MiB chunk.
- [x] Recursive plaintext-canary inspection and Unix `0700` directory/`0600` file assertions for
      application-controlled vault storage.
- [x] Frontend, Rust, responsive-browser, and cross-platform debug-build CI.
- [x] Native imports reject an oversized selection before opening file handles and reject local
      links/special files; metadata reads are bounded and authenticated manifests are structurally
      validated before their object names drive filesystem operations.
- [x] Production CSP excludes development WebSocket access, freezes the JavaScript prototype, and
      grants the main webview no unused Tauri core command permissions.
- [x] Property-based malformed-input coverage for header, manifest, object, and IPC envelopes;
      unsupported versions, same-generation manifest divergence, and generation overflow fail
      closed. Structured semantic manifest mutations, recovery-candidate selection, exact chunk
      boundaries and a preserved malformed-object regression corpus are also covered, and a future
      migration protocol is recorded.
- [x] Map every OWASP MASVS v2.1.0 control to current evidence and explicit gaps in
      [`MASVS_MAPPING.md`](MASVS_MAPPING.md). This engineering map is not an independent assessment.
- [x] Generate reproducible CycloneDX npm/Cargo dependency inventories in CI, keep Actions commit
      pinned, require the Cargo lockfile, and run npm plus scheduled Rust vulnerability gates.
- [x] Define content-provider export failure behavior: provider destinations may retain a partial
      readable copy and the returned patient-safe error requires deleting it before retrying.
- [x] Record the evaluation's empty telemetry allow-list, incident handling, supported-version
      boundary, future support-bundle constraints and release-supply-chain gates in
      [`SECURITY_OPERATIONS.md`](SECURITY_OPERATIONS.md).
- [x] Add WCAG A/AA automation across browser and durable-vault states; implement modal focus
      containment/return and keyboard folder movement; fix detected contrast failures. Add browser
      and durable hostile-filename regressions proving metadata renders as text.

## Required before calling the synthetic MVP reviewed

- [x] Replace the stale PR title/body with the implemented scope and current test evidence.
- [ ] Obtain application-owner and independent security review of the vault and threat model.
- [ ] Run the native lifecycle checklist on representative physical target devices.
- [ ] Verify import and export on an Android emulator or device. Android shows the document picker
      as a separate activity, which hides the page, so the app used to lock the vault under its own
      picker and every import and export failed with "locked". Import and export are now split into
      a native pick step, which holds the chosen paths natively, and a run step: the renderer does
      not lock while a picker it opened is in the foreground, treats that time as activity rather
      than inactivity, and locks once the picker closes if the page is still hidden. Backgrounding
      during the transfer itself still locks and cancels it. This is written against Android's
      documented lifecycle and covered by renderer tests, but it has not been run on Android: the
      development container has no Android SDK or emulator. Run `npm run tauri android dev` from a
      machine with Android Studio's emulator (see the Android section in `README.md`), then check
      that choosing PDFs imports them, that Save a copy writes the file, and that pressing Home
      while the picker is open locks the vault when the app returns.
- [ ] Give the native session its own idle deadline. Automatic locking runs only as timers and
      events in the renderer, so if the webview crashes, hangs, or is suspended before its lock
      request is delivered, the native session keeps the vault unlocked until the app exits.
- [x] A vault with a lost encrypted file can leave recovery mode without a reset: the library
      offers to remove the damaged documents after a confirmation that names the backup-restore
      alternative, and any file that has come back is kept.
- [ ] Review the passphrase policy against passphrases built from the profile's own name. The name
      is passed to zxcvbn as context, which only matches it as a whole, so rearranged or joined name
      words ("Family+Given") still reach the accepted score.
- [ ] Decide how passphrases are normalized before any vault holds real data. The bytes reach
      Argon2id exactly as typed, so the same visible passphrase entered composed on one keyboard and
      decomposed on another derives a different key, and the passphrase is the only way in.
      Normalizing later changes key derivation for existing vaults.
- [ ] Decide where the vault lives on Windows. It is rooted in the application data directory,
      which Tauri resolves to the roaming profile; on a domain-joined PC the ciphertext and the lock
      file would then roam between machines. Moving it later needs a migration.
- [ ] Handle a desktop export that is interrupted. The atomic-write primitive stages the readable
      copy in a hidden `.atomicwrite*` directory beside the chosen file, and nothing removes it if
      the app dies before the rename. Also confirm on iOS and sandboxed macOS that the save
      picker's folder allows creating that directory at all.
- [ ] Confirm on Windows that PDFs in a OneDrive Files On-Demand folder can be imported. Import
      refuses every reparse point, not only links and junctions, and cloud-synchronized files may
      carry a reparse tag even when fully downloaded.
- [ ] Run true power-cut/filesystem crash testing around the atomic replacement primitive on every
      supported filesystem and physical target; subprocess termination coverage is implemented.
- [ ] Reproduce genuine full-filesystem behavior and test OS backup/restore. Deterministic
      `NoSpace` injection, Unix permission modes, and the local corruption matrix are automated;
      platform filesystem and policy inspection remains. This includes filesystems that cannot
      sync a directory (some FUSE, network, and removable mounts): the atomic-write primitive syncs
      the parent after its rename, so there a manifest commit or an export is reported as failed
      although the complete file is already in place, and an import then removes the objects that
      the manifest on disk already references. Decide whether such storage is supported.
- [ ] Benchmark Argon2id on the oldest supported device class. A repeatable release-mode harness and
      result template are in [`ARGON2_BENCHMARK.md`](ARGON2_BENCHMARK.md); physical results remain.
- [ ] Inspect platform logs, crash artifacts, app-switcher snapshots, and backups for plaintext
      canaries. Recursive application-storage canary inspection is automated.
- [x] State the current evaluation's passphrase-only permanent-loss behavior and the limits of
      readable exports/deletion directly in the UI. The selected recovery kit and backup remain open.

## Required before a patient pilot

- [x] Decide the patient-pilot product behavior for identity, recovery, backup, deletion, viewing,
      E2EE portal synchronization, sharing, privacy, and updates; see
      [`PRODUCT_DECISIONS.md`](PRODUCT_DECISIONS.md). Implementation and review remain open.
- [ ] Design and test an isolated hostile-PDF viewer with no vault or network capability.
- [ ] Implement the approved portable encrypted backup, E2EE synchronization, device enrollment,
      rollback protection, immediate deletion, and resurrection-prevention tombstones.
- [ ] Implement signed CARLOS/portal provenance, recipient binding, and explicit encrypted sharing.
- [ ] Complete accessibility, privacy, PHIPA/PIPEDA, and clinical-safety review.
- [ ] Add signing, notarization, app-store packaging, updater security, and release operations.
- [ ] Resolve all high/critical shipped-runtime findings; Linux remains an evaluation pending review of the
      documented `glib` backport and device/release validation.

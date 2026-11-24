# iOS release settings (issue #422)

(claude assist) What the App Store needs from the app itself, and where each piece lives. **Everything marked
"draft for Ben" is a decision that is his (or a lawyer's), not a fact.**

| Piece                              | File                                                                                     | Checked by                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------- |
| Privacy manifest                   | `src-tauri/ios/PrivacyInfo.xcprivacy`                                                    | `npm run check:ios-privacy`         |
| Export compliance key              | `src-tauri/Info.ios.plist` (Tauri merges `Info.ios.plist` into the iOS app's Info.plist) | the same script                     |
| Out of iCloud and computer backups | `src-tauri/src/backup_exclusion.rs`, called at start                                     | unit tests; a device check (below)  |
| The manifest reaches the built app | `scripts/configure-ios-privacy.mjs`                                                      | `check-ios-privacy.mjs --app X.app` |

## Privacy manifest (draft for Ben)

`NSPrivacyTracking` false, no tracking domains, and **one collected data type, declared**: Ben decided the
clinic portal stays on iPhone, so the manifest says a **device identifier** (the device-made key id the
clinic's portal keeps for the linked device) is collected, **linked to the user, not used for tracking**, for
the purpose **App Functionality**. `scripts/check-ios-privacy.mjs` pins exactly that (`COLLECTED_DATA`): a
second type, another purpose, a changed linked or tracking flag, or dropping it is refused until the script,
this file and the store answers (`mycarlos-store-forms-draft-20261124.md`) are changed together. The App
Privacy label is therefore **no longer "Data Not Collected"**. **What the portal receives beyond the declared type (a decision for Ben and counsel; the pinned list is
not a complete account).** The privacy notice draft (`PRIVACY_NOTICE_DRAFT.md`, "What leaves your device") says the clinic's portal
also learns: the **device's name** (typed by the person), **delivery and receipt events**, the **times and how
often** the device checks (and, with notices and the background mode, asks "is anything waiting?"), and
the **internet address** the requests come from. Only the device identifier is declared here. The argument
for not declaring the rest is that this data goes only to the clinic's own portal server, which the publisher
does not operate and cannot access, so the publisher does not "collect" it in Apple's sense (data sent off the device that
the developer or its partners can access). Whether that holds, and whether the clinic counts as a third-party
partner, is not an engineering question: **until Ben and counsel decide, treat the one-entry list as
incomplete.** If they decide to declare more, the Apple types that would match are data types such as
"Other User Content", "Other Usage Data" and "Other Diagnostic Data", linked to the user, for App
Functionality, and the change goes in `COLLECTED_DATA` in the script, this file, the store answers and the
notice together.

Four required-reason API categories are declared (five reasons), because the Rust standard library, the
webview and the app's own disk-space check can reach them:

| Category         | Reason                                    | Why                                                                        |
| ---------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| File timestamp   | `C617.1` (files inside the app container) | opening and listing the app's own files                                    |
| File timestamp   | `3B52.1` (files the person granted)       | an import reads the size and dates of a file picked in the document picker |
| Disk space       | `E174.1` (check before writing)           | the free-space check before a download or a recording (`disk_space.rs`)    |
| System boot time | `35F9.1` (measure elapsed time)           | monotonic clocks (`Instant`)                                               |
| User defaults    | `CA92.1` (the app's own settings)         | the webview and plugins' own settings                                      |

**Disk space is declared as `E174.1` only** (a check before writing, then an error if there is no room). `85F4.1`
("show disk space to the person") is not declared because no screen shows a free-space figure: the messages
(`interface-RecordDialog-notEnoughRoom`, `ai-model-refusedDisk` and the like) say there is not enough room and what
the app needs, never how much is free. The day a screen shows that figure, add `85F4.1` to the manifest and
to `MINIMUM_REASONS` in the script.

Declaring a category the code never reaches does no harm; leaving one out is what Apple rejects (ITMS-91053).
**Xcode's Privacy Report on the first archive is the authority**; adjust the list and
`REQUIRED_APIS` in the script together. The script also refuses a changed tracking or collected-data answer, so
that cannot drift silently.

The manifest only counts at the **root of the app bundle**. The generated project is XcodeGen's, and a file in
its `<name>_iOS` folder is built in; `npm run ios:privacy` copies the manifest there and runs `xcodegen
generate` again. That is the one step not verified here (no macOS): the CI step that runs
`check-ios-privacy.mjs --app` on the built simulator app is the proof, and fails if the manifest is not at the
root.

## Export compliance (draft for Ben, with a lawyer)

`ITSAppUsesNonExemptEncryption` is set to **true**, which is the right answer for this app: it uses standard
algorithms of its own, beyond what iOS provides, and is not in the exempt list. What it ships (all standard,
implemented in Rust crates, none proprietary):

- vault and delivery encryption: **XChaCha20-Poly1305**, **Argon2id** (passphrase keys), **X25519** and **HPKE**
  (the clinic's deliveries to a device);
- signatures: **Ed25519** (device and notice keys);
- **HMAC** and **SHA-2** (SHA-256);
- **TLS to the clinic's portal through rustls** (the Rust TLS library, with the platform's certificate
  verifier): the app's **own TLS stack, not `NSURLSession`**, so it is not covered by iOS's own encryption.
  **Setting `true` does not stop App Store Connect asking.** With the key at `true`, App Store Connect asks for
  the export compliance documentation on each build until an `ITSEncryptionExportComplianceCode`, issued for an
  approved classification, is added to the Info.plist. (A claimed exemption would change the value to `false`; that
  and the classification are for counsel: US EAR 5D992 mass-market is the usual route, and Canadian rules
  apply.) France needs a declaration when non-OS encryption is distributed there. See
  `mycarlos-store-forms-draft-20261124.md` section 3.2.

## Out of iCloud and computer backups

App Store guideline 5.1.3(ii) forbids personal health information in iCloud. The vault is ciphertext, but a
backup would still carry its existence, sizes, dates and the header with the key wrapping, and `allowBackup` has
no iOS equivalent. `backup_exclusion::keep_out_of_device_backups` sets the attribute `com.apple.MobileBackup` = 1
(what `URLResourceValues.isExcludedFromBackup` sets) on the app's whole local data folder at start. The flag on
a folder covers everything in it, files made later too. A failure refuses vault work (below).
The patient's own copy is the encrypted backup file they choose to save, which they can keep in iCloud Drive
knowingly; that is their choice and is said in the privacy notice.

Tested here: the attribute call and its error handling (Linux, with the user namespace standing in for Apple's
attribute), and that nothing happens off iOS. **Not tested: on an iPhone.** A device check for Ben: install,
unlock, then on a computer make an encrypted Finder backup and look in it for the app's `Library/Application
Support` folder (it must be absent), or inspect with `xattr -l` on a development build.

## The webview's own storage (reviewed)

The exclusion covers the app's local data folder. WKWebView keeps `localStorage` and IndexedDB under
`Library/WebKit`, which **an iOS backup does take**, so nothing about a person or a document may live there.
The renderer uses `localStorage` only, for the choices below (the list is pinned by a test in
`scripts/check-ios-privacy.test.mjs`, which fails when a key is added until it is read and listed there; it
also refuses any `localStorage` get/set/remove whose key is typed at the call rather than a named constant). It
uses no IndexedDB, Cache API or cookies (the same test refuses them). `sessionStorage` is **not** scanned: it
is not written to disk and does not outlive the app. `mycarlos.unfinishedHandover.v1` gets the vault slot's
id as a `.<slotId>` suffix; that id is random and opaque and names no person.

| Key                                                                                                                                                         | Holds                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mycarlos.language.v1`, `mycarlos.appearance.v1`, `mycarlos.zoom.v1`, `mycarlos.aiLabelShort.v1`, `mycarlos.videoQuality.v1`, `mycarlos.cameraExplained.v1` | interface choices and a notice flag                                                                                                                                                                                                                                                                                                                                    |
| `mycarlos.autoLockMinutes.v1`                                                                                                                               | the idle lock minutes                                                                                                                                                                                                                                                                                                                                                  |
| `mycarlos.recoveryOfferHour.v1`, `mycarlos.unfinishedRecoveryKey.v1`                                                                                        | times and a flag of a recovery-key step; **no key**                                                                                                                                                                                                                                                                                                                    |
| `mycarlos.oldBackupsGuide.v1`                                                                                                                               | the step for older backups, **a time and a size, no file name**: the saved backup's name can carry a person's name and this storage is in iOS backups, so it is kept in memory for the session only (a test pins that it is never written, and drops one an earlier build stored). After myCarlos is closed the steps name the file by when it was saved and its size. |

(`mycarlos.unfinishedHandover.v1` is in the list now. Keys not on `main` yet, such as #429's, need an
audit row and an entry in the test's list when they merge after this.)

## Decisions for Ben (not changed here)

1. **Portal on iOS: decided, declared.** Ben decided to keep the clinic portal on iPhone and declare it (see the
   privacy manifest above). Still to confirm with counsel: whether the other things the portal sees need
   entries.
2. **If the backup flag cannot be set: decided, refuse.** Ben decided the vault stays out of Apple backups
   (iCloud and device backup; the mitigation is a separate myCarlos backup reminder). So when the flag cannot be
   set, `vault_create`, `vault_unlock` and `vault_recover` refuse before touching the vault with "This phone
   could not keep the vault out of device backups. Try again." (error code `backup_exclusion_failed`, message
   `native-backupExclusionFailed` in all seven languages). The flag is set again on every attempt (and once at
   start), so a failure that goes away stops refusing. After setting it the flag is read back, and a flag that
   did not stick is the same refusal. Tested: the refusal and the retry, the message and code, and that the three
   commands call the guard before the store; **not** on an iPhone.

## TestFlight workflow (draft for Ben: a patch, not applied)

`mycarlos-422-5-ios-release-workflow-20261124.patch` (in `/root/supervisor/for-ben/`, a new file under `.github/`,
so Ben's to apply) adds `mycarlos-ios-release.yml`: a signed archive for TestFlight. It starts **only by hand**
(`workflow_dispatch`): no `pull_request`, `pull_request_target` or push trigger, so a fork's code can never reach
the secrets. It runs in the **`ios-release` environment** (create it with required reviewers and "deployment
branches: main only"; the job also refuses any other ref), reads the repository with `contents: read` only,
pins every action by SHA like the other workflows, selects and **requires Xcode 26** (Apple needs the iOS 26
SDK since 28 April 2026), builds with `tauri ios build --export-method app-store-connect --build-number N`,
re-runs the privacy check on the built app, keeps the IPA as an artifact, and uploads to TestFlight only if
the `upload` input is ticked. Its keychain and profile are removed at the end.

**The secrets Ben must create, as secrets of the `ios-release` environment (not of the repository):**

| Secret                                      | What                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `APPLE_DISTRIBUTION_CERTIFICATE_P12_BASE64` | the Apple Distribution certificate with its private key, exported as `.p12`, base64 of the file |
| `APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD`   | the password set when exporting that `.p12`                                                     |
| `APPLE_APP_STORE_PROFILE_BASE64`            | the App Store provisioning profile for the app's bundle id, base64 of the `.mobileprovision`    |
| `APPLE_TEAM_ID`                             | the ten-character team id                                                                       |
| `APP_STORE_CONNECT_API_KEY_ID`              | the key id of an App Store Connect API key (role: App Manager or Developer)                     |
| `APP_STORE_CONNECT_API_ISSUER_ID`           | the issuer id shown with the API keys                                                           |
| `APP_STORE_CONNECT_API_KEY_P8`              | the contents of the `AuthKey_<id>.p8` file                                                      |

Needs an Apple Developer Program account, the app record in App Store Connect and the bundle id registered
(the bundle id is still `ca.carlos.mycarlos`, and the product name "myCarlos Evaluation"; both are Ben's
decisions before the first upload). **Not run anywhere**: the `CHECK` comments mark what the first real run
will most likely need fixed (the hosted runner label that carries Xcode 26, Tauri's exact signing options for
the generated project, and `altool`, which Apple has deprecated in favour of the App Store Connect API or
Transporter and which still works for upload).

## Not done here

The first real run of the TestFlight workflow, the `isExcludedFromBackup` result for a vault
restored from a file the patient picked (it lands in the same folder), the app name and bundle id, and the
privacy policy URL the store listing needs.

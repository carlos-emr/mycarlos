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

`NSPrivacyTracking` false, no tracking domains, **no collected data types** (the app sends nothing off the phone
today; this must change together with the Data safety answers if the portal, a push provider or cloud AI is
switched on). Four required-reason API categories are declared, because the Rust standard library, the
webview and the app's own disk-space check can reach them:

| Category         | Reason                                    | Why                                                                     |
| ---------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| File timestamp   | `C617.1` (files inside the app container) | opening and listing the app's own files                                 |
| Disk space       | `E174.1` (check before writing)           | the free-space check before a download or a recording (`disk_space.rs`) |
| System boot time | `35F9.1` (measure elapsed time)           | monotonic clocks (`Instant`)                                            |
| User defaults    | `CA92.1` (the app's own settings)         | the webview and plugins' own settings                                   |

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

`ITSAppUsesNonExemptEncryption` is set to **true**: the app uses standard algorithms of its own (XChaCha20-
Poly1305, Argon2id, X25519) beyond what iOS provides, and it is not in the exempt list. With the key present,
App Store Connect stops asking at every upload and asks the classification questions once. If counsel decides an
exemption applies, change the value (and add `ITSEncryptionExportComplianceCode` if Apple issues one). France
needs a declaration when non-OS encryption is distributed there. See
`mycarlos-store-forms-draft-20261124.md` section 3.2.

## Out of iCloud and computer backups

App Store guideline 5.1.3(ii) forbids personal health information in iCloud. The vault is ciphertext, but a
backup would still carry its existence, sizes, dates and the header with the key wrapping, and `allowBackup` has
no iOS equivalent. `backup_exclusion::keep_out_of_device_backups` sets the attribute `com.apple.MobileBackup` = 1
(what `URLResourceValues.isExcludedFromBackup` sets) on the app's whole local data folder at start. The flag on
a folder covers everything in it, files made later too. A failure is not fatal and is printed in a debug build.
The patient's own copy is the encrypted backup file they choose to save, which they can keep in iCloud Drive
knowingly; that is their choice and is said in the privacy notice.

Tested here: the attribute call and its error handling (Linux, with the user namespace standing in for Apple's
attribute), and that nothing happens off iOS. **Not tested: on an iPhone.** A device check for Ben: install,
unlock, then on a computer make an encrypted Finder backup and look in it for the app's `Library/Application
Support` folder (it must be absent), or inspect with `xattr -l` on a development build.

## Not done here

Xcode 26, signing and TestFlight (task 5, a workflow patch), the `isExcludedFromBackup` result for a vault
restored from a file the patient picked (it lands in the same folder), the app name and bundle id, and the
privacy policy URL the store listing needs.

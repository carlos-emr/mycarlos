# Release safety gate (issue #422)

(claude assist) `scripts/check-release-safety.mjs` fails a store build that carries something a store build must
not. It needs no build lock and no SDK: Node only, and it reads the artifacts itself (zip, Android binary and
protobuf XML, property lists).

```text
npm run check:release-safety -- --source                 the build configuration of this repository
npm run check:release-safety -- --android app.aab        an APK or AAB (or a plain manifest .xml)
npm run check:release-safety -- --ios myCarlos.ipa       an IPA or an unpacked .app
npm run check:release-safety -- --dist dist              the frontend build
npm run check:release-safety -- ... --app-id ca.example  another application / bundle id (a deliberate change)
```

Any number of modes at once; exit 1 if anything is found. **It fails closed:** a manifest or plist it cannot read,
an archive with no native library, or no mode at all is a finding, not a pass.

## What it refuses, and what each check rests on

| Finding                                                      | Where it looks                                                                                                                                                                                                                                                            | Rests on                                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai-helper-stub`, `cloud-ai`, tauri's `devtools` compiled in | `Cargo.toml` defaults and the `tauri` dependency (`--source`); `--features` / `-F` in the release script, release workflows and package release scripts (`--source`); a marker in the native code of an APK/AAB/IPA                                                       | Cargo; the stub names itself "FAKE stub"; the cloud send must define `mycarlos-cloud-ai` under its feature (a contract: **#72's code must add it**) |
| Dev or hot-reload hooks                                      | the frontend build (`--dist`): the Vite client, `import.meta.hot`, React refresh, the Vite ping, a webpack hot client                                                                                                                                                     | patterns of the dev tooling                                                                                                                         |
| A dev server address in the app                              | native code and the frontend: `localhost`, loopback, `10.0.2.2` or a private-network address with a port, except the configured `build.devUrl` (tauri embeds its config in every build; the real CI debug APK holds exactly `http://localhost:1420`)                      | observed on a real APK                                                                                                                              |
| A debug build                                                | `android:debuggable`, `android:testOnly`; iOS `get-task-allow`, a provisioning profile that lists devices (development or ad-hoc), `aps-environment` development; a native library that still has `.symtab` or `.debug_info` (Cargo's release profile has `strip = true`) | the manifest and profile; observed on a real APK                                                                                                    |
| Cleartext traffic                                            | `android:usesCleartextTraffic`; any network security config element with `cleartextTrafficPermitted="true"`; iOS App Transport Security `NSAllowsArbitraryLoads`, `NSAllowsLocalNetworking`, `NSExceptionAllowsInsecureHTTPLoads`                                         | the manifest, `res/xml`, `Info.plist`                                                                                                               |
| A wrong application id or bundle id                          | `package` of the manifest, `CFBundleIdentifier`, tauri.conf.json `identifier` and any `debugApplicationIdSuffix`; `EXPECTED_APP_ID` is `ca.carlos.mycarlos`                                                                                                               | a pinned constant: changing the id is a decision, made here and in tauri.conf.json together                                                         |
| `android:allowBackup` not false                              | the manifest                                                                                                                                                                                                                                                              | the vault must not go to Android backups                                                                                                            |

## What was checked against what

- **Real artifact:** the Android decoders (binary XML) and the markers were run on the real CI debug APK of
  `myCarlos-Evaluation-Android.apk`: the gate fails it with `debuggable`, `usesCleartextTraffic` and both native
  libraries "not stripped", and finds no stub or cloud marker in it (correct: CI builds without them).
- **Made-up artifacts:** every other case is tested with fixtures built in the test (a zip writer, a binary XML
  writer, a protobuf XML writer, plists, ELF-looking bytes), all FAKE: `npm run test:release-safety`, 13 cases.

## Not verified, and needs the first real release build

- The **protobuf XML** decoder (AAB) follows aapt2's `XmlNode` layout but was tested only on fixtures made from the
  same layout, not on a real AAB.
- A **binary `Info.plist`** is converted with macOS `plutil`; on another system the gate says it cannot read it
  (fail closed). Tests use XML plists.
- The **markers** (`FAKE stub`, `mycarlos-cloud-ai`) must be confirmed against a real build with each feature on;
  a marker that turns out to occur in a dependency is replaced, not ignored. `cloud-ai` does not exist in the code
  yet, so today it is covered by the feature-name checks only.
- Whether a **release** Tauri build still embeds the `devUrl` (we allow exactly that string) and whether Android
  Gradle strips the Rust library as expected.
- Detecting a devtools-enabled webview in a built artifact (the source checks refuse the `devtools` feature; no
  reliable string marker was found).

## In CI

The workflow steps are patches for Ben under `/root/supervisor/for-ben/`: `mycarlos-422-6-release-safety-workflow-...patch`
(tests and `--source` on every pull request; apply after patches 1, 2 and 4) and the iOS release workflow
(`mycarlos-422-5-...`) runs the gate on the IPA. The Android release script (`scripts/build-android-release.sh`,
#425) runs it on the bundle before it is copied out.

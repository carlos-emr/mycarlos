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
| `ai-helper-stub`, `cloud-ai`, tauri's `devtools` compiled in | `Cargo.toml` defaults and the `tauri` dependency (`--source`); `--features` / `-F` in the release script, release workflows and package release scripts (`--source`); a marker in the native code of an APK/AAB/IPA                                                       | Cargo; the stub names itself "FAKE stub"; the cloud send defines `mycarlos-cloud-ai` under its feature (`src-tauri/src/cloud_ai/gate.rs`) |
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
  writer, a protobuf XML writer, plists, ELF-looking bytes), all FAKE: `npm run test:release-safety`, 20 cases.

## Not verified, and needs the first real release build

- The **protobuf XML** decoder (AAB) follows aapt2's `XmlNode` layout but was tested only on fixtures made from the
  same layout, not on a real AAB.
- A **binary `Info.plist`** is converted with macOS `plutil`; on another system the gate says it cannot read it
  (fail closed). Tests use XML plists.
- The **markers** (`FAKE stub`, `mycarlos-cloud-ai`) must be confirmed against a real build with each feature on;
  a marker that turns out to occur in a dependency is replaced, not ignored. The `mycarlos-cloud-ai` marker is defined
  by `cloud_ai/gate.rs` and tested in the object code (`scripts/cloud-ai-gate.test.mjs`); it has not yet been looked
  for in a real packaged build.
- **Cloud AI (#72): which build is which.** The *release* profile (`tauri build`, the store and package builds; Cargo
  `PROFILE=release`, or `debug_assertions` off) does not compile with the `cloud-ai` feature: `cloud_ai/gate.rs` stops it, and
  `scripts/cloud-ai-gate.test.mjs` compiles that file with `rustc` both ways. The *evaluation and development* profile
  (`tauri build --debug`, `tauri dev`, `cargo test`; `debug_assertions` on) may carry it. This script refuses the feature on
  every build command that is not a debug-profile one (`--debug`), in the Cargo defaults, in an alias, and its marker in any
  store artifact; the evaluation workflows (`.github/workflows/mycarlos.yml`, `--debug`) are the only place the feature can
  be switched on, by a workflow line a maintainer adds.
- Whether a **release** Tauri build still embeds the `devUrl` (we allow exactly that string) and whether Android
  Gradle strips the Rust library as expected.
- Detecting a devtools-enabled webview in a built artifact (the source checks refuse the `devtools` feature; no
  reliable string marker was found).

## In CI

The workflow steps are patches for Ben under `/root/supervisor/for-ben/`: `mycarlos-422-6-release-safety-workflow-...patch`
(tests and `--source` on every pull request; apply after patches 1, 2 and 4) and the iOS release workflow
(`mycarlos-422-5-...`) runs the gate on the IPA. The Android release script (`scripts/build-android-release.sh`,
#425) runs it on the bundle before it is copied out.

## How the source checks work (after the review of #432)

- `Cargo.toml` is **parsed** (a small TOML reader for the subset Cargo uses), so the order of its tables does not
  matter. The **default feature closure** is resolved through the feature graph, including `dep/feature` and
  `dep?/feature` spellings (`default = ["tauri/devtools"]`, or `default = ["dev"]` with `dev = ["ai-helper-stub"]`).
  Every non-dev dependency's `features` are read in the inline, table (`[dependencies.tauri]`) and per-target forms.
- `tauri.conf.json` `build.features` and its build commands, and `.cargo/config.toml` aliases, are read too.
- Every command in **all** package scripts, workflows and shell scripts is tokenised (quotes, backslash-newlines,
  YAML steps): `-F x`, `-Fx`, `--features=x`, quoted space- or comma-separated lists, `--all-features` and
  `--cfg 'feature=...'` are all found, whatever the file is called. A forbidden feature on `cargo test`, `clippy`,
  `check`, `doc` and the like is fine (CI tests the stub); on anything else it is a finding. No file is skipped
  silently: `src-tauri/Cargo.toml`, `tauri.conf.json` and `package.json` are required, and finding no command at all
  is a finding.
- A manifest value that must be false is refused unless it is **literally false**: a `@bool/...` reference, an
  entity spelling of true, or any other value is a finding. Attributes are keyed by namespace, so
  `tools:debuggable="false"` cannot overwrite `android:debuggable="true"`.
- Native libraries are judged by their **ELF section headers** (`.symtab`, `.debug_*`), never by text in the file.
- **Bounded input:** the plain-XML scanner is linear and refuses over 1 MiB; one zip entry may inflate to at most
  1 GiB; a string index outside the pool, a truncated protobuf field and a runaway varint are errors. 20 tests,
  one for each false pass the review reproduced.

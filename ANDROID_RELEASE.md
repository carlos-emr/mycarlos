# Android release settings (issue #422)

(claude assist) The numbers Google Play checks for a release, and where each is pinned. This file grows
with the release work: page alignment and the signed bundle are added by their own changes.

| Setting      | Value            | Where it is set                                                                                                                              | Checked by                                                                  |
| ------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `targetSdk`  | 36 (Android 16)  | Written by the Tauri CLI into the generated `app/build.gradle.kts`                                                                           | `check-android-release-settings.mjs --generated` after `tauri android init` |
| `compileSdk` | 36               | The same file, and `src-tauri/android-pdf/android/build.gradle.kts`                                                                          | the same script                                                             |
| `minSdk`     | 24 (Android 7.0) | `src-tauri/tauri.conf.json` `bundle.android.minSdkVersion`; the plugin library; the `aarch64-linux-android24` linker in the CI compile check | the same script                                                             |
| NDK          | r28 or newer     | The runner's `$ANDROID_NDK_LATEST_HOME`                                                                                                      | `check-android-release-settings.mjs --ndk "$NDK_HOME"`                      |

Why: new apps and updates must target API 36 from 31 August 2026, and an NDK from r28 aligns native
libraries to 16 KB pages by default (Play refuses updates that do not support 16 KB pages from
1 February 2027). The script exists so that a Tauri upgrade, an edited Gradle file or an older NDK on the
runner fails a pull request instead of an upload.

**minSdk is a product decision, kept at 24 for now.** It is unchanged from what the app already
declared; this change only writes it down in one place that the generated project reads. Raising it
(Android 8.0, API 26, would drop about 1 % of devices and let the app drop its fallbacks) is Ben's call:
change `MIN_SDK` in the script, the three places above and `PRODUCT_DECISIONS.md` together.

Run locally: `npm run check:android-release` (source files) and `npm run test:android-release-settings`.
The CI steps are in the patch `mycarlos-422-1-android-pins-workflow-20261124.patch` (a change under
`.github/` is Ben's to apply).

## 16 KB memory pages

Google Play refuses updates that do not support 16 KB pages from 1 February 2027 (apps that target
Android 15 or newer, on 64-bit devices). `scripts/check-android-page-alignment.mjs` checks the built
files, not the settings:

```text
npm run check:android-page-alignment -- path/to/app.apk
npm run check:android-page-alignment -- path/to/app.aab
npm run check:android-page-alignment -- src-tauri/gen/android/app/src/main/jniLibs
```

For every 64-bit library (`arm64-v8a`, `x86_64`; the 32-bit ABIs are not subject to the rule) it
checks that:

1. every `PT_LOAD` segment of the ELF file has an alignment of at least 16 KB, which an NDK from r28 gives
   by default (older NDKs, and prebuilt libraries, may not);
2. in an APK, a library stored uncompressed starts at a multiple of 16 KB (`zipalign -P 16`, which the
   Android Gradle plugin does from 8.5.1). A compressed entry has no such rule. An AAB is checked for the
   ELF alignment only, because Play aligns the APKs it builds from it.

It refuses an archive in which it finds no 64-bit library, so a changed folder layout cannot make it pass
by checking nothing. The tests build small ELF files and zips; the script's reading was also compared
with `readelf` on a real library.

CI: the step after `tauri android build` is in the patch
`mycarlos-422-2-android-16kb-workflow-20261124.patch` (apply it after the first one). If a library ever
fails, the fix is the NDK (r28 or newer, pinned above) or, for a prebuilt library, a rebuilt one; a
linker flag (`-Wl,-z,max-page-size=16384`) is the fallback, and is not set today because the pinned NDK
already does it.

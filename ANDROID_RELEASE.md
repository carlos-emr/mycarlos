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

#!/usr/bin/env bash
# Builds the signed Android App Bundle (.aab) for Google Play (#422). No key is kept in the
# repository: set the four upload-key variables (see scripts/configure-android-signing.mjs) and,
# for a re-upload of the same version, MYCARLOS_BUILD_NUMBER (see scripts/android-version-code.mjs).
#
#   MYCARLOS_UPLOAD_KEYSTORE=/secure/upload.jks \
#   MYCARLOS_UPLOAD_KEYSTORE_PASSWORD=... MYCARLOS_UPLOAD_KEY_ALIAS=upload \
#   MYCARLOS_UPLOAD_KEY_PASSWORD=... MYCARLOS_BUILD_NUMBER=0 \
#   scripts/build-android-release.sh
#
# Needs what the CI Android job needs: Node 22, JDK 17, the Android SDK, an NDK r28 or newer in NDK_HOME,
# and the pinned Rust toolchain with the aarch64 and x86_64 Android targets. The result is copied to
# `release-out/android/myCarlos-<version>-<versionCode>.aab`, with the checks below already run.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${NDK_HOME:?set NDK_HOME to an Android NDK r28 or newer}"
for name in MYCARLOS_UPLOAD_KEYSTORE MYCARLOS_UPLOAD_KEYSTORE_PASSWORD MYCARLOS_UPLOAD_KEY_ALIAS MYCARLOS_UPLOAD_KEY_PASSWORD; do
  : "${!name:?set $name (the upload key is never kept in the repository)}"
done

code="$(node scripts/android-version-code.mjs)"
version="$(node -p "require('./src-tauri/tauri.conf.json').version")"
echo "Building myCarlos $version with versionCode $code"

node scripts/check-android-release-settings.mjs --ndk "$NDK_HOME"
npm ci
rm -rf src-tauri/gen/android
npm run tauri android init -- --ci
node scripts/check-android-release-settings.mjs --generated
npm run android:secure
node scripts/configure-android-signing.mjs

# The version code goes in through --config, which merges over tauri.conf.json for this build only.
npm run tauri android build -- --aab --target aarch64 x86_64 --ci \
  --config "{\"bundle\":{\"android\":{\"versionCode\":$code}}}"

mapfile -t bundles < <(find src-tauri/gen/android -name '*.aab' -path '*elease*' -type f)
if [ "${#bundles[@]}" -ne 1 ]; then
  echo "Expected exactly one release .aab, found ${#bundles[@]}" >&2
  exit 1
fi
bundle="${bundles[0]}"

node scripts/check-android-page-alignment.mjs "$bundle"
mkdir -p release-out/android
out="release-out/android/myCarlos-$version-$code.aab"
cp "$bundle" "$out"
echo "Done: $out"
echo "Upload it in Play Console (the upload key signed it; Play App Signing holds the app key)."

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

# The upload key must not be inside the working tree (it could be committed or swept into an artifact).
repository="$(pwd -P)"
keystore="$(realpath "$MYCARLOS_UPLOAD_KEYSTORE" 2>/dev/null || true)"
[ -f "$keystore" ] || { echo "MYCARLOS_UPLOAD_KEYSTORE does not name an existing file" >&2; exit 1; }
case "$keystore/" in
  "$repository"/*) echo "MYCARLOS_UPLOAD_KEYSTORE is inside the repository; keep the upload key outside it" >&2; exit 1 ;;
esac

# No Gradle daemon: the key variables are in its environment, and a daemon would keep them after this
# script ends. It is also stopped explicitly on the way out.
export GRADLE_OPTS="${GRADLE_OPTS:-} -Dorg.gradle.daemon=false"
stop_gradle() {
  if [ -x src-tauri/gen/android/gradlew ]; then (cd src-tauri/gen/android && ./gradlew --stop >/dev/null 2>&1 || true); fi
}
trap stop_gradle EXIT

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
# The release safety gate (needs scripts/check-release-safety.mjs, a separate change): no stub,
# dev, debug or cleartext settings, a right application id, a clean frontend build.
node scripts/check-release-safety.mjs --source --android "$bundle" --dist dist
mkdir -p release-out/android
out="release-out/android/myCarlos-$version-$code.aab"
cp "$bundle" "$out"
echo "Done: $out"
echo "Upload it in Play Console (the upload key signed it; Play App Signing holds the app key)."

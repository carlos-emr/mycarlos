#!/usr/bin/env bash
# The Android emulator smoke test, run by .github/workflows/mycarlos-android-emulator.yml
# inside the started emulator (adb already sees it). It checks only that the debug app
# installs, opens and stays up with nothing in the crash log, keeps a screenshot of its first
# screen, and that the APK names a launcher icon that is really inside it.
# It does NOT assert the status-bar inset, the keyboard or the icon's look, and it drives no
# page content: WebView debugging is not enabled, so there is no Playwright-on-Android yet.
# Usage: scripts/android-emulator-smoke.sh <output-dir>
set -euo pipefail

out=${1:?usage: android-emulator-smoke.sh <output-dir>}
mkdir -p "$out"
package=ca.carlos.mycarlos # "identifier" in src-tauri/tauri.conf.json

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

# One debug APK, from the build step.
mapfile -t apks < <(find src-tauri/gen/android -type f -name '*debug*.apk' -path '*outputs/apk*')
[ "${#apks[@]}" -eq 1 ] || fail "expected one debug APK, found ${#apks[@]}: ${apks[*]:-none}"
apk=${apks[0]}
echo "APK: $apk"

# The icon check needs no emulator: aapt2 names the launcher icon, and that file is in the APK.
aapt2=$(find "${ANDROID_HOME:?}/build-tools" -name aapt2 -type f | sort -V | tail -n 1)
[ -n "$aapt2" ] || fail "aapt2 not found under $ANDROID_HOME/build-tools"
"$aapt2" dump badging "$apk" > "$out/badging.txt"
grep -q "^package: name='$package'" "$out/badging.txt" || fail "APK is not $package"
grep -q "^launchable-activity:" "$out/badging.txt" || fail "APK has no launchable activity"
icon=$(sed -n "s/^application: .* icon='\([^']*\)'.*/\1/p" "$out/badging.txt" | head -n 1)
[ -n "$icon" ] || fail "APK names no launcher icon"
# Listed to a file first: with pipefail, `unzip | grep -q` fails by SIGPIPE when grep stops early.
unzip -Z1 "$apk" > "$out/apk-files.txt"
grep -Fxq -- "$icon" "$out/apk-files.txt" || { grep -i "ic_launcher" "$out/apk-files.txt" | head -n 20 || true; fail "launcher icon $icon is not inside the APK"; }
echo "launcher icon: $icon"

adb wait-for-device
adb install -r "$apk" > "$out/install.txt" 2>&1 || { cat "$out/install.txt"; fail "adb install failed"; }
cat "$out/install.txt"

adb logcat -c
adb shell monkey -p "$package" -c android.intent.category.LAUNCHER 1 > "$out/launch.txt" 2>&1 \
  || { cat "$out/launch.txt"; fail "the app would not launch"; }

# Up to 60 s for the app's window to be on top, then a few more seconds for its first screen.
resumed=no
for _ in $(seq 1 30); do
  top=$(adb shell dumpsys activity activities | grep -E "(mResumedActivity|topResumedActivity)" || true)
  if [[ "$top" == *"$package"* ]]; then
    resumed=yes
    break
  fi
  sleep 2
done
[ "$resumed" = yes ] || { adb logcat -d > "$out/logcat.txt"; fail "the app never came to the front"; }
sleep 10

adb exec-out screencap -p > "$out/first-screen.png"
[ "$(head -c 4 "$out/first-screen.png" | tail -c 3)" = "PNG" ] || fail "the screenshot is not a PNG"
adb shell dumpsys window > "$out/dumpsys-window.txt" || true
adb logcat -d > "$out/logcat.txt"

adb shell pidof "$package" > /dev/null || fail "the app is not running after opening"
crash=$(adb logcat -d -b crash | grep -v '^--------- beginning of' || true)
[ -z "$crash" ] || { echo "$crash" | head -n 40; fail "the crash log is not empty"; }
if grep -E "FATAL EXCEPTION|ANR in $package" "$out/logcat.txt" > "$out/problems.txt"; then
  head -n 20 "$out/problems.txt"
  fail "the log shows a fatal exception or ANR"
fi
echo "SMOKE OK: $package installed, open, no crash; screenshot $out/first-screen.png"

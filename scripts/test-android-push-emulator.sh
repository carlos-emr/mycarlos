#!/usr/bin/env bash
# Run on an API 34 emulator with the isolated synthetic APK.
set -euo pipefail
trap 'echo "Notice test failed at script line $LINENO"' ERR
apk=${1:?supply the test APK}
package=ca.carlos.mycarlos.pushtest
preview="$package/ca.carlos.mycarlos.push.NoticePreviewActivity"
main="$package/ca.carlos.mycarlos.MainActivity"
body='A new document is available in myCarlos.'

# Read accessibility text from the visible screen. Tap its actual bounds because
# system bars and density vary across emulator images.
find_text() {
  adb shell uiautomator dump /sdcard/notice-test.xml >/dev/null
  adb shell cat /sdcard/notice-test.xml > "$RUNNER_TEMP/notice-test.xml"
  python3 - "$RUNNER_TEMP/notice-test.xml" "$1" <<'PY'
import re, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1])
for node in root.iter("node"):
    if node.get("text", "").casefold() == sys.argv[2].casefold():
        x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.get("bounds")))
        print((x1 + x2) // 2, (y1 + y2) // 2)
        break
else:
    sys.exit(1)
PY
}
wait_for_text() {
  local coords
  for _ in {1..5}; do
    if coords=$(find_text "$1"); then echo "$coords"; return 0; fi
    sleep 1
  done
  echo "Text missing from screen: $1" >&2
  return 1
}
tap_text() {
  local coords x y
  coords=$(wait_for_text "$1")
  read -r x y <<< "$coords"
  adb shell input tap "$x" "$y"
}
notice_visible() {
  adb shell cmd notification list > "$RUNNER_TEMP/notice-list"
  grep -F "$package" "$RUNNER_TEMP/notice-list" | grep -F 'mycarlos-ready'
}

adb install -r "$apk"
adb logcat -c
adb shell am start -W -n "$main"
sleep 5
adb shell pidof "$package"
adb shell am start -W -n "$preview"
adb shell pm grant "$package" android.permission.POST_NOTIFICATIONS
tap_text 'Show test notice'
wait_for_text 'Test notice sent' >/dev/null
notice_visible
adb shell cmd statusbar expand-notifications
wait_for_text "$body" >/dev/null
adb exec-out screencap -p > push-download/test-notice.png
tap_text "$body"
for _ in {1..10}; do
  adb shell dumpsys activity activities > "$RUNNER_TEMP/notice-activities"
  if grep -E '(topResumedActivity|mResumedActivity)' "$RUNNER_TEMP/notice-activities" | grep -Fq "$main"; then break; fi
  sleep 1
done
grep -E '(topResumedActivity|mResumedActivity)' "$RUNNER_TEMP/notice-activities" | grep -F "$main"

# Tapping the first notice dismisses it. Try to send a NEW one with permission
# denied, rather than relying on when Android removes an old OS record.
adb shell pm revoke "$package" android.permission.POST_NOTIFICATIONS
adb shell pm set-permission-flags "$package" android.permission.POST_NOTIFICATIONS user-fixed
adb shell am start -W -n "$preview"
tap_text 'Show test notice'
wait_for_text 'Notifications are off' >/dev/null
if notice_visible; then echo 'Unexpected notification after denial'; exit 1; fi
adb logcat -d -b crash > "$RUNNER_TEMP/notice-crash-log"
if grep -Fq "Process: $package" "$RUNNER_TEMP/notice-crash-log"; then cat "$RUNNER_TEMP/notice-crash-log"; exit 1; fi
echo 'PASS: test notice visible, tap opened the app, denied permission suppressed the next notice'

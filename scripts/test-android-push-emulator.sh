#!/usr/bin/env bash
# Run with an API 34 emulator and the separate credential-free debug APK.
set -euo pipefail
apk=${1:?supply the test APK}
package=ca.carlos.mycarlos.pushtest
adb install -r "$apk"
adb logcat -c
adb shell am start -W -n "$package/ca.carlos.mycarlos.MainActivity"
sleep 5
adb shell pidof "$package"
adb shell am start -W -n "$package/ca.carlos.mycarlos.push.NoticePreviewActivity"
# Use the actual button bounds. System bars, density and locale can vary.
tap_preview() {
  adb shell uiautomator dump /sdcard/notice-test.xml >/dev/null
  adb shell cat /sdcard/notice-test.xml > "$RUNNER_TEMP/notice-test.xml"
  read -r x y < <(python3 - "$RUNNER_TEMP/notice-test.xml" <<'PY'
import re, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1])
button = next(n for n in root.iter("node") if n.get("text", "").lower() == "show test notice")
x1,y1,x2,y2 = map(int, re.findall(r"\d+", button.get("bounds")))
print((x1+x2)//2, (y1+y2)//2)
PY
)
  adb shell input tap "$x" "$y"
}
adb shell pm grant "$package" android.permission.POST_NOTIFICATIONS
tap_preview
for _ in {1..10}; do
  adb shell cmd notification list > "$RUNNER_TEMP/notice-list"
  if grep -F "$package" "$RUNNER_TEMP/notice-list" | grep -Fq 'mycarlos-ready'; then break; fi
  sleep 1
done
grep -F "$package" "$RUNNER_TEMP/notice-list" | grep -F 'mycarlos-ready'
adb shell cmd statusbar expand-notifications
sleep 1
adb exec-out screencap -p > push-download/test-notice.png
adb shell uiautomator dump /sdcard/notice-test.xml >/dev/null
adb shell cat /sdcard/notice-test.xml > "$RUNNER_TEMP/notice-panel.xml"
grep -Fq 'A new document is available in myCarlos.' "$RUNNER_TEMP/notice-panel.xml"
adb shell cmd statusbar collapse
adb shell pm revoke "$package" android.permission.POST_NOTIFICATIONS
adb shell cmd notification list > "$RUNNER_TEMP/notice-list"
if grep -F "$package" "$RUNNER_TEMP/notice-list" | grep -Fq 'mycarlos-ready'; then exit 1; fi
adb logcat -d -b crash > "$RUNNER_TEMP/notice-crash-log"
if grep -Fq "Process: $package" "$RUNNER_TEMP/notice-crash-log"; then exit 1; fi

#!/bin/bash
# Sets up the emulator for emulator-test.cjs and runs it: installs the app
# with its permissions, lets it draw over other apps, points the phone's
# https://localhost:8443 at the test server, and has its WebView accept the
# test server's self-signed certificate (a flag only test phones honour).
#
#   APK=path/to/app.apk OUT=dir NODE_PATH=.../node_modules bash emulator-test.sh
set -u
here=$(cd "$(dirname "$0")" && pwd)
pkg=net.tailchat.app

adb root >/dev/null 2>&1 && sleep 3
adb wait-for-device
# Room in the logs for the whole test, so Android's record of what it did
# to the app is still there at the end.
adb logcat -G 8M >/dev/null 2>&1 || true
adb shell 'echo "_ --ignore-certificate-errors" > /data/local/tmp/webview-command-line; chmod 644 /data/local/tmp/webview-command-line'
adb shell settings put system screen_off_timeout 1800000
# No "isn't responding" dialogs over the test, and a moment for the freshly
# booted phone to settle.
adb shell settings put global hide_error_dialogs 1
sleep 20
adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null
adb shell settings put global heads_up_notifications_enabled 1
adb reverse tcp:8443 tcp:8443
adb install -r -g "$APK"
adb shell appops set $pkg SYSTEM_ALERT_WINDOW allow
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
sleep 2

node "$here/emulator-test.cjs"
status=$?
adb logcat -d > "$OUT/logcat.txt" 2>/dev/null
exit $status

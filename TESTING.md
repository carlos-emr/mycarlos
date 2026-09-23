# Testing myCarlos on your own devices

This guide is for anyone who wants to install an evaluation build and try it, without building
anything. Every change to `main`, and a weekly scheduled run, publishes installable builds for
Windows, macOS, Android and the iOS Simulator.

> **Synthetic data only.** These are unsigned evaluation builds. Use the included FAKE sample PDFs
> or files you make up; never real patient records. Choose a throwaway passphrase: there is no way
> to recover a forgotten one except erasing the vault.

## Download a build

1. Open the [myCarlos evaluation workflow runs on `main`](https://github.com/carlos-emr/mycarlos/actions/workflows/mycarlos.yml?query=branch%3Amain).
   You must be signed in to GitHub to download.
2. Open the newest run whose job for your platform succeeded.
3. Under **Artifacts** at the bottom of the run, download the one for your platform:

| Platform | Artifact | Runs on |
| --- | --- | --- |
| Windows | `myCarlos-Windows-x64-Evaluation` | Windows 10 or 11, x64 |
| macOS | `myCarlos-macOS-AppleSilicon-Evaluation` | Macs with Apple silicon (M1 or later), not Intel Macs |
| Android | `myCarlos-Android-Evaluation` | Android phones (arm64) and emulators on a PC or Mac |
| iOS | `myCarlos-iOS-Simulator-Evaluation` | The iOS Simulator on an Apple silicon Mac with Xcode |

Each download is a ZIP holding the app, a `sample-files` folder of FAKE PDFs, and `BUILD.txt`,
which names the exact source commit. Downloads expire after 30 days; a newer run replaces them.
These are unoptimized debug builds, so they are large: the Android APK is about 320 MB.

There is no build for a real iPhone or iPad yet: installing on one needs an Apple Developer
account and signing. Linux has an unsupported debug `.deb` (`mycarlos-linux-evaluation-debug`)
for compatibility checks only.

## Install

### Windows

Extract the ZIP and run `myCarlos-Evaluation-Windows-x64-setup.exe`, then launch
**myCarlos Evaluation** from Start. Windows warns about an unknown publisher because the build is
unsigned; [WINDOWS.md](WINDOWS.md) explains the warning, checksums and uninstalling.

### macOS

1. Extract the downloaded ZIP, then double-click `myCarlos-Evaluation-macOS-AppleSilicon.zip`
   inside it. This produces **myCarlos Evaluation.app**; move it to Applications.
2. Open it. macOS refuses the first time because the app is not signed by a registered developer.
3. Open **System Settings → Privacy & Security**, scroll to the message about myCarlos
   Evaluation, and choose **Open Anyway**. Confirm, and the app opens from then on.

If there is no **Open Anyway** button, remove the download quarantine in Terminal and open the
app again:

```bash
xattr -dr com.apple.quarantine "/Applications/myCarlos Evaluation.app"
```

### Android emulator (for example, on your Windows PC)

1. In Android Studio, open **Device Manager** and create a device, for example a Pixel with a
   recent **x86_64** system image. Start it.
2. Extract the downloaded ZIP and drag `myCarlos-Evaluation-Android.apk` onto the emulator window.
   It installs as **myCarlos Evaluation**. (Or run `adb install -r myCarlos-Evaluation-Android.apk`.)
3. Drag the PDFs from `sample-files` onto the emulator window. They are saved to the emulator's
   Downloads folder, where the app's file picker can find them.

### Android phone

Copy `myCarlos-Evaluation-Android.apk` to the phone, open it, and allow installing apps from that
source when Android asks. The APK is signed with a debug key, so Play Protect may warn about it.
Copy the sample PDFs to the phone as well.

### iOS Simulator (Mac with Xcode)

1. Open Xcode's Simulator (`open -a Simulator`) and start an iPhone.
2. Extract the downloaded ZIP, then double-click `myCarlos-Evaluation-iOS-Simulator.zip` inside it.
3. Drag the resulting **myCarlos Evaluation.app** onto the Simulator window, or install it from
   Terminal: `xcrun simctl install booted "myCarlos Evaluation.app"`.
4. Drag the sample PDFs onto the Simulator window; they are saved to the Files app.

## What to try

On every platform:

1. Create a vault with a throwaway passphrase of at least 15 characters.
2. Press **New** and import the sample PDFs. The `_DUPLICATE` file should be reported as a
   duplicate and skipped.
3. Create a folder, move a document into it, and rename a document and a folder.
4. Open a document, choose **Save a copy**, and confirm the copy opens in a PDF viewer.
5. Lock the vault, quit the app, reopen it, and unlock: everything should still be there.
6. Under **Security**, set auto-lock to 1 minute, leave the app alone, and confirm it locks.
7. Send the app to the background (minimize it, or go to the home screen on a phone) and confirm
   it is locked when you come back.

On Android, also check the items in [issue #4](https://github.com/carlos-emr/mycarlos/issues/4):

- Press **New**, then press Home while the picker is open, and return: the vault should be locked.
- With auto-lock at 1 minute, browse in the picker for more than a minute, then choose a file: it
  should still import.
- Import a PDF from Downloads or Google Drive and note the name it is given.

On the iOS Simulator, also check the items in [issue #5](https://github.com/carlos-emr/mycarlos/issues/5):

- Save a copy to **Files → On My iPhone** (and to iCloud Drive if the Simulator is signed in to
  iCloud), and confirm it appears and opens.

[EVALUATION.md](EVALUATION.md) has the fuller evaluation checklist, including large files and
interrupted transfers.

## Start over

To remove everything, open **Security** and use **Erase entire vault**. Uninstalling also removes
the vault on Android and iOS. On desktop the vault stays until erased; it lives in:

- Windows: `%LOCALAPPDATA%\ca.carlos.mycarlos\vault-home`
- macOS: `~/Library/Application Support/ca.carlos.mycarlos/vault-home`
- Linux: `~/.local/share/ca.carlos.mycarlos/vault-home`

## Report what you find

Comment on [issue #4](https://github.com/carlos-emr/mycarlos/issues/4) (Android) or
[issue #5](https://github.com/carlos-emr/mycarlos/issues/5) (iOS), or open a new issue. Include
the platform and OS version, the device or emulator, the source commit from `BUILD.txt`, what you
did, and what happened. Screenshots help; they will only ever show synthetic data. Report
suspected security problems privately, as [SECURITY.md](SECURITY.md) describes, not in an issue.

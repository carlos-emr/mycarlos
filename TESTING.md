# Testing myCarlos on your own devices

This guide is for anyone who wants to install an evaluation build and try it, without building
anything. Every change to `main` publishes installable builds for Windows, macOS, Android and the
iOS Simulator.

> **Synthetic data only.** These are unsigned evaluation builds. Use the included FAKE sample PDFs
> and made-up names; never real patient records or names. Choose a throwaway passphrase: a
> forgotten one can be replaced only with the vault's recovery key, or else erased with the vault
> (see [Start over](#start-over)).

**Help improve this guide.** So far these builds have only been tried on Windows, so the steps for
macOS, Android and the iOS Simulator may be wrong or incomplete. If something does not work or does
not match what you see, please [report it](#report-what-you-find). Edits to this guide are
welcome as pull requests.

## Download a build

1. Open the [myCarlos evaluation builds from `main`](https://github.com/carlos-emr/mycarlos/actions/workflows/mycarlos.yml?query=branch%3Amain+event%3Apush).
   You must be signed in to GitHub to download. Use only the links in this guide: they list
   builds of the project's own code, not builds from other people's copies of it.
2. Open the newest run. A run can be marked failed because of another platform, so check that the
   job for your platform (the **Job** column below) has a green tick. If it has no downloads (they
   expire after 30 days), use the newest of the [weekly builds of `main`](https://github.com/carlos-emr/mycarlos/actions/workflows/mycarlos.yml?query=branch%3Amain+event%3Aschedule) instead.
   The top of the run page must say **Triggered via push**, **Triggered via schedule**,
   **Re-run triggered** or **Manually triggered**, with `main` as the branch. If it says
   **pull request**, or names another branch, it may be someone else's code, so do not install it.
   If every build has expired, ask a maintainer to start a new build of `main` (**Actions →
   myCarlos evaluation → Run workflow**, branch `main`) and send you the link to that run.
3. Under **Artifacts** at the bottom of the run, download the one for your platform:

| Platform | Job | Artifact | Runs on |
| --- | --- | --- | --- |
| Windows | Windows native build | `myCarlos-Windows-x64-Evaluation` | Windows PCs with an Intel or AMD (x64) processor |
| macOS | macOS native build | `myCarlos-macOS-AppleSilicon-Evaluation` | Macs with Apple silicon (M1 or later), not Intel Macs |
| Android | Android debug build | `myCarlos-Android-Evaluation` | Android phones (arm64) and emulators on a PC or Mac |
| iOS | iOS simulator debug build | `myCarlos-iOS-Simulator-Evaluation` | The iOS Simulator on an Apple silicon Mac with Xcode |

Each download is a ZIP holding the app, a `sample-files` folder of FAKE PDFs, and `BUILD.txt`,
which records the source it was built from; include it in bug reports. (It is not a safety
check: the run page in step 2 is.) Downloads expire after 30 days, so use the newest run.
These are unoptimized debug builds, so they are large: the Android APK is about 320 MB.

There is no build for a real iPhone or iPad yet: installing on one needs an Apple Developer
account and signing. Linux has an unsupported debug `.deb` (`mycarlos-linux-evaluation-debug`,
kept for 7 days) for compatibility checks only.

## Install

### Windows

Extract the ZIP and run `myCarlos-Evaluation-Windows-x64-setup.exe`. Because the build is
unsigned, Windows may show **Windows protected your PC**; choose **More info**, then
**Run anyway**. Then launch **myCarlos Evaluation** from Start. [WINDOWS.md](WINDOWS.md) explains
the warning, checksums and uninstalling.

### macOS

1. Extract the downloaded ZIP. (Safari may already have extracted it into a folder; if so, open
   that folder.) Then double-click `myCarlos-Evaluation-macOS-AppleSilicon.zip` inside it. This
   produces **myCarlos Evaluation.app**; move it to Applications.
2. Open it. macOS refuses the first time because the app is not signed by a registered developer;
   choose **Done**, not **Move to Trash**.
3. Open **System Settings → Privacy & Security**, scroll to the message about myCarlos
   Evaluation, and choose **Open Anyway**. Confirm with your Mac's password, and the app opens from
   then on.

If there is no **Open Anyway** button, or macOS says the app is damaged, remove the download
quarantine and open the app again. Open Terminal (press Command-Space, type `Terminal`, press
Return), then run:

```bash
xattr -dr com.apple.quarantine "/Applications/myCarlos Evaluation.app"
```

### Android emulator (for example, on your Windows PC)

1. Install [Android Studio](https://developer.android.com/studio) and open it. On the welcome
   screen choose **More Actions → Virtual Device Manager** (with a project open: **Tools → Device
   Manager**), and create a device, for example a Pixel with a recent system image: **x86_64** on
   a Windows or Intel PC, **arm64-v8a** on an Apple silicon Mac. Start it.
2. Extract the downloaded ZIP and drag `myCarlos-Evaluation-Android.apk` onto the emulator window.
   It installs as **myCarlos Evaluation**.
3. Drag the PDFs from `sample-files` onto the emulator window. They are saved to the emulator's
   Downloads folder, where the app's file picker can find them.

### Android phone

Copy `myCarlos-Evaluation-Android.apk` to the phone, open it, and allow installing apps from that
source when Android asks. The APK is signed with a debug key, so Play Protect may warn about it.
Copy the sample PDFs to the phone as well.

To move to a newer build on an emulator or phone, uninstall the old one first if Android refuses to
install over it; each build may be signed with a different debug key. Uninstalling erases its vault.

### iOS Simulator (Mac with Xcode)

1. Open Xcode and choose **Xcode → Open Developer Tool → Simulator**. If Xcode offers to download
   the iOS platform, accept. Then start an iPhone.
2. Extract the downloaded ZIP (Safari may already have done so), then double-click
   `myCarlos-Evaluation-iOS-Simulator.zip` inside it.
3. Drag the resulting **myCarlos Evaluation.app** onto the Simulator window. If it will not
   install, remove the download quarantine and try again: open Terminal (press Command-Space, type
   `Terminal`, press Return), type `xattr -dr com.apple.quarantine ` (with the trailing space),
   drag the app into the Terminal window to fill in its location, and press Return.
4. Drag the sample PDFs onto the Simulator window; they are saved to the Files app.

## What to try

On a phone or a narrow window, the sidebar is hidden: choose **My records** or **Security** from
the **Section** menu at the top instead.

On every platform:

1. Create a vault. For **First patient profile**, type a made-up name such as
   `FAKE Test Patient`. Choose a throwaway passphrase of at least 15 characters; the app rejects
   common or predictable ones.
2. Set up the recovery key the app shows next: try **Save kit…** (and **Print** on a computer),
   then **Next**, and type the whole key back. Typing it wrong says so; three wrong
   tries go back to the key. Check that the saved kit opens and shows the key and no names, and
   that the key's label shown beside the key is on the saved and the printed kit, and in
   **Security** once the key is set up.
3. Later, lock the vault and use **Forgot your passphrase?** → your recovery key and a new
   passphrase: the vault opens, the new passphrase works and the old one does not. In **Security**,
   **Replace recovery key** asks for the passphrase and why you are replacing it, and makes a new
   key. Choose "may have been lost, or seen". After you type it back, a system dialog (not part of
   the app's own screen) asks **Replace your recovery key?** Choose **Cancel** once: the setup stays
   open and says the current key still works. Check again and choose **Replace key**: the old key
   then stops working, and **Security** shows the steps for older backups. Choose **Save encrypted
   backup…**: the suggested name has the date and the key's label, and after saving, the steps
   name that file to keep and say to delete every other backup (on Android, which gives no name,
   they give the time it was saved instead). Replace the key once more with "I
   just want a new key": the app says to keep the old kit safe, and says nothing about deleting
   backups. The vault does not lock by itself while that dialog is open.
4. Press **New** and select all five sample PDFs together (on Windows or macOS, select them all in
   the folder; on Android, press and hold the first file, then tap the others; on iOS, tap
   **Select**). The app should say `4 file(s) encrypted and imported. 1 duplicate(s) skipped.`:
   the two Bloodwork files are identical.
5. Create a folder with **New folder**, open a document and use **Move to** to put it in the
   folder, then rename the document (**Rename document** in its details) and the folder
   (**Rename folder**).
6. Open a document, choose **Save a copy to this computer**, then **Save a copy**, and confirm the
   copy opens in a PDF viewer (a new emulator may not have one installed).
7. In **Security**, choose **Save encrypted backup…** and save the file somewhere other than the
   app's own folder. Import one more document (any PDF), then lock the vault and choose **Restore from a
   backup** on the unlock screen: pick the file, open it with the passphrase, and check that the
   app says the vault on this device is not the same as the backup and asks you to agree before
   restoring. After restoring, the vault is locked; unlock it and check that the extra document is
   gone and the others open. Try a copy of the backup with a few bytes changed: it is refused and
   nothing changes.
8. Press **Lock now** at the top, quit the app, reopen it, and unlock: everything should still be
   there.
9. In **Security**, set **Automatic lock delay** to 1 minute, leave the app alone (on a phone,
   keep the screen on), and confirm it locks.
10. Send the app to the background (minimize it, or go to the home screen on a phone) and confirm
    it is locked when you come back.
11. Import a large PDF, 200 MB or more (on a fast computer, import it from a USB stick or network
    drive so it takes several seconds). While it is still importing, send the app to the
    background, then come back within a minute. If the import is still running, the screen should
    say "Vault content is hidden. myCarlos will lock as soon as the transfer finishes." and the
    vault should lock by itself when it is done, saying only "Vault locked." Unlock: the app should
    say "Vault unlocked. 1 file(s) encrypted and imported." and the document should be in the
    library.
    On iPhone, the app says "Keep myCarlos open: switching apps pauses this transfer." while
    importing, and the import continues only when you come back. If you come back within the
    automatic lock delay, the screen says the vault will lock when the transfer finishes, and it
    does. If you stay away longer than that, the vault may instead lock as you return and leave the
    document out; after you unlock, the app says "The transfer did not finish." Either way nothing
    from the vault is shown meanwhile.

On Android, also check the items in [issue #4](https://github.com/carlos-emr/mycarlos/issues/4):

- Press **New**, then press Home while the picker is open, and return: the vault should be locked.
- With the lock delay at 1 minute, browse in the picker for more than a minute, then choose a
  file: it should still import.
- Import a PDF from Downloads or Google Drive and note the name it is given.

On the iOS Simulator, also check the items in [issue #5](https://github.com/carlos-emr/mycarlos/issues/5):

- Save a copy to **Files → On My iPhone** (and to iCloud Drive if the Simulator is signed in to
  iCloud), and confirm it appears and opens.

Developers can find a fuller checklist, including large files and interrupted transfers, in
[EVALUATION.md](EVALUATION.md); it needs a development setup.

## Accessibility checks

The automated tests catch missing labels and low contrast, but not whether the app makes sense to
someone listening to it. These checks need a person. Each screen reader below is free, and all
but NVDA are built in.

| Platform | Screen reader | Turn it on and off | Move / activate |
| --- | --- | --- | --- |
| Windows | Narrator (built in) | Ctrl + Windows + Enter | Tab / Enter or Space |
| Windows | [NVDA](https://www.nvaccess.org/download/) (free download) | Ctrl + Alt + N to start; Insert + Q to quit | Tab / Enter or Space |
| macOS | VoiceOver (built in) | Command + F5 | Tab / Control + Option + Space |
| Android | TalkBack (built in) | Settings → Accessibility → TalkBack | Swipe right or left / double-tap |
| iOS Simulator | None | VoiceOver does not run in the Simulator; use Xcode's Accessibility Inspector | — |

TalkBack is missing from some Android emulator images; use one whose name includes
**Google Play**, or a real phone. Screen readers also have a key to jump between headings: H in
NVDA and in Narrator's scan mode (Caps Lock + Space), or Control + Option + Command + H in
VoiceOver.

With the screen reader on, using only the keyboard (or only swipes on a phone), go through
[What to try](#what-to-try) and check each of these:

1. **Create a vault** (the first screen on a new install). Every field is read with its name,
   and the **Passphrase** field also with its rules ("Use at least 15 characters…"). Type two
   different passphrases: "Passphrases do not match." is read out. After **Create vault**,
   the recovery key setup opens and its title is read out.
2. **Unlock screen.** It opens in the **Passphrase** field and the reader says so. Unlock with a
   wrong passphrase: the reason is read out without you moving focus. Then unlock: "Vault
   unlocked." is read out (with a transfer's result, if one finished while the vault was locked).
3. **Finding your way.** Jumping by heading reaches the page title (for example **My records**)
   and each section in **Security**. The sidebar is read as the **Record library** navigation;
   on a phone, the **Section** menu is read with that name.
4. **Documents and folders** (in list view). Move through the list with the screen reader's
   reading keys (arrow keys in NVDA and Narrator, Control + Option + arrows in VoiceOver): each
   item is read by its name, followed by "document" or "folder". The extra buttons say what
   they act on ("More options for" or "Select", then the document's name), and **Select** says
   whether it is pressed.
5. **Messages.** After an import, a move or renaming a folder, the result (for example "4 file(s)
   encrypted and imported…") is read out without focus moving. Errors are read as soon as they
   appear. Renaming a document from its details reads out "Document renamed to…" once you are
   back in the details.
6. **Dialogs.** Opening a document's details, **Rename**, **Permanently delete**,
   **Save a copy** or the recovery key setup moves focus into the dialog and reads its title. Each
   group of the recovery key is read a character at a time ("Group 6: Y Z 0 1"). The recovery key
   setup of a new vault is the exception: Escape does not close it. In confirmations, focus
   starts on **Cancel**, so pressing Enter straight away does nothing harmful. With a keyboard,
   Tab stays inside the dialog, and Escape closes it and returns focus to the button that opened
   it (or, from a dialog opened within a document's details, to those details). When that button
   is gone by then, as after setting up a recovery key from the "No recovery key yet" notice, focus
   goes to the page's heading. Closing the recovery key setup once a key has been shown says
   that the key does not work.
7. **Locking.** After **Lock now**, focus is in the **Passphrase** field, not on something left
   over from the library, and the reader says "Vault locked." with the field. Check the same
   after an automatic lock.
8. **Keyboard.** You can reach every button, can always see where the focus is, and never get
   stuck.

Then turn the screen reader off and check text size:

- **Windows, macOS:** at the window's starting size, press Ctrl + plus (Command + plus on a Mac)
  up to 200%. The text grows, nothing is cut off or overlaps, and the page scrolls only up and
  down. Ctrl + 0 (Command + 0) resets it. Also try Windows **Settings → Accessibility → Text
  size** and report whether the app follows it.
- **Android:** set **Settings → Display → Font size** to the largest and reopen the app. Report
  whether the text gets larger, and whether anything is cut off.
- **iOS:** larger text in Settings is not expected to change the app yet; report what you see.

When you report a problem, name the screen reader and its version, and say what it read out and
what you expected it to read.

## Start over

To remove everything while unlocked, open **Security**, choose **Show reset controls**, type
`RESET MYCARLOS VAULT`, choose **Erase entire vault**, and confirm **Erase vault** in the dialog
that follows. If you forgot the passphrase, choose **Forgot your passphrase?** on the unlock
screen, type `RESET MYCARLOS VAULT`, choose **Erase vault**, and confirm **Erase vault** in the
dialog.

Uninstalling also removes the vault on Android and iOS. On desktop the vault stays until erased;
it lives in:

- Windows: `%LOCALAPPDATA%\ca.carlos.mycarlos\vault-home`
- macOS: `~/Library/Application Support/ca.carlos.mycarlos/vault-home`
- Linux: `~/.local/share/ca.carlos.mycarlos/vault-home`

## Report what you find

Comment on [issue #4](https://github.com/carlos-emr/mycarlos/issues/4) (Android) or
[issue #5](https://github.com/carlos-emr/mycarlos/issues/5) (iOS), or open a new issue. Include
the platform and OS version, the device or emulator, the source commit from `BUILD.txt`, what you
did, and what happened. Screenshots help, as long as they show only made-up data. Report
suspected security problems privately, as [SECURITY.md](SECURITY.md) describes, not in an issue.

## Automated Windows navigation smoke test

The Windows CI job runs `npm run test:windows-navigation` against the executable installed
from its freshly built NSIS package. It attaches Playwright to the real WebView2 window;
there is no frontend server or mocked native bridge. The test checks startup, real Rust IPC,
bundled-page reload, blocked outside/development-server navigation, and clicked links/popups
(including a popup to a bundled page). A local request detector checks that no canary URL arrives.
A changed document, transient external navigation, or extra webview also fails the test.

The job uploads `mycarlos-windows-navigation-evidence`, with the Playwright report, trace and
window screenshots. Failure evidence is captured only after Rust confirms there is no vault.
The test has no automatic retries and a failed test prevents publishing that run's Windows installer.

For a local run, use a disposable Windows account with no myCarlos vault. Install dependencies
with `npm ci`, set `MYCARLOS_WINDOWS_APP` to the absolute path of the installed executable,
and run `npm run test:windows-navigation`. A fresh temporary WebView profile is used and the
spawned app/process tree is stopped afterward. The profile does not relocate the native vault;
the test refuses an existing vault and never creates, unlocks, or deletes one. Remote debugging
is enabled only for this test process. No Playwright browser download is needed on Windows:
the test uses the installed WebView2 runtime. This suite deliberately fails on other platforms.

This test covers Windows desktop navigation. macOS/mobile behavior, native file pickers,
Narrator, and the documented upstream URL-parsing limitations still need their own checks.

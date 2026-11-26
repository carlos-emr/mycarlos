# Testing myCarlos on your own devices

This guide is for anyone who wants to install an evaluation build and try it, without building
anything. Every change to `main` publishes installable builds for Windows, macOS, Android and the
iOS Simulator. Only a real iPhone or iPad needs a build of your own, on a Mac.

> **Synthetic data only.** These are unsigned evaluation builds. Use the included FAKE sample PDFs
> and made-up names; never real patient records or names. Choose a throwaway passphrase: a
> forgotten one can be replaced only with the vault's recovery key, or else the vault set aside
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

There is no download for a real iPhone or iPad yet. With a Mac you can build one and install it
yourself: see [iPhone or iPad (build it on a Mac)](#iphone-or-ipad-build-it-on-a-mac). Linux has an
unsupported debug `.deb` (`mycarlos-linux-evaluation-debug`, kept for 7 days) for compatibility
checks only.

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

### iPhone or iPad (build it on a Mac)

This install builds an evaluation app on a Mac with full Xcode and the iOS platform, then signs
it for your connected phone with your Apple Account (a free Personal Team can be used). These
steps have not been tried on a real device here. Use only FAKE files and a throwaway test vault;
if a step fails, [report it](#report-what-you-find) with the source commit and last lines of output.

The default checkout below is **main at `315604a32202eae9168582bb66609841c2d8ead6`**.
It has no iPhone PDF reader: **Read** on a phone reports that documents cannot be shown yet.
The optional draft reader trial below uses a separate, exact source commit.

**Once, on the Mac:**

1. Install full **Xcode**, open it, accept its licence and add the **iOS** platform. Follow
   [Tauri's iOS prerequisites](https://v2.tauri.app/start/prerequisites/#ios). Command Line Tools
   alone are not enough. Check that `xcode-select -p` ends in `Xcode.app/Contents/Developer`;
   otherwise run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.
2. Use **Node 22.14.0**, matching this source's CI, from the
   [versioned Node download](https://nodejs.org/download/release/v22.14.0/), and install
   [rustup](https://rustup.rs/) and CocoaPods as described in the prerequisites. Then run:

   ```bash
   node --version
   rustup toolchain install 1.98.0 --profile minimal --component clippy --component rustfmt
   pod --version
   xcodebuild -version
   ```

   Node should report `v22.14.0`; `rust-toolchain.toml` pins Rust **1.98.0**.
   `npm ci` below installs the locked Tauri CLI **2.11.4**; do not install a global CLI or update
   the lockfiles. This repository does not pin Xcode or CocoaPods versions. Include their versions,
   the Mac's macOS version, and the phone's model and iOS version in your test report.
3. In **Xcode → Settings → Accounts**, sign in with your Apple Account, select your
   **Personal Team**, and use **Manage Certificates… → + → Apple Development**.
4. Get a fresh checkout of the default main source:

   ```bash
   git clone --no-checkout https://github.com/carlos-emr/mycarlos.git ~/mycarlos
   cd ~/mycarlos
   git fetch origin main
   git switch --detach 315604a32202eae9168582bb66609841c2d8ead6
   git rev-parse HEAD
   ```

   Confirm that `git rev-parse HEAD` prints the full commit above, then install dependencies:

   ```bash
   npm ci
   rustup target add --toolchain 1.98.0 aarch64-apple-ios
   ```

   The `aarch64-apple-ios` target is for a real phone; the downloadable CI app targets the
   Simulator and cannot be installed on the phone. For the optional reader trial, use its
   separate checkout below instead of this step.

**Each time you install** (from the selected checkout):

5. Set `APPLE_DEVELOPMENT_TEAM` to the 10-character team ID for the certificate you just created
   (under **Subject Name → Organizational Unit** in Keychain Access). Replace the placeholder
   below; use the same team you selected in Xcode. The variable lasts for this Terminal window.
   On the fresh checkout, initialize the iOS project once:

   ```bash
   export APPLE_DEVELOPMENT_TEAM='YOUR_TEAM_ID'
   npm run tauri ios init
   ```

6. Connect the unlocked phone with a data cable, tap **Trust** and enter its passcode. Let Xcode
   prepare it in **Window → Devices and Simulators**. On iOS 16 or later, enable
   **Settings → Privacy & Security → Developer Mode** and complete the restart. If the switch is
   missing, open Xcode's Devices window with the phone connected and check again.
7. Build and install, with the phone unlocked:

   ```bash
   npm run tauri ios run
   ```

   Choose the connected phone if prompted. This uses the bundled frontend, without a development
   server ([Tauri command reference](https://v2.tauri.app/reference/cli/#ios-run)). Allow the
   signing keychain prompt. The first install may need step 8 before it can open; then repeat
   this step.
8. On the phone, trust your developer under **Settings → General → VPN & Device Management**.

**Optional iPhone PDF reader trial — draft #105:**

Use the published [draft #105](https://github.com/carlos-emr/mycarlos/pull/105) at
**`098c576986b17c39edc1a8b7dd0f98d118db709b`**. It is unmerged; installing main does not enable
this reader. Instead of step 4, use a separate checkout:

```bash
git clone --no-checkout https://github.com/carlos-emr/mycarlos.git ~/mycarlos-iphone-trial
cd ~/mycarlos-iphone-trial
git fetch origin codex/agent2-ios-pdf-reader-20261022
git switch --detach 098c576986b17c39edc1a8b7dd0f98d118db709b
git rev-parse HEAD
```

Confirm that the printed commit is exactly the trial pin above, then run `npm ci` and
`rustup target add --toolchain 1.98.0 aarch64-apple-ios` here and continue steps 5–8 from this
checkout. To keep a separate main app installed alongside it, choose a distinct local bundle
identifier before `ios init`, as described in the troubleshooting table.

[This pin's automatic checks](https://github.com/carlos-emr/mycarlos/actions/runs/40524215876)
were still pending when recorded on 27 October 2026. Earlier head [7586137](https://github.com/carlos-emr/mycarlos/commit/758613727b9c0ea5557414413cb401e24b7f6114)
passed iOS Simulator compilation; that result is not a current-pin build or a device test.
Record the checks for the exact source you install.

This trial uses a separate native WebKit PDF view; it does not establish the desktop helper's
isolation guarantees. Native rendering, close/background/lock behavior, VoiceOver and repeated-read
memory checks still need a real iPhone. A successful Simulator compile or browser test is not
that proof. Import/export through Files, including **On My iPhone** and **iCloud Drive**, also
remain unverified ([issue #5](https://github.com/carlos-emr/mycarlos/issues/5)); the reader does
not resolve the save picker's security-scoped file and temporary-directory behavior.

**Sample files:** Five FAKE PDFs are included in the selected checkout's `dev-data/`. To regenerate
these synthetic files, run `npm run dev:data` there. AirDrop only `FAKE_*.pdf` to the phone and save
them to Files; `FAKE_MANIFEST.json` describes the samples and is not a PDF. Then follow
[What to try](#what-to-try), recording actual results and any platform limitations.

Good to know:

- **Free Personal Team:** Apple limits this to three installed apps per device and profiles that
  expire after seven days. Rebuild and reinstall using the same team and bundle identifier to
  renew the profile ([Apple's account guide](https://developer.apple.com/help/account/basics/about-your-developer-account)).
  Vault preservation during renewal has not been checked on a real phone here.
- **Updating a pinned checkout:** do not use `git pull` to change the source implicitly. Select
  another reviewed full commit in a fresh checkout, record it, run `npm ci`, and repeat the
  signing/install steps. Keep existing checkouts and vaults.
- **Removing:** deleting the app removes its vault. Do not uninstall it as a signing or reader fix.
- **Desktop only in main:** unlocking password-protected PDFs and the built-in PDF reader. The
  draft trial does not provide the desktop password-unlock controls on iPhone.
- **Camera:** enabled in the source on computers, Android and iPhone; real-phone permission and
  capture checks remain unperformed here.

**If something goes wrong:**

| You see | Do this |
| --- | --- |
| `xcodebuild` requires Xcode but the active developer directory is Command Line Tools | `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` |
| An iOS platform is missing | Install it in Xcode's Settings, then retry |
| The device target is not installed | In the selected checkout: `rustup target add --toolchain 1.98.0 aarch64-apple-ios` |
| `pod: command not found` | Complete the CocoaPods prerequisite, then open a new Terminal |
| No signing certificate or development team | Recheck steps 3 and 5, using the selected team's certificate |
| The bundle identifier is unavailable | Choose a unique local `identifier` in `src-tauri/tauri.conf.json` before initializing. Do not commit it. A different identifier installs a separate app with a separate vault |
| Developer Mode is disabled or the phone is locked | Complete step 6 and unlock the phone |
| A signature or profile is not trusted | Trust the developer in step 8 and repeat step 7 |
| A free development limit is reached | Check the account's limits in Xcode; preserve existing apps and vaults |
| The phone is not listed | Check the data cable, unlock and Trust, then check Xcode's Devices window |
| The build runs out of storage | Report the failing command and free storage; preserve existing checkouts and test evidence |

Anything else: [report it](#report-what-you-find) with the source commit, tool versions and last
lines of output. Never include a private signing key, passphrase or recovery key.

## What to try

On a phone or a narrow window, the sidebar is hidden: choose **My records** or **Security** from
the **Section** menu at the top instead.

On every platform:

1. Create a vault. For **First patient profile**, type a made-up name such as
   `FAKE Test Patient`. Choose a throwaway passphrase of at least 15 characters; the app rejects
   common or predictable ones.
2. Set up the recovery key the app shows next: try **Save recovery kit…** (and **Print recovery kit** on a computer),
   then **Next: check your recovery key**, and type the whole key back. Typing it wrong says so; three wrong
   tries go back to the key. Check that the saved kit opens and shows the key and no names, and
   that the key's label shown beside the key is on the saved and the printed kit, and in
   **Security** once the key is set up. During first setup, **Lock vault and finish later** or Escape
   first asks "Discard this recovery key?"; **Cancel** goes back to the setup. If a lock ends the setup
   (including **Discard key and lock**), the unfinished key does not work. The next unlock shows an unfinished-key warning.
   On a later eligible unlock, setup opens by itself, at most once a day
   (the rest of the time only the notice offers it). It
   shows no key until you type your passphrase and choose **Continue**; **Set up later** closes it.
3. Later, lock the vault and use **Forgot your passphrase?** → your recovery key and a new
   passphrase: the vault opens, the new passphrase works and the old one does not. In **Security**,
   **Replace recovery key** asks for the passphrase and why you are replacing it, and makes a new
   key. Choose "may have been lost, or seen". After you type it back, a system dialog (not part of
   the app's own screen) asks **Replace your recovery key?** with the buttons **Keep current key**,
   **Replace key** and **Cancel**. Choose **Keep current key**, or **Cancel**, once: the setup stays
   open and says the current key still works. Check again and choose **Replace key**: the old key
   then stops working, and **Security** shows the steps for older backups. Choose **Save encrypted
   backup…**: the suggested name has the date and the key's label, and after saving, the steps
   name that file to keep and say to delete every other backup (on Android, which gives no name,
   they give the time it was saved instead). Replace the key once more with "I just want a new
   key": the app says to keep the old kit safe, and says nothing about deleting backups. The vault
   does not lock by itself while that dialog is open.
4. Press **Add document**, choose **Import a file**, and select all five sample PDFs together (on Windows or macOS, select them all in
   the folder; on Android, press and hold the first file, then tap the others; on iOS, tap
   **Select**). The app should say `4 file(s) encrypted and imported. 1 duplicate(s) skipped.`:
   the two Bloodwork files are identical.
5. Create a folder with **New folder**, open a document and use **Move to** to put it in the
   folder, then rename the document (**Rename document** in its details) and the folder
   (**Rename folder**). With two people in the vault, open a filed document's details,
   choose the other person's records or one of their folders under **Move to**, then press
   **Move**. Check it appears there and its saved copy is unchanged. If that person already
   has the same file, the document stays with its original person and the notice says so.
6. Open a document, choose **Save a copy to this device**, then **Save a copy**, and confirm the
   copy opens in a PDF viewer (a new emulator may not have one installed).
7. In **Security**, choose **Save encrypted backup…** and save the file somewhere other than the
   app's own folder. Import one more document (any PDF), then lock the vault and choose **Restore from a
   backup** on the unlock screen: pick the file, open it with the passphrase, and check that the
   app says the vault on this device is not the same as the backup and asks you to agree before
   restoring, first on the app's own screen and then in a system dialog (**Keep this vault**,
   **Replace with backup**, **Cancel**). After restoring, the vault is locked; unlock it and check that the extra document is
   gone and the others open. Try a copy of the backup with a few bytes changed: it is refused and
   nothing changes.
8. Press **Lock now** at the top, quit the app, reopen it, and unlock: everything should still be
   there.
9. The Evaluation downloads do not show the speed test: **Speed test, for testers** is in
   development builds only (owner decision, 20 Nov 2026). Device benchmarks are collected by a
   developer from a development build (`npm run tauri dev`, `npm run tauri android dev` or
   `npm run tauri ios dev`) or from a build made with `VITE_SHOW_SPEED_TEST=1`;
   `ARGON2_BENCHMARK.md` says how to run it and record the lines. Check that **Security** in the
   Evaluation download has no **Speed test, for testers** section.
10. In **Security**, set **Automatic lock delay** to 1 minute, leave the app alone (on a phone,
    keep the screen on), and confirm it locks.
11. Send the app to the background (minimize it, or go to the home screen on a phone) and confirm
    it is locked when you come back. On the unlock, set-up and restore screens, press **Show
    passphrase** (or **Show recovery key**) first: the text must be back to dots when you return,
    and what you typed must still be there. On a computer the text also goes back to dots whenever
    the window loses the focus: copying a shown key to or from a password manager, or a native
    dialog over the app, hides it again. That is by design (a phone takes the app switcher's
    picture before the page is reported hidden); press **Show** again to see it.
12. On a computer with a camera (Windows, macOS or Linux), choose **Add document**, then **Take a photo**.
    The first time, the window explains why myCarlos uses the camera; choose **Use the
    camera**. On a Mac, macOS then asks whether myCarlos may use the camera, with the same reason;
    Windows and Linux ask nothing more. The camera's light comes on. Point it at a FAKE document,
    choose **Take photo**: the light goes off and the photo shows. Try **Retake**, then **Use
    photo**. The photo's details open, named like `Photo, 17 Oct 2026, 3.05 PM.jpg`, in the folder
    that was open. Choose **View photo**, try **Zoom in** and **Zoom out**, then **Close**. Rename
    the photo without `.jpg`: **View photo** still shows it. Save a copy and open it in another
    app: its details there show no place, camera or date taken.
    Then turn the camera off for apps in the computer's privacy settings and try again: the window
    says where to turn it back on, and the rest of the app keeps working. Also check that the
    light goes off when you choose **Cancel**, press Escape, minimize the window while the camera
    is on, or let the vault lock.
    **On a phone** (Android, or a real iPhone: the iOS Simulator has no camera), **Take a photo**
    is in the **Add document** menu too (beside the heading, because a phone's width hides the
    sidebar). The first time, the window says the phone asks once; choose **Use the
    camera**, and the phone asks whether myCarlos may use the camera (an iPhone with the reason
    "myCarlos uses the camera to save photos of your health documents…"). Allow it. The vault
    stays unlocked while the phone asks, the back camera's view shows, and the steps above work
    the same. Then check:
    - **No copy anywhere:** after saving a photo, nothing new is in the phone's Photos or Gallery
      app, or in its Files app.
    - **Refused:** in the phone's Settings, turn the camera off for myCarlos (Android: Apps →
      myCarlos → Permissions → Camera; iPhone: myCarlos → Camera) and choose **Take a photo**:
      the window says where to turn it back on, and the rest of the app keeps working. Turn it
      on and choose **Try again**. On Android, also choose **Don't allow** twice when asked:
      Android then stops asking, and the window still says where to allow it.
    - **Leaving:** with the camera on, go to the home screen and come back: the camera indicator
      went off and the vault is locked. Do the same while the phone's question is showing: the
      vault is locked when you come back.
    - **The indicator:** the camera dot (green on both phones) goes off when you take the photo,
      choose **Cancel**, or the vault locks.
    - **TalkBack or VoiceOver:** the shutter is read as "Take photo", and after a photo the focus
      is on **Use photo**. At the largest text size, every button can be reached.
13. Import a large PDF, 200 MB or more (on a fast computer, import it from a USB stick or network
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
13. **Shared with me.** With myCarlos closed, open a FAKE PDF with it (on Windows, use the
    command-line forwarding check below; installer **Open with** and **Send to** registration
    remains pending in #53; on a Mac, use Finder's **Open With** where available). The lock screen says one
    shared file is waiting, without its name. Unlock: the sidebar shows **Shared with me** with
    "1 new", and the app says the file was added. With one person in the vault it sits among
    their folders; with several, above them, outside everyone's records. Open it: the "new" goes,
    and the file is listed with its size. Open the file's details and choose a place under **Move
    to**: it moves there, and Shared with me is empty. Open a file that is not a PDF the same way
    (a FAKE `.txt` renamed `.pdf` will do): after unlocking, the app names it and says it was not
    added. Sharing from another app on a phone comes with the phone issues (#50 to #53).

**Windows second-launch forwarding (#53; real Windows execution still required).**
Use a build containing this change, a synthetic vault, and two FAKE PDFs. In PowerShell,
replace the executable placeholder with the actual installed executable path:

```powershell
$appPath = 'C:\replace-with-the-actual-installed-executable.exe'
& $appPath 'C:\FAKE Samples\FAKE first.pdf'
```

With the app initially closed, it should open one window and show only a waiting count
until unlock. After unlocking, myCarlos asks "Import <name> into Shared with me?" first;
the file is added only after **Import** (Cancel keeps nothing), and then appears in Shared
with me with its size and **Manual import — unverified** label. Keep the app running for the
second launch:

```powershell
Start-Job -ArgumentList $appPath, 'C:\FAKE Samples\FAKE José 结果.pdf' -ScriptBlock {
    param($program, $file)
    Start-Sleep -Seconds 5
    & $program $file
}
```

Bring myCarlos to the front before five seconds pass and leave it focused. The second
file should ask once ("Import <name> into Shared with me?"), without requiring another focus
change or another window; a file that arrives while a question is open waits for its own
question after you answer. Repeat while locked with another FAKE PDF: the count changes,
names remain hidden, and unlocking asks before adding it. Also try the startup "Open with"
while unlocked (it asks too), Cancel (nothing is stored), and a path such as `\\.\pipe\x`
or `\\?\GLOBALROOT\x` on the command line (it is ignored).
Also record startup/exit races, a second arrival during an import, an unreadable-file
retry, and password-protected PDF helper operation. Record the exact build and results;
browser mocks and cross-compilation do not establish these Windows outcomes. This checks
the executable handoff only; Explorer/Outlook menus, installer registration/uninstall,
unchanged default PDF handling and Windows 11 Share remain separate acceptance work.

On Android, also check the items in [issue #4](https://github.com/carlos-emr/mycarlos/issues/4):

- Press **Add document**, choose **Import a file**, then press Home while the picker is open, and
  return: the vault should be locked.
- With the lock delay at 1 minute, browse in the picker for more than a minute, then choose a
  file: it should still import.
- Import a PDF from Downloads or Google Drive and note the name it is given.

On the iOS Simulator, also check the items in [issue #5](https://github.com/carlos-emr/mycarlos/issues/5):

- Save a copy to **Files → On My iPhone** (and to iCloud Drive if the Simulator is signed in to
  iCloud), and confirm it appears and opens.

Developers can find a fuller checklist, including large files and interrupted transfers, in
[EVALUATION.md](EVALUATION.md); it needs a development setup.

## Recording and playing a video (#359)

Use **made-up people and documents only** (a person named "FAKE Patient", a filing folder of your own),
and point the camera at something harmless. Sound is recorded: anyone talking near the device is heard.

**On every platform**

1. In **My records** choose **Record a video**. Where the webview cannot record MP4 the button is
   replaced by "Video recording isn't available on this device" and a **Why?** that explains: check
   that, and that **Take a photo** still works.
2. In the dialog read the notice about sound, then choose **Use the camera and microphone**. The system
   (or, on Windows and Linux, the app alone) allows it; nothing is recorded yet. Then **Start recording**.
3. Check the **Recording** badge and the **Recorded 0:07** time. Press **Pause recording**: the badge says
   **Paused**, the note says the camera and microphone are still on, the time stops, and a screen reader
   says "Recording paused." **Resume recording**: it counts on.
4. **Stop and save.** The video appears in the list; open it and choose **Play video**. Seek by the bar
   and with the arrow keys; check that it neither starts by itself nor repeats, that sound plays, and that
   the time shown is the time you recorded **without** the pause.
5. Close the player, then **Lock now** while a video is open: the player goes and nothing plays.
6. **Idle lock.** Set the automatic lock to 1 minute. Record for 2 minutes without touching the screen:
   it must **not** lock. Pause and wait: it **must** lock about a minute later, and after unlocking the
   video that was saved is there with a note.
7. **A crash.** Start recording, then end myCarlos from the system (kill it). Open it again and unlock: it
   asks "myCarlos closed while you were recording. Keep the video that was saved?" with **Keep the video**
   focused. Try **Delete it**: it asks again and says it cannot be undone. Keep it and play it.
8. **Hiding while recording.** Switch to another app while recording: the recording ends and is saved.
9. **Room.** On a device or volume with little free space (a small disk image is enough), **Record a video**
   with under 1 GB free: the dialog says there is not enough room and neither the camera nor the
   microphone turns on. With a little more, record until it warns about the room left and then stops by
   itself, saved: "Saved. There was no more room." (If the disk fills before it can stop, the message says the video is kept as an unfinished recording and will be finished when there is room. On iOS and Android the free space myCarlos sees can be less than Settings shows, because it leaves out what the system can reclaim.)
10. **Hide a video** from its details while it plays: the player stops.

11. **Backups with videos.** In Security, under the backup, read "About … GB, of which videos …" before saving.
    Tick **Leave videos out**: the size drops, and the note says the videos will not be brought back.
    Save it, then **Restore backup** from the start screen on a second device or after setting the vault
    aside: it says "This backup was made without videos…" before you agree. After restoring, the videos are
    listed with the hidden documents as missing files, and everything else opens as before. Save a backup
    without ticking the box and check the videos come back and play.

**Windows (WebView2).** Windows has no per-app prompt for the microphone: "Let desktop apps access your
microphone" in Settings > Privacy decides. Switch it off and check the dialog says where to look. On an
**N or KN edition** without the Media Feature Pack, expect the "isn't available" line.

**macOS.** The system asks for the camera and the microphone with the texts in the dialog's explanation.
An unsigned build without the hardened runtime asks; a signed one needs the camera and audio-input
entitlements (not yet signed, #24).

**Linux (WebKitGTK).** Install `gstreamer1.0-plugins-bad` and `gstreamer1.0-plugins-ugly` (and
`gstreamer1.0-libav`) first: without them there is no Record. Nothing asks: the app allows the camera and
microphone for its own pages. Check that the screen is never offered.

**Android.** A phone with Android 7 or older shows the "isn't available" line. Otherwise the phone asks once
for the camera and the microphone (also try **Don't ask again** and check the message). Rotate the phone
while recording, take a call (the recording ends and is saved), and lock the phone.

**iPhone and iPad.** From iOS 14.5; before that, the "isn't available" line. The simulator has no camera:
use a real device. The prompt text is the one in the dialog's explanation.

### Camera and microphone on Apple devices (the Wry patch, #359 PR 7)

myCarlos carries a patch to Wry (`src-tauri/vendor/wry.patch`) so that on a Mac, an iPhone and an iPad the
webview answers a camera and microphone request as the other platforms do: **video, alone or with sound, from
myCarlos's own page, and nothing else**. The decision itself is tested on any computer; the Apple code that
asks it is compiled and run only on an Apple device, so it needs these checks. Use the CI's macOS build and an
iPhone or iPad build (not `tauri dev`: the development server is refused on purpose, so the camera does not
work there).

1. **A photo** (My records, **Take a photo**): the system asks for the camera once; the preview appears; take a
   photo. It must work as before the patch.
2. **A video with sound** (**Record a video**): the system asks for the camera and then the microphone, once each;
   recording, pause, resume and stop work, and the sound is in the saved video.
3. **Denied in Settings.** Turn the camera off for myCarlos in System Settings (macOS: Privacy & Security;
   iOS: Settings > myCarlos), then try again: the dialog says it could not start, and the camera light stays
   off. Turn it back on.
4. **Nothing turns on by itself.** Open myCarlos, open every screen except the photo and video dialogs, and
   watch the camera light and the orange or green indicator: it must stay off. After closing a dialog or
   locking, it must go off at once.
5. **Not from another page.** This is the one the patch adds, and cannot be tried from the app's own screens:
   it is covered by the unit tests of the decision. If you have a debugging build with the Safari Web
   Inspector attached, run `navigator.mediaDevices.getUserMedia({audio:true})` in the console: it must be
   refused (sound alone), where before the patch it asked the system.
6. **Both versions.** Repeat 1 and 2 on the oldest macOS and iOS you have. The patched method exists only on
   macOS 12 and later and iOS 15 and later: on macOS 10.13 to 11 and on iOS 14.5 to 14.8 (the app's lower end)
   WebKit never calls it, so its own default answers and step 5 will not show the patch's refusal there. Note
   which of those you tried; if they matter, the minimums are the thing to raise.

If any of 1 to 3 fails, the patch is wrong for that system: the delegate method is the only place to look
(`src-tauri/vendor/wry/src/wkwebview/class/wry_web_view_ui_delegate.rs`).

## Accessibility checks

The automated tests catch missing labels and low contrast, but not whether the app makes sense to
someone listening to it. These checks need a person. Each screen reader below is free, and all
but NVDA are built in.

Two browser tests go part of the way first, in Chromium with a synthetic vault:
`tests/keyboard-walk.spec.ts` uses only the keyboard through first setup, unlocking, the library,
Settings and the lock warning (every control reached in order, focus shown, no traps, Escape
closes dialogs), and
`tests/screen-reader-smoke.spec.ts` checks that controls have names, headings go in order and the
key events are read out. Problems they find are listed with `test.fail` and an issue number. They
are not a screen reader: the steps below still apply.

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
6. **Dialogs.** Opening a document's details, **Rename**, **Hide**,
   **Save a copy** or the recovery key setup moves focus into the dialog and reads its title. Each
   group of the recovery key is read a character at a time ("Group 6: Y Z 0 1"). The recovery key
   setup of a new vault is the exception: there, Escape asks "Discard this recovery key?" first,
   as **Lock vault and finish later** does; in that question, Escape means **Cancel**, so pressing
   Escape twice discards nothing. In confirmations, focus
   starts on **Cancel**, so pressing Enter straight away does nothing harmful. With a keyboard,
   Tab stays inside the dialog, and Escape closes it and returns focus to the button that opened
   it (or, from a dialog opened within a document's details, to those details). When that button
   is gone by then, as after setting up a recovery key from the "No recovery key yet" notice, focus
   goes to the page's heading. Closing the recovery key setup once a key has been shown says
   that the key does not work.
7. **Locking.** After **Lock now**, focus is in the **Passphrase** field, not on something left
   over from the library, and the reader says "Vault locked." with the field. Check the same
   after an automatic lock, where the reader gives the reason instead: "Locked after 1 minute
   without use." With the delay at 1 minute, after 30 seconds without touching anything the
   reader reads "myCarlos will lock in 30 seconds to keep your records private." and the focus
   is on **Keep open**; pressing it, or any key, keeps the vault open for another minute. Check
   the warning again at 400% text size: **Keep open** can be reached and pressed.
8. **Keyboard.** You can reach every button, can always see where the focus is, and never get
   stuck.

Then turn the screen reader off and check app zoom (and, on a phone, the device's own text size):

- **Windows, macOS, Linux:** at the window's starting size, press Ctrl + plus (Command + plus on a Mac)
  up to 200%. The text grows, nothing is cut off or overlaps, and the page scrolls only up and
  down. Ctrl + 0 (Command + 0) resets it. After unlocking, **Settings → Preferences → App zoom**
  shows the zoom, with **−** and **+** buttons ("Zoom out" and "Zoom in") and a box to type a
  percentage, that do the same. Also try Windows
  **Settings → Accessibility → Text size** and report whether the app follows it.
- **Windows, macOS, Linux, the size is remembered (new, and not yet tried by anyone):**
  1. Press Ctrl + plus once (Command + plus on a Mac). Does the size change by one step, or by
     two? It should be one.
  2. Close the app at a size other than 100% and open it again. It should open at the size you
     left it, without first showing at 100%. The next Ctrl + plus (Command + plus) should go one
     step on.
  3. Go to the largest size (400%) with the window at its smallest. Can you still unlock? Before
     unlocking, Ctrl + 0 (Command + 0) is the way back; after, also **Settings → Preferences → App zoom →
     Back to 100%**.
  4. On Windows, hold Ctrl and turn the mouse wheel one notch: one step. On Linux, report how
     many notches one step takes (Linux reports the wheel differently; one is expected, more is
     possible). On a touchpad, scroll with two fingers while holding Ctrl, and pinch: the size
     should change slowly or not at all, never jump to the largest. On a touch screen, pinching is not
     expected to zoom any more; use the buttons in **Settings → Preferences**, after unlocking.
  5. On a Mac, Control with the wheel is the system's own zoom and myCarlos leaves it alone.
  6. In **Settings → Preferences**, with a screen reader on, press **+** (read as "Zoom in"):
     it should say the new zoom ("App zoom 110%"). Type 150 in the box and press Enter: it should say 150%. Press
     **Back to 100%**: the focus should move to **+**, not be lost.
  7. Type 130 in the box and press Enter: the size goes to 125% and a line under the box says why.
     Type 500: 400%, the largest. Type `abc`: nothing changes, and the box says to type a number
     from 80 to 400. Press Escape while typing: the box goes back to the size shown.
  8. On Windows and Linux, at 200% and at 400%, hold Ctrl and turn the wheel toward smaller
     text: as many notches for one step as at 100%.
- **Android:** set **Settings → Display → Font size** to the largest and reopen the app. Report
  whether the text gets larger, and whether anything is cut off.
- **iOS:** larger text in Settings is not expected to change the app yet; report what you see.

When you report a problem, name the screen reader and its version, and say what it read out and
what you expected it to read.

## Nothing about a document in the device log (by hand, release build)

The app writes nothing about a document to a log: its native code, its plugins and its pages have no
logging call that names a file, a person, document text, a portal id or a token, and its errors are fixed
codes. This check shows it on a real device, because the system and the libraries underneath (the web view,
the document picker, the push service) write logs the app does not control. Use a **release** build (not a
debug one: it logs more) and **FAKE data only**.

1. Make a FAKE PDF with distinctive words that appear nowhere else: name it `FAKE-LOGCHECK-Zyxwv Patient.pdf`
   and put a line of text in it such as `Zyxwv Patient, health number LOGCHECK-7731`.
2. Install the release build on an Android phone or emulator, and on an iPhone if one is available, and
   create a FAKE vault. On Android clear the log first: `adb logcat -c`.
3. Do the things that handle documents: **import** the FAKE PDF, open it (**Read**), **Save a copy**
   (export), link a FAKE clinic portal and receive a FAKE document if a test portal is at hand, turn on
   iPhone notices and receive one on an iPhone, run the **AI helper** on a computer build, then lock and unlock.
4. Capture the log straight afterwards. Android: `adb logcat -b all -d > logcat.txt`. iPhone: the Console
   app on a Mac with the device selected (or `idevicesyslog`), saved to a file.
5. Search it for the FAKE file name, the FAKE person's name, the FAKE health number, the portal's host name,
   the document, link and clinic ids the screens show, the push token's first characters as the portal shows
   them, and the passphrase you typed. For example:
   `grep -n -i -E "zyxwv|logcheck|7731|<portal host>|<document id>" logcat.txt`. **Expect no hit.** Also
   look at lines tagged `chromium` (the web view's console): a release build's page writes none.
6. A hit is a finding: write down the line and its tag (the app's, or the system's), and say whether it
   came from the app or from something it uses. Do not paste a log into an issue before checking it holds
   only FAKE data.

Related, recorded decision: neither the app window nor the Android reader sets `FLAG_SECURE` (owner decision of
20 Nov 2026, see "Android PDF reader" above), so a screenshot or the recent-apps picture of an open document
is allowed; this check is about logs, not about screenshots.

## Start over

To start again with an empty vault, lock myCarlos, choose **Forgot your passphrase?** on the unlock
screen, type `RESET MYCARLOS VAULT`, choose **Set vault aside**, and confirm **Set it aside** in the
dialog, whose buttons are **Keep this vault**, **Set it aside** and **Cancel**. **Security** has no
way to start again (#71, decided 19 October); check that it shows none.

Nothing is erased (#71): the old vault moves, whole and encrypted, into a `set-aside` folder in the
vault's folder (below), and myCarlos never deletes it. To remove a test vault for good, close
myCarlos and delete that folder, or the whole vault folder, by hand. On Android and iPhone the
folder is private to the app: only clearing myCarlos's data in the phone's settings, or
uninstalling it, removes a vault set aside, and that removes every vault on the phone, the one in
use too. This limit is accepted (decided 19 October).

### The "are you sure?" dialogs (please try on Windows, on a Mac and on Linux)

Three things ask in a dialog of the system's own before they happen: erasing the vault (above),
restoring a backup over a vault (**Keep this vault**, **Replace with backup**, **Cancel**), and
replacing the recovery key (**Keep current key**, **Replace key**, **Cancel**). The safe button
is meant to be the one that Enter presses. Automated Windows/Linux checks are described below;
please also try these steps on each target computer, especially macOS and with a screen reader:

1. When the dialog opens, which button is highlighted? It should be the one that starts with
   **Keep**. Write down the order of the buttons as you see them.
2. Press Enter. Nothing should change.
3. Open it again and press Space. Nothing should change.
4. Open it again and press Escape. Nothing should change.
5. Open it again and close it with its X, if it has one. Nothing should change.
6. Each time, nothing should change. Setting aside and restore should report cancellation. For recovery-key
   replacement, setup should stay open and say the current key still works.
7. On a Mac, turn on **Keyboard navigation** in System Settings, then do steps 1 to 4 again, and
   say which button has the ring around it.
8. Can the dialog end up behind the app's window? On Windows and on a Mac it should stay in front
   of it. On Linux it may not.
9. Using a vault you can lose, open it again and press Tab until the button that goes ahead has
   focus. Try Enter and Space separately and record which button each key activates: the default
   button and the focused button may differ. Also deliberately click the button that goes ahead
   once and verify that it performs the requested action.

On a phone: note the order of the buttons, then tap outside the dialog, and press Back on
Android. Nothing should change.

Uninstalling also removes the vault on Android and iOS. On desktop the vault, and every vault set
aside, stays until you delete the folder by hand; it lives in:

- Windows: `%LOCALAPPDATA%\ca.carlos.mycarlos\vault-home`
- macOS: `~/Library/Application Support/ca.carlos.mycarlos/vault-home`
- Linux: `~/.local/share/ca.carlos.mycarlos/vault-home`

## Report what you find

Comment on [issue #4](https://github.com/carlos-emr/mycarlos/issues/4) (Android) or
[issue #5](https://github.com/carlos-emr/mycarlos/issues/5) (iOS), or open a new issue. Include
the platform and OS version, the device or emulator, the source commit from `BUILD.txt`, what you
did, and what happened. Screenshots help, as long as they show only made-up data. Report
suspected security problems privately, as [SECURITY.md](SECURITY.md) describes, not in an issue.

### Windows Narrator and keyboard retest

Use a Windows build of `main`, downloaded as described at the start of this guide, and note
its BUILD.txt source commit in your report. Use made-up data only.

1. Start Narrator. Create or unlock a vault. Hover and focus an empty password field,
   then type, delete and paste a throwaway password. The count description and hover text
   should say “N character password”. Confirm it does not speak the secret. The field
   remains a native protected password input: whether Narrator still repeats protected
   bullets needs this Windows test and has not been verified on Linux.
2. Tab and Shift+Tab reach only things you can operate (buttons, fields, links, and the
   list in a confirmation, so it can scroll); text is not a Tab stop. In create, unlock,
   restore, library and Security, check that each field is read with its label and its hint
   or count, and each button with a name that says what it acts on.
3. Read the text with Narrator's scan mode: press Caps Lock + Space to turn it on, then use
   the Up and Down arrows to read line by line and H (Shift + H backward) to jump between
   headings. Check every heading, instruction, warning, error and paragraph, including long
   text, in create, unlock, restore, library and Security. Press Caps Lock + Space again to
   go back to typing.
4. In recovery setup, when the dialog opens Narrator reads its title and instructions. In
   scan mode, the seven key groups are read as a list, each group character by character
   ("Group 6: Y Z 0 1"). Tab moves only between the buttons and wraps inside the dialog.
   Repeat in a short window or at 200% scaling.
5. Save a kit, go Next, go Back, and deliberately mistype the check. Focus should start at
   each new heading, and scan mode should reach all the text. Save/Print/Next/Back names
   describe the recovery-key action.
6. Escape or “Lock vault and finish later” during first setup asks "Discard this recovery
   key?", with focus on **Cancel**. Cancel (or Escape) goes back to the setup, with focus
   where it was. **Discard key and lock** hides the key and locks. After unlocking, the
   unfinished-key warning says that key does not work. Optional setup opened from Security
   may be cancelled; focus should return to its opening button.
7. Report any repeated bullet speech, missing text, unexpected focus jump, or focus that
   cannot leave a section. Browser keyboard/axe checks are not a Windows Narrator test.

## Automated Windows native tests

The Windows CI job runs `npm run test:windows-navigation` against the executable installed
from its freshly built NSIS package. It attaches Playwright to the real WebView2 window;
there is no frontend server or mocked native bridge. The test checks startup, real Rust IPC,
bundled-page reload, blocked outside/development-server navigation, and clicked links/popups
(including a popup to a bundled page). A local request detector checks that no canary URL arrives.
A changed document, transient external navigation, or extra webview also fails the test.

The job uploads `mycarlos-windows-navigation-evidence`, with the Playwright report, trace and
window screenshots. Capture starts only after Rust confirms there is no existing vault;
with dialog tests enabled, subsequent capture contains only the synthetic test vault.
The test has no automatic retries and a failed test prevents publishing that run's Windows installer.

The first attached Windows run exposed an outbound-request gap: WebView2 sent the test
server a GET before cancelling navigation. The bundled page stayed intact, but the zero-request
assertion failed. [Microsoft documents this behavior](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2navigationstartingeventargs#get_cancel).
Windows now installs a native document-request interceptor before allowing app navigation.
Disallowed document requests receive a local empty 403 response; Tauri IPC remains untouched.
The zero-request assertion is retained to verify this fix on the installed build. If the required
WebView2 request-filter API is unavailable, the app fails startup instead of running unprotected.

For a local run, use a disposable Windows account with no myCarlos vault. Install dependencies
with `npm ci` in a non-elevated shell, set `MYCARLOS_WINDOWS_APP` to the absolute path of the installed executable,
and run `npm run test:windows-navigation`. A fresh temporary WebView profile is used and the
spawned app/process tree is stopped afterward. The profile does not relocate the native vault;
the navigation-only test refuses an existing vault and does not create one. Remote debugging
is enabled only for testing. On the disposable elevated CI runner, the workflow temporarily
sets executable-specific HKLM WebView2 policies for the debugging port and fresh profile,
then removes only the values it added in a `finally` block. It refuses to overwrite existing
values. WebView2 150+ ignores the equivalent environment overrides for elevated processes
([Microsoft explanation](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5645)).
Local runs should use a non-elevated shell and do not modify registry policy.
No Playwright browser download is needed on Windows:
the test uses the installed WebView2 runtime. This suite deliberately fails on other platforms.

CI also sets `MYCARLOS_WINDOWS_DIALOG_TESTS=1` to test the three destructive confirmations.
This opt-in creates a synthetic vault in the disposable account. For each dialog, it sends
Enter and Space without focusing a button first, presses Escape, closes the native window,
and invokes Cancel and Keep. Every cancellation must preserve the encrypted vault files.
It also explicitly activates each destructive button and verifies the resulting vault state.
Restore uses the real Save/Open dialogs and a backup created by the app; a profile added
after the backup proves which contents remain. Successful completion erases the synthetic
vault. On failure, synthetic data may remain in the disposable account for diagnosis.
Use a fresh disposable account for the next local run; the initial vault check refuses
the retained vault.
The evidence artifact includes `native-dialogs.json`, with button labels and initial focus.
The native driver checks the app PID, foreground dialog, and native focus before sending
operating-system keystrokes. Explicit Windows button actions use Tab to reach the verified
button and Space to activate it; initial Enter/Space checks leave focus untouched. Playwright invokes real Rust commands but cannot itself press these native buttons.

For a local Windows dialog run, set `$env:MYCARLOS_WINDOWS_DIALOG_TESTS = '1'` before the
command above. Keep the desktop available to the test and do not use its mouse or keyboard.

Linux can run the same scenarios against an extracted evaluation package with a matching
WebKitWebDriver. Install `python3-gi`, `gir1.2-atspi-2.0`, `at-spi2-core`, `xdotool`, `openbox`,
`xvfb`, and `dbus-x11`. Run in a private virtual display/session, with absolute app/driver
paths and a new evidence directory:

```sh
xvfb-run -a dbus-run-session -- sh -c '
  openbox > /tmp/mycarlos-test-openbox.log 2>&1 &
  exec /usr/bin/python3 scripts/native-dialogs/linux.py "$@"
' sh /path/to/mycarlos-tauri-poc /path/to/WebKitWebDriver /path/to/new-evidence
```

The Linux driver creates isolated XDG directories and records AT-SPI focus/button evidence.
If initial Enter or Space leaves a Linux dialog open, it records that behavior and dismisses
with Escape; no destructive operation may occur. These checks cover the tested Windows
and Linux desktop configurations. macOS/mobile behavior, screen-reader announcements,
and the documented upstream URL-parsing limitations still need their own checks.

The macOS CI job also runs `native_dialog_macos` on the OS main thread, inside
AppKit's actual application run loop. The Cargo-launched harness uses the pinned
objc2 example's unbundled-app activation call; this is not production app policy.
Per-case diagnostics record running/active state, real key-window identity,
parent/sheet key eligibility, first responder and default-button-cell identity.
These observations do not replace any keyboard-property or actual-event gate.
The production sheet observes only its own parent's close notification, ends
only its own attached sheet, and clamps a late response to cancellation once
that parent starts closing; completion is delivered at most once.

The harness presents
an owned test window and the production AppKit sheet in all seven languages, posts
native Return and Escape events, and deliberately activates the second button.
It checks the exact response for each role and also refuses unknown responses,
cancellation and closing the parent. All 24 cases are attempted, including actual
key events after a keyboard-property mismatch; any metadata or behavior failure
still fails the report. Each appearance, key-window, and completion wait has its
own five-second deadline, allowing about fifteen seconds per case or 360 seconds
of waits across 24 cases, plus framework calls and cleanup.

A timeout fails before cleanup; cleanup cannot
satisfy an expected response. The job uploads `test-results/native-dialog-macos.json`,
and a missing report fails the upload step. Linux and Windows print an unsupported
message for this harness and provide no AppKit evidence. These in-process events
supplement physical keyboard, Tauri window integration and mobile device checks;
the report and its CI outcome must be reviewed before claiming platform coverage.

New camera filenames use the computer's date and time formats; their prefix
follows the UI language when they are created. Changing the UI language leaves
those date/time parts unchanged, and never renames existing records. This is an
intentional change from the earlier UI-locale date selection (English used
en-GB). Camera browser checks fix the computer locale (en-US and en-GB), timezone
(UTC), and clock, then compare the complete stored filename exactly. Human
status text uses Fluent isolation; the stored filename contains no formatter
controls.

## Automated Android emulator smoke test

The workflow `mycarlos-android-emulator.yml` builds the Android debug app for an x86_64
emulator, starts an Android 34 emulator on a hosted Linux runner and runs
`scripts/android-emulator-smoke.sh`. It runs by hand (Actions > myCarlos Android emulator smoke
test > Run workflow) and on pull requests that change the workflow, that script or the Android
security script; ordinary pull requests do not run it.

What it checks:

- The built APK is `ca.carlos.mycarlos`, has a launchable activity and names a launcher icon
  (read with `aapt2`) that is really inside the APK.
- The app installs on the emulator, opens, comes to the front and is still running ten seconds
  later, with nothing in the crash log and no fatal exception or "not responding" in the log.
- A screenshot of the first screen, the log and the check output are kept as the
  `myCarlos-Android-Emulator-Smoke` artifact for 14 days.

What it does not check yet:

- The status-bar inset, the keyboard and how the icon looks. The screenshot lets a person look
  at them; nothing asserts them.
- Anything inside the page. WebView debugging is not enabled in the app, so Playwright cannot
  attach to it on Android yet; that is a follow-up.
- A phone (arm64). The emulator is x86_64.

A red run is a real failure: nothing is retried. Emulator boot is the likeliest cause of a
false alarm; read the log in the artifact before changing the app.

## The loopback portal for trust checks (FAKE data)

`scripts/android-portal-fixture.py` is a small HTTPS "portal" for checking how the app trusts one,
on a computer or from an Android emulator (`adb reverse`). It answers every POST with a fixed
refusal, never a real portal answer, so a run proves the handshake and the HTTP exchange only:

| Mode | What the app should do |
| --- | --- |
| `trusted` (certificate for `127.0.0.1` and `localhost` under the test root of `src-tauri/tests/fixtures/portal-test-pki`) | A build that trusts the test root (a debug Android build, #478) reads `403 link_code_invalid` as "The portal did not accept that code." A build that does not trust it says "The portal request could not be completed." and the fixture logs no request. |
| `other` (certificate for `other.example` only) | Refused even by a build that trusts the root (wrong name): "could not be completed", no request logged. |
| `redirect` | A `302` is not followed: one request logged, never the target. |
| `--plain-port` | A clear-text listener that only logs a connection: a `http://` address is refused before any connection (the log stays empty). |

The log (`--log`, JSON lines) holds the method, path and body length, never a body or header. Run it
by hand with `python3 scripts/android-portal-fixture.py --mode trusted --port 8443 --log out.jsonl`;
its own tests are `npm run test:android-portal-fixture`. It uses throwaway test keys that are never
added to a trust store. The emulator test that drives the app against it is a proposed workflow
change (not applied; see `for-ben/android-portal-trust-emulator-README-20261126.md`).

## Password-protected PDFs

Use sample data only: `src-tauri/tests/fixtures/locked-pdf/` holds FAKE PDFs locked the way CARLOS
locks them (password `FAKE-portal-2026`). This is still a synthetic-data evaluation, not approval for PHI.

1. On Windows, macOS or Linux, share or open `text-aes256.pdf` with myCarlos, or add it with
   **Import**. It is stored as it came, in Shared with me or where it was added.
2. Open its details. They say "Locked with a password", with an **Unlock…** button. A PDF with no
   password shows neither.
3. **Unlock…** asks for "the document password from your patient portal". A wrong password asks
   again and says so; the field is emptied after every try. **Cancel** changes nothing.
4. The right password adds a copy beside it, with its name and in the same place. The details then
   show the copy, which has no Unlock, and say where the original is: it is kept, renamed
   "<name> (locked original).pdf". Saved with **Save a copy**, the copy opens with no password and
   the original still asks for one.
5. Unlock the original again: myCarlos says an unlocked copy is already there, and adds nothing.
6. The password is never shown again, never kept and never written to a log. Check that the app's
   data folder holds no unlocked copy outside the vault.
7. While the password is being checked, lock the vault or close myCarlos. Nothing is added, and the
   original keeps its name.
8. On a phone, a locked PDF's details say "Locked with a password. myCarlos cannot open it on this
   device yet", with no Unlock.

The Rust tests unlock every fixture and compare page text and content with the originals. They also
start the real executable as the helper exactly as myCarlos does on each desktop system: sandboxed,
and on Windows in its AppContainer and job object. It still unlocks a document and draws a page.

The helper's sandbox (#63) is tested in child processes, in CI on Linux, macOS and Windows:
- **Escape attempts.** A child sandboxed as the helper is tries to read a file it could read before,
  write one, connect to a port the test listens on, and start a program. On Linux and macOS it also
  tries to bind a socket and make a pipe, and then to read and connect again after closing stdin,
  which would free a descriptor. Every attempt must fail. A control child, started without the
  sandbox, must succeed at each, so the test cannot pass by doing nothing.
- **On Linux,** the same child with seccomp alone (no Landlock, no descriptor limit) must fail at
  each too, and cannot exec another program. A child with Landlock alone must be refused the file
  (and, from Landlock 4, the connection) when the kernel has Landlock; the test says so when it
  does not.
- **Memory.** myCarlos is not dumpable, and as an ordinary user (as CI runs) a sandboxed helper
  cannot read its memory. On Windows, a helper in its AppContainer cannot open myCarlos to read it,
  and a helper started outside one reads nothing. A sandboxed helper that grows past its memory limit
  is stopped well before its time limit: on Linux by its data limit, on Windows by its job, and on
  macOS, which refuses a data limit, by myCarlos reading its footprint.

On Windows the tests let AppContainers read and run the test programs first (`icacls`, as in
[WINDOWS.md](WINDOWS.md)), as the installer does for myCarlos.

## Reading a document inside myCarlos

Use sample data only, such as the FAKE PDFs in `src-tauri/tests/fixtures/locked-pdf/`.

1. Open a document's details and choose **Read**. The first page shows with "Page 1 of N". The page's
   text is under **Text on this page**.
2. **Next page** and **Previous page** move through the document. **Larger**, **Smaller** and
   **Fit width** change the size; a larger page scrolls inside the reader.
3. A document stored with its own password (imported with **Import** while still locked) asks for
   "the document password from your patient portal". A wrong one asks again. The password is used
   for the pages that follow and is gone when the reader closes.
4. Lock the vault, or let it lock, while a document is open: the reader closes with the library.
5. With a screen reader, each page picture is named "Page N of M"; read the page with **Text on this
   page**. A scanned page may have no text. That is a limitation of this first version.
6. On an iPhone, **Read** says documents cannot be shown on this device yet; use **Save a copy**. On
   Android, **Read** opens the native reader (see "Android PDF reader" below).

The helper draws pages, has no vault keys, and is sandboxed (THREAT_MODEL IMP-02, D-04, #63). Where
the sandbox cannot be set up, **Read** says documents cannot be shown safely on this system, and
**Unlock…** says the document cannot be opened safely on this system; the document is unchanged.

## Android PDF reader (#358)

**Read** on Android opens a separate native window drawn with Android's `PdfRenderer`, not the app's
web page and not the desktop helper. Use FAKE PDFs only (several pages, a scanned one, a large one,
and a password-protected one).

1. Unlock, open a document's details and choose **Read**. A full-screen reader opens with the
   document name, **Close**, **Previous page**, **Next page**, **Zoom in**, **Zoom out** and
   "Page N of M". Swipe sideways to turn a page, double-tap to zoom, pinch to change zoom, drag to
   pan a page that is bigger than the screen.
2. **Close** (or the back button) returns to the library. Lock the vault, let it lock, switch to
   another app or press Home while reading: the reader closes and does not come back by itself.
3. A password-protected PDF, a damaged PDF and one over 20 MB each show a message with **Close**;
   nothing is left open. Check that no file for the document appears in the app's storage
   (`adb shell run-as <package> ls -R cache files`) after reading.
4. Set automatic lock to one minute. Reading (touching the reader) keeps the vault open; leaving it
   alone lets the vault lock and the reader closes.
5. **Known gap, said plainly:** a page is a picture. **TalkBack can say "Page N of M, picture of the
   letter" and operate the buttons, but it cannot read the letter's text**, because `PdfRenderer`
   gives pictures only and the desktop text extraction does not run on Android. The AI helper and
   "Show in document" are computers-only, so Android shows the original only. A person who needs
   the text must use **Save a copy** and a reader app of their choice. Record what TalkBack does on
   your phone.
5a. **memfd on Android 8 to 10 (API 26 to 29), for Ben's device test:** the reader makes its in-memory
   file with the raw `memfd_create` system call. Some vendors' seccomp filters on those versions may
   kill the call (a signal, SIGSYS) rather than return an error, which the app cannot catch. Open a
   letter on the oldest phone available; a crash on open, not a "cannot show this document"
   message, is this. Android 11 and later return an error that the app handles.
6. Neither the app window nor this reader window sets `FLAG_SECURE`: screenshots and the recent-apps
   picture are allowed everywhere, by the owner's decision of 20 Nov 2026 (the patient's choice).
   Take a screenshot of an open letter on a test phone and expect it to work.

Automatic checks: the Rust tests cover the bounded export, the cancel/activity gates and the sealed
in-memory file (and that a refused memfd never falls back to a file); vitest covers the reader
screen and the bridge; the Android build compiles the Kotlin. The `PdfRenderer` drawing itself, the
gestures and TalkBack need a phone or the emulator test (`connectedDebugAndroidTest`).

## Preparing a document's text for an AI (#72, computers only)

Open a PDF's details and choose **Prepare text for an AI…**. myCarlos reads the
whole text on this device and shows it with every identifying detail it found
replaced by a placeholder such as `[NAME 1]` (marked, and named for a screen
reader). No date is sent: each is a numbered placeholder in calendar order with
its gap from the earliest, such as `[DATE 2, 14 days after DATE 1]` (marked “date
replaced”), and an age of 90 or over is `[AGE 1, 90+]`. After a save, **Put
details back** takes the AI's answer pasted in the box and puts every placeholder
back exactly; a placeholder it does not know, or whose note was changed, is
highlighted and left as written. Try: a possible name listed under the text goes with one press;
select some text and press **Remove the selected text**; type a word in the box
and press **Remove everywhere**; **Undo the last removal** undoes only your own
removals. **Save the text…** asks first, then opens the system save dialog with
a generic name; the file starts with a fixed line that tells an AI to treat
what follows as a document, not as instructions. The save is in the audit
history as “Anonymized text saved”. Nothing is saved without the preview.

What to look for: a name, number or date that stayed (read every line; the
remover is rules, not understanding, and the notice says what it can miss);
a word removed that should have stayed (undo cannot put it back, but the
original document is untouched); the page notes when a page has no text, was
cut or could not be read. Automated: `src/deidentify/*.test.ts` (the remover
on synthetic letters and reports, the text cleaning and its shared table),
`src/native/AnonymizePreview.test.tsx` (the preview, the save flow, a refused
save), `src-tauri/src/text_recheck.rs` (the native re-check) and
`tests/anonymize-preview.spec.ts` (a keyboard walk at 200% text).

**Copy text, by hand on Linux.** On Linux (WebKitGTK) the browser clipboard may refuse `writeText` once an awaited call has run since the click, because the click's permission can be lost. The button does an awaited native check first, so it may say "The text could not be copied." The app fails safe (nothing is copied, and it says so); please check it on your Linux machine and say what you see. On Windows and macOS it should copy.

## Notices while locked in the tray (#230, Windows only for now)

Needs: a Windows PC; a myCarlos build with the tray (#206) and this change; a development Portal that
has the waiting-key routes (carlos-portal#88) with a FAKE clinic and a FAKE patient who can be sent a
document. Use synthetic data only. Windows is the only system with a credential-store adapter, so on
Linux and macOS nothing below is made or asked (fail closed, no plain file).

1. In Preferences, turn on **Keep myCarlos running in the background** and the **notices** choice,
   then link the clinic (or, if it is linked, lock and unlock once). Check that a key was made:
   - `cmdkey /list` shows a Credential Manager item named `myCarlos/notice-keys/v1`;
   - `notice-keys.v1` is beside the settings in the app's local data folder, **20,532 bytes**
     whatever the number of clinics linked.
2. Close the window (it goes to the tray and the vault locks). From the Portal side, deliver a
   document for the device. Within about 5 to 6 minutes (5 min with up to 20 % jitter; never sooner than
   2 minutes) **a Windows notice appears: "A new document is waiting. Unlock myCarlos to see it."** and
   nothing else: no clinic, patient, document or count. Hover the tray icon: its tooltip says the same.
3. Click the notice. **Check and report what it does** (not verified without a Windows build): the aim is
   that it shows the myCarlos window on the unlock screen. If it does nothing, the tray icon's left click
   (or Open) must; that part is the tray's own.
4. The unlock screen shows the same sentence once. Unlock: the line goes, the icon's tooltip goes back
   to "myCarlos, vault locked" on the next lock, and the normal document check takes over. A second
   document does not announce again until the next unlock.
5. Turn the **notices** choice (or the background choice) off while unlocked: `notice-keys.v1` keeps its
   size but the key is gone, the `cmdkey` item is removed once no key is left, and the Portal stops
   answering for that key (the device's waiting key is revoked there, best effort).
6. Wipes: remove the device in the Portal (the key goes at the first "not found" from it, or at the
   next unlock's reconciliation); set the vault aside and start again (every key goes); open a
   different vault (the first vault's keys go).
7. Offline: disconnect the network with the window in the tray. Nothing is announced, nothing breaks, and
   asking resumes with a longer wait after failures (doubling up to an hour, then back to 5 minutes
   after one success).
Please report the tray icon, the notice text and its language (change the language in Preferences before
closing to the tray), and what a click on the notice does.

## Appearance and Windows high contrast

Use sample data only. Appearance is under **Settings → Preferences**, beside App zoom,
including on a phone. The separate browser demonstration follows the device automatically;
it has no Preferences screen. This is still a synthetic-data evaluation, not approval for PHI.

1. With no appearance saved, check that **System** follows the device's light/dark choice.
   Change the device choice while myCarlos is open, on both a locked screen and the library.
   The app should update without restarting.
2. Choose **Light**, then **Dark**. Close and reopen the app after each: the choice should be
   remembered, including before unlocking. Explicit Light/Dark should stay put when the device
   changes. Choose **System** again to resume following the device.
3. On Windows and macOS, check that the native window follows each choice where the platform
   supports it. A failed or slow native command must not block the app. A failed save of the
   preference should say it cannot be remembered, while the current appearance still works.
4. On Windows, turn on a contrast theme in **Settings → Accessibility → Contrast themes**.
   Try both a light and dark contrast palette, including with Light or Dark selected in the app.
   There is no extra high-contrast switch. Tab through Preferences and the library: focus outlines,
   selected buttons/checkmarks, document icons, warnings and disabled controls must be visible.
   Check with Narrator's scan mode too; static text should not enter the Tab sequence.
5. Check light/dark text, warning chips, selected records, bulk controls, input boundaries and
   keyboard focus against their actual backgrounds. Automated axe checks do not cover every state
   or replace native screen-reader and contrast-theme testing.
6. Try the phone layout and the smallest desktop window at 400% text size. Appearance must not
   remove App zoom controls, move auto-lock out of Security, or change reduced-motion behavior.
7. In the browser demonstration, compare the synthetic paper preview across light/dark: the paper
   and its content remain unchanged while the surrounding app changes. Native documents still use
   **Save a copy**; no PDF viewer is added. A recovery kit printed from either appearance must have
   black text on white paper. Do not include passwords or recovery keys in screenshots or traces.

`tests/appearance.spec.ts` exercises the real native UI with a synthetic IPC bridge in Chromium,
including phone layout, live system changes, contrast checks and forced-colours emulation. This
is separate from actual Windows/macOS native appearance testing and the text-size checks on
real devices (#40). Capture fresh light/dark/forced-colours screenshots at the reviewed head;
old screenshots and successful CI do not establish Ben's UI approval.

## Signed-PDF checker draft (#101)

The current CARLOS #5135 fixture is copied without regeneration from commit
`1f30d9bef74c4a5206244db21a367e94f24188df`; its SHA-256 is
`f26a292a7ba9ca52e5251b65fb46345c959d784fc3190435ca6b67a024b47169`. All keys and patients
are FAKE. The fixture includes 12 cases, including the encrypted email copy, missing/null
recipient, tampering, extra update, incomplete ranges, wrong kid, RSA and two signatures.

Focused native tests exercise CMS/current manifest digest and complete helper extraction;
`tests/pdf_helper.rs` also starts the real confined executable for both plaintext and
encrypted attachment reports. Import tests check preserved original bytes and honest
unverified diagnostics. The password is passed for extraction only after signature/pin
authentication. An unverified or malformed document still imports with its existing
unverified source label; helper refusal never creates a Verified result.

This is not completion of #55: authenticated portal linking, key replacement/revocation,
durable trust metadata and rechecking stored documents remain separate work. The app has
no authenticated clinic pins, so real production imports cannot become Verified yet.

For the explicit real-helper import check, first build/run the signature helper integration
case (`cargo test --manifest-path src-tauri/Cargo.toml --test pdf_helper
the_confined_signature_helper_reports`). Then set
`MYCARLOS_TEST_SIGNED_HELPER_EXE` to that build's absolute app-executable path and run
`cargo test --manifest-path src-tauri/Cargo.toml --lib signed_import_analysis --
--ignored --test-threads=1`. It requires the exact `unknown_signer` refusal from the real
helper path, alongside byte preservation. The executable override exists only in unit-test
builds, never production; a generic helper failure cannot satisfy this test.

Nullable v1 tests cover explicit null, missing members, wrong types, size bounds and the
clinic/recipient binding policy. An optional ignored private-producer test reads only a
FAKE captured PDF and its public certificate from metadata named by
`MYCARLOS_TEST_PRIVATE_INTEROP_INPUT`; with the real helper configured as above, run
`cargo test --manifest-path src-tauri/Cargo.toml --lib
private_native_producer_null_manifest_is_signed_but_never_matched -- --ignored
--test-threads=1`. It requires signed-but-unbound under an explicit FAKE test pin and
`unknown_signer` with no pins. Private captures, metadata and certificates are not committed
or published, and the public fixture is not regenerated. This opt-in check is separate from
the public fixture tests and does not establish a production authenticated clinic link.

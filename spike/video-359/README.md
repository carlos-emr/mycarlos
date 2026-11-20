# #359 video spike (PR 0): NOT SHIPPED, FAKE data only

A small harness that answers the open questions in the #359 design
(`mycarlos-359-video-design-20261120.md`, section 9.2) before any product code is written.
It lives under `spike/`, outside `src/` and `src-tauri/`, so nothing here is built into the app.

**FAKE sources only.** The picture is a drawn canvas, the sound a generated tone. No camera, no
microphone, no person. The only other media is MDN's public CC0 "flower" clip, used to check playback
independently of the recorder. Nothing is logged that names anyone.

## What is here

| Path | What it is |
|---|---|
| `probe/probe.js`, `probe/probe.html` | The probe that runs inside any webview: `MediaRecorder.isTypeSupported`, recording with `start(1000)`, audio plus video, pause and resume (with the tracks switched off while paused, Q10), 720p and 1080p, the achieved bitrate, pieces and their timing, a read of the MP4 or WebM structure (box list, fragment times per track, duplicate or orphan boxes), then playback and seeking of the recorded bytes. |
| `runners/chromium_runner.mjs` | Runs the probe in a browser Playwright launches (`--engine chromium|webkit|firefox`, `--channel chrome`), serving the bytes over http with ranges (`--reply-cap` shortens replies, as the design does). |
| `runners/webkitgtk_runner.py` | Runs the probe in WebKitGTK under Xvfb and serves the bytes through a **custom URI scheme**, as the app's playback address will. Also measures the CPU of the WebKit processes during each recording. |
| `runners/webkitgtk_media_inert_debug.py` | The small test that showed `<video>` does nothing in headless WebKitGTK here (see results). |
| `ci/mycarlos-video-spike.yml.proposed` | A workflow for the desktop engines on hosted runners. **Not installed**: `.github` changes need Ben. |
| `results/` | The result files from the runs below. |

## What was run, and where (20 Nov 2026, this Linux machine)

| Runner | Engine | Notes |
|---|---|---|
| Playwright Chromium 151.0.7922.34 | Chromium | A stand-in for WebView2 and Android WebView; **not** those webviews. Playback over http with ranges. |
| WebKitGTK 2.52.6, GStreamer 1.24.2 (Ubuntu 24.04) with `gstreamer1.0-plugins-bad`, `-ugly`, `-libav` unpacked into a private folder | WebKitGTK | Software x264 on a shared, busy machine. Nothing was installed on the system. |

**Not run here, and why:** Windows (no Windows here), macOS and iOS (none), real WebView2,
Android System WebView and the Android emulators (no Android SDK, no KVM on this machine).
A downloaded Google Chrome was **not** used: running a downloaded binary was refused by this session's
permission checks (see the report). The proposed workflow runs Chrome on all three desktop systems.
The real in-app webviews need a small Tauri harness app that is **not written yet**.

## Results

See the design doc's section 9.3 for the table and what each result means for the design.
The raw files are in `results/`.

## Known limits of this harness

- The recorder numbers on a shared, loaded machine (CPU limited to four niced cores) are **indicative
  only**: dropped frames and CPU percentages will differ on a real device. Battery is not measured at all.
- The canvas picture is synthetic: its bitrate is lower than a real camera's at the same target.
- Headless WebKitGTK here could not play any `<video>`, so the custom-scheme playback question for
  WebKitGTK is **not answered**. It needs a real desktop session (or the CI job with an audio sink).
- No Android or Apple results.

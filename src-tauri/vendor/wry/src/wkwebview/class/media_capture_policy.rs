// MYCARLOS LOCAL PATCH (#359 PR 7): this whole file is added by
// `vendor/wry.patch`; upstream Wry does not have it. See vendor/README.md.
//
// Which page may use the camera and the microphone. Upstream Wry answers every
// `getUserMedia` request on macOS and iOS with "grant"; myCarlos grants only
// what its own recording and photo dialogs ask for, as its Linux and Windows
// handlers (`src-tauri/src/camera_permission.rs`) already do:
//
// - video alone (a photo), or video with sound (a recording): allowed;
// - sound alone, or a request of any kind this policy does not know: refused;
// - only from the app's own page: the main frame, whose origin is the bundled
//   one, `tauri://localhost` (the same origin `bundled_origin` in
//   `src-tauri/src/lib.rs` gives macOS and iOS), with the default port.
//
// A refusal is `WKPermissionDecision::Deny`, never `Prompt`: a prompt would
// show WebKit's own question naming an origin, which is not for the patient
// to answer. The operating system's own camera and microphone prompt (and
// the app's `NSCameraUsageDescription`/`NSMicrophoneUsageDescription`) still
// follows for an allowed request.
//
// This file uses nothing from Wry, Cocoa or the platform, so that it can be
// tested on any host: `src-tauri/src/camera_permission.rs` compiles it in its
// own tests and runs the cases there against exactly these lines.

/// The scheme of the app's own bundled pages on macOS and iOS.
pub(crate) const OWN_PROTOCOL: &str = "tauri";
/// The host of the app's own bundled pages on macOS and iOS.
pub(crate) const OWN_HOST: &str = "localhost";

/// The `WKMediaCaptureType` values by number. `wry_web_view_ui_delegate.rs`
/// checks at compile time that they are the ones WebKit's binding names, so a
/// change there stops the build instead of changing what is allowed.
/// `MICROPHONE` (sound alone) is the one that is not allowed.
pub(crate) const CAMERA: isize = 0;
pub(crate) const MICROPHONE: isize = 1;
pub(crate) const CAMERA_AND_MICROPHONE: isize = 2;

/// Whether the page that asked may have what it asked for.
///
/// `capture_type` is the raw `WKMediaCaptureType`; `port` is the security
/// origin's port, which WebKit reports as 0 for the scheme's default.
pub(crate) fn media_capture_allowed(
  capture_type: isize,
  main_frame: bool,
  protocol: &str,
  host: &str,
  port: isize,
) -> bool {
  (capture_type == CAMERA || capture_type == CAMERA_AND_MICROPHONE)
    && main_frame
    && protocol == OWN_PROTOCOL
    && host == OWN_HOST
    && port == 0
}

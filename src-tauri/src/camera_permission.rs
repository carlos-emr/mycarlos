//! The camera and recording dialogs ask the webview for video, and the
//! recording dialog (#359) for video **with sound**, and only after the
//! patient chooses "Use the camera" or "Record video". This answers the
//! webview's own permission question for those requests, so no browser-style
//! prompt naming an origin appears. For the app's own pages it allows:
//!
//! - video alone (the photo dialog, which never asks for sound), and
//! - video and sound asked for together (the recording dialog).
//!
//! Everything else is refused: sound alone, a request from any other page,
//! location, notifications, device lists and the rest. The operating system's
//! camera and microphone settings still decide whether the app may use them at
//! all, and the page only asks when the patient has chosen to record: nothing
//! turns the camera or microphone on before that.
//!
//! macOS and iOS need nothing here: Wry grants a page's capture request and the
//! system then asks the patient, with the reasons in Info.plist
//! (`NSCameraUsageDescription` and, for video with sound,
//! `NSMicrophoneUsageDescription`: a Mac or iPhone app that uses the
//! microphone without one is ended by the system). Wry's grant is not
//! filtered, which is why only the app's own bundled pages may load; filtering
//! it as the other platforms do is a separate change (#359 PR 7). A signed
//! build with the hardened runtime also needs the
//! `com.apple.security.device.camera` and
//! `com.apple.security.device.audio-input` entitlements, or the camera and the
//! microphone stay off.
//!
//! Android is declared in the manifest by `scripts/configure-android-security.mjs`
//! (camera, `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`, none required) and
//! asked by Wry's own Kotlin handler.

use tauri::{Config, Url, WebviewWindow};

/// Whether a webview's capture request (camera and/or microphone) is allowed:
/// the app's own page, and video asked for, with or without sound. Sound alone,
/// or a request that asks for neither, is refused.
#[cfg(any(target_os = "linux", test))]
fn capture_allowed(video: bool, audio: bool, ours: bool) -> bool {
    let _ = audio; // video with sound is allowed; sound alone is not (no video)
    ours && video
}

/// The kinds of permission WebView2 raises, one request per kind: a request
/// for video with sound arrives as a camera request and a microphone request.
#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Camera,
    Microphone,
    Other,
}

/// Whether one WebView2 permission request is allowed: the camera or the
/// microphone, for the app's own pages only. WebView2 does not say that the two
/// belong to one request, so a microphone request on its own cannot be told
/// from the second half of a recording's: the page is the app's own, it asks
/// only when the patient chose to record, and nothing it loads can come from
/// elsewhere (THREAT_MODEL, VID-01).
#[cfg(any(windows, test))]
fn kind_allowed(kind: Kind, ours: bool) -> bool {
    ours && matches!(kind, Kind::Camera | Kind::Microphone)
}

/// Linux: WebKitGTK keeps `getUserMedia` switched off until a setting turns
/// it on, and refuses every permission request that no handler answers.
#[cfg(target_os = "linux")]
pub fn install(window: &WebviewWindow, config: Config) -> tauri::Result<()> {
    use webkit2gtk::{
        glib::prelude::Cast, PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
        UserMediaPermissionRequestExt, WebViewExt,
    };
    window.with_webview(move |platform| {
        let webview = platform.inner();
        if let Some(settings) = WebViewExt::settings(&webview) {
            settings.set_enable_media_stream(true);
        }
        webview.connect_permission_request(move |webview, request| {
            // Video, with or without sound; sound alone is refused.
            let wanted = request
                .downcast_ref::<UserMediaPermissionRequest>()
                .map(|media| (media.is_for_video_device(), media.is_for_audio_device()));
            let ours = webview
                .uri()
                .and_then(|uri| Url::parse(&uri).ok())
                .is_some_and(|url| super::may_navigate(&config, &url));
            if wanted.is_some_and(|(video, audio)| capture_allowed(video, audio, ours)) {
                request.allow();
            } else {
                // Sound alone, geolocation, notifications, device lists and
                // the rest: as WebKitGTK would without a handler.
                request.deny();
            }
            true
        });
    })
}

/// Windows: WebView2 raises PermissionRequested before it would show its own
/// prompt. Only the camera and the microphone, for the app's own pages, are
/// allowed; any other kind, or a request that cannot be read, is refused
/// without a prompt. Windows has no per-app prompt for a desktop app: the
/// patient's "Let desktop apps access your microphone" setting decides, and a
/// blocked microphone reaches the page as `NotAllowedError`.
#[cfg(windows)]
pub fn install(window: &WebviewWindow, config: Config) -> Result<(), Box<dyn std::error::Error>> {
    use webview2_com::{
        take_pwstr,
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
            COREWEBVIEW2_PERMISSION_STATE_DENY,
        },
        PermissionRequestedEventHandler,
    };
    use windows::core::PWSTR;

    let (send, receive) = std::sync::mpsc::channel();
    window.with_webview(move |platform| {
        // SAFETY: setup runs on the UI thread; the COM interface and the
        // callback stay on that thread. The runtime owns the registered handler.
        let result = unsafe {
            (|| -> windows::core::Result<()> {
                let webview = platform.controller().CoreWebView2()?;
                let mut token = 0;
                webview.add_PermissionRequested(
                    &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let allowed = (|| -> windows::core::Result<bool> {
                            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                            args.PermissionKind(&mut kind)?;
                            let kind = if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA {
                                Kind::Camera
                            } else if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                                Kind::Microphone
                            } else {
                                return Ok(false);
                            };
                            let mut uri = PWSTR::null();
                            args.Uri(&mut uri)?;
                            let uri = take_pwstr(uri);
                            Ok(Url::parse(&uri).is_ok_and(|url| {
                                kind_allowed(kind, super::may_navigate(&config, &url))
                            }))
                        })()
                        .unwrap_or(false);
                        args.SetState(if allowed {
                            COREWEBVIEW2_PERMISSION_STATE_ALLOW
                        } else {
                            COREWEBVIEW2_PERMISSION_STATE_DENY
                        })
                    })),
                    &mut token,
                )?;
                Ok(())
            })()
        };
        let _ = send.send(result);
    })?;
    // As in windows_navigation: with_webview runs inline on the setup thread.
    receive.try_recv()??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn photos_ask_for_video_alone_and_recordings_for_video_with_sound_from_our_pages() {
        assert!(capture_allowed(true, false, true)); // the photo dialog
        assert!(capture_allowed(true, true, true)); // the recording dialog
    }

    #[test]
    fn sound_alone_and_requests_for_nothing_are_refused_even_from_our_pages() {
        assert!(!capture_allowed(false, true, true));
        assert!(!capture_allowed(false, false, true));
    }

    #[test]
    fn no_capture_is_allowed_for_a_page_that_is_not_ours() {
        for video in [false, true] {
            for audio in [false, true] {
                assert!(!capture_allowed(video, audio, false), "{video} {audio}");
            }
        }
    }

    #[test]
    fn only_the_camera_and_the_microphone_are_allowed_and_only_for_our_pages() {
        assert!(kind_allowed(Kind::Camera, true));
        assert!(kind_allowed(Kind::Microphone, true));
        assert!(
            !kind_allowed(Kind::Other, true),
            "location, notifications, ..."
        );
        for kind in [Kind::Camera, Kind::Microphone, Kind::Other] {
            assert!(!kind_allowed(kind, false), "{kind:?}");
        }
    }
}

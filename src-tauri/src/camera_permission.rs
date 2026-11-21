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
//! macOS and iOS: Wry answers the webview's capture question itself, and
//! upstream Wry grants every request. myCarlos carries a small patch to the
//! vendored Wry (`vendor/wry.patch`, #359 PR 7) so that its answer is the same
//! as above: video alone or with sound, from the app's own page
//! (`tauri://localhost`, the main frame, the default port), is granted;
//! everything else is denied, without a prompt. That decision is the plain
//! function in `vendor/wry/src/wkwebview/class/media_capture_policy.rs`, which
//! the tests below compile and run on any host. A granted request is then
//! asked of the patient by the system, with the reasons in Info.plist
//! (`NSCameraUsageDescription` and, for video with sound,
//! `NSMicrophoneUsageDescription`: a Mac or iPhone app that uses the
//! microphone without one is ended by the system). A signed build with the
//! hardened runtime also needs the `com.apple.security.device.camera` and
//! `com.apple.security.device.audio-input` entitlements, or the camera and the
//! microphone stay off. A development server (`tauri dev`) is not the app's own
//! origin on Apple platforms: the camera is refused there, and a built app
//! (a simulator or device build) is what the camera is tried in.
//!
//! Android is declared in the manifest by `scripts/configure-android-security.mjs`
//! (camera, `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`, none required) and
//! asked by Wry's own Kotlin handler.

use tauri::{Config, Url, WebviewWindow};

/// Whether a webview's capture request (camera and/or microphone) is allowed:
/// the app's own page, and video asked for, with or without sound. Sound alone,
/// or a request that asks for neither, is refused.
///
/// Screen capture (`getDisplayMedia`) reaches WebKitGTK as a user-media request
/// that is for neither a camera nor a microphone (it has its own display flag,
/// `webkit_user_media_permission_is_for_display_device`, which the Rust binding
/// does not expose below WebKitGTK 2.34). It is refused here because it is not
/// "video": the decision needs a camera request, and a display request is not
/// one. The test `display_capture_is_not_a_camera_request` pins the shape.
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

/// The macOS and iOS decision, as the patched Wry makes it. The file is
/// included, not copied, so that the cases below run against the very lines the
/// Wry delegate calls (`vendor/wry.patch` adds it; it uses nothing from Wry).
#[cfg(test)]
mod apple {
    include!("../vendor/wry/src/wkwebview/class/media_capture_policy.rs");
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
    fn display_capture_is_not_a_camera_request() {
        // A display-capture request is for neither device kind: refused.
        assert!(!capture_allowed(false, false, true));
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

    // The patched Wry's answer on macOS and iOS (vendor/wry.patch).
    mod apple_decision {
        use super::super::apple::{
            media_capture_allowed, CAMERA, CAMERA_AND_MICROPHONE, MICROPHONE, OWN_HOST,
            OWN_PROTOCOL,
        };

        const OURS: (&str, &str, isize) = (OWN_PROTOCOL, OWN_HOST, 0);

        fn ask(capture_type: isize, main_frame: bool, origin: (&str, &str, isize)) -> bool {
            media_capture_allowed(capture_type, main_frame, origin.0, origin.1, origin.2)
        }

        #[test]
        fn video_alone_and_video_with_sound_are_granted_to_the_apps_own_main_page() {
            assert!(ask(CAMERA, true, OURS)); // the photo dialog
            assert!(ask(CAMERA_AND_MICROPHONE, true, OURS)); // the recording dialog
        }

        #[test]
        fn sound_alone_and_unknown_kinds_are_refused_even_for_the_apps_own_page() {
            assert!(!ask(MICROPHONE, true, OURS));
            for unknown in [-1, 3, 4, 100, isize::MAX, isize::MIN] {
                assert!(!ask(unknown, true, OURS), "{unknown}");
            }
        }

        #[test]
        fn a_subframe_is_refused() {
            assert!(!ask(CAMERA, false, OURS));
            assert!(!ask(CAMERA_AND_MICROPHONE, false, OURS));
        }

        #[test]
        fn any_other_origin_is_refused() {
            for origin in [
                ("http", "localhost", 0),
                ("https", "localhost", 0),
                ("tauri", "localhost", 1420),
                ("tauri", "localhost", 80),
                ("tauri", "tauri.localhost", 0), // Windows and Android's host
                ("tauri", "localhost.example.com", 0),
                ("tauri", "evil.localhost", 0),
                ("tauri", "", 0),
                ("tauri", "Localhost", 0),
                ("TAURI", "localhost", 0),
                ("tauri ", "localhost", 0),
                ("file", "", 0),
                ("about", "blank", 0),
                ("https", "example.com", 0),
                ("", "", 0),
            ] {
                for kind in [CAMERA, MICROPHONE, CAMERA_AND_MICROPHONE] {
                    assert!(!ask(kind, true, origin), "{origin:?} {kind}");
                }
            }
        }

        #[test]
        fn only_one_case_in_all_of_them_is_granted_per_kind() {
            let mut granted = Vec::new();
            for kind in -2..=4_isize {
                for main_frame in [false, true] {
                    for origin in [OURS, ("http", "localhost", 0), ("tauri", "localhost", 1)] {
                        if ask(kind, main_frame, origin) {
                            granted.push((kind, main_frame, origin));
                        }
                    }
                }
            }
            assert_eq!(
                granted,
                [(0, true, OURS), (2, true, OURS)],
                "exactly video, and video with sound, from the main page"
            );
        }

        #[test]
        fn the_origin_is_the_one_the_app_serves_its_pages_from_on_apple_platforms() {
            assert_eq!(
                (OWN_PROTOCOL, OWN_HOST),
                crate::origin_for(false, false),
                "bundled_origin gives macOS and iOS this origin"
            );
            // And a page there is one the navigation guard allows.
            let page =
                tauri::Url::parse(&format!("{OWN_PROTOCOL}://{OWN_HOST}/index.html")).unwrap();
            assert!(crate::navigation_allowed(
                &page,
                (OWN_PROTOCOL, OWN_HOST),
                None
            ));
        }
    }

    // The Wry source is the reviewed patch, not upstream's grant-everything.
    mod patched_wry {
        const DELEGATE: &str =
            include_str!("../vendor/wry/src/wkwebview/class/wry_web_view_ui_delegate.rs");
        const PATCH: &str = include_str!("../vendor/wry.patch");

        #[test]
        fn the_delegate_asks_the_policy_and_no_longer_grants_everything() {
            assert!(DELEGATE.contains("media_capture_policy::media_capture_allowed("));
            // The type, the frame and the origin all reach the decision.
            for part in [
                "capture_type.0",
                "frame.isMainFrame()",
                "origin.protocol()",
                "origin.host()",
                "origin.port()",
            ] {
                assert!(DELEGATE.contains(part), "{part}");
            }
            // Upstream's one line, granting whatever was asked, is gone: the
            // only Grant is the one the decision chooses.
            assert!(!DELEGATE.contains("call((WKPermissionDecision::Grant,))"));
            assert_eq!(DELEGATE.matches("WKPermissionDecision::Grant").count(), 1);
            assert!(DELEGATE.contains("WKPermissionDecision::Deny"));
            assert!(!DELEGATE.contains("WKPermissionDecision::Prompt"));
            // The numbers the policy uses are tied to WebKit's binding at build time.
            assert!(DELEGATE.contains("WKMediaCaptureType::CameraAndMicrophone.0"));
        }

        #[test]
        fn the_patch_touches_only_the_three_files_that_make_the_change() {
            let files: Vec<&str> = PATCH
                .lines()
                .filter_map(|line| line.strip_prefix("diff --git a/"))
                .map(|line| line.split(' ').next().unwrap())
                .collect();
            assert_eq!(
                files,
                [
                    "src/wkwebview/class/media_capture_policy.rs",
                    "src/wkwebview/class/mod.rs",
                    "src/wkwebview/class/wry_web_view_ui_delegate.rs",
                ]
            );
        }
    }
}

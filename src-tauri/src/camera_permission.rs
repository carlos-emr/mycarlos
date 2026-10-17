//! The camera dialog asks the webview for video, never sound, and only after
//! the patient chooses "Use the camera". This answers the webview's own
//! permission question for that request, so no browser-style prompt naming an
//! origin appears: the camera is allowed for the app's own pages, and the
//! microphone is refused. The operating system's camera setting still decides
//! whether the app may use the camera at all.
//!
//! macOS needs nothing here: Wry grants a page's capture request, and macOS
//! then asks the patient, with the reason in Info.plist
//! (`NSCameraUsageDescription`). The app declares no microphone reason, so
//! macOS gives it no microphone.

use tauri::{Config, Url, WebviewWindow};

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
            let camera_only = request
                .downcast_ref::<UserMediaPermissionRequest>()
                .is_some_and(|media| media.is_for_video_device() && !media.is_for_audio_device());
            let ours = webview
                .uri()
                .and_then(|uri| Url::parse(&uri).ok())
                .is_some_and(|url| super::may_navigate(&config, &url));
            if camera_only && ours {
                request.allow();
            } else {
                // Geolocation, notifications, the microphone, device lists
                // and the rest: as WebKitGTK would without a handler.
                request.deny();
            }
            true
        });
    })
}

/// Windows: WebView2 raises PermissionRequested before it would show its own
/// prompt. Other kinds of request keep WebView2's default; the app makes none.
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
                        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                        args.PermissionKind(&mut kind)?;
                        if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                            return args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY);
                        }
                        if kind != COREWEBVIEW2_PERMISSION_KIND_CAMERA {
                            return Ok(());
                        }
                        let mut uri = PWSTR::null();
                        args.Uri(&mut uri)?;
                        let uri = take_pwstr(uri);
                        let ours =
                            Url::parse(&uri).is_ok_and(|url| super::may_navigate(&config, &url));
                        args.SetState(if ours {
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

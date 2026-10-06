//! NavigationStarting cancels page replacement, but WebView2 may send a GET
//! before that callback returns. Intercept document requests before transmission.
//! https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webresourcerequested

use tauri::{Config, Url, WebviewWindow};
use webview2_com::{
    take_pwstr,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_22, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
    },
    WebResourceRequestedEventHandler,
};
use windows::core::{w, Interface, PWSTR};

pub fn install(window: &WebviewWindow, config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let (send, receive) = std::sync::mpsc::channel();
    window.with_webview(move |platform| {
        // SAFETY: setup runs on the UI thread; all COM interfaces and callbacks
        // stay on that thread. The runtime owns the registered handler.
        let result = unsafe {
            (|| -> windows::core::Result<()> {
                let webview = platform.controller().CoreWebView2()?;
                let environment = platform.environment();
                let mut token = 0;
                webview.add_WebResourceRequested(
                    &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                        let enforce = || -> windows::core::Result<()> {
                            let Some(args) = args else {
                                return Err(windows::core::Error::from_hresult(
                                    windows::Win32::Foundation::E_POINTER,
                                ));
                            };
                            let mut context = Default::default();
                            args.ResourceContext(&mut context)?;
                            // Wry's protocol filters also trigger this handler.
                            // Leave IPC and other non-document responses intact.
                            if context != COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT {
                                return Ok(());
                            }
                            let allowed = (|| -> windows::core::Result<bool> {
                                let request = args.Request()?;
                                let mut uri = PWSTR::null();
                                request.Uri(&mut uri)?;
                                let uri = take_pwstr(uri);
                                Ok(Url::parse(&uri)
                                    .is_ok_and(|url| super::may_navigate(&config, &url)))
                            })()
                            .unwrap_or(false);
                            if !allowed {
                                let response = environment.CreateWebResourceResponse(
                                    None,
                                    403,
                                    w!("Forbidden"),
                                    w!("Content-Length: 0\r\nCache-Control: no-store"),
                                )?;
                                args.SetResponse(&response)?;
                            }
                            Ok(())
                        };
                        if enforce().is_err() {
                            // Returning an HRESULT alone does not cancel a
                            // request. Never resume WebView2 without protection.
                            eprintln!("Windows navigation protection failed; closing the app");
                            std::process::exit(1);
                        }
                        Ok(())
                    })),
                    &mut token,
                )?;
                webview
                    .cast::<ICoreWebView2_22>()?
                    .AddWebResourceRequestedFilterWithRequestSourceKinds(
                        w!("*"),
                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
                        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                    )?;
                Ok(())
            })()
        };
        let _ = send.send(result);
    })?;
    // Tauri executes with_webview inline on the setup/UI thread. Fail startup
    // if that contract changes, instead of arming before registration finishes.
    receive.try_recv()??;
    Ok(())
}

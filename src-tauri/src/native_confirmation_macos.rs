//! macOS confirmation with explicit roles, independent of localized titles.
use block2::RcBlock;
use objc2::{rc::Retained, MainThreadMarker};
use objc2_app_kit::{
    NSAlert, NSAlertSecondButtonReturn, NSAlertStyle, NSEventModifierFlags, NSWindow,
};
use objc2_foundation::NSString;
use std::{cell::RefCell, rc::Rc, sync::mpsc};
use tauri::Manager;

/// Called on a blocking worker. The Cocoa main loop remains free to answer
/// the sheet. Only native-owned, reviewed catalogue content reaches here.
pub(crate) fn confirm<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    title: &str,
    message: &str,
    keep: &str,
    action: &str,
    cancel: &str,
) -> bool {
    let (sender, receiver) = mpsc::channel();
    let app_for_main = app.clone();
    let (title, message, keep, action, cancel) = (
        title.to_owned(),
        message.to_owned(),
        keep.to_owned(),
        action.to_owned(),
        cancel.to_owned(),
    );
    if app
        .run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let Some(window) = app_for_main.get_webview_window(super::MAIN_WINDOW) else {
                return;
            };
            let Ok(raw) = window.ns_window() else {
                return;
            };
            // SAFETY: Tauri supplied the live NSWindow of this retained webview
            // window on its main thread. Retain before the Tauri handle is dropped;
            // no raw Objective-C pointer crosses the thread boundary.
            let Some(parent) = (unsafe { Retained::retain(raw.cast::<NSWindow>()) }) else {
                return;
            };
            present(
                mtm,
                parent,
                &title,
                &message,
                &keep,
                &action,
                &cancel,
                move |response| {
                    let _ = sender.send(action_chosen(response));
                },
            );
        })
        .is_err()
    {
        return false;
    }
    // A missing parent, failed scheduling or closed callback channel refuses.
    receiver.recv().unwrap_or(false)
}

/// Shared by the production Tauri wrapper and the real AppKit CI harness.
/// Must be called on the main thread with its retained parent window.
pub(crate) fn present(
    mtm: MainThreadMarker,
    parent: Retained<NSWindow>,
    title: &str,
    message: &str,
    keep: &str,
    action: &str,
    cancel: &str,
    completed: impl Fn(isize) + 'static,
) -> Retained<NSAlert> {
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Warning);
    alert.setMessageText(&NSString::from_str(title));
    alert.setInformativeText(&NSString::from_str(message));
    let safe_button = alert.addButtonWithTitle(&NSString::from_str(keep));
    let action_button = alert.addButtonWithTitle(&NSString::from_str(action));
    let cancel_button = alert.addButtonWithTitle(&NSString::from_str(cancel));
    // AppKit guesses shortcuts from titles when adding buttons. Override ALL
    // three only after adding them: Return keeps data, Escape cancels, and the
    // irreversible action has no keyboard equivalent in any language.
    for (button, key) in [
        (&safe_button, "\r"),
        (&action_button, ""),
        (&cancel_button, "\u{1b}"),
    ] {
        button.setKeyEquivalent(&NSString::from_str(key));
        button.setKeyEquivalentModifierMask(NSEventModifierFlags::empty());
    }
    // The sheet retains its callback. Keep both objects alive until the
    // callback, then break the cycle while retaining them through its return.
    let held = Rc::new(RefCell::new(Some((alert.clone(), parent.clone()))));
    let completion_held = held.clone();
    let completion = RcBlock::new(move |response: isize| {
        let _until_return = completion_held.borrow_mut().take();
        completed(response);
    });
    alert.beginSheetModalForWindow_completionHandler(&parent, Some(&completion));
    alert
}

pub(crate) fn action_chosen(response: isize) -> bool {
    response == NSAlertSecondButtonReturn
}

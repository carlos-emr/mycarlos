//! macOS confirmation with explicit roles, independent of localized titles.
use block2::RcBlock;
use objc2::{
    define_class, msg_send, rc::Retained, sel, DefinedClass, MainThreadMarker, MainThreadOnly,
    Message,
};
use objc2_app_kit::{
    NSAlert, NSAlertSecondButtonReturn, NSAlertStyle, NSEventModifierFlags, NSModalResponseCancel,
    NSWindow, NSWindowWillCloseNotification,
};
use objc2_foundation::{
    NSNotification, NSNotificationCenter, NSObject, NSObjectProtocol, NSString,
};
use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    sync::mpsc,
};
use tauri::Manager;

struct HeldConfirmation {
    alert: Retained<NSAlert>,
    parent: Retained<NSWindow>,
    observer: Retained<ParentCloseObserver>,
}
struct ConfirmationState {
    completed: Cell<bool>,
    parent_is_closing: Cell<bool>,
    held: RefCell<Option<HeldConfirmation>>,
    callback: Box<dyn Fn(isize)>,
}
impl ConfirmationState {
    fn parent_will_close(&self) {
        if self.completed.get() {
            return;
        }
        // Set before ending the sheet: even a late action result must refuse.
        self.parent_is_closing.set(true);
        // Release the RefCell borrow before AppKit can reenter completion.
        let pair = self
            .held
            .borrow()
            .as_ref()
            .map(|held| (held.alert.clone(), held.parent.clone()));
        if let Some((alert, parent)) = pair {
            let sheet = alert.window();
            if parent
                .attachedSheet()
                .is_some_and(|attached| std::ptr::eq(&*attached, &*sheet))
            {
                // End exactly our sheet; its real native completion owns cleanup.
                parent.endSheet_returnCode(&sheet, NSModalResponseCancel);
            }
        }
    }
    fn complete(&self, response: isize) {
        if self.completed.replace(true) {
            return;
        }
        // Drop the borrow before removing the observer or invoking user code.
        let until_return = self.held.borrow_mut().take();
        if let Some(held) = &until_return {
            // SAFETY: this exact NSObject observer was registered below on the
            // main thread, for this retained NSWindow and notification only.
            unsafe {
                NSNotificationCenter::defaultCenter().removeObserver_name_object(
                    &*held.observer,
                    Some(NSWindowWillCloseNotification),
                    Some(&*held.parent),
                );
            }
        }
        let response = if self.parent_is_closing.get() {
            NSModalResponseCancel
        } else {
            response
        };
        (self.callback)(response);
        // Keep alert, parent and observer alive through the callback's return.
        drop(until_return);
    }
}
struct ParentCloseIvars {
    state: Weak<ConfirmationState>,
}
define_class!(
    // SAFETY: NSObject has no subclass requirements; this class has no Drop.
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[ivars = ParentCloseIvars]
    struct ParentCloseObserver;
    unsafe impl NSObjectProtocol for ParentCloseObserver {}
    impl ParentCloseObserver {
        #[unsafe(method(parentWillClose:))]
        fn parent_will_close(&self, _notification: &NSNotification) {
            // Completion may remove the observer while this method is active.
            let _observer_alive = self.retain();
            if let Some(state) = self.ivars().state.upgrade() { state.parent_will_close(); }
        }
    }
);
impl ParentCloseObserver {
    fn new(mtm: MainThreadMarker, state: Weak<ConfirmationState>) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(ParentCloseIvars { state });
        // SAFETY: NSObject init has this exact signature and superclass.
        unsafe { msg_send![super(this), init] }
    }
}

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
    alert.layout();
    for (button, key) in [
        (&safe_button, "\r"),
        (&action_button, ""),
        (&cancel_button, "\u{1b}"),
    ] {
        button.setKeyEquivalent(&NSString::from_str(key));
        button.setKeyEquivalentModifierMask(NSEventModifierFlags::empty());
    }
    let state = Rc::new(ConfirmationState {
        completed: Cell::new(false),
        parent_is_closing: Cell::new(false),
        held: RefCell::new(None),
        callback: Box::new(completed),
    });
    let observer = ParentCloseObserver::new(mtm, Rc::downgrade(&state));
    *state.held.borrow_mut() = Some(HeldConfirmation {
        alert: alert.clone(),
        parent: parent.clone(),
        observer: observer.clone(),
    });
    // SAFETY: the selector's one notification argument is exact; both this
    // observer and its filtered NSWindow are main-thread-only. NSWindow posts
    // willClose synchronously on its main thread. No Sendable block captures Rc.
    unsafe {
        NSNotificationCenter::defaultCenter().addObserver_selector_name_object(
            &*observer,
            sel!(parentWillClose:),
            Some(NSWindowWillCloseNotification),
            Some(&*parent),
        );
    }
    let completion_state = state.clone();
    let completion = RcBlock::new(move |response: isize| completion_state.complete(response));
    alert.beginSheetModalForWindow_completionHandler(&parent, Some(&completion));
    alert
}

pub(crate) fn action_chosen(response: isize) -> bool {
    response == NSAlertSecondButtonReturn
}

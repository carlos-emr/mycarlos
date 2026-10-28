//! Runs on the OS main thread, and exercises the production AppKit sheet.
//! Other targets explicitly report unsupported; they provide no platform proof.
#[cfg(target_os = "macos")]
#[path = "../src/native_confirmation_macos.rs"]
#[allow(dead_code)]
mod native_confirmation_macos;
#[cfg(target_os = "macos")]
#[path = "../src/ui_text.rs"]
#[allow(dead_code)]
mod ui_text;
#[cfg(target_os = "macos")]
#[path = "../src/ui_text_ids.rs"]
#[allow(dead_code)]
mod ui_text_ids;
#[cfg(target_os = "macos")]
const MAIN_WINDOW: &str = "main";

#[cfg(not(target_os = "macos"))]
fn main() {
    println!(
        "UNSUPPORTED: AppKit confirmation event proof requires macOS; no platform assertions ran."
    );
}

#[cfg(target_os = "macos")]
fn main() {
    use objc2::{rc::autoreleasepool, MainThreadMarker};
    use objc2_app_kit::NSApplication;
    let mtm = MainThreadMarker::new().expect("AppKit proof must run on the OS main thread");
    autoreleasepool(|_| {
        let app = NSApplication::sharedApplication(mtm);
        let (cases, error) = lifecycle::run(mtm, &app);
        let report = serde_json::json!({ "platform": "macOS", "scope": "Actual production AppKit sheet, synthesized native key events and real control activation; no physical keyboard or Tauri pointer-acquisition proof", "passed": error.is_none(), "cases": cases, "error": error });
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../test-results/native-dialog-macos.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        println!("{report}");
        assert!(error.is_none(), "AppKit event proof failed: {error:?}");
    });
}

#[cfg(target_os = "macos")]
mod lifecycle {
    use objc2::{
        define_class, msg_send, rc::Retained, runtime::AnyObject, sel, DefinedClass,
        MainThreadMarker, MainThreadOnly, Message,
    };
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSEvent, NSEventModifierFlags, NSEventType,
    };
    use objc2_foundation::{NSObject, NSObjectNSDelayedPerforming, NSObjectProtocol, NSPoint};
    use serde_json::Value;
    use std::cell::RefCell;
    struct RunnerIvars {
        result: RefCell<Option<(Vec<Value>, Option<String>)>>,
    }
    define_class!(
        #[unsafe(super = NSObject)]
        #[thread_kind = MainThreadOnly]
        #[ivars = RunnerIvars]
        struct EventProofRunner;
        unsafe impl NSObjectProtocol for EventProofRunner {}
        impl EventProofRunner {
            #[unsafe(method(runTests:))]
            fn run_tests(&self, _argument: Option<&AnyObject>) {
                let _runner_alive = self.retain();
                let app = NSApplication::sharedApplication(self.mtm());
                // The exact objc2 0.6.4 hello_world_app example requires this
                // for an unbundled Cargo-launched GUI app. Test harness only.
                #[allow(deprecated)]
                app.activateIgnoringOtherApps(true);
                let result = super::platform::run(self.mtm(), &app);
                *self.ivars().result.borrow_mut() = Some(result);
                // stop() needs an event to wake run() if nextEvent is waiting.
                let wake = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
                    NSEventType::ApplicationDefined, NSPoint::new(0.,0.), NSEventModifierFlags::empty(), 0., 0, None, 0, 0, 0,
                ).expect("could not create the owned run-loop wake event");
                app.stop(None);
                app.postEvent_atStart(&wake, false);
            }
        }
    );
    impl EventProofRunner {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(RunnerIvars {
                result: RefCell::new(None),
            });
            // SAFETY: NSObject init has this exact signature and superclass.
            unsafe { msg_send![super(this), init] }
        }
    }
    pub fn run(mtm: MainThreadMarker, app: &NSApplication) -> (Vec<Value>, Option<String>) {
        if !app.setActivationPolicy(NSApplicationActivationPolicy::Regular) {
            return (
                Vec::new(),
                Some("could not set the owned application's activation policy".to_owned()),
            );
        }
        let runner = EventProofRunner::new(mtm);
        // SAFETY: this one-object selector exists, accepts nil, and is queued
        // on the current OS main run loop. The retained runner spans app.run().
        unsafe {
            runner.performSelector_withObject_afterDelay(sel!(runTests:), None, 0.0);
        }
        // AppKit owns launching and its full GUI event loop, not a hand-made
        // approximation. The delayed selector begins only after run() starts.
        app.run();
        let result = runner.ivars().result.borrow_mut().take();
        result.unwrap_or_else(|| {
            (
                Vec::new(),
                Some("the run-loop proof did not complete".to_owned()),
            )
        })
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{native_confirmation_macos, ui_text::UiLocale, ui_text_ids::MessageId};
    use objc2::{rc::Retained, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSAlert, NSAlertFirstButtonReturn, NSAlertSecondButtonReturn, NSAlertThirdButtonReturn,
        NSApplication, NSBackingStoreType, NSCell, NSEvent, NSEventMask, NSEventModifierFlags,
        NSEventType, NSModalResponseCancel, NSResponder, NSWindow, NSWindowStyleMask,
    };
    use objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSPoint, NSRect, NSSize, NSString};
    use serde_json::{json, Value};
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
        time::{Duration, Instant},
    };

    fn pump(app: &NSApplication) {
        // SAFETY: the framework's process-lifetime mode constant is read on
        // the main thread, with no mutation or cross-thread pointer access.
        let mode = unsafe { NSDefaultRunLoopMode };
        if let Some(event) = app.nextEventMatchingMask_untilDate_inMode_dequeue(
            NSEventMask::Any,
            Some(&NSDate::dateWithTimeIntervalSinceNow(0.01)),
            mode,
            true,
        ) {
            app.sendEvent(&event);
        }
    }
    // Each wait has its own five-second deadline. A case can use three waits;
    // all 24 cases allow about 360 seconds of waiting, plus calls and cleanup.
    fn until(app: &NSApplication, predicate: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !predicate() {
            if Instant::now() >= deadline {
                return false;
            }
            pump(app);
        }
        true
    }
    fn parent(mtm: MainThreadMarker) -> Retained<NSWindow> {
        // SAFETY: called on the main thread with a valid fixed content rect
        // and standard documented window style/backing flags.
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(mtm),
                NSRect::new(NSPoint::new(0., 0.), NSSize::new(760., 540.)),
                NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        // SAFETY: Rust's Retained owner, rather than close(), releases the
        // test window. Prevent AppKit from consuming that ownership on close.
        unsafe {
            window.setReleasedWhenClosed(false);
        }
        window.makeKeyAndOrderFront(None);
        window
    }

    fn window_state(
        app: &NSApplication,
        parent: &NSWindow,
        sheet: &NSWindow,
        alert: &NSAlert,
    ) -> Value {
        let key = app.keyWindow();
        let first = sheet.firstResponder();
        let default = sheet.defaultButtonCell();
        let buttons = alert.buttons();
        let default_matches: Vec<bool> = (0..3)
            .map(|index| {
                let cell = buttons.objectAtIndex(index).cell();
                match (&default, &cell) {
                    (Some(default), Some(cell)) => {
                        let default_base: &NSCell = default;
                        std::ptr::eq(default_base, &**cell)
                    }
                    _ => false,
                }
            })
            .collect();
        let first_matches: Vec<bool> = (0..3)
            .map(|index| {
                let button = buttons.objectAtIndex(index);
                let responder: &NSResponder = &button;
                first
                    .as_ref()
                    .is_some_and(|first| std::ptr::eq(&**first, responder))
            })
            .collect();
        json!({ "appRunning": app.isRunning(), "appActive": app.isActive(), "activationPolicy": format!("{:?}", app.activationPolicy()), "keyWindowIsParent": key.as_ref().is_some_and(|key| std::ptr::eq(&**key,parent)), "keyWindowIsSheet": key.as_ref().is_some_and(|key| std::ptr::eq(&**key,sheet)), "parentCanBecomeKey": parent.canBecomeKeyWindow(), "sheetCanBecomeKey": sheet.canBecomeKeyWindow(), "parentStyle": parent.styleMask().bits(), "sheetStyle": sheet.styleMask().bits(), "firstResponderPresent": first.is_some(), "firstResponderMatchesButtons": first_matches, "defaultCellPresent": default.is_some(), "defaultCellMatchesButtons": default_matches })
    }

    pub fn run(mtm: MainThreadMarker, app: &NSApplication) -> (Vec<Value>, Option<String>) {
        // Still attempt all 24 cases if activation fails: the strict key-window
        // gates and recorded app state then expose the actual limitation.
        let _activation_observed = until(app, || app.isActive());
        let mut cases = Vec::new();
        let mut first_error = None;
        for (tag, locale) in [
            ("en", UiLocale::En),
            ("fr", UiLocale::Fr),
            ("es", UiLocale::Es),
            ("pl", UiLocale::Pl),
            ("pt-BR", UiLocale::PtBr),
            ("zh-CN", UiLocale::ZhCn),
            ("zh-TW", UiLocale::ZhTw),
        ] {
            for stimulus in ["Return", "Escape", "action"] {
                if let Err(error) = case(mtm, app, tag, locale, stimulus, &mut cases) {
                    first_error.get_or_insert(error);
                }
            }
        }
        for stimulus in ["unknown", "cancel", "close"] {
            if let Err(error) = case(mtm, app, "fr", UiLocale::Fr, stimulus, &mut cases) {
                first_error.get_or_insert(error);
            }
        }
        (cases, first_error)
    }

    fn case(
        mtm: MainThreadMarker,
        app: &NSApplication,
        tag: &str,
        locale: UiLocale,
        stimulus: &str,
        cases: &mut Vec<Value>,
    ) -> Result<(), String> {
        let parent = parent(mtm);
        let response = Rc::new(Cell::new(None));
        let calls = Rc::new(Cell::new(0));
        let callback_response = response.clone();
        let callback_calls = calls.clone();
        let text = |id| locale.text(id).map_err(|error| format!("{error:?}"));
        let title = text(MessageId::NativeSetAsideTitle)?;
        let warning = text(MessageId::NativeSetAsideKept)?;
        let keep = text(MessageId::NativeVaultKeep)?;
        let confirm = text(MessageId::NativeSetAsideConfirm)?;
        let cancel = text(MessageId::NativeCancel)?;
        let alert = native_confirmation_macos::present(
            mtm,
            parent.clone(),
            &title,
            &warning,
            &keep,
            &confirm,
            &cancel,
            move |value| {
                callback_calls.set(callback_calls.get() + 1);
                callback_response.set(Some(value));
            },
        );
        let sheet = alert.window();
        let buttons = alert.buttons();
        let readback = Rc::new(RefCell::new(Vec::<Value>::new()));
        let mut keyboard_role_errors = Vec::new();
        let mut key_event_posted = false;
        let diagnostics = Rc::new(RefCell::new(
            json!({ "initial": window_state(app, &parent, &sheet, &alert) }),
        ));
        let result = (|| {
            if !until(app, || {
                parent.attachedSheet().is_some() && sheet.isVisible()
            }) {
                return Err("sheet did not become visible".to_owned());
            }
            let actual_parent = sheet.sheetParent().ok_or("sheet has no parent")?;
            if !std::ptr::eq(&*actual_parent, &*parent) {
                return Err("sheet attached to the wrong window".to_owned());
            }
            // AppKit can finish activating the first owned sheet after it
            // becomes visible. Read strict button metadata only after the
            // same actual-key-window readiness required for native key events.
            sheet.makeKeyAndOrderFront(None);
            let ready_for_metadata = until(app, || {
                app.isRunning()
                    && app.isActive()
                    && sheet.isVisible()
                    && sheet.isKeyWindow()
                    && parent
                        .attachedSheet()
                        .is_some_and(|attached| std::ptr::eq(&*attached, &*sheet))
            });
            diagnostics.borrow_mut()["beforeMetadata"] = window_state(app, &parent, &sheet, &alert);
            if !ready_for_metadata {
                return Err("the running active application did not make its visible owned sheet the actual key window before metadata readback".to_owned());
            }
            for (index, expected_key) in ["\r", "", "\u{1b}"].iter().enumerate() {
                let button = buttons.objectAtIndex(index);
                let key = button.keyEquivalent().to_string();
                let modifiers = button.keyEquivalentModifierMask().bits();
                readback.borrow_mut().push(json!({ "index": index, "title": button.title().to_string(), "key": key, "modifiers": modifiers }));
                if key != *expected_key || modifiers != 0 {
                    keyboard_role_errors
                        .push(format!("incorrect keyboard role for button {index}"));
                }
            }
            if buttons.objectAtIndex(2).title().to_string() != cancel {
                return Err("cancel label is not localized".to_owned());
            }
            match stimulus {
                "Return" | "Escape" => {
                    diagnostics.borrow_mut()["beforeKeyEvent"] =
                        window_state(app, &parent, &sheet, &alert);
                    if !sheet.isKeyWindow() {
                        return Err(
                            "sheet was no longer the actual key window before the key event"
                                .to_owned(),
                        );
                    }
                    if !app.isRunning() || !app.isActive() {
                        return Err("the native application was not running and active before the key event".to_owned());
                    }
                    let (key, code) = if stimulus == "Return" {
                        ("\r", 36)
                    } else {
                        ("\u{1b}", 53)
                    };
                    let chars = NSString::from_str(key);
                    let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(NSEventType::KeyDown, NSPoint::new(0.,0.), NSEventModifierFlags::empty(), 0., sheet.windowNumber(), None, &chars, &chars, false, code).ok_or("native key event creation failed")?;
                    app.postEvent_atStart(&event, false);
                    key_event_posted = true;
                }
                "action" => {
                    // SAFETY: this is the retained live second button of the
                    // actual production alert, on its main thread.
                    unsafe {
                        buttons.objectAtIndex(1).performClick(None);
                    }
                }
                "unknown" => parent.endSheet_returnCode(&sheet, 12345),
                "cancel" => parent.endSheet_returnCode(&sheet, NSModalResponseCancel),
                "close" => parent.close(),
                _ => unreachable!(),
            }
            let completed = until(app, || response.get().is_some());
            diagnostics.borrow_mut()["afterStimulus"] = window_state(app, &parent, &sheet, &alert);
            if !completed {
                return Err(
                    "native completion timed out after stimulus; cleanup cannot count as proof"
                        .to_owned(),
                );
            }
            let actual = response.get().unwrap();
            let expected_response = match stimulus {
                "Return" => Some(NSAlertFirstButtonReturn),
                "Escape" => Some(NSAlertThirdButtonReturn),
                "action" => Some(NSAlertSecondButtonReturn),
                "unknown" => Some(12345),
                "cancel" => Some(NSModalResponseCancel),
                "close" => None,
                _ => unreachable!(),
            };
            if expected_response.is_some_and(|expected| actual != expected) {
                return Err(format!("wrong role response for {stimulus}: expected {expected_response:?}, got {actual}"));
            }
            let consent = native_confirmation_macos::action_chosen(actual);
            if consent != (stimulus == "action") || calls.get() != 1 {
                return Err(format!(
                    "unexpected completion {actual}, consent {consent}, callbacks {}",
                    calls.get()
                ));
            }
            // Retain the strict metadata failure, but send the actual event
            // first so a failed report still records real keyboard behavior.
            if let Some(error) = keyboard_role_errors.first() {
                return Err(error.clone());
            }
            Ok(())
        })();
        cases.push(json!({ "locale": tag, "stimulus": stimulus, "buttons": *readback.borrow(), "keyboardRoleErrors": keyboard_role_errors, "keyEventPosted": key_event_posted, "appWindowState": *diagnostics.borrow(), "response": response.get(), "consent": response.get().map(native_confirmation_macos::action_chosen), "callbacks": calls.get(), "passed": result.is_ok(), "error": result.as_ref().err() }));
        // Record failure before cleanup. These are only this case's own
        // objects; a cleanup response never turns a timeout into success.
        if parent.attachedSheet().is_some() {
            parent.endSheet_returnCode(&sheet, NSModalResponseCancel);
        }
        parent.close();
        result
    }
}

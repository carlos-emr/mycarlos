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
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
    let mtm = MainThreadMarker::new().expect("AppKit proof must run on the OS main thread");
    autoreleasepool(|_| {
        let app = NSApplication::sharedApplication(mtm);
        app.finishLaunching();
        assert!(
            app.setActivationPolicy(NSApplicationActivationPolicy::Regular),
            "could not activate the owned test application"
        );
        app.activate();
        let (cases, error) = platform::run(mtm, &app);
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
mod platform {
    use super::{native_confirmation_macos, ui_text::UiLocale};
    use objc2::{rc::Retained, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSAlertFirstButtonReturn, NSAlertSecondButtonReturn, NSAlertThirdButtonReturn,
        NSApplication, NSBackingStoreType, NSEvent, NSEventMask, NSEventModifierFlags, NSEventType,
        NSModalResponseCancel, NSWindow, NSWindowStyleMask,
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
    // all 18 cases allow about 270 seconds of waiting, plus calls and cleanup.
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

    pub fn run(mtm: MainThreadMarker, app: &NSApplication) -> (Vec<Value>, Option<String>) {
        let mut cases = Vec::new();
        let mut first_error = None;
        for (tag, locale) in [
            ("en", UiLocale::En),
            ("fr", UiLocale::Fr),
            ("es", UiLocale::Es),
            ("pl", UiLocale::Pl),
            ("pt-BR", UiLocale::PtBr),
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
        let alert = native_confirmation_macos::present(
            mtm,
            parent.clone(),
            locale.text("native.setAside.title"),
            locale.text("native.setAside.kept"),
            locale.text("native.vault.keep"),
            locale.text("native.setAside.confirm"),
            locale.text("native.cancel"),
            move |value| {
                callback_calls.set(callback_calls.get() + 1);
                callback_response.set(Some(value));
            },
        );
        let sheet = alert.window();
        let buttons = alert.buttons();
        let readback = Rc::new(RefCell::new(Vec::<Value>::new()));
        let mut keyboard_role_errors = Vec::new();
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
            if buttons.objectAtIndex(2).title().to_string() != locale.text("native.cancel") {
                return Err("cancel label is not localized".to_owned());
            }
            match stimulus {
                "Return" | "Escape" => {
                    sheet.makeKeyAndOrderFront(None);
                    if !until(app, || sheet.isKeyWindow()) {
                        return Err("sheet did not become the actual key window".to_owned());
                    }
                    let (key, code) = if stimulus == "Return" {
                        ("\r", 36)
                    } else {
                        ("\u{1b}", 53)
                    };
                    let chars = NSString::from_str(key);
                    let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(NSEventType::KeyDown, NSPoint::new(0.,0.), NSEventModifierFlags::empty(), 0., sheet.windowNumber(), None, &chars, &chars, false, code).ok_or("native key event creation failed")?;
                    app.postEvent_atStart(&event, false);
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
            if !until(app, || response.get().is_some()) {
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
        cases.push(json!({ "locale": tag, "stimulus": stimulus, "buttons": *readback.borrow(), "keyboardRoleErrors": keyboard_role_errors, "response": response.get(), "consent": response.get().map(native_confirmation_macos::action_chosen), "callbacks": calls.get(), "passed": result.is_ok(), "error": result.as_ref().err() }));
        // Record failure before cleanup. These are only this case's own
        // objects; a cleanup response never turns a timeout into success.
        if parent.attachedSheet().is_some() {
            parent.endSheet_returnCode(&sheet, NSModalResponseCancel);
        }
        parent.close();
        result
    }
}

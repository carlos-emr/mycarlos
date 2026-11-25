//! The macOS notice backend: `UNUserNotificationCenter`, asked in context.
//!
//! - `permission()` reads the system's answer (`notDetermined`, `denied`, `authorized`,
//!   `provisional`) without ever prompting.
//! - `request_permission()` shows macOS's own "Allow notifications?" prompt. The runtime calls it
//!   when the patient turns notices on, so the question comes with the choice and never at launch.
//! - `accept()` posts the fixed catalogue sentence under the title "myCarlos" and nothing else:
//!   no identifier of a document, a person or a clinic, no sound, no badge, no actions.
//! - A process that is not a `.app` bundle with a bundle identifier (a bare executable run from a
//!   terminal, a test binary) has no notification centre, and asking for it would raise an
//!   exception. That is `Unavailable`, never a crash.
//!
//! Not run on a real Mac by the author: the pure mapping is unit tested everywhere
//! (`document_notification_runtime::active::permission_for_authorization`), and CI's macOS job
//! compiles this file.
use crate::document_notification_runtime::{
    active::{permission_for_authorization, Backend},
    Error, Permission,
};
use block2::RcBlock;
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool},
    ClassType,
};
use objc2_foundation::{NSObject, NSObjectProtocol, NSString};
use std::{
    sync::{mpsc, OnceLock},
    time::Duration,
};

// The framework is linked here: without it the class lookup below finds nothing.
#[link(name = "UserNotifications", kind = "framework")]
extern "C" {}

/// `UNAuthorizationOptionAlert`: banners and alerts only; no sound and no badge.
const OPTION_ALERT: usize = 1 << 2;
/// `UNNotificationPresentationOptionBanner | List`: shown even while myCarlos is in front, which
/// macOS otherwise suppresses (so "Show a test notice" is visible).
const PRESENT_BANNER_AND_LIST: usize = (1 << 4) | (1 << 3);
/// The system's answer can take a moment, and the prompt waits for the person. The backend gives
/// up waiting after this; the system keeps the prompt, and the status shows the real answer later.
const ANSWER_WAIT: Duration = Duration::from_secs(60);
const SETTINGS_WAIT: Duration = Duration::from_secs(5);
/// One identifier for every notice: a new one replaces the one still showing.
const REQUEST_ID: &str = "ca.carlos.mycarlos.document";

define_class!(
    // SAFETY: NSObject has no subclass requirements; this class has no ivars and no Drop.
    #[unsafe(super = NSObject)]
    #[name = "MyCarlosNoticeDelegate"]
    struct NoticeDelegate;

    unsafe impl NSObjectProtocol for NoticeDelegate {}

    impl NoticeDelegate {
        /// Show the notice as a banner even when the app is in front.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &AnyObject,
            _notification: &AnyObject,
            handler: &block2::DynBlock<dyn Fn(usize)>,
        ) {
            handler.call((PRESENT_BANNER_AND_LIST,));
        }
    }
);

/// Keeps the delegate alive: the notification centre holds its delegate weakly.
struct Held(Retained<NoticeDelegate>);
// SAFETY: the delegate has no state and its one method only calls the block it is given.
unsafe impl Send for Held {}
unsafe impl Sync for Held {}
static DELEGATE: OnceLock<Held> = OnceLock::new();

pub struct MacBackend {
    /// This process is a `.app` bundle with an identifier, so a notification centre exists.
    bundled: bool,
}

impl MacBackend {
    pub fn new() -> Self {
        let bundled = in_app_bundle();
        if bundled {
            install_delegate();
        }
        Self { bundled }
    }

    /// The system's authorization status as the raw `UNAuthorizationStatus`, or `None` if it could
    /// not be read.
    fn authorization(&self) -> Option<isize> {
        if !self.bundled {
            return None;
        }
        let center = center()?;
        let (sender, receiver) = mpsc::channel();
        let answer = RcBlock::new(move |settings: *mut AnyObject| {
            // Read inside the block: the settings object is only lent to it.
            let status: Option<isize> = if settings.is_null() {
                None
            } else {
                // SAFETY: a non-null UNNotificationSettings answers `authorizationStatus`.
                Some(unsafe { msg_send![&*settings, authorizationStatus] })
            };
            let _ = sender.send(status);
        });
        // SAFETY: the selector and the block's argument type are those of the documented method.
        let _: () =
            unsafe { msg_send![&*center, getNotificationSettingsWithCompletionHandler: &*answer] };
        receiver.recv_timeout(SETTINGS_WAIT).ok().flatten()
    }
}

impl Default for MacBackend {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether this process is a bundled app: only then does `UNUserNotificationCenter` exist for it.
fn in_app_bundle() -> bool {
    let Some(class) = AnyClass::get(c"NSBundle") else {
        return false;
    };
    // SAFETY: `+[NSBundle mainBundle]` and `-bundlePath`, `-bundleIdentifier` are plain getters.
    unsafe {
        let bundle: Option<Retained<AnyObject>> = msg_send![class, mainBundle];
        let Some(bundle) = bundle else {
            return false;
        };
        let path: Option<Retained<NSString>> = msg_send![&*bundle, bundlePath];
        let identifier: Option<Retained<NSString>> = msg_send![&*bundle, bundleIdentifier];
        path.is_some_and(|path| path.to_string().ends_with(".app"))
            && identifier.is_some_and(|identifier| !identifier.to_string().is_empty())
    }
}

fn center() -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"UNUserNotificationCenter")?;
    // SAFETY: `+currentNotificationCenter` is a plain getter, valid in a bundled app.
    unsafe { msg_send![class, currentNotificationCenter] }
}

fn install_delegate() {
    DELEGATE.get_or_init(|| {
        let delegate: Retained<NoticeDelegate> = unsafe { msg_send![NoticeDelegate::class(), new] };
        if let Some(center) = center() {
            // SAFETY: the delegate answers the one optional method the centre looks for.
            let _: () = unsafe { msg_send![&*center, setDelegate: &*delegate] };
        }
        Held(delegate)
    });
}

impl Backend for MacBackend {
    fn permission(&self) -> Permission {
        if !self.bundled {
            return Permission::Unavailable;
        }
        match self.authorization() {
            Some(status) => permission_for_authorization(status),
            None => Permission::Unknown,
        }
    }

    fn request_permission(&self) -> Permission {
        if !self.bundled {
            return Permission::Unavailable;
        }
        // Only a question that has not been asked is asked: macOS never shows the prompt twice,
        // and a refusal is changed in System Settings, not here.
        if self.authorization() == Some(0) {
            if let Some(center) = center() {
                let (sender, receiver) = mpsc::channel();
                let answer = RcBlock::new(move |granted: Bool, _error: *mut AnyObject| {
                    let _ = sender.send(granted.as_bool());
                });
                // SAFETY: the selector, the options and the block's argument types are those of the
                // documented method.
                let _: () = unsafe {
                    msg_send![
                        &*center,
                        requestAuthorizationWithOptions: OPTION_ALERT,
                        completionHandler: &*answer
                    ]
                };
                let _ = receiver.recv_timeout(ANSWER_WAIT);
            }
        }
        self.permission()
    }

    fn accept(&self, body: &str, still_current: &dyn Fn() -> bool) -> Result<(), Error> {
        if !self.bundled {
            return Err(Error::Unavailable);
        }
        // A notice pressed for before the question was asked asks it here, in context.
        if self.permission() == Permission::NotYetAsked {
            self.request_permission();
        }
        if self.permission() != Permission::Allowed {
            return Err(Error::OsRejected);
        }
        let center = center().ok_or(Error::Unavailable)?;
        let (content_class, request_class) = (
            AnyClass::get(c"UNMutableNotificationContent").ok_or(Error::Unavailable)?,
            AnyClass::get(c"UNNotificationRequest").ok_or(Error::Unavailable)?,
        );
        // SAFETY: plain construction and setters of documented classes, with NSString arguments.
        let request: Retained<AnyObject> = unsafe {
            let content: Retained<AnyObject> = msg_send![content_class, new];
            let _: () = msg_send![&*content, setTitle: &*NSString::from_str("myCarlos")];
            let _: () = msg_send![&*content, setBody: &*NSString::from_str(body)];
            let identifier = NSString::from_str(REQUEST_ID);
            msg_send![
                request_class,
                requestWithIdentifier: &*identifier,
                content: &*content,
                trigger: Option::<&AnyObject>::None
            ]
        };
        if !still_current() {
            return Err(Error::Cancelled);
        }
        let (sender, receiver) = mpsc::channel();
        let done = RcBlock::new(move |error: *mut AnyObject| {
            let _ = sender.send(error.is_null());
        });
        // SAFETY: the selector and the block's argument type are those of the documented method.
        let _: () = unsafe {
            msg_send![
                &*center,
                addNotificationRequest: &*request,
                withCompletionHandler: &*done
            ]
        };
        match receiver.recv_timeout(SETTINGS_WAIT) {
            Ok(true) => Ok(()),
            _ => Err(Error::OsRejected),
        }
    }
}

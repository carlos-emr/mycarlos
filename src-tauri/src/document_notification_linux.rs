//! Arrival and test notices on a Linux desktop, through the freedesktop notification service
//! (`org.freedesktop.Notifications` on the session bus), as a backend of the notice runtime.
//!
//! There is no permission step on this platform: the permission is "Allowed" when that service
//! owns its name on the session bus, and "Unavailable" when it does not (a headless machine, no
//! session bus, no notification daemon). A notice shows the application's name and the one fixed
//! sentence the runtime gives it: no actions, no links, no icon, no hints, no document data.
//!
//! It must never block or crash the app. Every bus call runs on a short-lived thread and is
//! given three seconds; a call that fails, panics or does not answer in time is a refusal (or an
//! "Unavailable"), never a hang and never a panic here. The bus itself sits behind the small
//! [`Bus`] trait so the backend is tested through the runtime's `Backend` seam with a fake.
//!
//! Not tested on a real Linux desktop (see the pull request): the real [`Session`] bus is the
//! only part the tests do not reach.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use crate::document_notification_runtime::{active::Backend, Error, Permission};
use std::{sync::mpsc, sync::Arc, thread, time::Duration};

/// What the notice calls the application: the only text besides the fixed sentence.
const APP_NAME: &str = "myCarlos";
/// The longest sentence this will hand to the bus (the catalogue's sentences are far shorter).
const MAX_BODY_BYTES: usize = 1024;
/// How long any one call to the bus may take before it counts as failed.
const CALL_TIMEOUT: Duration = Duration::from_secs(3);

/// The arguments of one `Notify` call, in the order the specification gives them. Built in one
/// place so a test can check, once, that nothing but the name and the sentence is sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Notice {
    pub app_name: &'static str,
    /// 0: this notice replaces nothing.
    pub replaces_id: u32,
    /// Empty: no icon.
    pub app_icon: &'static str,
    /// The application's name, as the title line.
    pub summary: &'static str,
    /// The fixed sentence.
    pub body: String,
    /// Empty: no actions, so no buttons and nothing to click through to.
    pub actions: Vec<String>,
    /// How many hints are sent: none (no urgency, category, image or sound).
    pub hints: usize,
    /// -1: the daemon's own default lifetime.
    pub expire_timeout: i32,
}

impl Notice {
    fn new(body: &str) -> Option<Self> {
        if body.is_empty() || body.len() > MAX_BODY_BYTES || body.chars().any(char::is_control) {
            return None;
        }
        Some(Self {
            app_name: APP_NAME,
            replaces_id: 0,
            app_icon: "",
            summary: APP_NAME,
            body: body.to_owned(),
            actions: Vec::new(),
            hints: 0,
            expire_timeout: -1,
        })
    }
}

/// The session bus, as far as this needs it.
pub(crate) trait Bus: Send + Sync + 'static {
    /// Whether a notification service owns `org.freedesktop.Notifications` on the session bus.
    /// A bus that cannot be reached at all is `false`.
    fn service_present(&self) -> bool;
    /// One `Notify` call.
    fn notify(&self, notice: &Notice) -> Result<(), ()>;
}

/// Runs `call` on its own thread and waits at most `timeout` for its answer. A panic, or no
/// answer in time, is `None`: the caller treats both as "could not".
fn within<T: Send + 'static>(
    timeout: Duration,
    call: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (send, receive) = mpsc::channel();
    // The thread is left to finish on its own if the answer comes too late.
    thread::Builder::new()
        .name("mycarlos-notice-bus".into())
        .spawn(move || {
            let _ = send.send(call());
        })
        .ok()?;
    receive.recv_timeout(timeout).ok()
}

/// The notice runtime's backend for a Linux desktop.
pub(crate) struct LinuxBackend<B: Bus> {
    bus: Arc<B>,
    timeout: Duration,
}

impl<B: Bus> LinuxBackend<B> {
    pub(crate) fn with_bus(bus: B) -> Self {
        Self {
            bus: Arc::new(bus),
            timeout: CALL_TIMEOUT,
        }
    }

    #[cfg(test)]
    fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

impl<B: Bus> Backend for LinuxBackend<B> {
    fn permission(&self) -> Permission {
        let bus = Arc::clone(&self.bus);
        match within(self.timeout, move || bus.service_present()) {
            Some(true) => Permission::Allowed,
            _ => Permission::Unavailable,
        }
    }

    fn accept(&self, body: &str, still_current: &dyn Fn() -> bool) -> Result<(), Error> {
        let notice = Notice::new(body).ok_or(Error::OsRejected)?;
        // Checked just before the call: a notice the person turned off meanwhile is not shown.
        if !still_current() {
            return Err(Error::Cancelled);
        }
        let bus = Arc::clone(&self.bus);
        match within(self.timeout, move || bus.notify(&notice)) {
            Some(Ok(())) => Ok(()),
            _ => Err(Error::OsRejected),
        }
    }
}

#[cfg(target_os = "linux")]
pub(crate) use session::Session;

/// The real bus: a fresh blocking connection to the session bus for each call (a notice is rare,
/// and nothing here holds a socket between them).
#[cfg(target_os = "linux")]
mod session {
    use super::{Bus, Notice};
    use std::collections::HashMap;
    use zbus::{
        blocking::{fdo::DBusProxy, Connection},
        names::BusName,
        zvariant::Value,
    };

    const SERVICE: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";

    pub(crate) struct Session;

    impl Bus for Session {
        fn service_present(&self) -> bool {
            let Ok(connection) = Connection::session() else {
                return false;
            };
            let Ok(dbus) = DBusProxy::new(&connection) else {
                return false;
            };
            let Ok(name) = BusName::try_from(SERVICE) else {
                return false;
            };
            dbus.name_has_owner(name).unwrap_or(false)
        }

        fn notify(&self, notice: &Notice) -> Result<(), ()> {
            let connection = Connection::session().map_err(|_| ())?;
            let hints: HashMap<&str, Value<'_>> = HashMap::new();
            let actions: Vec<&str> = Vec::new();
            connection
                .call_method(
                    Some(SERVICE),
                    PATH,
                    Some(SERVICE),
                    "Notify",
                    &(
                        notice.app_name,
                        notice.replaces_id,
                        notice.app_icon,
                        notice.summary,
                        notice.body.as_str(),
                        actions,
                        hints,
                        notice.expire_timeout,
                    ),
                )
                .map(|_| ())
                .map_err(|_| ())
        }
    }
}

#[cfg(target_os = "linux")]
impl LinuxBackend<Session> {
    pub(crate) fn new() -> Self {
        Self::with_bus(Session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };
    use std::time::Instant;

    /// What the fake bus is asked to do.
    #[derive(Clone, Copy)]
    enum Behaviour {
        /// A daemon that answers.
        Present,
        /// No session bus, or no daemon on it.
        Absent,
        /// A daemon that takes a call and never answers it (long enough for any test here).
        Hangs,
        /// A call that panics.
        Panics,
        /// A daemon that is there but refuses the notice.
        Refuses,
    }

    struct FakeBus {
        behaviour: Behaviour,
        sent: Arc<Mutex<Vec<Notice>>>,
        presence_asked: Arc<AtomicUsize>,
    }

    impl Bus for FakeBus {
        fn service_present(&self) -> bool {
            self.presence_asked.fetch_add(1, Ordering::SeqCst);
            match self.behaviour {
                Behaviour::Absent => false,
                Behaviour::Hangs => {
                    thread::sleep(Duration::from_secs(5));
                    true
                }
                Behaviour::Panics => panic!("FAKE: the bus fell over"),
                Behaviour::Present | Behaviour::Refuses => true,
            }
        }
        fn notify(&self, notice: &Notice) -> Result<(), ()> {
            match self.behaviour {
                Behaviour::Hangs => {
                    thread::sleep(Duration::from_secs(5));
                    Ok(())
                }
                Behaviour::Panics => panic!("FAKE: the bus fell over"),
                Behaviour::Absent | Behaviour::Refuses => Err(()),
                Behaviour::Present => {
                    self.sent.lock().unwrap().push(notice.clone());
                    Ok(())
                }
            }
        }
    }

    fn backend(behaviour: Behaviour) -> (LinuxBackend<FakeBus>, Arc<Mutex<Vec<Notice>>>) {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let backend = LinuxBackend::with_bus(FakeBus {
            behaviour,
            sent: Arc::clone(&sent),
            presence_asked: Arc::new(AtomicUsize::new(0)),
        })
        .with_timeout(Duration::from_millis(200));
        (backend, sent)
    }

    const SENTENCE: &str = "A new document is waiting. Unlock myCarlos to see it.";

    #[test]
    fn the_permission_is_allowed_when_the_service_is_on_the_bus_and_unavailable_when_it_is_not() {
        assert_eq!(
            backend(Behaviour::Present).0.permission(),
            Permission::Allowed
        );
        assert_eq!(
            backend(Behaviour::Refuses).0.permission(),
            Permission::Allowed
        );
        // Headless, no session bus, no daemon: no notices, and no permission to ask for.
        assert_eq!(
            backend(Behaviour::Absent).0.permission(),
            Permission::Unavailable
        );
    }

    #[test]
    fn a_notice_carries_the_app_name_and_the_fixed_sentence_and_nothing_else() {
        let (backend, sent) = backend(Behaviour::Present);
        backend.accept(SENTENCE, &|| true).unwrap();
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(
            sent[0],
            Notice {
                app_name: "myCarlos",
                replaces_id: 0,
                app_icon: "",
                summary: "myCarlos",
                body: SENTENCE.to_owned(),
                actions: Vec::new(),
                hints: 0,
                expire_timeout: -1,
            }
        );
    }

    #[test]
    fn a_notice_that_was_turned_off_meanwhile_is_not_shown() {
        let (backend, sent) = backend(Behaviour::Present);
        assert!(matches!(
            backend.accept(SENTENCE, &|| false),
            Err(Error::Cancelled)
        ));
        assert!(sent.lock().unwrap().is_empty());
    }

    #[test]
    fn a_sentence_that_is_empty_too_long_or_has_control_characters_is_refused_unsent() {
        let (backend, sent) = backend(Behaviour::Present);
        for body in [
            "",
            &"x".repeat(MAX_BODY_BYTES + 1),
            "A line\nbreak",
            "bell\u{7}",
        ] {
            assert!(
                matches!(backend.accept(body, &|| true), Err(Error::OsRejected)),
                "{body:?}"
            );
        }
        assert!(sent.lock().unwrap().is_empty());
    }

    #[test]
    fn a_daemon_that_refuses_or_is_missing_is_a_refusal_never_a_success() {
        for behaviour in [Behaviour::Refuses, Behaviour::Absent] {
            let (backend, sent) = backend(behaviour);
            assert!(matches!(
                backend.accept(SENTENCE, &|| true),
                Err(Error::OsRejected)
            ));
            assert!(sent.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn a_bus_that_hangs_never_blocks_the_caller() {
        let (backend, _) = backend(Behaviour::Hangs);
        let started = Instant::now();
        assert_eq!(backend.permission(), Permission::Unavailable);
        assert!(matches!(
            backend.accept(SENTENCE, &|| true),
            Err(Error::OsRejected)
        ));
        // Two calls of 200 ms each, nowhere near the 5 seconds the fake sleeps.
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_bus_call_that_panics_does_not_take_the_app_down() {
        let (backend, _) = backend(Behaviour::Panics);
        assert_eq!(backend.permission(), Permission::Unavailable);
        assert!(matches!(
            backend.accept(SENTENCE, &|| true),
            Err(Error::OsRejected)
        ));
    }
}

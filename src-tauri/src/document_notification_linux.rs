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
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

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

/// How long a permission answer is kept: a settings screen polls the status, and each real
/// question opens a fresh bus connection, so asking again within this time repeats the last answer.
const PERMISSION_TTL: Duration = Duration::from_secs(15);

/// What every bus call of one backend shares: at most one call at a time, when it began, and the
/// last permission answer. A bus call that never returns (a hung notification daemon) leaves its
/// thread and socket behind, so while one is outstanding no other is started. A new call meets
/// one of two cases: the outstanding call is younger than the timeout (an ordinary call still on
/// its way, such as a settings poll's permission question), so it waits for it and then runs; or it
/// is older (the daemon is hung), so it is refused at once.
struct Gate {
    outstanding: AtomicBool,
    /// When the outstanding call began.
    since: Mutex<Option<Instant>>,
    permission: Mutex<Option<(Instant, Permission)>>,
    ttl: Duration,
}

impl Gate {
    fn new(ttl: Duration) -> Self {
        Self {
            outstanding: AtomicBool::new(false),
            since: Mutex::new(None),
            permission: Mutex::new(None),
            ttl,
        }
    }

    /// How old the outstanding call is, if there is one.
    fn age(&self) -> Option<Duration> {
        self.since
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .map(|began| began.elapsed())
    }

    /// A permission answer, kept now. Written by the worker as its call ends, so a late success
    /// after the caller gave up still refreshes the answer.
    fn remember(&self, answer: Permission) {
        *self
            .permission
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((Instant::now(), answer));
    }
}

/// Clears the outstanding mark when the call's thread ends, however it ends (a panic included).
struct Release(Arc<Gate>);

impl Drop for Release {
    fn drop(&mut self) {
        *self
            .0
            .since
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        self.0.outstanding.store(false, Ordering::SeqCst);
    }
}

/// How one bus call ended.
enum Call<T> {
    /// It answered in time.
    Done(T),
    /// It panicked, could not be started or did not answer in time.
    Lost,
    /// Another call was outstanding for longer than the timeout (or the wait for a younger one
    /// ran out), so none was started.
    Busy,
}

/// Runs `call` on its own thread and waits at most `timeout` for its answer. `record` runs on that
/// thread with the answer, before the outstanding mark is cleared and before the answer is sent.
/// With another call outstanding: a young one is waited for (up to what is left of its timeout)
/// and then this one runs; an old one means no thread is started at all. Waiting callers poll, so
/// with three or more at once the one that gets the free flag is whoever swaps first, not the one
/// that waited longest: each is still bounded by the timeout, and a notice is rare, so this is left.
fn within<T: Send + 'static>(
    gate: &Arc<Gate>,
    timeout: Duration,
    record: impl FnOnce(&T) + Send + 'static,
    call: impl FnOnce() -> T + Send + 'static,
) -> Call<T> {
    let mut give_up: Option<Instant> = None;
    while gate.outstanding.swap(true, Ordering::SeqCst) {
        let until = match give_up {
            Some(until) => until,
            None => {
                // The call that is out has this long left before it counts as hung.
                // A winner that has swapped the flag but not yet published its start is a call that
                // began an instant ago: no start yet is an age of zero, never "old".
                let age = gate.age().unwrap_or(Duration::ZERO);
                if age >= timeout {
                    return Call::Busy;
                }
                let until = Instant::now() + (timeout - age);
                give_up = Some(until);
                until
            }
        };
        if Instant::now() >= until {
            return Call::Busy;
        }
        thread::sleep(Duration::from_millis(10));
    }
    *gate
        .since
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Instant::now());
    let release = Release(Arc::clone(gate));
    let (send, receive) = mpsc::channel();
    // The thread is left to finish on its own if the answer comes too late, and says so by
    // clearing the mark when it does.
    let spawned = thread::Builder::new()
        .name("mycarlos-notice-bus".into())
        .spawn(move || {
            let answer = call();
            // Written before the mark is cleared, so the writes are ordered, and cleared before the
            // answer is sent, so a caller that gets the answer and asks again at once is never
            // turned away as busy by the call it just finished.
            record(&answer);
            drop(release);
            let _ = send.send(answer);
        });
    if spawned.is_err() {
        // The closure (and its Release) was dropped with the failed spawn, which cleared the mark.
        return Call::Lost;
    }
    match receive.recv_timeout(timeout) {
        Ok(answer) => Call::Done(answer),
        Err(_) => Call::Lost,
    }
}

/// The notice runtime's backend for a Linux desktop.
pub(crate) struct LinuxBackend<B: Bus> {
    bus: Arc<B>,
    timeout: Duration,
    gate: Arc<Gate>,
}

impl<B: Bus> LinuxBackend<B> {
    /// A backend over `bus` with a gate of its own (the real one is made by `new`, which shares).
    #[cfg(test)]
    pub(crate) fn with_bus(bus: B) -> Self {
        Self::with_gate(bus, Arc::new(Gate::new(PERMISSION_TTL)))
    }

    fn with_gate(bus: B, gate: Arc<Gate>) -> Self {
        Self {
            bus: Arc::new(bus),
            timeout: CALL_TIMEOUT,
            gate,
        }
    }

    #[cfg(test)]
    fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    #[cfg(test)]
    fn with_permission_ttl(self, ttl: Duration) -> Self {
        Self {
            gate: Arc::new(Gate::new(ttl)),
            ..self
        }
    }
}

impl<B: Bus> Backend for LinuxBackend<B> {
    fn permission(&self) -> Permission {
        let remembered = *self
            .gate
            .permission
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((at, answer)) = remembered {
            if at.elapsed() < self.gate.ttl {
                return answer;
            }
        }
        let bus = Arc::clone(&self.bus);
        let started = Instant::now();
        let gate = Arc::clone(&self.gate);
        let recorded = move |present: &bool| {
            gate.remember(if *present {
                Permission::Allowed
            } else {
                Permission::Unavailable
            });
        };
        match within(&self.gate, self.timeout, recorded, move || {
            bus.service_present()
        }) {
            Call::Done(true) => Permission::Allowed,
            Call::Done(false) => Permission::Unavailable,
            // No answer in time: Unavailable, kept for the TTL so a hung bus costs one wait, not
            // one per poll. A late answer from the same call replaces it (the worker writes
            // after this), and one that already did is not overwritten by this.
            Call::Lost => {
                let mut kept = self
                    .gate
                    .permission
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                match *kept {
                    Some((at, answer)) if at > started => answer,
                    _ => {
                        *kept = Some((Instant::now(), Permission::Unavailable));
                        Permission::Unavailable
                    }
                }
            }
            // Another call is still outstanding (a hung daemon): that is not a new answer about
            // the bus, so the last one stands, however old, and nothing is remembered anew.
            Call::Busy => remembered.map_or(Permission::Unavailable, |(_, answer)| answer),
        }
    }

    fn accept(&self, body: &str, still_current: &dyn Fn() -> bool) -> Result<(), Error> {
        let notice = Notice::new(body).ok_or(Error::OsRejected)?;
        // Checked just before the call: a notice the person turned off meanwhile is not shown.
        if !still_current() {
            return Err(Error::Cancelled);
        }
        let bus = Arc::clone(&self.bus);
        match within(
            &self.gate,
            self.timeout,
            |_| {},
            move || bus.notify(&notice),
        ) {
            Call::Done(Ok(())) => Ok(()),
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
    /// The real backend. Every one made here shares one gate: the tray makes a new backend for
    /// each notice, and a hung daemon must still count as one outstanding call across them.
    pub(crate) fn new() -> Self {
        static SHARED: OnceLock<Arc<Gate>> = OnceLock::new();
        let gate = SHARED.get_or_init(|| Arc::new(Gate::new(PERMISSION_TTL)));
        Self::with_gate(Session, Arc::clone(gate))
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
        /// A healthy daemon that is a little slow to say it is there (100 ms), as a busy one is.
        Slow,
    }

    struct FakeBus {
        behaviour: Behaviour,
        sent: Arc<Mutex<Vec<Notice>>>,
        presence_asked: Arc<AtomicUsize>,
        notify_asked: Arc<AtomicUsize>,
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
                Behaviour::Slow => {
                    thread::sleep(Duration::from_millis(100));
                    true
                }
                Behaviour::Present | Behaviour::Refuses => true,
            }
        }
        fn notify(&self, notice: &Notice) -> Result<(), ()> {
            self.notify_asked.fetch_add(1, Ordering::SeqCst);
            match self.behaviour {
                Behaviour::Hangs => {
                    thread::sleep(Duration::from_secs(5));
                    Ok(())
                }
                Behaviour::Panics => panic!("FAKE: the bus fell over"),
                Behaviour::Absent | Behaviour::Refuses => Err(()),
                Behaviour::Present | Behaviour::Slow => {
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
            notify_asked: Arc::new(AtomicUsize::new(0)),
        })
        .with_timeout(Duration::from_millis(200));
        (backend, sent)
    }

    /// A backend over a bus whose question and notice counters the test keeps.
    fn counted(
        behaviour: Behaviour,
    ) -> (LinuxBackend<FakeBus>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let presence_asked = Arc::new(AtomicUsize::new(0));
        let notify_asked = Arc::new(AtomicUsize::new(0));
        let backend = LinuxBackend::with_bus(FakeBus {
            behaviour,
            sent: Arc::new(Mutex::new(Vec::new())),
            presence_asked: Arc::clone(&presence_asked),
            notify_asked: Arc::clone(&notify_asked),
        })
        .with_timeout(Duration::from_millis(200));
        (backend, presence_asked, notify_asked)
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

    #[test]
    fn the_permission_answer_is_remembered_for_its_ttl_and_asked_again_after_it() {
        let (backend, asked, _) = counted(Behaviour::Present);
        let backend = backend.with_permission_ttl(Duration::from_millis(150));
        for _ in 0..5 {
            assert_eq!(backend.permission(), Permission::Allowed);
        }
        assert_eq!(
            asked.load(Ordering::SeqCst),
            1,
            "five polls, one bus question"
        );
        thread::sleep(Duration::from_millis(250));
        assert_eq!(backend.permission(), Permission::Allowed);
        assert_eq!(
            asked.load(Ordering::SeqCst),
            2,
            "asked again once the answer is old"
        );
    }

    #[test]
    fn a_hung_bus_costs_one_wait_and_one_thread_not_one_per_poll_or_notice() {
        let (backend, asked, notified) = counted(Behaviour::Hangs);
        let started = Instant::now();
        // The first question waits its timeout and is Unavailable.
        assert_eq!(backend.permission(), Permission::Unavailable);
        let first = started.elapsed();
        assert!(first >= Duration::from_millis(150), "{first:?}");
        // The next polls are answered at once from memory, without another question.
        for _ in 0..5 {
            assert_eq!(backend.permission(), Permission::Unavailable);
        }
        // A notice while the call is still outstanding is turned away at once, with no new thread.
        let before_notice = Instant::now();
        assert!(matches!(
            backend.accept(SENTENCE, &|| true),
            Err(Error::OsRejected)
        ));
        assert!(
            before_notice.elapsed() < Duration::from_millis(100),
            "{:?}",
            before_notice.elapsed()
        );
        assert_eq!(asked.load(Ordering::SeqCst), 1);
        assert_eq!(notified.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn while_a_call_is_outstanding_the_last_permission_answer_stands() {
        let (backend, asked, _) = counted(Behaviour::Present);
        let backend = backend.with_permission_ttl(Duration::ZERO);
        assert_eq!(backend.permission(), Permission::Allowed);
        // Another call is out (as a hung daemon leaves it): no new question, the last answer.
        backend.gate.outstanding.store(true, Ordering::SeqCst);
        assert_eq!(backend.permission(), Permission::Allowed);
        assert_eq!(asked.load(Ordering::SeqCst), 1);
        // With no answer yet there is nothing to stand: Unavailable.
        let (fresh, _, _) = counted(Behaviour::Present);
        fresh.gate.outstanding.store(true, Ordering::SeqCst);
        assert_eq!(fresh.permission(), Permission::Unavailable);
    }

    #[test]
    fn the_outstanding_mark_ends_with_the_call_even_when_the_call_panics() {
        let (backend, _asked, _) = counted(Behaviour::Panics);
        assert_eq!(backend.permission(), Permission::Unavailable);
        assert!(!backend.gate.outstanding.load(Ordering::SeqCst));
        let (backend, sent) = backend_present_after_answer();
        assert!(backend.accept(SENTENCE, &|| true).is_ok());
        assert!(!backend.gate.outstanding.load(Ordering::SeqCst));
        assert_eq!(sent.lock().unwrap().len(), 1);
    }

    /// Permission, then a notice straight after: the first call's mark is gone by the time its
    /// answer is back, so the second is never turned away as busy.
    fn backend_present_after_answer() -> (LinuxBackend<FakeBus>, Arc<Mutex<Vec<Notice>>>) {
        let (backend, sent) = backend(Behaviour::Present);
        assert_eq!(backend.permission(), Permission::Allowed);
        (backend, sent)
    }

    #[test]
    fn a_call_that_ends_late_frees_the_bus_for_the_next() {
        // `Hangs` sleeps five seconds, far past any wait here; use a short own bus instead.
        struct Slow(Arc<AtomicUsize>);
        impl Bus for Slow {
            fn service_present(&self) -> bool {
                thread::sleep(Duration::from_millis(300));
                self.0.fetch_add(1, Ordering::SeqCst);
                true
            }
            fn notify(&self, _notice: &Notice) -> Result<(), ()> {
                Ok(())
            }
        }
        let done = Arc::new(AtomicUsize::new(0));
        let backend = LinuxBackend::with_bus(Slow(Arc::clone(&done)))
            .with_timeout(Duration::from_millis(50))
            .with_permission_ttl(Duration::ZERO);
        assert_eq!(backend.permission(), Permission::Unavailable, "timed out");
        assert!(backend.gate.outstanding.load(Ordering::SeqCst));
        let until = Instant::now() + Duration::from_secs(3);
        while backend.gate.outstanding.load(Ordering::SeqCst) {
            assert!(Instant::now() < until, "the late call never freed the bus");
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(done.load(Ordering::SeqCst), 1);
        assert!(backend.accept(SENTENCE, &|| true).is_ok());
    }

    #[test]
    fn a_notice_is_not_lost_because_a_permission_question_is_still_on_its_way() {
        // A settings screen polls the permission (a bus call) just as a document arrives: the
        // notice waits for that young call and is then shown, instead of being turned away.
        let (backend, sent) = backend(Behaviour::Slow);
        // The helper's 200 ms timeout is twice the 100 ms question: on a loaded CI runner (macOS, main
        // run 45875944268) a late wake-up of the poll's thread made it count as hung and the notice was
        // turned away. A long timeout keeps "a young call is waited for" and leaves the hung-call cases
        // (which use the helper's own short timeout) as they were.
        let backend = Arc::new(backend.with_timeout(Duration::from_secs(3)));
        let poll = {
            let backend = Arc::clone(&backend);
            thread::spawn(move || backend.permission())
        };
        // Wait until the poll's call is really out, instead of guessing how long its thread takes to start.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !backend.gate.outstanding.load(Ordering::SeqCst) {
            assert!(Instant::now() < deadline, "the poll never started its call");
            thread::sleep(Duration::from_millis(1));
        }
        let begun = Instant::now();
        assert!(
            backend.accept(SENTENCE, &|| true).is_ok(),
            "the notice was lost"
        );
        // It waited for the poll (up to about 100 ms) and then ran, well inside the timeout.
        assert!(
            begun.elapsed() >= Duration::from_millis(40),
            "{:?}",
            begun.elapsed()
        );
        assert!(
            begun.elapsed() < Duration::from_secs(1),
            "{:?}",
            begun.elapsed()
        );
        assert_eq!(poll.join().unwrap(), Permission::Allowed);
        assert_eq!(sent.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_late_answer_refreshes_the_remembered_permission() {
        struct Late(Arc<AtomicUsize>);
        impl Bus for Late {
            fn service_present(&self) -> bool {
                thread::sleep(Duration::from_millis(250));
                self.0.fetch_add(1, Ordering::SeqCst);
                true
            }
            fn notify(&self, _notice: &Notice) -> Result<(), ()> {
                Ok(())
            }
        }
        let asked = Arc::new(AtomicUsize::new(0));
        let backend = LinuxBackend::with_bus(Late(Arc::clone(&asked)))
            .with_timeout(Duration::from_millis(50));
        // No answer in time: Unavailable.
        assert_eq!(backend.permission(), Permission::Unavailable);
        // The call ends (the bus was only slow) and its answer replaces the remembered one, so the
        // next poll, inside the TTL, says Allowed without a new question.
        let until = Instant::now() + Duration::from_secs(3);
        while backend.gate.outstanding.load(Ordering::SeqCst) {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(backend.permission(), Permission::Allowed);
        assert_eq!(asked.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_call_that_has_begun_but_not_yet_published_its_start_is_waited_for_not_refused() {
        // The exact window: the flag is set, and the start time is not written yet.
        let (backend, _, _) = counted(Behaviour::Present);
        backend.gate.outstanding.store(true, Ordering::SeqCst);
        assert!(backend.gate.age().is_none());
        let gate = Arc::clone(&backend.gate);
        let finishing = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            gate.outstanding.store(false, Ordering::SeqCst);
        });
        let began = Instant::now();
        let outcome = within(&backend.gate, Duration::from_millis(200), |_| {}, || 7);
        assert!(
            matches!(outcome, Call::Done(7)),
            "refused as busy in the window"
        );
        assert!(
            began.elapsed() >= Duration::from_millis(40),
            "{:?}",
            began.elapsed()
        );
        finishing.join().unwrap();
    }
}

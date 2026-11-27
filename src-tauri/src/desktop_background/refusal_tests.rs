//! The parts of the background mode the controller's own tests do not reach (coverage batch 2):
//! work run on a thread of its own, the close-to-tray counters an unlock checks, what a phone
//! reports, and a program path that is not text. FAKE paths only.

use super::*;
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn work_runs_on_a_thread_of_its_own_with_the_name_it_was_given() {
    let (sender, receiver) = mpsc::channel();
    let caller = std::thread::current().id();
    run_off_thread("fake-lock", move || {
        let thread = std::thread::current();
        sender
            .send((thread.id(), thread.name().map(str::to_owned)))
            .unwrap();
    });
    let (id, name) = receiver
        .recv_timeout(Duration::from_secs(10))
        .expect("the work ran");
    assert_ne!(id, caller);
    assert_eq!(name.as_deref(), Some("fake-lock"));
}

#[test]
fn a_close_to_the_tray_is_counted_and_refuses_an_unlock_that_started_before_it() {
    // These counters are shared by the whole test process; this is the only test that moves them.
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
    let _guard = ONE_AT_A_TIME
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    shown_again();
    let started = close_locks();
    assert!(
        !unlock_refused(started),
        "nothing closed, the window is shown"
    );

    closed_to_tray();
    assert_eq!(close_locks(), started + 1);
    assert!(
        unlock_refused(started),
        "a close came while it was in flight"
    );

    // Brought back: an unlock that began before the close is still refused (the count differs),
    // but one that begins now stands.
    shown_again();
    assert!(unlock_refused(started));
    let later = close_locks();
    assert!(!unlock_refused(later));

    // Hidden in the tray, an unlock that began after the close is refused too.
    closed_to_tray();
    assert!(unlock_refused(close_locks()));
    shown_again();
    assert!(!unlock_refused(close_locks()));
}

#[test]
fn a_phone_reports_no_background_mode_at_all() {
    let status = Status::unsupported();
    assert!(
        !status.supported
            && !status.keep_running
            && !status.start_at_login
            && !status.tray_ready
            && !status.paused_while_locked
    );
}

#[cfg(unix)]
#[test]
fn a_program_path_that_is_not_text_is_never_written_into_a_login_entry() {
    use std::os::unix::ffi::OsStrExt;
    let not_text = Path::new(std::ffi::OsStr::from_bytes(b"/opt/my\xffcarlos"));
    assert!(!login_path_ok(not_text));
    // Asking for the entry on is refused before anything on disk or in the environment is read.
    assert!(matches!(
        set_login_item(true, not_text),
        Err(Error::LoginItem)
    ));
}

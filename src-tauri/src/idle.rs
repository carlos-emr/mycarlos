//! The native idle deadline: the backstop that locks the vault when nobody has
//! used it for the configured delay, even if the renderer has hung, crashed, or
//! been suspended before its own timer could ask for a lock.
//!
//! The renderer still hides content at the configured delay and asks for the
//! lock itself. This deadline fires the delay plus `MARGIN` (15 s) after the
//! last activity it hears of. The renderer reports input at most every 10
//! seconds, so this is at least 5 s after the renderer's own deadline, and the
//! 2-second native check only adds to that: the two never race while the
//! renderer works.
//!
//! Locking drops the keys; it cannot clear a hung renderer's screen, which
//! keeps its last frame until it recovers and runs its own lock.

use std::{
    ops::Add,
    sync::{Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant, SystemTime},
};

/// How long after the last activity the native deadline fires, beyond the delay.
pub const MARGIN: Duration = Duration::from_secs(15);
/// A picker the app opened counts as activity for at most this long, the
/// longest auto-lock delay, as it does in the renderer.
pub const GRACE: Duration = Duration::from_secs(60 * MAX_DELAY_MINUTES);
/// The longest automatic lock delay the renderer offers.
const MAX_DELAY_MINUTES: u64 = 15;
/// Until the renderer sends the chosen delay in a session, assume the longest
/// one it offers, so a lost update cannot make this deadline fire before the
/// renderer's and lock the vault under a user who is still reading.
const DEFAULT_DELAY: Duration = Duration::from_secs(60 * MAX_DELAY_MINUTES);

/// A moment on two clocks. `Instant` stops while macOS, iOS, Linux or Android
/// sleeps, so on its own it would not count a night with the lid closed as idle
/// time. The wall clock does, as the renderer's deadline does, but it can be
/// changed: set forward, it fires the deadline early (as it does the
/// renderer's); set back, the monotonic clock still fires it. The deadline is
/// due when either clock says so.
#[derive(Clone, Copy)]
pub struct Now {
    pub mono: Instant,
    pub wall: SystemTime,
}

/// Pairs a monotonic time with the wall clock read now. Production code only
/// converts `Instant::now()`; tests that pass other instants exercise the
/// monotonic clock, and build a `Now` themselves to exercise the wall clock.
impl From<Instant> for Now {
    fn from(mono: Instant) -> Self {
        Self {
            mono,
            wall: SystemTime::now(),
        }
    }
}

pub struct IdleDeadline(Mutex<State>);

struct State {
    /// Only an unlocked session has a deadline.
    armed: bool,
    delay: Duration,
    holds: usize,
    openings: usize,
    mono: Times<Instant>,
    wall: Times<SystemTime>,
}

/// The deadline's moments on one clock.
#[derive(Clone, Copy)]
struct Times<T> {
    last_activity: T,
    held_since: T,
}

impl IdleDeadline {
    pub fn new(now: impl Into<Now>) -> Self {
        let now = now.into();
        Self(Mutex::new(State {
            armed: false,
            delay: DEFAULT_DELAY,
            holds: 0,
            openings: 0,
            mono: Times::new(now.mono),
            wall: Times::new(now.wall),
        }))
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts the deadline for a session that has just been unlocked.
    pub fn arm(&self, now: impl Into<Now>) {
        let now = now.into();
        let mut state = self.state();
        state.armed = true;
        state.mono.last_activity = now.mono;
        state.wall.last_activity = now.wall;
    }

    /// A locked vault has nothing to lock. The next session starts from the
    /// default delay until the renderer sends its own.
    pub fn disarm(&self) {
        let mut state = self.state();
        state.armed = false;
        state.delay = DEFAULT_DELAY;
        // An opening still under way belongs to the session that ended.
        state.openings = 0;
    }

    /// Takes the renderer's delay (clamped to 1-15 minutes). The renderer
    /// restarts its own deadline when it sends one, so this is user activity.
    pub fn set_delay_minutes(&self, minutes: u64, now: impl Into<Now>) {
        let now = now.into();
        let mut state = self.state();
        state.delay = Duration::from_secs(60 * minutes.clamp(1, MAX_DELAY_MINUTES));
        state.mono.touch(now.mono);
        state.wall.touch(now.wall);
    }

    /// Records activity: a command, the renderer reporting user input, or a
    /// transfer making progress. A transfer counts for as long as it makes
    /// progress, however slowly; one that has stalled does not.
    pub fn touch(&self, now: impl Into<Now>) {
        let now = now.into();
        let mut state = self.state();
        state.mono.touch(now.mono);
        state.wall.touch(now.wall);
    }

    /// Starts opening the files chosen for a transfer. A provider may download
    /// a whole document before the open returns, with no progress to report,
    /// so the deadline is not due until the opening ends.
    fn opening_started(&self) {
        self.state().openings += 1;
    }

    fn opening_ended(&self, now: impl Into<Now>) {
        let now = now.into();
        let mut state = self.state();
        state.openings = state.openings.saturating_sub(1);
        state.mono.touch(now.mono);
        state.wall.touch(now.wall);
    }

    /// Starts a stretch that counts as activity until it ends, up to the grace:
    /// a picker the app opened.
    pub fn hold_started(&self, now: impl Into<Now>) {
        let now = now.into();
        let mut state = self.state();
        if state.holds == 0 {
            state.mono.held_since = now.mono;
            state.wall.held_since = now.wall;
        }
        state.holds += 1;
    }

    pub fn hold_ended(&self, now: impl Into<Now>) {
        let now = now.into();
        let mut state = self.state();
        let open = state.holds > 0;
        state.mono.hold_ended(now.mono, open);
        state.wall.hold_ended(now.wall, open);
        state.holds = state.holds.saturating_sub(1);
    }

    pub fn is_due(&self, now: impl Into<Now>) -> bool {
        let now = now.into();
        let state = self.state();
        let open = state.holds > 0;
        state.armed
            && state.openings == 0
            && (state.mono.is_due(now.mono, open, state.delay)
                || state.wall.is_due(now.wall, open, state.delay))
    }
}

/// Marks the opening of chosen files, from its start until it is dropped, on
/// every path.
pub struct Opening<'a>(&'a IdleDeadline);

impl<'a> Opening<'a> {
    pub fn new(idle: &'a IdleDeadline) -> Self {
        idle.opening_started();
        Self(idle)
    }
}

impl Drop for Opening<'_> {
    fn drop(&mut self) {
        self.0.opening_ended(Instant::now());
    }
}

impl<T: Copy + Ord + Add<Duration, Output = T>> Times<T> {
    fn new(now: T) -> Self {
        Self {
            last_activity: now,
            held_since: now,
        }
    }

    fn touch(&mut self, now: T) {
        self.last_activity = self.last_activity.max(now);
    }

    /// Until when an open hold has counted as activity: now, capped at the
    /// grace. With no hold open, it adds nothing.
    fn held_until(&self, now: T, open: bool) -> T {
        if open {
            now.min(self.held_since + GRACE)
        } else {
            self.last_activity
        }
    }

    fn hold_ended(&mut self, now: T, open: bool) {
        let active_until = self.held_until(now, open);
        self.touch(active_until);
    }

    fn is_due(&self, now: T, open: bool, delay: Duration) -> bool {
        let last = self.last_activity.max(self.held_until(now, open));
        now >= last + delay + MARGIN
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    // Armed with a five-minute delay, the renderer's default.
    fn armed(start: impl Into<Now> + Copy) -> IdleDeadline {
        let deadline = IdleDeadline::new(start);
        deadline.set_delay_minutes(5, start);
        deadline.arm(start);
        deadline
    }

    #[test]
    fn a_locked_session_is_never_due() {
        let start = Instant::now();
        let deadline = IdleDeadline::new(start);
        assert!(!deadline.is_due(start + 60 * MINUTE));
        deadline.arm(start);
        deadline.disarm();
        assert!(!deadline.is_due(start + 60 * MINUTE));
    }

    #[test]
    fn it_fires_the_margin_after_the_delay() {
        let start = Instant::now();
        let deadline = armed(start);
        assert!(!deadline.is_due(start + 5 * MINUTE));
        assert!(!deadline.is_due(start + 5 * MINUTE + MARGIN - Duration::from_millis(1)));
        assert!(deadline.is_due(start + 5 * MINUTE + MARGIN));
    }

    #[test]
    fn before_the_renderer_sends_a_delay_it_assumes_the_longest() {
        let start = Instant::now();
        let deadline = IdleDeadline::new(start);
        deadline.arm(start);
        assert!(!deadline.is_due(start + 15 * MINUTE));
        assert!(deadline.is_due(start + 15 * MINUTE + MARGIN));
    }

    #[test]
    fn activity_restarts_the_delay() {
        let start = Instant::now();
        let deadline = armed(start);
        deadline.touch(start + 4 * MINUTE);
        assert!(!deadline.is_due(start + 5 * MINUTE + MARGIN));
        assert!(deadline.is_due(start + 9 * MINUTE + MARGIN));
        // Arming again, as an unlock does, restarts it too.
        deadline.arm(start + 20 * MINUTE);
        assert!(!deadline.is_due(start + 21 * MINUTE));
    }

    #[test]
    fn activity_reported_late_never_moves_the_deadline_back() {
        let start = Instant::now();
        let deadline = armed(start);
        deadline.touch(start + 4 * MINUTE);
        deadline.touch(start + 2 * MINUTE);
        assert!(!deadline.is_due(start + 9 * MINUTE));
    }

    #[test]
    fn the_delay_follows_the_setting_clamped_to_one_to_fifteen_minutes() {
        let start = Instant::now();
        let deadline = armed(start);
        deadline.set_delay_minutes(1, start);
        assert!(!deadline.is_due(start + MINUTE));
        assert!(deadline.is_due(start + MINUTE + MARGIN));
        deadline.set_delay_minutes(0, start);
        assert!(!deadline.is_due(start + MINUTE));
        assert!(deadline.is_due(start + MINUTE + MARGIN));
        deadline.set_delay_minutes(15, start);
        assert!(!deadline.is_due(start + 15 * MINUTE));
        assert!(deadline.is_due(start + 15 * MINUTE + MARGIN));
        deadline.set_delay_minutes(60, start);
        assert!(deadline.is_due(start + 15 * MINUTE + MARGIN));
        // Sending a delay is activity.
        deadline.set_delay_minutes(1, start + 20 * MINUTE);
        assert!(!deadline.is_due(start + 21 * MINUTE));
        assert!(deadline.is_due(start + 21 * MINUTE + MARGIN));
    }

    #[test]
    fn sending_a_delay_is_activity_on_the_wall_clock_too() {
        let start = Instant::now();
        let wall = SystemTime::now();
        let deadline = armed(Now { mono: start, wall });
        // Sent after 20 minutes that passed only on the wall clock (asleep).
        deadline.set_delay_minutes(
            1,
            Now {
                mono: start,
                wall: wall + 20 * MINUTE,
            },
        );
        assert!(!deadline.is_due(Now {
            mono: start,
            wall: wall + 21 * MINUTE,
        }));
    }

    #[test]
    fn an_open_picker_counts_as_activity_for_at_most_the_grace() {
        let start = Instant::now();
        let deadline = armed(start);
        deadline.hold_started(start + MINUTE);
        assert!(!deadline.is_due(start + 14 * MINUTE));
        // After the grace, the ordinary delay runs from its end.
        let grace_end = start + MINUTE + GRACE;
        assert!(!deadline.is_due(grace_end + 5 * MINUTE));
        assert!(deadline.is_due(grace_end + 5 * MINUTE + MARGIN));
    }

    #[test]
    fn closing_a_picker_restarts_the_delay_only_within_the_grace() {
        let start = Instant::now();
        let deadline = armed(start);
        deadline.hold_started(start);
        deadline.hold_ended(start + 10 * MINUTE);
        assert!(!deadline.is_due(start + 15 * MINUTE));
        assert!(deadline.is_due(start + 15 * MINUTE + MARGIN));

        let deadline = armed(start);
        deadline.hold_started(start);
        // Left open for an hour: the time counts only up to the grace.
        deadline.hold_ended(start + 60 * MINUTE);
        assert!(deadline.is_due(start + 60 * MINUTE));
    }

    #[test]
    fn overlapping_pickers_count_from_the_first() {
        let start = Instant::now();
        let deadline = armed(start);
        deadline.hold_started(start);
        deadline.hold_started(start + 10 * MINUTE);
        deadline.hold_ended(start + 11 * MINUTE);
        // One is still open, from the start, until the grace ends.
        assert!(!deadline.is_due(start + 14 * MINUTE));
        assert!(!deadline.is_due(start + GRACE + 5 * MINUTE));
        assert!(deadline.is_due(start + GRACE + 5 * MINUTE + MARGIN));
    }

    #[test]
    fn time_asleep_counts_on_the_wall_clock() {
        let start = Instant::now();
        let wall = SystemTime::now();
        let deadline = armed(Now { mono: start, wall });
        // A night asleep: the monotonic clock barely moved.
        let woke = Now {
            mono: start + MINUTE,
            wall: wall + 8 * 60 * MINUTE,
        };
        assert!(deadline.is_due(woke));
        // An open picker's grace is counted the same way.
        let deadline = armed(Now { mono: start, wall });
        deadline.hold_started(Now { mono: start, wall });
        assert!(deadline.is_due(woke));
    }

    #[test]
    fn a_wall_clock_set_back_does_not_hold_off_the_deadline() {
        let start = Instant::now();
        let wall = SystemTime::now();
        let deadline = armed(Now { mono: start, wall });
        // The monotonic clock still fires it.
        assert!(deadline.is_due(Now {
            mono: start + 5 * MINUTE + MARGIN,
            wall: wall - 60 * MINUTE,
        }));
    }

    #[test]
    fn activity_holds_off_the_deadline_on_both_clocks() {
        let start = Instant::now();
        let wall = SystemTime::now();
        let deadline = armed(Now { mono: start, wall });
        let at = |minutes: u32| Now {
            mono: start + minutes * MINUTE,
            wall: wall + minutes * MINUTE,
        };
        deadline.touch(at(4));
        assert!(!deadline.is_due(at(9)));
        deadline.hold_started(at(9));
        assert!(!deadline.is_due(at(20)));
        deadline.hold_ended(at(20));
        assert!(!deadline.is_due(at(25)));
        assert!(deadline.is_due(Now {
            mono: start + 25 * MINUTE + MARGIN,
            wall: wall + 25 * MINUTE + MARGIN,
        }));
        // Arming again, as an unlock does, restarts it on both clocks.
        deadline.arm(at(60));
        assert!(!deadline.is_due(at(61)));
    }

    #[test]
    fn a_transfer_that_keeps_making_progress_is_never_cut_off() {
        let start = Instant::now();
        let deadline = armed(start);
        // Progress every four minutes for hours, as on a slow connection.
        for minutes in (4..=240).step_by(4) {
            deadline.touch(start + minutes * MINUTE);
            assert!(!deadline.is_due(start + (minutes + 4) * MINUTE));
        }
        // Once it stalls, the delay runs from its last progress.
        assert!(deadline.is_due(start + 245 * MINUTE + MARGIN));
    }

    #[test]
    fn opening_restarts_the_delay_on_both_clocks_and_its_guard_releases_it() {
        let start = Instant::now();
        let wall = SystemTime::now();
        let deadline = armed(Now { mono: start, wall });
        let at = |minutes: u32| Now {
            mono: start + minutes * MINUTE,
            wall: wall + minutes * MINUTE,
        };
        // A download that takes an hour: the delay runs from its end on
        // either clock.
        deadline.opening_started();
        deadline.opening_ended(at(60));
        assert!(!deadline.is_due(at(64)));
        assert!(deadline.is_due(Now {
            mono: start + 65 * MINUTE + MARGIN,
            wall: wall + 65 * MINUTE + MARGIN,
        }));

        // Dropping the guard ends the opening, so a stall after it locks.
        let deadline = armed(Instant::now());
        drop(Opening::new(&deadline));
        assert!(deadline.is_due(Instant::now() + 5 * MINUTE + MARGIN));
    }

    #[test]
    fn an_opening_left_over_from_a_locked_session_does_not_hold_the_next() {
        let start = Instant::now();
        let deadline = armed(start);
        deadline.opening_started();
        deadline.disarm();
        deadline.set_delay_minutes(5, start);
        deadline.arm(start);
        assert!(deadline.is_due(start + 5 * MINUTE + MARGIN));
        // Its guard ending later does not underflow.
        deadline.opening_ended(start);
        assert!(deadline.is_due(start + 5 * MINUTE + MARGIN));
    }

    #[test]
    fn opening_chosen_files_is_never_cut_off_and_restarts_the_delay() {
        let start = Instant::now();
        let deadline = armed(start);
        deadline.opening_started();
        assert!(!deadline.is_due(start + 24 * 60 * MINUTE));
        // Opened at minute 10, so the delay runs from there.
        deadline.opening_ended(start + 10 * MINUTE);
        assert!(!deadline.is_due(start + 15 * MINUTE));
        assert!(deadline.is_due(start + 15 * MINUTE + MARGIN));
        // The guard does the same on every path.
        {
            let _opening = Opening::new(&deadline);
            assert!(!deadline.is_due(start + 24 * 60 * MINUTE));
        }
        assert!(!deadline.is_due(Instant::now() + 5 * MINUTE));
    }

    #[test]
    fn locking_returns_to_the_default_delay() {
        let start = Instant::now();
        let deadline = armed(start);
        deadline.disarm();
        deadline.arm(start);
        assert!(!deadline.is_due(start + 15 * MINUTE));
        assert!(deadline.is_due(start + 15 * MINUTE + MARGIN));
    }
}

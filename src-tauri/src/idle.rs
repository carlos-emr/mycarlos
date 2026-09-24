//! The native idle deadline: the backstop that locks the vault when nobody has
//! used it for the configured delay, even if the renderer has hung, crashed, or
//! been suspended before its own timer could ask for a lock.
//!
//! The renderer still hides content at the configured delay and asks for the
//! lock itself. This deadline fires `MARGIN` later, which covers how often the
//! renderer reports activity, so the two never race while the renderer works.

use std::{
    ops::Add,
    sync::{Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant, SystemTime},
};

/// How much later than the renderer the native deadline fires.
pub const MARGIN: Duration = Duration::from_secs(15);
/// Time in a picker the app opened counts as activity for at most this long,
/// the longest auto-lock delay, as it does in the renderer.
pub const PICKER_GRACE: Duration = Duration::from_secs(15 * 60);
/// Until the renderer sends the chosen delay, assume the longest one it offers,
/// so that a lost update can never make this deadline fire before the
/// renderer's and lock the vault under a user who is still reading.
const DEFAULT_DELAY: Duration = Duration::from_secs(15 * 60);

/// A moment on two clocks. `Instant` stops while macOS, iOS or Linux sleeps, so
/// on its own it would not count a night with the lid closed as idle time. The
/// wall clock does, as the renderer's deadline does, but it can be set back.
/// The deadline is due when either clock says so.
#[derive(Clone, Copy)]
pub struct Now {
    pub mono: Instant,
    pub wall: SystemTime,
}

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
    pickers_open: usize,
    mono: Times<Instant>,
    wall: Times<SystemTime>,
}

/// The deadline's moments on one clock.
#[derive(Clone, Copy)]
struct Times<T> {
    last_activity: T,
    picker_since: T,
}

impl IdleDeadline {
    pub fn new(now: impl Into<Now>) -> Self {
        let now = now.into();
        Self(Mutex::new(State {
            armed: false,
            delay: DEFAULT_DELAY,
            pickers_open: 0,
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

    /// A locked vault has nothing to lock.
    pub fn disarm(&self) {
        self.state().armed = false;
    }

    pub fn set_delay_minutes(&self, minutes: u64) {
        self.state().delay = Duration::from_secs(60 * minutes.clamp(1, 15));
    }

    /// Records activity: a command, the renderer reporting user input, or a
    /// transfer making progress.
    pub fn touch(&self, now: impl Into<Now>) {
        let now = now.into();
        let mut state = self.state();
        state.mono.touch(now.mono);
        state.wall.touch(now.wall);
    }

    /// Starts a stretch that counts as activity until it ends, up to the grace:
    /// a picker, or opening the files chosen in one.
    pub fn picker_opened(&self, now: impl Into<Now>) {
        let now = now.into();
        let mut state = self.state();
        if state.pickers_open == 0 {
            state.mono.picker_since = now.mono;
            state.wall.picker_since = now.wall;
        }
        state.pickers_open += 1;
    }

    pub fn picker_closed(&self, now: impl Into<Now>) {
        let now = now.into();
        let mut state = self.state();
        let open = state.pickers_open > 0;
        state.mono.picker_closed(now.mono, open);
        state.wall.picker_closed(now.wall, open);
        state.pickers_open = state.pickers_open.saturating_sub(1);
    }

    pub fn is_due(&self, now: impl Into<Now>) -> bool {
        let now = now.into();
        let state = self.state();
        let open = state.pickers_open > 0;
        state.armed
            && (state.mono.is_due(now.mono, open, state.delay)
                || state.wall.is_due(now.wall, open, state.delay))
    }
}

impl<T: Copy + Ord + Add<Duration, Output = T>> Times<T> {
    fn new(now: T) -> Self {
        Self {
            last_activity: now,
            picker_since: now,
        }
    }

    fn touch(&mut self, now: T) {
        self.last_activity = self.last_activity.max(now);
    }

    /// Until when an open picker has counted as activity: now, capped at the
    /// grace. With no picker open, it adds nothing.
    fn picker_active_until(&self, now: T, open: bool) -> T {
        if open {
            now.min(self.picker_since + PICKER_GRACE)
        } else {
            self.last_activity
        }
    }

    fn picker_closed(&mut self, now: T, open: bool) {
        let active_until = self.picker_active_until(now, open);
        self.touch(active_until);
    }

    fn is_due(&self, now: T, open: bool, delay: Duration) -> bool {
        let last = self.last_activity.max(self.picker_active_until(now, open));
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
        deadline.set_delay_minutes(5);
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
        deadline.set_delay_minutes(1);
        assert!(!deadline.is_due(start + MINUTE));
        assert!(deadline.is_due(start + MINUTE + MARGIN));
        deadline.set_delay_minutes(0);
        assert!(deadline.is_due(start + MINUTE + MARGIN));
        deadline.set_delay_minutes(15);
        assert!(!deadline.is_due(start + 15 * MINUTE));
        assert!(deadline.is_due(start + 15 * MINUTE + MARGIN));
        deadline.set_delay_minutes(60);
        assert!(deadline.is_due(start + 15 * MINUTE + MARGIN));
    }

    #[test]
    fn an_open_picker_counts_as_activity_for_at_most_the_grace() {
        let start = Instant::now();
        let deadline = armed(start);
        deadline.picker_opened(start + MINUTE);
        assert!(!deadline.is_due(start + 14 * MINUTE));
        // After the grace, the ordinary delay runs from its end.
        let grace_end = start + MINUTE + PICKER_GRACE;
        assert!(!deadline.is_due(grace_end + 5 * MINUTE));
        assert!(deadline.is_due(grace_end + 5 * MINUTE + MARGIN));
    }

    #[test]
    fn closing_a_picker_restarts_the_delay_only_within_the_grace() {
        let start = Instant::now();
        let deadline = armed(start);
        deadline.picker_opened(start);
        deadline.picker_closed(start + 10 * MINUTE);
        assert!(!deadline.is_due(start + 15 * MINUTE));
        assert!(deadline.is_due(start + 15 * MINUTE + MARGIN));

        let deadline = armed(start);
        deadline.picker_opened(start);
        // Left open for an hour: the time counts only up to the grace.
        deadline.picker_closed(start + 60 * MINUTE);
        assert!(deadline.is_due(start + 60 * MINUTE));
    }

    #[test]
    fn overlapping_pickers_count_from_the_first() {
        let start = Instant::now();
        let deadline = armed(start);
        deadline.picker_opened(start);
        deadline.picker_opened(start + 10 * MINUTE);
        deadline.picker_closed(start + 11 * MINUTE);
        // One is still open, from the start.
        assert!(!deadline.is_due(start + 14 * MINUTE));
        assert!(deadline.is_due(start + PICKER_GRACE + 5 * MINUTE + MARGIN));
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
        deadline.picker_opened(Now { mono: start, wall });
        assert!(deadline.is_due(woke));
    }

    #[test]
    fn a_wall_clock_set_back_does_not_hold_off_the_deadline() {
        let start = Instant::now();
        let wall = SystemTime::now();
        let deadline = armed(Now { mono: start, wall });
        let later = Now {
            mono: start + 5 * MINUTE + MARGIN,
            wall: wall - 60 * MINUTE,
        };
        deadline.touch(Now {
            mono: start,
            wall: later.wall,
        });
        assert!(deadline.is_due(later));
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
        deadline.picker_opened(at(9));
        assert!(!deadline.is_due(at(20)));
        deadline.picker_closed(at(20));
        assert!(!deadline.is_due(at(25)));
        assert!(deadline.is_due(Now {
            mono: start + 25 * MINUTE + MARGIN,
            wall: wall + 25 * MINUTE + MARGIN,
        }));
    }
}

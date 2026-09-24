//! The native idle deadline: the backstop that locks the vault when nobody has
//! used it for the configured delay, even if the renderer has hung, crashed, or
//! been suspended before its own timer could ask for a lock.
//!
//! The renderer still hides content at the configured delay and asks for the
//! lock itself. This deadline fires `MARGIN` later, which covers how often the
//! renderer reports activity, so the two never race while the renderer works.

use std::{
    sync::{Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

/// How much later than the renderer the native deadline fires.
pub const MARGIN: Duration = Duration::from_secs(15);
/// Time in a picker the app opened counts as activity for at most this long,
/// the longest auto-lock delay, as it does in the renderer.
pub const PICKER_GRACE: Duration = Duration::from_secs(15 * 60);
const DEFAULT_DELAY: Duration = Duration::from_secs(5 * 60);

pub struct IdleDeadline(Mutex<State>);

struct State {
    /// Only an unlocked session has a deadline.
    armed: bool,
    delay: Duration,
    last_activity: Instant,
    pickers_open: usize,
    picker_since: Instant,
}

impl IdleDeadline {
    pub fn new(now: Instant) -> Self {
        Self(Mutex::new(State {
            armed: false,
            delay: DEFAULT_DELAY,
            last_activity: now,
            pickers_open: 0,
            picker_since: now,
        }))
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts the deadline for a session that has just been unlocked.
    pub fn arm(&self, now: Instant) {
        let mut state = self.state();
        state.armed = true;
        state.last_activity = now;
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
    pub fn touch(&self, now: Instant) {
        let mut state = self.state();
        state.last_activity = state.last_activity.max(now);
    }

    pub fn picker_opened(&self, now: Instant) {
        let mut state = self.state();
        if state.pickers_open == 0 {
            state.picker_since = now;
        }
        state.pickers_open += 1;
    }

    pub fn picker_closed(&self, now: Instant) {
        let mut state = self.state();
        let active_until = state.picker_active_until(now);
        state.pickers_open = state.pickers_open.saturating_sub(1);
        state.last_activity = state.last_activity.max(active_until);
    }

    pub fn is_due(&self, now: Instant) -> bool {
        let state = self.state();
        let last = state.last_activity.max(state.picker_active_until(now));
        state.armed && now >= last + state.delay + MARGIN
    }
}

impl State {
    /// Until when an open picker has counted as activity: now, capped at the
    /// grace. With no picker open, it adds nothing.
    fn picker_active_until(&self, now: Instant) -> Instant {
        if self.pickers_open == 0 {
            self.last_activity
        } else {
            now.min(self.picker_since + PICKER_GRACE)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    fn armed(start: Instant) -> IdleDeadline {
        let deadline = IdleDeadline::new(start);
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
    fn it_fires_the_margin_after_the_default_five_minutes() {
        let start = Instant::now();
        let deadline = armed(start);
        assert!(!deadline.is_due(start + 5 * MINUTE));
        assert!(!deadline.is_due(start + 5 * MINUTE + MARGIN - Duration::from_millis(1)));
        assert!(deadline.is_due(start + 5 * MINUTE + MARGIN));
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
}

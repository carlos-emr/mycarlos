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
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant, SystemTime},
};

/// How long after the last activity the native deadline fires, beyond the delay.
pub const MARGIN: Duration = Duration::from_secs(15);
/// A hold (a picker the app opened, or opening what was chosen in one)
/// counts as activity for at most this long, the longest auto-lock delay, as
/// a picker does in the renderer. While a transfer command runs, only the
/// user's own input counts past this long after the first running transfer
/// began, so a source that trickles forever, or a transfer in several steps,
/// cannot keep the vault open.
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
    transfers: usize,
    mono: Times<Instant>,
    wall: Times<SystemTime>,
}

/// The deadline's moments on one clock.
#[derive(Clone, Copy)]
struct Times<T> {
    last_activity: T,
    held_since: T,
    transfer_since: T,
}

impl IdleDeadline {
    pub fn new(now: impl Into<Now>) -> Self {
        let now = now.into();
        Self(Mutex::new(State {
            armed: false,
            delay: DEFAULT_DELAY,
            holds: 0,
            transfers: 0,
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

    /// Records the user's own input, reported by the renderer. It counts in
    /// full, even during a transfer: someone is there.
    pub fn user_input(&self, now: impl Into<Now>) {
        let now = now.into();
        let mut state = self.state();
        state.mono.touch(now.mono);
        state.wall.touch(now.wall);
    }

    /// Records the app's own activity: a command, or a transfer making
    /// progress. During a transfer it counts only up to the grace after the
    /// transfer began.
    pub fn touch(&self, now: impl Into<Now>) {
        let now = now.into();
        let mut state = self.state();
        let transferring = state.transfers > 0;
        state.mono.touch_limited(now.mono, transferring);
        state.wall.touch_limited(now.wall, transferring);
    }

    /// Starts a transfer command. Everything the app does until the last
    /// running transfer ends shares one grace, from when the first began.
    pub fn transfer_started(&self, now: impl Into<Now>) {
        let now = now.into();
        let mut state = self.state();
        if state.transfers == 0 {
            state.mono.transfer_since = now.mono;
            state.wall.transfer_since = now.wall;
        }
        state.transfers += 1;
    }

    pub fn transfer_ended(&self) {
        let mut state = self.state();
        state.transfers = state.transfers.saturating_sub(1);
    }

    /// Starts a stretch that counts as activity until it ends, up to the grace:
    /// a picker, or opening what was chosen in one.
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
        let transferring = state.transfers > 0;
        state.mono.hold_ended(now.mono, open, transferring);
        state.wall.hold_ended(now.wall, open, transferring);
        state.holds = state.holds.saturating_sub(1);
    }

    pub fn is_due(&self, now: impl Into<Now>) -> bool {
        let now = now.into();
        let state = self.state();
        let open = state.holds > 0;
        let transferring = state.transfers > 0;
        state.armed
            && (state.mono.is_due(now.mono, open, transferring, state.delay)
                || state.wall.is_due(now.wall, open, transferring, state.delay))
    }
}

/// Marks a transfer command (an import, or an export in one or two passes)
/// from its start until it is dropped, on every path.
pub struct Transfer(Arc<IdleDeadline>);

impl Transfer {
    pub fn new(idle: &Arc<IdleDeadline>) -> Self {
        idle.transfer_started(Instant::now());
        Self(Arc::clone(idle))
    }
}

impl Drop for Transfer {
    fn drop(&mut self) {
        self.0.transfer_ended();
    }
}

impl<T: Copy + Ord + Add<Duration, Output = T>> Times<T> {
    fn new(now: T) -> Self {
        Self {
            last_activity: now,
            held_since: now,
            transfer_since: now,
        }
    }

    fn touch(&mut self, now: T) {
        self.last_activity = self.last_activity.max(now);
    }

    /// During a transfer, the app's own activity counts only up to the grace
    /// after the transfer began.
    fn limit(&self, at: T, transferring: bool) -> T {
        if transferring {
            at.min(self.transfer_since + GRACE)
        } else {
            at
        }
    }

    fn touch_limited(&mut self, now: T, transferring: bool) {
        self.touch(self.limit(now, transferring));
    }

    /// Until when an open hold has counted as activity: now, capped at the
    /// grace. With no hold open, it adds nothing.
    fn held_until(&self, now: T, open: bool, transferring: bool) -> T {
        if open {
            self.limit(now.min(self.held_since + GRACE), transferring)
        } else {
            self.last_activity
        }
    }

    fn hold_ended(&mut self, now: T, open: bool, transferring: bool) {
        let active_until = self.held_until(now, open, transferring);
        self.touch(active_until);
    }

    fn is_due(&self, now: T, open: bool, transferring: bool, delay: Duration) -> bool {
        let last = self
            .last_activity
            .max(self.held_until(now, open, transferring));
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
    fn during_a_transfer_only_user_input_counts_past_the_grace_from_its_start() {
        let start = Instant::now();
        let wall = SystemTime::now();
        let at = |minutes: u32| Now {
            mono: start + minutes * MINUTE,
            wall: wall + minutes * MINUTE,
        };
        let deadline = armed(at(0));
        deadline.transfer_started(at(1));
        deadline.touch(at(10));
        assert!(!deadline.is_due(at(14)));
        // Another transfer overlapping it does not start the grace again.
        deadline.transfer_started(at(10));
        deadline.transfer_ended();
        // Its progress, its commands, and a hold it opens stop counting at
        // minute 16, the grace after it began.
        deadline.touch(at(40));
        deadline.hold_started(at(12));
        assert!(!deadline.is_due(at(21)));
        assert!(deadline.is_due(Now {
            mono: start + 21 * MINUTE + MARGIN,
            wall: wall + 21 * MINUTE + MARGIN,
        }));
        deadline.hold_ended(at(40));
        assert!(deadline.is_due(at(41)));
        // The user's own input still counts in full.
        deadline.user_input(at(40));
        assert!(!deadline.is_due(at(44)));
        // Once it has ended, the app's activity counts in full again.
        deadline.transfer_ended();
        deadline.touch(at(60));
        assert!(!deadline.is_due(at(64)));

        // On either clock.
        let past_the_grace = MINUTE + GRACE + 5 * MINUTE + MARGIN;
        for (mono, wall_minutes) in [(40, 1), (1, 40)] {
            let deadline = armed(at(0));
            deadline.transfer_started(at(1));
            deadline.touch(Now {
                mono: start + mono * MINUTE,
                wall: wall + wall_minutes * MINUTE,
            });
            let later = |minutes: u32, extra: Duration| start + minutes * MINUTE + extra;
            assert!(deadline.is_due(if mono == 40 {
                Now {
                    mono: later(0, past_the_grace),
                    wall: wall + MINUTE,
                }
            } else {
                Now {
                    mono: later(1, Duration::ZERO),
                    wall: wall + past_the_grace,
                }
            }));
        }
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

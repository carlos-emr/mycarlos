//! Cooperative controls for explicitly consented collection while unlocked.
//! These are local iteration limits, never Portal cursors or authorization.
use std::{
    io::{self, Read},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

pub(crate) const INTERVAL: Duration = Duration::from_secs(120);
pub(crate) const CYCLE_TIME: Duration = Duration::from_secs(30);
pub(crate) const METADATA_TIME: Duration = Duration::from_secs(5);
pub(crate) const BODY_TIME: Duration = Duration::from_secs(15);
pub(crate) const MAX_REQUESTS: usize = 8;
pub(crate) const MAX_LINKS: usize = 4;
pub(crate) const MAX_PAGES: usize = 2;
pub(crate) const MAX_DOWNLOAD: usize = 20 * 1024 * 1024;
pub(crate) const MAX_PHYSICAL_READ: usize = 40 * 1024 * 1024;
pub(crate) const MAX_CANDIDATES: usize = 64;
pub(crate) const MAX_RAW_ENTRIES: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum StopReason {
    User = 1,
    Session = 2,
    Deadline = 3,
    Budget = 4,
}

/// A fresh token belongs to one cycle. Nothing ever clears a cancelled token.
pub(crate) struct CycleControl {
    deadline: Instant,
    /// MAX_PHYSICAL_READ, except in tests that shrink it to keep their fixtures small.
    physical_cap: usize,
    cancelled: Arc<AtomicBool>,
    reason: AtomicU8,
    requests: AtomicUsize,
    links: AtomicUsize,
    pages: AtomicUsize,
    downloads: AtomicUsize,
    physical: AtomicUsize,
    candidates: AtomicUsize,
    raw_entries: AtomicUsize,
    session: Option<(Arc<AtomicU64>, u64)>,
}

impl CycleControl {
    #[cfg(test)]
    pub(crate) fn test_counts(&self) -> (usize, usize, usize) {
        (
            self.raw_entries.load(Ordering::Acquire),
            self.candidates.load(Ordering::Acquire),
            self.physical.load(Ordering::Acquire),
        )
    }

    #[cfg(test)]
    pub(crate) fn with_physical_remaining(remaining: usize) -> Self {
        assert!(remaining <= MAX_PHYSICAL_READ);
        let value = Self::new(Instant::now(), Arc::new(AtomicBool::new(false)));
        value
            .physical
            .store(MAX_PHYSICAL_READ - remaining, Ordering::Release);
        value
    }

    /// Moves the cycle's deadline, for tests of the byte budget rather than the clock.
    #[cfg(test)]
    pub(crate) fn with_test_deadline(mut self, deadline: Instant) -> Self {
        self.deadline = deadline;
        self
    }

    /// A smaller physical-read budget, so budget tests need megabytes of fixture, not 40 MiB.
    #[cfg(test)]
    pub(crate) fn with_test_physical_cap(mut self, cap: usize) -> Self {
        assert!(cap <= MAX_PHYSICAL_READ);
        self.physical_cap = cap;
        self
    }

    pub(crate) fn new(now: Instant, cancelled: Arc<AtomicBool>) -> Self {
        Self {
            deadline: now + CYCLE_TIME,
            physical_cap: MAX_PHYSICAL_READ,
            cancelled,
            reason: AtomicU8::new(0),
            requests: AtomicUsize::new(0),
            links: AtomicUsize::new(0),
            pages: AtomicUsize::new(0),
            downloads: AtomicUsize::new(0),
            physical: AtomicUsize::new(0),
            candidates: AtomicUsize::new(0),
            raw_entries: AtomicUsize::new(0),
            session: None,
        }
    }

    pub(crate) fn with_session(mut self, ticket: Arc<AtomicU64>, expected: u64) -> Self {
        self.session = Some((ticket, expected));
        self
    }

    fn stop(&self, reason: StopReason) {
        // The first cause wins; reading cancellation never takes a ledger lock.
        let _ = self
            .reason
            .compare_exchange(0, reason as u8, Ordering::AcqRel, Ordering::Acquire);
    }

    pub(crate) fn stopped(&self) -> bool {
        self.stopped_at(Instant::now())
    }

    fn stopped_at(&self, now: Instant) -> bool {
        if self
            .session
            .as_ref()
            .is_some_and(|(ticket, expected)| ticket.load(Ordering::Acquire) != *expected)
        {
            self.stop(StopReason::Session);
        }
        if self.cancelled.load(Ordering::Acquire) {
            self.stop(StopReason::User);
        }
        if now >= self.deadline {
            self.stop(StopReason::Deadline);
        }
        self.reason.load(Ordering::Acquire) != 0
    }

    pub(crate) fn session_changed(&self) {
        self.stop(StopReason::Session);
    }

    pub(crate) fn reason(&self) -> Option<StopReason> {
        match self.reason.load(Ordering::Acquire) {
            1 => Some(StopReason::User),
            2 => Some(StopReason::Session),
            3 => Some(StopReason::Deadline),
            4 => Some(StopReason::Budget),
            _ => None,
        }
    }

    fn take(&self, used: &AtomicUsize, cap: usize, amount: usize) -> bool {
        if self.stopped() {
            return false;
        }
        if used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |old| {
                old.checked_add(amount).filter(|new| *new <= cap)
            })
            .is_err()
        {
            self.stop(StopReason::Budget);
            return false;
        }
        true
    }

    pub(crate) fn request(&self) -> bool {
        self.take(&self.requests, MAX_REQUESTS, 1)
    }
    pub(crate) fn visit_link(&self) -> bool {
        self.take(&self.links, MAX_LINKS, 1)
    }
    pub(crate) fn admit_page(&self) -> bool {
        self.take(&self.pages, MAX_PAGES, 1)
    }
    // Reaching a metadata scan allowance ends that scan, not already verified
    // receipt settlement. Poisoning the whole cycle here would starve receipts.
    fn scan_take(&self, used: &AtomicUsize, cap: usize) -> bool {
        !self.stopped()
            && used
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                    n.checked_add(1).filter(|v| *v <= cap)
                })
                .is_ok()
    }
    pub(crate) fn candidate(&self) -> bool {
        self.scan_take(&self.candidates, MAX_CANDIDATES)
    }
    pub(crate) fn inspect_raw(&self) -> bool {
        self.scan_take(&self.raw_entries, MAX_RAW_ENTRIES)
    }
    pub(crate) fn download(&self, bytes: usize) -> bool {
        self.take(&self.downloads, MAX_DOWNLOAD, bytes)
    }

    /// Admission only, before chunk allocation. Actual File reads charge once.
    pub(crate) fn physical_read_bytes(&self) -> usize {
        self.physical.load(Ordering::Acquire)
    }

    pub(crate) fn chunk_fits(&self, bytes: usize) -> bool {
        if self.stopped() {
            return false;
        }
        if bytes
            > self
                .physical_cap
                .saturating_sub(self.physical.load(Ordering::Acquire))
        {
            self.stop(StopReason::Budget);
            return false;
        }
        true
    }
}

/// Must sit immediately around File on the controlled path: NO BufReader
/// between this wrapper and File. read_exact calls this boundary each iteration.
pub(crate) struct PhysicalRead<'a, R> {
    source: R,
    control: &'a CycleControl,
}

impl<'a, R: Read> PhysicalRead<'a, R> {
    pub(crate) fn new(source: R, control: &'a CycleControl) -> Self {
        Self { source, control }
    }
}

impl<R: Read> Read for PhysicalRead<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if !self.control.take(
            &self.control.physical,
            self.control.physical_cap,
            buffer.len(),
        ) {
            // read_exact retries Interrupted forever. A stopped cycle must return a
            // terminal I/O error; caller maps control.reason() before corruption.
            return Err(io::Error::other("collection stopped"));
        }
        let result = self.source.read(buffer);
        let actual = result.as_ref().copied().unwrap_or(0);
        self.control
            .physical
            .fetch_sub(buffer.len() - actual, Ordering::AcqRel);
        result
    }
}

/// Caller indexes records directly with the returned position. No UUID search,
/// prefix iterator, clone or filtering may precede this charged boundary.
#[derive(Default, Debug)]
pub(crate) struct ScanCursor {
    next: usize,
}

impl ScanCursor {
    pub(crate) fn window(&mut self, len: usize) -> ScanWindow<'_> {
        self.next = if len == 0 { 0 } else { self.next % len };
        ScanWindow {
            cursor: self,
            len,
            remaining: len,
        }
    }
}

pub(crate) struct ScanWindow<'a> {
    cursor: &'a mut ScanCursor,
    len: usize,
    remaining: usize,
}

impl ScanWindow<'_> {
    pub(crate) fn defer(&mut self, index: usize) {
        self.cursor.next = index;
    }

    pub(crate) fn next(&mut self, control: &CycleControl) -> Option<usize> {
        if self.remaining == 0 || !control.inspect_raw() {
            return None;
        }
        let index = self.cursor.next;
        self.cursor.next = (index + 1) % self.len;
        self.remaining -= 1;
        Some(index)
    }
}

/// Scheduling policy independent of any worker/timer. Root must separately
/// release timer enablement after source and measured cancellation validation.
pub(crate) struct Schedule {
    due: Instant,
}

/// Cancellation/scheduling locks are held only for small in-memory operations,
/// never while collecting, persisting preferences or calling a vault/OS API.
pub(crate) struct Controller {
    schedule: Mutex<Schedule>,
    active: Mutex<Option<Arc<AtomicBool>>>,
    epoch: AtomicUsize,
    cache_epoch: AtomicUsize,
    // Low bit permits activation; remaining bits invalidate stale preference completions.
    eligibility: AtomicUsize,
    shutdown: AtomicBool,
    paused: AtomicBool,
}

impl Controller {
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            schedule: Mutex::new(Schedule::new(now)),
            active: Mutex::new(None),
            epoch: AtomicUsize::new(0),
            cache_epoch: AtomicUsize::new(0),
            eligibility: AtomicUsize::new(0),
            shutdown: AtomicBool::new(false),
            paused: AtomicBool::new(false),
        }
    }

    pub(crate) fn paused(&self) -> bool {
        self.paused.load(Ordering::Acquire)
    }
    pub(crate) fn set_paused(&self, value: bool) {
        self.paused.store(value, Ordering::Release);
    }

    pub(crate) fn is_shutdown(&self) -> bool {
        self.shutdown.load(Ordering::Acquire)
    }

    pub(crate) fn epoch(&self) -> usize {
        self.epoch.load(Ordering::Acquire)
    }

    pub(crate) fn cache_epoch(&self) -> usize {
        self.cache_epoch.load(Ordering::Acquire)
    }

    /// Clear eligibility in one atomic operation BEFORE cancellation/ledger I/O.
    /// Returning revision is the only stamp allowed to enable after persistence.
    pub(crate) fn suspend(&self) -> usize {
        let old = self
            .eligibility
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |v| {
                Some(v.wrapping_add(2) & !1)
            })
            .unwrap();
        let stamp = old.wrapping_add(2) & !1;
        self.invalidate_cache();
        stamp
    }
    pub(crate) fn permit_after(&self, stamp: usize) -> bool {
        !self.is_shutdown()
            && self
                .eligibility
                .compare_exchange(stamp, stamp | 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }
    pub(crate) fn allowed(&self) -> bool {
        !self.is_shutdown() && self.eligibility.load(Ordering::Acquire) & 1 == 1
    }
    pub(crate) fn invalidate_cache(&self) {
        self.cache_epoch.fetch_add(1, Ordering::AcqRel);
        self.paused.store(false, Ordering::Release);
        self.cancel();
    }
    pub(crate) fn cancel(&self) {
        // Manual preemption changes cancellation generation ONLY. It preserves
        // cache ownership, fairness and manual-required pauses on failed/busy checks.
        self.epoch.fetch_add(1, Ordering::AcqRel);
        let active = self.active.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(token) = active.as_ref() {
            token.store(true, Ordering::Release);
        }
    }
    pub(crate) fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
        self.suspend();
    }

    pub(crate) fn attempt(&self, now: Instant) -> Option<usize> {
        if !self.allowed() {
            return None;
        }
        let epoch = self.epoch();
        let mut schedule = self.schedule.lock().ok()?;
        schedule.attempt(now).then_some(epoch)
    }

    pub(crate) fn manual_requested(&self, now: Instant) {
        self.cancel();
        self.schedule
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .manual_requested(now);
    }

    /// Caller already owns the SAME manual/automatic CAS flag. It must recheck
    /// native consent/session after activating and before its first side effect.
    pub(crate) fn activate(&self, epoch: usize, now: Instant) -> Option<CycleControl> {
        let token = Arc::new(AtomicBool::new(false));
        let mut active = self.active.lock().ok()?;
        if self.epoch() != epoch || !self.allowed() {
            token.store(true, Ordering::Release);
            return None;
        }
        if active.is_some() {
            return None;
        }
        *active = Some(token.clone());
        Some(CycleControl::new(now, token))
    }

    pub(crate) fn finished(&self, control: &CycleControl) {
        let mut active = self.active.lock().unwrap_or_else(|p| p.into_inner());
        if active
            .as_ref()
            .is_some_and(|v| Arc::ptr_eq(v, &control.cancelled))
        {
            *active = None;
        }
    }
}

/// Shared manual/automatic ownership; releasing a cancelled cycle is the
/// only way a waiting manual request can acquire the same native flag.
pub(crate) struct CheckLease<'a>(&'a AtomicBool);
impl<'a> CheckLease<'a> {
    pub(crate) fn try_acquire(flag: &'a AtomicBool) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self(flag))
    }
}
impl Drop for CheckLease<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl Controller {
    pub(crate) fn manual_acquire<'a>(
        &self,
        flag: &'a AtomicBool,
        now: impl Fn() -> Instant,
        mut pause: impl FnMut(),
    ) -> Option<CheckLease<'a>> {
        let start = now();
        self.manual_requested(start);
        let deadline = start + Duration::from_secs(10);
        loop {
            if now() >= deadline {
                return None;
            }
            if let Some(lease) = CheckLease::try_acquire(flag) {
                return Some(lease);
            }
            pause();
        }
    }
}

impl Schedule {
    pub(crate) fn new(now: Instant) -> Self {
        Self { due: now }
    }
    /// Must run before acquiring the shared manual/automatic CAS guard. A busy
    /// attempt still moves due forward and cannot create a catch-up burst.
    pub(crate) fn attempt(&mut self, now: Instant) -> bool {
        if now < self.due {
            return false;
        }
        self.due = now + INTERVAL;
        true
    }
    pub(crate) fn manual_requested(&mut self, now: Instant) {
        self.due = self.due.max(now + INTERVAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn fresh() -> CycleControl {
        CycleControl::new(Instant::now(), Arc::new(AtomicBool::new(false)))
    }

    #[test]
    fn suspended_admission_rejects_gap_tick_and_stale_enable_completion() {
        let owner = Controller::new(Instant::now());
        assert!(!owner.allowed());
        assert!(owner.permit_after(0));
        let old = owner.suspend();
        // Persisted ledger can still say true here; no fresh cycle is admitted.
        assert!(owner.attempt(Instant::now()).is_none());
        let newer = owner.suspend();
        assert!(!owner.permit_after(old));
        assert!(!owner.allowed());
        assert!(owner.permit_after(newer));
        assert!(owner.allowed());
    }
    #[test]
    fn manual_preemption_and_busy_wait_preserve_cache_epoch_pause_and_spacing() {
        let start = Instant::now();
        let owner = Controller::new(start);
        owner.permit_after(0);
        let c = owner.activate(owner.epoch(), start).unwrap();
        owner.set_paused(true);
        let cache_epoch = owner.cache_epoch();
        let flag = AtomicBool::new(true);
        let clock = Cell::new(start);
        let lease = owner
            .manual_acquire(
                &flag,
                || clock.get(),
                || {
                    assert!(c.stopped());
                    owner.finished(&c);
                    flag.store(false, Ordering::Release);
                    clock.set(clock.get() + Duration::from_millis(20));
                },
            )
            .unwrap();
        assert!(flag.load(Ordering::Acquire));
        assert_eq!(owner.cache_epoch(), cache_epoch);
        assert!(owner.paused());
        drop(lease);
        assert!(!flag.load(Ordering::Acquire));
        assert!(owner.attempt(start + Duration::from_secs(119)).is_none());
        flag.store(true, Ordering::Release);
        let clock = Cell::new(start + INTERVAL);
        assert!(owner
            .manual_acquire(
                &flag,
                || clock.get(),
                || clock.set(clock.get() + Duration::from_secs(1))
            )
            .is_none());
        assert_eq!(clock.get(), start + INTERVAL + Duration::from_secs(10));
        assert_eq!(owner.cache_epoch(), cache_epoch);
        assert!(owner.paused());
        owner.invalidate_cache();
        assert_ne!(owner.cache_epoch(), cache_epoch);
        assert!(!owner.paused());
    }
    #[test]
    fn native_session_change_during_actual_file_read_stops_next_physical_read() {
        struct Switching {
            file: std::fs::File,
            ticket: Arc<AtomicU64>,
            calls: Arc<AtomicUsize>,
        }
        impl Read for Switching {
            fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                let n = self.file.read(b)?;
                self.ticket.fetch_add(1, Ordering::AcqRel);
                Ok(n)
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("synthetic");
        std::fs::write(&path, [1; 8]).unwrap();
        let ticket = Arc::new(AtomicU64::new(2));
        let calls = Arc::new(AtomicUsize::new(0));
        let c = fresh().with_session(ticket.clone(), 2);
        let source = Switching {
            file: std::fs::File::open(path).unwrap(),
            ticket,
            calls: calls.clone(),
        };
        let mut reader = PhysicalRead::new(source, &c);
        let mut header = [0; 5];
        reader.read_exact(&mut header).unwrap();
        assert!(reader.read(&mut [0; 1]).is_err());
        assert_eq!(c.reason(), Some(StopReason::Session));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(c.physical.load(Ordering::Acquire), 5);
    }

    #[test]
    fn old_epoch_activation_and_old_token_never_survive_opt_out_and_reenable() {
        let now = Instant::now();
        let owner = Controller::new(now);
        assert!(owner.permit_after(0));
        let old = owner.attempt(now).unwrap();
        owner.cancel();
        assert!(owner.activate(old, now).is_none());
        let current = owner.epoch();
        let active = owner.activate(current, now).unwrap();
        assert!(!active.stopped());
        owner.cancel();
        assert!(active.stopped());
        owner.finished(&active);
        let next = owner.activate(owner.epoch(), now).unwrap();
        assert!(!next.stopped());
        assert!(active.stopped());
        owner.shutdown();
        assert!(next.stopped());
        assert!(owner.attempt(now + INTERVAL).is_none());
        owner.finished(&next);
    }

    #[test]
    fn deadline_is_cooperative_and_cancellation_cannot_be_revived() {
        let now = Instant::now();
        let token = Arc::new(AtomicBool::new(false));
        let c = CycleControl::new(now, token.clone());
        assert!(!c.stopped_at(now));
        token.store(true, Ordering::Release);
        assert!(c.stopped_at(now));
        // Even accidental token reuse cannot clear the old cycle's stop reason.
        token.store(false, Ordering::Release);
        assert!(c.stopped_at(now));
        let d = fresh();
        assert!(d.stopped_at(d.deadline));
        assert_eq!(d.reason(), Some(StopReason::Deadline));
    }

    #[test]
    fn raw_sparse_scan_continues_without_prefix_search_and_caps_across_links() {
        let mut a = ScanCursor::default();
        let mut b = ScanCursor::default();
        let mut seen = false;
        for _ in 0..6 {
            let c = fresh();
            let mut w = a.window(1025);
            while let Some(i) = w.next(&c) {
                if i == 1024 {
                    seen = true;
                }
            }
            assert!(b.window(900).next(&c).is_none());
            assert_eq!(c.raw_entries.load(Ordering::Acquire), MAX_RAW_ENTRIES);
        }
        assert!(seen);
        // A removed suffix cannot leave an invalid index or require UUID search.
        assert!(a.window(3).next(&fresh()).unwrap() < 3);
    }

    #[test]
    fn short_physical_reads_charge_actual_once_and_header_does_not_prefetch() {
        struct Source<'a>(&'a Cell<usize>);
        impl Read for Source<'_> {
            fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
                self.0.set(self.0.get() + b.len());
                b[0] = 1;
                Ok(1)
            }
        }
        let c = fresh();
        let requested = Cell::new(0);
        let mut r = PhysicalRead::new(Source(&requested), &c);
        let mut header = [0; 5];
        r.read_exact(&mut header).unwrap();
        assert_eq!(requested.get(), 15);
        assert_eq!(c.physical.load(Ordering::Acquire), 5);
        c.physical.store(MAX_PHYSICAL_READ, Ordering::Release);
        assert!(r.read(&mut [0]).is_err());
        assert_eq!(requested.get(), 15);
    }

    #[test]
    fn full_chunk_admission_precedes_allocation_and_all_budgets_are_global() {
        let c = fresh();
        c.physical
            .store(MAX_PHYSICAL_READ - 1024, Ordering::Release);
        assert!(!c.chunk_fits(1024 * 1024 + 16));
        assert_eq!(c.reason(), Some(StopReason::Budget));
        let c = fresh();
        for _ in 0..MAX_CANDIDATES {
            assert!(c.candidate());
        }
        assert!(!c.candidate());
        assert_eq!(c.reason(), None);
        assert!(c.request()); // A verified receipt still gets a bounded send.
    }

    #[test]
    fn busy_attempt_and_manual_request_defer_without_catchup() {
        let now = Instant::now();
        let mut s = Schedule::new(now);
        assert!(s.attempt(now));
        assert!(!s.attempt(now + Duration::from_secs(1)));
        s.manual_requested(now + Duration::from_secs(100));
        assert!(!s.attempt(now + Duration::from_secs(120)));
        assert!(s.attempt(now + Duration::from_secs(220)));
        assert!(!s.attempt(now + Duration::from_secs(221)));
        assert!(s.attempt(now + Duration::from_secs(9999)));
        assert!(!s.attempt(now + Duration::from_secs(9999)));
    }
}

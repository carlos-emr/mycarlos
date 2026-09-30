//! A gentle wait after repeated wrong secrets: when unlocking, when opening
//! the vault with its recovery key, and when opening a backup. Every try
//! already costs a slow key derivation; this only slows guessing through the
//! app on this device. A copy of the vault, or a backup, can be guessed at
//! elsewhere without it.
//!
//! The counts are kept in a small file beside the vault, so that closing and
//! reopening myCarlos does not start them again. It holds only how many wrong
//! tries there were and when the last one was; whoever can change files in
//! the app's folder can remove it, which only undoes the wait.

use crate::vault::{atomic_bytes, read_bounded_regular_file};
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    path::PathBuf,
    sync::{Mutex, MutexGuard, PoisonError},
};

/// How a try went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// A passphrase or recovery key that does not open it.
    Wrong,
    /// It opened.
    Right,
    /// Something else: a typo in a key's check characters, a storage error.
    Neither,
}

/// A try under way, as `begin` counted it: when the wrong try before it
/// was, and when it began.
#[derive(Clone, Copy, Debug)]
pub struct Try {
    before: u64,
    at: u64,
}

/// What a secret was tried for. Each is counted apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attempt {
    Unlock,
    RecoveryKey,
    Backup,
}

/// Wrong tries in a row before any wait.
pub const FREE_TRIES: u32 = 5;
/// How much each further wrong try adds to the wait.
const STEP_MS: u64 = 5_000;
/// The longest wait.
pub const LONGEST_WAIT_MS: u64 = 60_000;
/// The counts file is a few dozen bytes; anything much larger is not it.
const MAX_FILE_BYTES: usize = 4 * 1024;

/// The wait before the next try after `failures` wrong ones in a row: none
/// for the first few, then 5 seconds more for each, up to a minute.
pub fn wait_after(failures: u32) -> u64 {
    if failures < FREE_TRIES {
        return 0;
    }
    (u64::from(failures - FREE_TRIES + 1) * STEP_MS).min(LONGEST_WAIT_MS)
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Count {
    failures: u32,
    last_failure_ms: u64,
    /// How many times the count was cleared. Another copy of myCarlos open
    /// at the same time shares the file, and a count cleared more often
    /// than the other copy knows of is the newer one.
    clears: u64,
}

impl Count {
    /// This run's count and the file's, taken together: whichever was
    /// cleared since the other wins; otherwise the higher count and the
    /// later time, so that no copy's wrong tries are lost, nor this run's
    /// when the file could not be written.
    fn with(self, kept: Count) -> Count {
        match self.clears.cmp(&kept.clears) {
            Ordering::Less => kept,
            Ordering::Greater => self,
            Ordering::Equal => Count {
                failures: self.failures.max(kept.failures),
                last_failure_ms: self.last_failure_ms.max(kept.last_failure_ms),
                clears: self.clears,
            },
        }
    }

    /// Cleared, unless there is nothing to clear.
    fn clear(&mut self) {
        if self.failures != 0 || self.last_failure_ms != 0 {
            *self = Count {
                clears: self.clears.wrapping_add(1),
                ..Count::default()
            };
        }
    }
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Counts {
    unlock: Count,
    recovery_key: Count,
    backup: Count,
}

impl Counts {
    fn of(&mut self, attempt: Attempt) -> &mut Count {
        match attempt {
            Attempt::Unlock => &mut self.unlock,
            Attempt::RecoveryKey => &mut self.recovery_key,
            Attempt::Backup => &mut self.backup,
        }
    }

    fn with(self, kept: Counts) -> Counts {
        Counts {
            unlock: self.unlock.with(kept.unlock),
            recovery_key: self.recovery_key.with(kept.recovery_key),
            backup: self.backup.with(kept.backup),
        }
    }
}

pub struct AttemptThrottle {
    /// Where the counts are kept; `None` keeps them for this run only.
    path: Option<PathBuf>,
    /// This run's counts, as last read or changed.
    counts: Mutex<Counts>,
}

impl AttemptThrottle {
    /// Reads nothing yet: the file is read each time the counts are needed,
    /// not while the app starts.
    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            path,
            counts: Mutex::new(Counts::default()),
        }
    }

    /// How many milliseconds are left before `attempt` may be tried again,
    /// if it must wait.
    #[cfg(test)]
    pub fn wait(&self, attempt: Attempt, now_ms: u64) -> Option<u64> {
        let mut counts = self.lock();
        self.left(&mut counts, attempt, now_ms)
    }

    /// Starts a try at `attempt`, unless it must wait: it is counted as
    /// wrong at once, under the same lock as the check, so that tries sent
    /// together cannot all pass the check before any is counted. `settle`
    /// then says how it went.
    pub fn begin(&self, attempt: Attempt, now_ms: u64) -> Result<Try, u64> {
        let mut counts = self.lock();
        if let Some(left) = self.left(&mut counts, attempt, now_ms) {
            return Err(left);
        }
        let count = counts.of(attempt);
        let started = Try {
            before: count.last_failure_ms,
            at: now_ms,
        };
        count.failures = count.failures.saturating_add(1);
        count.last_failure_ms = now_ms;
        self.keep(&counts);
        Ok(started)
    }

    /// How a try started by `begin` went: a wrong secret stays counted, the
    /// right one clears the count, and anything else (a typo, a storage
    /// error) is taken back off it, with the time of the wrong try before
    /// it, unless a later try has counted since.
    pub fn settle(&self, attempt: Attempt, started: Try, outcome: Outcome) {
        match outcome {
            Outcome::Wrong => {}
            Outcome::Right => self.succeeded(attempt),
            Outcome::Neither => {
                let mut counts = self.lock();
                let count = counts.of(attempt);
                count.failures = count.failures.saturating_sub(1);
                if count.last_failure_ms == started.at {
                    count.last_failure_ms = started.before;
                }
                self.keep(&counts);
            }
        }
    }

    /// A wrong secret was given for `attempt`.
    #[cfg(test)]
    pub fn failed(&self, attempt: Attempt, now_ms: u64) {
        let mut counts = self.lock();
        let count = counts.of(attempt);
        count.failures = count.failures.saturating_add(1);
        count.last_failure_ms = now_ms;
        self.keep(&counts);
    }

    /// The vault the counts were about is gone or replaced (created, erased
    /// or restored): its counts go with it. A backup's count stays.
    pub fn forget_vault(&self) {
        let mut counts = self.lock();
        let before = *counts;
        counts.unlock.clear();
        counts.recovery_key.clear();
        if *counts != before {
            self.keep(&counts);
        }
    }

    /// The wait left for `attempt`. A clock set back behind the last wrong
    /// try moves that try to now, so that the wait counts down from now,
    /// rather than never. A clock before 1970 reads as 0 and is not known:
    /// there is no wait then, rather than one that never ends.
    fn left(&self, counts: &mut Counts, attempt: Attempt, now_ms: u64) -> Option<u64> {
        if now_ms == 0 {
            return None;
        }
        let count = counts.of(attempt);
        if now_ms < count.last_failure_ms {
            count.last_failure_ms = now_ms;
            self.keep(counts);
        }
        let count = *counts.of(attempt);
        let until = count
            .last_failure_ms
            .saturating_add(wait_after(count.failures));
        let left = until.saturating_sub(now_ms);
        (left > 0).then_some(left)
    }

    /// The right secret was given for `attempt`. Opening the vault, by its
    /// passphrase or its recovery key, clears both counts: whoever did it
    /// has the vault anyway.
    pub fn succeeded(&self, attempt: Attempt) {
        let mut counts = self.lock();
        let before = *counts;
        match attempt {
            Attempt::Unlock | Attempt::RecoveryKey => {
                counts.unlock.clear();
                counts.recovery_key.clear();
            }
            Attempt::Backup => counts.backup.clear(),
        }
        if *counts != before {
            self.keep(&counts);
        }
    }

    /// The counts, with the file's as it is now: another copy of myCarlos
    /// open at the same time may have changed it. A file that cannot be
    /// read (missing, damaged, a link, or not a plain file) leaves this
    /// run's counts as they are.
    fn lock(&self) -> MutexGuard<'_, Counts> {
        let mut counts = self.counts.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(kept) = self.read() {
            *counts = counts.with(kept);
        }
        counts
    }

    fn read(&self) -> Option<Counts> {
        let data = read_bounded_regular_file(self.path.as_ref()?, MAX_FILE_BYTES).ok()?;
        serde_json::from_slice(&data).ok()
    }

    /// Written as the vault's own files are: private to the user, staged
    /// beside and renamed over, and the folder synced where the system
    /// allows, so that neither a torn write nor a power cut brings back an
    /// earlier count. A failure to write keeps the counts for this run only.
    fn keep(&self, counts: &Counts) {
        let Some(path) = &self.path else {
            return;
        };
        if let Ok(data) = serde_json::to_vec(counts) {
            let _ = atomic_bytes(path, &data);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn kept(path: &std::path::Path) -> Counts {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn the_first_few_wrong_tries_wait_for_nothing_then_a_little_more_each() {
        for failures in 0..FREE_TRIES {
            assert_eq!(wait_after(failures), 0);
        }
        assert_eq!(wait_after(5), 5_000);
        assert_eq!(wait_after(6), 10_000);
        assert_eq!(wait_after(16), LONGEST_WAIT_MS);
        assert_eq!(wait_after(u32::MAX), LONGEST_WAIT_MS);
    }

    #[test]
    fn a_wait_counts_from_the_last_wrong_try_and_ends() {
        let throttle = AttemptThrottle::new(None);
        for _ in 0..FREE_TRIES {
            assert_eq!(throttle.wait(Attempt::Unlock, 1_000), None);
            throttle.failed(Attempt::Unlock, 1_000);
        }
        assert_eq!(throttle.wait(Attempt::Unlock, 1_000), Some(5_000));
        assert_eq!(throttle.wait(Attempt::Unlock, 4_000), Some(2_000));
        assert_eq!(throttle.wait(Attempt::Unlock, 6_000), None);
        // Other secrets are counted apart.
        assert_eq!(throttle.wait(Attempt::Backup, 1_000), None);
        assert_eq!(throttle.wait(Attempt::RecoveryKey, 1_000), None);
    }

    #[test]
    fn a_clock_set_back_counts_the_wait_down_from_then() {
        let throttle = AttemptThrottle::new(None);
        for _ in 0..FREE_TRIES {
            throttle.failed(Attempt::Backup, 1_000_000);
        }
        // Set back minutes: the wait is as long as the count calls for, and
        // then over, not stuck until the clock catches up.
        assert_eq!(throttle.wait(Attempt::Backup, 10_000), Some(5_000));
        assert_eq!(throttle.wait(Attempt::Backup, 12_000), Some(3_000));
        assert_eq!(throttle.wait(Attempt::Backup, 15_000), None);
    }

    #[test]
    fn a_clock_that_cannot_be_read_does_not_shut_the_patient_out() {
        let throttle = AttemptThrottle::new(None);
        for _ in 0..FREE_TRIES + 3 {
            throttle.failed(Attempt::Unlock, 1_000);
        }
        // Before 1970 the clock reads as 0, and would never move on.
        assert_eq!(throttle.wait(Attempt::Unlock, 0), None);
        assert!(throttle.begin(Attempt::Unlock, 0).is_ok());
        assert!(throttle.wait(Attempt::Unlock, 1_000).is_some());
    }

    #[test]
    fn tries_sent_together_are_each_counted_before_they_run() {
        let throttle = AttemptThrottle::new(None);
        // Five begun at once, none settled yet: the sixth must wait.
        let mut begun = Vec::new();
        for _ in 0..FREE_TRIES {
            begun.push(throttle.begin(Attempt::Unlock, 1_000).unwrap());
        }
        assert!(matches!(throttle.begin(Attempt::Unlock, 1_000), Err(5_000)));
        // A try that was neither right nor wrong is taken back off.
        throttle.settle(Attempt::Unlock, begun[0], Outcome::Neither);
        let right = throttle.begin(Attempt::Unlock, 1_000).unwrap();
        throttle.settle(Attempt::Unlock, right, Outcome::Right);
        assert_eq!(throttle.wait(Attempt::Unlock, 1_000), None);
    }

    #[test]
    fn a_try_neither_right_nor_wrong_does_not_start_the_wait_again() {
        let throttle = AttemptThrottle::new(None);
        for _ in 0..FREE_TRIES {
            throttle.failed(Attempt::RecoveryKey, 1_000);
        }
        // The wait ends at 6 seconds; a typo at 7 must not start another.
        assert_eq!(throttle.wait(Attempt::RecoveryKey, 7_000), None);
        let typo = throttle.begin(Attempt::RecoveryKey, 7_000).unwrap();
        throttle.settle(Attempt::RecoveryKey, typo, Outcome::Neither);
        assert_eq!(throttle.wait(Attempt::RecoveryKey, 7_000), None);
    }

    #[test]
    fn a_new_or_replaced_vault_starts_its_counts_again() {
        let throttle = AttemptThrottle::new(None);
        for attempt in [Attempt::Unlock, Attempt::RecoveryKey, Attempt::Backup] {
            for _ in 0..FREE_TRIES {
                throttle.failed(attempt, 1_000);
            }
        }
        throttle.forget_vault();
        assert_eq!(throttle.wait(Attempt::Unlock, 1_000), None);
        assert_eq!(throttle.wait(Attempt::RecoveryKey, 1_000), None);
        assert_eq!(throttle.wait(Attempt::Backup, 1_000), Some(5_000));
    }

    #[test]
    fn opening_the_vault_clears_its_counts_and_leaves_the_backups() {
        let throttle = AttemptThrottle::new(None);
        for attempt in [Attempt::Unlock, Attempt::RecoveryKey, Attempt::Backup] {
            for _ in 0..FREE_TRIES {
                throttle.failed(attempt, 1_000);
            }
        }
        throttle.succeeded(Attempt::RecoveryKey);
        assert_eq!(throttle.wait(Attempt::Unlock, 1_000), None);
        assert_eq!(throttle.wait(Attempt::RecoveryKey, 1_000), None);
        assert_eq!(throttle.wait(Attempt::Backup, 1_000), Some(5_000));
        throttle.succeeded(Attempt::Backup);
        assert_eq!(throttle.wait(Attempt::Backup, 1_000), None);
    }

    #[test]
    fn closing_and_reopening_does_not_start_the_count_again() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("attempts.json");
        let throttle = AttemptThrottle::new(Some(path.clone()));
        for _ in 0..FREE_TRIES + 1 {
            throttle.failed(Attempt::Unlock, 1_000);
        }
        drop(throttle);
        let reopened = AttemptThrottle::new(Some(path.clone()));
        assert_eq!(reopened.wait(Attempt::Unlock, 1_000), Some(10_000));
        // It holds counts and times only, and only its owner can read it.
        assert_eq!(kept(&path).unlock.failures, 6);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // A file that does not read starts from nothing, rather than failing.
        fs::write(&path, b"not json").unwrap();
        assert_eq!(
            AttemptThrottle::new(Some(path)).wait(Attempt::Unlock, 1_000),
            None
        );
    }

    #[test]
    fn the_right_secret_clears_the_count_on_disk_too() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("attempts.json");
        let throttle = AttemptThrottle::new(Some(path.clone()));
        for _ in 0..FREE_TRIES {
            throttle.failed(Attempt::Unlock, 1_000);
        }
        let right = throttle.begin(Attempt::Unlock, 7_000).unwrap();
        throttle.settle(Attempt::Unlock, right, Outcome::Right);
        let on_disk = kept(&path).unlock;
        assert_eq!((on_disk.failures, on_disk.last_failure_ms), (0, 0));
        assert_eq!(
            AttemptThrottle::new(Some(path)).wait(Attempt::Unlock, 7_000),
            None
        );
    }

    #[test]
    fn two_copies_open_at_once_neither_lose_nor_bring_back_a_count() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("attempts.json");
        let first = AttemptThrottle::new(Some(path.clone()));
        let second = AttemptThrottle::new(Some(path.clone()));
        // The second knew of no tries; its own does not write over the
        // first's five.
        for _ in 0..FREE_TRIES {
            first.failed(Attempt::Unlock, 1_000);
        }
        second.failed(Attempt::Unlock, 1_000);
        assert_eq!(kept(&path).unlock.failures, FREE_TRIES + 1);
        assert_eq!(first.wait(Attempt::Unlock, 1_000), Some(10_000));
        // Cleared in one, cleared in the other: the second's six do not
        // come back with its next try.
        first.succeeded(Attempt::Unlock);
        assert_eq!(second.wait(Attempt::Unlock, 1_000), None);
        second.failed(Attempt::Unlock, 2_000);
        assert_eq!(kept(&path).unlock.failures, 1);
        assert_eq!(first.wait(Attempt::Unlock, 2_000), None);
    }

    #[test]
    fn counts_that_cannot_be_written_last_for_the_run() {
        let temp = tempfile::tempdir().unwrap();
        // No vault home yet: the file cannot be written.
        let throttle = AttemptThrottle::new(Some(temp.path().join("none").join("attempts.json")));
        for _ in 0..FREE_TRIES {
            throttle.failed(Attempt::Unlock, 1_000);
        }
        assert_eq!(throttle.wait(Attempt::Unlock, 1_000), Some(5_000));
    }

    #[cfg(unix)]
    #[test]
    fn only_a_plain_file_is_read_and_a_fifo_does_not_hang_the_app() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("attempts.json");
        // A link to counts elsewhere is not followed.
        let elsewhere = temp.path().join("elsewhere.json");
        let writer = AttemptThrottle::new(Some(elsewhere.clone()));
        for _ in 0..FREE_TRIES {
            writer.failed(Attempt::Unlock, 1_000);
        }
        std::os::unix::fs::symlink(&elsewhere, &path).unwrap();
        assert_eq!(
            AttemptThrottle::new(Some(path.clone())).wait(Attempt::Unlock, 1_000),
            None
        );
        // A FIFO in its place is not opened for a read that never ends.
        fs::remove_file(&path).unwrap();
        assert!(std::process::Command::new("mkfifo")
            .arg(&path)
            .status()
            .unwrap()
            .success());
        assert_eq!(
            AttemptThrottle::new(Some(path.clone())).wait(Attempt::Unlock, 1_000),
            None
        );
        // Nor is an oversized file.
        fs::remove_file(&path).unwrap();
        fs::write(&path, vec![b' '; MAX_FILE_BYTES + 1]).unwrap();
        assert_eq!(
            AttemptThrottle::new(Some(path)).wait(Attempt::Unlock, 1_000),
            None
        );
    }
}

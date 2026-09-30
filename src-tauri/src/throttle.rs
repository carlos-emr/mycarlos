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

use serde::{Deserialize, Serialize};
use std::{fs, io::Write as _, path::PathBuf, sync::Mutex};

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

/// The wait before the next try after `failures` wrong ones in a row: none
/// for the first few, then 5 seconds more for each, up to a minute.
pub fn wait_after(failures: u32) -> u64 {
    if failures < FREE_TRIES {
        return 0;
    }
    (u64::from(failures - FREE_TRIES + 1) * STEP_MS).min(LONGEST_WAIT_MS)
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Count {
    failures: u32,
    last_failure_ms: u64,
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
}

pub struct AttemptThrottle {
    /// Where the counts are kept; `None` keeps them for this run only.
    path: Option<PathBuf>,
    counts: Mutex<Counts>,
}

impl AttemptThrottle {
    pub fn new(path: Option<PathBuf>) -> Self {
        let counts = path
            .as_ref()
            .and_then(|path| fs::read(path).ok())
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default();
        Self {
            path,
            counts: Mutex::new(counts),
        }
    }

    /// How many milliseconds are left before `attempt` may be tried again,
    /// if it must wait. A clock set back never makes a wait longer than the
    /// one the count calls for.
    pub fn wait(&self, attempt: Attempt, now_ms: u64) -> Option<u64> {
        let mut counts = self.lock();
        let count = *counts.of(attempt);
        let wait = wait_after(count.failures);
        let until = count.last_failure_ms.saturating_add(wait);
        let left = until.saturating_sub(now_ms).min(wait);
        (left > 0).then_some(left)
    }

    /// A wrong secret was given for `attempt`.
    pub fn failed(&self, attempt: Attempt, now_ms: u64) {
        let mut counts = self.lock();
        let count = counts.of(attempt);
        count.failures = count.failures.saturating_add(1);
        count.last_failure_ms = now_ms;
        self.keep(&counts);
    }

    /// The right secret was given for `attempt`. Opening the vault, by its
    /// passphrase or its recovery key, clears both counts: whoever did it
    /// has the vault anyway.
    pub fn succeeded(&self, attempt: Attempt) {
        let mut counts = self.lock();
        let before = *counts;
        match attempt {
            Attempt::Unlock | Attempt::RecoveryKey => {
                counts.unlock = Count::default();
                counts.recovery_key = Count::default();
            }
            Attempt::Backup => counts.backup = Count::default(),
        }
        if *counts != before {
            self.keep(&counts);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Counts> {
        self.counts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Written beside and renamed over, so that a torn write never leaves a
    /// file that reads as no wrong tries. A failure to write keeps the
    /// counts for this run only.
    fn keep(&self, counts: &Counts) {
        let Some(path) = &self.path else {
            return;
        };
        let Ok(data) = serde_json::to_vec(counts) else {
            return;
        };
        let staged = path.with_extension("json.new");
        let written = fs::File::create(&staged).and_then(|mut file| {
            file.write_all(&data)?;
            file.sync_all()
        });
        if written.is_ok() {
            let _ = fs::rename(&staged, path);
        } else {
            let _ = fs::remove_file(&staged);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn a_clock_set_back_waits_no_longer_than_the_count_calls_for() {
        let throttle = AttemptThrottle::new(None);
        for _ in 0..FREE_TRIES {
            throttle.failed(Attempt::Backup, 1_000_000);
        }
        assert_eq!(throttle.wait(Attempt::Backup, 0), Some(5_000));
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
        // It holds counts and times only.
        let kept = fs::read_to_string(&path).unwrap();
        assert!(kept.contains("\"failures\":6"));
        // A file that does not read starts from nothing, rather than failing.
        fs::write(&path, b"not json").unwrap();
        assert_eq!(
            AttemptThrottle::new(Some(path)).wait(Attempt::Unlock, 1_000),
            None
        );
    }
}
